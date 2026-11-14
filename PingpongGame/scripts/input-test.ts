/**
 * 输入映射回归测试。
 *
 * 这里锁死一条容易踩坑的约定：
 *
 *   相机朝 +Z（对手方向）看 → 世界 +X 显示在屏幕左边，+Y 在屏幕上方。
 *   所以"用户往右"对应世界 -X，"用户往上"对应世界 +Y。
 *
 * 以前映射没取反，导致按右键球拍反而往左跑。方向性 bug 很隐蔽
 * （物理、规则全都能跑对），所以用测试钉死。
 *
 * 运行： node --experimental-strip-types scripts/input-test.ts
 */

/** Node 里没有 window，这里给 KeyboardController 造一个最小可用的宿主 */
interface WindowStub {
  addEventListener(type: string, fn: (e: unknown) => void): void
  removeEventListener(type: string, fn: (e: unknown) => void): void
}

function installWindowStub(): {
  window: WindowStub
  dispatch(type: string, key: string): void
} {
  const handlers = new Map<string, Array<(e: unknown) => void>>()
  const window: WindowStub = {
    addEventListener(type, fn) {
      const list = handlers.get(type) ?? []
      list.push(fn)
      handlers.set(type, list)
    },
    removeEventListener(type, fn) {
      const list = handlers.get(type) ?? []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
  }
  ;(globalThis as unknown as { window: WindowStub }).window = window
  return {
    window,
    dispatch(type, key) {
      for (const fn of handlers.get(type) ?? []) fn({ key, repeat: false })
    },
  }
}

const { dispatch } = installWindowStub()

const { KeyboardController } = await import('../src/input/keyboard.ts')
const { MouseController, MOUSE_RANGE } = await import('../src/input/mouse.ts')
const { paddleTargetFromPose, SwingDetector } = await import('../src/input/swingDetector.ts')
import type { PoseFrame } from '../src/input/poseTracker.ts'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

let failures = 0

function approx(name: string, actual: number, expected: number, tol = 1e-6): void {
  const ok = Math.abs(actual - expected) <= tol
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  期望 ≈${expected}，实际 ${actual}`}`)
}

/** 按住某个键若干帧，返回球拍目标 */
function holdKey(key: string, frames = 30): { x: number } {
  const kb = new KeyboardController()
  kb.attach()
  dispatch('keydown', key)
  let target = { x: 0 }
  for (let i = 0; i < frames; i++) target = kb.update(1 / 60)
  dispatch('keyup', key)
  return target
}

console.log('=== 键盘映射 ===')
{
  const right = holdKey('ArrowRight')
  approx('ArrowRight → 世界 x 变小（屏幕往右）', right.x, -0.55, 0.02)

  const left = holdKey('ArrowLeft')
  approx('ArrowLeft → 世界 x 变大（屏幕往左）', left.x, 0.55, 0.02)

  const d = holdKey('d')
  approx('D 等同 ArrowRight', d.x, -0.55, 0.02)

  const a = holdKey('a')
  approx('A 等同 ArrowLeft', a.x, 0.55, 0.02)

  // 上下键不再控制球拍（高度由游戏自动跟随球）
  const up = holdKey('ArrowUp')
  approx('ArrowUp 不再移动球拍', up.x, 0, 1e-9)
  const down = holdKey('ArrowDown')
  approx('ArrowDown 不再移动球拍', down.x, 0, 1e-9)

  // 活动范围夹取
  const farRight = holdKey('ArrowRight', 120)
  approx('向右夹在活动范围内', farRight.x, -0.72, 1e-9)
}

console.log('\n=== 体感映射 ===')
{
  const frame = (bodyX: number, wristY: number): PoseFrame => ({
    hasPerson: true,
    bodyX,
    bodyScale: 0.25,
    leftArm: { x: bodyX, y: wristY, speed: 0, verticalRange: 0, source: 'wrist' },
    rightArm: { x: bodyX, y: wristY, speed: 0, verticalRange: 0, source: 'wrist' },
    fastest: { x: bodyX, y: wristY, speed: 0, verticalRange: 0, source: 'wrist' },
    timestamp: 0,
  })

  const RANGE = 0.66

  // bodyX 是镜像后的画面坐标：玩家往自己右手边走，bodyX 变大
  const leanRight = paddleTargetFromPose(frame(0.7, 0.5), RANGE)
  if (leanRight.x >= 0) failures++
  console.log(
    `  ${leanRight.x < 0 ? 'PASS' : 'FAIL'}  身体往右 → 世界 x 变小（球拍在屏幕右边）`,
  )

  const leanLeft = paddleTargetFromPose(frame(0.3, 0.5), RANGE)
  if (leanLeft.x <= 0) failures++
  console.log(
    `  ${leanLeft.x > 0 ? 'PASS' : 'FAIL'}  身体往左 → 世界 x 变大（球拍在屏幕左边）`,
  )

  // 绝对映射：零点 = 摄像头画面正中
  const center = paddleTargetFromPose(frame(0.5, 0.5), RANGE)
  approx('站在画面中心 → 球拍居中', center.x, 0, 1e-9)

  const leftSide = paddleTargetFromPose(frame(0.2, 0.5), RANGE)
  if (leftSide.x <= 0) failures++
  console.log(`  ${leftSide.x > 0 ? 'PASS' : 'FAIL'}  站在画面左边 → 球拍在屏幕左边`)

  // 活动区：参考中心左右各 22% 画面宽就能打满行程
  const fullLeft = paddleTargetFromPose(frame(0.5 - 0.22, 0.5), RANGE)
  approx('向左移动 22% 画面宽 → 球拍到最左端', fullLeft.x, RANGE, 1e-9)
  const fullRight = paddleTargetFromPose(frame(0.5 + 0.22, 0.5), RANGE)
  approx('向右移动 22% 画面宽 → 球拍到最右端', fullRight.x, -RANGE, 1e-9)

  // 手腕高度不再影响球拍（由游戏自动跟随球）
  const high = paddleTargetFromPose(frame(0.5, 0.15), RANGE)
  const low = paddleTargetFromPose(frame(0.5, 0.85), RANGE)
  approx('手腕高度不再影响球拍位置', high.x, low.x, 1e-9)

  // 越界保护
  const extreme = paddleTargetFromPose(frame(1.5, 0.5), RANGE)
  approx('超出画面时仍然夹在活动范围内', extreme.x, -RANGE, 1e-9)
}

console.log('\n=== 鼠标映射 ===')
{
  /** 给 MouseController 造一个最小可用的宿主 */
  const handlers = new Map<string, Array<(e: unknown) => void>>()
  const host = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      const list = handlers.get(type) ?? []
      list.push(fn)
      handlers.set(type, list)
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      const list = handlers.get(type) ?? []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    fire(type: string, event: unknown) {
      for (const fn of handlers.get(type) ?? []) fn(event)
    },
  }

  const WIDTH = 1000
  const mouse = new MouseController({ viewportWidth: () => WIDTH })
  mouse.attach(host, host)

  host.fire('mousemove', { clientX: WIDTH / 2 })
  approx('鼠标在屏幕中间 → 球拍居中', mouse.update().x, 0, 1e-9)

  host.fire('mousemove', { clientX: WIDTH })
  approx('鼠标在屏幕右边缘 → 世界 x 变小（屏幕往右）', mouse.update().x, -MOUSE_RANGE, 1e-9)

  host.fire('mousemove', { clientX: 0 })
  approx('鼠标在屏幕左边缘 → 世界 x 变大（屏幕往左）', mouse.update().x, MOUSE_RANGE, 1e-9)

  host.fire('mousemove', { clientX: WIDTH * 0.75 })
  approx('鼠标在 3/4 处 → 世界 x 为负', mouse.update().x, -MOUSE_RANGE * 0.5, 1e-9)

  // 左键点击 = 挥拍
  host.fire('mousedown', { button: 0 })
  if (!mouse.consumeSwing()) failures++
  console.log(`  ${mouse.consumeSwing() === false ? 'PASS' : 'FAIL'}  左键点击触发挥拍（且只触发一次）`)

  // 右键不挥拍
  host.fire('mousedown', { button: 2 })
  if (mouse.consumeSwing()) failures++
  console.log(`  ${mouse.consumeSwing() === false ? 'PASS' : 'FAIL'}  右键不触发挥拍`)
}

console.log('\n=== 挥拍检测 ===')
{
  const { wristMotion } = await import('../src/input/poseTracker.ts')
  const ASPECT = 4 / 3
  const SCALE = 0.25 // 人的肩宽占画面宽度的 1/4

  /**
   * 关键回归：真实挥拍是"快速下压 → 击球 → 随挥上提"。
   * 窗口里手腕首尾可能几乎重合，净位移≈0，
   * 用净位移算速度就永远触发不了（玩家反馈"一直挥不出去"）。
   * 改成累计路径长度后，一次完整引拍能被正确识别。
   */
  const stroke = [
    { t: 0, x: 0.5, y: 0.5 },
    { t: 50, x: 0.5, y: 0.62 },
    { t: 100, x: 0.5, y: 0.74 },
    { t: 150, x: 0.5, y: 0.62 },
  ]
  const motion = wristMotion(stroke, ASPECT, SCALE)
  const netDisp = Math.abs(stroke[stroke.length - 1].y - stroke[0].y)
  // 路径长度 0.48（画面宽度单位）÷ 肩宽 0.25 = 1.92 肩宽，÷ 0.15s = 12.8 肩宽/秒
  // 垂直跨度 0.24（画面高度）× 宽高比 1.333 = 0.32 画面宽度 ÷ 肩宽 0.25 = 1.28 肩宽
  approx('一次引拍的垂直跨度被记录下来', motion.verticalRange, 1.28, 1e-6)
  approx('路径速度按路径长度算（首尾几乎重合也算动过）', motion.speed, 12.8, 1e-6)
  if (motion.speed <= 0) failures++
  console.log(
    `  ${motion.speed > 0 && netDisp < 0.48 ? 'PASS' : 'FAIL'}  净位移很小（${netDisp.toFixed(
      2,
    )}）但路径速度不为 0 → 能识别出挥拍`,
  )

  // 关键：同样的物理动作，人离摄像头越远（画面里的位移按比例变小），数值应该一样。
  // 人站得远时肩宽在画面里也更小（0.25 → 0.12），动作在画面里也要等比缩小，
  // 这样换算成"肩宽/秒"之后才是同一个数，阈值才有意义。
  const farStroke = stroke.map((p) => ({
    t: p.t,
    x: p.x,
    y: 0.5 + (p.y - 0.5) * (0.12 / 0.25),
  }))
  const far = wristMotion(farStroke, ASPECT, 0.12)
  approx('人离摄像头远（肩宽小）时数值不变', far.speed, motion.speed, 1e-6)
  approx('人离摄像头远时垂直跨度同样不变', far.verticalRange, motion.verticalRange, 1e-6)

  // 静止：速度与垂直跨度都应为 0
  const still = wristMotion(
    [
      { t: 0, x: 0.5, y: 0.5 },
      { t: 100, x: 0.5, y: 0.5 },
    ],
    ASPECT,
    SCALE,
  )
  approx('静止时速度为 0', still.speed, 0, 1e-9)
  approx('静止时垂直跨度为 0', still.verticalRange, 0, 1e-9)

  /** 造一帧姿态数据 */
  const poseFrame = (speed: number, verticalRange: number): PoseFrame => ({
    hasPerson: true,
    bodyX: 0.5,
    bodyScale: SCALE,
    leftArm: { x: 0.5, y: 0.5, speed: 0, verticalRange: 0, source: 'wrist' },
    rightArm: { x: 0.5, y: 0.5, speed, verticalRange, source: 'wrist' },
    fastest: { x: 0.5, y: 0.5, speed, verticalRange, source: 'wrist' },
    timestamp: 0,
  })

  const detector = new SwingDetector({
    threshold: 2.5,
    verticalRange: 0.2,
    fullPowerScale: 3,
    cooldown: 0.42,
    releaseRatio: 0.55,
  })

  // 慢速小幅移动：不触发
  const calm = detector.process(poseFrame(1.0, 0.05), 1000)
  if (calm.swung) failures++
  console.log(`  ${calm.swung === false ? 'PASS' : 'FAIL'}  慢速小幅移动不触发挥拍`)

  // 速度够快：触发
  const fast = detector.process(poseFrame(4.0, 0.05), 2000)
  if (!fast.swung) failures++
  console.log(`  ${fast.swung ? 'PASS' : 'FAIL'}  快速挥动触发挥拍`)

  // 冷却期内不再触发
  const duringCooldown = detector.process(poseFrame(4.0, 0.05), 2200)
  if (duringCooldown.swung) failures++
  console.log(`  ${duringCooldown.swung === false ? 'PASS' : 'FAIL'}  冷却期内不重复触发`)

  // 冷却时间单位回归：now 是毫秒，cooldown 是秒。
  // 以前直接 now + cooldown（秒）当成毫秒用，冷却形同虚设，
  // 一次挥手会被识别成几十次挥拍。
  detector.process(poseFrame(1.0, 0.05), 2250) // 速度回落到阈值以下 → 重新武装
  const blockedByCooldown = detector.process(poseFrame(4.0, 0.05), 2300)
  if (blockedByCooldown.swung) failures++
  console.log(
    `  ${blockedByCooldown.swung === false ? 'PASS' : 'FAIL'}  冷却期内即使重新武装也不触发`,
  )

  // 速度没超线，但垂直位移够大（用户要的"垂直方向移动"判定）→ 触发
  detector.process(poseFrame(1.0, 0.05), 2600)
  const verticalOnly = detector.process(poseFrame(1.0, 0.5), 3000)
  if (!verticalOnly.swung) failures++
  console.log(`  ${verticalOnly.swung ? 'PASS' : 'FAIL'}  只有垂直位移够大也能触发挥拍`)
}

console.log('\n=== 关键点可见性（MediaPipe 的坑） ===')
{
  const {
    computePoseFrame,
    createArmHistories,
    LANDMARK,
  } = await import('../src/input/poseTracker.ts')

  const ASPECT = 4 / 3
  const lm = (x: number, y: number, visibility = 1): NormalizedLandmark => ({
    x,
    y,
    z: 0,
    visibility,
  })
  /** MediaPipe 对"没检测到"的关键点就是这样：坐标 (0,0)、visibility≈0 */
  const missing = (): NormalizedLandmark => lm(0, 0, 0)

  type Parts = {
    ls: NormalizedLandmark
    rs: NormalizedLandmark
    lh: NormalizedLandmark
    rh: NormalizedLandmark
    le: NormalizedLandmark
    re: NormalizedLandmark
    lw: NormalizedLandmark
    rw: NormalizedLandmark
  }

  const defaults = (): Parts => ({
    ls: lm(0.45, 0.35),
    rs: lm(0.55, 0.35),
    lh: lm(0.47, 0.7),
    rh: lm(0.53, 0.7),
    le: lm(0.4, 0.5),
    re: lm(0.6, 0.5),
    lw: lm(0.38, 0.62),
    rw: lm(0.62, 0.62),
  })

  function build(overrides: Partial<Parts> = {}): NormalizedLandmark[] {
    const p = { ...defaults(), ...overrides }
    const arr: NormalizedLandmark[] = new Array(33).fill(null).map(() => missing())
    arr[LANDMARK.LEFT_SHOULDER] = p.ls
    arr[LANDMARK.RIGHT_SHOULDER] = p.rs
    arr[LANDMARK.LEFT_HIP] = p.lh
    arr[LANDMARK.RIGHT_HIP] = p.rh
    arr[LANDMARK.LEFT_ELBOW] = p.le
    arr[LANDMARK.RIGHT_ELBOW] = p.re
    arr[LANDMARK.LEFT_WRIST] = p.lw
    arr[LANDMARK.RIGHT_WRIST] = p.rw
    return arr
  }

  // —— 身体位置：双肩连线的中点（用户要的就是这个点）——
  const f1 = computePoseFrame(build(), 1000, ASPECT, createArmHistories())
  approx('双肩可见 → 身体位置 = 双肩连线中点', f1.bodyX, 0.5, 1e-9)

  const f1b = computePoseFrame(
    build({ ls: lm(0.2, 0.35), rs: lm(0.4, 0.35) }),
    1000,
    ASPECT,
    createArmHistories(),
  )
  approx('身体偏左 → 身体位置跟随（镜像后 0.7）', f1b.bodyX, 0.7, 1e-9)

  // —— 关键回归：以前不检查 visibility ——
  // 肩膀"没检测到"时坐标是 (0,0)，中点算成 0 → 身体位置变成画面最边上，
  // 球拍被钉死在边角：站在画面正中间也不会回到中间。
  const f2 = computePoseFrame(
    build({
      ls: missing(),
      rs: missing(),
      lh: lm(0.25, 0.7),
      rh: lm(0.35, 0.7),
    }),
    1000,
    ASPECT,
    createArmHistories(),
  )
  approx('肩膀没检测到 → 退到髋部中点', f2.bodyX, 0.7, 1e-9)

  const f3 = computePoseFrame(
    build({ ls: missing(), rs: missing(), lh: missing(), rh: missing() }),
    1000,
    ASPECT,
    createArmHistories(),
  )
  if (f3.hasPerson) failures++
  console.log(
    `  ${f3.hasPerson === false ? 'PASS' : 'FAIL'}  肩膀和髋部都没检测到 → 不当作"人在画面里"`,
  )
  approx('位置未知时身体坐标回到画面中心', f3.bodyX, 0.5, 1e-9)
  if (f3.bodyX > 0.9 || f3.bodyX < 0.1) failures++
  console.log(
    `  ${f3.bodyX <= 0.9 && f3.bodyX >= 0.1 ? 'PASS' : 'FAIL'}  没检测到人时球拍不会被钉在边角`,
  )

  // —— 手腕没检测到：不该产生采样（以前是 (0,0) 常驻 → 速度恒为 0）——
  const f4 = computePoseFrame(
    build({
      lw: missing(),
      rw: missing(),
      le: missing(),
      re: missing(),
    }),
    1000,
    ASPECT,
    createArmHistories(),
  )
  if (f4.fastest !== null) failures++
  console.log(
    `  ${f4.fastest === null ? 'PASS' : 'FAIL'}  手腕和肘部都没检测到 → 没有采样（挥拍速度为 0）`,
  )

  // —— 手腕没检测到、肘部还在 → 用肘部兜底 ——
  const f5 = computePoseFrame(
    build({ lw: missing(), rw: missing() }),
    1000,
    ASPECT,
    createArmHistories(),
  )
  if (f5.fastest?.source !== 'elbow') failures++
  console.log(
    `  ${f5.fastest?.source === 'elbow' ? 'PASS' : 'FAIL'}  手腕没检测到 → 自动改用肘部兜底`,
  )

  // —— 丢帧不清历史 ——
  const h6 = createArmHistories()
  computePoseFrame(build(), 1000, ASPECT, h6)
  computePoseFrame(
    build({ lw: missing(), rw: missing(), le: missing(), re: missing() }),
    1030,
    ASPECT,
    h6,
  )
  const f6 = computePoseFrame(
    build({ lw: lm(0.3, 0.5), rw: lm(0.7, 0.5) }),
    1060,
    ASPECT,
    h6,
  )
  if (!(f6.fastest && f6.fastest.speed > 0)) failures++
  console.log(
    `  ${f6.fastest && f6.fastest.speed > 0 ? 'PASS' : 'FAIL'}  手腕偶尔丢帧不会清空运动历史`,
  )
}

console.log('\n=== 速度窗口（毫秒 vs 秒） ===')
{
  const { computePoseFrame, createArmHistories, LANDMARK } = await import(
    '../src/input/poseTracker.ts'
  )

  const ASPECT = 4 / 3
  const lm = (x: number, y: number, visibility = 1): NormalizedLandmark => ({
    x,
    y,
    z: 0,
    visibility,
  })

  /** 只有肩膀可见（没有髋部）→ bodyScale 就是肩宽 0.1，方便对数 */
  function build(wristY: number): NormalizedLandmark[] {
    const arr: NormalizedLandmark[] = new Array(33).fill(null).map(() => lm(0, 0, 0))
    arr[LANDMARK.LEFT_SHOULDER] = lm(0.45, 0.35)
    arr[LANDMARK.RIGHT_SHOULDER] = lm(0.55, 0.35)
    arr[LANDMARK.LEFT_WRIST] = lm(0.5, wristY)
    arr[LANDMARK.RIGHT_WRIST] = lm(0.5, wristY)
    return arr
  }

  const histories = createArmHistories()

  // 关键回归：历史点的时间戳是毫秒，窗口却是秒。
  // 以前直接拿毫秒差比 0.18 → 每帧只剩最后一个点 → 挥拍速度恒为 0。
  computePoseFrame(build(0.5), 1000, ASPECT, histories)
  computePoseFrame(build(0.54), 1050, ASPECT, histories)
  const third = computePoseFrame(build(0.58), 1100, ASPECT, histories)

  // 路径 0.08 画面高 × 宽高比 1.333 = 0.1067 肩宽单位 ÷ 肩宽 0.1 ÷ 0.1s = 10.67
  approx('180ms 窗口里的运动量能累积起来', third.fastest?.speed ?? 0, 10.667, 0.01)

  // 超过窗口（180ms）的旧点要被丢掉
  const expired = computePoseFrame(build(0.58), 1300, ASPECT, histories)
  approx('窗口过期后旧点被清掉', expired.fastest?.speed ?? -1, 0, 1e-9)

  // 手腕消失很久又回来：坐标跳变不能算成速度（否则会凭空触发一次挥拍）
  const h7 = createArmHistories()
  computePoseFrame(build(0.5), 5000, ASPECT, h7)
  computePoseFrame(build(0.5), 5200, ASPECT, h7)
  const jumped = computePoseFrame(build(0.9), 5400, ASPECT, h7)
  approx('采样点断档后重新开始记（跳变不算速度）', jumped.fastest?.speed ?? -1, 0, 1e-9)
}

console.log('\n=== 肘部兜底的判定 ===')
{
  const detector = new SwingDetector({
    threshold: 2.5,
    verticalRange: 0.2,
    fullPowerScale: 3,
    cooldown: 0.42,
    releaseRatio: 0.55,
    elbowRatio: 0.6,
  })

  const withSource = (speed: number, source: 'wrist' | 'elbow'): PoseFrame => ({
    hasPerson: true,
    bodyX: 0.5,
    bodyScale: 0.25,
    leftArm: { x: 0.5, y: 0.5, speed, verticalRange: 0.05, source },
    rightArm: { x: 0.5, y: 0.5, speed, verticalRange: 0.05, source },
    fastest: { x: 0.5, y: 0.5, speed, verticalRange: 0.05, source },
    timestamp: 0,
  })

  // 2.0 肩宽/秒：按手腕阈值（2.5）不够，按肘部阈值（2.5×0.6=1.5）够
  const wrist = detector.process(withSource(2.0, 'wrist'), 1000)
  if (wrist.swung) failures++
  console.log(`  ${wrist.swung === false ? 'PASS' : 'FAIL'}  2.0 肩宽/秒达不到手腕阈值`)

  const elbow = detector.process(withSource(2.0, 'elbow'), 2000)
  if (!elbow.swung) failures++
  console.log(`  ${elbow.swung ? 'PASS' : 'FAIL'}  肘部兜底时阈值放宽，同样幅度能挥出去`)

  // 没有采样 → 永远不触发
  const none: PoseFrame = {
    hasPerson: false,
    bodyX: 0.5,
    bodyScale: 0.25,
    leftArm: null,
    rightArm: null,
    fastest: null,
    timestamp: 0,
  }
  const empty = detector.process(none, 5000)
  if (empty.swung) failures++
  console.log(`  ${empty.swung === false ? 'PASS' : 'FAIL'}  没有手臂采样时不会误触发挥拍`)
}

console.log('\n=== 左右手选择 ===')
{
  const { pickArmSample } = await import('../src/input/swingDetector.ts')

  /** 两只手各有各的速度 */
  const twoHands = (leftSpeed: number, rightSpeed: number): PoseFrame => ({
    hasPerson: true,
    bodyX: 0.5,
    bodyScale: 0.25,
    leftArm: { x: 0.4, y: 0.5, speed: leftSpeed, verticalRange: 0.05, source: 'wrist' },
    rightArm: { x: 0.6, y: 0.5, speed: rightSpeed, verticalRange: 0.05, source: 'wrist' },
    fastest: {
      x: 0.5,
      y: 0.5,
      speed: Math.max(leftSpeed, rightSpeed),
      verticalRange: 0.05,
      source: 'wrist',
    },
    timestamp: 0,
  })

  approx('选左手 → 取左手的速度', pickArmSample(twoHands(1, 5), 'left')?.speed ?? 0, 1, 1e-9)
  approx('选右手 → 取右手的速度', pickArmSample(twoHands(1, 5), 'right')?.speed ?? 0, 5, 1e-9)
  approx('选双手 → 取动得更厉害的那只', pickArmSample(twoHands(1, 5), 'both')?.speed ?? 0, 5, 1e-9)

  const makeDetector = (hand: 'left' | 'right' | 'both') =>
    new SwingDetector({
      threshold: 2.5,
      verticalRange: 0.2,
      fullPowerScale: 3,
      cooldown: 0.42,
      releaseRatio: 0.55,
      hand,
    })

  // 惯用左手：右手在画面里乱动也不该触发
  const onlyRight = makeDetector('left').process(twoHands(0, 6), 1000)
  if (onlyRight.swung) failures++
  console.log(`  ${onlyRight.swung === false ? 'PASS' : 'FAIL'}  选左手时右手挥动不触发`)

  const onlyLeft = makeDetector('left').process(twoHands(6, 0), 1000)
  if (!onlyLeft.swung) failures++
  console.log(`  ${onlyLeft.swung ? 'PASS' : 'FAIL'}  选左手时左手挥动能触发`)

  const rightOnly = makeDetector('right').process(twoHands(0, 6), 1000)
  if (!rightOnly.swung) failures++
  console.log(`  ${rightOnly.swung ? 'PASS' : 'FAIL'}  选右手时右手挥动能触发`)

  const either = makeDetector('both').process(twoHands(0, 6), 1000)
  if (!either.swung) failures++
  console.log(`  ${either.swung ? 'PASS' : 'FAIL'}  选双手时哪只手挥动都能触发`)
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
