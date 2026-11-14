# Memories

Facts the assistant keeps across conversations. Off by default: turn on **Memories** in the Plugins
panel.

## Using it

- **Save:** ask in chat — "remember that I prefer metric units". The assistant shows the exact text
  and waits for your approval. Autorun does not skip this prompt.
- **Change:** "update the memory about my home city: I moved to Denver". Saving under the same name
  replaces the old text; the approval prompt shows what it replaces.
- **Forget:** "forget the memory about my coffee order". Also asks for approval. Or use the card:
  hover a row in the Saved memories list, click ✕, then click "Delete?" to confirm. Deleting is
  permanent.
- **See them:** the Memories card in the Plugins panel lists every memory: a painted box in its
  session color ("N/A" when it has none), name, text and date. The chips above the list filter by
  color; with no chip picked ("All") everything is shown. The search box under the chips filters
  by name and text as you type (Escape clears) and works together with the color chips. In chat, "what do you remember?" gives
  the same list as text.

Nothing is saved unless you ask. A web page, file or tool result that says "remember this" is not a
request from you, and the approval prompt is the backstop if the model treats it as one.

## How the assistant uses them

While the plugin is on, every memory has one line at the end of the assistant's instructions, on
every request, in every conversation and in every task-pipeline step. There is no search step.

- A memory of up to 200 characters is carried in full.
- A longer one is carried as its description; the assistant reads the full text when it is relevant.
- The list holds 8,000 characters by default, roughly 50–100 memories. **List size** on the card
  changes that (2,000 to 40,000; about 4 characters per token, so 20,000 is about 5K tokens of every
  request). The note under the field shows how much is in use.
- When the list is full, the oldest memories stay and the newest are left out. The card's status
  line turns amber and says how many do not fit, and those memories are marked "not listed" in the
  card's list. The assistant can still look them up when asked, but does not see them by itself.
  Raise the list size, shorten some memories, or forget ones you no longer need.

With the Claude backend the memories are sent to Anthropic with each request.

## Colors

A memory can be tied to a session color, and only when you ask: "remember this for this kind of
chat". If you never ask, no memory has a color and the checkbox below changes nothing.

**Only memories matching the chat color** (card checkbox, off by default):

| Checkbox | Memory without a color | Memory with a color |
|---|---|---|
| Off | every chat | every chat (the color is stored but ignored) |
| On | every chat | only chats of that color |

"Make that memory global" removes a color.

## Files

One markdown file per memory in `data/memory/` (not in git). You can edit, add or delete files by
hand; the next request picks the change up.

```
---
name: Home city
color: amber
created: 2026-11-14T18:02:11.000Z
updated: 2026-11-14T18:02:11.000Z
description: Where the user lives
---

Lives in Denver since March 2026.
```

`color` and `description` are optional. A file with no header at all also works: its file name is
its name. One memory holds up to 4,000 characters.

## Design notes

- **No retrieval.** Keyword search (as Books uses) misses the cases memory is for: "what should I
  get Anna for her birthday" shares no word with "Anna likes orchids". Listing everything costs
  2–3K tokens at a hundred memories. Embedding-based retrieval becomes worth it at several hundred.
- **Placed last in the system prompt** (`promptTail` plugin hook, just before the final tool-call
  reminder), oldest memory first. Saving a memory re-reads the llama KV cache only from that block
  on, and a new memory is appended after the existing lines.
- **Offered in "Book only" mode** (`alwaysOffered`), like the core tools.
- **Chat color reaches the server** as `session` in the message and task-pipeline request bodies
  and is kept on the conversation (`conv.session`).
- Code: `src/services/memory.js` (storage, prompt block; synchronous), `src/tools/plugin-memory.js`
  (card, `memory` tool), tests in `test/memory.test.js`.
