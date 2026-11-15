import * as THREE from 'three'
import { BALL, PADDLE, TABLE } from '../core/constants.ts'
import type { Paddle } from '../core/types.ts'
import { clamp } from '../core/vec3.ts'

/** 球拍：拍面圆盘 + 拍柄 */
export function createPaddle(bladeColor: string, handleColor: string): THREE.Group {
  const group = new THREE.Group()

  const blade = new THREE.Mesh(
    new THREE.CylinderGeometry(PADDLE.radius, PADDLE.radius, PADDLE.thickness, 36),
    new THREE.MeshStandardMaterial({ color: bladeColor, roughness: 0.45, metalness: 0.05 }),
  )
  // 圆柱默认沿 Y 轴，转成沿 Z 轴（拍面朝向对手）
  blade.rotation.x = Math.PI / 2
  blade.castShadow = true
  group.add(blade)

  // 拍面正面的黑胶皮
  const rubber = new THREE.Mesh(
    new THREE.CylinderGeometry(PADDLE.radius * 0.96, PADDLE.radius * 0.96, PADDLE.thickness * 0.55, 36),
    new THREE.MeshStandardMaterial({ color: '#1a1a1e', roughness: 0.85 }),
  )
  rubber.rotation.x = Math.PI / 2
  rubber.position.z = -PADDLE.thickness * 0.28
  group.add(rubber)

  // 拍柄
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.019, 0.115, 14),
    new THREE.MeshStandardMaterial({ color: handleColor, roughness: 0.7 }),
  )
  handle.position.y = -PADDLE.radius - 0.05
  handle.castShadow = true
  group.add(handle)

  return group
}

/** 乒乓球 */
export function createBall(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL.radius, 28, 20),
    new THREE.MeshStandardMaterial({
      color: '#fff8e7',
      roughness: 0.35,
      metalness: 0,
      emissive: '#5a4a20',
      emissiveIntensity: 0.12,
    }),
  )
  mesh.castShadow = true
  return mesh
}

/**
 * 把球拍状态同步到 3D 物体上。
 *
 * swingAnim 从 1 衰减到 0 表示"刚刚挥出"，这段期间拍面会向前探并向下压，
 * 模拟真实的下压式挥拍动作。
 */
export function applyPaddleTransform(
  mesh: THREE.Group,
  paddle: Paddle,
  /** 挥拍时向前的探出距离 */
  swingReach = 0.18,
): void {
  const swing = paddle.swingAnim
  const ease = swing * swing

  mesh.position.set(
    paddle.x,
    paddle.y,
    paddle.z + ease * swingReach,
  )

  // 拍面朝向对手（-Z 方向），挥拍时向下压并前倾
  mesh.rotation.set(
    -0.15 + ease * 0.85,
    0,
    Math.max(-0.5, Math.min(0.5, paddle.vx * 0.06)),
  )
}

// ---------------------------------------------------------------- 对手人形

/** 对手情绪：待机 / 得意（对手得分）/ 沮丧（玩家得分） */
export type OpponentMood = 'idle' | 'happy' | 'sad'

const UP_Y = new THREE.Vector3(0, 1, 0)

/** 把一个"沿 Y 轴的胶囊/圆柱"摆到 from → to 之间（中点定位 + 朝向） */
function orientSegment(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3): void {
  const dir = new THREE.Vector3().subVectors(to, from)
  const len = dir.length()
  if (len > 1e-6) dir.divideScalar(len)
  mesh.position.copy(from).addScaledVector(dir, len / 2)
  mesh.quaternion.setFromUnitVectors(UP_Y, dir)
}

/** 两点之间摆一根带关节重叠的胶囊（四肢用） */
function capsuleBetween(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const len = from.distanceTo(to)
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, Math.max(len - radius * 0.4, 0.02), 6, 12),
    material,
  )
  orientSegment(mesh, from, to)
  return mesh
}

/**
 * 两段骨骼 IK（肩 → 肘 → 手）。
 *
 * 目标超出臂长时夹紧到可达范围（手朝拍子方向伸直），
 * 肘部方向由极向量（身体外侧 + 下方）决定，避免肘部反折。
 */
function solveArmIK(
  shoulder: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
): { elbow: THREE.Vector3; hand: THREE.Vector3 } {
  const toTarget = new THREE.Vector3().subVectors(target, shoulder)
  const dRaw = toTarget.length()
  const d = clamp(dRaw, Math.abs(l1 - l2) + 0.02, (l1 + l2) * 0.985)
  const dir =
    dRaw > 1e-6 ? toTarget.divideScalar(dRaw) : new THREE.Vector3(0, -1, 0)

  // 余弦定理求肩关节偏转角
  const cosA = (d * d + l1 * l1 - l2 * l2) / (2 * d * l1)
  const a = Math.acos(clamp(cosA, -1, 1))

  // 极向量：肘往"外侧 + 下方"顶，像真人持拍手
  const pole = new THREE.Vector3(0.7, -1, 0.15).normalize()
  const axis = new THREE.Vector3().crossVectors(dir, pole)
  if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0)
  axis.normalize()

  // 绕 axis 转 +a 或 -a，选让肘部更贴近极向量的那一个
  const upperA = dir.clone().applyAxisAngle(axis, a)
  const upperB = dir.clone().applyAxisAngle(axis, -a)
  const upper = upperA.dot(pole) > upperB.dot(pole) ? upperA : upperB

  return {
    elbow: upper.multiplyScalar(l1).add(shoulder),
    hand: dir.multiplyScalar(d).add(shoulder),
  }
}

/**
 * 对手人形（程序化拼装的运动员造型）。
 *
 * - 比例接近真人：站在**地板**上（以前的版本飘在台面高度，还没有腿）；
 * - 持拍手臂用两段 IK 追着拍面走，身体带阻尼跟随（像人在滑步）；
 * - 有待机呼吸、随移动重心侧倾、挥拍前探、盯球转头；
 * - 得失分有情绪动画：得分欢呼（举臂 + 小跳）、失分沮丧（塌腰 + 低头）。
 *
 * 球拍仍然是独立的 mesh（由 applyPaddleTransform 摆位），
 * 手掌 IK 到拍面附近，两者视觉上刚好衔接。
 */
export class OpponentRig {
  readonly group = new THREE.Group()

  private torsoPivot = new THREE.Group()
  private headPivot = new THREE.Group()
  private leftArmPivot = new THREE.Group()
  private upperArm: THREE.Mesh
  private foreArm: THREE.Mesh
  private handMesh: THREE.Mesh

  private time = 0
  private mood: OpponentMood = 'idle'
  private moodTimer = 0
  private leanSmoothed = 0
  private leftArmRaise = 0

  /** 复用的临时向量，避免每帧分配 */
  private tmpShoulder = new THREE.Vector3()
  private tmpTarget = new THREE.Vector3()

  constructor() {
    const skin = new THREE.MeshStandardMaterial({ color: '#e2ab7e', roughness: 0.8 })
    const jersey = new THREE.MeshStandardMaterial({ color: '#2f5bc8', roughness: 0.72 })
    const jerseyDark = new THREE.MeshStandardMaterial({ color: '#23407f', roughness: 0.72 })
    const shortsMat = new THREE.MeshStandardMaterial({ color: '#1c2c50', roughness: 0.8 })
    const hairMat = new THREE.MeshStandardMaterial({ color: '#20232b', roughness: 0.9 })
    const white = new THREE.MeshStandardMaterial({ color: '#e8ecf4', roughness: 0.5 })
    const shoeMat = new THREE.MeshStandardMaterial({ color: '#dfe6f2', roughness: 0.55 })
    const dark = new THREE.MeshStandardMaterial({ color: '#23262b', roughness: 0.6 })

    // —— 腿（A 字站位）+ 球鞋 ——
    for (const sx of [-1, 1]) {
      const hip = new THREE.Vector3(sx * 0.085, 0.88, 0.01)
      const foot = new THREE.Vector3(sx * 0.16, 0.1, -0.03)
      this.group.add(capsuleBetween(hip, foot, 0.062, jerseyDark))

      const shoe = new THREE.Mesh(new THREE.CapsuleGeometry(0.042, 0.1, 4, 10), shoeMat)
      shoe.rotation.x = Math.PI / 2
      shoe.position.set(sx * 0.16, 0.05, -0.07)
      this.group.add(shoe)
    }

    // —— 躯干（以髋为轴心，方便做前倾 / 侧倾 / 塌腰）——
    this.torsoPivot.position.y = 0.9

    const shorts = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.165, 0.17, 16), shortsMat)
    shorts.position.y = 0.02
    this.torsoPivot.add(shorts)

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.148, 0.28, 6, 16), jersey)
    torso.position.y = 0.27
    this.torsoPivot.add(torso)

    // 胸口白杠 + 肩条，让球衣不那么单调
    const chestBand = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.034, 0.015), white)
    chestBand.position.set(0, 0.36, -0.135)
    this.torsoPivot.add(chestBand)
    for (const sx of [-1, 1]) {
      const shoulderStripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.16, 0.014),
        white,
      )
      shoulderStripe.position.set(sx * 0.13, 0.42, -0.115)
      shoulderStripe.rotation.z = sx * 0.35
      this.torsoPivot.add(shoulderStripe)
    }

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.046, 0.09, 10), skin)
    neck.position.set(0, 0.545, 0.01)
    this.torsoPivot.add(neck)

    // —— 头（会盯球）——
    this.headPivot.position.set(0, 0.6, 0)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 16), skin)
    head.position.y = 0.07
    this.headPivot.add(head)

    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.106, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.52),
      hairMat,
    )
    hair.position.set(0, 0.075, 0.008)
    hair.rotation.x = -0.15
    this.headPivot.add(hair)

    const headband = new THREE.Mesh(new THREE.TorusGeometry(0.101, 0.015, 8, 24), white)
    headband.rotation.x = Math.PI / 2
    headband.position.y = 0.125
    this.headPivot.add(headband)

    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 8), dark)
      eye.position.set(sx * 0.036, 0.075, -0.093)
      this.headPivot.add(eye)
    }
    this.torsoPivot.add(this.headPivot)

    // —— 左臂（非持拍手）：自然下垂，欢呼时举起 ——
    this.leftArmPivot.position.set(-0.195, 0.5, 0.01)
    const leftArm = capsuleBetween(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.03, -0.32, 0.04),
      0.048,
      jersey,
    )
    this.leftArmPivot.add(leftArm)
    const leftHand = new THREE.Mesh(new THREE.SphereGeometry(0.048, 10, 8), skin)
    leftHand.position.set(0.03, -0.34, 0.045)
    this.leftArmPivot.add(leftHand)
    this.torsoPivot.add(this.leftArmPivot)
    this.group.add(this.torsoPivot)

    // —— 右臂（持拍手）：两段 IK，每帧摆位 ——
    // 挂在 group 上而不是 torsoPivot 上：IK 在 group 局部空间里算，
    // 躯干的小幅倾斜不会把手臂的坐标系也带着转（否则肩关节会算歪）。
    this.upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.24, 6, 12), jersey)
    this.foreArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.044, 0.26, 6, 12), skin)
    this.handMesh = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 10), skin)
    this.group.add(this.upperArm, this.foreArm, this.handMesh)

    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.castShadow = true
    })
  }

  /** 播放情绪动画（happy=得意 / sad=沮丧），duration 秒后回到待机 */
  setMood(mood: Exclude<OpponentMood, 'idle'>, duration: number): void {
    this.mood = mood
    this.moodTimer = duration
  }

  /**
   * 每帧驱动整个模型。
   *
   * @param paddle 对手球拍状态（身体跟随它移动，手臂 IK 到拍面）
   * @param ballPos 球的世界坐标（头会盯着球）
   */
  update(paddle: Paddle, ballPos: { x: number; y: number; z: number }, dt: number): void {
    this.time += dt
    if (this.moodTimer > 0) {
      this.moodTimer -= dt
      if (this.moodTimer <= 0) this.mood = 'idle'
    }

    const g = this.group
    const moodFade = this.mood === 'idle' ? 0 : Math.min(1, this.moodTimer / 0.35)

    // 身体跟着球拍走，但带阻尼（慢半拍），像人在滑步
    const targetX = paddle.x * 0.72
    g.position.x += (targetX - g.position.x) * Math.min(1, dt * 5.5)
    // 被调到台角时稍微后撤，给手臂留出长度
    g.position.z = PADDLE.opponentZ + 0.3 + Math.abs(paddle.x) * 0.08

    // 呼吸起伏 + 得意时小跳 / 沮丧时下坠
    const breathe = Math.sin(this.time * 2.2) * 0.012
    const hop = this.mood === 'happy' ? Math.abs(Math.sin(this.time * 8.5)) * 0.055 * moodFade : 0
    const sink = this.mood === 'sad' ? 0.045 * moodFade : 0
    g.position.y = TABLE.floorY + hop

    // 躯干：微微前倾（准备姿态）+ 随移动重心侧倾 + 沮丧时塌腰
    const leanTarget = clamp(paddle.vx * 0.05, -0.14, 0.14)
    this.leanSmoothed += (leanTarget - this.leanSmoothed) * Math.min(1, dt * 6)
    this.torsoPivot.rotation.z = -this.leanSmoothed
    this.torsoPivot.rotation.x =
      -0.08 + Math.sin(this.time * 2.2) * 0.012 - (this.mood === 'sad' ? 0.22 * moodFade : 0)
    this.torsoPivot.position.y = 0.9 + breathe - sink

    // 左臂：轻摆；得意时高举，沮丧时松垮前垂
    const raise = this.mood === 'happy' ? moodFade : 0
    this.leftArmRaise += (raise - this.leftArmRaise) * Math.min(1, dt * 8)
    this.leftArmPivot.rotation.z = 0.12 + Math.sin(this.time * 2) * 0.05 - this.leftArmRaise * 2.4
    this.leftArmPivot.rotation.x =
      Math.sin(this.time * 1.7) * 0.05 + (this.mood === 'sad' ? 0.25 * moodFade : 0)

    // 右臂 IK：肩 → 拍面（group 局部坐标）
    const swing = paddle.swingAnim
    const thrust = swing * swing
    // 拍子位置低时肩膀跟着下沉（蹲身救球的感觉）
    const dip = Math.max(0, 0.32 - paddle.y) * 0.55
    const shoulder = this.tmpShoulder.set(0.195, 1.4 + breathe - sink - dip, 0.02)
    const target = this.tmpTarget.set(
      paddle.x - g.position.x,
      paddle.y - TABLE.floorY - hop,
      paddle.z - g.position.z,
    )
    // 挥拍时手臂朝拍面方向再前探、下压，动作更有爆发感
    target.z -= thrust * 0.14
    target.y -= thrust * 0.06
    const { elbow, hand } = solveArmIK(shoulder, target, 0.3, 0.28)
    orientSegment(this.upperArm, shoulder, elbow)
    orientSegment(this.foreArm, elbow, hand)
    this.handMesh.position.copy(hand)

    // 头盯球（低头抬头跟着球的高度），沮丧时低头
    const headWorldY = 1.5 + breathe - sink
    const dx = ballPos.x - g.position.x
    const dy = ballPos.y - headWorldY
    const dz = ballPos.z - g.position.z
    const yaw = clamp(Math.atan2(-dx, -dz), -0.6, 0.6)
    const pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.45, 0.45)
    const targetPitch = this.mood === 'sad' ? -0.5 * moodFade : pitch
    const follow = Math.min(1, dt * 8)
    this.headPivot.rotation.y += (yaw - this.headPivot.rotation.y) * follow
    this.headPivot.rotation.x += (targetPitch - this.headPivot.rotation.x) * follow
  }
}
