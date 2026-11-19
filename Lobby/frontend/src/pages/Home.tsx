import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Header, Layout } from '../components'
import { useGameStore } from '../store/gameStore'
import { GAMES, launchPathOf, type GameEntry } from '../games/registry'

interface LiveRoom {
  id: string
  game_type: string
  player_count: number
  max_players: number
}

function PosterCard({ game, playerName, onPlay }: { game: GameEntry; playerName: string; onPlay: (g: GameEntry) => void }) {
  return (
    <div
      onClick={() => onPlay(game)}
      className="game-card rounded-3xl overflow-hidden cursor-pointer group relative"
    >
      {/* 海报区 */}
      <div className={`relative h-40 bg-gradient-to-br ${game.gradient} flex items-center justify-center`}>
        <div className="absolute inset-0 bg-grid opacity-40" />
        <span className="game-icon text-7xl drop-shadow-lg relative z-10">{game.icon}</span>
        <span className="absolute top-3 right-3 px-2.5 py-1 rounded-full bg-black/30 backdrop-blur text-white text-xs font-bold">
          {game.players} 人
        </span>
        {game.kind === 'external' && (
          <span className="absolute top-3 left-3 px-2.5 py-1 rounded-full bg-white/25 backdrop-blur text-white text-xs font-bold">
            🔗 外接
          </span>
        )}
        {game.id === 'snake-arena' && (
          <span className="absolute top-3 left-3 px-2.5 py-1 rounded-full bg-yellow-300 text-yellow-900 text-xs font-bold shadow">
            🆕 多人联机
          </span>
        )}
      </div>
      {/* 信息区 */}
      <div className="p-5">
        <h3 className="text-lg font-bold text-gray-800 group-hover:text-primary-600 transition-colors">
          {game.name}
        </h3>
        <p className="text-gray-500 text-sm mt-1 leading-relaxed" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {game.description}
        </p>
        <div className="flex flex-wrap gap-1.5 mt-3 mb-4">
          {game.features?.slice(0, 3).map((f) => (
            <span key={f} className="px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-xs">
              {f}
            </span>
          ))}
        </div>
        <button className="btn-primary w-full py-2.5 rounded-xl text-white font-bold text-sm">
          开始游戏 →
        </button>
      </div>
      {/* 点击目标 */}
      <span className="sr-only">{playerName}</span>
    </div>
  )
}

export default function Home() {
  const playerName = useGameStore((state) => state.playerName)
  const navigate = useNavigate()
  const [rooms, setRooms] = useState<LiveRoom[]>([])

  // 实时房间：3s 轮询
  useEffect(() => {
    let alive = true
    const poll = () =>
      fetch('/api/rooms')
        .then((r) => r.json())
        .then((d) => alive && setRooms(d.rooms ?? []))
        .catch(() => {})
    poll()
    const iv = setInterval(poll, 3000)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [])

  const handlePlay = (game: GameEntry) => {
    if (game.kind === 'external') {
      // 整页跳转：外接游戏页不带 COEP（SPA 内导航不会重新取文档，隔离态洗不掉）
      window.location.assign(`/games/ext/${game.id}`)
    } else {
      navigate(launchPathOf(game, playerName))
    }
  }

  return (
    <Layout>
      <Header />

      <main className="pb-12">
        {/* ===== Hero 横幅 ===== */}
        <section className="mx-8 mt-6 rounded-3xl overflow-hidden relative bg-gradient-to-br from-primary-600 via-indigo-600 to-fuchsia-600 shadow-2xl">
          <div className="absolute inset-0 bg-grid opacity-30" />
          <span className="absolute right-[8%] top-4 text-7xl opacity-25 select-none">🏓</span>
          <span className="absolute right-[20%] bottom-2 text-6xl opacity-20 select-none">🏎️</span>
          <span className="absolute left-[45%] top-2 text-5xl opacity-20 select-none">🎯</span>
          <div className="relative z-10 px-10 py-10 flex items-center justify-between gap-6 flex-wrap">
            <div>
              <h1 className="text-4xl font-extrabold text-white tracking-tight drop-shadow">
                🎮 MyGames 游戏大厅
              </h1>
              <p className="text-white/85 mt-2 text-lg">即点即玩 · 多人联机 · 体感对战 —— 内置游戏与外部精品一网打尽</p>
            </div>
            <div className="flex gap-3">
              <div className="px-5 py-3 rounded-2xl bg-white/15 backdrop-blur text-white text-center min-w-28">
                <p className="text-2xl font-extrabold">{GAMES.length}</p>
                <p className="text-xs text-white/80 mt-0.5">可玩游戏</p>
              </div>
              <div className="px-5 py-3 rounded-2xl bg-white/15 backdrop-blur text-white text-center min-w-28">
                <p className="text-2xl font-extrabold">{rooms.length}</p>
                <p className="text-xs text-white/80 mt-0.5">在线房间</p>
              </div>
            </div>
          </div>
        </section>

        {/* ===== 实时房间 ===== */}
        <section className="mx-8 mt-6 glass-card rounded-2xl px-6 py-4 flex items-center gap-4 flex-wrap">
          <span className="font-bold text-gray-700 flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" /> 实时房间
          </span>
          {rooms.length === 0 ? (
            <span className="text-gray-400 text-sm">暂无在线房间 —— 开一局 Snake Arena，好友即可看到你的房间</span>
          ) : (
            rooms.map((r) => (
              <span key={r.id} className="px-3 py-1.5 rounded-xl bg-white/70 border border-primary-100 text-sm text-gray-600 font-mono">
                {GAMES.find((g) => g.id === r.game_type)?.icon ?? '🎮'} {r.game_type} · {r.player_count}/{r.max_players} · {r.id.slice(0, 8)}
              </span>
            ))
          )}
        </section>

        {/* ===== 海报墙 ===== */}
        <section className="mx-8 mt-8">
          <div className="flex items-center gap-4 mb-5">
            <div className="section-line" />
            <h2 className="text-2xl font-bold text-gray-800">游戏墙</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {GAMES.map((game) => (
              <PosterCard key={game.id} game={game} playerName={playerName} onPlay={handlePlay} />
            ))}
          </div>
        </section>

        <footer className="mt-12 text-center text-gray-400 text-sm">
          <p>MyGames · AI 游戏平台</p>
        </footer>
      </main>
    </Layout>
  )
}
