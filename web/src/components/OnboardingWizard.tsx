import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'

// ============================================================
// 新手引导蒙板 Wizard:首次登录自动弹出,教用户走完核心流程;
// 顶部导航栏有开关可随时手动打开/关闭
// ============================================================

interface WizardStep {
  icon: string
  title: string
  desc: string
  tip?: string
}

const steps: WizardStep[] = [
  {
    icon: '👋',
    title: '欢迎来到 AgentVerse',
    desc: '这里可以铸造一个专属于你的链上 AI Agent:它有你的性格、你的语气,拥有链上唯一身份。它替你社交、替你互动、替你执行 DeFi 任务。',
    tip: '整个流程只需 3 步:连接钱包 → 铸造 Agent → 开始互动',
  },
  {
    icon: '🪪',
    title: '第一步:铸造你的 Agent',
    desc: '前往「铸造工坊」,挑选头像、身体、配饰和宠物,给 Agent 起一个全网唯一的名字,确认后身份 NFT 就铸到链上了,永久归属你的钱包。',
    tip: '名称全网唯一,先到先得;每个钱包只能铸造 1 枚',
  },
  {
    icon: '🎛️',
    title: '第二步:配置人格与能力',
    desc: '在「个人主页 → Agent 控制台」定义它的人格模板、语气风格、回复速度和聊天偏好。内置技能(社交、行情、兑换、借贷理财)默认全部启用;右上角面板还能切换兑换执行模式、处理任务审批。',
    tip: '人格配置会哈希上链存证,任何人都无法篡改',
  },
  {
    icon: '💬',
    title: '第三步:开始互动',
    desc: '「我的 Agent 助手」是只属于你的 Agent 对话页,支持多个会话,它记得你们聊过的一切。「社交广场」可以认识其他真人玩家,「消息」页和别的 Agent 或真人聊天。',
    tip: '你自己的 Agent 在「个人主页」点「和 Agent 聊」进入',
  },
  {
    icon: '💰',
    title: '进阶:让 Agent 帮你理财',
    desc: '在助手页直接说「把 0.05 AVAX 换成 USDC」或「存 0.01 USDC 到 Aave 赚收益」,Agent 会组装交易、经策略引擎限额把关,再由你签名确认。可随时问「我的理财仓位多少」。',
    tip: '签名模式可在个人主页切换:热钱包自动执行 / 我的钱包签名',
  },
]

export default function OnboardingWizard() {
  const open = useAppStore((s) => s.wizardOpen)
  const setOpen = useAppStore((s) => s.setWizardOpen)
  const [step, setStep] = useState(0)
  const nav = useNavigate()

  if (!open) return null

  const close = () => {
    setOpen(false)
    setStep(0)
  }

  const go = (path: string) => {
    close()
    nav(path)
  }

  const last = step === steps.length - 1
  const s = steps[step]

  return (
    <div className="fixed inset-0 z-[95] bg-black/75 backdrop-blur-sm grid place-items-center p-4" onClick={close}>
      <div
        className="glass neon-border w-full max-w-md p-7 relative animate-[fadeIn_.25s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={close} className="absolute top-4 right-4 text-slate-400 hover:text-white" title="关闭">
          ✕
        </button>

        {/* 步骤指示器 */}
        <div className="flex items-center gap-1.5 mb-5">
          {steps.map((_, i) => (
            <span
              key={i}
              className={`h-1 rounded-full transition-all ${i === step ? 'w-8 bg-neon-grad' : 'w-3 bg-white/15'}`}
            />
          ))}
          <span className="ml-auto text-[10px] text-slate-500 font-mono">
            {step + 1} / {steps.length}
          </span>
        </div>

        <div className="text-4xl mb-4">{s.icon}</div>
        <h3 className="text-xl font-bold mb-3">{s.title}</h3>
        <p className="text-sm text-slate-400 leading-relaxed">{s.desc}</p>
        {s.tip && (
          <p className="mt-3 text-xs text-neon-cyan/80 border border-neon-cyan/20 rounded-lg px-3 py-2 bg-neon-cyan/5">
            💡 {s.tip}
          </p>
        )}

        {/* 底部操作 */}
        <div className="flex items-center gap-2 mt-6">
          {step > 0 && (
            <button className="btn-ghost !text-xs !px-4 !py-2" onClick={() => setStep(step - 1)}>
              ← 上一步
            </button>
          )}
          <button className="text-xs text-slate-500 hover:text-slate-300 ml-1" onClick={close}>
            跳过
          </button>
          <div className="ml-auto flex gap-2">
            {!last ? (
              <button className="btn-primary !text-xs !px-5 !py-2" onClick={() => setStep(step + 1)}>
                下一步 →
              </button>
            ) : (
              <>
                <button className="btn-ghost !text-xs !px-4 !py-2" onClick={() => go('/mint')}>
                  去铸造
                </button>
                <button className="btn-primary !text-xs !px-5 !py-2" onClick={() => go('/profile')}>
                  开始探索 🚀
                </button>
              </>
            )}
          </div>
        </div>

        <p className="mt-4 text-center text-[10px] text-slate-600">之后可随时点顶部导航栏的「🎓 新手引导」重新打开</p>
      </div>
    </div>
  )
}
