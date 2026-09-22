import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import ChatBubble from '../components/ChatBubble'
import { chatWithAgent, getInbox } from '../lib/agentApi'
import { fetchMintedAgents, type MintedAgent } from '../lib/chain'
import { useChainConfig } from '../store/chainConfigStore'

// 页面 5:消息聊天界面 —— 纯社交,只列别人的链上 Agent;自己的 Agent 在 /assistant 助手页
export default function ChatPage() {
  const activeChain = useChainConfig((s) => s.active)
  const { connected, login, chats, activeChatId, setActiveChat, switchChatMode, sendMessage, appendPeerMessage, upsertChainSession, inventory, aiProfile, showToast } = useAppStore()
  const myTokenId = useChainStore((s) => s.tokenId)
  const [draft, setDraft] = useState('')
  const [showNFT, setShowNFT] = useState(false)
  const [showAIInfo, setShowAIInfo] = useState(false)
  const [typingChatId, setTypingChatId] = useState<string | null>(null) // 等待真实 Agent 回复的会话
  const [loadingAgents, setLoadingAgents] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const nav = useNavigate()
  // 收件箱轮询用的缓存与去重状态
  const agentsRef = useRef<Map<number, MintedAgent>>(new Map())
  const seenMsgRef = useRef<Set<string>>(new Set())
  const inboxSinceRef = useRef<string | null>(null)
  const recentRepliesRef = useRef<Map<string, string>>(new Map()) // sessionId → send() 已即时展示的回复文本

  const isSepolia = login?.chainId === activeChain.chainId
  const active = chats.find((c) => c.id === activeChatId) ?? chats[0]

  // 会话列表从链上读取:只列别人的 Agent(自己的 Agent 有专属助手页,不进社交列表)
  useEffect(() => {
    if (!connected || !isSepolia) return
    setLoadingAgents(true)
    fetchMintedAgents()
      .then((list) => {
        list.forEach((a) => agentsRef.current.set(a.tokenId, a))
        list.filter((a) => a.tokenId !== myTokenId).forEach((a) => upsertChainSession(a, false))
      })
      .catch((e) => console.warn('读取链上 Agent 列表失败:', e))
      .finally(() => setLoadingAgents(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, isSepolia, myTokenId])

  // 收件箱轮询:其他 Agent 主动发来/回复的消息,按发送方落进对应会话
  useEffect(() => {
    if (!connected || !isSepolia || myTokenId === 0) return
    const tick = async () => {
      try {
        const msgs = await getInbox(myTokenId, inboxSinceRef.current ?? undefined)
        for (const m of msgs) {
          if (seenMsgRef.current.has(m.id)) continue
          const peer = agentsRef.current.get(m.fromTokenId)
          if (!peer) continue // 链上 Agent 列表还没加载完,下轮再处理
          seenMsgRef.current.add(m.id)
          inboxSinceRef.current = m.createdAt
          const sid = upsertChainSession(peer, false)
          // 跳过 send() 已即时展示过的回复(后端同时落了 social_messages,避免重复)
          if (recentRepliesRef.current.get(sid) === m.content) {
            recentRepliesRef.current.delete(sid)
            continue
          }
          appendPeerMessage(sid, m.content)
        }
      } catch {
        // agent 服务未启动时静默,下轮重试
      }
    }
    tick()
    const timer = setInterval(tick, 15000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, isSepolia, myTokenId])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [active?.messages.length])

  const send = () => {
    if (!draft.trim() || !active) return
    const text = draft.trim()
    const sessionId = active.id
    // 对方 Agent 会话:回复由对方的链上人格决定(agent/ 服务装载对方人格)
    const toChainAgent = active.mode === 'ai' && active.agentTokenId != null
    sendMessage(sessionId, text)
    setDraft('')
    if (!toChainAgent) return

    setTypingChatId(sessionId)
    chatWithAgent(active.agentTokenId!, text, myTokenId > 0 ? myTokenId : undefined)
      .then((r) => {
        recentRepliesRef.current.set(sessionId, r.reply)
        appendPeerMessage(sessionId, r.reply)
      })
      .catch((err) => {
        // 网络层失败(服务没起)与业务错误(未铸造/LLM 异常)分开提示
        const msg = err instanceof TypeError
          ? 'Agent 服务未启动,请先运行 agent/ 服务(npm run dev,端口 4111)'
          : `Agent 回复失败:${err instanceof Error ? err.message : String(err)}`
        appendPeerMessage(sessionId, msg)
      })
      .finally(() => setTypingChatId((id) => (id === sessionId ? null : id)))
  }

  // 导出对话记录为 txt
  const exportChat = () => {
    if (!active) return
    const lines = active.messages.map(
      (m) => `[${m.time}] ${m.from === 'me' ? '我' : active.peerName + (m.ai ? '(Agent)' : '')}: ${m.kind === 'nft' ? '[NFT分享]' : m.text}`,
    )
    const blob = new Blob([`AgentVerse 对话记录 - ${active.peerName}\n\n` + lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `chat-${active.peerName}.txt`
    a.click()
    URL.revokeObjectURL(a.href)
    showToast('对话记录已导出')
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="grid lg:grid-cols-[300px_1fr] gap-4 h-[calc(100vh-8.5rem)]">
        {/* 左:会话列表 */}
        <div className="glass p-3 overflow-y-auto">
          <h3 className="text-sm font-semibold text-slate-300 px-2 py-2">会话列表</h3>
          {!connected || !isSepolia ? (
            <p className="text-xs text-slate-500 px-2 py-6 text-center">
              连接钱包并切换到 {activeChain.name} 后,会话列表将从链上读取
            </p>
          ) : loadingAgents && chats.length === 0 ? (
            <p className="text-xs text-slate-500 px-2 py-6 text-center animate-pulse">正在从链上读取 Agent…</p>
          ) : chats.length === 0 ? (
            <p className="text-xs text-slate-500 px-2 py-6 text-center">链上还没有铸造的 Agent</p>
          ) : null}
          <div className="space-y-1.5">
            {chats.map((c) => {
              const last = c.messages[c.messages.length - 1]
              return (
                <button
                  key={c.id}
                  onClick={() => setActiveChat(c.id)}
                  className={`w-full text-left p-3 rounded-xl transition flex items-center gap-3 ${
                    active?.id === c.id ? 'bg-neon-grad/20 border border-neon-purple/50' : 'hover:bg-white/5 border border-transparent'
                  }`}
                >
                  <span className="text-2xl">{c.peerEmoji}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate">{c.peerName}</span>
                      {/* 会话类型标识 */}
                      {c.mode === 'ai' ? (
                        <span className="tag !text-[9px] !px-1.5 border-neon-cyan/40 text-neon-cyan">🤖 AI</span>
                      ) : (
                        <span className="tag !text-[9px] !px-1.5 border-emerald-400/40 text-emerald-300">真人</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 truncate mt-0.5">
                      {last?.kind === 'nft' ? '[NFT 分享]' : last?.text}
                    </div>
                  </div>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${c.online ? 'bg-emerald-400' : 'bg-slate-600'}`} title={c.online ? '真人在线' : '真人离线,AI 代管'} />
                </button>
              )
            })}
          </div>
        </div>

        {/* 右:聊天窗口 */}
        {active ? (
          <div className="glass flex flex-col overflow-hidden">
            {/* 顶部栏 */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
              <span className="text-2xl">{active.peerEmoji}</span>
              <div className="min-w-0">
                <div className="font-medium text-sm">{active.peerName}</div>
                <div className="text-[11px] text-slate-500 font-mono">{active.peerAddress}</div>
              </div>
              {/* 真人 / AI 切换 */}
              <div className="ml-auto flex items-center glass !rounded-full p-1 text-xs">
                <button
                  onClick={() => switchChatMode(active.id, 'human')}
                  className={`px-3 py-1 rounded-full transition ${active.mode === 'human' ? 'bg-neon-grad text-white' : 'text-slate-400'}`}
                >
                  真人
                </button>
                <button
                  onClick={() => switchChatMode(active.id, 'ai')}
                  className={`px-3 py-1 rounded-full transition ${active.mode === 'ai' ? 'bg-neon-grad text-white' : 'text-slate-400'}`}
                >
                  🤖 Agent
                </button>
              </div>
              {active.agentTokenId != null && (
                <button className="btn-ghost !px-3 !py-1.5 !text-xs" onClick={() => nav(`/profile/${active.agentTokenId}`)}>主页</button>
              )}
              <button className="btn-ghost !px-3 !py-1.5 !text-xs" onClick={() => setShowAIInfo(true)}>AI 设定</button>
              <button className="btn-ghost !px-3 !py-1.5 !text-xs" onClick={exportChat}>导出</button>
            </div>

            {/* 消息流 */}
            <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-4">
              {active.mode === 'ai' && (
                <div className="text-center">
                  <span className="tag !text-[10px] border-neon-cyan/40 text-neon-cyan">
                    🤖 当前由对方的 Agent({active.aiTag})代为交流
                  </span>
                </div>
              )}
              {active.messages.map((m) => <ChatBubble key={m.id} msg={m} />)}
              {typingChatId === active.id && (
                <div className="text-xs text-slate-500 animate-pulse">🤖 对方正在输入…</div>
              )}
            </div>

            {/* 底部输入区 */}
            <div className="border-t border-white/10 p-3">
              {showNFT && (
                <div className="mb-2 glass p-2 max-h-32 overflow-y-auto grid grid-cols-4 gap-2">
                  {inventory.map((i) => (
                    <button
                      key={i.id}
                      className="glass p-2 text-center hover:border-neon-purple/60 transition"
                      onClick={() => { sendMessage(active.id, '', 'nft', i.id); setShowNFT(false) }}
                      title={`发送 ${i.name}`}
                    >
                      <div className="text-xl">{i.emoji}</div>
                      <div className="text-[9px] text-slate-400 truncate">{i.name}</div>
                    </button>
                  ))}
                  {inventory.length === 0 && <div className="col-span-4 text-xs text-slate-500 text-center py-2">背包为空</div>}
                </div>
              )}
              <div className="flex items-center gap-2">
                <button className="btn-ghost !px-3 !py-2 text-sm" onClick={() => setShowNFT((v) => !v)} title="发送我的装备 NFT">
                  🎒 NFT
                </button>
                <input
                  className="input flex-1"
                  placeholder="发送消息…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && send()}
                />
                <button className="btn-primary !py-2" onClick={send}>发送</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="glass grid place-items-center text-slate-500">选择左侧会话开始聊天</div>
        )}
      </div>

      {/* 查看本次对话 AI 性格设定 */}
      {showAIInfo && active && (
        <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm grid place-items-center p-4" onClick={() => setShowAIInfo(false)}>
          <div className="glass neon-border max-w-sm w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-3">
              <h3 className="font-semibold">🤖 本次对话 AI 性格设定</h3>
              <button onClick={() => setShowAIInfo(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-400">Agent 标签</span><span>{active.aiTag}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">人设模板</span><span>{aiProfile.template}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">语气风格</span><span>{aiProfile.tone}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">回复速度</span><span>{aiProfile.replySpeed === 'instant' ? '秒级快速回复' : '模拟人类延迟'}</span></div>
              <div className="pt-2 border-t border-white/10">
                <span className="text-slate-400 text-xs">性格描述</span>
                <p className="text-xs mt-1 text-slate-300">{aiProfile.personality || '未设置'}</p>
              </div>
              <p className="text-[10px] text-slate-500 pt-1">* 演示版:对方 Agent 设定以你的 AI 配置近似展示</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
