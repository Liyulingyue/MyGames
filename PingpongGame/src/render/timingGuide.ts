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
