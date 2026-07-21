import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import type { AIProfile } from '../types'
import { nftLibrary } from '../mock/data'
import PaperDoll from '../components/PaperDoll'
import { personaTemplates, toneOptions, topicOptions } from '../mock/data'
import { rarityDot } from '../components/NFTCard'

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

// 页面 3:个人 DID 主页(展示 + AI 分身控制台)
export default function ProfilePage() {
  const nav = useNavigate()
  const { did, inventory, aiProfile, saveAIProfile, resetAIProfile, following, favorites, toggleFollow, toggleFavorite, ensureChatWith, showToast } = useAppStore()
  const [form, setForm] = useState<AIProfile>(aiProfile)
  const [zoomMeta, setZoomMeta] = useState(false)

  if (!did) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <div className="text-5xl mb-4">🪪</div>
        <p className="text-slate-300 mb-6">你还没有铸造 DID 身份,先去铸造工坊创建一个吧</p>
        <Link to="/mint" className="btn-primary inline-block">前往铸造工坊</Link>
      </div>
    )
  }

  const set = <K extends keyof AIProfile>(k: K, v: AIProfile[K]) => setForm((f) => ({ ...f, [k]: v }))
  const equippedItems = Object.values(did.equipped).map((id) => nftLibrary.find((i) => i.id === id)).filter(Boolean)
  const selfId = 'me'
  const followed = following.includes(selfId)
  const favored = favorites.includes(selfId)

  const chat = (mode: 'human' | 'ai') => {
    ensureChatWith(did.name, did.address.slice(0, 6) + '...' + did.address.slice(-4), '🧑‍🎤', mode, form.template + '型 AI')
    nav('/chat')
  }

  const save = () => {
    saveAIProfile(form)
    showToast('✅ 人格配置已保存并同步上链绑定 DID NFT')
  }
  const reset = () => {
    resetAIProfile()
    setForm(useAppStore.getState().aiProfile)
    showToast('AI 人设已重置为默认')
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 grid lg:grid-cols-[1fr_380px] gap-6">
      {/* 左栏:DID 身份展示区(公开可见) */}
      <div className="space-y-6">
        {/* 顶部信息卡 */}
        <div className="glass p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-bold">{did.name}</h2>
            <span className="tag border-neon-cyan/40 text-neon-cyan">{did.chain}</span>
            <span className="tag text-slate-400">铸造于 {did.mintedAt}</span>
          </div>
          <div className="text-xs text-slate-500 font-mono mt-1.5">DID 地址:{did.address}</div>
          <div className="text-xs mt-1">
            <a className="text-neon-purple hover:underline cursor-pointer font-mono" onClick={() => showToast('演示环境:已复制合约链接')}>
              合约:{did.contract} ↗
            </a>
          </div>
          {did.bio && <p className="text-sm text-slate-400 mt-2">{did.bio}</p>}
          {/* 数据标签 */}
          <div className="grid grid-cols-3 gap-3 mt-4">
            {[
              { label: 'AI 分身活跃度', value: '92%' },
              { label: '社交互动数', value: '1,284' },
              { label: '持有 NFT 装备', value: String(inventory.length) },
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
            <PaperDoll equipped={did.equipped} size="lg" />
          </div>
          <p className="text-xs text-slate-500 mt-3">点击纸娃娃查看链上藏品元数据</p>
          {/* 公开社交按钮 */}
          <div className="flex flex-wrap gap-2 mt-4 justify-center">
            <button className="btn-primary !text-sm" onClick={() => chat('human')}>💬 和本人真人聊</button>
            <button className="btn-primary !text-sm" onClick={() => chat('ai')}>🤖 和 AI 分身聊</button>
            <button className="btn-ghost !text-sm" onClick={() => { toggleFavorite(selfId); showToast(favored ? '已取消收藏' : '已收藏该 DID 身份') }}>
              {favored ? '★ 已收藏' : '☆ 收藏'}
            </button>
            <button className="btn-ghost !text-sm" onClick={() => showToast(`全部装备:${equippedItems.map((i) => i!.name).join('、') || '无'}`)}>
              🎒 查看装备
            </button>
            <button className="btn-ghost !text-sm" onClick={() => { toggleFollow(selfId); showToast(followed ? '已取消关注' : '已关注该 DID') }}>
              {followed ? '✓ 已关注' : '+ 关注'}
            </button>
          </div>
        </div>
      </div>

      {/* 右栏:私有 AI 分身配置面板(仅本人可见) */}
      <div className="space-y-4">
        <div className="glass neon-border p-5">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-semibold">🤖 AI 分身控制台</h3>
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
            <button className="btn-primary flex-1 !text-sm" onClick={save}>保存人格配置</button>
            <button className="btn-ghost !text-sm" onClick={reset}>重置 AI 人设</button>
          </div>
        </div>
      </div>

      {/* 元数据放大弹窗 */}
      {zoomMeta && (
        <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm grid place-items-center p-4" onClick={() => setZoomMeta(false)}>
          <div className="glass neon-border max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start">
              <h3 className="font-semibold">链上藏品元数据</h3>
              <button onClick={() => setZoomMeta(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>
            <div className="flex justify-center my-4">
              <PaperDoll equipped={did.equipped} size="lg" />
            </div>
            <div className="space-y-1.5 text-xs font-mono text-slate-400">
              <div>contract: {did.contract}</div>
              <div>chain: {did.chain}</div>
              <div>minted: {did.mintedAt}</div>
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
