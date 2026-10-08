import { CalendarDays, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SimpleCreateDialog } from '@/components/SimpleCreateDialog'
import { useDataRefresh } from '@/hooks/useDataRefresh'
import { useT } from '@/hooks/useT'
import { timelineApi } from '@/lib/api'
import { useProjectName, useTimelineEvents } from '@/lib/useProjectData'

export function Timeline() {
  const { data: events, loading, reload } = useTimelineEvents()
  useDataRefresh('timeline', reload)
  const { t } = useT()
  const project = useProjectName()
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const eventFields = [
    { key: 'year', label: t('timeline.yearLabel'), required: true, placeholder: t('timeline.yearPlaceholder') },
    { key: 'title', label: t('timeline.titleLabel'), required: true, placeholder: t('timeline.titlePlaceholder') },
    {
      key: 'description',
      label: t('timeline.descriptionLabel'),
      type: 'textarea' as const,
      placeholder: t('timeline.descriptionPlaceholder'),
    },
    {
      key: 'importance',
      label: t('timeline.importanceLabel'),
      type: 'number' as const,
      placeholder: t('timeline.importancePlaceholder'),
    },
  ]

  const toPayload = (vals: Record<string, string>) => ({
    year: vals.year,
    title: vals.title,
    description: vals.description || '',
    importance: parseInt(vals.importance) || 3,
  })

  const handleCreate = async (vals: Record<string, string>) => {
    await timelineApi.create(project, toPayload(vals))
    reload()
  }

  const handleUpdate = async (vals: Record<string, string>) => {
    if (!editing) return
    await timelineApi.update(project, editing.id, toPayload(vals))
    reload()
  }

  const handleDelete = async (id: string) => {
    if (!project) return
    try {
      await timelineApi.delete(project, id)
      setConfirmDeleteId(null)
      reload()
    } catch (e: any) {
      setConfirmDeleteId(null)
      alert(e.message || t('timeline.deleteFailed'))
    }
  }

  if (loading)
    return <div className="flex-1 flex items-center justify-center text-[var(--ink-mute)]">{t('common.loading')}</div>

  return (
    <>
      <div className="page-header">
        <h2 className="flex items-center gap-2">
          <CalendarDays className="w-5 h-5" /> {t('pages.timeline')}
        </h2>
        <div className="page-header-actions">
          <button
            className="btn-primary flex items-center gap-1"
            style={{ height: 30, padding: '0 14px' }}
            onClick={() => setShowCreate(true)}
          >
            <Plus className="w-3.5 h-3.5" /> {t('pages.newEvent')}
          </button>
        </div>
      </div>

      {showCreate && (
        <SimpleCreateDialog
          title={`+ ${t('pages.newEvent')}`}
          fields={eventFields}
          onSubmit={handleCreate}
          onClose={() => setShowCreate(false)}
        />
      )}

      {editing && (
        <SimpleCreateDialog
          title={t('timeline.editEvent')}
          fields={eventFields}
          initialValues={{
            year: editing.year || '',
            title: editing.title || '',
            description: editing.description || '',
            importance: String(editing.importance ?? 3),
          }}
          submitLabel={t('common.save')}
          submittingLabel={t('common.saving')}
          onSubmit={handleUpdate}
          onClose={() => setEditing(null)}
        />
      )}

      {confirmDeleteId && (
        <ConfirmDialog
          title={t('timeline.deleteConfirmTitle')}
          message={t('timeline.deleteConfirmMsg')}
          onConfirm={() => handleDelete(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      <div className="page-body" style={{ padding: 0 }}>
        <div className="relative px-8 pb-8 pt-6">
          <div className="absolute left-12 top-6 bottom-0 w-[2px] bg-[var(--hairline-light)]" />
          {(events || []).map((ev) => (
            <div key={ev.id} className="flex gap-[18px] pb-[18px] relative group">
              <div
                className={`w-3 h-3 rounded-full shrink-0 z-[1] mt-1 ml-[30px]
                ${ev.importance < 3 ? 'bg-[var(--canvas-pop)] shadow-none' : 'bg-[var(--accent-gold)] border-2 border-[var(--canvas)] shadow-[0_0_0_2px_var(--accent-gold-soft-bg)]'}`}
              />
              <div className="font-display text-lg text-[var(--accent-gold)] w-[90px] shrink-0 text-right">
                {ev.year}
              </div>
              <div className="flex-1">
                <div className="text-[15px] text-[var(--ink)] mb-1 flex items-center gap-2">
                  {ev.title}
                  <span className="inline-flex gap-[1px] align-middle">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <span
                        key={star}
                        className="w-2 h-2 rounded-full"
                        style={{ background: star <= ev.importance ? 'var(--accent-gold)' : 'var(--canvas-mid)' }}
                      />
                    ))}
                  </span>
                  {/* 操作按钮常显半透明（不做悬停才显示，见协作约定） */}
                  <span className="ml-auto flex gap-0.5 shrink-0 opacity-60 hover:opacity-100 transition-opacity">
                    <button
                      className="w-6 h-6 flex items-center justify-center rounded text-[var(--ink-mute)] hover:text-[var(--accent-gold)] hover:bg-[var(--canvas-mid)] cursor-pointer border-none bg-transparent"
                      onClick={() => setEditing(ev)}
                      title={t('timeline.editEvent')}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      className="w-6 h-6 flex items-center justify-center rounded text-[var(--ink-mute)] hover:text-[var(--error)] hover:bg-[var(--canvas-mid)] cursor-pointer border-none bg-transparent"
                      onClick={() => setConfirmDeleteId(ev.id)}
                      title={t('timeline.deleteEvent')}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </span>
                </div>
                <div className="text-[13px] text-[var(--ink-tertiary)] leading-[1.6]">{ev.description}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
