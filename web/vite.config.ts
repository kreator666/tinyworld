import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // meteor-wallet 的 Node 风格依赖引用全局对象:
  //   randombytes/browser.js 用 global(→ globalThis);near-js 用 process.env.DEFAULT_FINALITY
  //   (成员表达式替换为字面量,避免与包内自身的 process 声明冲突);
  //   process.nextTick 仅在回调路径用到,运行期若触发会报错,目前链路不会走到
  define: {
    global: 'globalThis',
    'process.env': '{}',
    'process.env.DEFAULT_FINALITY': '"near-final"',
  },
  server: { port: 5173, open: true },
})
