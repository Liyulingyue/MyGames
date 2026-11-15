/**
 * 物理常量（国际乒联标准尺寸，单位：米 / 秒）。
 *
 * 坐标系：X = 左右，Y = 向上，Z = 指向对手（我方台端为 -Z，对手台端为 +Z）。
 * 台面高度基准取 y = 0，地板在 y = -0.76。
 */

export const TABLE = {
  /** 台长 2.74m */
  length: 2.74,
  /** 台宽 1.525m */
  width: 1.525,
  halfLength: 1.37,
  halfWidth: 0.7625,
  /** 台面厚度 */
  thickness: 0.05,
  /** 球网高出台面 15.25cm */
  netHeight: 0.1525,
  /** 球网在 Z 方向的厚度 */
  netDepth: 0.015,
  /** 球网两侧超出台面的宽度 */
  netOverhang: 0.1525,
  /** 台面高度基准 */
  surfaceY: 0,
  /** 地板高度 */
  floorY: -0.76,
} as const

export const BALL = {
  /** 40mm 直径 */
  radius: 0.02,
  /** 2.7g */
  mass: 0.0027,
  /** 落台反弹系数 */
  restitutionTable: 0.86,
  /** 撞网后保留的速度比例 */
  restitutionNet: 0.25,
  /** 落台时水平速度的保持比例 */
  frictionTable: 0.965,
  /** 空气阻力（每秒衰减比例） */
  drag: 0.06,
  /** 旋转衰减 */
  spinDecay: 0.35,
  /** 落台后最小反弹速度，避免球在台面上抖动 */
  minBounceSpeed: 0.7,
} as const

/** 拍面半径（先抽出来，PADDLE 里多处要用它推导别的量） */
const PADDLE_RADIUS = 0.075

export const PADDLE = {
  /** 拍面半径 */
  radius: PADDLE_RADIUS,
  /** 拍面厚度 */
  thickness: 0.012,
  /** 我方球拍所在 Z（略在台端之内） */
  homeZ: -1.28,
  /** 对手球拍所在 Z */
  opponentZ: 1.28,
  /** 球拍高度下限（台面为 0） */
  minY: 0.05,
  /** 球拍高度上限 */
  maxY: 0.72,
  /** 球不在来路上时球拍回到的中立高度 */
  homeY: 0.3,
  /**
   * 球拍中心的横向行程（米）。
   *
   * 球落台之后还会继续横向漂，**球的行程比台面宽**：实测球飞过我方球拍平面时
   * |x| 最大 0.89m，比台面半宽（0.7625m）还多 13cm。
   * 所以球拍行程必须比台面宽，否则那些球根本够不着，只能白丢分。
   *
   * 这里取"台面半宽 + 25cm"，正好盖住球的实际行程（加上拍面半径后够到 ±1.13m）。
   */
  rangeX: TABLE.halfWidth + 0.25,
  /**
   * 命中判定：球心到拍心（在拍面平面内）的距离上限。
   *
   * 拍面半径 7.5cm + 球半径 2cm = 9.5cm 是"球真的贴上拍面"的物理极限，
   * 这里再放宽 2.5cm，留一点手抖的余量。
   */
  bladeReach: PADDLE_RADIUS + BALL.radius + 0.025,
  /**
   * 挥拍在 Z 方向的厚度（米）：球从拍面旁边掠过时也算打中。
   *
   * 挥拍本身有 0.17s 的有效窗口，球在这段时间里飞过 0.8m 以上，
   * 所以决定"挥早挥晚"的主要是那个时间窗口，而不是这里的厚度。
   * 厚度取小一点，击球点才会贴着拍面，而不是球还在半路就被打飞。
   */
  swingDepth: 0.05,
  /** 挥拍后"可击中"状态的持续时间（秒） */
  swingActiveTime: 0.17,
  /** 两次挥拍之间的最小间隔（秒） */
  swingCooldown: 0.26,
  /** 击球速度下限（低于此速度球可能落在本方半区） */
  minShotSpeed: 5.0,
  /** 击球速度上限 */
  maxShotSpeed: 6.2,
} as const

export const GRAVITY = -9.81

/** 物理固定步长（秒）。1/300s 内球最多移动 ~2.7cm，小于球拍直径，不会穿模 */
export const FIXED_DT = 1 / 300

/** 一局的目标分数 */
export const TARGET_SCORE = 11

/** 每 2 个球交换发球方 */
export const SERVE_ROTATION = 2

export interface AIConfig {
  /** 接到球后的反应延迟（秒） */
  reactionDelay: number
  /** 挡板最大横移速度 m/s */
  paddleSpeed: number
  /** 回球速度区间 */
  shotSpeed: [number, number]
  /** 瞄准误差（米） */
  aimError: number
  /** 漏接概率 */
  missChance: number
}

export const AI_PRESETS: Record<'easy' | 'normal' | 'hard', AIConfig> = {
  easy: {
    reactionDelay: 0.34,
    paddleSpeed: 2.2,
    shotSpeed: [4.8, 5.4],
    aimError: 0.32,
    missChance: 0.22,
  },
  normal: {
    reactionDelay: 0.18,
    paddleSpeed: 3.4,
    shotSpeed: [4.8, 6.2],
    aimError: 0.18,
    missChance: 0.08,
  },
  hard: {
    reactionDelay: 0.08,
    paddleSpeed: 4.6,
    shotSpeed: [5.6, 6.6],
    aimError: 0.08,
    missChance: 0.02,
  },
}

/** 玩家手感相关 */
export const PLAYER = {
  /**
   * 体感模式下，身体横向移动映射到球拍 X 的半幅（米）。
   *
   * 和球拍行程一致：身体站到画面边缘时球拍正好到行程尽头，
   * 这样"球漂到台面外面"时身体也够得到（否则体感模式永远接不到那种球）。
   */
  xRange: PADDLE.rangeX,
  /**
   * 挥拍检测：手腕运动速度阈值，单位是「肩宽 / 秒」（按路径长度算）。
   *
   * 用肩宽做单位是关键：人站得远时手在画面里动的比例很小，
   * 如果按"画面宽度"算，同一个动作的数值会差好几倍，阈值根本没法定。
   * 一次正常的引拍（快速下压 + 随挥上提）大约是 5~8 肩宽/秒，
   * 随手甩一下也有 3 左右，所以默认阈值取 2.5。
   */
  swingThreshold: 2.5,
  /**
   * 挥拍检测：垂直位移阈值相对速度阈值的比例，单位是「肩宽」。
   *
   * 引拍主要是上下方向，"手腕在窗口内上下拉开了多少"比纯速度更好用，
   * 所以速度阈值之外的第二个信号就是它。
   * 默认 2.5 × 0.08 = 0.2 肩宽（约 8cm 的上下位移）。
   */
  swingVerticalRatio: 0.08,
  /** 挥拍检测：速度超过阈值的多少倍算满力 */
  swingFullPowerScale: 3,
  /**
   * 手腕没被检测到时改用肘部兜底，阈值按这个比例放宽。
   *
   * 抬手挥拍时手腕经常被裁掉或糊掉，但肘部一般还在画面里；
   * 肘部跟着手臂动，幅度大约是手腕的一半，所以阈值要放宽，
   * 否则这个兜底几乎不可能触发（等于白加）。
   */
  elbowThresholdRatio: 0.6,
} as const
