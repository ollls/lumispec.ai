# Lumispec Browser Search — Chrome extension

Runs `web_search` queries and `web_fetch` page loads in a hidden tab of **your own Chrome**
and hands the parsed results back to the Lumispec server over a WebSocket. Because the
request comes from a real, logged-in browser, Google and DuckDuckGo answer normally — no
faked headers, no headless Puppeteer.

The extension is loaded "unpacked" straight from this folder. Nothing is uploaded to the
Chrome Web Store and nothing is installed system-wide; removing it is one click.

## What it does

| Piece | Role |
|---|---|
| `manifest.json` | Manifest V3. Permissions: `tabs`, `scripting`, `storage`, `alarms`; host access `<all_urls>` (needed so `web_fetch` can read any page the assistant asks for). |
| `background.js` | Service worker. Keeps a WebSocket to the server, opens an **inactive** tab per request, runs a script inside the page, closes the tab. `search` returns `[{title, url, description}]`; `fetch` returns the live DOM HTML. One hidden tab at a time. |
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

With the Lumispec server running on the default port, the status line should read
**Connected to Lumispec** and the toolbar badge should be clear within a few seconds. If it
says **Not connected**, check the Server field matches `PORT` in `.env` and that the Token
matches `BROWSER_SEARCH_TOKEN` (both empty is fine).

### Switch Lumispec over to the extension

In the Lumispec UI open **Plugins** and turn on **Browser Search**. The regular
**Web Search & Fetch** card grays out while it is on; every `web_search` / `web_fetch`
call now routes to this extension. Turn Browser Search off to get the regular module back
exactly as it was.

Pick the engines on the Browser Search card. They are tried in order and the first one
with results wins, so leaving both DuckDuckGo and Google on means a Google CAPTCHA just
costs a few seconds. If the extension is offline, a request times out, or every engine
fails, Lumispec falls back to the regular HTTP search and says so in the tool result.
The **Browser** dot in the status bar is green while the extension is connected.

### Settings

| Field | Default | Meaning |
|---|---|---|
| Server | `ws://localhost:3000/ws/browser` | WebSocket endpoint of the Lumispec server. Change the port if `PORT` in `.env` is not 3000. |
| Token | empty | Shared secret appended as `?token=` so only Lumispec can drive the browser. Must match `BROWSER_SEARCH_TOKEN` in the server's `.env` (unset on both sides is allowed). |
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
| Badge shows `!` | Not connected to the server. Check the Lumispec server is running, the Server URL port matches `PORT`, and the Token matches `BROWSER_SEARCH_TOKEN`. |
| "Result page did not finish loading within 20s" | Slow network or the engine hung. Retry; if persistent, open the URL manually to see what the engine shows. |
| "Google showed a CAPTCHA" | Google rate-limited this browser. Wait a few minutes, or solve the CAPTCHA once in a normal tab. |
| "No organic results found" | Google changed its result markup. Update the selectors in `parseGoogle` in `background.js`. |
| Tabs stay open | The worker was killed mid-search. Close them by hand; the next search is unaffected. |
| Service worker shows "inactive" on the card | Normal. Chrome suspends idle workers; the alarm and the socket wake it. Click **service worker** on the card to open its console. |

## Security notes

- The extension only reads pages it opened itself, in tabs it closes afterwards. It never
  touches your other tabs. `<all_urls>` is required because `web_fetch` may be asked to
  load any site the search returned; pages open in **your** profile, so a site you are
  logged into will show its logged-in content to the assistant. Disable Browser Search
  for conversations where that is not wanted.
- The server accepts connections from localhost only. Do not point the extension at a
  remote host over plain `ws://`.
- Anything on this machine that can reach the WebSocket endpoint can make this browser
  load pages. Set `BROWSER_SEARCH_TOKEN` in `.env` and the same Token in the popup.
