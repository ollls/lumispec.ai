# Troubleshoot — revise an answer against its own evidence

> **In one line:** with `conversation_read` the model can read its own earlier output back — the
> tool results, the applet code, the reasoning — so you ask it to correct that answer instead of
> rerunning the original prompt.

Most chat tools give you two ways to deal with an answer you doubt: ask again and get a fresh
guess, or argue with the model about something it can no longer see. Troubleshoot is a third way.
It points the model at **one specific earlier answer**, hands it the facts recorded about that turn,
and lets it read back what its tools actually returned — so the revision is a check against
evidence, not a second opinion from memory.

It works on any answer, good runs included: "verify the P/E you quoted", "you skipped two of the
eight outlets", "recompute the total from the transactions you fetched".

## Why the model needs help to check itself

When a conversation continues, the model is shown each of its earlier answers as **final text
only**:

| What happened in the turn | What the model sees later |
|---|---|
| Tool calls and their results (searches, pages, quotes, Python output) | nothing — tool rounds are not replayed |
| Its reasoning | nothing, unless **Retain** is on |
| An applet it wrote | `[Applet: html visualization]` |
| A tool that failed, fell back or was truncated | nothing |

So "that number is wrong" used to produce either a confident defence or a rewrite — both from
memory of the question. Everything is still stored with the message; Troubleshoot is the way back
to it.

## Using the button

1. Hover an assistant answer. A red **Troubleshoot** appears at its bottom right. On a turn that
   failed (error, stopped, cut off) it is visible without hovering.
2. Optional: **select text** in that answer first. It is quoted as the part in question.
3. Click. The prompt box fills, with `<what to check or correct>` selected — type over it.
   Anything you had already typed in the box becomes the problem line.
4. Read it, edit it if you like, send. **Nothing is sent until you do.**

The correction arrives as a new answer below. The original stays where it is, so you can compare.

### What lands in the prompt box

```
Troubleshoot your earlier answer (message 14).

Problem: the forward P/E looks too low

Part in question: "NVDA trades at 31x forward earnings"

Turn report (facts, not necessarily defects):
- 11 tool call(s): etrade_account ×7, web_search ×2, web_fetch ×2
- #6 etrade_account → error: transactions failed: API error: 401 nonce_used
- #8 web_fetch → fell back to HTTP (extension timed out); returned a sign-in page
- long results (read one in full with "tool": <index>): #9 web_fetch (7312 chars)
- answer: 4210 chars

First call conversation_read {"what":"tools","message":14} to see what the tools actually
returned in that turn; add "tool": <index> to read one result in full. If the question is why you
answered that way, conversation_read {"what":"reasoning","message":14} returns your reasoning.

Check the answer against that evidence. Correct only what is described above and keep the rest as
it is; if the answer was right, say so plainly instead of changing it. If nothing is described,
ask me what to check instead of guessing.
```

| Part | Where it comes from |
|---|---|
| `message 14` | The bubble you clicked. You never need to know the number. |
| Problem | What you type. Left blank, the model is told to ask rather than guess. |
| Part in question | Your text selection inside that answer (first 400 characters). |
| Turn report | Built in the browser from what is stored with the message — see below. |
| `conversation_read` call | The exact call that returns that turn's tool results. |
| Closing paragraph | Built-in guidance, or your own (next section). |

### The turn report

Facts only — the heading says "not necessarily defects" on purpose. A report with nothing flagged
is normal on a good run.

- how many tools ran, by name, in call order; for a task-pipeline run, tasks and steps
- each tool result that **failed** (`error`), **fell back** to plain HTTP, hit a **sign-in page**,
  was **truncated**, or exited non-zero — numbered `#n`
- results longer than 3,000 characters, with the number to ask for
- whether the turn ended in an error, was stopped, or the answer was cut off at a limit
- pipeline tasks that errored, and hand-offs between steps that were clipped
- the answer's length and how many applets it holds

`#n` is the same number `conversation_read` uses for `"tool": n`.

### Your own wording

Save a prompt titled **Troubleshoot** in the Prompts menu. Its text replaces the closing paragraph
of every Troubleshoot prompt; the message number, your selection, the turn report and the
`conversation_read` call are still added by the button. Delete the saved prompt to get the default
back. Examples:

- *"Verify every number in the answer against the tool results. List each one as confirmed,
  wrong (with the right value) or not found in the data."*
- *"Do not rewrite the answer. Reply with a short list of corrections only."*

## Applets have their own button

Under every applet, next to **Save as Template**, a second Troubleshoot does the same for the
applet itself. Its report comes from the browser — JavaScript errors, failed requests, rendered
height, visible text — and its call is `conversation_read {"what":"applet", …}`, which returns the
applet's exact source. Use that one when the chart is blank or broken; use the answer-level one
when the content is wrong.

## `conversation_read` — the tool underneath

**Read the output back and correct it, instead of running the prompt again.** A rerun repeats
every search, fetch and calculation and may land somewhere else; a read-back keeps the data the
answer was built on and changes only what was wrong.

Always on (core plugin). It returns one slice of an earlier answer **in the same conversation**.
The model calls it; you can ask for it in plain words at any time, without the button.

| Argument | Meaning |
|---|---|
| `what` | `"applet"` (default) — full applet source · `"tools"` — stored tool results · `"reasoning"` — the turn's thinking |
| `message` | Which answer, by position in the conversation. Omitted = the newest answer that has what was asked for. |
| `applet` | Which applet, when an answer holds several. |
| `tool` | Which tool result, returned in full (see limits). |

Limits, so a read-back cannot flood the context:

| Slice | Returned |
|---|---|
| `tools` (list) | newest 12 results, 3,000 chars each, each with its `tool` number |
| `tools` + `tool: n` | that one result, up to 20,000 chars |
| `applet` | full source; several applets over 40,000 chars in total are listed first and read one by one |
| `reasoning` | the last 12,000 chars |

### Asking for it yourself

You do not type the call — you say what you want and the model makes it. Because the default is
"the newest answer that has it", plain requests about the last answer just work:

| You want to | Say something like |
|---|---|
| **Inspect** what a tool returned | "Use conversation_read to show the tool results of your last answer." |
| Read one long result | "Read tool 4 of that turn in full and quote the paragraph about guidance." |
| **Audit** an answer | "Read back your tool results and list every figure in your answer that is not in them." |
| See why it decided something | "Read your reasoning for the last answer — why did you skip the option chain?" |
| **Comment** on its own work | "Read the applet you wrote and explain how it computes the moving average. Don't change it." |
| **Correct** it | "Read your tool results; the dividend dates in your table are off by one row. Fix only that table." |
| Reuse data without re-fetching | "Read the quotes you fetched two answers ago and add a column for % change." |

For an older answer, use its Troubleshoot button — it is the easy way to name the message.

## Good to know

- **It reads what is stored.** Unpinned conversations live in memory and are gone after a server
  restart. **Compact** replaces the messages with a summary — after that there is nothing to read
  back.
- **Reasoning exists only if the model produced it.** Stored reasoning is read with
  `"what":"reasoning"` whether or not Retain was on.
- **The turn of a stopped or failed answer is kept**, with its tool results and reasoning, so those
  are the turns where the report says the most.
- **It costs context.** A read-back puts the old results into the current prompt (about 9K tokens
  for a full 12-result list). That is the point, but it is not free.
- **The original answer is never edited.** A correction is a new answer. Pinned conversations and
  Obsidian exports keep both.
- **Evidence is not truth.** The model checks its answer against what the tools returned. If a page
  it fetched was wrong, the check will agree with the page.

## For developers

| Piece | Where |
|---|---|
| Prompt builder — `turnReport()`, `buildPrompt()`, `turnFailed()`; plain script, `window.Troubleshoot` | `src/public/js/troubleshoot.js` |
| Button on assistant bubbles, `troubleshootMessage()`; applet button, `troubleshootApplet()` | `src/public/js/app.js` |
| `readConversationPart()` — pure, takes the stored conversation | `src/services/conversationRead.js` |
| Tool registration and the routing line | `src/tools/plugin-core.js` |
| Tests | `test/troubleshoot.test.js`, `test/conversationRead.test.js` |

The report is computed client-side from the message's stored `toolUses` / `taskRun` / `reasoning`;
the tool-result numbering follows `toolUsesOf()` (chat tool uses, then each task, then its
subtasks) so a `#n` in the report is `"tool": n` in the call. Round counts, calls dropped by the
parallel cap and context wind-downs are in the route log only and are not in the report yet.
