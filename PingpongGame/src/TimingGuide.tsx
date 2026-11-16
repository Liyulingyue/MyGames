import type { Ref } from 'react'
import { timingGuidePath, timingGuideStyle } from './render/timingGuide.ts'

interface TimingGuideProps {
  preview?: boolean
  guideRef?: Ref<HTMLDivElement>
  waveRef?: Ref<SVGPathElement>
  targetRef?: Ref<HTMLDivElement>
  paddleRef?: Ref<HTMLDivElement>
}

export function TimingGuide({ preview = false, guideRef, waveRef, targetRef, paddleRef }: TimingGuideProps) {
  const example = timingGuideStyle(0.5, 1, false)
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
        <path ref={waveRef} d={preview ? timingGuidePath(0.55, example.width) : undefined} />
      </svg>
      <div className="timing-target" ref={targetRef} style={preview ? { left: '55%' } : undefined} aria-hidden="true"><span>目标</span>▼</div>
      <div className="timing-paddle" ref={paddleRef} style={preview ? { left: '45%' } : undefined} aria-hidden="true">◆<span>球拍</span></div>
    </div>
  )
}
