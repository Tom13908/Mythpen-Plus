// ─── Project ───
export interface ProjectInfo {
  id: string
  name: string
  iconName: string
  genres: string[]
  mode: 'short-story' | 'medium-novel' | 'long-novel'
  language: string
  wordCount: number
  chapterCount: number
  lastOpened: string
  status: string
}

export interface ProjectMeta {
  name: string
  description: string
  mode: string
  language: string
  version: string
  createdAt: string
  updatedAt: string
  wordCount: number
  authorName: string
  autoConfirm: boolean
  embeddingEnabled: boolean
}

// ─── Chapters ───
export interface Chapter {
  id: number
  volumeId: number
  num: number
  title: string
  outline: string
  content: string
  summary: string
  wordCount: number
  status: 'pending' | 'writing' | 'review' | 'accepted'
  cognitiveFrame: string
  emotionalAnchor: string
  worldTexture: string
  concreteMystery: string
  interpersonalTension: string
  createdAt: string
  updatedAt: string
}

export interface Volume {
  id: number
  sortOrder: number
  title: string
  summary: string
  chapters: Chapter[]
}

// ─── Characters ───
export interface Character {
  id: string
  name: string
  age: string
  gender: string
  appearance: string
  personality: string
  background: string
  motivation: string
  arc: string
  extMarkers: string
  avatar: string
  notes: string
  /** 角色定位，由作者手选：major（主角）/ minor（配角）/ extra（客串）；空 = 未设定 */
  role?: string
  /** 角色当前状态（简短文字）：如"在世"、"死亡"、"隐退"、"暂时离开"；空 = 未标注 */
  status?: string
  chapterCount?: number
  firstChapter?: number | null
  firstVolumeOrder?: number | null
  firstVolumeTitle?: string | null
}

// ─── World ───
export interface WorldEntry {
  id: string
  category: string
  name: string
  description: string
  tags: string
}

// ─── Science ───
export interface ScienceEntry {
  id: string
  label: 'known' | 'extrapolation' | 'hypothesis'
  name: string
  description: string
  references: string
}

// ─── Foreshadow ───
export interface Foreshadow {
  id: string
  title: string
  description: string
  status: 'planted' | 'progressing' | 'resolved' | 'abandoned'
  // 字段名与数据库列一致：API 直接返回 SELECT * 的原始行（未做 camelCase 映射）
  planted_chapter_id?: number | null
  expected_resolve_chapter: number
  resolved_chapter_id?: number | null
  priority: 'low' | 'normal' | 'high'
}

// ─── Memory ───
export interface Memory {
  id: string
  category: 'character' | 'location' | 'item' | 'event' | 'promise' | 'other'
  content: string
  sourceChapterId?: number
  similarity?: number
}

// ─── Character Relation ───
export interface CharacterRelation {
  id: string
  // 字段名与数据库列一致：API 直接返回 SELECT * 的原始行（未做 camelCase 映射）
  character_a_id: string
  character_b_id: string
  relation_type: string
  description: string
  intensity: number
  started_at: string
  ended_at: string
  layout_x?: number
  layout_y?: number
}

// ─── Graph Nodes ───
export interface GraphNode {
  id: string
  name: string
  radius: number
  color: string
  x: number
  y: number
  fixed?: boolean
}

export interface GraphLink {
  source: string
  target: string
  type: string
  intensity: number
  color: string
  dashed: boolean
  label: string
}

// ─── Timeline ───
export interface TimelineEvent {
  id: string
  year: string
  title: string
  description: string
  importance: number
}

// ─── Workflow ───
export type WorkflowPhase = 'idea' | 'setting' | 'outline' | 'writing' | 'review' | 'consistency' | 'export'

// ─── Agent ───
export interface AgentTask {
  taskName: string
  chapterNum?: number
  status: 'idle' | 'running' | 'completed' | 'error' | 'cancelled'
  progress?: number
  inputTokens?: number
  outputTokens?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'ai' | 'system'
  content: string
  toolCalls?: { id: string; name: string; arguments: any; status?: string; result?: any }[]
}

// ─── Settings ───
export interface AIProviderProfile {
  id: string
  name: string
  type: 'openai' | 'openai-response' | 'claude' | 'gemini'
  baseUrl: string
  apiKey: string
  model: string
  /** 该模型的上下文窗口 token 上限（供上下文预算使用） */
  contextLimit: number
  /** 单次请求最大生成 token 数 */
  maxTokens: number
  /** 每章理想字数（0 = 未设置，写作时注入 prompt 作为篇幅目标） */
  targetWords: number
  /** 采样温度（undefined = 未设置，请求不携带该字段，用模型默认值） */
  temperature?: number
  /** 核采样概率（undefined = 未设置，请求不携带该字段，用模型默认值） */
  topP?: number
  /** 探针结果：该供应商是否接受 top_p 参数（null = 未探测） */
  toppSupported?: boolean | null
  /** 思维链语言：'writing' = 用与正文相同的语言思考（模型自动识别）；'default'/未设置 = 不干预，跟随模型默认 */
  reasoningLang?: 'writing' | 'default'
  /** 思考档位：default/未设置 = 不发送（黄金规则）；off = 关闭；low/medium/high = 思考强度 */
  thinkingLevel?: 'default' | 'off' | 'low' | 'medium' | 'high'
}

/**
 * 全局设置。
 *
 * 只存「进程内即用」的偏好：全部落 localStorage。
 * 唯一会写到服务端的是 ui_language（写作语言判定的兜底）
 * 与 http_timeout（适配器超时），其余字段服务端不读。
 */
export interface AppSettings {
  apiKey: string
  apiKeyDeepseek: string
  apiKeyAnthropic: string
  apiKeyOpenai: string
  apiBaseUrl: string
  apiModel: string
  apiType: 'openai' | 'openai-response' | 'claude' | 'gemini'
  /** 界面语言：zh / zh-TW / en / ja / ko / fr / es / ru（见 i18n 的 LANG_OPTIONS） */
  uiLanguage: string
  theme: 'dark' | 'light'
  editorFontSize: number
  editorFontFamily: string
  /** 自动保存间隔（秒）。0 = 关闭自动保存 */
  autoSaveInterval: number
  accentColor: string
  httpTimeout: number
  /** 展示侧开关：是否在 AI 面板显示模型思维链（仅影响展示，不影响请求） */
  showThinking: boolean
}

// ─── Statistics ───
export interface ProjectStats {
  totalWords: number
  chapterCount: number
  acceptedCount: number
  characterCount: number
  relationCount?: number
  foreshadowCount: number
  resolvedForeshadow: number
  overdueForeshadow: number
  worldCount: number
  sciCount: number
  memoryCount?: number
  timelineCount?: number
  volumeCount?: number
  volumes?: { id: number; title: string; sort_order: number; chapter_count: number; word_count: number }[]
  clueUnresolved?: number
  clueResolved?: number
  genres?: string[]
  tokenInput: number
  tokenOutput: number
  currentChapter?: { id: number; num: number; title: string; word_count: number; status: string; content: string }
  chapters: { id: number; num: number; title: string; word_count: number; status: string }[]
  dailyWords: number[]
  targetWords: number
}

// ─── Export ───
export interface ExportRecord {
  id: string
  format: 'txt' | 'markdown' | 'epub' | 'pdf'
  filePath: string
  wordCount: number
  exportedAt: string
}

// ─── Consistency ───
export interface ConsistencyIssue {
  type: 'conflict' | 'timeline' | 'foreshadow' | 'science'
  severity: 'error' | 'warn'
  title: string
  description: string
  location: string
}

// ─── Sidebar ───
export interface SidebarItem {
  id: string
  labelKey: string
  icon: string
  category: 'universal' | 'genre' | 'optional'
  genres: string
  sortOrder: number
  route: string
  enabled: boolean
}

// ─── 里程碑快照 ───

/** 快照时的内容量统计。让界面能直接读出「这一刻有什么」，不必点开才知道。 */
export interface SnapshotStats {
  volumes: number
  chapters: number
  characters: number
  relations: number
  world: number
  science: number
  foreshadows: number
  memories: number
  timeline: number
  clues: number
  chatSessions: number
  chatMessages: number
  wordCount: number
  phase: WorkflowPhase
}

export interface SnapshotMeta {
  id: string
  project: string
  /** initial = 建项目时自动留的初始状态；manual = 手动打点；safety = 还原前自动备份 */
  kind: 'initial' | 'manual' | 'safety'
  label: string
  createdAt: string
  dbBytes: number
  hasCover: boolean
  stats: SnapshotStats
  /** 由列表接口计算得出：库文件缺失或损坏时为 broken，这种快照不可还原 */
  integrity?: 'ok' | 'broken'
}
