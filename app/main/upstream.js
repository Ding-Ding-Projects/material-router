// Purpose: outbound calls to upstream AI providers. Deadlines REJECT (they
// abort the fetch, they never leave a promise pending), provider errors are
// normalized into {status,type,message}, and SSE bodies are parsed into data
// payload strings for pass-through or translation.
// Owned by Foundation Core lane.

export class UpstreamError extends Error {
  constructor(status, type, message) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.type = type;
  }
}

export class DeadlineError extends Error {
  constructor(ms) {
    super(`upstream request exceeded its ${ms}ms deadline`);
    this.name = 'DeadlineError';
    this.status = 504;
    this.type = 'timeout';
  }
}

// Callers build the endpoint URL via translator.upstreamPath(provider, purpose).

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // upstream response accumulation cap

/**
 * Call an upstream provider.
 *
 * @param {object} provider provider config {type,baseUrl,...}
 * @param {string} apiKey decrypted API key
 * @param {string} url fully-qualified endpoint URL
 * @param {object} body JSON-serializable upstream request
 * @param {object} opts {stream:boolean, timeoutMs:number, signal:AbortSignal}
 * @returns {Promise<{status:number, headers:Object, json:Function, sse:AsyncGenerator<string>|null, bytes:()=>number}>}
 */
export async function callUpstream(provider, apiKey, url, body, {
  stream = false,
  timeoutMs = 120_000,
  signal = null,
  headers = null,
} = {}) {
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort(new DOMException('client disconnected', 'AbortError'));
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers ?? defaultHeaders(provider, apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onExternalAbort);
    if (timedOut) throw new DeadlineError(timeoutMs);
    if (err?.name === 'AbortError') {
      throw new UpstreamError(499, 'aborted', 'request aborted before completion');
    }
    throw new UpstreamError(502, 'connection_error', `could not reach upstream (${err?.cause?.code || err?.message || 'network error'})`);
  }
  // The deadline keeps running through body consumption; cleared in release().

  const state = { received: 0 };

  async function readAllLimited(resBody) {
    const reader = resBody.getReader();
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        state.received += value.byteLength;
        if (state.received > MAX_RESPONSE_BYTES) {
          throw new UpstreamError(502, 'response_too_large', 'upstream response exceeded the 32MB safety cap');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks);
  }

  async function* ssePayloads(resBody) {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const reader = resBody.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        state.received += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line.
        let sep;
        while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + (buffer[sep] === '\r' ? 4 : 2));
          const data = parseSseData(rawEvent);
          if (data !== null) yield data;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const data = parseSseData(buffer);
        if (data !== null) yield data;
      }
    } finally {
      reader.releaseLock?.();
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  function release() {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onExternalAbort);
  }

  if (!res.ok) {
    let text = '';
    try {
      const buf = await readAllLimited(res.body);
      text = buf.toString('utf8');
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      if (timedOut) throw new DeadlineError(timeoutMs);
      throw new UpstreamError(502, 'read_error', 'failed reading upstream error body');
    } finally {
      release();
    }
    throw normalizeUpstreamError(res.status, text);
  }

  if (!stream || !res.body) {
    let buf;
    try {
      buf = await readAllLimited(res.body);
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      if (timedOut) throw new DeadlineError(timeoutMs);
      throw new UpstreamError(502, 'read_error', 'failed reading upstream response');
    } finally {
      release();
    }
    const text = buf.toString('utf8');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new UpstreamError(502, 'bad_gateway', 'upstream returned non-JSON body');
    }
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      ok: true,
      json: () => json,
      sse: null,
      get bytes() { return state.received; },
    };
  }

  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    ok: true,
    json: () => { throw new Error('streaming response has no JSON body'); },
    sse: ssePayloads(res.body),
    get bytes() { return state.received; },
  };
}

/** GET a provider's model list. Same deadline semantics as callUpstream. */
export async function fetchModelList(provider, apiKey, url, { timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: defaultHeaders(provider, apiKey),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (timedOut) throw new DeadlineError(timeoutMs);
    throw new UpstreamError(502, 'connection_error', `could not reach upstream (${err?.message || 'network error'})`);
  }
  clearTimeout(timer);
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch { /* empty */ }
    throw normalizeUpstreamError(res.status, text.slice(0, 2000));
  }
  try {
    return await res.json();
  } catch {
    throw new UpstreamError(502, 'bad_gateway', 'model list response was not JSON');
  }
}

function defaultHeaders(provider, apiKey) {
  const base = { 'content-type': 'application/json' };
  if (!apiKey) return base;
  if (provider.type === 'anthropic') {
    return { ...base, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { ...base, authorization: `Bearer ${apiKey}` };
}

/** Extract "data:" payload strings from one raw SSE event block. */
function parseSseData(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    // event:/id:/retry: fields are irrelevant for our consumers.
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

/** Normalize any upstream failure body into {status,type,message<=200chars}. */
export function normalizeUpstreamError(status, bodyText) {
  let type = 'upstream_error';
  let message = '';
  try {
    const parsed = JSON.parse(bodyText);
    const cand = parsed?.error ?? parsed;
    if (typeof cand === 'object' && cand !== null) {
      message = String(cand.message ?? '');
      if (cand.type) type = String(cand.type);
    } else if (typeof cand === 'string') {
      message = cand;
    }
  } catch {
    message = bodyText.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  if (!message) message = `HTTP ${status}`;
  if (status === 401 || status === 403) type = 'authentication_error';
  else if (status === 429) type = 'rate_limit_error';
  else if (status >= 500) type = type === 'upstream_error' ? 'api_error' : type;
  // Redact anything that looks like credential material defensively.
  message = redactSecretLike(message).slice(0, 200);
  return new UpstreamError(status, type, message);
}

function redactSecretLike(s) {
  return s
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***');
}
