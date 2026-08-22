// Purpose: the local AI router. Serves OpenAI- and Anthropic-compatible
// endpoints on loopback, resolves routing rules against provider configs,
// translates wire formats both directions (including SSE streams), enforces
// body limits and rejecting deadlines, aborts upstreams on client disconnect,
// and emits redacted structured log events.
// Foundation seam: Server lane owns the GUI around these exact behaviors;
// keep route paths, settings keys and log-event shape stable.
// Owned by Foundation Core lane.

import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  openaiToAnthropicRequest,
  anthropicToOpenaiRequest,
  anthropicToOpenaiResponse,
  openaiToAnthropicResponse,
  AnthropicEventToOpenAI,
  OpenAIChunkToAnthropic,
  upstreamPath,
  upstreamHeaders,
  errorBody,
} from './translator.js';
import { callUpstream, UpstreamError } from './upstream.js';

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

let requestCounter = 0;

export class LocalRouterServer extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('./providers-store.js').ProvidersStore} deps.providersStore
   * @param {(keyRef:string)=>string|null} deps.getSecret
   * @param {{get:(key:string,fallback?:any)=>any}} deps.settings JSONStore
   */
  constructor({ providersStore, getSecret, settings }) {
    super();
    this.providersStore = providersStore;
    this.getSecret = getSecret;
    this.settings = settings;
    this.httpServer = null;
    this.startedAt = null;
    this.requestsServed = 0;
  }

  // -- configuration ----------------------------------------------------------

  config() {
    return {
      enabled: this.settings.get('server.enabled', true),
      port: Number(this.settings.get('server.port', 8787)),
      host: String(this.settings.get('server.host', '127.0.0.1')),
      corsEnabled: Boolean(this.settings.get('server.corsEnabled', false)),
      corsAllowOrigin: String(this.settings.get('server.corsAllowOrigin', '*')),
      authRequired: Boolean(this.settings.get('server.authRequired', false)),
      timeoutMs: Number(this.settings.get('server.requestTimeoutMs', 120_000)) || 120_000,
      maxBodyBytes: Number(this.settings.get('server.maxBodyBytes', DEFAULT_MAX_BODY_BYTES)) || DEFAULT_MAX_BODY_BYTES,
    };
  }

  get isRunning() {
    return this.httpServer !== null && this.httpServer.listening;
  }

  getStatus() {
    const cfg = this.config();
    return {
      running: this.isRunning,
      enabled: cfg.enabled,
      port: cfg.port,
      host: cfg.host,
      corsEnabled: cfg.corsEnabled,
      authRequired: cfg.authRequired,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      requestsServed: this.requestsServed,
      providers: this.providersStore.listProviders().filter((p) => p.enabled).length,
      routes: this.providersStore.listRules().length,
    };
  }

  // -- lifecycle --------------------------------------------------------------

  start() {
    if (this.isRunning) return this.getStatus();
    const cfg = this.config();
    const server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        this._log({ kind: 'error', endpoint: req.url, status: 500, error: err });
        if (!res.headersSent) {
          this._sendError(res, 'openai', 500, 'internal_error', 'internal server error');
        } else {
          res.end();
        }
      });
    });
    server.on('clientError', (_err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        this.startedAt = Date.now();
        this._log({ kind: 'status', endpoint: 'listen', detail: `${cfg.host}:${cfg.port}` });
        resolve(this.getStatus());
      };
      server.once('error', onError);
      server.listen(cfg.port, cfg.host, onListening);
      this.httpServer = server;
    });
  }

  async stop() {
    const server = this.httpServer;
    if (!server) return;
    this.httpServer = null;
    this.startedAt = null;
    await new Promise((resolve) => server.close(() => resolve()));
    this._log({ kind: 'status', endpoint: 'stopped', detail: '' });
  }

  // -- logging ----------------------------------------------------------------

  /** Emit one redacted structured log event. Never include keys or full bodies. */
  _log(ev) {
    const event = {
      ts: new Date().toISOString(),
      id: ev.id ?? null,
      kind: ev.kind ?? 'info',
      direction: ev.direction ?? null,
      model: ev.model ?? null,
      provider: ev.provider ?? null,
      endpoint: ev.endpoint ?? null,
      ms: typeof ev.ms === 'number' ? Math.round(ev.ms) : null,
      bytes: typeof ev.bytes === 'number' ? ev.bytes : null,
      status: typeof ev.status === 'number' ? ev.status : null,
      detail: ev.detail ? String(ev.detail).slice(0, 200) : null,
      error: ev.error ? String(ev.error?.message || ev.error).replace(/\s+/g, ' ').slice(0, 200) : null,
    };
    this.emit('log', event);
  }

  // -- request plumbing ---------------------------------------------------------

  async _handleRequest(req, res) {
    const started = Date.now();
    const id = `req_${++requestCounter}_${crypto.randomBytes(3).toString('hex')}`;
    const cfg = this.config();

    if (req.method === 'OPTIONS') {
      this._handlePreflight(req, res, cfg);
      return;
    }

    const urlPath = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

    if (urlPath === '/health' && req.method === 'GET') {
      this._json(res, 200, {
        ok: true,
        service: 'material-router',
        version: '0.1.0',
        uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      });
      return;
    }

    const isModelsList = urlPath === '/v1/models' && req.method === 'GET';
    const modelsMatch = /^\/v1\/models\/([^/]+)$/.exec(urlPath);
    const isModelItem = modelsMatch && req.method === 'GET';

    if (!isModelsList && !isModelItem && !(
      (urlPath === '/v1/chat/completions' || urlPath === '/v1/messages') && req.method === 'POST'
    )) {
      this._sendError(res, 'openai', 404, 'not_found_error', `no route for ${req.method} ${urlPath}`);
      return;
    }

    // Bearer auth applies to every /v1 route (health stays open).
    if (urlPath.startsWith('/v1')) {
      const authResult = this._checkAuth(req, cfg);
      if (!authResult.ok) {
        this._sendError(res, 'openai', authResult.status, 'authentication_error', authResult.message);
        this._log({ kind: 'auth', id, endpoint: urlPath, status: authResult.status, error: authResult.message });
        return;
      }
    }

    if (isModelsList) return this._handleModels(res, cfg, started);
    if (isModelItem) return this._handleModelItem(res, decodeURIComponent(modelsMatch[1]));

    const inboundFormat = urlPath === '/v1/messages' ? 'anthropic' : 'openai';
    await this._handleCompletion(req, res, cfg, { id, started, inboundFormat });
  }

  _checkAuth(req, cfg) {
    if (!cfg.authRequired) return { ok: true };
    const expected = this.getSecret('routerToken');
    if (!expected) {
      return { ok: false, status: 503, message: 'bearer auth is required but no router token is configured' };
    }
    const header = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m || !safeEqual(m[1], expected)) {
      return { ok: false, status: 401, message: 'missing or invalid bearer token' };
    }
    return { ok: true };
  }

  _handlePreflight(req, res, cfg) {
    if (!cfg.corsEnabled) {
      res.writeHead(204, { 'access-control-max-age': '0' });
      res.end();
      return;
    }
    res.writeHead(204, {
      'access-control-allow-origin': cfg.corsAllowOrigin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
    res.end();
  }

  _corsHeaders(cfg) {
    if (!cfg.corsEnabled) return {};
    return { 'access-control-allow-origin': cfg.corsAllowOrigin, vary: 'Origin' };
  }

  _json(res, status, obj, extraHeaders = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...extraHeaders,
    });
    res.end(body);
  }

  _sendError(res, format, status, type, message) {
    this._json(res, status, errorBody(format, status, type, message));
  }

  // -- models endpoints ---------------------------------------------------------

  _handleModels(res, cfg, started) {
    const data = [];
    for (const provider of this.providersStore.listProviders()) {
      if (!provider.enabled) continue;
      const cached = this.providersStore.getCachedModels(provider.id);
      if (!cached) {
        // Refresh stale caches in the background; serve what exists now.
        this.providersStore.refreshModels(provider.id, (ref) => this.getSecret(ref))
          .then(() => this._log({ kind: 'models_refreshed', provider: provider.name }))
          .catch((err) => this._log({ kind: 'models_refresh_failed', provider: provider.name, error: err }));
        continue;
      }
      for (const m of cached) {
        data.push({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: m.owned_by || provider.name,
          material_router_provider: provider.id,
        });
      }
    }
    this.requestsServed += 1;
    this._log({
      kind: 'request', id: 'models', direction: 'inbound', endpoint: '/v1/models',
      ms: Date.now() - started, status: 200, bytes: data.length,
    });
    this._json(res, 200, { object: 'list', data }, this._corsHeaders(cfg));
  }

  _handleModelItem(res, modelId) {
    for (const provider of this.providersStore.listProviders()) {
      if (!provider.enabled) continue;
      const cached = this.providersStore.getCachedModels(provider.id);
      if (!cached) continue;
      const found = cached.find((m) => m.id === modelId);
      if (found) {
        this._json(res, 200, {
          id: found.id,
          object: 'model',
          created: 0,
          owned_by: found.owned_by || provider.name,
          material_router_provider: provider.id,
        });
        return;
      }
    }
    this._sendError(res, 'openai', 404, 'not_found_error', `model "${modelId}" not found`);
  }

  // -- completions ----------------------------------------------------------------

  async _handleCompletion(req, res, cfg, ctx) {
    const { id, started, inboundFormat } = ctx;
    const abortController = new AbortController();
    let clientGone = false;
    req.on('error', () => {});
    req.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        abortController.abort(new DOMException('client disconnected', 'AbortError'));
      }
    });

    let bodyText;
    try {
      bodyText = await readBody(req, cfg.maxBodyBytes);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        this._sendError(res, inboundFormat, 413, 'request_too_large',
          `request body exceeded the ${Math.floor(cfg.maxBodyBytes / 1024 / 1024)}MB limit`);
        return;
      }
      this._sendError(res, inboundFormat, 400, 'invalid_request_error', 'failed reading request body');
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(bodyText.length ? bodyText.toString('utf8') : '{}');
    } catch {
      this._sendError(res, inboundFormat, 400, 'invalid_request_error', 'request body was not valid JSON');
      return;
    }

    const model = typeof parsed?.model === 'string' ? parsed.model : '';
    const route = this.providersStore.resolveRoute(model);
    if (!route) {
      this._sendError(res, inboundFormat, 404, 'not_found_error',
        `no provider matched model "${model || '(none)'}" and no fallback provider is configured`);
      this._log({ kind: 'no_route', id, model, endpoint: req.url, status: 404 });
      return;
    }
    const { provider, rule } = route;
    const targetFormat = provider.type === 'anthropic' ? 'anthropic' : 'openai';

    this.requestsServed += 1;
    this._log({
      kind: 'route', id, direction: 'inbound', model, provider: provider.name,
      endpoint: req.url,
      detail: rule ? `${rule.matchType}:${rule.pattern}` : 'fallback-provider',
    });

    // Translate the inbound request into the upstream's wire format.
    let upstreamReq = parsed;
    try {
      if (inboundFormat !== targetFormat) {
        if (inboundFormat === 'openai') {
          const t = openaiToAnthropicRequest(parsed);
          upstreamReq = t.req;
          for (const n of t.notes) this._log({ kind: 'note', id, model, provider: provider.name, detail: n.message });
        } else {
          const t = anthropicToOpenaiRequest(parsed);
          upstreamReq = t.req;
          for (const n of t.notes) this._log({ kind: 'note', id, model, provider: provider.name, detail: n.message });
        }
      }
      if (!upstreamReq.model) upstreamReq.model = provider.defaultModel || undefined;
    } catch (err) {
      this._sendError(res, inboundFormat, 400, 'invalid_request_error', err.message);
      this._log({ kind: 'translate_error', id, model, provider: provider.name, status: 400, error: err });
      return;
    }

    const apiKey = provider.keyRef ? (this.getSecret(provider.keyRef) || '') : '';
    const url = upstreamPath(provider, provider.type === 'anthropic' ? 'messages' : 'chat');
    const wantsStream = Boolean(upstreamReq.stream);

    let upstream;
    try {
      upstream = await callUpstream(provider, apiKey, url, upstreamReq, {
        stream: wantsStream,
        timeoutMs: cfg.timeoutMs,
        signal: abortController.signal,
        headers: upstreamHeaders(provider, apiKey),
      });
    } catch (err) {
      const mapped = mapUpstreamFailure(err, inboundFormat, clientGone);
      if (!mapped.ignore) {
        this._sendRawError(res, inboundFormat, mapped.status, mapped.type, mapped.message);
      }
      this._log({
        kind: 'upstream_error', id, direction: 'outbound', model, provider: provider.name,
        status: err?.status ?? 0, error: err,
      });
      return;
    }

    this._log({
      kind: 'upstream', id, direction: 'outbound', model, provider: provider.name,
      status: upstream.status, bytes: upstream.bytes,
    });

    if (wantsStream) {
      await this._pipeStream({ res, upstream, inboundFormat, targetFormat, model, provider, id, cfg, abortController });
    } else {
      const ms = Date.now() - started;
      const json = upstream.json();
      let outJson = json;
      if (inboundFormat !== targetFormat) {
        outJson = inboundFormat === 'openai'
          ? anthropicToOpenaiResponse(json, model)
          : openaiToAnthropicResponse(json, model);
      }
      this._log({
        kind: 'response', id, direction: 'inbound', model, provider: provider.name,
        ms, status: upstream.status, bytes: upstream.bytes,
      });
      this._json(res, upstream.status, outJson, this._corsHeaders(cfg));
    }
  }

  async _pipeStream({ res, upstream, inboundFormat, targetFormat, model, provider, id, cfg }) {
    const started = Date.now();
    const headers = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...this._corsHeaders(cfg),
    };
    res.writeHead(200, headers);

    const writeEvent = (payloadStr) => {
      if (!res.writableEnded) res.write(`data: ${payloadStr}\n\n`);
    };

    try {
      if (inboundFormat === targetFormat) {
        // Pass-through: relay raw SSE payloads verbatim, translating nothing.
        let count = 0;
        for await (const payload of upstream.sse) {
          writeEvent(payload);
          count += 1;
          if (payload.trim() === '[DONE]') break;
        }
        if (inboundFormat === 'openai') {
          // Guarantee the sentinel even if upstream ended without one.
          writeEvent('[DONE]');
        }
        this._log({
          kind: 'response', id, direction: 'inbound', model, provider: provider.name,
          ms: Date.now() - started, bytes: upstream.bytes, status: upstream.status,
          detail: `passthrough ${count} events`,
        });
        res.end();
        return;
      }

      if (inboundFormat === 'anthropic' && targetFormat === 'openai') {
        const conv = new OpenAIChunkToAnthropic(model);
        let doneSent = false;
        for await (const payload of upstream.sse) {
          const trimmed = payload.trim();
          if (trimmed === '[DONE]') break;
          let chunk;
          try { chunk = JSON.parse(payload); } catch { continue; }
          for (const evt of conv.push(chunk)) {
            writeEvent(JSON.stringify(evt));
            doneSent = doneSent || evt.type === 'message_stop';
          }
        }
        if (!doneSent) {
          for (const evt of conv.finish()) writeEvent(JSON.stringify(evt));
        }
        this._log({
          kind: 'response', id, direction: 'inbound', model, provider: provider.name,
          ms: Date.now() - started, bytes: upstream.bytes, status: upstream.status,
          detail: 'openai->anthropic stream',
        });
        res.end();
        return;
      }

      // inboundFormat === 'openai' && targetFormat === 'anthropic'
      const conv = new AnthropicEventToOpenAI(model);
      let doneSent = false;
      for await (const payload of upstream.sse) {
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        for (const chunk of conv.push(evt)) {
          writeEvent(JSON.stringify(chunk));
          doneSent = doneSent || chunk.choices?.[0]?.finish_reason != null;
        }
      }
      if (!doneSent) {
        for (const chunk of conv.finish()) writeEvent(JSON.stringify(chunk));
      }
      writeEvent('[DONE]');
      this._log({
        kind: 'response', id, direction: 'inbound', model, provider: provider.name,
        ms: Date.now() - started, bytes: upstream.bytes, status: upstream.status,
        detail: 'anthropic->openai stream',
      });
      res.end();
    } catch (err) {
      // Deadline or network failure mid-stream: terminate the stream honestly
      // in the client's own protocol rather than leaving it hanging.
      this._log({ kind: 'stream_error', id, model, provider: provider.name, error: err });
      try {
        if (inboundFormat === 'anthropic' && !res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stream interrupted' } })}\n\n`);
          res.write('data: {"type":"message_stop"}\n\n');
        } else if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
        }
      } catch { /* socket already gone */ }
      res.end();
    }
  }
}

function mapUpstreamFailure(err, inboundFormat, clientGone) {
  if (clientGone) return { ignore: true };
  if (err instanceof UpstreamError) {
    return { ignore: false, status: clientStatus(err.status), type: err.type, message: err.message };
  }
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
    return { ignore: false, status: 499, type: 'aborted', message: 'request aborted' };
  }
  return {
    ignore: false,
    status: 502,
    type: inboundFormat === 'anthropic' ? 'api_error' : 'api_error',
    message: err?.message || 'upstream failure',
  };
}

function clientStatus(status) {
  // 499 is nginx-speak for client-closed; present it as 499 passthrough.
  return status >= 400 && status <= 599 ? status : 502;
}

async function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        const err = new Error('body too large');
        err.code = 'BODY_TOO_LARGE';
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Compare against self to keep timing uniform, then fail.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}
