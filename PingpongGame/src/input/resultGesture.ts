import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { isVisible, LANDMARK } from './poseTracker.ts'

export type ResultAction = 'restart' | 'menu'

/** Require both hands down before accepting one raised hand. */
export class ResultGesture {
  private armed = false
  private action: ResultAction | null = null
  private heldMs = 0
  private lastTime: number | null = null

  reset(): void {
    this.armed = false
    this.action = null
    this.heldMs = 0
    this.lastTime = null
  }

  update(landmarks: NormalizedLandmark[] | null, now: number): {
    action: ResultAction | null
    progress: number
    confirmed: boolean
  } {
    const dt = this.lastTime === null ? 0 : now - this.lastTime
    this.lastTime = now
    const leftShoulder = landmarks?.[LANDMARK.LEFT_SHOULDER]
    const rightShoulder = landmarks?.[LANDMARK.RIGHT_SHOULDER]
    const leftWrist = landmarks?.[LANDMARK.LEFT_WRIST]
    const rightWrist = landmarks?.[LANDMARK.RIGHT_WRIST]
    if (dt < 0 || dt > 250 || !leftShoulder || !rightShoulder || !leftWrist || !rightWrist ||
        !isVisible(leftShoulder) || !isVisible(rightShoulder) ||
        !isVisible(leftWrist) || !isVisible(rightWrist)) {
      this.armed = false
      this.action = null
      this.heldMs = 0
      return { action: null, progress: 0, confirmed: false }
    }

    const leftUp = leftWrist.y < leftShoulder.y - 0.06
    const rightUp = rightWrist.y < rightShoulder.y - 0.06
    if (!leftUp && !rightUp) {
      this.armed = true
      this.action = null
      this.heldMs = 0
      return { action: null, progress: 0, confirmed: false }
    }
    const action = leftUp === rightUp ? null : leftUp ? 'restart' : 'menu'
    if (!this.armed || !action) {
      this.action = null
      this.heldMs = 0
      return { action: null, progress: 0, confirmed: false }
    }
    if (action !== this.action) {
      this.action = action
      this.heldMs = 0
    } else {
      this.heldMs += dt
    }
    const progress = Math.min(1, this.heldMs / 1800)
    if (progress === 1) this.armed = false
    return { action, progress, confirmed: progress === 1 }
  }
}
