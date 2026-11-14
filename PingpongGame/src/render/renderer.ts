import * as THREE from 'three'
import type { GameState } from '../core/game.ts'
import { PADDLE, TABLE } from '../core/constants.ts'
import { createScene } from './scene.ts'
import { applyPaddleTransform, createBall, createPaddle } from './meshes.ts'

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

  private ball: THREE.Mesh
  private playerPaddle: THREE.Group
  private opponentPaddle: THREE.Group
  private opponent: THREE.Group
  private resizeObserver: ResizeObserver

  constructor(container: HTMLElement) {
    this.container = container

    const built = createScene()
    this.scene = built.scene
    this.camera = built.camera
    this.opponent = built.opponent

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

    this.playerPaddle = createPaddle('#c8342f', '#c9a227')
    this.scene.add(this.playerPaddle)

    this.opponentPaddle = createPaddle('#2f5bc8', '#c9a227')
    this.scene.add(this.opponentPaddle)

    this.resize()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
  }

  private resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  /** 把游戏状态同步到场景 */
  sync(state: GameState): void {
    this.ball.position.set(state.ball.pos.x, state.ball.pos.y, state.ball.pos.z)
    this.ball.rotation.x += state.ball.vel.z * 0.08
    this.ball.rotation.z -= state.ball.vel.x * 0.08

    applyPaddleTransform(this.playerPaddle, state.playerPaddle)
    applyPaddleTransform(this.opponentPaddle, state.opponentPaddle)

    // 对手人形跟随球拍（手臂大致对准拍面）
    this.opponent.position.x = state.opponentPaddle.x * 0.75
    this.opponent.position.z = PADDLE.opponentZ + 0.55

    // 相机跟随我方横向位置（轻微，增加临场感）
    const targetX = state.playerPaddle.x * 0.22
    this.camera.position.x += (targetX - this.camera.position.x) * 0.08
    this.camera.lookAt(this.camera.position.x * 0.4, 0.12, 0.8)
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.resizeObserver.disconnect()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        const material = obj.material
        if (Array.isArray(material)) material.forEach((m) => m.dispose())
        else material.dispose()
      }
    })
  }
}

export { TABLE }
