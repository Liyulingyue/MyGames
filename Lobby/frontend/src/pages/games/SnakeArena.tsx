/**
 * Snake Arena —— 平台第一个原生联机游戏（参考实现）。
 *
 * 架构：主机权威 + 大厅哑中继
 * - 房主（花名册第一位）本地跑 sim.ts 权威模拟，10Hz 快照 sendState 广播
 * - 其他玩家 sendAction 上行输入，渲染来自房主快照
 * - 房主掉线 → 花名册顶替者以"最后收到的快照"无缝接管模拟（主机迁移零成本）
 * - 终局后各自上报成绩到 /api/scores，展示 /api/leaderboard
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Header, Layout } from '../../components'
import { useGameStore } from '../../store/gameStore'
import {
  addSnake,
  createSim,
  GRID_H,
  GRID_W,
  leaderOf,
  removeSnake,
  ROUND_TICKS,
  setDirection,
  startRound,
  stepTick,
  summarize,
  TICK_MS,
  type Dir,
  type SimState,
  type SimSummary,
} from '../../games/snake-arena/sim'

const COLORS = ['#38bdf8', '#f87171', '#4ade80', '#facc15']
const CELL = 20
const CANVAS_W = GRID_W * CELL
const CANVAS_H = GRID_H * CELL
const GAME_TYPE = 'snake-arena'

interface LeaderboardEntry {
  player: string
  score: number
  at: number
}

const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  W: 'up', S: 'down', A: 'left', D: 'right',
}

export default function SnakeArena() {
  const [searchParams] = useSearchParams()

  const simRef = useRef<SimState>(createSim())
  const isHostRef = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scoreSubmittedRef = useRef(false)

  const connected = useGameStore((s) => s.connected)
  const playerId = useGameStore((s) => s.playerId)
  const playerName = useGameStore((s) => s.playerName)
  const roomId = useGameStore((s) => s.roomId)
  const players = useGameStore((s) => s.players)
  const latency = useGameStore((s) => s.latency)

  const [isHost, setIsHost] = useState(false)
  const [summary, setSummary] = useState<SimSummary>(() => summarize(simRef.current))
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])

  // 1) 挂载：接入大厅并进房（?room= 指定房间加入，否则按游戏类型自动分配）
  useEffect(() => {
    const g = useGameStore.getState()
    const name = searchParams.get('player') || g.playerName || 'Player1'
    if (name !== g.playerName) g.setPlayerName(name)
    const roomParam = searchParams.get('room')
    g.connect()
    if (roomParam) {
      g.joinRoom(roomParam)
    } else {
      g.joinGame(GAME_TYPE)
    }
    return () => {
      useGameStore.getState().disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 2) 主机身份：花名册第一位
  const hostId = players[0]?.id ?? null
  useEffect(() => {
    const amHost = !!playerId && hostId === playerId
    isHostRef.current = amHost
    setIsHost(amHost)
  }, [playerId, hostId])

  // 3) 房主：花名册 ↔ 模拟蛇同步（进人加蛇、走人删蛇；中途进房直接可玩）
  useEffect(() => {
    if (!isHost) return
    const sim = simRef.current
    for (const p of players) {
      if (!sim.snakes.some((s) => s.id === p.id)) addSnake(sim, p.id, p.name)
    }
    for (const s of [...sim.snakes]) {
      if (!players.some((p) => p.id === s.id)) removeSnake(sim, s.id)
    }
    setSummary(summarize(sim))
  }, [isHost, players])

  // 4) 订阅：非主机收快照；主机收对端输入
  useEffect(() => {
    const client = useGameStore.getState().client
    const offs = [
      client.on('game_state', ({ payload }: { payload: unknown }) => {
        if (isHostRef.current) return // 主机不信远端快照
        simRef.current = payload as SimState
        setSummary(summarize(simRef.current))
      }),
      client.on('peer_action', ({ from, payload }: { from?: string | null; payload: unknown }) => {
        if (!isHostRef.current || !from) return
        const dir = (payload as { dir?: Dir }).dir
        if (dir) setDirection(simRef.current, from, dir)
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // 5) 主机模拟循环：tick + 10Hz 快照广播
  useEffect(() => {
    if (!isHost) return
    const iv = setInterval(() => {
      const sim = simRef.current
      if (sim.phase === 'running') stepTick(sim)
      useGameStore.getState().sendState(sim)
      setSummary(summarize(sim))
    }, TICK_MS)
    return () => clearInterval(iv)
  }, [isHost])

  // 6) 终局：上报自己的成绩并拉取排行榜
  useEffect(() => {
    if (summary.phase !== 'ended') {
      scoreSubmittedRef.current = false
      return
    }
    if (scoreSubmittedRef.current) return
    const mine = summary.players.find((p) => p.id === playerId)
    if (!mine) return
    scoreSubmittedRef.current = true
    fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_type: GAME_TYPE, player_name: playerName, score: mine.score }),
    })
      .then(() => fetch(`/api/leaderboard?game_type=${GAME_TYPE}`))
      .then((r) => r.json())
      .then((d) => setLeaderboard(d.entries ?? []))
      .catch(() => {})
  }, [summary.phase, summary.players, playerId, playerName])

  // 7) 输入：主机本地直接驱动模拟，其他人走中继
  const handleDir = useCallback((dir: Dir) => {
    const g = useGameStore.getState()
    if (isHostRef.current && g.playerId) {
      setDirection(simRef.current, g.playerId, dir)
    } else {
      g.sendAction({ dir })
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = KEY_DIRS[e.key]
      if (!dir) return
      e.preventDefault()
      handleDir(dir)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleDir])

  // 8) 画布渲染：rAF 直接读 simRef，不经过 React 状态
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0

    const draw = () => {
      const sim = simRef.current
      ctx.fillStyle = '#0f172a'
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

      // 网格
      ctx.strokeStyle = '#1e293b'
      ctx.lineWidth = 1
      for (let x = 0; x <= GRID_W; x += 4) {
        ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, CANVAS_H); ctx.stroke()
      }
      for (let y = 0; y <= GRID_H; y += 4) {
        ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(CANVAS_W, y * CELL); ctx.stroke()
      }

      // 食物
      ctx.fillStyle = '#ef4444'
      for (const f of sim.foods) {
        ctx.beginPath()
        ctx.arc(f.x * CELL + CELL / 2, f.y * CELL + CELL / 2, CELL * 0.32, 0, Math.PI * 2)
        ctx.fill()
      }

      // 蛇
      for (const s of sim.snakes) {
        const color = COLORS[s.color % COLORS.length]
        for (let i = 0; i < s.body.length; i++) {
          const seg = s.body[i]
          ctx.fillStyle = i === 0 ? color : `${color}99`
          ctx.fillRect(seg.x * CELL + 1, seg.y * CELL + 1, CELL - 2, CELL - 2)
        }
        if (s.body.length > 0) {
          const head = s.body[0]
          ctx.fillStyle = '#e2e8f0'
          ctx.font = '10px sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText(s.name, head.x * CELL + CELL / 2, head.y * CELL - 3)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  const startGame = useCallback(() => {
    if (!isHostRef.current) return
    startRound(simRef.current)
  }, [])

  const winner = summary.phase === 'ended' ? leaderOf(simRef.current) : null
  const myEntry = summary.players.find((p) => p.id === playerId)
  const sortedPlayers = [...summary.players].sort((a, b) => b.score - a.score)
  const secondsLeft = Math.ceil(summary.remaining / (1000 / TICK_MS))

  return (
    <Layout>
      <Header title="🕹️ Snake Arena" showBack />

      <main className="flex h-[calc(100vh-80px)] p-4 gap-4">
        {/* 画布 */}
        <div className="flex-1 flex items-center justify-center">
          <div className="relative">
            <canvas
              ref={canvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              className="rounded-xl border-2 border-slate-700 shadow-2xl"
            />
            {summary.phase === 'lobby' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/70 rounded-xl">
                <p className="text-white text-xl font-bold">等待开局</p>
                <p className="text-slate-300 text-sm">房间成员 {players.length} 人（支持 1-4 人，单人可练习）</p>
                {isHost ? (
                  <button
                    onClick={startGame}
                    className="mt-2 px-8 py-3 bg-gradient-to-r from-sky-500 to-blue-600 text-white font-bold rounded-xl hover:from-sky-600 hover:to-blue-700"
                  >
                    开始对局
                  </button>
                ) : (
                  <p className="text-slate-400 text-sm">等待房主开始…</p>
                )}
              </div>
            )}
            {summary.phase === 'ended' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/80 rounded-xl">
                <p className="text-white text-2xl font-bold">🏁 时间到</p>
                {winner && (
                  <p className="text-yellow-300 text-xl font-bold">🏆 {winner.name} · {winner.score} 分</p>
                )}
                {leaderboard.length > 0 && (
                  <div className="text-slate-300 text-sm text-center">
                    <p className="font-bold mb-1">历史排行榜</p>
                    {leaderboard.slice(0, 5).map((e, i) => (
                      <p key={i}>{i + 1}. {e.player} — {e.score}</p>
                    ))}
                  </div>
                )}
                {isHost ? (
                  <button
                    onClick={startGame}
                    className="mt-2 px-8 py-3 bg-gradient-to-r from-sky-500 to-blue-600 text-white font-bold rounded-xl hover:from-sky-600 hover:to-blue-700"
                  >
                    再来一局
                  </button>
                ) : (
                  <p className="text-slate-400 text-sm">等待房主开下一局…</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 侧栏 */}
        <div className="w-80 flex-shrink-0 flex flex-col gap-3 overflow-y-auto">
          <div className="bg-slate-800/60 rounded-xl p-4 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-slate-400 text-xs">连接</span>
              <span className={`text-xs font-bold ${connected ? 'text-green-400' : 'text-red-400'}`}>
                {connected ? `已连接${latency != null ? ` · ${latency}ms` : ''}` : '未连接'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400 text-xs">房间</span>
              <span className="text-slate-200 text-xs font-mono">{roomId ? roomId.slice(0, 8) : '…'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400 text-xs">身份</span>
              <span className={`text-xs font-bold ${isHost ? 'text-yellow-300' : 'text-slate-200'}`}>
                {isHost ? '主机（权威模拟）' : '客户端（快照渲染）'}
              </span>
            </div>
          </div>

          <div className="bg-slate-800/60 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-white font-bold">得分</span>
              {summary.phase === 'running' && (
                <span className="text-sky-300 font-mono font-bold">{secondsLeft}s</span>
              )}
            </div>
            <div className="space-y-2">
              {sortedPlayers.map((p) => (
                <div key={p.id} className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-sm" style={{ background: COLORS[p.color % COLORS.length] }} />
                  <span className={`text-sm flex-1 truncate ${p.id === playerId ? 'text-white font-bold' : 'text-slate-300'}`}>
                    {p.name}{p.id === playerId ? '（你）' : ''}
                  </span>
                  <span className="text-slate-400 text-xs">
                    {p.alive ? '' : '💀 '}
                  </span>
                  <span className="text-white font-mono font-bold">{p.score}</span>
                </div>
              ))}
              {sortedPlayers.length === 0 && (
                <p className="text-slate-500 text-sm">等待玩家加入…</p>
              )}
            </div>
          </div>

          <div className="bg-slate-800/60 rounded-xl p-4 text-slate-300 text-sm space-y-1.5">
            <p>🎮 方向键 / WASD 控制转向</p>
            <p>🍎 吃食物 +1 分，撞墙撞蛇死亡</p>
            <p>⏱️ {ROUND_TICKS / 10} 秒一局，死后 2 秒复活</p>
            {!isHost && <p>📡 你的输入经大厅中继给主机</p>}
          </div>

          {myEntry && (
            <div className="mt-auto bg-slate-800/60 rounded-xl p-4">
              <p className="text-slate-400 text-xs mb-1">我的分数</p>
              <p className="text-white text-3xl font-bold font-mono">{myEntry.score}</p>
            </div>
          )}
        </div>
      </main>
    </Layout>
  )
}
