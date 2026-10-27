/**
 * 导入旧稿的文件选择面板。
 *
 * 只管「选文件 + 显示选中了什么」。真正的解析与建项目在服务端，
 * 因为 EPUB 是 zip，解压放在服务端可以避免把 zip 库打进前端主包。
 */

import { FileText, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useT } from '@/hooks/useT'
import { formatBytes, isEpubFile } from '@/lib/importFile'

interface Props {
  file: File | null
  onFile: (file: File | null) => void
  disabled?: boolean
}

export function ImportBookPanel({ file, onFile, disabled }: Props) {
  const { t } = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)

  const pick = () => {
    if (!disabled) inputRef.current?.click()
  }

  const accept = (selected: File | undefined) => {
    if (!selected || disabled) return
    const lower = selected.name.toLowerCase()
    if (!lower.endsWith('.txt') && !lower.endsWith('.epub')) {
      onFile(null)
      return
    }
    onFile(selected)
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.epub,text/plain,application/epub+zip"
        className="hidden"
        onChange={(e) => {
          accept(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {file ? (
        <div className="flex items-center gap-3 rounded-lg border border-[var(--hairline)] bg-[var(--canvas-elevated)] px-3 py-2.5">
          <FileText className="w-4 h-4 shrink-0 text-[var(--accent-gold)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] text-[var(--ink)]">{file.name}</div>
            <div className="text-[11px] text-[var(--ink-tertiary)]">
              {isEpubFile(file) ? 'EPUB' : 'TXT'} · {formatBytes(file.size)}
            </div>
          </div>
          <button
            className="h-[26px] w-[26px] flex items-center justify-center rounded border border-[var(--hairline)] bg-[var(--canvas-card)] text-[var(--ink-mute)] cursor-pointer hover:text-[var(--ink)]"
            onClick={() => onFile(null)}
            disabled={disabled}
            title={t('common.delete')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={`w-full rounded-xl border-2 border-dashed px-5 py-6 text-center transition-colors ${
            dragActive
              ? 'border-[var(--accent-gold)] bg-[var(--accent-gold)]/5'
              : 'border-[var(--hairline)] bg-[var(--canvas-elevated)]'
          } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-[var(--accent-gold)]/60'}`}
          onClick={pick}
          onDragOver={(e) => {
            e.preventDefault()
            if (!disabled) setDragActive(true)
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragActive(false)
            accept(e.dataTransfer.files?.[0])
          }}
        >
          <Upload className="mx-auto mb-2 w-5 h-5 text-[var(--ink-tertiary)]" />
          <div className="text-[13px] text-[var(--ink-secondary)]">{t('import.dropHint')}</div>
          <div className="mt-1 text-[11px] text-[var(--ink-tertiary)]">{t('import.supported')}</div>
        </button>
      )}

      <p className="mt-2 text-[11px] leading-[1.5] text-[var(--ink-tertiary)]">{t('import.hint')}</p>
    </div>
  )
}
