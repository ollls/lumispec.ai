# Google Search Scraping — Technical Analysis

## Goal
Scrape Google search results programmatically without API keys, using got-scraping for browser impersonation.

## Current Stack
- `got-scraping` v4.2.1 (Apify) — TLS fingerprinting, header generation
- `tough-cookie` — cookie jar management
- `linkedom` — HTML parsing
- `vm` (Node built-in) — sandboxed JS execution for challenge solving

## What Happens When You Search Google

### Request Flow
1. **GET** `https://www.google.com/search?q=...&hl=en`
2. Google returns a **JS challenge page** (~89KB), not search results
3. The page contains 5 inline `<script>` blocks — no external scripts

### Challenge Page Structure

| Script | Size | Purpose |
|--------|------|---------|
| 0 | 81B | Init `window.google.c` |
| 1 | 92B | Timing flag (`sctm`) |
| 2 | ~62KB | Challenge solver module ("knitsail") — defines `C.knitsail.a = LB` |
| 3 | ~25KB | Challenge trigger + cookie/redirect logic |
| 4 | 236B | 2s fallback `sg_trbl` beacon (diagnostic only) |

### Challenge Variables (Script 3)
```
var r = '1';              // version
var ce = 30;              // cookie expiry (seconds? maybe 300)
var sctm = false;         // timing enabled
var p = '<16KB blob>';    // encrypted challenge payload
var g = 'knitsail';       // solver module name
var eid = '<session id>'; // unique per request
var ss_cgi = false;       // CGI fallback flag
var sp = '';              // empty (sgs path)
var content_bindings = [];
var challenge_version = 0;
```

### Challenge Execution Flow
```
fa()
  → ca(successCallback, errorCallback)
    → D[g].a(p, innerCallback)     // D = C = global; g = 'knitsail'
      → knitsail solver processes encrypted payload `p`
      → innerCallback(solvedToken)
    → successCallback(solvedToken)
      → Format: challenge_version > 0 ? "B.<ver>.<cbs>.<token>" : token
      → Set cookie: SG_SS=<token>; expires=<ce seconds>
      → P()  // timing beacon (fire & forget, often fails silently)
      → Route check:
          if (ss_cgi || document.cookie missing SG_SS) → U(token)  // token in URL
          else → V(T())  // cookie-only redirect
            → T() builds: /search?<original_params>&sei=<eid>
            → V() calls window.prs(url) or location.replace(url)
```

### Response Cookies (Set-Cookie from challenge page)
| Cookie | SameSite | Secure | HttpOnly | Expiry | Purpose |
|--------|----------|--------|----------|--------|---------|
| `__Secure-STRP` | strict | yes | no | 5 min | Challenge session token |
| `AEC` | lax | yes | yes | 6 months | Abuse/bot detection |
| `NID` | none | yes | yes | 6 months | Preferences/tracking |

### Beacons
- **P() timing beacon**: `/gen_204?s=<sn>&t=sg&atyp=csi&ei=<kEI>&rt=<timing_data>` — rarely fires (needs `google.sn`/`google.kEI` which aren't set in the challenge page)
- **sg_trbl beacon** (Script 4): `/gen_204?cad=sg_trbl&ei=<eid>` — fires after 2s timeout as a "challenge still showing" diagnostic
- **Error beacon**: `/gen_204?cad=sg_b_e&e=<error>` — fires on challenge solve failure
- All sent via `navigator.sendBeacon()` (fire & forget POST, not blocking)

## What We Implemented

### VM-based Challenge Solver
Execute scripts 0-4 in a Node `vm.createContext` sandbox with minimal browser mocks:

**Required mocks:**
- `window` / `self` / `globalThis` — circular reference to context
- `google` — `{ c: { cap: 0, fbts: 0, e: () => {} }, tick: () => {}, rdn: false }`
- `document.cookie` — getter/setter (capture SG_SS when set)
- `document.getElementById` — returns element mock with `classList`
- `document.createElement` — returns element mock with `classList`
- `document.body` — element mock with `classList` (**critical** — solver checks `classList` existence, takes different code path without it, skips function definitions like `VZ`)
- `document.documentElement` — element mock
- `navigator.sendBeacon` — no-op returning true
- `navigator.userAgent` — should match request headers
- `location.href` / `location.search` / `location.replace` — capture redirect URL
- `setTimeout` — real, but capped: `setTimeout(fn, Math.min(ms || 0, 100))`
- `performance` — `{ now: () => Date.now(), getEntriesByType: () => [], navigation: { type: 0 } }`
- `screen` — `{ width: 1920, height: 1080, colorDepth: 24, ... }`
- `crypto` — passthrough from `globalThis.crypto`
- `atob` / `btoa` — passthrough from `globalThis`
- All standard JS built-ins (Array, Object, Promise, Map, Set, Proxy, Reflect, typed arrays, BigInt, etc.)

**classList is critical:** The knitsail solver (script 2) checks `u.classList` at branch `f==86`. Without it, `f` goes to 33 instead of 88, skipping the definition of internal function `VZ`. Later when the solver tries to call `VZ()`, it fails with `VZ is not a function`. The error gets encoded into the SG_SS token value (`SG_SS=E:VZ is not a function:TypeError`), producing an invalid cookie. This was discovered when testing HTTP/1.1 — the solver code is identical for both HTTP versions, but HTTP/2 happened to work without classList due to a different initialization path. The fix: mock elements with `classList` that has `add()`, `remove()`, `contains()`, `toggle()`.

**Not needed** (verified via Proxy tracing): canvas, WebGL, AudioContext, WebRTC, plugins, webdriver, deviceMemory, hardwareConcurrency

**Result:** Challenge solves successfully in ~100ms, produces valid `SG_SS` cookie.

### Token Validation (VM vs Browser)
Tested by serving the same challenge HTML page via localhost, intercepting `document.cookie` setter in the browser to capture the SG_SS token, and comparing with VM output. **Tokens are structurally identical.**

| Source | Prefix (random) | Core (deterministic from payload) |
|--------|-----------------|-----------------------------------|
| Browser run 1 | `*fECaQBry` | `AAb7TqnL2059RR-WoS3YvI8EAEABEArZ1CVCeADO0igXF...` |
| Browser run 2 | `*VWmaaTPy` | (same) |
| Browser run 3 | `*sIyajNby` | (same) |
| Browser run 4 | `*ck6aThTy` | (same) |
| VM | `*x_ua-6Hy` | (same) |

The first ~8 bytes are **random/time-dependent** (change every execution, even in the same browser). The rest is deterministic from the challenge payload `p`. The VM produces tokens indistinguishable from browser-generated ones.

**Conclusion: The token is NOT the problem. The server-side rejection is based entirely on HTTP connection characteristics, not the SG_SS value.**

### Session Consistency
- `sessionToken` option in got-scraping: shared object across requests → caches generated headers in a WeakMap → identical User-Agent and sec-ch-ua on both requests
- `CookieJar` from tough-cookie: accumulates all Set-Cookie headers from challenge page + our SG_SS addition
- Redirect URL captured from `location.replace()` callback (includes `&sei=<eid>`)
- Step 3 sends `referer` (challenge page URL) + `sec-fetch-site: same-origin` + `sec-fetch-mode: navigate`

## What Works
- ✅ Challenge page fetched (got-scraping TLS fingerprinting bypasses initial detection)
- ✅ Challenge solved in VM (produces valid SG_SS cookie value — **confirmed identical to browser tokens**)
- ✅ Headers identical between requests (sessionToken caches them)
- ✅ All cookies sent on follow-up (__Secure-STRP, AEC, NID, SG_SS)
- ✅ Correct redirect URL used (with `&sei=` from solver's `location.replace()`)
- ✅ Browser-like navigation headers (referer, sec-fetch-site: same-origin)
- ✅ Beacons are not required (P() doesn't even fire in practice)
- ✅ classList DOM mocks enable solver to work on both HTTP/1.1 and HTTP/2 paths

## What Fails
The second request (with cookie) returns **302 → `/sorry/index?...`** (Google's CAPTCHA/block page):
- Response explicitly **deletes** SG_SS: `SG_SS=0;Expires=Mon, 01-Jan-1990`
- This is **server-side rejection**, not a client-side check
- Happens regardless of: timing delay (0s, 2s), header pinning, cookie completeness, connection reuse, HTTP version (1.1 or 2)

### Ruled out as causes:
- **Token validity** — VM tokens are structurally identical to browser tokens (confirmed by comparison)
- **Header mismatch** — sessionToken ensures identical UA/sec-ch-ua across requests
- **Missing cookies** — all 4 cookies sent correctly (__Secure-STRP, AEC, NID, SG_SS)
- **Wrong redirect URL** — using exact URL from solver's `location.replace()` with `&sei=`
- **Timing** — tested with 0s and 2s delay, no difference
- **Missing beacons** — P() timing beacon doesn't fire even in the real challenge flow
- **sec-fetch headers** — tested with same-origin + navigate + referer, no difference

### Remaining theory:
Google validates something at the **TLS/HTTP2 connection layer** that got-scraping doesn't match:
- JA3/JA4 TLS fingerprint doesn't match any known Chrome version
- HTTP/2 SETTINGS frames, HPACK encoding, stream priority differ from real Chrome
- Or simply: the TLS fingerprint of the first request (challenge) is cross-referenced against a whitelist, and got-scraping's fingerprint isn't on it

## HAR Analysis — What a Real Chrome Sends

Captured from a real Chrome 146 — **fresh session, zero cookies, no login**. Entry 0 returns 200 with results directly (no challenge).

### Headers That Real Chrome Sends (We Don't)

**Browser integrity headers (Chrome-internal, not from JS):**
```
x-browser-channel: stable
x-browser-copyright: Copyright 2026 Google LLC. All Rights reserved.
x-browser-validation: mS0s+folUUd5dt5EirZjyPAZQ5A=    ← cryptographic proof of real Chrome
x-browser-year: 2026
x-client-data: CI+2yQEIprbJAQipncoBCJrx...            ← encoded experiment/variation data
```

**Extended Client Hints (requested via `Accept-CH` response header):**
```
sec-ch-ua-arch: "x86"
sec-ch-ua-bitness: "64"
sec-ch-ua-form-factors: "Desktop"
sec-ch-ua-full-version: "146.0.7680.153"
sec-ch-ua-full-version-list: "Chromium";v="146.0.7680.153", "Not-A.Brand";v="24.0.0.0", "Google Chrome";v="146.0.7680.153"
sec-ch-ua-model: ""
sec-ch-ua-platform-version: ""
sec-ch-ua-wow64: ?0
sec-ch-prefers-color-scheme: dark
```

**Network quality hints:**
```
downlink: 1.55
rtt: 50
```

**Other:**
```
dnt: 1
priority: u=0, i
referer: https://www.google.com/
available-dictionary: :s21+9XTB/J/yCVMZM214yPi7ipFvgobheUno4Ol/PIk=:
```

### Key Insight: `x-browser-validation`
This is a **cryptographic browser attestation token** generated inside Chrome's binary — not accessible via JavaScript or HTTP libraries. Google uses it to verify the request comes from a genuine Chrome browser. This is likely why:
- Logged-in Chrome → no challenge (has `x-browser-validation`)
- got-scraping → challenge page (no attestation)
- After challenge solve → still rejected (challenge is a fallback path, but server-side still validates something we can't provide)

### Request Pattern After Page Load (122 requests total)
| Time offset | Count | Type |
|-------------|-------|------|
| 0ms | 1 | Search request (GET /search) |
| ~120-500ms | ~30 | JS chunks, CSS, fonts, images (xjs, gstatic, fonts) |
| ~500ms | 1 | First gen_204 beacon (timing: aft.409) |
| ~680ms | 1 | Second gen_204 beacon (all timings) |
| ~700ms | 1 | client_204 (viewport/device info) |
| ~880ms | 1 | gen_204 (search latency hint) |
| ~1000ms | 8 | Map tiles, ad tracking, autocomplete |
| ~1100ms | 10+ | More JS chunks, YouTube embed |
| ~5000ms | 1 | YouTube log_event |

A real browser generates ~120 sub-resource requests within the first 2 seconds. We send exactly 1 (the search). This is trivially detectable.

## Theories for Server-Side Rejection

### 1. Missing browser attestation (most likely)
The `x-browser-validation` header is a Chrome-internal cryptographic token. Google can verify the request comes from genuine Chrome. Without it, the request enters the challenge path. After challenge solve, the SG_SS cookie may still require attestation context that we can't provide.

### 2. Challenge token validation
The SG_SS cookie value may encode information that Google validates server-side against the original challenge session. The `__Secure-STRP` cookie (5-min expiry, SameSite=strict) from the challenge page may be the binding token.

### 3. HTTP/2 fingerprinting
HTTP/2 has its own fingerprint — SETTINGS frame values, WINDOW_UPDATE, PRIORITY frames, header compression context (HPACK). got-scraping may produce HTTP/2 frames that don't match a real Chrome browser.

### 4. Request pattern detection
Google may flag: single search request with no sub-resources as a bot pattern. Real browsers make ~120 requests within 2s.

### 5. TLS session ticket binding
The server may validate that the TLS session ticket matches what was issued during the challenge.

## Potential Next Steps

### A. Try sending `x-browser-validation` and `x-client-data`
Extract these headers from a real Chrome session (HAR) and include them in got-scraping requests. They may be session-bound or time-limited, but worth testing if they bypass the challenge entirely.

### B. Investigate `x-client-data` encoding
This is a base64-encoded protobuf containing Chrome experiment/variation IDs. Tools exist to decode it (e.g. `chromium-client-data-decoder`). If it's static per Chrome version, we can hardcode it.

### C. Use curl-impersonate
`curl-impersonate` clones Chrome's exact TLS and HTTP/2 fingerprint (SETTINGS frames, HPACK context, everything). Can be called as a child process from Node. This would eliminate theories 3 and 5, but not 1 (attestation).

### D. Puppeteer/Playwright (nuclear option)
Run a headless Chrome instance. Guaranteed to work since it IS Chrome. Heavy (~200MB), slow (~3-5s per search), but proven. Can use `puppeteer-extra` + stealth plugin to avoid headless detection.

### E. Hybrid approach
Use Puppeteer once to establish a trusted session (with all Chrome-internal headers), extract the full cookie set, then reuse those cookies with got-scraping for subsequent searches until they expire. Amortizes the Puppeteer cost across multiple searches.

## File Locations
- Plugin: `src/tools/plugin-web.js` — `searchGoogle()`, `solveGoogleChallenge()`, `parseGoogleResults()`
- Health: `src/routes/health.js` — `google` engine entry
- Config: `src/config.js` — `search.engine` supports `'google'`
- got-scraping source: `got-scraping/` (cloned repo)
- Browser headers: `BROWSER_HEADERS` constant in plugin-web.js (pinned Chrome 131 identity)
