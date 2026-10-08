import { Brain, Loader, Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SimpleCreateDialog } from '@/components/SimpleCreateDialog'
import { useDataRefresh } from '@/hooks/useDataRefresh'
import { useT } from '@/hooks/useT'
import { aiApi, extractAIJsonArray, getAIResponseText, memoriesApi } from '@/lib/api'
import { useMemories, useProjectName } from '@/lib/useProjectData'

const CAT_LABELS: Record<string, string> = {
  character: 'memory.categoryCharacter',
  location: 'memory.categoryLocation',
  event: 'memory.categoryEvent',
  promise: 'memory.categoryPromise',
  item: 'memory.categoryItem',
  other: 'memory.categoryOther',
}
const CAT_COLORS: Record<string, { bg: string; text: string }> = {
  character: { bg: 'rgba(201,169,110,0.18)', text: 'var(--accent-gold)' },
  location: { bg: 'rgba(122,142,168,0.18)', text: 'var(--accent-mist)' },
  event: { bg: 'var(--info-soft)', text: 'var(--info)' },
  promise: { bg: 'var(--warning-soft)', text: 'var(--warning)' },
  item: { bg: 'var(--success-soft)', text: 'var(--success)' },
}

export function Memory() {
  const { data: memories, loading, reload } = useMemories()
  useDataRefresh('memory', reload)
  const { t } = useT()
  const project = useProjectName()
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const handleSearch = async () => {
    if (!project || !searchQuery.trim()) return
    setSearching(true)
    try {
      const results = await memoriesApi.search(project, searchQuery.trim())
      setSearchResults(results)
    } catch {
      setSearchResults([])
    }
    setSearching(false)
  }

  const handleClearSearch = () => {
    setSearchMode(false)
    setSearchQuery('')
    setSearchResults(null)
  }

  // 增删改后：主列表必刷；若处于搜索态，同时重跑搜索，避免显示陈旧结果
  const refreshAfterMutation = async () => {
    reload()
    if (searchResults !== null && project && searchQuery.trim()) {
      try {
        setSearchResults(await memoriesApi.search(project, searchQuery.trim()))
      } catch {
        /* ignore */
      }
    }
  }

  const handleCreate = async (vals: Record<string, string>) => {
    if (!project) return
    await memoriesApi.create(project, { category: vals.category, content: vals.content })
    await refreshAfterMutation()
  }

  const handleUpdate = async (vals: Record<string, string>) => {
    if (!project || !editing) return
    await memoriesApi.update(project, editing.id, { category: vals.category, content: vals.content })
    await refreshAfterMutation()
  }

  const handleDelete = async (id: string) => {
    if (!project) return
    try {
      await memoriesApi.delete(project, id)
      setConfirmDeleteId(null)
      await refreshAfterMutation()
    } catch (e: any) {
      setConfirmDeleteId(null)
      alert(e.message || t('memory.deleteFailed'))
    }
  }

  const handleExtract = async () => {
    if (!project) return
    setExtracting(true)
    try {
      const res = await aiApi.chat(
        [
          {
            role: 'system',
            content: t('memory.aiPrompt'),
          },
          { role: 'user', content: t('memory.aiUserMessage') },
        ],
        project,
      )
      const text = getAIResponseText(res)
      const items = extractAIJsonArray(text)
      if (items) {
        await Promise.all(
          items.map((item: any) =>
            memoriesApi.create(project, {
              category: item.category || 'other',
              content: item.content,
            }),
          ),
        )
        reload()
      }
    } catch (e) {
      console.error('AI extract memories failed:', e)
    }
    setExtracting(false)
  }

  const displayList = searchResults !== null ? searchResults : memories || []

  const categoryOptions = Object.entries(CAT_LABELS).map(([value, key]) => ({ value, label: t(key) }))
  const memoryFields = [
    {
      key: 'category',
      label: t('memory.categoryLabel'),
      type: 'select' as const,
      options: categoryOptions,
      required: true,
    },
    {
      key: 'content',
      label: t('memory.contentLabel'),
      type: 'textarea' as const,
      required: true,
      placeholder: t('memory.contentPlaceholder'),
    },
  ]

  if (loading)
    return <div className="flex-1 flex items-center justify-center text-[var(--ink-mute)]">{t('common.loading')}</div>

  return (
    <>
      <div className="page-header">
        <h2 className="flex items-center gap-2">
          <Brain className="w-5 h-5" /> {t('pages.narrativeMemory')}
        </h2>
        <div className="page-header-actions">
          <button
            className="btn-secondary flex items-center gap-1.5"
            style={{ height: 30, padding: '0 14px' }}
            onClick={() => setSearchMode(!searchMode)}
          >
            <Search className="w-3.5 h-3.5" /> {t('pages.semanticSearch')}
          </button>
          <button
            className="btn-secondary flex items-center gap-1.5"
            style={{ height: 30, padding: '0 14px' }}
            onClick={handleExtract}
            disabled={extracting}
          >
            {extracting ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {extracting ? t('common.extracting') : t('pages.aiExtract')}
          </button>
          <button
            className="btn-primary flex items-center gap-1"
            style={{ height: 30, padding: '0 14px' }}
            onClick={() => setShowCreate(true)}
          >
            <Plus className="w-3.5 h-3.5" /> {t('pages.newMemory')}
          </button>
        </div>
      </div>

      {showCreate && (
        <SimpleCreateDialog
          title={`+ ${t('pages.newMemory')}`}
          fields={memoryFields}
          initialValues={{ category: 'other' }}
          onSubmit={handleCreate}
          onClose={() => setShowCreate(false)}
        />
      )}

      {editing && (
        <SimpleCreateDialog
          title={t('memory.editMemory')}
          fields={memoryFields}
          initialValues={{ category: editing.category || 'other', content: editing.content || '' }}
          submitLabel={t('common.save')}
          submittingLabel={t('common.saving')}
          onSubmit={handleUpdate}
          onClose={() => setEditing(null)}
        />
      )}

      {confirmDeleteId && (
        <ConfirmDialog
          title={t('memory.deleteConfirmTitle')}
          message={t('memory.deleteConfirmMsg')}
          onConfirm={() => handleDelete(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      {/* Search bar */}
      {searchMode && (
        <div className="px-6 py-3 border-b border-[var(--hairline)] bg-[var(--canvas-soft)]">
          <div className="flex gap-2 max-w-[500px]">
            <input
              type="text"
              className="w-full h-8 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-lg px-3 font-sans text-[13px] text-[var(--ink)] outline-none focus:border-[var(--accent-gold)]"
              placeholder={t('memory.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              autoFocus
            />
            <button
              className="h-8 px-4 min-w-[72px] rounded-lg bg-[var(--accent-gold)] text-[var(--canvas)] text-[12px] cursor-pointer border-none font-medium whitespace-nowrap"
              onClick={handleSearch}
              disabled={searching || !searchQuery.trim()}
            >
              {searching ? t('common.searching') : t('common.search')}
            </button>
            <button
              className="h-8 w-8 rounded-lg flex items-center justify-center border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-tertiary)] cursor-pointer hover:text-[var(--ink)]"
              onClick={handleClearSearch}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {searchResults !== null && (
            <div className="text-[12px] text-[var(--ink-tertiary)] mt-1.5">
              {searchResults.length === 0
                ? t('memory.noResults')
                : t('memory.searchResultsCount', { n: searchResults.length })}
              <button
                className="ml-2 text-[var(--accent-gold)] underline cursor-pointer bg-transparent border-none"
                onClick={() => {
                  setSearchResults(null)
                  setSearchQuery('')
                }}
              >
                {t('memory.showAll')}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="page-body" style={{ padding: 0 }}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 p-6">
          {displayList.map((m: any) => {
            const color = CAT_COLORS[m.category] || { bg: 'var(--canvas-mid)', text: 'var(--ink-tertiary)' }
            return (
              <div
                key={m.id}
                className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg p-3.5 transition-colors hover:border-[var(--hairline-light)] hover:bg-[var(--canvas-elevated)]"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <span
                    className="text-[10px] px-[7px] py-[1px] rounded-full inline-block"
                    style={{ background: color.bg, color: color.text }}
                  >
                    {t(CAT_LABELS[m.category] || m.category)}
                  </span>
                  {/* 操作按钮常显半透明（不做悬停才显示，见协作约定） */}
                  <div className="flex gap-0.5 shrink-0 opacity-60 hover:opacity-100 transition-opacity">
                    <button
                      className="w-6 h-6 flex items-center justify-center rounded text-[var(--ink-mute)] hover:text-[var(--accent-gold)] hover:bg-[var(--canvas-mid)] cursor-pointer border-none bg-transparent"
                      onClick={() => setEditing(m)}
                      title={t('memory.editMemory')}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      className="w-6 h-6 flex items-center justify-center rounded text-[var(--ink-mute)] hover:text-[var(--error)] hover:bg-[var(--canvas-mid)] cursor-pointer border-none bg-transparent"
                      onClick={() => setConfirmDeleteId(m.id)}
                      title={t('memory.deleteMemory')}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <div className="text-[13px] text-[var(--ink-secondary)] leading-[1.6]">{m.content}</div>
                <div className="text-[11px] text-[var(--ink-mute)] mt-2 font-mono">
                  {m.source_chapter_id ? t('memory.sourceChapter', { n: m.source_chapter_id }) : ''}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
