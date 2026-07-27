import { useMemo, useState } from 'react'
import type { Equipped } from '../types'
import { dollParts } from './dollParts'

// Q 版 ARPG 纸娃娃:4 插槽分层 SVG 渲染(pet→body→accessory→head),统一脚底锚点
export default function PaperDoll({
  equipped,
  size = 'md',
  interactive = false,
}: {
  equipped: Equipped
  size?: 'sm' | 'md' | 'lg'
  interactive?: boolean // 是否显示缩放/翻转控制
}) {
  const [zoom, setZoom] = useState(1)
  const [flip, setFlip] = useState(false)

  const parts = useMemo(
    () => ({
      pet: equipped.pet ? dollParts.pet[equipped.pet] : undefined,
      body: equipped.body ? dollParts.body[equipped.body] : undefined,
      accessory: equipped.accessory ? dollParts.accessory[equipped.accessory] : undefined,
      head: equipped.head ? dollParts.head[equipped.head] : undefined,
    }),
    [equipped],
  )

  const box = size === 'lg' ? 'w-64 h-64' : size === 'sm' ? 'w-24 h-24' : 'w-44 h-44'

  return (
    <div className="flex flex-col items-center gap-2">
      <div className={`relative ${box} rounded-2xl bg-gradient-to-b from-indigo-950/60 via-slate-900/60 to-slate-950/80 grid place-items-center overflow-hidden border border-white/10`}>
        {/* 背景氛围光 */}
        <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-40 h-40 rounded-full bg-neon-purple/15 blur-2xl pointer-events-none" />
        <div
          className="animate-float transition-transform duration-300 w-full h-full"
          style={{ transform: `scale(${zoom}) scaleX(${flip ? -1 : 1})` }}
        >
          <svg viewBox="0 0 240 240" className="w-full h-full" role="img" aria-label="纸娃娃预览">
            {/* 地面阴影 */}
            <ellipse cx="120" cy="219" rx="66" ry="8" fill="#000" opacity="0.35" />
            {/* 分层渲染:宠物(最底层)→ 身体 → 配饰 → 头部 */}
            {parts.pet?.()}
            {parts.body?.()}
            {parts.accessory?.()}
            {parts.head?.()}
          </svg>
        </div>
        <span className="absolute top-2 right-2 tag !text-[10px] border-neon-cyan/40 text-neon-cyan">NFT</span>
      </div>

      {interactive && (
        <div className="flex items-center gap-2 text-xs">
          <button className="btn-ghost !px-2 !py-1" onClick={() => setFlip((f) => !f)} title="左右翻转">⇋</button>
          <button className="btn-ghost !px-2 !py-1" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(1)))}>−</button>
          <span className="text-slate-400 w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button className="btn-ghost !px-2 !py-1" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(1)))}>+</button>
        </div>
      )}
    </div>
  )
}
