/**
 * 击球几何体检：统计每一次击球时"球心相对拍心"的位置。
 *
 * 这是调球拍行程 / 命中判定的主要依据，回答四个问题：
 *   1. 接触点落在台面内还是台面外（|x| vs 台面半宽）
 *   2. 球有没有真的贴在拍面上（球心到拍面边缘的间隙，<=0 才算贴上）
 *   3. 横向 / 纵向 / 深度三个方向的偏差各有多大
 *   4. 命中率（打中次数 vs 球落我方半台的次数）
 *
 * 正常情况下应该看到：间隙中位数 <= 0、球拍中心不超出台面半宽、
 * 命中率接近 100%。
 *
 * 运行： node --experimental-strip-types scripts/analyze_contact.ts [局数] [每局秒数]
 *   例： node --experimental-strip-types scripts/analyze_contact.ts 20 60
 *
 * 输出全部用 ASCII（Windows 控制台直接输出中文会乱码）。
 */

import { PingPongGame } from '../src/core/game.ts'
import { BALL, PADDLE, TABLE } from '../src/core/constants.ts'
import { clamp } from '../src/core/vec3.ts'

const games = Number(process.argv[2] ?? 20)
const seconds = Number(process.argv[3] ?? 60)
const fps = 60

/** 球心到拍面边缘的物理半径：球贴上拍面的极限距离 */
const CONTACT_RADIUS = PADDLE.radius + BALL.radius

interface Contact {
  side: 'player' | 'opponent'
  /** 接触点位置 */
  x: number
  y: number
  z: number
  /** 拍心位置 */
  paddleX: number
  paddleY: number
  paddleZ: number
  /** 球心相对拍心的三个方向偏差 */
  lateral: number
  vertical: number
  depth: number
  /** 球心到拍心的 3D 距离 */
  dist: number
  /** 球心到拍面边缘的间隙（<=0 表示球真的贴在拍上） */
  bladeGap: number
}

interface SwingSnap {
  lateral: number
  vertical: number
  depth: number
  /** 挥拍瞬间球距球拍平面的距离（沿 Z） */
  gap: number
}

const contacts: Contact[] = []
const swings: SwingSnap[] = []
const misses: SwingSnap[] = []
/** 已挥出但还没判定结果的挥拍 */
const pendingSwings: Array<{ time: number; hit: boolean; snap: SwingSnap }> = []
/** 球在我方半台落过的次数（玩家本该接到的球） */
let playerChances = 0
/** 球在对方半台落过的次数（AI 本该接到的球） */
let aiChances = 0
/** 球拍中心超出台面行程的次数 */
let paddleOutOfRange = 0

for (let g = 0; g < games; g++) {
  const game = new PingPongGame({ seed: 1000 + g, ai: 'normal', autoHeight: true })
  game.start()

  const dt = 1 / fps
  const steps = Math.round(seconds / dt)

  for (let i = 0; i < steps; i++) {
    const s = game.state

    // "完美玩家"：球拍横向直接跟到球的位置（等价于游戏内的辅助移动）
    if (s.ball.pos.z < 0 && s.ball.vel.z < 0) {
      game.setPlayerTarget(clamp(s.ball.pos.x, -PADDLE.rangeX, PADDLE.rangeX))
      const p = s.playerPaddle
      const d = Math.hypot(s.ball.pos.x - p.x, s.ball.pos.y - p.y, s.ball.pos.z - p.z)
      const gap = s.ball.pos.z - PADDLE.homeZ
      if (d < 0.16 && gap < 0.16 && gap > -0.1 && game.swing(0.85)) {
        const snap: SwingSnap = {
          lateral: s.ball.pos.x - p.x,
          vertical: s.ball.pos.y - p.y,
          depth: Math.abs(s.ball.pos.z - p.z),
          gap,
        }
        swings.push(snap)
        pendingSwings.push({ time: s.elapsed, hit: false, snap })
      }
    }

    for (const ev of game.step(dt)) {
      if (ev.type === 'bounce' && ev.side === 'player') playerChances++
      else if (ev.type === 'bounce' && ev.side === 'opponent') aiChances++

      if (ev.type === 'paddleHit' && ev.pos && ev.side) {
        if (ev.side === 'player') {
          for (const sw of pendingSwings) sw.hit = true
        }
        const paddle = ev.side === 'player' ? s.playerPaddle : s.opponentPaddle
        const lateral = ev.pos.x - paddle.x
        const vertical = ev.pos.y - paddle.y
        const depth = ev.pos.z - paddle.z
        const dist = Math.hypot(lateral, vertical, depth)
        contacts.push({
          side: ev.side,
          x: ev.pos.x,
          y: ev.pos.y,
          z: ev.pos.z,
          paddleX: paddle.x,
          paddleY: paddle.y,
          paddleZ: paddle.z,
          lateral,
          vertical,
          depth,
          dist,
          bladeGap: dist - CONTACT_RADIUS,
        })
        if (Math.abs(paddle.x) > PADDLE.rangeX + 1e-6) paddleOutOfRange++
      }
    }

    if (s.phase === 'gameover') break

    // 挥拍窗口早就过了还没打中 → 记一次挥空
    while (pendingSwings.length && s.elapsed - pendingSwings[0].time > 0.25) {
      const sw = pendingSwings.shift()!
      if (!sw.hit) misses.push(sw.snap)
    }
  }

  for (const sw of pendingSwings) {
    if (!sw.hit) misses.push(sw.snap)
  }
}

// ------------------------------------------------------------------ 输出工具

function quantile(values: number[], p: number): number {
  if (!values.length) return NaN
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function spread(label: string, values: number[]): string {
  if (!values.length) return `${label} (no data)`
  return (
    `${label} mid=${quantile(values, 0.5).toFixed(3)} ` +
    `p90=${quantile(values, 0.9).toFixed(3)} max=${Math.max(...values).toFixed(3)}`
  )
}

function pct(n: number, total: number): string {
  return total ? `${n} (${((n / total) * 100).toFixed(1)}%)` : `${n} (n/a)`
}

// ------------------------------------------------------------------ 报告

const player = contacts.filter((c) => c.side === 'player')
const opponent = contacts.filter((c) => c.side === 'opponent')

console.log(
  `TABLE halfWidth=${TABLE.halfWidth}  PADDLE rangeX=${PADDLE.rangeX} ` +
    `bladeReach=${PADDLE.bladeReach} swingDepth=${PADDLE.swingDepth} ` +
    `contactRadius=${CONTACT_RADIUS.toFixed(3)}\n`,
)

console.log('--- contact point |x| (table edge = ' + TABLE.halfWidth + ') ---')
for (const [label, list] of [
  ['player  ', player],
  ['opponent', opponent],
] as const) {
  const xs = list.map((c) => Math.abs(c.x))
  const outside = list.filter((c) => Math.abs(c.x) > TABLE.halfWidth).length
  console.log(
    `${label} n=${list.length} ${spread('|x|', xs)} | outsideTable=${pct(outside, list.length)}`,
  )
}

console.log('\n--- ball vs blade surface (gap <= 0 means ball touches the blade) ---')
for (const [label, list] of [
  ['player  ', player],
  ['opponent', opponent],
] as const) {
  const gaps = list.map((c) => c.bladeGap)
  const detached = list.filter((c) => c.bladeGap > 0.01).length
  const far = list.filter((c) => c.bladeGap > 0.08).length
  console.log(
    `${label} n=${list.length} ${spread('gap', gaps)} | detached(>1cm)=${pct(detached, list.length)}` +
      ` far(>8cm)=${pct(far, list.length)}`,
  )
}

console.log('\n--- deviation per axis ---')
for (const [label, list] of [
  ['player  ', player],
  ['opponent', opponent],
] as const) {
  console.log(
    `${label} ${spread('lateral', list.map((c) => Math.abs(c.lateral)))} | ` +
      `${spread('vertical', list.map((c) => Math.abs(c.vertical)))} | ` +
      `${spread('depth', list.map((c) => Math.abs(c.depth)))}`,
  )
}

console.log('\n--- hit rate (hits / balls that bounced on that side) ---')
console.log(
  `player   chances=${playerChances} hits=${player.length} ` +
    `rate=${playerChances ? ((player.length / playerChances) * 100).toFixed(1) : 'n/a'}%`,
)
console.log(
  `opponent chances=${aiChances} hits=${opponent.length} ` +
    `rate=${aiChances ? ((opponent.length / aiChances) * 100).toFixed(1) : 'n/a'}%`,
)

console.log('\n--- paddle vs table ---')
console.log(
  `paddleCenterOutsideRange=${paddleOutOfRange} (rangeX=+/-${PADDLE.rangeX}) ` +
    `bladeEdgeMax=${(PADDLE.rangeX + PADDLE.radius).toFixed(3)} (table edge=${TABLE.halfWidth})`,
)

console.log('\n--- swings that missed ---')
console.log(
  `swings=${swings.length} missed=${misses.length} ` +
    `(${swings.length ? ((misses.length / swings.length) * 100).toFixed(1) : 'n/a'}%)`,
)
if (misses.length) {
  console.log(
    `  at swing moment: ${spread('lateral', misses.map((m) => Math.abs(m.lateral)))} | ` +
      `${spread('vertical', misses.map((m) => Math.abs(m.vertical)))} | ` +
      `${spread('gap', misses.map((m) => m.gap))}`,
  )
}
