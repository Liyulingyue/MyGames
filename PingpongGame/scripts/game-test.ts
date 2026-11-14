/**
 * 核心行为回归测试。
 *
 * 覆盖几条容易回归的规则：
 *   1. 得分停顿期间球拍仍然跟随输入（否则恢复回合时球拍会瞬移）
 *   2. 球拍高度自动跟随球
 *   3. 挥拍能接住球、不挥拍则丢分
 *
 * 运行： node --experimental-strip-types scripts/game-test.ts
 */

import { PingPongGame } from '../src/core/game.ts'
import { PADDLE } from '../src/core/constants.ts'

let failures = 0
function assert(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  ${detail}`}`)
}

// ---------------------------------------------------------------- 1. 停顿不锁死
console.log('=== 得分停顿期间球拍仍跟随输入 ===')
{
  const game = new PingPongGame({ seed: 5, ai: 'normal' })
  game.start()

  // 跑到"得分停顿"阶段
  let guard = 0
  while (game.state.phase !== 'point' && guard++ < 60 * 120) {
    game.step(1 / 60)
  }
  assert('能进入得分停顿阶段', game.state.phase === 'point')

  // 停顿期间目标改变，球拍应当跟着移动
  game.setPlayerTarget(0.6)
  const x0 = game.state.playerPaddle.x
  for (let i = 0; i < 20; i++) game.step(1 / 60)
  const x1 = game.state.playerPaddle.x
  assert(
    '球拍在停顿期间继续移动（没有锁死）',
    x1 > x0 + 0.05,
    `x: ${x0.toFixed(3)} → ${x1.toFixed(3)}`,
  )
  assert('停顿期间仍在 point 阶段', game.state.phase === 'point')

  // 恢复回合后不应出现瞬移：球拍位置应当是平滑移动到的目标附近
  const beforeResume = game.state.playerPaddle.x
  let jumped = 0
  let prev = beforeResume
  guard = 0
  while (game.state.phase === 'point' && guard++ < 60 * 10) {
    game.step(1 / 60)
    jumped = Math.max(jumped, Math.abs(game.state.playerPaddle.x - prev))
    prev = game.state.playerPaddle.x
  }
  assert(
    '恢复回合时球拍没有瞬移',
    jumped < 0.12,
    `单帧最大位移 ${jumped.toFixed(3)}m`,
  )
}

// ---------------------------------------------------------------- 2. 高度自动跟随
console.log('\n=== 球拍高度自动跟随球 ===')
{
  const game = new PingPongGame({ seed: 9, ai: 'normal' })
  game.start()

  let checked = 0
  let worst = 0
  let guard = 0
  while (checked < 5 && guard++ < 60 * 180) {
    game.step(1 / 60)
    const s = game.state
    // 球正飞向我方、且已经进入我方半场
    if (s.ball.vel.z < 0 && s.ball.pos.z < 0 && s.ball.pos.z > PADDLE.homeZ - 0.4) {
      checked++
      worst = Math.max(worst, Math.abs(s.playerPaddle.y - s.ball.pos.y))
    }
  }
  assert('采样到球飞向我方的时刻', checked > 0)
  assert(
    '球拍高度与球的高度接近',
    worst < 0.2,
    `最大纵向偏差 ${worst.toFixed(3)}m`,
  )
}

// ---------------------------------------------------------------- 3. 挥拍/不挥拍
console.log('\n=== 挥拍与失分 ===')
{
  // 不挥拍：必然丢分
  const idle = new PingPongGame({ seed: 3, ai: 'normal' })
  idle.start()
  let guard = 0
  while (idle.state.phase !== 'gameover' && guard++ < 60 * 300) idle.step(1 / 60)
  assert('完全不挥拍会输掉整局', idle.state.phase === 'gameover')
  assert('完全不挥拍一分不得', idle.state.score.player === 0, `得分 ${idle.state.score.player}`)

  // 挥拍：能接到球（玩家得分 > 0）
  const active = new PingPongGame({ seed: 3, ai: 'normal' })
  active.start()
  guard = 0
  while (active.state.phase !== 'gameover' && guard++ < 60 * 300) {
    const s = active.state
    if (s.ball.vel.z < 0 && s.ball.pos.z < 0) {
      active.setPlayerTarget(
        Math.max(-0.66, Math.min(0.66, s.ball.pos.x)),
      )
      const gap = s.ball.pos.z - PADDLE.homeZ
      if (gap < 0.16 && gap > -0.1) active.swing(0.85)
    }
    active.step(1 / 60)
  }
  assert(
    '挥拍能回击并得分',
    active.state.score.player > 0,
    `比分 ${active.state.score.player}:${active.state.score.opponent}`,
  )
}

// ---------------------------------------------------------------- 4. 重新开始
console.log('\n=== 重新开始 ===')
{
  const game = new PingPongGame({ seed: 5, ai: 'normal' })
  game.start()

  // 先打一会儿，让比分和球拍位置都发生变化
  let guard = 0
  while (game.state.score.player + game.state.score.opponent < 1 && guard++ < 60 * 60) {
    game.step(1 / 60)
  }
  game.setPlayerTarget(0.6)
  for (let i = 0; i < 30; i++) game.step(1 / 60)

  assert('重开前确实打过球', game.state.score.player + game.state.score.opponent > 0)

  game.start()
  assert(
    '重新开始后比分清零',
    game.state.score.player === 0 && game.state.score.opponent === 0,
    `比分 ${game.state.score.player}:${game.state.score.opponent}`,
  )
  assert('重新开始后球拍回到中间', game.state.playerPaddle.x === 0)
  assert('重新开始后进入发球阶段', game.state.phase === 'serve' || game.state.phase === 'rally')
}

// ---------------------------------------------------------------- 5. 辅助移动
console.log('\n=== 辅助移动（只挥拍，球拍自动跟球） ===')
{
  const game = new PingPongGame({ seed: 7, ai: 'normal', autoMove: true })
  game.start()

  let checked = 0
  let worst = Infinity
  let guard = 0
  while (checked < 40 && guard++ < 60 * 180) {
    game.step(1 / 60)
    const s = game.state
    if (s.ball.vel.z < 0 && s.ball.pos.z < 0.2 && s.ball.pos.z > PADDLE.homeZ - 0.3) {
      checked++
      worst = Math.min(worst, Math.abs(s.playerPaddle.x - s.ball.pos.x))
    }
  }
  assert('采样到球飞向我方的时刻', checked > 0)
  assert(
    '球拍自动贴住球的横向位置（玩家完全没设目标）',
    worst < 0.15,
    `最小横向偏差 ${worst.toFixed(3)}m`,
  )
}

// ---------------------------------------------------------------- 6. 辅助击球
console.log('\n=== 辅助击球（只走位，挥拍自动） ===')
{
  const game = new PingPongGame({ seed: 7, ai: 'normal', autoSwing: true })
  game.start()

  // 玩家只负责把球拍走到球的位置，从不主动挥拍
  let guard = 0
  while (game.state.phase !== 'gameover' && guard++ < 60 * 300) {
    const s = game.state
    if (s.ball.vel.z < 0) {
      game.setPlayerTarget(Math.max(-0.66, Math.min(0.66, s.ball.pos.x)))
    }
    game.step(1 / 60)
  }
  assert(
    '不手动挥拍也能回球得分（辅助击球生效）',
    game.state.score.player > 0,
    `比分 ${game.state.score.player}:${game.state.score.opponent}`,
  )
}

// ---------------------------------------------------------------- 7. 只挥拍不移动
console.log('\n=== 只挥拍不移动（辅助移动 + 手动挥拍） ===')
{
  const game = new PingPongGame({ seed: 7, ai: 'normal', autoMove: true })
  game.start()

  let guard = 0
  while (game.state.phase !== 'gameover' && guard++ < 60 * 300) {
    const s = game.state
    if (s.ball.vel.z < 0 && s.ball.pos.z < 0) {
      const gap = s.ball.pos.z - PADDLE.homeZ
      if (gap < 0.16 && gap > -0.1) game.swing(0.85)
    }
    game.step(1 / 60)
  }
  assert(
    '完全不移动球拍也能回球得分（辅助移动生效）',
    game.state.score.player > 0,
    `比分 ${game.state.score.player}:${game.state.score.opponent}`,
  )
}

// ---------------------------------------------------------------- 8. 时间倍率（慢动作）
console.log('\n=== 时间倍率（慢动作，弹道不变） ===')
{
  /** 跑固定的真实时间，返回模拟时间与对手回球时的物理球速 */
  function probe(timeScale: number): { elapsed: number; hitSpeed: number; netHits: number } {
    const game = new PingPongGame({ seed: 11, ai: 'normal', timeScale })
    game.start()
    let hitSpeed = 0
    let netHits = 0
    for (let i = 0; i < 60 * 30; i++) {
      const events = game.step(1 / 60)
      for (const e of events) {
        if (e.type === 'netHit') netHits++
        if (e.type === 'paddleHit' && e.side === 'opponent' && hitSpeed === 0) {
          const v = game.state.ball.vel
          hitSpeed = Math.hypot(v.x, v.y, v.z)
        }
      }
    }
    return { elapsed: game.state.elapsed, hitSpeed, netHits }
  }

  const normal = probe(1)
  const slow = probe(0.5)

  assert('对手能正常回球', normal.hitSpeed > 0, `球速 ${normal.hitSpeed.toFixed(2)}`)
  assert(
    '时间倍率只放慢模拟，不改球的物理速度',
    Math.abs(slow.hitSpeed - normal.hitSpeed) < 0.01,
    `1.0x=${normal.hitSpeed.toFixed(3)} / 0.5x=${slow.hitSpeed.toFixed(3)}`,
  )
  assert(
    '0.5x 时同样的真实时间只走了一半的模拟时间',
    Math.abs(slow.elapsed / normal.elapsed - 0.5) < 0.02,
    `实际比例 ${(slow.elapsed / normal.elapsed).toFixed(3)}`,
  )
  assert(
    '慢动作不会带来碰网（弹道没变）',
    slow.netHits === 0 && normal.netHits === 0,
    `0.5x 碰网 ${slow.netHits} 次 / 1.0x 碰网 ${normal.netHits} 次`,
  )
}

// ---------------------------------------------------------------- 9. 结算后冻结
console.log('\n=== 结算后不再继续 ===')
{
  const game = new PingPongGame({ seed: 21, ai: 'normal' })
  game.start()

  // 把比分推到临界点，让下一分直接结束整局
  game.state.score.player = 10
  game.state.score.opponent = 5

  let guard = 0
  let over = false
  while (guard++ < 60 * 300) {
    game.step(1 / 60)
    if (game.state.phase === 'gameover') {
      over = true
      break
    }
  }
  assert('能打出 gameover', over)
  assert(
    'gameover 时有一方已达目标分',
    game.state.score.player >= 11 || game.state.score.opponent >= 11,
    `比分 ${game.state.score.player}:${game.state.score.opponent}`,
  )

  // 结算之后继续推进：分数、阶段都不能再变
  const scoreAtOver = { ...game.state.score }
  const phaseAtOver = game.state.phase
  for (let i = 0; i < 60 * 10; i++) game.step(1 / 60)
  assert(
    '结算后分数不再变化',
    game.state.score.player === scoreAtOver.player &&
      game.state.score.opponent === scoreAtOver.opponent,
    `比分 ${game.state.score.player}:${game.state.score.opponent}`,
  )
  assert(
    '结算后阶段保持 gameover（不会偷偷重开一局）',
    game.state.phase === phaseAtOver,
    `阶段 ${game.state.phase}`,
  )
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)