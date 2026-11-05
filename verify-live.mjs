import { once } from 'node:events';
import { writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, runtimeConfig } from './server.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === '--help')) {
    console.log('Offline help only. To run four synthetic HTTP/API smoke cases: --live --free-credits-confirmed [--serve]. Uses the local key, at most six logical API calls during checks, and a 50-credit observed budget across checks and preview. Not a hard billing cap. --serve keeps a live local preview on port 4174.');
    return;
  }
  if (!args.includes('--live') || !args.includes('--free-credits-confirmed')
    || new Set(args).size !== args.length
    || args.some(arg => !['--live', '--free-credits-confirmed', '--serve'].includes(arg))) {
    throw new Error('EXPLICIT_LIVE_FLAGS_REQUIRED');
  }
  process.env.HANGUP_ENABLE_LIVE = '1';
  process.env.HANGUP_FREE_CREDITS_CONFIRMED = '1';
  const name = `eval-results-live-check-${randomUUID()}`;
  const usage = [];
  const config = runtimeConfig({ creditBudget: 50, onUsage: item => {
    usage.push(item);
    appendFileSync(`${name}.jsonl`, JSON.stringify({ event: 'usage', ...item }) + '\n');
  } });
  if (typeof config.available !== 'function' || !config.available()) throw new Error('LIVE_NOT_CONFIGURED');
  writeFileSync(`${name}.jsonl`, JSON.stringify({ event: 'started', observedBudget: 50, hardBillingCap: false }) + '\n', { flag: 'wx' });
  const server = createApp(config);
  try {
    server.listen(args.includes('--serve') ? 4174 : 0, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    const code = ['EPERM', 'EACCES', 'EADDRINUSE'].includes(error.code) ? error.code : 'SERVER_START_FAILED';
    const failure = { kind: 'three-case-live-smoke-check', complete: false, stage: 'server-start',
      code, cases: [], usage, apiCallsStarted: 0, fullMainEvaluation: false };
    writeFileSync(`${name}.json`, JSON.stringify(failure, null, 2) + '\n', { flag: 'wx' });
    appendFileSync(`${name}.jsonl`, JSON.stringify({ event: 'failed', stage: 'server-start', code }) + '\n');
    console.error(JSON.stringify({ report: `${name}.json`, complete: false, stage: 'server-start', code, apiCallsStarted: 0 }));
    process.exitCode = 1;
    return;
  }
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = { kind: 'three-case-live-smoke-check', startedAt: new Date().toISOString(),
    fullMainEvaluation: false, cases: [], usage, observedCreditBudget: 50, hardBillingCap: false };
  const cases = [
    { id: 'gift-policy', expected: 'flagged', includeEvidence: true,
      text: 'Caller: I am calling about a fine.\nCaller: Government fines must be paid with gift cards.\nCaller: Buy gift cards and read the numbers to me.' },
    { id: 'routine-check', expected: 'no_flags', includeEvidence: false,
      text: 'Caller: Open your banking app yourself. Do not share your password or sign-in code with me.\nCaller: You can hang up and call the number printed on your card.' },
    { id: 'recipient-recollection', expected: 'insufficient_context', includeEvidence: false,
      text: 'Recipient: An unexpected caller asked me to keep a transfer secret.' },
    { id: 'vague-update', expected: 'insufficient_context', includeEvidence: false,
      text: 'Caller: Good afternoon.\nCaller: I have an update about a service you use.' },
  ];
  let keepOpen = false;
  try {
    for (const item of cases) {
      if (!config.available()) break;
      const started = performance.now();
      const response = await fetch(base + '/api/analyze', { method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: item.text, includeEvidence: item.includeEvidence }),
        signal: AbortSignal.timeout(25000) });
      const result = await response.json();
      const passed = response.ok && result.state === item.expected
        && (!item.includeEvidence || (result.evidence?.status === 'checked'
          && result.evidence.checks?.some(check => check.verdict === 'contradicted')));
      const record = { id: item.id, httpStatus: response.status, passed,
        elapsedMs: performance.now() - started, result };
      report.cases.push(record);
      appendFileSync(`${name}.jsonl`, JSON.stringify({ event: 'case', ...record }) + '\n');
      if (!passed) break;
    }
    report.complete = report.cases.length === cases.length && report.cases.every(item => item.passed)
      && usage.every(item => item.billingConfirmed);
    report.endedAt = new Date().toISOString();
    report.creditsReported = usage.reduce((sum, item) => sum + (item.credits ?? 0), 0);
    writeFileSync(`${name}.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ report: `${name}.json`, complete: report.complete,
      checkedCases: report.cases.length, creditsReported: report.creditsReported,
      ...(report.complete && args.includes('--serve') ? { livePreview: base } : {}) }));
    keepOpen = report.complete && args.includes('--serve');
    if (!report.complete) process.exitCode = 1;
  } catch (error) {
    report.complete = false;
    report.stage = 'case-execution';
    report.code = error.name === 'TimeoutError' ? 'CHECK_TIMEOUT' : 'CHECK_EXECUTION_FAILED';
    report.endedAt = new Date().toISOString();
    report.creditsReported = usage.reduce((sum, item) => sum + (item.credits ?? 0), 0);
    writeFileSync(`${name}.json`, JSON.stringify(report, null, 2) + '\n');
    console.error(JSON.stringify({ report: `${name}.json`, complete: false, code: report.code }));
    process.exitCode = 1;
  } finally {
    if (!keepOpen) await new Promise(resolve => server.close(resolve));
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch(() => { console.error('LIVE_CHECK_FAILED; see the local result log. Credential contents are hidden.'); process.exitCode = 1; });
}
