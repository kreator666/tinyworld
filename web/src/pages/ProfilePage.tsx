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
import { explainChainError, fetchAgentPublic, fetchPersona, setPersonaOnChain, ensureTargetChain, approveErc20, fetchOwnedPartCount, isWalletOnActiveChain } from '../lib/chainDispatch'
import { useChainConfig } from '../store/chainConfigStore'
import { getCharacterDisplay } from '../data/equipmentCatalog'
import {
  getAgentStatus,
  getAgentStats,
  installSkill,
  listSkills,
  uninstallSkill,
  getSwapMode,
  setSwapMode,
  type AgentStatus,
  type SkillInfo,
  type SwapMode,
} from '../lib/agentApi'
import { approveApproval, getApprovals, rejectApproval, type Approval } from '../lib/agentApi'
import { explorerTx } from '../store/chainConfigStore'
import { useI18n } from '../i18n'

// 兑换执行模式切换(M4):热钱包自动 vs 用户钱包签名
function SwapModeSection({ tokenId }: { tokenId: number }) {
  const { t } = useI18n()
  const showToast = useAppStore((s) => s.showToast)
  const [mode, setMode] = useState<SwapMode>('user_wallet')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getSwapMode(tokenId)
      .then((m) => setMode(m))
      .catch(() => showToast(t('profile.swapMode.loadFail')))
      .finally(() => setLoading(false))
  }, [tokenId])

  const change = async (next: SwapMode) => {
    if (next === mode) return
    setSaving(true)
    try {
      await setSwapMode(tokenId, next)
      setMode(next)
      showToast(next === 'user_wallet' ? t('profile.swapMode.switchedUser') : t('profile.swapMode.switchedHot'))
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('profile.common.switchFail'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="glass p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{t('profile.swapMode.title')}</h3>
      </div>
      {loading ? (
        <p className="text-xs text-slate-500 animate-pulse">{t('profile.common.loading')}</p>
      ) : (
        <div className="space-y-2">
          <button
            onClick={() => change('hot_wallet')}
            disabled={saving}
            className={`w-full text-left px-3 py-2 rounded-lg text-xs transition border ${
              mode === 'hot_wallet'
                ? 'bg-neon-grad/20 border-neon-purple/50 text-white'
                : 'glass border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <div className="font-medium">{t('profile.swapMode.hotTitle')}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">{t('profile.swapMode.hotDesc')}</div>
          </button>
          <button
            onClick={() => change('user_wallet')}
            disabled={saving}
            className={`w-full text-left px-3 py-2 rounded-lg text-xs transition border ${
              mode === 'user_wallet'
                ? 'bg-neon-grad/20 border-neon-purple/50 text-white'
                : 'glass border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <div className="font-medium">{t('profile.swapMode.userTitle')}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">{t('profile.swapMode.userDesc')}</div>
          </button>
        </div>
      )}
    </div>
  )
}

// 任务审批中心:Agent 的 DeFi 提案超限后在这里由本人放行/拒绝(M4)
// 用户资金路径(如 USDC→AVAX)需要主人钱包先完成 ERC20 approve,再调用后端放行
function ApprovalCenter({ tokenId, address }: { tokenId: number; address: string }) {
  const { t } = useI18n()
  const showToast = useAppStore((s) => s.showToast)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [offline, setOffline] = useState(false)
  const [acting, setActing] = useState<string | null>(null)

  const reload = () =>
    getApprovals(tokenId)
      .then((list) => {
        setApprovals(list)
        setOffline(false)
      })
      .catch(() => setOffline(true))

  useEffect(() => {
    reload()
    const timer = setInterval(reload, 20000) // 轮询:Agent 随时可能产生新提案
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenId])

  const act = async (a: Approval, action: 'approve' | 'reject') => {
    setActing(a.id)
    try {
      if (action === 'approve') {
        // 用户资金路径:需要先由主人钱包完成 ERC20 approve,后端才能 transferFrom
        if (a.signatureRequest) {
          await ensureTargetChain()
          const { token, spender, amount } = a.signatureRequest
          showToast(t('profile.approval.approveNeeded'))
          await approveErc20(address, token, spender, BigInt(amount))
          showToast(t('profile.approval.approvedOnChain'))
        }
        const r = await approveApproval(a.id)
        showToast(r.txHash ? t('profile.approval.executed') : t('profile.approval.approved'))
      } else {
        await rejectApproval(a.id)
        showToast(t('profile.approval.rejected'))
      }
      await reload()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('profile.common.actionFail'))
    } finally {
      setActing(null)
    }
  }

  const describe = (a: Approval) => {
    const p = a.proposal
    if (p.action === 'swap' && p.params) {
      return t('profile.approval.descSwap', { amountIn: p.params.amountIn ?? '', tokenIn: p.params.tokenIn ?? '', tokenOut: p.params.tokenOut ?? '' })
    }
    if (p.action === 'supply' && p.params) {
      return t('profile.approval.descSupply', { amountIn: p.params.amountIn ?? '', tokenIn: p.params.tokenIn ?? '' })
    }
    if (p.action === 'withdraw' && p.params) {
      return t('profile.approval.descWithdraw', { amount: p.params.tokenOut ?? p.params.tokenIn ?? '' })
    }
    return p.action
  }

  const pending = approvals.filter((a) => a.status === 'pending')
  const history = approvals.filter((a) => a.status !== 'pending').slice(0, 5)

  if (offline || approvals.length === 0) return null // 服务未启动或无提案时不占位

  return (
    <div className="glass p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{t('profile.approval.title')}</h3>
        {pending.length > 0 && (
          <span className="tag !text-[10px] border-amber-400/50 text-amber-300">{t('profile.approval.pending', { count: pending.length })}</span>
        )}
      </div>

      {pending.length > 0 && (
        <div className="space-y-3 mb-4">
          {pending.map((a) => (
            <div key={a.id} className="glass !rounded-xl p-3 border-amber-400/30">
              <div className="text-sm font-medium">{describe(a)}</div>
              <div className="text-[11px] text-slate-500 mt-1">
                {a.proposal.estimatedValueUsd != null && <>{t('profile.approval.about', { usd: a.proposal.estimatedValueUsd.toFixed(2) })} · </>}
                {a.proposal.protocol} · {new Date(a.created_at).toLocaleString('zh-CN')}
              </div>
              {a.agent_reason && <p className="text-xs text-slate-400 mt-1.5">{t('profile.approval.agentReason', { reason: a.agent_reason })}</p>}
              {a.signatureRequest && (
                <p className="text-xs text-amber-300 mt-1.5">
                  {t('profile.approval.needApprove', {
                    tokenSymbol: a.signatureRequest.tokenSymbol,
                    spender: a.signatureRequest.spender.slice(0, 6) + '…' + a.signatureRequest.spender.slice(-4),
                  })}
                </p>
              )}
              <div className="flex gap-2 mt-3">
                <button
                  className="btn-primary flex-1 !text-xs !py-1.5"
                  disabled={acting === a.id}
                  onClick={() => act(a, 'approve')}
                >
                  {acting === a.id ? t('profile.approval.executing') : t('profile.approval.approveBtn')}
                </button>
                <button
                  className="btn-ghost flex-1 !text-xs !py-1.5 hover:border-rose-400/50 hover:text-rose-300"
                  disabled={acting === a.id}
                  onClick={() => act(a, 'reject')}
                >
                  {t('profile.approval.rejectBtn')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div className="border-t border-white/10 pt-3">
          <div className="text-xs text-slate-500 mb-2">{t('profile.approval.recent')}</div>
          <div className="space-y-1.5">
            {history.map((a) => (
              <div key={a.id} className="flex items-center justify-between text-xs">
                <span className="text-slate-400 truncate">{describe(a)}</span>
                {a.status === 'executed' && a.tx_hash ? (
                  <a className="text-neon-cyan hover:underline shrink-0 ml-2" href={explorerTx(a.tx_hash)} target="_blank" rel="noreferrer">
                    {t('profile.approval.onChain')}
                  </a>
                ) : (
                  <span className={`shrink-0 ml-2 ${a.status === 'rejected' ? 'text-rose-400' : a.status === 'failed' ? 'text-amber-400' : 'text-slate-500'}`}>
                    {a.status === 'rejected' ? t('profile.approval.statusRejected') : a.status === 'failed' ? t('profile.approval.statusFailed') : a.status}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Agent 运行时状态面板:记忆统计 + 技能安装/卸载(M2)
function AgentStatusPanel({ tokenId }: { tokenId: number }) {
  const { t } = useI18n()
  const showToast = useAppStore((s) => s.showToast)
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([])
  const [offline, setOffline] = useState(false)
  const [acting, setActing] = useState<string | null>(null)

  const reload = () =>
    Promise.all([getAgentStatus(tokenId), listSkills()])
      .then(([st, sk]) => {
        setStatus(st)
        setAllSkills(sk)
        setOffline(false)
      })
      .catch(() => setOffline(true))

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenId])

  const toggleSkill = async (skill: SkillInfo) => {
    const installed = !!status?.skills.some((s) => s.id === skill.id)
    setActing(skill.id)
    try {
      if (installed) {
        await uninstallSkill(tokenId, skill.id)
        showToast(t('profile.agent.skillUninstalled', { name: skill.name }))
      } else {
        const r = await installSkill(tokenId, skill.id)
        showToast(t('profile.agent.skillInstalled', { name: skill.name, note: r.note ? `(${r.note})` : '' }))
      }
      await reload()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('profile.common.actionFail'))
    } finally {
      setActing(null)
    }
  }

  return (
    <div className="glass p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{t('profile.agent.title')}</h3>
        {status && (
          <span className={`tag !text-[10px] ${status.personaFromChain ? 'border-neon-cyan/40 text-neon-cyan' : 'text-slate-500'}`}>
            {status.personaFromChain ? t('profile.agent.personaOnChain') : t('profile.agent.defaultPersona')}
          </span>
        )}
      </div>
      {offline ? (
        <p className="text-xs text-slate-500">{t('profile.agent.offline')}</p>
      ) : !status ? (
        <p className="text-xs text-slate-500 animate-pulse">{t('profile.common.loading')}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 mb-4">
            <div className="glass !rounded-xl p-2.5 text-center">
              <div className="text-lg font-bold bg-neon-grad bg-clip-text text-transparent">{status.episodicCount}</div>
              <div className="text-[10px] text-slate-500">{t('profile.agent.episodic')}</div>
            </div>
            <div className="glass !rounded-xl p-2.5 text-center">
              <div className="text-lg font-bold bg-neon-grad bg-clip-text text-transparent">{status.semanticCount}</div>
              <div className="text-[10px] text-slate-500">{t('profile.agent.semantic')}</div>
            </div>
          </div>
          <div className="text-xs font-medium text-neon-purple mb-2">{t('profile.agent.skills', { installed: status.skills.length, total: allSkills.length })}</div>
          <p className="text-[10px] text-slate-500 mb-2 -mt-1">{t('profile.agent.skillsHint')}</p>
          <div className="space-y-2">
            {allSkills.map((sk) => {
              const installed = status.skills.some((s) => s.id === sk.id)
              return (
                <div key={sk.id} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs">{sk.name}</div>
                    {sk.description && <div className="text-[10px] text-slate-500 truncate">{sk.description}</div>}
                  </div>
                  <button
                    className={`shrink-0 !text-[10px] !px-2 !py-1 rounded-lg transition ${
                      installed
                        ? 'bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 hover:bg-rose-500/20 hover:border-rose-400/50 hover:text-rose-300'
                        : 'btn-primary'
                    }`}
                    disabled={acting === sk.id}
                    onClick={() => toggleSkill(sk)}
                  >
                    {acting === sk.id ? t('profile.agent.processing') : installed ? t('profile.agent.installed') : t('profile.agent.install')}
                  </button>
                </div>
              )
            })}
            {allSkills.length === 0 && <p className="text-[10px] text-slate-500">{t('profile.agent.noSkills')}</p>}
          </div>
        </>
      )}
    </div>
  )
}

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
  const { t } = useI18n()
  const active = useChainConfig((s) => s.active)
  const nav = useNavigate()
  const { tokenId: paramTokenId } = useParams()
  const { connected, address, login, did, aiProfile, saveAIProfile, resetAIProfile, following, favorites, toggleFollow, toggleFavorite, ensureChatWith, showToast } = useAppStore()
  const { tokenId, didName, equipped: chainEquipped, loading: chainLoading, refresh } = useChainStore()
  const [form, setForm] = useState<AIProfile>(aiProfile)
  const [zoomMeta, setZoomMeta] = useState(false)
  const [saving, setSaving] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false) // 人格控制台长表单默认收起,需要时再展开
  // 真实统计指标:活跃度/社交互动数(后端 tasks+social_messages 统计),NFT 数(链上 balanceOfBatch)
  const [stats, setStats] = useState<{ activityPercent: number; socialInteractions: number } | null>(null)
  const [nftCount, setNftCount] = useState<number | null>(null)

  // 访客模式:URL 带 tokenId 且不是自己的 Agent
  const visitingTokenId = paramTokenId ? Number(paramTokenId) : null
  const isSelf = visitingTokenId == null || visitingTokenId === tokenId
  const [other, setOther] = useState<DIDIdentity | null>(null)
  const [otherLoading, setOtherLoading] = useState(false)
  const [otherError, setOtherError] = useState<string | null>(null)

  const onTargetChain = isWalletOnActiveChain(login, active)

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
          chain: active.name,
          mintedAt: '—',
          contract: active.identity,
          address: a.owner,
          equipped: a.equipped,
        }),
      )
      .catch(() => setOtherError(t('profile.main.notFound')))
      .finally(() => setOtherLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitingTokenId, isSelf])

  // 读取当前钱包在目标链上的 Agent 状态(名称/装备等),用于个人主页展示
  useEffect(() => {
    if (isSelf && connected && onTargetChain && address) refresh(address)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSelf, connected, onTargetChain, address])

  // 真实统计指标:活跃度/社交互动数(后端按 tokenId 统计);NFT 装备数(链上 balanceOfBatch,按所属钱包)
  const statsTokenId = isSelf ? tokenId : visitingTokenId
  const statsOwner = isSelf ? address : (other?.address ?? null)
  useEffect(() => {
    if (!connected || !onTargetChain || statsTokenId == null || statsTokenId === 0) return
    let cancelled = false
    getAgentStats(statsTokenId)
      .then((s) => !cancelled && setStats({ activityPercent: s.activityPercent, socialInteractions: s.socialInteractions }))
      .catch(() => !cancelled && setStats(null))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, onTargetChain, statsTokenId])

  useEffect(() => {
    if (!connected || !onTargetChain || !statsOwner) return
    let cancelled = false
    fetchOwnedPartCount(statsOwner)
      .then((n) => !cancelled && setNftCount(n))
      .catch(() => !cancelled && setNftCount(null))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, onTargetChain, statsOwner])

  // 读取链上人格配置(personaOf)回填 AI 控制台;contentHash 校验不一致则忽略
  // 仅自己的主页装载(控制台只有本人可见)
  useEffect(() => {
    if (!isSelf || !connected || !onTargetChain || tokenId === 0) return
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
            showToast(t('profile.main.personaChecksum'))
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
  }, [isSelf, connected, onTargetChain, tokenId])

  // 链上数据为实时权威;本地 did 镜像(铸造时写入)作为名称/简介/铸造时间及预览形象的兜底
  // 兜底必须校验地址归属:镜像属于其他账户时(如切换钱包后的残留)不得展示,防止身份错套
  const didBelongsToSelf = !!did && !!address && did.address.toLowerCase() === address.toLowerCase()
  const safeDid = didBelongsToSelf ? did : null
  const hasChainEquipped = Object.values(chainEquipped).some(Boolean)
  const chainDid: DIDIdentity | null =
    isSelf && tokenId > 0
      ? {
          name: didName || safeDid?.name || t('profile.main.unnamed'),
          bio: safeDid?.bio ?? '',
          chain: active.name,
          mintedAt: safeDid?.mintedAt ?? '—',
          contract: active.identity,
          address: address ?? '0x0',
          equipped: hasChainEquipped ? chainEquipped : (safeDid?.equipped ?? chainEquipped),
        }
      : null
  const view = isSelf ? (chainDid ?? safeDid) : other

  if (!view) {
    if (!isSelf) {
      return (
        <div className="mx-auto max-w-md px-4 py-24 text-center">
          <div className="text-5xl mb-4">🪪</div>
          {otherLoading ? (
            <p className="text-slate-300 mb-6 animate-pulse">{t('profile.main.chainLoading')}</p>
          ) : (
            <>
              <p className="text-slate-300 mb-6">{otherError ?? t('profile.main.chainLoading')}</p>
              {otherError && <Link to="/chat" className="btn-ghost inline-block">{t('profile.main.backToChat')}</Link>}
            </>
          )}
        </div>
      )
    }
    if (connected && onTargetChain && chainLoading) {
      return (
        <div className="mx-auto max-w-md px-4 py-24 text-center">
          <div className="text-5xl mb-4">🪪</div>
          <p className="text-slate-300 mb-6">{t('profile.main.chainLoading')}</p>
        </div>
      )
    }
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <div className="text-5xl mb-4">🪪</div>
        <p className="text-slate-300 mb-6">{t('profile.main.noAgent')}</p>
        <Link to="/mint" className="btn-primary inline-block">{t('profile.main.goMint')}</Link>
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

  const chat = (mode: 'human' | 'ai') => {
    // 自己的 Agent → 专属助手页(豆包式多对话);别人的 Agent → 消息页社交会话
    if (isSelf && mode === 'ai') {
      nav('/assistant')
      return
    }
    const chatTokenId = isSelf ? (tokenId > 0 ? tokenId : undefined) : (visitingTokenId ?? undefined)
    ensureChatWith(view.name, view.address.slice(0, 6) + '...' + view.address.slice(-4), '🧑‍🎤', mode, t('profile.main.aiType', { template: form.template }), {
      agentTokenId: chatTokenId,
    })
    nav('/chat')
  }

  const save = async () => {
    saveAIProfile(form)
    if (!connected || !address) {
      showToast(t('profile.main.connectFirst'))
      return
    }
    if (!onTargetChain) {
      showToast(t('profile.main.walletMismatch', { name: active.name }))
      return
    }
    if (tokenId === 0) {
      showToast(t('profile.main.noIdentity'))
      return
    }
    // 激活链上已有 DID 时,人格配置真正写链(setPersona:URI + keccak256 内容哈希)
    setSaving(true)
    try {
      const json = JSON.stringify(form)
      const uri = `data:application/json;base64,${btoa(unescape(encodeURIComponent(json)))}`
      await setPersonaOnChain(address, tokenId, uri, keccak256(toBytes(json)))
      showToast(t('profile.main.personaSaved'))
    } catch (err) {
      showToast(explainChainError(err))
    } finally {
      setSaving(false)
    }
  }
  const reset = () => {
    resetAIProfile()
    setForm(useAppStore.getState().aiProfile)
    showToast(t('profile.main.personaReset'))
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
            <span className="tag text-slate-400">{t('profile.main.mintedAt', { date: view.mintedAt })}</span>
          </div>
          <div className="text-xs text-slate-500 font-mono mt-1.5">{t('profile.main.ownerWallet', { address: view.address })}</div>
          <div className="text-xs mt-1">
            <a className="text-neon-purple hover:underline cursor-pointer font-mono" onClick={() => showToast(t('profile.main.contractCopied'))}>
              {t('profile.main.contract', { contract: view.contract })}
            </a>
          </div>
          {view.bio && <p className="text-sm text-slate-400 mt-2">{view.bio}</p>}
          {/* 数据标签(真实统计:活跃度=近7天活跃占比,社交互动=收发消息总数,NFT=链上余额) */}
          <div className="grid grid-cols-3 gap-3 mt-4">
            {[
              { label: t('profile.main.statActivity'), value: stats ? `${stats.activityPercent}%` : '—' },
              { label: t('profile.main.statSocial'), value: stats ? String(stats.socialInteractions) : '—' },
              { label: t('profile.main.statNft'), value: nftCount != null ? String(nftCount) : '—' },
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
          <div className="cursor-pointer" onClick={() => setZoomMeta(true)} title={t('profile.main.zoomTitle')}>
            <PaperDoll equipped={view.equipped} size="lg" />
          </div>
          <p className="text-xs text-slate-500 mt-3">{t('profile.main.zoomHint')}</p>
          {/* 社交按钮:本人主页只保留"和 Agent 聊",其余是给访客用的 */}
          <div className="flex flex-wrap gap-2 mt-4 justify-center">
            {!isSelf && (
              <button className="btn-primary !text-sm" onClick={() => chat('human')}>{t('profile.main.chatHuman')}</button>
            )}
            <button className="btn-primary !text-sm" onClick={() => chat('ai')}>{t('profile.main.chatAi')}</button>
            {!isSelf && (
              <>
                <button className="btn-ghost !text-sm" onClick={() => { toggleFavorite(targetId); showToast(favored ? t('profile.main.unfavorited') : t('profile.main.favorited')) }}>
                  {favored ? t('profile.main.favored') : t('profile.main.favorite')}
                </button>
                <button className="btn-ghost !text-sm" onClick={() => showToast(t('profile.main.allEquipped', { items: equippedItems.map((i) => i!.name).join(t('profile.main.equipSeparator')) || t('profile.main.noEquip') }))}>
                  {t('profile.main.viewEquip')}
                </button>
                <button className="btn-ghost !text-sm" onClick={() => { toggleFollow(targetId); showToast(followed ? t('profile.main.unfollowed') : t('profile.main.followedToast')) }}>
                  {followed ? t('profile.main.following') : t('profile.main.follow')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 右栏:私有 Agent 面板(仅本人可见)。按「要操作的事 → 运行状态 → 基础配置」排序:
          审批中心/兑换模式常需要立即处理,置顶;人格表单最长,折叠收纳,默认收起 */}
      {isSelf && (
      <div className="space-y-4">
        {/* ① 任务审批中心:有待办时最需要立即看到 */}
        {tokenId > 0 && <ApprovalCenter tokenId={tokenId} address={address ?? ''} />}
        {/* ② 兑换执行模式:资金安全相关设置 */}
        {tokenId > 0 && <SwapModeSection tokenId={tokenId} />}
        {/* ③ Agent 运行时状态:记忆统计 + 技能管理(M2) */}
        {tokenId > 0 && <AgentStatusPanel tokenId={tokenId} />}

        {/* ④ Agent 控制台:人格/行为/权限配置(长表单,可折叠) */}
        <div className="glass neon-border p-5">
          <button className="w-full flex items-center justify-between" onClick={() => setConsoleOpen((v) => !v)}>
            <h3 className="font-semibold">{t('profile.main.console')}</h3>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500 hidden sm:block">
                {form.template} · {form.tone}{form.emergency ? t('profile.main.emergencyBadge') : ''}
              </span>
              <span className="tag !text-[10px] text-slate-500">{t('profile.main.onlySelf')}</span>
              <span className={`text-slate-400 transition-transform ${consoleOpen ? 'rotate-180' : ''}`}>▾</span>
            </div>
          </button>
          {consoleOpen && (
          <>
          {/* 模块 1:人格基础设定 */}
          <div className="border-t border-white/10 mt-3 pt-3">
            <div className="text-sm font-medium text-neon-purple mb-2">{t('profile.main.personaTitle')}</div>
            <label className="text-xs text-slate-400">{t('profile.main.templateLabel')}</label>
            <select className="input mt-1" value={form.template} onChange={(e) => set('template', e.target.value)}>
              {personaTemplates.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
            </select>
            <label className="text-xs text-slate-400 mt-3 block">{t('profile.main.personalityLabel')}</label>
            <textarea
              className="input mt-1 h-16 resize-none"
              placeholder={t('profile.main.personalityPlaceholder')}
              value={form.personality}
              onChange={(e) => set('personality', e.target.value)}
            />
            <label className="text-xs text-slate-400 mt-3 block">{t('profile.main.toneLabel')}</label>
            <div className="grid grid-cols-2 gap-2 mt-1">
              {toneOptions.map((tn) => (
                <button key={tn} onClick={() => set('tone', tn)} className={`px-2 py-1.5 rounded-lg text-xs transition ${form.tone === tn ? 'bg-neon-grad text-white' : 'glass text-slate-300'}`}>
                  {tn}
                </button>
              ))}
            </div>
          </div>

          {/* 模块 2:行为习惯设置 */}
          <div className="border-t border-white/10 mt-4 pt-3">
            <div className="text-sm font-medium text-neon-purple mb-2">{t('profile.main.habitTitle')}</div>
            <label className="text-xs text-slate-400">{t('profile.main.replySpeedLabel')}</label>
            <div className="grid grid-cols-2 gap-2 mt-1">
              <button onClick={() => set('replySpeed', 'instant')} className={`px-2 py-1.5 rounded-lg text-xs transition ${form.replySpeed === 'instant' ? 'bg-neon-grad text-white' : 'glass text-slate-300'}`}>{t('profile.main.replyInstant')}</button>
              <button onClick={() => set('replySpeed', 'human')} className={`px-2 py-1.5 rounded-lg text-xs transition ${form.replySpeed === 'human' ? 'bg-neon-grad text-white' : 'glass text-slate-300'}`}>{t('profile.main.replyHuman')}</button>
            </div>
            <label className="text-xs text-slate-400 mt-3 block">{t('profile.main.topicsLabel')}</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {topicOptions.map((tp) => (
                <button
                  key={tp}
                  onClick={() => set('topics', form.topics.includes(tp) ? form.topics.filter((x) => x !== tp) : [...form.topics, tp])}
                  className={`px-2.5 py-1 rounded-full text-xs transition ${form.topics.includes(tp) ? 'bg-neon-grad text-white' : 'glass text-slate-400'}`}
                >
                  {tp}
                </button>
              ))}
            </div>
            <label className="text-xs text-slate-400 mt-3 block">{t('profile.main.blacklistLabel')}</label>
            <input className="input mt-1" placeholder={t('profile.main.blacklistPlaceholder')} value={form.blacklist} onChange={(e) => set('blacklist', e.target.value)} />
            <label className="text-xs text-slate-400 mt-3 block">{t('profile.main.socialLabel')}</label>
            <div className="grid grid-cols-3 gap-2 mt-1">
              {([['greet', 'profile.main.socialGreet'], ['share', 'profile.main.socialShare'], ['passive', 'profile.main.socialPassive']] as const).map(([k, l]) => (
                <button key={k} onClick={() => set('socialMode', k)} className={`px-2 py-1.5 rounded-lg text-xs transition ${form.socialMode === k ? 'bg-neon-grad text-white' : 'glass text-slate-300'}`}>{t(l)}</button>
              ))}
            </div>
          </div>

          {/* 模块 3:AI 权限开关 */}
          <div className="border-t border-white/10 mt-4 pt-3">
            <div className="text-sm font-medium text-neon-purple mb-1">{t('profile.main.permTitle')}</div>
            <Toggle on={form.autoGreet} onChange={(v) => set('autoGreet', v)} label={t('profile.main.autoGreetLabel')} desc={t('profile.main.autoGreetDesc')} />
            <Toggle on={form.autoReply} onChange={(v) => set('autoReply', v)} label={t('profile.main.autoReplyLabel')} desc={t('profile.main.autoReplyDesc')} />
            <Toggle on={form.memory} onChange={(v) => set('memory', v)} label={t('profile.main.memoryLabel')} desc={t('profile.main.memoryDesc')} />
            <Toggle on={form.emergency} onChange={(v) => set('emergency', v)} label={t('profile.main.emergencyLabel')} desc={t('profile.main.emergencyDesc')} />
          </div>

          {/* 底部操作 */}
          <div className="flex gap-2 mt-4">
            <button className="btn-primary flex-1 !text-sm" onClick={save} disabled={saving}>
              {saving ? t('profile.main.saving') : t('profile.main.save')}
            </button>
            <button className="btn-ghost !text-sm" onClick={reset}>{t('profile.main.reset')}</button>
          </div>
          </>
          )}
        </div>
      </div>
      )}

      {/* 元数据放大弹窗 */}
      {zoomMeta && (
        <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm grid place-items-center p-4" onClick={() => setZoomMeta(false)}>
          <div className="glass neon-border max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start">
              <h3 className="font-semibold">{t('profile.main.metaTitle')}</h3>
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
