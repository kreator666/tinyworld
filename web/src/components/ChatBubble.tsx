import type { Message } from '../types'
import { nftLibrary } from '../mock/data'
import { rarityDot } from './NFTCard'

// 聊天消息气泡:AI 分身消息带机器人标识,真人无
export default function ChatBubble({ msg }: { msg: Message }) {
  const mine = msg.from === 'me'
  const nft = msg.kind === 'nft' ? nftLibrary.find((i) => i.id === msg.nftId) : null

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] ${mine ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        {msg.ai && !mine && (
          <span className="text-[10px] text-neon-cyan flex items-center gap-1">🤖 对方 AI 分身</span>
        )}
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            mine
              ? 'bg-neon-grad text-white rounded-br-sm'
              : 'glass rounded-bl-sm ' + (msg.ai ? 'border-neon-cyan/40' : '')
          }`}
        >
          {nft ? (
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-lg bg-gradient-to-br ${nft.gradient} grid place-items-center text-2xl shrink-0`}>
                {nft.emoji}
              </div>
              <div>
                <div className="font-medium text-xs">{nft.name}</div>
                <div className="text-[10px] opacity-75 mt-0.5">
                  {rarityDot[nft.rarity]} {nft.rarity} · {nft.chain} · NFT 分享
                </div>
              </div>
            </div>
          ) : (
            msg.text
          )}
        </div>
        <span className="text-[10px] text-slate-500">{msg.time}</span>
      </div>
    </div>
  )
}
