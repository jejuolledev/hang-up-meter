import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { riskRequest } from './clocked.mjs';

export function parseCorpus(markdown) {
  const cases = [];
  for (const section of markdown.split(/^### /m).slice(1)) {
    const block = section.split(/^## /m)[0];
    const id = block.match(/^([SN]\d{2})\s/)?.[1];
    if (!id) continue;
    const turns = [...block.matchAll(/^(\d+)\. ((?:Caller|Recipient): .+)$/gm)];
    const expected = block.match(/^예상: (.+)$/m)?.[1];
    const firstAlert = id.startsWith('S') ? Number(expected?.match(/([23])번부터 경고/)?.[1]) : null;
    if (turns.length !== 3 || turns.some((turn, i) => Number(turn[1]) !== i + 1)
      || !expected || (id.startsWith('S') && ![2, 3].includes(firstAlert))) {
      throw new Error(`Invalid evaluation case: ${id}`);
    }
    cases.push({ id, turns: turns.map(turn => turn[2]), expectedFirstAlert: firstAlert, notes: expected });
  }
  const expectedIds = ['S', 'N'].flatMap(prefix => Array.from({ length: 20 }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`));
  const ids = new Set(cases.map(item => item.id));
  if (cases.length !== 40 || ids.size !== 40 || expectedIds.some(id => !ids.has(id))) {
    throw new Error('The main corpus must contain S01–S20 and N01–N20 exactly once.');
  }
  const practice = [...markdown.matchAll(/^\| (D\d{2}) \| (.+?) \| (.+?) \|$/gm)]
    .map(row => ({ id: row[1], text: row[2], expected: row[3] }));
  if (practice.length !== 8 || new Set(practice.map(item => item.id)).size !== 8
    || practice.some((item, i) => item.id !== `D${String(i + 1).padStart(2, '0')}`)) {
    throw new Error('The practice corpus must contain D01–D08 exactly once.');
  }
  return { cases, practice };
}

export function planEvaluation(markdown) {
  const { cases, practice } = parseCorpus(markdown);
  const inputs = cases.flatMap(item => item.turns.map((_, index) => ({
    id: item.id,
    turn: index + 1,
    // Gold labels and notes never enter the model state.
    request: riskRequest(item.turns.slice(0, index + 1).join('\n')),
  })));
  const hash = text => createHash('sha256').update(text).digest('hex');
  return {
    mode: 'offline-plan-only',
    mainCases: cases.length,
    riskCases: cases.filter(item => item.id.startsWith('S')).length,
    controlCases: cases.filter(item => item.id.startsWith('N')).length,
    mainRequests: inputs.length,
    practiceCases: practice.length,
    corpusSha256: hash(markdown),
    requestPlanSha256: hash(JSON.stringify(inputs)),
    maximumStateCharacters: Math.max(...inputs.map(input => input.request.state.length)),
    externalRequests: 0,
    liveQualityMeasured: false,
  };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  // No key reading, network call, or synthetic API response in this command.
  if (process.argv.slice(2).length) {
    process.stderr.write('This command validates an offline evaluation plan only; live execution is not enabled.\n');
    process.exitCode = 1;
  } else {
    try {
      const markdown = readFileSync(new URL('./평가대본.md', import.meta.url), 'utf8');
      process.stdout.write(`${JSON.stringify(planEvaluation(markdown), null, 2)}\n`);
    } catch {
      process.stderr.write('Evaluation corpus validation failed; inspect the scenario IDs, turns, and expected results.\n');
      process.exitCode = 1;
    }
  }
}
