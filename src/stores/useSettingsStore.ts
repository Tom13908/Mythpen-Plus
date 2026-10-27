import { create } from 'zustand'
import { isSupportedLang, setLanguage } from '@/i18n'
import { providersApi, settingsApi } from '@/lib/api'
import type { AIProviderProfile, AppSettings } from '@/types'

interface SettingsState {
  settings: AppSettings
  langVersion: number
  providers: AIProviderProfile[]
  activeProviderId: string
  providersLoaded: boolean
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  loadFromServer: () => Promise<void>
  saveProvidersLocal: (providers: AIProviderProfile[], activeId: string) => void
  loadProviders: () => Promise<void>
  switchProvider: (id: string) => void
  updateProvider: (id: string, patch: Partial<AIProviderProfile>) => void
  addProvider: () => void
  deleteProvider: (id: string) => void
}

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  apiKeyDeepseek: '',
  apiKeyAnthropic: '',
  apiKeyOpenai: '',
  apiBaseUrl: 'https://api.deepseek.com/v1',
  apiModel: 'deepseek-v4-flash',
  apiType: 'openai',
  uiLanguage: 'zh',
  theme: 'dark',
  editorFontSize: 17,
  editorFontFamily: "'Noto Serif SC', 'Source Han Serif SC', 'STSong', Georgia, serif",
  autoSaveInterval: 30,
  accentColor: '#c9a96e',
  httpTimeout: 300,
  showThinking: true,
}

const STORAGE_KEY = 'mythpen-settings'

/** 已下线的字段：旧 localStorage 里可能还留着，读进来时清掉，避免死数据永久生效 */
const REMOVED_KEYS = ['backupEnabled', 'maxOutputTokens']

function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      for (const k of REMOVED_KEYS) delete parsed[k]
      const restored: AppSettings = { ...DEFAULT_SETTINGS, ...parsed }
      // If the active apiKey is empty, fall back to per-provider slot
      if (!restored.apiKey) {
        if (restored.apiBaseUrl.includes('deepseek') && restored.apiKeyDeepseek)
          restored.apiKey = restored.apiKeyDeepseek
        else if (restored.apiBaseUrl.includes('anthropic') && restored.apiKeyAnthropic)
          restored.apiKey = restored.apiKeyAnthropic
        else if (restored.apiBaseUrl.includes('openai') && restored.apiKeyOpenai)
          restored.apiKey = restored.apiKeyOpenai
      }
      return restored
    }
  } catch {
    /* ignore parse errors */
  }
  return { ...DEFAULT_SETTINGS }
}

const initialSettings = loadSettings()

/** 把激活档案的字段镜像到扁平 settings（测试连接等既有流程直接读取这些字段） */
function applyActiveToSettings(settings: AppSettings, active?: AIProviderProfile): AppSettings {
  if (!active) return settings
  return {
    ...settings,
    apiKey: active.apiKey,
    apiBaseUrl: active.baseUrl,
    apiModel: active.model,
    apiType: active.type,
  }
}

// Sync i18n module with persisted language preference
if (initialSettings.uiLanguage !== 'zh' && isSupportedLang(initialSettings.uiLanguage)) {
  setLanguage(initialSettings.uiLanguage)
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: initialSettings,
  langVersion: 0,
  providers: [],
  activeProviderId: '',
  providersLoaded: false,

  loadFromServer: async () => {
    try {
      const serverSettings = await settingsApi.get()
      // 以本地偏好为底再覆盖服务端管理的 AI 连接字段。
      // 旧实现按字段逐个回填本地值，会漏掉新增的本地偏好
      // （showThinking / autoSaveInterval / httpTimeout 等被重置为默认）。
      const cur = get().settings
      const merged: AppSettings = { ...DEFAULT_SETTINGS, ...cur }
      // Override defaults with server values
      merged.apiKey = serverSettings.api_key ?? ''
      merged.apiBaseUrl = serverSettings.api_base_url || DEFAULT_SETTINGS.apiBaseUrl
      merged.apiModel = serverSettings.api_model || DEFAULT_SETTINGS.apiModel
      // If server has no API key, fall back to current provider's per-provider slot
      if (!merged.apiKey) {
        if (merged.apiBaseUrl.includes('deepseek')) merged.apiKey = cur.apiKeyDeepseek || ''
        else if (merged.apiBaseUrl.includes('anthropic')) merged.apiKey = cur.apiKeyAnthropic || ''
        else if (merged.apiBaseUrl.includes('openai')) merged.apiKey = cur.apiKeyOpenai || ''
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
      set({ settings: merged })
    } catch (e) {
      // server not reachable, keep local defaults
    }
  },

  updateSetting: (key, value) =>
    set((s) => {
      const newSettings = { ...s.settings, [key]: value }
      // When the active apiKey changes, also sync to the matching per-provider slot
      if (key === 'apiKey') {
        const keyStr = String(value)
        if (s.settings.apiBaseUrl.includes('deepseek')) newSettings.apiKeyDeepseek = keyStr
        else if (s.settings.apiBaseUrl.includes('anthropic')) newSettings.apiKeyAnthropic = keyStr
        else if (s.settings.apiBaseUrl.includes('openai')) newSettings.apiKeyOpenai = keyStr
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings))

      // Also sync to the backend server
      // 只把服务端真正会读的两个偏好写回：界面语言（写作语言判定的兜底）
      // 与 HTTP 超时（适配器）。其余外观类偏好只在本地 localStorage 生效，
      // 写进 app_settings 也无人读取，纯属冗余。
      const keyMap: Record<string, string> = {
        apiKey: 'api_key',
        apiBaseUrl: 'api_base_url',
        apiModel: 'api_model',
        apiType: 'api_type',
        uiLanguage: 'ui_language',
        httpTimeout: 'http_timeout',
      }
      const dbKey = keyMap[key]
      if (dbKey) {
        settingsApi.update(dbKey, String(value)).catch(() => {})
      }

      const extra: Partial<SettingsState> = {}
      // When uiLanguage changes, sync the i18n module so t() returns correct locale
      if (key === 'uiLanguage') {
        if (isSupportedLang(value)) setLanguage(value)
        extra.langVersion = s.langVersion + 1
      }
      return { settings: newSettings, ...extra }
    }),

  // ─── AI Provider Profiles ───

  saveProvidersLocal: (providers, activeId) => {
    const s = get()
    const active = providers.find((p) => p.id === activeId) || providers[0]
    const settings = applyActiveToSettings(s.settings, active)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    set({ providers, activeProviderId: activeId, settings })
    providersApi.save(providers, activeId).catch(() => {})
  },

  loadProviders: async () => {
    try {
      const { providers, activeId } = await providersApi.get()
      const active = providers.find((p) => p.id === activeId) || providers[0]
      const settings = applyActiveToSettings(get().settings, active)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
      set({ providers, activeProviderId: activeId, providersLoaded: true, settings })
    } catch {
      // server not reachable — keep empty list
    }
  },

  switchProvider: (id) => {
    get().saveProvidersLocal(get().providers, id)
  },

  updateProvider: (id, patch) => {
    const providers = get().providers.map((p) => (p.id === id ? { ...p, ...patch } : p))
    get().saveProvidersLocal(providers, get().activeProviderId)
  },

  addProvider: () => {
    const id = `p-${Date.now()}`
    const providers: AIProviderProfile[] = [
      ...get().providers,
      {
        id,
        name: `档案 ${get().providers.length + 1}`,
        type: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
        model: 'deepseek-v4-flash',
        contextLimit: 128000,
        maxTokens: 4096,
        targetWords: 0,
      },
    ]
    get().saveProvidersLocal(providers, id)
  },

  deleteProvider: (id) => {
    const cur = get().providers
    if (cur.length <= 1) return // 至少保留一个档案（服务端也拒绝空数组）
    const providers = cur.filter((p) => p.id !== id)
    const activeId = get().activeProviderId === id ? providers[0].id : get().activeProviderId
    get().saveProvidersLocal(providers, activeId)
  },
}))
