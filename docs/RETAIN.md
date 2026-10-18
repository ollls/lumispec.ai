# Retain — keep the model's reasoning in context

## Goal

A UI toggle, **Retain**, that sends the model's own thinking (`reasoning_content`) back to
llama-server on every assistant message, so the model sees its prior reasoning in later tool
rounds and later turns. Default **off**.

No context compression is added. The existing 80% wind-down keeps handling the wall gracefully;
Retain only makes the wall arrive sooner on long runs, which is the chosen tradeoff.

## Why no server flag

Verified 2026-09-13 against the running Qwen3.8-27B template (`/props`): assistant turns render as
`<think>\n{reasoning_content}\n</think>\n\n{content}` for **every** message when `preserve_thinking`
is undefined, and llama.cpp treats the kwarg as enabled unless `--no-reasoning-preserve` is passed.
So `--reasoning-preserve` is already effectively on. The template reads only the
`reasoning_content` field — it does not parse `<think>` tags out of `content`. Inlining tags into
content would render an empty think block followed by a second one inside the content. The field is
the only correct channel.

## Changes

### 1. Chat route — `src/routes/conversations.js`

- Read the flag next to the others: `const retain = !!req.body.retain;` (near line 126).
- `streamRound()` (line 231): keep a round-local `roundReasoning` alongside the turn-wide
  `accumulatedReasoning`, and return it: `return { content, usage, finishReason, reasoning: roundReasoning }`.
  Each round's assistant message must carry **its own** thinking, not the running total.
- Every tool-loop push (lines 428, 528, 553, 567, 583, 591, 638, 677) goes through one helper:
  ```js
  const asAssistant = (content, reasoning) =>
    retain && reasoning ? { role: 'assistant', content, reasoning_content: reasoning } : { role: 'assistant', content };
  ```
  Line 638 (`forced.content`, the options-analysis continuation) uses `forced.reasoning` the same way.
- History rebuild (line 212): attach the stored turn reasoning when Retain is on:
  `retain && msg.reasoning ? { role: 'assistant', content: stripped, reasoning_content: msg.reasoning } : { role: 'assistant', content: stripped }`.
  Stored `reasoning` is the whole turn's thinking concatenated across rounds. Tool rounds are not
  replayed in history, so attaching the concatenation to the final message is the only option and
  is acceptable. The flag is read at send time, so toggling Retain off drops all prior reasoning
  from the next prompt; toggling on restores it.
- Storage: nothing changes. `stored.reasoning` (lines 717/732/752) and pinned JSON already persist it.

### 2. Task pipeline — `src/routes/taskProcessor.js`

- Destructure `retain` from `req.body` (line 59) and pass it into `processOneStep()` options
  (lines 136, 187, 273).
- Same round-local reasoning in the step's stream loop (line 339) and the same `asAssistant`
  helper on the pushes at 491, 523, 534, 540.
- Step-to-step context is unchanged: `prev.result` stays content only. Reasoning never crosses
  steps — isolation is the pipeline's contract.

### 3. Token counter — `src/services/llm.js`

- `countPromptTokens()` (line 53) currently reads `content` only. Add
  `if (m.reasoning_content) text += m.reasoning_content + '\n';` in the loop. Without this the
  measured size drifts below the real size by all accumulated thinking, the 80% check fires late
  or never, and the blank-bubble failure the wind-down exists to prevent returns.
- `trimOldToolResults()` stays as is.

### 4. Claude backend — `src/services/llm.js`

- `streamClaudeCompletion` (line 134) and the collect path (line 211): strip `reasoning_content`
  from every message before the request. The Anthropic API rejects unknown message fields. One
  `.map(({ reasoning_content, ...m }) => m)` before `mergeConsecutiveRoles`.

### 5. Frontend — `src/views/index.html`, `src/public/js/app.js`

- Checkbox in the toggle row, immediately after **Think** (Think shows it, Retain keeps it).
  Same `slider-toggle` markup as `precision-toggle-label` (index.html line 346), id `retain-toggle`,
  its own `--slider-color`.
  Tooltip: `Keep the model's reasoning in context for later rounds and turns. Uses more context.`
- `state.retainEnabled` from localStorage `retainEnabled`, default false (app.js line 18 pattern).
- Send `retain: state.retainEnabled` in both POST bodies: chat send (line 1294) and task
  pipeline (line 1636).
- Change handler mirrors precision (lines 2674–2677).

### 6. Docs (working tree only — commits stay code-only)

- `CLAUDE.md`: a "Retain Toggle" subsection next to Think Toggle; add `retain` to the POST body
  list; note that `countPromptTokens` counts `reasoning_content`.
- `docs/FEATURES.md`, `docs/HELP.md`: one line each.

## Verification

1. **Template renders it.** With the server up, POST a two-turn history with `reasoning_content`
   to `http://localhost:8080/apply-template` and confirm both assistant turns show a filled
   `<think>` block, not an empty one.
2. **KV prefix holds.** Run a multi-round tool prompt with Retain on and watch `timings.prompt_n`
   on rounds 2+. It should be roughly "one round's new tokens", not the whole prompt. Compare with
   Retain off, where it re-prefills from the start of the previous assistant turn every round.
3. **Counter sees it.** Log `promptTokens` at the top of each round with Retain on; it must grow by
   roughly the thinking size each round.
4. **Wind-down still fires.** Temporarily set `CTX_WIND_DOWN` to 0.1, run a tool prompt with Retain
   on, confirm the "Context nearly full" status and a real final answer. Restore 0.8.
5. **Toggle off is clean.** Turn Retain off mid-conversation and send a message; the rendered
   prompt (apply-template) must show empty think blocks on every prior turn.
6. **Claude backend.** With `LLM_BACKEND=claude` and Retain on, a message must not return a 400.
7. **Pipeline isolation.** A two-step pipeline with Retain on: step 2's first prompt contains no
   reasoning from step 1.

## Follow-up implemented 2026-09-13: stable prompt prefix

Verification step 2 initially showed ~6,400 processed prompt tokens on **every** turn, Retain on or
off: the system prompt embedded the current time to the second, so the prefix diverged at message
one. Fixed alongside Retain — the stamp now rides on each user message (`getDatetimeStamp()`,
re-derived from the stored `sentAt` on replay) and the system prompt is byte-stable. Measured after
the fix: 6,393 on a cold slot, then 81 / 80 per turn with Retain on; 779 when toggled off (history
re-read without thinking), 90 steady; 1,097 when toggled back on.

## Out of scope

- Any automatic compression or dropping of old reasoning.
- Attaching reasoning to `prev.result` between pipeline steps.
- Per-round reasoning storage for history replay (history keeps the concatenated turn trace).
