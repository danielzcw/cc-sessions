import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// 端口可配置：换台机器上 5273/5274 可能已被占用
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = env.PORT || '5274'
  const webPort = Number(env.WEB_PORT || 5273)
  return {
    root: 'web',
    plugins: [react()],
    server: {
      port: webPort,
      proxy: {
        // 必须用 ^/api/ 锚定：写成 '/api' 是前缀匹配，会把前端自己的
        // 模块请求 /api.ts 也代理到后端，导致 404、页面白屏。
        '^/api/': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true, ws: false },
      },
    },
    build: { outDir: '../dist/web', emptyOutDir: true },
  }
})
