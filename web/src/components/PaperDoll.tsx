import { useMemo, useState } from 'react'
import type { Equipped } from '../types'
import { nftLibrary } from '../mock/data'

// 占位纸娃娃:按穿戴的 NFT 配件叠加展示(无美术资源,用渐变+emoji 拼装)
export default function PaperDoll({
  equipped,
  size = 'md',
  interactive = false,
}: {
  equipped: Equipped
  size?: 'sm' | 'md' | 'lg'
  interactive?: boolean // 是否显示旋转/缩放控制
}) {
  const [zoom, setZoom] = useState(1)
  const [rot, setRot] = useState(0)

  const items = useMemo(
    () => Object.values(equipped).map((id) => nftLibrary.find((i) => i.id === id)).filter(Boolean),
    [equipped],
  )
  const skin = items.find((i) => i!.category === 'skin')
  const head = items.find((i) => i!.category === 'head')
  const outfit = items.find((i) => i!.category === 'outfit')
  const acc = items.find((i) => i!.category === 'accessory')

  const box = size === 'lg' ? 'w-64 h-80' : size === 'sm' ? 'w-24 h-32' : 'w-44 h-56'
  const emojiSize = size === 'lg' ? 'text-7xl' : size === 'sm' ? 'text-3xl' : 'text-5xl'

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={`relative ${box} rounded-2xl bg-gradient-to-b ${acc?.gradient ?? 'from-slate-800 to-slate-900'} bg-opacity-40 grid place-items-center overflow-hidden border border-white/10`}
      >
        {acc && <span className="absolute inset-0 opacity-20 grid place-items-center text-8xl">{acc.emoji}</span>}
        <div
          className="animate-float transition-transform duration-300 flex flex-col items-center"
          style={{ transform: `scale(${zoom}) rotate(${rot}deg)` }}
        >
          {/* 头部 */}
          <div className={`rounded-full bg-gradient-to-br ${skin?.gradient ?? 'from-slate-500 to-slate-600'} p-1 shadow-neon-purple`}>
            <span className={`${emojiSize} block`}>{head?.emoji ?? '👤'}</span>
          </div>
          {/* 身体/服饰 */}
          <div className={`-mt-1 rounded-xl bg-gradient-to-br ${outfit?.gradient ?? 'from-slate-600 to-slate-700'} px-4 py-2 border border-white/20`}>
            <span className={size === 'sm' ? 'text-lg' : 'text-2xl'}>{outfit?.emoji ?? '🎽'}</span>
          </div>
          {acc && <span className="absolute -right-2 top-1/2 text-2xl drop-shadow">{acc.emoji}</span>}
        </div>
        <span className="absolute top-2 right-2 tag !text-[10px] border-neon-cyan/40 text-neon-cyan">NFT</span>
      </div>

      {interactive && (
        <div className="flex items-center gap-2 text-xs">
          <button className="btn-ghost !px-2 !py-1" onClick={() => setRot((r) => r - 15)}>↺</button>
          <button className="btn-ghost !px-2 !py-1" onClick={() => setRot((r) => r + 15)}>↻</button>
          <button className="btn-ghost !px-2 !py-1" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(1)))}>−</button>
          <span className="text-slate-400 w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button className="btn-ghost !px-2 !py-1" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(1)))}>+</button>
        </div>
      )}
    </div>
  )
}
