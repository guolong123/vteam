import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 使用轮询模式监听文件变更，避免 inotify watch 上限（ENOSPC）问题
    watch: {
      usePolling: true,
      interval: 500,
      ignored: ["**/node_modules/**", "**/.git/**"],
    },
  },
})
