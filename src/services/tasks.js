import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const TASKS_FILE = join(DATA_DIR, 'tasks.json');

function load() {
  if (!existsSync(TASKS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function save(tasks) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

export function listTasks() {
  return load();
}

export function createTask(text, title) {
  const tasks = load();
  const task = { id: randomUUID(), title: title || null, text, createdAt: new Date().toISOString() };
  tasks.unshift(task);
  save(tasks);
  return task;
}

export function deleteTask(id) {
  const tasks = load();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  save(tasks);
  return true;
}

export function reorderTasks(ids) {
  const tasks = load();
  const byId = new Map(tasks.map(t => [t.id, t]));
  const reordered = ids.map(id => byId.get(id)).filter(Boolean);
  for (const t of tasks) {
    if (!ids.includes(t.id)) reordered.push(t);
  }
  save(reordered);
  return reordered;
}

export function updateTask(id, { text, title } = {}) {
  const tasks = load();
  const task = tasks.find(t => t.id === id);
  if (!task) return null;
  if (text !== undefined) task.text = text;
  if (title !== undefined) task.title = title;
  save(tasks);
  return task;
}
