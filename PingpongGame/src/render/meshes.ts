import * as THREE from 'three'
import { BALL, PADDLE } from '../core/constants.ts'
import type { Paddle } from '../core/types.ts'

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
