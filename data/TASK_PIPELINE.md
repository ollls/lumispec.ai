# Task Pipeline: Sequential LLM Execution with Context Isolation

## Overview

The Task Pipeline is a system for breaking complex multi-step workflows into discrete tasks that execute sequentially against the LLM, each with isolated context. Instead of sending a long prompt with all instructions at once (which bloats context and causes the LLM to lose focus), each task runs independently and receives only the output from the previous step.

This keeps context small, responses focused, and gives the user real-time visibility into each step's progress.

## Core Principle: Structure Declares Intent

The task list structure controls context flow. Two levels of bullets express two distinct semantics:

| Level | Syntax | Meaning | Context behavior |
|---|---|---|---|
| Top-level | `- task` | Dependent sequential step | Receives previous step's output (chaining) |
| Indented | `  - subtask` | Independent work under a group | Receives only the parent's incoming context (isolation) |

This is the only control the user needs. No checkboxes, no configuration. Indentation = independence, flat = chaining.

## Task Structure

### Flat Tasks (Chained Context)
```
- search for today's US financial news
- extract key market data: indices, commodities, movers
- create dark mode HTML dashboard with the extracted data
```

Each step depends on the previous. Task 2 receives Task 1's full output. Task 3 receives Task 2's output. Use flat tasks when steps form a pipeline where each builds on the last.

### Nested Tasks (Isolated Context)
```
- Get semiconductor stock data
  - get AMD stock price and daily change
  - get MU stock price and daily change
  - get NVDA stock price and daily change
- Create bar chart comparing daily % changes
```

The parent ("Get semiconductor stock data") is a label — it doesn't execute against the LLM. Its subtasks execute sequentially with full isolation from each other: subtask 2 cannot see subtask 1's output. They all receive the same incoming context (from whatever top-level task came before the group, or nothing if first). After all subtasks complete, their results are merged and passed as context to the next top-level task.

Use nested tasks when the work items are independent (e.g., fetching separate stock quotes) and should be grouped for the next step.

### Choosing Between Flat and Nested

If subtask B needs subtask A's output, don't nest — make them flat:
```
- get AMD price
- analyze AMD price trends based on the price data
- write a summary of the analysis
```

If subtask B is independent from subtask A, nest them:
```
- Gather data
  - get AMD price
  - get NVDA price
- Compare the two stocks
```

The structure is the interface. No toggles or settings needed — the user expresses intent through indentation.

## Context Flow

### Flat Pipeline (Chained)
```
Task 1: [system prompt] + [task 1 text]
          → Result 1

Task 2: [system prompt] + [Result 1] + [task 2 text]
          → Result 2                     ↑ sees task 1 output

Task 3: [system prompt] + [Result 2] + [task 3 text]
          → Result 3                     ↑ sees task 2 output (not task 1)
```

Each step sees only the immediately preceding output. Context stays small.

### Pipeline with Subtasks (Isolated + Merged)
```
                               prevResult from earlier task (or null)
                                          ↓
Task 1 (parent label, not executed):      |
  Subtask 1a: [system] + [prevResult] + [1a text] → Result 1a
  Subtask 1b: [system] + [prevResult] + [1b text] → Result 1b   ← same prevResult, NOT Result 1a
  Subtask 1c: [system] + [prevResult] + [1c text] → Result 1c   ← same prevResult, NOT Result 1b

  Merge: "## 1a\n\nResult 1a\n\n---\n\n## 1b\n\nResult 1b\n\n---\n\n## 1c\n\nResult 1c"
                                          ↓
Task 2: [system] + [Merged] + [task 2 text] → Result 2
```

Subtasks are isolated from siblings — they all receive the same incoming context. After all complete, their results are merged with section headers and passed downstream as a single block.

## How Context Is Framed

Each step receives a pipeline-aware system prompt addition:

```
## Task Pipeline
You are executing Task 2/3 in a sequential pipeline of 3 total tasks.
Another step will handle the rest — you do NOT know what comes next.

CRITICAL RULES:
- Complete ONLY the current task. STOP when done.
- If previous step output is provided, USE it directly — do NOT
  re-fetch or re-search for information already present.
- Produce thorough, data-rich output. Your output is the ONLY
  context the next step will receive.
- If your task is to transform or visualize data — work with
  the provided data, do not gather new data unless clearly insufficient.
```

The LLM never sees the full task list. It only knows which step number it is and that more steps follow. This prevents it from working ahead.

Previous output is framed as a user message:
```
## Previous Step Output

[content from previous step, up to 32K chars]

---

## Current Task

[this step's instruction]
```

## Execution Engine

Each task/subtask runs through the same tool loop as regular chat messages:
- Up to 20 tool rounds per step (web search, file operations, code execution, etc.)
- Repeat detection (max 3 identical tool calls)
- Parallel tool call cap (max 4 per round)
- Malformed tool call retry
- Confirmation flow for destructive operations
- Full SSE streaming of all events

## SSE Event Protocol

```
{task_start: {index, total, text, subtasks?}}  — top-level task begins
  {subtask_start: {taskIndex, subtaskIndex, total, text}}  — subtask begins
    {reasoning: "..."}           — LLM thinking (streamed live)
    {tool_content: "..."}        — intermediate generation during tool rounds
    {tool_use: {name, result}}   — tool execution result
    {tool_status: "..."}         — status for slow operations
    {confirm_command: {command}}  — awaiting user approval
    {content: "..."}             — final answer for this step
  {subtask_complete: {taskIndex, subtaskIndex}}  — subtask done
{task_complete: {index}}         — top-level task done
{task_review: {index}}           — paused for user review (Continue/Retry)
{task_error: {index, error}}     — step failed, pipeline stops
{usage: {prompt_tokens, completion_tokens, total_tokens}}  — totals
[DONE]                           — all tasks complete
```

## Step Review

### The Problem

Stop-on-error catches tool failures, but the more common failure mode with small LLMs is "confidently wrong output" — hallucinated data, misunderstood instructions, or vague responses that look like success. If Task 2 builds on garbage from Task 1, Task 3 builds on worse garbage. The pipeline has no way to validate intermediate outputs without user involvement.

### The Solution: Review Checkpoint

A **Review** checkbox appears in the input area when list mode is active. When enabled, the pipeline pauses after each completed task (except the last) and shows **Continue** / **Retry** buttons.

- **Continue** — accepts the output and proceeds to the next task
- **Retry** — discards the output, restores context to pre-task state, and re-runs the same task

This gives the user a gate between every step to catch bad output before it propagates downstream.

### How It Works

1. User enables the Review checkbox (persisted to localStorage)
2. `review: true` is sent in the POST body to `/api/conversations/:id/tasks`
3. After each task completes, the backend emits `{task_review: {index}}` via SSE
4. The backend pauses on a promise, holding the SSE connection open
5. Frontend renders Continue/Retry buttons in the assistant bubble
6. User clicks a button → frontend POSTs to `/api/conversations/:id/task-review` with `{action: "continue"}` or `{action: "retry"}`
7. Backend resolves the promise and either proceeds or re-runs

On retry, the task's results are discarded and `prevResult` is restored to what it was before the task ran. The task re-executes from scratch with the same context — a fresh LLM call that may produce different output due to temperature sampling.

If the user aborts (closes the connection), pending reviews are automatically cancelled and the pipeline unblocks.

### When Review Is Not Shown

- When the Review checkbox is unchecked (default) — pipeline runs straight through
- After the last task — no point reviewing when there's nothing downstream
- Review is per top-level task, not per subtask — subtasks within a group are independent and their merged result is reviewed as a whole

## Input: Bullet List Editing

Tasks are authored as markdown bullet lists in the chat input textarea.

### Activation
- Click the bullet-list button (left column, above attach image)
- Or paste a multi-line bullet list (auto-detected)

### Keyboard Controls
| Key | Action |
|---|---|
| Enter | New bullet at same indent level |
| Tab | Indent to subtask (2 spaces, max 1 level) |
| Shift+Tab | Outdent subtask to top level |
| Backspace on empty `  - ` | Outdent first, then remove |
| Backspace on empty `- ` (first line) | Exit list mode |
| Ctrl+Enter | Submit tasks for execution |

### Auto-Detection
Pasting text where all non-empty lines start with `- ` or `  - ` (2+ lines) automatically activates list mode.

### UI Changes in List Mode
When list mode is active:
- **Review checkbox** appears next to the Think checkbox (pause after each step for review)
- **Save Prompt button** saves to Tasks menu (not Prompts)
- **Save Session** and **Save Compact** buttons are disabled

## Storage

Task runs are stored as a single assistant message with structured content:

```json
{
  "text": "### Task 1/2: Get stock data\n\n#### AMD\n...\n\n---\n\n### Task 2/2: Create chart\n...",
  "taskRun": [
    {
      "text": "Get stock data",
      "subtasks": [
        {"text": "get AMD price", "result": "...", "toolUses": [...]},
        {"text": "get MU price", "result": "...", "toolUses": [...]}
      ]
    },
    {
      "text": "Create chart",
      "result": "...",
      "toolUses": [...]
    }
  ]
}
```

The `text` field contains backward-compatible markdown — renders correctly even without task-aware code. The `taskRun` field provides structured metadata for enhanced rendering.

## File Exchange Between Steps

### The Problem with Large Data in Context

Financial tools (E*TRADE option chains, portfolio data, transaction history) return large structured datasets — 25+ option contracts with full Greeks, hundreds of transactions, multi-account portfolios. Passing this through `prevResult` text would consume most of the 32K context budget and the LLM would still lose details in the middle of a long text block.

### Auto-Save Mechanism

The tool system has a built-in auto-save for large results. When a tool result exceeds a size threshold, the tool writes the data to a CSV file in the project directory and sets `_autoSaved: true` in the result:

```json
{
  "_autoSaved": true,
  "savedFile": { "filename": "optionchains_1774629187967.csv", "size": 2636 },
  "_note": "50 rows — auto-saved to optionchains_1774629187967.csv. In run_python use: pd.read_csv('optionchains_1774629187967.csv')",
  "_markdown": "# Option Chain (8 contracts)\n\n| Strike | Bid | Ask | Delta | ... (truncated preview)"
}
```

The LLM receives only a truncated preview (first 8-15 rows) plus the filename and a usage hint. The full data lives in the CSV file, accessible via `run_python`.

This is not specific to the task pipeline — it works the same way in regular chat. But it becomes critical in pipelines because data must survive context isolation between steps.

### Automatic File Tracking

The task processor tracks all auto-saved files across the pipeline. When `processOneStep` completes, it extracts filenames from `_autoSaved` tool results and adds them to a cumulative `savedFiles` array.

Each subsequent step receives these files in its system prompt:

```
Files saved by previous steps (available via run_python):
- optionchains_1774629187967.csv (from etrade_account) — 50 rows — auto-saved...
- quotes_1774629100000.csv (from etrade_account) — 3 rows — auto-saved...
```

This provides a safety net: even if the LLM in step N forgets to mention a filename in its text output, step N+1 still sees it in the system prompt and can `pd.read_csv()` it.

### Pipeline Preamble Instructions

The pipeline preamble includes explicit rules about file handling:

- When tools save data to files, ALWAYS include the exact filename in output
- Prefer referencing saved files over embedding large data in the response
- For financial/tabular data: save to file first, then summarize key findings

### Example: E*TRADE Option Chain Pipeline

```
- get AMD current price and option expiration dates for May 2026
- fetch AMD call option chain for the earliest May expiry, strikePriceNear 15% above current price
- read the saved CSV, filter to delta < 0.30, output table with strike, bid, ask, delta, theta, gamma, IV
```

**Step 1:** Calls `etrade_account` with `action: quote` and `action: optionexpiry`. Returns AMD price ($201) and May expiry dates. Small data — passed through `prevResult` text.

**Step 2:** Reads the price from previous output, calculates 15% above ($231). Calls `etrade_account` with `action: optionchains`, `strikePriceNear: 231`. The tool returns 25 contracts — auto-saved to `optionchains_12345.csv`. LLM output mentions the filename + summary.

**Step 3:** Sees the filename in both `prevResult` text AND the "Files saved by previous steps" system prompt section. Uses `run_python` with `pd.read_csv('optionchains_12345.csv')` to load the full dataset, filters `Delta < 0.30`, outputs a clean markdown table. All 14 qualifying strikes preserved — no data lost to context truncation.

The file acts as a **side channel** that bypasses context limits entirely. The LLM context carries the filename (a few bytes) while the actual data (kilobytes) lives on disk.

## API

### Execute Task Pipeline

**Endpoint:** `POST /api/conversations/:id/tasks`

**Request:**
```json
{
  "tasks": [
    "simple task text",
    {"text": "parent label", "subtasks": ["sub 1", "sub 2"]},
    "another simple task"
  ],
  "applets": true,
  "autorun": false,
  "review": true
}
```

Tasks can be strings (simple) or objects with `text` and `subtasks` array (nested). The `review` flag enables pause-after-each-step behavior.

**Response:** SSE stream with events described above.

### Review Response

**Endpoint:** `POST /api/conversations/:id/task-review`

**Request:**
```json
{"action": "continue"}
```
or
```json
{"action": "retry"}
```

Unblocks a paused pipeline. Only valid when a `{task_review}` event is pending.

## Design Decisions

**Why not parallel subtasks?** Sequential execution is simpler and the app runs on a single local GPU with one inference slot. No benefit from parallelism.

**Why hide future tasks from the LLM?** Early testing showed the LLM would read ahead and do Task 2's work during Task 1. Hiding the full list eliminated this.

**Why frame previous output as user message, not assistant?** When previous output was sent as `role: assistant`, the LLM treated it as something it had already said and ignored it. Framing as a user message with explicit "Previous Step Output" headers makes the LLM engage with the data.

**Why 32K char truncation?** With a 65K context window, 32K for previous output leaves room for the system prompt (~4-8K with tools), current task, and tool loop rounds. In practice, most step outputs are well under 32K.

**Why stop on error?** Tasks form a chain where each step depends on the previous. A missing result produces garbage downstream. The pipeline stops, stores partial results, and reports which step failed.

**Why user review instead of auto-validation?** A small LLM validating its own output is circular — it will confidently approve its own hallucinations. Only the user can judge whether the output is actually correct. The Review checkbox adds one click per step but prevents garbage propagation entirely. Off by default so power users aren't slowed down.

**Why retry re-runs from scratch?** The LLM uses temperature sampling, so the same prompt can produce different output. A fresh run often succeeds where the first attempt hallucinated. If retries consistently fail, the user can abort and restructure the task list.
