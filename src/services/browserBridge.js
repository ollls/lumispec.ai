// Browser bridge — WebSocket endpoint the Lumispec Browser Search Chrome extension
// (extension/) connects to. The extension runs searches and page loads in a hidden tab of
// the user's real browser and sends parsed results back. One extension connection at a
// time; a newer connection (extension reloaded) replaces the older one.
//
// Attached to the main Express HTTP server at /ws/browser (same port as the UI), so the
// endpoint is live whenever the server runs — the extension can connect before the
// Browser Search plugin is even enabled, and the status dot goes green as soon as it does.
//
// Protocol (JSON text frames):
//   ext → srv  { type: 'hello', version, engines: [...], capabilities: [...], ua }
//   srv → ext  { type: 'search', id, engine, query, limit }
//   srv → ext  { type: 'fetch',  id, url, maxChars }
//   ext → srv  { type: 'result', id, engine?, results?, page?, ms }
//   ext → srv  { type: 'error',  id, message }
// Liveness uses WebSocket protocol-level ping/pong (browsers answer automatically).

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import config from '../config.js';

const PATH = '/ws/browser';
const HEARTBEAT_MS = 30000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

class BrowserBridge {
  #wss = null;
  #socket = null;
  #hello = null;
  #pending = new Map(); // id → { resolve, reject, timer }
  #heartbeat = null;
  lastSeen = null;        // Date of last message/pong from the extension
  lastConnected = null;   // Date of last successful connection
  everConnected = false;

  get connected() {
    return !!this.#socket && this.#socket.readyState === this.#socket.OPEN;
  }

  get info() {
    return {
      connected: this.connected,
      everConnected: this.everConnected,
      lastSeen: this.lastSeen?.toISOString() || null,
      lastConnected: this.lastConnected?.toISOString() || null,
      extension: this.#hello ? { version: this.#hello.version, engines: this.#hello.engines, capabilities: this.#hello.capabilities } : null,
      pending: this.#pending.size,
      path: PATH,
    };
  }

  /** @param {import('node:http').Server} server */
  attach(server) {
    if (this.#wss) return;
    this.#wss = new WebSocketServer({
      server,
      path: PATH,
      verifyClient: ({ req }, done) => {
        // Loopback only: anything that can reach this socket can drive the user's browser.
        const addr = req.socket.remoteAddress || '';
        if (!LOOPBACK.has(addr)) return done(false, 403, 'Loopback connections only');
        const token = config.browserSearch.token;
        if (token) {
          const url = new URL(req.url, 'http://localhost');
          if (url.searchParams.get('token') !== token) return done(false, 401, 'Bad token');
        }
        done(true);
      },
    });
    this.#wss.on('connection', (ws) => this.#onConnection(ws));
    this.#wss.on('error', (err) => console.error(`[browser-bridge] server error: ${err.message}`));
    this.#heartbeat = setInterval(() => this.#pingAlive(), HEARTBEAT_MS);
    this.#heartbeat.unref?.();
    console.log(`[browser-bridge] listening on ws://localhost:${config.port}${PATH}${config.browserSearch.token ? ' (token required)' : ''}`);
  }

  close() {
    clearInterval(this.#heartbeat);
    this.#rejectAll(new Error('Bridge closed'));
    try { this.#socket?.close(1001, 'server shutdown'); } catch {}
    this.#wss?.close();
    this.#wss = null;
  }

  #onConnection(ws) {
    if (this.#socket && this.#socket !== ws) {
      console.log('[browser-bridge] new extension connection replaces the previous one');
      this.#rejectAll(new Error('Extension reconnected'));
      try { this.#socket.close(1000, 'replaced by newer connection'); } catch {}
    }
    this.#socket = ws;
    this.#hello = null;
    this.everConnected = true;
    this.lastConnected = new Date();
    this.lastSeen = new Date();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; this.lastSeen = new Date(); });
    ws.on('message', (data) => this.#onMessage(ws, data));
    ws.on('close', (code, reason) => {
      if (this.#socket === ws) {
        this.#socket = null;
        this.#rejectAll(new Error('Browser extension disconnected'));
        console.log(`[browser-bridge] extension disconnected (${code}${reason ? ' ' + reason : ''})`);
      }
    });
    ws.on('error', (err) => console.warn(`[browser-bridge] socket error: ${err.message}`));
    console.log('[browser-bridge] extension connected');
  }

  #onMessage(ws, data) {
    if (ws !== this.#socket) return;
    this.lastSeen = new Date();
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg.type) {
      case 'hello':
        this.#hello = msg;
        console.log(`[browser-bridge] extension v${msg.version} — engines: ${(msg.engines || []).join(', ')}`);
        return;
      case 'pong':
        return;
      case 'result':
      case 'error': {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.type === 'error') p.reject(new Error(msg.message || 'Extension reported an error'));
        else p.resolve(msg);
        return;
      }
      default:
        console.warn(`[browser-bridge] unknown message type "${msg.type}"`);
    }
  }

  #pingAlive() {
    const ws = this.#socket;
    if (!ws) return;
    if (ws.isAlive === false) {
      console.warn('[browser-bridge] extension missed heartbeat — dropping connection');
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }

  #rejectAll(err) {
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.#pending.clear();
  }

  #request(payload, timeoutMs) {
    if (!this.connected) return Promise.reject(new Error('Browser extension not connected'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Browser extension did not answer within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify({ id, ...payload }));
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** @returns {Promise<{ engine: string, results: Array<{title:string,url:string,description:string}>, ms: number }>} */
  async search(engine, query, limit = 8) {
    const msg = await this.#request({ type: 'search', engine, query, limit }, config.browserSearch.timeoutMs);
    return { engine: msg.engine || engine, results: Array.isArray(msg.results) ? msg.results : [], ms: msg.ms };
  }

  /** @returns {Promise<{ title: string, url: string, html: string, ms: number }>} */
  async fetchPage(url, maxChars = 2_000_000) {
    const msg = await this.#request({ type: 'fetch', url, maxChars }, config.browserSearch.timeoutMs);
    if (!msg.page || typeof msg.page.html !== 'string') throw new Error('Extension returned no page content');
    return { ...msg.page, ms: msg.ms };
  }
}

const bridge = new BrowserBridge();
export default bridge;
