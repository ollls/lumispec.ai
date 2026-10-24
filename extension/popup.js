const $ = (id) => document.getElementById(id);
const call = (msg) => chrome.runtime.sendMessage(msg);

async function refresh() {
  const s = await call({ type: 'status' });
  $('dot').className = s.state;
  $('stateText').textContent = s.state === 'connected' ? 'Connected to Lumispec' : s.state === 'connecting' ? 'Connecting…' : 'Not connected';
  $('err').textContent = s.state === 'connected' ? '' : (s.lastError || '');
  if (document.activeElement?.tagName !== 'INPUT') {
    $('serverUrl').value = s.settings.serverUrl;
    $('token').value = s.settings.token;
    $('enabled').checked = s.settings.enabled;
  }
  if (!$('engine').options.length) {
    for (const e of s.engines) {
      const o = document.createElement('option');
      o.value = e; o.textContent = e;
      $('engine').appendChild(o);
    }
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

async function runTest() {
  const query = $('query').value.trim();
  if (!query) return;
  $('out').textContent = 'Searching…';
  const res = await call({ type: 'test', engine: $('engine').value, query });
  const out = $('out');
  out.textContent = '';
  if (res.error) { out.textContent = `Error: ${res.error}`; return; }
  const head = document.createElement('div');
  head.textContent = `${res.engine}: ${res.results.length} results in ${res.ms} ms`;
  out.appendChild(head);
  for (const r of res.results) {
    const div = document.createElement('div');
    div.className = 'r';
    const a = document.createElement('a'); a.href = r.url; a.target = '_blank'; a.textContent = r.title || '(no title)';
    const u = document.createElement('div'); u.className = 'u'; u.textContent = r.url;
    const d = document.createElement('div'); d.className = 'd'; d.textContent = r.description;
    div.append(a, u, d);
    out.appendChild(div);
  }
}
$('run').onclick = runTest;
$('query').addEventListener('keydown', (e) => { if (e.key === 'Enter') runTest(); });

refresh();
setInterval(refresh, 2000);
