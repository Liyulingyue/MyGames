/**
 * 核心数据类型。
 *
 * 本目录（core/）刻意不依赖 DOM、Canvas、three.js 或任何浏览器 API，
 * 只描述"游戏世界"本身。这样它既能跑在浏览器里，也能原样搬到 Node 服务端
 * 作为权威状态（server-authoritative）使用。
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** 玩家方 / 对手方 */
export type Side = 'player' | 'opponent'

/** 对局阶段 */
export type Phase =
  /** 未开始 */
  | 'idle'
  /** 准备发球（短暂停顿） */
  | 'serve'
  /** 回合进行中 */
  | 'rally'
  /** 得分结算（短暂停顿） */
  | 'point'
  /** 一局结束 */
  | 'gameover'

export interface Ball {
  pos: Vec3
  vel: Vec3
  /** 绕 Y 轴的旋转量，影响飞行中的弧线（弧线球） */
  spin: number
}

export interface Paddle {
  /** 球拍中心 X（左右，-0.7625 ~ +0.7625 为台面范围） */
  x: number
  /** 球拍中心 Y（台面高度为 0） */
  y: number
  /** 球拍所在 Z（我方为负，对手为正） */
  z: number
  /** 水平速度（用于击球加力） */
  vx: number
  /** 垂直速度 */
  vy: number
  /** 挥拍判定剩余时间，> 0 表示球拍处于"可击中"状态 */
  activeTimer: number
  /** 挥拍冷却，防止连发 */
  cooldown: number
  /** 最近一次挥拍力度 0~1 */
  lastSwingPower: number
  /** 挥拍动画进度 0~1，1 表示刚刚挥出 */
  swingAnim: number
}

export type GameEventType =
  | 'serve'
  | 'bounce'
  | 'paddleHit'
  | 'netHit'
  | 'floor'
  | 'out'
  | 'point'
  | 'gameOver'
  | 'swing'
  | 'aiMiss'

export interface GameEvent {
  type: GameEventType
  /** 事件发生的半场（若适用） */
  side?: Side
  pos?: Vec3
  /** 击球力度 0~1 */
  power?: number
  /** 得分变化后的比分 */
  score?: { player: number; opponent: number }
  /** 胜者 */
  winner?: Side
  /** 面向玩家的提示文案 */
  message?: string
}

export interface Score {
  player: number
  opponent: number
}
