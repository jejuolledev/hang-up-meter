import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup() {
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { checked: false, textContent: '', addEventListener() {} });
    return elements.get(id);
  };
  const spoken = [], timers = new Map(); let timerId = 0;
  const speech = { cancel() {}, getVoices: () => [], speak: u => spoken.push(u) };
  const context = vm.createContext({ $, window: { SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } },
    sampleSpeech: speech, samples: { gift: { turns: ['First.', 'Second.', 'Third.'] } },
    sample: 'gift', mode: 'sample', turnCount: 3, playing: false, samplePaused: false, sampleEpoch: 0,
    sampleUtterance: undefined, timer: undefined, renderSample() {}, refreshAction() {}, showError(message) { context.error = message; },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); } });
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('// Sample playback:'), source.indexOf('function invalidate()')), context);
  return { c: context, spoken, $, timers, speech };
}
test('spoken sentence starts transcript; end alone advances to next sentence and finishes', () => {
  const { c, spoken, $ } = setup(); c.toggleSample();
  assert.equal(spoken[0].text, 'First.'); assert.equal(c.turnCount, 0);
  for (let i = 0; i < 3; i++) { spoken[i].onstart(); assert.equal(c.turnCount, i + 1); spoken[i].onend(); }
  assert.equal(c.playing, false); assert.match($('mode-status').textContent, /Finished/);
});
test('pause cancels speech and resumes current sentence; stale events are ignored', () => {
  const { c, spoken } = setup(); c.toggleSample(); spoken[0].onstart(); c.toggleSample();
  spoken[0].onend(); spoken[0].onerror(); assert.equal(spoken.length, 1); assert.equal(c.samplePaused, true);
  c.toggleSample(); assert.equal(spoken[1].text, 'First.'); spoken[1].onstart(); assert.equal(c.turnCount, 1);
  c.stopSample(); spoken[1].onend(); assert.equal(spoken.length, 2);
});
test('pausing queued speech does not rewind the preceding sentence', () => {
  const { c, spoken } = setup(); c.toggleSample(); spoken[0].onstart(); spoken[0].onend();
  c.toggleSample(); c.toggleSample(); assert.equal(spoken[2].text, 'Second.');
});
test('speech error or start timeout stops with actionable feedback', () => {
  for (const timeout of [false, true]) {
    const { c, spoken, timers } = setup(); c.toggleSample();
    if (timeout) [...timers.values()][0](); else spoken[0].onerror();
    assert.equal(c.playing, false); assert.match(c.error, /Text only/);
  }
});
test('text-only option advances without any speech call', () => {
  const { c, spoken, $, timers } = setup(); $('sample-text-only').checked = true; c.toggleSample();
  assert.equal(c.turnCount, 1); assert.equal(spoken.length, 0);
  c.stopSample(); assert.equal(timers.size, 0);
});

 test('mid-sentence errors and missing end events replay the interrupted sentence', () => {
  for (const timeout of [false, true]) {
    const { c, spoken, timers } = setup(); c.toggleSample();
    spoken[0].onstart(); spoken[0].onend(); spoken[1].onstart();
    if (timeout) [...timers.values()][0](); else spoken[1].onerror();
    assert.equal(c.playing, false); assert.equal(c.turnCount, 1);
    c.toggleSample(); assert.equal(spoken[2].text, 'Second.');
  }
});
