import { useMemo, useState } from 'react'
import type { Equipped, NFTCategory } from '../types'
import { dollParts } from './dollParts'
import { getPartByLocalId } from '../data/equipmentCatalog'

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

  // 没有自定义 SVG 的已装备槽位,显示 emoji 占位
  const unknownSlots = useMemo(
    () =>
      (['pet', 'body', 'accessory', 'head'] as const)
        .map((slot) => {
          const id = equipped[slot]
          if (!id || dollParts[slot][id]) return null
          const part = getPartByLocalId(id)
          return { slot, id, emoji: part?.emoji ?? '❓', name: part?.name ?? id }
        })
        .filter((x): x is { slot: NFTCategory; id: string; emoji: string; name: string } => !!x),
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
            {/* 未配置 SVG 的装备按槽位显示 emoji 占位 */}
            {unknownSlots.map(({ slot, emoji, name }) => {
              const pos =
                slot === 'head'
                  ? { x: 120, y: 78 }
                  : slot === 'body'
                    ? { x: 120, y: 150 }
                    : slot === 'accessory'
                      ? { x: 62, y: 132 }
                      : { x: 184, y: 184 }
              return (
                <g key={slot}>
                  <circle cx={pos.x} cy={pos.y} r="16" fill="#1e293b" opacity="0.85" />
                  <text x={pos.x} y={pos.y + 4} textAnchor="middle" fontSize="16" fill="#e2e8f0">
                    {emoji}
                  </text>
                  <text x={pos.x} y={pos.y + 28} textAnchor="middle" fontSize="7" fill="#94a3b8">
                    {name.slice(0, 4)}
                  </text>
                </g>
              )
            })}
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
