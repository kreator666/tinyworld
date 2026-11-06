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
import { sendTransactions } from '../lib/chainDispatch'
import PixelRoom from '../components/PixelRoom'
import type { AgentStatus } from '../types'
import { useI18n } from '../i18n'

/** 消息文本渲染:把 URL 变成可点击链接(链上确认消息里的浏览器明细等) */
function renderMessageContent(content: string) {
  const parts = content.split(/(https?:\/\/[^\s]+)/g)
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a key={i} href={p} target="_blank" rel="noreferrer" className="underline text-cyan-300 break-all">
        {p}
      </a>
    ) : (
      <span key={i}>{p}</span>
    ),
  )
}

// 我的 Agent 助手(豆包式):只属于自己的 Agent 对话,支持多个会话,历史存后端
export default function MyAgentPage() {
  const { t } = useI18n()
  const showToast = useAppStore((s) => s.showToast)
  const { tokenId, didName, equipped: chainEquipped } = useChainStore()
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
  const [confirming, setConfirming] = useState(false)
  // 小屋状态:基础状态由流程推导,收到回复后短暂 happy 再回落
  const [happyUntil, setHappyUntil] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // happy 3 秒倒计时(到点回落推导状态)
  useEffect(() => {
    if (happyUntil <= 0) return
    const timer = setInterval(() => {
      if (Date.now() >= happyUntil) setHappyUntil(0)
    }, 400)
    return () => clearInterval(timer)
  }, [happyUntil])

  // 小屋状态映射:confirming > signing > happy > waiting-sign > thinking > idle
  const roomStatus: AgentStatus =
    confirming ? 'confirming'
    : signing ? 'signing'
    : Date.now() < happyUntil ? 'happy'
    : pendingSignTx && !signing ? 'waiting-sign'
    : sending ? 'thinking'
    : 'idle'

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
      showToast(t('myAgent.toast.createFail'))
    }
  }

  const removeConversation = async (id: string) => {
    try {
      await deleteConversation(id)
      if (activeId === id) setActiveId(null)
      reloadConversations(false)
    } catch {
      showToast(t('myAgent.toast.deleteFail'))
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
      setHappyUntil(Date.now() + 3000) // 收到回复,小屋撒花庆祝一下
      if (r.refused) showToast(t('myAgent.toast.refused'))
      if (r.action?.type === 'sign_tx') {
        setPendingSignTx({ unsignedTxs: r.action.unsignedTxs, note: r.action.note, proposal: r.action.proposal })
      }
      reloadConversations()
    } catch (err) {
      showToast(err instanceof TypeError ? t('myAgent.toast.serviceDown') : t('myAgent.toast.sendFail'))
    } finally {
      setSending(false)
    }
  }

  /** 用户钱包签名模式:钱包直接发送 unsigned tx,然后等后端核实回执,Agent 主动告知结果 */
  const signAndBroadcast = async () => {
    if (!pendingSignTx || !address || tokenId === 0) return
    setSigning(true)
    try {
      const txHashes = await sendTransactions(address, pendingSignTx.unsignedTxs, {
        tokenId,
        protocol: pendingSignTx.proposal?.protocol as string | undefined,
      })
      const swapTxHash = txHashes[txHashes.length - 1]
      setSigning(false)
      setConfirming(true)
      showToast(t('myAgent.toast.broadcasted'))
      if (pendingSignTx.proposal) {
        try {
          // 后端会等回执、解析 Swap 实际输出,并在会话里追加一条确认消息
          const r = await confirmSign(tokenId, swapTxHash, pendingSignTx.proposal, activeId ?? undefined)
          showToast(r.confirmed ? t('myAgent.toast.swapConfirmed') : t('myAgent.toast.swapPending'))
          if (activeId) {
            const msgs = await listMessages(activeId)
            setMessages(msgs)
          }
        } catch (e) {
          console.warn('上报签名结果到 Agent 服务失败', e)
          showToast(t('myAgent.toast.verifyFail'))
        }
      } else {
        showToast(t('myAgent.toast.txBroadcasted', { hash: swapTxHash.slice(0, 12) }))
      }
      setPendingSignTx(null)
      setConfirming(false)
    } catch (err) {
      // MetaMask 等 provider 拒绝时抛的是 {code,message} 普通对象而非 Error,兜底文案会吞掉真实原因
      const msg = err instanceof Error ? err.message : (err as { message?: unknown } | null)?.message
      showToast(typeof msg === 'string' && msg ? t('myAgent.toast.signFail', { message: msg }) : t('myAgent.toast.signFailPlain'))
    } finally {
      setSigning(false)
      setConfirming(false)
    }
  }

  if (tokenId === 0) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <div className="text-5xl mb-4">🤖</div>
        <p className="text-slate-300 mb-6">{t('myAgent.mintFirst')}</p>
        <Link to="/mint" className="btn-primary inline-block">{t('myAgent.goMint')}</Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <h2 className="text-2xl font-bold mb-1">{t('myAgent.title')}</h2>
      <p className="text-sm text-slate-400 mb-5">{t('myAgent.subtitle', { name: didName || 'Agent' })}</p>

      <div className="grid lg:grid-cols-[260px_1fr] gap-4 h-[calc(100vh-13rem)]">
        {/* 左:会话列表 */}
        <div className="glass p-3 flex flex-col overflow-hidden">
          <button className="btn-primary w-full !text-sm !py-2 mb-3" onClick={newConversation}>{t('myAgent.newChat')}</button>
          <div className="flex-1 overflow-y-auto space-y-1.5">
            {offline && <p className="text-xs text-slate-500 px-2 py-6 text-center">{t('myAgent.offline1')}<br />{t('myAgent.offline2')}</p>}
            {!offline && loadingList && <p className="text-xs text-slate-500 px-2 py-6 text-center animate-pulse">{t('myAgent.loading')}</p>}
            {!offline && !loadingList && conversations.length === 0 && (
              <p className="text-xs text-slate-500 px-2 py-6 text-center">{t('myAgent.empty')}</p>
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
                  title={t('myAgent.deleteTitle')}
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

        {/* 右:像素小屋(Agent 状态呈现区)+ 聊天区 */}
        <div className="flex flex-col gap-2 min-h-0">
          {address && tokenId > 0 && (
            <PixelRoom
              className="shrink-0"
              heightClass="h-28 md:h-32"
              dollHeight={80}
              status={roomStatus}
              ownerAddress={address}
              inhabitants={[{ id: address, equipped: chainEquipped }]}
            />
          )}
          <div className="glass flex flex-col flex-1 overflow-hidden">
          <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {!activeId && (
              <div className="h-full grid place-items-center text-slate-500 text-sm">
                {t('myAgent.noActive')}
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === 'user' ? 'bg-neon-grad text-white rounded-br-sm' : 'glass rounded-bl-sm'
                  }`}
                >
                  {renderMessageContent(m.content)}
                </div>
              </div>
            ))}
            {sending && <div className="text-xs text-slate-500 animate-pulse">{t('myAgent.thinking')}</div>}
            {pendingSignTx && !signing && (
              <div className="flex justify-start">
                <div className="max-w-[85%] glass rounded-xl p-3 border border-neon-purple/40">
                  <div className="text-sm flex items-center gap-2">
                    <span>🔏</span>
                    <span>{t('myAgent.needSign')}</span>
                  </div>
                  {pendingSignTx.note && <p className="text-xs text-slate-400 mt-1.5">{pendingSignTx.note}</p>}
                  <div className="text-[10px] text-slate-500 mt-1.5">
                    {t('myAgent.txCount', { count: pendingSignTx.unsignedTxs.length })}
                  </div>
                  <button
                    className="btn-primary w-full mt-3 !text-xs !py-1.5"
                    onClick={signAndBroadcast}
                    disabled={!address || signing}
                  >
                    {t('myAgent.signSend')}
                  </button>
                  {!address && <p className="text-[10px] text-rose-400 mt-1.5">{t('myAgent.connectFirst')}</p>}
                </div>
              </div>
            )}
            {signing && <div className="text-xs text-slate-500 animate-pulse">{t('myAgent.waitingSign')}</div>}
            {confirming && <div className="text-xs text-slate-500 animate-pulse">{t('myAgent.confirming')}</div>}
          </div>
          <div className="border-t border-white/10 p-3 flex items-center gap-2">
            <input
              className="input flex-1"
              placeholder={activeId ? t('myAgent.inputContinue') : t('myAgent.inputNew')}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              disabled={sending}
            />
            <button className="btn-primary !py-2" onClick={send} disabled={sending}>
              {sending ? t('myAgent.sending') : t('myAgent.send')}
            </button>
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}
