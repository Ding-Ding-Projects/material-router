// Purpose: pure client-snippet generators for the API Builder tab. Every
// generator targets the LOCAL router (loopback host:port) so what a user
// copies is exactly what external clients run. Secrets never appear in a
// snippet: credentials are referenced through environment-variable names,
// because real keys live only in the app's encrypted vault.
// Owned by Builder lane.

export const SNIPPET_LANGUAGES = Object.freeze([
  { key: 'curl', label: 'cURL (shell)' },
  { key: 'js_fetch', label: 'JavaScript — fetch()' },
  { key: 'py_requests', label: 'Python — requests' },
  { key: 'ts_anthropic_sdk', label: 'TypeScript — Anthropic SDK' },
  { key: 'js_openai_sdk', label: 'JavaScript — OpenAI SDK' },
]);

const TOKEN_VAR = 'MATERIAL_ROUTER_TOKEN';

function baseUrl({ host, port }) {
  return `http://${host || '127.0.0.1'}:${port || 8787}`;
}

function jsonPretty(value) {
  return JSON.stringify(value, null, 2);
}

/** Single-line JSON for curl -d, safe inside single quotes. */
function shellQuoted(value) {
  return JSON.stringify(value).replace(/'/g, `'\\''`);
}

/**
 * Generate a snippet.
 *
 * Each generator is bound to the wire format its client actually speaks:
 *   curl / fetch / requests follow the SELECTED endpoint, posting whichever
 *   body matches it; the Anthropic-SDK and OpenAI-SDK snippets always speak
 *   their own format against the router regardless of the selected endpoint.
 *
 * @param {string} lang one of SNIPPET_LANGUAGES keys
 * @param {{endpoint:'openai'|'anthropic', openaiBody:object, anthropicBody?:object}} req
 *        anthropicBody is the translator output when known; generators fall
 *        back to an honest note rather than guessing when absent.
 * @param {{host:string,port:number,authRequired:boolean}} server
 */
export function generateSnippet(lang, req, server) {
  const wantsAnthropic = req.endpoint === 'anthropic';
  const path = wantsAnthropic ? '/v1/messages' : '/v1/chat/completions';
  const url = `${baseUrl(server)}${path}`;

  switch (lang) {
    case 'curl': {
      const body = wantsAnthropic ? req.anthropicBody : req.openaiBody;
      if (!body) return missingBodyNote();
      const authHeader = server.authRequired
        ? `\n  -H "Authorization: Bearer $${TOKEN_VAR}" \\`
        : '';
      const authNote = server.authRequired
        ? `# The router requires a bearer token; export ${TOKEN_VAR} first.\n`
        : '';
      return `${authNote}curl ${url} \\
  -H "Content-Type: application/json" \\${authHeader}
  -d '${shellQuoted(body)}'`;
    }
    case 'js_fetch':
      return jsFetch(url, wantsAnthropic ? req.anthropicBody : req.openaiBody, server);
    case 'py_requests':
      return pyRequests(url, wantsAnthropic ? req.anthropicBody : req.openaiBody, server);
    case 'ts_anthropic_sdk':
      return tsAnthropicSdk(baseUrl(server), req.anthropicBody, server);
    case 'js_openai_sdk':
      return jsOpenAiSdk(baseUrl(server), req.openaiBody ?? {}, server);
    default:
      return `# unsupported language "${lang}"`;
  }
}

function missingBodyNote() {
  return '# The translated request body is not generated yet.\n'
    + '# Change any control in the builder so the preview refreshes,\n'
    + '# then copy this snippet again.';
}

function jsFetch(url, body, server) {
  if (!body) return missingBodyNote();
  const headers = ['    "Content-Type": "application/json",'];
  if (server.authRequired) {
    headers.push(`    "Authorization": \`Bearer \${process.env.${TOKEN_VAR}}\`,`);
  }
  return `const res = await fetch(${JSON.stringify(url)}, {
  method: "POST",
  headers: {
${headers.join('\n')}
  },
  body: JSON.stringify(${jsonPretty(body)}),
});
console.log(JSON.stringify(await res.json(), null, 2));`;
}

function pyRequests(url, body, server) {
  if (!body) return missingPyNote();
  const headerLines = server.authRequired
    ? `    "Authorization": f"Bearer {os.environ[${JSON.stringify(TOKEN_VAR)}]}",\n`
    : '';
  return `import os
import requests

resp = requests.post(
    ${JSON.stringify(url)},
    headers={
${headerLines}    },
    json=${pyLiteral(body, 1)},
)
print(resp.json())`;
}

function missingPyNote() {
  return '# The translated request body is not generated yet.\n'
    + '# Change any control in the builder so the preview refreshes,\n'
    + '# then copy this snippet again.';
}

/** Render a JS value as a Python literal (True/False/None, dict/list). */
function pyLiteral(value, indent) {
  const pad = '    '.repeat(indent);
  const padInner = '    '.repeat(indent + 1);
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => `${padInner}${pyLiteral(v, indent + 1)},`).join('\n');
    return `[\n${items}\n${pad}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  const items = entries.map(([k, v]) => `${padInner}${JSON.stringify(k)}: ${pyLiteral(v, indent + 1)},`).join('\n');
  return `{\n${items}\n${pad}}`;
}

function tsAnthropicSdk(base, anthropicBody, server) {
  const body = anthropicBody;
  if (!body) {
    return `// The translated Anthropic-format body is not available yet.\n// Open the builder's preview once so the translation is generated,\n// then copy this snippet again.`;
  }
  const args = { ...body };
  const stream = Boolean(args.stream);
  delete args.stream;
  // The SDK constructor demands a credential-shaped value; the router only
  // checks it as a bearer token when auth is switched on. The real upstream
  // provider key never leaves the router's encrypted vault.
  const tokenLine = server.authRequired
    ? `  apiKey: process.env.${TOKEN_VAR} ?? "",`
    : `  apiKey: process.env.${TOKEN_VAR} ?? "local-router",`;
  if (!stream) {
    return `import Anthropic from "@anthropic-ai/sdk";

// Point the SDK at the local router. The upstream provider key stays in the
// router's encrypted vault; this process only ever holds the router token.
const client = new Anthropic({
  baseURL: ${JSON.stringify(base)},
${tokenLine}
});

const message = await client.messages.create(${jsonPretty(args)});
console.log(JSON.stringify(message, null, 2));`;
  }
  return `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: ${JSON.stringify(base)},
${tokenLine}
});

const stream = client.messages.stream({
${Object.entries(args).map(([k, v]) => `  ${k}: ${jsonInline(v)},`).join('\n')}
});
for await (const event of stream) {
  if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
    process.stdout.write(event.delta.text);
  }
}
process.stdout.write("\\n");`;
}

function jsOpenAiSdk(base, openaiBody, server) {
  const args = { ...(openaiBody ?? {}) };
  delete args.stream;
  const wantsStream = Boolean(openaiBody?.stream);
  const tokenArg = `  apiKey: process.env.${TOKEN_VAR} ?? "local-router", // bearer token when auth is on\n`;
  if (!wantsStream) {
    return `import OpenAI from "openai";

// Point the SDK at the local router. Upstream provider keys stay in the
// router's encrypted vault; this process only ever holds the router token.
const client = new OpenAI({
  baseURL: ${JSON.stringify(`${base}/v1`)},
${tokenArg}
});

const completion = await client.chat.completions.create(${jsonPretty(args)});
console.log(JSON.stringify(completion, null, 2));`;
  }
  return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: ${JSON.stringify(`${base}/v1`)},
${tokenArg}
});

const stream = await client.chat.completions.create({
${Object.entries(args).map(([k, v]) => `  ${k}: ${jsonInline(v)},`).join('\n')}
  stream: true,
});
for await (const chunk of stream) {
  const delta = chunk.choices?.[0]?.delta?.content;
  if (delta) process.stdout.write(delta);
}
process.stdout.write("\\n");`;
}

function jsonInline(value) {
  return JSON.stringify(value);
}

/** File extension matching each language, used by the export action. */
export function snippetFilename(lang) {
  switch (lang) {
    case 'curl': return `router-request-${Date.now()}.sh`;
    case 'js_fetch': return `router-request-${Date.now()}.js`;
    case 'py_requests': return `router_request_${Date.now()}.py`;
    case 'ts_anthropic_sdk': return `router-request-${Date.now()}.ts`;
    case 'js_openai_sdk': return `router-request-${Date.now()}.mjs`;
    default: return `router-request-${Date.now()}.txt`;
  }
}
