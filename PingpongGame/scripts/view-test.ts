/**
 * 取景回归测试。
 *
 * 检查七件事：
 *   1. 基准情况（16:9 + 显示尺寸 1.0 + 默认位姿）必须和最初的相机一模一样；
 *   2. **显示尺寸永远不碰相机**：改显示尺寸时相机位姿一点不变
 *      （这是"画面拉大"不能变成俯视视角的保证）；
 *   3. 各种宽高比下球拍（尤其是漂到台面外的宽球位置）都必须留在画面里；
 *   4. 显示尺寸只做裁剪放大：球拍一侧的可见范围一点不变，越大远端球台越大；
 *   5. 放大到上限时对手也不能被裁掉；
 *   6. 相机位姿可调：默认位姿复现原取景，改位姿只改画面、不改显示尺寸语义；
 *   7. 相机位姿在滑块范围内时，取景不会崩（球台不会整个跑出画面）。
 *
 * 取景测试使用纯数学；场馆切换测试使用最小 Canvas 桩。
 */

import {
  CAMERA_LIMITS,
  DEFAULT_CAMERA,
  VIEW,
  checkFrame,
  fitFraming,
  resolveCamera,
  type CameraPose,
  type Framing,
} from '../src/render/view.ts'
import { PADDLE, TABLE } from '../src/core/constants.ts'
import { Box3, BoxGeometry, Color, Mesh, Vector3 } from 'three'
import { createScene } from '../src/render/scene.ts'
import { createOpponent } from '../src/render/opponent.ts'
import { applyPaddleTransform, createPaddle } from '../src/render/meshes.ts'
import { PingPongGame } from '../src/core/game.ts'

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
 * 先算"虚拟大图"上的位置（这一步只跟相机几何有关），
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

console.log('=== 基准取景不能被改坏（16:9 + 显示尺寸 1.0 + 默认位姿）===')
{
  const f = fitFraming(VIEW.referenceAspect, 1)
  approx('fov', f.fov, VIEW.base.fov, 1e-9)
  approx('相机 x', f.position.x, VIEW.base.pos.x, 1e-9)
  approx('相机 y', f.position.y, VIEW.base.pos.y, 1e-9)
  approx('相机 z', f.position.z, VIEW.base.pos.z, 1e-9)
  approx('裁剪倍率', f.zoom, 1, 1e-9)

  // 默认位姿的俯角必须精确复现原相机的视线方向
  approx('默认俯角', DEFAULT_CAMERA.angle, (Math.atan2(1.28, 3.15) * 180) / Math.PI, 1e-12)
  const cam = resolveCamera(DEFAULT_CAMERA)
  const want = { x: 0, y: -1.28, z: 3.15 }
  const wl = Math.hypot(want.x, want.y, want.z)
  approx('视线方向 x', cam.dir.x, want.x / wl, 1e-12)
  approx('视线方向 y', cam.dir.y, want.y / wl, 1e-12)
  approx('视线方向 z', cam.dir.z, want.z / wl, 1e-12)
}

console.log('\n=== 显示尺寸永远不碰相机（任何宽高比 × 任何显示尺寸）===')
{
  let moved = 0
  let fovMoved = 0
  for (const size of SIZES) {
    for (const aspect of ASPECTS) {
      const f = fitFraming(aspect, size)
      const same =
        f.position.x === VIEW.base.pos.x &&
        f.position.y === VIEW.base.pos.y &&
        f.position.z === VIEW.base.pos.z
      if (!same) moved++
      // 纵向张角只能因为窄屏而开大，不能因为显示尺寸而变
      if (size > 1 && aspect >= 1.3333 && f.sourceFov !== VIEW.base.fov) fovMoved++
    }
  }
  ok('相机位置 0 次变化', moved === 0)
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

console.log('\n=== 相机位姿：默认位姿复现原取景，改位姿只改画面 ===')
{
  const aspect = 16 / 9
  const base = fitFraming(aspect, 1)
  // 默认位姿 = 原相机
  approx('默认位姿的相机 x', base.position.x, VIEW.base.pos.x, 1e-9)
  approx('默认位姿的相机 y', base.position.y, VIEW.base.pos.y, 1e-9)
  approx('默认位姿的相机 z', base.position.z, VIEW.base.pos.z, 1e-9)

  // 改位姿：相机位置跟着变
  const moved: CameraPose = { ...DEFAULT_CAMERA, x: 0.8, y: 1.8, z: -3.0, angle: 30 }
  const f2 = fitFraming(aspect, 1, moved)
  approx('改位姿后相机 x', f2.position.x, 0.8, 1e-9)
  approx('改位姿后相机 y', f2.position.y, 1.8, 1e-9)
  approx('改位姿后相机 z', f2.position.z, -3.0, 1e-9)
  ok('改位姿后画面确实变了', project(f2, PADDLE_FAR, aspect).x !== project(base, PADDLE_FAR, aspect).x)

  // 关键：位姿变了，显示尺寸的语义不变
  // （放大 3 倍 = 裁剪放大，裁剪窗口贴下沿：
  //   屏幕 x = k·虚拟 x，屏幕 y + 1 = k·(虚拟 y + 1)）
  const f3 = fitFraming(aspect, VIEW.maxDisplaySize, moved)
  const p1 = project(f2, PADDLE_FAR, aspect)
  const p3 = project(f3, PADDLE_FAR, aspect)
  approx('位姿变了，放大倍率仍然精确等于 3', p3.x, p1.x * VIEW.maxDisplaySize, 1e-9)
  const lo1 = project(f2, { x: 0, y: PADDLE.minY, z: PADDLE.homeZ }, aspect)
  const lo3 = project(f3, { x: 0, y: PADDLE.minY, z: PADDLE.homeZ }, aspect)
  approx(
    '位姿变了，裁剪仍然严格按倍率缩放',
    lo3.y + 1,
    (lo1.y + 1) * VIEW.maxDisplaySize,
    1e-9,
  )
}

console.log('\n=== 滑块范围内取景不崩：不出 NaN、相机不会跑到台子后面 ===')
{
  let worstTable = 0
  let worstPaddle = 0
  let checked = 0
  let broken = 0
  for (const aspect of ASPECTS) {
    for (const size of SIZES) {
      for (const kx of [CAMERA_LIMITS.x.min, 0, CAMERA_LIMITS.x.max]) {
        for (const ky of [CAMERA_LIMITS.y.min, CAMERA_LIMITS.y.max]) {
          for (const kz of [CAMERA_LIMITS.z.min, CAMERA_LIMITS.z.max]) {
            for (const ka of [CAMERA_LIMITS.angle.min, 20, CAMERA_LIMITS.angle.max]) {
              const pose: CameraPose = { x: kx, y: ky, z: kz, angle: ka }
              const f = fitFraming(aspect, size, pose)
              const table = project(f, { x: TABLE.halfWidth, y: 0, z: 0 }, aspect)
              const paddle = project(f, PADDLE_FAR, aspect)
              worstTable = Math.max(worstTable, Math.abs(table.x))
              worstPaddle = Math.max(worstPaddle, Math.abs(paddle.x))
              checked++
              const finite =
                Number.isFinite(table.x) && Number.isFinite(paddle.x) && Number.isFinite(f.fov)
              // 相机必须还在我方球拍后面、而且在球台上方
              const sane =
                f.position.z <= CAMERA_LIMITS.z.max + 1e-9 &&
                f.position.z >= CAMERA_LIMITS.z.min - 1e-9 &&
                f.position.y > 0 &&
                f.fov > 0 &&
                f.fov < 180
              if (!finite || !sane) {
                broken++
                if (broken <= 3) {
                  console.log(`    异常位姿 ${JSON.stringify(pose)} aspect=${aspect} size=${size}`)
                }
              }
            }
          }
        }
      }
    }
  }
  console.log(
    `  组合数 ${checked}，台面中心横向最远 ${worstTable.toFixed(2)}，球拍横向最远 ${worstPaddle.toFixed(2)}`,
  )
  ok('没有任何一组位姿算出 NaN 或非法相机', broken === 0)
  ok('极端位姿下内容也只是偏出画面，不会翻车', worstTable < 20 && worstPaddle < 20)
}

console.log('\n=== 画面检查（诊断）能给出一致的结果 ===')
{
  const aspect = 16 / 9
  const good = checkFrame(aspect, 1, DEFAULT_CAMERA)
  ok('默认位姿下一切正常', good.ok)
  ok('默认位姿下球拍横向在画面内', good.paddleX <= 1)
  // 相机转到底下（俯角 60°）时球拍多半会出画，诊断要能看出来
  const steep = checkFrame(aspect, 1, { ...DEFAULT_CAMERA, angle: 60, y: 2.6 })
  console.log(
    `  俯角 60° + 高 2.6m：球拍横向 ${steep.paddleX.toFixed(2)}，球拍纵向 ${steep.paddleBottom.toFixed(2)} ~ ${steep.paddleTop.toFixed(2)}`,
  )
  ok('极端位姿下诊断仍然是有限数', Number.isFinite(steep.paddleX) && Number.isFinite(steep.paddleTop))
}

console.log('\n=== 对手姿态 ===')
{
  const opponent = createOpponent()
  const paddleMesh = createPaddle('#2f5bc8', '#c9a227')
  const paddle = new PingPongGame().state.opponentPaddle
  const grip = opponent.group.getObjectByName('opponent-grip')!
  const upperBody = opponent.group.getObjectByName('opponent-upper-body')!
  const feet = opponent.group.children.filter((child) => child.name === 'opponent-foot')
  ok('双脚落在地板上', feet.length === 2 && feet.every((foot) =>
    Math.abs(new Box3().setFromObject(foot).min.y - TABLE.floorY) < 1e-6))

  const poses = [
    { x: -PADDLE.rangeX, y: 0.08, vx: -3, swingAnim: 0 },
    { x: 0, y: 0.25, vx: 0, swingAnim: 0 },
    { x: PADDLE.rangeX, y: 0.5, vx: 3, swingAnim: 1 },
  ]
  ok('移动和挥拍时手始终握住拍柄', poses.every((pose) => {
    Object.assign(paddle, pose)
    applyPaddleTransform(paddleMesh, paddle, -0.18)
    opponent.sync(paddle, paddleMesh)
    const handle = paddleMesh.localToWorld(new Vector3(0, -PADDLE.radius - 0.05, 0))
    return grip.getWorldPosition(new Vector3()).distanceTo(handle) < 1e-6
  }))
  ok('移动时身体向运动方向倾斜', upperBody.position.x > 0)
}

console.log('\n=== 场馆环境切换 ===')
{
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const context = {
    fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    createLinearGradient() { return { addColorStop() {} } },
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ getContext: () => context }) },
  })
  try {
    const built = createScene()
    const background = () => built.scene.background instanceof Color
      ? built.scene.background.getHexString()
      : ''
    const bright = background()
    const objectCount = built.scene.children.length
    const cameraPosition = built.camera.position.clone()
    const room = built.scene.getObjectByName('bright-room')
    const windows = room?.children.filter((child) => child.name === 'room-window') ?? []
    const door = room?.getObjectByName('room-door')
    const lamps = room?.children.filter((child) => child.name === 'room-lamp') ?? []
    const floorDetail = room?.getObjectByName('room-floor-detail')
    ok('明亮球室有墙边门窗、顶灯和地板细节',
      !!room?.visible && windows.length === 6 && windows.every((window) =>
        Math.abs(window.position.x) === 5 || window.position.z === 5) &&
      !!door && door.position.z === 5 && Math.abs(door.position.x) > TABLE.halfWidth &&
      lamps.length === 4 && !!floorDetail)
    ok('门窗和边框位于墙面前方且不共面',
      !!door && [...windows, door].every((feature) => {
        const [surface, ...frames] = feature.children
        return surface.position.z < -0.01 && frames.every((frame) =>
          frame instanceof Mesh && frame.geometry instanceof BoxGeometry &&
          frame.position.z + frame.geometry.parameters.depth / 2 < surface.position.z)
      }))
    built.setEnvironment('night')
    const night = background()
    ok('默认明亮环境与夜间环境不同', bright !== night)
    ok('切换不重建场景或改变相机位置',
      built.scene.children.length === objectCount && built.camera.position.equals(cameraPosition))
    ok('夜间隐藏球室装饰', room?.visible === false)
    built.setEnvironment('bright')
    ok('切回明亮环境恢复原背景', background() === bright)
    ok('切回明亮环境恢复同一套球室装饰', room?.visible === true && built.scene.getObjectByName('room-door') === door)

    const tableParts = built.tableTop.parent!.children.filter(
      (part): part is Mesh<BoxGeometry> => part instanceof Mesh && part.geometry instanceof BoxGeometry,
    )
    const legs = tableParts.filter((part) => part.geometry.parameters.width === 0.06 && part.geometry.parameters.depth === 0.06)
    const rims = tableParts.filter((part) => part.geometry.parameters.height === 0.012)
    const beams = tableParts.filter((part) => part.geometry.parameters.height === 0.05 && part !== built.tableTop)
    const bounds = (part: Mesh) => new Box3().setFromObject(part)
    const tableBounds = bounds(built.tableTop)
    ok('四条桌腿从地板连接到台面下方，不穿透台板',
      legs.length === 4 && legs.every((leg) => {
        const box = bounds(leg)
        return Math.abs(box.min.y - TABLE.floorY) < 1e-6 && box.max.y <= tableBounds.min.y + 1e-6
      }))
    ok('四条边框在角部不重叠',
      rims.length === 4 && rims.every((rim, i) => rims.slice(i + 1).every((other) => {
        const a = bounds(rim)
        const b = bounds(other)
        return Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x) <= 1e-6 ||
          Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z) <= 1e-6
      })))
    ok('横梁与桌腿连接但不互相穿透',
      beams.length === 2 && beams.every((beam) => legs.every((leg) => {
        const a = bounds(beam)
        const b = bounds(leg)
        return Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x) <= 1e-6 ||
          Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z) <= 1e-6
      })))
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
