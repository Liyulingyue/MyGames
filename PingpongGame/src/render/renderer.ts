import * as THREE from 'three'
import type { GameState } from '../core/game.ts'
import { PADDLE, TABLE } from '../core/constants.ts'
import { createScene, type Environment } from './scene.ts'
import { applyPaddleTransform, createBall, createPaddle } from './meshes.ts'
import {
  DEFAULT_CAMERA,
  fitFraming,
  resolveCamera,
  viewOffset,
  type CameraPose,
  type Framing,
} from './view.ts'

/** 拖尾保留的历史点数 */
const TRAIL_LENGTH = 18
/** 拖尾光点之间的弧长间隔（米）：比球略大，保证连成一条光带而不是一串珠子 */
const TRAIL_STEP = 0.03

/**
 * 径向渐变贴图：拖尾光点用它。
 *
 * 比在 3D 里算灯光便宜得多，也更容易控制形状。
 */
function createRadialTexture(inner: string, outer: string, falloff = 0.45): THREE.CanvasTexture {
  const S = 128
  const canvas = document.createElement('canvas')
  canvas.width = S
  canvas.height = S
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  g.addColorStop(0, inner)
  g.addColorStop(falloff, outer)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, S, S)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * Three.js 表现层。
 *
 * 只负责"把 core/ 里的状态画出来"，不参与任何规则判定——
 * 将来换成服务端权威同步时，这一层几乎不用改。
 */
export class GameRenderer {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private container: HTMLElement
  private setSceneEnvironment: (environment: Environment) => void

  /** 当前生效的取景（随宽高比、显示尺寸和相机位姿变化） */
  private framing: Framing = fitFraming(1, 1)
  /** 显示尺寸倍率：1 = 原样 */
  private displaySize = 1
  /** 相机位姿（位置 + 俯角），用户可调 */
  private cameraPose: CameraPose = { ...DEFAULT_CAMERA }
  /** 每帧跟随球拍带来的横向偏移（米） */
  private panX = 0

  private ball: THREE.Mesh
  private playerPaddle: THREE.Group
  private opponentPaddle: THREE.Group
  private opponent: ReturnType<typeof createScene>['opponent']
  private alignMarker: THREE.Mesh
  private resizeObserver: ResizeObserver

  /** 球的拖尾：历史位置上的渐隐光点 */
  private trail: THREE.Sprite[] = []
  private readonly trailHistory = Array.from({ length: 48 }, () => new THREE.Vector3())
  private readonly trailSamples = Array.from({ length: TRAIL_LENGTH }, () => new THREE.Vector3())
  private trailHistoryHead = -1
  private trailHistoryCount = 0

  constructor(container: HTMLElement) {
    this.container = container

    const built = createScene()
    this.scene = built.scene
    this.camera = built.camera
    this.opponent = built.opponent
    this.setSceneEnvironment = built.setEnvironment

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    // three r18x 起 PCFSoftShadowMap 已被移除，统一用 PCFShadowMap
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    container.appendChild(this.renderer.domElement)

    this.ball = createBall()
    this.scene.add(this.ball)

    // —— 拖尾 ——
    // 用一串精灵而不是一条线：精灵永远正对相机，速度快时也不会变成
    // 屏幕上的一根细线，而是像彗尾一样一团光。
    const trailTexture = createRadialTexture('rgba(255,246,225,0.95)', 'rgba(255,214,150,0.35)', 0.35)
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: trailTexture,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          opacity: 0,
        }),
      )
      sprite.scale.setScalar(0.05)
      this.trail.push(sprite)
      this.scene.add(sprite)
    }

    this.playerPaddle = createPaddle('#c8342f', '#c9a227')
    this.scene.add(this.playerPaddle)

    this.opponentPaddle = createPaddle('#2f5bc8', '#c9a227')
    this.scene.add(this.opponentPaddle)

    this.alignMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.083, 0.091, 32),
      new THREE.MeshBasicMaterial({
        color: '#67e8f9', transparent: true, opacity: 0.8, depthTest: false, depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    this.alignMarker.visible = false
    this.alignMarker.renderOrder = 10
    this.scene.add(this.alignMarker)

    this.resize()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
  }

  private resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const aspect = w / h
    this.camera.aspect = aspect
    this.applyFraming(aspect)
    this.renderer.setSize(w, h, false)
    this.render()
  }

  /**
   * 按当前宽高比、显示尺寸和相机位姿重新算取景。
   *
   * 宽高比变了（转屏、窗口缩放、手机横竖屏切换）、用户改了显示尺寸、
   * 或者用户动了相机滑块，都要重算：
   * 球拍必须始终留在画面里，球台在不同屏幕上看起来也要差不多大。
   *
   * 注意两条轴是分开的：
   *   - 显示尺寸只改镜头张角和裁剪窗口，**绝不碰相机位姿**；
   *   - 相机位姿只改相机的位置和朝向，不改显示尺寸的语义。
   */
  private applyFraming(aspect: number): void {
    this.framing = fitFraming(aspect, this.displaySize, this.cameraPose)
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const offset = viewOffset(w, h, this.framing)
    // 虚拟大图的张角（裁剪窗口按它换算成实际张角）
    this.camera.fov = this.framing.sourceFov
    this.camera.setViewOffset(
      offset.fullWidth,
      offset.fullHeight,
      offset.x,
      offset.y,
      offset.width,
      offset.height,
    )
    this.applyCameraPose()
  }

  /**
   * 把位姿落到相机上：位置 = 位姿 + 横向跟随，朝向由位姿和俯角解算。
   *
   * 朝向是"水平瞄准球台远端中心 + 俯角下压"，
   * 所以左右滑块是横向平移（不会把画面拧歪），俯角是独立的第二个轴。
   */
  private applyCameraPose(): void {
    const cam = resolveCamera(this.cameraPose, this.panX)
    this.camera.position.set(cam.eye.x, cam.eye.y, cam.eye.z)
    this.camera.lookAt(cam.target.x, cam.target.y, cam.target.z)
  }

  /** 设置显示尺寸倍率（1 = 原样），立刻生效，不用重开一局 */
  setDisplaySize(size: number): void {
    this.displaySize = size
    this.applyFraming(this.camera.aspect)
  }

  /** 设置相机位姿（位置 + 俯角），立刻生效，不用重开一局 */
  setCameraPose(pose: CameraPose): void {
    this.cameraPose = { ...pose }
    this.applyFraming(this.camera.aspect)
  }

  setEnvironment(environment: Environment): void {
    this.setSceneEnvironment(environment)
  }

  /** 把游戏状态同步到场景 */
  sync(state: GameState): void {
    this.ball.position.set(state.ball.pos.x, state.ball.pos.y, state.ball.pos.z)
    this.ball.rotation.x += state.ball.vel.z * 0.08
    this.ball.rotation.z -= state.ball.vel.x * 0.08

    this.updateTrail(state)

    applyPaddleTransform(this.playerPaddle, state.playerPaddle)
    applyPaddleTransform(this.opponentPaddle, state.opponentPaddle, -0.18)

    this.opponent.sync(state.opponentPaddle, this.opponentPaddle)
    this.alignMarker.visible = state.softAlignTargetX !== null
    if (state.softAlignTargetX !== null) {
      this.alignMarker.position.set(state.softAlignTargetX, state.playerPaddle.y + 0.28, PADDLE.homeZ + 0.02)
    }

    // 相机跟随我方横向位置（轻微，增加临场感）
    // 跟随量是相对用户设定位的偏移，用户把相机推到左边不会把跟随吃掉。
    const targetX = state.playerPaddle.x * 0.22
    this.panX += (targetX - this.panX) * 0.08
    this.applyCameraPose()
  }

  /**
   * 更新拖尾。
   *
   * 直接按帧存历史点的话，高速时相邻光点会拉开距离，
   * 拖尾看起来像"一串珠子"而不是一条光带。
   * 所以这里先沿轨迹按**固定弧长**重采样，再把光点摆上去。
   *
   * 球慢下来的时候拖尾收掉（否则静止的球也挂着一团光，像贴纸）。
   */
  private updateTrail(state: GameState): void {
    const speed = Math.hypot(state.ball.vel.x, state.ball.vel.y, state.ball.vel.z)

    this.trailHistoryHead = (this.trailHistoryHead + 1) % this.trailHistory.length
    this.trailHistory[this.trailHistoryHead].set(state.ball.pos.x, state.ball.pos.y, state.ball.pos.z)
    this.trailHistoryCount = Math.min(this.trailHistoryCount + 1, this.trailHistory.length)

    const visible = speed > 1.0

    // 沿轨迹等弧长重采样（从新到旧）
    let sampleCount = 0
    let carry = 0
    for (let i = 1; i < this.trailHistoryCount && sampleCount < TRAIL_LENGTH; i++) {
      const a = this.trailHistory[(this.trailHistoryHead - i + 1 + this.trailHistory.length) % this.trailHistory.length]
      const b = this.trailHistory[(this.trailHistoryHead - i + this.trailHistory.length) % this.trailHistory.length]
      const seg = a.distanceTo(b)
      if (seg < 1e-6) continue
      let t = carry
      while (t <= seg && sampleCount < TRAIL_LENGTH) {
        this.trailSamples[sampleCount++].lerpVectors(a, b, t / seg)
        t += TRAIL_STEP
      }
      carry = t - seg
    }

    for (let i = 0; i < this.trail.length; i++) {
      const sprite = this.trail[i]
      if (!visible || i >= sampleCount) {
        sprite.material.opacity = 0
        continue
      }
      sprite.position.copy(this.trailSamples[i])
      // 越靠后越淡越小
      const k = 1 - i / TRAIL_LENGTH
      sprite.material.opacity = 0.5 * k * k
      sprite.scale.setScalar(0.014 + 0.042 * k)
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.resizeObserver.disconnect()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    const textures = new Set<THREE.Texture>()
    this.scene.traverse((obj) => {
      // 拖尾是精灵，也要一起释放（贴图挂在材质上）
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Sprite) {
        obj.geometry?.dispose?.()
        const material = obj.material
        const materials = Array.isArray(material) ? material : [material]
        for (const item of materials) {
          for (const value of Object.values(item)) {
            if (value instanceof THREE.Texture) textures.add(value)
          }
          item.dispose()
        }
      }
    })
    textures.forEach((texture) => texture.dispose())
  }
}

export { TABLE }
