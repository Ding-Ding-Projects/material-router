// Purpose: pure-core tests for app/main/upstream.js.
//
// callUpstream/fetchModelList have no fetch injection seam (they use the global
// fetch), so network behaviour is exercised against a real local http server on
// an ephemeral loopback port — builtin node:http only, no dependencies. That
// gives honest coverage of deadline rejection, client-abort handling, SSE event
// parsing across chunk boundaries and upstream error normalization.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  callUpstream,
  fetchModelList,
  normalizeUpstreamError,
  UpstreamError,
  DeadlineError,
} from '../app/main/upstream.js';

import { makeTempDir, rmRf, startHttpServer } from './helpers.mjs';

const tmpRoot = makeTempDir('upstream');
test.after(() => rmRf(tmpRoot));

const PROVIDER = { type: 'openai', baseUrl: 'unused-here' };
const BODY = { model: 'm', messages: [] };

/** A server that accepts the request and never responds. */
async function silentServer() {
  return startHttpServer(() => { /* hold the connection open */ });
}

// ---------------------------------------------------------------------------
// Error normalization (pure)
// ---------------------------------------------------------------------------

test('normalizeUpstreamError parses JSON bodies and maps status classes', () => {
  const e1 = normalizeUpstreamError(404, JSON.stringify({
    error: { message: 'model not found', type: 'invalid_request_error' },
  }));
  assert.ok(e1 instanceof UpstreamError);
  assert.equal(e1.status, 404);
  assert.equal(e1.type, 'invalid_request_error');
  assert.equal(e1.message, 'model not found');

  assert.equal(normalizeUpstreamError(401, '{}').type, 'authentication_error');
  assert.equal(normalizeUpstreamError(403, 'plain text body').type, 'authentication_error',
    '403 wins over whatever the body said');
  assert.equal(normalizeUpstreamError(429, 'slow down').type, 'rate_limit_error');

  const e500 = normalizeUpstreamError(502, JSON.stringify({ error: { type: 'overloaded', message: 'x' } }));
  assert.equal(e500.type, 'overloaded', 'a parsed type is preserved even for 5xx');
  assert.equal(normalizeUpstreamError(500, 'no json').type, 'api_error',
    '5xx without a parsed type becomes api_error');
});

test('normalizeUpstreamError redacts credential-looking material from messages', () => {
  const e = normalizeUpstreamError(400, JSON.stringify({
    error: {
      message: 'bad key sk-abcdefghijklmnop1234 provided via Bearer sk-zyxwvuts98765432 ok',
      type: 'invalid_request_error',
    },
  }));
  assert.ok(!e.message.includes('sk-abcdefghijklmnop1234'), `leaked: ${e.message}`);
  assert.ok(e.message.includes('sk-***'));
  assert.ok(!e.message.toLowerCase().includes('sk-zyxwvuts'), `bearer form leaked: ${e.message}`);

  const bearer = normalizeUpstreamError(500, 'Authorization: Bearer abcdefghijklmno was rejected');
  assert.ok(!bearer.message.includes('abcdefghijklmno'), `bearer token leaked: ${bearer.message}`);
  assert.ok(bearer.message.includes('Bearer ***'));
});

test('normalizeUpstreamError truncates long plain-text bodies and never returns empty messages', () => {
  const long = normalizeUpstreamError(500, 'x'.repeat(1000));
  assert.ok(long.message.length <= 200);

  const empty = normalizeUpstreamError(503, '   ');
  assert.equal(empty.message, 'HTTP 503');
});

test('error classes carry their documented identity fields', () => {
  const de = new DeadlineError(1234);
  assert.equal(de.name, 'DeadlineError');
  assert.equal(de.status, 504);
  assert.equal(de.type, 'timeout');
  assert.match(de.message, /1234ms deadline/);

  const ue = new UpstreamError(418, 'teapot', 'short and stout');
  assert.equal(ue.name, 'UpstreamError');
  assert.equal(ue.status, 418);
  assert.equal(ue.type, 'teapot');
});

// ---------------------------------------------------------------------------
// callUpstream: success paths
// ---------------------------------------------------------------------------

test('callUpstream: non-streaming JSON response returns parsed json + byte count', async () => {
  const payload = { answer: 42 };
  const fx = await startHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  try {
    const out = await callUpstream(PROVIDER, 'key', fx.url('/v1/chat/completions'), BODY);
    assert.equal(out.status, 200);
    assert.equal(out.sse, null);
    assert.deepEqual(out.json(), payload);
    assert.equal(out.bytes, Buffer.byteLength(JSON.stringify(payload)));
    assert.equal(out.headers['content-type'], 'application/json');
  } finally {
    await fx.close();
  }
});

test('callUpstream: non-JSON 2xx body fails honestly as bad_gateway', async () => {
  const fx = await startHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('<html>not json</html>');
  });
  try {
    await assert.rejects(
      () => callUpstream(PROVIDER, '', fx.url('/v1/x'), BODY),
      (err) => err instanceof UpstreamError && err.type === 'bad_gateway'
        && /non-JSON/.test(err.message),
    );
  } finally {
    await fx.close();
  }
});

test('callUpstream: streaming SSE payloads split correctly across TCP chunks', async () => {
  // Each write() below goes out as its own chunk; the parser must reassemble
  // events that straddle chunk boundaries.
  const writes = [
    'data: {"id":"1","choices":[{"delta":{"content":"He"}}]}\n\n',
    'data: {"id":"2","choices":[{"delta":{"content":"llo"}}]}',
    '\n\ndata: [DONE]\n\n',
    ': keep-alive comment with no data\n\n',
  ];
  const fx = await startHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => {
      if (i < writes.length) res.write(writes[i++]);
      else { clearInterval(timer); res.end(); }
    }, 15);
  });
  try {
    const out = await callUpstream(PROVIDER, '', fx.url('/v1/chat/completions'), BODY, { stream: true });
    assert.ok(out.sse, 'streaming request yields an sse generator');
    const payloads = [];
    for await (const p of out.sse) payloads.push(p);
    assert.deepEqual(payloads, [
      '{"id":"1","choices":[{"delta":{"content":"He"}}]}',
      '{"id":"2","choices":[{"delta":{"content":"llo"}}]}',
      '[DONE]',
    ], 'events reassembled in order; comment-only events skipped; DONE passed through');
    assert.ok(out.bytes > 0);
  } finally {
    await fx.close();
  }
});

test('callUpstream: multi-line data: fields join with newlines inside one event', async () => {
  const fx = await startHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: line-one\ndata: line-two\r\n\r\n');
    res.end();
  });
  try {
    const out = await callUpstream(PROVIDER, '', fx.url('/v1/chat/completions'), BODY, { stream: true });
    const payloads = [];
    for await (const p of out.sse) payloads.push(p);
    assert.deepEqual(payloads, ['line-one\nline-two']);
  } finally {
    await fx.close();
  }
});

test('callUpstream: upstream error status normalizes into a typed UpstreamError', async () => {
  const fx = await startHttpServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key sk-abcdefgh12345678', type: 'invalid_request_error' } }));
  });
  try {
    await assert.rejects(
      () => callUpstream(PROVIDER, 'wrong', fx.url('/v1/chat/completions'), BODY),
      (err) => err instanceof UpstreamError
        && err.status === 401
        && err.type === 'authentication_error'
        && !err.message.includes('sk-abcdefgh12345678')
        && err.message.includes('sk-***'),
    );
  } finally {
    await fx.close();
  }
});

// ---------------------------------------------------------------------------
// callUpstream: deadlines reject; they never hang
// ---------------------------------------------------------------------------

test('callUpstream: deadline aborts a silent upstream into DeadlineError', async () => {
  const fx = await silentServer();
  try {
    const started = Date.now();
    await assert.rejects(
      () => callUpstream(PROVIDER, '', fx.url('/v1/chat/completions'), BODY, { timeoutMs: 80 }),
      (err) => {
        assert.ok(err instanceof DeadlineError, `expected DeadlineError, got ${err?.name}: ${err?.message}`);
        assert.equal(err.status, 504);
        return true;
      },
    );
    const waited = Date.now() - started;
    assert.ok(waited < 5000, `deadline rejected promptly (${waited}ms), it did not hang`);
  } finally {
    await fx.close();
  }
});

test('fetchModelList: deadline also rejects on the GET path', async () => {
  const fx = await silentServer();
  try {
    await assert.rejects(
      () => fetchModelList(PROVIDER, '', fx.url('/v1/models'), { timeoutMs: 60 }),
      (err) => err instanceof DeadlineError && err.status === 504,
    );
  } finally {
    await fx.close();
  }
});

test('callUpstream: client disconnect aborts into a 499 UpstreamError', async () => {
  const fx = await silentServer();
  try {
    const external = new AbortController();
    const pending = callUpstream(PROVIDER, '', fx.url('/v1/chat/completions'), BODY, {
      timeoutMs: 30_000,
      signal: external.signal,
    });
    setTimeout(() => external.abort(), 40);
    await assert.rejects(
      () => pending,
      (err) => err instanceof UpstreamError
        && err.status === 499
        && err.type === 'aborted',
    );
  } finally {
    await fx.close();
  }
});

test('callUpstream: unreachable host maps to connection_error instead of throwing raw fetch errors', async () => {
  // Port 1 on loopback: nothing listens there; connection refused quickly.
  await assert.rejects(
    () => callUpstream(PROVIDER, '', 'http://127.0.0.1:1/v1/chat/completions', BODY, { timeoutMs: 3000 }),
    (err) => err instanceof UpstreamError && err.status === 502 && err.type === 'connection_error',
  );
});

test('fetchModelList: happy path returns parsed catalog JSON with provider auth headers', async () => {
  let seen = {};
  const fx = await startHttpServer((req, res) => {
    seen = { auth: req.headers.authorization || '', method: req.method };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'model-x' }] }));
  });
  try {
    const json = await fetchModelList(PROVIDER, 'k', fx.url('/v1/models'));
    assert.deepEqual(json, { data: [{ id: 'model-x' }] });
    assert.equal(seen.method, 'GET');
    assert.equal(seen.auth, 'Bearer k');
  } finally {
    await fx.close();
  }
});

test('fetchModelList: anthropic provider sends x-api-key + version headers; bad status normalizes', async () => {
  const ANTHROPIC = { type: 'anthropic', baseUrl: 'unused-here' };
  let seenHeaders = {};
  const fx = await startHttpServer((req, res) => {
    seenHeaders = req.headers;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('unauthorized');
  });
  try {
    await assert.rejects(
      () => fetchModelList(ANTHROPIC, 'k', fx.url('/v1/models')),
      (err) => err instanceof UpstreamError
        && err.status === 401
        && err.type === 'authentication_error',
    );
    assert.equal(seenHeaders['x-api-key'], 'k');
    assert.equal(seenHeaders['anthropic-version'], '2023-06-01');
  } finally {
    await fx.close();
  }
});
