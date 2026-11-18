use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use protocol::{
    ErrorPayload, JoinGamePayload, MatchFoundPayload, MessageType, PeerJoinedPayload,
    PeerLeftPayload, RoomPlayerInfo, RoomStatePayload, RoomSummary, WSMessage,
};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{mpsc, Mutex, RwLock};
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info};
use utils::generate_id;

/// 大厅状态：rooms 管花名册与容量，conns 管每个连接的下行通道与所在房间。
/// 玩法状态一律不落在大厅——它是哑中继。
///
/// 锁纪律：rooms 与 conns 各自短临界区，绝不嵌套获取同一把锁；
/// 广播类操作必须在锁释放之后进行。
struct AppState {
    rooms: RwLock<HashMap<String, Room>>,
    conns: RwLock<HashMap<String, Connection>>,
    /// 成绩榜：game_type -> 有序成绩（内存版，进程重启即清空；持久化待 docker-compose 阶段）
    scores: Mutex<HashMap<String, Vec<ScoreEntry>>>,
}

/// POST /api/scores 请求体
#[derive(Debug, Deserialize)]
struct ScoreSubmit {
    game_type: String,
    player_name: String,
    score: u32,
}

#[derive(Debug, Clone, Serialize)]
struct ScoreEntry {
    player: String,
    score: u32,
    /// 提交时间（unix 秒）
    at: u64,
}

#[derive(Debug, Deserialize)]
struct LeaderboardQuery {
    game_type: String,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

struct Room {
    id: String,
    game_type: String,
    max_players: usize,
    /// (player_id, player_name)，保持加入顺序。
    /// 花名册顺序必须确定（第一位 = 主机），故用 Vec 而非 HashMap。
    players: Vec<(String, String)>,
}

struct Connection {
    room_id: Option<String>,
    tx: mpsc::UnboundedSender<Message>,
}

const DEFAULT_MAX_PLAYERS: usize = 4;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .init();

    let state = Arc::new(AppState {
        rooms: RwLock::new(HashMap::new()),
        conns: RwLock::new(HashMap::new()),
        scores: Mutex::new(HashMap::new()),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/api/games", get(games_handler))
        .route("/api/rooms", get(rooms_handler))
        .route("/api/scores", post(submit_score))
        .route("/api/leaderboard", get(leaderboard_handler))
        .route("/ws", get(websocket_handler))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:7080").await.unwrap();
    info!("Gateway server running on http://0.0.0.0:7080");

    axum::serve(listener, app).await.unwrap();
}

async fn websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| websocket_stream(socket, state))
}

async fn websocket_stream(ws: WebSocket, state: Arc<AppState>) {
    let (mut socket_sender, mut socket_receiver) = ws.split();
    let player_id = generate_id();
    let name = format!("Player_{}", &player_id[..4]);

    // 单写者模式：所有下行都走 mpsc，写任务独占 socket 发送半边。
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = outbound_rx.recv().await {
            if socket_sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    state.conns.write().await.insert(
        player_id.clone(),
        Connection {
            room_id: None,
            tx: outbound_tx.clone(),
        },
    );
    info!("Player {} ({}) connected", player_id, name);

    while let Some(result) = socket_receiver.next().await {
        let msg = match result {
            Ok(m) => m,
            Err(e) => {
                error!("websocket error from {}: {}", player_id, e);
                break;
            }
        };
        match msg {
            Message::Text(text) => {
                if let Err(e) = handle_text(&state, &player_id, text.as_bytes()).await {
                    error!("handle_message from {}: {}", player_id, e);
                }
            }
            Message::Binary(data) => {
                if let Err(e) = handle_text(&state, &player_id, &data).await {
                    error!("handle_message from {}: {}", player_id, e);
                }
            }
            // 协议层 Ping 也走下行通道，保持单写者
            Message::Ping(data) => {
                let _ = outbound_tx.send(Message::Pong(data));
            }
            Message::Close(_) => break,
            Message::Pong(_) => {}
        }
    }

    // 连接结束：退出房间（广播离开）、注销连接、关闭下行
    leave_room(&state, &player_id).await;
    state.conns.write().await.remove(&player_id);
    outbound_tx.send(Message::Close(None)).ok();
    writer.abort();
    info!("Player {} disconnected", player_id);
}

async fn handle_text(state: &Arc<AppState>, player_id: &str, raw: &[u8]) -> Result<(), String> {
    let msg = match WSMessage::from_bytes(raw) {
        Ok(m) => m,
        Err(e) => {
            send_error(state, player_id, "bad_message", &e.to_string()).await;
            return Ok(());
        }
    };

    match msg.msg_type {
        MessageType::Ping => {
            // 原样回带 payload，客户端用它计算延迟
            reply(state, player_id, WSMessage::new(MessageType::Pong, msg.payload)).await;
        }
        MessageType::JoinGame => {
            match serde_json::from_value::<JoinGamePayload>(msg.payload) {
                Ok(payload) => join_room(state, player_id, payload).await,
                Err(e) => send_error(state, player_id, "bad_join", &e.to_string()).await,
            }
        }
        MessageType::LeaveGame => {
            leave_room(state, player_id).await;
        }
        MessageType::PlayerAction => {
            // 哑中继：原样转发给房内其他人，player_id 标记来源
            let relay =
                WSMessage::new(MessageType::PeerAction, msg.payload).with_player(player_id.to_string());
            broadcast_to_room(state, player_id, relay, true).await;
        }
        MessageType::GameState => {
            // 哑中继：客户端（通常是权威主机）广播快照给房内其他人
            let relay =
                WSMessage::new(MessageType::GameState, msg.payload).with_player(player_id.to_string());
            broadcast_to_room(state, player_id, relay, true).await;
        }
        MessageType::Chat => {
            let relay =
                WSMessage::new(MessageType::Chat, msg.payload).with_player(player_id.to_string());
            broadcast_to_room(state, player_id, relay, true).await;
        }
        _ => {}
    }
    Ok(())
}

/// 加入 game_type 对应的未满房间；没有就新建，容量由首位（建房）玩家指定。
async fn join_room(state: &Arc<AppState>, player_id: &str, payload: JoinGamePayload) {
    // 先退旧房（内部自持锁），再拿 rooms 写锁分房，避免嵌套获取同一把锁
    leave_room(state, player_id).await;

    let (room_id, max_players) = {
        let mut rooms = state.rooms.write().await;
        let existing = rooms
            .values_mut()
            .find(|r| r.game_type == payload.game_type && r.players.len() < r.max_players);

        match existing {
            Some(r) => {
                r.players
                    .push((player_id.to_string(), payload.player_name.clone()));
                (r.id.clone(), r.max_players)
            }
            None => {
                let room_id = generate_id();
                let max = payload
                    .max_players
                    .unwrap_or(DEFAULT_MAX_PLAYERS)
                    .clamp(1, 8);
                let players = vec![(player_id.to_string(), payload.player_name.clone())];
                rooms.insert(
                    room_id.clone(),
                    Room {
                        id: room_id.clone(),
                        game_type: payload.game_type.clone(),
                        max_players: max,
                        players,
                    },
                );
                info!(
                    "Room {} created for {} (max {})",
                    room_id, payload.game_type, max
                );
                (room_id, max)
            }
        }
    }; // rooms 写锁在此释放

    if let Some(conn) = state.conns.write().await.get_mut(player_id) {
        conn.room_id = Some(room_id.clone());
    }
    info!("Player {} joined room {}", player_id, room_id);

    // 回给本人（花名册此刻再取一次，短暂持读锁）
    let roster = {
        let rooms = state.rooms.read().await;
        rooms.get(&room_id).map(roster_of).unwrap_or_default()
    };
    let found = WSMessage::new(
        MessageType::MatchFound,
        serde_json::to_value(MatchFoundPayload {
            room_id: room_id.clone(),
            player_id: player_id.to_string(),
            players: roster,
            max_players,
        })
        .unwrap_or_default(),
    );
    reply(state, player_id, found).await;

    // 通知房内其他人 + 全员花名册
    let joined = WSMessage::new(
        MessageType::PeerJoined,
        serde_json::to_value(PeerJoinedPayload {
            player_id: player_id.to_string(),
            player_name: payload.player_name,
        })
        .unwrap_or_default(),
    );
    broadcast_in(&state, &room_id, joined, Some(player_id)).await;
    broadcast_room_state(&state, &room_id).await;
}

/// 退出所在房间；房间空了就地解散。返回是否曾在一个房间里。
async fn leave_room(state: &Arc<AppState>, player_id: &str) -> bool {
    let room_id = {
        let conns = state.conns.read().await;
        conns.get(player_id).and_then(|c| c.room_id.clone())
    };
    let Some(room_id) = room_id else {
        return false;
    };

    let dissolved = {
        let mut rooms = state.rooms.write().await;
        if let Some(room) = rooms.get_mut(&room_id) {
            room.players.retain(|(id, _)| id != player_id);
        }
        if let Some(conn) = state.conns.write().await.get_mut(player_id) {
            conn.room_id = None;
        }
        let empty = rooms
            .get(&room_id)
            .map(|r| r.players.is_empty())
            .unwrap_or(false);
        if empty {
            rooms.remove(&room_id);
        }
        empty
    }; // rooms 写锁在此释放

    if dissolved {
        info!("Room {} dissolved (empty)", room_id);
        return true;
    }

    let left = WSMessage::new(
        MessageType::PeerLeft,
        serde_json::to_value(PeerLeftPayload {
            player_id: player_id.to_string(),
        })
        .unwrap_or_default(),
    );
    broadcast_in(state, &room_id, left, None).await;
    broadcast_room_state(state, &room_id).await;
    true
}

/// 发给单个连接
async fn reply(state: &Arc<AppState>, player_id: &str, msg: WSMessage) {
    let text = match serde_json::to_string(&msg) {
        Ok(t) => t,
        Err(e) => {
            error!("serialize reply: {}", e);
            return;
        }
    };
    if let Some(conn) = state.conns.read().await.get(player_id) {
        let _ = conn.tx.send(Message::Text(text));
    }
}

async fn send_error(state: &Arc<AppState>, player_id: &str, code: &str, message: &str) {
    let err = WSMessage::new(
        MessageType::Error,
        serde_json::to_value(ErrorPayload {
            code: code.to_string(),
            message: message.to_string(),
        })
        .unwrap_or_default(),
    );
    reply(state, player_id, err).await;
}

/// 给房间内所有人广播（可选排除某人）。
/// 两把锁顺序获取、不嵌套：先取成员名单（rooms），放锁后再取下行通道（conns），
/// 与 leave_room 的 rooms→conns 顺序保持一致，避免锁顺序反转。
async fn broadcast_in(state: &Arc<AppState>, room_id: &str, msg: WSMessage, exclude: Option<&str>) {
    let text = match serde_json::to_string(&msg) {
        Ok(t) => t,
        Err(e) => {
            error!("serialize broadcast: {}", e);
            return;
        }
    };
    let member_ids: Vec<String> = {
        let rooms = state.rooms.read().await;
        match rooms.get(room_id) {
            Some(room) => room
                .players
                .iter()
                .map(|(id, _)| id.clone())
                .filter(|id| Some(id.as_str()) != exclude)
                .collect(),
            None => return,
        }
    }; // rooms 读锁在此释放

    let conns = state.conns.read().await;
    for member_id in member_ids {
        if let Some(conn) = conns.get(&member_id) {
            let _ = conn.tx.send(Message::Text(text.clone()));
        }
    }
}

/// 按发送者所在房间广播；no_echo 为 true 时不发回发送者本人
async fn broadcast_to_room(state: &Arc<AppState>, sender_id: &str, msg: WSMessage, no_echo: bool) {
    let room_id = {
        let conns = state.conns.read().await;
        conns.get(sender_id).and_then(|c| c.room_id.clone())
    };
    if let Some(room_id) = room_id {
        let exclude = if no_echo { Some(sender_id) } else { None };
        broadcast_in(state, &room_id, msg, exclude).await;
    }
}

/// 房间花名册广播（推给包括发送者在内的所有人）
async fn broadcast_room_state(state: &Arc<AppState>, room_id: &str) {
    let msg = {
        let rooms = state.rooms.read().await;
        let Some(room) = rooms.get(room_id) else {
            return;
        };
        WSMessage::new(
            MessageType::RoomState,
            serde_json::to_value(RoomStatePayload {
                room_id: room.id.clone(),
                game_type: room.game_type.clone(),
                players: roster_of(room),
                max_players: room.max_players,
            })
            .unwrap_or_default(),
        )
    }; // rooms 读锁在此释放
    broadcast_in(state, room_id, msg, None).await;
}

fn roster_of(room: &Room) -> Vec<RoomPlayerInfo> {
    room.players
        .iter()
        .map(|(id, name)| RoomPlayerInfo {
            id: id.clone(),
            name: name.clone(),
        })
        .collect()
}


/// POST /api/scores：提交成绩，返回名次。内存版：每游戏最多保留 100 条，按分降序。
async fn submit_score(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ScoreSubmit>,
) -> Json<serde_json::Value> {
    let name = payload.player_name.trim().to_string();
    if name.is_empty() || name.len() > 32 || payload.game_type.trim().is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "invalid player_name or game_type" }));
    }

    let mut scores = state.scores.lock().await;
    let list = scores.entry(payload.game_type.clone()).or_default();
    list.push(ScoreEntry {
        player: name,
        score: payload.score,
        at: now_secs(),
    });
    // 名次 = 比我分高的条数 + 1（先算再排序，避免同分歧义）
    let rank = 1 + list.iter().filter(|e| e.score > payload.score).count() as u32;
    list.sort_by(|a, b| b.score.cmp(&a.score).then(a.at.cmp(&b.at)));
    list.truncate(100);

    info!("score submitted: {} {} -> rank {}", payload.game_type, payload.score, rank);
    Json(serde_json::json!({ "ok": true, "rank": rank }))
}

/// GET /api/leaderboard?game_type=X：前 10 名
async fn leaderboard_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LeaderboardQuery>,
) -> Json<serde_json::Value> {
    let scores = state.scores.lock().await;
    let entries: Vec<ScoreEntry> = scores
        .get(&q.game_type)
        .map(|l| l.iter().take(10).cloned().collect())
        .unwrap_or_default();
    Json(serde_json::json!({ "game_type": q.game_type, "entries": entries }))
}

async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "service": "mygames-gateway"
    }))
}

async fn games_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "games": [
            {"id": "snake-arena", "name": "Snake Arena", "players": "1-4"},
            {"id": "paddle-snacks", "name": "Paddle Snacks", "players": "1-1"},
            {"id": "paddle-cars", "name": "Paddle Cars", "players": "1-2"},
            {"id": "rl-battle", "name": "RL Battle", "players": "2-4"}
        ]
    }))
}

async fn rooms_handler(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let rooms = state.rooms.read().await;
    let list: Vec<RoomSummary> = rooms
        .values()
        .map(|r| RoomSummary {
            id: r.id.clone(),
            game_type: r.game_type.clone(),
            player_count: r.players.len(),
            max_players: r.max_players,
        })
        .collect();
    Json(serde_json::json!({ "rooms": list }))
}
