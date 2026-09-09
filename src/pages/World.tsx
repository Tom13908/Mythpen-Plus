import { Building2, Calendar, Cog, Globe, Lightbulb, MapPin, Pencil, Save, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SimpleCreateDialog } from '@/components/SimpleCreateDialog'
import { useDataRefresh } from '@/hooks/useDataRefresh'
import { useT } from '@/hooks/useT'
import { worldApi } from '@/lib/api'
import { useProjectName, useWorldEntries } from '@/lib/useProjectData'
import type { WorldEntry } from '@/types'

const TABS = ['all', 'location', 'organization', 'concept', 'event']
const TAB_ICONS: Record<string, React.ReactNode> = {
  all: null,
  location: <MapPin className="w-3.5 h-3.5" />,
  organization: <Building2 className="w-3.5 h-3.5" />,
  concept: <Lightbulb className="w-3.5 h-3.5" />,
  event: <Calendar className="w-3.5 h-3.5" />,
}
const CAT_ICONS: Record<string, React.ReactNode> = {
  location: <MapPin className="w-3.5 h-3.5" />,
  organization: <Building2 className="w-3.5 h-3.5" />,
  concept: <Lightbulb className="w-3.5 h-3.5" />,
  event: <Calendar className="w-3.5 h-3.5" />,
  technology: <Cog className="w-3.5 h-3.5" />,
}

export function World() {
  const { data: entries, loading, reload } = useWorldEntries()
  useDataRefresh('world', reload)
  const [activeTab, setActiveTab] = useState('all')
  const [showCreate, setShowCreate] = useState(false)
  const [selected, setSelected] = useState<WorldEntry | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const { t } = useT()
  const project = useProjectName()
  const tabLabels: Record<string, string> = {
    all: t('world.tabAll'),
    location: t('world.categoryLocation'),
    organization: t('world.categoryOrganization'),
    concept: t('world.categoryConcept'),
    event: t('world.categoryEvent'),
  }
  const catLabels: Record<string, string> = {
    location: t('world.categoryLocation'),
    organization: t('world.categoryOrganization'),
    concept: t('world.categoryConcept'),
    event: t('world.categoryEvent'),
    technology: t('world.categoryTechnology'),
  }
  const catOptions = [
    { value: 'location', label: t('world.categoryLocation') },
    { value: 'organization', label: t('world.categoryOrganization') },
    { value: 'concept', label: t('world.categoryConcept') },
    { value: 'event', label: t('world.categoryEvent') },
    { value: 'technology', label: t('world.categoryTechnology') },
  ]

  const filtered = activeTab === 'all' ? entries || [] : (entries || []).filter((e) => e.category === activeTab)

  useEffect(() => {
    if (selected && !filtered.find((e) => e.id === selected.id)) {
      setSelected(null)
      setEditing(false)
    }
  }, [filtered, selected])

  const startEdit = () => {
    if (!selected) return
    setDraft({
      category: selected.category || '',
      name: selected.name || '',
      description: selected.description || '',
      tags: selected.tags || '',
    })
    setSaveError('')
    setEditing(true)
  }

  const handleSave = async () => {
    if (!selected || !project) return
    if (!draft.name?.trim()) {
      setSaveError(t('common.requiredField', { label: t('world.name') }))
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      await worldApi.update(project, selected.id, draft)
      setEditing(false)
      reload()
    } catch (e: any) {
      setSaveError(e.message || t('world.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!project) return
    try {
      await worldApi.delete(project, id)
      setConfirmDeleteId(null)
      if (selected?.id === id) setSelected(null)
      reload()
    } catch (e: any) {
      setConfirmDeleteId(null)
      alert(e.message || t('world.deleteFailed'))
    }
  }

  if (loading)
    return <div className="flex-1 flex items-center justify-center text-[var(--ink-mute)]">{t('common.loading')}</div>

  const deleteTarget = entries?.find((e) => e.id === confirmDeleteId)

  return (
    <>
      <div className="page-header">
        <h2 className="flex items-center gap-2">
          <Globe className="w-5 h-5" /> {t('pages.world')}
        </h2>
        <div className="page-header-actions">
          <button className="btn-primary" style={{ height: 30, padding: '0 14px' }} onClick={() => setShowCreate(true)}>
            + {t('pages.newEntry')}
          </button>
        </div>
      </div>

      {showCreate && (
        <SimpleCreateDialog
          title={`+ ${t('pages.newEntry')}`}
          fields={[
            { key: 'category', label: t('world.category'), type: 'select', required: true, options: catOptions },
            { key: 'name', label: t('world.name'), required: true, placeholder: t('world.namePlaceholder') },
            {
              key: 'description',
              label: t('world.description'),
              type: 'textarea',
              placeholder: t('world.descriptionPlaceholder'),
            },
            { key: 'tags', label: t('world.tags'), placeholder: t('world.tagsPlaceholder') },
          ]}
          onSubmit={async (vals) => {
            await worldApi.create(project, vals)
            reload()
          }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {confirmDeleteId && deleteTarget && (
        <ConfirmDialog
          title={t('world.deleteConfirmTitle')}
          message={t('world.deleteConfirmMsg', { name: deleteTarget.name })}
          onConfirm={() => handleDelete(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      <div className="flex gap-0 border-b border-[var(--hairline)] px-6 shrink-0 bg-[var(--canvas-soft)]">
        {TABS.map((tab) => (
          <span
            key={tab}
            className={`px-4 py-2.5 text-[13px] cursor-pointer border-b-2 transition-colors
              ${activeTab === tab ? 'text-[var(--ink)] border-b-2 border-[var(--accent-gold)]' : 'text-[var(--ink-tertiary)] border-b-2 border-transparent hover:text-[var(--ink-secondary)]'}`}
            onClick={() => setActiveTab(tab)}
          >
            <span className="flex items-center gap-1">
              {TAB_ICONS[tab]} {tabLabels[tab] || tab}
            </span>
          </span>
        ))}
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 p-6">
            {filtered.map((entry) => (
              <div
                key={entry.id}
                className={`group relative bg-[var(--canvas-card)] border rounded-lg p-4 cursor-pointer transition-colors hover:border-[var(--hairline-light)] hover:bg-[var(--canvas-elevated)]
                  ${selected?.id === entry.id ? 'border-[var(--accent-gold)]' : 'border-[var(--hairline)]'}`}
                onClick={() => {
                  setSelected(entry)
                  setEditing(false)
                }}
              >
                <button
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-[var(--ink-mute)] hover:text-[var(--error)] hover:bg-[var(--canvas-mid)] transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmDeleteId(entry.id)
                  }}
                  title={t('world.deleteEntry')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <span className="text-[10px] px-[6px] py-[1px] rounded-full bg-[var(--canvas-mid)] text-[var(--ink-tertiary)] inline-block mb-1.5">
                  <span className="inline-flex items-center gap-0.5">
                    {CAT_ICONS[entry.category]} {catLabels[entry.category] || entry.category}
                  </span>
                </span>
                <div className="text-[15px] text-[var(--ink)] mb-1 pr-6">{entry.name}</div>
                <div className="text-[13px] text-[var(--ink-tertiary)] line-clamp-2">{entry.description}</div>
              </div>
            ))}
          </div>
        </div>

        {selected && (
          <div className="w-[380px] shrink-0 border-l border-[var(--hairline)] overflow-y-auto p-5 custom-scrollbar">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[10px] px-[6px] py-[1px] rounded-full bg-[var(--canvas-mid)] text-[var(--ink-tertiary)] inline-flex items-center gap-0.5">
                {CAT_ICONS[selected.category]} {catLabels[selected.category] || selected.category}
              </span>
              {!editing ? (
                <button
                  className="h-[28px] px-2.5 flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] text-[12px] cursor-pointer hover:bg-[var(--canvas-mid)] hover:text-[var(--ink)]"
                  onClick={startEdit}
                >
                  <Pencil className="w-3.5 h-3.5" /> {t('world.editEntry')}
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
              <FormField label={t('world.category')}>
                {editing ? (
                  <select
                    className="w-full h-[34px] px-2.5 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[13px] outline-none cursor-pointer focus:border-[var(--accent-gold)]"
                    value={draft.category}
                    onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                  >
                    {catOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={catLabels[selected.category] || selected.category}
                    className="form-input"
                    readOnly
                  />
                )}
              </FormField>
              <FormField label={t('world.name')}>
                <input
                  type="text"
                  value={editing ? draft.name : selected.name}
                  className="form-input"
                  readOnly={!editing}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                />
              </FormField>
              <FormField label={t('world.description')}>
                <textarea
                  rows={6}
                  value={editing ? draft.description : selected.description || ''}
                  className="form-textarea"
                  readOnly={!editing}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                />
              </FormField>
              <FormField label={t('world.tags')}>
                <input
                  type="text"
                  value={editing ? draft.tags : selected.tags || ''}
                  className="form-input"
                  readOnly={!editing}
                  placeholder={editing ? t('world.tagsPlaceholder') : ''}
                  onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
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
