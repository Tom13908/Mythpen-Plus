// ─── SQL.js-based database layer (replaces better-sqlite3) ───
// Uses sql.js (pure JS/WASM SQLite) instead of better-sqlite3 (native addon)
// so that bun build --compile can produce a standalone binary without native .node files.

const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Storage location bootstrap ───
// The "bootstrap" file itself always lives in the fixed default location
// (~/.mythpen/.storage-location) so that "where is my data" never becomes
// a circular lookup. It contains a single line: the custom storage dir path.
// If absent, the default ~/.mythpen is used.
const DEFAULT_DB_DIR = path.join(os.homedir(), '.mythpen');
const BOOTSTRAP_FILE = path.join(DEFAULT_DB_DIR, '.storage-location');

function _resolveDbDir() {
  try {
    if (fs.existsSync(BOOTSTRAP_FILE)) {
      const custom = fs.readFileSync(BOOTSTRAP_FILE, 'utf-8').trim();
      if (custom) return custom;
    }
  } catch (e) {
    console.warn('[DB] Failed to read storage location bootstrap file:', e.message);
  }
  return DEFAULT_DB_DIR;
}

const DB_DIR = _resolveDbDir();
const CONFIG_DB = path.join(DB_DIR, 'config.db');
const PROJECTS_DIR = path.join(DB_DIR, 'projects');
const EXPORTS_DIR = path.join(DB_DIR, 'exports');
// 里程碑快照：<DB_DIR>/snapshots/<project>/<snapshotId>/{db.mythpen.db,meta.json,cover.*}
// 与 projects/ 平级而不在其内部 —— projects/ 会被按 *.mythpen.db 扫描列举，
// 快照放进去可能被当成项目库。
const SNAPSHOTS_DIR = path.join(DB_DIR, 'snapshots');

// ─── Ensure directories ───
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

let SQL;         // set by initDatabase()
let configDb;    // wrapped config database

// ═══════════════════════════════════════════════════════════════
// Schema versioning — bump these when adding migrations
// ═══════════════════════════════════════════════════════════════

const CONFIG_SCHEMA_VERSION = 1;
const PROJECT_SCHEMA_VERSION = 4;

// ═══════════════════════════════════════════════════════════════
// sql.js wrapper — provides a better-sqlite3-compatible API
// ═══════════════════════════════════════════════════════════════

const SQLITE_HEADER = 'SQLite format 3\u0000';

function _loadDb(filePath) {
  if (fs.existsSync(filePath)) {
    const buf = fs.readFileSync(filePath);
    // ─── 关键数据安全防线 ───
    // 文件存在却不是有效 SQLite（0 字节 / 被截断 / 损坏）时，绝不能当成全新空库
    // 打开：开库时的迁移写入会触发刷盘，用空 schema 覆盖原文件，用户数据被
    // 静默销毁（2026-09-24 实际发生过）。宁可报错中止，让人介入处理。
    if (buf.length === 0 || buf.subarray(0, 16).toString('binary') !== SQLITE_HEADER) {
      throw new Error(
        `[DB] 拒绝打开损坏的项目库: ${filePath}（${buf.length} 字节，缺少 SQLite 文件头）。` +
          `文件可能已损坏，为避免被空库覆盖已中止打开。请先人工检查/恢复该文件后再启动。`,
      );
    }
    return new SQL.Database(buf);
  }
  return new SQL.Database();
}

function _flushDb(db, filePath) {
  const data = db.export();
  // ─── 原子写（关键数据安全防线）───
  // 直接 writeFileSync 会先截断原文件；进程若在写入中途被杀（如 stop.sh 的强杀、
  // 系统断电），会留下截断文件。而 sql.js 会把截断/空文件当成"全新的空库"，
  // 下一次打开时的迁移写入将用空 schema 覆盖原文件——用户数据被静默销毁
  // （2026-09-24 实际发生过）。先写临时文件再 rename，保证任意时刻磁盘上
  // 要么是完整的旧文件、要么是完整的新文件。
  //
  // 父目录必须先存在：项目名若含路径分隔符，这里的路径会指向一个不存在的子目录，
  // openSync 直接 ENOENT（2026-09-25 实际发生过，整个后端进程被击穿）。名称已在
  // 入口处校验，这里是最后一道兜底。
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.flush-tmp';
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, Buffer.from(data));
      fs.fsyncSync(fd); // 确保内容落盘后再替换
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // 失败时不能留下半截临时文件（下次成功写入会覆盖它，但它会一直占着磁盘）
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响主流程 */ }
    throw e;
  }
}

// ─── Named-param helper ───
// sql.js 1.13+ has a bug where binding named params via object (e.g. {id:1})
// doesn't work — values come through as NULL.
// We work around it by converting @param / :param / $param → ? at the JS level.
const NAMED_PARAM_RE = /[$@:](\w+)/g;

function _normalizeParams(params) {
  if (params.length === 0) return null;
  // Single plain object = named params (e.g. {id: 1, name: 'test'})
  if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0])) {
    return { named: true, values: params[0] };
  }
  return { named: false, values: params };
}

function _buildSql(sqlText, bindMeta) {
  if (!bindMeta) return { sql: sqlText, args: null };
  if (!bindMeta.named) {
    // Positional params — convert undefined → null for sql.js compatibility
    return { sql: sqlText, args: bindMeta.values.map(v => v === undefined ? null : v) };
  }
  // Named params — convert to positional ? and collect values in SQL order
  const args = [];
  const converted = sqlText.replace(NAMED_PARAM_RE, (_, name) => {
    if (bindMeta.values[name] !== undefined) {
      args.push(bindMeta.values[name]);
      return '?';
    }
    // Keep unknown named params as-is (unbound → SQLite treats as NULL)
    return '@' + name;
  });
  return { sql: converted, args };
}

/**
 * Wrap a raw sql.js Database instance so it quacks like better-sqlite3.
 * Supports: .pragma(), .prepare(sql).{all,get,run}(), .exec(), .run(), .transaction(), .close()
 *
 * IMPORTANT: Each .run()/.all()/.get() creates its own fresh prepared statement
 * because sql.js's db.export() (called by _flushDb) invalidates ALL existing statements.
 * The statement is freed before _flushDb() so export() never hits a stale handle.
 */
const DB_FLUSH_DELAY = 250; // ms — batch writes up to this interval

function _wrapDb(db, filePath) {
  let dirty = false;
  let flushTimer = null;

  function _flushSync() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!dirty) return;
    dirty = false;
    try {
      _flushDb(db, filePath);
    } catch (e) {
      // 落盘失败绝不向调用方抛出。本函数由 setTimeout（250ms 防抖落盘）、事务提交和
      // 进程退出钩子调用，抛出会直接击穿进程 —— 把「一个项目写不进磁盘」升级成
      // 「整个服务不可用」（2026-09-25 实际发生过）。
      // 数据仍在内存中未丢失，重新置脏，等下一次写入或退出时重试。
      dirty = true;
      console.error(`[DB] 落盘失败（数据仍在内存，未丢失）: ${filePath} — ${e.message}`);
    }
  }

  function _scheduleFlush() {
    dirty = true;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        _flushSync();
      }, DB_FLUSH_DELAY);
    }
  }

  return {
    _db: db,
    _path: filePath,

    pragma(sql) {
      db.run('PRAGMA ' + sql);
    },

    prepare(sql) {
      return {
        all(...params) {
          const { sql: sql2, args } = _buildSql(sql, _normalizeParams(params));
          const s = db.prepare(sql2);
          if (args) s.bind(args);
          const rows = [];
          while (s.step()) rows.push(s.getAsObject());
          s.free();
          return rows;
        },
        get(...params) {
          const { sql: sql2, args } = _buildSql(sql, _normalizeParams(params));
          const s = db.prepare(sql2);
          if (args) s.bind(args);
          let row = null;
          if (s.step()) row = s.getAsObject();
          s.free();
          return row;
        },
        run(...params) {
          const { sql: sql2, args } = _buildSql(sql, _normalizeParams(params));
          const s = db.prepare(sql2);
          if (args) s.bind(args);
          s.step();
          const changes = db.getRowsModified();
          s.free();
          _scheduleFlush();
          return { changes };
        },
      };
    },

    exec(sql) {
      const results = db.exec(sql);
      _scheduleFlush();
      return results;
    },

    run(sql, params) {
      db.run(sql, params || []);
      _scheduleFlush();
    },

    transaction(fn) {
      return (...args) => {
        db.run('BEGIN');
        try {
          const result = fn(...args);
          db.run('COMMIT');
          _flushSync(); // flush immediately after commit for data safety
          return result;
        } catch (e) {
          db.run('ROLLBACK');
          throw e;
        }
      };
    },

    close() {
      _flushSync();
      db.close();
    },

    /** 立即把内存中的库写盘（不关闭连接）。供退出前的统一落盘使用。 */
    flush() {
      _flushSync();
    },

    /**
     * 丢弃内存中的库，**不写盘**。
     * 用于磁盘文件已被外部删除/替换的场景：此时内存里的旧库已无意义，
     * 若走 close() 会把旧内容重新写回磁盘（等于让文件复活）。
     */
    discard() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      dirty = false;
      try { db.close(); } catch { /* 已关闭/句柄失效都当成功 */ }
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Initialisation (MUST be called before any other db function)
// ═══════════════════════════════════════════════════════════════

async function initDatabase() {
  console.log('[DB] Initialising database...');
  console.log('[DB] DB_DIR:', DB_DIR, '| CONFIG_DB:', CONFIG_DB);
  const t0 = Date.now();

  // ─── Load sql.js library ───
  const initSqlJs = require('sql.js');
  console.log('[DB] sql.js library loaded');

  // ─── Load sql-wasm.wasm ───
  // In bun --compile binaries there's no node_modules, so sql.js cannot
  // locate its WASM file via module resolution. We must provide the WASM
  // binary explicitly via initSqlJs({ wasmBinary }).
  //
  // Multiple strategies tried in order:
  //   1. base64-embedded module (works in both bun dev and --compile)
  //   2. fs.readFileSync relative to __dirname (dev mode)
  //   3. fs.readFileSync relative to CWD (fallback)
  let wasmBinary;

  // Strategy 1: base64-embedded WASM (prevents bun --assets bug in 1.3.14)
  try {
    const { getWasmBinary } = require('./wasm-binary');
    wasmBinary = getWasmBinary();
    console.log('[DB] WASM loaded via base64 embedded module');
  } catch (e) {
    console.log('[DB] Embedded WASM module not available:', e.message);
  }

  // Strategy 2: fs.readFileSync relative to this file (dev mode, file on disk)
  if (!wasmBinary) {
    try {
      const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
      if (fs.existsSync(wasmPath)) {
        wasmBinary = fs.readFileSync(wasmPath);
        console.log('[DB] WASM loaded from:', wasmPath);
      }
    } catch {
      // strategy 2 failed
    }
  }

  // Strategy 3: fs.readFileSync from CWD (fallback for bun compiled binary)
  if (!wasmBinary) {
    try {
      const wasmPath = path.join(process.cwd(), 'server', 'sql-wasm.wasm');
      if (fs.existsSync(wasmPath)) {
        wasmBinary = fs.readFileSync(wasmPath);
        console.log('[DB] WASM loaded from:', wasmPath);
      }
    } catch {
      // strategy 3 failed
    }
  }

  if (!wasmBinary) {
    console.log('[DB] WASM not found via any strategy — initSqlJs will use its own loader');
  }

  // ─── Init sql.js runtime ───
  console.log('[DB] Calling initSqlJs()...');
  SQL = await initSqlJs({ wasmBinary });
  console.log('[DB] initSqlJs() OK');

  // ─── Open / create config database ───
  console.log('[DB] Opening config database...');
  configDb = _openConfig();
  console.log('[DB] Config database ready, schema version:', CONFIG_SCHEMA_VERSION);

  const t1 = Date.now();
  console.log(`[DB] Database initialised in ${t1 - t0}ms`);
  return true;
}

function _openConfig() {
  const db = _loadDb(CONFIG_DB);
  db.run('PRAGMA foreign_keys = ON');
  const wrapped = _wrapDb(db, CONFIG_DB);
  migrateConfig(wrapped);
  return wrapped;
}

// ═══════════════════════════════════════════════════════════════
// Config DB
// ═══════════════════════════════════════════════════════════════

function getConfigDb() {
  if (!configDb) throw new Error('Database not initialised – call initDatabase() first');
  return configDb;
}

// ═══════════════════════════════════════════════════════════════
// Generic migration runner
// ═══════════════════════════════════════════════════════════════

function runMigrations(db, migrations, targetVersion, getVersionFn, setVersionFn) {
  let currentVersion = getVersionFn(db);
  if (currentVersion >= targetVersion) return;
  for (let v = currentVersion; v < targetVersion; v++) {
    if (!migrations[v]) {
      // 关键：迁移函数缺失时绝不推进版本号。
      // 旧实现无条件 setVersion(v+1)，一旦版本号先于迁移函数被改动（例如分步编辑时
      // nodemon 中途重启），该步骤会被永久跳过且不再重试，导致"版本已升但列不存在"。
      throw new Error(`[DB] Missing migration for version ${v} → ${v + 1}`);
    }
    migrations[v](db);
    setVersionFn(db, v + 1);
  }
}

// ═══════════════════════════════════════════════════════════════
// Config DB migrations
// ═══════════════════════════════════════════════════════════════

const configMigrations = [
  // v0 → v1: initial schema + defaults
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recent_projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        file_path   TEXT NOT NULL UNIQUE,
        last_opened TEXT NOT NULL DEFAULT (datetime('now')),
        word_count  INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS editor_snapshots (
        project_path TEXT PRIMARY KEY,
        chapter_num  INTEGER NOT NULL,
        content      TEXT NOT NULL,
        cursor_pos   INTEGER,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Seed default settings if empty
    const count = db.prepare('SELECT COUNT(*) as c FROM app_settings').get().c;
    if (count === 0) {
      const insert = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
      const defaults = [
        ['api_key', ''],
        ['api_base_url', 'https://api.deepseek.com/v1'],
        ['api_model', 'deepseek-v4-flash'],
        ['ui_language', 'zh'],
        ['theme', 'dark'],
        ['editor_font_size', '17'],
        ['editor_font_family', "'Noto Serif SC', 'Source Han Serif SC', 'STSong', Georgia, serif"],
        ['auto_save_interval', '30'],
        ['backup_enabled', 'true'],
        ['accent_color', '#c9a96e'],
      ];
      const innerTx = db.transaction(() => {
        for (const [k, v] of defaults) insert.run(k, v);
      });
      innerTx();
    }
  },
];

function makeVersionGetter(tableName) {
  return (db) => {
    // 先直接读：绝大多数情况下表已存在，这条路径完全不触碰数据库。
    // 旧写法无条件 db.exec(CREATE TABLE IF NOT EXISTS ...)，而 exec() 会让包装层
    // 标记脏 —— 结果只是「列一次项目列表」就会把每个项目文件整库重写一遍。
    try {
      const row = db.prepare(`SELECT value FROM ${tableName} WHERE key = 'schema_version'`).get();
      return row ? parseInt(row.value, 10) || 0 : 0;
    } catch {
      // 表还不存在（全新库）→ 建表，按版本 0 交给迁移流程
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      } catch {
        /* 建表失败交由后续迁移流程抛出，处理方式保持一致 */
      }
      return 0;
    }
  };
}

function makeVersionSetter(tableName) {
  return (db, version) => {
    db.prepare(`INSERT OR REPLACE INTO ${tableName} (key, value) VALUES ('schema_version', ?)`).run(String(version));
  };
}

const getConfigVersion = makeVersionGetter('app_settings');
const setConfigVersion = makeVersionSetter('app_settings');

function migrateConfig(db) {
  runMigrations(db, configMigrations, CONFIG_SCHEMA_VERSION, getConfigVersion, setConfigVersion);
}

// ═══════════════════════════════════════════════════════════════
// Project DB Management
// ═══════════════════════════════════════════════════════════════

const projectConnections = new Map();

// ═══════════════════════════════════════════════════════════════
// 项目名校验（入口防线）
// ═══════════════════════════════════════════════════════════════
// 每个项目对应 <PROJECTS_DIR>/<name>.mythpen.db。名称一旦含路径分隔符，落盘路径就被
// 拆进不存在的子目录：第一次防抖落盘即 ENOENT，整个后端进程被击穿；而该项目的数据
// 此时只存在于内存连接里，进程一崩即永久丢失（2026-09-25 实际发生：项目名
// "Common Sense, Luv/Hate"）。`..` 变体还能把库文件写到 projects/ 之外。
// 因此非法名称一律在入口拒绝，绝不交给 path.join。
const PROJECT_NAME_MAX_LEN = 100;
const INVALID_PROJECT_NAME_CHARS = /[\\/:*?"<>|]/; // 路径分隔符 + Windows 保留字符

function validateProjectName(name) {
  if (typeof name !== 'string') return { ok: false, message: '项目名称必须是文本' };
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: '项目名称不能为空' };
  if (trimmed.length > PROJECT_NAME_MAX_LEN) {
    return { ok: false, message: `项目名称不能超过 ${PROJECT_NAME_MAX_LEN} 个字符` };
  }
  if (/^\.+$/.test(trimmed)) return { ok: false, message: '项目名称不能是 "." 或 ".."' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, message: '项目名称不能包含换行、制表符等控制字符' };
  }
  const hit = trimmed.match(new RegExp(INVALID_PROJECT_NAME_CHARS.source, 'g'));
  if (hit) {
    return { ok: false, message: `项目名称不能包含这些字符：${[...new Set(hit)].join(' ')}` };
  }
  return { ok: true, name: trimmed };
}

/** 校验通过返回规范化后的名称，否则抛出带 code 的错误（调用方转 400）。 */
function assertValidProjectName(name) {
  const v = validateProjectName(name);
  if (!v.ok) throw Object.assign(new Error(v.message), { code: 'INVALID_PROJECT_NAME' });
  return v.name;
}

/** 项目库所在目录（封面等附属资源也在这里按项目名建子目录）。 */
function getProjectsDir() {
  return PROJECTS_DIR;
}

/** 里程碑快照根目录。 */
function getSnapshotsDir() {
  return SNAPSHOTS_DIR;
}

/**
 * 文件是不是一个像样的 SQLite 库（前 16 字节文件头）。
 *
 * 抽出来复用而不是内联在 _loadDb 里，是因为「还原快照」这条路必须先校验快照文件、
 * **再**覆盖现役库 —— 顺序反了就是把坏文件盖到好库上，等于用一次还原销毁用户数据。
 */
function isValidSqliteFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 100) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(16);
      const read = fs.readSync(fd, head, 0, 16, 0);
      return read === 16 && head.toString('binary') === SQLITE_HEADER;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function getProjectDbPath(name) {
  return path.join(PROJECTS_DIR, `${assertValidProjectName(name)}.mythpen.db`);
}

function openProjectDb(filePath) {
  const cached = projectConnections.get(filePath);
  if (cached) {
    // 磁盘文件还在 → 复用缓存连接。
    // 文件已被外部删除/移走 → 丢弃内存里的旧库再重新加载：否则「重新创建同名项目」
    // 会继承旧内存库的内容，建默认卷时直接 500（UNIQUE constraint failed: volumes.id）。
    if (fs.existsSync(filePath)) return cached;
    cached.discard();
    projectConnections.delete(filePath);
  }
  const db = _loadDb(filePath);
  db.run('PRAGMA foreign_keys = ON');
  const wrapped = _wrapDb(db, filePath);
  migrateProject(wrapped);
  projectConnections.set(filePath, wrapped);
  return wrapped;
}

function closeProjectDb(filePath) {
  if (projectConnections.has(filePath)) {
    projectConnections.get(filePath).close();
    projectConnections.delete(filePath);
  }
}

/**
 * 丢弃内存中的项目库连接，**不写盘**。
 *
 * 还原快照专用：磁盘文件马上要被快照覆盖，此时若走 closeProjectDb()，
 * close() → _flushSync() 会把内存里的旧内容重新写回磁盘，把刚还原的结果再次覆盖掉
 * （且因为内存里 dirty 标志的存在，这一步并不总能靠"先 flush 再还原"避免）。
 * 必须用 discard()。
 *
 * 另外必须把连接从缓存里摘掉：openProjectDb() 的缓存复用条件是"磁盘文件还在"，
 * 而还原后文件一定在，于是下一次取库会把已经不成立的旧内存库当成有效缓存返回。
 */
function discardProjectDb(filePath) {
  const cached = projectConnections.get(filePath);
  if (!cached) return false;
  cached.discard();
  projectConnections.delete(filePath);
  return true;
}

/** 退出前统一落盘：把所有已打开的项目库立即写盘，避免丢最近 250ms 的写入。 */
function flushAllProjectDbs() {
  for (const [p, wrapped] of projectConnections) {
    try {
      if (typeof wrapped.flush === 'function') wrapped.flush();
    } catch (e) {
      console.warn(`[DB] 退出落盘失败 ${p}:`, e.message);
    }
  }
}

/**
 * 退出 / 备份前统一落盘：项目库 + **config.db**。
 * 旧实现只遍历项目库连接，配置库被漏掉 —— 改完设置（API key、切换档案、采样参数）
 * 后 250ms 内停止服务，这些改动就随进程一起消失；seed.js 写入的 recent_projects
 * 以及「新建项目」登记的记录同理。凡是调用方想「把内存里的东西全部写盘」，都该用这个。
 */
function flushAllDbs() {
  flushAllProjectDbs();
  try {
    if (configDb && typeof configDb.flush === 'function') configDb.flush();
  } catch (e) {
    console.warn('[DB] 配置库落盘失败:', e.message);
  }
}

function getProjectDb(name) {
  const filePath = getProjectDbPath(name);
  // 刚创建/刚打开的项目：连接已在缓存（flush 是 250ms 防抖，文件可能还没落盘）
  if (projectConnections.has(filePath)) {
    return projectConnections.get(filePath);
  }
  // 已删除的项目：拒绝静默重建空库（否则前端轮询会让文件复活，
  // 导致同名项目无法创建）。创建项目的路径走 openProjectDb。
  if (!fs.existsSync(filePath)) {
    throw new Error(`PROJECT_NOT_FOUND: ${name}`);
  }
  return openProjectDb(filePath);
}

// ═══════════════════════════════════════════════════════════════
// Project DB migrations
// ═══════════════════════════════════════════════════════════════

function tableHasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === column);
  } catch {
    return false;
  }
}

/**
 * 幂等地保证某个列存在，失败即抛错。
 *
 * 旧写法是把 ALTER 丢进 try/catch 里「失败就算了」，而 runMigrations 随后会无条件推进
 * 版本号 —— 「列缺失 + 版本号已升」意味着该步骤永远不会重试，之后每次查询都报
 * "no such column"，且没有任何日志线索。现在改为：先查列 → 缺了才 ALTER → 事后复查确认，
 * 任何环节不成立都抛出（宁可中止启动，也不带未知状态继续跑）。
 */
function ensureColumn(db, table, column, columnDef, tag) {
  if (tableHasColumn(db, table, column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
  } catch (e) {
    throw new Error(`[DB] ${tag} 迁移失败：${table}.${column} —— ${e.message}`);
  }
  if (!tableHasColumn(db, table, column)) {
    throw new Error(`[DB] ${tag} 迁移失败：${table}.${column} 未创建成功`);
  }
}

const projectMigrations = [
  // v0 → v1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS volumes (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL,
        title     TEXT NOT NULL,
        summary   TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chapters (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        volume_id   INTEGER REFERENCES volumes(id) ON DELETE CASCADE,
        num         INTEGER NOT NULL,
        title       TEXT NOT NULL,
        outline     TEXT DEFAULT '',
        content     TEXT DEFAULT '',
        summary     TEXT DEFAULT '',
        word_count  INTEGER DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','writing','review','accepted')),
        cognitive_frame   TEXT DEFAULT '',
        emotional_anchor  TEXT DEFAULT '',
        world_texture     TEXT DEFAULT '',
        concrete_mystery  TEXT DEFAULT '',
        interpersonal_tension TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(volume_id, num)
      );
      CREATE TABLE IF NOT EXISTS characters (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        age         TEXT DEFAULT '',
        gender      TEXT DEFAULT '',
        appearance  TEXT DEFAULT '',
        personality TEXT DEFAULT '',
        background  TEXT DEFAULT '',
        motivation  TEXT DEFAULT '',
        arc         TEXT DEFAULT '',
        ext_markers TEXT DEFAULT '',
        status      TEXT DEFAULT '',
        avatar      TEXT DEFAULT '',
        notes       TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chapter_characters (
        chapter_id  INTEGER REFERENCES chapters(id) ON DELETE CASCADE,
        character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
        role        TEXT DEFAULT 'appears' CHECK (role IN ('appears','speaks','pov','mentioned')),
        PRIMARY KEY (chapter_id, character_id)
      );
      CREATE TABLE IF NOT EXISTS world_entries (
        id          TEXT PRIMARY KEY,
        category    TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags        TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS project_genres (
        genre TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS sidebar_items (
        id          TEXT PRIMARY KEY,
        label_key   TEXT NOT NULL,
        icon        TEXT NOT NULL,
        category    TEXT NOT NULL CHECK (category IN ('universal','genre','optional')),
        genres      TEXT DEFAULT '',
        sort_order  INTEGER NOT NULL,
        route       TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1
      );
      -- Seed default sidebar items
      INSERT OR IGNORE INTO sidebar_items (id, label_key, icon, category, genres, sort_order, route, enabled) VALUES
        ('dashboard',    'sidebar.dashboard',    'LayoutDashboard', 'universal', '',  1,  'page-dashboard',    1),
        ('characters',   'sidebar.characters',   'Users',           'universal', '',  2,  'page-characters',   1),
        ('world',        'sidebar.world',        'Globe',           'universal', '',  3,  'page-world',        1),
        ('science',      'sidebar.science',      'FlaskConical',    'genre', 'sci-fi',  4,  'page-science',      1),
        ('outline_page', 'sidebar.outline_page', 'ScrollText',      'universal', '',  5,  'page-outline',      1),
        ('foreshadow',   'sidebar.foreshadow',   'Link2',           'universal', '',  6,  'page-foreshadow',   1),
        ('memory',       'sidebar.memory',       'Brain',           'universal', '',  7,  'page-memory',       1),
        ('relations',    'sidebar.relations',    'HeartHandshake',  'universal', '',  8,  'page-relations',    1),
        ('timeline',     'sidebar.timeline',     'CalendarDays',    'universal', '',  9,  'page-timeline',     1),
        ('consistency',  'sidebar.consistency',  'ShieldCheck',     'universal', '',  10, 'page-consistency',  1),
        ('export',       'sidebar.export',       'Download',        'universal', '',  11, 'page-export',       1);
      CREATE TABLE IF NOT EXISTS foreshadows (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        description     TEXT DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'planted' CHECK (status IN ('planted','progressing','resolved','abandoned')),
        planted_chapter_id    INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        expected_resolve_chapter INTEGER,
        resolved_chapter_id   INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        priority        TEXT DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS memories (
        id          TEXT PRIMARY KEY,
        category    TEXT NOT NULL CHECK (category IN ('character','location','item','event','promise','other')),
        content     TEXT NOT NULL,
        source_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS character_relations (
        id              TEXT PRIMARY KEY,
        character_a_id  TEXT REFERENCES characters(id) ON DELETE CASCADE,
        character_b_id  TEXT REFERENCES characters(id) ON DELETE CASCADE,
        relation_type   TEXT NOT NULL,
        description     TEXT DEFAULT '',
        intensity       INTEGER DEFAULT 3,
        started_at      TEXT DEFAULT '',
        ended_at        TEXT DEFAULT '',
        layout_x        REAL,
        layout_y        REAL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS science_entries (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL CHECK (label IN ('known','extrapolation','hypothesis')),
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        "references"  TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS timeline_events (
        id          TEXT PRIMARY KEY,
        year        TEXT NOT NULL,
        title       TEXT NOT NULL,
        description TEXT DEFAULT '',
        importance  INTEGER DEFAULT 3,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS clue_board (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        description     TEXT DEFAULT '',
        kind            TEXT DEFAULT '' CHECK (kind IN ('clue','red-herring','deduction','question')),
        related_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        resolved        INTEGER NOT NULL DEFAULT 0,
        resolved_at     TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS token_usage (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        task_name       TEXT NOT NULL,
        chapter_num     INTEGER,
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        context_tokens  INTEGER,
        model           TEXT DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL DEFAULT '新对话',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK (role IN ('user', 'ai', 'system')),
        content     TEXT NOT NULL,
        tool_calls  TEXT DEFAULT '[]',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_chapters_status ON chapters(status);
      CREATE INDEX IF NOT EXISTS idx_chapters_volume ON chapters(volume_id, num);
      CREATE INDEX IF NOT EXISTS idx_chapters_order ON chapters(num);
      CREATE INDEX IF NOT EXISTS idx_characters_name ON characters(name);
      CREATE INDEX IF NOT EXISTS idx_foreshadows_status ON foreshadows(status);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    `);
  },
  // v1 → v2: chat_messages.session_id（老库补列）+ 索引
  (db) => {
    // 原语句带 REFERENCES + NOT NULL DEFAULT ''，SQLite 会拒绝（"Cannot add a REFERENCES
    // column with non-NULL default value"），于是老库上这一步一直静默失败、列始终缺失。
    // 这里用普通列保证一定加上；该外键对 sql.js 无实际约束力，不值得为它牺牲可用性。
    ensureColumn(db, 'chat_messages', 'session_id', "TEXT NOT NULL DEFAULT ''", 'v1→v2');
    db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)");
  },
  // v2 → v3: 章节定稿自动总结的支撑结构
  (db) => {
    ensureColumn(db, 'chapters', 'summary_pending', 'INTEGER DEFAULT 0', 'v2→v3');
    db.exec(`
      CREATE TABLE IF NOT EXISTS relation_snapshots (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_id      INTEGER,
        character_a_id  TEXT,
        character_b_id  TEXT,
        relation_type   TEXT,
        description     TEXT,
        intensity       INTEGER,
        note            TEXT DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS foreshadow_changes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        foreshadow_id   TEXT,
        chapter_id      INTEGER,
        old_status      TEXT,
        new_status      TEXT,
        note            TEXT DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
  // v3 → v4: 角色状态（死亡/隐退/暂离…简短文字），供关系图与 AI 协作判断角色是否仍在叙事中
  (db) => {
    ensureColumn(db, 'characters', 'status', "TEXT DEFAULT ''", 'v3→v4');
  },
];

const getProjectVersion = makeVersionGetter('project_meta');
const setProjectVersion = makeVersionSetter('project_meta');

function migrateProject(db) {
  runMigrations(db, projectMigrations, PROJECT_SCHEMA_VERSION, getProjectVersion, setProjectVersion);
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Config DB query wrappers
// ═══════════════════════════════════════════════════════════════

function dbQuery(sql, params = []) {
  const db = getConfigDb();
  return db.prepare(sql).all(...params);
}

function dbGet(sql, params = []) {
  const db = getConfigDb();
  return db.prepare(sql).get(...params) || null;
}

function dbExecute(sql, params = []) {
  const db = getConfigDb();
  const result = db.prepare(sql).run(...params);
  return result.changes;
}

// ═══════════════════════════════════════════════════════════════
// Project-specific query wrappers
// ═══════════════════════════════════════════════════════════════

function projectQuery(projectName, sql, params = []) {
  const db = getProjectDb(projectName);
  return db.prepare(sql).all(...params);
}

function projectGet(projectName, sql, params = []) {
  const db = getProjectDb(projectName);
  return db.prepare(sql).get(...params) || null;
}

function projectExecute(projectName, sql, params = []) {
  const db = getProjectDb(projectName);
  const result = db.prepare(sql).run(...params);
  return result.changes;
}

function projectTransaction(projectName, fn) {
  const db = getProjectDb(projectName);
  return db.transaction(fn)();
}

// ═══════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════

function recalculateWordCount(projectName) {
  const total = projectGet(projectName, 'SELECT SUM(word_count) as total FROM chapters')?.total || 0;
  projectExecute(projectName, "UPDATE project_meta SET value = ? WHERE key = 'word_count'", [String(total)]);
  projectExecute(projectName, "UPDATE project_meta SET value = ? WHERE key = 'updated_at'", [new Date().toISOString()]);
}

function getCoverDir(projectName) {
  // 封面同样按项目名建子目录 → 与项目库同一条路径安全约束
  return path.join(PROJECTS_DIR, assertValidProjectName(projectName));
}

function getExportsDir(projectName) {
  return projectName ? path.join(EXPORTS_DIR, assertValidProjectName(projectName)) : EXPORTS_DIR;
}

function findCoverPath(projectName) {
  const coverDir = getCoverDir(projectName);
  const exts = ['png', 'jpg', 'webp', 'gif'];
  for (const ext of exts) {
    const p = path.join(coverDir, `cover.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const MIME_TO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const EXT_TO_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

// ═══════════════════════════════════════════════════════════════
// Storage location (feature: 设置中修改数据库位置)
// ═══════════════════════════════════════════════════════════════

function getStorageInfo() {
  return { currentDir: DB_DIR, isDefault: DB_DIR === DEFAULT_DB_DIR, defaultDir: DEFAULT_DB_DIR };
}

/**
 * Copy config.db + projects/ + exports/ + snapshots/ from the current storage dir to a new
 * directory, then update the bootstrap file to point there. Old files are left
 * in place (not deleted) so the user can verify before removing them manually.
 * Caller is responsible for restarting the server afterwards — this function
 * only prepares the new location; it does not swap the live DB_DIR in-process.
 */
function migrateStorageLocation(newDir) {
  if (!newDir || typeof newDir !== 'string') throw new Error('新路径不能为空');
  const resolved = path.resolve(newDir);
  if (resolved === path.resolve(DB_DIR)) throw new Error('新路径与当前路径相同');

  // Validate target is usable: must not already be an existing Mythpen dir with data,
  // and must be writable (create it if missing).
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  } else {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) throw new Error('目标路径不是一个文件夹');
  }
  // Writability check
  const probe = path.join(resolved, `.write-test-${Date.now()}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);

  // Copy config.db
  if (fs.existsSync(CONFIG_DB)) {
    fs.cpSync(CONFIG_DB, path.join(resolved, 'config.db'));
  }
  // Copy projects/
  if (fs.existsSync(PROJECTS_DIR)) {
    fs.cpSync(PROJECTS_DIR, path.join(resolved, 'projects'), { recursive: true });
  }
  // Copy exports/ (may not exist yet)
  if (fs.existsSync(EXPORTS_DIR)) {
    fs.cpSync(EXPORTS_DIR, path.join(resolved, 'exports'), { recursive: true });
  }
  // Copy snapshots/ — 里程碑快照是用户数据，漏掉它会让"迁移目录"变成静默丢快照
  if (fs.existsSync(SNAPSHOTS_DIR)) {
    fs.cpSync(SNAPSHOTS_DIR, path.join(resolved, 'snapshots'), { recursive: true });
  }

  // Update bootstrap file (always in the fixed default location)
  if (!fs.existsSync(DEFAULT_DB_DIR)) fs.mkdirSync(DEFAULT_DB_DIR, { recursive: true });
  fs.writeFileSync(BOOTSTRAP_FILE, resolved + '\n', 'utf-8');

  return { newDir: resolved, oldDir: DB_DIR };
}

module.exports = {
  initDatabase,
  getConfigDb,
  getProjectDb,
  getProjectDbPath,
  getProjectsDir,
  validateProjectName,
  assertValidProjectName,
  openProjectDb,
  closeProjectDb,
  discardProjectDb,
  getSnapshotsDir,
  isValidSqliteFile,
  dbQuery,
  dbGet,
  dbExecute,
  projectQuery,
  projectGet,
  projectExecute,
  projectTransaction,
  recalculateWordCount,
  getCoverDir,
  getExportsDir,
  findCoverPath,
  MIME_TO_EXT,
  EXT_TO_MIME,
  getStorageInfo,
  migrateStorageLocation,
  flushAllProjectDbs,
  flushAllDbs,
};
