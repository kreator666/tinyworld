import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import zh from './locales/zh'
import en from './locales/en'

export type Lang = 'zh' | 'en'

const dictionaries: Record<Lang, Record<string, unknown>> = { zh, en }
const STORAGE_KEY = 'agentverse-lang'

type Dict = Record<string, unknown>

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

let currentLang: Lang = detectLang()
const listeners = new Set<(lang: Lang) => void>()

export function getLang(): Lang {
  return currentLang
}

export function setLang(lang: Lang) {
  if (lang === currentLang) return
  currentLang = lang
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // ignore
  }
  listeners.forEach((fn) => fn(lang))
}

function lookup(dict: Dict | undefined, key: string): unknown {
  let node: unknown = dict
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Dict)[part]
  }
  return node
}

/**
 * 翻译函数。key 为点分路径(如 'shell.nav.profile')。
 * 当前语言缺失时回退到中文,再回退到 key 本身。
 * 支持 {name} 插值:t('arena.switch', { name: 'Solana' })
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let value = lookup(dictionaries[currentLang], key)
  if (value === undefined) value = lookup(dictionaries.zh, key)
  if (value === undefined) value = key
  let str = String(value)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.split(`{${k}}`).join(String(v))
    }
  }
  return str
}

interface LangContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: typeof t
}

const LangContext = createContext<LangContextValue>({ lang: currentLang, setLang, t })

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState(currentLang)
  useEffect(() => {
    const fn = (l: Lang) => setLangState(l)
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    const title = t('docTitle')
    if (title !== 'docTitle') document.title = title
  }, [lang])
  return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>
}

export function useI18n(): LangContextValue {
  return useContext(LangContext)
}
