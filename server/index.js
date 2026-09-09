const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const apiRoutes = require('./routes/api');
const { TOOLS, executeTool } = require('./tools');
const { createAIAdapter, detectProvider } = require('./ai-adapter');
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
    // 不同中转站的模型列表路径不一致，按可能性依次尝试
    const candidates = [];
    if (type === 'claude') {
      candidates.push(`${base}/v1/models`, `${base}/models`);
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
        const list = Array.isArray(data) ? data : data.data || [];
        const models = list.map((m) => m.id).filter(Boolean).sort();
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
    if (detail.includes('temperature')) {
      return type === 'claude' || type === 'anthropic'
        ? '（上游拒绝了 temperature 参数：Anthropic 协议范围是 0-1，请在设置中调整后重试，或清空该参数让其使用模型默认值）'
        : '（上游拒绝了 temperature 参数：请确认该模型支持自定义温度（部分推理模型忽略/禁用此参数），或清空该参数让其使用模型默认值）';
    }
    if (detail.includes('top_p') || detail.includes('topp')) {
      return '（上游拒绝了 top_p 参数：该模型/服务可能不支持此参数，建议在设置中清空 top_p 后重试）';
    }
  }
  return '';
}

// 工具名 → 中文进度描述（带 args 时对高频工具细化，如"写入第3章正文"）
function toolHint(name, args = {}) {
  const truncate = (s, n = 12) => {
    const t = String(s ?? '');
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
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
    const systemPrompt = buildWritingPrompt(project, aiConfig);

    const result = await adapter.complete(systemPrompt, messages, null, resolveSampling(aiConfig, req.body));

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
    console.error('AI chat error:', err);
    res.status(500).json({ error: err.message });
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
    const systemPrompt = mode === 'collab' ? buildCollabPrompt(project, aiConfig) : buildWritingPrompt(project, aiConfig);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write(':ok\n\n');

    const conversation = [...messages]; // system is passed separately to adapter
    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let emptyCount = 0; // 连续空响应（无文本无工具调用）容忍次数
    const MAX_TOOL_ROUNDS = 120;
    const MAX_EMPTY_ROUNDS = 4;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // 通知前端当前进行到第几轮（模型思考期间的提示，带真实信息量）
      res.write(`event: progress\ndata: ${JSON.stringify({ round, doneTools: round, hint: roundHint(project, mode) })}\n\n`);
      console.log(`[AI Stream] Round ${round}, messages: ${conversation.length}`);

      let result;
      try {
        result = await adapter.complete(systemPrompt, conversation, TOOLS, resolveSampling(aiConfig, req.body));
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

      console.log(`[AI Stream] Round ${round} result:`, {
        hasContent: !!result.content,
        contentLen: result.content?.length || 0,
        hasToolCalls: result.toolCalls.length > 0,
        toolCallNames: result.toolCalls.map(tc => tc.name) || [],
      });

      if (result.toolCalls.length > 0) {
        // Add assistant message with tool calls to conversation
        conversation.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        });

        // Execute each tool
        for (const tc of result.toolCalls) {
          // Notify frontend: tool call started（附中文描述，供进度展示）
          res.write(`event: tool_call\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, arguments: tc.args, round, hint: toolHint(tc.name, tc.args) })}\n\n`);

          // Execute tool against project database
          let toolResult;
          try {
            toolResult = executeTool(project, tc.name, tc.args);
          } catch(e) {
            toolResult = { error: e.message };
          }

          console.log(`[AI Stream] Tool ${tc.name}:`, JSON.stringify(toolResult).slice(0, 200));

          // Notify frontend: tool result
          res.write(`event: tool_result\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, result: toolResult })}\n\n`);

          // Add tool result to conversation for next round (OpenAI format — adapter handles conversion)
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        }
        // Continue loop
      } else if (result.content) {
        // Got text without tool calls — send as content
        fullContent = result.content;
        res.write(`event: content_chunk\ndata: ${JSON.stringify({ text: result.content, position: result.content.length })}\n\n`);
        break;
      } else {
        // 空响应（既无文本也无工具调用）：提示 AI 继续，容忍有限次数后放弃。
        // 否则像"只查了项目资料就结束"这种情况会静默产出空结果。
        if (emptyCount < MAX_EMPTY_ROUNDS) {
          emptyCount++;
          conversation.push({
            role: 'user',
            content: '（系统提示：你上一轮既没有产出任何文字，也没有调用工具，这是不允许的。工作流尚未完成——请立即继续：如果还有待写的章节，就用 update_chapter 写入正文并推进状态；如果所有章节都已完成，就输出一段总结文字（列明章名、字数、关键剧情）。禁止只回复空内容或只做查询。）',
          });
          console.log(`[AI Stream] 空响应，已提示 AI 继续（${emptyCount}/${MAX_EMPTY_ROUNDS}）`);
          continue;
        }
        // 超过容忍：明确告知而非静默结束，避免"对话完成"却无内容
        console.log('[AI Stream] 空响应超过容忍次数 — 显式报错结束');
        res.write(`event: content_chunk\ndata: ${JSON.stringify({ text: '（AI 多次未产出有效内容，任务已中止。请检查模型是否支持工具调用，或重新发起指令。）' })}\n\n`);
        fullContent = '（AI 多次未产出有效内容，任务已中止。）';
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
    const systemPrompt = buildWritingPrompt(project, aiConfig);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // Flush headers immediately so browser sees SSE connection is live
    res.write(':ok\n\n');

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const event of adapter.stream(systemPrompt, messages, resolveSampling(aiConfig, req.body))) {
        if (event.type === 'chunk') {
          fullContent += event.text;
          res.write(`event: content_chunk\ndata: ${JSON.stringify({ text: event.text, position: fullContent.length })}\n\n`);
        }
        if (event.type === 'usage') {
          inputTokens = event.inputTokens || 0;
          outputTokens = event.outputTokens || 0;
        }
      }
    } catch (err) {
      console.error('Continue stream error:', err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
      return;
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

app.post('/api/shutdown', (req, res) => {
  res.json({ status: 'shutting_down' });
  setImmediate(() => gracefulShutdown());
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
