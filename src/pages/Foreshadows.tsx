import type { LucideIcon } from 'lucide-react'
import { CheckCircle2, Link2, Loader, Pencil, Pin, Plus, RefreshCw, Save, Target, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SimpleCreateDialog } from '@/components/SimpleCreateDialog'
import { useDataRefresh } from '@/hooks/useDataRefresh'
import { useT } from '@/hooks/useT'
import { aiApi, extractAIJsonArray, foreshadowsApi, getAIResponseText } from '@/lib/api'
import { useChapters, useForeshadows, useProjectName } from '@/lib/useProjectData'

interface Column {
  key: string
  icon: LucideIcon
  label: string
}

const COLUMNS: Column[] = [
  { key: 'planted', icon: Pin, label: 'foreshadow.planted' },
  { key: 'progressing', icon: RefreshCw, label: 'foreshadow.progressing' },
  { key: 'resolved', icon: CheckCircle2, label: 'foreshadow.resolved' },
]

export function Foreshadows() {
  const { data: foreshadows, loading, reload } = useForeshadows()
  useDataRefresh('foreshadow', reload)
  const { chapters } = useChapters()
  const { t } = useT()
  const project = useProjectName()
  const [showCreate, setShowCreate] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const list = foreshadows || []
  const selected = list.find((f: any) => f.id === selectedId) || null

  useEffect(() => {
    if (selectedId && !list.find((f: any) => f.id === selectedId)) {
      setSelectedId(null)
      setEditing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list])

  const handleAIDesign = async () => {
    if (!project) return
    setGenerating(true)
    try {
      const res = await aiApi.chat(
        [
          {
            role: 'system',
            content: t('foreshadow.aiPrompt'),
          },
          { role: 'user', content: t('foreshadow.aiUserMessage') },
        ],
        project,
      )
      const text = getAIResponseText(res)
      const suggestions = extractAIJsonArray(text)
      if (suggestions) {
        await Promise.all(
          suggestions.map((s: any) =>
            foreshadowsApi.create(project, {
              title: s.title,
              description: s.description || '',
              priority: s.priority || 'normal',
              status: 'planted',
            }),
          ),
        )
        reload()
      }
    } catch (e) {
      console.error('AI design foreshadows failed:', e)
    }
    setGenerating(false)
  }

  const startEdit = () => {
    if (!selected) return
    setDraft({
      title: selected.title || '',
      description: selected.description || '',
      priority: selected.priority || 'normal',
      status: selected.status || 'planted',
      expected_resolve_chapter: String(selected.expected_resolve_chapter || 0),
    })
    setSaveError('')
    setEditing(true)
  }

  const handleSave = async () => {
    if (!selected || !project) return
    if (!draft.title?.trim()) {
      setSaveError(t('common.requiredField', { label: t('foreshadow.titleField') }))
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      await foreshadowsApi.update(project, selected.id, {
        ...draft,
        expected_resolve_chapter: parseInt(draft.expected_resolve_chapter, 10) || 0,
      })
      setEditing(false)
      reload()
    } catch (e: any) {
      setSaveError(e.message || t('foreshadow.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!project) return
    try {
      await foreshadowsApi.delete(project, id)
      setConfirmDeleteId(null)
      if (selectedId === id) setSelectedId(null)
      reload()
    } catch (e: any) {
      setConfirmDeleteId(null)
      alert(e.message || t('foreshadow.deleteFailed'))
    }
  }

  if (loading)
    return <div className="flex-1 flex items-center justify-center text-[var(--ink-mute)]">{t('common.loading')}</div>

  const maxChapterNum = Math.max(0, ...(chapters || []).map((c: any) => c.num))
  const stats = [
    { label: t('foreshadow.statTotal'), value: String(list.length), color: 'var(--accent-gold)' },
    { label: t('foreshadow.planted'), value: String(list.filter((f) => f.status === 'planted').length) },
    { label: t('foreshadow.progressing'), value: String(list.filter((f) => f.status === 'progressing').length) },
    { label: t('foreshadow.resolved'), value: String(list.filter((f) => f.status === 'resolved').length) },
    {
      label: t('foreshadow.overdue'),
      value: String(
        list.filter(
          (f: any) =>
            f.status === 'planted' && f.expected_resolve_chapter > 0 && f.expected_resolve_chapter < maxChapterNum,
        ).length,
      ),
      color: 'var(--error)',
    },
  ]

  const deleteTarget = list.find((f: any) => f.id === confirmDeleteId)

  return (
    <>
      <div className="page-header">
        <h2 className="flex items-center gap-2">
          <Link2 className="w-5 h-5" /> {t('pages.foreshadowBoard')}
        </h2>
        <div className="page-header-actions">
          <button
            className="btn-primary flex items-center gap-1.5"
            style={{ height: 30, padding: '0 14px' }}
            onClick={handleAIDesign}
            disabled={generating}
          >
            {generating ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Target className="w-3.5 h-3.5" />}
            {generating ? t('common.generating') : t('pages.aiDesign')}
          </button>
          <button
            className="btn-secondary flex items-center gap-1"
            style={{ height: 30, padding: '0 14px' }}
            onClick={() => setShowCreate(true)}
          >
            <Plus className="w-3.5 h-3.5" /> {t('pages.manualAdd')}
          </button>
        </div>
      </div>

      {showCreate && (
        <SimpleCreateDialog
          title={`+ ${t('pages.manualAdd')}`}
          fields={[
            {
              key: 'title',
              label: t('foreshadow.titleField'),
              required: true,
              placeholder: t('foreshadow.titlePlaceholder'),
            },
            {
              key: 'description',
              label: t('foreshadow.descriptionField'),
              type: 'textarea',
              placeholder: t('foreshadow.descriptionPlaceholder'),
            },
            {
              key: 'priority',
              label: t('foreshadow.priorityField'),
              type: 'select',
              options: [
                { value: 'high', label: t('foreshadow.priorityHigh') },
                { value: 'normal', label: t('foreshadow.priorityNormal') },
                { value: 'low', label: t('foreshadow.priorityLow') },
              ],
            },
            {
              key: 'status',
              label: t('foreshadow.statusField'),
              type: 'select',
              options: [
                { value: 'planted', label: t('foreshadow.planted') },
                { value: 'progressing', label: t('foreshadow.progressing') },
              ],
            },
          ]}
          onSubmit={async (vals) => {
            await foreshadowsApi.create(project, vals)
            reload()
          }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {confirmDeleteId && deleteTarget && (
        <ConfirmDialog
          title={t('foreshadow.deleteConfirmTitle')}
          message={t('foreshadow.deleteConfirmMsg', { title: deleteTarget.title })}
          onConfirm={() => handleDelete(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      <div className="flex gap-3 px-6 py-4 shrink-0 bg-[var(--canvas-soft)] border-b border-[var(--hairline)]">
        {stats.map((s) => (
          <div
            key={s.label}
            className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg px-5 py-3 min-w-[100px] text-center"
          >
            <div className="font-mono text-lg" style={{ color: s.color || 'var(--accent-gold)' }}>
              {s.value}
            </div>
            <div className="text-[11px] text-[var(--ink-tertiary)] mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex gap-4 flex-1 px-6 py-4 overflow-x-auto min-h-0 custom-scrollbar">
          {COLUMNS.map((col) => {
            const ColIcon = col.icon
            return (
              <div key={col.key} className="flex-1 min-w-[240px] bg-[var(--canvas-soft)] rounded-lg flex flex-col">
                <div className="px-3.5 py-2.5 text-[13px] font-medium text-[var(--ink-secondary)] border-b border-[var(--hairline)] flex items-center justify-between gap-1.5">
                  <span className="flex items-center gap-1">
                    <ColIcon className="w-3.5 h-3.5" /> {t(col.label)}
                  </span>
                  <span>{list.filter((f: any) => f.status === col.key).length}</span>
                </div>
                <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
                  {list
                    .filter((f: any) => f.status === col.key)
                    .map((f: any) => (
                      <div
                        key={f.id}
                        className={`group relative bg-[var(--canvas-card)] border rounded-[var(--radius-sm)] p-2.5 mb-1.5 cursor-pointer transition-colors hover:border-[var(--hairline-light)]
                          ${selectedId === f.id ? 'border-[var(--accent-gold)]' : 'border-[var(--hairline)]'}`}
                        onClick={() => {
                          setSelectedId(f.id)
                          setEditing(false)
                        }}
                      >
                        <button
                          className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-[var(--ink-mute)] hover:text-[var(--error)] hover:bg-[var(--canvas-mid)] transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmDeleteId(f.id)
                          }}
                          title={t('foreshadow.deleteEntry')}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                        <div className="text-[13px] text-[var(--ink)] flex items-center gap-1.5 pr-4">
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 inline-block
                          ${f.priority === 'high' ? 'bg-[var(--error)]' : f.priority === 'normal' ? 'bg-[var(--accent-gold)]' : 'bg-[var(--ink-mute)]'}`}
                          />
                          {f.title}
                        </div>
                        {f.description && (
                          <div className="text-[12px] text-[var(--ink-tertiary)] mt-1 line-clamp-2">
                            {f.description}
                          </div>
                        )}
                        {f.expected_resolve_chapter > 0 && (
                          <div className="text-[10px] text-[var(--ink-mute)] mt-1 font-mono">
                            {t('foreshadow.expectedResolve', { n: f.expected_resolve_chapter })}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            )
          })}
        </div>

        {selected && (
          <div className="w-[360px] shrink-0 border-l border-[var(--hairline)] overflow-y-auto p-5 custom-scrollbar">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[13px] font-medium text-[var(--ink)]">{t('foreshadow.titleField')}</span>
              {!editing ? (
                <button
                  className="h-[28px] px-2.5 flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] text-[12px] cursor-pointer hover:bg-[var(--canvas-mid)] hover:text-[var(--ink)]"
                  onClick={startEdit}
                >
                  <Pencil className="w-3.5 h-3.5" /> {t('foreshadow.editEntry')}
                </button>
              ) : (
                <div className="flex gap-1.5">
                  <button
                    className="h-[28px] px-2.5 flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] text-[12px] cursor-pointer hover:bg-[var(--canvas-mid)]"
                    onClick={() => setEditing(false)}
                    disabled={saving}
                  >
                    <X className="w-3.5 h-3.5" /> {t('common.cancel')}
                  </button>
                  <button
                    className="h-[28px] px-2.5 flex items-center gap-1.5 rounded-[var(--radius-sm)] border-none bg-[var(--accent-gold)] text-[var(--canvas)] font-medium text-[12px] cursor-pointer hover:bg-[var(--accent-gold-soft)] disabled:opacity-50"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    <Save className="w-3.5 h-3.5" /> {saving ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              )}
            </div>

            {saveError && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-[13px] text-red-500">
                {saveError}
              </div>
            )}

            <div className="space-y-3">
              <FormField label={t('foreshadow.titleField')}>
                <input
                  type="text"
                  value={editing ? draft.title : selected.title}
                  className="form-input"
                  readOnly={!editing}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                />
              </FormField>
              <FormField label={t('foreshadow.descriptionField')}>
                <textarea
                  rows={5}
                  value={editing ? draft.description : selected.description || ''}
                  className="form-textarea"
                  readOnly={!editing}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                />
              </FormField>
              <FormField label={t('foreshadow.priorityField')}>
                {editing ? (
                  <select
                    className="w-full h-[34px] px-2.5 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[13px] outline-none cursor-pointer focus:border-[var(--accent-gold)]"
                    value={draft.priority}
                    onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
                  >
                    <option value="high">{t('foreshadow.priorityHigh')}</option>
                    <option value="normal">{t('foreshadow.priorityNormal')}</option>
                    <option value="low">{t('foreshadow.priorityLow')}</option>
                  </select>
                ) : (
                  <input
                    type="text"
                    value={
                      selected.priority === 'high'
                        ? t('foreshadow.priorityHigh')
                        : selected.priority === 'low'
                          ? t('foreshadow.priorityLow')
                          : t('foreshadow.priorityNormal')
                    }
                    className="form-input"
                    readOnly
                  />
                )}
              </FormField>
              <FormField label={t('foreshadow.statusField')}>
                {editing ? (
                  <select
                    className="w-full h-[34px] px-2.5 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[13px] outline-none cursor-pointer focus:border-[var(--accent-gold)]"
                    value={draft.status}
                    onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
                  >
                    <option value="planted">{t('foreshadow.planted')}</option>
                    <option value="progressing">{t('foreshadow.progressing')}</option>
                    <option value="resolved">{t('foreshadow.resolved')}</option>
                    <option value="abandoned">{t('foreshadow.abandoned')}</option>
                  </select>
                ) : (
                  <input
                    type="text"
                    value={
                      selected.status === 'planted'
                        ? t('foreshadow.planted')
                        : selected.status === 'progressing'
                          ? t('foreshadow.progressing')
                          : selected.status === 'resolved'
                            ? t('foreshadow.resolved')
                            : t('foreshadow.abandoned')
                    }
                    className="form-input"
                    readOnly
                  />
                )}
              </FormField>
              <FormField label={t('foreshadow.expectedResolveField')}>
                <input
                  type="number"
                  value={editing ? draft.expected_resolve_chapter : String(selected.expected_resolve_chapter || 0)}
                  className="form-input"
                  readOnly={!editing}
                  onChange={(e) => setDraft((d) => ({ ...d, expected_resolve_chapter: e.target.value }))}
                />
              </FormField>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-[var(--ink-secondary)] tracking-[0.04em] uppercase mb-1">
        {label}
      </label>
      {children}
    </div>
  )
}
