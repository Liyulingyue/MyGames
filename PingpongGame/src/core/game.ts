import {
  AI_PRESETS,
  BALL,
  FIXED_DT,
  PADDLE,
  SERVE_ROTATION,
  TABLE,
  TARGET_SCORE,
} from './constants.ts'
import type { AIConfig } from './constants.ts'
import { createAIState, updateAI } from './ai.ts'
import type { AIState } from './ai.ts'
import {
  OUT_OF_BOUNDS,
  checkPaddleOverlap,
  checkSwingReach,
  launchTo,
  stepBall,
} from './physics.ts'
import type { CollisionEvent, PaddleHit } from './physics.ts'
import type { Ball, GameEvent, Paddle, Phase, Score, Side } from './types.ts'
import { clamp, createRng, lerp, rand } from './vec3.ts'

export interface GameOptions {
  /** 随机数种子，固定后整局可复现 */
  seed?: number
  /** 对手难度 */
  ai?: keyof typeof AI_PRESETS
  /** 自定义 AI 参数（优先于 ai 预设） */
  aiConfig?: AIConfig
  /** 一局的目标分数 */
  targetScore?: number
  /** 慢动作：球逼近我方时放慢，给玩家反应时间 */
  slowMotion?: boolean
  /** 慢动作最低速度倍率 */
  slowMotionScale?: number
  /** 进入慢动作的时间窗口（秒） */
  slowMotionWindow?: number
  /** 得分后停顿多久再发下一球（秒） */
  pointDelay?: number
  /**
   * 球拍高度是否自动跟随球（默认 true）。
   * 关掉就固定在 PADDLE.homeY，只用于对比测试手感。
   */
  autoHeight?: boolean
  /**
   * 全局时间倍率（默认 1），相当于"慢动作"。
   *
   * 小于 1 时整个对局变慢：球的**弹道完全不变**（同一段抛物线、同样的初速），
   * 只是走完这段路要花更多真实时间，于是玩家的反应时间变多。
   *
   * 注意它不影响球的物理速度——所以也绝不会因为"球速调低"而出现碰网：
   * 弹道没变，球网那一段的过网点也就没变。
   */
  timeScale?: number
  /**
   * 辅助移动（默认 false）：球拍自动横向跟随球，玩家只负责挥拍。
   */
  autoMove?: boolean
  /**
   * 辅助击球（默认 false）：球进到拍区自动挥拍，玩家只负责走位。
   */
  autoSwing?: boolean
  /** 保留手动挥拍，放宽挥拍时间和拍面偏差 */
  hitAssist?: boolean
  /** 仅在目标靠近来球时轻微引导球拍，强度为 0～1 */
  softAlign?: boolean
  softAlignStrength?: number
}

export interface GameState {
  phase: Phase
  ball: Ball
  playerPaddle: Paddle
  opponentPaddle: Paddle
  score: Score
  /** 各自半场的落台次数 */
  bounces: Record<Side, number>
  /** 最后一次击球方 */
  lastHitter: Side | null
  /** 挥拍窗口是否打开：球已在我方半场落台，等我挥拍 */
  playerWindowOpen: boolean
  /** 当前时间倍率（慢动作） */
  timeScale: number
  /** 本回合击球次数 */
  rallyHits: number
  /** 已进行的时长 */
  elapsed: number
  /** 得分后剩余的停顿时间 */
  pointTimer: number
  /** 上一个得分方 */
  lastPointWinner: Side | null
  /** 我方挥拍冷却剩余时间 */
  swingCooldown: number
  /** 我方挥拍剩余的有效时间 */
  swingActiveTimer: number
}

/**
 * 乒乓对局核心。
 *
 * 回合节奏（与真实乒乓一致，也是本项目要求的流程）：
 *   1. 对手发球 → 球在对手半场落台一次
 *   2. 对手把球打过网 → 球在我方半场落台一次
 *   3. 【我方窗口打开】挥拍回击；命中则继续回合，否则失分
 *
 * 本类不引用任何浏览器 API，可原样运行在 Node 服务端。
 */
export class PingPongGame {
  readonly state: GameState
  readonly options: Required<GameOptions>

  private rng: () => number
  private ai: AIState
  private accumulator = 0
  private pendingEvents: GameEvent[] = []
  private collisions: CollisionEvent[] = []
  private playerTargetX = 0
  private serveCount = 0

  constructor(options: GameOptions = {}) {
    const preset = options.ai ?? 'normal'
    this.options = {
      seed: options.seed ?? 20240501,
      ai: preset,
      aiConfig: options.aiConfig ?? AI_PRESETS[preset],
      targetScore: options.targetScore ?? TARGET_SCORE,
      slowMotion: options.slowMotion ?? true,
      slowMotionScale: options.slowMotionScale ?? 0.55,
      slowMotionWindow: options.slowMotionWindow ?? 0.9,
      pointDelay: options.pointDelay ?? 1.5,
      autoHeight: options.autoHeight ?? true,
      timeScale: options.timeScale ?? 1,
      autoMove: options.autoMove ?? false,
      autoSwing: options.autoSwing ?? false,
      hitAssist: options.hitAssist ?? false,
      softAlign: options.softAlign ?? false,
      softAlignStrength: options.softAlignStrength ?? 0.6,
    }

    this.rng = createRng(this.options.seed)
    this.ai = createAIState()

    this.state = {
      phase: 'idle',
      ball: {
        pos: { x: 0, y: 0.3, z: 0.6 },
        vel: { x: 0, y: 0, z: 0 },
        spin: 0,
      },
      playerPaddle: {
        x: 0,
        y: 0.3,
        z: PADDLE.homeZ,
        vx: 0,
        vy: 0,
        activeTimer: 0,
        cooldown: 0,
        lastSwingPower: 0,
        swingAnim: 0,
      },
      opponentPaddle: this.ai.paddle,
      score: { player: 0, opponent: 0 },
      bounces: { player: 0, opponent: 0 },
      lastHitter: null,
      playerWindowOpen: false,
      timeScale: 1,
      rallyHits: 0,
      elapsed: 0,
      pointTimer: 0,
      lastPointWinner: null,
      swingCooldown: 0,
      swingActiveTimer: 0,
    }
  }

  // ---------------------------------------------------------------- 对外接口

  /** 开新的一局 */
  start(): void {
    this.rng = createRng(this.options.seed)
    this.state.score = { player: 0, opponent: 0 }
    this.state.elapsed = 0
    this.state.lastPointWinner = null
    this.serveCount = 0

    // 球拍回到中间，避免新一局开始时球拍还停在上���局的位置
    this.playerTargetX = 0
    const p = this.state.playerPaddle
    p.x = 0
    p.y = PADDLE.homeY
    p.vx = 0
    p.vy = 0
    p.activeTimer = 0
    p.cooldown = 0
    p.swingAnim = 0
    this.state.opponentPaddle.swingAnim = 0

    this.beginServe()
  }

  /** 结束当前一局，回到待开始状态 */
  stop(): void {
    this.state.phase = 'idle'
  }

  /**
   * 输入层设置我方球拍的横向目标位置（体感或键盘都走这里）。
   *
   * 纵向不开放给玩家：体感模式下靠下蹲/抬手控制球拍高度很别扭，
   * 而且实测对命中率几乎没有帮助（高度固定的命中率同样是 96%~100%），
   * 却会让"球在什么高度"变成额外的追踪负担。
   * 高度改由游戏自动跟随球，见 autoPaddleHeight()。
   */
  setPlayerTarget(x: number): void {
    this.playerTargetX = clamp(x, -PADDLE.rangeX, PADDLE.rangeX)
  }

  /** 输入层触发一次挥拍，power 为 0~1 的力度 */
  swing(power = 0.6): boolean {
    const s = this.state
    if (s.phase !== 'rally' && s.phase !== 'serve') return false
    const p = s.playerPaddle
    if (p.cooldown > 0) return false

    p.activeTimer = this.options.hitAssist ? PADDLE.assistSwingActiveTime : PADDLE.swingActiveTime
    p.cooldown = PADDLE.swingCooldown
    p.lastSwingPower = clamp(power, 0, 1)
    p.swingAnim = 1
    s.swingActiveTimer = p.activeTimer
    s.swingCooldown = p.cooldown
    this.pendingEvents.push({ type: 'swing', power: p.lastSwingPower })
    return true
  }

  /**
   * 本局是否已经结束。
   *
   * 单独用方法读，避免 TypeScript 在 `step()` 里对 `state.phase` 做类型收窄，
   * 而实际上 fixedUpdate 内部是会改 phase 的。
   */
  get isGameOver(): boolean {
    return this.state.phase === 'gameover'
  }

  /** 推进游戏，返回本帧产生的事件 */
  step(dt: number): GameEvent[] {
    const events: GameEvent[] = []
    if (this.pendingEvents.length) {
      events.push(...this.pendingEvents)
      this.pendingEvents.length = 0
    }

    const s = this.state
    if (s.phase === 'idle' || s.phase === 'gameover') return events

    s.timeScale = this.computeTimeScale() * this.options.timeScale

    // 固定步长推进：累积的是"模拟时间"，乘上时间倍率就等于慢动作。
    // 物理本身（速度、弹道）一点没变，只是走完同样的路要花更久的真实时间。
    this.accumulator += Math.min(dt, 0.05) * s.timeScale
    let guard = 0
    while (this.accumulator >= FIXED_DT && guard++ < 40) {
      this.fixedUpdate(FIXED_DT, events)
      this.accumulator -= FIXED_DT
      // 结算之后不再继续推进
      if (this.isGameOver) break
    }

    return events
  }

  // ---------------------------------------------------------------- 内部逻辑

  private fixedUpdate(dt: number, events: GameEvent[]): void {
    const s = this.state

    // 本局已结束：模拟必须彻底冻结。
    //
    // 这里必须有这层保护：一个 step() 里会跑多个固定步，
    // 判定出胜负后如果还继续跑，下一个固定步里的 checkRules 可能把球判出界，
    // 于是 beginServe() 把 phase 改回 'serve' —— 结算之后游戏又偷偷打起来了。
    if (s.phase === 'gameover') return

    s.elapsed += dt
    s.opponentPaddle.swingAnim = Math.max(0, s.opponentPaddle.swingAnim - dt * 3.2)

    // 球拍始终跟随输入：得分停顿期间也继续更新，
    // 否则目标会在这段时间里漂移，恢复回合时球拍瞬移一下。
    this.updatePlayerPaddle(dt)

    if (s.phase === 'point') {
      s.pointTimer -= dt
      if (s.pointTimer <= 0) {
        if (
          s.score.player >= this.options.targetScore ||
          s.score.opponent >= this.options.targetScore
        ) {
          s.phase = 'gameover'
          const winner: Side = s.score.player > s.score.opponent ? 'player' : 'opponent'
          events.push({
            type: 'gameOver',
            winner,
            score: { ...s.score },
            message: winner === 'player' ? '你赢了！' : '你输了',
          })
        } else {
          this.beginServe()
        }
      }
      return
    }

    this.updateTimers(dt)

    // —— 辅助击球：球进到拍区就自动挥拍（玩家只负责走位）——
    if (this.options.autoSwing) this.tryAutoSwing()

    // —— 我方挥拍命中判定 ——
    if (
      s.playerPaddle.activeTimer > 0 &&
      (!this.options.hitAssist || (s.playerWindowOpen && s.lastHitter === 'opponent' && s.ball.vel.z < 0))
    ) {
      const reach = checkSwingReach(
        s.ball,
        s.playerPaddle,
        PADDLE.swingDepth,
        this.options.hitAssist ? PADDLE.assistBladeReach : PADDLE.bladeReach,
      )
      if (reach) this.hitByPlayer(reach, events)
    }

    // —— 对手 AI ——
    const action = updateAI(
      this.ai,
      s.ball,
      {
        rng: this.rng,
        config: this.options.aiConfig,
        playerPaddle: s.playerPaddle,
        ballBouncedOnOpponentSide: s.bounces.opponent >= 1,
      },
      dt,
    )
    if (action.kind === 'hit') {
      s.ball.vel = action.velocity
      s.ball.spin = 0
      s.lastHitter = 'opponent'
      s.bounces = { player: 0, opponent: 0 }
      s.rallyHits++
      s.phase = 'rally'
      events.push({
        type: 'paddleHit',
        side: 'opponent',
        pos: { ...s.ball.pos },
        power: action.power,
      })
    } else if (action.kind === 'miss') {
      events.push({ type: 'aiMiss', side: 'opponent' })
    }

    // —— 物理推进 ——
    const collisions = this.collisions
    collisions.length = 0
    stepBall(s.ball, dt, collisions)

    for (const c of collisions) {
      if (c.kind === 'table') {
        s.bounces[c.side]++
        if (c.side === 'player' && s.lastHitter === 'opponent') {
          s.playerWindowOpen = true
        }
        events.push({ type: 'bounce', side: c.side, pos: c.pos })
      } else if (c.kind === 'net') {
        events.push({ type: 'netHit', pos: c.pos })
      }
    }

    // 未挥拍时撞到拍面（被动格挡）
    this.passivePaddleContact('player', events)

    // —— 规则判定 ——
    this.checkRules(events)
  }

  /**
   * 球拍的目标高度：自动跟随球。
   *
   * 球飞向我方时，球拍贴着球当前的高度走 —— 这样无论玩家早挥还是晚挥，
   * 挥拍瞬间的纵向误差都很小（实测球心到拍心的最近距离从固定高度的
   * 0.17m 降到 0.115m）。球不在来路上、或已经从我方台端掠过时回到中立高度。
   */
  private autoPaddleHeight(): number {
    if (!this.options.autoHeight) return PADDLE.homeY
    const b = this.state.ball
    if (b.vel.z >= 0 || b.pos.z < PADDLE.homeZ - 0.35) return PADDLE.homeY
    return clamp(b.pos.y, PADDLE.minY, PADDLE.maxY)
  }

  /**
   * 球拍的目标横向位置。
   *
   * 辅助移动开启时直接贴着球走：玩家完全不用管走位，只要在对的时机挥拍。
   * 球不在来路上时保持玩家自己设定的位置。
   */
  private targetPaddleX(): number {
    if (!this.options.autoMove) {
      const s = this.state
      const b = s.ball
      if (!this.options.softAlign || s.phase !== 'rally' || !s.playerWindowOpen || s.lastHitter !== 'opponent' ||
          b.vel.z >= -1e-4 || b.pos.z < PADDLE.homeZ) return this.playerTargetX

      const eta = (PADDLE.homeZ - b.pos.z) / b.vel.z
      if (eta >= 0.6) return this.playerTargetX

      // 落台后 X/Z 同比受阻力衰减，速度比可用于估算穿过拍面的横向位置。
      const interceptX = b.pos.x + (PADDLE.homeZ - b.pos.z) * b.vel.x / b.vel.z
      const delta = interceptX - this.playerTargetX
      const distanceWeight = Math.max(0, 1 - Math.abs(delta) / 0.4)
      const timeWeight = clamp((0.6 - eta) / 0.3, 0, 1)
      const strength = clamp(this.options.softAlignStrength, 0, 1) * 0.8
      return clamp(this.playerTargetX + delta * distanceWeight * timeWeight * strength, -PADDLE.rangeX, PADDLE.rangeX)
    }
    const b = this.state.ball
    if (b.vel.z >= 0 || b.pos.z < PADDLE.homeZ - 0.35) return this.playerTargetX
    return clamp(b.pos.x, -PADDLE.rangeX, PADDLE.rangeX)
  }

  private updatePlayerPaddle(dt: number): void {
    const s = this.state
    const p = s.playerPaddle
    const prevX = p.x
    const prevY = p.y

    const maxSpeed = 4.0
    const targetX = this.targetPaddleX()
    const dx = targetX - p.x
    const dy = this.autoPaddleHeight() - p.y
    const d = Math.hypot(dx, dy)
    const maxStep = maxSpeed * dt

    if (d > maxStep && d > 1e-6) {
      p.x += (dx / d) * maxStep
      p.y += (dy / d) * maxStep
    } else {
      p.x = targetX
      p.y = this.autoPaddleHeight()
    }

    p.vx = (p.x - prevX) / Math.max(dt, 1e-6)
    p.vy = (p.y - prevY) / Math.max(dt, 1e-6)
  }

  private updateTimers(dt: number): void {
    const s = this.state
    const p = s.playerPaddle
    p.activeTimer = Math.max(0, p.activeTimer - dt)
    p.cooldown = Math.max(0, p.cooldown - dt)
    p.swingAnim = Math.max(0, p.swingAnim - dt * 3.2)
    s.swingActiveTimer = p.activeTimer
    s.swingCooldown = p.cooldown
  }

  /**
   * 辅助击球：球进到拍区就替玩家挥一下。
   *
   * 触发条件和手动挥拍一致（球必须先在我方半场落过台），
   * 只是时机由球的位置决定，玩家只需要把球拍走到位。
   */
  private tryAutoSwing(): void {
    const s = this.state
    if (!s.playerWindowOpen) return
    const b = s.ball
    if (b.vel.z >= 0) return

    const p = s.playerPaddle
    if (p.cooldown > 0) return

    // 球拍平面附近才挥：太早挥会打空，太晚球已经过去了。
    // 挥拍有 0.17s 的有效窗口，所以提前一点挥也来得及，
    // 只要球进到拍面厚度范围时挥拍还生效就行。
    const gap = b.pos.z - PADDLE.homeZ
    if (gap > 0.25 || gap < -0.15) return

    // 球必须落在拍面范围内（横向 + 纵向），否则挥了也是打空
    const dist = Math.hypot(b.pos.x - p.x, b.pos.y - p.y)
    if (dist > PADDLE.bladeReach) return

    this.swing(0.8)
  }

  private hitByPlayer(hit: PaddleHit, events: GameEvent[]): void {
    const s = this.state
    const p = s.playerPaddle

    // 打偏中心 → 球往反方向飞（真实乒乓球手感）
    const aimX = clamp(p.x - hit.offsetX * 2.6 + rand(this.rng, -0.12, 0.12), -0.62, 0.62)
    const aimZ = rand(this.rng, 0.45, 1.05)
    const power = clamp(p.lastSwingPower, 0.15, 1)
    // 回球速度只跟力度有关：全局"慢动作"已经让整段弹道变慢了，
    // 这里再乘一次倍率就等于改了物理速度（会改变弹道形状，甚至碰网）。
    const speed = lerp(PADDLE.minShotSpeed, PADDLE.maxShotSpeed, power)

    s.ball.vel = launchTo(s.ball.pos, aimX, aimZ, speed)
    s.ball.spin = clamp(-hit.offsetX * 8, -20, 20)
    s.lastHitter = 'player'
    s.bounces = { player: 0, opponent: 0 }
    s.playerWindowOpen = false
    s.rallyHits++
    s.phase = 'rally'
    p.activeTimer = 0

    events.push({
      type: 'paddleHit',
      side: 'player',
      pos: { ...s.ball.pos },
      power,
    })
  }

  private passivePaddleContact(side: Side, events: GameEvent[]): void {
    const s = this.state
    const p = side === 'player' ? s.playerPaddle : s.opponentPaddle
    const overlap = checkPaddleOverlap(s.ball, p)
    if (!overlap) return

    const d = Math.max(overlap.distance, 1e-6)
    const nx = overlap.offsetX / d
    const ny = overlap.offsetY / d
    const vn = s.ball.vel.x * nx + s.ball.vel.y * ny

    if (vn < 0) {
      s.ball.vel.x = (s.ball.vel.x - 2 * vn * nx) * 0.6
      s.ball.vel.y = (s.ball.vel.y - 2 * vn * ny) * 0.6
      events.push({ type: 'paddleHit', side, pos: { ...s.ball.pos }, power: 0.15 })
    }
  }

  private checkRules(events: GameEvent[]): void {
    const s = this.state
    const onFloor = s.ball.pos.y - BALL.radius <= TABLE.floorY + 1e-3
    const outOfBounds =
      Math.abs(s.ball.pos.x) > OUT_OF_BOUNDS.x ||
      Math.abs(s.ball.pos.z) > OUT_OF_BOUNDS.z ||
      s.ball.pos.y < OUT_OF_BOUNDS.y

    // 发球阶段还没有人击球：失误就重发
    if (s.lastHitter === null) {
      if (onFloor || outOfBounds || s.bounces.opponent >= 2) {
        events.push({ type: 'out', message: '重发球' })
        this.beginServe()
      }
      return
    }

    if (onFloor || outOfBounds) {
      const receiver: Side = s.lastHitter === 'player' ? 'opponent' : 'player'
      const receiverBounces = s.bounces[receiver]
      if (receiverBounces >= 1) {
        // 对方已经在台面上接到，却没能打回来 → 击球方得分
        this.awardPoint(s.lastHitter, events)
      } else {
        // 下网 / 出界 → 击球方丢分
        this.awardPoint(receiver, events)
      }
      return
    }

    // 同一半场第二次落台 = 没接到
    if (s.bounces.player >= 2) {
      this.awardPoint('opponent', events)
      return
    }
    if (s.bounces.opponent >= 2) {
      this.awardPoint('player', events)
      return
    }

    // 击球方自己的半场落台 = 没把球打过网
    if (s.lastHitter === 'player' && s.bounces.player >= 1) {
      this.awardPoint('opponent', events)
      return
    }
    if (s.lastHitter === 'opponent' && s.bounces.opponent >= 1) {
      this.awardPoint('player', events)
      return
    }
  }

  private awardPoint(winner: Side, events: GameEvent[]): void {
    const s = this.state
    if (s.phase === 'point' || s.phase === 'gameover') return

    if (winner === 'player') s.score.player++
    else s.score.opponent++

    s.phase = 'point'
    s.pointTimer = this.options.pointDelay
    s.lastPointWinner = winner
    s.playerWindowOpen = false
    s.bounces = { player: 0, opponent: 0 }
    s.lastHitter = null

    events.push({
      type: 'point',
      winner,
      score: { ...s.score },
      message: winner === 'player' ? '得分！' : '失分…',
    })
  }

  private beginServe(): void {
    const s = this.state
    s.phase = 'serve'
    this.serveCount++
    s.ball.pos = { x: rand(this.rng, -0.35, 0.35), y: 0.34, z: rand(this.rng, 0.5, 0.7) }
    s.ball.vel = { x: rand(this.rng, -0.25, 0.25), y: -1.7, z: rand(this.rng, 1.1, 1.5) }
    s.ball.spin = 0
    s.bounces = { player: 0, opponent: 0 }
    s.lastHitter = null
    s.playerWindowOpen = false
    s.rallyHits = 0

    // 重置 AI 的锁定状态，让它重新预判这一次发球
    this.ai.engaged = false
    this.ai.hasTarget = false
    this.ai.reactionTimer = 0
    this.ai.predictionTimer = 0
  }

  /** 计算慢动作倍率：球正在飞向我方时逐渐放慢 */
  private computeTimeScale(): number {
    const s = this.state
    if (!this.options.slowMotion) return 1
    if (s.lastHitter !== 'opponent') return 1
    if (s.ball.pos.z >= 0 || s.ball.vel.z >= 0) return 1

    const speed = Math.abs(s.ball.vel.z)
    if (speed < 1e-4) return 1

    const eta = (s.ball.pos.z - PADDLE.homeZ) / speed
    if (eta < 0 || eta > this.options.slowMotionWindow) return 1

    const t = eta / this.options.slowMotionWindow
    return lerp(this.options.slowMotionScale, 1, t)
  }

  // ---------------------------------------------------------------- 查询辅助

  /** 当前是否处于"该挥拍了"的窗口 */
  get shouldSwing(): boolean {
    const s = this.state
    const eta = this.timeToPaddle
    const window = this.options.hitAssist ? PADDLE.assistSwingActiveTime : PADDLE.swingActiveTime
    return s.playerWindowOpen && s.lastHitter === 'opponent' && eta !== null && eta <= window * 0.8
  }

  /** 球飞到我方拍面还要多久（秒），不在接近中则返回 null */
  get timeToPaddle(): number | null {
    const s = this.state
    if (s.ball.vel.z >= 0 || s.ball.pos.z < PADDLE.homeZ) return null
    const speed = Math.abs(s.ball.vel.z)
    if (speed < 1e-4) return null
    return (s.ball.pos.z - PADDLE.homeZ) / speed
  }

  /** 下一个发球方（用于 UI 显示） */
  get nextServeSide(): Side {
    return Math.floor(this.serveCount / SERVE_ROTATION) % 2 === 0 ? 'opponent' : 'player'
  }
}
