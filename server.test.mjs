import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createApp, createHandler } from './server.mjs';
import { analyzeConversation } from './analysis.mjs';

// This mode tests the real request handler without claiming socket/HTTP coverage.
const inMemory = process.env.HANGUP_TEST_IN_MEMORY === '1';
const handlers = new Map();
const fetch = inMemory ? async (url, options = {}) => {
  const target = new URL(url);
  const handler = handlers.get(target.origin);
  assert.ok(handler, 'A test handler must be registered');
  const request = Readable.from(options.body ? [Buffer.from(options.body)] : []);
  request.method = options.method ?? 'GET';
  request.url = target.pathname + target.search;
  request.headers = Object.fromEntries(new Headers({ host: target.host, ...options.headers }));
  request.socket = { remoteAddress: '127.0.0.1' };
  let status, headers, body;
  await handler(request, {
    destroyed: false,
    writeHead(code, values) { status = code; headers = values; },
    end(value) { body = value; },
  });
  return new Response(body, { status, headers });
} : globalThis.fetch;

async function preview(t, options) {
  if (inMemory) {
    const base = `http://localhost:${10000 + handlers.size}`;
    handlers.set(base, createHandler(options));
    t.after(() => handlers.delete(base));
    return base;
  }
  const server = createApp(options);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, text, extra = {}) => fetch(`${base}/api/analyze`, {
  method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ text }),
});

test('the preview serves the actual interface, font and icons with security headers', async t => {
  const base = await preview(t);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await response.text();
  assert.match(html, /Hang Up Meter/);
  for (const file of ['/app.css', '/app.js', '/brandmark.png', '/font-manrope.ttf', '/icon-pause.svg']) {
    assert.equal((await fetch(base + file)).status, 200);
  }
});

test('private files, reports and source modules cannot be served as static assets', async t => {
  const base = await preview(t);
  for (const file of ['/.env.local', '/.env', '/server.mjs', '/analysis.mjs', '/official-sources.json', '/clocked.mjs', '/HANDOVER.md', '/package.json', '/../.env.local']) {
    assert.equal((await fetch(base + file)).status, 404);
  }
});

test('the default preview never calls an analyzer and clearly disables live mode', async t => {
  let calls = 0;
  const base = await preview(t, { analyzeText: async () => { calls++; } });
  assert.deepEqual(await (await fetch(base + '/api/config')).json(), { liveAvailable: false });
  assert.equal((await post(base, 'Caller: A synthetic request.')).status, 503);
  assert.equal(calls, 0);
});

test('cross-origin analysis cannot spend the local account credits', async t => {
  let calls = 0;
  const base = await preview(t, { available: true, analyzeText: async () => { calls++; } });
  assert.equal((await post(base, 'Caller: A request.', { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal(calls, 0);
});

test('validation rejects missing speaker labels and overlong input before calling', async t => {
  let calls = 0;
  const base = await preview(t, { available: true, analyzeText: async () => { calls++; } });
  assert.equal((await post(base, 'Please check these words.')).status, 400);
  assert.equal((await post(base, 'Caller: ' + 'a'.repeat(12000))).status, 400);
  assert.equal(calls, 0);
});

test('the endpoint uses the supplied analysis and enforces a local request limit', async t => {
  let calls = 0;
  const base = await preview(t, { available: true, requestLimit: 1, analyzeText: async () => {
    calls++; return { state: 'flagged', flagged: ['credentials'], uncertain: [] };
  } });
  const first = await post(base, 'Caller: Tell me a bank login code.');
  assert.equal(first.status, 200);
  assert.equal((await first.json()).state, 'flagged');
  assert.equal((await post(base, 'Caller: Another request.')).status, 429);
  assert.equal(calls, 1);
});

test('the request limit counts each forwarded visitor separately and falls back to the socket', async t => {
  let calls = 0;
  const base = await preview(t, { available: true, requestLimit: 1, analyzeText: async () => {
    calls++; return { state: 'no_flags', flagged: [], uncertain: [] };
  } });
  const from = address => ({ 'X-Forwarded-For': address });
  assert.equal((await post(base, 'Caller: First visitor.', from(' 203.0.113.7 , 10.0.0.1'))).status, 200);
  assert.equal((await post(base, 'Caller: Second visitor.', from('198.51.100.20, 10.0.0.1'))).status, 200);
  assert.equal((await post(base, 'Caller: First visitor again.', from('203.0.113.7'))).status, 429);
  assert.equal((await post(base, 'Caller: No forwarding header.')).status, 200);
  assert.equal((await post(base, 'Caller: Malformed header uses the socket.', from('not-an-ip'))).status, 429);
  assert.equal(calls, 3);
});

test('unexpected failures never echo upstream content or supply a sample verdict', async t => {
  const base = await preview(t, { available: true, analyzeText: async () => { throw new Error('PRIVATE SECRET DATA'); } });
  const response = await post(base, 'Caller: A request.');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { code: 'ANALYSIS_FAILED' });
});

test('disabling analysis is reflected in config and stops additional requests', async t => {
  let enabled = true, calls = 0;
  const base = await preview(t, { available: () => enabled, analyzeText: async () => {
    calls++; enabled = false; return { state: 'no_flags', flagged: [], uncertain: [] };
  } });
  assert.equal((await post(base, 'Caller: A request.')).status, 200);
  assert.deepEqual(await (await fetch(base + '/api/config')).json(), { liveAvailable: false });
  assert.equal((await post(base, 'Caller: Another request.')).status, 503);
  assert.equal(calls, 1);
});

test('source checking needs an explicit boolean and passes its result through the route', async t => {
  let calls = 0;
  const evidence = { status: 'no_spans', spans: [], sources: [], checks: [] };
  const base = await preview(t, { available: true, analyzeText: async (text, options) => {
    calls++; assert.equal(options.includeEvidence, true); assert.equal(options.signal.aborted, false);
    return { state: 'insufficient_context', evidence };
  } });
  const send = includeEvidence => fetch(`${base}/api/analyze`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Caller: Hello.', includeEvidence }),
  });
  assert.equal((await send('true')).status, 400);
  const response = await send(true);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).evidence, evidence);
  assert.equal(calls, 1);
});


test('configured HTTPS origin works behind a proxy and rejects other origins', async t => {
  let calls = 0;
  const base = await preview(t, { publicOrigin: 'https://meter.example', available: true,
    analyzeText: async () => { calls++; return { state: 'no_flags' }; } });
  assert.equal((await post(base, 'Caller: Hello.', { Origin: 'https://meter.example' })).status, 200);
  for (const origin of [base, 'https://evil.example', 'https://meter.example.evil.example', 'http://meter.example']) {
    assert.equal((await post(base, 'Caller: Hello.', { Origin: origin })).status, 403);
  }
  assert.equal(calls, 1);
});

test('public origin configuration rejects insecure or non-origin URLs', () => {
  for (const publicOrigin of ['http://meter.example', 'https://meter.example/path', 'https://user:pass@meter.example']) {
    assert.throws(() => createHandler({ publicOrigin }));
  }
});


test('recipient-only recollection is insufficient through the real route without upstream calls', async t => {
  let calls = 0;
  const base = await preview(t, { available: true, analyzeText: (text, options) =>
    analyzeConversation(text, { ...options, call: async () => { calls++; throw new Error('unexpected'); } }) });
  const response = await post(base, 'Recipient: An unexpected caller asked me to keep a transfer secret.');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'insufficient_context');
  assert.equal(calls, 0);
});
