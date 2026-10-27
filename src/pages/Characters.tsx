import { Pencil, Save, Trash2, Users, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SimpleCreateDialog } from '@/components/SimpleCreateDialog'
import { useDataRefresh } from '@/hooks/useDataRefresh'
import { useT } from '@/hooks/useT'
import { charactersApi } from '@/lib/api'
import { notifyDataChanged } from '@/lib/dataEvents'
import { useCharacters, useProjectName } from '@/lib/useProjectData'
import type { Character } from '@/types'

export function Characters() {
  const { t } = useT()
  const project = useProjectName()
  const { data: characters, loading, reload } = useCharacters()
  useDataRefresh('character', reload)
  const [selected, setSelected] = useState<Character | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    if (characters?.length) {
      // Keep the current selection alive across reloads (e.g. after a save) instead of
      // always snapping back to the first item.
      const stillExists = selected && characters.find((c) => c.id === selected.id)
      setSelected(stillExists || characters[0])
    } else {
      setSelected(null)
    }
    setEditing(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters])

  const startEdit = () => {
    if (!selected) return
    setDraft({
      name: selected.name || '',
      role: selected.role || '',
      age: selected.age || '',
      gender: selected.gender || '',
      appearance: selected.appearance || '',
      personality: selected.personality || '',
      background: selected.background || '',
      motivation: selected.motivation || '',
      arc: selected.arc || '',
      status: selected.status || '',
      notes: selected.notes || '',
    })
    setSaveError('')
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setSaveError('')
  }

  const handleSave = async () => {
    if (!selected || !project) return
    if (!draft.name?.trim()) {
      setSaveError(t('common.requiredField', { label: t('pages.name') }))
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      await charactersApi.update(project, selected.id, draft)
      setEditing(false)
      reload()
      // 角色名/状态变化会影响关系图的节点显示
      notifyDataChanged('character')
    } catch (e: any) {
      setSaveError(e.message || t('characters.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!project) return
    try {
      await charactersApi.delete(project, id)
      setConfirmDeleteId(null)
      reload()
      // 关系表在 DB 层 CASCADE 删除；广播让关系图同步移除该节点与其连线
      notifyDataChanged('character')
    } catch (e: any) {
      setConfirmDeleteId(null)
      alert(e.message || t('characters.deleteFailed'))
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-[var(--ink-mute)]">{t('common.loading')}</div>
  }

  const deleteTarget = characters?.find((c) => c.id === confirmDeleteId)

  return (
    <>
      <div className="page-header">
        <h2 className="flex items-center gap-2">
          <Users className="w-5 h-5" /> {t('pages.characters')}
        </h2>
        <div className="page-header-actions">
          <button className="btn-primary" style={{ height: 30, padding: '0 14px' }} onClick={() => setShowCreate(true)}>
            + {t('pages.newCharacter')}
          </button>
        </div>
      </div>

      {showCreate && (
        <SimpleCreateDialog
          title={`+ ${t('pages.newCharacter')}`}
          fields={[
            { key: 'name', label: t('pages.name'), required: true, placeholder: t('characters.namePlaceholder') },
            {
              key: 'role',
              label: t('characters.roleLabel'),
              type: 'select',
              options: [
                { value: 'major', label: t('pages.roleMajor') },
                { value: 'minor', label: t('pages.roleMinor') },
                { value: 'extra', label: t('pages.roleExtra') },
              ],
            },
            { key: 'age', label: t('pages.age'), placeholder: t('characters.agePlaceholder') },
            { key: 'gender', label: t('pages.gender'), placeholder: t('characters.genderPlaceholder') },
            {
              key: 'appearance',
              label: t('pages.appearance'),
              type: 'textarea',
              placeholder: t('characters.appearancePlaceholder'),
            },
            {
              key: 'personality',
              label: t('pages.personality'),
              type: 'textarea',
              placeholder: t('characters.personalityPlaceholder'),
            },
            {
              key: 'background',
              label: t('pages.background'),
              type: 'textarea',
              placeholder: t('characters.backgroundPlaceholder'),
            },
            {
              key: 'motivation',
              label: t('pages.motivation'),
              type: 'textarea',
              placeholder: t('characters.motivationPlaceholder'),
            },
            { key: 'arc', label: t('pages.arc'), type: 'textarea', placeholder: t('characters.arcPlaceholder') },
            {
              key: 'status',
              label: t('characters.statusLabel'),
              placeholder: t('characters.statusPlaceholder'),
            },
            {
              key: 'notes',
              label: t('characters.notesLabel'),
              type: 'textarea',
              placeholder: t('characters.notesPlaceholder'),
            },
          ]}
          onSubmit={async (vals) => {
            await charactersApi.create(project, vals)
            reload()
            notifyDataChanged('character')
          }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {confirmDeleteId && deleteTarget && (
        <ConfirmDialog
          title={t('characters.deleteConfirmTitle')}
          message={t('characters.deleteConfirmMsg', { name: deleteTarget.name })}
          onConfirm={() => handleDelete(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      <div className="flex flex-1 min-h-0">
        <div className="w-[240px] shrink-0 border-r border-[var(--hairline)] overflow-y-auto py-3 custom-scrollbar">
          {(characters || []).map((c) => (
            <div
              key={c.id}
              className={`group flex items-center gap-2.5 px-4 py-2 cursor-pointer transition-colors
                ${selected?.id === c.id ? 'bg-[var(--accent-gold-soft-bg)] border-l-2 border-[var(--accent-gold)]' : 'hover:bg-[var(--canvas-card)]'}`}
              onClick={() => setSelected(c)}
            >
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0 bg-[var(--canvas-mid)] text-[var(--ink-tertiary)]">
                {c.name?.[0] || '?'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-[var(--ink)] truncate">{c.name}</div>
                <div className="text-[11px] text-[var(--ink-tertiary)]">
                  {c.age || '?'}
                  {t('characters.ageUnit')}
                  {(c.chapterCount ?? 0) > 0 &&
                    ` · ${
                      c.firstVolumeOrder != null
                        ? t('characters.firstAppearsVolumeChapter', {
                            volume: c.firstVolumeOrder,
                            chapter: c.firstChapter ?? 0,
                          })
                        : `${t('characters.firstChapterLabel')} ${c.firstChapter ?? '?'}`
                    } · ${t('characters.chapterAppearancesTotal', { n: c.chapterCount ?? 0 })}`}
                </div>
              </div>
              <button
                className="opacity-0 group-hover:opacity-100 shrink-0 w-6 h-6 flex items-center justify-center rounded text-[var(--ink-mute)] hover:text-[var(--error)] hover:bg-[var(--canvas-mid)] transition-opacity"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmDeleteId(c.id)
                }}
                title={t('characters.deleteCharacter')}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        {selected && (
          <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
            <div>
              <div className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg p-4 mb-5 flex items-center justify-between">
                <div className="flex gap-5">
                  <div className="text-center">
                    <div className="font-mono text-lg text-[var(--accent-gold)]">{selected.chapterCount || 0}</div>
                    <div className="text-[11px] text-[var(--ink-tertiary)] mt-0.5">
                      {(selected.chapterCount ?? 0) > 0
                        ? t('characters.chapterAppearancesTotal', { n: selected.chapterCount ?? 0 })
                        : t('characters.noAppearance')}
                    </div>
                  </div>
                  {selected.firstChapter != null && (
                    <div className="text-center">
                      <div className="font-mono text-lg text-[var(--accent-gold)]">
                        {selected.firstVolumeOrder != null
                          ? `${selected.firstVolumeOrder}·${selected.firstChapter}`
                          : selected.firstChapter}
                      </div>
                      <div className="text-[11px] text-[var(--ink-tertiary)] mt-0.5">
                        {selected.firstVolumeOrder != null
                          ? t('characters.firstAppearsVolumeChapter', {
                              volume: selected.firstVolumeOrder,
                              chapter: selected.firstChapter,
                            })
                          : t('characters.firstChapterLabel')}
                      </div>
                    </div>
                  )}
                </div>
                {!editing ? (
                  <button
                    className="h-[30px] px-3 flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] text-[12px] cursor-pointer hover:bg-[var(--canvas-mid)] hover:text-[var(--ink)]"
                    onClick={startEdit}
                  >
                    <Pencil className="w-3.5 h-3.5" /> {t('characters.editCharacter')}
                  </button>
                ) : (
                  <div className="flex gap-1.5">
                    <button
                      className="h-[30px] px-3 flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-secondary)] text-[12px] cursor-pointer hover:bg-[var(--canvas-mid)]"
                      onClick={cancelEdit}
                      disabled={saving}
                    >
                      <X className="w-3.5 h-3.5" /> {t('common.cancel')}
                    </button>
                    <button
                      className="h-[30px] px-3 flex items-center gap-1.5 rounded-[var(--radius-sm)] border-none bg-[var(--accent-gold)] text-[var(--canvas)] font-medium text-[12px] cursor-pointer hover:bg-[var(--accent-gold-soft)] disabled:opacity-50"
                      onClick={handleSave}
                      disabled={saving}
                    >
                      <Save className="w-3.5 h-3.5" /> {saving ? t('common.saving') : t('common.save')}
                    </button>
                  </div>
                )}
              </div>

              {saveError && (
                <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-[13px] text-red-500">
                  {saveError}
                </div>
              )}

              <div className="flex gap-3 mb-4">
                <FormField label={t('pages.name')} full>
                  <input
                    type="text"
                    value={editing ? draft.name : selected.name}
                    className="form-input"
                    readOnly={!editing}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  />
                </FormField>
                <FormField label={t('pages.age')} full>
                  <input
                    type="text"
                    value={editing ? draft.age : selected.age || ''}
                    className="form-input"
                    readOnly={!editing}
                    onChange={(e) => setDraft((d) => ({ ...d, age: e.target.value }))}
                  />
                </FormField>
                <FormField label={t('pages.gender')} full>
                  <input
                    type="text"
                    value={editing ? draft.gender : selected.gender || ''}
                    className="form-input"
                    readOnly={!editing}
                    onChange={(e) => setDraft((d) => ({ ...d, gender: e.target.value }))}
                  />
                </FormField>
                <FormField label={t('characters.statusLabel')} full>
                  <input
                    type="text"
                    value={editing ? (draft.status ?? '') : selected.status || ''}
                    className="form-input"
                    readOnly={!editing}
                    placeholder={t('characters.statusPlaceholder')}
                    onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
                  />
                </FormField>
              </div>
              <div className="mb-4 flex gap-3">
                <FormField label={t('characters.roleLabel')} full>
                  <select
                    className="form-input"
                    value={editing ? (draft.role ?? '') : selected.role || ''}
                    disabled={!editing}
                    onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}
                  >
                    <option value="">{t('characters.roleUnset')}</option>
                    <option value="major">{t('pages.roleMajor')}</option>
                    <option value="minor">{t('pages.roleMinor')}</option>
                    <option value="extra">{t('pages.roleExtra')}</option>
                  </select>
                </FormField>
              </div>
              <div className="mb-4">
                <FormField label={t('characters.notesLabel')} full>
                  <textarea
                    rows={2}
                    value={editing ? (draft.notes ?? '') : selected.notes || ''}
                    className="form-input"
                    readOnly={!editing}
                    placeholder={t('characters.notesPlaceholder')}
                    onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                  />
                </FormField>
              </div>
              <div className="mb-4">
                <FormField label={t('pages.appearance')}>
                  <textarea
                    rows={2}
                    value={editing ? draft.appearance : selected.appearance || ''}
                    className="form-textarea"
                    readOnly={!editing}
                    onChange={(e) => setDraft((d) => ({ ...d, appearance: e.target.value }))}
                  />
                </FormField>
              </div>
              <div className="flex gap-3 mb-4">
                <FormField label={t('pages.personality')} full>
                  <textarea
                    rows={2}
                    value={editing ? draft.personality : selected.personality || ''}
                    className="form-textarea"
                    readOnly={!editing}
                    onChange={(e) => setDraft((d) => ({ ...d, personality: e.target.value }))}
                  />
                </FormField>
                <FormField label={t('pages.background')} full>
                  <textarea
                    rows={2}
                    value={editing ? draft.background : selected.background || ''}
                    className="form-textarea"
                    readOnly={!editing}
                    onChange={(e) => setDraft((d) => ({ ...d, background: e.target.value }))}
                  />
                </FormField>
              </div>
              <div className="flex gap-3 mb-4">
                <FormField label={t('pages.motivation')} full>
                  <textarea
                    rows={2}
                    value={editing ? draft.motivation : selected.motivation || ''}
                    className="form-textarea"
                    readOnly={!editing}
                    onChange={(e) => setDraft((d) => ({ ...d, motivation: e.target.value }))}
                  />
                </FormField>
                <FormField label={t('pages.arc')} full>
                  <textarea
                    rows={2}
                    value={editing ? draft.arc : selected.arc || ''}
                    className="form-textarea"
                    readOnly={!editing}
                    onChange={(e) => setDraft((d) => ({ ...d, arc: e.target.value }))}
                  />
                </FormField>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function FormField({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? 'flex-1' : ''}>
      <label className="block text-[11px] font-medium text-[var(--ink-secondary)] tracking-[0.04em] uppercase mb-1">
        {label}
      </label>
      {children}
    </div>
  )
}
