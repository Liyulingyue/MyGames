import { BALL, FIXED_DT, GRAVITY, PADDLE, TABLE } from './constants.ts'
import type { Ball, Paddle, Vec3 } from './types.ts'
import { clamp, distance } from './vec3.ts'

export type CollisionEvent =
  | { kind: 'table'; side: 'player' | 'opponent'; pos: Vec3 }
  | { kind: 'net'; pos: Vec3 }
  | { kind: 'floor'; pos: Vec3 }
  | { kind: 'paddle'; side: 'player' | 'opponent'; pos: Vec3; power: number }

/** 球台之外的兜底边界，出了这个范围直接判死球 */
export const OUT_OF_BOUNDS = { x: 2.6, z: 3.2, y: TABLE.floorY - 1 }

/**
 * 推进一个小时间步：重力 + 阻力 + 台面 / 球网 / 地板碰撞。
 * 碰撞采用"穿越检测"（比较前后位置），因此即使一步位移大于障碍厚度也不会穿模。
 */
export function stepBall(ball: Ball, dt: number, events: CollisionEvent[]): void {
  ball.vel.y += GRAVITY * dt

  const drag = Math.max(0, 1 - BALL.drag * dt)
  ball.vel.x *= drag
  ball.vel.z *= drag
  ball.spin *= Math.max(0, 1 - BALL.spinDecay * dt)

  const prev = { ...ball.pos }
  ball.pos.x += ball.vel.x * dt
  ball.pos.y += ball.vel.y * dt
  ball.pos.z += ball.vel.z * dt

  collideTable(ball, prev, events)
  collideNet(ball, prev, events)
  collideFloor(ball, events)
}

function collideTable(ball: Ball, prev: Vec3, events: CollisionEvent[]): void {
  const r = BALL.radius
  // 必须是从上往下穿过台面高度
  if (ball.vel.y >= 0) return
  if (prev.y - r <= TABLE.surfaceY) return
  if (ball.pos.y - r > TABLE.surfaceY) return

  const inBounds =
    Math.abs(ball.pos.x) <= TABLE.halfWidth && Math.abs(ball.pos.z) <= TABLE.halfLength
  if (!inBounds) return

  // 抬回台面高度并反弹
  ball.pos.y = TABLE.surfaceY + r
  ball.vel.y = -ball.vel.y * BALL.restitutionTable
  if (Math.abs(ball.vel.y) < BALL.minBounceSpeed) {
    ball.vel.y = BALL.minBounceSpeed
  }
  ball.vel.x *= BALL.frictionTable
  ball.vel.z *= BALL.frictionTable

  events.push({
    kind: 'table',
    side: ball.pos.z < 0 ? 'player' : 'opponent',
    pos: { ...ball.pos },
  })
}

function collideNet(ball: Ball, prev: Vec3, events: CollisionEvent[]): void {
  const r = BALL.radius
  const crossed = (prev.z < 0 && ball.pos.z >= 0) || (prev.z > 0 && ball.pos.z <= 0)
  if (!crossed) return

  // 线性插值出与网面 z=0 相交的点
  const t = prev.z / (prev.z - ball.pos.z)
  const cx = prev.x + (ball.pos.x - prev.x) * t
  const cy = prev.y + (ball.pos.y - prev.y) * t

  const netHalfWidth = TABLE.halfWidth + TABLE.netOverhang
  if (Math.abs(cx) > netHalfWidth) return // 从网两侧绕过
  if (cy - r > TABLE.netHeight) return // 从网上方飞过
  if (cy + r < TABLE.surfaceY) return // 已经掉到台面以下

  // 撞网：速度大幅衰减并弹回
  ball.pos.z = prev.z < 0 ? -TABLE.netDepth : TABLE.netDepth
  ball.vel.z = -ball.vel.z * BALL.restitutionNet
  ball.vel.x *= 0.45
  ball.vel.y *= 0.35
  ball.spin = 0

  events.push({ kind: 'net', pos: { x: cx, y: cy, z: 0 } })
}

function collideFloor(ball: Ball, events: CollisionEvent[]): void {
  if (ball.pos.y - BALL.radius > TABLE.floorY) return

  ball.pos.y = TABLE.floorY + BALL.radius
  if (ball.vel.y < 0) {
    ball.vel.y = -ball.vel.y * 0.45
    ball.vel.x *= 0.7
    ball.vel.z *= 0.7
    events.push({ kind: 'floor', pos: { ...ball.pos } })
  }
}

export interface PaddleHit {
  /** 球心相对拍心的偏移 */
  offsetX: number
  offsetY: number
  /** 球心到拍心的距离 */
  distance: number
}

/** 球与拍面（XY 平面上的圆盘）是否发生物理重叠 */
export function checkPaddleOverlap(ball: Ball, paddle: Paddle): PaddleHit | null {
  const dz = ball.pos.z - paddle.z
  if (Math.abs(dz) > PADDLE.thickness + BALL.radius) return null

  const offsetX = ball.pos.x - paddle.x
  const offsetY = ball.pos.y - paddle.y
  const d = Math.hypot(offsetX, offsetY)
  if (d > PADDLE.radius + BALL.radius) return null

  return { offsetX, offsetY, distance: d }
}

/**
 * 挥拍命中判定。
 *
 * 球必须真的落在拍面上：
 *   - 拍面平面内（XY），球心到拍心的距离不能超过 bladeReach
 *   - 只有 Z 方向（球飞过拍面的那一下）留一点厚度 PADDLE.swingDepth
 *
 * 以前这里用的是"球心到拍心 29cm 的球形范围"，比拍面（半径 7.5cm）大得多，
 * 于是球在离拍面还有十几二十厘米的地方就被判定为打中——
 * 球看起来是凭空飞走的，而且落点可以远在台面之外。
 */
export function checkSwingReach(
  ball: Ball,
  paddle: Paddle,
  depth: number = PADDLE.swingDepth,
  bladeReach: number = PADDLE.bladeReach,
): PaddleHit | null {
  const offsetX = ball.pos.x - paddle.x
  const offsetY = ball.pos.y - paddle.y
  const offsetZ = ball.pos.z - paddle.z

  // 拍面是 XY 平面上的一块圆盘
  if (Math.hypot(offsetX, offsetY) > bladeReach) return null
  // 挥拍扫过的厚度
  if (Math.abs(offsetZ) > depth) return null

  const d = Math.hypot(offsetX, offsetY, offsetZ)
  return { offsetX, offsetY, distance: d }
}

/**
 * 过网安全余量（米）。
 *
 * 解析解忽略了空气阻力，而模拟里每步都会衰减水平速度，
 * 实际过网点会比解析值略低（约 4~5mm），必须留出余量，否则会擦网。
 */
const NET_CLEARANCE_MARGIN = 0.015

/** 起射高度下限（米），防止贴地起射导致弹道过不了网 */
const MIN_LAUNCH_HEIGHT = 0.05

/**
 * 以给定速度把球射向台面上的目标点（y = 台面高度）。
 *
 * 流程：
 *   1. 速度太低时按"能过网的最小速度"兜底（见 minNetClearSpeed）
 *   2. 目标点超出当前速度的射程时，按射程收敛（避免球落在本方半区）
 *   3. 解出满足"恰好落在目标点"的抛射角
 *   4. 校验能否过网（含安全余量），过不了就抬高角度
 */
export function launchTo(from: Vec3, targetX: number, targetZ: number, speed: number): Vec3 {
  const dx = targetX - from.x
  const dz = targetZ - from.z
  const d = Math.hypot(dx, dz)
  if (d < 1e-4) {
    return { x: 0, y: speed * 0.35, z: speed * 0.9 }
  }

  // 物理上，速度太低根本没法把球送到对方半场（见 minShotSpeed 的说明）
  const v = Math.max(speed, minNetClearSpeed(from))

  const ux = dx / d
  const uz = dz / d
  const height = Math.max(MIN_LAUNCH_HEIGHT, from.y - TABLE.surfaceY)

  // 射程上限：目标点太远时收敛到 85% 射程，保证球仍落在对方半区
  const thetaOpt = optimalAngle(v, height)
  const maxRange = rangeAt(thetaOpt, v, height)
  const clampedD = Math.min(d, maxRange * 0.85)

  let theta = solveLaunchAngle(clampedD, height, v)
  for (let i = 0; i < 24; i++) {
    const vel = velocityAlong(ux, uz, theta, v)
    if (clearsNet(from, vel)) break
    theta = Math.min(theta + 0.025, thetaOpt)
    if (theta >= thetaOpt) break
  }

  return velocityAlong(ux, uz, theta, v)
}

/**
 * 能把球送到对方半场的最小初速（米/秒）。
 *
 * 为什么需要它：抛射的最大水平射程是 R = v²/g（45° 最佳）。
 * 球要从球拍（离网约 1.28m）越过网并落在对方半场，至少需要
 * R ≥ (到网距离 + 余量) / 0.85，否则物理上根本飞不过去。
 *
 * 速度不够时解析解只能给出很平的弹道 —— 球会直接撞在网子上。
 * 这就是"把球速调低之后双方都频繁碰网"的原因：
 * 不是 AI 或玩家打歪了，而是球速低于物理下限，弹道必然撞网。
 *
 * 所以这里给出一个下限：低于它的速度一律按这个值发射（变成高抛球），
 * 球速滑块可以调得很低，但球始终能合法过网。
 */
export function minNetClearSpeed(from: Vec3): number {
  const toNet = Math.abs(from.z)
  const needed = (toNet + 0.22) / 0.85
  return Math.sqrt(Math.max(0.5, needed) * -GRAVITY)
}

function velocityAlong(ux: number, uz: number, theta: number, speed: number): Vec3 {
  const horizontal = speed * Math.cos(theta)
  return {
    x: ux * horizontal,
    y: speed * Math.sin(theta),
    z: uz * horizontal,
  }
}

/** 抛射后能否从网的上方飞过（含安全余量） */
function clearsNet(from: Vec3, vel: Vec3): boolean {
  if (Math.abs(vel.z) < 1e-6) return true
  const t = Math.abs(from.z) / Math.abs(vel.z)
  if (!Number.isFinite(t)) return true
  const y = from.y + vel.y * t + 0.5 * GRAVITY * t * t
  return y - BALL.radius > TABLE.netHeight + NET_CLEARANCE_MARGIN
}

/**
 * 求出"以速度 speed 出发、恰好落在水平距离 d 处"的抛射角。
 *
 * 射程 R(θ) = v·cosθ · (v·sinθ + √((v·sinθ)² + 2gh)) / g
 * 在 θ ∈ (0, θ_opt] 上单调递增，取该区间内的解（低弹道、更快）。
 */
function solveLaunchAngle(d: number, height: number, speed: number): number {
  const thetaOpt = optimalAngle(speed, height)
  if (d >= rangeAt(thetaOpt, speed, height)) return 0.02

  let lo = 0.02
  let hi = thetaOpt
  for (let i = 0; i < 36; i++) {
    const mid = (lo + hi) / 2
    if (rangeAt(mid, speed, height) < d) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** 射程最大时的抛射角 */
function optimalAngle(speed: number, height: number): number {
  return Math.atan2(speed, Math.sqrt(speed * speed + 2 * -GRAVITY * height))
}

/** 给定抛射角时的水平射程 */
function rangeAt(theta: number, speed: number, height: number): number {
  const vh = speed * Math.cos(theta)
  const vv = speed * Math.sin(theta)
  const t = (vv + Math.sqrt(vv * vv + 2 * -GRAVITY * height)) / -GRAVITY
  return vh * t
}

export interface Prediction {
  /** 球到达目标 Z 时的位置 */
  pos: Vec3
  /** 所需时间（秒） */
  time: number
  /** 是否真的到达了目标 Z */
  reached: boolean
}

/** 预测合法来球穿过我方拍面时的横向位置；触网、出界或落台次数不合法则返回 null。 */
export function predictPlayerInterceptX(ball: Ball, alreadyBounced: boolean): number | null {
  if (ball.vel.z >= 0 || ball.pos.z <= PADDLE.homeZ) return null
  const sim: Ball = { pos: { ...ball.pos }, vel: { ...ball.vel }, spin: ball.spin }
  const events: CollisionEvent[] = []
  let bounced = alreadyBounced

  for (let t = 0; t < 3; t += FIXED_DT) {
    const previous = { ...sim.pos }
    events.length = 0
    stepBall(sim, FIXED_DT, events)
    for (const event of events) {
      if (event.kind === 'net' || event.kind === 'floor') return null
      if (event.kind === 'table') {
        if (event.side !== 'player' || bounced || event.pos.z <= PADDLE.homeZ) return null
        bounced = true
      }
    }
    if (Math.abs(sim.pos.x) > OUT_OF_BOUNDS.x || Math.abs(sim.pos.z) > OUT_OF_BOUNDS.z ||
        sim.pos.y < OUT_OF_BOUNDS.y || sim.vel.z >= 0) return null
    if (sim.pos.z <= PADDLE.homeZ) {
      if (!bounced) return null
      const fraction = (previous.z - PADDLE.homeZ) / (previous.z - sim.pos.z)
      return previous.x + (sim.pos.x - previous.x) * fraction
    }
  }
  return null
}

/**
 * 前向模拟小球，返回它穿过 targetZ 时的位置。
 * 供对手 AI 预判落点使用。
 */
export function predictBallAtZ(
  ball: Ball,
  targetZ: number,
  maxTime = 3,
  step = 1 / 120,
): Prediction {
  const sim: Ball = {
    pos: { ...ball.pos },
    vel: { ...ball.vel },
    spin: ball.spin,
  }
  const events: CollisionEvent[] = []
  let t = 0
  const dir = Math.sign(targetZ - sim.pos.z) || 1

  while (t < maxTime) {
    const prevZ = sim.pos.z
    stepBall(sim, step, events)
    t += step
    if (dir > 0 ? sim.pos.z >= targetZ : sim.pos.z <= targetZ) {
      const alpha = Math.abs(targetZ - prevZ) < 1e-9 ? 1 : (targetZ - prevZ) / (sim.pos.z - prevZ)
      return {
        pos: {
          x: sim.pos.x,
          y: sim.pos.y,
          z: targetZ,
        },
        time: t - step * (1 - alpha),
        reached: true,
      }
    }
  }

  return { pos: { ...sim.pos }, time: t, reached: false }
}

/** 球拍沿 X 方向移动到目标位置，返回是否到达 */
export function movePaddleToward(paddle: Paddle, targetX: number, maxSpeed: number, dt: number): boolean {
  const delta = targetX - paddle.x
  const step = maxSpeed * dt
  if (Math.abs(delta) <= step) {
    paddle.vx = delta / Math.max(dt, 1e-6)
    paddle.x = targetX
    return true
  }
  paddle.vx = Math.sign(delta) * maxSpeed
  paddle.x += paddle.vx * dt
  return false
}

/** 把速度限制在给定区间 */
export function clampSpeed(v: Vec3, max: number): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z)
  if (len <= max || len < 1e-8) return v
  const s = max / len
  return { x: v.x * s, y: v.y * s, z: v.z * s }
}

/** 计算球拍中心与球心的距离（用于 UI 提示） */
export const paddleDistance = (ball: Ball, paddle: Paddle): number =>
  distance(ball.pos, { x: paddle.x, y: paddle.y, z: paddle.z })

export { clamp }
