// Analysis B — how much of every request is tool-protocol scaffolding that
// native tool calling would move out of the system prompt.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);   // config.js and plugin loading expect repo root as cwd
const { loadPlugins, getSystemPrompt, listTools } = await import(join(ROOT, 'src/tools/index.js'));

await loadPlugins();

const tools = listTools();
console.log(`loaded tools: ${tools.length} (${tools.filter(t => t.enabled).length} enabled)`);

const prompt = await getSystemPrompt({ applets: true, precision: false });
const chars = prompt.length;

// Qwen-family BPE averages ~3.5-4.0 chars/token on mixed English+code prose.
const TOK = c => ({ lo: Math.round(c / 4.0), hi: Math.round(c / 3.5) });
const fmt = c => { const t = TOK(c); return `${c} chars ≈ ${t.lo}-${t.hi} tok`; };

console.log(`\n=== FULL SYSTEM PROMPT ===`);
console.log(fmt(chars));

// Isolate the section native tool calling would delete: the mandatory
// <tool_call> protocol block + the rendered tool list + tool rules.
const start = prompt.indexOf('## Tool Call Format');
const endMarker = prompt.indexOf('- REMINDER: tool calls without <tool_call> tags DO NOT EXECUTE.');
const protoEnd = endMarker >= 0 ? endMarker + '- REMINDER: tool calls without <tool_call> tags DO NOT EXECUTE.'.length : -1;

if (start >= 0 && protoEnd > start) {
  const block = prompt.slice(start, protoEnd);
  console.log(`\n=== TOOL-PROTOCOL BLOCK (deleted under native) ===`);
  console.log(fmt(block.length));
  console.log(`share of system prompt: ${(100 * block.length / chars).toFixed(1)}%`);

  // Split protocol boilerplate vs the actual tool descriptions
  const listStart = block.indexOf('Available tools:');
  const boiler = block.slice(0, listStart);
  const list = block.slice(listStart);
  console.log(`  protocol boilerplate (the all-caps enforcement): ${fmt(boiler.length)}`);
  console.log(`  rendered tool list (survives, re-encoded as schemas): ${fmt(list.length)}`);
} else {
  console.log('\n[!] could not locate protocol block markers');
}

// Cost per conversation turn: system prompt is re-sent on every round of the loop.
const t = TOK(chars);
console.log(`\n=== RESEND COST ===`);
console.log(`The system prompt is re-sent on every request. A tool-using turn runs`);
console.log(`multiple rounds (loop cap = 20).`);
for (const rounds of [1, 3, 5, 20]) {
  console.log(`  ${String(rounds).padStart(2)} round(s): ${(t.lo * rounds).toLocaleString()}-${(t.hi * rounds).toLocaleString()} tok of system prompt`);
}
