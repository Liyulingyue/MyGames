import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { PingPongGame } from './core/game.ts'
import type { GameRenderer } from './render/renderer.ts'
import type { Environment } from './render/scene.ts'
import type { CameraPose } from './render/view.ts'

interface PreviewSettings {
  environment: Environment
  displaySize: number
  cameraPose: CameraPose
}

export function SettingsPreview({
  environment,
  displaySize,
  cameraPose,
  aspect,
}: PreviewSettings & { aspect: number }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<GameRenderer | null>(null)
  const settingsRef = useRef<PreviewSettings>({ environment, displaySize, cameraPose })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)

  settingsRef.current = { environment, displaySize, cameraPose }

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
  }, [environment, displaySize, cameraPose])

  return (
    <div className="settings-preview-frame" style={{ '--screen-aspect': aspect } as CSSProperties}>
      <div className="settings-preview-canvas" ref={hostRef} aria-label="球台画面预览" />
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
