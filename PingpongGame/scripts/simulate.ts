/**
 * 无头模拟：不需要浏览器，直接跑核心规则。
 *
 * 用途：
 *   - 验证回合流程（对手落台 → 我方落台 → 挥拍回击）是否闭环
 *   - 验证比分、得分判定、球的物理是否符合预期
 *
 * 运行： node --experimental-strip-types scripts/simulate.ts
 */

import { PingPongGame } from '../src/core/game.ts'
import { PADDLE } from '../src/core/constants.ts'
import { clamp } from '../src/core/vec3.ts'

const seed = Number(process.argv[2] ?? 1)
const seconds = Number(process.argv[3] ?? 60)
/**
 * 'perfect' 完美挥拍（含高度跟随）
 * 'flat'   完美挥拍，但球拍高度固定（不跟随球的高度）
 * 'none'   完全不挥拍
 * 'late'   反应迟钝
 */
const mode = (process.argv[4] ?? 'perfect') as 'perfect' | 'flat' | 'none' | 'late'
/** 模拟帧率（浏览器低帧率时输入采样也会变稀） */
const fps = Number(process.argv[5] ?? 60)
/** 输入采样率（体感模式约等于摄像头帧率 30fps） */
const inputHz = Number(process.argv[6] ?? fps)

const game = new PingPongGame({ seed, ai: 'normal', autoHeight: mode !== 'flat' })
game.start()

/** 记录挥拍瞬间的球/拍位置，用于核对手感 */
const swings: string[] = []
function recordSwing(gap: number) {
  const s = game.state
  const p = s.playerPaddle
  swings.push(
    `gap=${gap.toFixed(2)} ball(${s.ball.pos.x.toFixed(2)},${s.ball.pos.y.toFixed(2)},${s.ball.pos.z.toFixed(2)}) paddle(${p.x.toFixed(2)},${p.y.toFixed(2)}) v(${s.ball.vel.x.toFixed(2)},${s.ball.vel.y.toFixed(2)},${s.ball.vel.z.toFixed(2)})`,
  )
}

let lastPhase = game.state.phase
let rallyLog: string[] = []
let bounceLog: string[] = []

/** 一个"完美玩家"：自动走到球的位置，并在球接近时挥拍 */
let minDist = Infinity
let swingCount = 0
let hitCount = 0
function autoPlayer() {
  if (mode === 'none') return
  const s = game.state
  if (s.ball.pos.z < 0 && s.ball.vel.z < 0) {
    game.setPlayerTarget(clamp(s.ball.pos.x, -0.66, 0.66))
    const p = s.playerPaddle
    const d = Math.hypot(s.ball.pos.x - p.x, s.ball.pos.y - p.y, s.ball.pos.z - p.z)
    if (d < minDist) minDist = d
    // late 模式：等球已经很贴近才挥拍（模拟反应慢）
    const threshold = mode === 'late' ? 0.06 : 0.16
    const gap = s.ball.pos.z - PADDLE.homeZ
    if (gap < threshold && gap > -0.1) {
      swingCount++
      recordSwing(gap)
      game.swing(0.85)
    }
  }
}

const dt = 1 / fps
const steps = Math.round(seconds / dt)
const inputEvery = Math.max(1, Math.round(fps / inputHz))

for (let i = 0; i < steps; i++) {
  if (i % inputEvery === 0) autoPlayer()
  const events = game.step(dt)

  for (const ev of events) {
    switch (ev.type) {
      case 'bounce':
        bounceLog.push(`${ev.side} 落台`)
        break
      case 'paddleHit':
        rallyLog.push(`${ev.side} 击球`)
        if (ev.side === 'player') hitCount++
        break
      case 'netHit':
        rallyLog.push('触网')
        break
      case 'point':
        console.log(
          `[${(i * dt).toFixed(1)}s] ${ev.message}  比分 ${ev.score?.player}:${ev.score?.opponent}`,
        )
        rallyLog.push('--- 得分 ---')
        bounceLog.push('--- 得分 ---')
        break
      case 'gameOver':
        console.log(`\n${ev.message}  最终比分 ${ev.score?.player}:${ev.score?.opponent}`)
        break
      default:
        break
    }
  }

  if (game.state.phase !== lastPhase) {
    lastPhase = game.state.phase
  }
}
const s = game.state
console.log(
  `SUMMARY score=${s.score.player}:${s.score.opponent} phase=${s.phase} hits=${s.rallyHits} time=${s.elapsed.toFixed(1)} minDist=${minDist === Infinity ? 'n/a' : minDist.toFixed(3)} swings=${swingCount} playerHits=${hitCount} hitRate=${swingCount ? ((hitCount / swingCount) * 100).toFixed(0) + '%' : 'n/a'}`,
)
console.log('\n===== 模拟结束 =====')
console.log(`比分      : ${s.score.player} : ${s.score.opponent}`)
console.log(`阶段      : ${s.phase}`)
console.log(`回合击球数: ${s.rallyHits}`)
console.log(`总时长    : ${s.elapsed.toFixed(1)}s`)
console.log('\n最后一段事件流:')
console.log('  落台:', bounceLog.slice(-12).join(' → '))
console.log('  击球:', rallyLog.slice(-12).join(' → '))
console.log('\n前 5 次挥拍瞬间:')
for (const c of swings.slice(0, 5)) console.log('  ', c)
