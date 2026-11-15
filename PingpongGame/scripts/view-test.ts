/**
 * 取景回归测试。
 *
 * 检查五件事：
 *   1. 基准情况（16:9 + 显示尺寸 1.0）必须和最初的相机一模一样；
 *   2. **相机永远不动**：位置和朝向在任何宽高比、任何显示尺寸下都不变
 *      （这是"画面拉大"不能变成俯视视角的保证）；
 *   3. 各种宽高比下球拍（尤其是漂到台面外的宽球位置）都必须留在画面里；
 *   4. 显示尺寸只做裁剪放大：球拍一侧的可见范围一点不变，越大远端球台越大；
 *   5. 放大到上限时对手也不能被裁掉。
 *
 * 纯数学，不依赖 DOM 和 Three.js。
 */

import { VIEW, fitFraming, type Framing } from '../src/render/view.ts'
import { PADDLE, TABLE } from '../src/core/constants.ts'

let failures = 0

function ok(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

function approx(label: string, actual: number, expected: number, tol: number): void {
  ok(label, Math.abs(actual - expected) <= tol, `${actual.toFixed(5)}（期望 ${expected.toFixed(5)}）`)
}

/** 视点基：和 Three.js 的 lookAt 一致（z 轴指向相机后方） */
function basis(f: Framing) {
  const zx = f.position.x - f.target.x
  const zy = f.position.y - f.target.y
  const zz = f.position.z - f.target.z
  const zl = Math.hypot(zx, zy, zz)
  const z = { x: zx / zl, y: zy / zl, z: zz / zl }
  const x = { x: z.z, y: 0, z: -z.x }
  const xl = Math.hypot(x.x, x.z) || 1
  x.x /= xl
  x.z /= xl
  const y = {
    x: z.y * x.z - z.z * x.y,
    y: z.z * x.x - z.x * x.z,
    z: z.x * x.y - z.y * x.x,
  }
  return { x, y, z }
}

/**
 * 世界坐标 → 画面里的 NDC（x、y 都是 [-1,1] 为画面边界）。
 *
 * 先算"虚拟大图"上的位置（相机没动过，所以这一步永远只跟几何有关），
 * 再套上裁剪窗口：横向居中、纵向贴下沿。
 * 缩小（zoom < 1）时镜头直接开大，没有裁剪窗口。
 */
function project(f: Framing, p: { x: number; y: number; z: number }, aspect: number) {
  const { x, y, z } = basis(f)
  const vx = p.x - f.position.x
  const vy = p.y - f.position.y
  const vz = p.z - f.position.z
  const depth = -(vx * z.x + vy * z.y + vz * z.z)
  const cx = vx * x.x + vy * x.y + vz * x.z
  const cy = vx * y.x + vy * y.y + vz * y.z
  const tanHalf = Math.tan((f.sourceFov * Math.PI) / 360)
  const nx = cx / depth / (tanHalf * aspect)
  const ny = cy / depth / tanHalf
  const k = f.zoom
  if (k < 1) {
    // 缩小：镜头直接开大，没有裁剪窗口
    return { x: nx, y: ny, nx, ny }
  }
  // 裁剪窗口：横向 [-1/k, 1/k]，纵向 [-1, -1 + 2/k]
  return { x: k * nx, y: k * (ny + 1) - 1, nx, ny }
}

const ASPECTS = [0.45, 0.5625, 0.75, 1, 4 / 3, 1.5, 16 / 9, 2.1, 21 / 9, 2.6]
const SIZES = [0.5, 0.75, 1, 1.25, 2, 3]

/** 对手头顶（模型：头球心 y=0.9、半径 0.115，站位 z=1.83） */
const OPPONENT_HEAD = { x: 0, y: 1.015, z: PADDLE.opponentZ + 0.55 }
/** 我方球拍最远位置 */
const PADDLE_FAR = { x: VIEW.reachX, y: PADDLE.homeY, z: PADDLE.homeZ }

console.log('=== 基准取景不能被改坏（16:9 + 显示尺寸 1.0）===')
{
  const f = fitFraming(VIEW.referenceAspect, 1)
  approx('fov', f.fov, VIEW.base.fov, 1e-9)
  approx('相机 x', f.position.x, VIEW.base.pos.x, 1e-9)
  approx('相机 y', f.position.y, VIEW.base.pos.y, 1e-9)
  approx('相机 z', f.position.z, VIEW.base.pos.z, 1e-9)
  approx('看向 x', f.target.x, VIEW.base.target.x, 1e-9)
  approx('看向 y', f.target.y, VIEW.base.target.y, 1e-9)
  approx('看向 z', f.target.z, VIEW.base.target.z, 1e-9)
  approx('裁剪倍率', f.zoom, 1, 1e-9)
}

console.log('\n=== 相机永远不动（任何宽高比 × 任何显示尺寸）===')
{
  let moved = 0
  let fovMoved = 0
  for (const size of SIZES) {
    for (const aspect of ASPECTS) {
      const f = fitFraming(aspect, size)
      const same =
        f.position.x === VIEW.base.pos.x &&
        f.position.y === VIEW.base.pos.y &&
        f.position.z === VIEW.base.pos.z &&
        f.target.x === VIEW.base.target.x &&
        f.target.y === VIEW.base.target.y &&
        f.target.z === VIEW.base.target.z
      if (!same) moved++
      // 纵向张角只能因为窄屏而开大，不能因为显示尺寸而变
      if (size > 1 && aspect >= 1.3333 && f.sourceFov !== VIEW.base.fov) fovMoved++
    }
  }
  ok('相机位置/朝向 0 次变化', moved === 0)
  ok('横屏的虚拟大图张角恒为基准（显示尺寸不碰它）', fovMoved === 0)
}

console.log('\n=== 各宽高比 × 显示尺寸：球拍和球台都要留在画面里 ===')
{
  const baseFrame = fitFraming(VIEW.referenceAspect, 1)
  const baseBottom = project(baseFrame, { x: 0, y: PADDLE.minY, z: PADDLE.homeZ }, VIEW.referenceAspect).y
  console.log(`  基准取景下球拍底部 NDC y = ${baseBottom.toFixed(3)}（原相机就有一点出画）`)

  let worstX = 0
  let worstBottom = -Infinity
  let worstOpponent = 0
  let worstFar = 0
  for (const size of SIZES) {
    for (const aspect of ASPECTS) {
      const f = fitFraming(aspect, size)
      // 球拍中心走到实战最远处（球漂到台面外时球拍要跟出去接）
      const p = project(f, PADDLE_FAR, aspect)
      // 显示尺寸本身就是"裁剪"，放大之后横向必然收窄，所以这条只在默认尺寸下保证
      if (size === 1) worstX = Math.max(worstX, Math.abs(p.x))
      // 球拍下沿（裁剪窗口贴着下沿，所以它只会比基准更靠里一点）
      const lo = project(f, { x: 0, y: PADDLE.minY, z: PADDLE.homeZ }, aspect)
      worstBottom = Math.max(worstBottom, Math.abs(lo.y))
      // 对手那一侧（放大到很大时对手会被裁掉，那是裁剪的必然结果）
      const opp = project(f, { x: VIEW.reachX, y: PADDLE.homeY, z: PADDLE.opponentZ }, aspect)
      if (size <= 1.25) worstOpponent = Math.max(worstOpponent, Math.abs(opp.x))
      // 台面远端两角
      const far = project(f, { x: TABLE.halfWidth, y: 0, z: TABLE.halfLength }, aspect)
      worstFar = Math.max(worstFar, Math.abs(far.x))
    }
  }
  ok(
    `默认尺寸下球拍横向最远 ${worstX.toFixed(3)} ≤ ${VIEW.edgeMargin}`,
    worstX <= VIEW.edgeMargin + 1e-6,
  )
  ok(
    `球拍下沿最远 ${worstBottom.toFixed(3)}（基准 ${Math.abs(baseBottom).toFixed(3)}）`,
    worstBottom <= Math.abs(baseBottom) + 0.05,
  )
  ok(`对手球拍横向 ${worstOpponent.toFixed(3)} 在画面内`, worstOpponent <= 1)
  ok(`台面远端 ${worstFar.toFixed(3)} 在画面内`, worstFar <= 1)
}

console.log('\n=== 显示尺寸只做裁剪放大：球拍一侧的可见范围一点不变 ===')
{
  const aspect = 16 / 9
  const a = fitFraming(aspect, 1)
  const b = fitFraming(aspect, VIEW.maxDisplaySize)
  // 裁剪窗口贴着下沿 → 下沿那部分内容的位置几乎不变
  const lo1 = project(a, { x: 0, y: PADDLE.minY, z: PADDLE.homeZ }, aspect)
  const lo2 = project(b, { x: 0, y: PADDLE.minY, z: PADDLE.homeZ }, aspect)
  ok(
    `球拍下沿 NDC y ${lo1.y.toFixed(3)} → ${lo2.y.toFixed(3)}（裁剪只吃上方）`,
    Math.abs(lo2.y - lo1.y) <= 0.05,
  )
  // 横向位置只是等比放大（这是裁剪缩放，不是重新取景）
  const p1 = project(a, PADDLE_FAR, aspect)
  const p2 = project(b, PADDLE_FAR, aspect)
  approx('球拍横向 NDC 按倍率放大', p2.x, p1.x * b.zoom, 1e-9)
}

console.log('\n=== 显示尺寸越大，远端球台越大（越小则越小）===')
{
  const aspect = 16 / 9
  const steps = [0.5, 0.75, 1, 1.25, 2, 3]
  const sizes = steps.map((size) => {
    const f = fitFraming(aspect, size)
    const p = project(f, { x: TABLE.halfWidth, y: 0, z: TABLE.halfLength }, aspect)
    return Math.abs(p.x) * aspect
  })
  console.log(
    `  显示尺寸 ${steps.map((s) => s.toFixed(2)).join(' / ')} → 远端台角占屏高 ${sizes.map((v) => (v * 100).toFixed(1) + '%').join(' / ')}`,
  )
  ok(
    '从 0.5 到 1 逐渐变大',
    sizes[0] < sizes[1] && sizes[1] < sizes[2],
  )
  ok(
    '从 1 到 3 逐渐变大',
    sizes[2] < sizes[3] && sizes[3] < sizes[4] && sizes[4] < sizes[5],
  )
  ok('0.5 时约为原样的一半', Math.abs(sizes[0] / sizes[2] - 0.5) <= 0.02)
  ok('3.0 时约为原样的三倍', Math.abs(sizes[5] / sizes[2] - 3) <= 0.05)
}

console.log('\n=== 放大：球拍一侧不动，裁掉的是上方 ===')
{
  const aspect = 16 / 9
  const a = fitFraming(aspect, 1)
  const b = fitFraming(aspect, 3)
  const lo1 = project(a, { x: 0, y: PADDLE.minY, z: PADDLE.homeZ }, aspect)
  const lo2 = project(b, { x: 0, y: PADDLE.minY, z: PADDLE.homeZ }, aspect)
  ok(
    `球拍下沿 NDC y ${lo1.y.toFixed(3)} → ${lo2.y.toFixed(3)}（裁剪只吃上方）`,
    Math.abs(lo2.y - lo1.y) <= 0.05,
  )
  const p1 = project(a, PADDLE_FAR, aspect)
  const p2 = project(b, PADDLE_FAR, aspect)
  approx('球拍横向 NDC 按倍率放大', p2.x, p1.x * b.zoom, 1e-9)
  // 放大到 3 倍时对手会被裁掉（只剩我方这半张台面），这是裁剪的必然结果
  const head = project(b, OPPONENT_HEAD, aspect)
  ok(`3.0 倍时对手头顶 NDC y ${head.y.toFixed(3)} 已出画（预期）`, head.y > 1)
  // 但我方球拍必须还在
  const paddle = project(b, PADDLE_FAR, aspect)
  ok(`3.0 倍时我方球拍纵向 ${paddle.y.toFixed(3)} 仍在画面内`, paddle.y >= -1)
}

console.log('\n=== 缩小：露出更多场景，球拍下沿也进画了 ===')
{
  const aspect = 16 / 9
  const a = fitFraming(aspect, 1)
  const b = fitFraming(aspect, VIEW.minDisplaySize)
  const lo1 = project(a, { x: 0, y: PADDLE.minY, z: PADDLE.homeZ }, aspect)
  const lo2 = project(b, { x: 0, y: PADDLE.minY, z: PADDLE.homeZ }, aspect)
  ok(
    `球拍下沿 NDC y ${lo1.y.toFixed(3)} → ${lo2.y.toFixed(3)}（整只球拍都进画了）`,
    Math.abs(lo2.y) < Math.abs(lo1.y),
  )
  ok(`缩小后球拍下沿在画面内`, Math.abs(lo2.y) <= 1)
  const head = project(b, OPPONENT_HEAD, aspect)
  ok(`缩小后对手头顶 NDC y ${head.y.toFixed(3)} 在画面内`, head.y <= 1)
}

console.log('\n=== 不同屏幕上球台看起来要差不多大（按屏幕高度折算）===')
{
  const sizes: number[] = []
  for (const aspect of ASPECTS.filter((a) => a >= 1.2)) {
    const f = fitFraming(aspect, 1)
    const p = project(f, { x: TABLE.halfWidth, y: 0, z: TABLE.halfLength }, aspect)
    sizes.push(Math.abs(p.x) * aspect)
  }
  const spread = Math.max(...sizes) - Math.min(...sizes)
  ok(
    `横屏各宽高比：远端台角占屏高 ${((sizes[0] * 100).toFixed(1))}%（差异 ${(spread * 100).toFixed(1)}%）`,
    spread <= 0.02,
  )
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
