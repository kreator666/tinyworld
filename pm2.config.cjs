// 本地开发常驻进程:agent(:4111) + web(:5173)
// 用法: npm run up / npm run down / npm run logs
// 与 start.bat/start.sh 的区别:进程由 PM2 守护,关窗口/会话结束不会掉线,
// 崩溃自动重启;start.* 适合临时手动跑。
// 注意:Windows 下 PM2 不能直接 spawn npm(.cmd 批处理会被当 JS 解析),
// 这里统一用 node 直跑 tsx / vite 的 CLI 入口。
module.exports = {
  apps: [
    {
      name: 'tinyworld-agent',
      cwd: './agent',
      script: './node_modules/tsx/dist/cli.mjs',
      interpreter: 'node',
      args: 'watch src/index.ts',
      watch: false, // tsx watch 自行处理代码热重载
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'tinyworld-web',
      cwd: './web',
      script: './node_modules/vite/bin/vite.js',
      interpreter: 'node',
      args: '--port 5173',
      watch: false,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
}
