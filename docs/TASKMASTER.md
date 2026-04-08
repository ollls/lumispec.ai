# TaskMaster and the Task Pipeline

There are two distinct systems involved when a multi-step request is processed through the bullet-list interface. They are often conflated, but they live in different files and do different things.

## TaskMaster — the prompt decomposer

TaskMaster is the **input-side decomposer**. Given a free-form user prompt, it asks the LLM to rewrite that prompt as a bullet-list of discrete tasks the pipeline can then execute. It does not execute anything itself and does not manage memory.

- **Endpoint**: `POST /api/conversations/:id/decompose` — implementation in `src/routes/conversations.js:638-663`.
- **How it runs**: a single non-streaming `collectChatCompletion` call:
  - System prompt: `getTaskmasterPrompt()` (loaded from `data/TASKMASTER.md` via `src/tools/index.js`)
  - User content: the original user prompt
  - Settings: `temperature: 0.3`, `maxTokens: 1024`, `30s` abort timeout
- **Output**: a bullet-list string. If the LLM returns ≤1 top-level bullet, the route returns `{ tasks, single: true }` and the frontend sends the prompt as a normal chat message instead of running the pipeline.
- **Frontend trigger**: the **Taskmaster** checkbox in the input area routes the next prompt through `/decompose` before submission. Images bypass it.

That is the entirety of TaskMaster. It is a pre-processor that turns prose into a bullet list. The actual execution is the responsibility of the Task Pipeline below.

## Task Pipeline — the executor

The Task Pipeline runs the bullet list (whether produced by TaskMaster or typed by the user). It lives in `src/routes/taskProcessor.js`.

### Two task levels — structure determines context behavior

The task pipeline distinguishes two levels by indentation:

| Level | Syntax | Context behavior |
|---|---|---|
| Top-level | `- task` | **Chained.** Receives the previous step's `result` (string) and `files` (CSVs/JSON the previous step saved). |
| Indented | `  - subtask` | **Isolated from siblings.** Each subtask receives the parent group's incoming context (which is the previous top-level step's output). After all subtasks finish, results are merged with section headers and passed to the next top-level step. The parent bullet's text is added to subtasks as a `## Parent Task` section, but is not executed itself. |

Indentation = sibling isolation. Flat = sequential chaining. There is no per-task setting; the bullet structure is the configuration.

### What each step actually receives

Each step's user message is built in `taskProcessor.js:283-303`:

```js
const llmMessages = [{ role: 'system', content: systemPrompt + pipelinePreamble }];

const contextParts = [];
if (prevResult) {
  // hard-capped at MAX_PREV_RESULT_CHARS = 32000
  const truncated = prevResult.length > MAX_PREV_RESULT_CHARS
    ? prevResult.slice(0, MAX_PREV_RESULT_CHARS) + `\n\n[...truncated from ${prevResult.length} chars]`
    : prevResult;
  contextParts.push(`## Previous Step Output\n\n${truncated}`);
}
if (savedFiles.length > 0) {
  contextParts.push(`## Available Data Files\n${...}`);
}
if (parentText) {
  contextParts.push(`## Parent Task\n${parentText}`);
}

const userContent = `${contextParts.join('\n\n')}\n\n---\n\n## Current Task\n\n${taskText}`;
llmMessages.push({ role: 'user', content: userContent });
```

The system prompt is augmented with a `pipelinePreamble` (`taskProcessor.js:272-281`) that hides future tasks from the LLM and instructs it to complete only the current step. The LLM never sees the full task list — only "you are executing step N of M".

### What this means for memory

- Each step starts with a **fresh `llmMessages` array** (`taskProcessor.js:283`). There is no growing conversation buffer that gets "cleared between steps" — there is nothing to clear, because nothing accumulates across steps in the first place.
- `prev.result` is **bounded at 32000 characters** (`MAX_PREV_RESULT_CHARS`, `taskProcessor.js:12`). Larger results are truncated with a note.
- Tool results during a single step's tool loop accumulate inside that step's local `llmMessages`, then are discarded when the step ends.
- Per-step context is **bounded, not constant**. A step that receives a 32K-char prior result, has its own multi-K-char task prompt, runs through the system prompt, and executes several tool rounds will use far more than a few hundred tokens. The pipeline does not produce a "constant ~500 tokens per task" footprint.

### What flat tasks share

Flat top-level steps **do** share state across steps via `prev.result` and `prev.files`. The task pipeline is not a series of fully isolated single-shot calls. Only sibling subtasks under the same parent bullet are isolated from each other; flat top-level steps chain.

### Tool execution inside a step

Each step runs through the same tool loop as a normal chat conversation: up to 20 tool rounds, parallel-call cap, repeat detection, confirmation flow, and full SSE streaming. Large tool results auto-save to CSV files and the filename is added to `prev.files`, so downstream steps reference the saved file rather than re-receiving its content in `prev.result`.

### Review mode

When the **Review** toggle is on, the pipeline pauses after each completed task (except the last) with **Continue** / **Retry** buttons. Continue accepts the output and proceeds. Retry discards the output, restores `prev` to its pre-task state via the deep copy at `taskProcessor.js:116`, and re-runs the step (fresh LLM call — temperature sampling may produce a different result).

### SSE events

`{task_start}` → `{subtask_start}` → (streaming events) → `{subtask_complete}` → `{task_complete}` → `{task_review}` (if Review is on) → `{task_error}` (on failure, pipeline stops) → `[DONE]`.

## Wiki rebuild — a separate isolation mechanism

`wiki_index` is an ordinary plugin tool in `src/tools/plugin-wiki.js`. **It does not run through TaskMaster, and it does not run through the Task Pipeline.** When the user (or driving LLM) loops `wiki_index` over a list of files, the loop happens inside an ordinary chat conversation.

Wiki's per-file context isolation comes from a different mechanism: a fresh stateless `collectChatCompletion` call inside `indexToWiki()` at `plugin-wiki.js:184-187`:

```js
const { content } = await collectChatCompletion([
  { role: 'system', content: system },
  { role: 'user', content: user },
], { signal: AbortSignal.timeout(90000), maxTokens: 1200, temperature: 0.2 });
```

- Each call sends only `[system, user]` — no conversation history.
- The user message is the file content, hard-capped at `MAX_INPUT = 24000` chars (`plugin-wiki.js:144`).
- Output is capped at `maxTokens: 1200`.

So **per-file** memory is bounded regardless of how many files you index. **However**, the driving conversation does grow: every `wiki_index` tool result lands in the driving LLM's message history (one entry per file, ~1KB each after the markdown truncation in `src/routes/conversations.js:406-418`). For a 20-file rebuild this adds roughly 15-25 KB to the driving conversation context.

This is "context isolation" only in the sense that each summarization call is a fresh stateless completion. It is not provided by TaskMaster and not provided by the Task Pipeline.

## Quick reference

| Question | Answer |
|---|---|
| Where does TaskMaster live? | `src/routes/conversations.js:638` (`/decompose` route), prompt in `data/TASKMASTER.md` |
| Where does the pipeline live? | `src/routes/taskProcessor.js` |
| Does TaskMaster execute tasks? | No. It only rewrites a prompt as a bullet list. |
| Does the pipeline give every task constant memory? | No. Per-step context is bounded (32K-char prior-result cap), but it scales with prior output. |
| Are flat top-level tasks isolated from each other? | No. They chain via `prev.result` and `prev.files`. |
| Are subtasks isolated from each other? | Yes. Sibling subtasks under the same parent each receive only the parent group's incoming context. |
| Does wiki rebuild use the pipeline? | No. It's a tool loop inside a normal chat conversation. |
| Where does wiki's per-file isolation come from? | A stateless `collectChatCompletion` call inside `wiki_index`'s `indexToWiki()` helper. |
