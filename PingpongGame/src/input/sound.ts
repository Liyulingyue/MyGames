/**
 * 音效引擎：用 WebAudio **现场合成**，不加载任何音频文件。
 *
 * 为什么自己合成而不是放 mp3：
 *
 * - 这个项目要能纯前端跑、还要能打包成静态页面，带二进制资源会让仓库变脏；
 * - 乒乓球的几种声音其实是"短脉冲"，用振荡器 + 噪声 + 滤波就能做到，
 *   而且可以按击球力度实时改变音高/音量，比固定素材更有手感。
 *
 * 浏览器规定：AudioContext 必须在**用户手势**里创建/恢复，否则会被挂起。
 * 所以 `unlock()` 要挂在"开始游戏"按钮上。
 */

/** 可播放的音效 */
export type SfxName =
  /** 球拍击球 */
  | 'paddle'
  /** 球落台 */
  | 'bounce'
  /** 球触网 */
  | 'net'
  /** 挥拍但没打到球 */
  | 'whiff'
  /** 发球 */
  | 'serve'
  /** 得分 */
  | 'point'
  /** 赢下这一局 */
  | 'win'
  /** 输掉这一局 */
  | 'lose'
  /** UI 点击 */
  | 'ui'

interface ToneOptions {
  /** 波形 */
  type?: OscillatorType
  /** 起止频率（Hz），给了 freqTo 就是一次滑音 */
  freq: number
  freqTo?: number
  /** 时长（秒） */
  dur: number
  /** 音量 */
  gain?: number
  /** 延迟（秒） */
  delay?: number
}

interface NoiseOptions {
  /** 时长（秒） */
  dur: number
  /** 带通/低通中心频率 */
  freq: number
  /** 滤波类型 */
  filter?: BiquadFilterType
  /** Q 值 */
  q?: number
  gain?: number
  /** 结束频率（做扫频噪声用） */
  freqTo?: number
  delay?: number
}

export class SoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  /** 一段预生成的噪声，反复拿来当"撞击声"的素材 */
  private noiseBuffer: AudioBuffer | null = null
  private enabled = true
  private volume = 0.65

  /** 是否静音 */
  get isEnabled(): boolean {
    return this.enabled
  }

  /** 当前音量 0~1 */
  get level(): number {
    return this.volume
  }

  /**
   * 在用户手势里调用：创建 / 恢复 AudioContext。
   *
   * 不调用的话第一次播放会没有声音（浏览器把 context 挂起了）。
   */
  unlock(): void {
    const ctx = this.ensureContext()
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume()
    }
  }

  /** 开关音效 */
  setEnabled(on: boolean): void {
    this.enabled = on
    if (this.master) {
      this.master.gain.value = on ? this.volume : 0
    }
  }

  /** 设置音量 0~1 */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v))
    if (this.master && this.enabled) {
      this.master.gain.value = this.volume
    }
  }

  dispose(): void {
    this.ctx?.close()
    this.ctx = null
    this.master = null
    this.noiseBuffer = null
  }

  /**
   * 播放一个音效。
   *
   * @param name 音效名
   * @param power 0~1，用于按击球力度调整音高与音量
   */
  play(name: SfxName, power = 1): void {
    if (!this.enabled) return
    const ctx = this.ensureContext()
    if (!ctx || !this.master) return
    // 浏览器把页面切到后台时会挂起 context，这时不要打断
    if (ctx.state === 'suspended') return

    const p = Math.max(0, Math.min(1, power))
    switch (name) {
      case 'paddle':
        // 击球：干脆的"啪"。噪声负责摩擦感，正弦负责"芯"。
        this.noise({ dur: 0.09, freq: 1500 + p * 900, q: 1.1, gain: 0.5 * (0.5 + p * 0.5) })
        this.tone({ freq: 520 + p * 180, freqTo: 190, dur: 0.07, type: 'sine', gain: 0.42 })
        break
      case 'bounce':
        // 落台：比击球闷一点、短一点
        this.noise({ dur: 0.06, freq: 820, q: 1.4, gain: 0.26 })
        this.tone({ freq: 360, freqTo: 250, dur: 0.06, type: 'triangle', gain: 0.22 })
        break
      case 'net':
        // 触网：几乎只剩"噗"的一声
        this.noise({ dur: 0.13, freq: 380, filter: 'lowpass', gain: 0.2 })
        break
      case 'whiff':
        // 挥空：一条快速掠过的噪声
        this.noise({ dur: 0.2, freq: 700, freqTo: 2600, filter: 'bandpass', q: 0.8, gain: 0.16 })
        break
      case 'serve':
        this.tone({ freq: 720, dur: 0.05, type: 'square', gain: 0.12 })
        this.tone({ freq: 960, dur: 0.05, type: 'square', gain: 0.1, delay: 0.07 })
        break
      case 'point':
        // 得分：两声上行
        this.tone({ freq: 784, dur: 0.1, type: 'triangle', gain: 0.2 })
        this.tone({ freq: 1175, dur: 0.16, type: 'triangle', gain: 0.18, delay: 0.09 })
        break
      case 'win':
        this.tone({ freq: 523, dur: 0.16, type: 'triangle', gain: 0.2 })
        this.tone({ freq: 659, dur: 0.16, type: 'triangle', gain: 0.2, delay: 0.12 })
        this.tone({ freq: 880, dur: 0.32, type: 'triangle', gain: 0.22, delay: 0.24 })
        break
      case 'lose':
        this.tone({ freq: 392, dur: 0.18, type: 'triangle', gain: 0.2 })
        this.tone({ freq: 262, dur: 0.4, type: 'triangle', gain: 0.2, delay: 0.16 })
        break
      case 'ui':
        this.tone({ freq: 1250, dur: 0.022, type: 'square', gain: 0.07 })
        break
    }
  }

  // ---------------------------------------------------------------- 内部实现

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx
    if (typeof window === 'undefined') return null
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null

    const ctx = new Ctor()
    const master = ctx.createGain()
    master.gain.value = this.enabled ? this.volume : 0
    master.connect(ctx.destination)
    this.ctx = ctx
    this.master = master
    return ctx
  }

  /** 预生成 1 秒白噪声，后面切片用 */
  private ensureNoise(ctx: AudioContext): AudioBuffer | null {
    if (this.noiseBuffer) return this.noiseBuffer
    const len = Math.floor(ctx.sampleRate)
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < len; i++) {
      // 白噪声
      data[i] = Math.random() * 2 - 1
    }
    this.noiseBuffer = buffer
    return buffer
  }

  /** 单个振荡器音（可滑音） */
  private tone(opts: ToneOptions): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return

    const t0 = ctx.currentTime + (opts.delay ?? 0)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = opts.type ?? 'sine'
    osc.frequency.setValueAtTime(opts.freq, t0)
    if (opts.freqTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqTo), t0 + opts.dur)
    }

    const peak = opts.gain ?? 0.2
    // 快起快落：起音 4ms，尾部指数衰减，听起来才"脆"
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur)

    osc.connect(gain)
    gain.connect(master)
    osc.start(t0)
    osc.stop(t0 + opts.dur + 0.02)
  }

  /** 噪声脉冲（撞击、摩擦） */
  private noise(opts: NoiseOptions): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    const buffer = this.ensureNoise(ctx)
    if (!buffer) return

    const t0 = ctx.currentTime + (opts.delay ?? 0)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true

    const filter = ctx.createBiquadFilter()
    filter.type = opts.filter ?? 'bandpass'
    filter.frequency.setValueAtTime(opts.freq, t0)
    if (opts.freqTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, opts.freqTo), t0 + opts.dur)
    }
    filter.Q.value = opts.q ?? 1

    const gain = ctx.createGain()
    const peak = opts.gain ?? 0.2
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.003)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur)

    src.connect(filter)
    filter.connect(gain)
    gain.connect(master)
    src.start(t0, Math.random() * 0.5)
    src.stop(t0 + opts.dur + 0.02)
  }
}
