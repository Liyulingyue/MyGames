import fs from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function fixMediaPipeSourceMap(): Plugin {
  return {
    name: 'fix-mediapipe-sourcemap',
    apply: 'serve',
    load(id) {
      const cleanId = id.split('?', 1)[0].replaceAll('\\', '/')
      if (!cleanId.endsWith('/@mediapipe/tasks-vision/vision_bundle.mjs')) return null
      const code = fs
        .readFileSync(cleanId, 'utf-8')
        .replace(/\/\/# sourceMappingURL=.*$/m, '')
      return { code, map: null }
    },
  }
}

export default defineConfig({
  plugins: [react(), fixMediaPipeSourceMap()],
  server: {
    port: 5180,
    host: true,
  },
  optimizeDeps: {
    // MediaPipe 的 wasm 加载器需要保持原样，不能被预打包改写
    exclude: ['@mediapipe/tasks-vision'],
  },
  build: {
    target: 'es2022',
  },
})
