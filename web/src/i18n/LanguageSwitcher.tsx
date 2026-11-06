import { useI18n } from './index'

export default function LanguageSwitcher() {
  const { lang, setLang, t } = useI18n()
  return (
    <button
      onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
      className="tag !text-[10px] border-white/15 text-slate-400 hover:text-slate-200 transition"
      title={t('lang.switch')}
    >
      {lang === 'zh' ? 'EN' : '中文'}
    </button>
  )
}
