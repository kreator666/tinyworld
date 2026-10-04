// 浏览器环境 polyfill:@solana/spl-token 等依赖在模块求值期引用全局 Buffer,
// 必须先于一切 @solana/* 导入执行(Vite dev 下不做 commonjs 全局注入)。
import { Buffer } from 'buffer'

if (!(globalThis as { Buffer?: unknown }).Buffer) {
  ;(globalThis as { Buffer?: unknown }).Buffer = Buffer
}
