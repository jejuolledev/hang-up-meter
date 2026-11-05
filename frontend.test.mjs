import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Minimal DOM adapter for application state/race checks, not visual or screen-reader QA.
function app() {
  class Element {
    constructor() { this.textContent = ''; this.value = ''; this.checked = false; this.hidden = false; this.childNodes = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.classList = { add() {} }; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute(name, value) { this.attributes[name] = value; }
    replaceChildren(...children) { this.childNodes = children; }
    append(...children) { this.childNodes.push(...children); }
    focus() { this.focused = true; }
    showModal() {}
    close() {}
  }
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const modes = ['sample', 'text', 'mic'].map(mode => { const e = $(mode + '-tab'); e.dataset.mode = mode; return e; });
  const pending = [];
  const c = vm.createContext({
    document: { getElementById: $, createElement: () => new Element(), createTextNode: text => ({ textContent: text }),
      querySelectorAll: selector => selector === '[data-mode]' ? modes : [], addEventListener() {} },
    window: { addEventListener() {} }, location: { protocol: 'file:' }, AbortController,
    setTimeout, clearTimeout,
    fetch: (url, options) => new Promise(resolve => pending.push({ url, options, resolve })),
  });
  vm.runInContext(readFileSync(new URL('./app.js', import.meta.url), 'utf8'), c);
  vm.runInContext("liveAvailable = true; switchMode('text');", c);
  $('conversation-input').value = 'Caller: Give me your code.';
  return { c, $, pending };
}
const response = result => ({ ok: true, json: async () => result });
test('speaker-label error identifies and focuses the invalid field, then clears on edit', async () => {
  const { c, $, pending } = app();
  const input = $('conversation-input');
  input.value = 'Give me your code.';
  await c.analyze();
  assert.equal(pending.length, 0);
  assert.equal(input.attributes['aria-invalid'], 'true');
  assert.match(input.attributes['aria-describedby'], /inline-error/);
  assert.equal(input.focused, true);
  assert.equal($('inline-error').hidden, false);
  input.value = 'Caller: Give me your code.';
  c.inputChanged();
  assert.equal(input.attributes['aria-invalid'], 'false');
  assert.doesNotMatch(input.attributes['aria-describedby'], /inline-error/);
  assert.equal($('inline-error').hidden, true);
});
test('server failure does not label valid conversation text as invalid', async () => {
  const { c, $, pending } = app();
  const run = c.analyze();
  pending[0].resolve({ ok: false, json: async () => ({ code: 'ANALYSIS_FAILED' }) });
  await run;
  assert.equal($('conversation-input').attributes['aria-invalid'], 'false');
  assert.equal($('notice-title').textContent, 'Could not assess these words');
});
test('keyboard tabs update selection and hide inactive panels', () => {
  const { $ } = app();
  let prevented = false;
  $('text-tab').listeners.keydown({ key: 'End', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal($('mic-tab').attributes['aria-selected'], 'true');
  assert.equal($('mic-tab').tabIndex, 0);
  assert.equal($('mic-tab').focused, true);
  assert.equal($('text-tab').tabIndex, -1);
  assert.equal($('text-panel').hidden, true);
  assert.equal($('mic-panel').hidden, false);
  $('mic-tab').listeners.keydown({ key: 'Home', preventDefault() {} });
  assert.equal($('sample-tab').attributes['aria-selected'], 'true');
  assert.equal($('sample-panel').hidden, false);
});
test('editing while a request is pending ignores its late warning and clears busy state', async () => {
  const { c, $, pending } = app(); const run = c.analyze();
  $('conversation-input').value = 'Caller: Hello.'; c.inputChanged();
  assert.equal(pending[0].options.signal.aborted, true);
  pending[0].resolve(response({ state: 'flagged', description: 'Old warning' })); await run;
  assert.equal($('mode-status').textContent, 'Typed conversation · Not checked');
  assert.equal($('notice-title').textContent, 'Ready to check this conversation');
  assert.equal($('text-panel').attributes['aria-busy'], 'false');
});
test('rechecking clears previous evidence even when the new response fails', async () => {
  const { c, $, pending } = app();
  $('checked-words').hidden = false; $('checked-words').append({ textContent: 'Old evidence' });
  $('live-evidence').hidden = false; $('live-evidence').append({ textContent: 'Old source' });
  const run = c.analyze();
  assert.equal($('checked-words').hidden, true); assert.equal($('live-evidence').childNodes.length, 0);
  pending[0].resolve({ ok: false, json: async () => ({ code: 'ANALYSIS_FAILED' }) }); await run;
  assert.equal($('notice-title').textContent, 'Could not assess these words');
  assert.equal($('checked-words').hidden, true);
});
test('switching to samples cancels a pending check without replacing sample state', async () => {
  const { c, $, pending } = app(); const run = c.analyze(); c.switchMode('sample');
  pending[0].resolve(response({ state: 'no_flags' })); await run;
  assert.equal($('notice-title').textContent, 'Check this payment request');
  assert.equal($('mode-status').textContent, 'Scripted sample · Ready');
});
test('duplicate analysis clicks create only one request', async () => {
  const { c, pending } = app(); const run = c.analyze(); await c.analyze();
  assert.equal(pending.length, 1); pending[0].resolve(response({ state: 'insufficient_context' })); await run;
});
test('evidence rejects mismatched quotations and non-curated navigation targets', () => {
  const { c, $ } = app(); c.guidance();
  c.renderEvidence({ status: 'checked', spans: [{ start: 0, end: 6, quote: 'FORGED' }],
    sources: [{ url: 'javascript:alert(1)', text: 'Untrusted', title: 'Untrusted' }], checks: [] }, 'Caller: Hello.');
  assert.equal($('checked-words').hidden, true); assert.equal($('live-evidence').hidden, true);
});
test('valid Unicode quotation is rendered as text and incomplete checks retain their label', () => {
  const { c, $ } = app(); c.guidance();
  const text = 'Caller: 📞 <b>code</b>';
  const quote = '<b>code</b>'; const start = Array.from(text).indexOf('<');
  c.renderEvidence({ status: 'unavailable', spans: [{ start, end: start + quote.length, quote }], sources: [], checks: [] }, text);
  assert.equal($('guidance-label').textContent, 'Source check incomplete');
  const paragraph = $('checked-words').childNodes[1];
  assert.equal(paragraph.childNodes[1].textContent, quote);
});

test('each comparison example loads editable labeled words without making an API request', () => {
  for (const name of ['gift', 'ordinary', 'unclear']) {
    const { c, $, pending } = app();
    $('include-evidence').checked = true;
    c.loadConversationExample(name);
    assert.equal(pending.length, 0);
    assert.equal($('example-choice').value, name);
    assert.equal($('conversation-input').value.split('\n').length, 3);
    assert.ok($('conversation-input').value.startsWith('Caller: '));
    assert.equal($('include-evidence').checked, true);
    assert.equal($('mode-status').textContent, 'Typed conversation · Not checked');
    assert.equal($('checked-words').hidden, true);
  }
});
test('loading a different comparison cancels an old check without accepting its late result', async () => {
  const { c, $, pending } = app(); const run = c.analyze();
  c.loadConversationExample('ordinary');
  assert.equal(pending[0].options.signal.aborted, true);
  pending[0].resolve(response({ state: 'flagged', description: 'Old warning' })); await run;
  assert.match($('conversation-input').value, /Do not share/);
  assert.equal($('notice-title').textContent, 'Ready to check this conversation');
});
