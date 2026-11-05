# Hang Up Meter

Before acting on an unfamiliar caller’s request, inspect the exact words and compare a claim with official consumer guidance. Hang Up Meter is a working prototype for the Clocked Build Challenge.

**[Try the live app](https://hang-up-meter-ue5lzmopwq-du.a.run.app)** — no app account is needed. The first load after inactivity may take a few seconds.

To review the core flow, select **Type text**, load **Gift card request**, enable **Also check official guidance**, and press **Check with Clocked**. Then compare **Routine account check** and **A vague update** with guidance off. These are fictional examples; each Check requests a live analysis. Loading an example alone does not use the API.

## Current status

The app supports authored sample playback, typed English conversations, and optional source checks using Decide, Extract, Rerank and grounding. Real HTTP tests and four live smoke cases passed. Native Chrome verified a live warning, matching input spans, FTC guidance and a claim comparison, plus clearing old results after editing.

A frozen synthetic evaluation completed 40 conversations / 120 cumulative inputs: 20/20 risk conversations detected, no early risk alerts, and 1/20 control conversations falsely alerted. One original response-read failure was recovered under the same request ID. These are synthetic results, not real-call accuracy. See [본평가결과.md](본평가결과.md) for conditions and limitations.

The false alert came from a recipient-only recollection. A post-evaluation application guard now returns insufficient context without calling the API when no Caller turn exists. Its offline and in-memory route checks pass; the updated four-case real HTTP smoke run passed. Before the latest sample-audio changes, 66 tests passed with real local HTTP sockets (54 logic tests + 12 route tests). A fresh server run confirmed the guard. On November 6, the updated offline and in-memory suites pass 80 tests (68 logic/playback/frontend + 12 route tests); Claude subsequently reported all 80 tests passing with real HTTP sockets before the November 6 deployment. Three additional synthetic checks on the public app passed: a gift-card request with source comparison, a routine account message, and insufficient context. Input validation, clearing results, and a disconnected-network failure were checked in Chrome.

The selected visual reference is 디자인_개선_2.png. Scripted examples are authored, not API results. Public deployment and the three live checks are complete. A 320px action-label clipping issue has a local CSS fix pending deployment and visual recheck. Microphone quality, full screen-reader testing, repository publication, and video recording remain unfinished.

## Run locally

Requires Node.js 24 or later; no external package installation is needed.

```sh
npm start
```

Open http://127.0.0.1:4173. Live analysis defaults to off. Opening index.html directly provides a scripted preview without API calls.

For live checks, set CLOCKED_API_KEY on the server or in the untracked .env.local. Keep paid overage off and confirm free credits before running:

```sh
npm test
node verify-live.mjs --live --free-credits-confirmed --serve
```

The verifier checks four cases, including recipient-only input, and keeps port 4174 open only when all pass. Its observed budget is 50 credits, not a hard provider billing cap. Never put the key in frontend code, source control, video, or screenshots.

## Verification

```sh
npm run test:offline
npm run test:handlers
node evaluate.mjs
node run-evaluation.mjs
```

These commands use fake transports or validate the evaluation plan; they do not measure live model quality. npm test additionally uses real local HTTP sockets. Live evaluation requires explicit flags, free-credit confirmation and a frozen plan; use node run-evaluation.mjs --help. Resume reports retain the original failure and identify recovery-only timings. Never combine recovery latency with uninterrupted response timing without disclosure.

## Preparation materials

| Material | File |
|---|---|
| Product plan | [기획.md](기획.md) |
| Challenge and competitor research | [조사.md](조사.md) |
| Product review | [기획검토.md](기획검토.md) |
| Design review | [디자인검토.md](디자인검토.md) |
| Displayed concepts | [1](디자인_1.png), [2](디자인_2.png), [3](디자인_3.png) |
| Latest revised concepts | [1](디자인_개선_1.png), [2](디자인_개선_2.png), [3](디자인_개선_3.png) |
| Latest design review | [디자인_개선_검토.md](디자인_개선_검토.md) |
| Frontend prototype and QA status | [index.html](index.html), [design-qa.md](design-qa.md) |
| Generation prompts | [디자인프롬프트.md](디자인프롬프트.md) |
| API design | [API설계.md](API설계.md) |
| Synthetic conversations | [평가대본.md](평가대본.md) |
| Attributed official excerpts | [official-sources.json](official-sources.json) |
| Verification plan and results | [검증계획.md](검증계획.md), [검증결과.md](검증결과.md) |
| Rule checklist | [규칙대조표.md](규칙대조표.md) |
| Provisional submission and video copy | [제출초안.md](제출초안.md), [시연대본.md](시연대본.md) |
| Work record and handover | [개발기록.md](개발기록.md) |

## Limitations and credits

The conversations are synthetic, not a representative real-call benchmark. No flagged signals will not establish safety; a source match will not establish a caller's identity. Microphone quality and full assistive-technology behavior remain unverified. Speech input does not separate speakers. Measured synthetic text results are described separately above. The intended audio setup uses a separate computer near a speakerphone. Audio may go to the browser's speech provider and text will go to Clocked.

Research, preparation, code, and tests were created with OpenAI Codex assistance. Static design concepts were generated with the built-in image generation tool. Prompts and source references are included. Competitor code and assets were not reused.

Manrope is bundled from Google Fonts with its OFL license, and the UI icons are Heroicons with their MIT license. The phone mark was generated from the selected visual reference. The environment blocked .git creation. The work record is not presented as a substitute for required public repository development history. No remote repository exists. The deployment report records 80 passing tests and private-path 404 checks; public live analysis was subsequently verified.


### HTTPS hosting configuration

Set `HANGUP_PUBLIC_ORIGIN` to the exact public HTTPS origin (for example, `https://your-app.example`, without a trailing slash). The server checks the browser Origin against this configured value, including behind a TLS proxy; it does not trust forwarded headers. Without it, only local same-origin analysis is allowed. Start with `node server.mjs --host 0.0.0.0`; `PORT` is supported. Live analysis still requires both existing HANGUP flags and the server-side key.


### Sample audio

Play sample reads the fictional English caller lines using the browser's speech synthesis. Pause stops speech; Resume replays the interrupted sentence. Restart clears playback. Choose Text only (no sound) for silent playback. Voice availability and sound output depend on the browser and device. Sample playback does not call Clocked and is not a live analysis result.


### Compare requests

Use “Check these words with Clocked” to move a sample into editable text, or choose a gift-card request, routine account check, or vague update under “Try a conversation.” Loading an example does not send it to an API. Review the words, optionally select official guidance, then press Check. Live analysis must be enabled on the server; file previews only support the local interaction.

## Deployment

The public demo runs on Google Cloud Run (single instance, scales to zero) with `node server.mjs --host 0.0.0.0`; see `Dockerfile`. Live analysis is enabled only when the server has `CLOCKED_API_KEY`, `HANGUP_ENABLE_LIVE=1`, `HANGUP_FREE_CREDITS_CONFIRMED=1`, and `HANGUP_PUBLIC_ORIGIN` set. No key is stored in this repository.

## Development history

This repository's Git history starts at its public release on November 6, 2026. Earlier work on this project was done in a local folder without Git; it is summarized in `개발기록.md` and is not represented as earlier commits.

## License

Code: MIT, see `LICENSE`. Bundled font and icons keep their own licenses (see above).
