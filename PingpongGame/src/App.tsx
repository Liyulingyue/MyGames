import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { PingPongGame } from './core/game.ts'
import type { RulesMode } from './core/game.ts'
import { AI_PRESETS, HIT_JUDGMENT_PRESETS, PADDLE, PLAYER, TARGET_SCORE } from './core/constants.ts'
import type { HitJudgment } from './core/constants.ts'
import type { Phase, Side } from './core/types.ts'
import type { GameRenderer } from './render/renderer.ts'
import type { Environment } from './render/scene.ts'
import { CAMERA_LIMITS, DEFAULT_CAMERA, VIEW, checkFrame, type CameraPose } from './render/view.ts'
import { PoseTracker, isVisible } from './input/poseTracker.ts'
import type { MotionSource, PoseFrame, PoseLoadProgress } from './input/poseTracker.ts'
import { SwingDetector, paddleTargetFromPose, pickArmSample, handOf, isMouseSwing } from './input/swingDetector.ts'
import type { SwingSource } from './input/swingDetector.ts'
import { KeyboardController } from './input/keyboard.ts'
import { MouseController } from './input/mouse.ts'
import { SoundEngine } from './input/sound.ts'
import { SettingsPreview } from './SettingsPreview.tsx'
import { ResultGesture } from './input/resultGesture.ts'
import type { ResultAction } from './input/resultGesture.ts'

type InputMode = 'keyboard' | 'pose' | 'mouse'
type Difficulty = 'easy' | 'normal' | 'hard'
type Screen = 'menu' | 'settings' | 'playing'

const HIT_JUDGMENT_LABELS: Record<HitJudgment, string> = {
  light: '弱',
  standard: '标准',
  strong: '强',
}
const HIT_JUDGMENT_LEVELS: HitJudgment[] = ['light', 'standard', 'strong']

/**
 * 由"挥拍灵敏度"推出垂直位移阈值。
 *
 * 灵敏度滑块只有一个，但实际有两个判定信号：
 *   - 速度：手腕在 180ms 内的运动路径长度 / 时长（肩宽 / 秒）
 *   - 垂直位移：手腕在 180ms 内上下拉开的幅度（肩宽）
 *
 * 两者按固定比例联动，灵敏度调高时两个信号一起变严格。
 */
function verticalThresholdOf(sensitivity: number): number {
  return sensitivity * PLAYER.swingVerticalRatio
}

/**
 * 体感模式默认放慢一点（0.85），鼠标/键盘模式用 1.0。
 *
 * 这里调的是"时间倍率"（慢动作），不是球的物理速度：弹道不变，
 * 只是整段比赛走得慢一点，反应时间更多。
 */
const POSE_DEFAULT_TIME_SCALE = 0.85
const NORMAL_DEFAULT_TIME_SCALE = 1

/**
 * 开发调试用的合成姿态帧。
 *
 * 传 null 表示没有注入（走真实摄像头）。
 */
interface DevPose {
  /** 镜像后的屏幕坐标（0~1） */
  x: number
  y: number
  /** 手腕运动速度（肩宽 / 秒） */
  speed: number
  /** 手腕垂直位移（肩宽） */
  verticalRange: number
  /** 身体中心在画面里的横向位置，决定球拍目标 */
  bodyX?: number
  /** 人体尺寸参照（画面宽度比例），模拟"人离摄像头多远" */
  bodyScale?: number
  /** 采样点来源，'elbow' 可以模拟"手腕没识别到"的兜底情况 */
  source?: MotionSource
}

interface HudState {
  score: { player: number; opponent: number }
  phase: Phase
  server: Side
  serveStage: 'waiting' | 'firstBounce' | 'secondBounce' | null
  fps: number
  timeScale: number
  shouldSwing: boolean
  timeToPaddle: number | null
  hasPerson: boolean
  cameraState: 'off' | 'loading' | 'ready' | 'error'
  /** 摄像头 / 模型初始化失败的原因（游戏内显示） */
  cameraError: string | null
  message: string | null
  messageKind: 'good' | 'bad' | null
  swingPower: number
  /** 体感模式下身体在画面里的绝对位置（0~1，0=画面左边，0.5=零点） */
  bodyPos: number
  /** 手臂运动是否被识别到（识别不到就永远触发不了挥拍） */
  armSeen: boolean
  /** 当前采样点：手腕 / 肘部（兜底） / 无 */
  armSource: MotionSource | null
  /** 体感模式下手臂的运动速度（肩宽 / 秒），实时反馈，便于调灵敏度 */
  swingSpeed: number
  /** 体感模式下手臂的垂直位移（肩宽），实时反馈 */
  swingVert: number
  /** 本局结束时的结果 */
  gameOver: { winner: Side; player: number; opponent: number } | null
}

const INITIAL_HUD: HudState = {
  score: { player: 0, opponent: 0 },
  phase: 'idle',
  server: 'opponent',
  serveStage: null,
  fps: 0,
  timeScale: 1,
  shouldSwing: false,
  timeToPaddle: null,
  hasPerson: false,
  cameraState: 'off',
  cameraError: null,
  message: null,
  messageKind: null,
  swingPower: 0,
  bodyPos: 0.5,
  armSeen: false,
  armSource: null,
  swingSpeed: 0,
  swingVert: 0,
  gameOver: null,
}

/**
 * 带"已选部分"色条的滑块。
 *
 * 原生 range 的轨道是一条死板的灰线，看不出当前值在区间里的位置；
 * 这里用 --fill 把已选中的那一段涂成主色，一眼就有数。
 *
 * 双击滑块可以恢复默认值（很多视频编辑器/设计工具都这么用）。
 */
function Slider({
  min,
  max,
  step,
  value,
  onChange,
  defaultValue,
  title,
  ariaLabel,
}: {
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  /** 传了就允许双击恢复到这个值 */
  defaultValue?: number
  title?: string
  ariaLabel?: string
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      title={title ?? (defaultValue !== undefined ? '双击恢复默认' : undefined)}
      aria-label={ariaLabel}
      style={{ '--fill': `${Math.max(0, Math.min(100, pct))}%` } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
      onDoubleClick={() => {
        if (defaultValue !== undefined) onChange(defaultValue)
      }}
    />
  )
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('menu')
  const [inputMode, setInputMode] = useState<InputMode>('keyboard')
  const [difficulty, setDifficulty] = useState<Difficulty>('normal')
  const [rules, setRules] = useState<RulesMode>('casual')
  const [swingThreshold, setSwingThreshold] = useState<number>(PLAYER.swingThreshold)
  const [slowMotion, setSlowMotion] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [confirmExit, setConfirmExit] = useState(false)
  /** 左上角状态面板是否展开（折叠起来只剩一行，游戏时更清爽） */
  const [showStatus, setShowStatus] = useState(true)
  const [showPoseOverlay, setShowPoseOverlay] = useState(true)
  const [timeScale, setTimeScale] = useState<number>(NORMAL_DEFAULT_TIME_SCALE)
  const [autoMove, setAutoMove] = useState(false)
  const [autoSwing, setAutoSwing] = useState(false)
  const [hitJudgment, setHitJudgment] = useState<HitJudgment>('standard')
  const [predictionAssist, setPredictionAssist] = useState(false)
  const [softAlign, setSoftAlign] = useState(false)
  const [softAlignStrength, setSoftAlignStrength] = useState(0.6)
  /**
   * 体感模式下怎么击球。
   *
   * - left / right：挥指定的那只手（惯用左手的人选左手）
   * - both：哪只手挥得更厉害就用哪只（默认）
   * - mouse：不用手腕——走位仍然跟着身体，击球改用鼠标左键
   */
  const [swingSource, setSwingSource] = useState<SwingSource>('both')
  /** 音效开关 */
  const [soundOn, setSoundOn] = useState(true)
  /** 音量 0~1 */
  const [soundVolume, setSoundVolume] = useState(0.65)
  /** 画面倍率：1 = 原样，3 = 画面放大约三倍，0.5 = 画面缩一半（裁剪缩放，透视不变） */
  const [displaySize, setDisplaySize] = useState(1)
  /** 相机位姿：位置 (x/y/z) + 俯角，用户可调（范围受限） */
  const [cameraPose, setCameraPose] = useState<CameraPose>({ ...DEFAULT_CAMERA })
  const [environment, setEnvironment] = useState<Environment>('bright')
  /** 画布宽高比：给"画面检查"诊断用 */
  const [viewAspect, setViewAspect] = useState(VIEW.referenceAspect)
  /** 用户是否手动调过球速：没调过的话，切到体感模式会自动用更慢的球 */
  const speedTouchedRef = useRef(false)
  const [hud, setHud] = useState<HudState>(INITIAL_HUD)
  const [bootError, setBootError] = useState<string | null>(null)
  const [booting, setBooting] = useState(false)
  const [loadProgress, setLoadProgress] = useState<PoseLoadProgress | null>(null)
  const [cameraFault, setCameraFault] = useState<string | null>(null)
  const [resultGesture, setResultGesture] = useState<{ action: ResultAction | null; progress: number }>({
    action: null, progress: 0,
  })

  /**
   * 比分变化计数：谁的分数变了就把那一侧的 key 换掉，
   * 元素被重新挂载，CSS 动画自动重播一次（数字"弹一下"）。
   */
  const [scoreBump, setScoreBump] = useState({ player: 0, opponent: 0 })
  const prevScoreRef = useRef({ player: 0, opponent: 0 })

  const containerRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  /** 结算页的「再来一局」按钮：结算后自动聚焦，回车直接能重开 */
  const restartBtnRef = useRef<HTMLButtonElement>(null)
  const retryCameraBtnRef = useRef<HTMLButtonElement>(null)
  const settingsBtnRef = useRef<HTMLButtonElement>(null)
  const exitDialogRef = useRef<HTMLDialogElement>(null)
  const restoreMenuFocusRef = useRef(false)
  const startGenerationRef = useRef(0)

  const gameRef = useRef<PingPongGame | null>(null)
  const rendererRef = useRef<GameRenderer | null>(null)
  const rendererModuleRef = useRef<typeof import('./render/renderer.ts') | null>(null)
  const trackerRef = useRef<PoseTracker | null>(null)
  const detectorRef = useRef<SwingDetector | null>(null)
  const keyboardRef = useRef<KeyboardController | null>(null)
  const mouseRef = useRef<MouseController | null>(null)
  const soundRef = useRef<SoundEngine | null>(null)
  const cameraSetupPromiseRef = useRef<Promise<boolean> | null>(null)
  const pendingTrackerRef = useRef<PoseTracker | null>(null)
  const cameraGenerationRef = useRef(0)

  // 放进 ref，主循环里就不用依赖 state 变化而重启
  const inputModeRef = useRef<InputMode>(inputMode)
  const slowMotionRef = useRef(slowMotion)
  const swingThresholdRef = useRef(swingThreshold)
  const difficultyRef = useRef(difficulty)
  const rulesRef = useRef(rules)
  const cameraFaultRef = useRef<string | null>(null)
  const showPoseOverlayRef = useRef(showPoseOverlay)
  const timeScaleRef = useRef(timeScale)
  const autoMoveRef = useRef(autoMove)
  const autoSwingRef = useRef(autoSwing)
  const hitJudgmentRef = useRef(hitJudgment)
  const predictionAssistRef = useRef(predictionAssist)
  const softAlignRef = useRef(softAlign)
  const softAlignStrengthRef = useRef(softAlignStrength)
  const swingSourceRef = useRef(swingSource)
  /** 取景设置：新开一局时新建的渲染器要沿用当前设置 */
  const displaySizeRef = useRef(displaySize)
  const cameraPoseRef = useRef(cameraPose)
  const environmentRef = useRef(environment)
  const pausedRef = useRef(showSettings)
  /** 开发调试用：注入的合成姿态帧（null = 用真实摄像头） */
  const devPoseRef = useRef<PoseFrame | null>(null)
  /** setupCamera 定义在 switchInputMode 之后，用 ref 打破循环依赖 */
  const cameraSetupRef = useRef<() => Promise<boolean>>(async () => false)

  inputModeRef.current = inputMode
  slowMotionRef.current = slowMotion
  swingThresholdRef.current = swingThreshold
  difficultyRef.current = difficulty
  rulesRef.current = rules
  showPoseOverlayRef.current = showPoseOverlay
  timeScaleRef.current = timeScale
  autoMoveRef.current = autoMove
  autoSwingRef.current = autoSwing
  hitJudgmentRef.current = hitJudgment
  predictionAssistRef.current = predictionAssist
  softAlignRef.current = softAlign
  softAlignStrengthRef.current = softAlignStrength
  swingSourceRef.current = swingSource
  pausedRef.current = showSettings
  environmentRef.current = environment

  /**
   * 切换输入方式。
   * ref 要同步写：否则"选体感模式后立刻点开始游戏"（同一帧内）会读到旧模式，
   * 导致摄像头初始化被跳过。
   *
   * 切到体感模式时如果摄像头还没开，这里补一次初始化——
   * 否则会出现"选了体感但球拍怎么都不动"：没有画面，也就没有姿态数据。
   *
   * 体感模式下默认把球速调慢一点（体感反应比鼠标慢）；
   * 但用户手动调过球速的话，就不再自动改动。
   */
  const switchInputMode = useCallback((mode: InputMode) => {
    inputModeRef.current = mode
    setInputMode(mode)
    if (mode !== 'pose') {
      if (pendingTrackerRef.current) {
        cameraGenerationRef.current++
        pendingTrackerRef.current.close()
        pendingTrackerRef.current = null
        cameraSetupPromiseRef.current = null
        setBooting(false)
        setLoadProgress(null)
        setHud((h) => h.cameraState === 'loading' ? { ...h, cameraState: 'off' } : h)
      }
      if (cameraFaultRef.current) {
        trackerRef.current?.videoElement?.remove()
        trackerRef.current?.close()
        trackerRef.current = null
      }
      cameraFaultRef.current = null
      setCameraFault(null)
    }
    if (!speedTouchedRef.current) {
      setTimeScale(mode === 'pose' ? POSE_DEFAULT_TIME_SCALE : NORMAL_DEFAULT_TIME_SCALE)
    }
    if (mode === 'pose' && !trackerRef.current) {
      void cameraSetupRef.current()
    }
  }, [])

  // ---------------------------------------------------------------- 初始化

  const ensureKeyboard = useCallback((): KeyboardController => {
    if (!keyboardRef.current) keyboardRef.current = new KeyboardController()
    return keyboardRef.current
  }, [])

  const ensureMouse = useCallback((): MouseController => {
    if (!mouseRef.current) {
      mouseRef.current = new MouseController({ viewportWidth: () => window.innerWidth })
    }
    return mouseRef.current
  }, [])

  const ensureDetector = useCallback((): SwingDetector => {
    if (!detectorRef.current) {
      detectorRef.current = new SwingDetector({
        threshold: PLAYER.swingThreshold,
        verticalRange: verticalThresholdOf(PLAYER.swingThreshold),
        fullPowerScale: PLAYER.swingFullPowerScale,
        cooldown: 0.42,
        releaseRatio: 0.55,
        elbowRatio: PLAYER.elbowThresholdRatio,
      })
    }
    return detectorRef.current
  }, [])

  /**
   * 音效引擎：全程只建一个实例。
   *
   * AudioContext 必须在用户手势里创建，所以真正"解锁"发生在点开始游戏时；
   * 这里只是把实例准备好。
   */
  const ensureSound = useCallback((): SoundEngine => {
    if (!soundRef.current) soundRef.current = new SoundEngine()
    return soundRef.current
  }, [])

  const attachCameraPreview = useCallback((video: HTMLVideoElement) => {
    if (!previewRef.current) return
    previewRef.current.appendChild(video)
    video.style.width = '100%'
    video.style.height = '100%'
    video.style.objectFit = 'cover'
    video.style.transform = 'scaleX(-1)'
  }, [])

  /** 重新连接失败时保留暂停；普通初始化失败则回退到键盘。 */
  const setupCamera = useCallback((fallbackOnFailure = true): Promise<boolean> => {
    if (trackerRef.current) return Promise.resolve(true)
    if (cameraSetupPromiseRef.current) return cameraSetupPromiseRef.current

    const generation = cameraGenerationRef.current
    const setup = async (): Promise<boolean> => {
      setBooting(true)
      setBootError(null)
      setLoadProgress({ stage: 'wasm', ratio: null })
      setHud((h) => ({ ...h, cameraState: 'loading', cameraError: null }))
      let tracker: PoseTracker | null = null
      try {
        tracker = new PoseTracker()
        pendingTrackerRef.current = tracker
        await tracker.init((progress) => {
          if (generation === cameraGenerationRef.current) setLoadProgress(progress)
        })
        if (generation !== cameraGenerationRef.current) return false
        setLoadProgress({ stage: 'camera', ratio: null })
        const video = await tracker.startCamera()
        if (generation !== cameraGenerationRef.current) {
          tracker.close()
          return false
        }
        trackerRef.current = tracker

        attachCameraPreview(video)

        setHud((h) => ({ ...h, cameraState: 'ready', cameraError: null }))
        return true
      } catch (err) {
        tracker?.close()
        if (generation !== cameraGenerationRef.current) return false
        const message = err instanceof Error ? err.message : String(err)
        setHud((h) => ({ ...h, cameraState: 'error', cameraError: message }))
        if (fallbackOnFailure) {
          setBootError(`摄像头 / 模型初始化失败：${message}\n已自动切换到键盘模式，可以先开始游戏。`)
          switchInputMode('keyboard')
        } else {
          const fault = `重新连接失败：${message}`
          cameraFaultRef.current = fault
          setCameraFault(fault)
        }
        return false
      } finally {
        if (generation === cameraGenerationRef.current) {
          pendingTrackerRef.current = null
          cameraSetupPromiseRef.current = null
          setBooting(false)
          setLoadProgress(null)
        }
      }
    }

    const promise = setup()
    cameraSetupPromiseRef.current = promise
    return promise
  }, [switchInputMode, attachCameraPreview])

  cameraSetupRef.current = setupCamera

  const retryCamera = useCallback(async () => {
    trackerRef.current?.videoElement?.remove()
    trackerRef.current?.close()
    trackerRef.current = null
    const ok = await setupCamera(false)
    if (ok) {
      cameraFaultRef.current = null
      setCameraFault(null)
    }
  }, [setupCamera])

  const startGame = useCallback(async () => {
    const generation = ++startGenerationRef.current
    // 浏览器规定 AudioContext 必须在用户手势里解锁，否则一直是挂起状态
    ensureSound().unlock()
    if (inputModeRef.current === 'pose' && !trackerRef.current) {
      // 摄像头没起来就留在开始界面并给出提示，避免玩家对着黑屏找不到原因
      const ok = await setupCamera()
      if (!ok || generation !== startGenerationRef.current) return
    }
    if (!rendererModuleRef.current) {
      setBooting(true)
      try {
        rendererModuleRef.current = await import('./render/renderer.ts')
        if (generation !== startGenerationRef.current) return
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setBootError(`3D 渲染器加载失败：${message}`)
        return
      } finally {
        setBooting(false)
      }
    }
    ensureKeyboard()
    ensureDetector()
    setShowSettings(false)
    setScreen('playing')
  }, [setupCamera, ensureKeyboard, ensureDetector, ensureSound])

  /** 重新开一局（比分清零，球拍回到中间） */
  const restartGame = useCallback(() => {
    const game = gameRef.current
    if (!game) return
    game.start(Math.floor(Math.random() * 1e9))
    keyboardRef.current?.reset()
    mouseRef.current?.reset()
    detectorRef.current?.reset()
    setResultGesture({ action: null, progress: 0 })
    setHud((h) => ({
      ...h,
      score: { player: 0, opponent: 0 },
      phase: game.state.phase,
      server: game.state.server,
      serveStage: game.state.serveStage,
      message: null,
      messageKind: null,
      gameOver: null,
    }))
  }, [])

  /** 结束这一局，回到主菜单 */
  const backToMenu = useCallback(() => {
    startGenerationRef.current++
    cameraGenerationRef.current++
    pendingTrackerRef.current?.close()
    pendingTrackerRef.current = null
    trackerRef.current?.close()
    trackerRef.current = null
    cameraSetupPromiseRef.current = null
    setBooting(false)
    setLoadProgress(null)
    setConfirmExit(false)
    setScreen('menu')
    setShowSettings(false)
    setHud(INITIAL_HUD)
    cameraFaultRef.current = null
    setCameraFault(null)
    setResultGesture({ action: null, progress: 0 })
  }, [])

  const leaveSettingsPage = useCallback(() => {
    startGenerationRef.current++
    restoreMenuFocusRef.current = true
    setScreen('menu')
  }, [])

  useEffect(() => {
    if (screen === 'menu' && restoreMenuFocusRef.current) {
      settingsBtnRef.current?.focus()
      restoreMenuFocusRef.current = false
    }
  }, [screen])

  // ---------------------------------------------------------------- 主循环

  useEffect(() => {
    if (screen !== 'playing') return
    const container = containerRef.current
    if (!container) return
    const Renderer = rendererModuleRef.current?.GameRenderer
    if (!Renderer) return

    const game = new PingPongGame({
      seed: Math.floor(Math.random() * 1e9),
      ai: difficultyRef.current,
      targetScore: TARGET_SCORE,
      rules: rulesRef.current,
      slowMotion: slowMotionRef.current,
      timeScale: timeScaleRef.current,
      autoMove: autoMoveRef.current,
      autoSwing: autoSwingRef.current,
      hitJudgment: hitJudgmentRef.current,
      predictionAssist: predictionAssistRef.current,
      softAlign: softAlignRef.current,
      softAlignStrength: softAlignStrengthRef.current,
    })
    gameRef.current = game
    game.start()

    const renderer = new Renderer(container)
    rendererRef.current = renderer
    // 新渲染器要沿用当前的取景设置（重开一局也不丢）
    renderer.setDisplaySize(displaySizeRef.current)
    renderer.setCameraPose(cameraPoseRef.current)
    renderer.setEnvironment(environmentRef.current)

    const video = trackerRef.current?.videoElement
    if (video) attachCameraPreview(video)

    // 鼠标：mousemove 挂在 window 上（移出画布也继续跟踪），
    // mousedown 挂在画布容器上（点到 HUD 按钮时不要误挥拍）
    const mouse = ensureMouse()
    mouse.attach(window, container)

    const detector = ensureDetector()

    // 开发模式下暴露实例，方便在控制台里调试物理与手感
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__pingpong = {
        game,
        renderer,
        mouse,
        detector,
        /**
         * 注入一帧"合成姿态"，用来在没有摄像头的环境里验证体感链路
         * （映射 → 挥拍检测 → 球拍移动 → HUD 反馈）。
         * 传 null 表示恢复真实摄像头数据。
         */
        setFakePose: (pose: DevPose | null) => {
          devPoseRef.current = pose
            ? {
                hasPerson: true,
                bodyX: pose.bodyX ?? 0.5,
                bodyScale: pose.bodyScale ?? 0.25,
                leftArm: { ...pose, speed: 0, verticalRange: 0, source: 'wrist' },
                rightArm: { ...pose, source: pose.source ?? 'wrist' },
                fastest: { ...pose, source: pose.source ?? 'wrist' },
                timestamp: performance.now(),
              }
            : null
        },
        /** 强制切换输入模式，跳过摄像头初始化（调试用） */
        forceInputMode: (mode: InputMode) => {
          inputModeRef.current = mode
          setInputMode(mode)
        },
        /**
         * 注入原始关键点（跳过摄像头），用来验证 visibility 过滤这条链路。
         * 传 null 恢复真实数据。
         */
        setFakeLandmarks: (landmarks: unknown[] | null) => {
          let tracker = trackerRef.current
          if (!tracker) {
            // 没有摄像头时也能用：注入路径不碰模型和摄像头
            tracker = new PoseTracker()
            trackerRef.current = tracker
          }
          tracker.setFakeLandmarks((landmarks as never[]) ?? null)
        },
        /** 当前输入模式 */
        getInputMode: () => inputModeRef.current,
        /** 当前姿态追踪器（调试用） */
        getTracker: () => trackerRef.current,
      }
    }

    const detachKeyboard = ensureKeyboard().attach()
    detector.configure({
      threshold: swingThresholdRef.current,
      verticalRange: verticalThresholdOf(swingThresholdRef.current),
    })
    const sound = ensureSound()

    let raf = 0
    let last = performance.now()
    let hudTimer = 0
    let fpsTimer = 0
    let fpsFrames = 0
    let fps = 0
    let messageUntil = 0
    /** 上一次的回合阶段，用来在"发球"时响一声提示 */
    let lastPhase = ''
    /** 最近一帧姿态数据（真实摄像头或调试注入） */
    let lastFrame: PoseFrame | null = null
    let lastFreshFrame = performance.now()
    let wasGameOver = false
    let gestureKey = ''
    const resultControl = new ResultGesture()

    /**
     * 在摄像头预览上叠加人体辅助框。
     *
     * 画的是关键点连线 + 包住整个人体的矩形框，
     * 用来确认"到底有没有识别到人"——体感模式下看不到自己时，
     * 很难判断是摄像头没拍到、还是识别没生效、还是映射没反应。
     */
    const drawPoseOverlay = () => {
      const canvas = overlayRef.current
      const tracker = trackerRef.current
      if (!canvas || !tracker) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const video = tracker.videoElement
      if (!video || !video.videoWidth) return
      if (canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (!showPoseOverlayRef.current) return

      const landmarks = tracker.landmarks
      if (!landmarks || landmarks.length === 0) {
        ctx.fillStyle = 'rgba(255, 157, 122, 0.95)'
        ctx.font = `${Math.round(canvas.height * 0.07)}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText('未检测到人', canvas.width / 2, canvas.height / 2)
        return
      }

      // 只画**检测到了**的关键点：MediaPipe 对没检测到的点仍然返回坐标 (0,0)，
      // 直接画的话包围盒会被拉到画面左上角，骨架也会连到角上。
      const visible = landmarks.filter((lm) => isVisible(lm))

      // 人体包围盒（辅助框）
      let minX = 1
      let minY = 1
      let maxX = 0
      let maxY = 0
      for (const lm of visible) {
        if (lm.x < minX) minX = lm.x
        if (lm.x > maxX) maxX = lm.x
        if (lm.y < minY) minY = lm.y
        if (lm.y > maxY) maxY = lm.y
      }
      if (visible.length === 0) {
        ctx.fillStyle = 'rgba(255, 157, 122, 0.95)'
        ctx.font = `${Math.round(canvas.height * 0.07)}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText('未检测到人', canvas.width / 2, canvas.height / 2)
        return
      }
      const pad = 0.02
      minX = Math.max(0, minX - pad)
      maxX = Math.min(1, maxX + pad)
      minY = Math.max(0, minY - pad)
      maxY = Math.min(1, maxY + pad)

      ctx.strokeStyle = 'rgba(77, 212, 255, 0.95)'
      ctx.lineWidth = 3
      ctx.setLineDash([10, 6])
      ctx.strokeRect(
        minX * canvas.width,
        minY * canvas.height,
        (maxX - minX) * canvas.width,
        (maxY - minY) * canvas.height,
      )
      ctx.setLineDash([])

      // 肩 → 肘 → 腕 连线
      const pairs: [number, number][] = [
        [11, 12],
        [11, 13],
        [13, 15],
        [12, 14],
        [14, 16],
      ]
      ctx.strokeStyle = 'rgba(77, 212, 255, 0.85)'
      ctx.lineWidth = 4
      for (const [a, b] of pairs) {
        const la = landmarks[a]
        const lb = landmarks[b]
        if (!isVisible(la) || !isVisible(lb)) continue
        ctx.beginPath()
        ctx.moveTo(la.x * canvas.width, la.y * canvas.height)
        ctx.lineTo(lb.x * canvas.width, lb.y * canvas.height)
        ctx.stroke()
      }

      // 手腕高亮
      ctx.fillStyle = '#ffb454'
      for (const i of [15, 16]) {
        const l = landmarks[i]
        if (!isVisible(l)) continue
        ctx.beginPath()
        ctx.arc(l.x * canvas.width, l.y * canvas.height, 9, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      const frameElapsed = now - last
      last = now

      if (pausedRef.current) {
        lastFreshFrame = now
        resultControl.reset()
        mouse.consumeSwing()
        ensureKeyboard().clearKeys()
        if (messageUntil) messageUntil += frameElapsed
        renderer.render()
        raf = requestAnimationFrame(loop)
        return
      }

      // ---- 输入 ----
      // 鼠标的目标与挥拍请求每帧都取一次：即使当前不是鼠标模式，
      // 也要把排队的挥拍消费掉，否则切换模式后会莫名其妙挥一下。
      const mouseTarget = mouse.update()
      const mouseSwing = mouse.consumeSwing()

      if (inputModeRef.current === 'pose') {
        const tracker = trackerRef.current
        // 摄像头是在开始界面初始化的，那时还没有预览容器，这里补挂一次
        const host = previewRef.current
        const video = tracker?.videoElement
        if (tracker && host && video && video.parentElement !== host) {
          host.appendChild(video)
          video.style.width = '100%'
          video.style.height = '100%'
          video.style.objectFit = 'cover'
          video.style.transform = 'scaleX(-1)'
        }
        // devPoseRef 只在开发调试时注入数据，正常运行时是 null
        let frame: PoseFrame | null | undefined
        if (!cameraFaultRef.current) {
          try {
            if (!devPoseRef.current && tracker?.videoElement && !tracker.cameraLive) {
              throw new Error('摄像头已断开')
            }
            frame = devPoseRef.current ?? tracker?.detect(now)
            if (frame) lastFreshFrame = now
            else if (tracker && now - lastFreshFrame > 2000) throw new Error('摄像头画面超过 2 秒没有更新')
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            cameraFaultRef.current = message
            setCameraFault(message)
            setHud((h) => ({
              ...h, cameraState: 'error', cameraError: message, hasPerson: false,
              bodyPos: 0.5, armSeen: false, armSource: null, swingSpeed: 0, swingVert: 0,
            }))
            detector.reset()
          }
        }
        if (cameraFaultRef.current || (!tracker && !devPoseRef.current)) {
          lastFrame = null
          lastFreshFrame = now
          mouse.consumeSwing()
          ensureKeyboard().clearKeys()
          renderer.render()
          raf = requestAnimationFrame(loop)
          return
        }
        if (frame) lastFrame = frame
        if (frame) {
          const resultScreen = game.isGameOver
          if (resultScreen) {
            if (!wasGameOver) resultControl.reset()
            const gesture = resultControl.update(tracker?.landmarks ?? null, now)
            const progress = Math.floor(gesture.progress * 10) * 10
            const key = `${gesture.action}:${progress}`
            if (key !== gestureKey) {
              gestureKey = key
              setResultGesture({ action: gesture.action, progress })
            }
            if (gesture.confirmed) {
              resultControl.reset()
              if (gesture.action === 'restart') {
                detector.reset()
                restartGame()
              } else if (gesture.action === 'menu') {
                backToMenu()
                return
              }
            }
          } else if (frame.hasPerson) {
            // 绝对映射：人在画面里的位置 → 球拍位置（零点 = 摄像头画面正中）
            const target = paddleTargetFromPose(frame, PLAYER.xRange)
            game.setPlayerTarget(target.x)
          }

          if (!resultScreen && !isMouseSwing(swingSourceRef.current)) {
            // 挥拍检测不依赖身体位置：肩膀没识别到时，手臂照样能挥出信号
            const result = detector.process(frame, now)
            if (result.swung) game.swing(result.power)
          }
        }
        if (!game.isGameOver && isMouseSwing(swingSourceRef.current) && mouseSwing) {
          game.swing(0.75)
        }
      } else if (inputModeRef.current === 'mouse') {
        lastFreshFrame = now
        game.setPlayerTarget(mouseTarget.x)
        if (mouseSwing) game.swing(0.75)
      } else {
        lastFreshFrame = now
        const keyboard = ensureKeyboard()
        const target = keyboard.update(dt)
        game.setPlayerTarget(target.x)
        if (keyboard.consumeSwing()) game.swing(0.75)
      }

      // ---- 推进游戏 ----
      wasGameOver = game.isGameOver
      const events = game.step(dt)
      if (!wasGameOver && game.isGameOver) resultControl.reset()
      // 发球提示：进入 serve 阶段时响一声
      if (game.state.phase === 'serve' && lastPhase !== 'serve') sound.play('serve')
      lastPhase = game.state.phase
      // 击球的这一帧同时会有 swing 和 paddleHit 两个事件，
      // 这时只播"啪"，不播挥空的风声——否则每次得分都是两声。
      const playerHit = events.some((e) => e.type === 'paddleHit' && e.side === 'player')
      for (const ev of events) {
        switch (ev.type) {
          case 'paddleHit':
            sound.play('paddle', ev.power ?? 0.7)
            break
          case 'bounce':
            sound.play('bounce')
            break
          case 'netHit':
            sound.play('net')
            break
          case 'swing':
            if (!playerHit) sound.play('whiff', ev.power ?? 0.6)
            break
          case 'point':
            sound.play('point')
            break
          case 'gameOver':
            sound.play(ev.winner === 'player' ? 'win' : 'lose')
            break
          default:
            break
        }

        if (ev.type === 'point') {
          const won = ev.winner === 'player'
          setHud((h) => ({
            ...h,
            message: won ? '得分！' : '失分',
            messageKind: won ? 'good' : 'bad',
          }))
          messageUntil = now + 1200
        } else if (ev.type === 'gameOver') {
          const winner = ev.winner ?? 'opponent'
          const score = ev.score ?? game.state.score
          setHud((h) => ({
            ...h,
            message: winner === 'player' ? '你赢了！' : '你输了',
            messageKind: winner === 'player' ? 'good' : 'bad',
            gameOver: { winner, player: score.player, opponent: score.opponent },
          }))
          messageUntil = now + 4000
        }
      }

      // ---- 渲染 ----
      renderer.sync(game.state)
      renderer.render()
      drawPoseOverlay()

      // ---- HUD 刷新（10Hz，避免每帧重渲染 React）----
      fpsFrames++
      fpsTimer += dt
      if (fpsTimer >= 0.5) {
        fps = Math.round(fpsFrames / fpsTimer)
        fpsFrames = 0
        fpsTimer = 0
      }

      hudTimer += dt
      if (hudTimer >= 0.1) {
        hudTimer = 0
        const s = game.state
        const frame = inputModeRef.current === 'pose' ? lastFrame : null
        // HUD 显示的必须是"实际参与判定"的那条手臂，否则会和手感对不上
        const sample = frame ? pickArmSample(frame, handOf(swingSourceRef.current)) : null
        setHud((h) => ({
          ...h,
          score: { ...s.score },
          phase: s.phase,
          server: s.server,
          serveStage: s.serveStage,
          fps,
          timeScale: s.timeScale,
          shouldSwing: game.shouldSwing,
          timeToPaddle: game.timeToPaddle,
          hasPerson: frame?.hasPerson ?? false,
          bodyPos: frame?.hasPerson ? frame.bodyX : 0.5,
          armSeen: !!sample,
          armSource: sample?.source ?? null,
          swingSpeed: sample?.speed ?? 0,
          swingVert: sample?.verticalRange ?? 0,
          message: now < messageUntil ? h.message : null,
          messageKind: now < messageUntil ? h.messageKind : null,
        }))
      }

      raf = requestAnimationFrame(loop)
    }

    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      detachKeyboard()
      mouse.detach()
      renderer.dispose()
      rendererRef.current = null
      gameRef.current = null
    }
  }, [screen, ensureKeyboard, ensureDetector, ensureMouse, ensureSound, attachCameraPreview, restartGame, backToMenu])

  useEffect(() => {
    keyboardRef.current?.clearKeys()
    mouseRef.current?.consumeSwing()
    detectorRef.current?.reset()
  }, [showSettings])

  useEffect(() => {
    const dialog = exitDialogRef.current
    if (!confirmExit || !dialog) return
    dialog.showModal()
    return () => dialog.close()
  }, [confirmExit])

  // 难度 / 慢动作实时生效（不重开一局）
  useEffect(() => {
    const game = gameRef.current
    if (!game) return
    game.options.ai = difficulty
    game.options.aiConfig = AI_PRESETS[difficulty]
    game.options.slowMotion = slowMotion
  }, [difficulty, slowMotion])

  // 比分变了就重播一次数字动画
  useEffect(() => {
    const prev = prevScoreRef.current
    const next = hud.score
    if (next.player !== prev.player) {
      setScoreBump((s) => ({ ...s, player: s.player + 1 }))
    }
    if (next.opponent !== prev.opponent) {
      setScoreBump((s) => ({ ...s, opponent: s.opponent + 1 }))
    }
    prevScoreRef.current = { ...next }
  }, [hud.score])

  // 结算后把焦点放到「再来一局」上：回车直接重开，键盘用户不用再 Tab 一次
  useEffect(() => {
    if (hud.gameOver) restartBtnRef.current?.focus()
  }, [hud.gameOver])

  useEffect(() => {
    if (cameraFault) retryCameraBtnRef.current?.focus()
  }, [cameraFault])

  /**
   * 全局快捷键 + 点面板外关闭设置：
   * - Esc：先关掉设置面板；结算页再按 Esc 回主菜单
   * - Enter：结算页「再来一局」；主菜单「开始游戏」
   * - 鼠标点设置面板以外的地方，面板自动收起
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (cameraFaultRef.current) return
      const target = e.target as HTMLElement | null
      // 焦点在按钮/滑块里时，回车交给控件自己处理，避免重复触发
      const inControl = !!target?.closest?.('button, input, select, textarea')
      if (e.key === 'Escape') {
        if (screen === 'settings') {
          e.preventDefault()
          leaveSettingsPage()
          return
        }
        if (confirmExit) {
          e.preventDefault()
          exitDialogRef.current?.close()
          setConfirmExit(false)
          setShowSettings(false)
          settingsBtnRef.current?.focus()
          return
        }
        if (showSettings) {
          setShowSettings(false)
          settingsBtnRef.current?.focus()
        }
        else if (hud.gameOver) backToMenu()
        return
      }
      if (e.key !== 'Enter' || inControl || showSettings) return
      if (hud.gameOver) {
        e.preventDefault()
        restartGame()
      } else if (screen === 'menu') {
        e.preventDefault()
        void startGame()
      }
    }
    const onPointerDown = (e: MouseEvent) => {
      if (screen !== 'playing' || !showSettings || confirmExit) return
      const target = e.target as HTMLElement | null
      // 点面板内部或齿轮按钮都不关
      if (target?.closest?.('.settings, .settings-toggle, .menu-settings')) return
      mouseRef.current?.consumeSwing()
      setShowSettings(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onPointerDown)
    }
  }, [showSettings, confirmExit, hud.gameOver, screen, backToMenu, leaveSettingsPage, restartGame, startGame])

  // 音效开关 / 音量实时生效
  useEffect(() => {
    const sound = ensureSound()
    sound.setEnabled(soundOn)
    sound.setVolume(soundVolume)
  }, [soundOn, soundVolume, ensureSound])

  // 按钮点击的轻响（全局挂一次，任何按钮都算数）
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('button')) ensureSound().play('ui')
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [ensureSound])

  // 挥拍阈值 / 击球来源实时生效（速度阈值与垂直位移阈值一起改）
  useEffect(() => {
    ensureDetector().configure({
      threshold: swingThreshold,
      verticalRange: verticalThresholdOf(swingThreshold),
      hand: handOf(swingSource),
    })
  }, [swingThreshold, swingSource, ensureDetector])

  // 球速 / 辅助模式实时生效（不重开一局）
  useEffect(() => {
    const game = gameRef.current
    if (!game) return
    game.options.timeScale = timeScale
    game.options.autoMove = autoMove
    game.options.autoSwing = autoSwing
    game.options.hitJudgment = hitJudgment
    game.options.predictionAssist = predictionAssist
    game.options.softAlign = softAlign
    game.options.softAlignStrength = softAlignStrength
    game.refreshPrediction()
    if (pausedRef.current && rendererRef.current) {
      rendererRef.current.sync(game.state)
      rendererRef.current.render()
    }
  }, [timeScale, autoMove, autoSwing, hitJudgment, predictionAssist, softAlign, softAlignStrength])

  // 显示尺寸实时生效（只动相机，物理完全不受影响）
  useEffect(() => {
    displaySizeRef.current = displaySize
    rendererRef.current?.setDisplaySize(displaySize)
  }, [displaySize])

  // 相机位姿实时生效（只动相机，物理完全不受影响）
  useEffect(() => {
    cameraPoseRef.current = cameraPose
    rendererRef.current?.setCameraPose(cameraPose)
  }, [cameraPose])

  useEffect(() => {
    rendererRef.current?.setEnvironment(environment)
  }, [environment])

  // 记录画布宽高比：窄屏要开大镜头，画面检查也按这个比例算
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => {
      const w = el.clientWidth || 1
      const h = el.clientHeight || 1
      setViewAspect(w / h)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 退出时释放摄像头
  useEffect(() => {
    return () => {
      cameraGenerationRef.current++
      pendingTrackerRef.current?.close()
      pendingTrackerRef.current = null
      trackerRef.current?.close()
      trackerRef.current = null
    }
  }, [])

  // ---------------------------------------------------------------- 渲染 UI

  /**
   * 当前生效的挥拍阈值。
   *
   * 采样点换成肘部兜底时阈值会放宽（肘部动作幅度比手腕小），
   * HUD 上显示的阈值要和实际判定用的那个一致，不然会出现"明明超线了却没挥出去"。
   */
  const effSwingThreshold =
    hud.armSource === 'elbow' ? swingThreshold * PLAYER.elbowThresholdRatio : swingThreshold
  const effVertThreshold = effSwingThreshold * PLAYER.swingVerticalRatio

  /**
   * 画面检查：当前位姿 + 显示尺寸下，球拍和对手还在不在画面里。
   *
   * 相机是手动调的，可能把画面调歪（球拍出画、对手出画），
   * 所以在设置面板里实时把结果显示出来，而不是让玩家自己猜"球呢？"
   */
  const frameCheck = useMemo(
    () => checkFrame(viewAspect, displaySize, cameraPose),
    [viewAspect, displaySize, cameraPose],
  )

  /**
   * 诊断结论分三种：
   *   - 一切正常；
   *   - 相机没事，是「显示尺寸」的裁剪把东西裁掉了（放大到 3 倍时必然如此）；
   *   - 相机本身把东西挤出画面了（要往回调）。
   */
  const frameStatus = frameCheck.ok
    ? { text: '一切正常', cls: 'good' }
    : frameCheck.cameraOk
      ? { text: '被显示尺寸裁掉了', cls: 'warn' }
      : { text: '相机出画了', cls: 'bad' }

  const exitScore = gameRef.current?.state.score ?? hud.score

  /** 相机滑块的定义（范围来自 CAMERA_LIMITS） */
  const cameraSliders: {
    key: keyof CameraPose
    label: string
    unit: string
    digits: number
  }[] = [
    { key: 'x', label: '相机左右', unit: 'm', digits: 2 },
    { key: 'y', label: '相机高度', unit: 'm', digits: 2 },
    { key: 'z', label: '相机远近', unit: 'm', digits: 2 },
    { key: 'angle', label: '相机俯角', unit: '°', digits: 1 },
  ]

  /**
   * 体感模式的专属选项（设置面板和主菜单共用一份）。
   *
   * 一个「挥拍手」分段控件决定体感模式下**怎么击球**：
   * 左手 / 右手 / 双手 = 用手腕挥拍（惯用左手就选左手）；
   * 鼠标左键 = 走位仍然跟着身体，击球改用鼠标左键。
   */
  const poseOptions = (
    <>
      <div className="setting">
        <div className="setting-label">
          <span>挥拍手</span>
        </div>
        <div className="seg">
          {(
            [
              ['left', '左手'],
              ['right', '右手'],
              ['both', '双手'],
              ['mouse', '鼠标左键'],
            ] as [SwingSource, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              className={swingSource === value ? 'active' : ''}
              onClick={() => setSwingSource(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="setting-hint">
          惯用左手就选左手：只有选中的那只手挥动才算击球。选"双手"时哪只手动得更厉害就用哪只。
          选"鼠标左键"时走位仍然跟着身体，但挥拍改用鼠标左键点击（不用挥手腕）。
        </div>
      </div>
    </>
  )

  const prompt = (() => {
    if (hud.message) {
      return {
        main: hud.message,
        sub: '',
        cls: `prompt point ${hud.messageKind === 'bad' ? 'lost' : ''}`,
      }
    }
    if (hud.phase === 'gameover') {
      return { main: '本局结束', sub: '在右上角设置里可以重新开始', cls: 'prompt' }
    }
    if (rules === 'standard' && hud.phase === 'serve') {
      if (hud.server === 'player' && hud.serveStage === 'waiting') {
        return {
          main: '轮到你发球',
          sub: autoSwing ? '移动球拍选择发球位置，即将自动发球' : '移动球拍选择发球位置，然后挥拍',
          cls: 'prompt',
        }
      }
      return { main: hud.server === 'player' ? '我方发球' : '对手发球', sub: '发球先落发球方，再落接球方', cls: 'prompt' }
    }
    if (hud.shouldSwing) {
      return { main: '挥 拍 !', sub: '球已过网并在你这边落台，现在出手', cls: 'prompt' }
    }
    if (hud.timeToPaddle !== null && hud.timeToPaddle < 0.55) {
      return { main: '准备…', sub: '球正在飞来', cls: 'prompt' }
    }
    return null
  })()

  const cameraErrorNotice = inputMode !== 'pose' && hud.cameraState === 'error' && hud.cameraError && (
    <div className="status-error" role="alert">
      摄像头初始化失败：{hud.cameraError}。当前使用{inputMode === 'keyboard' ? '键盘' : '鼠标'}模式，可在设置中调整。
      <button className="mini-btn" onClick={() => setHud((h) => ({ ...h, cameraError: null }))}>
        关闭提示
      </button>
    </div>
  )

  return (
    <div className={`app ${screen !== 'playing' && environment === 'bright' ? 'menu-bright' : ''}`}>
      <div className="canvas-host" ref={containerRef} />

      {screen === 'settings' && (
        <main className="settings-page">
          <header className="settings-page-header">
            <button className="ghost-btn" onClick={leaveSettingsPage}>返回首页</button>
            <h1>游戏设置</h1>
            <button className="start-btn" onClick={startGame} disabled={booting}>
              {booting ? '正在准备…' : '开始游戏'}
            </button>
          </header>
          <section className="settings-preview-area" aria-label="预览和设置状态">
            <div className="settings-preview-heading">
              <h2>画面预览</h2>
              <p>场馆、显示尺寸和相机位姿实时生效。预览比例与当前屏幕一致。</p>
            </div>
            <SettingsPreview
              environment={environment}
              displaySize={displaySize}
              cameraPose={cameraPose}
              aspect={viewAspect}
            />
            <div className="settings-preview-summary" aria-live="polite">
              <span>{inputMode === 'pose' ? '体感' : inputMode === 'mouse' ? '鼠标' : '键盘'}操作</span>
              <span>对手：{difficulty === 'easy' ? '简单' : difficulty === 'normal' ? '普通' : '困难'}</span>
              <span>球速：{timeScale.toFixed(2)}x</span>
              <span>击球判定：{HIT_JUDGMENT_LABELS[hitJudgment]}</span>
              <span>辅助预测：{predictionAssist ? '开' : '关'}</span>
              <span>软吸附：{softAlign ? autoMove ? '自动跟球优先' : `${Math.round(softAlignStrength * 100)}%` : '关'}</span>
              <span>音效：{soundOn ? `${Math.round(soundVolume * 100)}%` : '关闭'}</span>
              <p>静态预览不模拟对局；操作、球速和辅助效果需开始游戏体验。</p>
              {inputMode === 'pose' && <p>摄像头：{hud.cameraState === 'ready' ? '已就绪' : hud.cameraState === 'loading' ? '正在准备' : '未就绪'}</p>}
              {bootError && <p className="start-error" role="alert">{bootError}</p>}
              {booting && <LoadProgressBar progress={loadProgress} />}
            </div>
          </section>
        </main>
      )}

      <div className="hud">
        {screen === 'playing' && (
          <>
          <div className="scoreboard glass">
            <div className="score-side player">
              <span className="score-label">你</span>
              {/* key 变了元素就会重新挂载，CSS 动画自动重播 */}
              <span
                key={`p${scoreBump.player}`}
                className={`score-value ${scoreBump.player ? 'bump' : ''}`}
              >
                {hud.score.player}
              </span>
            </div>
            <span className="score-sep">:</span>
            <div className="score-side opponent">
              <span className="score-label">对手</span>
              <span
                key={`o${scoreBump.opponent}`}
                className={`score-value ${scoreBump.opponent ? 'bump' : ''}`}
              >
                {hud.score.opponent}
              </span>
            </div>
          </div>

          <div className="status-panel glass">
            <div className="status-head">
              <span>
                <i className={`dot ${hud.cameraState === 'ready' ? 'ok' : 'warn'}`} />
                {inputMode === 'pose'
                  ? hud.cameraState === 'ready'
                    ? '体感已就绪'
                    : '体感未就绪'
                  : inputMode === 'mouse'
                    ? '鼠标模式'
                    : '键盘模式'}
                <b className="status-fps">{hud.fps} fps</b>
              </span>
              <button
                className={`collapse-btn ${showStatus ? '' : 'collapsed'}`}
                onClick={() => setShowStatus((v) => !v)}
                aria-expanded={showStatus}
                title={showStatus ? '收起详情' : '展开详情'}
              >
                <span className="chev">▾</span>
                详情
              </button>
            </div>

            {!showSettings && cameraErrorNotice}

            {showStatus && (
              <div className="status-body">
                {inputMode === 'pose' && (
                  <>
                    <div className="status-row">
                      <span>体感识别人</span>
                      <b>{hud.hasPerson ? '是' : '否'}</b>
                    </div>
                    <div className="status-row">
                      <span>身体位置</span>
                      <b>{hud.bodyPos.toFixed(2)}</b>
                    </div>
                    <div className="status-row">
                      <span>挥拍手</span>
                      <b>
                        {swingSource === 'left'
                          ? '左手'
                          : swingSource === 'right'
                            ? '右手'
                            : swingSource === 'mouse'
                              ? '鼠标左键'
                              : '双手'}
                      </b>
                    </div>
                    <div className="status-row">
                      <span>采样点</span>
                      <b className={hud.armSeen || isMouseSwing(swingSource) ? '' : 'bad'}>
                        {isMouseSwing(swingSource)
                          ? '鼠标左键'
                          : hud.armSource === 'wrist'
                            ? '手腕'
                            : hud.armSource === 'elbow'
                              ? '肘部（兜底）'
                              : '无'}
                      </b>
                    </div>
                    <div className="status-row">
                      <span>挥拍速度</span>
                      <b className={hud.swingSpeed >= effSwingThreshold ? 'hot' : ''}>
                        {hud.swingSpeed.toFixed(2)} / {effSwingThreshold.toFixed(2)}
                      </b>
                    </div>
                    <div className="status-row">
                      <span>垂直位移</span>
                      <b className={hud.swingVert >= effVertThreshold ? 'hot' : ''}>
                        {hud.swingVert.toFixed(3)} / {effVertThreshold.toFixed(3)}
                      </b>
                    </div>
                    <div className="status-note">
                      {isMouseSwing(swingSource) ? (
                        <>
                          现在用鼠标左键击球：球拍位置 = 你在画面里的位置（零点 = 画面正中）。
                          下面的手腕数值只是参考，不参与判定。
                        </>
                      ) : (
                        <>
                          速度或垂直位移超线即算挥拍（单位：肩宽，手腕每帧的移动量）。
                          球拍位置 = 你在画面里的位置（零点 = 画面正中）。
                          手腕没识别到时会自动改用肘部，阈值相应放宽。
                        </>
                      )}
                    </div>
                    {hud.cameraError && (
                      <div className="status-error">{hud.cameraError}</div>
                    )}
                    {hud.cameraState === 'loading' && (
                      <LoadProgressBar progress={loadProgress} compact />
                    )}
                  </>
                )}
                <div className="status-row">
                  <span>时间倍率</span>
                  <b>{hud.timeScale.toFixed(2)}x</b>
                </div>
                <div className="status-row">
                  <span>目标分数</span>
                  <b>{TARGET_SCORE} 分</b>
                </div>
              </div>
            )}
          </div>

          {prompt && (
            <div className={prompt.cls}>
              <div className="prompt-main">{prompt.main}</div>
              {prompt.sub && <div className="prompt-sub">{prompt.sub}</div>}
            </div>
          )}

          <div className={`camera-preview ${inputMode !== 'pose' ? 'compact' : ''}`}>
            <div ref={previewRef} style={{ position: 'absolute', inset: 0 }} />
            <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0 }} />
            {inputMode !== 'pose' && (
              <div className="placeholder">切换到「体感」模式后，这里显示摄像头画面与骨架</div>
            )}
            <div className="camera-caption">
              {inputMode === 'pose'
                ? '虚线框=人体识别范围，橙色=手腕。挥拍看的是手腕的相对位移'
                : '体感模式可在这里看到摄像头画面与人体辅助框'}
            </div>
          </div>

          <div className={`hints glass ${inputMode === 'pose' ? 'pose-hints' : ''}`}>
            {inputMode === 'pose' ? (
              <>左右移动身体调整球拍 · 上下快速挥动手腕击球</>
            ) : inputMode === 'mouse' ? (
              <>移动鼠标调整球拍 · 点击左键挥拍</>
            ) : (
              <>
                <kbd>←</kbd>
                <kbd>→</kbd> 左右 · <kbd>空格</kbd> 挥拍
              </>
            )}
          </div>
          </>
        )}

          {screen === 'playing' && (
            <button
              ref={settingsBtnRef}
              className={`settings-toggle ${showSettings ? 'active' : ''}`}
              onClick={() => setShowSettings((v) => !v)}
              aria-label="设置"
              aria-expanded={showSettings}
              title="设置（Esc 关闭）"
            >
              ⚙ 设置
            </button>
          )}

          {(showSettings || screen === 'settings') && (
            <div
              className={`settings glass ${screen === 'settings' ? 'settings-page-panel' : ''}`}
              role={screen === 'playing' ? 'dialog' : 'region'}
              aria-label="设置"
            >
              <div className="settings-header">
                <h3>{screen === 'playing' ? '设置 · 比赛已暂停' : '调整设置'}</h3>
                {screen === 'playing' && <button
                  className="mini-btn"
                  onClick={() => {
                    setShowSettings(false)
                    settingsBtnRef.current?.focus()
                  }}
                >
                  关闭设置
                </button>}
              </div>
              {screen === 'playing' && cameraErrorNotice}
              {screen === 'playing' && (
                <button className="ghost-btn settings-home" onClick={() => setConfirmExit(true)}>
                  返回首页
                </button>
              )}

              <div className="setting-group">
                <div className="setting-group-title">操作</div>

                <div className="setting">
                  <div className="setting-label"><span>对局规则</span></div>
                  <div className="seg">
                    {([['casual', '休闲'], ['standard', '标准']] as const).map(([value, label]) => (
                      <button key={value} className={rules === value ? 'active' : ''}
                        aria-pressed={rules === value} disabled={screen === 'playing'}
                        onClick={() => setRules(value)}>{label}</button>
                    ))}
                  </div>
                  <div className="setting-hint">休闲保持原有对手开球；标准双方换发，平分后需领先两分。对局中不能更换规则。</div>
                </div>

                <div className="setting">
                  <div className="setting-label">
                    <span>操作方式</span>
                  </div>
                  <div className="seg">
                    <button
                      className={inputMode === 'pose' ? 'active' : ''}
                      aria-pressed={inputMode === 'pose'}
                      onClick={() => switchInputMode('pose')}
                    >
                      体感
                    </button>
                    <button
                      className={inputMode === 'mouse' ? 'active' : ''}
                      aria-pressed={inputMode === 'mouse'}
                      onClick={() => switchInputMode('mouse')}
                    >
                      鼠标
                    </button>
                    <button
                      className={inputMode === 'keyboard' ? 'active' : ''}
                      aria-pressed={inputMode === 'keyboard'}
                      onClick={() => switchInputMode('keyboard')}
                    >
                      键盘
                    </button>
                  </div>
                </div>

                {inputMode === 'pose' && (
                  <>
                    <label className="setting switch">
                      <span>人体辅助框</span>
                      <input
                        type="checkbox"
                        checked={showPoseOverlay}
                        onChange={(e) => setShowPoseOverlay(e.target.checked)}
                      />
                    </label>
                    {poseOptions}
                  </>
                )}

                <div className="setting">
                  <div className="setting-label">
                    <span>对手强度</span>
                  </div>
                  <div className="seg">
                    {(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => (
                      <button
                        key={d}
                        className={difficulty === d ? 'active' : ''}
                        aria-pressed={difficulty === d}
                        onClick={() => setDifficulty(d)}
                      >
                        {d === 'easy' ? '简单' : d === 'normal' ? '普通' : '困难'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-group-title">手感</div>

                <div className="setting">
                  <div className="setting-label">
                    <span>挥拍灵敏度</span>
                    <b>{swingThreshold.toFixed(2)}</b>
                  </div>
                  <Slider
                    min={0.8}
                    max={8}
                    step={0.1}
                    value={swingThreshold}
                    defaultValue={PLAYER.swingThreshold}
                    onChange={setSwingThreshold}
                  />
                  <div className="setting-hint">
                    数值越小越容易挥拍。速度阈值 {swingThreshold.toFixed(2)} 肩宽/秒，
                    垂直位移阈值 {verticalThresholdOf(swingThreshold).toFixed(2)} 肩宽。
                    一直挥不出来就调到 1.5 以下。
                  </div>
                </div>

                <div className="setting">
                  <div className="setting-label">
                    <span>球速</span>
                    <b>{timeScale.toFixed(2)}x</b>
                  </div>
                  <Slider
                    min={0.3}
                    max={1.2}
                    step={0.05}
                    value={timeScale}
                    defaultValue={
                      inputMode === 'pose' ? POSE_DEFAULT_TIME_SCALE : NORMAL_DEFAULT_TIME_SCALE
                    }
                    onChange={(v) => {
                      speedTouchedRef.current = true
                      setTimeScale(v)
                    }}
                  />
                  <div className="setting-hint">
                    相当于慢动作：弹道不变，只是整个比赛变慢，给你更多反应时间。
                    0.5 就是两倍慢动作，1.2 是两成快节奏。体感模式建议 0.8 左右。
                  </div>
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-group-title">画面</div>

                <div className="setting">
                  <div className="setting-label"><span>场馆环境</span></div>
                  <div className="seg">
                    <button className={environment === 'bright' ? 'active' : ''} aria-pressed={environment === 'bright'} onClick={() => setEnvironment('bright')}>明亮球室</button>
                    <button className={environment === 'night' ? 'active' : ''} aria-pressed={environment === 'night'} onClick={() => setEnvironment('night')}>夜间球场</button>
                  </div>
                </div>

                <div className="setting">
                  <div className="setting-label">
                    <span>球台显示尺寸</span>
                    <b>{displaySize.toFixed(2)}x</b>
                  </div>
                  <Slider
                    min={VIEW.minDisplaySize}
                    max={VIEW.maxDisplaySize}
                    step={0.05}
                    value={displaySize}
                    defaultValue={1}
                    onChange={setDisplaySize}
                  />
                  <div className="setting-hint">
                    相机不动、透视不变，只是把画面裁一块出来重新铺满屏幕。
                    1.0 是原样：往上调画面放大（球台、球、球拍一起变大，裁掉的是上方空背景），
                    往下调画面缩小、露出更多场景。放到 3.0 就只剩我方这半张台面了。
                  </div>
                </div>

                <div className="setting">
                  <div className="setting-label">
                    <span>相机位姿</span>
                    <button
                      className="mini-btn"
                      onClick={() => setCameraPose({ ...DEFAULT_CAMERA })}
                      title="恢复最初的取景"
                    >
                      恢复默认
                    </button>
                  </div>
                  {cameraSliders.map((row) => {
                    const limit = CAMERA_LIMITS[row.key]
                    return (
                      <div key={row.key} className="camera-slider">
                        <div className="setting-label">
                          <span>{row.label}</span>
                          <b>
                            {cameraPose[row.key].toFixed(row.digits)}
                            {row.unit}
                          </b>
                        </div>
                        <Slider
                          min={limit.min}
                          max={limit.max}
                          step={limit.step}
                          value={cameraPose[row.key]}
                          defaultValue={DEFAULT_CAMERA[row.key]}
                          onChange={(v) => setCameraPose({ ...cameraPose, [row.key]: v })}
                        />
                      </div>
                    )
                  })}
                  <div className="setting-hint">
                    相机位置和俯角可以手动调（范围有限，不会跑飞）。
                    左右是横向平移，俯角决定往下看多少度——这两条和「球台显示尺寸」
                    完全独立：调显示尺寸永远只是裁剪放大，不会把视角变成俯视。
                  </div>
                </div>

                <div className="setting">
                  <div className="setting-label">
                    <span>画面检查</span>
                    <b className={frameStatus.cls}>{frameStatus.text}</b>
                  </div>
                  <div className="setting-hint">
                    球拍横向 {frameCheck.paddleX.toFixed(2)}（≤1 在画面内）·
                    球拍纵向 {frameCheck.paddleCenter.toFixed(2)}（
                    {frameCheck.paddleBottom.toFixed(2)} ~ {frameCheck.paddleTop.toFixed(2)}）·
                    对手头顶 {frameCheck.opponentHead.toFixed(2)}
                    {!frameCheck.paddleOk &&
                      (frameCheck.cameraOk
                        ? ' —— 球拍被放大裁掉了。'
                        : ' —— 球拍出画了，往回调一点。')}
                    {!frameCheck.opponentOk &&
                      (frameCheck.cameraOk
                        ? ' —— 对手被放大裁掉了。'
                        : ' —— 对手出画了，往回调一点。')}
                  </div>
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-group-title">辅助</div>

                <div className="setting">
                  <div className="setting-label">
                    <span>击球判定</span>
                    <b>{HIT_JUDGMENT_LABELS[hitJudgment]}</b>
                  </div>
                  <div className="seg" role="group" aria-label="击球判定">
                    {HIT_JUDGMENT_LEVELS.map((level) => (
                      <button
                        key={level}
                        className={hitJudgment === level ? 'active' : ''}
                        aria-pressed={hitJudgment === level}
                        onClick={() => setHitJudgment(level)}
                      >
                        {HIT_JUDGMENT_LABELS[level]}
                      </button>
                    ))}
                  </div>
                  <div className="setting-hint">
                    挥拍有效期 {HIT_JUDGMENT_PRESETS[hitJudgment].swingTime.toFixed(2)} 秒模拟时间 ·
                    拍面偏差 {(HIT_JUDGMENT_PRESETS[hitJudgment].bladeReach * 100).toFixed(0)}cm ·
                    前后距离 {PADDLE.swingDepth * 100}cm。标准档为原有辅助效果；
                    只对落台后飞向球拍的来球生效。仍需自己走位和挥拍；修改从下次挥拍起生效。
                  </div>
                </div>

                <label className="setting switch">
                  <span>辅助预测</span>
                  <input
                    type="checkbox"
                    checked={predictionAssist}
                    onChange={(e) => setPredictionAssist(e.target.checked)}
                  />
                </label>
                <div className="setting-hint">
                  对手击球后，球拍上方的青色圆环标示预测横向位置；只显示提示，不移动球拍。
                </div>

                <label className="setting switch">
                  <span>软吸附</span>
                  <input
                    type="checkbox"
                    checked={softAlign}
                    onChange={(e) => setSoftAlign(e.target.checked)}
                  />
                </label>
                <div className="setting-hint">
                  接近预测位置时轻微引导，落台后逐渐加强。仍需自己移动和挥拍；辅助移动开启时优先自动跟球。
                </div>
                <div className="setting">
                  <div className="setting-label">
                    <span>软吸附强度</span>
                    <b>{Math.round(softAlignStrength * 100)}%</b>
                  </div>
                  <Slider
                    min={0}
                    max={1}
                    step={0.1}
                    value={softAlignStrength}
                    defaultValue={0.6}
                    ariaLabel="软吸附强度"
                    onChange={setSoftAlignStrength}
                  />
                  <div className="setting-hint">开启软吸附后生效；0% 不产生引导。</div>
                </div>

                <label className="setting switch">
                  <span>辅助移动</span>
                  <input
                    type="checkbox"
                    checked={autoMove}
                    onChange={(e) => setAutoMove(e.target.checked)}
                  />
                </label>
                <div className="setting-hint">球拍自动跟着球走，你只管挥拍。</div>

                <label className="setting switch">
                  <span>辅助击球</span>
                  <input
                    type="checkbox"
                    checked={autoSwing}
                    onChange={(e) => setAutoSwing(e.target.checked)}
                  />
                </label>
                <div className="setting-hint">球进到拍区自动挥拍，你只管走位。</div>

                <label className="setting switch">
                  <span>慢动作辅助</span>
                  <input
                    type="checkbox"
                    checked={slowMotion}
                    onChange={(e) => setSlowMotion(e.target.checked)}
                  />
                </label>
              </div>

              <div className="setting-group">
                <div className="setting-group-title">声音</div>

                <label className="setting switch">
                  <span>音效</span>
                  <input
                    type="checkbox"
                    checked={soundOn}
                    onChange={(e) => setSoundOn(e.target.checked)}
                  />
                </label>
                <div className="setting-hint">击球、落台、触网、得分的声音都是实时合成的。</div>

                <div className="setting">
                  <div className="setting-label">
                    <span>音量</span>
                    <b>{Math.round(soundVolume * 100)}%</b>
                  </div>
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    value={soundVolume}
                    defaultValue={0.65}
                    onChange={setSoundVolume}
                  />
                </div>
              </div>

              {screen === 'playing' && (
                <button
                  className="start-btn"
                  style={{ width: '100%', marginTop: 6, padding: '10px 0', fontSize: 14 }}
                  onClick={() => {
                    restartGame()
                    setShowSettings(false)
                  }}
                >
                  重新开始
                </button>
              )}
            </div>
          )}

          <dialog
            ref={exitDialogRef}
            className="exit-dialog"
            aria-labelledby="exit-title"
            aria-describedby="exit-description"
            onCancel={(event) => {
              event.preventDefault()
              exitDialogRef.current?.close()
              setConfirmExit(false)
              setShowSettings(false)
              settingsBtnRef.current?.focus()
            }}
          >
            <h2 id="exit-title">返回首页？</h2>
            <p id="exit-description">当前比分 {exitScore.player} : {exitScore.opponent}，返回后本局进度将丢失。</p>
            <div className="exit-actions">
              <button
                className="ghost-btn"
                autoFocus
                onClick={() => {
                  exitDialogRef.current?.close()
                  setConfirmExit(false)
                  setShowSettings(false)
                  settingsBtnRef.current?.focus()
                }}
              >
                继续比赛
              </button>
              <button className="start-btn" onClick={backToMenu}>确认返回</button>
            </div>
          </dialog>

          {hud.gameOver && (
            <div className="gameover">
              <div className="gameover-card">
                <div
                  className={`gameover-title ${
                    hud.gameOver.winner === 'player' ? 'win' : 'lose'
                  }`}
                >
                  {hud.gameOver.winner === 'player' ? '你赢了！' : '你输了'}
                </div>
                <div className="gameover-score">
                  <span className="player">{hud.gameOver.player}</span>
                  <span className="sep">:</span>
                  <span className="opponent">{hud.gameOver.opponent}</span>
                </div>
                <div className="gameover-hint">
                  {hud.gameOver.winner === 'player' ? '打得不错' : '再来一局？'}
                </div>
                {inputMode === 'pose' && (
                  <div className="gameover-hint" aria-live="polite">
                    先放下双手，再举左手重开或举右手返回首页，保持 1.8 秒
                    {resultGesture.action && ` · ${resultGesture.action === 'restart' ? '重开' : '返回'} ${resultGesture.progress}%`}
                  </div>
                )}
                <button className="start-btn" ref={restartBtnRef} onClick={restartGame}>
                  再来一局 <kbd>Enter</kbd>
                </button>
                <button className="ghost-btn" onClick={backToMenu}>
                  返回主菜单 <kbd>Esc</kbd>
                </button>
              </div>
            </div>
          )}
          {cameraFault && inputMode === 'pose' && (
            <div className="gameover camera-fault" role="alertdialog" aria-modal="true" aria-labelledby="camera-fault-title">
              <div className="gameover-card">
                <h2 id="camera-fault-title">体感中断，比赛已暂停</h2>
                <p>{cameraFault}</p>
                <button ref={retryCameraBtnRef} className="start-btn" onClick={() => void retryCamera()} disabled={booting}>
                  {booting ? '正在重新连接…' : '重新连接摄像头'}
                </button>
                <button className="ghost-btn" onClick={() => switchInputMode('keyboard')}>切换到键盘并继续</button>
                <button className="ghost-btn" onClick={backToMenu}>返回首页</button>
              </div>
            </div>
          )}
      </div>

      {screen === 'menu' && (
        <div className="start-overlay">
          <div className="menu-card">
            <h1 className="start-title">
              PingPong 3D
              <small>体感乒乓球</small>
            </h1>
            <p className="start-sub">
              摄像头捕捉你的身体：左右移动调整球拍位置，
              球落到你这边台面后快速挥动手腕完成击球。
            </p>

            <div className="mode-grid">
              <button
                className={`mode-card ${inputMode === 'pose' ? 'active' : ''}`}
                onClick={() => switchInputMode('pose')}
                aria-pressed={inputMode === 'pose'}
              >
                <span className="mode-icon">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="6" width="13" height="10" rx="2.5" />
                    <path d="M15 10.5 21.5 7v8L15 11.5z" />
                  </svg>
                </span>
                <span className="mode-name">体感</span>
                <span className="mode-desc">摄像头捕捉 · 挥腕击球</span>
              </button>

              <button
                className={`mode-card ${inputMode === 'mouse' ? 'active' : ''}`}
                onClick={() => switchInputMode('mouse')}
                aria-pressed={inputMode === 'mouse'}
              >
                <span className="mode-icon">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="7" y="2.5" width="10" height="19" rx="5" />
                    <path d="M12 7v3.5" />
                  </svg>
                </span>
                <span className="mode-name">鼠标</span>
                <span className="mode-desc">移动鼠标走位 · 左键挥拍</span>
              </button>

              <button
                className={`mode-card ${inputMode === 'keyboard' ? 'active' : ''}`}
                onClick={() => switchInputMode('keyboard')}
                aria-pressed={inputMode === 'keyboard'}
              >
                <span className="mode-icon">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="1.5" y="6" width="21" height="12" rx="2.5" />
                    <path d="M5.5 10h.01M9 10h.01M12.5 10h.01M16 10h.01M19.5 10h.01M8 14h8" />
                  </svg>
                </span>
                <span className="mode-name">键盘</span>
                <span className="mode-desc">← → 移动 · 空格挥拍</span>
              </button>
            </div>

            {inputMode === 'pose' && <div className="menu-options">{poseOptions}</div>}

            <div className="setting">
              <div className="setting-label"><span>对局规则</span></div>
              <div className="seg">
                {([['casual', '休闲'], ['standard', '标准']] as const).map(([value, label]) => (
                  <button key={value} className={rules === value ? 'active' : ''}
                    aria-pressed={rules === value} onClick={() => setRules(value)}>{label}</button>
                ))}
              </div>
              <div className="setting-hint">{rules === 'casual' ? '对手开球，先到 11 分获胜' : '双方轮流发球，平分后领先两分获胜'}</div>
            </div>

            <div className="flow">
              <span className="flow-step">{rules === 'casual' ? '对手发球' : '双方轮流发球'}</span>
              <span className="flow-arrow">→</span>
              <span className="flow-step">{rules === 'casual' ? '对方区弹一次' : '发球方落台'}</span>
              <span className="flow-arrow">→</span>
              <span className="flow-step">{rules === 'casual' ? '我方区弹一次' : '接球方落台'}</span>
              <span className="flow-arrow">→</span>
              <span className="flow-step">{rules === 'casual' ? '你挥拍回击' : '接球方回击'}</span>
            </div>

            {bootError && <div className="start-error">{bootError}</div>}

            {booting && <LoadProgressBar progress={loadProgress} />}

            <button className="start-btn" onClick={startGame} disabled={booting}>
              {booting ? '正在准备游戏…' : '开始游戏'}
            </button>

            <button
              ref={settingsBtnRef}
              className="ghost-btn menu-settings"
              onClick={() => setScreen('settings')}
              disabled={booting}
            >
              ⚙ 游戏设置
            </button>

            <p className="start-footnote">
              体感模式首次启动需要从 CDN 下载 MediaPipe 的 wasm 与姿态模型（约 10MB），请保持联网。
              没有摄像头也能玩：鼠标或键盘模式不需要任何权限。
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

function formatLoadLabel(progress: PoseLoadProgress | null): { label: string; detail: string } {
  if (!progress) return { label: '正在准备姿态识别…', detail: '' }
  switch (progress.stage) {
    case 'wasm':
      return { label: '1/4 加载运行时…', detail: '' }
    case 'model': {
      const pct = progress.ratio !== null ? `${Math.round(progress.ratio * 100)}%` : ''
      const size =
        progress.loadedBytes !== undefined && progress.totalBytes !== undefined
          ? `${formatMb(progress.loadedBytes)} / ${formatMb(progress.totalBytes)} MB`
          : progress.loadedBytes !== undefined
            ? `${formatMb(progress.loadedBytes)} MB`
            : ''
      return {
        label: `2/4 下载姿态模型${pct ? ` ${pct}` : '…'}`,
        detail: size,
      }
    }
    case 'engine':
      return { label: '3/4 初始化识别引擎…', detail: '' }
    case 'camera':
      return { label: '4/4 等待摄像头授权…', detail: '' }
  }
}

function LoadProgressBar({
  progress,
  compact = false,
}: {
  progress: PoseLoadProgress | null
  compact?: boolean
}) {
  const { label, detail } = formatLoadLabel(progress)
  const determinate = progress?.stage === 'model' && progress.ratio !== null
  const percent = determinate ? Math.round((progress.ratio ?? 0) * 100) : 0

  return (
    <div className={`load-progress${compact ? ' compact' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={determinate ? percent : undefined}>
      <div className="load-progress-text">
        <span>{label}</span>
        {detail && <span>{detail}</span>}
      </div>
      <div className="load-progress-track">
        <div
          className={`load-progress-fill${determinate ? '' : ' indeterminate'}`}
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  )
}
