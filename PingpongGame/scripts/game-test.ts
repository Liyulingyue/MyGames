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
import { AI_PRESETS, FIXED_DT, PADDLE } from '../src/core/constants.ts'
import type { HitJudgment } from '../src/core/constants.ts'
import { launchTo, predictPlayerInterceptX, stepBall } from '../src/core/physics.ts'
import type { Ball } from '../src/core/types.ts'

let failures = 0
function assert(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  ${detail}`}`)
}

console.log('=== 对局规则与发球 ===')
{
  const game = new PingPongGame({ rules: 'standard', slowMotion: false, pointDelay: 0, seed: 1 })
  game.start()
  const bounces: string[] = []
  for (let i = 0; i < 600 && bounces.length < 2; i++) {
    for (const event of game.step(1 / 120)) {
      if (event.type === 'bounce' && event.side) bounces.push(event.side)
    }
  }
  assert('对手发球先落对方、再落我方并打开接球窗口',
    bounces.join(',') === 'opponent,player' && game.state.phase === 'rally' && game.state.playerWindowOpen)

  function prepareScore(player: number, opponent: number): void {
    game.state.score = { player, opponent }
    game.state.phase = 'point'
    game.state.pointTimer = 0
    game.step(0.01)
  }
  prepareScore(1, 1)
  assert('两分后轮到玩家发球并等待挥拍',
    game.state.server === 'player' && game.state.serveStage === 'waiting')
  const waitingBall = { ...game.state.ball.pos }
  for (let i = 0; i < 120; i++) game.step(1 / 120)
  assert('等待发球不会自动计分或移动球',
    game.state.serveStage === 'waiting' && game.state.score.player === 1 &&
      game.state.ball.pos.z === waitingBall.z)
  game.setPlayerTarget(PADDLE.rangeX)
  for (let i = 0; i < 120; i++) game.step(1 / 120)
  assert('等待发球时球随球拍移动至边线',
    Math.abs(game.state.ball.pos.x - game.state.playerPaddle.x) < 1e-6 &&
      Math.abs(game.state.ball.pos.y - game.state.playerPaddle.y) < 1e-6 &&
      game.state.playerPaddle.x > 0.9)
  assert('玩家挥拍发球', game.swing())
  const playerBounces: string[] = []
  for (let i = 0; i < 600 && playerBounces.length < 2; i++) {
    for (const event of game.step(1 / 120)) {
      if (event.type === 'bounce' && event.side) playerBounces.push(event.side)
    }
  }
  assert('玩家发球先落我方、再落对方', playerBounces.join(',') === 'player,opponent')

  const automatic = new PingPongGame({ rules: 'standard', autoSwing: true, slowMotion: false, pointDelay: 0 })
  automatic.start()
  automatic.state.score = { player: 1, opponent: 1 }
  automatic.state.phase = 'point'
  automatic.state.pointTimer = 0
  automatic.step(0.01)
  let autoServeHits = 0
  const autoBounces: string[] = []
  for (let i = 0; i < 600 && autoBounces.length < 2; i++) {
    for (const event of automatic.step(1 / 120)) {
      if (event.type === 'paddleHit' && event.side === 'player') autoServeHits++
      if (event.type === 'bounce' && event.side) autoBounces.push(event.side)
    }
  }
  assert('辅助击球自动发球一次并保持合法落台',
    autoServeHits === 1 && autoBounces.join(',') === 'player,opponent')

  let serveError = ''
  for (const side of ['player', 'opponent'] as const) {
    for (const x of [-PADDLE.rangeX, -0.75, -0.5, 0, 0.5, 0.75, PADDLE.rangeX]) {
      for (const y of [PADDLE.minY, PADDLE.homeY, PADDLE.maxY]) {
        for (const seed of [5, 17, 911]) {
          const test = new PingPongGame({ rules: 'standard', slowMotion: false, pointDelay: 0, seed })
          test.start()
          const paddle = side === 'player' ? test.state.playerPaddle : test.state.opponentPaddle
          paddle.x = x
          paddle.y = y
          test.setPlayerTarget(x)
          test.state.score = side === 'player' ? { player: 1, opponent: 1 } : { player: 2, opponent: 2 }
          test.state.phase = 'point'
          test.state.pointTimer = 0
          test.step(FIXED_DT * 2)
          const aligned = Math.abs(test.state.ball.pos.x - paddle.x) < 1e-6 &&
            Math.abs(test.state.ball.pos.y - paddle.y) < 1e-6
          if (side === 'player') test.swing()
          const bounces: string[] = []
          for (let i = 0; i < 600 && bounces.length < 2; i++) {
            for (const event of test.step(1 / 120)) {
              if (event.type === 'bounce' && event.side) bounces.push(event.side)
            }
            if (test.state.phase === 'point') break
          }
          const expected = side === 'player' ? 'player,opponent' : 'opponent,player'
          if (!aligned || bounces.join(',') !== expected) {
            serveError ||= `side=${side} x=${x} y=${y} seed=${seed} aligned=${aligned} bounces=${bounces}`
          }
        }
      }
    }
  }
  assert('双方发球从拍面出发，覆盖完整横向行程及高低位并合法落台', !serveError, serveError)

  prepareScore(2, 2)
  assert('四分后轮回对手发球', game.state.server === 'opponent')
  prepareScore(10, 10)
  assert('10:10 未结束，下一球由对手发球',
    !game.isGameOver && game.state.server === 'opponent')
  prepareScore(11, 10)
  assert('11:10 未结束，平分后每球换发',
    !game.isGameOver && game.state.server === 'player')
  prepareScore(11, 11)
  assert('11:11 再次换发', !game.isGameOver && game.state.server === 'opponent')
  prepareScore(12, 10)
  assert('领先两分后结束', game.isGameOver)

  const fault = new PingPongGame({ rules: 'standard', slowMotion: false })
  fault.start()
  fault.state.ball.pos = { x: 0, y: -0.75, z: 1 }
  fault.state.ball.vel = { x: 0, y: -1, z: 0 }
  fault.state.serveStage = 'firstBounce'
  fault.state.lastHitter = 'opponent'
  fault.step(0.01)
  assert('标准模式发球失败判发球方失分',
    fault.state.score.player === 1 && fault.state.score.opponent === 0)

  const earlyNet = new PingPongGame({ rules: 'standard', slowMotion: false })
  earlyNet.start()
  earlyNet.state.serveStage = 'firstBounce'
  earlyNet.state.lastHitter = 'opponent'
  earlyNet.state.ball.pos = { x: 0, y: 0.1, z: 0.001 }
  earlyNet.state.ball.vel = { x: 0, y: 0, z: -2 }
  earlyNet.step(0.01)
  assert('发球在己方落台前触网判失分', earlyNet.state.score.player === 1)

  const miss = new PingPongGame({
    rules: 'standard', slowMotion: false, pointDelay: 0,
    aiConfig: { ...AI_PRESETS.normal, missChance: 1 },
  })
  miss.start()
  miss.state.score = { player: 2, opponent: 0 }
  miss.state.phase = 'point'
  miss.state.pointTimer = 0
  miss.step(0.01)
  miss.swing()
  for (let i = 0; i < 1000 && miss.state.score.player === 2; i++) miss.step(1 / 120)
  assert('标准模式对手接发球漏接由玩家得分',
    miss.state.score.player === 3 && miss.state.score.opponent === 0)

  const letServe = new PingPongGame({ rules: 'standard', slowMotion: false })
  letServe.start()
  letServe.state.score = { player: 1, opponent: 1 }
  letServe.state.server = 'player'
  letServe.state.serveStage = 'secondBounce'
  letServe.state.lastHitter = 'player'
  letServe.state.ball.pos = { x: 0, y: 0.16, z: -0.001 }
  letServe.state.ball.vel = { x: 0, y: 0, z: 2.1 }
  const beforeLet = letServe.state.serveId
  const serveStage = () => letServe.state.serveStage
  for (let i = 0; i < 300 && serveStage() !== 'waiting'; i++) letServe.step(1 / 120)
  assert('发球擦网后合法落台重发且不改变发球方或比分',
    serveStage() === 'waiting' && letServe.state.server === 'player' &&
      letServe.state.score.player === 1 && letServe.state.score.opponent === 1)
  assert('擦网重发会更新球位置重置标识', letServe.state.serveId === beforeLet + 1)

  const seeded = new PingPongGame({ rules: 'standard', slowMotion: false })
  const serveVelocity = (seed?: number): number => {
    seeded.start(seed)
    for (let i = 0; i < 120 && seeded.state.serveStage === 'waiting'; i++) seeded.step(1 / 120)
    return seeded.state.ball.vel.x
  }
  const firstVelocity = serveVelocity(17)
  assert('固定种子可复现发球，新种子改变发球',
    serveVelocity() === firstVelocity && serveVelocity(18) !== firstVelocity)
  const serveId = seeded.state.serveId
  seeded.start()
  assert('同一实例重新开始也更新球位置重置标识', seeded.state.serveId === serveId + 1)

  const casual = new PingPongGame({ pointDelay: 0 })
  casual.start()
  casual.state.score = { player: 11, opponent: 10 }
  casual.state.phase = 'point'
  casual.state.pointTimer = 0
  casual.step(0.01)
  assert('默认休闲模式保留先到目标分数即结束', casual.isGameOver)
}

console.log('=== 对手挥拍动画 ===')
{
  const game = new PingPongGame({ slowMotion: false })
  game.start()
  game.state.phase = 'point'
  game.state.pointTimer = 1
  game.state.opponentPaddle.swingAnim = 1
  game.step(FIXED_DT)
  assert('得分停顿期间对手挥拍动画也会衰减', game.state.opponentPaddle.swingAnim < 1)
  for (let i = 0; i < 120; i++) game.step(FIXED_DT)
  assert('挥拍动画回到待机状态', game.state.opponentPaddle.swingAnim === 0)
  game.state.opponentPaddle.swingAnim = 1
  game.start()
  assert('重新开始清除对手挥拍动画', game.state.opponentPaddle.swingAnim === 0)
}

console.log('=== 手动击球判定 ===')
{
  function attempt(
    level: HitJudgment | undefined,
    delay: number,
    offsetX: number,
    options: {
      windowOpen?: boolean; velocityZ?: number; depth?: number; swing?: boolean
      changeTo?: HitJudgment; lastHitter?: 'player' | 'opponent'
    } = {},
  ): number {
    const game = new PingPongGame({ seed: 17, hitJudgment: level, slowMotion: false, autoHeight: false })
    game.start()
    const s = game.state
    s.phase = 'rally'
    s.lastHitter = 'opponent'
    s.bounces = { player: 1, opponent: 0 }
    s.playerWindowOpen = options.windowOpen ?? true
    s.ball.pos = { x: 0, y: 0.6, z: -0.5 }
    s.ball.vel = { x: 0, y: 0, z: -0.1 }
    if (options.swing !== false) game.swing(0.75)
    if (options.changeTo) game.options.hitJudgment = options.changeTo
    for (let i = 0; i < Math.round(delay / FIXED_DT); i++) game.step(FIXED_DT)
    s.ball.pos = { x: offsetX, y: s.playerPaddle.y, z: PADDLE.homeZ + (options.depth ?? 0.02) }
    s.ball.vel = { x: 0, y: 0, z: options.velocityZ ?? -2 }
    s.lastHitter = options.lastHitter ?? 'opponent'
    const events = game.step(FIXED_DT * 2)
    return events.filter((event) => event.type === 'paddleHit' && event.side === 'player' && event.power === 0.75).length
  }

  const delays = [0.08, 0.12, 0.20, 0.24, 0.28, 0.31]
  const offsets = [0, 0.10, 0.15, 0.19]
  let lightHits = 0
  let assistedHits = 0
  for (const delay of delays) {
    for (const offset of offsets) {
      lightHits += attempt('light', delay, offset)
      assistedHits += attempt('standard', delay, offset)
    }
  }
  assert('固定输入下标准档命中多于弱档', assistedHits === 15 && assistedHits > lightHits,
    `弱档 ${lightHits}/24，标准档 ${assistedHits}/24`)
  assert('未指定档位时默认使用标准判定',
    new PingPongGame().options.hitJudgment === 'standard' &&
      attempt(undefined, 0.27, 0.17) === 1 && attempt(undefined, 0.08, 0, { windowOpen: false }) === 0)
  assert('不挥拍不会自动击球', attempt('standard', 0.08, 0, { swing: false }) === 0)
  assert('未落台不能辅助击球', attempt('standard', 0.08, 0, { windowOpen: false }) === 0)
  assert('远离球拍的球不能辅助击球', attempt('standard', 0.08, 0, { depth: 0.08 }) === 0)
  assert('飞离球拍的球不能辅助击球', attempt('standard', 0.08, 0, { velocityZ: 2 }) === 0)
  assert('横向超出辅助范围不能击球', attempt('standard', 0.08, 0.19) === 0)
  assert('标准档比弱档放宽时机和拍面范围',
    attempt('light', 0.27, 0.17) === 0 && attempt('standard', 0.27, 0.17) === 1)
  assert('强档比标准档放宽时机和拍面范围',
    attempt('standard', 0.33, 0.19) === 0 && attempt('strong', 0.33, 0.19) === 1)
  assert('所有档位都需合法来球，前后距离不变',
    (['light', 'standard', 'strong'] as const).every((level) =>
      attempt(level, 0.08, 0, { windowOpen: false }) === 0 &&
      attempt(level, 0.08, 0, { lastHitter: 'player' }) === 0 &&
      attempt(level, 0.08, 0, { velocityZ: 2 }) === 0 &&
      attempt(level, 0.08, 0, { depth: 0.08 }) === 0))
  assert('切档不改变已经挥出的判定，下次挥拍起生效',
    attempt('light', 0.19, 0.17, { changeTo: 'strong' }) === 0 &&
      attempt('strong', 0.33, 0.19, { changeTo: 'light' }) === 1)

  const game = new PingPongGame({ hitJudgment: 'standard', slowMotion: false, autoHeight: false })
  game.start()
  const state = game.state
  state.phase = 'rally'
  state.lastHitter = 'opponent'
  state.bounces = { player: 1, opponent: 0 }
  state.playerWindowOpen = true
  state.ball.pos = { x: 0, y: state.playerPaddle.y, z: PADDLE.homeZ + 0.8 }
  state.ball.vel = { x: 0, y: 0, z: -2 }
  assert('远离球拍时不提示立即挥拍', !game.shouldSwing)
  state.ball.pos.z = PADDLE.homeZ + 0.5
  const standardHint = game.shouldSwing
  game.options.hitJudgment = 'strong'
  assert('挥拍提示使用当前判定档位', !standardHint && game.shouldSwing)
  game.options.hitJudgment = 'standard'
  state.ball.pos.z = PADDLE.homeZ + 0.2
  assert('合法来球接近球拍时提示挥拍', game.shouldSwing)
  state.ball.pos.z = PADDLE.homeZ + 0.02
  game.swing(0.75)
  const first = game.step(FIXED_DT * 2)
  state.lastHitter = 'opponent'
  state.bounces = { player: 1, opponent: 0 }
  state.playerWindowOpen = true
  state.ball.pos = { x: 0, y: state.playerPaddle.y, z: PADDLE.homeZ + 0.02 }
  state.ball.vel = { x: 0, y: 0, z: -2 }
  const second = game.step(FIXED_DT * 2)
  assert('一次挥拍至多主动击球一次',
    first.some((event) => event.type === 'paddleHit' && event.power === 0.75) &&
      !second.some((event) => event.type === 'paddleHit' && event.power === 0.75))
}

console.log('\n=== 固定来球对比 ===')
{
  function firstReturn(
    seed: number,
    level: HitJudgment,
    offset = 0.14,
    swingAt = 0.23,
  ): { attempted: boolean; hit: boolean } {
    const game = new PingPongGame({ seed, hitJudgment: level, slowMotion: false })
    game.start()
    let attempted = false
    for (let frame = 0; frame < 120 * 30; frame++) {
      const state = game.state
      if (state.lastHitter === 'opponent' && state.ball.vel.z < 0) {
        game.setPlayerTarget(state.ball.pos.x + offset)
        const eta = game.timeToPaddle
        if (!attempted && state.playerWindowOpen && eta !== null && eta <= swingAt) {
          attempted = game.swing(0.75)
        }
      }
      const events = game.step(1 / 120)
      if (events.some((event) => event.type === 'paddleHit' && event.side === 'player' && event.power === 0.75)) {
        return { attempted, hit: true }
      }
      if (state.phase === 'point' || state.phase === 'gameover') break
    }
    return { attempted, hit: false }
  }

  const levels: HitJudgment[] = ['light', 'standard', 'strong']
  for (const [offset, swingAt] of [[0.16, 0.25], [0.19, 0.33]]) {
    const hits = levels.map((level) => {
      let total = 0
      for (let seed = 1; seed <= 30; seed++) {
        const result = firstReturn(seed, level, offset, swingAt)
        if (result.attempted && result.hit) total++
      }
      return total
    })
    const expectedStep = offset === 0.16 ? 1 : 2
    assert(`30 组固定来球区分档位（偏差 ${offset}m，时机 ${swingAt}s）`,
      hits[expectedStep] >= hits[expectedStep - 1] + 10 &&
        hits.every((count, i) => i === 0 || count >= hits[i - 1]),
      `弱/标准/强：${hits.join('/')}`)
    console.log(`  弱/标准/强：${hits.map((count) => `${count}/30`).join(' / ')}`)
  }
}

console.log('\n=== 软吸附 ===')
{
  function move(options: {
    enabled?: boolean
    strength?: number
    target?: number
    ballX?: number
    velocityX?: number
    velocityZ?: number
    gap?: number
    windowOpen?: boolean
    autoMove?: boolean
  } = {}): { x: number; swung: boolean } {
    const game = new PingPongGame({
      softAlign: options.enabled ?? true,
      softAlignStrength: options.strength ?? 0.6,
      autoMove: options.autoMove ?? false,
      slowMotion: false,
      autoHeight: false,
    })
    game.start()
    const s = game.state
    s.phase = 'rally'
    s.lastHitter = 'opponent'
    s.bounces = { player: 1, opponent: 0 }
    s.playerWindowOpen = options.windowOpen ?? true
    s.ball.pos = { x: options.ballX ?? 0.2, y: 0.6, z: PADDLE.homeZ + (options.gap ?? 0.5) }
    s.ball.vel = { x: options.velocityX ?? 0, y: 0, z: options.velocityZ ?? -2 }
    const target = options.target ?? 0
    s.playerPaddle.x = target
    game.setPlayerTarget(target)
    let swung = false
    for (let i = 0; i < 30; i++) {
      const events = game.step(FIXED_DT)
      if (events.some((event) => event.type === 'swing')) swung = true
    }
    return { x: s.playerPaddle.x, swung }
  }

  const off = move({ enabled: false })
  const soft = move()
  const full = move({ strength: 1 })
  assert('关闭或强度为零时不改变玩家目标', off.x === 0 && move({ strength: 0 }).x === 0)
  assert('接近来球时轻微引导（默认强度最多 4.8cm）', soft.x > 0.02 && soft.x <= 0.048001)
  assert('提高强度增加引导但不超过偏差', full.x > soft.x && full.x < 0.2)
  assert('软吸附不会替玩家挥拍', !soft.swung)
  assert('无效来球、球远离或来球尚远时不引导',
    move({ windowOpen: false }).x === 0 &&
      move({ velocityZ: 2 }).x === 0 &&
      move({ gap: 1.5 }).x === 0)
  assert('目标远离来球时不引导', move({ target: -0.3 }).x === -0.3)
  assert('按预测穿越点引导而不是跟踪当前球的位置',
    move({ ballX: -0.1, velocityX: 0.6 }).x > 0)
  assert('自动跟球优先于软吸附',
    Math.abs(move({ autoMove: true }).x - move({ autoMove: true, enabled: false }).x) < 1e-9)

  const positions = [-0.3, -0.15, 0, 0.1, 0.2, 0.3, 0.45, 0.6]
    .map((target) => move({ target, strength: 1 }).x)
  assert('玩家持续移动时不会被吸附反向拖拽',
    positions.every((x, index) => index === 0 || x > positions[index - 1]))
}

console.log('\n=== 提前预测软吸附 ===')
{
  const start = { x: 0, y: 0.3, z: PADDLE.opponentZ }
  const incoming: Ball = { pos: { ...start }, vel: launchTo(start, 0.2, -0.75, 5.2), spin: 0 }
  const prediction = predictPlayerInterceptX(incoming, false)
  const simulated: Ball = { pos: { ...incoming.pos }, vel: { ...incoming.vel }, spin: incoming.spin }
  let afterBounce: Ball | null = null
  let crossingX: number | null = null
  for (let i = 0; i < 900 && crossingX === null; i++) {
    const previous = { ...simulated.pos }
    const events: Parameters<typeof stepBall>[2] = []
    stepBall(simulated, FIXED_DT, events)
    if (events.some((event) => event.kind === 'table' && event.side === 'player')) {
      afterBounce = { pos: { ...simulated.pos }, vel: { ...simulated.vel }, spin: simulated.spin }
    }
    if (simulated.pos.z <= PADDLE.homeZ) {
      const fraction = (previous.z - PADDLE.homeZ) / (previous.z - simulated.pos.z)
      crossingX = previous.x + (simulated.pos.x - previous.x) * fraction
    }
  }
  assert('落台前已准确预测过网、反弹后的拍面穿越点',
    prediction !== null && crossingX !== null && Math.abs(prediction - crossingX) < 1e-9)

  const target = (prediction ?? 0) - 0.2
  function prepare(
    ball: Ball,
    bounced: boolean,
    options: { predictionAssist?: boolean; softAlign?: boolean; autoMove?: boolean } = {},
  ): PingPongGame {
    const game = new PingPongGame({
      predictionAssist: options.predictionAssist ?? true,
      softAlign: options.softAlign ?? true,
      autoMove: options.autoMove ?? false,
      slowMotion: false,
      autoHeight: false,
    })
    game.start()
    game.state.phase = 'rally'
    game.state.lastHitter = 'opponent'
    game.state.bounces = { player: bounced ? 1 : 0, opponent: 0 }
    game.state.playerWindowOpen = bounced
    game.state.ball = { pos: { ...ball.pos }, vel: { ...ball.vel }, spin: ball.spin }
    game.state.playerPaddle.x = target
    game.setPlayerTarget(target)
    return game
  }

  const early = prepare(incoming, false)
  let swung = false
  for (let i = 0; i < 18; i++) {
    const events = early.step(FIXED_DT)
    if (events.some((event) => event.type === 'swing')) swung = true
  }
  const earlyOffset = early.state.playerPaddle.x - target
  assert('对手击球后、我方落台前显示预测并轻柔引导',
    !early.state.playerWindowOpen && early.state.predictionTargetX !== null && earlyOffset > 0 && !swung)
  if (afterBounce) {
    const late = prepare(afterBounce, true)
    for (let i = 0; i < 3; i++) late.step(FIXED_DT)
    const initialOffset = late.state.playerPaddle.x - target
    for (let i = 0; i < 15; i++) late.step(FIXED_DT)
    assert('落台时引导平滑过渡，没有立即跳到最大强度',
      initialOffset > 0 && initialOffset < late.state.playerPaddle.x - target)
    assert('落台后引导逐渐加强', late.state.playerPaddle.x - target > earlyOffset)
  } else {
    assert('落台时引导平滑过渡，没有立即跳到最大强度', false, '测试轨迹未落台')
    assert('落台后引导逐渐加强', false, '测试轨迹未落台')
  }

  const net: Ball = { pos: { x: 0, y: 0.1, z: 0.1 }, vel: { x: 0, y: -1, z: -3 }, spin: 0 }
  const out: Ball = { pos: { x: 1, y: 0.3, z: 1.28 }, vel: { x: 0, y: 1, z: -5 }, spin: 0 }
  const secondBounce: Ball = { pos: { x: 0, y: 0.05, z: -0.4 }, vel: { x: 0, y: -1, z: -1 }, spin: 0 }
  assert('预测触网、出界及第二次落台时不引导',
    predictPlayerInterceptX(net, false) === null && predictPlayerInterceptX(out, false) === null &&
      predictPlayerInterceptX(secondBounce, true) === null)

  early.state.ball = { pos: { x: 0, y: 0.1, z: 0.004 }, vel: { x: 0, y: -1, z: -3 }, spin: 0 }
  early.step(FIXED_DT)
  assert('实际触网立即移除预测标记', early.state.predictionTargetX === null)
  early.state.ball = { pos: { ...incoming.pos }, vel: { ...incoming.vel }, spin: incoming.spin }
  early.refreshPrediction()
  early.options.autoMove = true
  early.refreshPrediction()
  assert('辅助移动开启时仍可显示预测', early.state.predictionTargetX !== null)
  early.options.autoMove = false
  early.refreshPrediction()
  early.options.softAlign = false
  early.refreshPrediction()
  assert('关闭软吸附时辅助预测仍然显示', early.state.predictionTargetX !== null)
  early.options.predictionAssist = false
  early.refreshPrediction()
  assert('关闭辅助预测时立即隐藏标记', early.state.predictionTargetX === null)
  early.options.predictionAssist = true
  early.state.lastHitter = null
  early.refreshPrediction()
  assert('对手尚未击球时不显示预测', early.state.predictionTargetX === null)

  const combinations = [
    { predictionAssist: false, softAlign: false },
    { predictionAssist: true, softAlign: false },
    { predictionAssist: false, softAlign: true },
    { predictionAssist: true, softAlign: true },
  ].map((options) => {
    const game = prepare(incoming, false, options)
    for (let i = 0; i < 18; i++) game.step(FIXED_DT)
    return { marker: game.state.predictionTargetX, offset: game.state.playerPaddle.x - target }
  })
  assert('辅助预测独立控制标记，不改变球拍位置',
    combinations[0].marker === null && combinations[1].marker !== null &&
      combinations[0].offset === 0 && combinations[1].offset === 0)
  assert('仅软吸附时仍有引导但不显示标记',
    combinations[2].marker === null && combinations[2].offset > 0)
  assert('同时开启时显示标记且引导与单独软吸附一致',
    combinations[3].marker !== null && Math.abs(combinations[3].offset - combinations[2].offset) < 1e-9)
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