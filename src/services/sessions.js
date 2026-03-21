import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');

function load() {
  if (!existsSync(SESSIONS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function save(sessions) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

export function listSessions() {
  return load();
}

/** Upsert: if a session with this color exists, overwrite it; otherwise create new */
export function upsertSession(color, text, title) {
  const sessions = load();
  const idx = sessions.findIndex(s => s.color === color);
  const session = {
    id: idx !== -1 ? sessions[idx].id : randomUUID(),
    color,
    title: title || null,
    text,
    updatedAt: new Date().toISOString(),
  };
  if (idx !== -1) {
    sessions[idx] = session;
  } else {
    sessions.push(session);
  }
  save(sessions);
  return session;
}

export function deleteSession(id) {
  const sessions = load();
  const idx = sessions.findIndex(s => s.id === id);
  if (idx === -1) return false;
  sessions.splice(idx, 1);
  save(sessions);
  return true;
}
