const $ = (id) => document.getElementById(id);
const call = (msg) => chrome.runtime.sendMessage(msg);

async function refresh() {
  const s = await call({ type: 'status' });
  $('dot').className = s.state;
  $('stateText').textContent = (s.state === 'connected' ? 'Connected to Lumispec' : s.state === 'connecting' ? 'Connecting…' : 'Not connected') + ` · v${s.version}`;
  $('err').textContent = s.state === 'connected' ? '' : (s.lastError || '');
  if (document.activeElement?.tagName !== 'INPUT') {
    $('serverUrl').value = s.settings.serverUrl;
    $('token').value = s.settings.token;
    $('enabled').checked = s.settings.enabled;
  }
}

$('save').onclick = async () => {
  await call({ type: 'saveSettings', settings: {
    serverUrl: $('serverUrl').value.trim(),
    token: $('token').value,
    enabled: $('enabled').checked,
  }});
  setTimeout(refresh, 300);
};

$('reconnect').onclick = async () => { await call({ type: 'reconnect' }); setTimeout(refresh, 500); };

// Test = load a URL in a hidden tab and report what came back. Proves the install works
// without the server; engine parsing lives server-side and is not exercised here.
async function runTest() {
  let url = $('url').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const out = $('out');
  out.textContent = 'Loading in a hidden tab…';
  const r = await call({ type: 'test', url });
  out.textContent = '';
  if (r.error) { out.textContent = `Error: ${r.error}`; return; }
  const line = (label, value) => { const d = document.createElement('div'); d.className = 'r'; d.innerHTML = `<b>${label}</b> `; d.appendChild(document.createTextNode(value)); out.appendChild(d); };
  line('Title', r.title || '(none)');
  line('Final URL', r.url);
  line('Loaded in', `${r.ms} ms`);
  line('Text', `${r.textChars} chars · HTML ${r.htmlChars} chars (${r.sentChars} sent after stripping scripts/styles) · ${r.reads} read${r.reads === 1 ? '' : 's'}`);
  line('Bot wall', r.wall ? `YES — "${r.wallText}"` : 'no');
  line('Snippet', r.textSnippet || '');
}
$('run').onclick = runTest;

// Tab Fetch checks (docs/TAB_FETCH.md): the list the server would get, and a read of the tab
// the user is looking at — in place, nothing navigated or closed.
$('listTabs').onclick = async () => {
  const out = $('out');
  out.textContent = 'Listing…';
  const r = await call({ type: 'tabs' });
  out.textContent = '';
  if (r.error) { out.textContent = `Error: ${r.error}`; return; }
  if (!r.tabs.length) { out.textContent = 'No readable web tabs open.'; return; }
  for (const t of r.tabs) {
    const d = document.createElement('div'); d.className = 'r';
    d.innerHTML = `<b>${t.current ? '▶ ' : ''}#${t.id}</b> `;
    d.appendChild(document.createTextNode(`${t.title || '(untitled)'} — ${t.url}${t.discarded ? ' (suspended)' : ''}`));
    out.appendChild(d);
  }
};
$('readCurrent').onclick = async () => {
  const out = $('out');
  out.textContent = 'Reading the current tab…';
  const r = await call({ type: 'readCurrent' });
  out.textContent = '';
  if (r.error) { out.textContent = `Error: ${r.error}`; return; }
  const line = (label, value) => { const d = document.createElement('div'); d.className = 'r'; d.innerHTML = `<b>${label}</b> `; d.appendChild(document.createTextNode(value)); out.appendChild(d); };
  line('Tab', `${r.title} — ${r.url}`);
  line('Read in', `${r.ms} ms (in place, nothing reloaded)`);
  line('Text', `${r.textChars} chars on screen (${r.textSource}) · ${r.domChars} in the DOM · HTML ${r.htmlChars} chars (${r.sentChars} sent)`);
  line('Snippet', r.textSnippet || '');
};
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') runTest(); });

refresh();
setInterval(refresh, 2000);
