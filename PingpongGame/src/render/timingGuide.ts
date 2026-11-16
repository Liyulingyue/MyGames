/** Visual urgency is based on simulated time; green is reserved for the swing window. */
export function timingGuideStyle(eta: number, swingEta: number, shouldSwing: boolean): {
  color: string
  width: number
} {
  const colorProgress = Math.max(0, Math.min(1, (1.15 - eta) / 0.6))
  const color = shouldSwing
    ? [88, 224, 138]
    : [77 + 178 * colorProgress, 212 - 32 * colorProgress, 255 - 171 * colorProgress]
  const progress = Math.max(0, Math.min(1, (1.15 - eta) / (1.15 - swingEta)))
  return {
    color: `rgb(${color.map(Math.round).join(', ')})`,
    width: 110 - 65 * progress,
  }
}
