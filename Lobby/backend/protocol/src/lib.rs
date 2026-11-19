use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("Invalid message type: {0}")]
    InvalidMessageType(String),
    #[error("Serialization error: {0}")]
    SerializationError(String),
    #[error("Deserialization error: {0}")]
    DeserializationError(String),
}

/// 线上消息信封。大厅只做"哑中继"：玩法语义全部在 payload 里，由游戏自解释。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WSMessage {
    pub msg_type: MessageType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_id: Option<String>,
    pub payload: serde_json::Value,
}

/// 消息类型。方向约定：
/// - 客户端 → 服务端：ping / join_game / leave_game / player_action / game_state / chat
/// - 服务端 → 客户端：pong / match_found / peer_joined / peer_left / room_state / peer_action / game_state(转发) / chat(转发) / error
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    Ping,
    Pong,
    JoinGame,
    JoinRoom,
    LeaveGame,
    MatchFound,
    PeerJoined,
    PeerLeft,
    RoomState,
    PlayerAction,
    PeerAction,
    GameState,
    Chat,
    Error,
    Matchmaking,
}

impl WSMessage {
    pub fn new(msg_type: MessageType, payload: serde_json::Value) -> Self {
        Self {
            msg_type,
            game_id: None,
            player_id: None,
            payload,
        }
    }

    pub fn with_player(mut self, player_id: String) -> Self {
        self.player_id = Some(player_id);
        self
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        serde_json::to_vec(self).map_err(|e| ProtocolError::SerializationError(e.to_string()))
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProtocolError> {
        serde_json::from_slice(bytes).map_err(|e| ProtocolError::DeserializationError(e.to_string()))
    }
}

/// 客户端 → 服务端：进房。大厅按 game_type 分配现有未满房间，没有则新建；
/// 房间容量由首名（建房）玩家指定，缺省 4，范围 1..=8。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinGamePayload {
    pub player_name: String,
    pub game_type: String,
    #[serde(default)]
    pub max_players: Option<usize>,
}

/// 客户端 → 服务端：按 id 加入指定房间（大厅"实时房间"列表的加入按钮）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinRoomPayload {
    pub room_id: String,
    pub player_name: String,
}

/// 服务端 → 客户端：进房成功（回给发起者本人）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchFoundPayload {
    pub room_id: String,
    pub player_id: String,
    pub players: Vec<RoomPlayerInfo>,
    pub max_players: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomPlayerInfo {
    pub id: String,
    pub name: String,
}

/// 服务端 → 客户端：有人进房（回给房内其他人）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerJoinedPayload {
    pub player_id: String,
    pub player_name: String,
}

/// 服务端 → 客户端：有人离开/掉线（回给房内其他人）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerLeftPayload {
    pub player_id: String,
}

/// 服务端 → 客户端：房间花名册广播（每次成员变动都推全量）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomStatePayload {
    pub room_id: String,
    pub game_type: String,
    pub players: Vec<RoomPlayerInfo>,
    pub max_players: usize,
}

/// 服务端 → 客户端：错误。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

/// REST /api/rooms 行。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomSummary {
    pub id: String,
    pub game_type: String,
    pub player_count: usize,
    pub max_players: usize,
}
