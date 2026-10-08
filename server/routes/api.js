const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const snapshots = require('../snapshots');
const { markAndEnqueue } = require('../summarizer');

function project(name) {
  // Ensure project DB is accessible
  try { db.getProjectDb(name); } catch(e) { /* will be created on first use */ }
  return name;
}

// ─── Shared helpers ───
function updateRecord(projectName, table, id, body, allowedFields, addUpdatedAt) {
  const fields = []; const params = [];
  const data = body || {};
  for (const key of allowedFields) {
    if (data[key] !== undefined) { fields.push(`${key} = ?`); params.push(data[key]); }
  }
  if (fields.length === 0) return null;
  if (addUpdatedAt) fields.push("updated_at = datetime('now')");
  params.push(id);
  const changes = db.projectExecute(projectName, `UPDATE ${table} SET ${fields.join(', ')} WHERE id = ?`, params);
  return changes;
}

/** 批量校验角色 id 是否仍然存在，返回不存在的 id 列表（用于给出可读的 400 而不是 FK 报错）。 */
function missingCharacters(projectName, ids) {
  const missing = [];
  for (const id of ids) {
    if (!id) continue;
    if (!db.projectGet(projectName, 'SELECT id FROM characters WHERE id = ?', [id])) missing.push(id);
  }
  return missing;
}

// ─── 项目名校验（统一入口）───
// 项目名会直接拼进文件路径（<PROJECTS_DIR>/<name>.mythpen.db）。含 `/` 的名称把落盘
// 路径拆进不存在的子目录 → 防抖落盘 ENOENT 击穿进程，且该项目数据只在内存里、重启即丢
// （2026-09-25 实际发生：项目名 "Common Sense, Luv/Hate"）。
// 挂在 param 钩子上，一次覆盖全部 /:project/... 与 /projects/:name 路由。
function rejectInvalidProjectName(res, name) {
  const v = db.validateProjectName(name);
  if (v.ok) return false;
  res.status(400).json({ error: { code: 'INVALID_PROJECT_NAME', message: v.message, recoverable: true } });
  return true;
}

for (const paramName of ['project', 'name']) {
  router.param(paramName, (req, res, next, value) => {
    if (rejectInvalidProjectName(res, value)) return;
    next();
  });
}

/**
 * 让 recent_projects 与磁盘上的项目库文件对齐（单向补齐）。
 *
 * 实际场景（2026-09-25 亲见）：projects/ 里躺着 我的科幻小说.mythpen.db，但 config.db
 * 是后来重建的 → recent_projects 里没有这条记录 → 项目列表空空如也，用户以为数据没了。
 * 这里只做「磁盘上有、登记里没有 → 补登记」，不做反向删除：登记了却找不到文件时
 * 保留记录不动，交给「删除项目」的正常流程处理，避免误清用户的项目清单。
 */
function syncRecentProjects() {
  const dir = db.getProjectsDir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  const known = new Set(db.dbQuery('SELECT file_path FROM recent_projects').map((r) => r.file_path));
  const SUFFIX = '.mythpen.db';
  for (const file of files) {
    if (!file.endsWith(SUFFIX) || known.has(path.join(dir, file))) continue;
    const filePath = path.join(dir, file);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    const checked = db.validateProjectName(file.slice(0, -SUFFIX.length));
    if (!checked.ok) {
      console.warn(`[Projects] 跳过名称非法的项目库文件: ${file}`);
      continue;
    }
    console.warn(`[Projects] 发现未登记的项目库，已补进项目列表: ${checked.name}`);
    db.dbExecute(
      'INSERT OR REPLACE INTO recent_projects (id, name, file_path, last_opened, word_count) VALUES (?, ?, ?, ?, ?)',
      [checked.name, checked.name, filePath, new Date().toISOString(), 0],
    );
  }
}

// ═══════════════════════════════════════════
// STORAGE LOCATION
// ═══════════════════════════════════════════

router.get('/storage-location', (req, res) => {
  res.json(db.getStorageInfo());
});

router.post('/storage-location', (req, res) => {
  const { newDir } = req.body || {};
  if (!newDir || !newDir.trim()) {
    return res.status(400).json({ error: { message: '新路径不能为空' } });
  }
  try {
    const result = db.migrateStorageLocation(newDir.trim());
    res.json({
      success: true,
      newDir: result.newDir,
      oldDir: result.oldDir,
      message: '迁移完成，旧数据仍保留在原位置，需重启应用以生效。确认新位置数据无误后，可自行删除旧位置的文件。',
    });
  } catch (e) {
    res.status(400).json({ error: { message: e.message || '迁移失败' } });
  }
});

// ═══════════════════════════════════════════
// PROJECTS
// ═══════════════════════════════════════════

router.get('/projects', (req, res) => {
  // 先跟磁盘对齐：补登记「有库文件但没登记」的项目，避免项目列表空着、用户以为数据丢了
  try { syncRecentProjects(); } catch (e) { console.warn('[Projects] 项目列表对齐失败:', e.message); }
  const rows = db.dbQuery('SELECT * FROM recent_projects ORDER BY last_opened DESC');
  const projects = rows.map(r => {
    let status = '刚起步';
    try {
      // 文件不存在时绝不能走 openProjectDb：它把「不存在的项目」当新项目，
      // 在内存里建一个空库、250ms 后落盘 —— 已删除的项目会凭空复活。
      // getProjectDb 早已有这道防线，这里是漏掉的一处。复活出来的空壳库还会被
      // 下一次列表请求当成正常项目统计，用户看到的就是一个 0 章 0 字的项目。
      if (!fs.existsSync(r.file_path)) throw new Error('PROJECT_FILE_MISSING');
      const db2 = db.openProjectDb(r.file_path);
      const meta = {};
      db2.prepare('SELECT key, value FROM project_meta').all().forEach(m => meta[m.key] = m.value);
      const chCount = db2.prepare('SELECT COUNT(*) as c FROM chapters').get().c;
      const genres = db2.prepare('SELECT genre FROM project_genres').all().map(g => g.genre);
      const wordCount = parseInt(meta.word_count || '0');
      const iconMap = { 'sci-fi': 'Rocket', 'fantasy': 'Wand', 'romance': 'Heart', 'history': 'Landmark', 'urban': 'Building', 'power-fantasy': 'Zap', 'biography': 'BookOpen', 'other': 'Scroll' };
      const iconName = genres.map(g => iconMap[g] || 'BookOpen').join(' ');
      const genreLabels = { 'sci-fi': '科幻', 'fantasy': '玄幻', 'romance': '言情', 'history': '历史', 'urban': '都市', 'power-fantasy': '爽文', 'biography': '传记', 'other': '其他' };
      return {
        id: r.id, name: r.name, iconName: iconName || 'BookOpen',
        genres: genres.map(g => genreLabels[g] || g),
        wordCount, chapterCount: chCount, lastOpened: r.last_opened,
        mode: meta.mode || 'medium-novel',
        status: wordCount > 30000 ? '写作中' : wordCount > 5000 ? '进行中' : '刚起步',
      };
    } catch (e) {
      return { id: r.id, name: r.name, iconName: 'BookOpen', genres: [], wordCount: r.word_count || 0, chapterCount: 0, lastOpened: r.last_opened, mode: 'medium-novel', status: '未知' };
    }
  });
  res.json(projects);
});

router.post('/projects', (req, res) => {
  // language 默认 'auto'：写作语言由模型从用户输入自动识别，无需显式指定
  const { name, mode = 'medium-novel', language = 'auto', genres = ['other'] } = req.body || {};
  // 名称是文件路径的一部分，非法字符必须在写盘之前拦掉（校验顺带完成 trim 归一化）
  const checked = db.validateProjectName(name);
  if (!checked.ok) {
    return res.status(400).json({ error: { code: 'INVALID_PROJECT_NAME', message: checked.message, recoverable: true } });
  }
  const projectName = checked.name;

  const filePath = db.getProjectDbPath(projectName);
  if (require('fs').existsSync(filePath)) {
    return res.status(409).json({ error: { code: 'PROJECT_ALREADY_EXISTS', message: `项目"${projectName}"已存在`, recoverable: true } });
  }

  // Create new project DB
  const pdb = db.openProjectDb(filePath);
  const metaInsert = pdb.prepare('INSERT OR REPLACE INTO project_meta (key, value) VALUES (?, ?)');
  const meta = { name: projectName, description: '', mode, language, version: '1', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), word_count: '0', author_name: '佚名', workflow_phase: 'idea' };
  for (const [k, v] of Object.entries(meta)) metaInsert.run(k, v);

  // Default volume
  pdb.prepare("INSERT INTO volumes (id, sort_order, title, summary) VALUES (1, 1, '第一卷', '')").run();

  // Genres
  for (const g of genres) {
    pdb.prepare('INSERT OR IGNORE INTO project_genres (genre) VALUES (?)').run(g);
  }

  // Config
  const config = db.getConfigDb();
  config.prepare('INSERT OR REPLACE INTO recent_projects (id, name, file_path, last_opened, word_count) VALUES (?, ?, ?, ?, ?)').run(projectName, projectName, filePath, new Date().toISOString(), 0);

  // 立刻留一份「初始状态」：此刻库里只有项目名、风格与一个空卷，没有任何会话和叙事元素。
  // 共创会把讨论出的设定直接写进这个库，而库里的元素又进入之后每一轮提示词，所以开局
  // 不合意时光在会话里重试只会得到大差不差的结果 —— 必须能退回这一刻。
  // 失败只告警不阻断建项目：快照是附加能力，不能因为磁盘问题让建项目整个失败。
  try {
    snapshots.createSnapshot(projectName, {
      kind: snapshots.KIND_INITIAL,
      label: snapshots.INITIAL_LABEL,
      unique: true,
    });
  } catch (e) {
    console.warn(`[Projects] 建项目时留初始快照失败 ${projectName}:`, e.message);
  }

  res.json({ name: projectName, filePath, mode, language, genres });
});

router.get('/projects/:name', (req, res) => {
  const { name } = req.params;
  const filePath = db.getProjectDbPath(name);
  if (!require('fs').existsSync(filePath)) {
    return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: `项目"${name}"不存在`, recoverable: true } });
  }
  const pdb = db.openProjectDb(filePath);
  const meta = {};
  pdb.prepare('SELECT key, value FROM project_meta').all().forEach(m => meta[m.key] = m.value);
  const genres = pdb.prepare('SELECT genre FROM project_genres').all().map(g => g.genre);
  res.json({ ...meta, genres, filePath });
});

router.delete('/projects/:name', (req, res) => {
  const { name } = req.params;
  const filePath = db.getProjectDbPath(name);
  db.closeProjectDb(filePath);
  try { require('fs').unlinkSync(filePath); } catch(e) { console.warn(`[Projects] 删除文件失败 ${filePath}:`, e.message); }
  // 快照跟着项目一起删：项目没了之后这些文件再也无法从界面上访问到，
  // 留着只是占磁盘的孤儿数据。
  try { snapshots.deleteAllSnapshots(name); } catch(e) { console.warn(`[Projects] 清理快照失败 ${name}:`, e.message); }
  db.dbExecute('DELETE FROM recent_projects WHERE name = ?', [name]);
  res.json({ success: true });
});

// ─── Sidebar Items (genre-filtered) ───
router.get('/:project/sidebar-items', (req, res) => {
  const pdb = db.getProjectDb(req.params.project);
  try {
    const genres = pdb.prepare('SELECT genre FROM project_genres').all().map((g) => g.genre);
    const items = pdb.prepare('SELECT * FROM sidebar_items WHERE enabled = 1 ORDER BY sort_order').all();
    const filtered = items.filter((item) => {
      if (item.category === 'universal') return true;
      if (item.category === 'genre') {
        const itemGenres = item.genres ? item.genres.split(',').map((s) => s.trim()) : [];
        return genres.some((g) => itemGenres.includes(g));
      }
      return false;
    });
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// ═══════════════════════════════════════════
// CHAPTERS
// ═══════════════════════════════════════════

router.get('/:project/chapters', (req, res) => {
  const rows = db.projectQuery(project(req.params.project),
    'SELECT c.*, v.title as volume_title FROM chapters c JOIN volumes v ON c.volume_id = v.id ORDER BY c.num'
  );
  res.json(rows);
});

router.get('/:project/chapters/:num', (req, res) => {
  const volId = req.query.volume_id ? parseInt(req.query.volume_id) : null;
  const sql = volId
    ? 'SELECT c.*, v.title as volume_title FROM chapters c JOIN volumes v ON c.volume_id = v.id WHERE c.num = ? AND c.volume_id = ?'
    : 'SELECT c.*, v.title as volume_title FROM chapters c JOIN volumes v ON c.volume_id = v.id WHERE c.num = ?';
  const params = volId ? [parseInt(req.params.num), volId] : [parseInt(req.params.num)];
  const row = db.projectGet(project(req.params.project), sql, params);
  if (!row) return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: `章节 ${req.params.num} 不存在`, recoverable: true } });
  res.json(row);
});

router.put('/:project/chapters/:num', (req, res) => {
  const { num } = req.params;
  const { title, content, outline, status, cognitive_frame, emotional_anchor, world_texture, concrete_mystery, interpersonal_tension } = req.body || {};
  const fields = [];
  const params = [];
  if (title !== undefined) { fields.push('title = ?'); params.push(title); }
  if (content !== undefined) { fields.push('content = ?'); params.push(content); }
  if (outline !== undefined) { fields.push('outline = ?'); params.push(outline); }
  if (status !== undefined) { fields.push('status = ?'); params.push(status); }
  if (cognitive_frame !== undefined) { fields.push('cognitive_frame = ?'); params.push(cognitive_frame); }
  if (emotional_anchor !== undefined) { fields.push('emotional_anchor = ?'); params.push(emotional_anchor); }
  if (world_texture !== undefined) { fields.push('world_texture = ?'); params.push(world_texture); }
  if (concrete_mystery !== undefined) { fields.push('concrete_mystery = ?'); params.push(concrete_mystery); }
  if (interpersonal_tension !== undefined) { fields.push('interpersonal_tension = ?'); params.push(interpersonal_tension); }

  if (content !== undefined) {
    // Update word count for Chinese text
    const wc = content.replace(/\s/g, '').length;
    fields.push('word_count = ?');
    params.push(wc);
  }

  fields.push("updated_at = datetime('now')");
  params.push(parseInt(num));

  const sql = `UPDATE chapters SET ${fields.join(', ')} WHERE num = ?`;
  db.projectExecute(project(req.params.project), sql, params);
  db.recalculateWordCount(project(req.params.project));

  // 定稿触发自动总结（fire-and-forget）
  if (status === 'accepted') {
    markAndEnqueue(project(req.params.project), parseInt(num));
  }

  const updated = db.projectGet(project(req.params.project),
    'SELECT * FROM chapters WHERE num = ?', [parseInt(num)]
  );
  res.json(updated);
});

router.post('/:project/chapters', (req, res) => {
  const { title, volume_id = 1, outline = '', status = 'pending', chapter_num } = req.body || {};
  let num;
  if (chapter_num !== undefined) {
    num = chapter_num;
  } else {
    const maxNum = db.projectGet(project(req.params.project), 'SELECT MAX(num) as mx FROM chapters WHERE volume_id = ?', [volume_id]);
    num = (maxNum?.mx || 0) + 1;
  }
  db.projectExecute(project(req.params.project),
    'INSERT INTO chapters (volume_id, num, title, outline, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))',
    [volume_id, num, title, outline, status]
  );
  const created = db.projectGet(project(req.params.project), 'SELECT * FROM chapters WHERE num = ?', [num]);
  res.status(201).json(created);
});

router.delete('/:project/chapters/:num', (req, res) => {
  // volume_id 可选：章节号可能跨卷重复，带上卷号才能精确删除
  const volumeId = req.query.volume_id ? parseInt(req.query.volume_id, 10) : null;
  const changes = volumeId
    ? db.projectExecute(project(req.params.project), 'DELETE FROM chapters WHERE num = ? AND volume_id = ?', [parseInt(req.params.num), volumeId])
    : db.projectExecute(project(req.params.project), 'DELETE FROM chapters WHERE num = ?', [parseInt(req.params.num)]);
  if (changes === 0) return res.status(404).json({ error: { message: `章节 ${req.params.num} 不存在` } });
  db.recalculateWordCount(project(req.params.project));
  res.json({ success: true, deleted_num: parseInt(req.params.num) });
});

router.get('/:project/volumes', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM volumes ORDER BY sort_order');
  for (const v of rows) {
    v.chapters = db.projectQuery(project(req.params.project),
      'SELECT * FROM chapters WHERE volume_id = ? ORDER BY num', [v.id]
    );
  }
  res.json(rows);
});

router.post('/:project/volumes', (req, res) => {
  const { title, summary = '' } = req.body || {};
  const pdb = db.getProjectDb(project(req.params.project));
  const max = pdb.prepare('SELECT COALESCE(MAX(sort_order), 0) as mx FROM volumes').get();
  const sortOrder = (max?.mx || 0) + 1;
  pdb.prepare("INSERT INTO volumes (sort_order, title, summary, created_at) VALUES (?, ?, ?, datetime('now'))").run(sortOrder, title, summary);
  // sql.js 的 run() 不返回 lastInsertRowid，按 sort_order 回查新卷 id
  const row = pdb.prepare('SELECT id FROM volumes WHERE sort_order = ?').get(sortOrder);
  res.status(201).json({ id: row?.id, title });
});

router.put('/:project/volumes/:id', (req, res) => {
  const changes = updateRecord(project(req.params.project), 'volumes', req.params.id, req.body, ['title', 'summary'], false);
  if (changes === null) return res.status(400).json({ error: { message: '没有要更新的字段' } });
  if (changes === 0) return res.status(404).json({ error: { message: '卷不存在' } });
  res.json({ success: true });
});

router.delete('/:project/volumes/:id', (req, res) => {
  const { id } = req.params;
  db.projectExecute(project(req.params.project), 'DELETE FROM chapters WHERE volume_id = ?', [id]);
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM volumes WHERE id = ?', [id]);
  if (changes === 0) return res.status(404).json({ error: { message: '卷不存在' } });
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// CHARACTERS
// ═══════════════════════════════════════════

router.get('/:project/characters', (req, res) => {
  const chars = db.projectQuery(project(req.params.project), 'SELECT * FROM characters ORDER BY name');
  // Add chapter count + first appearance chapter (with its volume)
  for (const c of chars) {
    const cc = db.projectGet(project(req.params.project),
      'SELECT COUNT(*) as cnt FROM chapter_characters WHERE character_id = ?', [c.id]
    );
    c.chapterCount = cc?.cnt || 0;
    const first = db.projectGet(project(req.params.project),
      `SELECT ch.num as num, v.sort_order as volumeOrder, v.title as volumeTitle
       FROM chapter_characters cc
       JOIN chapters ch ON cc.chapter_id = ch.id
       JOIN volumes v ON ch.volume_id = v.id
       WHERE cc.character_id = ?
       ORDER BY v.sort_order, ch.num LIMIT 1`, [c.id]
    );
    c.firstChapter = first?.num ?? null;
    c.firstVolumeOrder = first?.volumeOrder ?? null;
    c.firstVolumeTitle = first?.volumeTitle ?? null;
  }
  res.json(chars);
});

router.get('/:project/characters/:id', (req, res) => {
  const row = db.projectGet(project(req.params.project), 'SELECT * FROM characters WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: '角色不存在', recoverable: true } });
  res.json(row);
});

router.post('/:project/characters', (req, res) => {
  const { name, age = '', gender = '', appearance = '', personality = '', background = '', motivation = '', arc = '', ext_markers = '', status = '' } = req.body || {};
  if (!name) return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '角色名不能为空', recoverable: true } });
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO characters (id, name, age, gender, appearance, personality, background, motivation, arc, ext_markers, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, age, gender, appearance, personality, background, motivation, arc, ext_markers, status]
  );
  res.status(201).json({ id, name });
});

router.put('/:project/characters/:id', (req, res) => {
  const { id } = req.params;
  const fields = []; const params = [];
  for (const key of ['name', 'age', 'gender', 'appearance', 'personality', 'background', 'motivation', 'arc', 'ext_markers', 'notes', 'status']) {
    if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  }
  if (fields.length === 0) return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '没有要更新的字段', recoverable: true } });
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.projectExecute(project(req.params.project), `UPDATE characters SET ${fields.join(', ')} WHERE id = ?`, params);
  res.json({ success: true });
});

router.delete('/:project/characters/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM characters WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '角色不存在' } });
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// WORLD ENTRIES
// ═══════════════════════════════════════════

router.get('/:project/world', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM world_entries ORDER BY category, name');
  res.json(rows);
});

router.post('/:project/world', (req, res) => {
  const { category, name, description = '', tags = '[]' } = req.body || {};
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO world_entries (id, category, name, description, tags) VALUES (?, ?, ?, ?, ?)',
    [id, category, name, description, tags]
  );
  res.status(201).json({ id, name });
});

router.put('/:project/world/:id', (req, res) => {
  const changes = updateRecord(project(req.params.project), 'world_entries', req.params.id, req.body, ['category', 'name', 'description', 'tags'], true);
  if (changes === null) return res.status(400).json({ error: { message: '没有要更新的字段' } });
  if (changes === 0) return res.status(404).json({ error: { message: '条目不存在' } });
  res.json({ success: true });
});

router.delete('/:project/world/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM world_entries WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '条目不存在' } });
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// SCIENCE ENTRIES
// ═══════════════════════════════════════════

router.get('/:project/science', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM science_entries ORDER BY label, name');
  res.json(rows);
});

router.post('/:project/science', (req, res) => {
  const { label, name, description = '', references = '' } = req.body || {};
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO science_entries (id, label, name, description, "references") VALUES (?, ?, ?, ?, ?)',
    [id, label, name, description, references]
  );
  res.status(201).json({ id, name });
});

router.delete('/:project/science/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM science_entries WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '条目不存在' } });
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// FORESHADOWS
// ═══════════════════════════════════════════

router.get('/:project/foreshadows', (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM foreshadows';
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY created_at';
  const rows = db.projectQuery(project(req.params.project), sql, params);
  res.json(rows);
});

router.post('/:project/foreshadows', (req, res) => {
  const { title, description = '', status = 'planted', priority = 'normal', expected_resolve_chapter = 0 } = req.body || {};
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO foreshadows (id, title, description, status, priority, expected_resolve_chapter) VALUES (?, ?, ?, ?, ?, ?)',
    [id, title, description, status, priority, expected_resolve_chapter]
  );
  res.status(201).json({ id, title });
});

router.put('/:project/foreshadows/:id', (req, res) => {
  const changes = updateRecord(project(req.params.project), 'foreshadows', req.params.id, req.body, ['title', 'description', 'status', 'priority', 'expected_resolve_chapter'], true);
  if (changes === null) return res.status(400).json({ error: { message: '没有要更新的字段' } });
  if (changes === 0) return res.status(404).json({ error: { message: '伏笔不存在' } });
  res.json({ success: true });
});

router.delete('/:project/foreshadows/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM foreshadows WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '伏笔不存在' } });
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// CHARACTER RELATIONS
// ═══════════════════════════════════════════

router.get('/:project/relations', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM character_relations');
  res.json(rows);
});

router.post('/:project/relations', (req, res) => {
  const { character_a_id, character_b_id, relation_type, description = '', intensity = 3, ended_at = '' } = req.body || {};
  if (!character_a_id || !character_b_id) {
    return res.status(400).json({ error: { message: '必须指定关系两端的角色', recoverable: true } });
  }
  if (character_a_id === character_b_id) {
    return res.status(400).json({ error: { message: '关系的两端不能是同一个角色', recoverable: true } });
  }
  const bad = missingCharacters(project(req.params.project), [character_a_id, character_b_id]);
  if (bad.length > 0) {
    return res.status(400).json({ error: { message: `角色不存在：${bad.join('、')}`, recoverable: true } });
  }
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO character_relations (id, character_a_id, character_b_id, relation_type, description, intensity, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, character_a_id, character_b_id, relation_type, description, intensity, ended_at]
  );
  res.status(201).json({ id });
});

router.put('/:project/relations/:id', (req, res) => {
  const body = req.body || {};
  // 允许改关系两端：前端编辑弹窗会一并提交角色，此前这两个字段不在 allowed 里，
  // 于是「改了角色 → 提示保存成功 → 重新加载后角色没变」。
  if (body.character_a_id !== undefined && body.character_b_id !== undefined
      && body.character_a_id === body.character_b_id) {
    return res.status(400).json({ error: { message: '关系的两端不能是同一个角色', recoverable: true } });
  }
  const ids = [body.character_a_id, body.character_b_id].filter(Boolean);
  const bad = missingCharacters(project(req.params.project), ids);
  if (bad.length > 0) {
    return res.status(400).json({ error: { message: `角色不存在：${bad.join('、')}`, recoverable: true } });
  }
  const changes = updateRecord(project(req.params.project), 'character_relations', req.params.id, body,
    ['character_a_id', 'character_b_id', 'relation_type', 'description', 'intensity', 'started_at', 'ended_at'], false);
  if (changes === null) return res.status(400).json({ error: { message: '没有要更新的字段' } });
  if (changes === 0) return res.status(404).json({ error: { message: '关系不存在' } });
  res.json({ success: true });
});

router.delete('/:project/relations/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM character_relations WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '关系不存在' } });
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// MEMORIES
// ═══════════════════════════════════════════

router.get('/:project/memories', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM memories ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/:project/memories', (req, res) => {
  const { category, content, source_chapter_id } = req.body || {};
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO memories (id, category, content, source_chapter_id) VALUES (?, ?, ?, ?)',
    [id, category, content, source_chapter_id || null]
  );
  res.status(201).json({ id });
});

router.put('/:project/memories/:id', (req, res) => {
  const changes = updateRecord(project(req.params.project), 'memories', req.params.id, req.body, ['category', 'content'], false);
  if (changes === null) return res.status(400).json({ error: { message: '没有要更新的字段' } });
  if (changes === 0) return res.status(404).json({ error: { message: '记忆不存在' } });
  res.json({ success: true });
});

router.delete('/:project/memories/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM memories WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '记忆不存在' } });
  res.json({ success: true });
});

// ─── Memory Search ───
router.post('/:project/memories/search', (req, res) => {
  const pn = project(req.params.project);
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: { message: '缺少搜索关键词' } });
  const rows = db.projectQuery(pn,
    "SELECT * FROM memories WHERE content LIKE ? ORDER BY created_at DESC LIMIT 20",
    [`%${query}%`]
  );
  res.json(rows);
});

// ═══════════════════════════════════════════
// TIMELINE
// ═══════════════════════════════════════════

router.get('/:project/timeline', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM timeline_events ORDER BY year');
  res.json(rows);
});

router.post('/:project/timeline', (req, res) => {
  const { year, title, description = '', importance = 3 } = req.body || {};
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO timeline_events (id, year, title, description, importance) VALUES (?, ?, ?, ?, ?)',
    [id, year, title, description, importance]
  );
  res.status(201).json({ id, title });
});

router.put('/:project/timeline/:id', (req, res) => {
  const changes = updateRecord(project(req.params.project), 'timeline_events', req.params.id, req.body, ['year', 'title', 'description', 'importance'], false);
  if (changes === null) return res.status(400).json({ error: { message: '没有要更新的字段' } });
  if (changes === 0) return res.status(404).json({ error: { message: '事件不存在' } });
  res.json({ success: true });
});

router.delete('/:project/timeline/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM timeline_events WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '事件不存在' } });
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// SETTINGS (global)
// ═══════════════════════════════════════════

router.get('/settings', (req, res) => {
  const rows = db.dbQuery('SELECT key, value FROM app_settings');
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  // Fill in effective API key from env/fallback if DB entry is empty
  if (!settings.api_key) {
    settings.api_key = process.env.DEEPSEEK_KEY || '';
  }
  if (!settings.api_base_url) {
    settings.api_base_url = 'https://api.deepseek.com/v1';
  }
  if (!settings.api_model) {
    settings.api_model = 'deepseek-v4-flash';
  }
  res.json(settings);
});

router.put('/settings', (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '缺少key', recoverable: true } });
  db.dbExecute('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, String(value)]);
  // Invalidate AI config cache so next AI request picks up the change
  if (db.invalidateAiConfigCache) db.invalidateAiConfigCache();
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// PROJECT META
// ═══════════════════════════════════════════

router.get('/:project/meta', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT key, value FROM project_meta');
  const meta = {};
  for (const r of rows) meta[r.key] = r.value;
  meta.genres = db.projectQuery(project(req.params.project), 'SELECT genre FROM project_genres').map(g => g.genre);
  res.json(meta);
});

// ═══════════════════════════════════════════
// WORKFLOW PHASE
// ═══════════════════════════════════════════

router.get('/:project/workflow/phase', (req, res) => {
  const row = db.projectGet(project(req.params.project),
    "SELECT value FROM project_meta WHERE key = 'workflow_phase'"
  );
  res.json({ phase: row?.value || 'idea' });
});

router.put('/:project/workflow/phase', (req, res) => {
  const { phase } = req.body || {};
  const valid = ['idea', 'setting', 'outline', 'writing', 'review', 'consistency', 'export'];
  if (!phase || !valid.includes(phase)) {
    return res.status(400).json({ error: { message: `Invalid phase. Must be one of: ${valid.join(', ')}` } });
  }
  db.projectExecute(project(req.params.project),
    "INSERT OR REPLACE INTO project_meta (key, value) VALUES ('workflow_phase', ?)", [phase]
  );
  res.json({ success: true, phase });
});

// ═══════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════

router.get('/:project/stats', (req, res) => {
  const pn = project(req.params.project);
  const totalWords = db.projectGet(pn, 'SELECT SUM(word_count) as total FROM chapters')?.total || 0;
  const chCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM chapters')?.cnt || 0;
  const acceptedCount = db.projectGet(pn, "SELECT COUNT(*) as cnt FROM chapters WHERE status = 'accepted'")?.cnt || 0;
  const charCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM characters')?.cnt || 0;
  const foreshadowCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM foreshadows')?.cnt || 0;
  const resolvedForeshadow = db.projectGet(pn, "SELECT COUNT(*) as cnt FROM foreshadows WHERE status = 'resolved'")?.cnt || 0;
  const overdueForeshadow = db.projectGet(pn, "SELECT COUNT(*) as cnt FROM foreshadows WHERE status = 'planted' AND expected_resolve_chapter < (SELECT COALESCE(MAX(num), 0) FROM chapters)")?.cnt || 0;
  const worldCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM world_entries')?.cnt || 0;
  const sciCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM science_entries')?.cnt || 0;
  const relCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM character_relations')?.cnt || 0;
  const memCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM memories')?.cnt || 0;
  const tlCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM timeline_events')?.cnt || 0;
  const volCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM volumes')?.cnt || 0;
  const clueUnresolved = db.projectGet(pn, "SELECT COUNT(*) as cnt FROM clue_board WHERE resolved = 0")?.cnt || 0;
  const clueResolved = db.projectGet(pn, "SELECT COUNT(*) as cnt FROM clue_board WHERE resolved = 1")?.cnt || 0;
  const genres = db.projectQuery(pn, 'SELECT genre FROM project_genres').map(g => g.genre);
  const tokenUsage = db.projectGet(pn, 'SELECT COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output FROM token_usage') || { input: 0, output: 0 };

  // Target words: custom override or fallback to project mode default
  const projectMode = db.projectGet(pn, "SELECT value FROM project_meta WHERE key = 'mode'")?.value || 'medium-novel';
  const TARGET_WORDS = { 'short-story': 30000, 'medium-novel': 100000, 'long-novel': 200000 };
  const customTarget = db.projectGet(pn, "SELECT value FROM project_meta WHERE key = 'target_words'")?.value;
  const targetWords = customTarget ? parseInt(customTarget) : (TARGET_WORDS[projectMode] || 100000);

  // Volume structure summary
  const volumes = db.projectQuery(pn, 'SELECT id, title, sort_order, (SELECT COUNT(*) FROM chapters WHERE volume_id = volumes.id) as chapter_count, (SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE volume_id = volumes.id) as word_count FROM volumes ORDER BY sort_order');

  // Daily word counts for sparkline (last 7 days)
  const rawDaily = db.projectQuery(pn,
    "SELECT date(updated_at) as day, SUM(word_count) as words FROM chapters WHERE updated_at >= date('now', '-6 days') GROUP BY date(updated_at) ORDER BY day"
  );
  const dailyMap = {};
  for (const r of rawDaily) dailyMap[r.day] = r.words;
  const dailyWords = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyWords.push(dailyMap[key] || 0);
  }

  res.json({
    totalWords, chapterCount: chCount, acceptedCount, characterCount: charCount,
    foreshadowCount, resolvedForeshadow, overdueForeshadow, worldCount, sciCount,
    relationCount: relCount, memoryCount: memCount, timelineCount: tlCount,
    volumeCount: volCount, volumes,
    clueUnresolved, clueResolved,
    genres,
    tokenInput: tokenUsage.input || 0, tokenOutput: tokenUsage.output || 0,
    targetWords,
    currentChapter: db.projectGet(pn, "SELECT * FROM chapters WHERE status = 'writing' ORDER BY num LIMIT 1"),
    chapters: db.projectQuery(pn, 'SELECT id, num, title, word_count, status FROM chapters ORDER BY num'),
    dailyWords,
    });
  });

// ─── Genres ───

router.post('/:project/genres', (req, res) => {
  const pn = project(req.params.project);
  const { genre } = req.body || {};
  if (!genre || !genre.trim()) return res.status(400).json({ error: { message: '关键词不能为空' } });
  db.projectExecute(pn, 'INSERT OR IGNORE INTO project_genres (genre) VALUES (?)', [genre.trim()]);
  res.status(201).json({ success: true });
});

router.delete('/:project/genres/:genre', (req, res) => {
  const pn = project(req.params.project);
  const changes = db.projectExecute(pn, 'DELETE FROM project_genres WHERE genre = ?', [req.params.genre]);
  if (changes === 0) return res.status(404).json({ error: { message: '关键词不存在' } });
  res.json({ success: true });
});

// ─── Target words ───

router.put('/:project/target-words', (req, res) => {
  const pn = project(req.params.project);
  const { targetWords } = req.body;
  if (typeof targetWords !== 'number' || targetWords < 1000) {
    return res.status(400).json({ error: { message: 'targetWords must be a number ≥ 1000' } });
  }
  db.projectExecute(pn,
    "INSERT OR REPLACE INTO project_meta (key, value) VALUES ('target_words', ?)", [String(targetWords)]
  );
  res.json({ success: true, targetWords });
});

router.delete('/:project/target-words', (req, res) => {
  const pn = project(req.params.project);
  db.projectExecute(pn, "DELETE FROM project_meta WHERE key = 'target_words'");
  // Return the mode-based default
  const projectMode = db.projectGet(pn, "SELECT value FROM project_meta WHERE key = 'mode'")?.value || 'medium-novel';
  const TARGET_WORDS = { 'short-story': 30000, 'medium-novel': 100000, 'long-novel': 200000 };
  res.json({ success: true, targetWords: TARGET_WORDS[projectMode] || 100000 });
});

// ═══════════════════════════════════════════
// TOKEN USAGE
// ═══════════════════════════════════════════

router.get('/:project/tokens', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM token_usage ORDER BY created_at DESC LIMIT 50');
  res.json(rows);
});

// ═══════════════════════════════════════════
// COVER IMAGE
// ═══════════════════════════════════════════

router.post('/:project/cover', (req, res) => {
  const pn = project(req.params.project);
  const { data, mime } = req.body || {};
  if (!data) return res.status(400).json({ error: { message: '缺少图片数据' } });
  const coverDir = db.getCoverDir(pn);
  if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
  const ext = db.MIME_TO_EXT[mime || 'image/png'] || 'png';
  const coverPath = path.join(coverDir, `cover.${ext}`);
  fs.writeFileSync(coverPath, Buffer.from(data, 'base64'));
  db.projectExecute(pn, "INSERT OR REPLACE INTO project_meta (key, value) VALUES ('cover_mime', ?)", [mime || 'image/png']);
  db.projectExecute(pn, "INSERT OR REPLACE INTO project_meta (key, value) VALUES ('cover_ext', ?)", [ext]);
  res.json({ success: true, ext, mime: mime || 'image/png' });
});

router.get('/:project/cover', (req, res) => {
  const pn = project(req.params.project);
  const coverPath = db.findCoverPath(pn);
  if (coverPath) {
    const ext = path.extname(coverPath).slice(1);
    res.setHeader('Content-Type', db.EXT_TO_MIME[ext] || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    return res.end(fs.readFileSync(coverPath));
  }
  res.status(404).json({ error: { message: '未上传封面' } });
});

router.delete('/:project/cover', (req, res) => {
  const pn = project(req.params.project);
  const coverPath = db.findCoverPath(pn);
  if (coverPath) {
    fs.unlinkSync(coverPath);
    db.projectExecute(pn, "DELETE FROM project_meta WHERE key IN ('cover_mime', 'cover_ext')");
    res.json({ success: true });
  } else {
    res.status(404).json({ error: { message: '未上传封面' } });
  }
});

// ═══════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════

router.get('/:project/export', async (req, res) => {
  const { format = 'txt' } = req.query;
  const pn = project(req.params.project);
  const chapters = db.projectQuery(pn, "SELECT num, title, content, volume_id FROM chapters WHERE content != '' ORDER BY num");
  const volumes = db.projectQuery(pn, 'SELECT * FROM volumes ORDER BY sort_order');
  const meta = {};
  db.projectQuery(pn, 'SELECT key, value FROM project_meta').forEach(m => meta[m.key] = m.value);

  const totalWords = chapters.reduce((s, c) => s + (c.content?.replace(/\s/g, '').length || 0), 0);
  const EXPORT_DIR = db.getExportsDir(pn);
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

  // Find cover image
  const coverPath = db.findCoverPath(pn);
  const coverBase64 = coverPath ? fs.readFileSync(coverPath).toString('base64') : null;
  const coverMime = coverPath ? (db.EXT_TO_MIME[path.extname(coverPath).slice(1)] || 'image/png') : null;

  let ext = 'txt';
  let mime = 'text/plain; charset=utf-8';
  let output;
  let filename;

  if (format === 'epub') {
    // ── EPUB with cover ──
    ext = 'epub';
    mime = 'application/epub+zip';
    filename = `${pn}.epub`;

    const EpubGen = require('epub-gen');

    // Build content grouped by volume
    const volumeMap = new Map();
    for (const v of volumes) volumeMap.set(v.id, v);
    const volChapters = new Map();
    for (const ch of chapters) {
      const vId = ch.volume_id || 1;
      if (!volChapters.has(vId)) volChapters.set(vId, []);
      volChapters.get(vId).push(ch);
    }

    const content = [];

    for (const [vId, vchs] of volChapters) {
      const vol = volumeMap.get(vId);
      if (volumes.length > 1 && vol) {
        content.push({
          title: vol.title,
          data: `<h2>第${vol.sort_order}卷 ${vol.title}</h2>${vol.summary ? `<p>${vol.summary}</p>` : ''}`,
        });
      }
      for (const ch of vchs) {
        const displayTitle = ch.title.startsWith('第') ? ch.title : `第${ch.num}章 ${ch.title}`;
        content.push({
          title: ch.title,
          data: `<h1>${displayTitle}</h1>${ch.content}`,
        });
      }
    }

    const epubPath = path.join(EXPORT_DIR, filename);
    const epubOptions = {
      title: meta.name || pn,
      author: meta.author_name || '佚名',
      publisher: 'Mythpen',
      cover: coverPath || undefined,
      output: epubPath,
      content,
    };
    await new EpubGen(epubOptions).promise;

    if (req.query.download === '1' || req.query.download === 'true') {
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      return res.end(fs.readFileSync(epubPath));
    }
    return res.json({ success: true, format: 'epub', filePath: epubPath, wordCount: totalWords, chapterCount: chapters.length, filename });

  } else if (format === 'html') {
    // ── HTML with cover (for save-as-PDF) ──
    ext = 'html';
    mime = 'text/html; charset=utf-8';
    filename = `${pn}.html`;

    let coverHtml = '';
    if (coverPath) {
      coverHtml = `<div class="cover-page"><img src="data:${coverMime};base64,${coverBase64}" alt="封面"></div>`;
    }

    output = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${meta.name || pn}</title>
<style>
  @page { margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Noto Serif SC', 'Songti SC', serif; color: #333; background: #fff; line-height: 1.8; }
  .cover-page { page-break-after: always; text-align: center; padding: 20px; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .cover-page img { max-width: 100%; max-height: 90vh; object-fit: contain; box-shadow: 0 4px 20px rgba(0,0,0,0.15); }
  .toc-page { page-break-after: always; padding: 40px; }
  .toc-page h1 { text-align: center; font-size: 24px; margin-bottom: 30px; }
  .toc-page ul { list-style: none; padding: 0; max-width: 500px; margin: 0 auto; }
  .toc-page li { padding: 8px 0; border-bottom: 1px solid #eee; font-size: 16px; }
  .chapter { page-break-after: always; padding: 40px; max-width: 700px; margin: 0 auto; }
  .chapter h1 { font-size: 22px; text-align: center; margin-bottom: 30px; padding-bottom: 15px; border-bottom: 2px solid #333; }
  .chapter p { text-indent: 2em; margin-bottom: 0.8em; font-size: 16px; }
  .chapter h1, .chapter h2, .chapter h3, .chapter h4 { text-indent: 0; }
</style>
</head>
<body>
${coverHtml}
<div class="toc-page">
  <h1>${meta.name || pn}</h1>
  <p style="text-align:center;color:#999;margin-bottom:30px;">${meta.author_name || '佚名'} 著</p>
  <ul>${chapters.map(ch => `<li>第${ch.num}章 ${ch.title}</li>`).join('')}</ul>
</div>
${chapters.map(ch => `<div class="chapter"><h1>第${ch.num}章 ${ch.title}</h1>${ch.content}</div>`).join('')}
</body>
</html>`;

    const filePath = path.join(EXPORT_DIR, filename);
    fs.writeFileSync(filePath, output, 'utf-8');

    if (req.query.download === '1' || req.query.download === 'true') {
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      return res.send(output);
    }
    return res.json({ success: true, format: 'html', filePath, wordCount: totalWords, chapterCount: chapters.length, filename });

  } else if (format === 'md' || format === 'markdown') {
    ext = 'md';
    mime = 'text/markdown; charset=utf-8';
    filename = `${pn}.md`;
    output = `# ${meta.name || pn}\n\n${meta.description ? `> ${meta.description}\n\n` : ''}`;
    if (coverPath) {
      output += `<img src="data:${coverMime};base64,${coverBase64}" alt="封面" style="max-width:100%;height:auto;">\n\n`;
    }
    for (const ch of chapters) {
      output += `\n---\n\n## 第${ch.num}章 ${ch.title}\n\n${ch.content}\n`;
    }
  } else {
    // TXT
    ext = 'txt';
    mime = 'text/plain; charset=utf-8';
    filename = `${pn}.txt`;
    output = `${meta.name || pn}\n${'='.repeat(meta.name?.length || 10)}\n\n`;
    if (meta.description) output += `${meta.description}\n\n`;
    for (const ch of chapters) {
      output += `\n第${ch.num}章 ${ch.title}\n${'-'.repeat(20)}\n\n${ch.content.replace(/^#+/gm, '').trim()}\n`;
    }
  }

  output += `\n\n---\n共 ${chapters.length} 章 · ${totalWords} 字\n`;

  // Save to exports dir
  const filePath = path.join(EXPORT_DIR, filename);
  fs.writeFileSync(filePath, output, 'utf-8');

  // Record in exports table
  try {
    db.projectExecute(pn,
      'INSERT OR REPLACE INTO exports (id, format, file_path, word_count, exported_at) VALUES (?, ?, ?, ?, datetime(\'now\'))',
      [randomUUID(), ext, filePath, totalWords]
    );
  } catch(e) {}

  if (req.query.download === '1' || req.query.download === 'true') {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    return res.send(output);
  }

  res.json({
    success: true,
    format: ext,
    filePath,
    wordCount: totalWords,
    chapterCount: chapters.length,
    preview: (output || '').slice(0, 2000),
    filename,
  });
});

// ═══════════════════════════════════════════
// CHAT SESSIONS (per-project)
// ═══════════════════════════════════════════

router.get('/:project/chat/sessions', (req, res) => {
  const rows = db.projectQuery(project(req.params.project),
    'SELECT * FROM chat_sessions ORDER BY updated_at DESC'
  );
  res.json(rows);
});

router.post('/:project/chat/sessions', (req, res) => {
  const { title } = req.body || {};
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO chat_sessions (id, title) VALUES (?, ?)',
    [id, title || '新对话']
  );
  res.status(201).json({ id, title: title || '新对话', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
});

router.put('/:project/chat/sessions/:id', (req, res) => {
  const { title } = req.body || {};
  if (!title) return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: 'title is required' } });
  db.projectExecute(project(req.params.project),
    "UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?",
    [title, req.params.id]
  );
  res.json({ success: true });
});

router.delete('/:project/chat/sessions/:id', (req, res) => {
  db.projectExecute(project(req.params.project),
    'DELETE FROM chat_messages WHERE session_id = ?', [req.params.id]
  );
  db.projectExecute(project(req.params.project),
    'DELETE FROM chat_sessions WHERE id = ?', [req.params.id]
  );
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// CHAT MESSAGES (per-project)
// ═══════════════════════════════════════════

router.put('/:project/chat/messages/:id', (req, res) => {
  const { content } = req.body || {};
  if (!content || !String(content).trim()) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: 'content is required', recoverable: true } });
  }
  const changes = db.projectExecute(project(req.params.project),
    'UPDATE chat_messages SET content = ? WHERE id = ?', [String(content), req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '消息不存在' } });
  res.json({ success: true });
});

router.delete('/:project/chat/messages/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project),
    'DELETE FROM chat_messages WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '消息不存在' } });
  res.json({ success: true });
});

router.get('/:project/chat/messages', (req, res) => {
  const { session_id } = req.query;
  let sql = 'SELECT * FROM chat_messages';
  const params = [];
  if (session_id) {
    sql += ' WHERE session_id = ?';
    params.push(session_id);
  }
  sql += ' ORDER BY created_at ASC';
  const rows = db.projectQuery(project(req.params.project), sql, params);
  const messages = rows.map(r => ({
    id: r.id,
    role: r.role,
    content: r.content,
    toolCalls: JSON.parse(r.tool_calls || '[]'),
    createdAt: r.created_at,
  }));
  res.json(messages);
});

router.post('/:project/chat/messages', (req, res) => {
  const { role, content, toolCalls, session_id } = req.body || {};
  if (!role || !content || !session_id) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: 'role, content and session_id are required', recoverable: true } });
  }
  if (!['user', 'ai', 'system'].includes(role)) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: 'role must be user/ai/system', recoverable: true } });
  }
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO chat_messages (id, session_id, role, content, tool_calls) VALUES (?, ?, ?, ?, ?)',
    [id, session_id, role, content, JSON.stringify(toolCalls || [])]
  );
  // Update session's updated_at
  db.projectExecute(project(req.params.project),
    "UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?", [session_id]
  );
  res.status(201).json({ id, role, content, toolCalls: toolCalls || [], session_id, createdAt: new Date().toISOString() });
});

// ═══════════════════════════════════════════
// SNAPSHOTS（里程碑快照）
// ═══════════════════════════════════════════
//
// 用途：AI 共创会把设定直接写进项目库，开局那批元素不合意时，光在会话里重试没用
// （模型每次都读到库里已有的元素）。留一份「初始状态」快照，不满意就整份还原。
// 详见 server/snapshots.js 顶部说明。

/** 快照模块的错误自带 code，映射成合适的状态码，别让全部情况都退化成 500。 */
function snapshotError(res, e, fallbackMessage) {
  const code = e && e.code;
  if (code === 'SNAPSHOT_NOT_FOUND' || code === 'PROJECT_NOT_FOUND') {
    return res.status(404).json({ error: { code, message: e.message, recoverable: true } });
  }
  if (code === 'INVALID_SNAPSHOT_ID' || code === 'INVALID_PROJECT_NAME') {
    return res.status(400).json({ error: { code, message: e.message, recoverable: true } });
  }
  // 快照损坏 / 还原后自检失败：请求本身没错，是目标状态不可用，用 409
  if (code === 'SNAPSHOT_CORRUPT' || code === 'RESTORE_VERIFY_FAILED') {
    return res.status(409).json({ error: { code, message: e.message, recoverable: true } });
  }
  return res.status(500).json({ error: { message: e.message || fallbackMessage, recoverable: true } });
}

router.get('/:project/snapshots', (req, res) => {
  try {
    const list = snapshots.listSnapshots(req.params.project);
    res.json({ snapshots: list, totalBytes: snapshots.snapshotsSize(req.params.project) });
  } catch (e) {
    snapshotError(res, e, '读取快照列表失败');
  }
});

router.post('/:project/snapshots', (req, res) => {
  const { label, kind } = req.body || {};
  try {
    // 只接受前端声明的这两种。safety 是还原流程内部产生的，
    // 允许外部指定只会让「自动备份」被用户手动伪造成普通里程碑。
    const wanted = kind === snapshots.KIND_INITIAL ? snapshots.KIND_INITIAL : snapshots.KIND_MANUAL;
    const existed =
      wanted === snapshots.KIND_INITIAL &&
      snapshots.listSnapshots(req.params.project).some((s) => s.kind === snapshots.KIND_INITIAL);
    const meta = snapshots.createSnapshot(req.params.project, {
      label,
      kind: wanted,
      // 「初始状态」一个项目只该有一份：前端重试、或用户反复进入项目页，
      // 都不该堆出多份同名里程碑把列表占满。
      unique: wanted === snapshots.KIND_INITIAL,
    });
    res.status(existed ? 200 : 201).json(meta);
  } catch (e) {
    snapshotError(res, e, '创建快照失败');
  }
});

router.post('/:project/snapshots/:id/restore', (req, res) => {
  const { safetyLabel } = req.body || {};
  try {
    res.json(snapshots.restoreSnapshot(req.params.project, req.params.id, { safetyLabel }));
  } catch (e) {
    snapshotError(res, e, '还原快照失败');
  }
});

router.delete('/:project/snapshots/:id', (req, res) => {
  try {
    snapshots.deleteSnapshot(req.params.project, req.params.id);
    res.json({ success: true });
  } catch (e) {
    snapshotError(res, e, '删除快照失败');
  }
});

module.exports = router;
