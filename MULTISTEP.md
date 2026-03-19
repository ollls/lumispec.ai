# Multi-Step Prompt Tool

## Concept

A structured prompt editor mode in the chat UI. User clicks a button to enter step mode, types prompts as a bullet list, and on submit it gets transformed into a numbered step instruction with an enforcement envelope. Templates store raw bullets; transform happens on submit.

## UX Flow

1. User clicks step-mode toggle button (next to image attach, etc.)
2. Input switches to bullet list editor — Enter creates new bullet, visual indicator shows step mode is active
3. User types each step as a bullet
4. On submit, bullets are transformed to step format and sent as a normal message
5. Tool loop handles execution as usual

## Transform

Raw bullets are converted verbatim — no rewording, no injected phrases. The user's words are the instruction.

```
Input bullets:
• Fetch AMD option chain for next 3 expirations
• Filter for delta between 10-40
• Show as applet with expiration dropdown

Submitted as:
─────────────────────────────────────
Complete the following steps IN ORDER. After each step, confirm completion
before proceeding to the next.

STEP 1: Fetch AMD option chain for next 3 expirations
STEP 2: Filter for delta between 10-40
STEP 3: Show as applet with expiration dropdown

Execute these steps sequentially. Do not skip or combine steps.
─────────────────────────────────────
```

## Why the Envelope Matters

Numbered steps alone (`STEP 1, 2, 3`) are weak — LLMs treat them as a loose suggestion and will merge, skip, or reorder. What enforces sequential execution:

- **Intro**: "Complete the following steps IN ORDER" — sets the contract
- **Confirm gate**: "After each step, confirm completion before proceeding" — prevents rushing ahead
- **Closing**: "Execute these steps sequentially. Do not skip or combine steps." — reinforces

The combination is reliable across models including llama.cpp served models.

## Template Integration

- Save: store raw bullet array in the prompts system (same format as authoring)
- Load: populate the bullet editor with stored bullets
- Submit: same transform applies — template users see bullets, LLM sees steps

## Implementation Scope

**Frontend only** — no backend tool or endpoint needed:

- Bullet editor: contenteditable div or textarea with bullet handling in step mode
- Toggle button in input area to switch between normal and step mode
- JS transform on submit: bullets → step envelope → sent as normal message
- Template save/load uses raw bullet format

## Guidelines

- Works well up to ~7 steps. Soft warning if user writes 10+ bullets.
- One clear action per bullet for best results.
- No auto-rewording of user text — bullets become steps verbatim.
- No sub-steps for v1 (no tab indentation).
- Progress is visible naturally — LLM confirms each step in streamed response.
