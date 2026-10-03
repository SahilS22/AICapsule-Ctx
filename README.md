# ◉ Context Capsule

**Your conversation should not be trapped inside the AI that you started it with.**

Context Capsule seals an ongoing AI chat into a small, structured `.contextcapsule` file, then *unseals* it in another AI chat so that model picks up exactly where the last one stopped — with the **minimum sufficient context**, not the whole transcript.

Everything runs locally in your browser. No account, no server, no telemetry. Optional LLM distillation uses *your* API key and is off by default.

```
ChatGPT ──seal──▶ ◉ .contextcapsule ──unseal──▶ Claude ──update──▶ ◉ v7 ──unseal──▶ Gemini
          structured core + memories + full archive        only the context that matters rides along
```

---

## Why this exists

Pasting a transcript into a new AI is slow, expensive and half-effective: the model re-reads 40k tokens of chatter to find the three decisions that matter. Context Capsule treats conversation state as a *data structure*, not a log.

- **Token efficiency is the product.** A handoff is a few hundred to a few thousand estimated tokens, not the raw conversation. The panel shows the reduction per capsule.
- **Continuation must be seamless.** The destination AI must never break character to say *"I can see the context you've shared!"* The handoff carries an explicit behavioural directive, so the model treats the capsule as its own prior work and simply answers the next message.
- **The mechanism must be invisible.** Capsule context never appears in your input box or in the sent bubble. It rides along silently and renders as a file-attachment card — icon, name, token count.

## The handoff UX

| Surface | What it does |
|---|---|
| **Capsule FAB** | Floating 3D glass pill, bottom-right of every supported chat. Halves split open on click. |
| **Quick-pick list** | Panel opens straight onto your stored capsules — one click unseals into the current chat. Each card crossfades capsule → the *source* platform's brand. |
| **Unseal burst** | 2-second screen FX: the pill shatters, shards fly into the composer, the source brand is revealed. |
| **Attachment chip** | Compact card anchored above the input box: source brand, capsule name, `~1.1k tok · rides next msg`. Live states: `✓ delivered` / `⚠ not attached — press send again`. |
| **Sent bubble card** | Your sent message is replaced by an attachment card (brand logo + name + tokens). Click it to expand the exact context the AI received. |
| **Capsule Radar** | Detects when the chat you reopened *is* one of your capsules and pulses the FAB. |
| **Ask my capsule** | One-off targeted retrieval: ask a question, only the matching memories + excerpts attach to your next message. |

Delivery is **verified, never assumed**: text insertion is re-checked after the editor's own model settles (ChatGPT's Lexical and Gemini's ProseMirror both silently revert naive DOM writes), and the chip only reports success with proof.

## The three-tier context model

| Tier | What | When it's injected |
|---|---|---|
| **1 — Core** | Objective, requirements, constraints, decisions, **rejected approaches**, current state, current task, known issues, preferences | Always |
| **2 — Relevant** | Individual memories scored against your query | Only when a query is supplied, budget-permitting |
| **3 — Archive** | The full original conversation, code fences preserved byte-for-byte | Never wholesale — up to 4 verbatim, token-budgeted *deep-recall excerpts* scored against the destination chat |

Default handoff budget is 4,000 estimated tokens; the core is always paid for first, then retrieval, then excerpts with whatever room remains.

## Supported platforms

Content script runs on **12 AI chat hosts**, behind one adapter contract:

| Dedicated adapters | Heuristic generic adapter |
|---|---|
| ChatGPT · Claude · Gemini | DeepSeek · Grok · Perplexity · Meta AI · Microsoft Copilot · Mistral Le Chat · Kimi · Poe · DuckDuckGo AI |

Cross-platform parity is a hard rule: composer targeting, clearing, delivery proof and every UI surface are shared, so a fix to one platform lands on all of them.

Brand marks are **inline SVG generated offline** from the `simple-icons` dev dependency (`scripts/gen-platform-icons.mjs` → `src/ui/platformIcons.ts`). No favicon services, no network requests.

## Optional AI distillation (off by default)

The default extraction engine is the offline heuristic pipeline. If you explicitly enable AI mode, distillation switches to your own account — 12 presets, each with a runtime-resolvable model override:

`OpenAI · Anthropic · Google Gemini · Groq · OpenRouter · NVIDIA NIM · Mistral · DeepSeek · xAI · Cohere · Ollama (local) · LM Studio (local)`

Requests go out from the background worker only when the toggle is on. Nothing is sent anywhere else, ever.

## Privacy & security

- **Permissions:** `storage`, `activeTab`, and the chat/provider hosts you use. No `<all_urls>`.
- **Storage:** IndexedDB (`context-capsule`), whole capsule documents keyed by `id`, `updated_at` index.
- **Redaction at creation *and* export** (`src/security/sanitize.ts`): OpenAI/Anthropic/Google/AWS/GitHub/Slack key shapes, JWTs, PEM private keys, `password=`/`api_key=` assignments, bearer tokens, session ids, card-like numbers.
- **Import is hostile input:** magic header + JSON + schema validation, version ceiling check, size caps, re-sanitisation. A newer capsule is refused with a clear message rather than half-parsed.

## The `.contextcapsule` format

```
CONTEXTCAPSULE 1
{ "version": 1, "project": {...}, "source_platform": "chatgpt",
  "core_context": {...}, "memories": [...], "archive": [...], "history": [...] }
```

Magic header, then pretty-printed JSON. Versioned and migratable (`src/core/versioning/migrate.ts`). `history` holds previous core snapshots, so any version can be restored in one click. A capsule is a plain file: readable, diffable, committable, portable between browsers.

## Architecture

```
src/
  core/               provider-independent engine — pure TS, no chrome APIs, unit-tested
    capsule/          schema + validation, create, incremental update, diff, file format
    extraction/       DOM-agnostic message → memory pipeline (messages, memories, sections)
    memory/           conflict detection & supersede ("use Mongo" → "use Postgres instead")
    compression/      tier-1 core builder
    retrieval/        archive search, deep-recall excerpt picker, context router (handoff builder)
    tokenization/     honest char/4 estimates — always labelled "estimated"
    versioning/       capsule format migrations
    llm/              provider presets + chat client + distillation (opt-in)
  adapters/           PlatformAdapter contract; per-site DOM knowledge isolated here
    base.ts           shared composer resolution (visibleRect / pickComposer), insert, submit
  content/            content script: page bridge + panel host
  ui/panel/           shadow-DOM in-page panel — vanilla TS, zero dependencies
  ui/platformIcons.ts generated inline brand SVGs
  popup/  options/    React surfaces (Vite)
  storage/            IndexedDB persistence
  security/           secret redaction
  background/         service worker: message bus, capsule lifecycle, cross-tab sync
tests/                vitest — extraction, conflicts, file roundtrip, updates, retrieval, redaction, tokens
```

**Two build paths, deliberately.** `popup.html` / `options.html` go through Vite (React). `content.js` and `background.js` are single-file IIFE bundles from esbuild (`scripts/build.mjs`) with CSS inlined as strings — MV3 content scripts cannot load chunks or stylesheets.

**Message bus** (`src/background/background.ts`): `LIST_CAPSULES`, `GET_CAPSULE`, `CREATE_CAPSULE`, `UPDATE_CAPSULE`, `IMPORT_CAPSULE`, `DELETE_CAPSULE`, `RENAME_CAPSULE`, `RESTORE_VERSION`, `REMOVE_MEMORY`, `TOGGLE_PIN_MEMORY`, `GET_HANDOFF`, `OPEN_OPTIONS`, `CLEAR_ALL`, `TEST_AI_PROVIDER`, `LIST_AI_MODELS`. Mutating ops broadcast `CAPSULES_CHANGED` to every tab, so a capsule deleted in one chat disappears from the panel in another immediately — IndexedDB writes emit no storage events.

## Build & run

```bash
npm install
npm run build       # Vite (popup/options) + esbuild (content script, service worker) → dist/
npm test            # vitest
npm run typecheck   # tsc --noEmit
```

Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`.

1. Open a real conversation on any supported AI → the ◉ pill appears bottom-right.
2. **Create Capsule** → watch it seal → **Export Capsule**.
3. Open a different AI → pill → **quick-pick or Import Capsule** → **unseal** → keep working. Your next message carries the context silently.

### Packaging note (Brave / Chromium)

Zip the built folder with **forward-slash entry paths**:

```bash
cd dist && tar -a -cf ../context-capsule-extension.zip manifest.json background.js content.js popup.html options.html icons assets
```

PowerShell's `Compress-Archive` writes backslash separators, which Chromium's extension loader rejects. Loading the unpacked folder is always the more reliable dev path.

## Honest limits

- **Selectors drift.** When a platform ships a UI change, extraction or composer targeting can break. The adapter layer isolates that, and failures surface as an explicit "the platform may have changed its interface" message — never a silent "✓ delivered" lie.
- **Token figures are estimates** (chars ÷ 4). No tokenizer is bundled, so no false precision; every number in the UI is labelled.
- **Heuristics favour precision over recall.** Anything the memory engine missed is still in the archive, searchable and available as verbatim deep-recall excerpts.
- **Generic adapters are best-effort** on the nine heuristic platforms — dedicated adapters exist where the DOM was verified by hand.
- **Unseal is not undo.** Injected context is delivered into a third-party chat; the extension never sees the model's reply.

## Roadmap

Capsule lineage (context that compounds across hops) · cross-capsule retrieval ("ask all my capsules") · capsule merge with conflict resolution · per-destination serialization dialects (XML for Claude, markdown for ChatGPT) · lifetime tokens-saved aggregate · seal-a-selection · token budget control in the chip.

---

*Built as a local-first Manifest V3 extension: TypeScript, React (two pages), a zero-dependency shadow-DOM panel, IndexedDB, and no backend.*
