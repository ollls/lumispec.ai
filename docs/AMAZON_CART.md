# Amazon Cart

The assistant searches Amazon, reads your cart and puts items into it — in your own Chrome, signed
in as you, through the Lumispec Browser Search extension. **It never buys.** You review the cart
and check out on Amazon yourself.

**Experimental** — the card says so in red. Off by default, and off again after every restart of
the app: its on/off state is deliberately not kept, so you enable it each time you want to use it
(your site and pacing settings are kept). Turn on **Amazon Cart** in the Plugins panel (it switches
Browser Search on with it). Needs extension 0.9.0 or later: after updating, reload the extension at `chrome://extensions`.

## What you can ask

- "Find a 6 ft USB-C cable on Amazon" → `amazon_cart` `search`: picture, title, price, rating,
  delivery, ASIN; sponsored results are marked. The pictures show in the tool result itself.
- "Tell me more about the Anker one" / "show its pictures" → `product`: price, seller,
  availability, rating, feature list and up to six gallery pictures, from one page load.
- "What is in my Amazon cart?" → `view`: the active cart with quantities and subtotal (Saved for
  later is counted, not listed).
- "Add the Anker one to my cart" → `add`: one item, quantity 1–10.

## What happens on an add

1. The product page is loaded in a hidden tab and read: title, buy-box price, seller, availability.
2. You get an approval prompt naming exactly that — `Add to your Amazon cart: 1 × "…" — $9.49,
   sold by … (ASIN …). Nothing is bought.` **Autorun does not skip it.** Decline and nothing happens.
3. The extension loads the product page again in a hidden tab of its own, checks it is that ASIN,
   sets the quantity and clicks **Add to Cart**. The tab is closed.
4. The cart is read back. The result says `verified: true` only when the item is in the cart
   Amazon shows and the cart grew by the quantity asked.

## More results

`search` shows ten products at a time; `"page": 2`, `3`… gives the next ten for the same query. An
Amazon results page holds about twenty, and the tool keeps everything a query has brought back for
15 minutes (`SEARCH_TTL_MS`, in memory, 20 queries), so:

- the second ten come from what is already loaded — no request to Amazon;
- the same search asked again within 15 minutes costs nothing either;
- only when the loaded results run out does one more Amazon page load, the one its own **Next**
  link points to (`nextPageOf()` reads the link; the address is `…/s?k=<query>&page=<n>`). Nothing
  is clicked. At most one Amazon page per call; products repeated across pages are listed once.

Each result says whether there is `more` and how to ask for it. Before this (2026-11-25) "any
more?" re-ran the identical query: the tool had kept 10 of the 22 products it had just loaded, the
model had no way to ask for the rest, and that needless load drew Amazon's third refusal of the day.

**Several screens asked for at once.** The assistant may ask for screens 1, 2 and 3 in a single
step, and the app starts those calls together. Searches therefore run one after the other
(`oneSearchAtATime()`), each seeing what the one before it loaded, and the wait between Amazon
pages is booked before it is slept (`createPacer()`), so calls arriving together are spaced a full
wait apart. Before this (2026-11-26) three screens of one query each loaded the same Amazon page,
about 3 s apart: 7 page loads in 50 s where 4 were needed, and three products appeared on two
screens.

A screen asked for ahead of what is loaded (screen 5 with twenty products loaded) comes back short
or empty with `more: true`, and its note names the screen to ask for next, so no results are
skipped and "no more results" is said only when Amazon has none.

## Pictures

Each search result carries an `image` address and `product` carries `images` — the picture ids
Amazon's own page uses, rewritten to one size by `imageUrl()` (`…/images/I/<id>._SL500_.jpg`). The
model is told to put the picture in the first column of every product table without being asked
(markdown image, or `<img>` in an applet for a larger view); it is told never to guess a
picture address from an ASIN and never to download pictures to check them. Nothing extra is loaded
from Amazon's site for a picture.

## Staying within what Amazon tolerates

On 2026-11-25 a request for pictures took 19 rounds: the tool returned none, so the model loaded
12 product pages through `web_fetch` and then scraped amazon.com from `run_python` (about 46
requests under invented browser names). Amazon answered the browser twice with **"Access
restricted — continued access by an unauthorized AI agent violates Amazon's Conditions of Use"**.
Since then:

- **One door.** While this plugin is on, `web_fetch` refuses Amazon storefront addresses and points
  at `amazon_cart` (`webFetchRedirect()`); the prompt forbids reaching Amazon from `run_python`.
  That last rule is a prompt rule only — code cannot see what a Python script requests.
- **Pacing.** Each Amazon page is loaded a random time after the previous one — between 4 and 9 s
  by default — and at most 8 pages are loaded in 5 minutes (`createPacer()`, `randomGapMs()`); past
  that the tool answers "page limit reached" with the wait. An add costs three loads, so it takes
  8–18 s longer than the pages themselves. Three card fields set this: **Shortest wait between
  pages** (2–60 s), **Longest wait between pages** (2–120 s, never below the shortest) and
  **Amazon pages per 5 minutes** (1–20); `clampPacing()` applies the bounds, and a change takes
  effect at the next page load. The wait cannot be set to zero.
- **No imitation of a person.** The tool does not scroll, move a pointer, type, or visit pages it
  does not need in order to look human. The wait exists to keep the request rate low, not to
  disguise what is making the requests.
- **A refusal stops everything.** When Amazon serves that notice the tool says so plainly and
  loads no Amazon page for 30 minutes (`startCoolDown()`; the card turns amber and counts down).
  Open Amazon yourself and press Continue on the notice. The pause is written to
  `data/amazon-state.json`, so a server restart does not end it.
- Outside this plugin, `web_fetch` no longer retries over plain HTTP a page that names an AI agent
  as the reason it refused (`AGENT_REFUSAL_RE` in `plugin-browser.js`).

None of this makes the tool permitted by Amazon's terms; it makes it quiet. See Limits.

## What it cannot do

There is no checkout, Buy Now, Subscribe & Save, remove, address, payment or account action. This
is not a rule in the prompt that a web page could talk the model out of: the model supplies an ASIN
and a quantity and nothing else, and the selectors the extension receives are constants in
`src/tools/plugin-amazon.js` (`buildAddSteps()`), ending in the one click `form#addToCart
#add-to-cart-button`. The extension performs steps only in hidden tabs it opened itself and refuses
them for a tab you opened.

What an injected instruction on a product page could still do is make the model *ask* to add
something you did not want. That is what the approval prompt is for: read it before approving.

## Limits

- An item with versions (size, colour, pack) must be addressed by the ASIN of the exact version;
  a page with nothing selected is refused with that explanation.
- If Amazon answers the click with a question (protection plan, options) the item may not land in
  the cart; the result then says `verified: false` and to check the product page.
- Sign-in pages and robot checks are reported as such — pass them in Chrome and ask again.
- Removing items and changing quantities are done on Amazon.
- Amazon's Conditions of Use restrict automated access. This loads a handful of pages per request
  in your own browser at human pace; use it for your own shopping, not for bulk work.

## Implementation

- `src/tools/plugin-amazon.js` — group `amazon` (`dependencies: ['browser']`, off by default), tool
  `amazon_cart { action: search | product | view | add, query?, item?, quantity? }`. Pure parsers
  over the page the extension returns: `parseSearch()`, `parseProduct()`, `parseCart()`,
  `blockReason()`.
  Card field **Amazon site** (`site`, `cleanSite()` accepts Amazon storefront hosts only).
- Extension 0.9.0 — `fetch { actions: [{ require } | { select, value } | { click }] }`, capability
  `act`: `runActions()` runs the steps in the hidden tab once the page has rendered, stops at the
  first step it cannot do, waits for the navigation the click caused and returns the page then on
  screen with `actions: { asked, done, error? }`. At most 6 steps; never with `reuseTabId`.
- `bridge.fetchPage(url, { actions, timeoutMs })` refuses actions when the extension lacks `act`.
- First live session (2026-11-25, a laptop search and six product pages): pacing held (4–6 s apart,
  7 pages in 100 s, no notice from Amazon), `web_fetch` was not used on Amazon and the model read
  earlier results back with `conversation_read` instead of searching again. Two parser faults
  showed: every electronics result was titled by its brand line ("Dell") — fixed, `rowTitle()`
  takes the heading with an `aria-label`, else the longest — and **no picture address was found on
  any search row or product page**. `dumpDrift()` saves such a page to
  `logs/browser-debug/amazon-search-*.html` / `amazon-product-*.html` (one per kind per 10
  minutes), and the next session's pages gave the cause: the addresses carry a query string
  (`…_SF320,320_PQ70_.jpg?aicid=productui-image-1`) and, in the gallery, an experiment segment
  (`/images/W/<experiment>/images/I/<id>…`), neither of which `imageUrl()` accepted. Fixed; run
  over those two saved pages the parsers return a picture for 10 of 10 search rows and six gallery
  pictures, the rating, review count and feature list for the product.
- Still unverified on the live site: the Add to Cart click and the markup of an active cart row. Verified against saved pages only: the picture markup
  (`img.s-image` in a search row, `#landingImage` / `#altImages` on a product page — `rowImage()`
  falls back to any Amazon picture in the row) and the rating / feature selectors.
- Tests: `test/amazonCart.test.js` (parsers on pages reduced by hand from the 2026-11-25 markup,
  the step list, the add flow with a fake extension), `test/browserBridge.test.js` (actions).
