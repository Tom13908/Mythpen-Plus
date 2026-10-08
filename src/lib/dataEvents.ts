// Lightweight event bus for cross-store data invalidation.
// AI tool calls modify the DB through the backend; the frontend stores
// need to know when to re-fetch. This lets any store broadcast "entity X
// changed" and any component/store subscribe.

import { useChapterStore } from '@/stores/useChapterStore'
import { useProjectStore } from '@/stores/useProjectStore'

/** Entity types that can be modified by AI tool calls. */
export type EntityType =
  | 'chapter'
  | 'volume'
  | 'character'
  | 'world'
  | 'science'
  | 'foreshadow'
  | 'relation'
  | 'memory'
  | 'timeline'
  | 'stats'
  | 'project'
  | 'chat'
  | 'snapshot'
  | 'all'

export type DataChangeEvent = { entity: EntityType; ids?: (string | number)[]; source?: 'auto' | 'manual' }

type Listener = (event: DataChangeEvent) => void

let listeners: Listener[] = []
let refreshVersion = 0

/** Subscribe to data change events. Returns an unsubscribe function. */
export function onDataChanged(fn: Listener): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

/** Broadcast that data has changed. Any store that cares about `entity` should re-fetch. */
export function notifyDataChanged(entity: EntityType, ids?: (string | number)[]): void {
  const event: DataChangeEvent = { entity, ids, source: 'auto' }
  refreshVersion++
  // Use setTimeout to avoid cascading updates inside a React render cycle
  setTimeout(() => {
    for (const fn of listeners) {
      try {
        fn(event)
      } catch {
        /* guard against listener crashes */
      }
    }
  }, 0)
}

/** Get the current refresh version counter — useful for forcing re-fetch in hooks. */
export function getRefreshVersion(): number {
  return refreshVersion
}

// ═══════════════════════════════════════════════
// Manual Refresh
// ═══════════════════════════════════════════════

/**
 * Last manual refresh timestamp (ms since epoch).
 * Components can use this to decide whether to refetch.
 */
let lastManualRefresh = 0

export function getLastManualRefresh(): number {
  return lastManualRefresh
}

/**
 * Trigger a full manual refresh of all data.
 * Calls every known store's reload method and broadcasts 'all'.
 */
export function refreshAllData(project?: string): Promise<void> {
  lastManualRefresh = Date.now()
  refreshVersion++

  const proj = project || useProjectStore.getState().currentProject

  // Fire all reloads in parallel
  const reloads: Promise<any>[] = []

  if (proj) {
    reloads.push(useChapterStore.getState().loadChapters(proj))

    const currentCh = useChapterStore.getState().currentChapter
    if (currentCh) {
      reloads.push(useChapterStore.getState().loadChapterContent(proj, currentCh.num))
    }
  }

  reloads.push(useProjectStore.getState().loadProjects())

  return Promise.all(reloads).then(() => {
    // Broadcast 'all' for any component using useDataRefresh hook
    const event: DataChangeEvent = { entity: 'all', source: 'manual' }
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        for (const fn of listeners) {
          try {
            fn(event)
          } catch {
            /* noop */
          }
        }
        resolve()
      }, 0)
    })
  })
}

// ═══════════════════════════════════════════════
// AI Tool → Entity mapping
// ═══════════════════════════════════════════════

/**
 * Map an AI tool name to the entity type(s) it modifies.
 * Tools follow the pattern `{verb}_{entity}` — extract the entity part.
 * Read-only tools (list_*, get_*) return null since they don't modify data.
 */

const TOOL_ENTITY_MAP: Record<string, EntityType | EntityType[] | undefined> = {
  // Chapters
  create_chapter: 'chapter',
  update_chapter: 'chapter',
  delete_chapter: 'chapter',
  // Volumes
  create_volume: 'volume',
  update_volume: 'volume',
  delete_volume: 'volume',
  // Characters
  create_character: 'character',
  update_character: 'character',
  delete_character: 'character',
  // Chapter ↔ Character links affect both sides
  set_chapter_character: ['chapter', 'character'],
  remove_chapter_character: ['chapter', 'character'],
  // World
  create_world_entry: 'world',
  update_world_entry: 'world',
  delete_world_entry: 'world',
  // Science
  create_science_entry: 'science',
  delete_science_entry: 'science',
  // Foreshadows
  create_foreshadow: 'foreshadow',
  update_foreshadow: 'foreshadow',
  delete_foreshadow: 'foreshadow',
  // Relations
  create_relation: 'relation',
  update_relation: 'relation',
  delete_relation: 'relation',
  // Memories
  create_memory: 'memory',
  update_memory: 'memory',
  delete_memory: 'memory',
  // Timeline
  create_timeline_event: 'timeline',
  update_timeline_event: 'timeline',
  delete_timeline_event: 'timeline',
  // Clue board：暂无独立页面，AI 增删线索后需要跟着变的是概览/侧栏的线索计数
  create_clue: 'stats',
  update_clue: 'stats',
  delete_clue: 'stats',
  // Project phase
  update_project_phase: 'project',
}

/** Given a list of tool call names, return the set of entity types that were modified. */
export function getModifiedEntities(toolNames: string[]): EntityType[] {
  const entities = new Set<EntityType>()
  for (const name of toolNames) {
    const entity = TOOL_ENTITY_MAP[name]
    if (Array.isArray(entity)) entity.forEach((e) => entities.add(e))
    else if (entity) entities.add(entity)
  }
  return [...entities]
}

/** Given a single tool call name, return the entity type if it modifies data, or null. */
export function getEntityFromTool(toolName: string): EntityType | null {
  const entity = TOOL_ENTITY_MAP[toolName]
  if (!entity) return null
  return Array.isArray(entity) ? entity[0] : entity
}
