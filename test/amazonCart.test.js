// Amazon Cart (docs/AMAZON_CART.md): parsers over hand-reduced pages with the structure Amazon
// served on 2026-11-25, the fixed step list, and the add flow with a fake extension. No Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asinOf, quantityOf, cleanSite, buildAddSteps, blockReason, parseProduct, parseCart, parseSearch, runAmazonCart, ADD_BUTTON, MAX_QUANTITY,
  imageUrl, isAmazonUrl, webFetchRedirect, createPacer, coolDownLeft, clearCoolDown, COOLDOWN_MS, clampPacing, randomGapMs, nextPageOf, clearSearchMemory, SEARCH_TTL_MS } from '../src/tools/plugin-amazon.js';

// A pause recorded by the running app (data/amazon-state.json) must not decide these tests;
// cleared in memory only, the file is left alone.
clearCoolDown();
clearSearchMemory();

const ASIN = 'B07VP5X239';
const SITE = 'www.amazon.com';
const page = (html, extra = {}) => ({ title: 'Amazon.com', url: `https://${SITE}/`, html: `<html><body>${html}</body></html>`, wall: false, ...extra });

const productHtml = ({ asin = ASIN, button = true, count = 0, twister = false } = {}) => `
  <span id="nav-cart-count">${count}</span>
  <span id="productTitle"> WD 5TB My Passport, Portable External Hard Drive, Black </span>
  <div id="imgTagWrapperId"><img id="landingImage" src="https://m.media-amazon.com/images/I/61abcDEF+hL._AC_SX679_.jpg"
    data-old-hires="https://m.media-amazon.com/images/I/61abcDEF+hL._AC_SL1500_.jpg"
    data-a-dynamic-image='{"https://m.media-amazon.com/images/I/61abcDEF+hL._AC_SX466_.jpg":[466,466]}'></div>
  <div id="altImages"><img src="https://m.media-amazon.com/images/I/61abcDEF+hL._AC_US40_.jpg"><img src="https://m.media-amazon.com/images/I/41secondIMG._AC_US40_.jpg"><img src="https://m.media-amazon.com/images/G/01/x/sprite.png"></div>
  <div id="averageCustomerReviews"><span class="a-icon-alt">4.6 out of 5 stars</span><span id="acrCustomerReviewText">(12,345)</span></div>
  <div id="feature-bullets"><ul><li><span class="a-list-item"> Slim design </span></li><li><span class="a-list-item">Password protection</span></li></ul></div>
  <div id="corePrice_feature_div"><span class="a-offscreen">$284.99</span></div>
  <div id="availability"><span>In Stock</span></div>
  ${twister ? '<div id="twister"></div>' : ''}
  <div id="merchantInfoFeature_feature_div">Sold by <span class="offer-display-feature-text-message">Stavvy Sales</span></div>
  <div id="fulfillerInfoFeature_feature_div">Ships from <span class="offer-display-feature-text-message">Amazon</span></div>
  <form id="addToCart" method="post" action="/gp/product/handle-buy-box/ref=dp_start">
    <input type="hidden" id="ASIN" name="ASIN" value="${asin}">
    <input type="hidden" name="items[0.base][customerVisiblePrice][displayString]" value="$219.89">
    <select id="quantity" name="quantity"><option value="1">1</option><option value="2">2</option><option value="3">3</option></select>
    ${button ? '<input id="add-to-cart-button" name="submit.add-to-cart" type="submit">' : ''}
    <input id="buy-now-button" name="submit.buy-now" type="submit">
  </form>`;

const cartItem = (asin, title, price, qty, type = 'active') => `
  <div class="a-row sc-list-item" data-asin="${asin}" data-itemtype="${type}" data-price="${price}" data-quantity="${qty}" data-outofstock="0">
    <a class="sc-product-link sc-product-title"><span class="a-truncate-full">${title}</span><span class="a-truncate-cut">${title.slice(0, 8)}</span></a>
  </div>`;
const cartHtml = (active = [], saved = []) => `
  <div id="sc-active-cart" data-name="Active Cart">
    ${active.length ? active.join('') : '<h3>Your Amazon Cart is empty</h3>'}
    <span id="sc-subtotal-amount-activecart"> $${active.length ? '229.38' : '0.00'} </span>
  </div>
  <div id="sc-saved-cart" data-name="Saved Cart">${saved.join('')}</div>`;

test('asinOf: bare ids and product addresses, nothing else', () => {
  assert.equal(asinOf('b07vp5x239'), ASIN);
  assert.equal(asinOf(`https://www.amazon.com/Passport-Portable/dp/${ASIN}/ref=sr_1_4?th=1`), ASIN);
  assert.equal(asinOf(`https://www.amazon.com/gp/product/${ASIN}`), ASIN);
  assert.equal(asinOf('https://www.amazon.com/gp/cart/view.html'), null);
  assert.equal(asinOf('WD passport 5TB'), null);
  assert.equal(asinOf(''), null);
});

test('quantityOf: 1 by default, whole numbers up to the cap', () => {
  assert.equal(quantityOf(undefined), 1);
  assert.equal(quantityOf('3'), 3);
  assert.equal(quantityOf(MAX_QUANTITY), MAX_QUANTITY);
  for (const bad of [0, -1, 1.5, MAX_QUANTITY + 1, 'many']) assert.equal(quantityOf(bad), null);
});

test('cleanSite accepts Amazon storefronts only', () => {
  assert.equal(cleanSite('amazon.de'), 'www.amazon.de');
  assert.equal(cleanSite('https://www.amazon.co.uk/gp/cart'), 'www.amazon.co.uk');
  assert.equal(cleanSite('amazon.com.evil.example'), 'www.amazon.com');
  assert.equal(cleanSite('evil.example'), 'www.amazon.com');
  assert.equal(cleanSite(''), 'www.amazon.com');
});

test('buildAddSteps: the only click is Add to Cart, on that product\'s page', () => {
  const one = buildAddSteps(ASIN, 1);
  assert.deepEqual(one.filter(s => s.click).map(s => s.click), [ADD_BUTTON]);
  assert.ok(one[0].require.includes(`[value="${ASIN}"]`));
  assert.equal(one.some(s => s.select), false);
  const three = buildAddSteps(ASIN, 3);
  assert.deepEqual(three.find(s => s.select), { select: 'form#addToCart select#quantity', value: '3' });
  assert.equal(three.at(-1).click, ADD_BUTTON);
  assert.doesNotMatch(JSON.stringify([one, three]), /buy-now|checkout|subscribe|place/i);
  assert.throws(() => buildAddSteps('B07"]', 1));
  assert.throws(() => buildAddSteps(ASIN, 99));
});

test('parseProduct reads the buy box and says why an item cannot be added', () => {
  const p = parseProduct(page(productHtml({ count: 4 })));
  assert.deepEqual(
    { asin: p.asin, price: p.price, seller: p.seller, shipsFrom: p.shipsFrom, availability: p.availability, canAdd: p.canAdd, cartCount: p.cartCount },
    { asin: ASIN, price: '$219.89', seller: 'Stavvy Sales', shipsFrom: 'Amazon', availability: 'In Stock', canAdd: true, cartCount: 4 });
  assert.match(p.title, /^WD 5TB My Passport/);
  assert.deepEqual(p.quantities, [1, 2, 3]);
  assert.match(parseProduct(page(productHtml({ button: false, twister: true }))).whyNot, /several versions/);
  assert.match(parseProduct(page(productHtml({ button: false }))).whyNot, /No Add to Cart button.*In Stock/);
});

test('parseCart lists the active cart and only counts Saved for later', () => {
  const empty = parseCart(page(cartHtml([], [cartItem('B0SAVED001', 'Saved thing', 9.5, 1, 'saved')])));
  assert.deepEqual(empty.items, []);
  assert.equal(empty.savedForLater, 1);
  const cart = parseCart(page(cartHtml([cartItem(ASIN, 'WD 5TB My Passport', 219.89, 1), cartItem('B088NRLMPV', 'Anker USB C Cable', 9.49, 2)], [cartItem('B0SAVED001', 'Saved thing', 9.5, 1, 'saved')])));
  assert.deepEqual(cart.items, [
    { asin: ASIN, title: 'WD 5TB My Passport', price: 219.89, quantity: 1 },
    { asin: 'B088NRLMPV', title: 'Anker USB C Cable', price: 9.49, quantity: 2 },
  ]);
  assert.equal(cart.itemCount, 3);
  assert.equal(cart.subtotal, '$229.38');
});

test('parseSearch: products in order, sponsored flagged, duplicates dropped', () => {
  const row = (asin, title, aria = title) => `
    <div data-component-type="s-search-result" data-asin="${asin}">
      <img class="s-image" src="https://m.media-amazon.com/images/I/71${asin}._AC_UL320_.jpg" srcset="https://m.media-amazon.com/images/I/71${asin}._AC_UL640_QL65_.jpg 2x">
      <h2 aria-label="${aria}"><span>${title}</span></h2>
      <span class="a-price"><span class="a-offscreen">$7.99</span></span>
      <i><span class="a-icon-alt">4.7 out of 5 stars</span></i>
      <div data-cy="reviews-block"><span class="s-underline-text">(92K)</span></div>
      <div data-cy="delivery-recipe">FREE delivery Sat, Nov 28</div>
    </div>`;
  const r = parseSearch(page(row('B0DSZQYC3C', 'Cable 5 Pack', 'Sponsored Ad - Cable 5 Pack') + row('B088NRLMPV', 'Anker Cable') + row('B088NRLMPV', 'Anker Cable') + '<div data-component-type="s-search-result" data-asin=""></div>'));
  assert.deepEqual(r.map(x => [x.asin, !!x.sponsored]), [['B0DSZQYC3C', true], ['B088NRLMPV', false]]);
  assert.deepEqual({ ...r[1] }, { asin: 'B088NRLMPV', title: 'Anker Cable', price: '$7.99', rating: '4.7', reviews: '92K', delivery: 'FREE delivery Sat, Nov 28', image: 'https://m.media-amazon.com/images/I/71B088NRLMPV._SL500_.jpg', url: 'https://www.amazon.com/dp/B088NRLMPV' });
});

test('blockReason: sign-in, robot check, missing page', () => {
  assert.match(blockReason(page('<input id="ap_email_login">', { url: 'https://www.amazon.com/ax/claim?arb=1' })), /sign in/i);
  assert.match(blockReason(page('<form action="/errors/validateCaptcha"></form>')), /robot check/);
  assert.match(blockReason(page('<p>Looking for something?</p>', { title: 'Page Not Found' })), /no page/);
  assert.equal(blockReason(page(productHtml())), null);
});

// ── The add flow with a fake extension ──────────────

function fakeBrowser({ cartAfter, product = productHtml({ count: 0 }), actions = { asked: 3, done: 3 } } = {}) {
  const calls = [];
  const fetchPage = async (url, opts = {}) => {
    calls.push({ url, actions: opts.actions || null });
    if (opts.actions) return { ...page('<h1>Added to cart</h1>'), actions };
    if (url.includes('/gp/cart/')) return page(cartAfter ?? cartHtml([cartItem(ASIN, 'WD 5TB My Passport', 219.89, 1)]));
    return page(product);
  };
  return { calls, deps: { fetchPage, connected: true, canAct: true, site: SITE } };
}
const approve = (answer, seen = []) => ({ confirmFn: async (text) => { seen.push(text); return answer; } });

test('add: shows the offer, asks, clicks once, proves it from the cart', async () => {
  const b = fakeBrowser();
  const seen = [];
  const r = await runAmazonCart({ action: 'add', item: ASIN }, approve(true, seen), b.deps);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /1 × "WD 5TB My Passport.*\$219\.89, sold by Stavvy Sales \(ASIN B07VP5X239\)\. Nothing is bought\./);
  assert.deepEqual(b.calls.map(c => [new URL(c.url).pathname, !!c.actions]), [[`/dp/${ASIN}`, false], [`/dp/${ASIN}`, true], ['/gp/cart/view.html', false]]);
  assert.equal(r.verified, true);
  assert.equal(r.added.quantity, 1);
  assert.match(r.note, /Nothing was bought/);
  assert.equal(r.cart.items[0].asin, ASIN);
});

test('add: a declined approval clicks nothing', async () => {
  const b = fakeBrowser();
  const r = await runAmazonCart({ action: 'add', item: ASIN, quantity: 2 }, approve(false), b.deps);
  assert.equal(r.declined, true);
  assert.equal(b.calls.some(c => c.actions), false);
});

test('add: no approval channel, old extension, bad input → refused before any page is touched', async () => {
  const b = fakeBrowser();
  assert.match((await runAmazonCart({ action: 'add', item: ASIN }, {}, b.deps)).error, /approval/);
  assert.match((await runAmazonCart({ action: 'add', item: ASIN }, approve(true), { ...b.deps, canAct: false })).error, /0\.9\.0/);
  assert.match((await runAmazonCart({ action: 'add', item: 'a nice drive' }, approve(true), b.deps)).error, /ASIN/);
  assert.match((await runAmazonCart({ action: 'add', item: ASIN, quantity: 50 }, approve(true), b.deps)).error, /1 to 10/);
  assert.match((await runAmazonCart({ action: 'view' }, {}, { ...b.deps, connected: false })).error, /not connected/);
  assert.equal(b.calls.length, 0);
});

test('add: never asks when the page cannot add, is another product, or lacks the quantity', async () => {
  const seen = [];
  const run = (product, args = {}) => runAmazonCart({ action: 'add', item: ASIN, ...args }, approve(true, seen), fakeBrowser({ product }).deps);
  assert.match((await run(productHtml({ button: false, twister: true }))).error, /several versions/);
  assert.match((await run(productHtml({ asin: 'B000000001' }))).error, /different product/);
  assert.match((await run(productHtml(), { quantity: 5 })).error, /at most 3/);
  assert.equal(seen.length, 0);
});

test('add: a failed step or a cart without the item is reported, not papered over', async () => {
  const failed = await runAmazonCart({ action: 'add', item: ASIN }, approve(true), fakeBrowser({ actions: { asked: 3, done: 1, error: 'step 2: nothing matches form#addToCart #add-to-cart-button' } }).deps);
  assert.match(failed.error, /Nothing was added: step 2/);
  const missing = await runAmazonCart({ action: 'add', item: ASIN }, approve(true), fakeBrowser({ cartAfter: cartHtml() }).deps);
  assert.equal(missing.verified, false);
  assert.match(missing.note, /not in the cart/);
  const already = await runAmazonCart({ action: 'add', item: ASIN }, approve(true), fakeBrowser({ product: productHtml({ count: 1 }) }).deps);
  assert.equal(already.verified, false);
  assert.match(already.note, /did not grow/);
});

test('view and search; unknown actions name what exists', async () => {
  const b = fakeBrowser({ cartAfter: cartHtml() });
  const v = await runAmazonCart({ action: 'view' }, {}, b.deps);
  assert.deepEqual(v.items, []);
  assert.match(v._markdown, /empty/);
  const signedOut = await runAmazonCart({ action: 'view' }, {}, { ...b.deps, fetchPage: async () => page('<input id="ap_email">', { url: 'https://www.amazon.com/ap/signin' }) });
  assert.match(signedOut.error, /sign in/i);
  assert.match((await runAmazonCart({ action: 'search' }, {}, b.deps)).error, /query/);
  assert.match((await runAmazonCart({ action: 'checkout' }, {}, b.deps)).error, /no remove, checkout or buy/);
});

// ── Pictures, product details, and staying off Amazon's nerves ──

test('imageUrl: any size of an Amazon picture, nothing else', () => {
  assert.equal(imageUrl('https://m.media-amazon.com/images/I/71ULtE83xWL._AC_UL320_.jpg'), 'https://m.media-amazon.com/images/I/71ULtE83xWL._SL500_.jpg');
  assert.equal(imageUrl('https://m.media-amazon.com/images/I/61nhW-Moj8L.jpg', 1000), 'https://m.media-amazon.com/images/I/61nhW-Moj8L._SL1000_.jpg');
  assert.equal(imageUrl('https://m.media-amazon.com/images/I/510lUZfU+AL._QL92_SH45_SS200_.png', 120), 'https://m.media-amazon.com/images/I/510lUZfU+AL._SL120_.png');
  // the forms Amazon served on 2026-11-25: a query string, size tokens with commas, an experiment segment
  assert.equal(imageUrl('https://m.media-amazon.com/images/I/5182C62G4QL._AC_AIweblab1378949,T2_SF320,320_PQ70_.jpg?aicid=productui-image-1'), 'https://m.media-amazon.com/images/I/5182C62G4QL._SL500_.jpg');
  assert.equal(imageUrl('https://m.media-amazon.com/images/W/BW_MEDIAX_AVIF_MEASUREMENT_1306696-T4/images/I/5182C62G4QL._AC_SL1500_.jpg', 1000), 'https://m.media-amazon.com/images/I/5182C62G4QL._SL1000_.jpg');
  for (const no of ['https://m.media-amazon.com/images/G/01/x/sprite.png', 'https://m.media-amazon.com/images/P/B08HW32VG6.01._SL1500_.jpg', 'https://evil.example/images/I/71ULtE83xWL.jpg', 'data:image/gif;base64,R0lG', '', null]) assert.equal(imageUrl(no), null);
});

test('parseProduct: gallery (largest main picture first, no duplicates, no sprites), rating, features', () => {
  const p = parseProduct(page(productHtml()));
  assert.deepEqual(p.images, ['https://m.media-amazon.com/images/I/61abcDEF+hL._SL1000_.jpg', 'https://m.media-amazon.com/images/I/41secondIMG._SL1000_.jpg']);
  assert.equal(p.image, 'https://m.media-amazon.com/images/I/61abcDEF+hL._SL500_.jpg');
  assert.equal(p.rating, '4.6');
  assert.equal(p.reviews, '12,345');
  assert.deepEqual(p.features, ['Slim design', 'Password protection']);
});

test('product: one page, pictures and features, nothing about the cart', async () => {
  const b = fakeBrowser();
  const r = await runAmazonCart({ action: 'product', item: `https://www.amazon.com/dp/${ASIN}?th=1` }, {}, b.deps);
  assert.equal(b.calls.length, 1);
  assert.equal(r.product.asin, ASIN);
  assert.equal(r.product.images.length, 2);
  assert.equal(r.product.canAdd, true);
  assert.equal('cartCount' in r.product, false);
  assert.match(r._markdown, /!\[\]\(https:\/\/m\.media-amazon\.com\/images\/I\/61abcDEF\+hL\._SL200_\.jpg\)/);
  const s = await runAmazonCart({ action: 'search', query: 'usb' }, {}, { ...b.deps, fetchPage: async () => page('<div data-component-type="s-search-result" data-asin="B088NRLMPV"><img class="s-image" src="https://m.media-amazon.com/images/I/71x1x2x3x4._AC_UL320_.jpg"><h2>Anker Cable</h2></div>') });
  assert.match(s._markdown, /\| !\[Anker Cable\]\(https:\/\/m\.media-amazon\.com\/images\/I\/71x1x2x3x4\._SL120_\.jpg\) \| Anker Cable/);
});

test('web_fetch is turned away from Amazon pages while the plugin is on, and only then', () => {
  assert.equal(isAmazonUrl('https://www.amazon.com/dp/B07VP5X239'), true);
  assert.equal(isAmazonUrl('https://amazon.de/s?k=x'), true);
  assert.equal(isAmazonUrl('https://m.media-amazon.com/images/I/71ULtE83xWL.jpg'), false);
  assert.equal(isAmazonUrl('https://aws.amazon.com/s3/'), false);
  assert.equal(isAmazonUrl('https://www.amazon.com.evil.example/dp/B07VP5X239'), false);
  assert.match(webFetchRedirect(`https://www.amazon.com/dp/${ASIN}`, true).error, new RegExp(`"action":"product","item":"${ASIN}"`));
  assert.match(webFetchRedirect('https://www.amazon.com/s?k=usb', true).error, /"search"/);
  assert.equal(webFetchRedirect(`https://www.amazon.com/dp/${ASIN}`, false), null);
  assert.equal(webFetchRedirect('https://www.bestbuy.com/site/x', true), null);
});

test('createPacer: a gap between loads and a cap per window', async () => {
  let t = 1_000_000;
  const slept = [];
  const p = createPacer({ gapMs: 4000, max: 3, windowMs: 60000, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  await p.wait();                      // first load: no wait
  t += 1000; await p.wait();           // 1 s later: waits the remaining 3 s
  t += 10000; await p.wait();          // long after: no wait
  assert.deepEqual(slept, [3000]);
  await assert.rejects(p.wait(), /page limit reached \(3 pages in 1 minutes\).*in \d+s/);
  t += 61000; await p.wait();          // the window moved on
  assert.equal(p.count, 1);
});

test('a refusal page stops everything: cool-down, no further page loads, said plainly', async () => {
  clearCoolDown();
  let t = 5_000_000;
  let loads = 0;
  const refused = page('<h4>Access restricted</h4><p>Continued access by an unauthorized AI agent violates Amazon\'s Conditions of Use, to which our customers have agreed.</p><a>Continue</a>');
  assert.match(blockReason(refused), /refused automated access/);
  const deps = { connected: true, canAct: true, site: SITE, now: () => t, fetchPage: async () => { loads++; return refused; } };
  const first = await runAmazonCart({ action: 'search', query: 'usb stick' }, {}, deps);
  assert.match(first.error, /refused automated access.*paused here for 30 more minute.*do not try to reach Amazon any other way/);
  assert.equal(coolDownLeft(t), COOLDOWN_MS);
  t += 60_000;
  const second = await runAmazonCart({ action: 'add', item: ASIN }, approve(true), deps);
  assert.equal(second.refused, true);
  assert.match(second.error, /29 more minute/);
  assert.equal(loads, 1);
  t += COOLDOWN_MS;
  await runAmazonCart({ action: 'view' }, {}, { ...deps, fetchPage: async () => { loads++; return page(cartHtml()); } });
  assert.equal(loads, 2);
  clearCoolDown();
  // a real product page that merely mentions the words is not a refusal
  assert.equal(blockReason(page(productHtml() + '<p>Access restricted to members. ' + 'x '.repeat(900) + '</p>')), null);
});

test('the page limit is reported as such, not as a connection failure', async () => {
  const b = fakeBrowser();
  const pacer = { wait: async () => { throw Object.assign(new Error('Amazon page limit reached (8 pages in 5 minutes).'), { paced: true }); } };
  const r = await runAmazonCart({ action: 'view' }, {}, { ...b.deps, pacer });
  assert.equal(r.paced, true);
  assert.match(r.error, /^Amazon page limit reached/);
  assert.equal(b.calls.length, 0);
});

test('pacing settings: clamped, max never below min, a fresh random wait per load', async () => {
  assert.deepEqual(clampPacing(), { minDelaySec: 4, maxDelaySec: 9, maxLoads: 8 });
  assert.deepEqual(clampPacing({ minDelaySec: 0, maxDelaySec: 999, maxLoads: 0 }), { minDelaySec: 2, maxDelaySec: 120, maxLoads: 1 });
  assert.deepEqual(clampPacing({ minDelaySec: 20, maxDelaySec: 5, maxLoads: 'x' }), { minDelaySec: 20, maxDelaySec: 20, maxLoads: 8 });
  const cfg = { minDelaySec: 4, maxDelaySec: 10 };
  assert.equal(randomGapMs(cfg, () => 0), 4000);
  assert.equal(randomGapMs(cfg, () => 0.5), 7000);
  assert.equal(randomGapMs(cfg, () => 0.999), 9994);
  // the pacer draws the gap again at every load
  let t = 0;
  const draws = [5000, 9000];
  const slept = [];
  const p = createPacer({ gapMs: () => draws.shift() ?? 4000, max: () => 5, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  await p.wait(); await p.wait(); await p.wait();
  assert.deepEqual(slept, [9000, 4000]); // first load never waits; its draw (5000) is unused
});

test('parseSearch: a brand line ahead of the title does not become the title; glued delivery lines are split', () => {
  const html = `<div data-component-type="s-search-result" data-asin="B0HC87Z6WN">
      <h2 class="a-size-mini"><span>Dell</span></h2>
      <a><h2 aria-label="Sponsored Ad - Dell Pro Max 18 Plus 18&quot; QHD+ Workstation Laptop"><span>Dell Pro Max 18 Plus 18" QHD+ Workstation Laptop</span></h2></a>
      <div data-cy="delivery-recipe"><div>FREE delivery Sat, Nov 28</div><div>Only 5 left in stock - order soon.</div></div>
    </div>
    <div data-component-type="s-search-result" data-asin="B0HKN7VPTN"><h2><span>Dell</span></h2><h2><span>Dell Pro Max 18 Plus MB18250 Notebook</span></h2></div>`;
  const r = parseSearch(page(html));
  assert.deepEqual(r.map(x => x.title), ['Dell Pro Max 18 Plus 18" QHD+ Workstation Laptop', 'Dell Pro Max 18 Plus MB18250 Notebook']);
  assert.equal(r[0].sponsored, true);
  assert.equal(r[0].delivery, 'FREE delivery Sat, Nov 28 · Only 5 left in stock - order soon.');
});

test('search paging: ten at a time, the rest of a page from memory, Next only when needed', async () => {
  clearSearchMemory();
  const id = (n) => 'B0' + String(n).padStart(8, '0');
  const row = (n) => `<div data-component-type="s-search-result" data-asin="${id(n)}"><h2><span>Stick number ${n}</span></h2></div>`;
  const amazonPage = (first, count, next) => page(Array.from({ length: count }, (_, i) => row(first + i)).join('')
    + (next ? `<a class="s-pagination-item s-pagination-next" href="/s?k=usb+stick&amp;page=${next}&amp;qid=1">Next</a>` : '<span class="s-pagination-item s-pagination-next s-pagination-disabled" aria-disabled="true">Next</span>'));
  assert.equal(nextPageOf(amazonPage(1, 2, 2)), 2);
  assert.equal(nextPageOf(amazonPage(1, 2, null)), null);
  const urls = [];
  let t = 1_000_000;
  const deps = { connected: true, site: SITE, now: () => t, fetchPage: async (url) => {
    urls.push(url);
    return /[?&]page=2/.test(url) ? amazonPage(22, 5, null) : amazonPage(1, 22, 2); // page 2 repeats one product of page 1
  } };
  const s = (pageNo, query = 'usb stick') => runAmazonCart({ action: 'search', query, ...(pageNo ? { page: pageNo } : {}) }, {}, deps);

  const p1 = await s();
  assert.deepEqual([p1.results.length, p1.results[0].asin, p1.more, p1.page], [10, id(1), true, 1]);
  const again = await s(1, 'USB  Stick');            // the same question again: nothing is loaded
  assert.equal(again.results[9].asin, id(10));
  const p2 = await s(2);                             // the second ten were on the page already
  assert.deepEqual([p2.results[0].asin, p2.results.length, p2.more], [id(11), 10, true]);
  assert.match(p2.note, /Results 11–20, from the results already loaded \(no new Amazon page\)/);
  assert.equal(urls.length, 1);

  const p3 = await s(3);                             // 21–22 are in memory, the rest needs Next: one load
  assert.deepEqual(urls.map(u => new URL(u).search), ['?k=usb%20stick', '?k=usb%20stick&page=2']);
  assert.deepEqual(p3.results.map(r => r.asin), [id(21), id(22), id(23), id(24), id(25), id(26)]); // the repeated one is not listed twice
  assert.equal(p3.more, false);
  assert.match(p3.note, /last results/);
  const p4 = await s(4);
  assert.deepEqual([p4.results.length, p4.more], [0, false]);
  assert.match(p4.note, /returned 26 products.*seen them all/);
  assert.equal(urls.length, 2);

  t += SEARCH_TTL_MS + 1;                            // prices go stale: after a while it is loaded afresh
  await s();
  assert.equal(urls.length, 3);
  assert.match((await runAmazonCart({ action: 'search', query: 'usb stick', page: 0 }, {}, deps)).error, /whole number from 1 to 10/);
  clearSearchMemory();
});

test('createPacer: calls arriving together are spaced a gap apart, not started together', async () => {
  const slept = [];                    // the clock stands still: all four calls arrive at the same moment
  const p = createPacer({ gapMs: 7000, max: 8, now: () => 0, sleep: async (ms) => { slept.push(ms); } });
  await Promise.all([1, 2, 3, 4].map(() => p.wait()));
  assert.deepEqual(slept, [7000, 14000, 21000]);   // was [7000, 7000, 7000]
});

test('search: screens asked for in one round share the loads; a screen asked for too early says which one to ask for', async () => {
  clearSearchMemory();
  const id = (a, n) => `B${a}` + String(n).padStart(8, '0');
  const amazonPage = (a) => page(Array.from({ length: 22 }, (_, i) => `<div data-component-type="s-search-result" data-asin="${id(a, i)}"><h2><span>Stick ${a}-${i}</span></h2></div>`).join('')
    + `<a class="s-pagination-next" href="/s?k=usb&amp;page=${a + 1}">Next</a>`);
  const urls = [];
  const deps = { connected: true, site: SITE, fetchPage: async (url) => {
    urls.push(new URL(url).search);
    await new Promise(r => setTimeout(r, 5));          // the load is in flight while the other calls start
    return amazonPage(Number(new URL(url).searchParams.get('page') || 1));
  } };
  const s = (pageNo, query = 'usb') => runAmazonCart({ action: 'search', query, page: pageNo }, {}, deps);

  const [a, b, c] = await Promise.all([s(1), s(3), s(2)]);   // the order the model used on 2026-11-26
  assert.deepEqual(urls, ['?k=usb', '?k=usb&page=2']);       // was: Amazon's first page three times
  const asins = [...a.results, ...c.results, ...b.results].map(r => r.asin);
  assert.equal(new Set(asins).size, 30);                     // no product on two screens
  assert.match(c.note, /Results 11–20, from the results already loaded/);

  urls.length = 0;
  const p1 = await s(1, 'jump');
  const p5 = await s(5, 'jump');                             // 22 loaded + one more page = 44: screen 5 is short
  assert.deepEqual([p5.results.length, p5.more], [4, true]);
  assert.match(p5.note, /Results 41–44\. This screen is not complete yet: .*"page": 5 /);
  const p5b = await s(5, 'jump');
  assert.equal(p5b.results.length, 10);
  assert.match(p5b.note, /"page": 6\./);
  assert.equal(p1.results.length, 10);
  await s(1, 'far');
  const p9 = await s(9, 'far');                              // far ahead: nothing to show yet, and not "no more results"
  assert.deepEqual([p9.results.length, p9.more], [0, true]);
  assert.match(p9.note, /only 44 are loaded so far.*"page": 5\./);
});

test('experimental and session-only: off after every restart, other settings kept', async () => {
  const { turnOffSessionOnly } = await import('../src/tools/index.js');
  const amazon = (await import('../src/tools/plugin-amazon.js')).default;
  assert.equal(amazon.experimental, true);
  assert.equal(amazon.sessionOnly, true);
  const modules = { amazon: { plugin: amazon }, books: { plugin: { group: 'books', tools: {} } } };
  const cfg = { amazon: { enabled: true, site: 'www.amazon.de', minDelaySec: 7 }, books: { enabled: true } };
  assert.deepEqual(turnOffSessionOnly(cfg, modules), ['amazon']);
  assert.deepEqual(cfg, { amazon: { enabled: false, site: 'www.amazon.de', minDelaySec: 7 }, books: { enabled: true } });
  assert.deepEqual(turnOffSessionOnly(cfg, modules), []);          // already off: nothing to write
  assert.deepEqual(turnOffSessionOnly({}, modules), []);           // never configured: the default (off) stands
});
