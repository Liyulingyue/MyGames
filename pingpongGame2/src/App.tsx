import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PingPongGame } from './core/game.ts'
import { AI_PRESETS, PLAYER, RAGE, TARGET_SCORE } from './core/constants.ts'
import type { Phase, Side } from './core/types.ts'
import { GameRenderer } from './render/renderer.ts'
import { CAMERA_LIMITS, DEFAULT_CAMERA, VIEW, checkFrame, type CameraPose } from './render/view.ts'
import { PoseTracker, isVisible, handsRaised } from './input/poseTracker.ts'
import type { MotionSource, PoseFrame } from './input/poseTracker.ts'
import { SwingDetector, paddleTargetFromPose, pickArmSample, handOf, isMouseSwing } from './input/swingDetector.ts'
import type { SwingSource } from './input/swingDetector.ts'
import { KeyboardController } from './input/keyboard.ts'
import { MouseController } from './input/mouse.ts'
import { SoundEngine } from './input/sound.ts'

type InputMode = 'keyboard' | 'pose' | 'mouse'
type Difficulty = 'easy' | 'normal' | 'hard'
type Screen = 'menu' | 'playing'

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
 * 体感爆气手势的保持时长（秒）。
 *
 * 双手举过头顶后需要保持这段时间才触发：举手瞬间（比如伸懒腰、
 * 挥拍随挥）不算，避免误触。怒气条上会实时显示充能进度。
 */
const SMASH_GESTURE_HOLD = 0.6

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
  /** 本回合的对拉次数（回合越长越精彩） */
  rallyHits: number
  /** 爆气怒气值 0~RAGE.max */
  rage: number
  /** 是否处于爆气武装状态（下一次命中即扣杀） */
  smashArmed: boolean
  /** 体感爆气手势的充能进度 0~1（双手举过头顶保持中） */
  smashCharge: number
  /** 本局结束时的结果与统计 */
  gameOver: {
    winner: Side
    player: number
    opponent: number
    /** 本局最长的一次对拉（拍数） */
    longestRally: number
    /** 玩家本局总击球数 */
    playerHits: number
  } | null
}

const INITIAL_HUD: HudState = {
  score: { player: 0, opponent: 0 },
  phase: 'idle',
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
  rallyHits: 0,
  rage: 0,
  smashArmed: false,
  smashCharge: 0,
  gameOver: null,
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('menu')
  const [inputMode, setInputMode] = useState<InputMode>('keyboard')
  const [difficulty, setDifficulty] = useState<Difficulty>('normal')
  /** 一局先到多少分获胜（开始界面可选） */
  const [targetScore, setTargetScore] = useState<number>(TARGET_SCORE)
  const [swingThreshold, setSwingThreshold] = useState<number>(PLAYER.swingThreshold)
  const [slowMotion, setSlowMotion] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [showPoseOverlay, setShowPoseOverlay] = useState(true)
  /**
   * 左上角状态面板是否展开。
   *
   * 默认收起：面板信息偏调试性质，展开时高度很大，
   * 会挡住滑步到画面左侧的对手人形；需要看体感数值时点标题栏展开。
   * 摄像头出错 / 加载中时会自动展开，保证看得到原因。
   */
  const [statusOpen, setStatusOpen] = useState(false)
  const [timeScale, setTimeScale] = useState<number>(NORMAL_DEFAULT_TIME_SCALE)
  const [autoMove, setAutoMove] = useState(false)
  const [autoSwing, setAutoSwing] = useState(false)
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
  /** 画布宽高比：给"画面检查"诊断用 */
  const [viewAspect, setViewAspect] = useState(VIEW.referenceAspect)
  /** 用户是否手动调过球速：没调过的话，切到体感模式会自动用更慢的球 */
  const speedTouchedRef = useRef(false)
  const [hud, setHud] = useState<HudState>(INITIAL_HUD)
  const [bootError, setBootError] = useState<string | null>(null)
  const [booting, setBooting] = useState(false)
  /** 本局统计：最长对拉 / 玩家总击球数（结算面板展示） */
  const statsRef = useRef({ longestRally: 0, playerHits: 0 })
  /** 连续得分（双方各自），用于连胜文案 */
  const streakRef = useRef({ player: 0, opponent: 0 })
  /**
   * 体感爆气手势状态。
   *
   * hold：双手举过头顶已经保持的秒数；
   * latched：本次举手已经触发过爆气，必须把手放下才能再来一次
   * （防止一次举手在怒气重新攒满的瞬间又误触发）。
   */
  const smashGestureRef = useRef({ hold: 0, latched: false })

  const containerRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const gameRef = useRef<PingPongGame | null>(null)
  const rendererRef = useRef<GameRenderer | null>(null)
  const trackerRef = useRef<PoseTracker | null>(null)
  const detectorRef = useRef<SwingDetector | null>(null)
  const keyboardRef = useRef<KeyboardController | null>(null)
  const mouseRef = useRef<MouseController | null>(null)
  const soundRef = useRef<SoundEngine | null>(null)

  // 放进 ref，主循环里就不用依赖 state 变化而重启
  const inputModeRef = useRef<InputMode>(inputMode)
  const slowMotionRef = useRef(slowMotion)
  const swingThresholdRef = useRef(swingThreshold)
  const difficultyRef = useRef(difficulty)
  const targetScoreRef = useRef(targetScore)
  const showPoseOverlayRef = useRef(showPoseOverlay)
  const timeScaleRef = useRef(timeScale)
  const autoMoveRef = useRef(autoMove)
  const autoSwingRef = useRef(autoSwing)
  const swingSourceRef = useRef(swingSource)
  /** 取景设置：新开一局时新建的渲染器要沿用当前设置 */
  const displaySizeRef = useRef(displaySize)
  const cameraPoseRef = useRef(cameraPose)
  /** 开发调试用：注入的合成姿态帧（null = 用真实摄像头） */
  const devPoseRef = useRef<PoseFrame | null>(null)
  /** setupCamera 定义在 switchInputMode 之后，用 ref 打破循环依赖 */
  const cameraSetupRef = useRef<() => Promise<boolean>>(async () => false)

  inputModeRef.current = inputMode
  slowMotionRef.current = slowMotion
  swingThresholdRef.current = swingThreshold
  difficultyRef.current = difficulty
  targetScoreRef.current = targetScore
  showPoseOverlayRef.current = showPoseOverlay
  timeScaleRef.current = timeScale
  autoMoveRef.current = autoMove
  autoSwingRef.current = autoSwing
  swingSourceRef.current = swingSource

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

  /** 启动摄像头与姿态模型。成功返回 true，失败返回 false（已自动回退到键盘模式） */
  const setupCamera = useCallback(async (): Promise<boolean> => {
    setBooting(true)
    setBootError(null)
    setHud((h) => ({ ...h, cameraState: 'loading', cameraError: null }))
    try {
      const tracker = new PoseTracker()
      await tracker.init()
      const video = await tracker.startCamera()
      trackerRef.current = tracker

      // 把摄像头画面挂到预览容器里
      if (previewRef.current) {
        previewRef.current.appendChild(video)
        video.style.width = '100%'
        video.style.height = '100%'
        video.style.objectFit = 'cover'
        video.style.transform = 'scaleX(-1)'
      }

      setHud((h) => ({ ...h, cameraState: 'ready', cameraError: null }))
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setBootError(`摄像头 / 模型初始化失败：${message}\n已自动切换到键盘模式，可以先开始游戏。`)
      // 游戏中途切到体感模式失败时，错误要显示在 HUD 上（菜单上的提示看不到）
      setHud((h) => ({ ...h, cameraState: 'error', cameraError: message }))
      switchInputMode('keyboard')
      return false
    } finally {
      setBooting(false)
    }
  }, [switchInputMode])

  cameraSetupRef.current = setupCamera

  const startGame = useCallback(async () => {
    // 浏览器规定 AudioContext 必须在用户手势里解锁，否则一直是挂起状态
    ensureSound().unlock()
    if (inputModeRef.current === 'pose' && !trackerRef.current) {
      // 摄像头没起来就留在开始界面并给出提示，避免玩家对着黑屏找不到原因
      const ok = await setupCamera()
      if (!ok) return
    }
    ensureKeyboard()
    ensureDetector()
    setScreen('playing')
  }, [setupCamera, ensureKeyboard, ensureDetector, ensureSound])

  /** 重新开一局（比分清零，球拍回到中间，统计与连胜也一并重置） */
  const restartGame = useCallback(() => {
    const game = gameRef.current
    if (!game) return
    statsRef.current = { longestRally: 0, playerHits: 0 }
    streakRef.current = { player: 0, opponent: 0 }
    game.start()
    setHud((h) => ({
      ...h,
      score: { player: 0, opponent: 0 },
      phase: 'rally',
      message: null,
      messageKind: null,
      gameOver: null,
      rallyHits: 0,
    }))
  }, [])

  /** 结束这一局，回到主菜单 */
  const backToMenu = useCallback(() => {
    setScreen('menu')
    setShowSettings(false)
    setHud(INITIAL_HUD)
  }, [])

  // ---------------------------------------------------------------- 主循环

  useEffect(() => {
    if (screen !== 'playing') return
    const container = containerRef.current
    if (!container) return

    const game = new PingPongGame({
      seed: Math.floor(Math.random() * 1e9),
      ai: difficultyRef.current,
      targetScore: targetScoreRef.current,
      slowMotion: slowMotionRef.current,
      timeScale: timeScaleRef.current,
      autoMove: autoMoveRef.current,
      autoSwing: autoSwingRef.current,
    })
    gameRef.current = game
    game.start()

    const renderer = new GameRenderer(container)
    rendererRef.current = renderer
    // 新渲染器要沿用当前的取景设置（重开一局也不丢）
    renderer.setDisplaySize(displaySizeRef.current)
    renderer.setCameraPose(cameraPoseRef.current)

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
    /** 爆气手势的充能进度 0~1（体感模式、怒气满、双手举高时增长） */
    let smashCharge = 0
    /** 最近一帧姿态数据（真实摄像头或调试注入） */
    let lastFrame: PoseFrame | null = null

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
      last = now

      // ---- 输入 ----
      // 鼠标的目标与挥拍请求每帧都取一次：即使当前不是鼠标模式，
      // 也要把排队的挥拍消费掉，否则切换模式后会莫名其妙挥一下。
      const mouseTarget = mouse.update()
      const mouseSwing = mouse.consumeSwing()

      // 爆气（F 键）：键盘控制器全程挂着，三种输入模式都可用；
      // 怒气不满时 game.armSmash() 会安静地返回 false
      if (ensureKeyboard().consumeSmash()) game.armSmash()

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
        const frame = devPoseRef.current ?? tracker?.detect(now)
        lastFrame = frame ?? null
        if (frame) {
          if (frame.hasPerson) {
            // 绝对映射：人在画面里的位置 → 球拍位置（零点 = 摄像头画面正中）
            const target = paddleTargetFromPose(frame, PLAYER.xRange)
            game.setPlayerTarget(target.x)
          }

          if (isMouseSwing(swingSourceRef.current)) {
            // 体感 + 鼠标击球：走位看身体，击球用鼠标左键
            if (mouseSwing) game.swing(0.75)
          } else {
            // 挥拍检测不依赖身体位置：肩膀没识别到时，手臂照样能挥出信号
            const result = detector.process(frame, now)
            if (result.swung) game.swing(result.power)
          }
        }

        // 爆气手势：双手举过头顶保持 SMASH_GESTURE_HOLD 秒 → 爆气。
        // 体感模式人站在摄像头前，这是比"跑去按 F"科学的触发方式；
        // 触发过一次后必须把手放下才能再来（latched）。
        {
          const gesture = smashGestureRef.current
          if (handsRaised(tracker?.landmarks)) {
            if (!gesture.latched) {
              gesture.hold += dt
              if (game.state.rage >= RAGE.max && gesture.hold >= SMASH_GESTURE_HOLD) {
                game.armSmash()
                gesture.latched = true
              }
            }
          } else {
            gesture.hold = 0
            gesture.latched = false
          }
        }
      } else if (inputModeRef.current === 'mouse') {
        game.setPlayerTarget(mouseTarget.x)
        if (mouseSwing) game.swing(0.75)
      } else {
        const keyboard = ensureKeyboard()
        const target = keyboard.update(dt)
        game.setPlayerTarget(target.x)
        if (keyboard.consumeSwing()) game.swing(0.75)
      }

      // 离开体感模式时清掉手势进度；充能进度只在"体感 + 怒气满 + 未武装"时显示
      if (inputModeRef.current !== 'pose') {
        smashGestureRef.current.hold = 0
        smashGestureRef.current.latched = false
      }
      smashCharge =
        inputModeRef.current === 'pose' &&
        game.state.rage >= RAGE.max &&
        game.state.smashArmed <= 0
          ? Math.min(1, smashGestureRef.current.hold / SMASH_GESTURE_HOLD)
          : 0

      // ---- 推进游戏 ----
      const events = game.step(dt)
      // 发球提示：进入 serve 阶段时响一声
      if (game.state.phase === 'serve' && lastPhase !== 'serve') sound.play('serve')
      lastPhase = game.state.phase
      // 击球的这一帧同时会有 swing 和 paddleHit 两个事件，
      // 这时只播"啪"，不播挥空的风声——否则每次得分都是两声。
      // 扣杀命中的那一帧则只播扣杀重击声，不叠普通击球声。
      const playerHit = events.some((e) => e.type === 'paddleHit' && e.side === 'player')
      const smashHit = events.some((e) => e.type === 'smash')
      for (const ev of events) {
        // 表现层反馈：击球火花、对手情绪动画、扣杀震动
        renderer.notifyEvent(ev)

        switch (ev.type) {
          case 'paddleHit':
            if (!(smashHit && ev.side === 'player')) sound.play('paddle', ev.power ?? 0.7)
            if (ev.side === 'player') statsRef.current.playerHits++
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
          case 'smashArm':
            sound.play('smashArm')
            break
          case 'smash':
            sound.play('smash')
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

        if (ev.type === 'smashArm') {
          setHud((h) => ({
            ...h,
            message: '爆气！下一次命中就是扣杀',
            messageKind: 'good',
          }))
          messageUntil = now + 1200
        } else if (ev.type === 'smash') {
          setHud((h) => ({
            ...h,
            message: '扣 杀 !',
            messageKind: 'good',
          }))
          messageUntil = now + 900
        } else if (ev.type === 'point') {
          // 得分文案按"连胜 + 对拉长度"变化，比单调的得分/失分有代入感
          const won = ev.winner === 'player'
          const rally = game.state.rallyHits
          statsRef.current.longestRally = Math.max(statsRef.current.longestRally, rally)
          let message: string
          if (won) {
            streakRef.current.player++
            streakRef.current.opponent = 0
            if (streakRef.current.player >= 3) {
              message = `势不可挡！连得 ${streakRef.current.player} 分`
            } else if (rally >= 8) {
              message = `神仙对拉 x${rally}，这一分太精彩了！`
            } else if (rally >= 5) {
              message = `精彩回合 x${rally}！`
            } else {
              message = '得分！'
            }
          } else {
            streakRef.current.opponent++
            streakRef.current.player = 0
            if (streakRef.current.opponent >= 3) {
              message = `对手连得 ${streakRef.current.opponent} 分，稳住！`
            } else if (rally >= 8) {
              message = `可惜，缠斗 ${rally} 拍还是丢了`
            } else {
              message = '失分'
            }
          }
          setHud((h) => ({
            ...h,
            message,
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
            gameOver: {
              winner,
              player: score.player,
              opponent: score.opponent,
              longestRally: statsRef.current.longestRally,
              playerHits: statsRef.current.playerHits,
            },
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
        const tracker = trackerRef.current
        const frame = lastFrame ?? tracker?.frame
        // HUD 显示的必须是"实际参与判定"的那条手臂，否则会和手感对不上
        const sample = frame ? pickArmSample(frame, handOf(swingSourceRef.current)) : null
        setHud((h) => ({
          ...h,
          score: { ...s.score },
          phase: s.phase,
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
          rallyHits: s.rallyHits,
          rage: s.rage,
          smashArmed: s.smashArmed > 0,
          smashCharge,
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
  }, [screen, ensureKeyboard, ensureDetector, ensureMouse, ensureSound])

  // 难度 / 目标分数 / 慢动作实时生效（不重开一局）
  useEffect(() => {
    const game = gameRef.current
    if (!game) return
    game.options.ai = difficulty
    game.options.aiConfig = AI_PRESETS[difficulty]
    game.options.targetScore = targetScore
    game.options.slowMotion = slowMotion
  }, [difficulty, targetScore, slowMotion])

  // 音效开关 / 音量实时生效
  useEffect(() => {
    const sound = ensureSound()
    sound.setEnabled(soundOn)
    sound.setVolume(soundVolume)
  }, [soundOn, soundVolume, ensureSound])

  // 摄像头出错 / 加载中时自动展开状态面板（收起状态看不到错误原因）
  useEffect(() => {
    if (hud.cameraError || hud.cameraState === 'loading') setStatusOpen(true)
  }, [hud.cameraError, hud.cameraState])

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
  }, [timeScale, autoMove, autoSwing])

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

  /**
   * 游戏参数预设（开始界面用，和游戏内 ⚙ 面板共享同一份状态）。
   *
   * 以前这些参数只能开局后在设置里改，开局前完全看不到——
   * 现在难度、目标分数、球速、慢动作都可以在开始界面先定好。
   */
  const difficultyHint =
    difficulty === 'easy'
      ? '新手友好：对手反应慢、走位慢、失误也多，适合先熟悉挥拍。'
      : difficulty === 'hard'
        ? '对手又快又稳，还会专打你的空档，来点挑战。'
        : '标准对打节奏，反应和失误率都比较均衡。'

  const gameOptions = (
    <>
      <div className="setting">
        <div className="setting-label">
          <span>对手强度</span>
        </div>
        <div className="seg">
          {(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => (
            <button
              key={d}
              className={difficulty === d ? 'active' : ''}
              onClick={() => setDifficulty(d)}
            >
              {d === 'easy' ? '简单' : d === 'normal' ? '普通' : '困难'}
            </button>
          ))}
        </div>
        <div className="setting-hint">{difficultyHint}</div>
      </div>

      <div className="setting">
        <div className="setting-label">
          <span>目标分数</span>
        </div>
        <div className="seg">
          {[6, 11, 21].map((score) => (
            <button
              key={score}
              className={targetScore === score ? 'active' : ''}
              onClick={() => setTargetScore(score)}
            >
              {score} 分
            </button>
          ))}
        </div>
        <div className="setting-hint">先到目标分数获胜。6 分适合快节奏热身，11 分是标准局。</div>
      </div>

      <div className="setting">
        <div className="setting-label">
          <span>球速节奏</span>
          <b>{timeScale.toFixed(2)}x</b>
        </div>
        <input
          type="range"
          min={0.3}
          max={1.2}
          step={0.05}
          value={timeScale}
          onChange={(e) => {
            speedTouchedRef.current = true
            setTimeScale(Number(e.target.value))
          }}
        />
        <div className="setting-hint">
          相当于慢动作：弹道不变，整个比赛变慢，反应时间更多。体感模式建议 0.8 左右。
        </div>
      </div>

      <label className="setting switch">
        <span>慢动作辅助</span>
        <input
          type="checkbox"
          checked={slowMotion}
          onChange={(e) => setSlowMotion(e.target.checked)}
        />
      </label>
      <div className="setting-hint">球快打到你这边的瞬间放慢时间，给挥拍留出反应窗口。</div>
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
    if (hud.shouldSwing) {
      return { main: '挥 拍 !', sub: '球已过网并在你这边落台，现在出手', cls: 'prompt' }
    }
    if (hud.timeToPaddle !== null && hud.timeToPaddle < 0.55) {
      return { main: '准备…', sub: '球正在飞来', cls: 'prompt' }
    }
    return null
  })()

  return (
    <div className="app">
      <div className="canvas-host" ref={containerRef} />

      {screen === 'playing' && (
        <div className="hud">
          <div className="scoreboard">
            <div className="score-side player">
              <span className="score-label">你</span>
              <span className="score-value">{hud.score.player}</span>
            </div>
            <span className="score-sep">:</span>
            <div className="score-side opponent">
              <span className="score-label">对手</span>
              <span className="score-value">{hud.score.opponent}</span>
            </div>
            {!hud.gameOver &&
              (hud.score.player >= targetScore - 1 || hud.score.opponent >= targetScore - 1) && (
                <span className="matchpoint-pill">赛点</span>
              )}
          </div>

          {hud.phase === 'rally' && hud.rallyHits >= 3 && (
            <div className="rally-badge">对拉 x{hud.rallyHits}</div>
          )}

          {!hud.gameOver && (
            <button
              type="button"
              className={`rage-bar${hud.rage >= RAGE.max ? ' full' : ''}${hud.smashArmed ? ' armed' : ''}`}
              onClick={() => gameRef.current?.armSmash()}
              title={
                inputMode === 'pose'
                  ? '怒气攒满后双手举过头顶保持片刻即可爆气（也可按 F 或点击这里）'
                  : '怒气攒满后点击（或按 F）爆气，5 秒内下一次命中球的挥拍变成扣杀'
              }
            >
              <span
                className="rage-fill"
                style={{ width: `${Math.min(100, (hud.rage / RAGE.max) * 100)}%` }}
              />
              {hud.smashCharge > 0 && (
                <span
                  className="rage-charge"
                  style={{ width: `${hud.smashCharge * 100}%` }}
                />
              )}
              <span className="rage-label">
                {hud.smashArmed
                  ? '扣杀已就绪 · 挥拍！'
                  : hud.rage >= RAGE.max
                    ? hud.smashCharge > 0
                      ? '保持举高…'
                      : inputMode === 'pose'
                        ? '爆气就绪 · 举双手 / 按 F'
                        : '爆气就绪 · 按 F 或点击'
                    : '怒气'}
              </span>
            </button>
          )}

          <div className={`status-panel${statusOpen ? '' : ' collapsed'}`}>
            <button
              className="status-header"
              onClick={() => setStatusOpen((v) => !v)}
              title={statusOpen ? '收起状态面板（不挡对手）' : '展开状态面板（体感调试数值）'}
            >
              <span className="status-mode">
                <i className={`dot ${hud.cameraState === 'ready' ? 'ok' : 'warn'}`} />
                {inputMode === 'pose'
                  ? hud.cameraState === 'ready'
                    ? '体感已就绪'
                    : '体感未就绪'
                  : inputMode === 'mouse'
                    ? '鼠标模式'
                    : '键盘模式'}
              </span>
              <span className="status-meta">
                {hud.fps} fps
                <i className="chevron">{statusOpen ? '▴' : '▾'}</i>
              </span>
            </button>
            {statusOpen && (
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
                      <div className="status-error">正在加载姿态模型…</div>
                    )}
                  </>
                )}
                <div className="status-row">
                  <span>时间倍率</span>
                  <b>{hud.timeScale.toFixed(2)}x</b>
                </div>
                <div className="status-row">
                  <span>目标分数</span>
                  <b>{targetScore} 分</b>
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

          <div className="camera-preview">
            <div ref={previewRef} style={{ position: 'absolute', inset: 0 }} />
            <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0 }} />
            {inputMode !== 'pose' && (
              <div className="placeholder">切换到「体感」模式后，这里显示摄像头画面与骨架</div>
            )}
            <div className="camera-caption">
              {inputMode === 'pose'
                ? '虚线框=人体识别范围，橙色=手腕。挥拍看的是手腕的相对位移'
                : '体感模式这里显示摄像头画面与人体辅助框'}
            </div>
          </div>

          <div className="hints">
            {inputMode === 'pose' ? (
              <>左右移动身体调整球拍 · 上下快速挥动手腕击球 · 怒气满后双手举过头顶爆气</>
            ) : inputMode === 'mouse' ? (
              <>移动鼠标调整球拍 · 点击左键挥拍 · F 爆气</>
            ) : (
              <>
                <kbd>←</kbd>
                <kbd>→</kbd> 左右 · <kbd>空格</kbd> 挥拍 · <kbd>F</kbd> 爆气
              </>
            )}
          </div>

          <button className="settings-toggle" onClick={() => setShowSettings((v) => !v)}>
            ⚙
          </button>

          {showSettings && (
            <div className="settings">
              <h3>设置</h3>

              <div className="setting">
                <div className="setting-label">
                  <span>操作方式</span>
                </div>
                <div className="seg">
                  <button
                    className={inputMode === 'pose' ? 'active' : ''}
                    onClick={() => switchInputMode('pose')}
                  >
                    体感
                  </button>
                  <button
                    className={inputMode === 'mouse' ? 'active' : ''}
                    onClick={() => switchInputMode('mouse')}
                  >
                    鼠标
                  </button>
                  <button
                    className={inputMode === 'keyboard' ? 'active' : ''}
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
                      onClick={() => setDifficulty(d)}
                    >
                      {d === 'easy' ? '简单' : d === 'normal' ? '普通' : '困难'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting">
                <div className="setting-label">
                  <span>挥拍灵敏度</span>
                  <b>{swingThreshold.toFixed(2)}</b>
                </div>
                <input
                  type="range"
                  min={0.8}
                  max={8}
                  step={0.1}
                  value={swingThreshold}
                  onChange={(e) => setSwingThreshold(Number(e.target.value))}
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
                <input
                  type="range"
                  min={0.3}
                  max={1.2}
                  step={0.05}
                  value={timeScale}
                  onChange={(e) => {
                    speedTouchedRef.current = true
                    setTimeScale(Number(e.target.value))
                  }}
                />
                <div className="setting-hint">
                  相当于慢动作：弹道不变，只是整个比赛变慢，给你更多反应时间。
                  0.5 就是两倍慢动作，1.2 是两成快节奏。体感模式建议 0.8 左右。
                </div>
              </div>

              <div className="setting">
                <div className="setting-label">
                  <span>球台显示尺寸</span>
                  <b>{displaySize.toFixed(2)}x</b>
                </div>
                <input
                  type="range"
                  min={VIEW.minDisplaySize}
                  max={VIEW.maxDisplaySize}
                  step={0.05}
                  value={displaySize}
                  onChange={(e) => setDisplaySize(Number(e.target.value))}
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
                      <input
                        type="range"
                        min={limit.min}
                        max={limit.max}
                        step={limit.step}
                        value={cameraPose[row.key]}
                        onChange={(e) =>
                          setCameraPose({ ...cameraPose, [row.key]: Number(e.target.value) })
                        }
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
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={soundVolume}
                  onChange={(e) => setSoundVolume(Number(e.target.value))}
                />
              </div>

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
            </div>
          )}

          {hud.gameOver && (
            <div className="gameover">
              <div className="gameover-card">
                <div className="gameover-title">
                  {hud.gameOver.winner === 'player' ? '你赢了！' : '你输了'}
                </div>
                <div className="gameover-score">
                  <span className="player">{hud.gameOver.player}</span>
                  <span className="sep">:</span>
                  <span className="opponent">{hud.gameOver.opponent}</span>
                </div>
                <div className="gameover-stats">
                  <div className="stat">
                    <span>最长对拉</span>
                    <b>{hud.gameOver.longestRally} 拍</b>
                  </div>
                  <div className="stat">
                    <span>你的击球</span>
                    <b>{hud.gameOver.playerHits} 次</b>
                  </div>
                </div>
                <div className="gameover-hint">
                  {hud.gameOver.winner === 'player'
                    ? hud.gameOver.opponent === 0
                      ? '零封对手，太狠了！'
                      : hud.gameOver.longestRally >= 8
                        ? '鏖战取胜，漂亮！'
                        : '打得不错'
                    : '差一点，再来一局？'}
                </div>
                <button className="start-btn" onClick={restartGame}>
                  再来一局
                </button>
                <button className="ghost-btn" onClick={backToMenu}>
                  返回主菜单
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {screen === 'menu' && (
        <div className="start-overlay">
          <h1 className="start-title">PingpongGame</h1>
          <p className="start-sub">
            3D 体感乒乓球。体感模式用摄像头捕捉你的身体：左右移动调整球拍位置，
            在球落到你这边台面后快速挥动手腕完成击球。
            <br />
            惯用左手可以在下面选「左手」；不想挥手腕就选「鼠标左键」
            （球拍仍然跟着身体走，击球用鼠标左键）。
            <br />
            没有摄像头也可以用鼠标（移动鼠标 + 点击）或键盘（← → + 空格）来玩。
          </p>

          <div className="flow">
            <span className="flow-step">对手发球</span>
            <span className="flow-arrow">→</span>
            <span className="flow-step">球在对方区弹一次</span>
            <span className="flow-arrow">→</span>
            <span className="flow-step">球在我方区弹一次</span>
            <span className="flow-arrow">→</span>
            <span className="flow-step">你挥拍回击</span>
          </div>

          <div className="seg" style={{ width: 420, maxWidth: '92%' }}>
            <button
              className={inputMode === 'pose' ? 'active' : ''}
              onClick={() => switchInputMode('pose')}
            >
              体感模式（需摄像头）
            </button>
            <button
              className={inputMode === 'mouse' ? 'active' : ''}
              onClick={() => switchInputMode('mouse')}
            >
              鼠标模式
            </button>
            <button
              className={inputMode === 'keyboard' ? 'active' : ''}
              onClick={() => switchInputMode('keyboard')}
            >
              键盘模式
            </button>
          </div>

          {inputMode === 'pose' && <div className="menu-options">{poseOptions}</div>}

          <div className="menu-options">
            <div className="menu-options-title">对局设置</div>
            {gameOptions}
          </div>

          {bootError && <div className="start-error">{bootError}</div>}

          <button className="start-btn" onClick={startGame} disabled={booting}>
            {booting ? '正在加载姿态模型…' : '开始游戏'}
          </button>

          <p className="start-sub" style={{ fontSize: 12, opacity: 0.7 }}>
            体感模式首次启动需要从 CDN 下载 MediaPipe 的 wasm 与姿态模型（约 10MB），请保持联网。
          </p>
        </div>
      )}
    </div>
  )
}
