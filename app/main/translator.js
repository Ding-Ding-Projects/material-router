// Purpose: bidirectional translation between the OpenAI chat.completions wire
// format and the Anthropic /v1/messages wire format, non-streaming and
// streaming. Pure functions and stateful stream converters; no I/O anywhere.
// Foundation seam: server.js routes through these; Builder lane reuses them
// for previewing translated payloads.
// Owned by Foundation Core lane.

// ---------------------------------------------------------------------------
// Mapping tables
// ---------------------------------------------------------------------------

export const FINISH_TO_STOP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

export const STOP_TO_FINISH = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  pause_turn: 'stop',
};

export const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';

function note(notes, code, message) {
  notes.push({ code, message });
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
  }
  return '';
}

/** Parse an OpenAI image_url data URL into {media_type,data} or null. */
function parseDataUrl(url) {
  if (typeof url !== 'string') return null;
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  if (!m) return null;
  return { media_type: m[1].toLowerCase(), data: m[2] };
}

function toDataUrl(mediaType, b64) {
  return `data:${mediaType};base64,${b64}`;
}

// ---------------------------------------------------------------------------
// Request translation: OpenAI -> Anthropic
// ---------------------------------------------------------------------------

export function openaiToAnthropicRequest(o, { defaultMaxTokens = DEFAULT_MAX_TOKENS } = {}) {
  const notes = [];
  const out = {};
  const systemParts = [];

  if (typeof o === 'string') o = JSON.parse(o);
  if (!o || typeof o !== 'object') throw new Error('request body must be a JSON object');
  if (!Array.isArray(o.messages)) throw new Error("'messages' array is required");

  /** @type {Array<{role:string,content:any}>} */
  const msgs = [];

  for (const msg of o.messages) {
    if (!msg || typeof msg.role !== 'string') continue;
    switch (msg.role) {
      case 'system':
      case 'developer': {
        const t = textFromContent(msg.content).trim();
        if (t) systemParts.push(t);
        break;
      }
      case 'user': {
        const blocks = userBlocksFromOpenAI(msg.content, notes);
        msgs.push({ role: 'user', content: blocks });
        break;
      }
      case 'assistant': {
        const blocks = [];
        const text = textFromContent(msg.content);
        if (text) blocks.push({ type: 'text', text });
        for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
          if (!tc || tc.type === 'function' || !tc.type) {
            let input = {};
            try { input = JSON.parse(tc?.function?.arguments ?? '{}'); } catch { /* note below */ }
            blocks.push({
              type: 'tool_use',
              id: tc?.id || `call_${Math.random().toString(36).slice(2, 10)}`,
              name: tc?.function?.name || 'unknown_tool',
              input,
            });
          } else {
            note(notes, 'unsupported_tool_call_type', `ignored assistant tool_call type "${tc.type}"`);
          }
        }
        if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
        msgs.push({ role: 'assistant', content: blocks });
        break;
      }
      case 'tool': {
        // A tool result becomes a user message containing a tool_result block.
        const resultText = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('\n')
            : JSON.stringify(msg.content ?? null);
        msgs.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || '', content: resultText }],
        });
        break;
      }
      case 'function':
        note(notes, 'dropped_legacy_function_role', 'legacy "function" role messages are not supported by Anthropic; dropped');
        break;
      default:
        note(notes, 'unknown_role_dropped', `unknown role "${msg.role}" dropped`);
    }
  }

  if (systemParts.length > 0) out.system = systemParts.join('\n\n');

  // Anthropic requires alternating roles starting with user.
  const merged = mergeAdjacentRoles(msgs, notes);
  ensureFirstIsUser(merged, notes);
  out.messages = merged;

  if (Array.isArray(o.tools) && o.tools.length > 0) {
    const tools = [];
    for (const t of o.tools) {
      const fn = t?.type === 'function' ? t.function : (t && !t.type ? t : null);
      if (!fn || typeof fn.name !== 'string') {
        note(notes, 'malformed_tool_def_skipped', 'a tools[] entry without a function name was skipped');
        continue;
      }
      tools.push({
        name: fn.name,
        description: fn.description ?? '',
        input_schema: fn.parameters ?? { type: 'object', properties: {} },
      });
    }
    if (tools.length > 0) out.tools = tools;
  }

  if (o.tool_choice !== undefined) {
    if (o.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
    else if (o.tool_choice === 'required') out.tool_choice = { type: 'any' };
    else if (o.tool_choice && typeof o.tool_choice === 'object' && o.tool_choice.function?.name) {
      out.tool_choice = { type: 'tool', name: String(o.tool_choice.function.name) };
    } else if (o.tool_choice === 'none') {
      note(notes, 'tool_choice_none_unsupported', '"tool_choice":"none" has no Anthropic equivalent; dropped');
    } else {
      note(notes, 'tool_choice_dropped', 'unrecognized tool_choice value dropped');
    }
  }

  if (typeof o.temperature === 'number') out.temperature = clamp(o.temperature, 0, 1);
  if (typeof o.top_p === 'number') out.top_p = clamp(o.top_p, 0, 1);

  if (o.stop !== undefined) {
    const seqs = Array.isArray(o.stop) ? o.stop : [o.stop];
    const valid = seqs.filter((s) => typeof s === 'string' && s.length > 0);
    if (valid.length > 4) {
      note(notes, 'stop_sequences_truncated', 'Anthropic accepts at most 4 stop_sequences; extra entries dropped');
    }
    out.stop_sequences = valid.slice(0, 4);
  }

  const mt = o.max_completion_tokens ?? o.max_tokens;
  if (typeof mt === 'number' && Number.isFinite(mt)) {
    out.max_tokens = Math.floor(mt);
  } else {
    out.max_tokens = defaultMaxTokens;
    note(
      notes,
      'max_tokens_defaulted',
      `Anthropic requires max_tokens; defaulted to ${defaultMaxTokens}`,
    );
  }

  for (const key of ['frequency_penalty', 'presence_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'n', 'seed']) {
    if (o[key] !== undefined) {
      note(notes, 'param_not_supported', `"${key}" has no Anthropic equivalent; dropped`);
    }
  }

  out.stream = Boolean(o.stream);
  return { req: out, notes };
}

function userBlocksFromOpenAI(content, notes) {
  const blocks = [];
  if (typeof content === 'string') {
    blocks.push({ type: 'text', text: content });
    return blocks;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        const parsed = parseDataUrl(part.image_url?.url);
        if (parsed) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: parsed.media_type, data: parsed.data } });
        } else {
          note(notes, 'image_url_skipped', 'only base64 data URLs can be sent to Anthropic; a remote image_url was dropped');
        }
      } else {
        note(notes, 'content_part_skipped', `unsupported content part type "${part?.type}" dropped`);
      }
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

function mergeAdjacentRoles(msgs, notes) {
  const merged = [];
  for (const msg of msgs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [...prev.content, ...msg.content];
    } else {
      merged.push({ role: msg.role, content: [...msg.content] });
    }
  }
  if (merged.length !== msgs.length) {
    note(notes, 'messages_merged', 'adjacent same-role messages were merged to satisfy Anthropic alternation rules');
  }
  return merged;
}

function ensureFirstIsUser(msgs, notes) {
  if (msgs.length === 0) return;
  if (msgs[0].role !== 'user') {
    msgs.unshift({
      role: 'user',
      content: [{ type: 'text', text: '[Continue the conversation.]' }],
    });
    note(notes, 'leading_assistant_wrapped', 'conversation started with an assistant message; a user turn was inserted before it');
  }
}

// ---------------------------------------------------------------------------
// Request translation: Anthropic -> OpenAI
// ---------------------------------------------------------------------------

export function anthropicToOpenaiRequest(a) {
  const notes = [];
  if (typeof a === 'string') a = JSON.parse(a);
  if (!a || typeof a !== 'object') throw new Error('request body must be a JSON object');

  const out = { model: a.model };
  const msgs = [];

  const sys = a.system;
  if (typeof sys === 'string' && sys.trim()) {
    msgs.push({ role: 'system', content: sys });
  } else if (Array.isArray(sys)) {
    const t = sys.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n\n');
    if (t.trim()) msgs.push({ role: 'system', content: t });
  }

  for (const msg of Array.isArray(a.messages) ? a.messages : []) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;

    if (msg.role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      for (const block of asBlocks(msg.content)) {
        if (block.type === 'text' && block.text) textParts.push(block.text);
        if (block.type === 'thinking') continue;
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: safeStringify(block.input) },
          });
        }
      }
      const am = { role: 'assistant', content: textParts.join('') || (toolCalls.length ? null : '') };
      if (toolCalls.length) am.tool_calls = toolCalls;
      msgs.push(am);
      continue;
    }

    // user message: split into plain parts and tool_result blocks. Tool results
    // must become separate role:"tool" messages that follow the assistant turn.
    const plain = [];
    for (const block of asBlocks(msg.content)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        plain.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && block.source?.type === 'base64') {
        plain.push({
          type: 'image_url',
          image_url: { url: toDataUrl(block.source.media_type || 'image/png', block.source.data) },
        });
      } else if (block.type === 'document') {
        note(notes, 'document_block_unsupported', 'PDF document blocks have no OpenAI equivalent; dropped');
      } else if (block.type === 'tool_result') {
        flushPlain();
        const content = typeof block.content === 'string'
          ? block.content
          : asBlocks(block.content).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
            || (block.content == null ? '' : safeStringify(block.content));
        msgs.push({ role: 'tool', tool_call_id: block.tool_use_id || '', content });
      } else if (block.type === 'thinking') {
        continue;
      }
    }
    flushPlain();

    function flushPlain() {
      if (plain.length > 0) {
        msgs.push({ role: 'user', content: plain.splice(0) });
      }
    }
  }

  out.messages = msgs;

  if (Array.isArray(a.tools) && a.tools.length > 0) {
    out.tools = a.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
  }

  if (a.tool_choice?.type === 'auto') out.tool_choice = 'auto';
  else if (a.tool_choice?.type === 'any') out.tool_choice = 'required';
  else if (a.tool_choice?.type === 'tool') out.tool_choice = { type: 'function', function: { name: a.tool_choice.name } };

  if (typeof a.temperature === 'number') out.temperature = a.temperature;
  if (typeof a.top_p === 'number') out.top_p = a.top_p;
  if (Array.isArray(a.stop_sequences) && a.stop_sequences.length) out.stop = a.stop_sequences;
  if (typeof a.max_tokens === 'number') out.max_tokens = a.max_tokens;

  for (const key of ['metadata', 'top_k', 'stream']) {
    if (a[key] !== undefined && key !== 'stream') {
      note(notes, 'param_not_supported', `"${key}" has no OpenAI equivalent; dropped`);
    }
  }
  out.stream = Boolean(a.stream);
  return { req: out, notes };
}

function asBlocks(content) {
  if (content == null) return [];
  if (Array.isArray(content)) return content.filter(Boolean);
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [content];
}

function safeStringify(v) {
  try { return JSON.stringify(v ?? {}); } catch { return '{}'; }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// Non-streaming response translation
// ---------------------------------------------------------------------------

export function anthropicToOpenaiResponse(a, fallbackModel) {
  const choiceBlocks = asBlocks(a?.content);
  const text = choiceBlocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const toolCalls = choiceBlocks
    .filter((b) => b.type === 'tool_use')
    .map((b, i) => ({
      id: b.id || `call_${i}`,
      type: 'function',
      function: { name: b.name, arguments: safeStringify(b.input) },
    }));

  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: a?.id || `chatcmpl-${randomId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: a?.model || fallbackModel,
    choices: [{
      index: 0,
      message,
      finish_reason: STOP_TO_FINISH[a?.stop_reason] ?? 'stop',
    }],
    usage: {
      prompt_tokens: a?.usage?.input_tokens ?? 0,
      completion_tokens: a?.usage?.output_tokens ?? 0,
      total_tokens: (a?.usage?.input_tokens ?? 0) + (a?.usage?.output_tokens ?? 0),
    },
  };
}

export function openaiToAnthropicResponse(o, fallbackModel, notes = []) {
  const choice = o?.choices?.[0];
  const msg = choice?.message ?? {};
  const blocks = [];

  const text = typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content)
      ? msg.content.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('')
      : '';
  if (text) blocks.push({ type: 'text', text });

  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    let input = {};
    try { input = JSON.parse(tc?.function?.arguments ?? '{}'); } catch {
      note(notes, 'tool_arguments_invalid_json', 'a tool_call had non-JSON arguments; empty input substituted');
    }
    blocks.push({
      type: 'tool_use',
      id: tc?.id || `toolu_${randomId()}`,
      name: tc?.function?.name || 'unknown_tool',
      input,
    });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });

  return {
    id: o?.id || `msg_${randomId()}`,
    type: 'message',
    role: 'assistant',
    model: o?.model || fallbackModel,
    content: blocks,
    stop_reason: FINISH_TO_STOP[choice?.finish_reason] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: o?.usage?.prompt_tokens ?? 0,
      output_tokens: o?.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming conversion: OpenAI chunks -> Anthropic SSE events
// ---------------------------------------------------------------------------

/**
 * Consumes parsed chat.completion.chunk objects and emits arrays of Anthropic
 * SSE event objects (message_start / content_block_* / message_delta /
 * message_stop).
 */
export class OpenAIChunkToAnthropic {
  constructor(model) {
    this.model = model;
    this.started = false;
    this.nextBlockIndex = 0;
    this.textBlockIndex = null;
    /** openai tool index -> anthropic block index */
    this.toolBlockByIndex = new Map();
    this.finishReason = null;
    this.usageIn = 0;
    this.usageOut = 0;
    this.id = `msg_${randomId()}`;
  }

  push(chunk) {
    const events = [];
    const choice = chunk?.choices?.[0];

    if (!this.started) {
      this.started = true;
      events.push({
        type: 'message_start',
        message: {
          id: chunk?.id || this.id,
          type: 'message',
          role: 'assistant',
          model: chunk?.model || this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: chunk?.usage?.prompt_tokens ?? 0, output_tokens: 0 },
        },
      });
    }
    if (chunk?.usage) {
      if (typeof chunk.usage.prompt_tokens === 'number') this.usageIn = chunk.usage.prompt_tokens;
      if (typeof chunk.usage.completion_tokens === 'number') this.usageOut = chunk.usage.completion_tokens;
    }

    const delta = choice?.delta;
    if (delta && typeof delta === 'object') {
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (this.textBlockIndex === null) {
          this.textBlockIndex = this.nextBlockIndex++;
          events.push({
            type: 'content_block_start',
            index: this.textBlockIndex,
            content_block: { type: 'text', text: '' },
          });
        }
        events.push({
          type: 'content_block_delta',
          index: this.textBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : this.toolBlockByIndex.size;
          let blockIdx = this.toolBlockByIndex.get(idx);
          if (blockIdx === undefined) {
            blockIdx = this.nextBlockIndex++;
            this.toolBlockByIndex.set(idx, blockIdx);
            events.push({
              type: 'content_block_start',
              index: blockIdx,
              content_block: {
                type: 'tool_use',
                id: tc.id || `toolu_${randomId()}`,
                name: tc.function?.name || 'unknown_tool',
                input: {},
              },
            });
          }
          if (tc.function?.arguments) {
            events.push({
              type: 'content_block_delta',
              index: blockIdx,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            });
          }
        }
      }
      // delta.reasoning_content / other vendor extensions are ignored silently:
      // they carry no client-visible contract on the Anthropic side.
    }

    if (choice?.finish_reason) this.finishReason = choice.finish_reason;
    return events;
  }

  finish() {
    const events = [];
    if (!this.started) {
      this.started = true;
      events.push({
        type: 'message_start',
        message: {
          id: this.id,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.usageIn, output_tokens: 0 },
        },
      });
    }
    if (this.textBlockIndex !== null) {
      events.push({ type: 'content_block_stop', index: this.textBlockIndex });
    }
    for (const blockIdx of this.toolBlockByIndex.values()) {
      events.push({ type: 'content_block_stop', index: blockIdx });
    }
    const hadToolUse = this.toolBlockByIndex.size > 0;
    const stopReason = this.finishReason
      ? (FINISH_TO_STOP[this.finishReason] ?? 'end_turn')
      : (hadToolUse ? 'tool_use' : 'end_turn');
    events.push({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.usageOut },
    });
    events.push({ type: 'message_stop' });
    return events;
  }
}

// ---------------------------------------------------------------------------
// Streaming conversion: Anthropic SSE events -> OpenAI chunks
// ---------------------------------------------------------------------------

/**
 * Consumes parsed Anthropic event objects and emits arrays of
 * chat.completion.chunk objects. The caller appends the [DONE] sentinel.
 */
export class AnthropicEventToOpenAI {
  constructor(model) {
    this.model = model;
    this.id = `chatcmpl-${randomId()}`;
    this.created = Math.floor(Date.now() / 1000);
    this.sentRole = false;
    /** anthropic block index -> {kind:'text'|'tool', toolIndex?} */
    this.blocks = new Map();
    this.nextToolIndex = 0;
    this.stopReason = null;
    this.usageIn = 0;
    this.usageOut = 0;
    this.finished = false;
  }

  _chunk(delta, finishReason = null) {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }

  push(evt) {
    const chunks = [];
    if (!evt || typeof evt !== 'object') return chunks;

    switch (evt.type) {
      case 'message_start': {
        this.usageIn = evt.message?.usage?.input_tokens ?? this.usageIn;
        if (!this.sentRole) {
          this.sentRole = true;
          chunks.push(this._chunk({ role: 'assistant', content: '' }));
        }
        break;
      }
      case 'content_block_start': {
        const idx = evt.index;
        const block = evt.content_block;
        if (block?.type === 'tool_use') {
          const toolIndex = this.nextToolIndex++;
          this.blocks.set(idx, { kind: 'tool', toolIndex });
          chunks.push(this._chunk({
            tool_calls: [{
              index: toolIndex,
              id: block.id || `call_${randomId()}`,
              type: 'function',
              function: { name: block.name || 'unknown_tool', arguments: '' },
            }],
          }));
        } else {
          this.blocks.set(idx, { kind: block?.type || 'text' });
          if (!this.sentRole) {
            this.sentRole = true;
            chunks.push(this._chunk({ role: 'assistant', content: '' }));
          }
        }
        break;
      }
      case 'content_block_delta': {
        const info = this.blocks.get(evt.index) || { kind: 'text' };
        if (evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
          if (!this.sentRole) {
            this.sentRole = true;
            chunks.push(this._chunk({ role: 'assistant', content: '' }));
          }
          chunks.push(this._chunk({ content: evt.delta.text }));
        } else if (evt.delta?.type === 'input_json_delta' && info.kind === 'tool') {
          chunks.push(this._chunk({
            tool_calls: [{
              index: info.toolIndex,
              function: { arguments: evt.delta.partial_json ?? '' },
            }],
          }));
        }
        // thinking_delta / signature_delta are internal to Anthropic clients.
        break;
      }
      case 'content_block_stop':
        break;
      case 'message_delta': {
        if (evt.delta?.stop_reason) this.stopReason = evt.delta.stop_reason;
        if (typeof evt.usage?.output_tokens === 'number') this.usageOut = evt.usage.output_tokens;
        break;
      }
      case 'message_stop': {
        if (!this.finished) {
          this.finished = true;
          chunks.push({
            ...this._chunk({}, STOP_TO_FINISH[this.stopReason] ?? 'stop'),
            usage: {
              prompt_tokens: this.usageIn,
              completion_tokens: this.usageOut,
              total_tokens: this.usageIn + this.usageOut,
            },
          });
        }
        break;
      }
      case 'error': {
        // Surface upstream errors as a terminal chunk with finish_reason so the
        // client sees a closed stream rather than silence.
        if (!this.finished) {
          this.finished = true;
          chunks.push(this._chunk({}, 'stop'));
        }
        break;
      }
      default:
        break;
    }
    return chunks;
  }

  finish() {
    if (this.finished) return [];
    this.finished = true;
    return [{
      ...this._chunk({}, STOP_TO_FINISH[this.stopReason] ?? 'stop'),
      usage: {
        prompt_tokens: this.usageIn,
        completion_tokens: this.usageOut,
        total_tokens: this.usageIn + this.usageOut,
      },
    }];
  }
}

// ---------------------------------------------------------------------------
// Shared helpers used by server.js
// ---------------------------------------------------------------------------

/** Headers for calling an upstream provider of the given type. */
export function upstreamHeaders(provider, apiKey) {
  if (provider.type === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
}

/** Path appended to provider.baseUrl per purpose, avoiding double '/v1'. */
export function upstreamPath(provider, purpose) {
  const paths = {
    openaiChat: '/v1/chat/completions',
    anthropicMessages: '/v1/messages',
    models: '/v1/models',
  };
  const raw = provider.type === 'anthropic'
    ? (purpose === 'models' ? paths.models : paths.anthropicMessages)
    : (purpose === 'models' ? paths.models : paths.openaiChat);
  const base = (provider.baseUrl || '').replace(/\/+$/, '');
  if (/\/v1$/i.test(base)) return base + raw.slice(3); // strip leading '/v1'
  return base + raw;
}

/** Client-facing error bodies per inbound format. */
export function errorBody(format, status, type, message) {
  if (format === 'anthropic') {
    return { type: 'error', error: { type: type || 'api_error', message } };
  }
  return { error: { message, type: type || 'invalid_request_error', code: status } };
}

function randomId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
