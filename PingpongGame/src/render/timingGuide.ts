/** Progress starts when a prediction first becomes visible, not at a fixed ETA. */
export function timingGuideStyle(eta: number, startEta: number, shouldSwing: boolean): {
  color: string
  width: number
} {
  const progress = Math.max(0, Math.min(1, 1 - eta / Math.max(startEta, 0.001)))
  const colorProgress = Math.min(1, progress / 0.7)
  const color = shouldSwing
    ? [88, 224, 138]
    : [77 + 178 * colorProgress, 212 - 32 * colorProgress, 255 - 171 * colorProgress]
  return {
    color: `rgb(${color.map(Math.round).join(', ')})`,
    width: 155 - 120 * progress,
  }
}

/** Original 92px guide: 48% from the wave baseline to its peak. */
export const TIMING_WAVE_HEIGHT = 44.16

export function timingGuidePath(targetX: number, width: number): string {
  const peak = targetX * 1000
  let path = 'M 0 90'
  for (let x = 0; x <= 1000; x += 10) {
    const height = 48 * Math.exp(-0.5 * ((x - peak) / width) ** 2)
    path += ` L ${x} ${(90 - height).toFixed(1)}`
  }
  return `${path} L 1000 90 Z`
}
