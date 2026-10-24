# Lumispec Browser Search — Chrome extension

Runs `web_search` queries in a hidden tab of **your own Chrome** and hands the parsed
results back to the Lumispec server over a WebSocket. Because the request comes from a
real, logged-in browser, Google and DuckDuckGo answer normally — no faked headers, no
headless Puppeteer.

The extension is loaded "unpacked" straight from this folder. Nothing is uploaded to the
Chrome Web Store and nothing is installed system-wide; removing it is one click.

## What it does

| Piece | Role |
|---|---|
| `manifest.json` | Manifest V3. Permissions: `tabs`, `scripting`, `storage`, `alarms`; host access to google.com and duckduckgo.com only. |
| `background.js` | Service worker. Keeps a WebSocket to the server, opens an **inactive** tab per search, runs a parser inside the result page, closes the tab, returns `[{title, url, description}]`. One search at a time. |
| `popup.html` / `popup.js` | Toolbar popup: connection state, server URL + token, enable toggle, and a **Test search** box that works without the server. |

Engines: `duckduckgo` (HTML endpoint, stable selectors) and `google` (organic results
only; detects CAPTCHA and consent interstitials and reports them as errors).

## Install (Chrome, Brave, Edge, or any Chromium browser)

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked**.
4. Select this folder: `<repo>/extension`.
5. The card "Lumispec Browser Search 0.1.0" appears. Optionally click the puzzle-piece
   icon in the toolbar and **pin** the extension so its status badge is visible.

That is all. Host permissions declared in the manifest are granted at load time for
unpacked extensions, so there is no permission prompt.

### Verify it works (no server needed)

1. Click the extension icon to open the popup.
2. In the **Test** row pick `duckduckgo`, type a query, press **Run**.
3. A tab flickers open in the background and closes; results appear in the popup within a
   few seconds.
4. Repeat with `google`. If you see "consent interstitial", open google.com once in a
   normal tab, accept the dialog, and run again.

The status line will say **Not connected** until the Lumispec server side ships (part 2).
That is expected and does not affect the test search.

### Settings

| Field | Default | Meaning |
|---|---|---|
| Server | `ws://localhost:3000/ws/browser` | WebSocket endpoint of the Lumispec server. Change the port if `PORT` in `.env` is not 3000. |
| Token | empty | Shared secret appended as `?token=` so only Lumispec can drive the browser. Must match the server's `.env` once part 2 lands. |
| Enabled | on | Off closes the socket and stops reconnecting. Test search still works. |

Settings are stored in `chrome.storage.local` for this browser profile only.

## Update after editing the code

Chrome does not watch the folder. After changing any file:

1. `chrome://extensions` → find the card → click the **↻ Reload** button.
2. If the popup looks stale, close and reopen it.

`manifest.json` changes also need Reload. A syntax error in `background.js` shows as a
red **Errors** button on the card.

## Disable temporarily

Either flip the toggle on the extension card at `chrome://extensions`, or untick
**Enabled** in the popup and press Save. The popup method keeps the extension installed
but closes the WebSocket.

## Remove completely

1. `chrome://extensions` → find "Lumispec Browser Search" → **Remove** → confirm.
2. Optionally turn **Developer mode** back off.

Removal deletes the extension's stored settings. The folder in the repo is untouched.
There are no other files on disk, no registry or profile entries, and nothing to
uninstall on the server side.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Badge shows `!` | Not connected to the server. Normal until part 2; otherwise check Server URL and that the Lumispec server is running. |
| "Result page did not finish loading within 20s" | Slow network or the engine hung. Retry; if persistent, open the URL manually to see what the engine shows. |
| "Google showed a CAPTCHA" | Google rate-limited this browser. Wait a few minutes, or solve the CAPTCHA once in a normal tab. |
| "No organic results found" | Google changed its result markup. Update the selectors in `parseGoogle` in `background.js`. |
| Tabs stay open | The worker was killed mid-search. Close them by hand; the next search is unaffected. |
| Service worker shows "inactive" on the card | Normal. Chrome suspends idle workers; the alarm and the socket wake it. Click **service worker** on the card to open its console. |

## Security notes

- The extension only ever opens google.com and duckduckgo.com URLs and only reads result
  pages it opened itself. It cannot see or touch your other tabs.
- The WebSocket defaults to `localhost`. Do not point it at a remote host over plain `ws://`.
- Anything that can reach the WebSocket endpoint can make this browser run searches.
  Set a Token once part 2 enforces it.
