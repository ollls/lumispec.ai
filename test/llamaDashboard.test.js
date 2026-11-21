import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBuildInfo, parseCmdline, flagsFromArgv, flagValue, parsePrometheus, parseNvidiaSmi,
  parseXidLines, isRelevantCommit, summarizeCommits, githubRepoOf, speedOf, summarizeSpeed,
  buildAlerts, isLocalHost,
} from '../src/services/llamaDashboard.js';

test('parseBuildInfo reads build number and commit', () => {
  assert.deepEqual(parseBuildInfo('b11719-5aeac37a3'), { build: 11719, commit: '5aeac37a3' });
  assert.deepEqual(parseBuildInfo('v1.0.0'), { build: null, commit: null });
  assert.deepEqual(parseBuildInfo(undefined), { build: null, commit: null });
});

test('command line → flags, values joined, negative numbers are values', () => {
  const argv = parseCmdline(['./llama-server', '--jinja', '-hf', 'org/model:Q6', '--ctx-size', '114688', '--seed', '-1', '--port', '8080', ''].join('\u0000'));
  const flags = flagsFromArgv(argv);
  assert.deepEqual(flags, [
    { flag: '--jinja', value: '' },
    { flag: '-hf', value: 'org/model:Q6' },
    { flag: '--ctx-size', value: '114688' },
    { flag: '--seed', value: '-1' },
    { flag: '--port', value: '8080' },
  ]);
  assert.equal(flagValue(flags, '-c', '--ctx-size'), '114688');
  assert.equal(flagValue(flags, '--metrics'), null);
});

test('parsePrometheus: plain values and the labeled per-position counter', () => {
  const { values, labeled } = parsePrometheus([
    '# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed.',
    '# TYPE llamacpp:prompt_tokens_total counter',
    'llamacpp:prompt_tokens_total 12345',
    'llamacpp:predicted_tokens_seconds 61.5',
    'llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="0"} 900',
    'llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="1"} 400',
    'garbage line',
  ].join('\n'));
  assert.equal(values.prompt_tokens_total, 12345);
  assert.equal(values.predicted_tokens_seconds, 61.5);
  assert.deepEqual(labeled.spec_decode_num_accepted_tokens_per_pos_total, { 0: 900, 1: 400 });
});

test('parseNvidiaSmi: card readings and memory per pid', () => {
  const { gpus, apps } = parseNvidiaSmi(
    '0, NVIDIA GeForce RTX 5090, 30902, 32607, 1, 49, 29.47, 595.84\n',
    '4454, 42\n16989, 30038\n16989, 10\n',
  );
  assert.equal(gpus.length, 1);
  assert.deepEqual(gpus[0], { index: 0, name: 'NVIDIA GeForce RTX 5090', memUsedMiB: 30902, memTotalMiB: 32607, utilPct: 1, tempC: 49, powerW: 29.47, driver: '595.84' });
  assert.equal(apps[16989], 30048);
  assert.deepEqual(parseNvidiaSmi('', ''), { gpus: [], apps: {} });
});

test('parseXidLines keeps only Xid lines, with code, process and UTC time', () => {
  const ev = parseXidLines([
    '2026-11-16T21:47:22-0500 pop-os kernel: NVRM: Xid (PCI:0000:01:00): 8, pid=9594, name=llama-server, channel 0x00000011',
    '2026-11-17T08:00:00-0500 pop-os kernel: wlp3s0: Limiting TX power',
    '2026-11-18T01:02:03+0100 pop-os kernel: NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus.',
  ].join('\n'));
  assert.equal(ev.length, 2);
  assert.equal(ev[0].code, 8);
  assert.equal(ev[0].pid, 9594);
  assert.equal(ev[0].process, 'llama-server');
  assert.equal(ev[0].at, '2026-11-17T02:47:22.000Z');
  assert.equal(ev[1].code, 79);
  assert.equal(ev[1].process, null);
});

test('isRelevantCommit: server, CUDA and speculative yes; other backends, UI and docs no', () => {
  for (const s of ['server: fix slot restore', 'ggml-cuda: fattn do not check oob', 'CUDA: abort on UB in fastdiv (#32698)',
    'spec: draft-mtp position stats', 'llama : remove fused lightning indexer gating', 'chat (qwen): tool call parser', 'fix MTP draft with q8_0 KV cache']) {
    assert.equal(isRelevantCommit(s), true, s);
  }
  for (const s of ['sycl: add fused ADD', 'ui: open the context gauge panel', 'ggml-zdnn: fix ztensor load race', 'ggml-cpu: fix nc alignment',
    'mtmd: support kyutai', 'docs: update README', 'vulkan: cuda-style fastdiv', 'llama-grammar: Fix integer overflow']) {
    assert.equal(isRelevantCommit(s), false, s);
  }
});

test('summarizeCommits takes the first line and flags relevance', () => {
  const out = summarizeCommits([{ sha: 'abcdef0123456789', html_url: 'u', commit: { message: 'server: x\n\nbody', committer: { date: '2026-11-21T00:00:00Z' } } }, {}]);
  assert.deepEqual(out[0], { sha: 'abcdef012', subject: 'server: x', date: '2026-11-21T00:00:00Z', url: 'u', relevant: true });
  assert.equal(out[1].subject, '');
  assert.deepEqual(summarizeCommits(null), []);
});

test('githubRepoOf handles https and ssh remotes', () => {
  assert.equal(githubRepoOf('https://github.com/ggml-org/llama.cpp.git'), 'ggml-org/llama.cpp');
  assert.equal(githubRepoOf('git@github.com:ggml-org/llama.cpp.git\n'), 'ggml-org/llama.cpp');
  assert.equal(githubRepoOf('https://gitlab.com/a/b.git'), null);
});

test('speedOf ignores non-llama usage objects', () => {
  assert.equal(speedOf({ prompt_tokens: 10, completion_tokens: 5 }), null);
  assert.equal(speedOf(null), null);
  assert.deepEqual(
    speedOf({ predicted_per_second: 61.234, predicted_n: 400, prompt_per_second: 1905.77, prompt_n: 80, cache_n: 6300, draft_n: 300, draft_n_accepted: 210 }),
    { gen: 61.2, genN: 400, prompt: 1905.8, promptN: 80, cacheN: 6300, draftN: 300, draftAccepted: 210 },
  );
});

test('summarizeSpeed: medians, cache share, draft acceptance; tiny answers excluded from speed', () => {
  const s = summarizeSpeed([
    { gen: 60, genN: 400, prompt: 2000, promptN: 6000, cacheN: 0, draftN: 100, draftAccepted: 70 },
    { gen: 50, genN: 300, prompt: 900, promptN: 80, cacheN: 6400, draftN: 100, draftAccepted: 50 },
    { gen: 999, genN: 3, prompt: 10, promptN: 20, cacheN: 6500 },
    null,
  ]);
  assert.equal(s.answers, 3);
  assert.equal(s.genTps.median, 55);
  assert.equal(s.genTps.max, 60);
  assert.equal(s.promptTps.median, 2000);
  assert.equal(s.generatedTokens, 703);
  assert.equal(s.cacheSharePct, 67.9);
  assert.deepEqual(s.draft, { drafted: 200, accepted: 120, acceptPct: 60 });
  assert.deepEqual(s.series, [60, 50]);
  assert.equal(summarizeSpeed([]).genTps.median, null);
});

test('buildAlerts: recent Xid and full memory warn, old Xid does not, behind is info', () => {
  const recent = new Date(Date.now() - 3600e3).toISOString();
  const old = new Date(Date.now() - 5 * 86400e3).toISOString();
  const a = buildAlerts({
    server: { reachable: true },
    gpu: { gpus: [{ index: 0, memUsedMiB: 32000, memTotalMiB: 32607, tempC: 60 }] },
    xid: { events: [{ at: recent, code: 8 }] },
    updates: { behind: 900, branch: 'master' },
  });
  assert.deepEqual(a.map(x => x.level), ['warn', 'warn', 'info']);
  assert.deepEqual(buildAlerts({ server: { reachable: true }, gpu: null, xid: { events: [{ at: old, code: 8 }] }, updates: null }), []);
  assert.equal(buildAlerts({ server: { reachable: false } })[0].level, 'error');
});

test('isLocalHost', () => {
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('127.0.0.1'), true);
  assert.equal(isLocalHost('192.168.1.20'), false);
});
