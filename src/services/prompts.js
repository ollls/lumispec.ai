import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const PROMPTS_FILE = join(DATA_DIR, 'prompts.json');

function load() {
  if (!existsSync(PROMPTS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PROMPTS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function save(prompts) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PROMPTS_FILE, JSON.stringify(prompts, null, 2));
}

export function listPrompts() {
  return load();
}

export function createPrompt(text, title) {
  const prompts = load();
  const prompt = { id: randomUUID(), title: title || null, text, createdAt: new Date().toISOString() };
  prompts.unshift(prompt);
  save(prompts);
  return prompt;
}

export function deletePrompt(id) {
  const prompts = load();
  const idx = prompts.findIndex(p => p.id === id);
  if (idx === -1) return false;
  prompts.splice(idx, 1);
  save(prompts);
  return true;
}

export function reorderPrompts(ids) {
  const prompts = load();
  const byId = new Map(prompts.map(p => [p.id, p]));
  const reordered = ids.map(id => byId.get(id)).filter(Boolean);
  // append any prompts not in the ids list (safety)
  for (const p of prompts) {
    if (!ids.includes(p.id)) reordered.push(p);
  }
  save(reordered);
  return reordered;
}

export function updatePrompt(id, { text, title } = {}) {
  const prompts = load();
  const prompt = prompts.find(p => p.id === id);
  if (!prompt) return null;
  if (text !== undefined) prompt.text = text;
  if (title !== undefined) prompt.title = title;
  save(prompts);
  return prompt;
}
