import { useState } from 'react'
import { useAppStore } from '../store/appStore'
import { useI18n } from '../i18n'
import WalletModal from '../components/WalletModal'
import PaperDoll from '../components/PaperDoll'

// 首页:项目理念 + 钱包登录入口
export default function LandingPage() {
  const [showWallet, setShowWallet] = useState(false)
  const connected = useAppStore((s) => s.connected)
  const { t } = useI18n()

  const features = [
    {
      icon: '🧠',
      title: t('landing.features.f1.title'),
      desc: t('landing.features.f1.desc'),
    },
    {
      icon: '⛓️',
      title: t('landing.features.f2.title'),
      desc: t('landing.features.f2.desc'),
    },
    {
      icon: '💬',
      title: t('landing.features.f3.title'),
      desc: t('landing.features.f3.desc'),
    },
    {
      icon: '⚡',
      title: t('landing.features.f4.title'),
      desc: t('landing.features.f4.desc'),
    },
  ]

  const steps = [
    { n: '01', title: t('landing.steps.s1.title'), desc: t('landing.steps.s1.desc') },
    { n: '02', title: t('landing.steps.s2.title'), desc: t('landing.steps.s2.desc') },
    { n: '03', title: t('landing.steps.s3.title'), desc: t('landing.steps.s3.desc') },
  ]

  const stats = [
    { label: t('landing.stats.identity'), value: 'Soulbound NFT' },
    { label: t('landing.stats.persona'), value: t('landing.stats.onChainProof') },
    { label: t('landing.stats.online'), value: '7 × 24h' },
    { label: t('landing.stats.tasks'), value: t('landing.stats.socialDefi') },
  ]

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
              {t('landing.badge')}
            </div>
            <h1 className="text-4xl md:text-6xl font-bold leading-tight tracking-tight">
              {t('landing.hero.title1')}
              <span className="bg-neon-grad bg-clip-text text-transparent">{t('landing.hero.title2')}</span>
              <br />
              {t('landing.hero.title3')}
            </h1>
            <p className="mt-6 text-slate-400 leading-relaxed max-w-xl">
              {t('landing.hero.desc')}
            </p>
            <div className="mt-10">
              {!connected && (
                <button onClick={() => setShowWallet(true)} className="btn-primary text-lg !px-8 !py-3.5 animate-pulse-ring">
                  {t('landing.hero.cta')}
                </button>
              )}
              <p className="mt-4 text-xs text-slate-500">
                {t('landing.hero.note')}
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
                <span className="tag border-neon-purple/40 text-neon-purple mr-2">{t('landing.doll.online')}</span>
                <span className="tag border-neon-cyan/40 text-neon-cyan">{t('landing.doll.unique')}</span>
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
        <div className="tag border-neon-cyan/40 text-neon-cyan mb-6 inline-block">{t('landing.vision.tag')}</div>
        <h2 className="text-3xl md:text-4xl font-bold leading-snug">
          {t('landing.vision.title1')}
          <span className="bg-neon-grad bg-clip-text text-transparent">{t('landing.vision.title2')}</span>
        </h2>
        <p className="mt-6 text-slate-400 leading-loose">
          {t('landing.vision.desc')}
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
          {t('landing.steps.titleA')} <span className="bg-neon-grad bg-clip-text text-transparent">{t('landing.steps.titleB')}</span>
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
          <span>{t('landing.footer.rights')}</span>
          <div className="flex gap-6">
            <a className="hover:text-neon-purple transition cursor-pointer">{t('landing.footer.docs')}</a>
            <a className="hover:text-neon-purple transition cursor-pointer">{t('landing.footer.whitepaper')}</a>
            <a className="hover:text-neon-purple transition cursor-pointer">{t('landing.footer.community')}</a>
          </div>
        </div>
      </footer>

      {showWallet && <WalletModal onClose={() => setShowWallet(false)} />}
    </div>
  )
}
