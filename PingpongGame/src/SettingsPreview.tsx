import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { PingPongGame } from './core/game.ts'
import { PADDLE } from './core/constants.ts'
import type { GameRenderer } from './render/renderer.ts'
import type { Environment } from './render/scene.ts'
import type { CameraPose } from './render/view.ts'
import { TIMING_WAVE_HEIGHT } from './render/timingGuide.ts'
import { TimingGuide } from './TimingGuide.tsx'

interface PreviewSettings {
  environment: Environment
  displaySize: number
  cameraPose: CameraPose
}

const PREVIEW_TARGET_X = 0.12

export function SettingsPreview({
  environment,
  displaySize,
  cameraPose,
  aspect,
  timingGuide,
  timingGuideHeight,
  softAlign,
  softAlignRange,
  autoMove,
}: PreviewSettings & {
  aspect: number
  timingGuide: boolean
  timingGuideHeight: number
  softAlign: boolean
  softAlignRange: number
  autoMove: boolean
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<GameRenderer | null>(null)
  const settingsRef = useRef<PreviewSettings>({ environment, displaySize, cameraPose })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0, scale: 0 })
  const [projection, setProjection] = useState<{
    target: number; paddle: number; left: number; right: number
  } | null>(null)

  settingsRef.current = { environment, displaySize, cameraPose }

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const resize = () => {
      setPreviewSize({
        width: window.innerWidth,
        height: window.innerHeight,
        scale: frame.clientWidth / window.innerWidth,
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(frame)
    window.addEventListener('resize', resize)
    resize()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let renderer: GameRenderer | null = null
    setLoading(true)
    setError(null)

    const start = async () => {
      try {
        const { GameRenderer } = await import('./render/renderer.ts')
        if (cancelled || !hostRef.current) return
        renderer = new GameRenderer(hostRef.current)
        rendererRef.current = renderer
        const settings = settingsRef.current
        renderer.setEnvironment(settings.environment)
        renderer.setDisplaySize(settings.displaySize)
        renderer.setCameraPose(settings.cameraPose)
        renderer.sync(new PingPongGame().state)
        renderer.render()
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        renderer?.dispose()
        renderer = null
        rendererRef.current = null
        setLoading(false)
        setError(`预览加载失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    void start()
    return () => {
      cancelled = true
      renderer?.dispose()
      rendererRef.current = null
    }
  }, [attempt])

  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    renderer.setEnvironment(environment)
    renderer.setDisplaySize(displaySize)
    renderer.setCameraPose(cameraPose)
    renderer.render()
    const target = renderer.projectPaddleX(PREVIEW_TARGET_X, PADDLE.homeY)
    const paddle = renderer.projectPaddleX(0, PADDLE.homeY)
    const start = renderer.projectPaddleX(Math.max(-PADDLE.rangeX, PREVIEW_TARGET_X - softAlignRange), PADDLE.homeY)
    const end = renderer.projectPaddleX(Math.min(PADDLE.rangeX, PREVIEW_TARGET_X + softAlignRange), PADDLE.homeY)
    setProjection(target !== null && paddle !== null && start !== null && end !== null
      ? { target, paddle, left: Math.min(start, end), right: Math.max(start, end) }
      : null)
  }, [environment, displaySize, cameraPose, softAlignRange, previewSize, loading])

  return (
    <div className="settings-preview-frame" ref={frameRef} style={{ '--screen-aspect': aspect } as CSSProperties}>
      <div className="settings-preview-canvas" ref={hostRef} aria-label="球台画面预览" />
      {(timingGuide || (softAlign && !autoMove)) && projection && previewSize.scale > 0 && (
        <div
          className="settings-preview-guide"
          style={{
            width: previewSize.width,
            height: previewSize.height,
            transform: `scale(${previewSize.scale})`,
            '--timing-wave-height': `${TIMING_WAVE_HEIGHT * timingGuideHeight}px`,
          } as CSSProperties}
        >
          {timingGuide && <TimingGuide preview previewTargetX={projection.target} previewPaddleX={projection.paddle} />}
          {softAlign && !autoMove && projection.right > 0 && projection.left < 1 && (
            <>
              <div
                className="soft-align-preview"
                role="img"
                aria-label={`软吸附进入范围示例，目标两侧各 ${Math.round(softAlignRange * 100)} 厘米`}
                style={{
                  left: `${Math.max(0, projection.left) * 100}%`,
                  width: `${(Math.min(1, projection.right) - Math.max(0, projection.left)) * 100}%`,
                }}
              />
              {projection.target >= 0 && projection.target <= 1 && (
                <div className="soft-align-preview-target" style={{ left: `${projection.target * 100}%` }} aria-hidden="true" />
              )}
            </>
          )}
        </div>
      )}
      {!loading && !error && !projection && (timingGuide || (softAlign && !autoMove)) && (
        <div className="settings-preview-unavailable" role="status">球拍平面出画，无法显示辅助示例</div>
      )}
      {!loading && !error && projection && softAlign && !autoMove && (projection.right <= 0 || projection.left >= 1) && (
        <div className="settings-preview-unavailable" role="status">吸附示例范围在画外</div>
      )}
      {!loading && !error && projection && softAlign && !autoMove &&
        projection.right > 0 && projection.left < 1 && (projection.left < 0 || projection.right > 1) && (
        <div className="settings-preview-unavailable" role="status">部分吸附示例范围在画外</div>
      )}
      {loading && <div className="settings-preview-message" role="status">正在加载画面预览…</div>}
      {error && (
        <div className="settings-preview-message" role="alert">
          <span>{error}</span>
          <button className="ghost-btn" onClick={() => setAttempt((value) => value + 1)}>重试</button>
        </div>
      )}
    </div>
  )
}
