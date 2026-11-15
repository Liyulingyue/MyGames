import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
