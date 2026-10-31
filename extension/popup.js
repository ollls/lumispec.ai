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
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') runTest(); });

refresh();
setInterval(refresh, 2000);
