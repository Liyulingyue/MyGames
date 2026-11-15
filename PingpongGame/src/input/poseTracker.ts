import type { NormalizedLandmark, PoseLandmarker as PoseLandmarkerType } from '@mediapipe/tasks-vision'

/** wasm 运行时（CDN，与 npm 包版本保持一致） */
const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm'

/** 轻量姿态模型 */
const MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

/** MediaPipe PoseLandmarker 关键点索引 */
export const LANDMARK = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
} as const

/**
 * 关键点可信度下限：低于这个值就当作"没检测到"。
 *
 * MediaPipe 的姿态模型**永远返回 33 个关键点**，没检测到的那些
 * visibility≈0、坐标是 (0,0)。不检查 visibility 就会：
 *
 * - 肩膀"没检测到" → 中点算成 (0,0) → 身体位置变成画面最边上 → 球拍钉死在边角，
 *   站在画面正中间也不会回到中间；
 * - 手腕"没检测到" → 采样点一直是 (0,0) → 路径长度为 0 → 挥拍速度永远是 0。
 *
 * 这两个都是玩家实际遇到过的现象，所以这里必须过滤。
 */
export const VISIBILITY_MIN = 0.5

/** 采样点来源：手腕，或者手腕没识别到时的肘部兜底 */
export type MotionSource = 'wrist' | 'elbow'

export interface ArmSample {
  /** 镜像后的屏幕坐标（0~1，x 越大越靠右） */
  x: number
  y: number
  /**
   * 最近 ~180ms 的运动速度，单位是「肩宽 / 秒」（按路径长度算）。
   *
   * 用肩宽而不是画面宽度做单位很关键：人站得远，手在画面里动的比例就小，
   * 用画面宽度当单位时同样的动作数值会差好几倍，阈值根本没法定。
   */
  speed: number
  /** 最近 ~180ms 内垂直方向的跨度，单位是「肩宽」（引拍幅度） */
  verticalRange: number
  /** 这个采样来自手腕还是肘部 */
  source: MotionSource
}

export interface PoseFrame {
  /**
   * 能不能确定人在画面里的位置。
   *
   * 为 true 表示双肩（或髋部）至少有一个是**真的检测到了**，
   * bodyX 才有意义；否则 bodyX 会退回到画面中心（球拍不会乱跑）。
   */
  hasPerson: boolean
  /** 身体位置（镜像后）：双肩连线中点，取不到时退到髋部中点 */
  bodyX: number
  /**
   * 人体尺寸参照（肩宽 / 躯干长度，单位：画面宽度）。
   *
   * 手腕的运动量都除以它，这样"挥一下手"不管人离摄像头多远，
   * 得到的数值都是可比的。
   */
  bodyScale: number
  /** 左边手臂的运动采样 */
  leftArm: ArmSample | null
  /** 右边手臂的运动采样 */
  rightArm: ArmSample | null
  /** 动得更厉害的那条手臂 */
  fastest: ArmSample | null
  timestamp: number
}

export interface HistoryPoint {
  t: number
  x: number
  y: number
}

/**
 * 手臂运动历史。
 *
 * 手腕与肘部分开记：采样点在两者之间切换时（例如手腕被遮住），
 * 如果共用一条历史，肘部和手腕之间那一下"跳变"会被算成巨大的速度，
 * 凭空触发一次挥拍。
 */
export interface ArmHistories {
  leftWrist: HistoryPoint[]
  rightWrist: HistoryPoint[]
  leftElbow: HistoryPoint[]
  rightElbow: HistoryPoint[]
}

/** 新建一份空历史 */
export function createArmHistories(): ArmHistories {
  return { leftWrist: [], rightWrist: [], leftElbow: [], rightElbow: [] }
}

function clearHistories(h: ArmHistories): void {
  h.leftWrist.length = 0
  h.rightWrist.length = 0
  h.leftElbow.length = 0
  h.rightElbow.length = 0
}

/** 速度统计窗口（秒） */
const SPEED_WINDOW = 0.18

/**
 * 速度统计窗口（毫秒）。
 *
 * 历史点的时间戳是 performance.now()，单位是**毫秒**。
 * 以前这里直接拿毫秒差去和 0.18（秒）比，结果每一帧都只剩最后一个点，
 * 窗口里攒不下任何运动量 → 挥拍速度永远是 0，挥拍永远触发不了。
 */
const SPEED_WINDOW_MS = SPEED_WINDOW * 1000

/**
 * 采样点断档多久算"重新开始"（毫秒）。
 *
 * 超过这个间隔说明中间丢过帧（手腕被遮挡 / 离开画面），
 * 再回来时坐标可能已经跳到别处，这时不能把跳变算进运动量。
 */
const SAMPLE_GAP_LIMIT_MS = 120

/**
 * 找不到人体尺寸参照时的兜底值（画面宽度的比例）。
 *
 * 取 0.25 相当于"人占画面宽度的一半、肩宽约 1/4 画面宽"的典型情况。
 */
const DEFAULT_BODY_SCALE = 0.25

/** 把浏览器抛出的英文摄像头错误翻译成能看懂的提示 */
function cameraErrorText(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '摄像头权限被拒绝，请在浏览器地址栏允许摄像头权限后重试'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有检测到摄像头设备'
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头被其它程序占用，请关闭后重试'
    case 'OverconstrainedError':
      return '摄像头不支持所需的采集格式'
    default:
      return err instanceof Error ? err.message : String(err)
  }
}

/** 摄像头授权等待上限（秒）——权限弹窗没人点时会超时报错，而不是一直卡着 */
const CAMERA_TIMEOUT = 30

/** 模型 / wasm 下载等待上限（秒） */
const MODEL_TIMEOUT = 120

export type PoseInitStage = 'wasm' | 'model' | 'engine' | 'camera'

export interface PoseLoadProgress {
  stage: PoseInitStage
  /** 0~1；非下载阶段或服务端未返回 Content-Length 时为 null */
  ratio: number | null
  loadedBytes?: number
  totalBytes?: number
}

/**
 * 流式下载模型文件并实时上报下载进度。
 *
 * MediaPipe 内部直接传 URL 时外部拿不到下载进度；
 * 自己用 fetch + ReadableStream 读取字节后，再通过 modelAssetBuffer 传入，
 * 就能给前端提供准确的进度条反馈。
 */
export async function downloadModelBytes(
  url: string,
  onProgress?: (progress: PoseLoadProgress) => void,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetchImpl(url, { signal })
  if (!response.ok) {
    throw new Error(`姿态模型下载失败（HTTP ${response.status}）`)
  }

  const contentLength = Number(response.headers.get('Content-Length') ?? 0)
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    onProgress?.({
      stage: 'model',
      ratio: 1,
      loadedBytes: buffer.byteLength,
      totalBytes: totalBytes ?? buffer.byteLength,
    })
    return buffer
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let loadedBytes = 0

  onProgress?.({ stage: 'model', ratio: totalBytes ? 0 : null, loadedBytes: 0, totalBytes })

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    chunks.push(value)
    loadedBytes += value.byteLength
    onProgress?.({
      stage: 'model',
      ratio: totalBytes ? Math.min(1, loadedBytes / totalBytes) : null,
      loadedBytes,
      totalBytes,
    })
  }

  const result = new Uint8Array(loadedBytes)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/**
 * 给异步操作加超时（seconds 为秒）。
 * 超时后原 promise 仍会继续跑，只是我们不再等它。
 */
function withTimeout<T>(promise: Promise<T>, seconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), seconds * 1000)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * MediaPipe 姿态追踪封装。
 *
 * 只负责"从摄像头里取出人体关键点，并换算成屏幕坐标"，
 * 不关心游戏规则。挥拍的判定逻辑在 swingDetector.ts。
 */
export class PoseTracker {
  private landmarker: PoseLandmarkerType | null = null
  private stream: MediaStream | null = null
  private closed = false
  private readonly abortController = new AbortController()
  private video: HTMLVideoElement | null = null
  private lastVideoTime = -1
  private histories = createArmHistories()
  private aspect = 4 / 3
  private lastLandmarks: NormalizedLandmark[] | null = null
  private lastFrame: PoseFrame | null = null
  /**
   * 开发调试用：注入原始关键点，跳过摄像头。
   *
   * 这样可以在没有摄像头的环境里验证整条链路
   * （visibility 过滤 → 身体位置 → 球拍 → 挥拍速度）。
   */
  private fakeLandmarks: NormalizedLandmark[] | null = null

  /** 摄像头视频元素（用于 UI 预览） */
  get videoElement(): HTMLVideoElement | null {
    return this.video
  }

  /** 最近一帧的关键点（用于 UI 叠加绘制） */
  get landmarks(): NormalizedLandmark[] | null {
    return this.lastLandmarks
  }

  /** 最近一次姿态检测的结果（没检测过则为 null） */
  get frame(): PoseFrame | null {
    return this.lastFrame
  }

  /** 注入原始关键点（null = 恢复真实摄像头数据） */
  setFakeLandmarks(landmarks: NormalizedLandmark[] | null): void {
    this.fakeLandmarks = landmarks
  }

  /** 初始化模型（需要网络，wasm 与模型都从 CDN 加载） */
  async init(onProgress?: (progress: PoseLoadProgress) => void): Promise<void> {
    onProgress?.({ stage: 'wasm', ratio: null })
    const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision')
    const fileset = await withTimeout(
      FilesetResolver.forVisionTasks(WASM_PATH),
      MODEL_TIMEOUT,
      'MediaPipe 运行时下载超时，请检查网络',
    )
    if (this.closed) throw new Error('姿态追踪已关闭')

    const modelBytes = await withTimeout(
      downloadModelBytes(MODEL_PATH, onProgress, fetch, this.abortController.signal),
      MODEL_TIMEOUT,
      '姿态模型下载超时，请检查网络',
    )
    if (this.closed) throw new Error('姿态追踪已关闭')

    onProgress?.({ stage: 'engine', ratio: null })
    let abandoned = false
    const pending = PoseLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetBuffer: modelBytes,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }).then((landmarker) => {
        if (abandoned || this.closed) {
          landmarker.close()
          throw new Error('姿态追踪已关闭')
        }
        return landmarker
      })
    try {
      const landmarker = await withTimeout(
        pending,
        MODEL_TIMEOUT,
        '姿态模型初始化超时，请检查网络或显卡驱动',
      )
      if (this.closed) {
        landmarker.close()
        throw new Error('姿态追踪已关闭')
      }
      this.landmarker = landmarker
    } catch (err) {
      abandoned = true
      throw err
    }
  }

  /** 打开摄像头 */
  async startCamera(): Promise<HTMLVideoElement> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头采集')
    }

    let abandoned = false
    const pending = navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    }).catch((err: unknown) => {
      throw new Error(cameraErrorText(err))
    }).then((stream) => {
      if (abandoned || this.closed) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error('姿态追踪已关闭')
      }
      return stream
    })
    try {
      const stream = await withTimeout(
        pending,
        CAMERA_TIMEOUT,
        '摄像头授权超时，请在浏览器地址栏允许摄像头权限',
      )
      if (this.closed) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error('姿态追踪已关闭')
      }
      this.stream = stream
    } catch (err) {
      abandoned = true
      throw err
    }

    const video = document.createElement('video')
    video.playsInline = true
    video.muted = true
    video.srcObject = this.stream
    await video.play()

    if (this.closed) throw new Error('姿态追踪已关闭')
    this.video = video
    return video
  }

  /**
   * 对当前视频帧做一次姿态检测。
   * 没有新帧时返回 null（省算力）。
   */
  detect(now: number): PoseFrame | null {
    // 开发调试：直接用注入的关键点，不碰摄像头
    if (this.fakeLandmarks) {
      this.lastLandmarks = this.fakeLandmarks
      this.lastFrame = computePoseFrame(this.fakeLandmarks, now, this.aspect, this.histories)
      return this.lastFrame
    }

    const video = this.video
    const landmarker = this.landmarker
    if (!video || !landmarker) return null
    if (video.readyState < 2) return null
    if (video.currentTime === this.lastVideoTime) return null
    this.lastVideoTime = video.currentTime

    if (video.videoWidth && video.videoHeight) {
      this.aspect = video.videoWidth / video.videoHeight
    }

    let result
    try {
      result = landmarker.detectForVideo(video, now)
    } catch {
      return null
    }

    const landmarks = result.landmarks?.[0]
    this.lastLandmarks = landmarks ?? null
    this.lastFrame = computePoseFrame(landmarks, now, this.aspect, this.histories)
    return this.lastFrame
  }

  close(): void {
    this.closed = true
    this.abortController.abort()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    this.landmarker?.close()
    this.landmarker = null
    this.video = null
  }
}

/**
 * 从原始关键点算出一帧姿态数据。
 *
 * 抽成纯函数是为了能脱离摄像头做回归测试——MediaPipe 的"没检测到"
 * 表现（visibility≈0 + 坐标 (0,0)）必须被挡住，否则：
 * 身体位置会算到画面边上（球拍钉死），挥拍速度恒为 0。
 */
export function computePoseFrame(
  landmarks: NormalizedLandmark[] | null | undefined,
  now: number,
  aspect: number,
  histories: ArmHistories = createArmHistories(),
): PoseFrame {
  if (!landmarks || landmarks.length === 0) {
    clearHistories(histories)
    return {
      hasPerson: false,
      bodyX: 0.5,
      bodyScale: DEFAULT_BODY_SCALE,
      leftArm: null,
      rightArm: null,
      fastest: null,
      timestamp: now,
    }
  }

  const at = (index: number): NormalizedLandmark | undefined =>
    isVisible(landmarks[index]) ? landmarks[index] : undefined

  // —— 身体位置：双肩连线的中点（用户要求的就是这个点）——
  // 肩膀被挡住时退到髋部中点；两个都取不到就认为"人不在画面里"。
  const shoulderMid = midpointOrNull(at(LANDMARK.LEFT_SHOULDER), at(LANDMARK.RIGHT_SHOULDER))
  const hipMid = midpointOrNull(at(LANDMARK.LEFT_HIP), at(LANDMARK.RIGHT_HIP))
  const bodyPoint = shoulderMid ?? hipMid
  const bodyX = bodyPoint ? mirror(bodyPoint.x) : 0.5
  const bodyScale = bodyScaleOf(landmarks, aspect)

  // —— 手臂运动：手腕优先，手腕没识别到时用肘部兜底 ——
  const leftArm = armSample(
    histories.leftWrist,
    histories.leftElbow,
    at(LANDMARK.LEFT_WRIST),
    at(LANDMARK.LEFT_ELBOW),
    now,
    aspect,
    bodyScale,
  )
  const rightArm = armSample(
    histories.rightWrist,
    histories.rightElbow,
    at(LANDMARK.RIGHT_WRIST),
    at(LANDMARK.RIGHT_ELBOW),
    now,
    aspect,
    bodyScale,
  )

  const fastest =
    leftArm && rightArm ? (leftArm.speed >= rightArm.speed ? leftArm : rightArm) : (leftArm ?? rightArm)

  return {
    hasPerson: bodyPoint !== null,
    bodyX,
    bodyScale,
    leftArm,
    rightArm,
    fastest,
    timestamp: now,
  }
}

/**
 * 取一条手臂的采样点。
 *
 * 手腕优先；手腕没检测到（visibility 太低）时用肘部兜底——
 * 抬手挥拍时手腕经常被裁掉或糊掉，但肘部一般还在，
 * 总比完全挥不出去强。
 */
function armSample(
  wristHistory: HistoryPoint[],
  elbowHistory: HistoryPoint[],
  wrist: NormalizedLandmark | undefined,
  elbow: NormalizedLandmark | undefined,
  now: number,
  aspect: number,
  bodyScale: number,
): ArmSample | null {
  if (wrist) return pushSample(wristHistory, wrist, now, aspect, bodyScale, 'wrist')
  if (elbow) return pushSample(elbowHistory, elbow, now, aspect, bodyScale, 'elbow')

  // 两个点都没检测到：这一帧没有采样。
  //
  // 这里绝对不能清空历史：一旦清掉，窗口里就攒不够运动量，
  // 挥拍永远测不出来（这正是"体感一直挥不出去"的元凶之一）。
  // 保留旧点，等它们自然过期就行。
  return null
}

function pushSample(
  history: HistoryPoint[],
  landmark: NormalizedLandmark,
  now: number,
  aspect: number,
  bodyScale: number,
  source: MotionSource,
): ArmSample {
  // 镜像：摄像头画面是左右相反的，镜像后"我往右移"就是"画面往右移"
  const x = mirror(landmark.x)
  const y = landmark.y

  // 采样点消失过一阵又回来时，MediaPipe 给的坐标可能和上次差很多
  // （被遮挡期间它只能瞎猜）。把中间那一下跳变算进路径长度的话，
  // 会得到一个巨大的速度，凭空触发一次挥拍。
  // 所以间隔太久就重新开始记。
  const last = history[history.length - 1]
  if (last && now - last.t > SAMPLE_GAP_LIMIT_MS) {
    history.length = 0
  }

  history.push({ t: now, x, y })
  while (history.length > 0 && now - history[0].t > SPEED_WINDOW_MS) {
    history.shift()
  }

  const motion = wristMotion(history, aspect, bodyScale)
  return { x, y, speed: motion.speed, verticalRange: motion.verticalRange, source }
}

/** 镜像 x 坐标 */
function mirror(x: number): number {
  return 1 - x
}

/**
 * 关键点是不是真的检测到了。
 *
 * visibility 是 MediaPipe 给的"这个点在画面里有多可信"；
 * 没检测到时约为 0。少数情况下模型不给这个字段，此时按可信处理。
 */
export function isVisible(lm?: NormalizedLandmark | null): boolean {
  if (!lm) return false
  const v = lm.visibility
  if (typeof v !== 'number') return true
  return v >= VISIBILITY_MIN
}

/** 取一个可信的关键点（不可信就当没有） */
function visibleAt(
  landmarks: NormalizedLandmark[],
  index: number,
): NormalizedLandmark | undefined {
  const lm = landmarks[index]
  return isVisible(lm) ? lm : undefined
}

/** 和 midpoint 一样，但两个点都没有时返回 null（用于区分"没有这个关键点"） */
function midpointOrNull(
  a?: NormalizedLandmark,
  b?: NormalizedLandmark,
): { x: number; y: number } | null {
  if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const only = a ?? b
  return only ? { x: only.x, y: only.y } : null
}

/**
 * 人体尺寸参照（用于把手腕运动量换算成"肩宽"单位）。
 *
 * 优先用躯干长度（肩中点 → 髋中点）：人转身时投影宽度会变，躯干长度基本不变。
 * 摄像头通常只拍到上半身，取不到髋部时退化为肩宽。
 *
 * 只用**检测到了**的关键点：被挡住的关键点坐标是 (0,0)，
 * 混进来会让比例算得完全不对。
 */
export function bodyScaleOf(landmarks: NormalizedLandmark[], aspect: number): number {
  const ls = visibleAt(landmarks, LANDMARK.LEFT_SHOULDER)
  const rs = visibleAt(landmarks, LANDMARK.RIGHT_SHOULDER)
  const lh = visibleAt(landmarks, LANDMARK.LEFT_HIP)
  const rh = visibleAt(landmarks, LANDMARK.RIGHT_HIP)

  const shoulderMid = midpointOrNull(ls, rs)
  const hipMid = midpointOrNull(lh, rh)
  if (shoulderMid && hipMid) {
    const torso = Math.hypot(
      shoulderMid.x - hipMid.x,
      (shoulderMid.y - hipMid.y) * aspect,
    )
    if (torso > 0.05) return torso
  }

  if (ls && rs) {
    const width = Math.abs(ls.x - rs.x)
    if (width > 0.03) return width
  }

  return DEFAULT_BODY_SCALE
}

/**
 * 窗口内的手腕运动量。
 *
 * - speed：路径长度 / 时长，单位是「肩宽 / 秒」。
 *   注意不能用"首尾净位移"：真实挥拍是"加速下压 → 击球 → 随挥上提"，
 *   窗口里首尾位置可能几乎重合，净位移≈0，挥拍就永远测不出来。
 *   改成累计路径长度后，一次下压+上提能完整计入。
 * - verticalRange：窗口内 y 的最大跨度，单位是「肩宽」。
 *   乒乓球的引拍主要是上下方向，这个量不受"挥完回到原位"的影响，
 *   对小幅快速的上下挥动特别敏感。
 *
 * 一切都除以 bodyScale（人的肩宽/躯干长度）：这样人离摄像头远近不同，
 * 同样的挥拍动作得到同样的数值，阈值才有意义。
 */
export function wristMotion(
  history: HistoryPoint[],
  aspect: number,
  bodyScale = DEFAULT_BODY_SCALE,
): { speed: number; verticalRange: number } {
  if (history.length < 2) return { speed: 0, verticalRange: 0 }

  const first = history[0]
  const last = history[history.length - 1]
  const dt = (last.t - first.t) / 1000
  if (dt <= 1e-4) return { speed: 0, verticalRange: 0 }

  // 累计路径长度：x 以画面宽度为单位，y 乘上宽高比换算到同一尺度
  let path = 0
  let minY = history[0].y
  let maxY = history[0].y
  for (let i = 1; i < history.length; i++) {
    const dx = history[i].x - history[i - 1].x
    const dy = (history[i].y - history[i - 1].y) * aspect
    path += Math.hypot(dx, dy)
    if (history[i].y < minY) minY = history[i].y
    if (history[i].y > maxY) maxY = history[i].y
  }

  // 换算成"肩宽"单位：人离摄像头远近不影响数值
  const scale = Math.max(0.05, bodyScale)
  return {
    speed: path / scale / dt,
    verticalRange: ((maxY - minY) * aspect) / scale,
  }
}
