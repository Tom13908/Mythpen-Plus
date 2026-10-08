import { useEffect, useState } from 'react'
import { useT } from '@/hooks/useT'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'

// 项目名会拼进后端的文件路径（<PROJECTS_DIR>/<name>.mythpen.db），含路径分隔符的名称
// 会让落盘目标指向不存在的子目录。后端同样会挡（400 INVALID_PROJECT_NAME），这里提前
// 提示，省掉一次注定失败的往返。
const INVALID_NAME_CHARS = /[\\/:*?"<>|]/
const NAME_MAX_LEN = 100

function projectNameError(
  name: string,
  t: (path: string, params?: Record<string, string | number>) => string,
): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  if (trimmed.length > NAME_MAX_LEN) return t('project.nameTooLong', { max: NAME_MAX_LEN })
  if (/^\.+$/.test(trimmed)) return t('project.nameReserved')
  const hit = trimmed.match(new RegExp(INVALID_NAME_CHARS.source, 'g'))
  if (hit) return t('project.nameInvalid', { chars: [...new Set(hit)].join(' ') })
  return null
}

export function NewProjectDialog() {
  const { projectDialogOpen, setProjectDialogOpen } = useUIStore()
  const { createProject, loading, error } = useProjectStore()
  const { t } = useT()
  const [name, setName] = useState('')
  const [styleInput, setStyleInput] = useState('')

  // Clear stale error when dialog opens
  useEffect(() => {
    if (projectDialogOpen) {
      useProjectStore.setState({ error: null })
    }
  }, [projectDialogOpen])

  if (!projectDialogOpen) return null

  // 每次渲染重新计算：语言切换时提示文案要跟着变
  const nameError = projectNameError(name, t)

  // 风格关键词解析：顿号/逗号/分号/空格分隔，去重去空
  const parseStyleKeywords = (input: string): string[] => {
    return [
      ...new Set(
        input
          .split(/[、，,;；\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ]
  }

  const handleCreate = async () => {
    if (!name.trim() || nameError) return
    try {
      await createProject(name.trim(), { mode: 'medium-novel', genres: parseStyleKeywords(styleInput) })
      setProjectDialogOpen(false)
    } catch {
      // error is already set in store → displayed in UI
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100]"
      onClick={() => setProjectDialogOpen(false)}
    >
      <div
        className="bg-[var(--canvas-card)] border border-[var(--hairline-light)] rounded-xl p-8 w-[520px] max-w-[90vw] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-[28px] font-semibold leading-[1.3] mb-1">{t('project.new')}</h2>
        <p className="text-[var(--ink-tertiary)] text-[13px] mb-6">{t('project.subtitle')}</p>

        {/* Error message */}
        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-[13px] text-red-500">
            {error}
          </div>
        )}

        <div className="mb-5">
          <label className="block text-[11px] font-medium text-[var(--ink-secondary)] tracking-[0.04em] uppercase mb-1.5">
            {t('project.nameLabel')}
          </label>
          <input
            type="text"
            className={
              nameError
                ? 'w-full h-9 bg-[var(--canvas-elevated)] border border-red-500/50 rounded-lg px-3 font-sans text-[15px] text-[var(--ink)] outline-none transition-colors focus:border-red-500 focus:shadow-[0_0_0_2px_rgba(239,68,68,0.2)]'
                : 'w-full h-9 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-lg px-3 font-sans text-[15px] text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-gold)] focus:shadow-[0_0_0_2px_rgba(201,169,110,0.2)]'
            }
            placeholder={t('project.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {nameError && <p className="text-[12px] text-red-500 mt-1.5">{nameError}</p>}
        </div>

        <div className="mb-5">
          <label className="block text-[11px] font-medium text-[var(--ink-secondary)] tracking-[0.04em] uppercase mb-1.5">
            {t('project.styleLabel')}
          </label>
          <input
            type="text"
            className="w-full h-9 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-lg px-3 font-sans text-[15px] text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-gold)] focus:shadow-[0_0_0_2px_rgba(201,169,110,0.2)]"
            placeholder={t('project.stylePlaceholder')}
            value={styleInput}
            onChange={(e) => setStyleInput(e.target.value)}
          />
          <p className="text-[12px] text-[var(--ink-tertiary)] mt-1.5">{t('project.styleHint')}</p>
        </div>

        <div className="flex gap-2 justify-end mt-6 pt-4 border-t border-[var(--hairline)]">
          <button
            className="h-[34px] px-5 rounded-lg border border-[var(--hairline-light)] bg-[var(--canvas-elevated)] text-[var(--ink)] text-[13px] cursor-pointer transition-colors hover:bg-[var(--canvas-mid)]"
            onClick={() => setProjectDialogOpen(false)}
          >
            {t('project.cancel')}
          </button>
          <button
            className="h-[34px] px-5 rounded-lg border-none bg-[var(--accent-gold)] text-[var(--canvas)] font-medium text-[13px] cursor-pointer transition-colors hover:bg-[var(--accent-gold-soft)] disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleCreate}
            disabled={loading || !name.trim() || !!nameError}
          >
            {loading ? t('project.creating') : t('project.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
