import type { AIConfig } from './constants.ts'
import { PADDLE } from './constants.ts'
import type { Ball, Paddle } from './types.ts'
import { checkSwingReach, launchTo, movePaddleToward, predictBallAtZ } from './physics.ts'
import { clamp, rand } from './vec3.ts'

export interface AIState {
  paddle: Paddle
  /** 反应计时器：> 0 表示"还没反应过来"，暂时不会击球 */
  reactionTimer: number
  /** 当前预判的落点 X */
  targetX: number
  /** 是否已经锁定落点 */
  hasTarget: boolean
  /** 本次来球是否已经处理过（击球或漏接），避免重复判定 */
  engaged: boolean
  /** 距离下次重新预判落点的剩余时间 */
  predictionTimer: number
}

export function createAIState(): AIState {
  return {
    paddle: {
      x: 0,
      y: 0.25,
      z: PADDLE.opponentZ,
      vx: 0,
      vy: 0,
      activeTimer: 0,
      cooldown: 0,
      lastSwingPower: 0,
      swingAnim: 0,
    },
    reactionTimer: 0,
    targetX: 0,
    hasTarget: false,
    engaged: false,
    predictionTimer: 0,
  }
}

export interface AIContext {
  rng: () => number
  config: AIConfig
  /** 玩家挡板位置，AI 会瞄着空档打 */
  playerPaddle: Paddle
  /** 球是否已经在对手半场落过台（落台后才轮到 AI 击球） */
  ballBouncedOnOpponentSide: boolean
}

export type AIAction =
  | { kind: 'none' }
  | { kind: 'hit'; velocity: { x: number; y: number; z: number }; targetX: number; targetZ: number; power: number }
  | { kind: 'miss' }

/**
 * AI 可接受的击球深度（米）。
 *
 * 球从拍面旁边掠过就算打中——比玩家稍宽松一点，保证 AI 能稳定回球，
 * 但也必须贴着拍面，否则球会在半路就被打飞。
 */
const AI_DEPTH = PADDLE.swingDepth + 0.02

export function updateAI(ai: AIState, ball: Ball, ctx: AIContext, dt: number): AIAction {
  const { rng, config, playerPaddle } = ctx

  if (ai.reactionTimer > 0) ai.reactionTimer -= dt

  // —— 预判来球落点 ——
  // 预判是一次前向模拟，比较重，20Hz 刷新即可
  ai.predictionTimer -= dt
  const approaching = ball.vel.z > 0 && ball.pos.z < ai.paddle.z + 0.05
  if (approaching) {
    if (!ai.hasTarget) {
      ai.hasTarget = true
      ai.reactionTimer = config.reactionDelay
    }
    if (ai.predictionTimer <= 0) {
      ai.predictionTimer = 0.05
      const prediction = predictBallAtZ(ball, ai.paddle.z)
      // 球拍中心不超出台面：拍面始终盖在台面上
      ai.targetX = clamp(prediction.pos.x, -PADDLE.rangeX, PADDLE.rangeX)
      // 挡板高度跟随预测的球高度，模拟"抬手准备"
      // 跟得紧一点：击球判定要求球真的落在拍面上，挡板高度差太多就够不着了
      const targetY = clamp(prediction.pos.y, 0.08, 0.5)
      ai.paddle.y += (targetY - ai.paddle.y) * Math.min(1, dt * 24)
    }
  } else {
    ai.hasTarget = false
    ai.engaged = false
    ai.predictionTimer = 0
    // 待机时挡板缓慢回到中线
    ai.paddle.y += (0.25 - ai.paddle.y) * Math.min(1, dt * 2)
  }

  movePaddleToward(ai.paddle, ai.targetX, config.paddleSpeed, dt)

  // —— 判定是否击球 ——
  const canHit =
    ctx.ballBouncedOnOpponentSide &&
    !ai.engaged &&
    ai.reactionTimer <= 0 &&
    approaching &&
    ball.pos.z > ai.paddle.z - AI_DEPTH &&
    ball.pos.z < ai.paddle.z + AI_DEPTH

  if (!canHit) return { kind: 'none' }

  const reach = checkSwingReach(ball, ai.paddle, AI_DEPTH)
  if (!reach) return { kind: 'none' }

  ai.engaged = true

  // 漏接：AI 挥空
  if (rng() < config.missChance) {
    ai.paddle.swingAnim = 1
    return { kind: 'miss' }
  }

  // 瞄玩家挡板的空档
  const away = playerPaddle.x >= 0 ? -1 : 1
  const aimTarget = playerPaddle.x + away * rand(rng, 0.18, 0.5)
  const targetX = clamp(aimTarget + rand(rng, -config.aimError, config.aimError), -0.62, 0.62)
  const targetZ = rand(rng, -1.0, -0.5)
  const speed = rand(rng, config.shotSpeed[0], config.shotSpeed[1])

  const velocity = launchTo(ball.pos, targetX, targetZ, speed)

  ai.paddle.swingAnim = 1
  ai.paddle.lastSwingPower = 0.6

  return { kind: 'hit', velocity, targetX, targetZ, power: 0.6 }
}
