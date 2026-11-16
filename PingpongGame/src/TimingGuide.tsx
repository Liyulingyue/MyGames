import type { Ref } from 'react'
import { timingGuidePath, timingGuideStyle } from './render/timingGuide.ts'

interface TimingGuideProps {
  preview?: boolean
  guideRef?: Ref<HTMLDivElement>
  waveRef?: Ref<SVGPathElement>
  targetRef?: Ref<HTMLDivElement>
  paddleRef?: Ref<HTMLDivElement>
  previewTargetX?: number
  previewPaddleX?: number
}

export function TimingGuide({
  preview = false, guideRef, waveRef, targetRef, paddleRef,
  previewTargetX = 0.55, previewPaddleX = 0.45,
}: TimingGuideProps) {
  const example = timingGuideStyle(0.5, 1, false)
  const edge = (x: number) => x < 0 ? 'left' : x > 1 ? 'right' : ''
  const position = (x: number) => `${Math.max(0, Math.min(1, x)) * 100}%`
  return (
    <div
      className="timing-guide"
      ref={guideRef}
      data-phase={preview ? 'ready' : 'hidden'}
      role="img"
      aria-label={preview ? '击球提示带静态示例' : '击球提示带'}
      style={preview ? { color: example.color } : undefined}
    >
      <svg viewBox="0 42 1000 48" preserveAspectRatio="none" aria-hidden="true">
        <path ref={waveRef} d={preview ? timingGuidePath(previewTargetX, example.width) : undefined} />
      </svg>
      <div className="timing-target" ref={targetRef} data-edge={preview ? edge(previewTargetX) : undefined}
        style={preview ? { left: position(previewTargetX) } : undefined} aria-hidden="true">
        <span>{preview && previewTargetX < 0 ? '← 目标画外' : preview && previewTargetX > 1 ? '目标画外 →' : '目标'}</span>▼
      </div>
      <div className="timing-paddle" ref={paddleRef} data-edge={preview ? edge(previewPaddleX) : undefined}
        style={preview ? { left: position(previewPaddleX) } : undefined} aria-hidden="true">
        ◆<span>{preview && previewPaddleX < 0 ? '← 球拍画外' : preview && previewPaddleX > 1 ? '球拍画外 →' : '球拍'}</span>
      </div>
    </div>
  )
}
