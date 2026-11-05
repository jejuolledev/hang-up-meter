import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { callClocked, ClockedError, riskRequest, riskResult } from './clocked.mjs';
import { parseCorpus, planEvaluation } from './evaluate.mjs';

function fail(code) { throw new ClockedError(code); }
const hash = value => createHash('sha256').update(value).digest('hex');

export function requestSpecHash() {
  const { state, ...spec } = riskRequest('SPECIFICATION');
  return hash(JSON.stringify(spec));
}

export function evaluationJobs(markdown, suite) {
  const corpus = parseCorpus(markdown);
  if (suite === 'practice') return corpus.practice.map(item => ({ id: item.id, turn: 1, text: item.text }));
  if (suite === 'main') return corpus.cases.flatMap(item => item.turns.map((_, i) => ({
    id: item.id, turn: i + 1, text: item.turns.slice(0, i + 1).join('\n'),
  })));
  fail('INVALID_SUITE');
}

export function freezeEvaluation(practice, markdown) {
  const plan = planEvaluation(markdown);
  if (practice?.kind !== 'clocked-live-evaluation' || practice.suite !== 'practice'
    || practice.complete !== true || !Array.isArray(practice.records) || practice.records.length < 1
    || practice.records.some(record => !record.ok || !Number.isFinite(record.credits) || record.credits < 1)
    || practice.requestSpecSha256 !== requestSpecHash()
    || practice.corpusSha256 !== plan.corpusSha256) fail('INVALID_PRACTICE_REPORT');
  return {
    kind: 'evaluation-freeze',
    frozenAt: new Date().toISOString(),
    corpusSha256: plan.corpusSha256,
    requestPlanSha256: plan.requestPlanSha256,
    requestSpecSha256: requestSpecHash(),
    practiceRunId: practice.runId,
    note: 'Identifies this authored synthetic workload, not an independent or real-world benchmark.',
  };
}

export function validateFreeze(freeze, markdown) {
  const plan = planEvaluation(markdown);
  if (freeze?.kind !== 'evaluation-freeze'
    || freeze.corpusSha256 !== plan.corpusSha256
    || freeze.requestPlanSha256 !== plan.requestPlanSha256
    || freeze.requestSpecSha256 !== requestSpecHash()) fail('FREEZE_MISMATCH');
}

export function summarizeRecords(records, markdown) {
  const cases = parseCorpus(markdown).cases;
  const summary = { completeRiskCases: 0, completeControlCases: 0, incompleteCases: 0,
    falseAlertedControls: [], missedRiskCases: [], earlyRiskAlerts: [], uncertainControls: [] };
  for (const item of cases) {
    const rows = records.filter(record => record.id === item.id);
    if (rows.length !== 3 || rows.some(row => !row.ok)) { summary.incompleteCases++; continue; }
    const flagged = rows.filter(row => row.decision.state === 'flagged').map(row => row.turn);
    if (item.expectedFirstAlert === null) {
      summary.completeControlCases++;
      if (flagged.length) summary.falseAlertedControls.push(item.id);
      if (rows.some(row => row.decision.state === 'review')) summary.uncertainControls.push(item.id);
    } else {
      summary.completeRiskCases++;
      if (!flagged.some(turn => turn >= item.expectedFirstAlert)) summary.missedRiskCases.push(item.id);
      if (flagged.some(turn => turn < item.expectedFirstAlert)) summary.earlyRiskAlerts.push(item.id);
    }
  }
  // Latencies cover completed logical requests, including retries, not model time.
  const times = records.filter(row => row.ok).map(row => row.elapsedMs).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  return { ...summary, requestFailures: records.filter(row => !row.ok).length,
    completedRequestLatency: times.length ? {
      count: times.length,
      medianMs: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2,
      p95Ms: times[Math.ceil(times.length * 0.95) - 1], maxMs: times.at(-1),
    } : null };
}

export async function runEvaluation(markdown, {
  suite = 'practice', limit = 2, creditBudget, confirmedFreeCredits = false,
  apiKey, fetchImpl, sleep, onRecord = () => {}, freeze, resumeReport, recovery,
} = {}) {
  if (confirmedFreeCredits !== true) fail('FREE_CREDITS_NOT_CONFIRMED');
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('MISSING_KEY');
  const available = evaluationJobs(markdown, suite);
  if (!Number.isInteger(limit) || limit < 1 || limit > available.length
    || !Number.isFinite(creditBudget) || creditBudget <= 0 || creditBudget > 20000) fail('INVALID_BUDGET');
  if (suite === 'main') validateFreeze(freeze, markdown);
  const jobs = available.slice(0, limit);
  const report = {
    kind: 'clocked-live-evaluation', runId: randomUUID(), startedAt: new Date().toISOString(),
    suite, plannedRequests: jobs.length, corpusSha256: planEvaluation(markdown).corpusSha256,
    requestSpecSha256: requestSpecHash(), creditBudget, creditsReported: 0,
    creditLimitIsHardBillingCap: false, complete: false, stopReason: null, records: [],
  };
  if (resumeReport || recovery) {
    const prior = resumeReport, last = prior?.records?.at(-1);
    if (suite !== 'main' || prior?.suite !== suite || prior.complete !== false
      || prior.stopReason !== 'request_failed' || prior.plannedRequests !== limit
      || prior.corpusSha256 !== report.corpusSha256 || prior.requestSpecSha256 !== report.requestSpecSha256
      || !Array.isArray(prior.records) || !prior.records.length || prior.records.length > jobs.length
      || last?.ok !== false || recovery?.kind !== 'clocked-request-recovery'
      || recovery.sourceRunId !== prior.runId || recovery.requestId !== last.requestId
      || recovery.id !== last.id || recovery.turn !== last.turn || recovery.billingConfirmed !== true
      || !Number.isFinite(recovery.credits) || recovery.credits < 1
      || !['reference', 'prepaid'].includes(recovery.costBasis)) fail('INVALID_RESUME_REPORT');
    for (const [i, record] of prior.records.entries()) {
      if (record.id !== jobs[i].id || record.turn !== jobs[i].turn) fail('INVALID_RESUME_REPORT');
      if (i < prior.records.length - 1 && (record.ok !== true
        || JSON.stringify(record.request) !== JSON.stringify(riskRequest(jobs[i].text))
        || !Number.isFinite(record.credits) || record.credits < 1
        || !['reference', 'prepaid'].includes(record.costBasis))) fail('INVALID_RESUME_REPORT');
    }
    const decision = riskResult({ answers: Object.fromEntries(Object.entries(recovery.decision?.scores ?? {})
      .map(([key, noul]) => [key, { type: 'noul', noul }])) });
    report.records = [...prior.records.slice(0, -1), { id: last.id, turn: last.turn,
      requestId: last.requestId, ok: true, decision, recovered: true,
      elapsedMs: recovery.elapsedMs, credits: recovery.credits, costBasis: recovery.costBasis }];
    report.resume = { sourceRunId: prior.runId, originalFailure: last,
      recoveredAt: recovery.recoveredAt, latencyNote: 'Recovered entry measures recovery only, not original failure plus recovery.' };
    report.creditsReported = report.records.reduce((sum, record) => sum + record.credits, 0);
    if (report.creditsReported >= creditBudget) fail('INVALID_BUDGET');
  }
  const sanitized = value => JSON.parse(JSON.stringify(value)
    .replaceAll(JSON.stringify(apiKey).slice(1, -1), '[REDACTED]'));
  for (const job of jobs.slice(report.records.length)) {
    const requestId = randomUUID();
    const request = riskRequest(job.text);
    const started = performance.now();
    let record;
    try {
      const result = await callClocked('decide', request, { apiKey, fetchImpl, sleep, requestId });
      const meta = result.attempts.at(-1);
      const decision = riskResult(result.data);
      record = sanitized({ id: job.id, turn: job.turn, requestId, ok: true,
        request, response: result.data, decision, elapsedMs: result.elapsedMs,
        attempts: result.attempts, credits: meta.credits, costBasis: meta.costBasis });
      if (record.credits !== null) report.creditsReported += record.credits;
      if (record.credits === null) report.stopReason = 'credits_unknown';
      if (record.credits !== null && record.credits < 1) report.stopReason = 'credits_invalid';
      if (record.costBasis !== 'reference' && record.costBasis !== 'prepaid') report.stopReason = 'billing_basis_not_confirmed';
    } catch (error) {
      record = { id: job.id, turn: job.turn, requestId, ok: false,
        elapsedMs: performance.now() - started,
        error: error instanceof ClockedError ? error.code : 'EVALUATION_FAILURE',
        status: error instanceof ClockedError ? error.status : null };
      report.stopReason = 'request_failed';
    }
    report.records.push(record);
    await onRecord(record);
    if (report.stopReason) break;
    if (report.creditsReported >= creditBudget && report.records.length < jobs.length) {
      report.stopReason = 'observed_credit_budget_reached'; break;
    }
  }
  report.endedAt = new Date().toISOString();
  report.complete = report.stopReason === null && report.records.length === jobs.length;
  report.fullMainEvaluation = suite === 'main' && report.complete && jobs.length === available.length;
  report.creditBudgetOvershot = report.creditsReported > creditBudget;
  report.coverage = suite === 'main' ? summarizeRecords(report.records, markdown) : null;
  return sanitized(report);
}

function localFile(name) {
  const path = resolve(name);
  if (dirname(path) !== process.cwd()) fail('REPORT_MUST_BE_IN_WORKSPACE');
  return path;
}

export async function recoverFailedRequest(report, markdown, { confirmedFreeCredits = false, ...transport } = {}) {
  if (!confirmedFreeCredits) fail('FREE_CREDITS_NOT_CONFIRMED');
  const record = report?.records?.at(-1);
  if (report?.kind !== 'clocked-live-evaluation' || report.complete !== false
    || report.stopReason !== 'request_failed' || record?.ok !== false
    || !(record.error === 'NETWORK_FAILURE' || (record.error === 'INVALID_RESPONSE' && record.status === 200))
    || report.corpusSha256 !== planEvaluation(markdown).corpusSha256
    || report.requestSpecSha256 !== requestSpecHash()) fail('INVALID_RECOVERY_REPORT');
  const job = evaluationJobs(markdown, report.suite).find(job => job.id === record.id && job.turn === record.turn);
  if (!job || typeof record.requestId !== 'string') fail('INVALID_RECOVERY_REPORT');
  const result = await callClocked('decide', riskRequest(job.text), {
    ...transport, requestId: record.requestId, recoverUnknownOutcome: true,
  });
  const decision = riskResult(result.data), usage = result.attempts.at(-1);
  return { kind: 'clocked-request-recovery', sourceRunId: report.runId, requestId: record.requestId,
    id: job.id, turn: job.turn, decision, credits: usage.credits,
    costBasis: ['reference', 'prepaid'].includes(usage.costBasis) ? usage.costBasis : null,
    billingConfirmed: usage.credits >= 1 && ['reference', 'prepaid'].includes(usage.costBasis),
    elapsedMs: result.elapsedMs, recoveredAt: new Date().toISOString(), fullMainEvaluation: false };
}

async function main() {
  const args = process.argv.slice(2);
  const markdown = readFileSync(new URL('./평가대본.md', import.meta.url), 'utf8');
  if (!args.length) {
    console.log(JSON.stringify(planEvaluation(markdown), null, 2)); return;
  }
  if (args.length === 1 && args[0] === '--help') {
    console.log('Default: offline validation only.\nLive practice: --live --suite practice --limit 2 --credit-budget 50 --free-credits-confirmed\nFreeze a completed practice report: --freeze REPORT.json\nLive main: --live --suite main --limit 120 --credit-budget BUDGET --free-credits-confirmed --frozen FREEZE.json\nConfirm remaining free credits and no paid overage before live use. A single request can exceed the observed credit budget.');
    console.log('Recover one uncertain request with its original ID and unchanged payload: --recover REPORT.json --free-credits-confirmed');
    return;
  }
  if (args.length === 3 && args[0] === '--recover' && args[2] === '--free-credits-confirmed') {
    const previous = JSON.parse(readFileSync(localFile(args[1]), 'utf8'));
    const apiKey = parseEnv(readFileSync(new URL('./.env.local', import.meta.url), 'utf8')).CLOCKED_API_KEY;
    if (!apiKey?.trim()) fail('MISSING_KEY');
    const recovered = await recoverFailedRequest(previous, markdown, { apiKey, confirmedFreeCredits: true });
    const name = `eval-results-recovery-${randomUUID()}.json`;
    writeFileSync(name, JSON.stringify(recovered, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ report: name, recovered: true, state: recovered.decision.state,
      creditsReported: recovered.credits, billingConfirmed: recovered.billingConfirmed }));
    if (!recovered.billingConfirmed) process.exitCode = 1;
    return;
  }
  if (args.length === 2 && args[0] === '--freeze') {
    const practice = JSON.parse(readFileSync(localFile(args[1]), 'utf8'));
    const frozen = freezeEvaluation(practice, markdown);
    const name = `eval-freeze-${randomUUID()}.json`;
    writeFileSync(name, `${JSON.stringify(frozen, null, 2)}\n`, { flag: 'wx' });
    console.log(`Evaluation snapshot saved: ${name}`); return;
  }
  if (args[0] !== '--live') fail('INVALID_ARGUMENTS');
  const options = {};
  for (let i = 1; i < args.length; i++) {
    const name = args[i];
    if (Object.hasOwn(options, name)) fail('INVALID_ARGUMENTS');
    if (name === '--free-credits-confirmed') options[name] = true;
    else if (['--suite', '--limit', '--credit-budget', '--frozen', '--resume', '--recovery'].includes(name) && args[i + 1]) options[name] = args[++i];
    else fail('INVALID_ARGUMENTS');
  }
  if (!options['--free-credits-confirmed']) fail('FREE_CREDITS_NOT_CONFIRMED');
  const suite = options['--suite'];
  const limit = Number(options['--limit']);
  const creditBudget = Number(options['--credit-budget']);
  if (!['practice', 'main'].includes(suite) || !Number.isInteger(limit) || limit < 1
    || limit > (suite === 'practice' ? 8 : 120)
    || !Number.isFinite(creditBudget) || creditBudget <= 0 || creditBudget > 20000) fail('INVALID_ARGUMENTS');
  const frozen = options['--frozen'] ? JSON.parse(readFileSync(localFile(options['--frozen']), 'utf8')) : undefined;
  if (suite === 'main') validateFreeze(frozen, markdown);
  const apiKey = parseEnv(readFileSync(new URL('./.env.local', import.meta.url), 'utf8')).CLOCKED_API_KEY;
  if (!apiKey?.trim()) fail('MISSING_KEY');
  const basename = `eval-results-${suite}-${randomUUID()}`;
  writeFileSync(`${basename}.jsonl`, `${JSON.stringify({ event: 'started', suite, limit, creditBudget })}\n`, { flag: 'wx' });
  const report = await runEvaluation(markdown, {
    suite, limit, creditBudget, confirmedFreeCredits: true, apiKey, freeze: frozen,
    resumeReport: options['--resume'] ? JSON.parse(readFileSync(localFile(options['--resume']), 'utf8')) : undefined,
    recovery: options['--recovery'] ? JSON.parse(readFileSync(localFile(options['--recovery']), 'utf8')) : undefined,
    onRecord: record => appendFileSync(`${basename}.jsonl`, `${JSON.stringify(record)}\n`),
  });
  writeFileSync(`${basename}.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ report: `${basename}.json`, complete: report.complete,
    recordedRequests: report.records.length, creditsReported: report.creditsReported,
    stopReason: report.stopReason, creditBudgetOvershot: report.creditBudgetOvershot }, null, 2));
  if (!report.complete) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch(error => {
    // No raw exception or upstream body: either could include a secret or source.
    console.error(error instanceof ClockedError ? error.code : 'EVALUATION_FAILED_CHECK_LOCAL_SETUP');
    process.exitCode = 1;
  });
}
