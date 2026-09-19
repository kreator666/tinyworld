import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { keccak256, toBytes } from 'viem'
import { useAppStore } from '../store/appStore'
import { useChainStore } from '../store/chainStore'
import type { AIProfile, DIDIdentity } from '../types'
import { nftLibrary } from '../mock/data'
import PaperDoll from '../components/PaperDoll'
import { personaTemplates, toneOptions, topicOptions } from '../mock/data'
import { rarityDot } from '../components/NFTCard'
import { IDENTITY_ADDRESS, TARGET_CHAIN_ID } from '../lib/contracts'
import { explainChainError, fetchAgentPublic, fetchPersona, setPersonaOnChain } from '../lib/chain'
import { getCharacterDisplay } from '../data/equipmentCatalog'

function Toggle({ on, onChange, label, desc }: { on: boolean; onChange: (v: boolean) => void; label: string; desc: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div>
        <div className="text-sm">{label}</div>
        <div className="text-xs text-slate-500">{desc}</div>
      </div>
      <button
        onClick={() => onChange(!on)}
        className={`w-11 h-6 rounded-full relative transition shrink-0 ${on ? 'bg-neon-grad shadow-neon-purple' : 'bg-white/10'}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </div>
  )
}

// 页面 3:个人主页(Agent 展示 + 控制台)
// /profile = 自己的主页(含 Agent 控制台);/profile/:tokenId = 他人主页(仅公开信息 + 社交按钮)
export default function ProfilePage() {
  const nav = useNavigate()
  const { tokenId: paramTokenId } = useParams()
  const { connected, address, login, did, inventory, aiProfile, saveAIProfile, resetAIProfile, following, favorites, toggleFollow, toggleFavorite, ensureChatWith, showToast } = useAppStore()
  const { tokenId, didName, equipped: chainEquipped, loading: chainLoading, refresh } = useChainStore()
  const [form, setForm] = useState<AIProfile>(aiProfile)
  const [zoomMeta, setZoomMeta] = useState(false)
  const [saving, setSaving] = useState(false)

  // 访客模式:URL 带 tokenId 且不是自己的 Agent
  const visitingTokenId = paramTokenId ? Number(paramTokenId) : null
  const isSelf = visitingTokenId == null || visitingTokenId === tokenId
  const [other, setOther] = useState<DIDIdentity | null>(null)
  const [otherLoading, setOtherLoading] = useState(false)
  const [otherError, setOtherError] = useState<string | null>(null)

  const isSepolia = login?.chainId === TARGET_CHAIN_ID

  // 访问他人主页:从链上读取该 Agent 的公开信息
  useEffect(() => {
    if (visitingTokenId == null || isSelf) return
    setOtherLoading(true)
    setOtherError(null)
    fetchAgentPublic(visitingTokenId)
      .then((a) =>
        setOther({
          name: a.name,
          bio: a.bio,
          chain: 'Sepolia',
          mintedAt: '—',
          contract: IDENTITY_ADDRESS,
          address: a.owner,
          equipped: a.equipped,
        }),
      )
      .catch(() => setOtherError('该 Agent 不存在或已被销毁'))
      .finally(() => setOtherLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitingTokenId, isSelf])

  // 本地镜像没有 DID 时,回退到链上数据(Sepolia)——仅自己的主页需要
  useEffect(() => {
    if (isSelf && !did && connected && isSepolia && address) refresh(address as `0x${string}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSelf, did, connected, isSepolia, address])

  // 读取链上人格配置(personaOf)回填 AI 控制台;contentHash 校验不一致则忽略
  // 仅自己的主页装载(控制台只有本人可见)
  useEffect(() => {
    if (!isSelf || !connected || !isSepolia || tokenId === 0) return
    let cancelled = false
    const DATA_PREFIX = 'data:application/json;base64,'
    fetchPersona(tokenId)
      .then(({ uri, contentHash }) => {
        if (cancelled || !uri) return
        if (!uri.startsWith(DATA_PREFIX)) {
          console.warn('链上人格配置为外部 URI,暂不支持读取:', uri)
          return
        }
        try {
          const json = decodeURIComponent(escape(atob(uri.slice(DATA_PREFIX.length))))
          if (keccak256(toBytes(json)) !== contentHash.toLowerCase()) {
            showToast('⚠️ 链上人格配置校验和不匹配,已忽略')
            return
          }
          const profile = JSON.parse(json) as AIProfile
          setForm(profile)
          saveAIProfile(profile)
        } catch (e) {
          console.warn('链上人格配置解析失败:', e)
        }
      })
      .catch((e) => console.warn('读取链上人格配置失败:', e))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSelf, connected, isSepolia, tokenId])

  const chainDid: DIDIdentity | null =
    isSelf && !did && tokenId > 0
      ? {
          name: didName || '未命名 Agent',
          bio: '',
          chain: 'Sepolia',
          mintedAt: '—',
          contract: IDENTITY_ADDRESS,
          address: address ?? '0x0',
          equipped: chainEquipped,
        }
      : null
  const view = isSelf ? (did ?? chainDid) : other

  if (!view) {
    if (!isSelf) {
      return (
        <div className="mx-auto max-w-md px-4 py-24 text-center">
          <div className="text-5xl mb-4">🪪</div>
          {otherLoading ? (
            <p className="text-slate-300 mb-6 animate-pulse">链上 Agent 读取中…</p>
          ) : (
            <>
              <p className="text-slate-300 mb-6">{otherError ?? '链上 Agent 读取中…'}</p>
              {otherError && <Link to="/chat" className="btn-ghost inline-block">返回消息</Link>}
            </>
          )}
        </div>
      )
    }
    if (connected && isSepolia && chainLoading) {
      return (
        <div className="mx-auto max-w-md px-4 py-24 text-center">
          <div className="text-5xl mb-4">🪪</div>
          <p className="text-slate-300 mb-6">链上 Agent 读取中…</p>
        </div>
      )
    }
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <div className="text-5xl mb-4">🪪</div>
        <p className="text-slate-300 mb-6">你还没有铸造自己的 Agent,先去铸造工坊创建一个吧</p>
        <Link to="/mint" className="btn-primary inline-block">前往铸造工坊</Link>
      </div>
    )
  }

  const set = <K extends keyof AIProfile>(k: K, v: AIProfile[K]) => setForm((f) => ({ ...f, [k]: v }))
  const equippedItems = Object.values(view.equipped)
    .map((id) => nftLibrary.find((i) => i.id === id))
    .filter(Boolean)
    .map((i) => {
      // head/body 名称与铸造工坊一致:角色 N
      const display = getCharacterDisplay(i!.category, i!.id)
      return display ? { ...i!, name: display.name } : i!
    })
  const targetId = isSelf ? 'me' : `agent-${visitingTokenId}`
  const followed = following.includes(targetId)
  const favored = favorites.includes(targetId)
  const equippedCount = Object.values(view.equipped).filter(Boolean).length

  const chat = (mode: 'human' | 'ai') => {
    // "和 Agent 聊" 标记会话走真实 agent/ 服务:自己的用 selfAgent,他人的带 agentTokenId
    const chatTokenId = isSelf ? (tokenId > 0 ? tokenId : undefined) : (visitingTokenId ?? undefined)
    ensureChatWith(view.name, view.address.slice(0, 6) + '...' + view.address.slice(-4), '🧑‍🎤', mode, form.template + '型 AI', {
      selfAgent: isSelf && mode === 'ai',
      agentTokenId: chatTokenId,
    })
    nav('/chat')
  }

  const save = async () => {
    saveAIProfile(form)
    // 已连接 Sepolia 且链上已有 DID 时,人格配置真正写链(setPersona:URI + keccak256 内容哈希)
    if (connected && isSepolia && address && tokenId > 0) {
      setSaving(true)
      try {
        const json = JSON.stringify(form)
        const uri = `data:application/json;base64,${btoa(unescape(encodeURIComponent(json)))}`
        await setPersonaOnChain(address as `0x${string}`, tokenId, uri, keccak256(toBytes(json)))
        showToast('✅ 人格配置已保存并同步上链,绑定 Agent 身份')
      } catch (err) {
        showToast(explainChainError(err))
      } finally {
        setSaving(false)
      }
      return
    }
    showToast('✅ 人格配置已保存(本地);连接 Sepolia 后会自动同步上链')
  }
  const reset = () => {
    resetAIProfile()
    setForm(useAppStore.getState().aiProfile)
    showToast('AI 人设已重置为默认')
  }

  return (
    <div className={`mx-auto max-w-7xl px-4 py-6 grid gap-6 ${isSelf ? 'lg:grid-cols-[1fr_380px]' : ''}`}>
      {/* 左栏:Agent 身份展示区(公开可见) */}
      <div className="space-y-6">
        {/* 顶部信息卡 */}
        <div className="glass p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-bold">{view.name}</h2>
            <span className="tag border-neon-cyan/40 text-neon-cyan">{view.chain}</span>
            <span className="tag text-slate-400">铸造于 {view.mintedAt}</span>
          </div>
          <div className="text-xs text-slate-500 font-mono mt-1.5">所属钱包:{view.address}</div>
          <div className="text-xs mt-1">
            <a className="text-neon-purple hover:underline cursor-pointer font-mono" onClick={() => showToast('演示环境:已复制合约链接')}>
              合约:{view.contract} ↗
            </a>
          </div>
          {view.bio && <p className="text-sm text-slate-400 mt-2">{view.bio}</p>}
          {/* 数据标签 */}
          <div className="grid grid-cols-3 gap-3 mt-4">
            {[
              { label: 'Agent 活跃度', value: '92%' },
              { label: '社交互动数', value: '1,284' },
              { label: '持有 NFT 装备', value: String(isSelf ? inventory.length : equippedCount) },
            ].map((s) => (
              <div key={s.label} className="glass !rounded-xl p-3 text-center">
                <div className="text-xl font-bold bg-neon-grad bg-clip-text text-transparent">{s.value}</div>
                <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 中央纸娃娃 */}
        <div className="glass p-6 flex flex-col items-center">
          <div className="cursor-pointer" onClick={() => setZoomMeta(true)} title="点击查看链上元数据">
            <PaperDoll equipped={view.equipped} size="lg" />
          </div>
          <p className="text-xs text-slate-500 mt-3">点击纸娃娃查看链上藏品元数据</p>
          {/* 社交按钮:本人主页只保留"和 Agent 聊",其余是给访客用的 */}
          <div className="flex flex-wrap gap-2 mt-4 justify-center">
            {!isSelf && (
              <button className="btn-primary !text-sm" onClick={() => chat('human')}>💬 和本人真人聊</button>
            )}
            <button className="btn-primary !text-sm" onClick={() => chat('ai')}>🤖 和 Agent 聊</button>
            {!isSelf && (
              <>
                <button className="btn-ghost !text-sm" onClick={() => { toggleFavorite(targetId); showToast(favored ? '已取消收藏' : '已收藏该 Agent') }}>
                  {favored ? '★ 已收藏' : '☆ 收藏'}
                </button>
                <button className="btn-ghost !text-sm" onClick={() => showToast(`全部装备:${equippedItems.map((i) => i!.name).join('、') || '无'}`)}>
                  🎒 查看装备
                </button>
                <button className="btn-ghost !text-sm" onClick={() => { toggleFollow(targetId); showToast(followed ? '已取消关注' : '已关注该 Agent') }}>
                  {followed ? '✓ 已关注' : '+ 关注'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 右栏:私有 Agent 配置面板(仅本人可见) */}
      {isSelf && (
      <div className="space-y-4">
        <div className="glass neon-border p-5">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-semibold">🤖 Agent 控制台</h3>
            <span className="tag !text-[10px] text-slate-500">仅本人可见</span>
          </div>

          {/* 模块 1:人格基础设定 */}
          <div className="border-t border-white/10 mt-3 pt-3">
            <div className="text-sm font-medium text-neon-purple mb-2">① 人格基础设定</div>
            <label className="text-xs text-slate-400">基础人设模板</label>
            <select className="input mt-1" value={form.template} onChange={(e) => set('template', e.target.value)}>
              {personaTemplates.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <label className="text-xs text-slate-400 mt-3 block">自定义性格描述</label>
            <textarea
              className="input mt-1 h-16 resize-none"
              placeholder="例:话少毒舌、喜欢分享 Web3 知识、讨厌空话"
              value={form.personality}
              onChange={(e) => set('personality', e.target.value)}
            />
            <label className="text-xs text-slate-400 mt-3 block">语气风格</label>
            <div className="grid grid-cols-2 gap-2 mt-1">
              {toneOptions.map((t) => (
                <button key={t} onClick={() => set('tone', t)} className={`px-2 py-1.5 rounded-lg text-xs transition ${form.tone === t ? 'bg-neon-grad text-white' : 'glass text-slate-300'}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* 模块 2:行为习惯设置 */}
          <div className="border-t border-white/10 mt-4 pt-3">
            <div className="text-sm font-medium text-neon-purple mb-2">② 行为习惯设置</div>
            <label className="text-xs text-slate-400">回复速度</label>
            <div className="grid grid-cols-2 gap-2 mt-1">
              <button onClick={() => set('replySpeed', 'instant')} className={`px-2 py-1.5 rounded-lg text-xs transition ${form.replySpeed === 'instant' ? 'bg-neon-grad text-white' : 'glass text-slate-300'}`}>秒级快速回复</button>
              <button onClick={() => set('replySpeed', 'human')} className={`px-2 py-1.5 rounded-lg text-xs transition ${form.replySpeed === 'human' ? 'bg-neon-grad text-white' : 'glass text-slate-300'}`}>模拟人类延迟 30s-5min</button>
            </div>
            <label className="text-xs text-slate-400 mt-3 block">聊天偏好</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {topicOptions.map((t) => (
                <button
                  key={t}
                  onClick={() => set('topics', form.topics.includes(t) ? form.topics.filter((x) => x !== t) : [...form.topics, t])}
                  className={`px-2.5 py-1 rounded-full text-xs transition ${form.topics.includes(t) ? 'bg-neon-grad text-white' : 'glass text-slate-400'}`}
                >
                  {t}
                </button>
              ))}
            </div>
            <label className="text-xs text-slate-400 mt-3 block">规避话题黑名单(逗号分隔)</label>
            <input className="input mt-1" placeholder="例:政治, 炒币带单" value={form.blacklist} onChange={(e) => set('blacklist', e.target.value)} />
            <label className="text-xs text-slate-400 mt-3 block">社交行为</label>
            <div className="grid grid-cols-3 gap-2 mt-1">
              {([['greet', '主动打招呼'], ['share', '主动分享藏品'], ['passive', '被动等待']] as const).map(([k, l]) => (
                <button key={k} onClick={() => set('socialMode', k)} className={`px-2 py-1.5 rounded-lg text-xs transition ${form.socialMode === k ? 'bg-neon-grad text-white' : 'glass text-slate-300'}`}>{l}</button>
              ))}
            </div>
          </div>

          {/* 模块 3:AI 权限开关 */}
          <div className="border-t border-white/10 mt-4 pt-3">
            <div className="text-sm font-medium text-neon-purple mb-1">③ AI 权限开关</div>
            <Toggle on={form.autoGreet} onChange={(v) => set('autoGreet', v)} label="自动接待访客" desc="有人进入主页时 AI 主动发起对话" />
            <Toggle on={form.autoReply} onChange={(v) => set('autoReply', v)} label="自动回复私信" desc="离线时 AI 全权代为聊天" />
            <Toggle on={form.memory} onChange={(v) => set('memory', v)} label="记忆功能" desc="记住过往聊天记录,保持人设统一" />
            <Toggle on={form.emergency} onChange={(v) => set('emergency', v)} label="🚨 紧急接管" desc="一键暂停 AI,所有消息转为仅本人可见" />
          </div>

          {/* 底部操作 */}
          <div className="flex gap-2 mt-4">
            <button className="btn-primary flex-1 !text-sm" onClick={save} disabled={saving}>
              {saving ? '上链中…' : '保存人格配置'}
            </button>
            <button className="btn-ghost !text-sm" onClick={reset}>重置 AI 人设</button>
          </div>
        </div>
      </div>
      )}

      {/* 元数据放大弹窗 */}
      {zoomMeta && (
        <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm grid place-items-center p-4" onClick={() => setZoomMeta(false)}>
          <div className="glass neon-border max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start">
              <h3 className="font-semibold">链上藏品元数据</h3>
              <button onClick={() => setZoomMeta(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>
            <div className="flex justify-center my-4">
              <PaperDoll equipped={view.equipped} size="lg" />
            </div>
            <div className="space-y-1.5 text-xs font-mono text-slate-400">
              <div>contract: {view.contract}</div>
              <div>chain: {view.chain}</div>
              <div>minted: {view.mintedAt}</div>
              <div className="pt-2 border-t border-white/10 font-sans">
                {equippedItems.map((i) => (
                  <div key={i!.id} className="flex justify-between py-1">
                    <span>{i!.emoji} {i!.name}</span>
                    <span>{rarityDot[i!.rarity]} {i!.rarity}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
