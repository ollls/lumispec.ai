// Llama Dashboard — the panel behind the "Llama" button in the top bar.
// Plain script, no dependencies on app.js. Data: GET /api/llama/dashboard
// (src/services/llamaDashboard.js). Styles are inline so no Tailwind rebuild is needed.
(function () {
  'use strict';

  const button = document.getElementById('llama-toggle');
  const pluginPanel = document.getElementById('plugin-config-panel');
  if (!button || !pluginPanel) return;

  const POLL_OPEN_MS = 4000;      // while the panel is open
  const POLL_BADGE_MS = 60000;    // closed: only the alert dot on the button

  const css = `
  #llama-dash{position:absolute;inset:0;z-index:40;background:#09090b;overflow-y:auto;padding:40px 24px 32px;color:#d4d4d8;font-size:13px;line-height:1.45}
  #llama-dash.ld-hidden{display:none}
  #llama-dash .ld-wrap{max-width:1040px;margin:0 auto}
  #llama-dash .ld-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}
  #llama-dash h2{font-size:18px;font-weight:600;color:#e4e4e7;margin:0}
  #llama-dash .ld-sub{color:#a1a1aa;margin-top:4px;overflow-wrap:anywhere}
  #llama-dash .ld-close{color:#71717a;font-size:24px;line-height:1;width:36px;height:36px;border-radius:8px;flex-shrink:0;cursor:pointer}
  #llama-dash .ld-close:hover{color:#e4e4e7;background:#3f3f46}
  #llama-dash .ld-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
  #llama-dash .ld-card{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px;min-width:0}
  #llama-dash .ld-wide{grid-column:1/-1}
  #llama-dash h3{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#71717a;margin:0 0 10px;display:flex;justify-content:space-between;gap:8px;align-items:center}
  #llama-dash dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}
  #llama-dash dt{color:#71717a}
  #llama-dash dd{margin:0;color:#e4e4e7;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
  #llama-dash .ld-big{font-size:24px;font-weight:600;color:#fafafa;font-variant-numeric:tabular-nums}
  #llama-dash .ld-unit{font-size:12px;color:#71717a;font-weight:400;margin-left:4px}
  #llama-dash .ld-muted{color:#71717a}
  #llama-dash .ld-ok{color:#4ade80} #llama-dash .ld-warn{color:#fbbf24} #llama-dash .ld-err{color:#f87171} #llama-dash .ld-info{color:#a5b4fc}
  #llama-dash .ld-bar{height:8px;background:#27272a;border-radius:999px;overflow:hidden;display:flex;margin:8px 0 6px}
  #llama-dash .ld-bar span{display:block;height:100%}
  #llama-dash .ld-alert{border-radius:8px;padding:8px 12px;margin-bottom:8px;border:1px solid}
  #llama-dash .ld-alert.warn{background:#422006;border-color:#854d0e;color:#fde68a}
  #llama-dash .ld-alert.error{background:#450a0a;border-color:#991b1b;color:#fecaca}
  #llama-dash .ld-alert.info{background:#1e1b4b;border-color:#3730a3;color:#c7d2fe}
  #llama-dash .ld-btn{font-size:11px;color:#a5b4fc;border:1px solid #3f3f46;border-radius:6px;padding:2px 8px;cursor:pointer;text-transform:none;letter-spacing:0;font-weight:400}
  #llama-dash .ld-btn:hover{background:#27272a;color:#c7d2fe}
  #llama-dash .ld-btn[disabled]{opacity:.5;cursor:default}
  #llama-dash a{color:#a5b4fc;text-decoration:none} #llama-dash a:hover{text-decoration:underline}
  #llama-dash ul{list-style:none;margin:8px 0 0;padding:0}
  #llama-dash li{padding:3px 0;border-top:1px solid #27272a;display:flex;gap:10px;min-width:0}
  #llama-dash li .ld-when{color:#71717a;flex-shrink:0;font-variant-numeric:tabular-nums}
  #llama-dash li .ld-what{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #llama-dash code,#llama-dash pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  #llama-dash pre{background:#09090b;border:1px solid #27272a;border-radius:8px;padding:10px 12px;margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;color:#d4d4d8}
  #llama-dash details summary{cursor:pointer;color:#a1a1aa}
  #llama-dash .ld-stats{display:flex;gap:28px;flex-wrap:wrap;margin-bottom:10px}
  #llama-toggle .ld-dot{display:none;width:6px;height:6px;border-radius:999px;background:#f59e0b;margin-left:5px;vertical-align:middle}
  #llama-toggle.ld-alerting .ld-dot{display:inline-block}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'llama-dash';
  panel.className = 'ld-hidden slim-scrollbar';
  pluginPanel.parentElement.insertBefore(panel, pluginPanel.nextSibling);

  const dot = document.createElement('span');
  dot.className = 'ld-dot';
  button.appendChild(dot);

  // ── formatting ──────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const nf = new Intl.NumberFormat('en-US');
  const n = (v) => (v == null ? '—' : nf.format(v));
  const gb = (bytes) => (bytes == null ? '—' : (bytes / 1e9).toFixed(1) + ' GB');
  const gib = (mib) => (mib == null ? '—' : (mib / 1024).toFixed(1) + ' GiB');
  const short = (v) => (v == null ? '—' : v >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(v));
  function duration(sec) {
    if (sec == null) return '—';
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${sec}s`;
  }
  function ago(iso) {
    if (!iso) return '—';
    const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    return sec < 90 ? 'just now' : duration(sec) + ' ago';
  }
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  const dayTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const rows = (pairs) => '<dl>' + pairs.filter(p => p && p[1] != null && p[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('') + '</dl>';

  function sparkline(series) {
    if (!series || series.length < 2) return '';
    const w = 260, h = 44, min = Math.min(...series), max = Math.max(...series), span = max - min || 1;
    const pts = series.map((v, i) => `${((i / (series.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Generation speed of the last ${series.length} answers, ${min} to ${max} tokens per second"><polyline points="${pts}" fill="none" stroke="#818cf8" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>
      <div class="ld-muted" style="display:flex;justify-content:space-between"><span>last ${series.length} answers</span><span>${min}–${max} tok/s</span></div>`;
  }

  // ── cards ───────────────────────────────────────────
  function cardServer(d) {
    const s = d.server || {}, p = d.process;
    if (!s.reachable) return `<div class="ld-card"><h3>Server</h3><div class="ld-err">Not answering at ${esc(d.url)}</div></div>`;
    const slot = (d.slots || [])[0];
    const busy = (d.slots || []).filter(x => x.processing).length;
    return `<div class="ld-card"><h3>Server</h3>${rows([
      ['Status', s.sleeping ? '<span class="ld-warn">sleeping</span>' : busy ? '<span class="ld-info">generating</span>' : '<span class="ld-ok">idle</span>'],
      ['Build', `${esc(s.buildInfo || '—')}`],
      p && ['Running for', `${duration(p.uptimeSec)} <span class="ld-muted">· since ${esc(dayTime(p.startedAt))}</span>`],
      ['Window', `${n(s.nCtx)} tokens <span class="ld-muted">· model trained to ${n(s.nCtxTrain)}</span>`],
      ['Slots', `${n(s.totalSlots)}${slot && slot.promptTokens ? ` <span class="ld-muted">· ${n(slot.promptTokens)} tokens held</span>` : ''}`],
      slot && ['Speculative', esc(slot.speculative)],
      slot && slot.sampling && ['Sampling', `temp ${+slot.sampling.temperature.toFixed(2)} · top-p ${+slot.sampling.top_p.toFixed(2)} · top-k ${slot.sampling.top_k} · min-p ${+slot.sampling.min_p.toFixed(2)}`],
      p && ['Process', `pid ${p.pid} <span class="ld-muted">· ${gb(p.rssBytes)} RAM</span>`],
      ['Address', esc(d.url)],
    ])}</div>`;
  }

  function cardModel(d) {
    const s = d.server || {};
    if (!s.reachable) return '';
    const mods = Object.entries(s.modalities || {}).filter(([, v]) => v).map(([k]) => k);
    return `<div class="ld-card"><h3>Model</h3>${rows([
      ['Name', esc(s.model)],
      ['Quantization', esc(s.quant)],
      ['Parameters', short(s.params)],
      ['File size', gb(s.sizeBytes)],
      ['Input', esc(['text', ...mods].join(', '))],
      s.modelPath && ['File', `<span class="ld-muted" title="${esc(s.modelPath)}">${esc(s.modelPath.split('/').pop())}</span>`],
    ])}</div>`;
  }

  function cardGpu(d) {
    const g = d.gpu;
    if (!g) return `<div class="ld-card"><h3>GPU</h3><div class="ld-muted">${d.local ? 'No reading: nvidia-smi is not available on this machine.' : 'llama-server runs on another machine, so its GPU cannot be read from here.'}</div></div>`;
    return `<div class="ld-card"><h3>GPU</h3>` + g.gpus.map((x, i) => {
      const mine = i === 0 && g.llamaMiB != null ? Math.min(g.llamaMiB, x.memUsedMiB) : 0;
      const other = Math.max(0, x.memUsedMiB - mine);
      const usedPct = Math.round((x.memUsedMiB / x.memTotalMiB) * 100);
      return `<div style="${i ? 'margin-top:14px' : ''}"><div><span class="ld-big">${gib(x.memUsedMiB).replace(' GiB', '')}</span><span class="ld-unit">of ${gib(x.memTotalMiB)} · ${usedPct}%</span></div>
        <div class="ld-bar" title="llama-server ${gib(mine)}, everything else ${gib(other)}"><span style="width:${(mine / x.memTotalMiB) * 100}%;background:#6366f1"></span><span style="width:${(other / x.memTotalMiB) * 100}%;background:#52525b"></span></div>
        <div class="ld-muted" style="margin-bottom:8px">${mine ? `<span style="color:#a5b4fc">■</span> llama-server ${gib(mine)} &nbsp; <span style="color:#71717a">■</span> other ${gib(other)} &nbsp; ` : ''}free ${gib(x.memTotalMiB - x.memUsedMiB)}</div>
        ${rows([
          ['Card', esc(x.name)],
          ['Temperature', x.tempC == null ? null : `<span class="${x.tempC >= 85 ? 'ld-warn' : ''}">${x.tempC} °C</span>`],
          ['Power', x.powerW == null ? null : `${Math.round(x.powerW)} W`],
          ['Load', x.utilPct == null ? null : `${x.utilPct}%`],
          ['Driver', esc(x.driver)],
        ])}</div>`;
    }).join('') + `</div>`;
  }

  function cardSpeed(d) {
    const s = d.speed || {}, m = d.metrics;
    let body;
    if (!s.answers) {
      body = `<div class="ld-muted">No answers recorded yet. Speed is measured from each answer llama-server gives this app, starting when the app starts (${esc(dayTime(s.since))}).</div>`;
    } else {
      body = `<div class="ld-stats">
          <div><div class="ld-big">${s.genTps.median ?? '—'}<span class="ld-unit">tok/s</span></div><div class="ld-muted">generation, median</div></div>
          ${s.promptTps.median != null ? `<div><div class="ld-big">${n(Math.round(s.promptTps.median))}<span class="ld-unit">tok/s</span></div><div class="ld-muted">prompt reading</div></div>` : ''}
          ${s.cacheSharePct != null ? `<div><div class="ld-big">${s.cacheSharePct}<span class="ld-unit">%</span></div><div class="ld-muted">prompt from cache</div></div>` : ''}
          ${s.draft ? `<div><div class="ld-big">${s.draft.acceptPct}<span class="ld-unit">%</span></div><div class="ld-muted">draft tokens accepted</div></div>` : ''}
        </div>${sparkline(s.series)}
        <div style="margin-top:10px">${rows([
          ['Answers', `${n(s.answers)} <span class="ld-muted">· since ${esc(dayTime(s.since))}</span>`],
          ['Generated', `${n(s.generatedTokens)} tokens`],
          ['Prompt', `${n(s.promptTokensProcessed)} read · ${n(s.promptTokensCached)} from cache`],
          s.draft && ['Drafts', `${n(s.draft.accepted)} of ${n(s.draft.drafted)} tokens accepted`],
        ])}</div>`;
    }
    const life = m
      ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid #27272a"><div class="ld-muted" style="margin-bottom:6px">Since llama-server started (all clients)</div>${rows([
          ['Generated', `${n(m.generatedTokens)} tokens`],
          ['Prompt', `${n(m.promptTokens)} read${m.promptTokensCached != null ? ` · ${n(m.promptTokensCached)} from cache` : ''}`],
          m.draft && ['Drafts', `${n(m.draft.accepted)} of ${n(m.draft.drafted)} accepted (${m.draft.acceptPct}%)`],
          m.draftPerPosition && ['By position', m.draftPerPosition.map(p => `#${p.position + 1} ${p.pct}%`).join(' · ')],
        ])}</div>`
      : (d.server?.reachable ? `<div class="ld-muted" style="margin-top:12px;padding-top:10px;border-top:1px solid #27272a">Add <code>--metrics</code> to the launch command for totals since llama-server started and draft acceptance by position.</div>` : '');
    return `<div class="ld-card"><h3>Speed <button class="ld-btn" data-act="reset-speed" title="Forget the recorded answers and start again">Reset</button></h3>${body}${life}</div>`;
  }

  function cardStability(d) {
    const x = d.xid;
    if (!x) return `<div class="ld-card"><h3>Stability</h3><div class="ld-muted">${d.local ? 'The kernel log is not readable from this app, so GPU errors cannot be listed.' : 'llama-server runs on another machine, so its GPU errors cannot be listed from here.'}</div></div>`;
    if (!x.events.length) return `<div class="ld-card"><h3>Stability</h3><div class="ld-ok">No GPU errors (Xid) in the last ${x.days} days.</div></div>`;
    return `<div class="ld-card"><h3>Stability</h3><div><span class="ld-warn">${x.total} GPU error${x.total > 1 ? 's' : ''}</span> <span class="ld-muted">(Xid) in the last ${x.days} days · latest ${esc(ago(x.events[0].at))}</span></div>
      <ul>${x.events.slice(0, 8).map(e => `<li title="${esc(e.detail)}"><span class="ld-when">${esc(dayTime(e.at))}</span><span class="ld-what">Xid ${e.code}${e.meaning ? ' — ' + esc(e.meaning) : ''}${e.process ? ` <span class="ld-muted">· ${esc(e.process)}</span>` : ''}</span></li>`).join('')}</ul></div>`;
  }

  function cardUpdates(d) {
    const c = d.checkout, u = d.updates;
    const btn = `<button class="ld-btn" data-act="check-updates" ${checking ? 'disabled' : ''}>${checking ? 'Checking…' : 'Check now'}</button>`;
    if (!c) return `<div class="ld-card ld-wide"><h3>Updates</h3><div class="ld-muted">${!d.server?.reachable && d.local ? 'llama-server is not running, so its checkout cannot be located. Set <code>LLAMA_CPP_DIR</code> in .env to check for updates while it is stopped.' : d.local ? 'The llama.cpp checkout was not found. It is located from the running llama-server binary; set <code>LLAMA_CPP_DIR</code> in .env if it was built elsewhere.' : 'llama-server runs on another machine. To compare a checkout on this machine against upstream, set <code>LLAMA_CPP_DIR</code> in .env.'}</div></div>`;
    let state;
    if (!u) state = `<div class="ld-muted">Not checked yet.</div>`;
    else if (u.error) state = `<div class="ld-warn">Could not check: ${esc(u.error)}</div>`;
    else if (!u.behind) state = `<div><span class="ld-ok">Up to date</span> <span class="ld-muted">with ${esc(u.branch)} · checked ${esc(ago(u.checkedAt))}</span></div>`;
    else {
      state = `<div><span class="ld-big">${n(u.behind)}</span><span class="ld-unit">commits behind ${esc(u.branch)}</span></div>
        <div class="ld-muted" style="margin:2px 0 8px">Checked ${esc(ago(u.checkedAt))} · <a href="${esc(u.compareUrl)}" target="_blank" rel="noopener">all changes on GitHub</a>${u.localAhead ? ` · ${u.localAhead} local commit${u.localAhead > 1 ? 's' : ''} not upstream` : ''}</div>`;
      if (u.relevant?.length) {
        state += `<div class="ld-muted">${u.relevantCount} of the newest ${u.listedCount} touch the server, CUDA, speculative decoding or chat handling:</div>
          <ul>${u.relevant.slice(0, 12).map(k => `<li><span class="ld-when">${esc(day(k.date))}</span><span class="ld-what"><a href="${esc(k.url)}" target="_blank" rel="noopener" title="${esc(k.subject)}">${esc(k.subject)}</a></span></li>`).join('')}</ul>`;
      }
      state += `<div class="ld-muted" style="margin-top:8px">Nothing is updated from here. Updating means <code>git pull</code> and a rebuild in ${esc(c.dir)}.</div>`;
    }
    const rel = u?.release
      ? `<a href="${esc(u.release.url)}" target="_blank" rel="noopener">${esc(u.release.tag)}</a> <span class="ld-muted">· ${esc(day(u.release.publishedAt))}${u.release.newerThanBuild ? ' · newer than this build' : ''}</span>` : null;
    return `<div class="ld-card ld-wide"><h3>Updates ${btn}</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">
        <div>${state}</div>
        <div>${rows([
          ['Checkout', esc(c.dir)],
          ['Version', `${esc(c.describe || '')} <span class="ld-muted">· ${esc(c.head.slice(0, 9))}${c.modified ? ' · local changes' : ''}</span>`],
          ['Built from', `${esc(day(c.date))} <span class="ld-muted">· ${esc(ago(c.date))}</span>`],
          ['Branch', esc(c.branch)],
          rel && ['Latest release', rel],
        ])}</div>
      </div></div>`;
  }

  function cardFlags(d) {
    const p = d.process;
    if (!p) return `<div class="ld-card ld-wide"><h3>Launch command</h3><div class="ld-muted">${!d.server?.reachable && d.local ? 'llama-server is not running.' : d.local ? 'No llama-server process was found on this machine for this address (it may run under another user or in a container), so its command line and memory use are not shown.' : 'llama-server runs on another machine, so its command line and memory use are not shown.'}</div></div>`;
    const lines = [p.exe || 'llama-server', ...p.flags.map(f => `  ${f.flag}${f.value ? ' ' + f.value : ''}`)].join(' \\\n');
    return `<div class="ld-card ld-wide"><h3>Launch command <button class="ld-btn" data-act="copy-cmd">Copy</button></h3>
      <div class="ld-muted">As it is running now${p.cwd ? `, started in ${esc(p.cwd)}` : ''}.</div><pre>${esc(lines)}</pre></div>`;
  }

  // ── render / poll ───────────────────────────────────
  let data = null, timer = null, badgeTimer = null, lastKey = '', checking = false;

  function render() {
    if (!data) { panel.innerHTML = '<div class="ld-wrap ld-muted">Loading…</div>'; return; }
    const d = data, s = d.server || {};
    const sub = s.reachable ? `${esc(s.model || '')} · ${esc(s.quant || '')} · ${n(s.nCtx)}-token window` : `llama-server at ${esc(d.url)}`;
    const notLlama = d.backend !== 'llama' ? `<div class="ld-alert info">The active backend is ${esc(d.backend)}. This page still describes the llama-server at ${esc(d.url)}.</div>` : '';
    panel.innerHTML = `<div class="ld-wrap">
      <div class="ld-head"><div><h2>Llama Dashboard</h2><div class="ld-sub">${sub}</div></div><button class="ld-close" data-act="close" aria-label="Close">&times;</button></div>
      ${notLlama}${(d.alerts || []).filter(a => a.level !== 'info').map(a => `<div class="ld-alert ${esc(a.level)}">${esc(a.text)}</div>`).join('')}
      <div class="ld-grid">${cardServer(d)}${cardGpu(d)}${cardSpeed(d)}${cardModel(d)}${cardStability(d)}${cardUpdates(d)}${cardFlags(d)}</div>
    </div>`;
  }

  function setBadge(d) {
    const warn = (d?.alerts || []).filter(a => a.level !== 'info');
    button.classList.toggle('ld-alerting', warn.length > 0);
    button.title = warn.length ? warn.map(a => a.text).join('\n') : 'Llama Dashboard — server, GPU, speed, stability, updates';
  }

  async function load(path = '/api/llama/dashboard', method = 'GET') {
    try {
      const res = await fetch(path, { method });
      const d = await res.json();
      if (d.error && !d.server) throw new Error(d.error);
      data = d;
      setBadge(d);
      // `at` changes on every answer; redraw only when something shown did
      const key = JSON.stringify({ ...d, at: null }) + checking;
      if (key !== lastKey && isOpen()) { lastKey = key; render(); }
    } catch (e) {
      if (isOpen() && !data) panel.innerHTML = `<div class="ld-wrap ld-err">Could not load the dashboard: ${esc(e.message)}</div>`;
    }
  }

  const isOpen = () => !panel.classList.contains('ld-hidden');

  function open() {
    // one overlay at a time: close the Plugins panel through its own button (stops its poll)
    if (!pluginPanel.classList.contains('hidden')) document.getElementById('plugin-config-close')?.click();
    panel.classList.remove('ld-hidden');
    lastKey = '';
    render();
    load();
    timer = setInterval(() => load(), POLL_OPEN_MS);
  }
  function close() {
    panel.classList.add('ld-hidden');
    clearInterval(timer); timer = null;
  }

  button.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? close() : open(); });
  document.getElementById('plugins-toggle')?.addEventListener('click', () => { if (isOpen()) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen() && !e.defaultPrevented) close(); });

  panel.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') return close();
    if (act === 'check-updates') {
      checking = true; lastKey = ''; render();
      await load('/api/llama/check-updates', 'POST');
      checking = false; lastKey = ''; render();
    } else if (act === 'reset-speed') {
      await fetch('/api/llama/speed/reset', { method: 'POST' }).catch(() => {});
      load();
    } else if (act === 'copy-cmd' && data?.process) {
      const btn = e.target.closest('[data-act]');
      try { await navigator.clipboard.writeText(data.process.command); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
      setTimeout(() => { lastKey = ''; render(); }, 1500);
    }
  });

  // The alert dot on the button, while the panel is closed
  load();
  badgeTimer = setInterval(() => { if (!isOpen()) load(); }, POLL_BADGE_MS);
  window.LlamaDashboard = { open, close };
})();
