// Markdown printer — turns an answer (or any markdown text) into a clean black-on-white document
// and sends it to the browser's print dialog. Plain script (no modules): loaded by index.html
// ahead of app.js, by print.html (the page that prints a saved .md file), and by
// test/print.test.js in a vm context, so everything here must stay self-contained.
//
// Why it exists (2026-11-26): asked to "print this", the model wrote an applet with a
// window.print() button. Applets run in a sandboxed iframe where print() was blocked without an
// error, so nothing happened; its fix opened a popup, also blocked; the third turn saved an .md
// file the user then had no way to print. Printing is the page's job, not the model's.
//
// The answer is rendered again from its markdown rather than copied from the chat, so nothing of
// the dark chat styling, the tool details or the buttons reaches the paper.
(function (root) {
  'use strict';

  var APPLET_RE = /<applet\s+type=["']?(\w+)["']?\s*>[\s\S]*?(?:<\/applet>|$)(?:<\/applet)?/gi;
  var APPLET_NOTE = '*[An interactive applet is shown here in the chat — use the Print button under it.]*';
  var IMAGE_WAIT_MS = 4000;

  // One stylesheet for the hidden print frame and for print.html's on-screen preview.
  var CSS = [
    '@page{margin:14mm}',
    '*{box-sizing:border-box}',
    'html,body{background:#fff;color:#111}',
    'body{margin:0;font:11pt/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;overflow-wrap:break-word}',
    'h1,h2,h3,h4{line-height:1.25;margin:1.2em 0 .45em;break-after:avoid;page-break-after:avoid}',
    'h1{font-size:19pt;margin-top:0}h2{font-size:14.5pt;border-bottom:1px solid #bbb;padding-bottom:.15em}h3{font-size:12pt}h4{font-size:11pt}',
    'p,ul,ol,blockquote,pre,table{margin:0 0 .75em}',
    'ul,ol{padding-left:1.5em}li{margin:.15em 0}',
    'a{color:inherit;text-decoration:underline}',
    'table{border-collapse:collapse;width:100%;font-size:9.5pt}',
    'thead{display:table-header-group}',
    'th,td{border:1px solid #888;padding:4px 6px;text-align:left;vertical-align:top}',
    'th{background:#eee;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    'tr,img,pre,blockquote{break-inside:avoid;page-break-inside:avoid}',
    'img{max-width:100%;height:auto}',
    'code{font:9.5pt/1.4 ui-monospace,Menlo,Consolas,monospace}',
    'pre{border:1px solid #bbb;border-radius:3px;padding:8px;white-space:pre-wrap}',
    'blockquote{border-left:3px solid #999;padding-left:10px;color:#333}',
    'hr{border:0;border-top:1px solid #bbb;margin:1em 0}',
  ].join('\n');

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** The markdown as it goes to paper: each applet block becomes a one-line note. */
  function printableMarkdown(md) {
    return String(md == null ? '' : md).replace(APPLET_RE, '\n\n' + APPLET_NOTE + '\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** True when there is something to print besides applets. */
  function hasPrintableText(md) {
    return printableMarkdown(md).split(APPLET_NOTE).join('').trim().length > 0;
  }

  /** The document's name (browsers offer it as the PDF file name): first heading, else the fallback. */
  function titleOf(md, fallback) {
    var m = String(md || '').match(/^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/m);
    var t = (m ? m[1] : String(fallback || '')).replace(/[*_`\[\]]/g, '').replace(/\s+/g, ' ').trim();
    return (t || 'Lumispec answer').slice(0, 120);
  }

  /** Markdown → sanitized HTML. `lib` supplies marked and DOMPurify (the page's globals by default). */
  function renderMarkdown(md, lib) {
    var m = (lib && lib.marked) || root.marked;
    var purify = (lib && lib.DOMPurify) || root.DOMPurify;
    if (!m || !purify) throw new Error('The markdown renderer has not loaded.');
    return purify.sanitize(m.parse(printableMarkdown(md)));
  }

  /** A complete printable page around already-sanitized body HTML. */
  function documentHtml(title, bodyHtml) {
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title><style>' + CSS + '</style></head><body>' + bodyHtml + '</body></html>';
  }

  // Prints a whole document through a hidden frame of this page: no popup (blocked by default) and
  // the chat itself is not what gets printed. Pictures are waited for, up to IMAGE_WAIT_MS.
  function printDocument(html) {
    var doc = root.document;
    var frame = doc.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    var done = false;
    function remove() { if (frame.parentNode) frame.parentNode.removeChild(frame); }
    frame.onload = function () {
      if (done) return;
      done = true;
      var win = frame.contentWindow;
      var pending = Array.prototype.filter.call(win.document.images, function (i) { return !i.complete; });
      var waits = pending.map(function (i) { return new Promise(function (r) { i.addEventListener('load', r); i.addEventListener('error', r); }); });
      var timeout = new Promise(function (r) { setTimeout(r, IMAGE_WAIT_MS); });
      Promise.race([Promise.all(waits), timeout]).then(function () {
        win.addEventListener('afterprint', function () { setTimeout(remove, 500); });
        setTimeout(remove, 10 * 60 * 1000); // some browsers never fire afterprint
        win.focus();
        win.print();
      });
    };
    frame.srcdoc = html;
    doc.body.appendChild(frame);
  }

  /** Print markdown text. Returns false when there is nothing to print. */
  function printMarkdown(md, fallbackTitle) {
    if (!hasPrintableText(md)) return false;
    printDocument(documentHtml(titleOf(md, fallbackTitle), renderMarkdown(md)));
    return true;
  }

  root.Printer = {
    CSS: CSS,
    APPLET_NOTE: APPLET_NOTE,
    printableMarkdown: printableMarkdown,
    hasPrintableText: hasPrintableText,
    titleOf: titleOf,
    renderMarkdown: renderMarkdown,
    documentHtml: documentHtml,
    printDocument: printDocument,
    printMarkdown: printMarkdown,
  };
})(typeof window !== 'undefined' ? window : globalThis);
