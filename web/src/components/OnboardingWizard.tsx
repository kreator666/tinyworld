import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import { useI18n } from '../i18n'

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

export default function OnboardingWizard() {
  const open = useAppStore((s) => s.wizardOpen)
  const setOpen = useAppStore((s) => s.setWizardOpen)
  const [step, setStep] = useState(0)
  const nav = useNavigate()
  const { t } = useI18n()

  const steps: WizardStep[] = [
    {
      icon: '👋',
      title: t('wizard.step1.title'),
      desc: t('wizard.step1.desc'),
      tip: t('wizard.step1.tip'),
    },
    {
      icon: '🪪',
      title: t('wizard.step2.title'),
      desc: t('wizard.step2.desc'),
      tip: t('wizard.step2.tip'),
    },
    {
      icon: '🎛️',
      title: t('wizard.step3.title'),
      desc: t('wizard.step3.desc'),
      tip: t('wizard.step3.tip'),
    },
    {
      icon: '💬',
      title: t('wizard.step4.title'),
      desc: t('wizard.step4.desc'),
      tip: t('wizard.step4.tip'),
    },
    {
      icon: '💰',
      title: t('wizard.step5.title'),
      desc: t('wizard.step5.desc'),
      tip: t('wizard.step5.tip'),
    },
  ]

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
        <button onClick={close} className="absolute top-4 right-4 text-slate-400 hover:text-white" title={t('wizard.close')}>
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
              {t('wizard.prev')}
            </button>
          )}
          <button className="text-xs text-slate-500 hover:text-slate-300 ml-1" onClick={close}>
            {t('wizard.skip')}
          </button>
          <div className="ml-auto flex gap-2">
            {!last ? (
              <button className="btn-primary !text-xs !px-5 !py-2" onClick={() => setStep(step + 1)}>
                {t('wizard.next')}
              </button>
            ) : (
              <>
                <button className="btn-ghost !text-xs !px-4 !py-2" onClick={() => go('/mint')}>
                  {t('wizard.goMint')}
                </button>
                <button className="btn-primary !text-xs !px-5 !py-2" onClick={() => go('/profile')}>
                  {t('wizard.start')}
                </button>
              </>
            )}
          </div>
        </div>

        <p className="mt-4 text-center text-[10px] text-slate-600">{t('wizard.reopenHint')}</p>
      </div>
    </div>
  )
}
