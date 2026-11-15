import * as THREE from 'three'
import { PADDLE, TABLE } from '../core/constants.ts'
import type { Paddle } from '../core/types.ts'

/** 风格化运动员；握拍手的位置直接由球拍的变换决定。 */
export function createOpponent(): {
  group: THREE.Group
  sync: (paddle: Paddle, paddleMesh: THREE.Group) => void
} {
  const group = new THREE.Group()
  group.position.set(0, TABLE.surfaceY, PADDLE.opponentZ + 0.55)
  const upperBody = new THREE.Group()
  upperBody.name = 'opponent-upper-body'
  group.add(upperBody)

  const shirt = new THREE.MeshStandardMaterial({ color: '#237b9b', roughness: 0.8 })
  const shorts = new THREE.MeshStandardMaterial({ color: '#243957', roughness: 0.85 })
  const skin = new THREE.MeshStandardMaterial({ color: '#d9b48f', roughness: 0.85 })
  const hair = new THREE.MeshStandardMaterial({ color: '#292b34', roughness: 0.9 })
  const shoe = new THREE.MeshStandardMaterial({ color: '#edf2f2', roughness: 0.8 })

  const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material,
    x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    parent.add(mesh)
    return mesh
  }

  const torso = add(upperBody, new THREE.CapsuleGeometry(0.16, 0.31, 6, 16), shirt, 0, 0.5, 0)
  torso.scale.z = 0.72
  const waist = add(upperBody, new THREE.BoxGeometry(0.29, 0.15, 0.17), shorts, 0, 0.23, 0)
  waist.rotation.x = -0.08
  add(upperBody, new THREE.CylinderGeometry(0.055, 0.065, 0.08, 12), skin, 0, 0.745, 0)
  add(upperBody, new THREE.SphereGeometry(0.115, 20, 16), skin, 0, 0.9, 0)
  const hairCap = add(upperBody, new THREE.SphereGeometry(0.116, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.38),
    hair, 0, 0.9, 0)
  hairCap.scale.y = 0.98
  for (const x of [-0.04, 0.04]) {
    add(upperBody, new THREE.SphereGeometry(0.008, 8, 6), hair, x, 0.91, -0.104)
  }
  const stripe = add(upperBody, new THREE.BoxGeometry(0.19, 0.018, 0.012), shoe, 0, 0.52, -0.114)
  stripe.rotation.z = -0.12

  const up = new THREE.Vector3(0, 1, 0)
  const direction = new THREE.Vector3()
  const segment = (radius: number, material: THREE.Material) =>
    add(group, new THREE.CylinderGeometry(radius, radius, 1, 10), material, 0, 0, 0)
  const placeSegment = (mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) => {
    direction.subVectors(b, a)
    mesh.position.copy(a).add(b).multiplyScalar(0.5)
    mesh.scale.y = direction.length()
    mesh.quaternion.setFromUnitVectors(up, direction.normalize())
  }

  for (const side of [-1, 1]) {
    const hip = new THREE.Vector3(side * 0.09, 0.18, 0)
    const knee = new THREE.Vector3(side * 0.16, -0.24, -0.055)
    const ankle = new THREE.Vector3(side * 0.2, TABLE.floorY + 0.07, 0.025)
    placeSegment(segment(0.068, shorts), hip, knee)
    placeSegment(segment(0.047, skin), knee, ankle)
    const foot = add(group, new THREE.BoxGeometry(0.12, 0.07, 0.23), shoe,
      ankle.x, TABLE.floorY + 0.035, -0.025)
    foot.name = 'opponent-foot'
  }

  const upperArm = segment(0.053, shirt)
  const forearm = segment(0.04, skin)
  const elbowMesh = add(group, new THREE.SphereGeometry(0.045, 12, 8), skin, 0, 0, 0)
  const hand = add(group, new THREE.SphereGeometry(0.04, 12, 8), skin, 0, 0, 0)
  hand.name = 'opponent-grip'

  const freeShoulder = new THREE.Vector3(-0.15, 0.65, 0)
  const freeElbow = new THREE.Vector3(-0.25, 0.39, -0.06)
  const freeHand = new THREE.Vector3(-0.2, 0.26, -0.19)
  const freeUpperArm = segment(0.05, shirt)
  const freeForearm = segment(0.038, skin)
  const freeHandMesh = add(group, new THREE.SphereGeometry(0.038, 12, 8), skin, 0, 0, 0)

  const shoulder = new THREE.Vector3()
  const elbow = new THREE.Vector3()
  const grip = new THREE.Vector3()
  const sync = (paddle: Paddle, paddleMesh: THREE.Group) => {
    group.position.x = paddle.x * 0.75
    const lean = THREE.MathUtils.clamp(paddle.vx * 0.025, -0.08, 0.08)
    upperBody.position.x = lean

    shoulder.set(0.15 + lean, 0.65, 0)
    paddleMesh.updateWorldMatrix(true, false)
    group.updateWorldMatrix(true, false)
    grip.set(0, -PADDLE.radius - 0.05, 0)
    paddleMesh.localToWorld(grip)
    group.worldToLocal(grip)
    elbow.copy(shoulder).lerp(grip, 0.5)
    elbow.x += 0.08
    elbow.y -= 0.08
    placeSegment(upperArm, shoulder, elbow)
    placeSegment(forearm, elbow, grip)
    elbowMesh.position.copy(elbow)
    hand.position.copy(grip)

    freeShoulder.x = -0.15 + lean
    freeElbow.x = -0.25 + lean
    freeHand.x = -0.2 + lean
    placeSegment(freeUpperArm, freeShoulder, freeElbow)
    placeSegment(freeForearm, freeElbow, freeHand)
    freeHandMesh.position.copy(freeHand)
  }

  return { group, sync }
}
