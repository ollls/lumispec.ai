import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const TEMPLATES_FILE = join(DATA_DIR, 'templates.json');

function load() {
  if (!existsSync(TEMPLATES_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TEMPLATES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function save(templates) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
}

export function listTemplates() {
  return load().map(({ id, name, type, createdAt }) => ({ id, name, type, createdAt }));
}

export function createTemplate(name, type, html) {
  const templates = load();
  const template = { id: randomUUID(), name, type, html, createdAt: new Date().toISOString() };
  templates.unshift(template);
  save(templates);
  return { id: template.id, name, type, createdAt: template.createdAt };
}

export function deleteTemplate(id) {
  const templates = load();
  const idx = templates.findIndex(t => t.id === id);
  if (idx === -1) return false;
  templates.splice(idx, 1);
  save(templates);
  return true;
}

export function getTemplate(id) {
  return load().find(t => t.id === id) || null;
}

export function getTemplateByName(name) {
  return load().find(t => t.name.toLowerCase() === name.toLowerCase()) || null;
}
