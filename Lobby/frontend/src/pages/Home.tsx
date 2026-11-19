import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Header, Layout } from '../components'
import { useGameStore } from '../store/gameStore'
import { GAMES, findGame, launchPathOf, type GameEntry } from '../games/registry'

interface LiveRoom {
  id: string
  game_type: string
  player_count: number
  max_players: number
}

interface LeaderRow {
  player: string
  score: number
}

/** 数字滚动动画 */
function useCountUp(target: number, durationMs = 700): number {
  const [value, setValue] = useState(target)
  const fromRef = useRef(target)
  useEffect(() => {
    const from = fromRef.current
    if (from === target) return
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(Math.round(from + (target - from) * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs])
  return value
}

function StatChip({ label, value }: { label: string; value: number }) {
  const shown = useCountUp(value)
  return (
    <div className="px-5 py-3 rounded-2xl bg-white/10 backdrop-blur border border-white/15 text-white text-center min-w-28">
      <p className="text-3xl font-extrabold pulse-num font-mono">{shown}</p>
      <p className="text-xs text-white/80 mt-0.5">{label}</p>
    </div>
  )
}

function PosterCard({ game, index, onPlay }: { game: GameEntry; index: number; onPlay: (g: GameEntry) => void }) {
  return (
    <div
      onClick={() => onPlay(game)}
      className="game-card rounded-3xl cursor-pointer group rise-in"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      {/* 海报区 */}
      <div className={`relative h-40 bg-gradient-to-br ${game.gradient} flex items-center justify-center`}>
        <div className="absolute inset-0 bg-grid opacity-40" />
        <span className="game-icon text-7xl drop-shadow-lg relative z-10">{game.icon}</span>
        <span className="absolute top-3 right-3 px-2.5 py-1 rounded-full bg-black/40 backdrop-blur text-white text-xs font-bold">
          {game.players} 人
        </span>
        {game.kind === 'external' ? (
          <span className="absolute top-3 left-3 px-2.5 py-1 rounded-full bg-white/25 backdrop-blur text-white text-xs font-bold">
            🔗 外接
          </span>
        ) : game.id === 'snake-arena' ? (
          <span className="absolute top-3 left-3 px-2.5 py-1 rounded-full bg-yellow-300 text-yellow-900 text-xs font-bold shadow">
            🆕 多人联机
          </span>
        ) : null}
      </div>
      {/* 信息区 */}
      <div className="p-5">
        <h3 className="text-lg font-bold text-slate-100 group-hover:text-sky-300 transition-colors">
          {game.name}
        </h3>
        <p
          className="text-slate-400 text-sm mt-1 leading-relaxed"
          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
        >
          {game.description}
        </p>
        <div className="flex flex-wrap gap-1.5 mt-3 mb-4">
          {game.features?.slice(0, 3).map((f) => (
            <span key={f} className="px-2 py-0.5 bg-slate-800/80 text-slate-400 rounded-full text-xs">
              {f}
            </span>
          ))}
        </div>
        <button className="btn-primary w-full py-2.5 rounded-xl text-white font-bold text-sm">开始游戏 →</button>
      </div>
    </div>
  )
}

const MEDALS = ['🥇', '🥈', '🥉']

export default function Home() {
  const playerName = useGameStore((state) => state.playerName)
  const navigate = useNavigate()
  const [rooms, setRooms] = useState<LiveRoom[]>([])
  const [leaders, setLeaders] = useState<LeaderRow[]>([])

  // 实时房间：3s 轮询（页面隐藏时暂停）
  useEffect(() => {
    let alive = true
    let iv: ReturnType<typeof setInterval> | null = null
    const poll = () =>
      fetch('/api/rooms')
        .then((r) => r.json())
        .then((d) => alive && setRooms(d.rooms ?? []))
        .catch(() => {})
    const start = () => {
      poll()
      iv = setInterval(poll, 3000)
    }
    const stop = () => {
      if (iv) clearInterval(iv)
      iv = null
    }
    const onVis = () => (document.hidden ? stop() : start())
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVis)
      stop()
    }
  }, [])

  // Snake Arena 排行榜：10s 轮询
  useEffect(() => {
    let alive = true
    const poll = () =>
      fetch('/api/leaderboard?game_type=snake-arena')
        .then((r) => r.json())
        .then((d) => alive && setLeaders(d.entries ?? []))
        .catch(() => {})
    poll()
    const iv = setInterval(poll, 10000)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [])

  const handlePlay = (game: GameEntry) => {
    if (game.kind === 'external') {
      window.location.assign(`/games/ext/${game.id}`)
    } else {
      navigate(launchPathOf(game, playerName))
    }
  }

  const handleJoin = (room: LiveRoom) => {
    const game = findGame(room.game_type)
    if (!game || !game.supportsRoomJoin) return
    navigate(`${launchPathOf(game, playerName)}&room=${encodeURIComponent(room.id)}`)
  }

  const playersOnline = rooms.reduce((sum, r) => sum + r.player_count, 0)

  return (
    <Layout>
      <Header />

      <main className="pb-12">
        {/* ===== Hero ===== */}
        <section className="mx-8 mt-6 rounded-3xl overflow-hidden relative hero-animated shadow-2xl border border-white/10">
          <div className="absolute inset-0 bg-grid opacity-30" />
          <span className="float-icon right-[10%] top-5 text-7xl opacity-30">🏓</span>
          <span className="float-icon right-[22%] bottom-3 text-6xl opacity-25" style={{ animationDelay: '1.2s' }}>
            🏎️
          </span>
          <span className="float-icon left-[46%] top-2 text-5xl opacity-25" style={{ animationDelay: '2.1s' }}>
            🎯
          </span>
          <span className="float-icon right-[38%] top-8 text-4xl opacity-20" style={{ animationDelay: '0.6s' }}>
            🕹️
          </span>
          <div className="relative z-10 px-10 py-10 flex items-center justify-between gap-6 flex-wrap">
            <div>
              <h1 className="text-5xl font-extrabold text-white tracking-tight drop-shadow-[0_2px_20px_rgba(0,0,0,0.35)]">
                🎮 MyGames 游戏大厅
              </h1>
              <p className="text-white/85 mt-3 text-lg">即点即玩 · 多人联机 · 体感对战 —— 内置游戏与外部精品一网打尽</p>
            </div>
            <div className="flex gap-3">
              <StatChip label="可玩游戏" value={GAMES.length} />
              <StatChip label="在线房间" value={rooms.length} />
              <StatChip label="对局中玩家" value={playersOnline} />
            </div>
          </div>
        </section>

        {/* ===== 实时房间（可加入） ===== */}
        <section className="mx-8 mt-6 glass-card rounded-2xl px-6 py-4 flex items-center gap-4 flex-wrap">
          <span className="font-bold text-slate-200 flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" /> 实时房间
          </span>
          {rooms.length === 0 ? (
            <span className="text-slate-500 text-sm">暂无在线房间 —— 开一局 Snake Arena，好友即可在这里看到并加入你的房间</span>
          ) : (
            rooms.map((r) => {
              const game = findGame(r.game_type)
              const joinable = !!game?.supportsRoomJoin
              return (
                <span
                  key={r.id}
                  className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-xl bg-slate-900/70 border border-sky-500/20"
                >
                  <span className="text-lg">{game?.icon ?? '🎮'}</span>
                  <span className="text-sm text-slate-300">
                    {game?.name ?? r.game_type}
                    <span className="font-mono text-slate-500 ml-1.5 text-xs">{r.id.slice(0, 8)}</span>
                  </span>
                  <span className="player-count-badge px-2 py-0.5 rounded-full text-xs font-bold">
                    {r.player_count}/{r.max_players}
                  </span>
                  {joinable ? (
                    <button
                      onClick={() => handleJoin(r)}
                      className="btn-secondary px-3 py-1 rounded-lg text-xs font-bold"
                    >
                      加入 →
                    </button>
                  ) : (
                    <span className="text-slate-500 text-xs">观战中</span>
                  )}
                </span>
              )
            })
          )}
        </section>

        {/* ===== 排行榜 ===== */}
        {leaders.length > 0 && (
          <section className="mx-8 mt-6 glass-card rounded-2xl px-6 py-4">
            <span className="font-bold text-slate-200 flex items-center gap-2">
              🏆 Snake Arena 排行榜
            </span>
            <div className="flex gap-6 mt-3 flex-wrap">
              {leaders.slice(0, 5).map((e, i) => (
                <span key={i} className="flex items-center gap-2 text-sm">
                  <span>{MEDALS[i] ?? `${i + 1}.`}</span>
                  <span className="text-slate-300">{e.player}</span>
                  <span className="text-sky-300 font-bold font-mono">{e.score}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        {/* ===== 海报墙 ===== */}
        <section className="mx-8 mt-8">
          <div className="flex items-center gap-4 mb-5">
            <div className="section-line" />
            <h2 className="text-2xl font-bold text-slate-100">游戏墙</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {GAMES.map((game, i) => (
              <PosterCard key={game.id} game={game} index={i} onPlay={handlePlay} />
            ))}
          </div>
        </section>

        <footer className="mt-12 text-center text-slate-500 text-sm">
          <p>MyGames · AI 游戏平台</p>
        </footer>
      </main>
    </Layout>
  )
}
