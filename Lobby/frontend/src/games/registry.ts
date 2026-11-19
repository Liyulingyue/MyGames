/**
 * 大厅游戏注册表 —— 大厅与游戏之间的"目录"。
 *
 * kind = 'internal'：SPA 内部路由游戏（同一个 vite 工程，走 @lobby/game-sdk 联机）
 * kind = 'external'：外部独立站点，经嵌入契约（iframe + postMessage）进场，
 *                    例如 PingpongGame。大厅只负责启动它、注入身份、回收成绩。
 */
export type GameKind = 'internal' | 'external'

export interface GameEntry {
  id: string
  kind: GameKind
  name: string
  players: string
  description: string
  icon: string
  gradient: string
  /** internal：SPA 路由；external：外部站点 origin（dev 用本地端口，生产换部署地址） */
  path?: string
  url?: string
  instructions?: string[]
  features?: string[]
}

export const GAMES: GameEntry[] = [
  {
    id: 'snake-arena',
    kind: 'internal',
    name: 'Snake Arena 竞技场',
    players: '1-4',
    description: '多人实时贪吃蛇 - 主机权威联机，吃食物、躲蛇身，90 秒决胜负',
    icon: '🕹️',
    gradient: 'from-sky-400 to-blue-600',
    path: '/games/snake-arena',
    instructions: ['方向键 / WASD 控制转向', '吃食物得分，撞墙撞蛇会死亡', '90 秒一局，死后 2 秒复活', '房主是权威主机，其他人输入经大厅中继', '支持单人练习，也可以开房间真人对战'],
    features: ['多人实时', '主机权威', '断线重连', '排行榜'],
  },
  {
    id: 'pingpong',
    kind: 'external',
    name: '体感乒乓 3D',
    players: '1',
    description: '第一人称体感乒乓 - 独立部署的 Three.js + MediaPipe 游戏，经嵌入契约进场',
    icon: '🏓',
    gradient: 'from-emerald-400 to-teal-600',
    url: 'http://localhost:5180',
    instructions: ['需先启动 PingpongGame（开发：npm run dev；生产：docker :16083）', '摄像头模式需在 localhost 或 HTTPS 下打开', '成绩通过嵌入契约回传大厅'],
    features: ['3D', '体感', '外接游戏'],
  },
  {
    id: 'embed-demo',
    kind: 'external',
    name: '嵌入示例',
    players: '1',
    description: '外部游戏接入契约的活文档：10 秒点击挑战，演示身份注入与成绩回传',
    icon: '🧩',
    gradient: 'from-amber-400 to-orange-600',
    url: `${typeof location !== 'undefined' ? location.origin : ''}/embed-demo.html`,
    instructions: ['这是给外部游戏开发者看的参考实现', '源码：frontend/public/embed-demo.html', '接入只需一行 <script src="/lobby-embed.js">'],
    features: ['契约示例'],
  },
  {
    id: 'pose-snake',
    kind: 'internal',
    name: 'PoseSnake (四向)',
    players: '1-1',
    description: '姿态控制贪吃蛇 - 挥手操控，上下左右移动',
    icon: '🐍',
    gradient: 'from-green-400 to-emerald-500',
    path: '/games/pose-snake',
    instructions: ['站立在摄像头前', '向左挥手控制蛇向左移动', '向右挥手控制蛇向右移动', '向上挥手控制蛇向上移动', '向下挥手控制蛇向下移动'],
    features: ['体感控制', '无需手柄', 'AI 辅助'],
  },
  {
    id: 'pose-snake-2',
    kind: 'internal',
    name: 'PoseSnake 2 (任意方向)',
    players: '1-1',
    description: '连续角度控制 - 左右转向，任意方向移动',
    icon: '🐍',
    gradient: 'from-teal-400 to-cyan-500',
    path: '/games/pose-snake-2',
    instructions: ['站立在摄像头前', '左手向左转控制蛇向左转', '右手向右转控制蛇向右转', '蛇会连续转向移动'],
    features: ['360度方向控制', '流畅转向', '极限操作'],
  },
  {
    id: 'pose-match',
    kind: 'internal',
    name: 'Pose Match',
    players: '1',
    description: '摆出指定姿势，匹配即得分',
    icon: '🎯',
    gradient: 'from-yellow-400 to-orange-500',
    path: '/games/pose-match',
    instructions: ['屏幕显示目标姿势', '玩家摆出相同姿势', '匹配度达到80%即可得分', '30秒内尽量多得分数'],
    features: ['姿势识别', '反应训练', '体能挑战'],
  },
  {
    id: 'pose-cars',
    kind: 'internal',
    name: 'Pose Cars',
    players: '1-2',
    description: '飙车躲避游戏，考验反应速度',
    icon: '🏎️',
    gradient: 'from-red-400 to-orange-500',
    path: '/games/pose-cars',
    instructions: ['使用左右手控制左右移动', '躲避对面来车', '坚持越久分数越高'],
    features: ['双人对抗', '反应训练', '竞技模式'],
  },
  {
    id: 'rl-battle',
    kind: 'internal',
    name: 'RL Battle',
    players: '2-4',
    description: 'AI 强化学习对战，极限思考',
    icon: '🤖',
    gradient: 'from-purple-400 to-indigo-500',
    path: '/games/rl-battle',
    instructions: ['与 AI 进行对战', '思考每一步策略', '击败 AI 获得胜利'],
    features: ['AI 对战', '策略思考', '多人竞技'],
  },
]

export function findGame(id: string | undefined): GameEntry | undefined {
  return GAMES.find((g) => g.id === id)
}

/** 内部游戏启动地址；外部游戏由 ExternalGameHost 处理 */
export function launchPathOf(game: GameEntry, playerName: string): string {
  const q = `player=${encodeURIComponent(playerName)}`
  return `${game.path}?${q}`
}
