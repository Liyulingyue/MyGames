/**
 * 外部游戏承载页 —— 嵌入契约的大厅侧实现。
 *
 * iframe 加载外部游戏 → 注入身份（postMessage lobby:hello + ?player= 查询参数）
 * → 游戏回 lobby:ready / 上报 lobby:score → 大厅落库 /api/scores。
 * 协议详见 public/lobby-embed.js 头注释。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Layout } from '../../components'
import { useGameStore } from '../../store/gameStore'
import { findGame } from '../../games/registry'

interface LobbyHello {
  type: 'lobby:hello'
  game_id: string
  player_name: string
}
interface LobbyReady {
  type: 'lobby:ready'
}
interface LobbyScore {
  type: 'lobby:score'
  score: number
}
type GameMessage = LobbyReady | LobbyScore

export default function ExternalGameHost() {
  const { id } = useParams<{ id: string }>()
  const game = findGame(id)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [handshook, setHandshook] = useState(false)
  const [scoreRelayed, setScoreRelayed] = useState<number | null>(null)
  const playerName = useGameStore((s) => s.playerName)

  const src = game?.url
    ? `${game.url}${game.url.includes('?') ? '&' : '?'}player=${encodeURIComponent(playerName)}&lobby=1`
    : ''

  const postHello = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win || !game?.url || !id) return
    const msg: LobbyHello = { type: 'lobby:hello', game_id: id, player_name: playerName }
    // targetOrigin 限定为游戏自己的 origin，身份不外泄
    win.postMessage(msg, new URL(game.url).origin)
  }, [game?.url, id, playerName])

  // 身份注入 + 成绩回收
  useEffect(() => {
    if (!game?.url || !id) return

    const onMessage = (e: MessageEvent) => {
      // 只信任我们自己 iframe 发来的消息
      if (e.source !== iframeRef.current?.contentWindow) return
      const msg = e.data as GameMessage
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'lobby:ready') {
        setHandshook(true)
        postHello() // 游戏就绪后（重）注入身份，覆盖游戏自身早于 iframe load 的情况
      }
      if (msg.type === 'lobby:score') {
        fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game_type: id, player_name: playerName, score: msg.score }),
        })
          .then((r) => r.json())
          .then((d) => setScoreRelayed(d.rank ?? null))
          .catch(() => {})
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [game?.url, id, playerName, postHello])

  if (!game || game.kind !== 'external' || !game.url) {
    return (
      <Layout>
        <main className="p-16 text-center text-gray-500">
          <p className="text-5xl mb-4">🕹️</p>
          <p className="text-lg">找不到外接游戏「{id}」，请检查大厅注册表（src/games/registry.ts）。</p>
        </main>
      </Layout>
    )
  }

  return (
    <Layout>
      {/* 本页必须整页加载（无 COEP 隔离），返回也走整页跳转，避免 SPA 内导航弄脏隔离状态 */}
      <header className="header-gradient backdrop-blur-sm sticky top-0 z-50">
        <div className="px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a
              href="/"
              className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition-colors text-sm font-medium"
            >
              ← 返回
            </a>
            <h1 className="text-2xl font-extrabold text-gradient tracking-tight">
              {game.icon} {game.name}
            </h1>
          </div>
          <span className="text-xs text-gray-500">外部游戏 · {new URL(game.url).host}</span>
        </div>
      </header>
      <main className="relative flex-1 h-[calc(100vh-80px)]">
        <iframe
          ref={iframeRef}
          src={src}
          title={game.name}
          onLoad={() => {
            setLoaded(true)
            postHello()
          }}
          className="w-full h-full border-0"
          allow="camera; microphone; fullscreen"
        />
        {!loaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/85 text-white">
            <span className="text-5xl animate-bounce">{game.icon}</span>
            <p className="text-lg font-bold">正在连接 {game.name}…</p>
            <p className="text-sm text-slate-300 max-w-md text-center">
              需要先启动外部游戏本体。开发模式：在 PingpongGame 目录执行 <code className="bg-black/40 px-2 py-0.5 rounded">npm run dev</code>（:5180）；
              生产模式：docker（:16083）。
            </p>
            <p className="text-xs text-slate-400">若长时间空白，请确认游戏已启动且地址 {game.url} 可访问</p>
          </div>
        )}
        {loaded && !handshook && (
          <div className="absolute bottom-4 left-4 bg-slate-800/80 text-slate-300 text-xs px-3 py-2 rounded-lg">
            游戏已载入。该游戏尚未接入嵌入脚本（lobby-embed.js），身份注入与成绩回传未启用
          </div>
        )}
        {handshook && scoreRelayed != null && (
          <div className="absolute top-4 right-4 bg-green-500/90 text-white text-sm font-bold px-4 py-2 rounded-xl shadow-lg">
            ✅ 成绩已上报 · 第 {scoreRelayed} 名
          </div>
        )}
      </main>
    </Layout>
  )
}
