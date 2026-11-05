import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runEvaluation, evaluationJobs, freezeEvaluation, validateFreeze, summarizeRecords, recoverFailedRequest } from './run-evaluation.mjs';

// No live transport is used. These fixtures test the evaluator, not Clocked.
const markdown = readFileSync(new URL('./평가대본.md', import.meta.url), 'utf8');
const key = 'unit-test-only-secret';
const body = { answers: Object.fromEntries(['payment', 'secrecy', 'credentials',
  'remote_access', 'threats', 'stay_connected', 'specific_request']
  .map(name => [name, { type: 'noul', noul: name === 'specific_request' ? 0.9 : 0.01 }])) };
const response = (headers = {}) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json',
    'X-Clocked-Credits': '3', 'X-Clocked-Cost-Basis': 'reference', ...headers },
});
const options = { suite: 'practice', limit: 2, creditBudget: 50,
  confirmedFreeCredits: true, apiKey: key, fetchImpl: async () => response(), sleep: async () => {} };

async function uncertainReport() {
  return runEvaluation(markdown, { ...options, fetchImpl: async () => { throw new Error('network unavailable'); } });
}
test('recovery preserves the original request ID and payload across an uncertain 409', async () => {
  const old = await uncertainReport(), seen = [];
  const recovered = await recoverFailedRequest(old, markdown, { ...options, fetchImpl: async (_, init) => {
    seen.push({ id: init.headers['Idempotency-Key'], body: init.body });
    return seen.length === 1 ? new Response('{}', { status: 409 }) : response();
  } });
  assert.equal(recovered.billingConfirmed, true);
  assert.equal(recovered.fullMainEvaluation, false);
  assert.equal(seen.length, 2); assert.deepEqual(seen[0], seen[1]);
  assert.equal(seen[0].id, old.records[0].requestId);
  assert.equal(JSON.parse(seen[0].body).state, evaluationJobs(markdown, 'practice')[0].text);
});
test('recovery rejects changed source material and completed reports before transport', async () => {
  const old = await uncertainReport(); let calls = 0;
  const settings = { ...options, fetchImpl: async () => { calls++; return response(); } };
  await assert.rejects(recoverFailedRequest(old, markdown + '\nChanged', settings), { code: 'INVALID_RECOVERY_REPORT' });
  await assert.rejects(recoverFailedRequest({ ...old, complete: true }, markdown, settings), { code: 'INVALID_RECOVERY_REPORT' });
  assert.equal(calls, 0);
});
test('recovery requires free-credit confirmation before attempting the original request', async () => {
  const old = await uncertainReport(); let calls = 0;
  await assert.rejects(recoverFailedRequest(old, markdown, { ...options, confirmedFreeCredits: false,
    fetchImpl: async () => { calls++; return response(); } }), { code: 'FREE_CREDITS_NOT_CONFIRMED' });
  assert.equal(calls, 0);
});
test('recovery never copies an unrecognized billing header into its saved result', async () => {
  const old = await uncertainReport();
  const recovered = await recoverFailedRequest(old, markdown, { ...options,
    fetchImpl: async () => response({ 'X-Clocked-Cost-Basis': key }) });
  assert.equal(recovered.billingConfirmed, false);
  assert.equal(recovered.costBasis, null);
  assert.equal(JSON.stringify(recovered).includes(key), false);
});

test('live execution requires explicit free-credit confirmation before sending', async () => {
  let calls = 0;
  await assert.rejects(runEvaluation(markdown, { ...options, confirmedFreeCredits: false,
    fetchImpl: async () => { calls++; } }), { code: 'FREE_CREDITS_NOT_CONFIRMED' });
  assert.equal(calls, 0);
});

test('invalid budgets and limits stop before transport', async () => {
  for (const change of [{ limit: 0 }, { limit: 9 }, { creditBudget: -1 }, { creditBudget: 20001 }]) {
    await assert.rejects(runEvaluation(markdown, { ...options, ...change }), { code: 'INVALID_BUDGET' });
  }
});

test('practice and main jobs do not include gold labels in their text', () => {
  const practice = evaluationJobs(markdown, 'practice');
  const main = evaluationJobs(markdown, 'main');
  assert.equal(practice.length, 8);
  assert.equal(main.length, 120);
  assert.equal(main[0].text, 'Caller: I am calling about activity on your bank account.');
  assert.equal(main[1].text.split('\n').length, 2);
  assert.equal('expectedFirstAlert' in main[0], false);
  assert.equal('notes' in main[0], false);
});

test('main evaluation cannot start without a matching frozen plan', async () => {
  await assert.rejects(runEvaluation(markdown, { ...options, suite: 'main' }), { code: 'FREEZE_MISMATCH' });
});

test('completed practice produces a snapshot that detects data drift', async () => {
  const report = await runEvaluation(markdown, options);
  const frozen = freezeEvaluation(report, markdown);
  assert.doesNotThrow(() => validateFreeze(frozen, markdown));
  assert.throws(() => validateFreeze(frozen, `${markdown}\nChanged evaluation note.\n`), { code: 'FREEZE_MISMATCH' });
  assert.throws(() => freezeEvaluation({ ...report, records: [] }, markdown), { code: 'INVALID_PRACTICE_REPORT' });
  assert.throws(() => freezeEvaluation({ ...report, records: undefined }, markdown), { code: 'INVALID_PRACTICE_REPORT' });
});

test('observed credits stop new calls without promising a hard billing cap', async () => {
  let calls = 0;
  const report = await runEvaluation(markdown, { ...options, creditBudget: 2,
    fetchImpl: async () => { calls++; return response(); } });
  assert.equal(calls, 1);
  assert.equal(report.stopReason, 'observed_credit_budget_reached');
  assert.equal(report.creditBudgetOvershot, true);
  assert.equal(report.creditLimitIsHardBillingCap, false);
  assert.equal(report.complete, false);
});

test('missing credits or unknown billing basis stop further calls', async () => {
  for (const [headers, reason] of [
    [{ 'X-Clocked-Credits': '' }, 'credits_unknown'],
    [{ 'X-Clocked-Credits': '0' }, 'credits_invalid'],
    [{ 'X-Clocked-Cost-Basis': 'mixed' }, 'billing_basis_not_confirmed'],
    [{ 'X-Clocked-Cost-Basis': '' }, 'billing_basis_not_confirmed'],
  ]) {
    let calls = 0;
    const report = await runEvaluation(markdown, { ...options, fetchImpl: async () => { calls++; return response(headers); } });
    assert.equal(calls, 1);
    assert.equal(report.stopReason, reason);
    assert.equal(report.complete, false);
  }
});

test('failed requests stay failures and stop the batch', async () => {
  let calls = 0;
  const report = await runEvaluation(markdown, { ...options, fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ error: key }), { status: 401 });
  } });
  assert.equal(calls, 1);
  assert.equal(report.records[0].ok, false);
  assert.equal(report.records[0].error, 'HTTP_FAILURE');
  assert.equal(report.complete, false);
  assert.equal(JSON.stringify(report).includes(key), false);
});

test('an echoed secret in a successful body is redacted before recording', async () => {
  const recorded = [];
  const report = await runEvaluation(markdown, { ...options,
    fetchImpl: async () => new Response(JSON.stringify({ ...body, note: key }), {
      status: 200, headers: { 'X-Clocked-Credits': '1', 'X-Clocked-Cost-Basis': 'reference' },
    }), onRecord: row => recorded.push(row),
  });
  assert.equal(JSON.stringify(recorded).includes(key), false);
  assert.equal(JSON.stringify(report).includes(key), false);
  assert.equal(recorded[0].response.note, '[REDACTED]');
});

test('partial main runs are not reported as a complete 40-call benchmark', async () => {
  const practice = await runEvaluation(markdown, options);
  const freeze = freezeEvaluation(practice, markdown);
  const report = await runEvaluation(markdown, { ...options, suite: 'main', freeze, limit: 3 });
  assert.equal(report.complete, true);
  assert.equal(report.fullMainEvaluation, false);
  assert.equal(report.coverage.completeRiskCases, 1);
  assert.equal(report.coverage.incompleteCases, 39);
});

test('case metrics distinguish early alarms, missed risk and false control alerts', () => {
  const rows = [];
  for (const id of ['S01', 'S19', 'N01']) {
    for (let turn = 1; turn <= 3; turn++) {
      const state = (id === 'S19' && turn === 1) || (id === 'N01' && turn === 2) ? 'flagged' : 'no_flags';
      rows.push({ id, turn, ok: true, decision: { state }, elapsedMs: 10 });
    }
  }
  const result = summarizeRecords(rows, markdown);
  assert.deepEqual(result.falseAlertedControls, ['N01']);
  assert.deepEqual(result.missedRiskCases, ['S01', 'S19']);
  assert.deepEqual(result.earlyRiskAlerts, ['S19']);
  assert.equal(result.incompleteCases, 37);
});

test('official snippets have stable IDs, primary HTTPS URLs, and no synthetic attribution', () => {
  const sources = JSON.parse(readFileSync(new URL('./official-sources.json', import.meta.url), 'utf8'));
  assert.equal(sources.documents.length, 2);
  assert.equal(new Set(sources.documents.map(document => document.id)).size, 2);
  for (const document of sources.documents) {
    assert.equal(new URL(document.url).hostname, 'consumer.ftc.gov');
    assert.equal(new URL(document.url).protocol, 'https:');
    assert.equal(document.kind, 'verbatim_excerpt');
    assert.ok(document.text.length > 30);
  }
});


test('unreadable successful response recovery keeps the original logical request', async () => {
  const old = await runEvaluation(markdown, { ...options,
    fetchImpl: async () => new Response('{', { status: 200 }) });
  assert.equal(old.records[0].error, 'INVALID_RESPONSE');
  const recovered = await recoverFailedRequest(old, markdown, { ...options, fetchImpl: async (_, init) => {
    assert.equal(init.headers['Idempotency-Key'], old.records[0].requestId);
    assert.equal(JSON.parse(init.body).state, evaluationJobs(markdown, 'practice')[0].text);
    return response();
  } });
  assert.equal(recovered.billingConfirmed, true);
  assert.equal(recovered.fullMainEvaluation, false);
});

test('resume skips recovered work and retains the original failed attempt', async () => {
  const practice = await runEvaluation(markdown, options);
  const frozen = freezeEvaluation(practice, markdown);
  let calls = 0;
  const prior = await runEvaluation(markdown, { ...options, suite: 'main', limit: 120,
    creditBudget: 500, freeze: frozen, fetchImpl: async () => {
      calls++; return calls === 3 ? new Response('{', { status: 200 }) : response();
    } });
  const recovered = await recoverFailedRequest(prior, markdown, options);
  calls = 0;
  const settings = { ...options, suite: 'main', limit: 120, creditBudget: 500,
    freeze: frozen, resumeReport: prior, recovery: recovered,
    fetchImpl: async () => { calls++; return response(); } };
  const resumed = await runEvaluation(markdown, settings);
  assert.equal(calls, 117);
  assert.equal(resumed.records.length, 120);
  assert.equal(resumed.fullMainEvaluation, true);
  assert.equal(resumed.resume.originalFailure.error, 'INVALID_RESPONSE');
  assert.equal(resumed.records[2].requestId, prior.records[2].requestId);
  calls = 0;
  await assert.rejects(runEvaluation(markdown, { ...settings,
    recovery: { ...recovered, requestId: 'wrong' } }), { code: 'INVALID_RESUME_REPORT' });
  assert.equal(calls, 0);
});
