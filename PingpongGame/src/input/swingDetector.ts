import type { ArmSample, PoseFrame } from './poseTracker.ts'

/**
 * 用哪只手挥拍。
 *
 * - left / right：只有选中的那只手才算（惯用左手的人选左手，
 *   免得另一只手在画面里乱动也触发）。
 * - both：哪只手动得更厉害就用哪只（默认，最不容易漏判）。
 */
export type HandPreference = 'left' | 'right' | 'both'

/**
 * 从姿态帧里挑出"用来判定挥拍"的那条手臂。
 *
 * 追踪器两条手臂都在算，判定用哪一条由偏好决定——
 * HUD 显示的数值也用这个函数挑，保证"看到的"和"判定的"是同一个。
 */
export function pickArmSample(
  frame: PoseFrame,
  hand: HandPreference = 'both',
): ArmSample | null {
  if (hand === 'left') return frame.leftArm
  if (hand === 'right') return frame.rightArm
  return frame.fastest
}

export interface SwingOptions {
  /** 触发挥拍的速度阈值（肩宽 / 秒，按路径长度算） */
  threshold: number
  /**
   * 触发挥拍的垂直位移阈值（肩宽）。
   *
   * 引拍主要是上下方向，所以"手腕在窗口内上下拉开了多少"是个很直接的信号：
   * 它不受"挥完又回到原位"的影响，比纯速度判定更容易触发。
   */
  verticalRange: number
  /** 达到该倍数算满力 */
  fullPowerScale: number
  /** 两次挥拍之间的最小间隔（秒） */
  cooldown: number
  /** 速度回落到该比例以下才允许下一次触发（滞回，避免连续触发） */
  releaseRatio: number
  /**
   * 肘部兜底时的阈值折扣（默认 0.6）。
   *
   * 手腕没被检测到时会改用肘部，肘部跟着手臂动但幅度只有手腕的一半左右，
   * 所以阈值要放宽，否则兜底几乎不可能触发（等于白加）。
   */
  elbowRatio?: number
  /** 用哪只手挥拍（默认 both：哪只动得厉害用哪只） */
  hand?: HandPreference
}

/**
 * 挥拍检测器。
 *
 * 判定依据有两个，满足其一即算挥拍：
 *   - 速度（手腕在最近 ~150ms 内的运动路径长度 / 时长）> threshold
 *   - 垂直位移（窗口内手腕上下拉开的幅度）> verticalRange
 *
 * 力度取两个信号里更强的那个。触发后进入冷却，
 * 且速度回落到 releaseRatio 以下才重新武装（滞回，避免一次挥手被识别成好几次挥拍）。
 */
export class SwingDetector {
  private options: SwingOptions
  private cooldownUntil = 0
  private armed = true

  constructor(options: SwingOptions) {
    this.options = options
  }

  /** 更新参数（阈值、冷却等） */
  configure(options?: Partial<SwingOptions>): void {
    if (options) this.options = { ...this.options, ...options }
  }

  /**
   * 喂入一帧姿态数据。
   * @param now 当前时间戳（毫秒，与 performance.now() 一致）
   * @returns 本帧是否触发了挥拍，以及力度 0~1
   */
  process(frame: PoseFrame, now: number): { swung: boolean; power: number } {
    const sample = pickArmSample(frame, this.options.hand ?? 'both')
    if (!sample) {
      // 没采到手臂运动（人离开画面 / 手腕和肘部都没识别到）→ 重新武装
      this.armed = true
      return { swung: false, power: 0 }
    }

    const { speed, verticalRange, source } = sample

    // 肘部兜底时阈值放宽（肘部动作幅度比手腕小）
    const ratio = source === 'elbow' ? (this.options.elbowRatio ?? 0.6) : 1
    const threshold = this.options.threshold * ratio
    const verticalThreshold = this.options.verticalRange * ratio

    const { fullPowerScale, cooldown, releaseRatio } = this.options

    // 两个信号：运动速度、垂直引拍幅度
    const speedSignal = speed / threshold
    const verticalSignal = verticalRange / Math.max(1e-6, verticalThreshold)
    const signal = Math.max(speedSignal, verticalSignal)

    if (!this.armed) {
      // 两个信号都回落到阈值以下才重新武装（滞回，避免一次挥手被识别成好几次挥拍）
      if (speed < threshold * releaseRatio && verticalRange < verticalThreshold * releaseRatio) {
        this.armed = true
      }
      return { swung: false, power: 0 }
    }

    if (signal < 1) return { swung: false, power: 0 }
    // 冷却时间是秒，now 是毫秒 —— 这里必须换算，否则冷却等于没有
    if (now < this.cooldownUntil) return { swung: false, power: 0 }

    this.armed = false
    this.cooldownUntil = now + cooldown * 1000

    const power = Math.min(1, (signal - 1) / Math.max(0.001, fullPowerScale - 1))
    return { swung: true, power: Math.max(0.15, power) }
  }

  /** 当前是否处于冷却中（UI 提示用） */
  get coolingDown(): boolean {
    return !this.armed
  }

  reset(): void {
    this.armed = true
    this.cooldownUntil = 0
  }
}

/**
 * 从姿态帧里推出球拍的目标位置。
 *
 * - 横向：**绝对映射** —— 人在摄像头画面里的位置直接决定球拍位置，
 *   站在画面左边球拍就在左边，往哪边走球拍就跟到哪边。
 *   零点就是**摄像头画面的正中**：站在画面中心 → 球拍在中间。
 * - 纵向：不由玩家控制，交给游戏自动跟随球的高度（体感下蹲/抬手太别扭）
 */
export function paddleTargetFromPose(frame: PoseFrame, rangeX: number): { x: number } {
  const bodyX = frame.bodyX
  // bodyX 是镜像后的画面坐标：玩家往自己右手边走，bodyX 变大。
  // 相机朝 +Z 看，屏幕右方是世界 -X，所以这里要取反。
  //
  // 相对画面中心的偏移量，按"人体活动区"的半宽归一化：
  // 人只要在画面中心附近移动，就能覆盖整个球拍行程。
  const rel = (bodyX - BODY_CENTER_X) / BODY_ACTIVE_HALF_SPAN
  const x = -rel * rangeX
  return { x: Math.max(-rangeX, Math.min(rangeX, x)) }
}

/** 体感映射的零点：摄像头画面的正中 */
const BODY_CENTER_X = 0.5

/**
 * 以参考中心为基准，人体左右移动多远算"打满"（画面宽度的比例）。
 *
 * 取 0.22：人在参考中心左右各移动约 22% 画面宽度，就能把球拍从一端打到另一端。
 * 摄像头只拍到上半身时这个值比较合适。
 */
export const BODY_ACTIVE_HALF_SPAN = 0.22
