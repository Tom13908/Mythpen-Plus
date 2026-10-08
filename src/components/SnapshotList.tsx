// 里程碑快照面板。
//
// 解决的问题：AI 共创会把讨论出来的设定**直接写进项目库**。库里的元素又会进入每一轮
// 提示词，所以开局那批设定不合意时，光在会话里重试只会得到大差不差的结果 ——
// 必须把库本身退回去。这里提供「留住某一刻 / 整份还原到那一刻」。
//
// 两处使用：AI 共创面板的弹出层与仪表盘的卡片。两个实例可能同时挂载，
// 因此本组件**不使用全局 toast**（两个 ToastContainer 会重叠），状态提示一律就地显示。

import { AlertTriangle, Flag, History, Loader, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useT } from '@/hooks/useT'
import { snapshotsApi } from '@/lib/api'
import { notifyDataChanged, onDataChanged, refreshAllData } from '@/lib/dataEvents'
import { useAgentStore } from '@/stores/useAgentStore'
import type { SnapshotMeta, SnapshotStats } from '@/types'

interface Props {
  project: string
  /** 还原成功后触发。侧栏面板用它重跑「加载会话 + 没有就新建」那一段。 */
  onRestored?: () => void
  /** 传入则在右上角显示关闭按钮（弹出层形态用） */
  onClose?: () => void
}

/** 「叙事元素」= 共创会写进库的那些东西。合计为 0 即代表库是干净的，这正是用户想一眼看到的。 */
function narrativeCount(s: SnapshotStats): number {
  return (
    (s.characters || 0) +
    (s.relations || 0) +
    (s.world || 0) +
    (s.science || 0) +
    (s.foreshadows || 0) +
    (s.memories || 0) +
    (s.timeline || 0) +
    (s.clues || 0)
  )
}

function fmtSize(bytes: number): string {
  if (!bytes) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** MM-DD HH:mm；不是今年时带上年份，免得年份久远的里程碑看起来像刚建的。 */
function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`
}

export function SnapshotList({ project, onRestored, onClose }: Props) {
  const { t } = useT()
  const [list, setList] = useState<SnapshotMeta[]>([])
  const [totalBytes, setTotalBytes] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  const [confirmRestore, setConfirmRestore] = useState<SnapshotMeta | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<SnapshotMeta | null>(null)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const fail = useCallback((prefix: string, e: any) => {
    setNotice({ type: 'error', text: `${prefix}${e?.message || String(e)}` })
  }, [])

  const load = useCallback(
    async (silent = false) => {
      if (!project) return
      if (!silent) setLoading(true)
      try {
        const res = await snapshotsApi.list(project)
        setList(res.snapshots || [])
        setTotalBytes(res.totalBytes || 0)
      } catch (e: any) {
        fail(t('snapshots.loadFailed'), e)
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [project, t, fail],
  )

  useEffect(() => {
    void load()
  }, [load])

  // 仪表盘卡片与共创面板弹出层可能同时挂着。任意一侧打了点或还原之后另一侧必须跟上，
  // 否则它会缺掉刚生成的 safety 快照 —— 而那正是用户想「退回去」时需要的凭据。
  // 这里用静默重载：是别人那边变了，不该在本实例闪一次 loading。
  useEffect(() => {
    return onDataChanged((event) => {
      if (event.entity === 'all' || event.entity === 'snapshot') void load(true)
    })
  }, [load])

  const handleCreate = async () => {
    const label = labelDraft.trim()
    if (!project || !label || saving) return
    setSaving(true)
    try {
      await snapshotsApi.create(project, label)
      setNotice({ type: 'success', text: t('snapshots.created', { label }) })
      setCreating(false)
      setLabelDraft('')
      notifyDataChanged('snapshot')
      await load()
    } catch (e: any) {
      fail(t('snapshots.actionFailed'), e)
    } finally {
      setSaving(false)
    }
  }

  const handleRestore = async (snap: SnapshotMeta) => {
    if (!project) return
    setBusyId(snap.id)
    setNotice(null)
    try {
      await snapshotsApi.restore(project, snap.id, t('snapshots.kindSafety'))
      // 会话可能被整库还原一起退掉。先清掉选中态，避免后续消息写到一个已不存在的
      // 会话上；侧栏面板若正挂着，onRestored 会让它重跑「加载会话 + 没有就新建」。
      useAgentStore.setState({ currentSessionId: null, messages: [], sessions: [] })
      await refreshAllData(project)
      onRestored?.()
      await load()
      setNotice({ type: 'success', text: t('snapshots.restored', { label: snap.label }) })
    } catch (e: any) {
      fail(t('snapshots.actionFailed'), e)
    } finally {
      setBusyId(null)
      setConfirmRestore(null)
    }
  }

  const handleDelete = async (snap: SnapshotMeta) => {
    if (!project) return
    setBusyId(snap.id)
    try {
      await snapshotsApi.remove(project, snap.id)
      setNotice({ type: 'success', text: t('snapshots.deleted', { label: snap.label }) })
      notifyDataChanged('snapshot')
      await load()
    } catch (e: any) {
      fail(t('snapshots.actionFailed'), e)
    } finally {
      setBusyId(null)
      setConfirmDelete(null)
    }
  }

  if (!project) return null

  const kindLabel = (k: SnapshotMeta['kind']) =>
    k === 'initial'
      ? t('snapshots.kindInitial')
      : k === 'safety'
        ? t('snapshots.kindSafety')
        : t('snapshots.kindManual')
  const kindColor = (k: SnapshotMeta['kind']) =>
    k === 'initial' ? 'var(--info)' : k === 'safety' ? 'var(--warning)' : 'var(--accent-gold)'

  return (
    <div className="flex flex-col gap-3">
      {/* 头部：标题 + 打点按钮 */}
      <div className="flex items-center gap-2">
        <History className="w-3.5 h-3.5 text-[var(--ink-tertiary)] shrink-0" />
        <span className="font-medium text-[var(--ink)] text-[13px]">{t('snapshots.title')}</span>
        {list.length > 0 && (
          <span className="text-[10px] text-[var(--ink-mute)] font-mono">
            {t('snapshots.totalSize', { size: fmtSize(totalBytes) })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!creating && (
            <button
              className="inline-flex items-center gap-1 h-[24px] px-2 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[11px] text-[var(--ink-secondary)] cursor-pointer hover:border-[var(--accent-gold)] hover:text-[var(--accent-gold)] transition-colors"
              onClick={() => {
                // 预填时间戳而不是「里程碑」这类固定词：列表里多个同名条目等于没有名字，
                // 而时间戳既能区分又自解释，用户想改成语义名可以就地编辑。
                setLabelDraft(fmtTime(new Date().toISOString()))
                setCreating(true)
              }}
              disabled={!!busyId}
            >
              <Plus className="w-3 h-3" />
              {t('snapshots.create')}
            </button>
          )}
          {onClose && (
            <button
              className="w-[24px] h-[24px] flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-tertiary)] cursor-pointer hover:text-[var(--ink)] transition-colors"
              onClick={onClose}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      <p className="text-[11px] text-[var(--ink-mute)] leading-[1.6] -mt-1">{t('snapshots.intro')}</p>

      {/* 新建输入行 */}
      {creating && (
        <div className="flex items-center gap-1.5">
          <input
            className="flex-1 h-[26px] px-2 bg-[var(--canvas-elevated)] border border-[var(--accent-gold)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[12px] outline-none"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate()
              if (e.key === 'Escape') setCreating(false)
            }}
            placeholder={t('snapshots.labelPlaceholder')}
            autoFocus
            disabled={saving}
          />
          <button
            className="h-[26px] px-2.5 rounded-[var(--radius-sm)] border-none bg-[var(--accent-gold)] text-[var(--canvas)] text-[11px] font-medium cursor-pointer disabled:opacity-50"
            onClick={() => void handleCreate()}
            disabled={saving || !labelDraft.trim()}
          >
            {t('snapshots.save')}
          </button>
          <button
            className="h-[26px] px-2.5 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[11px] text-[var(--ink-secondary)] cursor-pointer"
            onClick={() => setCreating(false)}
            disabled={saving}
          >
            {t('snapshots.cancel')}
          </button>
        </div>
      )}

      {/* 就地状态提示（不用全局 toast，见文件头说明） */}
      {notice && (
        <div
          className="text-[11px] px-2 py-1.5 rounded-[var(--radius-sm)] border"
          style={{
            borderColor: notice.type === 'error' ? 'var(--error)' : 'var(--success)',
            color: notice.type === 'error' ? 'var(--error)' : 'var(--success)',
            background: 'var(--canvas-elevated)',
          }}
        >
          {notice.text}
        </div>
      )}

      {/* 列表 */}
      {loading ? (
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--ink-mute)]">
          <Loader className="w-3 h-3 animate-spin" />
          {t('snapshots.loading')}
        </div>
      ) : list.length === 0 ? (
        <div className="text-[11px] text-[var(--ink-mute)] py-1">{t('snapshots.empty')}</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {list.map((snap) => {
            const broken = snap.integrity === 'broken'
            const busy = busyId === snap.id
            return (
              <div
                key={snap.id}
                className="flex items-start gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)]"
              >
                <Flag className="w-3 h-3 mt-[3px] shrink-0" style={{ color: kindColor(snap.kind) }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[12px] text-[var(--ink)] truncate max-w-[160px]" title={snap.label}>
                      {snap.label}
                    </span>
                    <span
                      className="text-[9px] px-1.5 py-[1px] rounded-full border shrink-0"
                      style={{ color: kindColor(snap.kind), borderColor: kindColor(snap.kind) }}
                    >
                      {kindLabel(snap.kind)}
                    </span>
                    {broken && (
                      <span
                        className="text-[9px] px-1.5 py-[1px] rounded-full border inline-flex items-center gap-0.5 shrink-0"
                        style={{ color: 'var(--error)', borderColor: 'var(--error)' }}
                        title={t('snapshots.brokenHint')}
                      >
                        <AlertTriangle className="w-2.5 h-2.5" />
                        {t('snapshots.broken')}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-[var(--ink-mute)] mt-[2px] font-mono">
                    {fmtTime(snap.createdAt)} · {t('snapshots.statChapters', { n: snap.stats?.chapters ?? 0 })} ·{' '}
                    <span
                      title={[
                        t('snapshots.statCharacters', { n: snap.stats?.characters ?? 0 }),
                        t('snapshots.statRelations', { n: snap.stats?.relations ?? 0 }),
                        t('snapshots.statWorld', { n: snap.stats?.world ?? 0 }),
                        t('snapshots.statScience', { n: snap.stats?.science ?? 0 }),
                        t('snapshots.statForeshadows', { n: snap.stats?.foreshadows ?? 0 }),
                        t('snapshots.statMemories', { n: snap.stats?.memories ?? 0 }),
                        t('snapshots.statTimeline', { n: snap.stats?.timeline ?? 0 }),
                        t('snapshots.statClues', { n: snap.stats?.clues ?? 0 }),
                      ].join(' · ')}
                    >
                      {t('snapshots.statElements', { n: narrativeCount(snap.stats || ({} as SnapshotStats)) })}
                    </span>{' '}
                    · {t('snapshots.statChat', { n: snap.stats?.chatSessions ?? 0 })}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="h-[22px] px-2 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-card)] text-[10px] text-[var(--ink-secondary)] cursor-pointer inline-flex items-center gap-1 hover:border-[var(--accent-gold)] hover:text-[var(--accent-gold)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => setConfirmRestore(snap)}
                    disabled={broken || busy || !!busyId}
                    title={broken ? t('snapshots.brokenHint') : t('snapshots.restore')}
                  >
                    {busy ? <Loader className="w-2.5 h-2.5 animate-spin" /> : <RotateCcw className="w-2.5 h-2.5" />}
                    {t('snapshots.restore')}
                  </button>
                  <button
                    className="w-[22px] h-[22px] flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-card)] text-[var(--ink-tertiary)] cursor-pointer hover:text-[var(--error)] hover:border-[var(--error)] transition-colors disabled:opacity-50"
                    onClick={() => setConfirmDelete(snap)}
                    disabled={busy || !!busyId}
                    title={t('snapshots.delete')}
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 还原确认 */}
      {confirmRestore && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[210]"
          onClick={() => setConfirmRestore(null)}
        >
          <div
            className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-xl p-6 w-[420px] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[16px] font-medium text-[var(--ink)] mb-2">{t('snapshots.restoreTitle')}</h3>
            <p className="text-[13px] text-[var(--ink-tertiary)] mb-5 leading-[1.7]">
              {t('snapshots.restoreBody', { label: confirmRestore.label })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="h-[32px] px-4 rounded-lg border border-[var(--hairline-light)] bg-[var(--canvas-elevated)] text-[var(--ink)] text-[13px] cursor-pointer hover:bg-[var(--canvas-mid)]"
                onClick={() => setConfirmRestore(null)}
              >
                {t('snapshots.cancel')}
              </button>
              <button
                className="h-[32px] px-4 rounded-lg bg-[var(--accent-gold)] text-[var(--canvas)] text-[13px] font-medium cursor-pointer border-none hover:brightness-110"
                onClick={() => void handleRestore(confirmRestore)}
              >
                {t('snapshots.restoreConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {confirmDelete && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[210]"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-xl p-6 w-[380px] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[16px] font-medium text-[var(--ink)] mb-2">{t('snapshots.deleteTitle')}</h3>
            <p className="text-[13px] text-[var(--ink-tertiary)] mb-5 leading-[1.7]">
              {t('snapshots.deleteBody', { label: confirmDelete.label })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="h-[32px] px-4 rounded-lg border border-[var(--hairline-light)] bg-[var(--canvas-elevated)] text-[var(--ink)] text-[13px] cursor-pointer hover:bg-[var(--canvas-mid)]"
                onClick={() => setConfirmDelete(null)}
              >
                {t('snapshots.cancel')}
              </button>
              <button
                className="h-[32px] px-4 rounded-lg bg-[var(--error)] text-white text-[13px] font-medium cursor-pointer border-none hover:brightness-110"
                onClick={() => void handleDelete(confirmDelete)}
              >
                {t('snapshots.deleteConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
