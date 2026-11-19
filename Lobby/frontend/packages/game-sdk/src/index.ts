/**
 * @lobby/game-sdk — 游戏接入大厅的唯一耦合面。
 *
 * 分两层：
 * - LobbyClient：连接管理（自动重连、断线自动重进房、心跳延迟）+ 事件订阅
 * - createLobbyStore：zustand 工厂，大厅 UI 与游戏共用的响应式状态
 *
 * 协议与 Lobby/backend/protocol crate 保持一致（snake_case 消息类型）。
 * 大厅是哑中继：玩法语义全部在 payload 里，由游戏自解释。
 */
import { create } from 'zustand'

// ---------- 协议类型（与 backend/protocol 对齐） ----------

export type MessageType =
  | 'ping'
  | 'pong'
  | 'join_game'
  | 'join_room'
  | 'leave_game'
  | 'match_found'
  | 'peer_joined'
  | 'peer_left'
  | 'room_state'
  | 'player_action'
  | 'peer_action'
  | 'game_state'
  | 'chat'
  | 'error'
  | 'matchmaking'

export interface WSMessage {
  msg_type: MessageType
  game_id?: string | null
  player_id?: string | null
  payload: unknown
}

export interface RoomPlayer {
  id: string
  name: string
}

export interface MatchFoundInfo {
  room_id: string
  player_id: string
  players: RoomPlayer[]
  max_players: number
}

export interface RoomStateInfo {
  room_id: string
  game_type: string
  players: RoomPlayer[]
  max_players: number
}

export interface ErrorInfo {
  code: string
  message: string
}

/** 同源 /ws：开发环境走 vite 代理，生产环境走 nginx 反代 */
export function defaultWsUrl(): string {
  if (typeof location === 'undefined') return 'ws://localhost:7080/ws'
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}

type Handler = (payload: any) => void

export interface LobbyClientOptions {
  url?: string
  /** 心跳间隔，毫秒。0 关闭心跳 */
  heartbeatIntervalMs?: number
  /** 断线是否自动重连并重进房（默认 true） */
  rejoin?: boolean
}

type ConnStatus = 'connecting' | 'open' | 'closed' | 'reconnecting'

/**
 * 大厅连接客户端。
 * 事件：status / match_found / peer_joined / peer_left / room_state /
 *      peer_action / game_state / chat / error / latency / message
 */
export class LobbyClient {
  private url: string
  private ws: WebSocket | null = null
  private handlers = new Map<string, Set<Handler>>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private lastPingSent = 0
  private attempts = 0
  private manualClose = false
  private lastJoin:
    | { kind: 'game'; gameType: string; maxPlayers?: number; playerName?: string }
    | { kind: 'room'; roomId: string; playerName?: string }
    | null = null
  readonly heartbeatIntervalMs: number
  readonly rejoin: boolean

  constructor(opts: LobbyClientOptions = {}) {
    this.url = opts.url ?? defaultWsUrl()
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 3000
    this.rejoin = opts.rejoin ?? true
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.manualClose = false
    this.emit('status', 'connecting' satisfies ConnStatus)
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.onopen = () => {
      this.attempts = 0
      this.emit('status', 'open' satisfies ConnStatus)
      // 断线重连后自动重进房（带齐身份，名字不回退默认值）
      if (this.rejoin && this.lastJoin) {
        if (this.lastJoin.kind === 'room') {
          this.send({
            msg_type: 'join_room',
            payload: { room_id: this.lastJoin.roomId, player_name: this.lastJoin.playerName ?? 'Player1' },
          })
        } else {
          this.sendJoin(this.lastJoin.gameType, this.lastJoin.maxPlayers, this.lastJoin.playerName)
        }
      }
      if (this.heartbeatIntervalMs > 0) this.startHeartbeat()
    }
    ws.onmessage = (ev) => {
      try {
        this.dispatch(JSON.parse(ev.data as string) as WSMessage)
      } catch {
        // 非 JSON 帧，忽略
      }
    }
    ws.onclose = () => {
      this.stopHeartbeat()
      this.ws = null
      this.emit('status', 'closed' satisfies ConnStatus)
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose 会随后触发，统一在那里处理
    }
  }

  /** 主动断开：不重连、不清除重进房意图（下次 connect 仍会重进房） */
  disconnect(): void {
    this.manualClose = true
    this.clearReconnect()
    this.stopHeartbeat()
    this.ws?.close()
    this.ws = null
  }

  joinGame(gameType: string, opts: { playerName?: string; maxPlayers?: number } = {}): void {
    this.lastJoin = { kind: 'game', gameType, maxPlayers: opts.maxPlayers, playerName: opts.playerName }
    this.sendJoin(gameType, opts.maxPlayers, opts.playerName)
  }

  /** 按 id 加入指定房间（大厅"实时房间"加入按钮）。 */
  joinRoom(roomId: string, opts: { playerName?: string } = {}): void {
    this.lastJoin = { kind: 'room', roomId, playerName: opts.playerName }
    this.send({
      msg_type: 'join_room',
      payload: { room_id: roomId, player_name: opts.playerName ?? 'Player1' },
    })
  }

  leaveGame(): void {
    this.lastJoin = null
    this.send({ msg_type: 'leave_game', payload: {} })
  }

  /** 输入上行（大厅转发给房内其他人，事件 peer_action） */
  sendAction(payload: unknown): void {
    this.send({ msg_type: 'player_action', payload })
  }

  /** 快照广播（权威主机用；大厅转发给房内其他人，事件 game_state） */
  sendState(payload: unknown): void {
    this.send({ msg_type: 'game_state', payload })
  }

  sendChat(text: string): void {
    this.send({ msg_type: 'chat', payload: { text } })
  }

  /** 原始消息发送（兼容旧用法） */
  send(msg: WSMessage): void {
    if (this.connected) this.ws!.send(JSON.stringify(msg))
  }

  /** 订阅事件，返回退订函数 */
  on(event: string, handler: Handler): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
    }
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler)
  }

  // ---------- 内部 ----------

  private sendJoin(gameType: string, maxPlayers?: number, playerName?: string): void {
    this.send({
      msg_type: 'join_game',
      payload: {
        game_type: gameType,
        player_name: playerName ?? 'Player1',
        ...(maxPlayers != null ? { max_players: maxPlayers } : {}),
      },
    })
  }

  private dispatch(msg: WSMessage): void {
    this.emit('message', msg)
    switch (msg.msg_type) {
      case 'match_found':
        this.emit('match_found', msg.payload)
        break
      case 'peer_joined':
        this.emit('peer_joined', msg.payload)
        break
      case 'peer_left':
        this.emit('peer_left', msg.payload)
        break
      case 'room_state':
        this.emit('room_state', msg.payload)
        break
      case 'peer_action':
        this.emit('peer_action', { from: msg.player_id, payload: msg.payload })
        break
      case 'game_state':
        this.emit('game_state', { from: msg.player_id, payload: msg.payload })
        break
      case 'chat':
        this.emit('chat', { from: msg.player_id, payload: msg.payload })
        break
      case 'pong': {
        const payload = msg.payload as { timestamp?: number }
        if (payload?.timestamp) this.emit('latency', Date.now() - payload.timestamp)
        break
      }
      case 'error':
        this.emit('error', msg.payload)
        break
      default:
        break
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return
      this.lastPingSent = Date.now()
      this.send({ msg_type: 'ping', payload: { timestamp: this.lastPingSent } })
    }, this.heartbeatIntervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.manualClose || !this.rejoin) return
    this.clearReconnect()
    const delay = Math.min(1000 * 2 ** Math.min(this.attempts, 4), 10000)
    this.attempts++
    this.reconnectTimer = setTimeout(() => {
      this.emit('status', 'reconnecting' satisfies ConnStatus)
      this.connect()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private emit(event: string, payload?: unknown): void {
    this.handlers.get(event)?.forEach((h) => {
      try {
        h(payload)
      } catch (e) {
        console.error('[game-sdk] handler error:', e)
      }
    })
  }
}

// ---------- zustand store 工厂 ----------

export interface LobbyStoreState {
  connected: boolean
  playerName: string
  roomId: string | null
  playerId: string | null
  /** 当前房间花名册（由 room_state 驱动） */
  players: RoomPlayer[]
  latency: number | null
  lastError: ErrorInfo | null
  client: LobbyClient
  setPlayerName: (name: string) => void
  connect: (playerName?: string) => void
  disconnect: () => void
  joinGame: (gameType: string, opts?: { maxPlayers?: number }) => void
  joinRoom: (roomId: string) => void
  leaveGame: () => void
  sendAction: (payload: unknown) => void
  sendState: (payload: unknown) => void
  /** 兼容旧用法的原始发送 */
  send: (msg: WSMessage) => void
}

export interface CreateLobbyStoreOptions {
  url?: string
  defaultPlayerName?: string
  /** 传 false 时由调用方自己控制 client 生命周期 */
  autoConnect?: boolean
}

export function createLobbyStore(opts: CreateLobbyStoreOptions = {}) {
  const client = new LobbyClient({ url: opts.url })
  let nameFromStorage = 'Player1'
  if (typeof sessionStorage !== 'undefined') {
    nameFromStorage = sessionStorage.getItem('playerName') ?? opts.defaultPlayerName ?? 'Player1'
  }

  const useStore = create<LobbyStoreState>()((set, get) => {
    client.on('status', (s: ConnStatus) => set({ connected: s === 'open' }))
    client.on('latency', (l: number) => set({ latency: l }))
    client.on('error', (e: ErrorInfo) => set({ lastError: e }))
    client.on('match_found', (info: MatchFoundInfo) =>
      set({ roomId: info.room_id, playerId: info.player_id, players: info.players })
    )
    client.on('room_state', (info: RoomStateInfo) => set({ players: info.players }))

    return {
      connected: false,
      playerName: nameFromStorage,
      roomId: null,
      playerId: null,
      players: [],
      latency: null,
      lastError: null,
      client,

      setPlayerName: (name) => {
        set({ playerName: name })
        try {
          sessionStorage.setItem('playerName', name)
        } catch {
          /* 隐私模式下忽略 */
        }
      },

      connect: (playerName) => {
        if (playerName) get().setPlayerName(playerName)
        client.connect()
      },

      disconnect: () => client.disconnect(),

      joinGame: (gameType, o) =>
        client.joinGame(gameType, { playerName: get().playerName, maxPlayers: o?.maxPlayers }),

      joinRoom: (roomId) => client.joinRoom(roomId, { playerName: get().playerName }),

      leaveGame: () => client.leaveGame(),

      sendAction: (payload) => client.sendAction(payload),

      sendState: (payload) => client.sendState(payload),

      send: (msg) => client.send(msg),
    }
  })

  if (opts.autoConnect !== false) client.connect()
  return useStore
}
