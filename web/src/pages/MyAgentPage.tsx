import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import {
  chatInConversation,
  confirmSign,
  createConversation,
  deleteConversation,
  listConversations,
  listMessages,
  type Conversation,
  type ConversationMessage,
  type UnsignedTx,
} from '../lib/agentApi'
import { sendTransactions } from '../lib/chain'

// 我的 Agent 助手(豆包式):只属于自己的 Agent 对话,支持多个会话,历史存后端
export default function MyAgentPage() {
  const showToast = useAppStore((s) => s.showToast)
  const { tokenId, didName } = useChainStore()
  const address = useAppStore((s) => s.address)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [offline, setOffline] = useState(false)
  const [loadingList, setLoadingList] = useState(true)
  const [pendingSignTx, setPendingSignTx] = useState<{ unsignedTxs: UnsignedTx[]; note?: string; proposal?: Record<string, unknown> } | null>(null)
  const [signing, setSigning] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const reloadConversations = useCallback(
    (keepActive = true) => {
      if (tokenId === 0) return
      setLoadingList(true)
      listConversations(tokenId)
        .then((list) => {
          setConversations(list)
          setOffline(false)
          if (list.length > 0 && (!keepActive || !activeId || !list.some((c) => c.id === activeId))) {
            setActiveId(list[0].id)
          }
          if (list.length === 0) setActiveId(null)
        })
        .catch(() => setOffline(true))
        .finally(() => setLoadingList(false))
    },
    [tokenId, activeId],
  )

  useEffect(() => {
    reloadConversations()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenId])

  // 切换会话时加载历史
  useEffect(() => {
    if (!activeId) {
      setMessages([])
      return
    }
    listMessages(activeId)
      .then(setMessages)
      .catch(() => setMessages([]))
  }, [activeId])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, sending])

  const newConversation = async () => {
    if (tokenId === 0) return
    try {
      const c = await createConversation(tokenId)
      setActiveId(c.id)
      reloadConversations()
    } catch {
      showToast('创建会话失败,请确认 agent 服务已启动')
    }
  }

  const removeConversation = async (id: string) => {
    try {
      await deleteConversation(id)
      if (activeId === id) setActiveId(null)
      reloadConversations(false)
    } catch {
      showToast('删除失败')
    }
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || sending || tokenId === 0) return
    setSending(true)
    setPendingSignTx(null) // 新消息发送时清空上一条待签名
    try {
      // 没有会话就先建一个
      let cid = activeId
      if (!cid) {
        cid = (await createConversation(tokenId)).id
        setActiveId(cid)
      }
      const optimistic: ConversationMessage = {
        id: `tmp-${Date.now()}`,
        conversation_id: cid,
        role: 'user',
        content: text,
        created_at: new Date().toISOString(),
      }
      setMessages((m) => [...m, optimistic])
      setDraft('')
      const r = await chatInConversation(cid, text)
      // 从后端重拉,保证与落库一致(含自动生成的标题)
      const msgs = await listMessages(cid)
      setMessages(msgs)
      if (r.refused) showToast('人格开关拦截了这次回复')
      if (r.action?.type === 'sign_tx') {
        setPendingSignTx({ unsignedTxs: r.action.unsignedTxs, note: r.action.note, proposal: r.action.proposal })
      }
      reloadConversations()
    } catch (err) {
      showToast(err instanceof TypeError ? 'Agent 服务未启动(cd agent && npm run dev)' : '发送失败,请重试')
    } finally {
      setSending(false)
    }
  }

  /** 用户钱包签名模式:钱包直接发送 unsigned tx(sendTransactions 内部会切链),成功回写后端 */
  const signAndBroadcast = async () => {
    if (!pendingSignTx || !address || tokenId === 0) return
    setSigning(true)
    try {
      const txHashes = await sendTransactions(address as `0x${string}`, pendingSignTx.unsignedTxs)
      const swapTxHash = txHashes[txHashes.length - 1]
      showToast(`已上链 ${swapTxHash.slice(0, 10)}…${swapTxHash.slice(-4)}`)
      if (pendingSignTx.proposal) {
        try {
          await confirmSign(tokenId, swapTxHash, pendingSignTx.proposal)
        } catch (e) {
          console.warn('上报签名结果到 Agent 服务失败', e)
        }
      }
      setPendingSignTx(null)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '签名或发送失败')
    } finally {
      setSigning(false)
    }
  }

  if (tokenId === 0) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <div className="text-5xl mb-4">🤖</div>
        <p className="text-slate-300 mb-6">先铸造你的 Agent,才能拥有专属助手</p>
        <Link to="/mint" className="btn-primary inline-block">前往铸造工坊</Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <h2 className="text-2xl font-bold mb-1">我的 Agent 助手</h2>
      <p className="text-sm text-slate-400 mb-5">只属于你的 {didName || 'Agent'},对话只有你能看到,它记得你们聊过的一切</p>

      <div className="grid lg:grid-cols-[260px_1fr] gap-4 h-[calc(100vh-13rem)]">
        {/* 左:会话列表 */}
        <div className="glass p-3 flex flex-col overflow-hidden">
          <button className="btn-primary w-full !text-sm !py-2 mb-3" onClick={newConversation}>➕ 新对话</button>
          <div className="flex-1 overflow-y-auto space-y-1.5">
            {offline && <p className="text-xs text-slate-500 px-2 py-6 text-center">Agent 服务未启动<br />(cd agent && npm run dev)</p>}
            {!offline && loadingList && <p className="text-xs text-slate-500 px-2 py-6 text-center animate-pulse">读取中…</p>}
            {!offline && !loadingList && conversations.length === 0 && (
              <p className="text-xs text-slate-500 px-2 py-6 text-center">还没有对话,点击上方"新对话"开始</p>
            )}
            {conversations.map((c) => (
              <div
                key={c.id}
                className={`group w-full flex items-center gap-2 p-2.5 rounded-xl transition cursor-pointer ${
                  activeId === c.id ? 'bg-neon-grad/20 border border-neon-purple/50' : 'hover:bg-white/5 border border-transparent'
                }`}
                onClick={() => setActiveId(c.id)}
              >
                <span className="text-sm truncate flex-1 text-left">{c.title}</span>
                <button
                  className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-300 text-xs shrink-0 transition"
                  title="删除对话"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeConversation(c.id)
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* 右:聊天区 */}
        <div className="glass flex flex-col overflow-hidden">
          <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {!activeId && (
              <div className="h-full grid place-items-center text-slate-500 text-sm">
                开始一个新对话,或从左侧选择历史对话
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === 'user' ? 'bg-neon-grad text-white rounded-br-sm' : 'glass rounded-bl-sm'
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {sending && <div className="text-xs text-slate-500 animate-pulse">🤖 正在思考…</div>}
            {pendingSignTx && !signing && (
              <div className="flex justify-start">
                <div className="max-w-[85%] glass rounded-xl p-3 border border-neon-purple/40">
                  <div className="text-sm flex items-center gap-2">
                    <span>🔏</span>
                    <span>需要你的钱包签名以完成兑换</span>
                  </div>
                  {pendingSignTx.note && <p className="text-xs text-slate-400 mt-1.5">{pendingSignTx.note}</p>}
                  <div className="text-[10px] text-slate-500 mt-1.5">
                    共 {pendingSignTx.unsignedTxs.length} 笔待签交易
                  </div>
                  <button
                    className="btn-primary w-full mt-3 !text-xs !py-1.5"
                    onClick={signAndBroadcast}
                    disabled={!address || signing}
                  >
                    签名并发送
                  </button>
                  {!address && <p className="text-[10px] text-rose-400 mt-1.5">请先连接钱包</p>}
                </div>
              </div>
            )}
            {signing && <div className="text-xs text-slate-500 animate-pulse">⏳ 等待钱包签名…</div>}
          </div>
          <div className="border-t border-white/10 p-3 flex items-center gap-2">
            <input
              className="input flex-1"
              placeholder={activeId ? '继续说…' : '输入消息,开始新对话…'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              disabled={sending}
            />
            <button className="btn-primary !py-2" onClick={send} disabled={sending}>
              {sending ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
