import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleText, looksLikeLoginPage, detectWall } from '../src/tools/plugin-browser.js';

// Gmail, 2026-10-31: Chrome loaded the signed-in inbox, the extractor got 42 chars, and the
// cookie-less HTTP fallback returned Google's sign-in page, which the model reported as the
// user being logged out. These helpers back the two server-side guards against that.

test('visibleText returns the page text one block per line, without scripts or styles', () => {
  const html = `<html><head><title>Inbox</title><style>.a{color:red}</style></head><body>
<div>Inbox (4,764)</div><script>var x = 1;</script>
<table><tr><td>Alice</td><td>Lunch tomorrow?</td></tr><tr><td>Bob</td><td>Invoice attached</td></tr></table>
<template><p>hidden template text</p></template><p>Inbox (4,764)</p></body></html>`;
  const text = visibleText(html);
  assert.equal(text.split('\n')[0], 'Inbox (4,764)');
  assert.ok(text.includes('Alice'));
  assert.ok(text.includes('Invoice attached'));
  assert.ok(!text.includes('color:red'));
  assert.ok(!text.includes('var x'));
  assert.ok(!text.includes('hidden template text'));
});

test('visibleText respects the cap', () => {
  const html = '<body>' + Array.from({ length: 200 }, (_, i) => `<p>line number ${i} of the page</p>`).join('') + '</body>';
  const text = visibleText(html, 600);
  assert.ok(text.length <= 700, String(text.length));
  assert.ok(text.endsWith('[...truncated]'));
});

test('looksLikeLoginPage recognises a short sign-in page and not an article', () => {
  assert.equal(looksLikeLoginPage({ title: 'Gmail', content: 'Not your computer? Use Guest mode to sign in privately. [Learn more](https://support.google.com/)' }), true);
  assert.equal(looksLikeLoginPage({ title: 'Log in to Example', content: 'Enter your email to continue. Forgot password?' }), true);
  assert.equal(looksLikeLoginPage({ title: 'Why people sign in less', content: 'A long feature article. '.repeat(200) }), false, 'long content is a page, not a wall');
  assert.equal(looksLikeLoginPage({ title: 'Weather', content: 'Sunny, 21°C, light winds through the afternoon in the valley.' }), false);
  assert.equal(looksLikeLoginPage({ content: '' }), false);
});

// Reuters, 2026-10-31: the hidden tab got a DataDome CAPTCHA that lives entirely in a
// cross-origin iframe. The main document had a title and nothing else, so no wall phrase
// matched and the fetch was reported as "browser returned 11 chars".
test('detectWall recognises a CAPTCHA that renders inside an iframe', () => {
  const html = '<html lang="en"><head><title>reuters.com</title></head><body><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x&hash=y" sandbox="allow-scripts" title="DataDome CAPTCHA" width="100%" height="100%"></iframe></body></html>';
  const reason = detectWall({ html, title: 'reuters.com', textChars: 0 });
  assert.match(reason || '', /DataDome CAPTCHA/);
  assert.match(reason || '', /normal tab/);
});

test('detectWall leaves a real page with an embedded CAPTCHA widget alone', () => {
  const body = '<p>' + 'Ordinary article prose that goes on for a while. '.repeat(80) + '</p>';
  const html = `<html><head><title>Contact us</title></head><body><article>${body}</article><form><iframe src="https://www.google.com/recaptcha/api2/anchor?k=abc" title="reCAPTCHA"></iframe></form></body></html>`;
  assert.equal(detectWall({ html, title: 'Contact us', textChars: 4000 }), null);
});

// view: "text" — the page as laid out on screen. The extension sends document.body.innerText;
// renderedText() turns it into one trimmed line per visual row for the model.
test('renderedText joins table cells, drops blank lines and consecutive repeats, and caps', async () => {
  const { renderedText } = await import('../src/tools/plugin-web.js');
  const inner = 'Inbox\n\n\nSmartReversals\tNew thread from SmartReversals - Trading Compass chat\t11:00 AM\nSmartReversals\tNew thread from SmartReversals - Trading Compass chat\t11:00 AM\n  The Aging Edge  \t The Cool Room And The Deep Sleep Connection \t10:07 AM\n';
  const out = renderedText(inner);
  assert.equal(out, 'Inbox\nSmartReversals · New thread from SmartReversals - Trading Compass chat · 11:00 AM\nThe Aging Edge · The Cool Room And The Deep Sleep Connection · 10:07 AM');
  // Empty grid cells (star, importance marker, attachment icon) leave runs of separators behind
  assert.equal(renderedText('Sender · · · · · Subject here · · - snippet text · · · 11:00 AM'), 'Sender · Subject here · - snippet text · 11:00 AM');
  assert.equal(renderedText(' · Leading and trailing · '), 'Leading and trailing');
  const capped = renderedText(Array.from({ length: 100 }, (_, i) => `row ${i} with some words`).join('\n'), 300);
  assert.ok(capped.length <= 320 && capped.endsWith('[...truncated]'), capped.slice(-60));
});
