/**
 * 键盘输入：没有摄像头时的备用方案，也是调试物理用的工具。
 *
 * - ← / → 或 A / D：左右移动球拍
 * - 空格：挥拍（力度固定）
 *
 * 球拍高度由游戏自动跟随球，不需要上下控制（见 PingPongGame.autoPaddleHeight）。
 *
 * 方向按"屏幕方向"理解：按右键球拍在屏幕上往右走。
 * 由于相机朝 +Z 看，屏幕右方对应世界 -X，映射时需要取反。
 */
import { PADDLE } from '../core/constants.ts'

export class KeyboardController {
  private keys = new Set<string>()
  private swingQueued = false
  private targetX = 0
  private speed = 1.1

  /** 注册键盘监听，返回取消函数 */
  attach(): () => void {
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return
      if (e.target && (e.target as HTMLElement).closest?.('button, input, select, textarea, [contenteditable="true"]')) return
      this.keys.add(e.key.toLowerCase())
      if (e.key === ' ') {
        this.swingQueued = true
        e.preventDefault()
      }
    }
    const onUp = (e: KeyboardEvent) => {
      this.keys.delete(e.key.toLowerCase())
    }
    const onBlur = () => this.clearKeys()

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)

    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }

  /** 每帧更新球拍横向目标位置 */
  update(dt: number): { x: number } {
    let dx = 0
    // 相机朝 +Z（对手方向）看，所以世界 +X 显示在屏幕左边。
    // 用户按"右"要往世界 -X 走。
    if (this.keys.has('arrowleft') || this.keys.has('a')) dx += 1
    if (this.keys.has('arrowright') || this.keys.has('d')) dx -= 1

    if (dx !== 0) {
      this.targetX += dx * this.speed * dt
    }

    this.targetX = Math.max(-PADDLE.rangeX, Math.min(PADDLE.rangeX, this.targetX))

    return { x: this.targetX }
  }

  /** 本帧是否请求挥拍 */
  consumeSwing(): boolean {
    const queued = this.swingQueued
    this.swingQueued = false
    return queued
  }

  clearKeys(): void {
    this.keys.clear()
    this.swingQueued = false
  }

  reset(): void {
    this.targetX = 0
    this.clearKeys()
  }
}
