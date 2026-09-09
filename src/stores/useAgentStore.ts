import { create } from 'zustand'
import { chatApi } from '@/lib/api'
import type { AgentTask, ChatMessage } from '@/types'

interface AgentState {
  task: AgentTask
  messages: ChatMessage[]
  sessions: any[]
  currentSessionId: string | null
  isRunning: boolean
  loading: boolean
  // 记录最近一次 loadSessions/loadMessages 是为哪个项目发起的，
  // 响应返回时用它判断结果是否已经过期（项目已经被切换），过期则丢弃。
  _sessionsRequestProject: string | null
  setTask: (task: Partial<AgentTask>) => void
  addMessage: (msg: ChatMessage) => void
  replaceMessageId: (tempId: string, realId: string) => void
  updateMessage: (project: string, messageId: string, content: string) => void
  deleteMessage: (project: string, messageId: string) => void
  loadMessages: (project: string) => Promise<void>
  loadSessions: (project: string) => Promise<void>
  createSession: (project: string, title?: string) => Promise<string>
  switchSession: (project: string, sessionId: string) => Promise<void>
  deleteSession: (project: string, sessionId: string) => Promise<void>
  updateSessionTitle: (project: string, sessionId: string, title: string) => Promise<void>
  cancelTask: () => void
}

export const useAgentStore = create<AgentState>((set, get) => ({
  task: { taskName: '', status: 'idle' },
  messages: [],
  sessions: [],
  currentSessionId: null,
  isRunning: false,
  loading: false,
  _sessionsRequestProject: null,

  setTask: (task) =>
    set((s) => ({
      task: { ...s.task, ...task },
      isRunning:
        task.status === 'running' ? true : task.status === 'completed' || task.status === 'error' ? false : s.isRunning,
    })),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),

  // 后端保存返回真实 UUID 后，把前端临时 id 替换掉，保证后续编辑/删除能命中后端
  replaceMessageId: (tempId, realId) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === tempId ? { ...m, id: realId } : m)) })),

  updateMessage: (project, messageId, content) => {
    set((s) => ({ messages: s.messages.map((m) => (m.id === messageId ? { ...m, content } : m)) }))
    chatApi.updateMessage(project, messageId, content).catch(() => {})
  },

  deleteMessage: (project, messageId) => {
    set((s) => ({ messages: s.messages.filter((m) => m.id !== messageId) }))
    chatApi.deleteMessage(project, messageId).catch(() => {})
  },

  loadMessages: async (project) => {
    if (!project) return
    const sid = get().currentSessionId
    if (!sid) return // nothing to load
    set({ loading: true })
    try {
      const msgs = await chatApi.list(project, sid)
      // Guard: currentSessionId changed (project switch / new session) — discard stale result
      if (get().currentSessionId !== sid) return
      set({ messages: msgs, loading: false })
    } catch {
      set({ messages: [], loading: false })
    }
  },

  loadSessions: async (project) => {
    if (!project) return
    set({ _sessionsRequestProject: project })
    try {
      const sessions = await chatApi.listSessions(project)
      // 项目已经被切走 — 这是过期响应，丢弃，不能覆盖当前项目的 sessions
      if (get()._sessionsRequestProject !== project) return
      set({ sessions })
      // Auto-select first session if none selected (AIPanel will load messages)
      if (!get().currentSessionId && sessions.length > 0) {
        set({ currentSessionId: sessions[0].id })
      }
    } catch {
      if (get()._sessionsRequestProject !== project) return
      set({ sessions: [] })
    }
  },

  createSession: async (project, title?: string) => {
    const session = await chatApi.createSession(project, title)
    set((s) => ({
      sessions: [session, ...s.sessions],
      currentSessionId: session.id,
      messages: [],
    }))
    return session.id
  },

  switchSession: async (project, sessionId) => {
    set({ currentSessionId: sessionId, messages: [], loading: true })
    try {
      const msgs = await chatApi.list(project, sessionId)
      set({ messages: msgs, loading: false })
    } catch {
      set({ messages: [], loading: false })
    }
  },

  deleteSession: async (project, sessionId) => {
    await chatApi.deleteSession(project, sessionId)
    const remaining = get().sessions.filter((s: any) => s.id !== sessionId)
    const newCurrent = get().currentSessionId === sessionId ? remaining[0]?.id || null : get().currentSessionId
    set({
      sessions: remaining,
      currentSessionId: newCurrent,
      messages: newCurrent ? [] : [],
    })
    if (newCurrent) {
      const msgs = await chatApi.list(project, newCurrent)
      set({ messages: msgs })
    }
  },

  updateSessionTitle: async (project, sessionId, title) => {
    await chatApi.updateSession(project, sessionId, title)
    set((s) => ({
      sessions: s.sessions.map((sess: any) => (sess.id === sessionId ? { ...sess, title } : sess)),
    }))
  },

  cancelTask: () => set({ isRunning: false, task: { taskName: '', status: 'idle' } }),
}))
