const $ = id => document.getElementById(id);
const samples = {
  gift: {
    turns: [
      'I have an update about your account.',
      'Government fines must be paid with gift cards.',
      'Buy gift cards and read the numbers to me.',
    ], highlight: 'read the numbers to me',
  },
  ordinary: {
    turns: [
      'There is an account notification for you to review.',
      'Open your banking app yourself. Do not share your password or sign-in code with me.',
      'You can hang up and call the number printed on your card.',
    ],
  },
  unclear: { turns: ['Good afternoon.', 'I have an update about a service you use.', 'I would like to explain a few things.'] },
};
let mode = 'sample', sample = 'gift', turnCount = 3, playing = false, timer;
let samplePaused = false, sampleEpoch = 0, sampleUtterance;
const sampleSpeech = window.speechSynthesis;
let version = 0, liveAvailable = false, busy = false, request;
let recognition, listening = false, recognized = '';
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const iconFiles = { play: 'play', pause: 'pause', check: 'check', chat: 'chat-bubble-left-right', mic: 'microphone' };
function icon(name) {
  $('primary-icon').className = `icon i-${name}`;
  $('primary-icon').src = `./icon-${iconFiles[name]}.svg`;
}
function setNotice(kind, title, detail) {
  $('next-step').hidden = kind !== 'warning';
  $('next-step-text').textContent = 'Pause. Check with a contact you trust.';
  $('notice').className = `notice notice-${kind}`;
  $('notice-icon').className = `icon notice-icon i-${kind === 'warning' || kind === 'error' ? 'warning' : 'info'}`;
  $('notice-icon').src = `./icon-${kind === 'warning' || kind === 'error' ? 'exclamation-triangle' : 'information-circle'}.svg`;
  if ($('notice-title').textContent !== title) $('notice-title').textContent = title;
  if ($('notice-detail').textContent !== detail) $('notice-detail').textContent = detail;
}
function guidance(type = 'unknown') {
  $('live-evidence').hidden = true; $('live-evidence').replaceChildren();
  $('checked-words').hidden = true; $('checked-words').replaceChildren();
  $('guidance-content').hidden = false;
  $('guidance-label').textContent = 'Guidance summary';
  $('publisher').textContent = 'Federal Trade Commission';
  $('source-link').hidden = false;
  if (type === 'gift') {
    $('guidance-text').textContent = 'Government agencies do not demand gift cards as payment.';
    $('source-link').href = 'https://consumer.ftc.gov/avoiding-reporting-gift-card-scams';
  } else if (type === 'ordinary') {
    $('guidance-text').textContent = 'Take time to check an unexpected request through a contact you already trust.';
    $('source-link').href = 'https://consumer.ftc.gov/articles/phone-scams';
  } else {
    $('publisher').textContent = 'No source selected';
    $('guidance-label').textContent = 'Guidance not checked';
    $('guidance-text').textContent = 'Check a conversation to see related guidance.';
    $('source-link').hidden = true;
  }
  $('guidance-footnote').textContent = 'This does not verify who is calling.';
}
function showError(message = '', inputError = false) {
  $('inline-error').textContent = message;
  $('inline-error').hidden = !message;
  $('conversation-input').setAttribute('aria-invalid', String(inputError));
  $('conversation-input').setAttribute('aria-describedby',
    `text-help input-status text-service-note${inputError ? ' inline-error' : ''}`);
}
function renderSample() {
  const selected = samples[sample];
  $('sample-transcript').replaceChildren();
  selected.turns.slice(0, turnCount).forEach((text, index) => {
    const bubble = document.createElement('p');
    bubble.className = 'speech';
    const highlighted = selected.highlight && index === 2;
    if (highlighted) {
      bubble.classList.add('flagged');
      const start = text.indexOf(selected.highlight);
      bubble.append(document.createTextNode(text.slice(0, start)));
      const mark = document.createElement('mark');
      mark.textContent = selected.highlight;
      bubble.append(mark, document.createTextNode(text.slice(start + selected.highlight.length)));
    } else bubble.textContent = text;
    $('sample-transcript').append(bubble);
  });
  if (!turnCount) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy'; empty.textContent = 'The fictional caller will speak in a moment…';
    $('sample-transcript').append(empty);
  }
  if (sample === 'gift' && turnCount >= 3) {
    setNotice('warning', 'Check this payment request', 'The caller is asking for gift card codes.'); guidance('gift');
  } else if (sample === 'ordinary' && turnCount >= 2) {
    setNotice('neutral', 'No flagged requests in this example', 'This sample contains no flagged request. The caller’s identity is unknown.'); guidance('ordinary');
  } else {
    setNotice('neutral', 'More conversation is needed', 'A greeting or general update is not enough to assess a request.'); guidance();
  }
  $('mode-status').textContent = `Scripted sample · ${playing ? 'Playing' : 'Ready'}`;
  refreshAction();
}
// Sample playback: only the fixed fictional lines are spoken.
function stopSample() {
  sampleEpoch++; clearTimeout(timer); playing = false; samplePaused = false;
  sampleUtterance = undefined; sampleSpeech?.cancel();
}
function finishSample() {
  playing = false; samplePaused = false; sampleUtterance = undefined;
  refreshAction(); $('mode-status').textContent = 'Scripted sample · Finished';
}
function sampleAudioError(epoch) {
  if (epoch !== sampleEpoch) return;
  const replayCurrent = Boolean(sampleUtterance?.sampleStarted);
  stopSample();
  if (replayCurrent && turnCount > 0) turnCount--;
  samplePaused = true; refreshAction();
  $('mode-status').textContent = 'Scripted sample · Audio unavailable';
  showError('Sample audio could not play. Try Play again, or select “Text only” to watch without sound.');
}
function tickSample() {
  if (!playing || mode !== 'sample') return;
  if (turnCount >= samples[sample].turns.length) { finishSample(); return; }
  const epoch = sampleEpoch;
  const text = samples[sample].turns[turnCount];
  if ($('sample-text-only').checked) {
    turnCount++; renderSample();
    timer = setTimeout(tickSample, Math.max(2400, text.split(/\s+/).length * 350));
    return;
  }
  if (!sampleSpeech || !window.SpeechSynthesisUtterance) { sampleAudioError(epoch); return; }
  const utterance = new window.SpeechSynthesisUtterance(text);
  sampleUtterance = utterance;
  utterance.lang = 'en-US'; utterance.rate = 0.95; utterance.volume = 1;
  const voices = sampleSpeech.getVoices().filter(voice => /^en([-_]|$)/i.test(voice.lang));
  const voice = voices.find(voice => voice.localService) || voices[0];
  if (voice) utterance.voice = voice;
  utterance.onstart = () => {
    if (epoch !== sampleEpoch) return;
    clearTimeout(timer); utterance.sampleStarted = true; turnCount++; renderSample();
    timer = setTimeout(() => sampleAudioError(epoch), 30000);
  };
  utterance.onend = () => {
    if (epoch !== sampleEpoch) return;
    clearTimeout(timer); sampleUtterance = undefined;
    if (playing) tickSample();
  };
  utterance.onerror = () => sampleAudioError(epoch);
  timer = setTimeout(() => sampleAudioError(epoch), 8000);
  try { sampleSpeech.speak(utterance); }
  catch { sampleAudioError(epoch); }
}
function toggleSample() {
  if (playing) {
    // Cancel and replay the current sentence on resume: avoids engines stuck in pause.
    const replayCurrent = Boolean(sampleUtterance?.sampleStarted);
    stopSample();
    if (replayCurrent && turnCount > 0) turnCount--;
    samplePaused = true;
    $('mode-status').textContent = 'Scripted sample · Paused'; refreshAction(); return;
  }
  showError();
  if (!samplePaused && turnCount >= samples[sample].turns.length) turnCount = 0;
  samplePaused = false; playing = true; renderSample(); tickSample();
}
$('sample-text-only').addEventListener('change', () => {
  stopSample(); turnCount = 0; showError(); renderSample();
});
function invalidate() {
  version++; request?.abort(); request = undefined; busy = false; showError();
}
function stopMic() {
  listening = false;
  const previous = recognition; recognition = undefined;
  previous?.abort();
}
function refreshAction() {
  $('text-panel').setAttribute('aria-busy', String(busy));
  $('primary-action').disabled = false;
  $('restart-action').disabled = false;
  $('restart-label').textContent = mode === 'sample' ? 'Restart' : 'Clear';
  if (mode === 'sample') {
    icon(playing ? 'pause' : 'play'); $('primary-label').textContent = playing ? 'Pause sample' : samplePaused ? 'Resume sample' : 'Play sample';
    $('controls-note').textContent = $('sample-text-only').checked ? 'Text only · Fictional example' : 'Synthetic voice · Fictional example';
  } else if (mode === 'text') {
    icon('check'); $('primary-label').textContent = busy ? 'Checking…' : 'Check with Clocked';
    $('primary-action').disabled = busy || !liveAvailable || !$('conversation-input').value.trim();
    $('controls-note').textContent = liveAvailable ? 'Text is sent to Clocked' : 'Live analysis is off';
  } else {
    icon(listening ? 'pause' : recognized ? 'chat' : 'mic');
    $('primary-label').textContent = listening ? 'Stop listening' : recognized ? 'Review text' : 'Start transcription';
    $('primary-action').disabled = !recognized && (!SpeechRecognition || !$('mic-consent').checked);
    $('controls-note').textContent = 'Review the speaker labels before analysis';
  }
}
function switchMode(next) {
  stopSample(); stopMic(); invalidate(); mode = next;
  for (const tab of document.querySelectorAll('[data-mode]')) {
    const selected = tab.dataset.mode === mode;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    $(`${tab.dataset.mode}-panel`).hidden = !selected;
  }
  if (mode === 'sample') renderSample();
  else if (mode === 'text') {
    setNotice('neutral', 'Check the words, not the caller ID', 'Use a fictional conversation or one you have permission to share.'); guidance();
    $('mode-status').textContent = 'Typed conversation';
  } else {
    setNotice('neutral', 'Speech input needs your permission', 'Transcribe first, then review speaker labels before analysis.'); guidance();
    $('mode-status').textContent = 'Microphone · Off';
  }
  refreshAction();
}
for (const tab of document.querySelectorAll('[data-mode]')) {
  tab.addEventListener('click', () => switchMode(tab.dataset.mode));
  tab.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('[data-mode]')];
    let index = tabs.indexOf(tab);
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault(); switchMode(tabs[index].dataset.mode); tabs[index].focus();
  });
}
function inputChanged() {
  invalidate(); $('mode-status').textContent = 'Typed conversation · Not checked'; $('input-status').textContent = `${$('conversation-input').value.length.toLocaleString('en-US')} / 12,000`;
  setNotice('neutral', 'Ready to check this conversation', 'Check again after changing the conversation.'); guidance(); refreshAction();
}
$('conversation-input').addEventListener('input', inputChanged);
$('include-evidence').addEventListener('change', inputChanged);
function loadConversationExample(name) {
  if (!Object.hasOwn(samples, name)) return;
  switchMode('text');
  $('example-choice').value = name;
  $('conversation-input').value = samples[name].turns.map(text => `Caller: ${text}`).join('\n');
  inputChanged(); $('conversation-input').focus();
}
$('load-example').addEventListener('click', () => loadConversationExample($('example-choice').value));
$('check-this-sample').addEventListener('click', () => loadConversationExample(sample));
async function analyze() {
  if (!liveAvailable || busy) return;
  const text = $('conversation-input').value;
  if (!/^(Caller|Recipient):\s*\S/m.test(text)) {
    showError('Label the speakers with Caller: or Recipient: before checking.', true);
    $('conversation-input').focus();
    return;
  }
  invalidate(); guidance(); const current = version; busy = true; request = new AbortController();
  setNotice('neutral', 'Checking the latest words', 'Please wait for the result.');
  refreshAction();
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, includeEvidence: $('include-evidence').checked }), signal: request.signal,
    });
    const result = await response.json();
    if (current !== version || mode !== 'text') return;
    if (!response.ok) {
      if (result.code === 'LIVE_DISABLED') {
        liveAvailable = false;
        $('text-service-note').textContent = 'Live analysis is off on this server. Scripted samples are still available.';
      }
      throw new Error(result.code || 'ANALYSIS_FAILED');
    }
    if (result.state === 'flagged') setNotice('warning', 'Pause and check this request', result.description);
    else if (result.state === 'review') setNotice('warning', 'This request needs a closer look', result.description);
    else if (result.state === 'insufficient_context') setNotice('neutral', 'More conversation is needed', 'The current words do not establish a concrete request.');
    else if (result.state === 'no_flags') setNotice('neutral', 'No flagged signals so far', 'This does not establish that the caller or request is safe.');
    else throw new Error('INVALID_RESPONSE');
    guidance();
    renderEvidence(result.evidence, text);
    $('mode-status').textContent = 'Clocked analysis · Complete';
  } catch (error) {
    if (current !== version || error.name === 'AbortError') return;
    const descriptions = { LIVE_DISABLED: 'Live analysis is off on this server.', RATE_LIMITED: 'The local request limit has been reached. Please wait before trying again.', INVALID_INPUT: 'Use a nonempty conversation no longer than 12,000 characters.', MISSING_KEY: 'The server-side key is not configured.' };
    setNotice('error', 'Could not assess these words', descriptions[error.message] || 'The check could not finish. Please try again later.');
    $('mode-status').textContent = 'Clocked analysis · Failed';
  } finally {
    if (current === version) { busy = false; request = undefined; refreshAction(); }
  }
}
function renderEvidence(evidence, text) {
  $('publisher').textContent = 'Source review';
  $('guidance-label').textContent = !evidence ? 'Guidance not checked'
    : evidence.status === 'checked' ? 'Claim checked'
    : evidence.status === 'guidance_only' ? 'Related guidance'
    : evidence.status === 'unavailable' ? 'Source check incomplete' : 'No verified comparison';
  const messages = {
    checked: 'The caller’s claim was compared with the guidance below.',
    guidance_only: 'Related guidance was found, but there was no specific claim to check.',
    no_spans: 'No clear request or claim was found to check against the guidance.',
    needs_more_sources: 'More information is needed than these short excerpts provide.',
    no_relevant_sources: 'No matching guidance was found in the two available sources.',
    unavailable: 'The source check could not finish. The request assessment above is separate.',
  };
  $('guidance-text').textContent = evidence ? messages[evidence.status] ?? messages.unavailable
    : 'Select “Also check official guidance” to compare the caller’s words with our sources.';
  if (!evidence) return;
  const chars = Array.from(text);
  const spans = (evidence.spans ?? []).filter(span => Number.isInteger(span.start) && Number.isInteger(span.end)
    && span.start >= 0 && span.end > span.start && span.end <= chars.length
    && chars.slice(span.start, span.end).join('') === span.quote).sort((a, b) => a.start - b.start);
  if (spans.length) {
    const title = document.createElement('strong'); title.textContent = 'Exact words located in your input';
    const transcript = document.createElement('p'); let end = 0;
    for (const span of spans) {
      if (span.start < end) continue;
      transcript.append(document.createTextNode(chars.slice(end, span.start).join('')));
      const mark = document.createElement('mark'); mark.textContent = span.quote; transcript.append(mark); end = span.end;
    }
    transcript.append(document.createTextNode(chars.slice(end).join('')));
    $('checked-words').append(title, transcript); $('checked-words').hidden = false;
  }
  const container = $('live-evidence');
  for (const source of evidence.sources ?? []) {
    // Only locally curated FTC links may become navigation targets.
    if (!['https://consumer.ftc.gov/avoiding-reporting-gift-card-scams', 'https://consumer.ftc.gov/articles/phone-scams'].includes(source.url)) continue;
    const quote = document.createElement('blockquote'); quote.textContent = source.text;
    const link = document.createElement('a'); link.className = 'source-link'; link.textContent = source.title;
    link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    container.append(quote, link);
  }
  const labels = { supported: 'Supported by the supplied excerpt', contradicted: 'Conflicts with the supplied excerpt',
    not_stated: 'Not established by the supplied excerpts', not_a_claim: 'Not a checkable claim' };
  for (const check of evidence.checks ?? []) {
    const line = document.createElement('p'); line.textContent = `${labels[check.verdict] ?? 'Unresolved'}: “${check.claim}”`;
    container.append(line);
    if (check.passage) {
      const passage = document.createElement('blockquote'); passage.textContent = check.passage.quote; container.append(passage);
    }
  }
  container.hidden = !container.childNodes.length;
}
function micAction() {
  if (listening) {
    stopMic(); $('mode-status').textContent = 'Microphone · Stopped'; refreshAction(); return;
  }
  if (recognized) {
    switchMode('text'); $('conversation-input').value = recognized; inputChanged();
    showError('Speech input does not identify speakers. Add Caller: or Recipient: labels and review the words before checking.');
    $('conversation-input').focus(); return;
  }
  if (!SpeechRecognition || !$('mic-consent').checked) return;
  stopMic(); showError(); listening = true;
  const engine = new SpeechRecognition(); recognition = engine;
  engine.lang = 'en-US'; engine.continuous = true; engine.interimResults = false;
  engine.onresult = event => {
    if (recognition !== engine || !listening || mode !== 'mic') return;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) recognized = `${recognized}\n${event.results[i][0].transcript}`.trim().slice(0, 12000);
    }
    $('mic-transcript').textContent = recognized;
    if (recognized.length >= 12000) { stopMic(); $('mode-status').textContent = 'Microphone · Stopped'; showError('The input limit was reached. Review the text before starting again.'); refreshAction(); }
  };
  engine.onerror = () => {
    if (recognition !== engine) return;
    stopMic(); showError('Speech recognition could not continue. Check browser permission or use Type text.');
    $('mode-status').textContent = 'Microphone · Unavailable'; refreshAction();
  };
  engine.onend = () => {
    if (recognition !== engine) return;
    recognition = undefined; listening = false; $('mode-status').textContent = 'Microphone · Stopped'; refreshAction();
  };
  try { engine.start(); $('mode-status').textContent = 'Microphone · Transcribing'; }
  catch { stopMic(); showError('Microphone input could not start. Use Type text instead.'); }
  refreshAction();
}
$('primary-action').addEventListener('click', () => mode === 'sample' ? toggleSample() : mode === 'text' ? analyze() : micAction());
$('restart-action').addEventListener('click', () => {
  invalidate(); stopSample(); stopMic();
  if (mode === 'sample') { turnCount = 0; renderSample(); }
  else if (mode === 'text') { $('conversation-input').value = ''; inputChanged(); }
  else { recognized = ''; $('mic-transcript').textContent = 'Recognized words will appear here.'; $('mode-status').textContent = 'Microphone · Off'; refreshAction(); }
});
$('mic-consent').addEventListener('change', () => {
  if (!$('mic-consent').checked) {
    stopMic(); $('mode-status').textContent = 'Microphone · Off';
  }
  refreshAction();
});
$('sample-picker-open').addEventListener('click', () => $('sample-dialog').showModal());
$('about-open').addEventListener('click', () => $('about-dialog').showModal());
for (const button of document.querySelectorAll('[data-sample]')) button.addEventListener('click', () => {
  stopSample(); sample = button.dataset.sample; turnCount = samples[sample].turns.length;
  $('sample-dialog').close(); switchMode('sample');
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && mode === 'text') { event.preventDefault(); analyze(); }
});
window.addEventListener('pagehide', () => { stopSample(); stopMic(); request?.abort(); });
$('mic-support').textContent = SpeechRecognition
  ? 'Browser speech recognition is available. It has not been verified for real phone calls; speaker separation is not supported.'
  : 'This browser does not provide speech recognition. Type text and scripted samples are still available.';
renderSample();
if (location.protocol !== 'file:') fetch('/api/config').then(response => response.ok ? response.json() : Promise.reject()).then(config => {
  liveAvailable = config.liveAvailable === true;
  $('text-service-note').textContent = liveAvailable
    ? 'Clicking Check sends this text to Clocked. Review speaker labels and use only authorized or synthetic content.'
    : 'Live analysis is off. The scripted samples work without a key.';
  refreshAction();
}).catch(() => { liveAvailable = false; refreshAction(); });
