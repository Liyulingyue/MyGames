import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react(), coepPerRoute()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5178,
    proxy: {
      '/api': {
        target: 'http://localhost:7080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:7080',
        ws: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision']
  }
})

/**
 * COEP 按路由分流：体感游戏需要跨源隔离（MediaPipe SharedArrayBuffer），
 * 但 COEP require-corp 会拦截不带 CORP 头的跨源 iframe（外接游戏）。
 * 因此外接游戏页（/games/ext/*）不带 COEP —— 这些页面自身不用 MediaPipe。
 * 注意：需配合外接游戏走整页跳转（SPA 内导航不会重新取文档）。
 * 生产 nginx 需同样按 location 分流（见 Lobby/README）。
 */
function coepPerRoute(): Plugin {
  return {
    name: 'coep-per-route',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0]
        if (!url.startsWith('/games/ext')) {
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        }
        next()
      })
    },
  }
}
