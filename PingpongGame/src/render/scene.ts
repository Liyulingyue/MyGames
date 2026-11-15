import * as THREE from 'three'
import { TABLE } from '../core/constants.ts'
import { createOpponent } from './opponent.ts'
import { DEFAULT_CAMERA, VIEW, resolveCamera } from './view.ts'

export type Environment = 'bright' | 'night'

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

/** 搭建整个场景：地板、球台、球网、灯光、相机 */
export function createScene(): {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  tableTop: THREE.Mesh
  net: THREE.Mesh
  opponent: ReturnType<typeof createOpponent>
  setEnvironment: (environment: Environment) => void
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
  const ambient = new THREE.HemisphereLight('#bcd4ff', '#2a2118', 0.85)
  scene.add(ambient)

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
  const floorMaterial = new THREE.MeshStandardMaterial({ color: '#1b2340', roughness: 0.95, metalness: 0 })
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    floorMaterial,
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = TABLE.floorY
  floor.receiveShadow = true
  scene.add(floor)

  const createRoomShell = (name: string, wallColor: string, trimColor: string, ceilingColor: string) => {
    const shell = new THREE.Group()
    shell.name = name
    const wallMaterial = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 1, side: THREE.DoubleSide })
    const trimMaterial = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 1, side: THREE.DoubleSide })
    const backWall = new THREE.Mesh(new THREE.PlaneGeometry(10, 4), wallMaterial)
    backWall.position.set(0, TABLE.floorY + 2, 5)
    shell.add(backWall)
    const backTrim = new THREE.Mesh(new THREE.PlaneGeometry(10, 0.85), trimMaterial)
    backTrim.position.set(0, TABLE.floorY + 0.425, 4.99)
    shell.add(backTrim)
    for (const x of [-5, 5]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(10, 4), wallMaterial)
      wall.rotation.y = Math.PI / 2
      wall.position.set(x, TABLE.floorY + 2, 0)
      shell.add(wall)
      const trim = new THREE.Mesh(new THREE.PlaneGeometry(10, 0.85), trimMaterial)
      trim.rotation.y = Math.PI / 2
      trim.position.set(x - Math.sign(x) * 0.01, TABLE.floorY + 0.425, 0)
      shell.add(trim)
    }
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshBasicMaterial({ color: ceilingColor, side: THREE.DoubleSide }),
    )
    ceiling.rotation.x = Math.PI / 2
    ceiling.position.y = TABLE.floorY + 4
    shell.add(ceiling)
    return shell
  }
  const room = createRoomShell('bright-room', '#c4d2cc', '#76978d', '#c4d2cc')

  const frameMaterial = new THREE.MeshStandardMaterial({ color: '#d1d8d1', roughness: 0.8 })
  const glassMaterial = new THREE.MeshStandardMaterial({ color: '#8faeb0', roughness: 0.9 })
  const doorMaterial = new THREE.MeshStandardMaterial({ color: '#9a806d', roughness: 0.9 })
  const handleMaterial = new THREE.MeshStandardMaterial({ color: '#d2c3a3', roughness: 0.5 })

  const addWallFeature = (
    name: string, width: number, height: number, material: THREE.Material,
    x: number, y: number, z: number, rotation: number, target = room, frame = frameMaterial,
  ) => {
    const feature = new THREE.Group()
    feature.name = name
    feature.position.set(x, TABLE.floorY + y, z)
    feature.rotation.y = rotation
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
    surface.position.z = -0.02
    surface.rotation.y = Math.PI
    feature.add(surface)
    const frameWidth = 0.07
    const addFrame = (w: number, h: number, px: number, py: number) => {
      const piece = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), frame)
      piece.position.set(px, py, -0.06)
      feature.add(piece)
    }
    for (const side of [-1, 1]) {
      addFrame(frameWidth, height + 2 * frameWidth, side * (width + frameWidth) / 2, 0)
      addFrame(width, frameWidth, 0, side * (height + frameWidth) / 2)
    }
    target.add(feature)
    return feature
  }

  const addWindowMullions = (window: THREE.Group, width: number) => {
    const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.045, 1.05, 0.04), frameMaterial)
    mullion.position.z = -0.06
    window.add(mullion)
    for (const side of [-1, 1]) {
      const crossbar = new THREE.Mesh(new THREE.BoxGeometry((width - 0.045) / 2, 0.035, 0.04), frameMaterial)
      crossbar.position.set(side * (width + 0.045) / 4, -0.15, -0.06)
      window.add(crossbar)
    }
  }
  for (const x of [-3.3, 3.6]) {
    const window = addWallFeature('room-window', 1.15, 1.05, glassMaterial, x, 2.35, 5, 0)
    addWindowMullions(window, 1.15)
  }
  for (const side of [-1, 1]) {
    for (const z of [-1.4, 2]) {
      const window = addWallFeature('room-window', 1.3, 1.05, glassMaterial, side * 5, 2.35, z, side * Math.PI / 2)
      addWindowMullions(window, 1.3)
    }
  }
  const door = addWallFeature('room-door', 1, 2.05, doorMaterial, 1.9, 1.025, 5, 0)
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.16, 0.035), handleMaterial)
  handle.position.set(-0.37, -0.02, -0.06)
  door.add(handle)

  const bench = new THREE.Group()
  bench.name = 'room-bench'
  bench.position.set(-2.8, TABLE.floorY, 4.6)
  const benchMaterial = new THREE.MeshStandardMaterial({ color: '#936e55', roughness: 0.88 })
  const benchLegMaterial = new THREE.MeshStandardMaterial({ color: '#596763', roughness: 0.8 })
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.07, 0.38), benchMaterial)
  seat.position.y = 0.39
  bench.add(seat)
  for (const x of [-0.52, 0.52]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.355, 0.28), benchLegMaterial)
    leg.position.set(x, 0.1775, 0)
    bench.add(leg)
  }
  room.add(bench)

  const addCeilingLamps = (target: THREE.Group, name: string, housingColor: string, panelColor: string) => {
    const lampHousing = new THREE.MeshStandardMaterial({ color: housingColor, roughness: 0.8 })
    const lampPanel = new THREE.MeshBasicMaterial({ color: panelColor })
    for (const x of [-2, 2]) {
      for (const z of [-1.5, 2]) {
        const fixture = new THREE.Group()
        fixture.name = name
        fixture.position.set(x, TABLE.floorY + 3.94, z)
        const housing = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.08, 0.42), lampHousing)
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.3), lampPanel)
        panel.rotation.x = Math.PI / 2
        panel.position.y = -0.041
        fixture.add(housing, panel)
        target.add(fixture)
      }
    }
  }
  addCeilingLamps(room, 'room-lamp', '#c9d0ca', '#e8e9df')

  const floorLines: number[] = []
  for (let i = 0; i <= 22; i++) {
    const x = -4.95 + i * 0.45
    floorLines.push(x, TABLE.floorY + 0.002, -4.95, x, TABLE.floorY + 0.002, 4.95)
    if (i === 22) continue
    for (let z = -4.5 + (i % 2) * 0.75; z < 4.95; z += 1.5) {
      floorLines.push(x, TABLE.floorY + 0.002, z, x + 0.45, TABLE.floorY + 0.002, z)
    }
  }
  const floorLineGeometry = new THREE.BufferGeometry()
  floorLineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(floorLines, 3))
  const floorDetail = new THREE.LineSegments(
    floorLineGeometry,
    new THREE.LineBasicMaterial({ color: '#6f5344', transparent: true, opacity: 0.16, depthWrite: false }),
  )
  floorDetail.name = 'room-floor-detail'
  room.add(floorDetail)
  scene.add(room)

  const nightRoom = createRoomShell('night-room', '#536a80', '#30465a', '#263448')
  const nightFrameMaterial = new THREE.MeshStandardMaterial({ color: '#617587', roughness: 0.8 })
  const nightDoorMaterial = new THREE.MeshStandardMaterial({ color: '#384958', roughness: 0.9 })
  const nightDoor = addWallFeature(
    'night-door', 1, 2.05, nightDoorMaterial, 1.9, 1.025, 5, 0, nightRoom, nightFrameMaterial,
  )
  const nightHandle = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.16, 0.035), nightFrameMaterial)
  nightHandle.position.set(-0.37, -0.02, -0.06)
  nightDoor.add(nightHandle)
  addCeilingLamps(nightRoom, 'night-lamp', '#4d6176', '#c4d5e0')
  const sconceHousing = new THREE.MeshStandardMaterial({ color: '#516879', roughness: 0.8 })
  const sconcePanel = new THREE.MeshBasicMaterial({ color: '#94aeb9' })
  for (const x of [-3.4, 3.4]) {
    const sconce = new THREE.Group()
    sconce.name = 'night-wall-light'
    sconce.position.set(x, TABLE.floorY + 2.45, 5)
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.05), sconceHousing)
    housing.position.z = -0.045
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.12), sconcePanel)
    panel.position.z = -0.075
    panel.rotation.y = Math.PI
    const light = new THREE.PointLight('#aac9df', 3, 4, 2)
    light.position.z = -0.4
    sconce.add(housing, panel, light)
    nightRoom.add(sconce)
  }
  const courtLineGeometry = new THREE.BufferGeometry()
  const courtY = TABLE.floorY + 0.002
  courtLineGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -2.8, courtY, -4, 2.8, courtY, -4,
    -2.8, courtY, 4, 2.8, courtY, 4,
    -2.8, courtY, -4, -2.8, courtY, 4,
    2.8, courtY, -4, 2.8, courtY, 4,
  ], 3))
  const courtLines = new THREE.LineSegments(
    courtLineGeometry,
    new THREE.LineBasicMaterial({ color: '#8faaba', transparent: true, opacity: 0.3, depthWrite: false }),
  )
  courtLines.name = 'night-court-lines'
  nightRoom.add(courtLines)
  scene.add(nightRoom)

  const setEnvironment = (environment: Environment) => {
    const bright = environment === 'bright'
    const background = bright ? '#c4d2cc' : '#0b1020'
    scene.background = new THREE.Color(background)
    scene.fog = new THREE.Fog(background, 8, 22)
    room.visible = bright
    nightRoom.visible = !bright
    floorMaterial.color.set(bright ? '#a37b60' : '#1b2340')
    ambient.color.set(bright ? '#ffffff' : '#bcd4ff')
    ambient.groundColor.set(bright ? '#b9aa96' : '#2a2118')
    ambient.intensity = bright ? 1.35 : 0.85
    key.intensity = bright ? 2 : 1.5
    fill.color.set(bright ? '#fff5e3' : '#88aaff')
    fill.intensity = bright ? 0.8 : 0.45
  }
  setEnvironment('bright')

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
  const rimWidth = 0.015
  const rimY = TABLE.surfaceY + rimH / 2
  const addRim = (w: number, d: number, x: number, z: number) => {
    const rim = new THREE.Mesh(new THREE.BoxGeometry(w, rimH, d), rimMaterial)
    rim.position.set(x, rimY, z)
    rim.castShadow = true
    tableGroup.add(rim)
  }
  addRim(TABLE.width + 2 * rimWidth, rimWidth, 0, TABLE.halfLength + rimWidth / 2)
  addRim(TABLE.width + 2 * rimWidth, rimWidth, 0, -TABLE.halfLength - rimWidth / 2)
  addRim(rimWidth, TABLE.length, TABLE.halfWidth + rimWidth / 2, 0)
  addRim(rimWidth, TABLE.length, -TABLE.halfWidth - rimWidth / 2, 0)

  // 桌腿
  const legMaterial = new THREE.MeshStandardMaterial({ color: '#22304a', roughness: 0.6, metalness: 0.3 })
  const legWidth = 0.06
  const legX = TABLE.halfWidth - 0.12
  const legHeight = TABLE.surfaceY - TABLE.thickness - TABLE.floorY
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(legWidth, legHeight, legWidth),
        legMaterial,
      )
      leg.position.set(
        sx * legX,
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
      new THREE.BoxGeometry(2 * legX - legWidth, 0.05, 0.05),
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

  const opponent = createOpponent()
  scene.add(opponent.group)

  return { scene, camera, tableTop, net, opponent, setEnvironment }
}
