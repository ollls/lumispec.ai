import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { splitTemplateNotes } from './templateExpansion.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const TEMPLATES_FILE = join(DATA_DIR, 'templates.json');

function load() {
  if (!existsSync(TEMPLATES_FILE)) return [];
  let templates;
  try {
    templates = JSON.parse(readFileSync(TEMPLATES_FILE, 'utf-8'));
  } catch {
    return [];
  }
  // Records saved before `notes` existed carry the author's comment inside `html`; move it once.
  let migrated = false;
  for (const t of templates) {
    const { notes, html } = splitTemplateNotes(t.html);
    if (!notes) continue;
    t.notes = t.notes ? `${t.notes}\n\n${notes}` : notes;
    t.html = html;
    migrated = true;
  }
  if (migrated) save(templates);
  return templates;
}

function save(templates) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
}

export function listTemplates() {
  return load().map(({ id, name, type, createdAt, review, notes }) => ({ id, name, type, createdAt, review, notes }));
}

/**
 * `review` is the LLM review's state on this template (see services/templateReview.js):
 * { status: 'pending' | 'done' | 'failed' | 'skipped', changed?, issues?, remaining?, reason?, at }.
 * Absent on templates saved before the review existed.
 *
 * `notes` are the author's instructions to the assistant. They arrive as HTML comments ahead of
 * the markup and are split off here (`splitTemplateNotes`), so `html` is only what the model
 * copies and the review rewrites; the prompt shows the notes outside the code fence.
 */
export function createTemplate(name, type, html, review) {
  const templates = load();
  const split = splitTemplateNotes(html);
  const template = { id: randomUUID(), name, type, html: split.html, createdAt: new Date().toISOString() };
  if (split.notes) template.notes = split.notes;
  if (review) template.review = review;
  templates.unshift(template);
  save(templates);
  return { id: template.id, name, type, createdAt: template.createdAt, review: template.review };
}

export function reorderTemplates(ids) {
  const templates = load();
  const byId = new Map(templates.map(t => [t.id, t]));
  const reordered = ids.map(id => byId.get(id)).filter(Boolean);
  for (const t of templates) {
    if (!ids.includes(t.id)) reordered.push(t);
  }
  save(reordered);
  return reordered;
}

/**
 * New `html` with a leading comment replaces the notes (a re-saved file carries its own); without
 * one it leaves them alone (the LLM review hands back markup only). `notes` set explicitly wins;
 * an empty string removes them.
 */
export function updateTemplate(id, { name, type, html, review, notes } = {}) {
  const templates = load();
  const template = templates.find(t => t.id === id);
  if (!template) return null;
  if (name !== undefined) template.name = name;
  if (type !== undefined) template.type = type;
  if (html !== undefined) {
    const split = splitTemplateNotes(html);
    template.html = split.html;
    if (split.notes) template.notes = split.notes;
  }
  if (notes !== undefined) {
    if (notes && String(notes).trim()) template.notes = String(notes).trim();
    else delete template.notes;
  }
  if (review !== undefined) template.review = review;
  save(templates);
  return template;
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
