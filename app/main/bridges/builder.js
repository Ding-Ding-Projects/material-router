// Purpose: Builder-lane main-process bridge. Registers the builder:* handlers
// the API Builder tab drives:
//
//   builder:schema            - replaces the foundation descriptor with real
//                               composer metadata (ranges, suggestion lists)
//   builder:translate-preview - canonical OpenAI body -> Anthropic body via
//                               translator.openaiToAnthropicRequest (the exact
//                               pure functions server.js routes through)
//   builder:test-send         - resolves a route through providersStore +
//                               vault secrets and calls the upstream directly,
//                               mirroring server.js's pipeline; progress is
//                               streamed to the renderer as 'builder-stream'
//                               events keyed by requestId
//   builder:test-abort        - aborts one in-flight test request
//   builder:preset-*          - named compositions persisted through JSONStore
//   builder:open-in-editor    - writes an export file atomically and hands it
//                               to VS Code when present, else the default app
//
// Secrets never leave this process: keys are read from the vault here and
// attached to the upstream call; nothing that reaches the renderer carries one.
// Owned by Builder lane.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, shell } from 'electron';
import { JSONStore, atomicWriteFile } from '../store.js';
import { registerHandler } from '../ipc.js';
import {
  openaiToAnthropicRequest,
  anthropicToOpenaiRequest,
  anthropicToOpenaiResponse,
  openaiToAnthropicResponse,
  AnthropicEventToOpenAI,
  OpenAIChunkToAnthropic,
  upstreamHeaders,
  upstreamPath,
} from '../translator.js';
import { callUpstream, UpstreamError } from '../upstream.js';

// Composer metadata mirrored in the schema descriptor below. The renderer's
// compose.js is the interactive source of truth; these literals exist so
// builder:schema answers honestly without main reaching into renderer code.
const MESSAGE_ROLES = ['user', 'assistant', 'system'];
const LIMITS = {
  temperature: { min: 0, max: 2, step: 0.05, default: 0.7 },
  topP: { min: 0, max: 1, step: 0.05, default: 1 },
  maxTokens: { min: 1, max: 200000, step: 1, default: 1024 },
  stops: { min: 0, max: 8 },
  messages: { min: 1, max: 200 },
};
const SYSTEM_PRESET_KEYS = ['none', 'concise', 'coder', 'translator'];
const TOOL_SUGGESTION_NAMES = ['get_weather', 'web_search', 'calculator', 'read_file', 'create_ticket'];
const SCHEMA_TEMPLATE_KEYS = ['city_query', 'search_query', 'expression', 'path_only', 'record', 'empty_object'];
const SNIPPET_LANGUAGE_KEYS = ['curl', 'js_fetch', 'py_requests', 'ts_anthropic_sdk', 'js_openai_sdk'];

const PRESET_STORE_FILE = 'builder-presets.json';
const MAX_PRESETS = 100;
const MAX_PRESET_JSON_CHARS = 200_000;
const MAX_STREAM_TRANSCRIPT_CHARS = 400_000;
const MAX_CONCURRENT_TESTS = 4;

/** requestId -> AbortController for in-flight test requests */
const activeTests = new Map();
let testCounter = 0;

export function register(ctx) {
  const { settingsStore, vault, providersStore, routerServer, broadcast } = ctx;

  // -- presets persistence (JSONStore: atomic temp+rename+retry) -------------
  const presetsStore = new JSONStore(path.join(app.getPath('userData'), PRESET_STORE_FILE), {
    defaults: { schemaVersion: 1, presets: [] },
    debounceMs: 150,
  });

  const listPresets = () => {
    const raw = presetsStore.get('presets', []);
    return Array.isArray(raw) ? raw : [];
  };

  const writePresets = (list) => presetsStore.set('presets', list);

  // -- schema ------------------------------------------------------------------
  // Replaces the foundation's placeholder descriptor (invited by ipc.js).
  registerHandler('builder', 'schema', () => ({
    version: 2,
    endpoints: [
      { id: 'openai', path: '/v1/chat/completions' },
      { id: 'anthropic', path: '/v1/messages' },
    ],
    roles: [...MESSAGE_ROLES],
    rolesByEndpoint: { openai: [...MESSAGE_ROLES], anthropic: ['user', 'assistant'] },
    limits: LIMITS,
    systemPresets: [...SYSTEM_PRESET_KEYS],
    toolSuggestions: [...TOOL_SUGGESTION_NAMES],
    schemaTemplates: [...SCHEMA_TEMPLATE_KEYS],
    snippetLanguages: [...SNIPPET_LANGUAGE_KEYS],
    streamEvent: 'builder-stream',
  }));

  // -- translate preview ---------------------------------------------------------
  // The renderer composes in canonical OpenAI shape; the Anthropic view always
  // comes from the same translator the router itself uses.
  registerHandler('builder', 'translate-preview', ({ body }) => {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('translate-preview: body must be a JSON object');
    }
    const { req, notes } = openaiToAnthropicRequest(parsed);
    return { req, notes };
  });

  // -- presets --------------------------------------------------------------------
  registerHandler('builder', 'preset-list', () => ({
    presets: listPresets().map(sanitizePresetOut),
  }));

  registerHandler('builder', 'preset-save', ({ name, preset, id } = {}) => {
    const cleanName = String(name ?? '').trim();
    if (!cleanName || cleanName.length > 80) {
      throw new Error('preset-save: a name of 1-80 characters is required');
    }
    const clean = sanitizePresetIn(preset);
    const list = listPresets();

    let target = null;
    if (typeof id === 'string' && id) {
      target = list.find((p) => p.id === id) ?? null;
    }
    if (!target) {
      target = list.find((p) => p.name.toLowerCase() === cleanName.toLowerCase()) ?? null;
    }
    const replaced = Boolean(target);

    if (target) {
      target.name = cleanName;
      target.preset = clean;
      target.updatedAt = new Date().toISOString();
    } else {
      if (list.length >= MAX_PRESETS) {
        throw new Error(`preset-save: at most ${MAX_PRESETS} presets can be stored`);
      }
      list.push({
        id: `bp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        name: cleanName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        preset: clean,
      });
    }
    writePresets(list);
    return { saved: sanitizePresetOut(target), replaced };
  });

  registerHandler('builder', 'preset-delete', ({ id } = {}) => {
    const key = String(id ?? '');
    const list = listPresets();
    const next = list.filter((p) => p.id !== key);
    if (next.length === list.length) return false;
    writePresets(next);
    return true;
  });

  // -- test send ---------------------------------------------------------------
  // Mirrors LocalRouterServer._handleCompletion: route resolution, wire-format
  // translation, vault-backed credentials, rejecting deadline, response
  // translation back into the inbound format. Progress flows out as
  // broadcast('builder-stream', ...) events so the tab can render streams live.
  registerHandler('builder', 'test-send', ({ endpoint = 'openai', body } = {}) => {
    if (activeTests.size >= MAX_CONCURRENT_TESTS) {
      throw new Error(`at most ${MAX_CONCURRENT_TESTS} test requests can run at once`);
    }
    const format = endpoint === 'anthropic' ? 'anthropic' : 'openai';
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('test-send: body must be a JSON object');
    }
    const model = typeof parsed.model === 'string' ? parsed.model : '';
    const route = providersStore.resolveRoute(model);
    if (!route) {
      throw new Error(
        `no provider matched model "${model || '(none)'}" and no fallback provider is configured`,
      );
    }
    const { provider } = route;
    const targetFormat = provider.type === 'anthropic' ? 'anthropic' : 'openai';

    testCounter += 1;
    const requestId = `btest_${Date.now().toString(36)}_${testCounter}`;
    const controller = new AbortController();
    activeTests.set(requestId, controller);
    const startedAt = Date.now();

    const emit = (payload) => broadcast('builder-stream', { requestId, ...payload });
    emit({
      kind: 'start',
      provider: provider.name,
      providerId: provider.id,
      routedModel: model,
      translating: format !== targetFormat,
    });

    // Fire the async pipeline; test-send returns immediately so the renderer
    // can subscribe before chunks arrive. Errors surface as events, never as
    // unhandled rejections.
    runTestSend({
      requestId, emit, controller, startedAt, format, targetFormat,
      parsed, provider, model,
      settingsStore, vault,
    }).finally(() => activeTests.delete(requestId));

    return { requestId };
  });

  registerHandler('builder', 'test-abort', ({ requestId } = {}) => {
    const entry = activeTests.get(String(requestId ?? ''));
    if (!entry) return false;
    entry.abort(new DOMException('cancelled by user', 'AbortError'));
    return true;
  });

  // -- editor handoff ------------------------------------------------------------
  registerHandler('builder', 'open-in-editor', async ({ filename, content } = {}) => {
    const safeName = String(filename ?? '')
      .replace(/[\\/]/g, '_')
      .replace(/^\.+/, '_')
      .slice(0, 120) || `material-router-export-${Date.now()}.txt`;
    const dir = path.join(app.getPath('userData'), 'builder-exports');
    const file = path.join(dir, safeName);
    await atomicWriteFile(file, String(content ?? ''));

    const launched = await tryLaunchVsCode(file);
    if (launched.ok) {
      return { opened: 'vscode', path: file };
    }
    // Fallback: the platform default handler for this file type. Returns ''
    // on success or a failure string, per Electron's shell.openPath contract.
    const fallbackErr = await shell.openPath(file);
    if (!fallbackErr) {
      return { opened: 'default', path: file };
    }
    return { opened: false, path: file, reason: fallbackErr.slice(0, 200) };
  });
}

// ---------------------------------------------------------------------------
// Test-send pipeline
// ---------------------------------------------------------------------------

async function runTestSend(opts) {
  const {
    requestId, emit, controller, startedAt,
    format, targetFormat, parsed, provider, model,
    settingsStore, vault,
  } = opts;

  let upstreamReq = structuredClone(parsed);
  try {
    if (format !== targetFormat) {
      if (format === 'openai') {
        const t = openaiToAnthropicRequest(parsed);
        upstreamReq = t.req;
        for (const n of t.notes) emit({ kind: 'note', detail: n.message });
      } else {
        // Inbound anthropic-shaped body heading to an OpenAI-speaking
        // provider: run it through the real translator rather than trusting
        // whatever shape the client composed.
        const t = anthropicToOpenaiRequest(parsed);
        upstreamReq = t.req;
        for (const n of t.notes) emit({ kind: 'note', detail: n.message });
      }
    }
    if (!upstreamReq.model) upstreamReq.model = provider.defaultModel || undefined;
  } catch (err) {
    emit({ kind: 'error', status: 400, type: 'invalid_request_error', message: err?.message ?? 'translation failed' });
    return;
  }

  const apiKey = provider.keyRef ? (vault.getSecret(provider.keyRef) || '') : '';
  const url = upstreamPath(provider, provider.type === 'anthropic' ? 'messages' : 'chat');
  const cfg = settingsStore.get('server.requestTimeoutMs', 120_000);
  const timeoutMs = Number(cfg) > 0 ? Number(cfg) : 120_000;
  const wantsStream = Boolean(upstreamReq.stream);

  let upstream;
  try {
    upstream = await callUpstream(provider, apiKey, url, upstreamReq, {
      stream: wantsStream,
      timeoutMs,
      signal: controller.signal,
      headers: upstreamHeaders(provider, apiKey),
    });
  } catch (err) {
    emit(failureEvent(err));
    return;
  }

  try {
    if (!wantsStream) {
      const json = upstream.json();
      const outJson = format !== targetFormat
        ? (format === 'openai'
          ? anthropicToOpenaiResponse(json, model)
          : openaiToAnthropicResponse(json, model))
        : json;
      emit({
        kind: 'done',
        status: upstream.status,
        ms: Date.now() - startedAt,
        bytes: upstream.bytes,
        response: outJson,
        usage: usageOf(outJson),
        text: null,
        truncated: false,
      });
      return;
    }

    await pipeTestStream({ emit, upstream, format, targetFormat, model, startedAt });
  } catch (err) {
    emit(failureEvent(err));
  }
}

/**
 * Consume an SSE upstream and emit normalized progress events. Text deltas
 * are extracted regardless of passthrough vs translated direction so the
 * renderer shows one consistent streaming view.
 */
async function pipeTestStream({ emit, upstream, format, targetFormat, model, startedAt }) {
  const transcript = [];
  let transcriptChars = 0;
  let truncated = false;
  let text = '';
  let textChars = 0;
  const TEXT_CAP = 200_000;
  const usageIn = { prompt: null, completion: null };

  /** @type {AnthropicEventToOpenAI|OpenAIChunkToAnthropic|null} */
  let conv = null;
  if (format === 'openai' && targetFormat === 'anthropic') conv = new OpenAIChunkToAnthropic(model);
  if (format === 'anthropic' && targetFormat === 'openai') conv = new AnthropicEventToOpenAI(model);
  let doneSeen = false;

  for await (const payload of upstream.sse) {
    const trimmed = payload.trim();
    transcript.push(payload);
    transcriptChars += payload.length + 1;
    if (transcriptChars > MAX_STREAM_TRANSCRIPT_CHARS) {
      truncated = true;
      break;
    }
    if (trimmed === '[DONE]') { doneSeen = true; break; }

    let evt;
    try { evt = JSON.parse(payload); } catch { continue; }

    if (conv) {
      const outs = conv.push(evt);
      for (const out of outs) {
        const serialized = JSON.stringify(out);
        transcript.push(serialized);
        transcriptChars += serialized.length + 1;
        const piece = deltaTextOf(out, targetFormat);
        if (piece && textChars < TEXT_CAP) { text += piece; textChars += piece.length; }
      }
    } else {
      const piece = deltaTextOf(evt, targetFormat);
      if (piece && textChars < TEXT_CAP) { text += piece; textChars += piece.length; }
    }

    const u = streamUsageOf(evt, targetFormat);
    if (u.prompt != null) usageIn.prompt = u.prompt;
    if (u.completion != null) usageIn.completion = u.completion;

    if (!conv) {
      // Terminal markers on the native format.
      if (targetFormat === 'anthropic' && evt?.type === 'message_stop') doneSeen = true;
      if (targetFormat === 'openai' && evt?.choices?.[0]?.finish_reason) doneSeen = true;
    }
  }

  if (conv && !doneSeen) {
    for (const out of conv.finish()) {
      const serialized = JSON.stringify(out);
      transcript.push(serialized);
      transcriptChars += serialized.length + 1;
      const piece = deltaTextOf(out, targetFormat);
      if (piece && textChars < TEXT_CAP) { text += piece; textChars += piece.length; }
    }
  }

  emit({
    kind: 'done',
    status: upstream.status,
    ms: Date.now() - startedAt,
    bytes: upstream.bytes,
    response: null,
    usage: {
      prompt: usageIn.prompt,
      completion: usageIn.completion,
      total: usageIn.prompt != null && usageIn.completion != null
        ? usageIn.prompt + usageIn.completion
        : null,
    },
    text,
    truncated,
    transcript: transcript.join('\n\n'),
  });
}

function deltaTextOf(evt, format) {
  if (format === 'openai') {
    const delta = evt?.choices?.[0]?.delta;
    if (delta && typeof delta.content === 'string') return delta.content;
    return '';
  }
  if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
    return typeof evt.delta.text === 'string' ? evt.delta.text : '';
  }
  return '';
}

function streamUsageOf(evt, format) {
  if (format === 'openai') {
    const u = evt?.usage;
    if (u && typeof u === 'object') {
      return {
        prompt: Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : null,
        completion: Number.isFinite(u.completion_tokens) ? u.completion_tokens : null,
      };
    }
    return {};
  }
  if (evt?.type === 'message_start') {
    return { prompt: Number.isFinite(evt.message?.usage?.input_tokens) ? evt.message.usage.input_tokens : null };
  }
  if (evt?.type === 'message_delta') {
    return { completion: Number.isFinite(evt.usage?.output_tokens) ? evt.usage.output_tokens : null };
  }
  return {};
}

function usageOf(json) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const u = json?.usage ?? {};
  const prompt = num(u.prompt_tokens ?? u.input_tokens);
  const completion = num(u.completion_tokens ?? u.output_tokens);
  let total = num(u.total_tokens);
  if (total === null && prompt !== null && completion !== null) total = prompt + completion;
  return { prompt, completion, total };
}

function failureEvent(err) {
  if (err instanceof UpstreamError) {
    if (err.status === 499 || err.type === 'aborted') return { kind: 'aborted' };
    return { kind: 'error', status: err.status, type: err.type, message: err.message };
  }
  if (err?.name === 'DeadlineError') {
    return { kind: 'error', status: 504, type: 'timeout', message: String(err.message ?? '').slice(0, 200) };
  }
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
    return { kind: 'aborted' };
  }
  return {
    kind: 'error',
    status: 502,
    type: 'api_error',
    message: String(err?.message ?? 'upstream failure').slice(0, 200),
  };
}

// ---------------------------------------------------------------------------
// Preset sanitizing
// ---------------------------------------------------------------------------

function sanitizePresetIn(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('preset-save: preset object required');
  const json = JSON.stringify(raw);
  if (json.length > MAX_PRESET_JSON_CHARS) {
    throw new Error(`preset-save: preset exceeds ${Math.floor(MAX_PRESET_JSON_CHARS / 1000)}KB`);
  }
  return raw;
}

function sanitizePresetOut(p) {
  return {
    id: String(p?.id ?? ''),
    name: String(p?.name ?? ''),
    createdAt: String(p?.createdAt ?? ''),
    updatedAt: String(p?.updatedAt ?? ''),
    preset: p?.preset && typeof p.preset === 'object' ? p.preset : null,
  };
}

// ---------------------------------------------------------------------------
// VS Code handoff
// ---------------------------------------------------------------------------

function vsCodeCandidates() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
      path.join(programFiles, 'Microsoft VS Code', 'bin', 'code.cmd'),
      path.join(programFilesX86, 'Microsoft VS Code', 'bin', 'code.cmd'),
      'code.cmd',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/usr/local/bin/code',
      'code',
    ];
  }
  return ['/usr/bin/code', '/usr/local/bin/code', 'code'];
}

/**
 * Try each known VS Code launcher in order. Resolves {ok:true} on the first
 * candidate that demonstrably launched (clean exit or still alive after the
 * grace window) and {ok:false} when every candidate fails fast.
 */
async function tryLaunchVsCode(file) {
  for (const candidate of vsCodeCandidates()) {
    if (await spawnDetached(candidate, [file])) return { ok: true };
  }
  return { ok: false };
}

function spawnDetached(cmd, args) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      const quoted = process.platform === 'win32' ? args.map((a) => `"${a}"`) : args;
      const child = spawn(cmd, quoted, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: process.platform === 'win32', // the launcher is a .cmd shim there
      });
      child.on('error', () => finish(false));
      child.on('exit', (code) => finish(code === 0));
      // Still running past the grace window counts as launched; the editor
      // keeps its own lifetime from here.
      timer = setTimeout(() => finish(true), 2500);
    } catch {
      finish(false);
    }
  });
}
