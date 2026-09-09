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

function detectProvider(model, apiType) {
  if (apiType === 'claude' || apiType === 'anthropic') return 'claude';
  if (apiType === 'openai-response' || apiType === 'responses') return 'openai-response';
  if (apiType === 'openai') return 'openai';
  if (!model) return 'openai';
  const m = model.toLowerCase();
  if (m.startsWith('claude') || m.startsWith('anthropic/')) return 'claude';
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
  for (const item of data.output || []) {
    if (item.type === 'message') {
      for (const block of item.content || []) {
        if (block.type === 'output_text') content += block.text || '';
      }
    } else if (item.type === 'function_call') {
      let args;
      try { args = JSON.parse(item.arguments || '{}'); } catch { args = {}; }
      toolCalls.push({ id: item.call_id, name: item.name, args });
    }
    // 'reasoning' items are ignored
  }
  return { content: content || null, toolCalls };
}

// ─── Unified response format ───

function makeResponse(content, toolCalls, inputTokens, outputTokens) {
  return { content, toolCalls, usage: { inputTokens, outputTokens } };
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
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools: tools || undefined,
      max_tokens: apiConfig.maxOutputTokens || 4096,
      stream: false,
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

    const toolCalls = (msg?.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments || '{}'),
    }));

    return makeResponse(msg?.content || null, toolCalls, inputTokens, outputTokens);
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
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: 'chunk', text: delta.content };
          }
          if (parsed.usage) {
            yield { type: 'usage', inputTokens: parsed.usage.prompt_tokens || 0, outputTokens: parsed.usage.completion_tokens || 0 };
          }
        } catch { /* skip parse errors */ }
      }
    }
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
    const response = await fetch(this.apiConfig.responsesUrl, {
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
    const data = await this.post(reqBody);

    const { content, toolCalls } = fromResponsesOutput(data);
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    return makeResponse(content, toolCalls, inputTokens, outputTokens);
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
          } else if (parsed.type === 'response.completed') {
            const usage = parsed.response?.usage || {};
            yield { type: 'usage', inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 };
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

    const params = {
      model: apiConfig.apiModel,
      system: systemPrompt,
      messages: toClaudeMessages(messages),
      max_tokens: apiConfig.maxOutputTokens || 4096,
    };
    if (s.temperature !== undefined) params.temperature = s.temperature;
    if (s.topP !== undefined) params.top_p = s.topP;

    if (tools && tools.length > 0) {
      params.tools = toClaudeTools(tools);
    }

    const response = await client.messages.create(params);
    const toolCalls = [];
    let content = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, args: block.input });
      }
    }

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    return makeResponse(content || null, toolCalls, inputTokens, outputTokens);
  }

  /**
   * Streaming chat completion (no tools).
   */
  async *stream(systemPrompt, messages, sampling) {
    const { apiConfig, client } = this;
    const s = clampSampling('claude', sampling) || {};

    const streamParams = {
      model: apiConfig.apiModel,
      system: systemPrompt,
      messages: toClaudeMessages(messages),
      max_tokens: apiConfig.maxOutputTokens || 4096,
    };
    if (s.temperature !== undefined) streamParams.temperature = s.temperature;
    if (s.topP !== undefined) streamParams.top_p = s.topP;

    const stream = client.messages.stream(streamParams);

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield { type: 'chunk', text: event.delta.text };
      }
      if (event.type === 'message_delta') {
        if (event.usage) {
          outputTokens = event.usage.output_tokens || 0;
        }
      }
      if (event.type === 'message_start') {
        if (event.message?.usage) {
          inputTokens = event.message.usage.input_tokens || 0;
        }
      }
    }

    yield { type: 'usage', inputTokens, outputTokens };
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
  }

  switch (provider) {
    case 'claude':
      return new ClaudeProvider(apiConfig);
    case 'openai-response':
      return new OpenAIResponsesProvider(apiConfig);
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
  detectProvider,
  clampSampling,
  SAMPLING_LIMITS,
  toResponsesInput,
  toResponsesTools,
  fromResponsesOutput,
};
