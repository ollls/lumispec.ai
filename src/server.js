import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, extname } from 'path';
import { exec } from 'child_process';
import { stat, readdir } from 'fs/promises';
import { createReadStream } from 'fs';
import config from './config.js';
import conversationRoutes from './routes/conversations.js';
import slotRoutes from './routes/slots.js';
import healthRoutes from './routes/health.js';
import etradeRoutes from './routes/etrade.js';
import promptRoutes from './routes/prompts.js';
import toolRoutes from './routes/tools.js';
import templateRoutes from './routes/templates.js';
import sessionRoutes from './routes/sessions.js';
import compactRoutes from './routes/compacts.js';
import taskRoutes from './routes/tasks.js';
import taskProcessorRoutes from './routes/taskProcessor.js';
import slots from './services/slots.js';
import { loadPlugins } from './services/tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));

app.use('/api/conversations', conversationRoutes);
app.use('/api/slots', slotRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/etrade', etradeRoutes);
app.use('/api/prompts', promptRoutes);
app.use('/api/tools', toolRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/compacts', compactRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/conversations', taskProcessorRoutes);

// Serve project directory files (follows source_project switches)
app.use('/files', (req, res, next) => {
  if (!config.sourceDir) return res.status(404).json({ error: 'No source directory configured' });
  express.static(resolve(config.sourceDir))(req, res, next);
});

// List data files in source directory (optionally filtered by substring in ?match=)
app.get('/api/files', async (_req, res) => {
  if (!config.sourceDir) return res.status(404).json({ error: 'No source directory configured' });
  try {
    const dir = resolve(config.sourceDir);
    const entries = await readdir(dir);
    // Only expose data files, not directories or sensitive files
    const dataExts = new Set(['.csv', '.json', '.html', '.txt', '.md', '.png', '.jpg', '.svg']);
    const hidden = new Set(['.env', '.env.example', '.claudeignore', 'package-lock.json']);
    let files = entries.filter(f => {
      if (f.startsWith('.') || hidden.has(f)) return false;
      const ext = f.slice(f.lastIndexOf('.'));
      return dataExts.has(ext);
    });
    const match = _req.query.match;
    if (match) files = files.filter(f => f.includes(match));
    res.json(files.sort());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ location: config.location, terminal: !!config.terminal, sourceDir: config.sourceDir || '' });
});

app.post('/api/terminal', (_req, res) => {
  if (!config.terminal) return res.status(400).json({ error: 'TERMINAL not configured in .env' });
  const cwd = config.sourceDir ? resolve(config.sourceDir) : process.env.HOME;
  const term = config.terminal;
  // Terminal-specific working directory flags
  const cwdFlags = {
    'cosmic-term': `-w "${cwd}"`,
    'kitty': `-d "${cwd}"`,
    'alacritty': `--working-directory "${cwd}"`,
  };
  const bin = term.split('/').pop(); // handle full paths like /usr/bin/cosmic-term
  const flag = cwdFlags[bin] || `--working-directory="${cwd}"`;
  exec(`${term} ${flag}`, (err) => {
    if (err) console.warn('[terminal]', err.message);
  });
  res.json({ ok: true, cwd });
});

// File proxy — serves local files by absolute path
// Allowed MIME type prefixes (extend as needed)
const PROXY_ALLOWED = ['image/'];
app.get('/api/file', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Missing ?path= parameter' });
  const resolved = resolve(filePath);
  const ext = extname(resolved).toLowerCase();
  const mimeMap = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
    '.pdf': 'application/pdf', '.json': 'application/json',
    '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html',
    '.md': 'text/markdown', '.xml': 'text/xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  };
  const mime = mimeMap[ext];
  if (!mime) return res.status(403).json({ error: `File type ${ext} not allowed` });
  if (!PROXY_ALLOWED.some(prefix => mime.startsWith(prefix))) {
    return res.status(403).json({ error: `MIME type ${mime} not in allowed list` });
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return res.status(400).json({ error: 'Not a file' });
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', info.size);
    res.setHeader('Cache-Control', 'private, max-age=300');
    createReadStream(resolved).pipe(res);
  } catch (e) {
    res.status(404).json({ error: 'File not found' });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'views', 'index.html'));
});

// Load tool plugins before starting the server
await loadPlugins();

const server = app.listen(config.port, () => {
  console.log(`LLM Workbench running at http://localhost:${config.port}`);
  slots.startPolling();
});

process.on('SIGTERM', () => {
  slots.stopPolling();
  server.close();
});
