/**
 * 取景参数：只管"画面里能看到多少"，不碰物理。
 *
 * 第一原则：**相机永远不动**。
 *
 * 位置 (0, 1.4, -2.35)、朝向 (0, 0.12, 0.8) 全部锁死，
 * 所以透视、比例、畸变和最初的取景一模一样——不会变成俯视视角。
 *
 * "画面拉大"用的是**裁剪放大**（相当于换长焦镜头）：
 * 画面就是同一张图裁一块出来放大，跟"3m 屏显示整幅、1m 屏只显示它的 1/N"
 * 是一个意思。裁剪窗口贴着下沿（球拍那一侧），所以球拍和对手的可见范围
 * 一点没变，裁掉的是上方的空背景。
 *
 * 宽高比适配也只在镜头张角上做：纵向张角固定 → 画面高度的内容一致，
 * 3m 屏和 1m 屏按比例等价；竖屏太窄时把张角开大到刚好装下球拍行程为止。
 *
 * 物理用的是真实米制（台宽 1.525m、球径 4cm、球拍满行程 ±1.09m），
 * 这里一行都不改。
 */

import { PADDLE } from '../core/constants.ts'

export const VIEW = {
  /** 基准取景：16:9、显示尺寸 1.0 时的相机（也就是最初的取景） */
  base: {
    pos: { x: 0, y: 1.4, z: -2.35 },
    target: { x: 0, y: 0.12, z: 0.8 },
    fov: 58,
  },
  /** 基准宽高比：在这个比例下、显示尺寸 = 1 时就是上面的基准取景 */
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
  /**
   * 镜头张角上限：竖屏太窄时只能开大角，宁可轻微广角也不把球拍切出画面。
   *
   * 9:16 竖屏需要 97° 才能装下球拍行程；再窄一点（比如 0.45 的手机长屏）
   * 需要 109°，所以上限放在 110°。
   */
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

export interface Framing {
  /** 裁剪之后实际生效的垂直 fov（度） */
  fov: number
  /** 虚拟大图的 fov（裁剪窗口按它换算） */
  sourceFov: number
  /** 裁剪放大倍率：1 = 原样 */
  zoom: number
  /** 相机位置（恒等于基准取景，只列出来方便调用方和测试读） */
  position: { x: number; y: number; z: number }
  /** 相机看向的点（恒等于基准取景） */
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

/**
 * 按视口宽高比和"显示尺寸"算出一套取景。
 *
 * @param aspect 视口宽高比（宽 / 高）
 * @param displaySize 显示尺寸倍率：1 = 原样，3 = 画面放大约三倍，0.5 = 画面缩一半
 */
export function fitFraming(aspect: number, displaySize = 1): Framing {
  const base = VIEW.base

  // 视角方向（只用来算深度，相机本身不动）
  const dx = base.target.x - base.pos.x
  const dy = base.target.y - base.pos.y
  const dz = base.target.z - base.pos.z
  const len = Math.hypot(dx, dy, dz)
  const dir = { x: dx / len, y: dy / len, z: dz / len }

  // 我方球拍平面在视线方向上的深度（相机到球拍平面的"正对距离"）
  const depthP =
    (0 - base.pos.x) * dir.x +
    (PADDLE.homeY - base.pos.y) * dir.y +
    (PADDLE.homeZ - base.pos.z) * dir.z

  // ---- 宽高比 → 镜头张角 ----
  // 纵向张角固定（画面高度的内容一致），横向随宽高比自然变化；
  // 竖屏太窄、横向装不下球拍行程时，才把张角开大到刚好装得下为止。
  const tanBase = Math.tan((base.fov * Math.PI) / 360)
  const halfWidthMin = VIEW.reachX / VIEW.edgeMargin
  const tanNeeded = halfWidthMin / (depthP * aspect)
  const tanSource = Math.min(
    Math.max(tanBase, tanNeeded),
    Math.tan((VIEW.maxFov * Math.PI) / 360),
  )
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
    position: { ...base.pos },
    target: { ...base.target },
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
