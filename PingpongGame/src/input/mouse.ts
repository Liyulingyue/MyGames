/**
 * 鼠标输入：移动鼠标控制球拍左右，点击左键挥拍。
 *
 * 相比键盘更适合"只想看一眼、随手玩两下"的场景，也方便在
 * 没有摄像头、没有手柄的机器上玩。
 *
 * 方向同样按"屏幕方向"理解：鼠标往屏幕右���走，球拍在屏幕上也往右走。
 * 由于相机朝 +Z 看，屏幕右方对应世界 -X，映射时需要取反。
 */

export interface MouseHost {
  addEventListener(type: string, fn: (e: unknown) => void): void
  removeEventListener(type: string, fn: (e: unknown) => void): void
}

export interface MouseControllerOptions {
  /** 鼠标横向移动映射到球拍的半幅（米） */
  range?: number
  /** 当前视口宽度，用来把 clientX 归一化到 0~1 */
  viewportWidth: () => number
}

/** 鼠标横移到屏幕最边上时，球拍到达的最大偏移（米） */
export const MOUSE_RANGE = 0.75

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export class MouseController {
  private targetX = 0
  private swingQueued = false
  private moveHost: MouseHost | null = null
  private clickHost: MouseHost | null = null
  private readonly range: number
  private readonly viewportWidth: () => number

  constructor(options: MouseControllerOptions) {
    this.range = options.range ?? MOUSE_RANGE
    this.viewportWidth = options.viewportWidth
  }

  /**
   * 注册监听。
   *
   * - moveHost：接收 mousemove 的宿主（一般是 window，这样鼠标移出画布也还能跟踪）
   * - clickHost：接收 mousedown 的宿主（一般是画布容器，避免点到 HUD 按钮时误挥拍）
   */
  attach(moveHost: MouseHost, clickHost: MouseHost = moveHost): void {
    this.detach()
    this.moveHost = moveHost
    this.clickHost = clickHost
    moveHost.addEventListener('mousemove', this.onMove)
    clickHost.addEventListener('mousedown', this.onDown)
  }

  detach(): void {
    this.moveHost?.removeEventListener('mousemove', this.onMove)
    this.clickHost?.removeEventListener('mousedown', this.onDown)
    this.moveHost = null
    this.clickHost = null
  }

  private onMove = (e: unknown): void => {
    const ev = e as { clientX?: number }
    if (typeof ev.clientX !== 'number') return
    const width = this.viewportWidth()
    if (!width || width <= 0) return
    const nx = clamp(ev.clientX / width, 0, 1)
    // 屏幕右方 = 世界 -X
    this.targetX = -(nx - 0.5) * 2 * this.range
  }

  private onDown = (e: unknown): void => {
    const ev = e as { button?: number }
    // 只认左键；button 为 undefined 的合成事件也当作左键
    if (ev.button !== undefined && ev.button !== 0) return
    this.swingQueued = true
  }

  /** 每帧读取球拍横向目标位置 */
  update(): { x: number } {
    return { x: this.targetX }
  }

  /** 本帧是否请求挥拍 */
  consumeSwing(): boolean {
    if (!this.swingQueued) return false
    this.swingQueued = false
    return true
  }

  reset(): void {
    this.targetX = 0
    this.swingQueued = false
  }
}
