/**
 * MyGames 大厅嵌入契约 —— 外部游戏接入脚本（可选但强烈推荐）。
 *
 * 外部游戏（如 PingpongGame）只需一行：
 *   <script src="http://<lobby-host>/lobby-embed.js"></script>
 *
 * 提供：
 * - 自动向大厅宣告 lobby:ready
 * - 监听大厅注入的 lobby:hello（player_name / game_id），并以 'lobby:hello' DOM 事件转发给游戏
 * - window.LobbyEmbed.reportScore(score) 把成绩回传大厅（大厅落库到 /api/scores）
 *
 * 消息契约（postMessage，双向 *）：
 *   大厅 → 游戏: { type: 'lobby:hello',  game_id, player_name }
 *   游戏 → 大厅: { type: 'lobby:ready' }
 *   游戏 → 大厅: { type: 'lobby:score',  score: number }
 */
;(function () {
  if (window.parent === window) return // 不在大厅 iframe 里，静默退出
  var parentWin = window.parent

  function post(msg) {
    try {
      parentWin.postMessage(msg, '*')
    } catch (e) {
      /* 跨源异常时静默 */
    }
  }

  var player = { name: null, gameId: null }

  window.addEventListener('message', function (ev) {
    var d = ev.data || {}
    if (d.type === 'lobby:hello') {
      player.name = d.player_name || null
      player.gameId = d.game_id || null
      document.title = player.name ? player.name + ' · ' + document.title.replace(/^[^·]*· /, '') : document.title
      try {
        window.dispatchEvent(new CustomEvent('lobby:hello', { detail: player }))
      } catch (e) {
        /* 老浏览器降级：游戏可直接读 window.LobbyEmbed.player */
      }
    }
  })

  function announceReady() {
    post({ type: 'lobby:ready' })
  }
  if (document.readyState === 'complete') {
    announceReady()
  } else {
    window.addEventListener('load', announceReady)
  }

  window.LobbyEmbed = {
    /** 当前玩家（由大厅注入），未注入时为 { name: null, gameId: null } */
    player: player,
    /** 对局结束/得分变化时上报成绩 */
    reportScore: function (score) {
      post({ type: 'lobby:score', score: Number(score) || 0 })
    },
  }
})()
