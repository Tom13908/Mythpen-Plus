import {
  Bot,
  Eye,
  EyeOff,
  FolderOpen,
  Globe,
  Hash,
  Palette,
  Pen,
  Plus,
  RotateCw,
  SwatchBook,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '@/hooks/useT'
import { LANG_OPTIONS } from '@/i18n'
import { modelsApi, projectSettingsApi, storageApi } from '@/lib/api'
import { refreshAllData } from '@/lib/dataEvents'
import { modelSamplingHint, samplingRange, toppProbeLabel } from '@/lib/sampling'
import { useEditorStore } from '@/stores/useEditorStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import type { AIProviderProfile } from '@/types'

const ACCENT_COLORS = ['#c9a96e', '#e06c75', '#61afef', '#98c379', '#c678dd', '#d4a040', '#56b6c2']

/** 自动保存间隔可选值（秒）。0 由开关负责，不在下拉里出现。 */
const AUTO_SAVE_OPTIONS = [15, 30, 60, 120]

/** Apply accent color to CSS custom property so the UI updates immediately. */
function applyAccentColor(color: string) {
  document.documentElement.style.setProperty('--accent-gold', color)
  // The soft variant: lighten by adjusting transparency
  document.documentElement.style.setProperty('--accent-gold-soft', color + 'cc')
}

/**
 * 已知模型名关键词 → 上下文窗口（tokens）的预设映射。
 * 按数组顺序匹配（更精确/更新的规则放前面），命中第一条即返回。
 */
const MODEL_CONTEXT_PRESETS: Array<{ pattern: RegExp; contextLimit: number }> = [
  { pattern: /deepseek-v4/i, contextLimit: 1_000_000 },
  { pattern: /deepseek-v3\.2/i, contextLimit: 1_000_000 },
  { pattern: /deepseek/i, contextLimit: 128_000 },
  { pattern: /claude-.*(opus|sonnet|haiku)-4/i, contextLimit: 1_000_000 },
  { pattern: /claude-3/i, contextLimit: 200_000 },
  { pattern: /claude/i, contextLimit: 200_000 },
  { pattern: /gpt-4\.1/i, contextLimit: 1_000_000 },
  { pattern: /gpt-5/i, contextLimit: 400_000 },
  { pattern: /gpt-4o/i, contextLimit: 128_000 },
  { pattern: /gpt-4-turbo/i, contextLimit: 128_000 },
  { pattern: /^gpt-4$|gpt-4-\d{4}/i, contextLimit: 8_192 },
  { pattern: /o1|o3|o4/i, contextLimit: 200_000 },
  { pattern: /gemini-.*2\.5/i, contextLimit: 1_000_000 },
  { pattern: /gemini/i, contextLimit: 1_000_000 },
  { pattern: /qwen.*(long|plus|max)/i, contextLimit: 1_000_000 },
  { pattern: /qwen/i, contextLimit: 128_000 },
  { pattern: /glm-4\.6|glm-4\.5/i, contextLimit: 128_000 },
  { pattern: /kimi|moonshot/i, contextLimit: 256_000 },
  { pattern: /grok/i, contextLimit: 128_000 },
  { pattern: /llama-3\.1|llama-3\.2|llama-3\.3/i, contextLimit: 128_000 },
  { pattern: /mistral-large/i, contextLimit: 128_000 },
]

/** 根据模型名猜测对应的上下文窗口大小，未命中任何预设时返回 null。 */
function guessContextLimit(model: string): number | null {
  const name = model.trim()
  if (!name) return null
  for (const preset of MODEL_CONTEXT_PRESETS) {
    if (preset.pattern.test(name)) return preset.contextLimit
  }
  return null
}

export function SettingsDrawer() {
  const { settingsOpen, closeSettings } = useUIStore()
  const {
    settings,
    updateSetting,
    providers,
    activeProviderId,
    providersLoaded,
    loadProviders,
    switchProvider,
    updateProvider,
    addProvider,
    deleteProvider,
  } = useSettingsStore()
  const { t } = useT()
  const [showApiKey, setShowApiKey] = useState(false)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testTime, setTestTime] = useState(0)
  const [testError, setTestError] = useState('')
  const [modelList, setModelList] = useState<string[]>([])
  const [modelsStatus, setModelsStatus] = useState<'idle' | 'fetching' | 'ok' | 'fail'>('idle')
  const [modelsMsg, setModelsMsg] = useState('')
  const [storageInfo, setStorageInfo] = useState<{ currentDir: string; isDefault: boolean } | null>(null)
  const [editingStorage, setEditingStorage] = useState(false)
  const [storagePathInput, setStoragePathInput] = useState('')
  const [migrating, setMigrating] = useState(false)
  const [migrateMsg, setMigrateMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // 章节编号方式是项目级设置，不是全局设置 —— 单独读接口。
  const currentProject = useProjectStore((s) => s.currentProject)
  const [numbering, setNumbering] = useState<'per-volume' | 'global'>('per-volume')

  useEffect(() => {
    if (!settingsOpen || !currentProject) return
    projectSettingsApi
      .getChapterNumbering(currentProject)
      .then((r: any) => setNumbering(r?.mode === 'global' ? 'global' : 'per-volume'))
      .catch(() => {})
  }, [settingsOpen, currentProject])

  const handleNumberingChange = async (mode: 'per-volume' | 'global') => {
    if (!currentProject) return
    const previous = numbering
    setNumbering(mode)
    try {
      await projectSettingsApi.setChapterNumbering(currentProject, mode)
    } catch {
      setNumbering(previous)
    }
  }

  useEffect(() => {
    storageApi
      .get()
      .then(setStorageInfo)
      .catch(() => {})
  }, [])

  const active = providers.find((p) => p.id === activeProviderId) || providers[0]

  // 采样参数：协议范围、模型族提示、探针结果文案
  const range = samplingRange(active?.type)
  const samplingHint = active ? modelSamplingHint(active.model) : ''
  const probeLabel = active ? toppProbeLabel(active.toppSupported) : ''
  // 未设置时滑块显示在协议中点，但档案值保持 undefined（黄金规则：不发送）
  const defaultSliderPos = active?.type === 'claude' ? 0.5 : 1

  useEffect(() => {
    if (!providersLoaded) loadProviders()
  }, [providersLoaded, loadProviders])

  /** 切换模型时，如命中已知模型的上下文窗口预设，则一并自动更新 contextLimit。 */
  const handleModelChange = (model: string) => {
    if (!active) return
    const guessed = guessContextLimit(model)
    if (guessed && guessed !== active.contextLimit) {
      updateProvider(active.id, { model, contextLimit: guessed })
    } else {
      updateProvider(active.id, { model })
    }
  }

  const handleFetchModels = async () => {
    if (!active) return
    setModelsStatus('fetching')
    setModelsMsg('')
    try {
      const { models } = await modelsApi.list(active.baseUrl, active.apiKey, active.type)
      setModelList(models)
      setModelsStatus('ok')
      setModelsMsg(t('settings.modelsFetched', { count: models.length }))
    } catch (err: any) {
      setModelsStatus('fail')
      setModelsMsg(err.message || 'Network error')
    }
  }

  const handleTestConnection = async () => {
    setTestStatus('testing')
    setTestError('')
    const start = Date.now()
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: t('settings.testMessage') }],
          temperature: 0,
          max_tokens: 10,
          apiKey: settings.apiKey,
          apiBaseUrl: settings.apiBaseUrl,
          apiModel: settings.apiModel,
          apiType: settings.apiType,
        }),
      })
      const ms = Date.now() - start
      setTestTime(ms)
      if (res.ok) {
        setTestStatus('ok')
        // 探针：测试连接成功后实测供应商对 top_p 的支持（结果写入档案供 UI 提示）
        runProbe()
      } else {
        setTestStatus('fail')
        try {
          const body = await res.json()
          // detail 里是上游原始报错（如 Google 503 的容量说明），失败时一并展示
          setTestError(body.detail ? `${body.error}\n${body.detail}` : body.error || `HTTP ${res.status}`)
        } catch {
          setTestError(`HTTP ${res.status}`)
        }
      }
    } catch (err: any) {
      setTestTime(Date.now() - start)
      setTestStatus('fail')
      setTestError(err.message || 'Network error')
    }
  }

  /** 探针：实测当前档案供应商是否接受 top_p（结果写入 toppSupported）。 */
  const runProbe = async () => {
    if (!active) return
    try {
      const { request } = await import('@/lib/api')
      const result = await request('/ai/probe-sampling', {
        method: 'POST',
        body: {
          baseUrl: active.baseUrl,
          apiKey: active.apiKey,
          model: active.model,
          type: active.type,
        },
      })
      if (result.toppSupported !== null) {
        // 实测不支持时同时清掉已保存的值：否则输入框虽然禁用，
        // 旧值仍会随请求发出去，照样 400。
        updateProvider(
          active.id,
          result.toppSupported === false
            ? { toppSupported: false, topP: undefined }
            : { toppSupported: result.toppSupported },
        )
      }
    } catch {
      // 探针失败不影响测试连接结果，静默保留"未探测"状态
    }
  }

  if (!settingsOpen) return null

  const handleAccentChange = (color: string) => {
    updateSetting('accentColor', color)
    applyAccentColor(color)
  }

  const handleFontSizeChange = (size: number) => {
    const clamped = Math.max(14, Math.min(24, size))
    updateSetting('editorFontSize', clamped)
    useEditorStore.getState().setFontSize(clamped)
  }

  const handleFontFamilyChange = (family: string) => {
    updateSetting('editorFontFamily', family)
    useEditorStore.getState().setFontFamily(family)
  }

  const startEditStorage = () => {
    setStoragePathInput(storageInfo?.currentDir || '')
    setMigrateMsg(null)
    setEditingStorage(true)
  }

  const cancelEditStorage = () => {
    setEditingStorage(false)
    setMigrateMsg(null)
  }

  const handleMigrateStorage = async () => {
    const target = storagePathInput.trim()
    if (!target) return
    setMigrating(true)
    setMigrateMsg(null)
    try {
      const result = await storageApi.migrate(target)
      setStorageInfo({ currentDir: result.newDir, isDefault: false })
      setEditingStorage(false)
      setMigrateMsg({ type: 'success', text: t('settings.storageMigrateSuccess', { oldDir: result.oldDir }) })
    } catch (err: any) {
      setMigrateMsg({ type: 'error', text: err.message || t('settings.storageMigrateFailed') })
    }
    setMigrating(false)
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-[200]" onClick={closeSettings} />
      <div className="fixed top-0 right-0 bottom-0 w-[380px] bg-[var(--canvas-card)] border-l border-[var(--hairline-light)] z-[210] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--hairline)] shrink-0">
          <h2 className="font-display text-[22px] font-medium text-[var(--ink)]">{t('settings.title')}</h2>
          <button
            className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-none text-[var(--ink-tertiary)] text-xl cursor-pointer hover:bg-[var(--canvas-mid)] hover:text-[var(--ink)] transition-colors"
            onClick={closeSettings}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 custom-scrollbar">
          {/* ── UI Language ── */}
          <div className="mb-7 mt-5">
            <div className="text-[11px] font-medium text-[var(--ink-mute)] tracking-[0.06em] uppercase mb-3">
              <Globe className="w-3.5 h-3.5 inline-block mr-1" /> {t('settings.uiLanguage')}
            </div>
            <SettingRow label={t('settings.uiLanguage')} desc={t('settings.uiLanguageDesc')}>
              <select
                className="h-[32px] px-2 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[13px] outline-none cursor-pointer focus:border-[var(--accent-gold)]"
                value={settings.uiLanguage}
                onChange={(e) => updateSetting('uiLanguage', e.target.value)}
              >
                {LANG_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </SettingRow>
          </div>

          {/* ── Storage location ── */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-[var(--ink-mute)] tracking-[0.06em] uppercase mb-3">
              <FolderOpen className="w-3.5 h-3.5 inline-block mr-1" /> {t('settings.storageLocation')}
            </div>
            <div className="py-2.5 border-t border-[var(--hairline)]">
              <div className="text-[13px] text-[var(--ink)] mb-1">{t('settings.storageLocation')}</div>
              <div className="text-[12px] text-[var(--ink-tertiary)] mb-2.5">{t('settings.storageLocationDesc')}</div>
              <div className="flex flex-col gap-2 items-stretch w-full">
                {!editingStorage ? (
                  <div className="flex items-center gap-2">
                    <span
                      className="flex-1 text-[12px] text-[var(--ink-secondary)] truncate"
                      title={storageInfo?.currentDir}
                    >
                      {storageInfo?.currentDir || '…'}
                    </span>
                    <button
                      className="px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--hairline)] text-[12px] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] cursor-pointer hover:bg-[var(--canvas-mid)] transition-colors shrink-0"
                      onClick={startEditStorage}
                    >
                      {t('settings.storageChange')}
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <input
                      className="form-input h-[28px] text-[12px]"
                      value={storagePathInput}
                      onChange={(e) => setStoragePathInput(e.target.value)}
                      placeholder={t('settings.storagePathPlaceholder')}
                      autoFocus
                      disabled={migrating}
                    />
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        className="px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--hairline)] text-[12px] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] cursor-pointer hover:bg-[var(--canvas-mid)] transition-colors"
                        onClick={cancelEditStorage}
                        disabled={migrating}
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        className="px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--accent-gold)] text-[12px] bg-[var(--accent-gold)] text-[var(--canvas)] font-medium cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50"
                        onClick={handleMigrateStorage}
                        disabled={migrating || !storagePathInput.trim()}
                      >
                        {migrating ? t('settings.storageMigrating') : t('settings.storageConfirm')}
                      </button>
                    </div>
                    <p className="text-[11px] text-[var(--ink-tertiary)] leading-relaxed">
                      {t('settings.storageRestartHint')}
                    </p>
                  </div>
                )}
                {migrateMsg && (
                  <p
                    className={`text-[11px] leading-relaxed ${migrateMsg.type === 'success' ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}
                  >
                    {migrateMsg.text}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* ── Chapter numbering（项目级） ── */}
          {currentProject && (
            <div className="mb-7">
              <div className="text-[11px] font-medium text-[var(--ink-mute)] tracking-[0.06em] uppercase mb-3">
                <Hash className="w-3.5 h-3.5 inline-block mr-1" /> {t('settings.chapterNumbering')}
              </div>
              <SettingRow label={t('settings.chapterNumbering')} desc={t('settings.chapterNumberingDesc')}>
                <select
                  className="h-[32px] px-2 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[13px] outline-none cursor-pointer focus:border-[var(--accent-gold)]"
                  value={numbering}
                  onChange={(e) => handleNumberingChange(e.target.value as 'per-volume' | 'global')}
                >
                  <option value="per-volume">{t('settings.chapterNumberingPerVolume')}</option>
                  <option value="global">{t('settings.chapterNumberingGlobal')}</option>
                </select>
              </SettingRow>
            </div>
          )}

          {/* ── Theme ── */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-[var(--ink-mute)] tracking-[0.06em] uppercase mb-3">
              <Palette className="w-3.5 h-3.5 inline-block mr-1" /> {t('settings.theme')}
            </div>
            <div className="flex gap-3">
              {(['dark', 'light'] as const).map((themeVal) => (
                <div
                  key={themeVal}
                  className="text-center cursor-pointer"
                  onClick={() => {
                    updateSetting('theme', themeVal)
                    document.documentElement.setAttribute('data-theme', themeVal)
                  }}
                >
                  <div
                    className={`w-9 h-9 rounded-[var(--radius-sm)] border-2 transition-colors
                      ${settings.theme === themeVal ? 'border-[var(--accent-gold)]' : 'border-[var(--hairline)] hover:border-[var(--ink-mute)]'}`}
                    style={{ background: themeVal === 'dark' ? '#0e0e10' : '#f5f0e8' }}
                  />
                  <div className="text-[11px] text-[var(--ink-tertiary)] mt-1">
                    {themeVal === 'dark' ? t('settings.dark') : t('settings.light')}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Editor ── */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-[var(--ink-mute)] tracking-[0.06em] uppercase mb-3">
              <Pen className="w-3.5 h-3.5 inline-block mr-1" /> {t('settings.editor')}
            </div>
            <SettingRow label={t('settings.fontSize')} desc={t('settings.fontSizeDesc')}>
              <div className="flex items-center gap-2">
                <button
                  className="px-2.5 py-[3px] rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] text-[13px] cursor-pointer hover:bg-[var(--canvas-mid)]"
                  onClick={() => handleFontSizeChange(settings.editorFontSize - 1)}
                >
                  −
                </button>
                <input
                  type="number"
                  className="w-[60px] h-[30px] text-center bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[13px] outline-none focus:border-[var(--accent-gold)]"
                  value={settings.editorFontSize}
                  min={14}
                  max={24}
                  onChange={(e) => handleFontSizeChange(parseInt(e.target.value) || 17)}
                />
                <button
                  className="px-2.5 py-[3px] rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] text-[13px] cursor-pointer hover:bg-[var(--canvas-mid)]"
                  onClick={() => handleFontSizeChange(settings.editorFontSize + 1)}
                >
                  +
                </button>
                <span className="text-[11px] text-[var(--ink-mute)]">px</span>
              </div>
            </SettingRow>
            <SettingRow
              label={t('settings.autoSave')}
              desc={
                settings.autoSaveInterval > 0
                  ? t('settings.autoSaveEnabled', { seconds: settings.autoSaveInterval })
                  : t('settings.autoSaveDisabled')
              }
            >
              <div className="flex items-center gap-2 shrink-0">
                {settings.autoSaveInterval > 0 && (
                  <select
                    className="h-[30px] px-2 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[13px] outline-none cursor-pointer focus:border-[var(--accent-gold)]"
                    value={settings.autoSaveInterval}
                    onChange={(e) => updateSetting('autoSaveInterval', parseInt(e.target.value, 10))}
                  >
                    {AUTO_SAVE_OPTIONS.map((sec) => (
                      <option key={sec} value={sec}>
                        {t('settings.autoSaveSeconds', { seconds: sec })}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className={`w-9 h-5 rounded-full border-none cursor-pointer relative transition-colors shrink-0
                  ${settings.autoSaveInterval > 0 ? 'bg-[var(--accent-gold)]' : 'bg-[var(--canvas-mid)]'}`}
                  onClick={() => updateSetting('autoSaveInterval', settings.autoSaveInterval > 0 ? 0 : 30)}
                >
                  <span
                    className={`absolute top-[2px] left-[2px] w-4 h-4 rounded-full bg-[var(--ink)] transition-transform ${settings.autoSaveInterval > 0 ? 'translate-x-4' : ''}`}
                  />
                </button>
              </div>
            </SettingRow>
            <SettingRow label={t('settings.fontFamily')}>
              <select
                className="h-[30px] px-2.5 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[13px] outline-none cursor-pointer focus:border-[var(--accent-gold)]"
                value={settings.editorFontFamily}
                onChange={(e) => handleFontFamilyChange(e.target.value)}
              >
                <option value="'Noto Serif SC', 'Source Han Serif SC', serif">思源宋体</option>
                <option value="'Noto Sans SC', 'Source Han Sans SC', sans-serif">思源黑体</option>
                <option value="Georgia, 'Noto Serif SC', serif">Georgia</option>
              </select>
            </SettingRow>
            <SettingRow label={t('settings.showThinking')} desc={t('settings.showThinkingDesc')}>
              <button
                className={`w-9 h-5 rounded-full border-none cursor-pointer relative transition-colors shrink-0
                  ${settings.showThinking ? 'bg-[var(--accent-gold)]' : 'bg-[var(--canvas-mid)]'}`}
                onClick={() => updateSetting('showThinking', !settings.showThinking)}
              >
                <span
                  className={`absolute top-[2px] left-[2px] w-4 h-4 rounded-full bg-[var(--ink)] transition-transform ${settings.showThinking ? 'translate-x-4' : ''}`}
                />
              </button>
            </SettingRow>
            {/* ─── 思维链语言（软控制，写入 system prompt）─── */}
            {active && (
              <SettingRow label={t('settings.reasoningLang')} desc={t('settings.reasoningLangDesc')}>
                <div className="flex gap-2 shrink-0">
                  <button
                    className={`px-[12px] h-[28px] rounded-full border-none font-sans text-[12px] cursor-pointer transition-all ${
                      active.reasoningLang !== 'writing'
                        ? 'bg-[var(--accent-gold)] text-[var(--canvas)] font-medium'
                        : 'bg-[var(--canvas-mid)] text-[var(--ink-secondary)] hover:bg-[var(--canvas-pop)]'
                    }`}
                    onClick={() => updateProvider(active.id, { reasoningLang: 'default' })}
                  >
                    {t('settings.reasoningLangDefault')}
                  </button>
                  <button
                    className={`px-[12px] h-[28px] rounded-full border-none font-sans text-[12px] cursor-pointer transition-all ${
                      active.reasoningLang === 'writing'
                        ? 'bg-[var(--accent-gold)] text-[var(--canvas)] font-medium'
                        : 'bg-[var(--canvas-mid)] text-[var(--ink-secondary)] hover:bg-[var(--canvas-pop)]'
                    }`}
                    onClick={() => updateProvider(active.id, { reasoningLang: 'writing' })}
                  >
                    {t('settings.reasoningLangWriting')}
                  </button>
                </div>
              </SettingRow>
            )}
          </div>

          {/* ── Accent Color ── */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-[var(--ink-mute)] tracking-[0.06em] uppercase mb-3">
              <SwatchBook className="w-3.5 h-3.5 inline-block mr-1" /> {t('settings.accentColor')}
            </div>
            <div className="flex gap-2 flex-wrap mb-2">
              {ACCENT_COLORS.map((c) => (
                <div
                  key={c}
                  className={`w-[30px] h-[30px] rounded-full border-2 cursor-pointer transition-all hover:scale-110 shrink-0
                    ${settings.accentColor === c ? 'border-[var(--ink)] shadow-[0_0_0_1px_var(--canvas)]' : 'border-transparent'}`}
                  style={{ background: c }}
                  onClick={() => handleAccentChange(c)}
                />
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-[var(--ink-mute)]">{t('settings.customColor')}</span>
              <input
                type="color"
                className="w-8 h-7 p-0 border border-[var(--hairline)] rounded-[var(--radius-sm)] bg-none cursor-pointer"
                value={settings.accentColor}
                onChange={(e) => handleAccentChange(e.target.value)}
              />
            </div>
          </div>

          {/* ── AI Service ── */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-[var(--ink-mute)] tracking-[0.06em] uppercase mb-3">
              <Bot className="w-3.5 h-3.5 inline-block mr-1" /> {t('settings.aiService')}
            </div>
            <SettingRow label={t('settings.providerProfile')} desc={t('settings.providerProfileDesc')}>
              <div className="flex gap-1 items-center">
                <select
                  className="h-[30px] px-2.5 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[13px] outline-none cursor-pointer focus:border-[var(--accent-gold)] w-[120px]"
                  value={activeProviderId}
                  onChange={(e) => switchProvider(e.target.value)}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] text-[15px] cursor-pointer hover:bg-[var(--canvas-mid)] shrink-0"
                  onClick={addProvider}
                  title={t('settings.addProvider')}
                >
                  +
                </button>
                <button
                  className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] text-[14px] cursor-pointer hover:bg-[var(--canvas-mid)] disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  onClick={() => active && deleteProvider(active.id)}
                  disabled={providers.length <= 1}
                  title={t('settings.deleteProvider')}
                >
                  ×
                </button>
              </div>
            </SettingRow>
            {active && (
              <>
                <SettingRow label={t('settings.providerName')}>
                  <input
                    type="text"
                    className="h-[30px] px-2 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[12px] outline-none focus:border-[var(--accent-gold)] w-[160px]"
                    value={active.name}
                    onChange={(e) => updateProvider(active.id, { name: e.target.value })}
                  />
                </SettingRow>
                <SettingRow label={t('settings.apiType')} desc={t('settings.apiTypeDesc')}>
                  <select
                    className="h-[30px] px-2.5 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[13px] outline-none cursor-pointer focus:border-[var(--accent-gold)] w-[150px]"
                    value={active.type}
                    onChange={(e) => updateProvider(active.id, { type: e.target.value as AIProviderProfile['type'] })}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="openai-response">OpenAI Responses</option>
                    <option value="claude">Anthropic</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </SettingRow>
                <SettingRow label={t('settings.apiBaseUrl')}>
                  <input
                    type="url"
                    className="h-[30px] px-2 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[12px] font-mono outline-none focus:border-[var(--accent-gold)] w-[200px]"
                    value={active.baseUrl}
                    onChange={(e) => updateProvider(active.id, { baseUrl: e.target.value })}
                    placeholder="https://api.deepseek.com/v1"
                  />
                </SettingRow>
                <SettingRow label={t('settings.apiKey')}>
                  <div className="flex gap-1 items-center">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      className="h-[30px] px-2 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[12px] font-mono outline-none focus:border-[var(--accent-gold)] w-[180px]"
                      value={active.apiKey}
                      onChange={(e) => updateProvider(active.id, { apiKey: e.target.value })}
                    />
                    <button
                      className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-none text-[var(--ink-tertiary)] cursor-pointer hover:text-[var(--ink)] transition-colors shrink-0"
                      onClick={() => setShowApiKey(!showApiKey)}
                      title={showApiKey ? t('settings.hideKey') : t('settings.showKey')}
                    >
                      {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </SettingRow>
                <SettingRow label={t('settings.model')} desc={t('settings.modelDesc')}>
                  <div className="flex gap-1 items-center">
                    <input
                      type="text"
                      className="h-[30px] px-2 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[12px] font-mono outline-none focus:border-[var(--accent-gold)] w-[160px]"
                      value={active.model}
                      onChange={(e) => handleModelChange(e.target.value)}
                      placeholder="deepseek-v4-flash"
                    />
                    <button
                      className="h-[30px] px-2 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] text-[12px] cursor-pointer hover:bg-[var(--canvas-mid)] disabled:opacity-50 shrink-0 whitespace-nowrap"
                      onClick={handleFetchModels}
                      disabled={modelsStatus === 'fetching'}
                      title={t('settings.fetchModels')}
                    >
                      {modelsStatus === 'fetching' ? '…' : '⟳'}
                    </button>
                  </div>
                </SettingRow>
                {modelList.length > 0 && (
                  <SettingRow
                    label={t('settings.pickModel')}
                    desc={t('settings.modelsFetched', { count: modelList.length })}
                  >
                    <select
                      className="h-[30px] px-2 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[12px] font-mono outline-none cursor-pointer focus:border-[var(--accent-gold)] w-[200px]"
                      value={active.model}
                      onChange={(e) => handleModelChange(e.target.value)}
                    >
                      {modelList.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      {active.model && !modelList.includes(active.model) && (
                        <option value={active.model}>{active.model}</option>
                      )}
                    </select>
                  </SettingRow>
                )}
                {modelsStatus === 'ok' && (
                  <div className="text-[11px] text-[var(--success)] border-t border-[var(--hairline)] pt-1.5">
                    {modelsMsg}
                  </div>
                )}
                {modelsStatus === 'fail' && (
                  <div className="text-[11px] text-[var(--error)] border-t border-[var(--hairline)] pt-1.5">
                    {t('settings.fetchModelsFailed')}：{modelsMsg}
                  </div>
                )}
                <SettingRow label={t('settings.contextLimit')} desc={t('settings.contextLimitDesc')}>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      className="h-[30px] px-2 w-[100px] text-right bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[12px] outline-none focus:border-[var(--accent-gold)]"
                      value={active.contextLimit}
                      min={4096}
                      step={1000}
                      onChange={(e) => updateProvider(active.id, { contextLimit: parseInt(e.target.value) || 0 })}
                    />
                    <span className="text-[11px] text-[var(--ink-mute)]">tokens</span>
                  </div>
                </SettingRow>
                <SettingRow label={t('settings.maxTokens')} desc={t('settings.maxTokensDesc')}>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      className="h-[30px] px-2 w-[100px] text-right bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[12px] outline-none focus:border-[var(--accent-gold)]"
                      value={active.maxTokens}
                      min={256}
                      step={256}
                      onChange={(e) => updateProvider(active.id, { maxTokens: parseInt(e.target.value) || 0 })}
                    />
                    <span className="text-[11px] text-[var(--ink-mute)]">tokens</span>
                  </div>
                </SettingRow>
                <SettingRow label={t('settings.httpTimeout')} desc={t('settings.httpTimeoutDesc')}>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      className="h-[30px] px-2 w-[100px] text-right bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[12px] outline-none focus:border-[var(--accent-gold)]"
                      value={settings.httpTimeout || ''}
                      min={0}
                      step={10}
                      placeholder="300"
                      onChange={(e) => updateSetting('httpTimeout', parseInt(e.target.value) || 0)}
                    />
                    <span className="text-[11px] text-[var(--ink-mute)]">s</span>
                  </div>
                </SettingRow>
                <SettingRow label={t('settings.targetWordsPerChapter')} desc={t('settings.targetWordsPerChapterDesc')}>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      className="h-[30px] px-2 w-[100px] text-right bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[12px] outline-none focus:border-[var(--accent-gold)]"
                      value={active.targetWords || ''}
                      min={0}
                      step={500}
                      placeholder="0 = 自动"
                      onChange={(e) => {
                        const v = parseInt(e.target.value) || 0
                        if (v > 0) {
                          // 联动：每章理想字数 → 自动把生成上限设为 字数×1.5 + 余量
                          const autoMax = Math.max(1024, Math.round(v * 1.5 + 512))
                          updateProvider(active.id, { targetWords: v, maxTokens: autoMax })
                        } else {
                          updateProvider(active.id, { targetWords: 0 })
                        }
                      }}
                    />
                    <span className="text-[11px] text-[var(--ink-mute)]">字/章</span>
                  </div>
                </SettingRow>
                {/* ─── 采样参数（temperature / top_p）─── */}
                <SettingRow
                  label={t('settings.temperature')}
                  desc={samplingHint ? samplingHint : t('settings.temperatureDesc', { max: range.temperatureMax })}
                >
                  <div className="flex items-center gap-1.5">
                    <input
                      type="range"
                      className="w-[110px] accent-[var(--accent-gold)]"
                      min={0}
                      max={range.temperatureMax}
                      step={0.05}
                      value={active.temperature ?? defaultSliderPos}
                      onChange={(e) => updateProvider(active.id, { temperature: parseFloat(e.target.value) })}
                    />
                    <span className="text-[12px] text-[var(--ink)] font-mono w-[34px] text-right">
                      {active.temperature !== undefined ? active.temperature.toFixed(2) : t('settings.samplingDefault')}
                    </span>
                    {active.temperature !== undefined && (
                      <button
                        className="w-5 h-5 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-none text-[var(--ink-tertiary)] cursor-pointer hover:text-[var(--ink)] transition-colors shrink-0 text-[13px] leading-none"
                        onClick={() => updateProvider(active.id, { temperature: undefined })}
                        title={t('settings.samplingClear')}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </SettingRow>
                <SettingRow
                  label={t('settings.topP')}
                  desc={
                    active.toppSupported === false
                      ? t('settings.topPUnsupported')
                      : t('settings.topPDesc') + (probeLabel ? `（${probeLabel}）` : '')
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <input
                      type="range"
                      className="w-[110px] accent-[var(--accent-gold)] disabled:opacity-40"
                      min={0}
                      max={1}
                      step={0.01}
                      disabled={active.toppSupported === false}
                      value={active.topP ?? defaultSliderPos}
                      onChange={(e) => updateProvider(active.id, { topP: parseFloat(e.target.value) })}
                    />
                    <span className="text-[12px] text-[var(--ink)] font-mono w-[34px] text-right">
                      {active.topP !== undefined ? active.topP.toFixed(2) : t('settings.samplingDefault')}
                    </span>
                    {active.topP !== undefined && (
                      <button
                        className="w-5 h-5 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-none text-[var(--ink-tertiary)] cursor-pointer hover:text-[var(--ink)] transition-colors shrink-0 text-[13px] leading-none"
                        onClick={() => updateProvider(active.id, { topP: undefined })}
                        title={t('settings.samplingClear')}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </SettingRow>
              </>
            )}
            <div className="pt-2.5 flex flex-col gap-1.5">
              <div className="flex items-center gap-2.5">
                <button
                  className="h-[30px] px-4 rounded-lg border border-[var(--hairline-light)] bg-[var(--canvas-elevated)] text-[var(--ink)] text-[13px] cursor-pointer transition-colors hover:bg-[var(--canvas-mid)] disabled:opacity-50 flex items-center gap-1.5"
                  onClick={handleTestConnection}
                  disabled={testStatus === 'testing'}
                >
                  <Zap className="w-3.5 h-3.5" />
                  {testStatus === 'testing' ? t('settings.testing') : t('settings.testConnection')}
                </button>
                <a
                  href={
                    settings.apiType === 'claude'
                      ? 'https://console.anthropic.com/'
                      : settings.apiType === 'gemini'
                        ? 'https://aistudio.google.com/app/apikey'
                        : settings.apiBaseUrl.includes('openai')
                          ? 'https://platform.openai.com/api-keys'
                          : 'https://platform.deepseek.com/api_keys'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto text-[12px] text-[var(--accent-gold)] no-underline hover:underline"
                >
                  {t('settings.getApiKey')}
                </a>
              </div>
              {testStatus === 'ok' && (
                <span className="text-[12px] text-[var(--success)] pl-1">
                  {t('settings.connectionSuccess', { time: testTime })}
                </span>
              )}
              {testStatus === 'fail' && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-[12px] text-[var(--error)] pl-1">{t('settings.connectionFailed')}</span>
                  {testError && <span className="text-[11px] text-[var(--ink-mute)] pl-1">{testError}</span>}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-[var(--hairline)] flex items-center shrink-0 gap-2">
          <button
            className="w-6 h-6 flex items-center justify-center rounded-[var(--radius-sm)] border-none text-[var(--ink-mute)] cursor-pointer hover:text-[var(--accent-ember)] hover:bg-[var(--canvas-mid)] transition-colors shrink-0"
            onClick={() => refreshAllData()}
            title={t('settings.forceRefreshDesc')}
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <span className="text-[11px] text-[var(--ink-mute)] flex-1">{t('settings.footer')}</span>
          <button
            className="h-[34px] px-5 rounded-lg border-none bg-[var(--accent-gold)] text-[var(--canvas)] font-medium text-[13px] cursor-pointer transition-colors hover:bg-[var(--accent-gold-soft)]"
            onClick={closeSettings}
          >
            {t('settings.done')}
          </button>
        </div>
      </div>
    </>
  )
}

function SettingRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-t border-[var(--hairline)] first:border-t-0">
      <div className="flex-1">
        <div className="text-[13px] text-[var(--ink)]">{label}</div>
        {desc && <div className="text-[12px] text-[var(--ink-tertiary)] mt-0.5">{desc}</div>}
      </div>
      {children}
    </div>
  )
}
