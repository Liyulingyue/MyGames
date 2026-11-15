import * as THREE from 'three'
import { TABLE } from '../core/constants.ts'
import { DEFAULT_CAMERA, VIEW, resolveCamera } from './view.ts'

/** 球台台面的贴图：按国际乒联标准画白线 */
export function createTableTexture(): THREE.CanvasTexture {
  const W = 1024
  const H = Math.round((W * TABLE.length) / TABLE.width)
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  // 台面底色
  ctx.fillStyle = '#14496e'
  ctx.fillRect(0, 0, W, H)

  // 细微磨砂质感
  const grad = ctx.createLinearGradient(0, 0, W, H)
  grad.addColorStop(0, 'rgba(255,255,255,0.06)')
  grad.addColorStop(0.5, 'rgba(0,0,0,0.05)')
  grad.addColorStop(1, 'rgba(255,255,255,0.04)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)

  // 边线（2cm）与中线（3mm），换算成贴图像素
  const pxPerMeter = W / TABLE.width
  const edge = 0.02 * pxPerMeter
  const center = 0.003 * pxPerMeter

  ctx.fillStyle = '#f4f8ff'
  ctx.fillRect(0, 0, W, edge) // 上边
  ctx.fillRect(0, H - edge, W, edge) // 下边
  ctx.fillRect(0, 0, edge, H) // 左边
  ctx.fillRect(W - edge, 0, edge, H) // 右边
  // 中线（沿台长方向，纵向）
  ctx.fillRect(W / 2 - center / 2, 0, center, H)

  const texture = new THREE.CanvasTexture(canvas)
  texture.anisotropy = 8
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** 球网：白色网格 + 透明背景 */
export function createNetTexture(): THREE.CanvasTexture {
  const W = 512
  const H = 128
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  ctx.clearRect(0, 0, W, H)
  ctx.strokeStyle = 'rgba(240,245,255,0.92)'
  ctx.lineWidth = 2

  const cols = 32
  const rows = 8
  for (let i = 0; i <= cols; i++) {
    const x = (i / cols) * W
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, H)
    ctx.stroke()
  }
  for (let i = 0; i <= rows; i++) {
    const y = (i / rows) * H
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(W, y)
    ctx.stroke()
  }

  // 顶部白带
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.fillRect(0, 0, W, 6)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** 搭建整个场景：地板、球台、球网、灯光、相机（对手人形见 meshes.ts 的 OpponentRig） */
export function createScene(): {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  tableTop: THREE.Mesh
  net: THREE.Mesh
} {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#0b1020')
  scene.fog = new THREE.Fog('#0b1020', 8, 22)

  // —— 相机：第一人称，站在我方台端 ——
  // 相机参数由 render/view.ts 按位姿解算（这里先用默认位姿 = 最初的相机）
  const camera = new THREE.PerspectiveCamera(VIEW.base.fov, 1, 0.05, 60)
  const initial = resolveCamera(DEFAULT_CAMERA)
  camera.position.set(initial.eye.x, initial.eye.y, initial.eye.z)
  camera.lookAt(initial.target.x, initial.target.y, initial.target.z)

  // —— 灯光 ——
  scene.add(new THREE.HemisphereLight('#bcd4ff', '#2a2118', 0.85))

  const key = new THREE.DirectionalLight('#ffffff', 1.5)
  key.position.set(2.4, 4.2, -1.6)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.near = 0.5
  key.shadow.camera.far = 12
  key.shadow.camera.left = -2.2
  key.shadow.camera.right = 2.2
  key.shadow.camera.top = 2.2
  key.shadow.camera.bottom = -2.2
  key.shadow.bias = -0.0008
  scene.add(key)

  const fill = new THREE.DirectionalLight('#88aaff', 0.45)
  fill.position.set(-3, 2.5, 2)
  scene.add(fill)

  // 台面上方的顶灯
  const lamp = new THREE.PointLight('#ffffff', 12, 8, 2)
  lamp.position.set(0, 2.6, 0)
  scene.add(lamp)

  // —— 地板 ——
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.MeshStandardMaterial({ color: '#1b2340', roughness: 0.95, metalness: 0 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = TABLE.floorY
  floor.receiveShadow = true
  scene.add(floor)

  // —— 球台 ——
  const tableGroup = new THREE.Group()
  const texture = createTableTexture()

  const sideMaterial = new THREE.MeshStandardMaterial({ color: '#0e2f48', roughness: 0.7 })
  const topMaterial = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.55 })

  const topGeo = new THREE.BoxGeometry(
    TABLE.width,
    TABLE.thickness,
    TABLE.length,
  )
  // BoxGeometry 材质顺序：+X, -X, +Y, -Y, +Z, -Z
  const tableTop = new THREE.Mesh(topGeo, [
    sideMaterial,
    sideMaterial,
    topMaterial,
    sideMaterial,
    sideMaterial,
    sideMaterial,
  ])
  tableTop.position.y = -TABLE.thickness / 2
  tableTop.receiveShadow = true
  tableGroup.add(tableTop)

  // 台面边框（白色）
  const rimMaterial = new THREE.MeshStandardMaterial({ color: '#e8eef8', roughness: 0.5 })
  const rimH = 0.012
  const rimY = TABLE.surfaceY + rimH / 2
  const addRim = (w: number, d: number, x: number, z: number) => {
    const rim = new THREE.Mesh(new THREE.BoxGeometry(w, rimH, d), rimMaterial)
    rim.position.set(x, rimY, z)
    rim.castShadow = true
    tableGroup.add(rim)
  }
  addRim(TABLE.width + 0.03, 0.015, 0, TABLE.halfLength + 0.007)
  addRim(TABLE.width + 0.03, 0.015, 0, -TABLE.halfLength - 0.007)
  addRim(0.015, TABLE.length + 0.03, TABLE.halfWidth + 0.007, 0)
  addRim(0.015, TABLE.length + 0.03, -TABLE.halfWidth - 0.007, 0)

  // 桌腿
  const legMaterial = new THREE.MeshStandardMaterial({ color: '#22304a', roughness: 0.6, metalness: 0.3 })
  const legHeight = Math.abs(TABLE.floorY)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, legHeight, 0.06),
        legMaterial,
      )
      leg.position.set(
        sx * (TABLE.halfWidth - 0.12),
        TABLE.floorY + legHeight / 2,
        sz * (TABLE.halfLength - 0.14),
      )
      leg.castShadow = true
      tableGroup.add(leg)
    }
  }
  // 横梁
  for (const sz of [-1, 1]) {
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE.width - 0.2, 0.05, 0.05),
      legMaterial,
    )
    beam.position.set(0, TABLE.floorY + 0.06, sz * (TABLE.halfLength - 0.14))
    tableGroup.add(beam)
  }
  scene.add(tableGroup)

  // —— 球网 ——
  const netWidth = (TABLE.halfWidth + TABLE.netOverhang) * 2
  const net = new THREE.Mesh(
    new THREE.PlaneGeometry(netWidth, TABLE.netHeight),
    new THREE.MeshBasicMaterial({
      map: createNetTexture(),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  net.position.set(0, TABLE.netHeight / 2, 0)
  scene.add(net)

  // 网柱
  const postMaterial = new THREE.MeshStandardMaterial({ color: '#d8dee9', roughness: 0.4 })
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, TABLE.netHeight + 0.04, 12),
      postMaterial,
    )
    post.position.set(sx * (TABLE.halfWidth + TABLE.netOverhang), (TABLE.netHeight + 0.04) / 2, 0)
    post.castShadow = true
    scene.add(post)
  }

  return { scene, camera, tableTop, net }
}
