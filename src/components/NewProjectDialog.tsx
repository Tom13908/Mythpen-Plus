import { useEffect, useState } from 'react'
import { ImportBookPanel } from '@/components/ImportBookPanel'
import { useT } from '@/hooks/useT'
import { isEpubFile, readFileBase64, readTextFile } from '@/lib/importFile'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'

// 项目名只作显示名：库文件按 UUID 落盘（见后端 db.allocateProjectFilePath），封面与
// 快照目录会自动转义。所以 `?`、`/`、`:` 这些字符不再拦截。只挡控制字符与超长名称。
const NAME_MAX_LEN = 200
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function projectNameError(
  name: string,
  t: (path: string, params?: Record<string, string | number>) => string,
): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  if (trimmed.length > NAME_MAX_LEN) return t('project.nameTooLong', { max: NAME_MAX_LEN })
  if (/^\.+$/.test(trimmed)) return t('project.nameReserved')
  if (CONTROL_CHARS.test(trimmed)) return t('project.nameControlChars')
  return null
}

/** 风格关键词解析：顿号/逗号/分号/空格分隔，去重去空 */
function parseStyleKeywords(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[、，,;；\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]
}

type Tab = 'blank' | 'import'

export function NewProjectDialog() {
  const { projectDialogOpen, setProjectDialogOpen } = useUIStore()
  const { createProject, importProject, loading, error } = useProjectStore()
  const { t } = useT()
  const [tab, setTab] = useState<Tab>('blank')
  const [name, setName] = useState('')
  const [styleInput, setStyleInput] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  // Clear stale error when dialog opens
  useEffect(() => {
    if (projectDialogOpen) {
      useProjectStore.setState({ error: null })
      setImportError(null)
    }
  }, [projectDialogOpen])

  if (!projectDialogOpen) return null

  // 每次渲染重新计算：语言切换时提示文案要跟着变
  const nameError = projectNameError(name, t)

  const pickFile = (selected: File | null) => {
    setFile(selected)
    setImportError(null)
    // 名称还空着就用文件名（去掉扩展名）做默认，省一次手打
    if (selected && !name.trim()) {
      setName(selected.name.replace(/\.(txt|epub)$/i, '').slice(0, NAME_MAX_LEN))
    }
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

  const handleImport = async () => {
    if (!file || !name.trim() || nameError) return
    setImporting(true)
    setImportError(null)
    try {
      const genres = parseStyleKeywords(styleInput)
      const payload = isEpubFile(file)
        ? {
            name: name.trim(),
            format: 'epub' as const,
            fileBase64: await readFileBase64(file),
            fileName: file.name,
            genres,
          }
        : {
            name: name.trim(),
            format: 'txt' as const,
            text: (await readTextFile(file)).text,
            fileName: file.name,
            genres,
          }
      await importProject(payload)
      setProjectDialogOpen(false)
      setFile(null)
      setName('')
      setStyleInput('')
    } catch (e: any) {
      setImportError(e?.message || t('import.failed'))
    } finally {
      setImporting(false)
    }
  }

  const busy = loading || importing
  const primaryDisabled = busy || !name.trim() || !!nameError || (tab === 'import' && !file)
  const shownError = importError || error

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
        <p className="text-[var(--ink-tertiary)] text-[13px] mb-4">{t('project.subtitle')}</p>

        {/* 两个入口：从零开始 / 导入旧稿 */}
        <div className="mb-5 flex gap-1 rounded-lg bg-[var(--canvas-elevated)] p-1">
          {(['blank', 'import'] as Tab[]).map((key) => (
            <button
              key={key}
              className={`flex-1 h-[30px] rounded-md border-none text-[12.5px] cursor-pointer transition-colors ${
                tab === key
                  ? 'bg-[var(--canvas-card)] text-[var(--ink)] shadow-sm'
                  : 'bg-transparent text-[var(--ink-tertiary)] hover:text-[var(--ink-secondary)]'
              }`}
              onClick={() => setTab(key)}
              disabled={busy}
            >
              {key === 'blank' ? t('import.tabBlank') : t('import.tabImport')}
            </button>
          ))}
        </div>

        {/* Error message */}
        {shownError && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-[13px] text-red-500">
            {shownError}
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

        {tab === 'blank' ? (
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
        ) : (
          <div className="mb-5">
            <ImportBookPanel file={file} onFile={pickFile} disabled={importing} />
          </div>
        )}

        <div className="flex gap-2 justify-end mt-6 pt-4 border-t border-[var(--hairline)]">
          <button
            className="h-[34px] px-5 rounded-lg border border-[var(--hairline-light)] bg-[var(--canvas-elevated)] text-[var(--ink)] text-[13px] cursor-pointer transition-colors hover:bg-[var(--canvas-mid)]"
            onClick={() => setProjectDialogOpen(false)}
            disabled={busy}
          >
            {t('project.cancel')}
          </button>
          <button
            className="h-[34px] px-5 rounded-lg border-none bg-[var(--accent-gold)] text-[var(--canvas)] font-medium text-[13px] cursor-pointer transition-colors hover:bg-[var(--accent-gold-soft)] disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={tab === 'blank' ? handleCreate : handleImport}
            disabled={primaryDisabled}
          >
            {tab === 'import'
              ? importing
                ? t('import.importing')
                : t('import.start')
              : loading
                ? t('project.creating')
                : t('project.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
