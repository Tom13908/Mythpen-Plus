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
   */
  async complete(systemPrompt, messages, tools, temperature) {
    const { apiConfig } = this;
    const body = {
      model: apiConfig.apiModel,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools: tools || undefined,
      temperature: temperature ?? 0.8,
      max_tokens: 4096,
      stream: false,
    };

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

    const data = await response.json();
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
  async *stream(systemPrompt, messages, temperature) {
    const { apiConfig } = this;
    const body = {
      model: apiConfig.apiModel,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: temperature ?? 0.85,
      max_tokens: 4096,
      stream: true,
    };

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
    return response.json();
  }

  /**
   * Non-streaming completion (supports tools).
   * Used by the tool-call loop in /api/ai/chat/stream.
   */
  async complete(systemPrompt, messages, tools, temperature) {
    const { apiConfig } = this;
    const data = await this.post({
      model: apiConfig.apiModel,
      instructions: systemPrompt,
      input: toResponsesInput(messages),
      tools: toResponsesTools(tools),
      temperature: temperature ?? 0.8,
      max_output_tokens: 4096,
      store: false,
      stream: false,
    });

    const { content, toolCalls } = fromResponsesOutput(data);
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    return makeResponse(content, toolCalls, inputTokens, outputTokens);
  }

  /**
   * Streaming completion (no tools).
   * Used by /api/ai/continue.
   */
  async *stream(systemPrompt, messages, temperature) {
    const { apiConfig } = this;
    const response = await fetch(apiConfig.responsesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
      body: JSON.stringify({
        model: apiConfig.apiModel,
        instructions: systemPrompt,
        input: toResponsesInput(messages),
        temperature: temperature ?? 0.85,
        max_output_tokens: 4096,
        store: false,
        stream: true,
      }),
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
  async complete(systemPrompt, messages, tools, temperature) {
    const { apiConfig, client } = this;

    const params = {
      model: apiConfig.apiModel,
      system: systemPrompt,
      messages: toClaudeMessages(messages),
      max_tokens: 4096,
      temperature: temperature ?? 0.8,
    };

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
  async *stream(systemPrompt, messages, temperature) {
    const { apiConfig, client } = this;

    const stream = client.messages.stream({
      model: apiConfig.apiModel,
      system: systemPrompt,
      messages: toClaudeMessages(messages),
      max_tokens: 4096,
      temperature: temperature ?? 0.85,
    });

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

function createAIAdapter(model, apiConfig, apiType) {
  const provider = detectProvider(model, apiType);
  console.log(`[AI Adapter] Using ${provider} provider for model "${model}" (apiType: ${apiType || 'auto'})`);

  // Derive endpoint URLs from the shared /v1-level base URL
  if (provider === 'openai') {
    const baseUrl = apiConfig.apiBaseUrl || 'https://api.deepseek.com/v1';
    apiConfig.chatUrl = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  } else if (provider === 'openai-response') {
    const baseUrl = apiConfig.apiBaseUrl || 'https://api.openai.com/v1';
    apiConfig.responsesUrl = baseUrl.replace(/\/+$/, '') + '/responses';
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
  toResponsesInput,
  toResponsesTools,
  fromResponsesOutput,
};
