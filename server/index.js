const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const apiRoutes = require('./routes/api');
const { TOOLS, executeTool } = require('./tools');
const { createAIAdapter, detectProvider, isTruncatedReason } = require('./ai-adapter');
const { buildWritingPrompt } = require('./prompts/writing');
const { buildCollabPrompt } = require('./prompts/collab');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Request logging ───
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path.startsWith('/api/ai')) return; // don't log AI streaming
    console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ─── API Routes ───
app.use('/api', apiRoutes);

// ═══════════════════════════════════════════
// AI CONFIG — read from config.db
// ═══════════════════════════════════════════

// ─── AI Config cache (invalidated when settings are updated) ───
let aiConfigCache = null;

function invalidateAiConfigCache() {
  aiConfigCache = null;
}

function getAiConfig() {
  if (aiConfigCache) return aiConfigCache;

  const DEFAULTS = {
    apiBaseUrl: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_KEY || '',
    apiModel: 'deepseek-v4-flash',
    apiType: '',
    maxOutputTokens: 4096,
    contextLimit: 128000,
    targetWords: 0,
  };
  try {
    const db = require('./db');
    const rows = db.dbQuery('SELECT key, value FROM app_settings');
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    aiConfigCache = {
      apiBaseUrl: map.api_base_url || DEFAULTS.apiBaseUrl,
      apiKey: map.api_key || DEFAULTS.apiKey,
      apiModel: map.api_model || DEFAULTS.apiModel,
      apiType: map.api_type || DEFAULTS.apiType,
      maxOutputTokens: parseInt(map.max_output_tokens, 10) || DEFAULTS.maxOutputTokens,
      contextLimit: parseInt(map.context_limit, 10) || DEFAULTS.contextLimit,
      targetWords: parseInt(map.target_words, 10) || DEFAULTS.targetWords,
      // 采样参数：undefined 表示用户未设置 → 适配器不发送该字段（黄金规则）
      temperature: map.temperature !== undefined && map.temperature !== '' ? parseFloat(map.temperature) : undefined,
      topP: map.top_p !== undefined && map.top_p !== '' ? parseFloat(map.top_p) : undefined,
      // 思维链语言：'writing' 才注入提示词，其余/未设置不干预（黄金规则）
      reasoningLang: map.reasoning_lang || undefined,
      // 思考档位：未设置/默认 → 适配器不发送任何思考参数（黄金规则）
      thinkingLevel: map.thinking_level || undefined,
    };
    return aiConfigCache;
  } catch (e) {
    return { ...DEFAULTS };
  }
}


// ─── AI Provider Profiles (multi-profile management) ───
// providers is stored as a JSON array in app_settings. The active profile is
// flattened into the legacy api_* keys on save, so every existing AI route
// (chat / chat/stream / continue / test) keeps working without changes.

function loadProviders() {
  const db = require('./db');
  const rows = db.dbQuery("SELECT key, value FROM app_settings WHERE key IN ('providers', 'active_provider_id')");
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  if (map.providers) {
    try {
      const providers = JSON.parse(map.providers);
      if (Array.isArray(providers) && providers.length > 0) {
        return { providers, activeId: map.active_provider_id || providers[0].id };
      }
    } catch { /* corrupted JSON — fall through to migration */ }
  }
  // First run: migrate legacy flat settings into a default profile
  const ai = getAiConfig();
  const providers = [{
    id: 'default',
    name: '默认',
    type: ai.apiType || 'openai',
    baseUrl: ai.apiBaseUrl,
    apiKey: ai.apiKey,
    model: ai.apiModel,
    contextLimit: 128000,
    maxTokens: 4096,
    targetWords: 0,
    temperature: ai.temperature,
    topP: ai.topP,
    toppSupported: null,
  }];
  persistProviders(providers, 'default');
  return { providers, activeId: 'default' };
}

function persistProviders(providers, activeId) {
  const db = require('./db');
  db.dbExecute('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', ['providers', JSON.stringify(providers)]);
  db.dbExecute('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', ['active_provider_id', activeId]);
  const active = providers.find(p => p.id === activeId) || providers[0];
  if (active) {
    const flat = [
      ['api_base_url', active.baseUrl || ''],
      ['api_key', active.apiKey || ''],
      ['api_model', active.model || ''],
      ['api_type', active.type || 'openai'],
      ['max_output_tokens', String(active.maxTokens || 4096)],
      ['context_limit', String(active.contextLimit || 128000)],
      ['target_words', String(active.targetWords || 0)],
      // 采样参数：undefined/null 存空串表示"未设置"（不发送该字段）
      ['temperature', active.temperature !== undefined && active.temperature !== null ? String(active.temperature) : ''],
      ['top_p', active.topP !== undefined && active.topP !== null ? String(active.topP) : ''],
      // 探针结果：top_p 字段是否被当前供应商接受（null = 未探测）
      ['topp_supported', active.toppSupported === true ? 'true' : active.toppSupported === false ? 'false' : ''],
      ['reasoning_lang', active.reasoningLang === 'writing' ? 'writing' : ''],
      ['thinking_level', active.thinkingLevel && active.thinkingLevel !== 'default' ? active.thinkingLevel : ''],
    ];
    for (const [key, value] of flat) {
      db.dbExecute('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, value]);
    }
  }
}

app.get('/api/ai/providers', (req, res) => {
  try {
    res.json(loadProviders());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/ai/providers', (req, res) => {
  const { providers, activeId } = req.body || {};
  if (!Array.isArray(providers) || providers.length === 0) {
    return res.status(400).json({ error: 'providers 数组不能为空' });
  }
  if (!providers.some(p => p.id === activeId)) {
    return res.status(400).json({ error: 'activeId 必须对应 providers 中的一项' });
  }
  persistProviders(providers, activeId);
  invalidateAiConfigCache();
  res.json({ success: true });
});

// ─── 采样参数探针（第 4 层兼容性检测）───
// 用极小请求实测当前供应商是否接受 top_p 字段，结果写入档案供 UI 提示。
// 不影响任何创作数据，仅探测上游 API 行为。
app.post('/api/ai/probe-sampling', async (req, res) => {
  const { baseUrl, apiKey, model, type } = req.body || {};
  if (!baseUrl || !model) return res.status(400).json({ error: '缺少 baseUrl 或 model' });

  const provider = detectProvider(model, type);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    // 温度探针：0 值最小化输出随机性（探针用途，非用户设置）
    // top_p 探针：1.0 是"不截断"的中性值
    const body = { temperature: 0, top_p: 1, max_tokens: 1 };

    let status, text;
    if (provider === 'claude') {
      const base = String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
      const response = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }], ...body }),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } else if (provider === 'gemini') {
      let base = String(baseUrl).replace(/\/+$/, '');
      if (!/\/v\d+(beta|alpha)?$/.test(base)) base += '/v1beta';
      const modelPath = String(model).replace(/^models\//, '').replace(/^google\//, '');
      const response = await fetch(`${base}/models/${modelPath}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey || '' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1, temperature: 0, topP: 1 },
        }),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } else {
      // openai / openai-response 都先探 /v1/chat/completions（覆盖率最高）
      let base = String(baseUrl).replace(/\/+$/, '');
      if (!/\/v\d+$/.test(base)) base += '/v1';
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || ''}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...body }),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    }

    // 2xx = 接受；400 且错误点名 top_p = 不支持；其他错误无法判断（可能 key/模型本身有问题）
    let toppSupported = null;
    if (status >= 200 && status < 300) {
      toppSupported = true;
    } else if (status === 400 && /top_p|topp/i.test(text)) {
      toppSupported = false;
    }

    res.json({ status, toppSupported, detail: text.slice(0, 300) });
  } catch (e) {
    res.json({ status: 0, toppSupported: null, detail: e.message });
  } finally {
    clearTimeout(timeout);
  }
});

// ─── Fetch available models under a key (proxied: no CORS, key stays server-side) ───

app.post('/api/ai/models', async (req, res) => {
  try {
    const { baseUrl, apiKey, type } = req.body || {};
    if (!baseUrl) return res.status(400).json({ error: { message: '缺少 baseUrl' } });

    const base = baseUrl.replace(/\/+$/, '');
    const isGemini = type === 'gemini' || type === 'google';
    // 不同中转站的模型列表路径不一致，按可能性依次尝试
    const candidates = [];
    if (type === 'claude') {
      candidates.push(`${base}/v1/models`, `${base}/models`);
    } else if (isGemini) {
      const gbase = /\/v\d+(beta|alpha)?$/.test(base) ? base : `${base}/v1beta`;
      candidates.push(`${gbase}/models`);
    } else if (/\/v\d+$/.test(base)) {
      candidates.push(`${base}/models`);
    } else {
      candidates.push(`${base}/models`, `${base}/v1/models`);
    }

    let lastStatus = 0;
    let lastText = '';
    for (const url of candidates) {
      const headers = { 'Content-Type': 'application/json' };
      if (type === 'claude') {
        headers['x-api-key'] = apiKey || '';
        headers['anthropic-version'] = '2023-06-01';
        headers['Authorization'] = `Bearer ${apiKey || ''}`; // 部分中转站只认 Bearer
      } else if (isGemini) {
        headers['x-goog-api-key'] = apiKey || '';
      } else {
        headers['Authorization'] = `Bearer ${apiKey || ''}`;
      }

      let response;
      try {
        response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      } catch (e) {
        lastStatus = 0;
        lastText = e.message;
        continue;
      }
      if (response.ok) {
        const text = await response.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          // 200 但返回了 HTML/网页——该路径不是 API，继续尝试下一个候选
          lastStatus = response.status;
          lastText = '响应不是 JSON（可能命中了中转站的网页而非 API 路径）';
          continue;
        }
        const list = Array.isArray(data) ? data : data.data || data.models || [];
        // OpenAI 系返回 id；Gemini 返回 name（形如 models/gemini-2.5-pro）
        const models = list
          .map((m) => m.id || m.name)
          .filter(Boolean)
          .map((id) => String(id).replace(/^models\//, ''))
          .sort();
        return res.json({ models });
      }
      lastStatus = response.status;
      lastText = (await response.text()).slice(0, 200);
      if (response.status !== 404) break; // 401/403 等鉴权错误换路径也没用
    }

    const reason = lastStatus ? `上游返回 ${lastStatus}` : '无法连接上游';
    return res.status(502).json({ error: { message: `${reason}：${lastText || '无响应内容'}` } });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});


// 端点和模型错配提示：常见于 claude 类型打 OpenAI 兼容服务（如
// DeepSeek 官方只有 /chat/completions，没有 /v1/messages，返回 404）。
function mismatchHint(aiConfig, err) {
  const url = String(aiConfig.apiBaseUrl || '').toLowerCase();
  const type = String(aiConfig.apiType || '').toLowerCase();
  const model = String(aiConfig.apiModel || '').toLowerCase();
  if (url.includes('deepseek') && (type === 'claude' || type === 'anthropic')) {
    return '（检测到 DeepSeek 官方 API + Anthropic 类型错配：DeepSeek 官方只支持 OpenAI 兼容格式，请把接口类型改为 OpenAI）';
  }
  if (model.startsWith('deepseek') && (type === 'claude' || type === 'anthropic')) {
    return '（检测到 DeepSeek 模型 + Anthropic 类型错配：请把接口类型改为 OpenAI）';
  }
  if (model.startsWith('claude') && (type === 'openai' || type === 'openai-response')) {
    return '（检测到 Claude 模型 + OpenAI 类型错配：请把接口类型改为 Anthropic）';
  }
  if (err.status === 404 && (type === 'claude' || type === 'anthropic')) {
    return '（404 常见原因：接口类型/地址与所选服务不匹配——Anthropic 类型会请求 /v1/messages，若你的服务不支持该端点请改用 OpenAI 类型）';
  }
  // 采样参数兼容性：上游 400 且错误文本点名 temperature/top_p 时给出建议（第 3 层兜底）
  if (err.status === 400) {
    const detail = String(err.detail || err.message || '').toLowerCase();
    // 中转站 OpenAI 端点对工具调用不稳定：实测同一份合法请求在 Packy+GLM 上随机返回
    // tools[0].name 缺失（约 50%），而该模型的 Anthropic 端点稳定。提示切换协议。
    if (/tools\[\d+\]/.test(detail) && /name is invalid or missing/.test(detail) && !(type === 'claude' || type === 'anthropic')) {
      return '（该模型的 OpenAI 端点在此中转上对工具调用不稳定：可在设置中把「接口类型」切换为 Anthropic 后重试，同一模型走 /v1/messages 更稳定）';
    }
    if (detail.includes('temperature')) {
      return type === 'claude' || type === 'anthropic'
        ? '（上游拒绝了 temperature 参数：Anthropic 协议范围是 0-1，请在设置中调整后重试，或清空该参数让其使用模型默认值）'
        : '（上游拒绝了 temperature 参数：请确认该模型支持自定义温度（部分推理模型忽略/禁用此参数），或清空该参数让其使用模型默认值）';
    }
    if (detail.includes('top_p') || detail.includes('topp')) {
      return '（上游拒绝了 top_p 参数：该模型/服务可能不支持此参数，建议在设置中清空 top_p 后重试）';
    }
    // Claude 新一代模型已移除手动思考预算：'enabled'/'disabled' 两种写法都会被 400 拒绝
    // （错误原文为 thinking.type.enabled is not supported for this model）
    if (detail.includes('thinking.type.enabled') || detail.includes('thinking.type.disabled')) {
      return '（该模型不支持手动设置思考档位：请在设置中把「思考档位」改回「默认」，是否思考由模型自行决定）';
    }
    if (detail.includes('thinkingconfig') || detail.includes('includeoughts') || detail.includes('includethoughts')) {
      return '（上游拒绝了 thinkingConfig/includeThoughts：该模型不支持思考回传，建议改用 Gemini 2.5+ 或其他推理模型）';
    }
    if (detail.includes('thought_signature')) {
      return '（Gemini 要求回传 thoughtSignature：请重试；若持续出现，请新开一个会话）';
    }
  }
  // 容量型 / 限流：属于上游临时故障，稍后重试即可
  if (err.status === 429 || err.status === 503) {
    return '（上游当前过载或限流，属临时故障，稍候重试即可）';
  }
  return '';
}

// 工具名 → 中文进度描述（带 args 时对高频工具细化，如"写入第3章正文"）
function toolHint(name, args = {}) {
  const truncate = (s, n = 12) => {
    const t = String(s ?? '');
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  // 参数被截断时 args 是空对象，直接拼字符串会在界面上显示「更新第undefined章」。
  // 这类调用已被 missingRequiredArgs 拦下不执行，提示语据实说明。
  if (['get_chapter', 'update_chapter', 'delete_chapter'].includes(name) && args.chapter_num === undefined) {
    return '参数不完整，未传章节号';
  }
  switch (name) {
    // 章节与卷
    case 'list_chapters': return '查看章节列表';
    case 'get_chapter': return `读取第${args.chapter_num}章内容`;
    case 'create_chapter': return `创建章节「${truncate(args.title)}」`;
    case 'update_chapter': {
      if (args.content !== undefined) return `写入第${args.chapter_num}章正文`;
      if (args.outline !== undefined) return `撰写第${args.chapter_num}章大纲`;
      if (args.status === 'accepted') return `定稿第${args.chapter_num}章`;
      if (args.status === 'review') return `第${args.chapter_num}章送审`;
      if (args.cognitive_frame !== undefined || args.emotional_anchor !== undefined) return `设定第${args.chapter_num}章叙事维度`;
      return `更新第${args.chapter_num}章`;
    }
    case 'delete_chapter': return `删除第${args.chapter_num}章`;
    case 'list_volumes': return '查看卷结构';
    case 'create_volume': return `创建卷「${truncate(args.title)}」`;
    case 'update_volume': return `更新卷「${truncate(args.title)}」`;
    case 'delete_volume': return '删除卷';
    // 角色
    case 'list_characters': return '查看角色列表';
    case 'get_character': return `读取角色「${truncate(args.name)}」详情`;
    case 'create_character': return `创建角色「${truncate(args.name)}」`;
    case 'update_character': return `更新角色「${truncate(args.name)}」`;
    case 'delete_character': return `删除角色「${truncate(args.name)}」`;
    case 'list_relations': return '查看人物关系';
    case 'create_relation': return `建立关系：${truncate(args.character_a)} ↔ ${truncate(args.character_b)}`;
    case 'update_relation': return '更新人物关系';
    case 'delete_relation': return '删除人物关系';
    // 世界观 / 科幻
    case 'list_world': return '查看世界观';
    case 'create_world_entry': return `添加世界观「${truncate(args.name)}」`;
    case 'update_world_entry': return `更新世界观「${truncate(args.name)}」`;
    case 'delete_world_entry': return '删除世界观条目';
    case 'list_science': return '查看科幻设定';
    case 'create_science_entry': return `添加科幻设定「${truncate(args.name)}」`;
    case 'delete_science_entry': return '删除科幻设定';
    // 伏笔 / 线索 / 记忆 / 时间线
    case 'list_foreshadows': return '查看伏笔';
    case 'create_foreshadow': return `埋设伏笔「${truncate(args.title)}」`;
    case 'update_foreshadow': return `推进伏笔「${truncate(args.title)}」`;
    case 'delete_foreshadow': return `删除伏笔「${truncate(args.title)}」`;
    case 'list_clues': return '查看线索板';
    case 'create_clue': return `记录线索「${truncate(args.title)}」`;
    case 'update_clue': return `更新线索「${truncate(args.title)}」`;
    case 'delete_clue': return `删除线索「${truncate(args.title)}」`;
    case 'list_memories': return '查看叙事记忆';
    case 'create_memory': return `记录叙事记忆：${truncate(args.content)}`;
    case 'update_memory': return '更新叙事记忆';
    case 'delete_memory': return '删除叙事记忆';
    case 'list_timeline': return '查看时间线';
    case 'create_timeline_event': return `记录时间线事件「${truncate(args.title)}」`;
    case 'update_timeline_event': return `更新时间线事件「${truncate(args.title)}」`;
    case 'delete_timeline_event': return '删除时间线事件';
    // 章节↔角色出场
    case 'list_chapter_characters': return `查看第${args.chapter_num}章出场角色`;
    case 'set_chapter_character': return `登记「${truncate(args.character_name)}」在第${args.chapter_num}章出场`;
    case 'remove_chapter_character': return `移除「${truncate(args.character_name)}」出场记录`;
    // 项目状态
    case 'update_project_phase': return '推进创作阶段';
    case 'get_project_meta': return '读取项目信息';
    case 'get_stats': return '读取统计信息';
    default: return `执行 ${name}`;
  }
}

// ─── 工具参数完整性校验 ───
// 上游被输出上限截断时，工具调用可能带着空对象或半截 JSON 到达
// （实测 Packy+GLM：update_chapter 共 42 次调用，其中 30 次参数为空）。
// 直接执行只会得到「没有要更新的字段」这类看不出原因的结果，模型也无从自纠。
// 这里按工具 schema 的 required 判定：缺必填项就不执行，把原因写回对话要求重发。
function missingRequiredArgs(name, args) {
  const def = TOOLS.find((t) => t.function?.name === name)?.function;
  const required = def?.parameters?.required;
  if (!Array.isArray(required) || required.length === 0) return [];
  // 参数不是对象（空对象、null、被截断成字符串）时，全部必填项都算缺失
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [...required];
  return required.filter((key) => args[key] === undefined || args[key] === null);
}

// ─── 轮次进度提示 ───
// 模型思考期间（一轮可能长达数十秒）让进度条有真实信息量：
// 写作模式报剩余未定稿章节，共创模式报当前所处阶段。
function roundHint(project, mode) {
  try {
    if (mode === 'collab') {
      const meta = db.projectGet(project, "SELECT value FROM project_meta WHERE key = 'workflow_phase'");
      const label = ({ idea: '选题', setting: '设定共创', outline: '分卷规划', writing: '交付前三章', review: '审阅', consistency: '一致性检查', export: '导出' })[meta?.value];
      return label ? `共创中 · ${label}阶段` : '共创中 · 正在确认项目状态';
    }
    const row = db.projectGet(project, "SELECT COUNT(*) AS c FROM chapters WHERE status != 'accepted'");
    const pending = row?.c || 0;
    if (pending > 0) return `写作中 · 待完成 ${pending} 章`;
    return '写作中 · 正在确认章节状态';
  } catch {
    return '正在分析项目与执行工具';
  }
}

// ─── 采样参数取值 ───
// body 显式传入（数字）优先；否则用档案值；两者都没有 → undefined（不发送）
// 思维链语言（软控制）：'writing' 时提示模型用与正文相同的语言思考。
// 不写死具体语种——写作语言由模型从用户输入/正文自行识别（项目 language 仅存 'auto'）。
// 未设置 / 'default' 不注入任何指令，跟随模型默认（黄金规则）。
const REASONING_LANG_HINT = '（思考语言：请使用与正文相同的语言进行思考，不要换用其他语言思考。）';

function withReasoningLang(systemPrompt, aiConfig) {
  if (!aiConfig || aiConfig.reasoningLang !== 'writing') return systemPrompt;
  return `${systemPrompt}\n\n${REASONING_LANG_HINT}`;
}

// 思维链语言的第二个落点：最后一条用户消息。
// 只写在系统提示词里，对 Claude 新一代模型的思考块几乎没有作用——思考块语言由模型
// 自身决定，系统提示词到不了那一层；写在会话里（用户轮次）才有效。两处都写：
// 跟随系统提示词的模型（DeepSeek/GLM/Gemini）走前者，Claude 走后者。
function withReasoningLangOnMessages(messages, aiConfig) {
  if (!aiConfig || aiConfig.reasoningLang !== 'writing') return messages;
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { idx = i; break; }
  }
  if (idx < 0 || typeof messages[idx].content !== 'string') return messages;
  const next = messages.slice();
  next[idx] = { ...messages[idx], content: `${messages[idx].content}\n\n${REASONING_LANG_HINT}` };
  return next;
}

function resolveSampling(aiConfig, body = {}) {
  const temperature = typeof body.temperature === 'number' && isFinite(body.temperature)
    ? body.temperature
    : aiConfig.temperature;
  const topP = typeof body.topP === 'number' && isFinite(body.topP)
    ? body.topP
    : aiConfig.topP;
  // 两者都未定义时返回 undefined，让适配器走"不发送"路径
  if (temperature === undefined && topP === undefined) return undefined;
  return { temperature, topP };
}

// ─── AI Chat Completion (non-streaming) ───
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { messages, project } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages is required' });
    }

    const aiConfig = getAiConfig();
    // 测试连接时允许前端传入 API key/baseUrl/model 覆盖数据库配置
    if (req.body.apiKey !== undefined) {
      aiConfig.apiKey = req.body.apiKey;
    }
    if (req.body.apiBaseUrl !== undefined) {
      aiConfig.apiBaseUrl = req.body.apiBaseUrl;
    }
    if (req.body.apiModel !== undefined) {
      aiConfig.apiModel = req.body.apiModel;
    }
    if (req.body.apiType !== undefined) {
      aiConfig.apiType = req.body.apiType;
    }
    const adapter = createAIAdapter(aiConfig.apiModel, aiConfig, aiConfig.apiType);
    const systemPrompt = withReasoningLang(buildWritingPrompt(project, aiConfig), aiConfig);

    const result = await adapter.complete(systemPrompt, withReasoningLangOnMessages(messages, aiConfig), null, resolveSampling(aiConfig, req.body));

    // Record token usage
    if (result.usage.inputTokens || result.usage.outputTokens) {
      try {
        const db = require('./db');
        db.projectExecute(project,
          'INSERT INTO token_usage (task_name, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?)',
          ['chat', result.usage.inputTokens, result.usage.outputTokens, aiConfig.apiModel]
        );
      } catch(e) {
          console.warn('[AI Chat] Failed to record token usage:', e.message);
        }
    }

    res.json({
      choices: [{ message: { content: result.content, role: 'assistant' } }],
      usage: { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens },
    });
  } catch (err) {
    console.error('AI chat error:', err.status || '', err.detail || err.message);
    // 与 /chat/stream 对齐：透出上游真实 status + detail，否则测试连接只显示
    // 一句 "API Error: 503"，用户看不到 Google 返回的容量/限流说明。
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    const hint = mismatchHint(aiConfig, err);
    const message = err.status ? `API Error: ${err.status}${hint}` : (err.message || 'Unknown error');
    res.status(status).json({ error: message, detail: err.detail || '' });
  }
});


// ─── AI Streaming Chat with Tool Calling (SSE) ───
app.post('/api/ai/chat/stream', async (req, res) => {
  try {
    const { messages, project, mode = 'writing' } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages is required' });
    }

    const aiConfig = getAiConfig();
    const adapter = createAIAdapter(aiConfig.apiModel, aiConfig, aiConfig.apiType);
    const systemPrompt = withReasoningLang(
      mode === 'collab' ? buildCollabPrompt(project, aiConfig) : buildWritingPrompt(project, aiConfig),
      aiConfig,
    );

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write(':ok\n\n');

    const conversation = withReasoningLangOnMessages(messages, aiConfig); // system is passed separately to adapter
    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let emptyCount = 0; // 连续空响应（无文本无工具调用）容忍次数
    let continueCount = 0; // 正文被输出上限截断后的续写次数
    const MAX_TOOL_ROUNDS = 120;
    const MAX_EMPTY_ROUNDS = 4;
    // 续写上限：每次续写都要重新消耗一轮完整输出额度，而 GLM-5.3 这类
    // 中转的思考量与任务复杂度正相关，续写同样可能被思考占满。
    // 给 3 次机会，保留半截内容且不无限烧额度。
    const MAX_CONTINUE_ROUNDS = 3;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // 通知前端当前进行到第几轮（模型思考期间的提示，带真实信息量）
      res.write(`event: progress\ndata: ${JSON.stringify({ round, doneTools: round, hint: roundHint(project, mode) })}\n\n`);
      console.log(`[AI Stream] Round ${round}, messages: ${conversation.length}`);

      let result;
      try {
        // Packy 在 GLM 上会间歇性把同一份合法 tools 请求判成
        // tools[0].function.name 缺失（文案里 function 显示成 ***）。
        // 同一请求体重试往往就能过，不要当成工具定义错误直接中止。
        const sampling = resolveSampling(aiConfig, req.body);
        let lastErr;
        let transientRetries = 0;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            result = await adapter.complete(systemPrompt, conversation, TOOLS, sampling);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const detail = String(err.detail || '');
            // 同一份合法请求被上游间歇性判成工具名缺失（Packy+GLM 实测随机触发）
            const flakyToolName = err.status === 400 && /tools\[\d+\]/.test(detail) && /name is invalid or missing/.test(detail);
            // 超时/限流/网关故障等临时错误：Google 503 常由模型高并发触发，
            // 多等一会儿再试比立刻失败更可靠
            const transient = err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504;
            if (flakyToolName) {
              if (attempt === 3) break;
              console.warn(`[AI Stream] 上游间歇性拒绝工具名，重试 ${attempt + 1}/3`);
              await new Promise(r => setTimeout(r, 400));
            } else if (transient) {
              if (transientRetries >= 2 || attempt >= 3) break;
              const waitMs = transientRetries === 0 ? 800 : 2000;
              transientRetries++;
              console.warn(`[AI Stream] 上游临时故障 ${err.status}，${waitMs}ms 后重试（${transientRetries}/2）`);
              await new Promise(r => setTimeout(r, waitMs));
            } else {
              break;
            }
          }
        }
        if (lastErr) throw lastErr;
      } catch (err) {
        console.error('[AI Stream] 上游请求失败:', err.status || '', err.detail || err.message || err);
        const detail = err.detail || err.message || '';
        const hint = mismatchHint(aiConfig, err);
        if (err.status === 400 || err.status === 404) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: `API Error: ${err.status}${hint}`, detail })}\n\n`);
        } else if (err.status) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: `API Error: ${err.status}`, detail })}\n\n`);
        } else {
          res.write(`event: error\ndata: ${JSON.stringify({ error: err.message, detail })}\n\n`);
        }
        res.end();
        return;
      }

      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;

      const truncated = !!result.truncated;
      console.log(`[AI Stream] Round ${round} result:`, {
        hasContent: !!result.content,
        contentLen: result.content?.length || 0,
        hasToolCalls: result.toolCalls.length > 0,
        toolCallNames: result.toolCalls.map(tc => tc.name) || [],
        hasReasoning: !!result.reasoning,
        stopReason: result.stopReason || '(未返回)',
        truncated,
        outputTokens: result.usage.outputTokens,
      });
      if (truncated) {
        console.warn(`[AI Stream] 第 ${round} 轮被输出上限截断（stopReason=${result.stopReason}，outputTokens=${result.usage.outputTokens}）`);
      }

      // 思考链：独立事件推送，与正文/工具互不影响（前端可独立展示开关）
      if (result.reasoning) {
        res.write(`event: reasoning_chunk\ndata: ${JSON.stringify({ text: result.reasoning, round })}\n\n`);
      }

      // 带工具调用轮次里的正文同样要上屏并累积。此前它只被塞进 conversation，
      // 导致「先说一句再查资料」的正文用户完全看不到（实测丢过 31 字与 27 字）。
      if (result.content) {
        fullContent += result.content;
        res.write(`event: content_chunk\ndata: ${JSON.stringify({ text: result.content, position: fullContent.length })}\n\n`);
      }

      if (result.toolCalls.length > 0) {
        // Add assistant message with tool calls to conversation
        conversation.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            // Gemini 多轮工具调用要求回传 thoughtSignature，缺失会导致下一轮 400
            ...(tc.sig ? { thoughtSignature: tc.sig } : {}),
          })),
        });

        // Execute each tool
        for (const tc of result.toolCalls) {
          // Notify frontend: tool call started（附中文描述，供进度展示）
          res.write(`event: tool_call\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, arguments: tc.args, round, hint: toolHint(tc.name, tc.args) })}\n\n`);

          // Execute tool against project database
          let toolResult;
          const missing = missingRequiredArgs(tc.name, tc.args);
          if (missing.length > 0) {
            // 参数不完整（多为输出被截断，实测 Packy+GLM 上 update_chapter 42 次调用有 30 次参数为空）：
            // 不执行，把原因写回对话要求重发。执行下去只会得到「没有要更新的字段」这类
            // 看不出原因的结果，模型只能盲试 2-3 轮补救。
            toolResult = {
              error: `参数不完整：${tc.name} 缺少必填参数 ${missing.join('、')}，本次调用未执行。`
                + (truncated ? '（本轮输出达到上限被截断，参数没有传完）' : '')
                + ` 请重新调用 ${tc.name} 并把 ${missing.join('、')} 写完整；正文较长时请分段写入，不要发出没有参数的调用。`,
            };
            console.warn(`[AI Stream] 工具 ${tc.name} 参数不完整（缺 ${missing.join('、')}），已拒绝执行${truncated ? ' · 本轮被截断' : ''}`);
          } else {
            try {
              toolResult = executeTool(project, tc.name, tc.args);
            } catch(e) {
              toolResult = { error: e.message };
            }
          }

          console.log(`[AI Stream] Tool ${tc.name}:`, JSON.stringify(toolResult).slice(0, 200));

          // Notify frontend: tool result
          res.write(`event: tool_result\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, result: toolResult })}\n\n`);

          // Add tool result to conversation for next round (OpenAI format — adapter handles conversion)
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        }
        // Continue loop
      } else if (result.content && !truncated) {
        // 模型自己收尾（停止原因正常）才结束任务。
        // 此前不看停止原因，正文只有两个字也会被当成完整答复结束。
        break;
      } else if (result.content) {
        // 被输出上限截断：正文只是半截，不能当完整答复收工。
        // 保留已产出的部分，立刻请求从断点接着写，直到模型自然收尾。
        if (continueCount >= MAX_CONTINUE_ROUNDS) {
          console.warn(`[AI Stream] 续写 ${MAX_CONTINUE_ROUNDS} 次仍被截断，停止续写`);
          res.write(`event: progress\ndata: ${JSON.stringify({ round, doneTools: round, hint: `输出多次被上限截断，已保留当前内容（续写 ${MAX_CONTINUE_ROUNDS} 次未写完）` })}\n\n`);
          break;
        }
        continueCount++;
        conversation.push({ role: 'assistant', content: result.content });
        conversation.push({
          role: 'user',
          content: '（系统提示：你上一条回复因为达到输出上限被截断了，正文只写到一半。请紧接着断掉的地方继续写：不要重开开头、不要重复已经写过的句子、不要解释，直接输出后续正文。如果这一章还很长，这一轮只写下一段（约 500 字）就停下来。）',
        });
        console.log(`[AI Stream] 正文被截断，请求续写（${continueCount}/${MAX_CONTINUE_ROUNDS}）`);
        res.write(`event: progress\ndata: ${JSON.stringify({ round, doneTools: round, hint: `输出被上限截断，正在续写（${continueCount}/${MAX_CONTINUE_ROUNDS}）` })}\n\n`);
        continue;
      } else {
        // 空响应（既无文本也无工具调用）：提示 AI 继续，容忍有限次数后放弃。
        // 否则像"只查了项目资料就结束"这种情况会静默产出空结果。
        if (emptyCount < MAX_EMPTY_ROUNDS) {
          emptyCount++;
          conversation.push({
            role: 'user',
            content: truncated
              // 本轮输出额度被思考用光：催促语必须点明「参数要带全、长正文要分段」，
              // 否则模型会发出没有参数的 update_chapter 来敷衍。
              ? '（系统提示：你上一轮的全部输出额度都被思考用掉了，既没有产出文字也没有调用工具。请立即直接调用 update_chapter，并且必须同时传 chapter_num 与 content 两个参数——缺任何一个这次调用都会被拒绝。正文很长时不要一次写完：第一段用 content_mode="replace"，接着用 content_mode="append" 续写后续段落，最后一段再设 status。禁止发出没有参数的调用。）'
              : '（系统提示：你上一轮既没有产出任何文字，也没有调用工具，这是不允许的。工作流尚未完成——请立即继续：如果还有待写的章节，就用 update_chapter 写入正文并推进状态，调用时必须同时传 chapter_num 与 content；正文较长时分段写入，第一段用 content_mode="replace"，后续段落用 content_mode="append"。如果所有章节都已完成，就输出一段总结文字（列明章名、字数、关键剧情）。禁止只回复空内容或只做查询，禁止发出没有参数的调用。）',
          });
          console.log(`[AI Stream] 空响应，已提示 AI 继续（${emptyCount}/${MAX_EMPTY_ROUNDS}）${truncated ? ' · 本轮为截断' : ''}`);
          // 让前端显示"仍在推进"，避免催促阶段界面完全静默像卡死
          res.write(`event: progress\ndata: ${JSON.stringify({ round, doneTools: round, hint: truncated ? `输出被上限截断，正在重试（${emptyCount}/${MAX_EMPTY_ROUNDS}）` : `模型暂未产出内容，正在继续（${emptyCount}/${MAX_EMPTY_ROUNDS}）` })}\n\n`);
          continue;
        }
        // 超过容忍：明确告知而非静默结束，避免"对话完成"却无内容
        console.log('[AI Stream] 空响应超过容忍次数 — 显式报错结束');
        const stopReasonText = truncated
          ? '（模型输出连续被上限截断，任务已中止。当前供应商的思考量占满了输出额度：请提高该供应商的「最大输出 tokens」，或把长章节拆成多次写入后重试。）'
          : '（AI 多次未产出有效内容，任务已中止。请检查模型是否支持工具调用，或重新发起指令。）';
        res.write(`event: content_chunk\ndata: ${JSON.stringify({ text: stopReasonText })}\n\n`);
        fullContent += stopReasonText;
        break;
      }
    }


    // Record token usage
    try {
      const db = require('./db');
      db.projectExecute(project,
        'INSERT INTO token_usage (task_name, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?)',
        ['stream_chat', inputTokens, outputTokens, aiConfig.apiModel]
      );
        } catch(e) {
          console.warn('[AI Stream] Failed to record token usage:', e.message);
        }

        res.write(`event: task_end\ndata: ${JSON.stringify({ success: true, content: fullContent, inputTokens, outputTokens })}\n\n`);
    res.end();

  } catch (err) {
    console.error('AI stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`event: task_error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

// ─── AI Continue Writing (streaming) ───
app.post('/api/ai/continue', async (req, res) => {
  try {
    const { chapterNum, context, style = '悬疑', project } = req.body;

    const db = require('./db');
    const chapter = db.projectGet(project, 'SELECT * FROM chapters WHERE num = ?', [chapterNum]);

    const messages = [
      { role: 'user', content: `请续写以下小说的第${chapterNum}章「${chapter?.title || '未知'}」。保持${style}氛围，延续已有的文风和叙事视角。\n\n## 当前内容\n\n${chapter?.content?.slice(-1500) || '（新章节开头）'}\n\n## 用户额外要求\n${context || '请自然续写，保持文学质感。'}\n\n请直接开始续写，不要加任何前缀说明。` }
    ];

    const aiConfig = getAiConfig();
    const adapter = createAIAdapter(aiConfig.apiModel, aiConfig, aiConfig.apiType);
    const systemPrompt = withReasoningLang(buildWritingPrompt(project, aiConfig), aiConfig);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // Flush headers immediately so browser sees SSE connection is live
    res.write(':ok\n\n');

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = '';

    try {
      for await (const event of adapter.stream(systemPrompt, messages, resolveSampling(aiConfig, req.body))) {
        if (event.type === 'chunk') {
          fullContent += event.text;
          res.write(`event: content_chunk\ndata: ${JSON.stringify({ text: event.text, position: fullContent.length })}\n\n`);
        }
        if (event.type === 'usage') {
          inputTokens = event.inputTokens || 0;
          outputTokens = event.outputTokens || 0;
          if (event.stopReason) stopReason = event.stopReason;
        }
      }
    } catch (err) {
      console.error('Continue stream error:', err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
      return;
    }

    // 续写同样会被输出上限截断（思考把额度用光）。内容照旧保存，
    // 但要明确告知：否则用户看到一段戛然而止的文字会以为模型写坏了。
    const truncated = isTruncatedReason(stopReason);
    if (truncated) {
      console.warn(`[AI Continue] 续写被输出上限截断（stopReason=${stopReason}，outputTokens=${outputTokens}），已保存当前内容`);
      res.write(`event: progress\ndata: ${JSON.stringify({ hint: '续写达到输出上限，已保存当前内容；可再次续写接着写' })}\n\n`);
    }

    // Save to chapter
    if (fullContent.length > 10) {
      try {
        const existing = db.projectGet(project, 'SELECT content FROM chapters WHERE num = ?', [chapterNum]);
        const newContent = (existing?.content || '') + '\n\n' + fullContent;
        const wc = newContent.replace(/\s/g, '').length;
        db.projectExecute(project,
          "UPDATE chapters SET content = ?, word_count = ?, status = 'writing', updated_at = datetime('now') WHERE num = ?",
          [newContent, wc, chapterNum]
        );
        // Recalculate project word count
        const total = db.projectGet(project, 'SELECT SUM(word_count) as total FROM chapters')?.total || 0;
        db.projectExecute(project, "UPDATE project_meta SET value = ? WHERE key = 'word_count'", [String(total)]);
      } catch(e) { console.error('Save error:', e); }
    }

    // Record token usage
    try {
      db.projectExecute(project,
        'INSERT INTO token_usage (task_name, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?)',
        ['continue', inputTokens, outputTokens, aiConfig.apiModel]
      );
      } catch(e) {
        console.warn('[AI Continue] Failed to record token usage:', e.message);
      }

      res.write(`event: task_end\ndata: ${JSON.stringify({ success: true, content: fullContent })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Continue error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`event: task_error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

// ─── Health check ───
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    db: 'connected',
    version: '0.1.0',
    mode: 'development',
  });
});

// ─── Graceful shutdown ───
// Called by Tauri on app exit to avoid antivirus flagging SIGKILL/TerminateProcess
let serverInstance = null;

function gracefulShutdown() {
  console.log('\n  🛑 Shutting down Mythpen API Server gracefully...');
  // 退出前把所有已打开的项目库落盘（sql.js 是内存库，不落盘会丢最近 250ms 的写入）
  try {
    require('./db').flushAllDbs();
  } catch (e) {
    console.warn('  ⚠️  退出落盘失败:', e.message);
  }
  if (serverInstance) {
    serverInstance.close(() => {
      console.log('  ✓ Server closed.');
      process.exit(0);
    });
    // Force exit after 5s if close hangs
    setTimeout(() => {
      console.error('  ⚠️  Server close timed out, forcing exit.');
      process.exit(0);
    }, 5000);
  } else {
    process.exit(0);
  }
}

// 备份/运维用：把内存中的数据立即写盘，减少 250ms 防抖窗口造成的数据滞后
app.post('/api/admin/flush', (req, res) => {
  try {
    require('./db').flushAllDbs();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/shutdown', (req, res) => {
  res.json({ status: 'shutting_down' });
  setImmediate(() => gracefulShutdown());
});

// 兜底错误处理：路由里未捕获的异常统一返回 JSON。
// 默认行为是 Express 的 HTML 堆栈页，前端 request() 解析 JSON 失败后只能显示
// "Internal Server Error" —— 真正的原因（如 UNIQUE constraint failed: xxx）被吞掉，
// 用户看到的提示与实际问题无关。此中间件必须注册在所有路由之后才能兜住它们。
app.use((err, req, res, next) => {
  console.error(`[Server] 未捕获的路由异常 ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: { message: err.message || '服务器内部错误', recoverable: true },
  });
});

// Handle SIGTERM from Tauri (sent before SIGKILL on some platforms)
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Share cache invalidation with routes (settings updates clear the cache)
const db = require('./db');
db.invalidateAiConfigCache = invalidateAiConfigCache;

// ─── Start (async — init DB then listen) ───
const { initDatabase } = require('./db');
const serverStartTime = Date.now();
console.log('[Server] Mythpen API Server starting...');
console.log('[Server] Port:', PORT);
initDatabase()
  .then(() => {
    serverInstance = app.listen(PORT, () => {
      const cfg = getAiConfig();
      const elapsed = Date.now() - serverStartTime;
      console.log(`\n  🖋️  Mythpen API Server`);
      console.log(`  ─────────────────────`);
      console.log(`  Local:   http://localhost:${PORT}`);
      console.log(`  Health:  http://localhost:${PORT}/api/health`);
      console.log(`  AI:      ${cfg.apiModel} @ ${cfg.apiBaseUrl}`);
      console.log(`  Startup: ${elapsed}ms`);
      console.log(`\n  Ready.\n`);
      // 补跑上次中断的章节定稿总结
      try {
        const { scanPending } = require('./summarizer');
        scanPending();
      } catch (e) {
        console.warn('[Summarizer] 启动补跑失败:', e.message);
      }
    });
  })
  .catch(err => {
    console.error('❌ Failed to initialise database:', err);
    process.exit(1);
  });
