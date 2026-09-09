/**
 * 章节定稿自动总结流水线
 *
 * 章节状态变为 accepted（定稿）时触发：异步调用 AI 读取本章正文，
 * 生成章节摘要、提取叙事记忆、记录人物关系变化、推进伏笔状态，
 * 全部写入结构化数据库。这是"上下文压缩"的高质量原料来源——
 * 后续章节的注入只读摘要和变化，不再重读全文。
 *
 * 设计要点：
 * - fire-and-forget：不阻塞写章节的请求，失败保留 summary_pending 标记
 * - 内存去重队列 + 服务启动时扫描补跑（服务重启不丢待总结章节）
 * - 无 API key 时静默跳过（保持 pending，配好 key 后自动补跑）
 */
const db = require('./db');
const { createAIAdapter } = require('./ai-adapter');

const MEMORY_CATEGORIES = ['character', 'location', 'item', 'event', 'promise', 'other'];
const FORESHADOW_STATUSES = ['planted', 'progressing', 'resolved', 'abandoned'];
const MAX_BODY_CHARS = 8000; // 正文截断：足够总结，避免超出窗口

const SUMMARY_PROMPT = `你是小说章节分析器。阅读用户提供的章节正文与故事现状，提取结构化信息，只返回 JSON（不要任何前后缀说明）：

{
  "summary": "本章摘要（2-4句，涵盖主要事件、进展、关键转折）",
  "memories": [
    {"category": "character|location|item|event|promise|other", "content": "对后续情节有影响的叙事记忆，如情节承诺、角色线索、设定关键点"}
  ],
  "relationChanges": [
    {"characterA": "角色A的名字（必须与现有角色名一致）", "characterB": "角色B的名字", "relationType": "如:师徒/恋人/敌人/同事", "intensity": 1-5, "note": "本章关系如何变化（如:从敌对转为合作）"}
  ],
  "foreshadowChanges": [
    {"title": "伏笔标题（必须与现有伏笔标题一致）", "newStatus": "progressing|resolved|abandoned", "note": "本章对它的处理（如:在第N章发挥作用/正式揭示）"}
  ]
}

要求：
- summary 必须基于正文实际内容
- memories 只记录真正重要的，空则给 []
- relationChanges 只在关系发生变化时给出，无变化给 []
- foreshadowChanges 只在伏笔状态变化时给出，无变化给 []
- 不确定的字段留空字符串，不要编造`;

// ─── 内存队列去重 ───
const queue = new Map(); // key: `${project}::${num}`

// 读取 AI 配置（与 index.js getAiConfig 同源，此处独立实现避免循环依赖）
function getAiConfig() {
  const DEFAULTS = {
    apiBaseUrl: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_KEY || '',
    apiModel: 'deepseek-v4-flash',
    apiType: '',
    maxOutputTokens: 4096,
  };
  try {
    const rows = db.dbQuery('SELECT key, value FROM app_settings');
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    return {
      apiBaseUrl: map.api_base_url || DEFAULTS.apiBaseUrl,
      apiKey: map.api_key || DEFAULTS.apiKey,
      apiModel: map.api_model || DEFAULTS.apiModel,
      apiType: map.api_type || DEFAULTS.apiType,
      maxOutputTokens: parseInt(map.max_output_tokens, 10) || DEFAULTS.maxOutputTokens,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// 定稿章节打标记并入队
function markAndEnqueue(projectName, chapterNum) {
  if (!projectName || !chapterNum) return;
  try {
    db.projectExecute(projectName, 'UPDATE chapters SET summary_pending = 1 WHERE num = ?', [chapterNum]);
  } catch (e) {
    return; // 项目不可达，忽略
  }
  enqueue(projectName, chapterNum);
}

function enqueue(projectName, chapterNum) {
  const key = `${projectName}::${chapterNum}`;
  if (queue.has(key)) return;
  queue.set(key, true);
  // 异步执行，绝不阻塞写章节的请求
  setTimeout(() => {
    queue.delete(key);
    runSummary(projectName, chapterNum).catch((err) => {
      console.warn(`[Summarizer] 章节 ${projectName} #${chapterNum} 总结失败:`, err.message || err);
    });
  }, 50);
}

async function runSummary(projectName, chapterNum) {
  const aiConfig = getAiConfig();
  if (!aiConfig.apiKey) {
    // 没配 key：保持 pending，配好 key 后启动补跑
    console.log(`[Summarizer] 无 API key，跳过 ${projectName} #${chapterNum}（保持待总结标记）`);
    return;
  }

  // 读取章节（截断正文）
  const chapter = db.projectGet(projectName, 'SELECT * FROM chapters WHERE num = ?', [chapterNum]);
  if (!chapter) return;
  const body = String(chapter.content || '').slice(0, MAX_BODY_CHARS);

  // 故事现状（供 AI 对照角色名/伏笔标题）
  const chars = db.projectQuery(projectName, 'SELECT name FROM characters').map((c) => c.name);
  const foreshadows = db.projectQuery(projectName, 'SELECT title, status FROM foreshadows').map((f) => `${f.title}(${f.status})`);

  const userPrompt = `## 章节正文（第${chapterNum}章「${chapter.title}」）\n\n${body}\n\n## 现有角色\n${chars.join('、') || '（无）'}\n\n## 现有伏笔\n${foreshadows.join('、') || '（无）'}`;

  const adapter = createAIAdapter(aiConfig.apiModel, aiConfig, aiConfig.apiType);
  const result = await adapter.complete(SUMMARY_PROMPT, [{ role: 'user', content: userPrompt }], null, { temperature: 0.2 });
  if (!result.content) {
    throw new Error('AI 未返回内容');
  }

  const parsed = extractJson(result.content);
  if (!parsed) {
    throw new Error('AI 返回不是有效 JSON');
  }

  await writeSummary(projectName, chapterNum, parsed);
  // 成功：清标记
  db.projectExecute(projectName, 'UPDATE chapters SET summary_pending = 0, updated_at = datetime(\'now\') WHERE num = ?', [chapterNum]);
  console.log(`[Summarizer] ✅ ${projectName} #${chapterNum} 总结完成`);
}

// 从 AI 文本中提取 JSON 对象（容忍代码块/前后缀）
function extractJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function writeSummary(projectName, chapterNum, data) {
  // 1. 章节摘要
  if (data.summary) {
    db.projectExecute(projectName, 'UPDATE chapters SET summary = ? WHERE num = ?', [String(data.summary).trim(), chapterNum]);
  }

  // 2. 叙事记忆
  for (const mem of Array.isArray(data.memories) ? data.memories : []) {
    const category = MEMORY_CATEGORIES.includes(mem.category) ? mem.category : 'other';
    const content = String(mem.content || '').trim();
    if (!content) continue;
    db.projectExecute(
      projectName,
      'INSERT INTO memories (id, category, content, source_chapter_id) VALUES (?, ?, ?, ?)',
      [require('crypto').randomUUID(), category, content, chapterNum],
    );
  }

  // 3. 关系变化：更新当前关系 + 记录快照
  for (const rc of Array.isArray(data.relationChanges) ? data.relationChanges : []) {
    const a = db.projectGet(projectName, 'SELECT id FROM characters WHERE name = ?', [String(rc.characterA || '').trim()]);
    const b = db.projectGet(projectName, 'SELECT id FROM characters WHERE name = ?', [String(rc.characterB || '').trim()]);
    if (!a || !b || a.id === b.id) continue;
    const intensity = Math.max(1, Math.min(5, parseInt(rc.intensity, 10) || 3));
    const note = String(rc.note || '').trim();

    // 更新/插入当前关系
    const existing = db.projectGet(
      projectName,
      'SELECT id FROM character_relations WHERE character_a_id = ? AND character_b_id = ?',
      [a.id, b.id],
    );
    if (existing) {
      db.projectExecute(
        projectName,
        'UPDATE character_relations SET relation_type = ?, description = ?, intensity = ? WHERE id = ?',
        [String(rc.relationType || '').trim(), String(rc.description || '').trim(), intensity, existing.id],
      );
    } else {
      db.projectExecute(
        projectName,
        'INSERT INTO character_relations (id, character_a_id, character_b_id, relation_type, description, intensity) VALUES (?, ?, ?, ?, ?, ?)',
        [require('crypto').randomUUID(), a.id, b.id, String(rc.relationType || '').trim(), String(rc.description || '').trim(), intensity],
      );
    }

    // 快照（变化历史）
    db.projectExecute(
      projectName,
      'INSERT INTO relation_snapshots (chapter_id, character_a_id, character_b_id, relation_type, description, intensity, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [chapterNum, a.id, b.id, String(rc.relationType || '').trim(), String(rc.description || '').trim(), intensity, note],
    );
  }

  // 4. 伏笔推进：更新状态 + 记录变化
  for (const fc of Array.isArray(data.foreshadowChanges) ? data.foreshadowChanges : []) {
    const title = String(fc.title || '').trim();
    const newStatus = FORESHADOW_STATUSES.includes(fc.newStatus) ? fc.newStatus : '';
    if (!title || !newStatus) continue;
    const f = db.projectGet(projectName, 'SELECT id, status FROM foreshadows WHERE title = ?', [title]);
    if (!f || f.status === newStatus) continue;
    db.projectExecute(projectName, 'UPDATE foreshadows SET status = ? WHERE id = ?', [newStatus, f.id]);
    db.projectExecute(
      projectName,
      'INSERT INTO foreshadow_changes (foreshadow_id, chapter_id, old_status, new_status, note) VALUES (?, ?, ?, ?, ?)',
      [f.id, chapterNum, f.status, newStatus, String(fc.note || '').trim()],
    );
  }
}

// 扫描所有项目的待总结章节并补跑（服务启动时调用）
function scanPending() {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = db.getProjectDbPath(''); // 拿目录（带尾随文件名，取 dirname）
    const projectsDir = path.dirname(dir);
    if (!fs.existsSync(projectsDir)) return;
    const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith('.mythpen.db'));
    for (const file of files) {
      const name = file.replace(/\.mythpen\.db$/, '');
      try {
        const rows = db.projectQuery(name, 'SELECT num FROM chapters WHERE summary_pending = 1 ORDER BY num');
        for (const r of rows) enqueue(name, r.num);
      } catch {
        // 项目文件可能损坏或不可读，跳过
      }
    }
    if (queue.size > 0) console.log(`[Summarizer] 发现 ${queue.size} 个待总结章节，开始补跑`);
  } catch (e) {
    console.warn('[Summarizer] 补跑扫描失败:', e.message);
  }
}

module.exports = { markAndEnqueue, scanPending };
