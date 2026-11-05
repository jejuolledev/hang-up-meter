import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConversation, createLiveAnalyzer } from './analysis.mjs';

const text = 'Caller: Government fines must be paid with gift cards. Buy gift cards.';
const span = quote => ({ value: quote, start: Array.from(text.slice(0, text.indexOf(quote))).length,
  end: Array.from(text.slice(0, text.indexOf(quote)) + quote).length });
const risk = { answers: Object.fromEntries(['payment', 'secrecy', 'credentials', 'remote_access', 'threats', 'stay_connected', 'specific_request']
  .map(key => [key, { type: 'noul', noul: ['payment', 'specific_request'].includes(key) ? 0.95 : 0.01 }])) };
const extract = { fields: { request: span('Buy gift cards'), factual_claim: span('Government fines must be paid with gift cards.') } };
const ranking = (first = 'use') => ({ results: [
  { index: 0, id: 'ftc-gift-card-payment', action: first },
  { index: 1, id: 'ftc-time-to-decide', action: 'skip' },
] });
function fixture(overrides = {}) {
  const seen = [];
  return { seen, call: async (endpoint, payload) => {
    seen.push({ endpoint, payload });
    const data = { decide: risk, extract, rerank: ranking(), grounding: {
      claims: [{ claim: extract.fields.factual_claim.value, verdict: 'contradicted' }],
    }, ...overrides }[endpoint];
    if (data instanceof Error) throw data;
    return { data };
  } };
}

test('extra source calls are opt-in; Decide alone still determines the state', async () => {
  const f = fixture(); const result = await analyzeConversation(text, f);
  assert.equal(result.state, 'flagged'); assert.equal(result.evidence, undefined);
  assert.deepEqual(f.seen.map(item => item.endpoint), ['decide']);
});
test('four stages affect exact spans, selected sources, and a distinct source verdict', async () => {
  const f = fixture(); const result = await analyzeConversation(text, { ...f, includeEvidence: true });
  assert.deepEqual(f.seen.map(item => item.endpoint), ['decide', 'extract', 'rerank', 'grounding']);
  assert.equal(result.evidence.status, 'checked');
  assert.equal(result.evidence.sources.length, 1);
  assert.equal(result.evidence.checks[0].verdict, 'contradicted');
  assert.equal(result.evidence.checks[0].passage, null);
  assert.equal(f.seen[3].payload.claims[0], extract.fields.factual_claim.value);
});
test('a command without a factual claim gets related guidance without Verify', async () => {
  const f = fixture({ extract: { fields: { ...extract.fields, factual_claim: { value: null } } } });
  const result = await analyzeConversation(text, { ...f, includeEvidence: true });
  assert.equal(result.evidence.status, 'guidance_only'); assert.equal(f.seen.length, 3);
});
test('offset mismatch prevents ranking and invented highlights', async () => {
  const f = fixture({ extract: { fields: { ...extract.fields, request: { value: 'invented', start: 0, end: 8 } } } });
  const result = await analyzeConversation(text, { ...f, includeEvidence: true });
  assert.equal(result.evidence.status, 'unavailable'); assert.equal(result.evidence.spans.length, 0);
  assert.equal(f.seen.length, 2); assert.equal(result.state, 'flagged');
});
for (const [action, status] of [['skip', 'no_relevant_sources'], ['expand', 'needs_more_sources']]) {
  test(`${action} does not become usable evidence or trigger Verify`, async () => {
    const f = fixture({ rerank: ranking(action) });
    const result = await analyzeConversation(text, { ...f, includeEvidence: true });
    assert.equal(result.evidence.status, status); assert.deepEqual(result.evidence.sources, []); assert.equal(f.seen.length, 3);
  });
}
test('unknown source IDs invalidate ranking rather than attaching an unrelated document', async () => {
  const bad = ranking(); bad.results[0].id = 'invented-source';
  const f = fixture({ rerank: bad }); const result = await analyzeConversation(text, { ...f, includeEvidence: true });
  assert.equal(result.evidence.status, 'unavailable'); assert.equal(f.seen.length, 3);
});
for (const verdict of ['not_stated', 'not_a_claim']) {
  test(`${verdict} remains distinct from contradiction`, async () => {
    const f = fixture({ grounding: { claims: [{ claim: extract.fields.factual_claim.value, verdict }] } });
    const result = await analyzeConversation(text, { ...f, includeEvidence: true });
    assert.equal(result.evidence.checks[0].verdict, verdict);
  });
}
test('fabricated source quotations invalidate the check but preserve Decide', async () => {
  const f = fixture({ grounding: { claims: [{ claim: extract.fields.factual_claim.value, verdict: 'contradicted',
    evidence: { document: 'ftc-gift-card-payment', quote: 'fabricated', start: 0, end: 10 } }] } });
  const result = await analyzeConversation(text, { ...f, includeEvidence: true });
  assert.equal(result.state, 'flagged'); assert.equal(result.evidence.status, 'unavailable');
  assert.deepEqual(result.evidence.checks, []);
});
test('source service failure does not turn a completed assessment into a safe sample', async () => {
  const f = fixture({ extract: new Error('PRIVATE UPSTREAM CONTENT') });
  const result = await analyzeConversation(text, { ...f, includeEvidence: true });
  assert.equal(result.state, 'flagged'); assert.equal(result.evidence.status, 'unavailable');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('a valid source-local evidence span is preserved verbatim', async () => {
  const quote = 'No real business or government agency';
  const f = fixture({ grounding: { claims: [{ claim: extract.fields.factual_claim.value, verdict: 'contradicted',
    evidence: { document: 'ftc-gift-card-payment', quote, start: 0, end: quote.length } }] } });
  const result = await analyzeConversation(text, { ...f, includeEvidence: true });
  assert.equal(result.evidence.status, 'checked');
  assert.equal(result.evidence.checks[0].passage.quote, quote);
});
test('no extracted facts stop before retrieval rather than using generic guidance', async () => {
  const f = fixture({ extract: { fields: { request: { value: null }, factual_claim: { value: null } } } });
  const result = await analyzeConversation(text, { ...f, includeEvidence: true });
  assert.equal(result.evidence.status, 'no_spans'); assert.equal(f.seen.length, 2);
});
test('failed Decide never supplies an assessment from later stages', async () => {
  const f = fixture({ decide: new Error('service unavailable') });
  await assert.rejects(analyzeConversation(text, { ...f, includeEvidence: true }));
  assert.deepEqual(f.seen.map(item => item.endpoint), ['decide']);
});

test('the live analyzer stops further stages when its observed credit budget is reached', async () => {
  const usage = [], endpoints = [];
  const analyzer = createLiveAnalyzer({ apiKey: 'unit-only', creditBudget: 2, onUsage: item => usage.push(item),
    transport: async endpoint => { endpoints.push(endpoint); return { data: risk, requestId: 'unit-only',
      elapsedMs: 1, attempts: [{ credits: 2, costBasis: 'reference' }] }; } });
  const result = await analyzer.analyzeText(text, { includeEvidence: true });
  assert.equal(result.state, 'flagged'); assert.equal(result.evidence.status, 'unavailable');
  assert.deepEqual(endpoints, ['decide']); assert.equal(analyzer.available(), false);
  assert.equal(usage[0].totalObservedCredits, 2);
  await assert.rejects(analyzer.analyzeText(text), { code: 'LIVE_DISABLED' });
});
test('the live analyzer suspends on unknown usage and exposes only normalized billing metadata', async () => {
  const usage = [];
  const analyzer = createLiveAnalyzer({ apiKey: 'unit-only', onUsage: item => usage.push(item),
    transport: async () => ({ data: risk, elapsedMs: 1, attempts: [{ credits: null, costBasis: 'PRIVATE' }] }) });
  await analyzer.analyzeText(text);
  assert.equal(analyzer.available(), false); assert.equal(usage[0].costBasis, null);
  assert.equal(JSON.stringify(usage).includes('PRIVATE'), false);
});


test('recipient-only recollections cannot trigger caller warnings or spend API credits', async () => {
  let calls = 0;
  const result = await analyzeConversation('Recipient: An unexpected caller asked me to keep a transfer secret.', {
    includeEvidence: true, call: async () => { calls++; throw new Error('must not call'); },
  });
  assert.equal(result.state, 'insufficient_context');
  assert.deepEqual(result.flagged, []);
  assert.equal(result.evidence.status, 'no_spans');
  assert.equal(calls, 0);
});
