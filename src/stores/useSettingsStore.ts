import { create } from 'zustand'
import { setLanguage } from '@/i18n'
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
  backupEnabled: true,
  accentColor: '#c9a96e',
  maxOutputTokens: 8192,
  httpTimeout: 300,
}

const STORAGE_KEY = 'mythpen-settings'

function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
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
    maxOutputTokens: active.maxTokens,
  }
}

// Sync i18n module with persisted language preference
if (initialSettings.uiLanguage !== 'zh') {
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
      const merged = { ...DEFAULT_SETTINGS }
      // Override defaults with server values
      merged.apiKey = serverSettings.api_key ?? ''
      merged.apiBaseUrl = serverSettings.api_base_url || DEFAULT_SETTINGS.apiBaseUrl
      merged.apiModel = serverSettings.api_model || DEFAULT_SETTINGS.apiModel
      // If server has no API key, fall back to current provider's per-provider slot
      if (!merged.apiKey) {
        const cur = get().settings
        if (merged.apiBaseUrl.includes('deepseek')) merged.apiKey = cur.apiKeyDeepseek || ''
        else if (merged.apiBaseUrl.includes('anthropic')) merged.apiKey = cur.apiKeyAnthropic || ''
        else if (merged.apiBaseUrl.includes('openai')) merged.apiKey = cur.apiKeyOpenai || ''
      }
      // Keep UI preferences from local storage
      merged.uiLanguage = get().settings.uiLanguage
      merged.theme = get().settings.theme
      merged.editorFontSize = get().settings.editorFontSize
      merged.editorFontFamily = get().settings.editorFontFamily
      merged.accentColor = get().settings.accentColor
      // Preserve per-provider API keys from local state (server only has one api_key slot)
      merged.apiKeyDeepseek = get().settings.apiKeyDeepseek || DEFAULT_SETTINGS.apiKeyDeepseek
      merged.apiKeyAnthropic = get().settings.apiKeyAnthropic || DEFAULT_SETTINGS.apiKeyAnthropic
      merged.apiKeyOpenai = get().settings.apiKeyOpenai || DEFAULT_SETTINGS.apiKeyOpenai
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
      const keyMap: Record<string, string> = {
        apiKey: 'api_key',
        apiBaseUrl: 'api_base_url',
        apiModel: 'api_model',
        apiType: 'api_type',
        uiLanguage: 'ui_language',
        theme: 'theme',
        editorFontSize: 'editor_font_size',
        editorFontFamily: 'editor_font_family',
        autoSaveInterval: 'auto_save_interval',
        backupEnabled: 'backup_enabled',
        accentColor: 'accent_color',
      }
      const dbKey = keyMap[key]
      if (dbKey) {
        settingsApi.update(dbKey, String(value)).catch(() => {})
      }

      const extra: Partial<SettingsState> = {}
      // When uiLanguage changes, sync the i18n module so t() returns correct locale
      if (key === 'uiLanguage') {
        setLanguage(value as 'zh' | 'en')
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
