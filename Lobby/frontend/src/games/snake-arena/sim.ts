/**
 * Snake Arena 纯逻辑核心。
 *
 * 不 import 任何 DOM / React / 网络模块——与 PingpongGame/core 同一哲学：
 * 这份文件可以在浏览器跑（主机权威客户端），也可以原样搬进 Node/服务端做权威模拟。
 *
 * 确定性约定：同序遍历 snakes 数组，随机性仅用于食物与重生点（不影响判定公平性）。
 */

export const GRID_W = 32
export const GRID_H = 24
export const TICK_MS = 100
/** 90 秒一局（900 tick） */
export const ROUND_TICKS = 900
export const FOOD_TARGET = 3
export const MAX_PLAYERS = 4
/** 死亡后重生等待（tick） */
export const RESPAWN_TICKS = 20

export type Dir = 'up' | 'down' | 'left' | 'right'

export const DIR_VECTORS: Record<Dir, Vec2> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

export interface Vec2 {
  x: number
  y: number
}

export interface SnakeState {
  id: string
  name: string
  /** 调色板索引，渲染用 */
  color: number
  /** 头在前 */
  body: Vec2[]
  dir: Vec2
  /** 玩家的下一转向意图，下一 tick 应用（防一 tick 内反向） */
  pending: Vec2 | null
  alive: boolean
  /** 死亡后的重生倒计时（tick） */
  respawnIn: number
  score: number
}

export interface FoodState {
  x: number
  y: number
}

export type Phase = 'lobby' | 'running' | 'ended'

export interface SimState {
  phase: Phase
  tick: number
  snakes: SnakeState[]
  foods: FoodState[]
}

export function createSim(): SimState {
  return { phase: 'lobby', tick: 0, snakes: [], foods: [] }
}

function cellFree(sim: SimState, x: number, y: number): boolean {
  if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return false
  for (const s of sim.snakes) {
    for (const seg of s.body) {
      if (seg.x === x && seg.y === y) return false
    }
  }
  return !sim.foods.some((f) => f.x === x && f.y === y)
}

function randomFreeCell(sim: SimState): Vec2 {
  for (let i = 0; i < 200; i++) {
    const x = Math.floor(Math.random() * GRID_W)
    const y = Math.floor(Math.random() * GRID_H)
    if (cellFree(sim, x, y)) return { x, y }
  }
  // 场地几乎满时线性扫描兜底
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (cellFree(sim, x, y)) return { x, y }
    }
  }
  return { x: 0, y: 0 }
}

/** 出生点选择：头、第二节（头左侧）、行进前方一格都空闲——杜绝"出生/重生即撞墙"。
 *  场地拥挤时返回 null，由调用方决定兜底。初次出生与重生共用，保证行为一致。 */
function pickSpawnBody(sim: SimState): Vec2[] | null {
  for (let i = 0; i < 200; i++) {
    const x = 1 + Math.floor(Math.random() * (GRID_W - 2))
    const y = Math.floor(Math.random() * GRID_H)
    if (!cellFree(sim, x, y)) continue
    if (!cellFree(sim, x - 1, y)) continue
    if (!cellFree(sim, x + 1, y)) continue
    return [{ x, y }, { x: x - 1, y }]
  }
  return null
}

/** 拥挤兜底：任意空闲格 + 朝右（可能很快再死，但可接受） */
function fallbackBody(sim: SimState): Vec2[] {
  const head = randomFreeCell(sim)
  const second: Vec2 = head.x > 0 ? { x: head.x - 1, y: head.y } : { x: head.x + 1, y: head.y }
  return [head, second]
}

function spawnSnakeBody(sim: SimState, color: number, id: string, name: string): SnakeState {
  const body = pickSpawnBody(sim) ?? fallbackBody(sim)
  return pushSnake(sim, color, id, name, body)
}

function pushSnake(sim: SimState, color: number, id: string, name: string, body: Vec2[]): SnakeState {
  const snake: SnakeState = {
    id,
    name,
    color,
    body,
    dir: { x: 1, y: 0 },
    pending: null,
    alive: true,
    respawnIn: 0,
    score: 0,
  }
  sim.snakes.push(snake)
  return snake
}

export function addSnake(sim: SimState, id: string, name: string): void {
  if (sim.snakes.some((s) => s.id === id)) return
  const color = sim.snakes.length % MAX_PLAYERS
  spawnSnakeBody(sim, color, id, name)
  // 对局中途加入：直接可玩；lobby 阶段加入：食物还没生成，无需处理
  if (sim.phase === 'running') fillFoods(sim)
}

export function removeSnake(sim: SimState, id: string): void {
  sim.snakes = sim.snakes.filter((s) => s.id !== id)
}

/** 设置转向意图。返回是否接受（活着且不是反向）。 */
export function setDirection(sim: SimState, id: string, dir: Dir): boolean {
  const snake = sim.snakes.find((s) => s.id === id)
  if (!snake || !snake.alive) return false
  const v = DIR_VECTORS[dir]
  // 反向判定以"当前行驶方向"为准（pending 仅缓存到下一 tick）
  if (v.x === -snake.dir.x && v.y === -snake.dir.y) return false
  if (v.x === snake.dir.x && v.y === snake.dir.y) return true
  snake.pending = { x: v.x, y: v.y }
  return true
}

function fillFoods(sim: SimState): void {
  while (sim.foods.length < FOOD_TARGET) {
    sim.foods.push(randomFreeCell(sim))
  }
}

/** 原地重生：保留对象身份（外部引用不失效），只换身体、位置与朝向。
 *  与初次出生共用同一套受约束的出生点选择。 */
function respawn(snake: SnakeState, sim: SimState): void {
  snake.body = pickSpawnBody(sim) ?? fallbackBody(sim)
  snake.dir = { x: 1, y: 0 }
  snake.pending = null
  snake.alive = true
  snake.respawnIn = 0
}

function killSnake(snake: SnakeState): void {
  snake.alive = false
  snake.body = []
  snake.respawnIn = RESPAWN_TICKS
  snake.pending = null
}

/** 开始/重开一局：重置分数与位置，进入 running */
export function startRound(sim: SimState): void {
  const roster = sim.snakes.map((s) => ({ id: s.id, name: s.name, color: s.color }))
  sim.snakes = []
  sim.foods = []
  sim.tick = 0
  for (const r of roster) {
    spawnSnakeBody(sim, r.color, r.id, r.name)
  }
  fillFoods(sim)
  sim.phase = 'running'
}

/** 推进一个 tick。仅 phase === 'running' 时有效。 */
export function stepTick(sim: SimState): void {
  if (sim.phase !== 'running') return
  sim.tick++

  // 1. 应用转向意图
  for (const s of sim.snakes) {
    if (s.alive && s.pending) {
      const v = s.pending
      s.pending = null
      if (!(v.x === -s.dir.x && v.y === -s.dir.y)) {
        s.dir = v
      }
    }
  }

  // 2. 依次移动（房主端数组顺序确定 → 各端确定性一致）
  for (const s of sim.snakes) {
    if (!s.alive) continue
    const head = s.body[0]
    const nx = head.x + s.dir.x
    const ny = head.y + s.dir.y

    // 撞墙
    if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) {
      killSnake(s)
      continue
    }
    // 撞任何身体（含自己）
    let hit = false
    for (const other of sim.snakes) {
      for (const seg of other.body) {
        if (seg.x === nx && seg.y === ny) {
          hit = true
          break
        }
      }
      if (hit) break
    }
    if (hit) {
      killSnake(s)
      continue
    }

    s.body.unshift({ x: nx, y: ny })
    const foodIdx = sim.foods.findIndex((f) => f.x === nx && f.y === ny)
    if (foodIdx >= 0) {
      s.score++
      sim.foods.splice(foodIdx, 1)
      fillFoods(sim)
    } else {
      s.body.pop()
    }
  }

  // 3. 重生计时
  for (const s of sim.snakes) {
    if (!s.alive) {
      s.respawnIn--
      if (s.respawnIn <= 0) respawn(s, sim)
    }
  }

  // 4. 终局
  if (sim.tick >= ROUND_TICKS) {
    sim.phase = 'ended'
  }
}

export interface Leader {
  id: string
  name: string
  score: number
}

export function leaderOf(sim: SimState): Leader | null {
  let best: Leader | null = null
  for (const s of sim.snakes) {
    if (!best || s.score > best.score) {
      best = { id: s.id, name: s.name, score: s.score }
    }
  }
  return best
}

/** HUD 用的轻量摘要（避免整只 sim 进 React 状态） */
export interface SimSummary {
  phase: Phase
  remaining: number
  players: { id: string; name: string; color: number; score: number; alive: boolean }[]
}

export function summarize(sim: SimState): SimSummary {
  return {
    phase: sim.phase,
    remaining: Math.max(0, ROUND_TICKS - sim.tick),
    players: sim.snakes.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      score: s.score,
      alive: s.alive,
    })),
  }
}
