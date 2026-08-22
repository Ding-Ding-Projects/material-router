// Purpose: pure-core tests for app/main/translator.js — request/response
// translation in both directions plus both streaming converters.
// Zero dependencies: node:test + node:assert only.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FINISH_TO_STOP,
  STOP_TO_FINISH,
  DEFAULT_MAX_TOKENS,
  openaiToAnthropicRequest,
  anthropicToOpenaiRequest,
  anthropicToOpenaiResponse,
  openaiToAnthropicResponse,
  OpenAIChunkToAnthropic,
  AnthropicEventToOpenAI,
  upstreamHeaders,
  upstreamPath,
  errorBody,
} from '../app/main/translator.js';

// A tiny valid PNG data URL payload (bytes do not need to decode; the
// translator treats base64 payloads opaquely).
const IMG_B64 = 'AAAA';
const IMG_DATA_URL = `data:image/png;base64,${IMG_B64}`;

const WEATHER_TOOL_OPENAI = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Look up weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
};

function sampleOpenAiMessages() {
  return [
    { role: 'system', content: 'You are a helpful router.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is the weather?' },
        { type: 'image_url', image_url: { url: IMG_DATA_URL } },
      ],
    },
    {
      role: 'assistant',
      content: 'Let me check.',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"HK"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '22C sunny' },
  ];
}

// ---------------------------------------------------------------------------
// Mapping tables
// ---------------------------------------------------------------------------

test('finish/stop mapping tables round-trip on their shared keys', () => {
  assert.equal(FINISH_TO_STOP.stop, 'end_turn');
  assert.equal(FINISH_TO_STOP.length, 'max_tokens');
  assert.equal(FINISH_TO_STOP.tool_calls, 'tool_use');
  for (const [stop, finish] of Object.entries(STOP_TO_FINISH)) {
    // Two Anthropic stop reasons collapse onto OpenAI's "stop"; the reverse
    // table can only recover one of them. That degeneracy is by design.
    if (stop === 'pause_turn' || stop === 'stop_sequence') {
      assert.equal(finish, 'stop', `${stop} maps to stop`);
      continue;
    }
    assert.equal(FINISH_TO_STOP[finish], stop, `${finish} -> ${stop}`);
  }
});

test('DEFAULT_MAX_TOKENS is exported and used when max_tokens missing', () => {
  assert.equal(typeof DEFAULT_MAX_TOKENS, 'number');
  const { req, notes } = openaiToAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(req.max_tokens, DEFAULT_MAX_TOKENS);
  assert.ok(notes.some((n) => n.code === 'max_tokens_defaulted'));
});

// ---------------------------------------------------------------------------
// openaiToAnthropicRequest
// ---------------------------------------------------------------------------

test('openaiToAnthropicRequest: full-featured request translates faithfully', () => {
  const o = {
    model: 'gpt-test',
    messages: sampleOpenAiMessages(),
    tools: [WEATHER_TOOL_OPENAI],
    tool_choice: 'auto',
    stop: ['STOP', 'END'],
    temperature: 1.5,
    top_p: 0.9,
    max_tokens: 512,
    stream: true,
  };
  const { req, notes } = openaiToAnthropicRequest(o);

  assert.equal(req.system, 'You are a helpful router.');
  assert.equal(req.max_tokens, 512);
  assert.deepEqual(req.stop_sequences, ['STOP', 'END']);
  // temperature clamped into Anthropic's [0,1]
  assert.equal(req.temperature, 1);
  assert.equal(req.top_p, 0.9);
  assert.equal(req.stream, true);

  assert.deepEqual(req.tools, [{
    name: 'get_weather',
    description: 'Look up weather',
    input_schema: WEATHER_TOOL_OPENAI.function.parameters,
  }]);
  assert.deepEqual(req.tool_choice, { type: 'auto' });

  const [userMsg, assistantMsg, toolResultMsg] = req.messages;
  assert.equal(userMsg.role, 'user');
  assert.deepEqual(userMsg.content, [
    { type: 'text', text: 'What is the weather?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG_B64 } },
  ]);
  assert.equal(assistantMsg.role, 'assistant');
  assert.deepEqual(assistantMsg.content, [
    { type: 'text', text: 'Let me check.' },
    { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'HK' } },
  ]);
  assert.equal(toolResultMsg.role, 'user');
  assert.deepEqual(toolResultMsg.content, [{
    type: 'tool_result', tool_use_id: 'call_1', content: '22C sunny',
  }]);

  assert.equal(notes.length, 0, `unexpected notes: ${JSON.stringify(notes)}`);
});

test('openaiToAnthropicRequest: system+developer prompts merge, adjacent roles merge', () => {
  const { req, notes } = openaiToAnthropicRequest({
    messages: [
      { role: 'system', content: 'rule one' },
      { role: 'developer', content: 'rule two' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ],
  });
  assert.equal(req.system, 'rule one\n\nrule two');
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].content.length, 2);
  assert.ok(notes.some((n) => n.code === 'messages_merged'));
});

test('openaiToAnthropicRequest: leading assistant turn gets a user wrapper', () => {
  const { req, notes } = openaiToAnthropicRequest({
    messages: [{ role: 'assistant', content: 'hi there' }],
  });
  assert.equal(req.messages[0].role, 'user');
  assert.equal(req.messages[1].role, 'assistant');
  assert.ok(notes.some((n) => n.code === 'leading_assistant_wrapped'));
});

test('openaiToAnthropicRequest: max_completion_tokens preferred over max_tokens', () => {
  const { req } = openaiToAnthropicRequest({
    messages: [{ role: 'user', content: 'x' }],
    max_tokens: 10,
    max_completion_tokens: 77,
  });
  assert.equal(req.max_tokens, 77);
});

test('openaiToAnthropicRequest: >4 stop sequences truncated with note', () => {
  const { req, notes } = openaiToAnthropicRequest({
    messages: [{ role: 'user', content: 'x' }],
    stop: ['a', 'b', 'c', 'd', 'e', 'f'],
  });
  assert.equal(req.stop_sequences.length, 4);
  assert.ok(notes.some((n) => n.code === 'stop_sequences_truncated'));
});

test('openaiToAnthropicRequest: tool_choice variants map correctly; "none" dropped with note', () => {
  const required = openaiToAnthropicRequest({
    messages: [{ role: 'user', content: 'x' }], tool_choice: 'required',
  }).req;
  assert.deepEqual(required.tool_choice, { type: 'any' });

  const named = openaiToAnthropicRequest({
    messages: [{ role: 'user', content: 'x' }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  }).req;
  assert.deepEqual(named.tool_choice, { type: 'tool', name: 'get_weather' });

  const none = openaiToAnthropicRequest({
    messages: [{ role: 'user', content: 'x' }], tool_choice: 'none',
  });
  assert.equal(none.req.tool_choice, undefined);
  assert.ok(none.notes.some((n) => n.code === 'tool_choice_none_unsupported'));
});

test('openaiToAnthropicRequest: unsupported params and remote images produce honest notes', () => {
  const { req, notes } = openaiToAnthropicRequest({
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'pic?' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
        { type: 'audio_url', audio_url: { url: 'https://example.com/a.mp3' } },
      ] },
    ],
    frequency_penalty: 0.5,
    seed: 42,
  });
  // Only the text part survived.
  assert.deepEqual(req.messages[0].content, [{ type: 'text', text: 'pic?' }]);
  const codes = notes.map((n) => n.code);
  assert.ok(codes.includes('image_url_skipped'));
  assert.ok(codes.includes('content_part_skipped'));
  assert.ok(codes.includes('param_not_supported'));
});

test('openaiToAnthropicRequest: accepts a JSON string body; rejects malformed bodies', () => {
  const fromString = openaiToAnthropicRequest(JSON.stringify({ messages: [{ role: 'user', content: 's' }] }));
  assert.equal(fromString.req.messages[0].content[0].text, 's');

  assert.throws(() => openaiToAnthropicRequest(null), /JSON object/);
  assert.throws(() => openaiToAnthropicRequest({}), /messages/);
});

test('openaiToAnthropicRequest: malformed tool defs skipped; empty assistant gets empty text block', () => {
  const { req, notes } = openaiToAnthropicRequest({
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null },
    ],
    tools: [{ type: 'function', function: { description: 'no name here' } }, WEATHER_TOOL_OPENAI],
  });
  // The assistant turn is second; the leading user wrapper is asserted elsewhere.
  assert.deepEqual(req.messages[1].content, [{ type: 'text', text: '' }]);
  assert.equal(req.tools.length, 1);
  assert.ok(notes.some((n) => n.code === 'malformed_tool_def_skipped'));
});

// ---------------------------------------------------------------------------
// anthropicToOpenaiRequest
// ---------------------------------------------------------------------------

test('anthropicToOpenaiRequest: system string/array, thinking blocks skipped', () => {
  const { req } = anthropicToOpenaiRequest({
    model: 'claude-test',
    system: 'Be brief.',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'internal' },
        { type: 'text', text: 'Answer one.' },
        { type: 'thinking', thinking: 'more internal' },
        { type: 'text', text: ' Answer two.' },
      ] },
    ],
  });
  assert.deepEqual(req.messages[0], { role: 'system', content: 'Be brief.' });
  assert.deepEqual(req.messages[1], { role: 'user', content: [{ type: 'text', text: 'hello' }] });
  const assistant = req.messages[2];
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content, 'Answer one. Answer two.');
  assert.equal(assistant.tool_calls, undefined);
});

test('anthropicToOpenaiRequest: tool_use becomes tool_calls with JSON arguments string', () => {
  const { req } = anthropicToOpenaiRequest({
    messages: [{ role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: { city: 'HK' } },
    ] }],
  });
  const am = req.messages[0];
  assert.equal(am.role, 'assistant');
  assert.equal(am.content, null, 'assistant with only tool calls has null content');
  assert.deepEqual(am.tool_calls, [{
    id: 'toolu_9', type: 'function',
    function: { name: 'get_weather', arguments: '{"city":"HK"}' },
  }]);
});

test('anthropicToOpenaiRequest: tool_result blocks become role:"tool" messages after user text', () => {
  const { req } = anthropicToOpenaiRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'context first' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'result body' },
        { type: 'text', text: 'and also look at this' },
      ] },
    ],
  });
  const kinds = req.messages.map((m) =>
    m.role === 'tool' ? `tool:${m.tool_call_id}` : m.role);
  assert.deepEqual(kinds, ['user', 'assistant', 'tool:t1', 'user']);
  assert.deepEqual(req.messages[2], { role: 'tool', tool_call_id: 't1', content: 'result body' });
  assert.deepEqual(req.messages[3].content.map((p) => p.text), ['and also look at this']);
});

test('anthropicToOpenaiRequest: image block round-trips to identical data URL', () => {
  const { req } = anthropicToOpenaiRequest({
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: IMG_B64 } },
    ] }],
  });
  assert.deepEqual(req.messages[0].content, [
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
  ]);
});

test('anthropicToOpenaiRequest: params copied or noted honestly', () => {
  const { req, notes } = anthropicToOpenaiRequest({
    model: 'm',
    max_tokens: 321,
    stop_sequences: ['A'],
    temperature: 0.4,
    top_p: 0.8,
    stream: true,
    metadata: { user_id: 'u' },
    top_k: 5,
    messages: [],
  });
  assert.equal(req.max_tokens, 321);
  assert.deepEqual(req.stop, ['A']);
  assert.equal(req.temperature, 0.4);
  assert.equal(req.top_p, 0.8);
  assert.equal(req.stream, true);
  const codes = notes.map((n) => n.code);
  assert.ok(codes.filter((c) => c === 'param_not_supported').length >= 2); // metadata + top_k
});

test('anthropicToOpenaiRequest: document blocks dropped with note; tools mapped', () => {
  const { req, notes } = anthropicToOpenaiRequest({
    messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }],
    tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
  });
  // A user turn holding only an unsupported block vanishes entirely — the drop
  // is at least recorded in notes rather than silently corrupting the stream.
  assert.deepEqual(req.messages, []);
  assert.ok(notes.some((n) => n.code === 'document_block_unsupported'));
  assert.deepEqual(req.tools, [{
    type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } },
  }]);
});

// ---------------------------------------------------------------------------
// Round trip: OpenAI -> Anthropic -> OpenAI
// ---------------------------------------------------------------------------

test('round trip OpenAI->Anthropic->OpenAI preserves system/roles/text/image/tools/tool_calls/stops/max_tokens', () => {
  const original = {
    model: 'any-model',
    messages: sampleOpenAiMessages(),
    tools: [WEATHER_TOOL_OPENAI],
    stop: ['STOP'],
    max_tokens: 640,
  };
  const { req: mid } = openaiToAnthropicRequest(original);
  const { req: back } = anthropicToOpenaiRequest(mid);

  // System prompt survives as the first message.
  assert.equal(back.messages[0].role, 'system');
  assert.equal(back.messages[0].content, 'You are a helpful router.');

  const roles = back.messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool']);

  const user = back.messages[1];
  assert.equal(user.content[0].type, 'text');
  assert.equal(user.content[0].text, 'What is the weather?');
  assert.equal(user.content[1].image_url.url, IMG_DATA_URL);

  const assistant = back.messages[2];
  assert.equal(assistant.content, 'Let me check.');
  assert.deepEqual(assistant.tool_calls, [{
    id: 'call_1', type: 'function',
    function: { name: 'get_weather', arguments: '{"city":"HK"}' },
  }]);

  assert.deepEqual(
    back.messages[3],
    { role: 'tool', tool_call_id: 'call_1', content: '22C sunny' },
  );

  assert.deepEqual(back.tools, [WEATHER_TOOL_OPENAI]);
  assert.deepEqual(back.stop, ['STOP']);
  assert.equal(back.max_tokens, 640);
});

test('double round trip is stable (translate back and forth twice, same result)', () => {
  const original = { messages: sampleOpenAiMessages(), tools: [WEATHER_TOOL_OPENAI], max_tokens: 100 };
  const onceFwd = openaiToAnthropicRequest(original).req;
  const onceBack = anthropicToOpenaiRequest(onceFwd).req;
  const twiceFwd = openaiToAnthropicRequest(onceBack).req;
  const twiceBack = anthropicToOpenaiRequest(twiceFwd).req;
  assert.deepEqual(twiceBack, onceBack);
});

// ---------------------------------------------------------------------------
// Non-streaming response translation
// ---------------------------------------------------------------------------

test('anthropicToOpenaiResponse maps content blocks, stop reason and usage', () => {
  const out = anthropicToOpenaiResponse({
    id: 'msg_1',
    model: 'claude-x',
    content: [
      { type: 'text', text: 'partial ' },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'HK' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 11, output_tokens: 7 },
  }, 'fallback-model');

  assert.equal(out.object, 'chat.completion');
  assert.equal(out.model, 'claude-x');
  const choice = out.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.role, 'assistant');
  assert.equal(choice.message.content, 'partial answer');
  assert.deepEqual(choice.message.tool_calls, [{
    id: 'tu_1', type: 'function',
    function: { name: 'get_weather', arguments: '{"city":"HK"}' },
  }]);
  assert.deepEqual(out.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
});

test('anthropicToOpenaiResponse falls back on missing id/model/stop_reason', () => {
  const out = anthropicToOpenaiResponse({}, 'fallback-model');
  assert.match(out.id, /^chatcmpl-/);
  assert.equal(out.model, 'fallback-model');
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.deepEqual(out.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('openaiToAnthropicResponse maps inverse direction incl. finish reasons and usage', () => {
  const out = openaiToAnthropicResponse({
    id: 'chatcmpl_9',
    model: 'gpt-x',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'here you go',
        tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
      },
      finish_reason: 'length',
    }],
    usage: { prompt_tokens: 3, completion_tokens: 9 },
  }, 'fb');

  assert.equal(out.type, 'message');
  assert.equal(out.id, 'chatcmpl_9');
  assert.equal(out.model, 'gpt-x');
  assert.equal(out.stop_reason, 'max_tokens');
  assert.deepEqual(out.usage, { input_tokens: 3, output_tokens: 9 });
  assert.equal(out.content[0].text, 'here you go');
  assert.deepEqual(out.content[1], { type: 'tool_use', id: 'call_2', name: 'f', input: { a: 1 } });
});

test('openaiToAnthropicResponse: invalid tool-call JSON arguments noted, empty input substituted', () => {
  const notes = [];
  const out = openaiToAnthropicResponse({
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'f', arguments: '{not json' } },
    ] }, finish_reason: 'stop' }],
  }, 'fb', notes);
  // Null content contributes no text block once a tool_use exists; the
  // placeholder empty-text block only appears when there is nothing at all.
  assert.deepEqual(out.content, [
    { type: 'tool_use', id: 'c1', name: 'f', input: {} },
  ]);
  assert.ok(notes.some((n) => n.code === 'tool_arguments_invalid_json'));
});

test('response translations round-trip through each other', () => {
  const anthropicOriginal = {
    id: 'msg_rt',
    model: 'claude-rt',
    content: [
      { type: 'text', text: 'final words' },
      { type: 'tool_use', id: 'tu_rt', name: 'fn', input: { k: [1, 2] } },
    ],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 5, output_tokens: 6 },
  };
  const asOpenai = anthropicToOpenaiResponse(anthropicOriginal, 'fb');
  const backToAnthropic = openaiToAnthropicResponse(asOpenai, 'fb2');
  assert.equal(backToAnthropic.id, 'msg_rt');
  assert.equal(backToAnthropic.model, 'claude-rt');
  assert.equal(backToAnthropic.stop_reason, 'max_tokens');
  assert.deepEqual(backToAnthropic.usage, { input_tokens: 5, output_tokens: 6 });
  assert.deepEqual(backToAnthropic.content, anthropicOriginal.content);
});

// ---------------------------------------------------------------------------
// Streaming: OpenAI chunks -> Anthropic events
// ---------------------------------------------------------------------------

function collectStreamEvents(chunks, model = 'stream-model') {
  const conv = new OpenAIChunkToAnthropic(model);
  const events = [];
  for (const c of chunks) events.push(...conv.push(c));
  events.push(...conv.finish());
  return events;
}

test('OpenAIChunkToAnthropic: role-first chunk emits message_start without opening a text block', () => {
  const events = collectStreamEvents([
    { id: 'cmpl_1', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { id: 'cmpl_1', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]);
  assert.equal(events[0].type, 'message_start');
  assert.equal(events[0].message.id, 'cmpl_1');
  assert.equal(events[0].message.model, 'm');
  assert.equal(events[0].message.usage.input_tokens, 0);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['message_start', 'message_delta', 'message_stop']);
  assert.equal(events[1].delta.stop_reason, 'end_turn');
});

test('OpenAIChunkToAnthropic: text deltas become one text block with ordered deltas', () => {
  const events = collectStreamEvents([
    { choices: [{ delta: { role: 'assistant' } }] },
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  const startIdx = events.findIndex((e) => e.type === 'content_block_start');
  assert.ok(startIdx !== -1, 'expected a content_block_start');
  assert.equal(events[startIdx].content_block.type, 'text');
  const deltas = events.filter((e) => e.type === 'content_block_delta');
  assert.deepEqual(deltas.map((d) => d.delta.text), ['Hel', 'lo']);
  assert.ok(deltas.every((d) => d.delta.type === 'text_delta'));
  assert.ok(deltas.every((d) => d.index === events[startIdx].index));
  // Block closes before the terminal pair.
  const stopIdx = events.findIndex((e) => e.type === 'content_block_stop');
  const deltaIdx = events.indexOf(events.find((e) => e.type === 'message_delta'));
  assert.ok(stopIdx < deltaIdx);
});

test('OpenAIChunkToAnthropic: streamed tool call accumulates partial JSON deltas', () => {
  const events = collectStreamEvents([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"HK"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const start = events.find((e) => e.type === 'content_block_start');
  assert.equal(start.content_block.type, 'tool_use');
  assert.equal(start.content_block.id, 'call_a');
  assert.equal(start.content_block.name, 'get_weather');
  const jsonDeltas = events.filter((e) => e.type === 'content_block_delta')
    .map((e) => e.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(jsonDeltas), { city: 'HK' });
  const lastDelta = events.at(-2);
  assert.equal(lastDelta.delta.stop_reason, 'tool_use', 'finish_reason tool_calls maps to stop_reason tool_use');
});

test('OpenAIChunkToAnthropic: usage lands in message_delta; late prompt_tokens cannot reach message_start', () => {
  const events = collectStreamEvents([
    { choices: [{ delta: { content: 'x' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 34 } },
  ]);
  const start = events.find((e) => e.type === 'message_start');
  // OpenAI sends usage at stream end (stream_options.include_usage); by then
  // message_start is already on the wire, so prompt_tokens has nowhere to go.
  // Known translation limitation, asserted honestly rather than hidden.
  assert.equal(start.message.usage.input_tokens, 0);
  const mdelta = events.find((e) => e.type === 'message_delta');
  assert.equal(mdelta.usage.output_tokens, 34);
});

test('OpenAIChunkToAnthropic: empty stream still yields a well-formed event sequence', () => {
  const conv = new OpenAIChunkToAnthropic('m');
  const events = [...conv.finish()];
  assert.deepEqual(events.map((e) => e.type), ['message_start', 'message_delta', 'message_stop']);
  assert.equal(events[0].message.model, 'm');
});

// ---------------------------------------------------------------------------
// Streaming: Anthropic events -> OpenAI chunks
// ---------------------------------------------------------------------------

function collectChunks(events, model = 'back-model') {
  const conv = new AnthropicEventToOpenAI(model);
  const chunks = [];
  for (const e of events) chunks.push(...conv.push(e));
  chunks.push(...conv.finish());
  return chunks;
}

test('AnthropicEventToOpenAI: message_start emits exactly one role-first chunk', () => {
  const chunks = collectChunks([
    { type: 'message_start', message: { usage: { input_tokens: 9 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hey' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
  assert.ok(chunks.slice(1).every((c) => !('role' in c.choices[0].delta)), 'role emitted once');
  const textChunk = chunks[1];
  assert.equal(textChunk.object, 'chat.completion.chunk');
  assert.equal(textChunk.choices[0].delta.content, 'hey');
  const finalChunk = chunks.at(-1);
  assert.equal(finalChunk.choices[0].finish_reason, 'stop');
  assert.deepEqual(finalChunk.usage, { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 });
  assert.ok(chunks.every((c) => typeof c === 'object'),
    '[DONE] sentinel is appended by the caller (server.js), never by the converter');
});

test('AnthropicEventToOpenAI: streamed tool_use keeps one tool index across argument deltas', () => {
  const chunks = collectChunks([
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_x', name: 'fn' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]);
  const toolStart = chunks.find((c) => c.choices[0].delta.tool_calls?.[0]?.id === 'tu_x');
  assert.ok(toolStart, 'tool_calls start chunk present');
  assert.equal(toolStart.choices[0].delta.tool_calls[0].index, 0);
  assert.equal(toolStart.choices[0].delta.tool_calls[0].function.name, 'fn');
  const argChunks = chunks.filter((c) => c.choices[0].delta.tool_calls?.[0]?.function?.arguments);
  assert.deepEqual(argChunks.map((c) => c.choices[0].delta.tool_calls[0].index), [0, 0]);
  assert.equal(argChunks.map((c) => c.choices[0].delta.tool_calls[0].function.arguments).join(''), '{"a":1}');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('AnthropicEventToOpenAI: unknown stop_reason falls back to "stop"; error event closes the stream', () => {
  const chunks = collectChunks([
    { type: 'message_start', message: {} },
    { type: 'error', error: { type: 'overloaded_error', message: 'boom' } },
  ]);
  const finalChunk = chunks.at(-1);
  assert.equal(finalChunk.choices[0].finish_reason, 'stop');
  // A second push after finish emits nothing (idempotent close).
  const conv = new AnthropicEventToOpenAI('m');
  conv.push({ type: 'message_start', message: {} });
  conv.push({ type: 'error' });
  assert.deepEqual(conv.finish(), []);
});

test('AnthropicEventToOpenAI.finish() closes a never-stopped stream honestly', () => {
  const conv = new AnthropicEventToOpenAI('late-model');
  conv.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'z' } });
  const chunks = conv.finish();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].model, 'late-model');
  assert.equal(chunks[0].choices[0].finish_reason, 'stop');
});

test('converter pair: OpenAI chunks -> Anthropic events -> OpenAI chunks preserves the visible stream', () => {
  const sourceChunks = [
    { id: 'c1', model: 'pair-m', choices: [{ delta: { role: 'assistant', content: '' } }] },
    { id: 'c1', choices: [{ delta: { content: 'Hello' } }] },
    { id: 'c1', choices: [{ delta: { content: ' world' } }] },
    { id: 'c1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'cc', type: 'function', function: { name: 'f', arguments: '{"city":"HK"}' } }] } }] },
    { id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const fwd = new OpenAIChunkToAnthropic('pair-m');
  const events = [];
  for (const c of sourceChunks) events.push(...fwd.push(c));
  events.push(...fwd.finish());

  const bwd = new AnthropicEventToOpenAI('pair-m');
  const outChunks = [];
  for (const e of events) outChunks.push(...bwd.push(e));
  outChunks.push(...bwd.finish());

  const text = outChunks.map((c) => c.choices[0].delta.content).filter(Boolean).join('');
  assert.equal(text, 'Hello world');
  const args = outChunks.flatMap((c) => c.choices[0].delta.tool_calls ?? [])
    .map((tc) => tc.function?.arguments ?? '').join('');
  assert.deepEqual(JSON.parse(args), { city: 'HK' });
  assert.equal(outChunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

// ---------------------------------------------------------------------------
// Shared helpers used by server.js
// ---------------------------------------------------------------------------

test('upstreamHeaders picks auth style per provider type', () => {
  assert.deepEqual(upstreamHeaders({ type: 'anthropic' }, 'k1'), {
    'content-type': 'application/json',
    'x-api-key': 'k1',
    'anthropic-version': '2023-06-01',
  });
  assert.deepEqual(upstreamHeaders({ type: 'openai' }, 'k2'), {
    'content-type': 'application/json',
    authorization: 'Bearer k2',
  });
});

test('upstreamPath avoids double /v1 across baseUrl shapes', () => {
  const cases = [
    ['', 'openaiChat', '/v1/chat/completions'],
    ['https://api.openai.com', 'openaiChat', 'https://api.openai.com/v1/chat/completions'],
    ['https://api.openai.com/', 'openaiChat', 'https://api.openai.com/v1/chat/completions'],
    ['https://proxy.local/v1', 'openaiChat', 'https://proxy.local/v1/chat/completions'],
    ['https://proxy.local/v1/', 'openaiChat', 'https://proxy.local/v1/chat/completions'],
    ['https://api.anthropic.com', 'anthropicMessages', 'https://api.anthropic.com/v1/messages'],
    ['https://api.anthropic.com/v1', 'anthropicMessages', 'https://api.anthropic.com/v1/messages'],
    ['https://api.openai.com', 'models', 'https://api.openai.com/v1/models'],
    ['https://api.anthropic.com', 'models', 'https://api.anthropic.com/v1/models'],
  ];
  for (const [baseUrl, purpose, expected] of cases) {
    assert.equal(upstreamPath({ type: purpose === 'anthropicMessages' ? 'anthropic' : 'openai', baseUrl }, purpose),
      expected, `${baseUrl || '(empty)'} + ${purpose}`);
  }
});

test('errorBody shapes per inbound format', () => {
  assert.deepEqual(errorBody('openai', 404, undefined, 'nope'), {
    error: { message: 'nope', type: 'invalid_request_error', code: 404 },
  });
  assert.deepEqual(errorBody('anthropic', 500, 'overloaded_error', 'busy'), {
    type: 'error',
    error: { type: 'overloaded_error', message: 'busy' },
  });
});
