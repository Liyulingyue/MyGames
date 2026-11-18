# MyGames

AI 游戏与游戏平台合集。每个子项目自包含、独立构建与部署；`Lobby` 是唯一的常驻组件——游戏大厅基建。

## 项目地图

| 目录 | 类型 | 说明 |
|------|------|------|
| [Lobby/](Lobby/) | 常驻基建 | 游戏大厅：Rust 网关 + React/Vite 门户，提供身份、房间、匹配与通讯转发 |
| [PingpongGame/](PingpongGame/) | 独立游戏 | Three.js + MediaPipe 第一人称体感乒乓球（单机，本地 AI 对手），静态站点部署 |
| [PoseMatchPlatform/](PoseMatchPlatform/) | 独立平台 | AI 体感健身平台（React 前端 + FastAPI 后端），含关卡、多人、排行榜 |
| [MatchingAIPlatform/](MatchingAIPlatform/) | 独立游戏 | AI 匹配连连看（React 前端，纯本地游玩） |
| [services/ai-inference/](services/ai-inference/) | 共享服务 | Python FastAPI：姿态估计、LLM 对话等 AI 推理能力 |
| [legacy/](legacy/) | 存档 | 旧 PaddleGames 桌面版（PyQt5 + PaddlePaddle），已被 web 实现取代 |
| [references/](references/) | 资料 | 参考资料 |
| [scripts/](scripts/) | 工具 | 构建脚本（`scripts/build.sh` / `build.bat`） |

## 架构原则

- **游戏自包含**：每个游戏目录独立构建、独立部署，不依赖其他目录的代码，也不依赖根目录的任何工具链（根目录没有 Cargo.toml / package.json）。
- **大厅是唯一常驻组件**：身份、房间、匹配、通讯转发下沉到 `Lobby`；游戏只通过 SDK / 契约接入，不自建大厅与通讯逻辑。
- **玩法模拟永远在游戏侧**：大厅负责"把人聚齐、把消息送到"，不承载玩法逻辑；游戏间唯一的共享物是契约（消息协议与 SDK）。

## 快速开始

### 大厅（常驻）

```bash
# 后端网关 (http://0.0.0.0:7080)
cd Lobby/backend
cargo run -p gateway

# 前端门户 (http://localhost:5178，/api 与 /ws 代理到 7080)
cd Lobby/frontend
npm install
npm run dev
```

### PingpongGame（独立游戏）

```bash
cd PingpongGame
npm install
npm run dev
```

### 一键构建

```bash
scripts/build.sh    # 或 Windows 下 scripts/build.bat
```
