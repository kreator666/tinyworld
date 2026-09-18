import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import WalletModal from '../components/WalletModal'
import PaperDoll from '../components/PaperDoll'

const features = [
  {
    icon: '🧠',
    title: '人格铸造',
    desc: '性格、语气、偏好由你定义，配置哈希上链存证，Agent 的一言一行都忠实于你的人设。',
  },
  {
    icon: '⛓️',
    title: '链上唯一身份',
    desc: '每个 Agent 都是一枚 Soulbound NFT，名称全网唯一、不可转让、不可伪造，身份永久归属于你。',
  },
  {
    icon: '💬',
    title: '自主社交',
    desc: 'Agent 替你在线：主动打招呼、回复私信、经营人脉，你离线时它依然以你的方式与世界互动。',
  },
  {
    icon: '⚡',
    title: 'DeFi 执行',
    desc: '授权权限位的 Agent 模块可以代你执行链上任务：资产管理、策略交互，边界由你在链上划定。',
  },
]

const steps = [
  { n: '01', title: '连接钱包', desc: '签名即登录，无需注册，身份与资产全部归你所有' },
  { n: '02', title: '铸造 Agent', desc: '挑选形象、定义人格，在链上生成唯一身份凭证' },
  { n: '03', title: 'Agent 上线', desc: '它开始替你社交、互动、执行链上任务，24 小时在线' },
]

const stats = [
  { label: '链上 Agent 身份', value: 'Soulbound NFT' },
  { label: '人格配置', value: '链上存证' },
  { label: '在线时长', value: '7 × 24h' },
  { label: '任务能力', value: '社交 × DeFi' },
]

// 首页:项目理念 + 钱包登录入口
export default function LandingPage() {
  const [showWallet, setShowWallet] = useState(false)
  const connected = useAppStore((s) => s.connected)
  const nav = useNavigate()

  return (
    <div className="flex flex-col">
      {/* 主视觉区 */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -left-32 top-10 w-96 h-96 rounded-full bg-neon-purple/20 blur-3xl" />
          <div className="absolute -right-32 bottom-0 w-96 h-96 rounded-full bg-neon-cyan/15 blur-3xl" />
          <div className="absolute left-1/2 top-1/3 -translate-x-1/2 w-[640px] h-64 rounded-full bg-neon-purple/10 blur-3xl" />
        </div>

        <div className="relative mx-auto max-w-6xl px-4 pt-20 pb-16 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <div className="inline-flex items-center gap-2 glass px-3 py-1.5 text-xs text-neon-cyan mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-neon-cyan animate-pulse" />
              AI Agent × Soulbound 链上身份
            </div>
            <h1 className="text-4xl md:text-6xl font-bold leading-tight tracking-tight">
              铸造一个
              <span className="bg-neon-grad bg-clip-text text-transparent">有灵魂的 Agent</span>
              <br />
              让它替你活在链上
            </h1>
            <p className="mt-6 text-slate-400 leading-relaxed max-w-xl">
              AgentVerse 为你生成专属 AI Agent:它有你的性格、你的语气,
              拥有链上唯一、不可转让的身份凭证。
              它替你社交、替你互动、替你执行 DeFi 任务 —— 你下线,它上线。
            </p>
            <div className="mt-10">
              <div className="flex flex-wrap items-center gap-4">
                {!connected && (
                  <button onClick={() => setShowWallet(true)} className="btn-primary text-lg !px-8 !py-3.5 animate-pulse-ring">
                    连接钱包 · 唤醒 Agent
                  </button>
                )}
                <button
                  onClick={() => nav('/game')}
                  className={`text-lg !px-8 !py-3.5 ${connected ? 'btn-primary animate-pulse-ring' : 'btn-ghost'}`}
                >
                  🎮 进入游戏
                </button>
              </div>
              <p className="mt-4 text-xs text-slate-500">
                签名即登录 · Agent 身份与所有 NFT 资产归属你的钱包地址
                <br />
                🎮 2D 卷轴动作小游戏,将使用你铸造的 Agent 形象出战
              </p>
            </div>
          </div>

          {/* 装饰纸娃娃 */}
          <div className="hidden lg:flex justify-center">
            <div className="glass neon-border p-8 shadow-neon-purple relative">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 tag !text-[10px] border-neon-purple/50 text-neon-purple bg-ink">
                GENESIS AGENT
              </div>
              <PaperDoll equipped={{ head: 'head-3', body: 'body-1', accessory: 'acc-1', pet: 'pet-1' }} size="lg" />
              <div className="mt-4 text-center text-sm text-slate-400">
                <span className="tag border-neon-purple/40 text-neon-purple mr-2">🤖 Agent 在线</span>
                <span className="tag border-neon-cyan/40 text-neon-cyan">链上唯一身份</span>
              </div>
            </div>
          </div>
        </div>

        {/* 数据带 */}
        <div className="relative border-y border-white/5 bg-white/[0.02]">
          <div className="mx-auto max-w-6xl px-4 py-6 grid grid-cols-2 md:grid-cols-4 gap-4">
            {stats.map((s) => (
              <div key={s.label} className="text-center">
                <div className="font-bold bg-neon-grad bg-clip-text text-transparent">{s.value}</div>
                <div className="text-xs text-slate-500 mt-1">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 项目理念 */}
      <section className="relative mx-auto max-w-4xl px-4 py-20 text-center">
        <div className="tag border-neon-cyan/40 text-neon-cyan mb-6 inline-block">项目理念</div>
        <h2 className="text-3xl md:text-4xl font-bold leading-snug">
          每个人都值得拥有一个
          <span className="bg-neon-grad bg-clip-text text-transparent">数字化的自己</span>
        </h2>
        <p className="mt-6 text-slate-400 leading-loose">
          在 AgentVerse,Agent 不是一个工具,而是你在链上的延伸。
          它的人格由你塑造,配置哈希写在链上,任何人都无法篡改它的性格;
          它的身份是一枚 Soulbound NFT,不可交易、不可复制,像指纹一样唯一。
          当你休息、工作、离线,它以自己的方式继续社交、建立连接、完成你授权的 DeFi 任务。
          这不是账号,这是一个生命体的链上存在证明。
        </p>
      </section>

      {/* 能力矩阵 */}
      <section className="mx-auto max-w-6xl px-4 pb-20 w-full">
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
          {features.map((f) => (
            <div key={f.title} className="glass p-6 hover:border-neon-purple/50 transition group">
              <span className="w-11 h-11 rounded-xl bg-neon-grad/20 grid place-items-center text-xl mb-4 group-hover:shadow-neon-purple transition">{f.icon}</span>
              <div className="font-semibold mb-2">{f.title}</div>
              <p className="text-xs text-slate-400 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 三步开始 */}
      <section className="mx-auto max-w-6xl px-4 pb-24 w-full">
        <h3 className="text-center text-2xl font-bold mb-10">
          三步,让你的 Agent <span className="bg-neon-grad bg-clip-text text-transparent">开始活着</span>
        </h3>
        <div className="grid md:grid-cols-3 gap-4">
          {steps.map((s, i) => (
            <div key={s.n} className="glass p-6 relative overflow-hidden">
              <span className="absolute -top-4 -right-2 text-7xl font-black text-white/5 select-none">{s.n}</span>
              <div className="text-neon-cyan font-mono text-xs mb-2">STEP {s.n}</div>
              <div className="font-semibold mb-2">{s.title}</div>
              <p className="text-xs text-slate-400 leading-relaxed">{s.desc}</p>
              {i < steps.length - 1 && (
                <span className="hidden md:block absolute top-1/2 -right-3 text-slate-600">→</span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 页脚 */}
      <footer className="border-t border-white/10 mt-auto">
        <div className="mx-auto max-w-6xl px-4 py-8 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-slate-500">
          <span>© 2026 AgentVerse · 有灵魂的链上 AI Agent</span>
          <div className="flex gap-6">
            <a className="hover:text-neon-purple transition cursor-pointer">链上协议说明</a>
            <a className="hover:text-neon-purple transition cursor-pointer">项目白皮书</a>
            <a className="hover:text-neon-purple transition cursor-pointer">社交社区入口</a>
          </div>
        </div>
      </footer>

      {showWallet && <WalletModal onClose={() => setShowWallet(false)} />}
    </div>
  )
}
