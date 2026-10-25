# Handoff Detector — plan

**Status:** planned, not started. Written 2026-10-25 against Browser Search as shipped in v1.4.0
(extension 0.4.1, `src/tools/plugin-browser.js`, `src/services/browserBridge.js`).

## Goal

When a Browser Search fetch lands on a page that needs a human — a login form, a one-time code,
a CAPTCHA, a consent or age gate — the hidden tab is brought to the foreground, the user completes
the step in their own Chrome (one click when the password manager has the credentials), and the
fetch then continues as if nothing had happened. Nothing is typed, clicked or submitted by code.

Today such pages end in the thin-page / bot-wall fallback to HTTP, which cannot get past them
either. The user's own observation that triggered this: Bank of America, device pre-authorised,
username and password autofilled, "only click required" — and the hidden tab cannot receive that
click.

## Non-goals

- Automating the login itself (scripted clicks, filling fields). Banks' bot detection is built
  to catch exactly that, their terms forbid it, and a lockout costs more than a handoff saves.
- Solving CAPTCHAs by any means other than the user.
- Changing the HTTP path. Handoff is a Browser Search feature only.

## What triggers a handoff

The detector runs inside the loaded page (same `executeScript` pass that already measures text
and flags bot walls) and returns `{ handoff: null | { kind, reason, confidence } }`. Kinds, in
order of how reliably they can be recognised:

### 1. `login` — a visible password field

- `input[type=password]` that is **visible**: non-zero box, not `hidden`, not inside a
  `display:none` / `visibility:hidden` / `aria-hidden` ancestor, not an off-screen honeypot.
  Open shadow roots and same-origin iframes are walked too; cross-origin iframes cannot be
  inspected (see §Host rules).
- Confirmation signals (any one makes it high confidence; without one, the field must be the
  dominant content of a thin page):
  - `autocomplete="current-password"` / `"username"` on fields in the same form
  - URL path or host matches an auth pattern: `login`, `signin`, `sign-in`, `auth`, `sso`,
    `oauth`, `account/login`, or an identity-provider host (`accounts.google.com`,
    `login.microsoftonline.com`, `login.live.com`, `secure.bankofamerica.com`, …)
  - the page was reached by redirect from the requested URL
  - visible text under ~1,500 chars apart from the form
- Not a trigger on its own: a password field that exists but is hidden (header sign-in menus),
  or a long article with a sign-in box in the chrome.

### 2. `otp` — second factor

- A visible `input[autocomplete="one-time-code"]`, or a short numeric/`tel` input (maxlength ≤ 8)
  next to text matching `verification code|security code|one-time|passcode|authenticator`.
- "Approve in your app" screens with no input: visible text matching
  `approve this sign-in|check your (phone|device)|push notification sent` on a thin page.

### 3. `captcha` — a challenge the user must solve

Structural signals (stable across sites because the vendors are few):
- iframe/script src on `google.com/recaptcha`, `recaptcha.net`, `hcaptcha.com`,
  `challenges.cloudflare.com` (Turnstile), `arkoselabs.com` / `funcaptcha`, `geetest.com`
- containers `.g-recaptcha`, `.h-captcha`, `.cf-turnstile`, `#captcha-form`, `[id*=captcha]`,
  `[class*=captcha]`, `#px-captcha` (PerimeterX), `#challenge-form` / `#challenge-stage` (Cloudflare)
- hidden response fields `g-recaptcha-response`, `h-captcha-response`, `cf-turnstile-response`
- page title `Attention Required|Access Denied|Just a moment|Are you a human|Security check`
Plus the existing text heuristics (`verify you are human`, `are you a robot`, `unusual traffic`,
`press and hold`, `checking your browser`). Engine-specific checks already in `plugin-browser.js`
(Google `/sorry/`, Bing `/turing/`) map to this kind.

A **silent** challenge — the site decides against the browser and serves a degraded page with no
visible test — has nothing to hand off and stays a thin-page fallback.

### 4. `consent` — gates that block content until clicked

- Cookie/privacy walls that hide everything else: a visible dialog containing `accept|agree|consent`
  buttons **and** body text under ~1,500 chars outside it (an ordinary cookie banner over a
  readable article is *not* a handoff; the article is already there).
- Age gates: visible text `are you (over|at least) (18|21)|enter your (date of birth|birth year)`
  with a thin page.
- Region/language interstitials with a single "continue" control and no content.
- Google's consent interstitial (`consent.google.com`, title "Before you continue") — currently an
  engine error; becomes a handoff.

### 5. `paywall` — detected but **not** a handoff by default

Overlay + truncated article (`subscribe|sign in to continue reading`, article text present but
short). Reported as `kind: 'paywall'` so the fallback reason is accurate; handoff only if the
host is on the user's handoff list (the user may well be a subscriber).

### Precedence and scoring

Evaluate in the order captcha → otp → login → consent → paywall; first match wins. Each kind has
a "strong" signal set (sufficient alone) and a "weak" set (needs the page to be thin). This avoids
the two classic false positives: an article with a sign-in menu, and a readable page with a cookie
banner.

## Host rules (the escape hatch)

A small table on the Browser Search card, persisted in `plugins.json` under `browser.hostRules`:

| Pattern | Rule | Effect |
|---|---|---|
| `*.bankofamerica.com` | `handoff` | surface the tab immediately, skip detection |
| `*.chase.com` | `never` | never load in the browser; use HTTP (no cookies) — the privacy guard discussed earlier |
| `reuters.com` | `auto` | default: detector decides |

`handoff` covers sites whose wall lives in a cross-origin iframe or otherwise defeats detection.
`never` is the privacy control for accounts the user does not want the assistant to see. Patterns
are host globs; first match wins; default `auto`.

The two rules are opposites and must not be confused in the UI: `handoff` makes a site *easier*
to read (tab surfaces at once, user clicks Sign in); `never` makes it *unreadable* through the
browser even when the user asks (HTTP without cookies → public login page). Only the user adds
`never` rows; the automatic entry after a successful handoff (Decision 1) is always `handoff`, and
its toast names the rule. When a fetch is refused by a `never` rule, the tool result must say so
in plain words — `host rule "never": <host> is always read without your cookies; change the rule on
the Browser Search card to allow it` — never a generic fetch failure.

## Flow

### Extension (`extension/background.js`, bump to 0.5.0)

1. `runFetch` loads the URL as today. After settle, `extractPage` also returns `handoff`.
2. If `handoff` (or host rule `handoff`) and the request allows it (`interactive: true` from
   the server):
   - `chrome.tabs.update(tabId, { active: true })` and `chrome.windows.update(windowId,
     { focused: true })`; set the badge to `✋`; `chrome.notifications.create` "Lumispec needs you:
     sign in / solve the challenge on <host>, then the fetch continues."
   - send `{ type: 'progress', id, stage: 'handoff', kind, host }` so the server extends its
     timeout and streams a status line.
   - wait for completion: tab URL changes to a non-auth path, **or** the triggering element is
     gone on re-probe (every 1.5 s), **or** the user closes the tab (→ error "handoff cancelled").
     Cap: `HANDOFF_TIMEOUT_MS` (default 120 s) → error "handoff timed out".
   - on completion: wait the normal settle, re-run `extractPage`; if it *still* reports a handoff
     (e.g. password → OTP), loop once more (max 3 stages).
   - return the page with `handoff: { kind, stages, ms }` so the result can say what happened.
   - tab is closed as usual. **If the user was mid-interaction when a second request arrives**,
     the serialized tab chain already queues it.
3. If the request is **not** interactive (searches, or handoff disabled), behave as today: the
   detector result is returned as a hint and the server reports it in the fallback reason
   (`login wall on secure.bankofamerica.com — enable handoff to sign in`).

### Bridge (`src/services/browserBridge.js`)

- New inbound `progress` message: looks up the pending request, resets its timer to
  `handoffTimeoutMs`, and invokes an optional `onProgress(msg)` callback.
- `fetchPage(url, opts)` gains `interactive` and `onProgress`.

### Plugin (`src/tools/plugin-browser.js`)

- `web_fetch` passes `interactive: handoffEnabled` and an `onProgress` that writes a
  `{tool_status}` SSE line via the tool context ("✋ Waiting for you to sign in on
  secure.bankofamerica.com (up to 2 min)…"). **Note:** the tool context today carries only
  `autorun`, `cite`, `confirmFn`; `conversations.js` / `taskProcessor.js` must add a
  `sendStatus(text)` that writes `tool_status` (the pipeline's `buildToolContext` is the single
  place for it there).
- `web_search` stays non-interactive except for engine CAPTCHAs: Google `/sorry/` and Bing
  `/turing/` become `interactive` handoffs when enabled, since solving one clears the engine for
  the session.
- Result gets `handoff: 'login (1 stage, 14 s)'` so the Think stream shows it; no `fallback`.
- Host rules applied before loading: `never` → HTTP path directly with reason
  `host rule: never via browser`.

### UI

- Browser Search card: **Handoff** toggle (default **on**; the whole point is that it is safe),
  and the host-rules table (add / remove rows, pattern + rule dropdown).
- Status line while waiting: the `tool_status` text above, plus the extension badge.

## Privacy and data handling (decide before enabling on bank sites)

- Fetched content enters the conversation, `logs/tools_*.log`, and `data/pinned/<id>.json` if
  pinned. For hosts with rule `handoff` the plugin should **not** write the page content to the
  tool log (log the URL and sizes only), and the UI should warn once when pinning a conversation
  that contains such a fetch. Make this part of the same change, not a follow-up.
- Only the local llama.cpp backend keeps content on the machine; the Claude backend sends it
  with every turn. The card copy should say so next to the Handoff toggle.
- Handoff never submits anything. The extension's `<all_urls>` permission is unchanged.

## Edge cases

- **Password → OTP → device approval** chains: handled by the stage loop (max 3).
- **Login succeeded but redirected elsewhere** (dashboard instead of the requested page): after
  the handoff completes, if the final URL's path differs from the requested one, load the
  requested URL once more in the same tab (session cookies now exist) before extracting.
- **User ignores the tab:** timeout → fallback with `handoff timed out (login on …)`; the
  90 s no-retry cache applies so the LLM does not immediately ask again.
- **Multiple windows:** focus the window that owns the hidden tab; if Chrome is minimised the
  notification is the only cue — mention this in the extension README.
- **Headless / unattended runs** (task pipeline overnight): `interactive` should be forced off
  when no user is present; simplest rule: pipeline steps pass `interactive: false` unless the
  Review toggle is on.
- **Detection false positive on an article with a modal:** the user sees a tab pop up with a
  readable page; closing it cancels the handoff and the page is read as-is (treat "tab closed by
  user" after a false positive as "continue with what we have", not as an error, when text is
  already ≥ 1,500 chars).

## Testing

- **Unit (server, linkedom):** fixture pages per kind — BoA-style login (visible password +
  `current-password`), article with hidden header login (must be `null`), reCAPTCHA / hCaptcha /
  Turnstile / PerimeterX / Cloudflare shells, OTP page, cookie wall vs. cookie banner, age gate,
  paywall overlay. Note the detector itself runs in the browser; keep its logic in a small pure
  function that both the extension and a node test can import (copy the function text at build
  time or keep it in a shared file the extension loads).
- **Bridge (fake extension):** `progress` extends the timeout; handoff result shape; timeout and
  cancel errors; non-interactive request returns the hint only.
- **Live:** Bank of America sign-in (the originating case); Google `/sorry/` after a burst of
  searches; a Cloudflare-fronted site in a fresh profile; Reuters consent; a site with a cookie
  wall. Record timings in the release notes as with v1.4.0.

## Rollout

1. Detector + unit fixtures (server-side function, exported), no behaviour change yet: the
   fallback reason starts naming the wall kind. Ship alone — useful on its own.
2. Bridge `progress` + plugin `sendStatus` plumbing.
3. Extension 0.5.0: surface tab, wait, stage loop, notification. One extension reload.
4. Card UI: Handoff toggle, host rules, privacy copy; log exemption for `handoff` hosts.
5. Docs: `extension/README.md` (what the ✋ badge means, "if Chrome is minimised"), `HELP.md`,
   `CLAUDE.md`, release notes.

## Decisions (2026-10-25)

1. **Remember handoff hosts automatically — YES.** After a successful handoff on a host, the
   plugin adds `<host pattern>` with rule `handoff` to `browser.hostRules` and shows a toast
   ("Added *.bankofamerica.com to handoff hosts — undo"). The next visit surfaces the tab
   immediately, skipping detection. The toast's undo removes the row; the card table remains the
   place to edit it later.
2. **Pipeline: hand off only when the Review toggle is on.** Review already means "the user is
   present to approve each step", so it is the signal that someone can click. With Review off,
   pipeline steps pass `interactive: false` and login/CAPTCHA pages fall back as today. Chat turns
   are always interactive when the Handoff toggle is on.

## Open question

- Does `never` also remove that host from **search results**, or only force direct `web_fetch`
  calls to the cookie-less HTTP path? Recommendation: enforce at fetch only. Every page read goes
  through `web_fetch`, so a `never` host is always read without cookies regardless of how its URL
  was found, and public pages on that host (a bank's rates page) stay usable. One-sentence rule for
  the docs: "never-listed hosts are always read without your cookies."
