// ─── AI Provider Adapter ───
// Unified interface for OpenAI-compatible (DeepSeek, etc.) and Anthropic Claude models.
// Auto-detects provider from model name.

const Anthropic = require('@anthropic-ai/sdk');

// ─── Provider detection ───
// apiType takes priority; fallback to model name heuristic
// Supported apiType values:
//   'openai'          → POST {base}/chat/completions
//   'openai-response' → POST {base}/responses       (OpenAI Responses API)
//   'claude'/'anthropic' → POST {base}/messages     (Anthropic Messages API)
//   'gemini'/'google' → POST {base}/models/{model}:generateContent (Google Gemini native)

function detectProvider(model, apiType) {
  if (apiType === 'claude' || apiType === 'anthropic') return 'claude';
  if (apiType === 'openai-response' || apiType === 'responses') return 'openai-response';
  if (apiType === 'gemini' || apiType === 'google') return 'gemini';
  if (apiType === 'openai') return 'openai';
  if (!model) return 'openai';
  const m = model.toLowerCase();
  if (m.startsWith('claude') || m.startsWith('anthropic/')) return 'claude';
  if (m.startsWith('gemini') || m.startsWith('models/gemini') || m.startsWith('google/gemini')) return 'gemini';
  return 'openai';
}

// ─── Sampling parameter helpers ───
// 黄金规则：用户未显式设置采样参数时不发送该字段，让上游使用自己的默认值。
// 原因：部分中转站/小众网关对未知或多余字段校验严格（返回 400），
// 少发字段是最安全的跨供应商兼容策略。
// 协议级硬钳制：OpenAI 系 temperature 0-2，Claude 0-1；top_p 各协议均为 0-1。

const SAMPLING_LIMITS = {
  claude: { temperatureMax: 1 },
  'openai': { temperatureMax: 2 },
  'openai-response': { temperatureMax: 2 },
  gemini: { temperatureMax: 2 },
};

function clampSampling(provider, sampling) {
  if (!sampling) return undefined;
  const limits = SAMPLING_LIMITS[provider] || SAMPLING_LIMITS.openai;
  const clamped = {};
  if (typeof sampling.temperature === 'number') {
    clamped.temperature = Math.max(0, Math.min(limits.temperatureMax, sampling.temperature));
  }
  if (typeof sampling.topP === 'number') {
    clamped.topP = Math.max(0, Math.min(1, sampling.topP));
  }
  return clamped;
}

// ─── Tool format conversion ───
// OpenAI: { type: 'function', function: { name, description, parameters } }
// Claude: { name, description, input_schema }

function toClaudeTools(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return undefined;
  return openaiTools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

// ─── Message format conversion ───

function toClaudeMessages(openaiMessages) {
  const msgs = [];
  for (const msg of openaiMessages) {
    if (msg.role === 'system') continue; // system is handled separately

    if (msg.role === 'tool') {
      // OpenAI: { role: 'tool', tool_call_id, content }
      // Claude: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }
      msgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }],
      });
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      // OpenAI: { role: 'assistant', content, tool_calls: [{ id, function: { name, arguments } }] }
      // Claude: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
      const content = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls) {
        let input;
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      msgs.push({ role: 'assistant', content });
    } else {
      // Regular user/assistant message
      // Claude requires content to be an array when there are tool blocks in conversation
      // but for plain text messages we can use a string
      msgs.push({
        role: msg.role,
        content: msg.content || '',
      });
    }
  }
  return msgs;
}

// ─── Responses API format conversion ───
// OpenAI Responses API (/v1/responses) uses a flat item list:
//   plain messages keep { role, content }
//   tool calls become { type: 'function_call', call_id, name, arguments }
//   tool results become { type: 'function_call_output', call_id, output }
// System prompt is passed via the top-level `instructions` field.

function toResponsesInput(openaiMessages) {
  const input = [];
  for (const msg of openaiMessages) {
    if (msg.role === 'system') continue; // system is handled by `instructions`

    if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      });
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      if (msg.content) input.push({ role: 'assistant', content: msg.content });
      for (const tc of msg.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || '{}',
        });
      }
    } else {
      input.push({ role: msg.role, content: msg.content || '' });
    }
  }
  return input;
}

function toResponsesTools(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return undefined;
  // Responses API tools are flat: { type: 'function', name, description, parameters }
  return openaiTools.map(t => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

function fromResponsesOutput(data) {
  const toolCalls = [];
  let content = '';
  let reasoning = '';
  for (const item of data.output || []) {
    if (item.type === 'message') {
      for (const block of item.content || []) {
        if (block.type === 'output_text') content += block.text || '';
      }
    } else if (item.type === 'reasoning') {
      // 官方在 summary[].text；部分中转（实测 Packy+GLM）在 content[].reasoning_text
      for (const block of item.content || []) {
        if ((block.type === 'reasoning_text' || block.type === 'summary_text') && typeof block.text === 'string') {
          reasoning += block.text + '\n';
        }
      }
      for (const block of item.summary || []) {
        if (typeof block.text === 'string') reasoning += block.text + '\n';
      }
    } else if (item.type === 'function_call') {
      let args;
      try { args = JSON.parse(item.arguments || '{}'); } catch { args = {}; }
      toolCalls.push({ id: item.call_id, name: item.name, args });
    }
  }
  return { content: content || null, toolCalls, reasoning };
}

// ─── Unified response format ───

// 停止原因归一化。四家协议的字段名与取值都不同：
//   Anthropic → stop_reason: end_turn / max_tokens / tool_use
//   OpenAI    → finish_reason: stop / length / tool_calls
//   Responses → status: completed / incomplete（原因在 incomplete_details.reason）
//   Gemini    → finishReason: STOP / MAX_TOKENS
// 工具循环只需要区分一件事：这一轮是被输出上限截断的，还是模型自己写完的。
// 截断会让正文或工具参数不完整，必须能与「正常收尾」分开处理。
function normalizeStopReason(raw) {
  if (!raw) return '';
  const s = String(raw).toLowerCase();
  if (s === 'length' || s === 'max_tokens' || s === 'max_output_tokens' || s === 'incomplete') return 'max_tokens';
  return s;
}

function isTruncatedReason(raw) {
  return normalizeStopReason(raw) === 'max_tokens';
}

function makeResponse(content, toolCalls, inputTokens, outputTokens, reasoning, stopReason) {
  return {
    content,
    toolCalls,
    usage: { inputTokens, outputTokens },
    reasoning: reasoning || '',
    stopReason: normalizeStopReason(stopReason),
    truncated: isTruncatedReason(stopReason),
  };
}

// 请求超时：中转站/供应商偶尔会挂住连接不返回，没有超时时 SSE 会永久无输出
// （2026-09-23 Packy + GLM 实测：正常 ~10s，异常时挂满数分钟无响应）。
// 仅用于非流式 complete()；流式接口不加，避免长回答中途被中止。
const REQUEST_TIMEOUT_MS = 90000;

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw Object.assign(new Error('上游请求超时'), {
        status: 504,
        detail: `上游在 ${Math.round(timeoutMs / 1000)}s 内未返回，已中止（多为中转站/供应商临时故障，请重试）`,
      });
    }
    throw e;
  }
}

// 流式接口只对「拿到响应头」设时限，不在数据传输过程中中止：
// 长回答可能持续数分钟，套用整体超时会把它拦腰砍断；但完全不设时限，
// 中转站挂住连接时 SSE 会永久静默（Gemini 的 stream() 原本就是裸 fetch，属此列）。
const STREAM_CONNECT_TIMEOUT_MS = 60000;

async function fetchStreaming(url, options, connectTimeoutMs = STREAM_CONNECT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer); // 响应头已到 → 解除时限，避免长回答被中止
    return response;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw Object.assign(new Error('上游请求超时'), {
        status: 504,
        detail: `上游在 ${Math.round(connectTimeoutMs / 1000)}s 内未返回响应头，已中止（多为中转站/供应商临时故障，请重试）`,
      });
    }
    throw e;
  }
}

// ─── Google Gemini (generateContent) format conversion ───
// Gemini 与 OpenAI 的差异：
//   - contents[] 的 role 只有 'user' / 'model'，没有 system（system 走 systemInstruction）
//   - 工具调用是 parts 里的 functionCall，工具结果是对应 functionResponse（按函数名匹配，无 id）
//   - 需要把连续的相同 role 合并；工具结果必须紧跟在触发它的 functionCall 之后
// Gemini 没有 tool_call_id，因此我们从 assistant.tool_calls 建 id→name 映射，回填 functionResponse。

function toGeminiSchema(params) {
  // 无参数工具：省略 parameters（Gemini 视为无参），避免空 properties 触发校验失败
  if (!params || !params.properties || Object.keys(params.properties).length === 0) {
    return { type: 'object' };
  }
  const schema = { type: 'object', properties: params.properties };
  if (Array.isArray(params.required) && params.required.length > 0) schema.required = params.required;
  return schema;
}

function toGeminiTools(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return undefined;
  return [
    {
      functionDeclarations: openaiTools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: toGeminiSchema(t.function.parameters),
      })),
    },
  ];
}

// Gemini 要求 contents 严格 user/model 交替，因此相邻同 role 的 parts 必须合并
// （并行工具结果、连续催促消息都会产生同 role 相邻）。
function _appendGeminiContent(contents, role, parts) {
  const last = contents[contents.length - 1];
  if (last && last.role === role) {
    last.parts.push(...parts);
  } else {
    contents.push({ role, parts });
  }
}

function toGeminiContents(openaiMessages) {
  const contents = [];
  const idToName = {};
  for (const msg of openaiMessages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const parts = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.tool_calls) {
        idToName[tc.id] = tc.function.name;
        let args;
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
        const part = { functionCall: { name: tc.function.name, args } };
        if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature;
        parts.push(part);
      }
      _appendGeminiContent(contents, 'model', parts);
    } else if (msg.role === 'tool') {
      let response;
      try { response = JSON.parse(msg.content); } catch { response = { result: msg.content }; }
      if (response === null || typeof response !== 'object' || Array.isArray(response)) {
        response = { result: response };
      }
      const name = idToName[msg.tool_call_id] || msg.name || 'tool';
      _appendGeminiContent(contents, 'user', [{ functionResponse: { name, response } }]);
    } else {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      _appendGeminiContent(contents, role, [{ text: msg.content || '' }]);
    }
  }
  return contents;
}

/**
 * 把一个 parts 数组拆成「正文 / 思考 / 工具调用」三部分（非流式与流式共用，避免两处判定不一致）。
 *
 * 实测（2026-09-25，Google 官方 generativelanguage 端点）：开启 includeThoughts 后，
 * 思考 part 形如 `{ text: '思考内容', thought: true }` —— thought 是**布尔标记**，思考文本
 * 仍然挂在 text 上；不带 thought 标记的 part 才是正文。
 * 早期实现只认「thought 是字符串」，于是官方格式下思考文本被并入正文、思考面板反而是空的；
 * 而中转站把思考文本同时写进 thought(字符串) 与 text 时，思考又会重复出现两次。
 */
function splitGeminiParts(parts) {
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  (parts || []).forEach((p, i) => {
    const text = typeof p.text === 'string' ? p.text : '';
    const thoughtFlag = p.thought === true || p.thought === 'true';
    const thoughtStr = typeof p.thought === 'string' ? p.thought : '';
    const thinkingStr = typeof p.thinking === 'string' ? p.thinking : '';
    // 该 part 承载的思考文本：布尔标记时在 text 上；字符串 thought / thinking 本身就是文本
    const thoughtText = thoughtFlag ? (text || thoughtStr || thinkingStr) : (thoughtStr || thinkingStr);
    if (thoughtText) {
      reasoning += thoughtText + '\n';
      // 极端情况：同一 part 里 text 与思考文本不同源 → 说明 text 才是真正的正文，保留
      if (text && text !== thoughtText) content += text;
    } else if (text) {
      content += text;
    }
    if (p.functionCall) {
      toolCalls.push({
        id: `gemini_call_${Date.now()}_${i}`,
        name: p.functionCall.name,
        args: p.functionCall.args || {},
        // Gemini 多轮工具调用强制要求回传该签名，否则下一轮 400（实测）
        ...(p.thoughtSignature ? { sig: p.thoughtSignature } : {}),
      });
    }
  });
  return { content, reasoning, toolCalls };
}

function fromGeminiOutput(data) {
  const candidate = (data.candidates || [])[0] || {};
  const { content, reasoning, toolCalls } = splitGeminiParts(candidate.content?.parts);
  return { content: content || null, toolCalls, reasoning };
}

// Gemini 会把 thoughtSignature 附在 tool_calls 上（跨轮必需）。
// 其他协议不需要，转发给 OpenAI 端点前剥掉，避免上游对未知字段报 400。
// 仅在确实带了该字段时才改写，正常路径零开销。
function stripNonStandardToolFields(openaiMessages) {
  if (!Array.isArray(openaiMessages)) return openaiMessages;
  const dirty = openaiMessages.some(
    (m) => m?.role === 'assistant' && Array.isArray(m.tool_calls)
      && m.tool_calls.some((tc) => tc && ('thoughtSignature' in tc || 'sig' in tc)),
  );
  if (!dirty) return openaiMessages;
  return openaiMessages.map((m) => {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) return m;
    return {
      ...m,
      tool_calls: m.tool_calls.map((tc) => ({ id: tc.id, type: tc.type || 'function', function: tc.function })),
    };
  });
}

// ─── 思考档位 → 各协议参数 ───
// 'default'/未设置一律不发送（黄金规则）。各协议对「关闭」的支持程度不同，
// 不支持时上游会 400，由 mismatchHint 给出中文提示，用户可退回「默认」。
// 注：OpenAI 兼容协议没有统一的思考参数方言（reasoning_effort / enable_thinking /
// thinking 各不相同），为避免随机 400，该协议下思考档位不发送任何字段。
const CLAUDE_THINKING_BUDGETS = { low: 1024, medium: 4096, high: 16384 };
const GEMINI_THINKING_BUDGETS = { low: 1024, medium: 8192, high: 24576 };
// 思考之外必须留给正文的输出预算
const CLAUDE_OUTPUT_HEADROOM = 2048;

function claudeThinkingParams(level) {
  if (!level || level === 'default') return null;
  if (level === 'off') return { type: 'disabled' };
  return { type: 'enabled', budget_tokens: CLAUDE_THINKING_BUDGETS[level] || 4096 };
}

/**
 * 一次算出 Anthropic 请求需要的 thinking 与 max_tokens。
 *
 * 硬约束：max_tokens 必须**大于** thinking.budget_tokens，否则必然 400。用户档案里的
 * max_tokens 默认 4096，而 medium / high 档的思考预算是 4096 / 16384 —— 照发必错，且
 * 上游错误文本只说 "max_tokens must be greater than thinking.budget_tokens"，
 * 用户看不出该改哪个数字。这是程序能自己算出来的量，就自己抬上去：
 * 只在会违反约束时抬高（medium→6144、high→18432），其余情况完全尊重用户设置
 * （low 档预算 1024 < 4096，max_tokens 保持原值不动）。
 */
function claudeRequestParams(level, configuredMaxTokens) {
  const thinking = claudeThinkingParams(level);
  const maxTokens = configuredMaxTokens || 4096;
  if (!thinking || thinking.type !== 'enabled') return { thinking, maxTokens };
  const budget = thinking.budget_tokens;
  if (maxTokens > budget) return { thinking, maxTokens };
  const raised = budget + CLAUDE_OUTPUT_HEADROOM;
  console.warn(
    `[AI Adapter] max_tokens(${maxTokens}) 不足以容纳思考预算(${budget})，已自动抬升到 ${raised}`,
  );
  return { thinking, maxTokens: raised };
}

function responsesReasoningParams(level) {
  if (!level || level === 'default') return null;
  return { effort: level === 'off' ? 'minimal' : level };
}

/**
 * Gemini 思考配置。与另外三个协议一致遵守「未设置就不发思考字段」的黄金规则。
 * 旧实现无论用户选什么都固定发送 { includeThoughts: true }：既违背黄金规则（用户选
 * 「默认」仍然在改上游行为），又会让不支持思考的老 Gemini 模型直接 400。
 */
function geminiThinkingConfig(level) {
  if (!level || level === 'default') return null;
  return {
    includeThoughts: true,
    thinkingBudget: level === 'off' ? 0 : (GEMINI_THINKING_BUDGETS[level] || 8192),
  };
}

// ═══════════════════════════════════════════
// OPENAI PROVIDER (DeepSeek / any OpenAI-compatible API)
// ═══════════════════════════════════════════

class OpenAIProvider {
  constructor(apiConfig) {
    this.apiConfig = apiConfig;
  }

  /**
   * Non-streaming chat completion (supports tools).
   * Used by the tool-call loop in /api/ai/chat/stream.
   * sampling: { temperature?, topP? } — 未设置的字段不发送（黄金规则）
   */
  async complete(systemPrompt, messages, tools, sampling) {
    const { apiConfig } = this;
    const s = clampSampling('openai', sampling);
    const body = {
      model: apiConfig.apiModel,
      messages: [{ role: 'system', content: systemPrompt }, ...stripNonStandardToolFields(messages)],
      tools: tools || undefined,
      max_tokens: apiConfig.maxOutputTokens || 4096,
      stream: false,
    };
    if (s?.temperature !== undefined) body.temperature = s.temperature;
    if (s?.topP !== undefined) body.top_p = s.topP;

    const response = await fetchWithTimeout(apiConfig.chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw Object.assign(new Error(`API Error: ${response.status}`), {
        status: response.status,
        detail: errText.slice(0, 500),
      });
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw Object.assign(new Error('上游返回了非 JSON 内容（疑似接口地址缺少 /v1 版本路径，命中了中转站网页）'), {
        status: 502,
        detail: '上游响应不是 JSON，请检查「接口地址」是否填到了 /v1 版本路径（例如 https://xxx.com/v1）',
      });
    }
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;

    const toolCalls = (msg?.tool_calls || []).map(tc => {
      const rawArgs = tc.function.arguments;
      let args = {};
      if (rawArgs) {
        try {
          args = JSON.parse(rawArgs);
        } catch (e) {
          // 输出被上限截断会把 arguments 切成不合法的 JSON。这里不抛异常
          // （抛了整轮直接失败），改为给空对象并记下原文，交给工具循环
          // 按「参数不完整」处理：不执行、写回原因、重新请求。
          console.warn(`[AI Adapter] 工具 ${tc.function.name} 的 arguments 不是合法 JSON（${e.message}），原文前 120 字：${String(rawArgs).slice(0, 120)}`);
        }
      }
      return { id: tc.id, name: tc.function.name, args };
    });

    // 中转站的推理模型（实测 Packy+GLM）会把思考放在 reasoning_content
    const reasoning = [msg?.reasoning_content, msg?.reasoning]
      .filter((s) => typeof s === 'string' && s)
      .join('');

    return makeResponse(msg?.content || null, toolCalls, inputTokens, outputTokens, reasoning, choice?.finish_reason);
  }

  /**
   * Streaming chat completion (no tools).
   * Used by /api/ai/continue.
   */
  async *stream(systemPrompt, messages, sampling) {
    const { apiConfig } = this;
    const s = clampSampling('openai', sampling);
    const body = {
      model: apiConfig.apiModel,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: apiConfig.maxOutputTokens || 4096,
      stream: true,
    };
    if (s?.temperature !== undefined) body.temperature = s.temperature;
    if (s?.topP !== undefined) body.top_p = s.topP;

    const response = await fetch(apiConfig.chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw Object.assign(new Error(`API Error: ${response.status}`), {
        status: response.status,
        detail: errText.slice(0, 500),
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stopReason = '';
    let inTok = 0;
    let outTok = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            yield { type: 'chunk', text: delta.content };
          }
          // finish_reason 出现在最后一条数据块上，length 即为被输出上限截断
          if (choice?.finish_reason) stopReason = choice.finish_reason;
          if (parsed.usage) {
            inTok = parsed.usage.prompt_tokens || inTok;
            outTok = parsed.usage.completion_tokens || outTok;
          }
        } catch { /* skip parse errors */ }
      }
    }
    yield { type: 'usage', inputTokens: inTok, outputTokens: outTok, stopReason };
  }
}

// ═══════════════════════════════════════════
// OPENAI RESPONSES PROVIDER (/v1/responses)
// ═══════════════════════════════════════════

class OpenAIResponsesProvider {
  constructor(apiConfig) {
    this.apiConfig = apiConfig;
  }

  async post(body) {
    const response = await fetchWithTimeout(this.apiConfig.responsesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiConfig.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw Object.assign(new Error(`API Error: ${response.status}`), {
        status: response.status,
        detail: errText.slice(0, 500),
      });
    }
    try {
      return await response.json();
    } catch {
      throw Object.assign(new Error('上游返回了非 JSON 内容（疑似接口地址缺少 /v1 版本路径，命中了中转站网页）'), {
        status: 502,
        detail: '上游响应不是 JSON，请检查「接口地址」是否填到了 /v1 版本路径（例如 https://xxx.com/v1）',
      });
    }
  }

  /**
   * Non-streaming completion (supports tools).
   * Used by the tool-call loop in /api/ai/chat/stream.
   */
  async complete(systemPrompt, messages, tools, sampling) {
    const { apiConfig } = this;
    const s = clampSampling('openai-response', sampling);
    const reqBody = {
      model: apiConfig.apiModel,
      instructions: systemPrompt,
      input: toResponsesInput(messages),
      tools: toResponsesTools(tools),
      max_output_tokens: apiConfig.maxOutputTokens || 4096,
      store: false,
      stream: false,
    };
    if (s?.temperature !== undefined) reqBody.temperature = s.temperature;
    if (s?.topP !== undefined) reqBody.top_p = s.topP;
    const reasoningParams = responsesReasoningParams(apiConfig.thinkingLevel);
    if (reasoningParams) reqBody.reasoning = reasoningParams;
    const data = await this.post(reqBody);

    const { content, toolCalls, reasoning } = fromResponsesOutput(data);
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    // status: completed / incomplete；被上限截断时 reason 为 max_output_tokens
    const stopReason = data.incomplete_details?.reason || data.status;
    return makeResponse(content, toolCalls, inputTokens, outputTokens, reasoning, stopReason);
  }

  /**
   * Streaming completion (no tools).
   * Used by /api/ai/continue.
   */
  async *stream(systemPrompt, messages, sampling) {
    const { apiConfig } = this;
    const s = clampSampling('openai-response', sampling);
    const reqBody = {
      model: apiConfig.apiModel,
      instructions: systemPrompt,
      input: toResponsesInput(messages),
      max_output_tokens: apiConfig.maxOutputTokens || 4096,
      store: false,
      stream: true,
    };
    if (s?.temperature !== undefined) reqBody.temperature = s.temperature;
    if (s?.topP !== undefined) reqBody.top_p = s.topP;
    const reasoningParams = responsesReasoningParams(apiConfig.thinkingLevel);
    if (reasoningParams) reqBody.reasoning = reasoningParams;
    const response = await fetch(apiConfig.responsesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
      body: JSON.stringify(reqBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw Object.assign(new Error(`API Error: ${response.status}`), {
        status: response.status,
        detail: errText.slice(0, 500),
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.type === 'response.output_text.delta' && parsed.delta) {
            yield { type: 'chunk', text: parsed.delta };
          } else if (parsed.type === 'response.completed' || parsed.type === 'response.incomplete') {
            const usage = parsed.response?.usage || {};
            // 被输出上限截断时 status=incomplete、incomplete_details.reason=max_output_tokens
            const stopReason = parsed.response?.incomplete_details?.reason || parsed.response?.status;
            yield { type: 'usage', inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0, stopReason };
          } else if (parsed.type === 'response.failed' || parsed.type === 'response.error' || parsed.type === 'error') {
            const err = parsed.response?.error || parsed.error || {};
            throw Object.assign(new Error(`API Error: ${err.message || 'stream failed'}`), {
              status: err.code,
              detail: JSON.stringify(err).slice(0, 500),
            });
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue; // skip parse errors
          throw e;
        }
      }
    }
  }
}

// ═══════════════════════════════════════════
// CLAUDE PROVIDER (Anthropic)
// ═══════════════════════════════════════════

class ClaudeProvider {
  constructor(apiConfig) {
    this.apiConfig = apiConfig;
    const opts = { apiKey: apiConfig.apiKey };
    // Support relay/proxy base URLs. The Anthropic SDK appends /v1/messages
    // to baseURL, while users enter a /v1-level base like the other providers,
    // so strip any trailing "/v1" before handing it over.
    if (apiConfig.apiBaseUrl) {
      const base = apiConfig.apiBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
      if (base) opts.baseURL = base;
    }
    this.client = new Anthropic(opts);
  }

  /**
   * Non-streaming chat completion (supports tools).
   */
  async complete(systemPrompt, messages, tools, sampling) {
    const { apiConfig, client } = this;
    const s = clampSampling('claude', sampling) || {};

    const { thinking, maxTokens } = claudeRequestParams(apiConfig.thinkingLevel, apiConfig.maxOutputTokens);
    const params = {
      model: apiConfig.apiModel,
      system: systemPrompt,
      messages: toClaudeMessages(messages),
      max_tokens: maxTokens,
    };
    if (thinking) params.thinking = thinking;
    // Anthropic 约束：启用思考时不能自定义 temperature
    const thinkingOn = !!(thinking && thinking.type === 'enabled');
    if (s.temperature !== undefined && !thinkingOn) params.temperature = s.temperature;
    if (s.topP !== undefined) params.top_p = s.topP;

    if (tools && tools.length > 0) {
      params.tools = toClaudeTools(tools);
    }

    const response = await client.messages.create(params);
    const toolCalls = [];
    let content = '';
    let reasoning = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'thinking') {
        // 实测字段为 thinking；text 兜底兼容部分中转的实现差异
        const t = typeof block.thinking === 'string' ? block.thinking : (typeof block.text === 'string' ? block.text : '');
        if (t) reasoning += t + '\n';
      } else if (block.type === 'tool_use') {
        // block.input 正常是对象；部分中转在输出被截断时会回传空对象或字符串
        let args = block.input;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            console.warn(`[AI Adapter] 工具 ${block.name} 的 input 是非法 JSON 字符串，原文前 120 字：${String(args).slice(0, 120)}`);
            args = {};
          }
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
        toolCalls.push({ id: block.id, name: block.name, args });
      }
    }

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    return makeResponse(content || null, toolCalls, inputTokens, outputTokens, reasoning, response.stop_reason);
  }

  /**
   * Streaming chat completion (no tools).
   */
  async *stream(systemPrompt, messages, sampling) {
    const { apiConfig, client } = this;
    const s = clampSampling('claude', sampling) || {};

    const { thinking, maxTokens } = claudeRequestParams(apiConfig.thinkingLevel, apiConfig.maxOutputTokens);
    const streamParams = {
      model: apiConfig.apiModel,
      system: systemPrompt,
      messages: toClaudeMessages(messages),
      max_tokens: maxTokens,
    };
    if (thinking) streamParams.thinking = thinking;
    const thinkingOn = !!(thinking && thinking.type === 'enabled');
    if (s.temperature !== undefined && !thinkingOn) streamParams.temperature = s.temperature;
    if (s.topP !== undefined) streamParams.top_p = s.topP;

    const stream = client.messages.stream(streamParams);

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield { type: 'chunk', text: event.delta.text };
      }
      if (event.type === 'message_delta') {
        if (event.usage) {
          outputTokens = event.usage.output_tokens || 0;
        }
        // 停止原因只在最后一条 message_delta 上出现
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
      }
      if (event.type === 'message_start') {
        if (event.message?.usage) {
          inputTokens = event.message.usage.input_tokens || 0;
        }
      }
    }

    yield { type: 'usage', inputTokens, outputTokens, stopReason };
  }
}

// ═══════════════════════════════════════════
// GEMINI PROVIDER (Google generative language API)
// ═══════════════════════════════════════════

class GeminiProvider {
  constructor(apiConfig) {
    this.apiConfig = apiConfig;
  }

  _headers() {
    const { apiConfig } = this;
    // Google 官方端点必须用 x-goog-api-key（或 ?key=）承载 API key。
    // 绝不能同时发 Authorization: Bearer <API key> —— Google 的认证优先级里
    // Authorization 优先，会把 API key 当 OAuth2 access token 解析，直接 401
    // UNAUTHENTICATED「Expected OAuth 2 access token」。
    // 实测：只带 x-goog-api-key → 400 API_KEY_INVALID（鉴权路径正确）；
    //      一旦带了 Authorization   → 401 UNAUTHENTICATED（鉴权路径错误）。
    const headers = { 'Content-Type': 'application/json' };
    if (this._isGoogleHost()) {
      headers['x-goog-api-key'] = apiConfig.apiKey || '';
    } else {
      // 中转站等非 Google 域：部分只认 Bearer，两个都发更兼容
      headers['x-goog-api-key'] = apiConfig.apiKey || '';
      headers['Authorization'] = `Bearer ${apiConfig.apiKey || ''}`;
    }
    return headers;
  }

  _isGoogleHost() {
    try {
      const host = new URL(this.apiConfig.apiBaseUrl || 'https://generativelanguage.googleapis.com').hostname;
      return host === 'generativelanguage.googleapis.com' || host.endsWith('.googleapis.com');
    } catch {
      return true;
    }
  }

  _buildBody(systemPrompt, messages, tools, sampling) {
    const { apiConfig } = this;
    const s = clampSampling('gemini', sampling);
    const body = {
      contents: toGeminiContents(messages),
      generationConfig: {
        maxOutputTokens: apiConfig.maxOutputTokens || 4096,
      },
    };
    // 未设置思考档位 → 完全不发 thinkingConfig，把行为交回给模型默认值（黄金规则）
    const thinkingConfig = geminiThinkingConfig(apiConfig.thinkingLevel);
    if (thinkingConfig) body.generationConfig.thinkingConfig = thinkingConfig;
    if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
    const geminiTools = toGeminiTools(tools);
    if (geminiTools) body.tools = geminiTools;
    if (s?.temperature !== undefined) body.generationConfig.temperature = s.temperature;
    if (s?.topP !== undefined) body.generationConfig.topP = s.topP;
    return body;
  }

  /**
   * Non-streaming generateContent (supports tools).
   * Used by the tool-call loop in /api/ai/chat/stream.
   */
  async complete(systemPrompt, messages, tools, sampling) {
    const { apiConfig } = this;
    const response = await fetchWithTimeout(apiConfig.geminiUrl, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(this._buildBody(systemPrompt, messages, tools, sampling)),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw Object.assign(new Error(`API Error: ${response.status}`), {
        status: response.status,
        detail: errText.slice(0, 500),
      });
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw Object.assign(new Error('上游返回了非 JSON 内容（疑似接口地址缺少 /v1beta 版本路径，命中了中转站网页）'), {
        status: 502,
        detail: '上游响应不是 JSON，请检查「接口地址」是否为 Gemini 的 /v1beta 版本路径',
      });
    }
    if (data.error) {
      throw Object.assign(new Error(`API Error: ${data.error.code || 400}`), {
        status: data.error.code || 400,
        detail: String(data.error.message || '').slice(0, 500),
      });
    }

    const { content, toolCalls, reasoning } = fromGeminiOutput(data);
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    // finishReason: STOP 为正常收尾，MAX_TOKENS 为被输出上限截断
    return makeResponse(content, toolCalls, inputTokens, outputTokens, reasoning, data.candidates?.[0]?.finishReason);
  }

  /**
   * Streaming generateContent (no tools).
   * Used by /api/ai/continue.
   */
  async *stream(systemPrompt, messages, sampling) {
    const { apiConfig } = this;
    const url = `${apiConfig.geminiStreamUrl}?alt=sse`;
    const response = await fetchStreaming(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(this._buildBody(systemPrompt, messages, null, sampling)),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw Object.assign(new Error(`API Error: ${response.status}`), {
        status: response.status,
        detail: errText.slice(0, 500),
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          // 与非流式走同一套拆分：思考 part 不能当正文推给前端
          const candidate = parsed.candidates?.[0];
          const { content: chunkText } = splitGeminiParts(candidate?.content?.parts);
          if (chunkText) yield { type: 'chunk', text: chunkText };
          if (candidate?.finishReason) stopReason = candidate.finishReason;
          if (parsed.usageMetadata) {
            inputTokens = parsed.usageMetadata.promptTokenCount || inputTokens;
            outputTokens = parsed.usageMetadata.candidatesTokenCount || outputTokens;
          }
        } catch { /* skip parse errors */ }
      }
    }

    yield { type: 'usage', inputTokens, outputTokens, stopReason };
  }
}

// ═══════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════

// ─── 版本路径规范化 ───
// OpenAI 兼容 API 的端点几乎都挂在 /v1 下（/v1/chat/completions、
// /v1/responses）。用户常把 baseUrl 填成根地址（缺 /v1），请求就会
// 打到中转站首页返回 HTML。这里在末尾没有 /vN 版本号时自动补 /v1。
function withVersionPath(baseUrl) {
  let b = String(baseUrl || '').replace(/\/+$/, '');
  if (!/\/v\d+$/.test(b)) b += '/v1';
  return b;
}

// Gemini 的版本路径是 /v1beta（或 /v1），且模型名拼在路径里
function withGeminiVersionPath(baseUrl) {
  let b = String(baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  if (!/\/v\d+(beta|alpha)?$/.test(b)) b += '/v1beta';
  return b;
}

function normalizeGeminiModel(model) {
  return String(model || '').replace(/^models\//, '').replace(/^google\//, '');
}

function createAIAdapter(model, apiConfig, apiType) {
  const provider = detectProvider(model, apiType);
  console.log(`[AI Adapter] Using ${provider} provider for model "${model}" (apiType: ${apiType || 'auto'})`);

  // Derive endpoint URLs from the shared /v1-level base URL
  if (provider === 'openai') {
    const baseUrl = withVersionPath(apiConfig.apiBaseUrl || 'https://api.deepseek.com/v1');
    apiConfig.chatUrl = baseUrl + '/chat/completions';
  } else if (provider === 'openai-response') {
    const baseUrl = withVersionPath(apiConfig.apiBaseUrl || 'https://api.openai.com/v1');
    apiConfig.responsesUrl = baseUrl + '/responses';
  } else if (provider === 'gemini') {
    const base = withGeminiVersionPath(apiConfig.apiBaseUrl);
    const modelPath = normalizeGeminiModel(apiConfig.apiModel);
    apiConfig.geminiUrl = `${base}/models/${modelPath}:generateContent`;
    apiConfig.geminiStreamUrl = `${base}/models/${modelPath}:streamGenerateContent`;
  }

  switch (provider) {
    case 'claude':
      return new ClaudeProvider(apiConfig);
    case 'openai-response':
      return new OpenAIResponsesProvider(apiConfig);
    case 'gemini':
      return new GeminiProvider(apiConfig);
    case 'openai':
    default:
      return new OpenAIProvider(apiConfig);
  }
}

module.exports = {
  createAIAdapter,
  OpenAIProvider,
  OpenAIResponsesProvider,
  ClaudeProvider,
  GeminiProvider,
  detectProvider,
  clampSampling,
  SAMPLING_LIMITS,
  toResponsesInput,
  toResponsesTools,
  fromResponsesOutput,
  toGeminiContents,
  toGeminiTools,
  fromGeminiOutput,
  splitGeminiParts,
  toClaudeMessages,
  stripNonStandardToolFields,
  claudeRequestParams,
  makeResponse,
  normalizeStopReason,
  isTruncatedReason,
};
