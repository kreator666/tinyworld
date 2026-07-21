import type { NFTItem, Rarity } from '../types'

export const rarityStyle: Record<Rarity, string> = {
  普通: 'border-slate-400/40 text-slate-300',
  稀有: 'border-cyan-400/50 text-cyan-300',
  史诗: 'border-purple-400/60 text-purple-300',
  传说: 'border-amber-400/60 text-amber-300',
}

export const rarityDot: Record<Rarity, string> = {
  普通: '⚪', 稀有: '🔵', 史诗: '🟣', 传说: '🟡',
}

// NFT 素材卡:稀有度 / 单价 / 是否持有 / 右上角链标
export default function NFTCard({
  item,
  selected,
  onClick,
  actions,
}: {
  item: NFTItem
  selected?: boolean
  onClick?: () => void
  actions?: React.ReactNode
}) {
  return (
    <div
      onClick={onClick}
      className={`glass p-3 relative transition ${onClick ? 'cursor-pointer hover:border-neon-purple/60' : ''} ${
        selected ? 'neon-border shadow-neon-purple' : ''
      }`}
    >
      {/* 链标 */}
      <span className="absolute top-2 right-2 tag !text-[10px] border-neon-cyan/40 text-neon-cyan">{item.chain}</span>
      <div className={`w-full h-24 rounded-xl bg-gradient-to-br ${item.gradient} grid place-items-center text-4xl mb-2`}>
        {item.emoji}
      </div>
      <div className="text-sm font-medium truncate" title={item.name}>{item.name}</div>
      <div className="flex items-center justify-between mt-1.5 text-xs">
        <span className={`tag ${rarityStyle[item.rarity]}`}>{rarityDot[item.rarity]} {item.rarity}</span>
        <span className="text-slate-400 font-mono">{item.price} ETH</span>
      </div>
      <div className="flex items-center justify-between mt-2">
        <span className={`text-[11px] ${item.owned ? 'text-emerald-400' : 'text-slate-500'}`}>
          {item.owned ? '✓ 已持有' : '未持有'}
        </span>
        {actions}
      </div>
    </div>
  )
}
