// Purpose: pure composition model for the API Builder tab. No DOM, no IPC:
// state shape, defaults, clamping, the canonical OpenAI-format body that the
// preview and send paths share, and preset sanitizing shared by save/load.
// The Anthropic view of a composition is produced in the main process through
// translator.openaiToAnthropicRequest so the preview can never drift from the
// real routing pipeline.
// Owned by Builder lane.

export const ENDPOINTS = Object.freeze({
  openai: { id: 'openai', path: '/v1/chat/completions' },
  anthropic: { id: 'anthropic', path: '/v1/messages' },
});

/** Ranges shown next to the controls and enforced by clampState(). */
export const LIMITS = Object.freeze({
  temperature: { min: 0, max: 2, step: 0.05, default: 0.7 },
  topP: { min: 0, max: 1, step: 0.05, default: 1 },
  maxTokens: { min: 1, max: 200000, step: 1, default: 1024 },
  stops: { min: 0, max: 8 },
  messages: { min: 1, max: 200 },
});

/**
 * System-prompt presets. Values are facts shipped with the app; the picker
 * fills the editable textarea so the user can start from words instead of a
 * blank box.
 */
export const SYSTEM_PRESETS = Object.freeze([
  { key: 'none', text: '' },
  {
    key: 'concise',
    text: 'Answer as briefly as possible while staying correct. No preamble, no restating the question.',
  },
  {
    key: 'coder',
    text: 'You are a senior software engineer. Prefer complete working code over prose, name the exact files touched, and call out edge cases you deliberately skipped.',
  },
  {
    key: 'translator',
    text: 'Translate the user text faithfully into Traditional Chinese as used in Hong Kong. Keep tone, formatting and technical terms intact; do not add commentary.',
  },
]);

/** Tool-name suggestions plus the canned description each one pairs with. */
export const TOOL_SUGGESTIONS = Object.freeze([
  { name: 'get_weather', description: 'Look up current weather observations for a city name.' },
  { name: 'web_search', description: 'Search the public web and return short snippets with links.' },
  { name: 'calculator', description: 'Evaluate one arithmetic expression and return the numeric result.' },
  { name: 'read_file', description: 'Read a UTF-8 text file from the workspace and return its contents.' },
  { name: 'create_ticket', description: 'Create a tracked ticket with a title, body and severity.' },
]);

/**
 * JSON Schema templates for the tool mini-form. Keys are stable identifiers;
 * the schema objects are plain data so they survive structured clone.
 */
export const SCHEMA_TEMPLATES = Object.freeze([
  {
    key: 'city_query',
    label: 'City query — one required string',
    schema: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name, e.g. "Hong Kong"' } },
      required: ['city'],
    },
  },
  {
    key: 'search_query',
    label: 'Search query — string + optional limit',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
    },
  },
  {
    key: 'expression',
    label: 'Single expression — one required string',
    schema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  },
  {
    key: 'path_only',
    label: 'File path — one required string',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    key: 'record',
    label: 'Small record — title, body, severity enum',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        severity: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['title', 'body'],
    },
  },
  {
    key: 'empty_object',
    label: 'Empty object — no parameters',
    schema: { type: 'object', properties: {} },
  },
]);

export const MESSAGE_ROLES = Object.freeze(['user', 'assistant', 'system']);

/** Roles the OpenAI wire format accepts in `messages`. */
export function rolesForEndpoint(endpoint) {
  return endpoint === 'anthropic' ? ['user', 'assistant'] : [...MESSAGE_ROLES];
}

export function defaultComposition() {
  return {
    endpoint: 'openai',
    providerId: '',
    model: '',
    params: {
      temperature: LIMITS.temperature.default,
      topP: LIMITS.topP.default,
      maxTokens: LIMITS.maxTokens.default,
      stops: [],
      stream: false,
    },
    system: { presetKey: 'none', custom: '' },
    tools: {
      enabled: false,
      suggestionIndex: 0,
      description: TOOL_SUGGESTIONS[0].description,
      templateKey: SCHEMA_TEMPLATES[0].key,
    },
    messages: [newMessage('user')],
  };
}

let msgSeq = 0;
export function newMessage(role = 'user') {
  msgSeq += 1;
  return { id: `msg_${msgSeq}_${Math.random().toString(36).slice(2, 7)}`, role, content: '' };
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function clampText(v, maxLen) {
  if (typeof v !== 'string') return '';
  return v.length > maxLen ? v.slice(0, maxLen) : v;
}

/**
 * Deep-normalize any loaded/pasted shape into a valid composition. Every
 * numeric field is clamped into its declared range; unknown roles fall back
 * to 'user'; oversized text is truncated rather than trusted.
 */
export function normalizeComposition(raw) {
  const d = defaultComposition();
  if (!raw || typeof raw !== 'object') return d;

  const out = d;
  if (raw.endpoint === 'openai' || raw.endpoint === 'anthropic') out.endpoint = raw.endpoint;
  if (typeof raw.providerId === 'string') out.providerId = clampText(raw.providerId, 120);
  if (typeof raw.model === 'string') out.model = clampText(raw.model, 200);

  const p = raw.params && typeof raw.params === 'object' ? raw.params : {};
  out.params.temperature = clampNum(p.temperature, LIMITS.temperature.min, LIMITS.temperature.max, d.params.temperature);
  out.params.topP = clampNum(p.topP, LIMITS.topP.min, LIMITS.topP.max, d.params.topP);
  out.params.maxTokens = Math.round(clampNum(p.maxTokens, LIMITS.maxTokens.min, LIMITS.maxTokens.max, d.params.maxTokens));
  out.params.stream = Boolean(p.stream);
  if (Array.isArray(p.stops)) {
    out.params.stops = p.stops
      .filter((s) => typeof s === 'string' && s.length > 0)
      .slice(0, LIMITS.stops.max)
      .map((s) => clampText(s, 120));
  }

  const sys = raw.system && typeof raw.system === 'object' ? raw.system : {};
  const presetKeys = SYSTEM_PRESETS.map((x) => x.key);
  if (presetKeys.includes(sys.presetKey)) out.system.presetKey = sys.presetKey;
  out.system.custom = clampText(sys.custom, 20000);

  const tools = raw.tools && typeof raw.tools === 'object' ? raw.tools : {};
  out.tools.enabled = Boolean(tools.enabled);
  const idx = Number(tools.suggestionIndex);
  if (Number.isInteger(idx) && idx >= 0 && idx < TOOL_SUGGESTIONS.length) out.tools.suggestionIndex = idx;
  else if (TOOL_SUGGESTIONS.some((tl) => tl.name === tools.name)) {
    out.tools.suggestionIndex = TOOL_SUGGESTIONS.findIndex((tl) => tl.name === tools.name);
  }
  out.tools.description = clampText(tools.description ?? TOOL_SUGGESTIONS[out.tools.suggestionIndex].description, 500);
  if (SCHEMA_TEMPLATES.some((tl) => tl.key === tools.templateKey)) out.tools.templateKey = tools.templateKey;

  if (Array.isArray(raw.messages) && raw.messages.length > 0) {
    out.messages = raw.messages
      .slice(0, LIMITS.messages.max)
      .map((m) => ({
        id: typeof m?.id === 'string' ? m.id : newMessage().id,
        role: MESSAGE_ROLES.includes(m?.role) ? m.role : 'user',
        content: clampText(m?.content, 100000),
      }));
  }

  return out;
}

/** System prompt text implied by the current system card state. */
export function systemText(state) {
  if (state.system.custom.trim()) return state.system.custom.trim();
  const preset = SYSTEM_PRESETS.find((p) => p.key === state.system.presetKey);
  return preset ? preset.text : '';
}

/**
 * The canonical OpenAI chat.completions body for this composition. This is
 * exactly what "as-OpenAI" preview shows and what test-send posts when the
 * OpenAI endpoint is selected.
 */
export function canonicalOpenAIBody(state) {
  const msgs = [];
  const sys = systemText(state);
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const m of state.messages) {
    msgs.push({ role: m.role, content: m.content });
  }

  const body = {
    model: state.model || '',
    messages: msgs,
    temperature: round2(state.params.temperature),
    top_p: round2(state.params.topP),
    max_tokens: state.params.maxTokens,
    stream: Boolean(state.params.stream),
  };
  if (state.params.stops.length > 0) body.stop = [...state.params.stops];

  if (state.tools.enabled) {
    const template = SCHEMA_TEMPLATES.find((t) => t.key === state.tools.templateKey) ?? SCHEMA_TEMPLATES[0];
    const tool = TOOL_SUGGESTIONS[state.tools.suggestionIndex] ?? TOOL_SUGGESTIONS[0];
    body.tools = [{
      type: 'function',
      function: {
        name: tool.name,
        description: state.tools.description || tool.description,
        parameters: structuredClone(template.schema),
      },
    }];
  }
  return body;
}

/**
 * Validation for the Send action. Returns an array of human-readable keys
 * (i18n keys under builder.err.*) — empty means ready to send.
 */
export function validationErrors(state) {
  const errors = [];
  if (!state.model) errors.push('builder.err.noModel');
  if (!state.providerId) errors.push('builder.err.noProvider');
  const usable = state.messages.filter((m) => m.content.trim().length > 0);
  if (usable.length === 0) errors.push('builder.err.noMessages');
  return errors;
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

/**
 * Extract usage numbers from either wire format's response. Missing fields
 * stay null so the UI never invents a zero.
 */
export function extractUsage(json) {
  const u = json?.usage ?? null;
  if (!u || typeof u !== 'object') return { prompt: null, completion: null, total: null };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const prompt = num(u.prompt_tokens ?? u.input_tokens);
  const completion = num(u.completion_tokens ?? u.output_tokens);
  let total = num(u.total_tokens);
  if (total === null && prompt !== null && completion !== null) total = prompt + completion;
  return { prompt, completion, total };
}
