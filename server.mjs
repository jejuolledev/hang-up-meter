import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClockedError } from './clocked.mjs';
import { createLiveAnalyzer } from './analysis.mjs';

const ROOT = new URL('./', import.meta.url);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ...['app.js', 'app.css', 'brandmark.png', 'font-manrope.ttf'].map(name => [`/${name}`, [name,
    name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8'
      : name.endsWith('.png') ? 'image/png' : 'font/ttf']]),
  ...['phone', 'pause', 'play', 'arrow-path', 'microphone', 'document-text', 'arrow-top-right-on-square',
    'information-circle', 'exclamation-triangle', 'chat-bubble-left-right', 'x-mark', 'check', 'chevron-down']
    .map(name => [`/icon-${name}.svg`, [`icon-${name}.svg`, 'image/svg+xml']]),
]);
const description = {
  payment: 'The caller is insisting on a potentially concerning payment method.',
  secrecy: 'The caller appears to be blocking independent verification.',
  credentials: 'The caller is asking for sensitive information or sign-in details.',
  remote_access: 'The caller appears to be requesting unsolicited remote access.',
  threats: 'The caller appears to be using a threat to force action.',
  stay_connected: 'The caller is restricting time away from the call during a transaction.',
};

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 96000) throw new ClockedError('INVALID_INPUT', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ClockedError('INVALID_INPUT', 400); }
}

// Behind Cloud Run every request arrives from the Google front end, so count
// visitors by the first X-Forwarded-For address and fall back to the socket.
function visitorKey(request) {
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim();
  return first && first.length <= 45 && isIP(first) ? first : request.socket.remoteAddress;
}

export function createHandler({ analyzeText, available = false, requestLimit = 12, publicOrigin } = {}) {
  if (publicOrigin) {
    const parsed = new URL(publicOrigin);
    if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin) throw new Error('Public origin must be an exact HTTPS origin');
  }
  const limits = new Map();
  const isAvailable = () => (typeof available === 'function' ? available() : available) && typeof analyzeText === 'function';
  return async (request, response) => {
    const headers = {
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'microphone=(self)', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    };
    const send = (status, data) => {
      if (response.destroyed) return;
      response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    try {
      const origin = new URL(`http://${request.headers.host}`);
      const url = new URL(request.url, origin);
      if (url.pathname === '/api/config' && request.method === 'GET') {
        send(200, { liveAvailable: isAvailable() }); return;
      }
      if (url.pathname === '/api/analyze' && request.method === 'POST') {
        const host = origin.hostname;
        const expectedOrigin = publicOrigin ?? origin.origin;
        if ((!publicOrigin && !['127.0.0.1', 'localhost', '[::1]', 'terminal.local'].includes(host))
          || request.headers.origin !== expectedOrigin) { send(403, { code: 'ORIGIN_REJECTED' }); return; }
        if (!isAvailable()) { send(503, { code: 'LIVE_DISABLED' }); return; }
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          send(415, { code: 'INVALID_INPUT' }); return;
        }
        const input = await readBody(request);
        if (!input || Array.isArray(input) || typeof input.text !== 'string'
          || !input.text.trim() || input.text.length > 12000
          || (input.includeEvidence !== undefined && typeof input.includeEvidence !== 'boolean')
          || !/^(Caller|Recipient):\s*\S/m.test(input.text)) { send(400, { code: 'INVALID_INPUT' }); return; }
        const address = visitorKey(request);
        const now = Date.now();
        for (const [key, item] of limits) if (now - item.since >= 3600000) limits.delete(key);
        const count = limits.get(address) ?? { since: now, count: 0 };
        if (count.count >= requestLimit || limits.size > 1000) { send(429, { code: 'RATE_LIMITED' }); return; }
        limits.set(address, { since: count.since, count: count.count + 1 });
        const controller = new AbortController();
        response.once?.('close', () => controller.abort());
        const result = await analyzeText(input.text, { includeEvidence: input.includeEvidence === true, signal: controller.signal });
        if (!['flagged', 'review', 'insufficient_context', 'no_flags'].includes(result?.state)) {
          throw new ClockedError('INVALID_RESPONSE');
        }
        const signals = [...(result.flagged ?? []), ...(result.uncertain ?? [])];
        send(200, { state: result.state, signals, ...(result.evidence ? { evidence: result.evidence } : {}),
          description: description[signals[0]] ?? 'There is not enough evidence to establish a concerning request.' });
        return;
      }
      const file = files.get(url.pathname);
      if (file && ['GET', 'HEAD'].includes(request.method)) {
        const data = readFileSync(new URL(file[0], ROOT));
        response.writeHead(200, { ...headers, 'Content-Type': file[1], 'Content-Length': data.length });
        response.end(request.method === 'HEAD' ? undefined : data); return;
      }
      send(404, { code: 'NOT_FOUND' });
    } catch (error) {
      send(error instanceof ClockedError && [400, 413].includes(error.status) ? error.status : 502,
        { code: error instanceof ClockedError ? error.code : 'ANALYSIS_FAILED' });
    }
  };
}

export function createApp(options) {
  const server = createServer(createHandler(options));
  server.requestTimeout = 25000;
  server.headersTimeout = 10000;
  return server;
}

export function runtimeConfig(options = {}) {
  // Without both explicit flags, don't even load the local key file.
  const publicOrigin = process.env.HANGUP_PUBLIC_ORIGIN || undefined;
  if (process.env.HANGUP_ENABLE_LIVE !== '1' || process.env.HANGUP_FREE_CREDITS_CONFIRMED !== '1') return { publicOrigin };
  let apiKey = process.env.CLOCKED_API_KEY;
  if (!apiKey) {
    try { apiKey = parseEnv(readFileSync(new URL('./.env.local', ROOT), 'utf8')).CLOCKED_API_KEY; }
    catch { return {}; }
  }
  if (!apiKey?.trim()) return {};
  return { ...createLiveAnalyzer({ ...options, apiKey }), publicOrigin };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  let port = Number(process.env.PORT ?? 4173), host = '127.0.0.1';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--host') host = args[++i];
    else if (args[i] !== '--strictPort') throw new Error('Unsupported server option');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['127.0.0.1', '0.0.0.0', 'localhost'].includes(host)) throw new Error('Invalid local server configuration');
  const server = createApp(runtimeConfig());
  server.on('error', () => { console.error('Local preview could not start; check the selected port.'); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Hang Up Meter preview: http://${host}:${port} (live analysis off unless explicitly enabled)`));
}
