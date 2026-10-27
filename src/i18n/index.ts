import en from './en.json'
import es from './es.json'
import fr from './fr.json'
import ja from './ja.json'
import ko from './ko.json'
import ru from './ru.json'
import zh from './zh.json'
import zhTW from './zh-TW.json'

export type Lang = 'zh' | 'zh-TW' | 'en' | 'ja' | 'ko' | 'fr' | 'es' | 'ru'

let currentLang: Lang = 'zh'

/** 设置页语言下拉的选项。顺序按用户规模排，中文在最前。 */
export const LANG_OPTIONS: { value: Lang; label: string }[] = [
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'ru', label: 'Русский' },
]

const locales: Record<Lang, Record<string, any>> = {
  zh,
  'zh-TW': zhTW,
  en,
  ja,
  ko,
  fr,
  es,
  ru,
}

/**
 * 某语言缺失某个键时的回退顺序。
 *
 * 本地新增的功能（快照、采样参数、思考档位等）只写进了 zh/en，
 * 其余 6 套沿用上游词表。缺键回退到英文、再回退中文 ——
 * 总比界面直接显示原始键名（`settings.xxx`）好。
 */
function fallbackChain(lang: Lang): Lang[] {
  if (lang === 'zh') return ['zh', 'en']
  if (lang === 'zh-TW') return ['zh-TW', 'zh', 'en']
  if (lang === 'en') return ['en', 'zh']
  return [lang, 'en', 'zh']
}

function pick(lang: Lang, keys: string[]): string | undefined {
  for (const candidate of fallbackChain(lang)) {
    let val: any = locales[candidate]
    for (const key of keys) {
      val = val?.[key]
      if (val === undefined) break
    }
    if (typeof val === 'string') return val
  }
  return undefined
}

export function isSupportedLang(value: unknown): value is Lang {
  return typeof value === 'string' && LANG_OPTIONS.some((o) => o.value === value)
}

export function setLanguage(lang: Lang) {
  currentLang = lang
  localStorage.setItem('mythpen-ui-lang', lang)
}

export function getLanguage(): Lang {
  return currentLang
}

export function t(path: string, params?: Record<string, string | number>): string {
  const keys = path.split('.')
  const val = pick(currentLang, keys)
  if (val === undefined) return path
  if (params) {
    return val.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`))
  }
  return val
}

// Init
const stored = localStorage.getItem('mythpen-ui-lang')
const settingsStored = localStorage.getItem('mythpen-settings')
let initLang: Lang = 'zh'
if (settingsStored) {
  try {
    const parsed = JSON.parse(settingsStored)
    if (isSupportedLang(parsed.uiLanguage)) initLang = parsed.uiLanguage
  } catch {
    /* ignore */
  }
} else if (isSupportedLang(stored)) {
  initLang = stored
}
if (initLang !== 'zh') {
  setLanguage(initLang)
}
