import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useGameStore } from '../store/gameStore'

interface HeaderProps {
  title?: string
  showBack?: boolean
}

export default function Header({ title = 'MyGames', showBack = false }: HeaderProps) {
  const { connected, latency, connect, disconnect, roomId, playerName, setPlayerName } = useGameStore()

  useEffect(() => {
    const stored = sessionStorage.getItem('playerName')
    if (stored) {
      setPlayerName(stored)
    }
  }, [setPlayerName])

  const handleConnect = () => {
    if (connected) {
      disconnect()
    } else {
      sessionStorage.setItem('playerName', playerName)
      connect(playerName)
    }
  }

  return (
    <header className="header-gradient backdrop-blur-sm sticky top-0 z-50">
      <div className="px-8 py-5 flex items-center justify-between">
        <div className="flex items-center gap-4">
          {showBack && (
            <Link 
              to="/" 
              className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition-colors text-sm font-medium"
            >
              ← 返回
            </Link>
          )}
          <div>
            <h1 className="text-3xl font-extrabold text-gradient tracking-tight">
              {title}
            </h1>
            <p className="text-gray-500 mt-0.5 text-sm">AI 游戏平台 · 体感 + 智能对战</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={playerName}
              onChange={e => setPlayerName(e.target.value)}
              placeholder="玩家名称"
              className="px-4 py-2 rounded-xl bg-slate-800/80 border border-slate-700 text-slate-100 placeholder-slate-500 text-sm w-32 focus:border-sky-500 focus:outline-none transition-colors"
            />
            <button
              onClick={handleConnect}
              className={`px-4 py-2 rounded-xl font-bold text-white text-sm whitespace-nowrap ${
                connected ? 'bg-slate-700 hover:bg-slate-600' : 'btn-primary'
              }`}
            >
              {connected ? '断开连接' : '连接服务器'}
            </button>
            <div className="flex flex-col items-center">
              <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold ${
                connected ? 'badge-success' : 'badge-disconnected'
              }`}>
                {connected ? '🟢 已连接' : '🔴 未连接'}
              </span>
              {connected && roomId && (
                <span className="text-xs text-slate-400 mt-1 font-medium">房间: {roomId.slice(0, 8)}</span>
              )}
            </div>
          </div>
          {connected && latency !== null && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-sky-500/10 border border-sky-500/30">
              <span className="text-sky-300 font-semibold text-sm">延迟: {latency}ms</span>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}