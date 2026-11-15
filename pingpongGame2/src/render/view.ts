/**
 * 取景参数：只管"画面从哪儿看、看到多少"，不碰物理。
 *
 * 两条独立的轴：
 *
 * 1. **相机位姿**（x / y / z / 俯角）：手动调，范围受限。
 *    相机位置和朝向都在这里定死，物理是真实米制（台宽 1.525m、球径 4cm、
 *    球拍满行程 ±1.09m），这里一行都不改。
 *
 * 2. **显示尺寸**（裁剪放大）：1 = 原样，往上调把画面裁一块出来铺满屏幕
 *    （相当于换长焦镜头），往下调则开大镜头、露出更多场景。
 *    这一轴**只改镜头张角和裁剪窗口，绝不碰相机位姿**——
 *    所以调它不会把透视改成俯视，"画面拉大"永远只是裁剪。
 *
 * 宽高比适配也只在镜头张角上做：纵向张角固定 → 画面高度的内容一致，
 * 3m 屏和 1m 屏按比例等价；竖屏太窄时把张角开大到刚好装下球拍行程为止。
 *
 * 实现是纯数学（不依赖 Three.js），方便回归测试。
 */

import { PADDLE } from '../core/constants.ts'

export const VIEW = {
  /** 基准取景：最初的相机（也就是 16:9 + 显示尺寸 1.0 时的画面） */
  base: {
    pos: { x: 0, y: 1.4, z: -2.35 },
    target: { x: 0, y: 0.12, z: 0.8 },
    fov: 58,
  },
  /** 基准宽高比 */
  referenceAspect: 16 / 9,
  /**
   * 球拍中心最远要出现在画面里的横向位置（米）。
   *
   * 实测击球点 |x| 最大 0.817m，球拍中心会跟到 0.85m 上下；
   * 拍面最外沿（±1.09m）允许被裁掉一点，所以硬约束卡在 0.85m。
   */
  reachX: 0.85,
  /** 球拍中心最多走到画面的这个比例（1 = 刚好贴边） */
  edgeMargin: 0.95,
  /** 镜头张角上限：竖屏太窄时只能开大角，宁可轻微广角也不把球拍切出画面 */
  maxFov: 110,
  /** 显示尺寸的下限（小于 1 = 画面缩小，露出更多场景） */
  minDisplaySize: 0.5,
  /**
   * 显示尺寸的上限。
   *
   * 相机不动 → 场景纵向只有约 46° 的张角（球拍底部到对手头顶），
   * 放大 1.25 倍时正好塞满；再大就把对手裁掉了（3.0 只剩我方这半张台面）。
   */
  maxDisplaySize: 3,
} as const

/** 相机位姿：位置 + 俯角（单位：米 / 度） */
export interface CameraPose {
  /** 左右（0 = 正对球台） */
  x: number
  /** 高度 */
  y: number
  /** 前后（越负越靠后） */
  z: number
  /** 俯角：相机向下看的角度 */
  angle: number
}

/** 各滑块的取值范围（范围受限，不做开放世界） */
export const CAMERA_LIMITS = {
  x: { min: -1.5, max: 1.5, step: 0.05 },
  y: { min: 0.6, max: 2.6, step: 0.05 },
  // z 上限 -1.8：必须留在我方球拍（z = -1.28）后面，否则球拍会跑到相机背后
  z: { min: -4.5, max: -1.8, step: 0.05 },
  angle: { min: 0, max: 60, step: 0.05 },
} as const

/**
 * 默认位姿 = 最初的相机，一个像素都不变。
 *
 * 俯角由最初的相机反推：看向 (0, 0.12, 0.8)，从 (0, 1.4, -2.35) 出发，
 * atan2(1.28, 3.15) ≈ 22.11°。
 */
export const DEFAULT_CAMERA: CameraPose = {
  x: 0,
  y: 1.4,
  z: -2.35,
  angle: (Math.atan2(1.28, 3.15) * 180) / Math.PI,
}

/** 水平瞄准点：球台远端中心（决定相机的偏航角） */
const AIM = { x: 0, z: 0.8 }
/** 注视点离相机的距离（只看方向，取个够远的值） */
const AIM_DISTANCE = 6

export interface Framing {
  /** 裁剪之后实际生效的垂直 fov（度） */
  fov: number
  /** 虚拟大图的 fov（裁剪窗口按它换算） */
  sourceFov: number
  /** 裁剪放大倍率：1 = 原样 */
  zoom: number
  /** 相机位置（x 还要加上每帧的横向跟随） */
  position: { x: number; y: number; z: number }
  /** 相机看向的点 */
  target: { x: number; y: number; z: number }
}

/** 裁剪窗口（虚拟大图上的一块） */
export interface ViewOffset {
  fullWidth: number
  fullHeight: number
  x: number
  y: number
  width: number
  height: number
}

/** 位姿解算结果 */
export interface ResolvedCamera {
  eye: { x: number; y: number; z: number }
  target: { x: number; y: number; z: number }
  dir: { x: number; y: number; z: number }
}

/**
 * 由位姿算出相机位置和朝向。
 *
 * 朝向 = 水平瞄准球台远端中心，再按俯角往下压。
 * 这样"左右"是横向平移（不会把画面拧歪），俯角是独立的第二个轴。
 *
 * @param panX 球拍跟随带来的横向偏移（会轻微转头，保持原来的手感）
 */
export function resolveCamera(pose: CameraPose, panX = 0): ResolvedCamera {
  const eye = { x: pose.x + panX, y: pose.y, z: pose.z }
  const aimX = panX * 0.4
  const dx = aimX - eye.x
  const dz = AIM.z - eye.z
  const hl = Math.hypot(dx, dz) || 1
  const pitch = (pose.angle * Math.PI) / 180
  const cos = Math.cos(pitch)
  const dir = {
    x: (dx / hl) * cos,
    y: -Math.sin(pitch),
    z: (dz / hl) * cos,
  }
  return {
    eye,
    dir,
    target: {
      x: eye.x + dir.x * AIM_DISTANCE,
      y: eye.y + dir.y * AIM_DISTANCE,
      z: eye.z + dir.z * AIM_DISTANCE,
    },
  }
}

/** 视点基：和 Three.js 的 lookAt 一致（z 轴指向相机后方） */
function basis(eye: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }) {
  const zx = eye.x - target.x
  const zy = eye.y - target.y
  const zz = eye.z - target.z
  const zl = Math.hypot(zx, zy, zz)
  const z = { x: zx / zl, y: zy / zl, z: zz / zl }
  const raw = { x: z.z, y: 0, z: -z.x }
  const xl = Math.hypot(raw.x, raw.z) || 1
  const x = { x: raw.x / xl, y: 0, z: raw.z / xl }
  const y = {
    x: z.y * x.z - z.z * x.y,
    y: z.z * x.x - z.x * x.z,
    z: z.x * x.y - z.y * x.x,
  }
  return { x, y, z }
}

/** 世界坐标 → 虚拟大图上的 NDC（tanHalf = 虚拟大图半张角的 tan） */
function projectVirtual(
  cam: ResolvedCamera,
  p: { x: number; y: number; z: number },
  aspect: number,
  tanHalf: number,
): { x: number; y: number } {
  const { x, y, z } = basis(cam.eye, cam.target)
  const vx = p.x - cam.eye.x
  const vy = p.y - cam.eye.y
  const vz = p.z - cam.eye.z
  const depth = -(vx * z.x + vy * z.y + vz * z.z)
  const cx = vx * x.x + vy * x.y + vz * x.z
  const cy = vx * y.x + vy * y.y + vz * y.z
  return { x: cx / depth / (tanHalf * aspect), y: cy / depth / tanHalf }
}

/**
 * 按宽高比、显示尺寸和相机位姿算出一套取景。
 *
 * @param aspect 视口宽高比（宽 / 高）
 * @param displaySize 显示尺寸倍率：1 = 原样，3 = 画面放大约三倍，0.5 = 画面缩一半
 * @param pose 相机位姿
 */
export function fitFraming(aspect: number, displaySize = 1, pose: CameraPose = DEFAULT_CAMERA): Framing {
  const base = VIEW.base
  const cam = resolveCamera(pose)

  // ---- 宽高比 → 镜头张角 ----
  // 纵向张角固定（画面高度的内容一致），横向随宽高比自然变化；
  // 竖屏太窄、横向装不下球拍行程时，才把张角开大到刚好装得下为止。
  const tanBase = Math.tan((base.fov * Math.PI) / 360)
  const tanMax = Math.tan((VIEW.maxFov * Math.PI) / 360)
  // 球拍最远位置在相机前面的横向张角（左右各算一次，取大的）
  const far = { x: VIEW.reachX, y: PADDLE.homeY, z: PADDLE.homeZ }
  const near = { x: -VIEW.reachX, y: PADDLE.homeY, z: PADDLE.homeZ }
  const halfTan = Math.max(
    Math.abs(projectVirtual(cam, far, aspect, 1).x),
    Math.abs(projectVirtual(cam, near, aspect, 1).x),
  )
  const tanNeeded = halfTan / (VIEW.edgeMargin * aspect)
  const tanSource = Math.min(Math.max(tanBase, tanNeeded), tanMax)
  const adaptedFov = (2 * Math.atan(tanSource) * 180) / Math.PI

  // ---- 显示尺寸 → 裁剪放大 ----
  // 同一张图裁一块出来放大：等效 fov 变小（放大），或变大（缩小）。
  const zoom = Math.min(
    Math.max(displaySize, VIEW.minDisplaySize),
    VIEW.maxDisplaySize,
  )
  const fov = (2 * Math.atan(tanSource / zoom) * 180) / Math.PI

  // 放大（zoom ≥ 1）用裁剪窗口：相机张角保持不变，只裁一块出来铺满屏幕，
  // 裁剪窗口贴着下沿 → 球拍一侧的位置一点不变。
  // 缩小（zoom < 1）没法用裁剪（要看得比原图更多），直接开大镜头。
  const sourceFov = zoom >= 1 ? adaptedFov : fov

  return {
    fov,
    sourceFov,
    zoom,
    position: { ...cam.eye },
    target: { ...cam.target },
  }
}

/**
 * 裁剪窗口：把画布当成"虚拟大图上的一块"来看。
 *
 * 虚拟大图的像素尺寸 = 画布 × zoom，所以放大 zoom 倍时，
 * 画布上的一个像素对应大图上的 1/zoom 个像素 → 画面被放大 zoom 倍。
 * 裁剪窗口横向居中、纵向贴着下沿（球拍那一侧），
 * 这样球拍和对手在画面里的位置一点不变，裁掉的是上方空背景。
 */
export function viewOffset(width: number, height: number, f: Framing): ViewOffset {
  // 缩小时镜头已经开大了，裁剪窗口就是整块画布
  if (f.zoom < 1) {
    return { fullWidth: width, fullHeight: height, x: 0, y: 0, width, height }
  }
  const fullWidth = width * f.zoom
  const fullHeight = height * f.zoom
  return {
    fullWidth,
    fullHeight,
    x: (fullWidth - width) / 2,
    y: fullHeight - height,
    width,
    height,
  }
}

/** 画面检查：当前位姿下哪些关键点还在画面里 */
export interface FrameCheck {
  /** 球拍中心最远 ±reachX 的横向 NDC（|x| ≤ 1 才在画面内） */
  paddleX: number
  /** 球拍中心的纵向 NDC */
  paddleCenter: number
  /** 球拍中心最低/最高位置的纵向位置 */
  paddleBottom: number
  paddleTop: number
  /** 对手球拍 / 对手头顶的纵向位置 */
  opponent: number
  opponentHead: number
  /** 球拍是否还在画面里 */
  paddleOk: boolean
  /** 对手是否还在画面里 */
  opponentOk: boolean
  /**
   * 相机本身（不管显示尺寸）有没有把东西挤出画面。
   *
   * 显示尺寸是"裁剪放大"，放大到 3 倍时球拍出画是裁剪的必然结果，
   * 不是相机调坏了——用这个字段把两件事分开。
   */
  cameraOk: boolean
  /** 汇总：球拍和对手是否都还在画面里 */
  ok: boolean
}

/**
 * 检查当前位姿 + 显示尺寸下，球拍和对手还在不在画面里。
 *
 * 相机是手动调的，可能把画面调歪，所以要在 UI 上把结果显示出来，
 * 而不是让玩家自己猜"球呢？"
 *
 * 要把两件事分开：
 *   - **相机本身**好不好（看显示尺寸 = 1 时的取景）；
 *   - **显示尺寸**（裁剪放大）有没有把东西裁掉。
 * 放大到 3 倍时球拍出画是裁剪的必然结果，不是相机调坏了。
 */
export function checkFrame(
  aspect: number,
  displaySize: number,
  pose: CameraPose = DEFAULT_CAMERA,
): FrameCheck {
  const cam = resolveCamera(pose)

  /** 取某个取景方案下的屏幕位置（含裁剪窗口） */
  const probe = (framing: Framing) => {
    const tanHalf = Math.tan((framing.sourceFov * Math.PI) / 360)
    const k = framing.zoom
    const toScreen = (p: { x: number; y: number; z: number }) => {
      const v = projectVirtual(cam, p, aspect, tanHalf)
      if (k < 1) return v
      return { x: k * v.x, y: k * (v.y + 1) - 1 }
    }
    const far = toScreen({ x: VIEW.reachX, y: PADDLE.homeY, z: PADDLE.homeZ })
    const near = toScreen({ x: -VIEW.reachX, y: PADDLE.homeY, z: PADDLE.homeZ })
    const center = toScreen({ x: 0, y: PADDLE.homeY, z: PADDLE.homeZ })
    const bottom = toScreen({ x: 0, y: PADDLE.minY, z: PADDLE.homeZ })
    const top = toScreen({ x: 0, y: PADDLE.maxY, z: PADDLE.homeZ })
    const opponent = toScreen({ x: 0, y: PADDLE.homeY, z: PADDLE.opponentZ })
    const head = toScreen({ x: 0, y: 1.015, z: PADDLE.opponentZ + 0.55 })
    return {
      paddleX: Math.max(Math.abs(far.x), Math.abs(near.x)),
      paddleCenter: center.y,
      paddleBottom: bottom.y,
      paddleTop: top.y,
      opponent: opponent.y,
      opponentHead: head.y,
    }
  }

  const shown = probe(fitFraming(aspect, displaySize, pose))
  const alone = probe(fitFraming(aspect, 1, pose))

  // 球拍：中心在画面里就算数（拍面边缘露一点出去没关系，原相机也是这样）
  const paddleOk = shown.paddleX <= 1 && shown.paddleCenter >= -1 && shown.paddleCenter <= 1
  const opponentOk = shown.opponent >= -1 && shown.opponentHead <= 1
  const cameraOk =
    alone.paddleX <= 1 && alone.paddleCenter >= -1 && alone.paddleCenter <= 1 &&
    alone.opponent >= -1 && alone.opponentHead <= 1

  return {
    ...shown,
    paddleOk,
    opponentOk,
    cameraOk,
    ok: paddleOk && opponentOk,
  }
}
