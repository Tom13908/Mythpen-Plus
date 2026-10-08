import { HeartHandshake, Link2, Loader, Pencil, Plus, RefreshCcw, Save, Sparkles, Trash2, Users, X } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SimpleCreateDialog } from '@/components/SimpleCreateDialog'
import { useDataRefresh } from '@/hooks/useDataRefresh'
import { useT } from '@/hooks/useT'
import { aiApi, extractAIJsonArray, getAIResponseText, relationsApi } from '@/lib/api'
import { useCharacters, useProjectName, useRelations } from '@/lib/useProjectData'

interface PositionedNode {
  id: string
  name: string
  radius: number
  color: string
  labelColor: string
  fontSize: number
  x: number
  y: number
  chapterCount: number
  /** 角色状态（死亡/隐退/暂离…），空 = 未标注 */
  status: string
  /** 已退场：节点降饱和 + 虚线外环（仍保留在图与历史关系中） */
  retired: boolean
}

interface PositionedLink {
  id: string
  source: string
  target: string
  type: string
  intensity: number
  color: string
  dashed: boolean
  label: string
}

const ROLE_COLORS: Record<string, string> = {
  major: 'var(--accent-gold)',
  minor: 'var(--accent-mist)',
  extra: 'var(--canvas-mid)',
}
const ROLE_LABEL_COLORS: Record<string, string> = {
  major: 'var(--canvas)',
  minor: 'var(--ink)',
  extra: 'var(--ink-secondary)',
}

// 关系线配色：正向(金) / 敌对(橙) / 从属或师承(蓝) / 中性(灰)
const EDGE_COLORS = {
  pos: 'var(--accent-gold)',
  neg: 'var(--accent-ember)',
  mentor: 'var(--info)',
  neutral: 'var(--ink-mute)',
}

const EDGE_POS = [
  '恋人',
  '情侣',
  '夫妻',
  '爱人',
  '伴侣',
  '好友',
  '朋友',
  '盟友',
  '伙伴',
  '搭档',
  '同学',
  '兄妹',
  '姐妹',
  '兄弟',
  '姐弟',
  '亲人',
  '家人',
  '父母',
  '子女',
  '亲属',
  '恩人',
  '救命恩人',
]
const EDGE_NEG = ['宿敌', '仇人', '敌人', '对手', '死对头', '竞争者', '敌对', '背叛', '憎恨', '对立']
const EDGE_MENTOR = [
  '师徒',
  '师父',
  '徒弟',
  '老师',
  '学生',
  '上司',
  '下属',
  '上级',
  '下级',
  '雇主',
  '雇员',
  '主从',
  '附庸',
  '长官',
  '部下',
]

function getEdgeColor(type: string): string {
  const t = type || ''
  if (EDGE_POS.some((k) => t.includes(k))) return EDGE_COLORS.pos
  if (EDGE_NEG.some((k) => t.includes(k))) return EDGE_COLORS.neg
  if (EDGE_MENTOR.some((k) => t.includes(k))) return EDGE_COLORS.mentor
  return EDGE_COLORS.neutral
}

// 退场判定：命中关键词才降饱和，避免"在世"这类状态被误伤
const RETIRED_RE = /死|亡|殁|牺牲|阵亡|遇难|离世|去世|退场|退隐|隐退|失踪|下落不明|退役|淡出/
export function isRetiredStatus(status: string): boolean {
  return !!status && RETIRED_RE.test(status)
}

// ─── Helpers ───
function hash(s: number, i: number) {
  return ((s * 9301 + i * 49297) % 233280) / 233280
}

function computeCircleLayout(
  characters: any[],
  relations: any[],
  seed = 0,
): { nodes: PositionedNode[]; links: PositionedLink[] } {
  const cx = 400,
    cy = 250,
    rx = 260,
    ry = 170
  const count = characters.length
  const maxCh = Math.max(...characters.map((ch) => ch.chapterCount || 0), 1)

  const nodes: PositionedNode[] = characters.map((c, i) => {
    const angle = (i / count) * 2 * Math.PI - Math.PI / 2 + hash(seed, i) * 0.15
    const r = 24 + ((c.chapterCount || 0) / maxCh) * 20
    const ch = c.chapterCount || 0
    const role = ch >= 3 ? 'major' : ch >= 1 ? 'minor' : 'extra'
    const status = c.status || ''
    return {
      id: c.id,
      name: c.name,
      radius: Math.max(22, Math.min(r, 44)),
      color: ROLE_COLORS[role] || ROLE_COLORS.extra,
      labelColor: ROLE_LABEL_COLORS[role] || ROLE_LABEL_COLORS.extra,
      fontSize: r > 32 ? 13 : 11,
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
      chapterCount: ch,
      status,
      retired: isRetiredStatus(status),
    }
  })

  const nodeMap = new Map(characters.map((c) => [c.id, c.name]))

  const links: PositionedLink[] = relations
    .filter((r) => nodeMap.has(r.character_a_id) && nodeMap.has(r.character_b_id))
    .map((r) => ({
      id: r.id,
      source: r.character_a_id,
      target: r.character_b_id,
      type: r.relation_type,
      intensity: r.intensity || 3,
      color: getEdgeColor(r.relation_type),
      dashed: !!r.ended_at,
      label: r.relation_type,
    }))

  return { nodes, links }
}

export function Relations() {
  const { data: characters, loading: charsLoading, reload: reloadChars } = useCharacters()
  const { data: relations, loading: relsLoading, reload: reloadRels } = useRelations()
  // 角色变更（改名/删除/状态）同样影响图的节点与连线，一并重载
  useDataRefresh(['character', 'relation'], () => {
    reloadChars()
    reloadRels()
  })
  const { t } = useT()
  const project = useProjectName()
  const [layoutSeed, setLayoutSeed] = useState(0)
  const [organizing, setOrganizing] = useState(false)
  const [orgMsg, setOrgMsg] = useState('')
  const [editingRelId, setEditingRelId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ relation_type: string; description: string; intensity: string }>({
    relation_type: '',
    description: '',
    intensity: '3',
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // 关系图交互：点线编辑 / 从节点拉线建关系
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [relDialog, setRelDialog] = useState<{ initial: Record<string, string>; editId: string | null } | null>(null)
  const [dragFrom, setDragFrom] = useState<string | null>(null)
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)

  const loading = charsLoading || relsLoading
  const chars = characters || []
  const rels = relations || []

  const { nodes, links } = useMemo(() => computeCircleLayout(chars, rels, layoutSeed), [chars, rels, layoutSeed])
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const relById = useMemo(() => new Map(rels.map((r: any) => [r.id, r])), [rels])

  const handleRelayout = useCallback(() => {
    setLayoutSeed((s) => s + 1)
  }, [])

  const handleOrganize = async () => {
    if (!project) return
    setOrganizing(true)
    setOrgMsg('')
    try {
      const charList = chars
        .map((c: any) => {
          const ch = c.chapterCount || 0
          const role =
            ch >= 3 ? t('relations.roleMajor') : ch >= 1 ? t('relations.roleMinor') : t('relations.roleExtra')
          return `${c.name}（${role}）`
        })
        .join('、')
      const existingRels = rels
        .map((r: any) => {
          const a = chars.find((c: any) => c.id === r.character_a_id)?.name || r.character_a_id
          const b = chars.find((c: any) => c.id === r.character_b_id)?.name || r.character_b_id
          return `${a} → ${b}: ${r.relation_type}`
        })
        .join('\n')

      const res = await aiApi.chat(
        [
          {
            role: 'system',
            content: t('relations.aiPrompt'),
          },
          {
            role: 'user',
            content: t('relations.userPrompt', {
              charList,
              existingRels: existingRels || t('relations.existingRelations'),
            }),
          },
        ],
        project,
      )
      const text = getAIResponseText(res)
      const suggestions = extractAIJsonArray(text)
      if (!suggestions) {
        setOrgMsg(t('relations.aiNoSuggestion'))
        setOrganizing(false)
        return
      }
      let created = 0

      const charMap = new Map(chars.map((c: any) => [c.name, c]))
      const existingPairs = new Set(rels.map((r: any) => [r.character_a_id, r.character_b_id].sort().join(':')))
      const createOps = []
      for (const s of suggestions) {
        const a = charMap.get(s.character_a_name)
        const b = charMap.get(s.character_b_name)
        if (!a || !b) continue
        const pairKey = [a.id, b.id].sort().join(':')
        if (existingPairs.has(pairKey)) continue
        createOps.push(
          relationsApi.create(project, {
            character_a_id: a.id,
            character_b_id: b.id,
            relation_type: s.relation_type,
            description: s.description || '',
            intensity: s.intensity || 3,
          }),
        )
      }
      const results = await Promise.all(createOps)
      created = results.length
      await reloadRels()
      setOrgMsg(created > 0 ? t('relations.createdCount', { n: created }) : t('relations.aiNoNewRelations'))
    } catch (e) {
      console.error('AI organize failed:', e)
      setOrgMsg(t('relations.aiError'))
    }
    setOrganizing(false)
  }

  const startEditRel = (r: any) => {
    setEditingRelId(r.id)
    setDraft({
      relation_type: r.relation_type || '',
      description: r.description || '',
      intensity: String(r.intensity ?? 3),
    })
    setSaveError('')
  }

  const cancelEditRel = () => {
    setEditingRelId(null)
    setSaveError('')
  }

  const handleSaveRel = async () => {
    if (!project || !editingRelId) return
    if (!draft.relation_type.trim()) {
      setSaveError(t('relations.saveFailed'))
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      await relationsApi.update(project, editingRelId, {
        relation_type: draft.relation_type.trim(),
        description: draft.description,
        intensity: parseInt(draft.intensity, 10) || 3,
      })
      await reloadRels()
      setEditingRelId(null)
    } catch (e) {
      console.error('Save relation failed:', e)
      setSaveError(t('relations.saveFailed'))
    }
    setSaving(false)
  }

  const handleDeleteRel = async (id: string) => {
    if (!project) return
    try {
      await relationsApi.delete(project, id)
      await reloadRels()
    } catch (e) {
      console.error('Delete relation failed:', e)
    }
    setConfirmDeleteId(null)
    if (editingRelId === id) setEditingRelId(null)
  }

  // ─── 关系图交互（点线编辑 / 拉线建关系）───
  const openCreateRel = (a = '', b = '') => {
    setRelDialog({ initial: { a, b, intensity: '3' }, editId: null })
  }
  const openEditRel = (r: any) => {
    setRelDialog({
      initial: {
        a: r.character_a_id,
        b: r.character_b_id,
        relation_type: r.relation_type || '',
        description: r.description || '',
        intensity: String(r.intensity ?? 3),
        ended_at: r.ended_at || '',
      },
      editId: r.id,
    })
  }

  const submitRel = async (vals: Record<string, string>) => {
    if (!project) return
    if (!vals.a || !vals.b) throw new Error(t('relations.pickBothError'))
    if (vals.a === vals.b) throw new Error(t('relations.samePairError'))
    const payload = {
      character_a_id: vals.a,
      character_b_id: vals.b,
      relation_type: vals.relation_type.trim(),
      description: vals.description || '',
      intensity: parseInt(vals.intensity, 10) || 3,
      ended_at: (vals.ended_at || '').trim(),
    }
    if (relDialog?.editId) await relationsApi.update(project, relDialog.editId, payload)
    else await relationsApi.create(project, payload)
    await reloadRels()
  }

  // 屏幕坐标 → SVG viewBox 坐标（viewBox 与实际渲染尺寸不同，必须换算）
  const toSvgPoint = (e: React.MouseEvent) => {
    const svg = svgRef.current
    if (!svg) return null
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const loc = pt.matrixTransform(ctm.inverse())
    return { x: loc.x, y: loc.y }
  }

  const handleNodeMouseDown = (e: React.MouseEvent, node: PositionedNode) => {
    e.preventDefault()
    e.stopPropagation()
    setDragFrom(node.id)
    setDragPos({ x: node.x, y: node.y })
  }

  const handleSvgMouseMove = (e: React.MouseEvent) => {
    if (!dragFrom) return
    const p = toSvgPoint(e)
    if (p) setDragPos(p)
  }

  const handleSvgMouseUp = (e: React.MouseEvent) => {
    if (!dragFrom) return
    const p = toSvgPoint(e)
    let target: string | null = null
    if (p) {
      for (const n of nodes) {
        if (Math.hypot(n.x - p.x, n.y - p.y) <= n.radius + 12) {
          target = n.id
          break
        }
      }
    }
    const from = dragFrom
    setDragFrom(null)
    setDragPos(null)
    if (!target || target === from) return
    // 已有关系（任一方向）则打开编辑，避免重复建线
    const existing = rels.find(
      (r: any) =>
        (r.character_a_id === from && r.character_b_id === target) ||
        (r.character_a_id === target && r.character_b_id === from),
    )
    if (existing) openEditRel(existing)
    else openCreateRel(from, target)
  }

  const cancelDrag = () => {
    setDragFrom(null)
    setDragPos(null)
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-[var(--ink-mute)]">{t('common.loading')}</div>
  }

  if (chars.length === 0) {
    return (
      <>
        <div className="page-header">
          <h2 className="flex items-center gap-2">
            <HeartHandshake className="w-5 h-5" /> {t('pages.relationGraph')}
          </h2>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-[var(--ink-tertiary)] gap-3">
          <Users className="w-12 h-12 opacity-30" />
          <p className="text-[15px]">{t('relations.noCharacters')}</p>
        </div>
      </>
    )
  }

  const sortedByChapter = [...chars].sort((a, b) => (b.chapterCount || 0) - (a.chapterCount || 0))
  const relTypeCount = new Map<string, number>()
  rels.forEach((r: any) => relTypeCount.set(r.relation_type, (relTypeCount.get(r.relation_type) || 0) + 1))
  const sortedRelTypes = [...relTypeCount.entries()].sort((a, b) => b[1] - a[1])
  const charNameById = new Map(chars.map((c: any) => [c.id, c.name]))
  const charOptions = chars.map((c: any) => ({ value: c.id, label: c.name }))
  const deleteTarget = confirmDeleteId ? rels.find((r: any) => r.id === confirmDeleteId) : null

  return (
    <>
      <div className="page-header">
        <h2 className="flex items-center gap-2">
          <HeartHandshake className="w-5 h-5" /> {t('pages.relationGraph')}
        </h2>
        <div className="page-header-actions">
          <button
            className="btn-secondary flex items-center gap-1.5"
            style={{ height: 30, padding: '0 14px' }}
            onClick={() => openCreateRel()}
          >
            <Plus className="w-3.5 h-3.5" /> {t('relations.newRelation')}
          </button>
          <button
            className="btn-secondary flex items-center gap-1.5"
            style={{ height: 30, padding: '0 14px' }}
            onClick={handleRelayout}
          >
            <RefreshCcw className="w-3.5 h-3.5" /> {t('pages.reLayout')}
          </button>
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
        {/* Graph */}
        <div className="flex-1 flex items-center justify-center relative overflow-hidden bg-[var(--canvas)]">
          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            viewBox="0 0 800 500"
            preserveAspectRatio="xMidYMid meet"
            style={{ maxHeight: '100%', cursor: dragFrom ? 'crosshair' : 'default' }}
            onMouseMove={handleSvgMouseMove}
            onMouseUp={handleSvgMouseUp}
            onMouseLeave={cancelDrag}
          >
            <defs>
              {links.map((link, i) => {
                const from = nodeById.get(link.source)
                const to = nodeById.get(link.target)
                if (!from || !to) return null
                return (
                  <marker
                    key={`arrow-${i}`}
                    id={`arrow-${i}`}
                    viewBox="0 0 8 8"
                    refX="8"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M0,0 L8,4 L0,8 Z" fill={link.color} />
                  </marker>
                )
              })}
            </defs>

            {/* Edges */}
            {links.map((link, i) => {
              const from = nodeById.get(link.source)
              const to = nodeById.get(link.target)
              if (!from || !to) return null
              const mx = (from.x + to.x) / 2
              const my = (from.y + to.y) / 2 - 14
              const labelW = link.label.length * 7 + 12
              return (
                <g key={`link-${i}`}>
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={link.color}
                    strokeWidth={1 + link.intensity * 0.6}
                    strokeLinecap="round"
                    strokeDasharray={link.dashed ? '6,4' : undefined}
                    markerEnd={`url(#arrow-${i})`}
                    opacity="0.7"
                  />
                  {/* Label background */}
                  <rect
                    x={mx - labelW / 2}
                    y={my - 8}
                    width={labelW}
                    height={16}
                    rx="4"
                    fill="var(--canvas-card)"
                    stroke="var(--hairline)"
                    strokeWidth="0.5"
                  />
                  <text
                    x={mx}
                    y={my + 3}
                    fill="var(--ink-mute)"
                    fontSize="10"
                    fontFamily="Inter,sans-serif"
                    textAnchor="middle"
                  >
                    {link.label}
                  </text>
                  {/* 透明加宽命中线：线太细点不中；点击打开该关系的编辑弹层 */}
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke="transparent"
                    strokeWidth={14}
                    style={{ cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = relById.get(link.id)
                      if (r) openEditRel(r)
                    }}
                  >
                    <title>{t('relations.clickEdgeHint')}</title>
                  </line>
                </g>
              )
            })}

            {/* 拉线预览：从起点节点到当前鼠标位置 */}
            {dragFrom &&
              dragPos &&
              (() => {
                const f = nodeById.get(dragFrom)
                if (!f) return null
                return (
                  <line
                    x1={f.x}
                    y1={f.y}
                    x2={dragPos.x}
                    y2={dragPos.y}
                    stroke="var(--accent-gold)"
                    strokeWidth={2}
                    strokeDasharray="5,4"
                    opacity="0.85"
                    pointerEvents="none"
                  />
                )
              })()}

            {/* Nodes */}
            {nodes.map((node) => (
              <g key={node.id} style={{ cursor: 'pointer' }} onMouseDown={(e) => handleNodeMouseDown(e, node)}>
                {/* Glow for major characters */}
                {node.color === ROLE_COLORS.major && !node.retired && (
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.radius + 4}
                    fill="none"
                    stroke={node.color}
                    strokeWidth="1"
                    opacity="0.3"
                  />
                )}
                {/* 已退场：虚线外环标识；角色仍保留在图与历史关系中（不删除） */}
                {node.retired && (
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.radius + 6}
                    fill="none"
                    stroke="var(--ink-mute)"
                    strokeWidth="1.5"
                    strokeDasharray="4,3"
                    opacity="0.75"
                  />
                )}
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.radius}
                  fill={node.color}
                  opacity={node.retired ? 0.45 : 1}
                  stroke={node.color === ROLE_COLORS.major ? 'var(--accent-gold)' : 'var(--hairline-light)'}
                  strokeWidth={node.color === ROLE_COLORS.major ? 2.5 : 1.5}
                />
                <text
                  x={node.x}
                  y={node.y + 3}
                  fill={node.labelColor}
                  opacity={node.retired ? 0.5 : 1}
                  fontSize={node.fontSize}
                  fontFamily="Noto Serif SC,serif"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  style={{ userSelect: 'none' }}
                >
                  {node.name}
                </text>
                {node.status && (
                  <text
                    x={node.x}
                    y={node.y + node.radius + 11}
                    fill="var(--ink-mute)"
                    fontSize="9"
                    fontFamily="Inter,sans-serif"
                    textAnchor="middle"
                    style={{ userSelect: 'none' }}
                  >
                    {node.status}
                  </text>
                )}
              </g>
            ))}

            {rels.length === 0 && chars.length > 0 && (
              <text
                x="400"
                y="470"
                fill="var(--ink-mute)"
                fontSize="13"
                fontFamily="Inter,sans-serif"
                textAnchor="middle"
              >
                {t('relations.noRelations')}
              </text>
            )}
          </svg>

          {/* Legend */}
          <div className="absolute bottom-3 right-3 bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg p-2.5 text-[11px] shadow-sm">
            <div className="flex items-center gap-1.5 py-0.5">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: ROLE_COLORS.major }} />
              {t('pages.roleMajor')}
            </div>
            <div className="flex items-center gap-1.5 py-0.5">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: ROLE_COLORS.minor }} />
              {t('pages.roleMinor')}
            </div>
            <div className="flex items-center gap-1.5 py-0.5">
              <span className="w-3 h-[2px] shrink-0" style={{ background: EDGE_COLORS.pos }} />
              {t('pages.legendRelationPos')}
            </div>
            <div className="flex items-center gap-1.5 py-0.5">
              <span className="w-3 h-[2px] shrink-0" style={{ background: EDGE_COLORS.neg }} />
              {t('pages.legendRelationNeg')}
            </div>
            <div className="flex items-center gap-1.5 py-0.5">
              <span className="w-3 h-[2px] shrink-0" style={{ background: EDGE_COLORS.mentor }} />
              {t('pages.legendRelationMentor')}
            </div>
            <div className="flex items-center gap-1.5 py-0.5">
              <span className="w-3 h-[2px] shrink-0" style={{ background: EDGE_COLORS.neutral }} />
              {t('pages.legendRelationNeutral')}
            </div>
            <div className="text-[10px] text-[var(--ink-mute)] mt-1 pt-1 border-t border-[var(--hairline)] max-w-[150px]">
              {t('relations.graphHint')}
            </div>
            <div className="text-[10px] text-[var(--ink-mute)] mt-1 pt-1 border-t border-[var(--hairline)]">
              {t('pages.legendWeight')}
            </div>
          </div>
        </div>

        {/* Right panel */}
        <div className="w-[220px] shrink-0 border-l border-[var(--hairline)] p-3 overflow-y-auto custom-scrollbar flex flex-col gap-3">
          {/* AI Organize */}
          <div className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg p-3">
            <button
              className="w-full h-[32px] rounded-lg bg-[var(--accent-gold)] text-[var(--canvas)] text-[12px] font-medium cursor-pointer border-none flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleOrganize}
              disabled={organizing}
            >
              {organizing ? (
                <>
                  <Loader className="w-3.5 h-3.5 animate-spin" /> {t('relations.analyzing')}
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" /> {t('relations.aiOrganize')}
                </>
              )}
            </button>
            {orgMsg && <div className="text-[11px] text-[var(--ink-tertiary)] mt-2 text-center">{orgMsg}</div>}
          </div>

          {/* Character stats */}
          <div className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg p-3">
            <div className="text-[11px] font-medium text-[var(--ink-secondary)] tracking-[0.04em] uppercase mb-2 flex items-center gap-1.5">
              <Users className="w-3 h-3" /> {t('relations.appearsIn')}
            </div>
            {sortedByChapter.slice(0, 8).map((c: any, i) => (
              <div key={i} className="flex justify-between items-center py-[2px] text-[12px]">
                <span className="text-[var(--ink-mute)] truncate max-w-[130px]">{c.name}</span>
                <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">{c.chapterCount || 0}章</span>
              </div>
            ))}
            {chars.length === 0 && (
              <div className="text-[12px] text-[var(--ink-tertiary)] py-2 text-center">{t('common.noData')}</div>
            )}
          </div>

          {/* Relation types */}
          <div className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg p-3">
            <div className="text-[11px] font-medium text-[var(--ink-secondary)] tracking-[0.04em] uppercase mb-2 flex items-center gap-1.5">
              <Link2 className="w-3 h-3" /> {t('relations.relationType')}
            </div>
            {sortedRelTypes.map(([type, count], i) => (
              <div key={i} className="flex justify-between items-center py-[2px] text-[12px]">
                <span className="text-[var(--ink-mute)] truncate max-w-[130px]">{type}</span>
                <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">{count}</span>
              </div>
            ))}
            {rels.length === 0 && (
              <div className="text-[12px] text-[var(--ink-tertiary)] py-2 text-center">{t('relations.listEmpty')}</div>
            )}
          </div>

          {/* Relation list (edit/delete) */}
          <div className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg p-3">
            <div className="text-[11px] font-medium text-[var(--ink-secondary)] tracking-[0.04em] uppercase mb-2 flex items-center gap-1.5">
              <HeartHandshake className="w-3 h-3" /> {t('relations.manageList')}
            </div>
            {rels.length === 0 && (
              <div className="text-[12px] text-[var(--ink-tertiary)] py-2 text-center">{t('relations.listEmpty')}</div>
            )}
            <div className="flex flex-col gap-2">
              {rels.map((r: any) =>
                editingRelId === r.id ? (
                  <div
                    key={r.id}
                    className="border border-[var(--hairline)] rounded-lg p-2 bg-[var(--canvas-soft)] flex flex-col gap-1.5"
                  >
                    <div className="text-[11px] text-[var(--ink-tertiary)] truncate">
                      {charNameById.get(r.character_a_id) || r.character_a_id} ↔{' '}
                      {charNameById.get(r.character_b_id) || r.character_b_id}
                    </div>
                    <input
                      className="form-input h-[26px] text-[12px]"
                      value={draft.relation_type}
                      onChange={(e) => setDraft((d) => ({ ...d, relation_type: e.target.value }))}
                      placeholder={t('relations.relationTypeField')}
                    />
                    <input
                      className="form-input h-[26px] text-[12px]"
                      value={draft.description}
                      onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                      placeholder={t('relations.descriptionField')}
                    />
                    <input
                      type="number"
                      min={1}
                      max={5}
                      className="form-input h-[26px] text-[12px]"
                      value={draft.intensity}
                      onChange={(e) => setDraft((d) => ({ ...d, intensity: e.target.value }))}
                      placeholder={t('relations.intensityField')}
                    />
                    {saveError && <div className="text-[11px] text-[var(--error)]">{saveError}</div>}
                    <div className="flex justify-end gap-1.5 mt-0.5">
                      <button
                        className="w-[24px] h-[24px] rounded-md flex items-center justify-center hover:bg-[var(--canvas-mid)] text-[var(--ink-tertiary)]"
                        onClick={cancelEditRel}
                        title={t('common.cancel')}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                      <button
                        className="w-[24px] h-[24px] rounded-md flex items-center justify-center hover:bg-[var(--canvas-mid)] text-[var(--accent-gold)] disabled:opacity-50"
                        onClick={handleSaveRel}
                        disabled={saving}
                        title={t('common.save')}
                      >
                        <Save className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-1.5 py-1 group border-b border-[var(--hairline)] last:border-0"
                  >
                    <div className="text-[12px] truncate min-w-0">
                      <span className="text-[var(--ink)]">{charNameById.get(r.character_a_id) || '?'}</span>
                      <span className="text-[var(--ink-mute)] mx-1">·{r.relation_type}·</span>
                      <span className="text-[var(--ink)]">{charNameById.get(r.character_b_id) || '?'}</span>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        className="w-[22px] h-[22px] rounded-md flex items-center justify-center hover:bg-[var(--canvas-mid)] text-[var(--ink-tertiary)]"
                        onClick={() => startEditRel(r)}
                        title={t('relations.editRelation')}
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        className="w-[22px] h-[22px] rounded-md flex items-center justify-center hover:bg-[var(--canvas-mid)] text-[var(--error)]"
                        onClick={() => setConfirmDeleteId(r.id)}
                        title={t('relations.deleteRelation')}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      </div>

      {relDialog && (
        <SimpleCreateDialog
          title={relDialog.editId ? t('relations.editRelation') : t('relations.newRelation')}
          fields={[
            { key: 'a', label: t('relations.charA'), type: 'select', options: charOptions, required: true },
            { key: 'b', label: t('relations.charB'), type: 'select', options: charOptions, required: true },
            {
              key: 'relation_type',
              label: t('relations.relationTypeField'),
              required: true,
              placeholder: t('relations.typePlaceholder'),
            },
            {
              key: 'description',
              label: t('relations.descriptionField'),
              type: 'textarea',
              placeholder: t('relations.descPlaceholder'),
            },
            { key: 'intensity', label: t('relations.intensityField'), type: 'number', placeholder: '3' },
            {
              key: 'ended_at',
              label: t('relations.endedAtField'),
              placeholder: t('relations.endedAtPlaceholder'),
            },
          ]}
          initialValues={relDialog.initial}
          submitLabel={relDialog.editId ? t('common.save') : t('common.create')}
          submittingLabel={t('common.saving')}
          onSubmit={submitRel}
          onClose={() => setRelDialog(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={t('relations.deleteConfirmTitle')}
          message={t('relations.deleteConfirmMsg', {
            a: charNameById.get(deleteTarget.character_a_id) || '?',
            b: charNameById.get(deleteTarget.character_b_id) || '?',
            type: deleteTarget.relation_type,
          })}
          onConfirm={() => handleDeleteRel(deleteTarget.id)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </>
  )
}
