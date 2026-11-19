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
  "msg_type": "join_game",
  "player_id": null,       // 中继类消息由服务端填上发送者 id
  "payload": {}
}
```

| 消息 | 方向 | 语义 |
|------|------|------|
| `ping` / `pong` | C→S / S→C | 心跳，pong 原样回带 payload 供客户端算延迟 |
| `join_game` | C→S | 进房 `{player_name, game_type, max_players?}`；分配未满房间或新建（容量 1-8，默认 4，由建房者指定） |
| `join_room` | C→S | 定向加入 `{room_id, player_name}`（大厅实时房间的加入按钮）；房间不存在/已满回 error |
| `match_found` | S→C | 回给本人：`{room_id, player_id, players, max_players}` |
| `peer_joined` / `peer_left` | S→C | 房内其他人进/出通知 |
| `room_state` | S→C | 全量花名册广播，每次成员变动推送 |
| `player_action` | C→S | 输入上行，大厅原样转发给房内其他人（`peer_action`，带来源 id） |
| `game_state` | C→S | 快照广播（权威主机用），原样转发（带来源 id） |
| `chat` | C→S | 转发（带来源 id） |
| `leave_game` | C→S | 退房；房空即解散 |
| `error` | S→C | `{code, message}` |

REST：`GET /health`、`GET /api/games`、`GET /api/rooms`（当前房间与人数）。

**大厅是哑中继**：不存储任何玩法状态，消息到齐只做转发——模拟与判定永远在游戏侧。

## 游戏接入指南

游戏注册表：`frontend/src/games/registry.ts`（内置 + 外接两种类型）。接入分两条路：

### 路线 A：内部游戏（SPA 内路由，要联机）

用 `@lobby/game-sdk`（`frontend/packages/game-sdk`）：

```ts
import { LobbyClient } from '…/packages/game-sdk/src'

const client = new LobbyClient()          // 默认连同源 /ws（开发走 vite 代理）
client.on('match_found',  (info) => console.log(info.room_id, info.players))
client.on('peer_action',  ({ from, payload }) => game.applyRemoteInput(from, payload))
client.on('peer_left',    ({ player_id }) => game.removeRemotePlayer(player_id))
client.connect()
client.joinGame('your-game', { playerName: 'Alice', maxPlayers: 2 })

client.sendAction({ move: 'left', power: 0.7 })   // 输入上行
client.sendState({ tick: 42, ball: {...} })       // 快照广播（权威主机）
```

或直接用 zustand 工厂：`createLobbyStore()` → `useGameStore`。
参考实现：**SnakeArena**（主机权威联机 + 成绩上报，`src/games/snake-arena/`）。

### 路线 B：外部独立游戏（iframe 嵌入契约，PingpongGame 走这条）

独立站点也能进大厅——**不需要改游戏的技术栈，甚至一行不改也能进**（只是没有身份/成绩）：

1. 在 `registry.ts` 注册：`{ kind: 'external', url: 'http://localhost:5180', ... }`
2. 玩家点击卡片 → `/games/ext/:id` → iframe 承载，整页跳转（外接页不带 COEP，见下）
3. （推荐）游戏侧加一行接入脚本，获得身份注入与成绩回传：

```html
<script src="http://<lobby-host>/lobby-embed.js"></script>
<script>
  // LobbyEmbed.player.name 是大厅注入的玩家名；对局结束时报成绩：
  LobbyEmbed.reportScore(finalScore)
</script>
```

**嵌入契约（postMessage，双向）**：

| 方向 | 消息 | 语义 |
|------|------|------|
| 大厅 → 游戏 | `{type:'lobby:hello', game_id, player_name}` | 身份注入（iframe onLoad 与收到 ready 时各发一次，另附 `?player=` 查询参数） |
| 游戏 → 大厅 | `{type:'lobby:ready'}` | 游戏就绪（lobby-embed.js 自动发） |
| 游戏 → 大厅 | `{type:'lobby:score', score}` | 成绩上报 → 大厅落库 `/api/scores` |

活文档/参考实现：`frontend/public/embed-demo.html`（大厅里点"嵌入示例"即可看到全流程）。

### COEP 说明（重要）

体感游戏需要 `Cross-Origin-Embedder-Policy: require-corp`（MediaPipe 的跨源隔离），
但它会拦截不带 CORP 头的跨源 iframe。因此：

- 开发：`vite.config.ts` 的 `coepPerRoute()` 插件对 `/games/ext/*` 不注入 COEP，其余路由照旧；
- 外接游戏页必须**整页跳转**进入（SPA 内导航不会重新取文档，隔离态洗不掉）；
- 生产 nginx 部署时需同样按 `location /games/ext` 分流（不加 COEP 头），其余 `add_header` 照旧。

## 已知状态 / 路线图

- [x] 目录化：大厅自包含于本文件夹，根目录不再承载任何构建配置
- [x] 真实房间生命周期（容量、分配、解散、掉线清理）——双客户端 E2E 全过
- [x] 输入上行 / 快照下行转发（哑中继模式）
- [x] game-sdk 收敛为唯一 WS 客户端（三份重复实现已合一）
- [x] portal 唯一入口（删除 apps/portal 重复入口，根 Vite :5178 即门户）
- [x] 成绩上报：`POST /api/scores` + `GET /api/leaderboard`（内存版，重启即清；持久化待 docker-compose 阶段）
- [x] **SnakeArena（内置参考游戏）**：2-4 人主机权威联机 + 主机掉线无缝迁移 + 排行榜，
      是"如何在平台上写联机游戏"的标准答案（`frontend/src/games/snake-arena/sim.ts` 纯逻辑可搬服务端）
- [x] 大厅暗色街机主题 + 实时房间一键加入（`join_room` 协议 + `?room=` 参数，E2E 已验证）
- [ ] docker-compose 常驻部署（含 nginx 的 /ws 反代 + 成绩持久化）
- [ ] 嵌入契约（iframe + postMessage 身份注入），供 PingpongGame 等外部独立游戏接入
- [ ] 房主中途离开的战局恢复策略（当前：接管者以最后快照续跑，已够用）
