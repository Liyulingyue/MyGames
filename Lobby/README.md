# Lobby — 游戏大厅（常驻基建）

为所有游戏提供身份、房间、匹配与实时通讯转发，让游戏不必自建大厅、联机与通讯逻辑。

## 定位

- **常驻**：一次构建部署后长期运行，是本仓库唯一的后台服务组件。
- **契约统一、实现解耦**：游戏只依赖 SDK（`frontend/packages/game-sdk`），不感知服务器内部结构；玩法模拟永远在游戏侧，大厅只负责"把人聚齐、把消息送到"。
- **新游戏接入标准**：实现 3 个钩子（取身份、报成绩、可选开启实时会话），不改大厅代码。

## 结构

```
Lobby/
├── backend/                 # Rust workspace（Axum）
│   ├── gateway/             # 入口服务：REST (/health, /api/games) + WebSocket (/ws)，端口 7080
│   ├── protocol/            # 消息协议定义（WSMessage / MessageType 等）
│   └── utils/
└── frontend/                # React + Vite
    ├── src/                 # 大厅 UI + 内置体感游戏（first-party）
    ├── apps/portal/         # 大厅 Vite 入口（:3000，渲染 ../src 的 App）
    ├── apps/games/paddle-snacks/
    └── packages/
        ├── game-sdk/        # 游戏接入 SDK：WS 客户端 + 协议 TS 类型（单源）
        └── ui/
```

## 快速开始

```bash
# 后端网关 (http://0.0.0.0:7080)
cd backend
cargo run -p gateway

# 前端门户 (http://localhost:5178)
cd frontend
npm install
npm run dev        # /api 与 /ws 已代理到 localhost:7080
```

## 通信协议

WebSocket 消息结构（Rust 侧权威定义在 `backend/protocol/src/lib.rs`，TS 侧对齐在 `frontend/packages/game-sdk/src/index.ts`，两侧保持一致）：

```jsonc
{
  "msg_type": "join_game",   // ping | pong | join_game | leave_game | game_state
                             // | player_action | chat | error | match_found | matchmaking
  "game_id": null,
  "player_id": null,
  "payload": {}
}
```

## 游戏接入指南

1. **取身份**：连接 `ws://<host>:7080/ws`，发送 `join_game { player_name, game_type }`。
2. **进房**：收到 `match_found`，携带 `room_id` 与 `player_id`。
3. **实时会话**（可选，规划中）：通过 game-sdk 收发玩家输入与状态快照。
4. **成绩上报**（规划中）：统一 REST 接口。

## 已知状态 / 路线图

- [x] 目录化：大厅自包含于本文件夹，根目录不再承载任何构建配置
- [x] gateway 基础骨架：REST + WS 接入、按 game_type 聚合房间
- [ ] 真实房间生命周期（容量、满员开局、解散、掉线重连）
- [ ] 输入上行 / 快照下行转发（哑中继模式）
- [ ] game-sdk 收敛为唯一 WS 客户端（当前 `frontend/src/store/gameStore.ts` 为重复实现）
- [ ] portal 合并为前端唯一入口（当前与根 Vite 入口重复）
- [ ] docker-compose 常驻部署（含 nginx 的 /ws 反代）
