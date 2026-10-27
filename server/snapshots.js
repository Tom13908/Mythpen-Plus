// ─── 里程碑快照 ───────────────────────────────────────────────
//
// 解决的问题：AI 共创会把讨论出来的设定**直接写进项目库**（角色、世界观、伏笔、
// 关系、时间线、记忆……）。一旦开局那批元素不合意，光在会话里重试是没用的 ——
// 模型每次都会读到库里已有的元素，产出只会围着它们打转。以前唯一的出路是手动
// 逐项删除，那既繁琐又必然漏项。
//
// 做法：把项目库在某一刻的**整份状态**留下来，之后可以整份还原。
//
// 为什么是"整库文件"而不是"叙事元素表的逻辑导出"：
//   1. 逻辑导出要枚举表、处理外键顺序，漏一张表就是静默的数据残缺；
//      整库拷贝在结构上不可能漏 —— 这个项目已经有过两次数据被静默改错/销毁的事故，
//       宁可多占几 MB 磁盘，不要任何"可能漏了哪张表"的空间。
//   2. 无需维护「哪些表算叙事元素」这份清单 —— 清单一旦过时（新增表忘了加）就会出错。
//   3. 还原语义与用户的心智一致：「回到那个阶段」就是回到那一刻的全部状态。
//
// 磁盘布局：<DB_DIR>/snapshots/<project>/<snapshotId>/
//             ├── db.mythpen.db   ← 项目库整份副本
//             ├── meta.json       ← 标签、时间、统计（最后写，缺它即视为不完整）
//             └── cover.<ext>     ← 该时刻的封面（若有）
//
// 快照 id 用 `YYYYMMDD-HHmmss-SSS-rand`：既可按字典序正确排序，
// 又不含冒号等 Windows 非法文件名字符。

const path = require('path');
const fs = require('fs');
const db = require('./db');

const KIND_INITIAL = 'initial'; // 项目创建后自动留的「初始状态」
const KIND_MANUAL = 'manual'; // 用户手动打点
const KIND_SAFETY = 'safety'; // 还原前自动留下的当前状态

const DEFAULT_LABEL = '未命名里程碑';
const INITIAL_LABEL = '初始状态';
const SAFETY_LABEL = '还原前自动备份';

const DB_FILE_NAME = 'db.mythpen.db';
const META_FILE_NAME = 'meta.json';

// 目录名会由 URL 参数拼出来，必须限定字符集：否则 `../..` 之类的 id 能把
// 删除/还原操作指到快照目录之外。
const SNAPSHOT_ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z-]{0,63}$/;

/** 统计口径：项目库里所有"内容量"表。表名是内部常量，不来自请求参数。 */
const COUNT_TABLES = [
  ['volumes', 'volumes'],
  ['chapters', 'chapters'],
  ['characters', 'characters'],
  ['character_relations', 'relations'],
  ['world_entries', 'world'],
  ['science_entries', 'science'],
  ['foreshadows', 'foreshadows'],
  ['memories', 'memories'],
  ['timeline_events', 'timeline'],
  ['clue_board', 'clues'],
  ['chat_sessions', 'chatSessions'],
  ['chat_messages', 'chatMessages'],
];

function assertValidSnapshotId(id) {
  if (typeof id !== 'string' || !SNAPSHOT_ID_RE.test(id)) {
    throw Object.assign(new Error('快照标识不合法'), { code: 'INVALID_SNAPSHOT_ID' });
  }
  return id;
}

function _projectDir(projectName) {
  // 目录名用 projectDirKey：名称含 `/` 时不会再建出嵌套目录，且同名总落在同一处。
  // 老项目（名称本身安全）目录名保持不变，已有快照不受影响。
  db.assertValidProjectName(projectName);
  const dir = path.join(db.getSnapshotsDir(), db.projectDirKey(projectName));
  const root = path.resolve(db.getSnapshotsDir());
  if (!path.resolve(dir).startsWith(root + path.sep)) {
    throw Object.assign(new Error('快照路径越界'), { code: 'INVALID_PROJECT_NAME' });
  }
  return dir;
}

function _snapshotDir(projectName, id) {
  assertValidSnapshotId(id);
  return path.join(_projectDir(projectName), id);
}

function _newSnapshotId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `-${p(d.getMilliseconds(), 3)}`;
  // 尾随机段：同一毫秒内连打两次时仍能区分
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 该时刻项目库里有什么。用于在界面上把里程碑直接读出来，不必点开才知道。 */
function _collectStats(projectName) {
  const stats = {};
  for (const [table, key] of COUNT_TABLES) {
    try {
      stats[key] = db.projectGet(projectName, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0;
    } catch {
      stats[key] = 0;
    }
  }
  try {
    const meta = {};
    for (const row of db.projectQuery(projectName, 'SELECT key, value FROM project_meta')) {
      meta[row.key] = row.value;
    }
    stats.wordCount = Number(meta.word_count || 0);
    stats.phase = meta.workflow_phase || 'idea';
  } catch {
    stats.wordCount = 0;
    stats.phase = 'idea';
  }
  return stats;
}

/** 把某个快照目录里的库文件原子替换到现役库位置。 */
function _swapIn(snapshotDir, filePath) {
  const src = path.join(snapshotDir, DB_FILE_NAME);
  const tmp = `${filePath}.restore-tmp`;
  fs.copyFileSync(src, tmp);
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清理失败不影响主流程 */
    }
    throw e;
  }
  // 防抖落盘留下的临时文件属于**被替换掉的那一版**，留着有被误当成有效数据的风险
  try {
    fs.unlinkSync(`${filePath}.flush-tmp`);
  } catch {
    /* 不存在是常态 */
  }
}

/** 用快照里的封面替换现役封面；快照里没有封面就一并清掉，保持"回到那一刻"的语义。 */
function _applyCover(snapshotDir, projectName) {
  const coverDir = db.getCoverDir(projectName);
  const exts = ['png', 'jpg', 'webp', 'gif'];
  let snapCover = null;
  for (const ext of exts) {
    const p = path.join(snapshotDir, `cover.${ext}`);
    if (fs.existsSync(p)) {
      snapCover = { path: p, ext };
      break;
    }
  }
  for (const ext of exts) {
    const live = path.join(coverDir, `cover.${ext}`);
    try {
      fs.unlinkSync(live);
    } catch {
      /* 不存在即无需清理 */
    }
  }
  if (!snapCover) return false;
  fs.mkdirSync(coverDir, { recursive: true });
  fs.copyFileSync(snapCover.path, path.join(coverDir, `cover.${snapCover.ext}`));
  return true;
}

/**
 * 新建快照。
 * @param {string} projectName
 * @param {{label?: string, kind?: string, unique?: boolean}} opts
 *        unique=true 时，同 kind 已存在则直接返回既有快照（用于"初始状态"这类
 *        只该有一份的里程碑，避免前端重试导致重复）。
 */
function createSnapshot(projectName, opts = {}) {
  const name = db.assertValidProjectName(projectName);
  const kind = opts.kind || KIND_MANUAL;
  const label = (opts.label || '').trim() || DEFAULT_LABEL;

  // 顺序不能反：必须**先落盘再判断文件在不在**。
  // sql.js 的写入有 250ms 防抖，「建项目 → 立刻打初始快照」这条主路径整个发生在
  // 防抖窗口之内，此刻磁盘上还没有这个文件 —— 先 existsSync 会误报「项目不存在」。
  // 同时落盘也保证后面读统计与拷贝文件取到的是同一时刻的内容。
  db.flushAllDbs();

  const filePath = db.getProjectDbPath(name);
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error(`项目"${name}"不存在`), { code: 'PROJECT_NOT_FOUND' });
  }

  if (opts.unique) {
    const existing = listSnapshots(name).find((s) => s.kind === kind);
    if (existing) return existing;
  }

  const stats = _collectStats(name);
  const id = _newSnapshotId();
  const dir = _snapshotDir(name, id);

  fs.mkdirSync(dir, { recursive: true });
  try {
    const dest = path.join(dir, DB_FILE_NAME);
    fs.copyFileSync(filePath, dest);
    // 副本自己要先能通过文件头校验 —— 存一份坏副本比不存更糟
    if (!db.isValidSqliteFile(dest)) {
      throw new Error('快照副本未通过 SQLite 文件头校验');
    }

    let hasCover = false;
    const cover = db.findCoverPath(name);
    if (cover) {
      fs.copyFileSync(cover, path.join(dir, path.basename(cover)));
      hasCover = true;
    }

    // meta.json 最后写：缺它即代表这份快照没做完，列举时会被跳过
    const meta = {
      id,
      project: name,
      kind,
      label,
      createdAt: new Date().toISOString(),
      dbBytes: fs.statSync(dest).size,
      hasCover,
      stats,
    };
    fs.writeFileSync(path.join(dir, META_FILE_NAME), JSON.stringify(meta, null, 2), 'utf-8');
    return meta;
  } catch (e) {
    // 半截快照绝不留下：列表里会出现一条点不动的记录，用户以为有备份、
    // 还原时才发现是空的。
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响主流程 */
    }
    throw e;
  }
}

function listSnapshots(projectName) {
  const name = db.assertValidProjectName(projectName);
  const dir = _projectDir(name);
  if (!fs.existsSync(dir)) return [];

  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(dir, entry.name, META_FILE_NAME);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      // 目录在但库文件不在了 → 标出来示警，而不是藏起来让用户以为这份快照可用
      meta.integrity = db.isValidSqliteFile(path.join(dir, entry.name, DB_FILE_NAME)) ? 'ok' : 'broken';
      out.push(meta);
    } catch {
      /* 读不出 meta 的目录视为未完成的快照，跳过 */
    }
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

function getSnapshot(projectName, id) {
  return listSnapshots(projectName).find((s) => s.id === id) || null;
}

/**
 * 还原到某个快照。
 *
 * 顺序上有一处不能调换：**先**校验快照文件、**再**动现役库。
 * 反过来的话，一份损坏的快照会被拷到好库上 —— 一次还原等于一次数据销毁。
 * 还原前还会自动给"当前状态"留一份安全副本（kind=safety）：还原本身就是破坏性操作，
 * 点错里程碑、或者刚写完几千字才发现选错，都必须能退回来。
 */
function restoreSnapshot(projectName, id, opts = {}) {
  const name = db.assertValidProjectName(projectName);
  const dir = _snapshotDir(name, id); // 内含 id 字符集校验
  const srcDb = path.join(dir, DB_FILE_NAME);

  if (!fs.existsSync(srcDb)) {
    throw Object.assign(new Error('快照不存在或已被删除'), { code: 'SNAPSHOT_NOT_FOUND' });
  }
  if (!db.isValidSqliteFile(srcDb)) {
    throw Object.assign(new Error('快照文件已损坏，为避免覆盖当前数据已中止还原'), {
      code: 'SNAPSHOT_CORRUPT',
    });
  }

  // 先把内存状态落盘：既让安全副本的内容是完整的，也让接下来「项目是否存在」
  // 的判断可靠（同样是 250ms 防抖窗口的问题，见 createSnapshot 的说明）。
  db.flushAllDbs();

  const filePath = db.getProjectDbPath(name);
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error(`项目"${name}"不存在`), { code: 'PROJECT_NOT_FOUND' });
  }

  const target = getSnapshot(name, id);
  const safety = createSnapshot(name, { kind: KIND_SAFETY, label: opts.safetyLabel || SAFETY_LABEL });

  // 必须 discard 而不是 close：close() 会把内存里的旧内容重新写回磁盘，
  // 正好把刚还原的结果再覆盖掉。
  db.discardProjectDb(filePath);
  _swapIn(dir, filePath);

  try {
    // 立即开一次并跑两条查询：坏库在这里暴露，而不是等用户点开某个页面才报错
    const check = db.getProjectDb(name);
    check.prepare('SELECT COUNT(*) AS c FROM project_meta').get();
    check.prepare('SELECT COUNT(*) AS c FROM chapters').get();
  } catch (e) {
    // 还原后打不开 → 用刚留下的安全副本退回去，绝不让用户停在一个打不开的项目上
    db.discardProjectDb(filePath);
    _swapIn(path.join(_projectDir(name), safety.id), filePath);
    db.discardProjectDb(filePath);
    throw Object.assign(
      new Error(`快照还原后校验失败，已自动退回还原前状态：${e.message}`),
      { code: 'RESTORE_VERIFY_FAILED' },
    );
  }

  const coverApplied = _applyCover(dir, name);

  return { restored: getSnapshot(name, id) || target, safetySnapshot: safety, coverApplied };
}

function deleteSnapshot(projectName, id) {
  const dir = _snapshotDir(projectName, id);
  if (!fs.existsSync(dir)) {
    throw Object.assign(new Error('快照不存在'), { code: 'SNAPSHOT_NOT_FOUND' });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // 项目下已经没有快照了就顺手收掉空目录，避免残留一堆空壳
  const parent = _projectDir(projectName);
  try {
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch {
    /* 非空或有并发写入，留着即可 */
  }
  return true;
}

/** 删除项目时调用：快照跟着项目一起消失，否则会留下再也访问不到的文件。 */
function deleteAllSnapshots(projectName) {
  const dir = _projectDir(projectName);
  if (!fs.existsSync(dir)) return 0;
  fs.rmSync(dir, { recursive: true, force: true });
  return 1;
}

/** 快照占用磁盘总量，用于在界面上告诉用户这份便利的代价。 */
function snapshotsSize(projectName) {
  const dir = _projectDir(projectName);
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      total += fs.statSync(path.join(dir, entry.name, DB_FILE_NAME)).size;
    } catch {
      /* 缺文件即不计入 */
    }
  }
  return total;
}

module.exports = {
  KIND_INITIAL,
  KIND_MANUAL,
  KIND_SAFETY,
  INITIAL_LABEL,
  createSnapshot,
  listSnapshots,
  getSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  deleteAllSnapshots,
  snapshotsSize,
};
