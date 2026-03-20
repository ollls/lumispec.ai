import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { mkdir, writeFile, readFile, readdir, stat, unlink, appendFile } from 'fs/promises';
import { join, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { spawn } from 'child_process';
import config from '../config.js';
import etrade from './etrade.js';
import liteapi from './liteapi.js';

const __dirname = import.meta.dirname || (() => { const f = fileURLToPath(import.meta.url); return f.substring(0, f.lastIndexOf('/')); })();
const DATA_DIR = resolve(__dirname, '../../data');
const LOG_DIR = resolve(__dirname, '../../logs');

// ── Tool call logger ────────────────────────────────
async function logToolCall(toolName, action, { args, rawResult, formattedResult }) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const now = new Date();
    const ts = now.toISOString();
    const logFile = join(LOG_DIR, `tools_${now.toISOString().split('T')[0]}.log`);
    const entry = {
      timestamp: ts,
      tool: toolName,
      action,
      args,
      raw: rawResult,
      formatted: formattedResult,
    };
    const line = `\n${'═'.repeat(80)}\n[${ts}] ${toolName}:${action}\n${'─'.repeat(80)}\nARGS: ${JSON.stringify(args)}\n─── RAW ───\n${JSON.stringify(rawResult, null, 2)}\n─── FORMATTED (to LLM) ───\n${JSON.stringify(formattedResult, null, 2)}\n`;
    await appendFile(logFile, line, 'utf-8');
  } catch (err) {
    console.warn(`[logToolCall] failed: ${err.message}`);
  }
}
const PYTHON_VENV = (config.python.venvPath || '').replace(/^~/, homedir());

// ── File save helper ─────────────────────────────────
async function saveToFile(filename, content) {
  const safe = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe || safe.startsWith('.')) return { error: `Invalid filename: ${filename}` };
  await mkdir(DATA_DIR, { recursive: true });
  const filePath = join(DATA_DIR, safe);
  await writeFile(filePath, content, 'utf-8');
  return { url: `/files/${encodeURIComponent(safe)}`, filename: safe, size: Buffer.byteLength(content, 'utf-8') };
}

// ── Shared helpers ───────────────────────────────────
function formatExpiry(p) {
  if (!p.expiryYear) return '';
  const yr = Number(p.expiryYear);
  const fullYear = yr < 100 ? 2000 + yr : yr;
  return `${fullYear}-${String(p.expiryMonth).padStart(2, '0')}-${String(p.expiryDay).padStart(2, '0')}`;
}
// E*TRADE returns strikePrice:0 for equities — treat 0 as empty
function formatStrike(v) { return v != null && v !== 0 ? v : ''; }

// ── CSV helpers ──────────────────────────────────────
function csvEscape(v) {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map(r => r.map(csvEscape).join(','))].join('\n');
}

function transactionsToCsv(data) {
  const txns = data.Transaction || [];
  if (!txns.length) return '';
  const headers = ['Date', 'Transaction ID', 'Type', 'Symbol', 'Security Type', 'Call/Put', 'Strike', 'Expiry', 'Quantity', 'Price', 'Amount', 'Fee', 'Description'];
  const rows = txns.map(t => {
    const b = t.brokerage || {};
    const p = b.product || {};
    const date = new Date(t.transactionDate).toISOString().split('T')[0];
    const expiry = formatExpiry(p);
    return [date, t.transactionId, t.transactionType, p.symbol || '', p.securityType || '', p.callPut || '', formatStrike(p.strikePrice), expiry, b.quantity ?? '', b.price ?? '', t.amount ?? '', b.fee ?? '', t.description?.trim() || ''];
  });
  return toCsv(headers, rows);
}

function portfolioToCsv(data) {
  const positions = data?.AccountPortfolio?.[0]?.Position || [];
  if (!positions.length) return '';
  const headers = ['Symbol', 'Description', 'Security Type', 'Call/Put', 'Strike', 'Expiry', 'Quantity', 'Price Paid', 'Market Value', 'Total Cost', 'Total Gain', 'Total Gain Pct', 'Day Gain', 'Day Gain Pct', 'Current Price', 'Change', 'Change Pct'];
  const rows = positions.map(pos => {
    const p = pos.Product || pos.product || {};
    const q = pos.Quick || pos.quick || {};
    const expiry = formatExpiry(p);
    return [
      p.symbol || pos.symbolDescription || '', pos.symbolDescription || '', p.securityType || '',
      p.callPut || '', formatStrike(p.strikePrice), expiry,
      pos.quantity ?? '', pos.pricePaid ?? '', pos.marketValue ?? '',
      pos.totalCost ?? '', pos.totalGain ?? '', pos.totalGainPct ?? '',
      q.lastTrade ?? pos.Quick?.lastTrade ?? '',
      q.change ?? '', q.changePct ?? '',
      pos.daysGain ?? '', pos.daysGainPct ?? '',
    ];
  });
  return toCsv(headers, rows);
}

function balanceToCsv(data) {
  const b = data || {};
  const c = b.Computed || b.computed || {};
  const headers = ['Account ID', 'Account Type', 'Net Cash', 'Cash Balance', 'Market Value', 'Total Account Value', 'Cash Buying Power', 'Margin Buying Power', 'Day Trader Buying Power'];
  const row = [
    b.accountId || '', b.accountType || '',
    c.cashAvailableForInvestment ?? b.cashAvailableForInvestment ?? '',
    c.cashBalance ?? b.cashBalance ?? '',
    c.RealTimeValues?.totalMarketValue ?? c.totalMarketValue ?? '',
    c.RealTimeValues?.totalAccountValue ?? c.totalAccountValue ?? '',
    c.cashBuyingPower ?? '', c.marginBuyingPower ?? '', c.dtCashBuyingPower ?? '',
  ];
  return toCsv(headers, [row]);
}

function accountsToCsv(data) {
  const accounts = data?.accounts || [];
  if (!accounts.length) return '';
  const headers = ['Account ID', 'Account ID Key', 'Account Name', 'Account Type', 'Institution Type', 'Account Status', 'Account Mode', 'Description'];
  const rows = accounts.map(a => [
    a.accountId || '', a.accountIdKey || '', a.accountName || '', a.accountType || '',
    a.institutionType || '', a.accountStatus || '', a.accountMode || '', a.accountDesc || '',
  ]);
  return toCsv(headers, rows);
}

// ── Markdown table helpers ───────────────────────────
function toMd(title, headers, rows) {
  const sep = headers.map(() => '---');
  const lines = [
    `# ${title}`, '',
    '| ' + headers.join(' | ') + ' |',
    '| ' + sep.join(' | ') + ' |',
    ...rows.map(r => '| ' + r.map(v => String(v ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |'),
  ];
  return lines.join('\n');
}

function transactionsToMd(data) {
  const txns = data.Transaction || [];
  if (!txns.length) return '';
  const headers = ['Date', 'Type', 'Symbol', 'C/P', 'Strike', 'Expiry', 'Qty', 'Price', 'Amount', 'Fee'];
  const rows = txns.map(t => {
    const b = t.brokerage || {}; const p = b.product || {};
    const date = new Date(t.transactionDate).toISOString().split('T')[0];
    const expiry = formatExpiry(p);
    return [date, t.transactionType, p.symbol || '', p.callPut || '', formatStrike(p.strikePrice), expiry, b.quantity ?? '', b.price ?? '', t.amount ?? '', b.fee ?? ''];
  });
  const range = `${data.queryStartDate || '?'} to ${data.queryEndDate || 'today'}`;
  return toMd(`Transactions (${txns.length}) — queried ${range}`, headers, rows);
}

function portfolioToMd(data) {
  const positions = data?.AccountPortfolio?.[0]?.Position || [];
  if (!positions.length) return '';
  const headers = ['Symbol', 'Description', 'Type', 'C/P', 'Strike', 'Expiry', 'Qty', 'Price/Share', 'Total Cost', 'Market Value', 'Total Gain', 'Gain %'];
  const rows = positions.map(pos => {
    const p = pos.Product || pos.product || {};
    const expiry = formatExpiry(p);
    return [p.symbol || '', pos.symbolDescription || '', p.securityType || '', p.callPut || '', formatStrike(p.strikePrice), expiry, pos.quantity ?? '', pos.pricePaid ?? '', pos.totalCost ?? '', pos.marketValue ?? '', pos.totalGain ?? '', pos.totalGainPct ?? ''];
  });
  return toMd(`Portfolio (${positions.length} positions)`, headers, rows);
}

function balanceToMd(data) {
  const b = data || {}; const c = b.Computed || b.computed || {};
  const headers = ['Field', 'Value'];
  const rows = [
    ['Account ID', b.accountId || ''],
    ['Account Type', b.accountType || ''],
    ['Cash Balance', c.cashBalance ?? b.cashBalance ?? ''],
    ['Market Value', c.RealTimeValues?.totalMarketValue ?? c.totalMarketValue ?? ''],
    ['Total Account Value', c.RealTimeValues?.totalAccountValue ?? c.totalAccountValue ?? ''],
    ['Cash Buying Power', c.cashBuyingPower ?? ''],
    ['Margin Buying Power', c.marginBuyingPower ?? ''],
  ];
  return toMd('Account Balance', headers, rows);
}

function accountsToMd(data) {
  const accounts = data?.accounts || [];
  if (!accounts.length) return '';
  const headers = ['Account ID', 'Name', 'Type', 'Status'];
  const rows = accounts.map(a => [a.accountId || '', a.accountDesc || a.accountName || '', a.accountType || '', a.accountStatus || '']);
  return toMd(`Accounts (${accounts.length})`, headers, rows);
}

function gainsToCsv(data) {
  const rows = (data.gains || []).map(g => [
    g.symbol, g.securityType, g.callPut || '', formatStrike(g.strikePrice), formatExpiry(g),
    g.description, g.dateAcquired ?? '', g.quantity, g.costPerShare,
    g.totalCost, g.marketValue, g.gain, g.gainPct, g.term,
  ]);
  return toCsv(['Symbol', 'Type', 'C/P', 'Strike', 'Expiry', 'Description', 'Date Acquired', 'Quantity', 'Cost/Share', 'Total Cost', 'Market Value', 'Gain', 'Gain %', 'Term'], rows);
}

function quotesToCsv(data) {
  const quotes = data.quotes || [];
  if (!quotes.length) return '';
  const headers = ['Symbol', 'Description', 'Last Price', 'Change', 'Change %', 'Bid', 'Ask', 'Bid Size', 'Ask Size', 'Volume', 'Day High', 'Day Low', 'Open', 'Prev Close', '52w High', '52w Low', 'Market Cap', 'P/E', 'EPS', 'Div Yield', 'Next Earnings'];
  const rows = quotes.map(q => {
    const all = q.All || q.Intraday || q.Fundamental || {};
    return [
      q.Product?.symbol || '', q.Product?.securityType || '',
      all.lastTrade ?? '', all.changeClose ?? all.change ?? '', all.changeClosePercentage ?? all.changePct ?? '',
      all.bid ?? '', all.ask ?? '', all.bidSize ?? '', all.askSize ?? '',
      all.totalVolume ?? all.volume ?? '',
      all.high ?? '', all.low ?? '', all.open ?? '', all.previousClose ?? '',
      all.high52 ?? '', all.low52 ?? '',
      all.marketCap ?? '', all.pe ?? '', all.eps ?? '', all.dividend ?? all.annualDividend ?? '',
      all.nextEarningDate ?? '',
    ];
  });
  return toCsv(headers, rows);
}

function quotesToMd(data) {
  const quotes = data.quotes || [];
  if (!quotes.length) return '';
  const headers = ['Symbol', 'Company', 'Last', 'Change', 'Change %', 'Bid', 'Ask', 'Volume', '52w High', '52w Low', 'P/E'];
  const rows = quotes.map(q => {
    const all = q.All || q.Intraday || q.Fundamental || {};
    return [
      q.Product?.symbol || '', all.companyName || q.Product?.symbolDescription || '',
      all.lastTrade ?? '', all.changeClose ?? all.change ?? '',
      all.changeClosePercentage ?? all.changePct ?? '', all.bid ?? '', all.ask ?? '',
      all.totalVolume ?? all.volume ?? '', all.high52 ?? '', all.low52 ?? '', all.pe ?? '',
    ];
  });
  return toMd(`Quotes (${quotes.length})`, headers, rows);
}

function optionChainsToCsv(data) {
  const pairs = data.OptionPair || [];
  if (!pairs.length) return '';
  // Fallback expiry from response-level fields (when individual options lack expiryDate)
  const fallbackExpiry = [data._queryExpiryYear, data._queryExpiryMonth, data._queryExpiryDay].every(Boolean)
    ? `${data._queryExpiryYear}-${String(data._queryExpiryMonth).padStart(2, '0')}-${String(data._queryExpiryDay).padStart(2, '0')}`
    : '';
  const headers = ['Type', 'Symbol', 'Strike', 'Expiry', 'Bid', 'Ask', 'Last', 'Volume', 'Open Interest', 'IV', 'Delta', 'Gamma', 'Theta', 'Vega', 'Rho', 'Theo Value', 'In The Money'];
  const rows = [];
  for (const pair of pairs) {
    for (const type of ['Call', 'Put']) {
      const opt = pair[type];
      if (!opt) continue;
      const greeks = opt.OptionGreeks || {};
      rows.push([
        type, opt.symbol || '', opt.strikePrice ?? '', opt.expiryDate || fallbackExpiry,
        opt.bid ?? '', opt.ask ?? '', opt.lastPrice ?? '', opt.volume ?? '',
        opt.openInterest ?? '', greeks.iv ?? '',
        greeks.delta ?? '', greeks.gamma ?? '',
        greeks.theta ?? '', greeks.vega ?? '', greeks.rho ?? '',
        greeks.currentValue ?? '', opt.inTheMoney ?? '',
      ]);
    }
  }
  return toCsv(headers, rows);
}

function optionChainsToMd(data) {
  const pairs = data.OptionPair || [];
  if (!pairs.length) return '';
  const fallbackExpiry = [data._queryExpiryYear, data._queryExpiryMonth, data._queryExpiryDay].every(Boolean)
    ? `${data._queryExpiryYear}-${String(data._queryExpiryMonth).padStart(2, '0')}-${String(data._queryExpiryDay).padStart(2, '0')}`
    : '';
  const headers = ['Type', 'Strike', 'Expiry', 'Bid', 'Ask', 'Last', 'Vol', 'OI', 'IV', 'Delta', 'Theta', 'ITM'];
  const rows = [];
  for (const pair of pairs) {
    for (const type of ['Call', 'Put']) {
      const opt = pair[type];
      if (!opt) continue;
      const greeks = opt.OptionGreeks || {};
      rows.push([
        type, opt.strikePrice ?? '', opt.expiryDate || fallbackExpiry,
        opt.bid ?? '', opt.ask ?? '', opt.lastPrice ?? '', opt.volume ?? '',
        opt.openInterest ?? '', greeks.iv ?? '',
        greeks.delta ?? '', greeks.theta ?? '', opt.inTheMoney ?? '',
      ]);
    }
  }
  return toMd(`Option Chain (${rows.length} contracts)`, headers, rows);
}

function optionExpireDatesToCsv(data) {
  const dates = data.expirationDates || [];
  if (!dates.length) return '';
  const headers = ['Year', 'Month', 'Day', 'Expiry Type'];
  const rows = dates.map(d => [d.year ?? '', d.month ?? '', d.day ?? '', d.expiryType ?? '']);
  return toCsv(headers, rows);
}

function optionExpireDatesToMd(data) {
  const dates = data.expirationDates || [];
  if (!dates.length) return '';
  const headers = ['Year', 'Month', 'Day', 'Type'];
  const rows = dates.map(d => [d.year ?? '', d.month ?? '', d.day ?? '', d.expiryType ?? '']);
  return toMd(`Option Expiration Dates (${dates.length})`, headers, rows);
}

function lookupToCsv(data) {
  const products = data.products || [];
  if (!products.length) return '';
  const headers = ['Symbol', 'Description', 'Type'];
  const rows = products.map(p => [p.symbol || '', p.description || '', p.type || '']);
  return toCsv(headers, rows);
}

function lookupToMd(data) {
  const products = data.products || [];
  if (!products.length) return '';
  const headers = ['Symbol', 'Description', 'Type'];
  const rows = products.map(p => [p.symbol || '', p.description || '', p.type || '']);
  return toMd(`Product Lookup (${products.length})`, headers, rows);
}

function ordersToCsv(data) {
  const orders = data.Order || [];
  if (!orders.length) return '';
  const headers = ['Order ID', 'Date', 'Type', 'Status', 'Symbol', 'Security Type', 'Action', 'Quantity', 'Price Type', 'Limit Price', 'Filled Qty', 'Avg Exec Price', 'Total Order Value', 'Total Commission'];
  const rows = orders.map(o => {
    const detail = o.OrderDetail?.[0] || {};
    const inst = detail.Instrument?.[0] || {};
    const p = inst.Product || {};
    return [
      o.orderId ?? '', o.orderPlacedDate || detail.placedTime || '',
      o.orderType || '', detail.status || '',
      p.symbol || '', p.securityType || '',
      inst.orderAction || '', inst.orderedQuantity ?? inst.quantity ?? '',
      detail.priceType || '', detail.limitPrice ?? '',
      inst.filledQuantity ?? '', inst.averageExecutionPrice ?? '',
      detail.totalOrderValue ?? '', detail.totalCommission ?? '',
    ];
  });
  return toCsv(headers, rows);
}

function ordersToMd(data) {
  const orders = data.Order || [];
  if (!orders.length) return '';
  const headers = ['Order ID', 'Date', 'Status', 'Symbol', 'Action', 'Qty', 'Price Type', 'Limit', 'Filled', 'Avg Price'];
  const rows = orders.map(o => {
    const detail = o.OrderDetail?.[0] || {};
    const inst = detail.Instrument?.[0] || {};
    const p = inst.Product || {};
    return [
      o.orderId ?? '', o.orderPlacedDate || detail.placedTime || '',
      detail.status || '', p.symbol || '', inst.orderAction || '',
      inst.orderedQuantity ?? inst.quantity ?? '', detail.priceType || '',
      detail.limitPrice ?? '', inst.filledQuantity ?? '', inst.averageExecutionPrice ?? '',
    ];
  });
  return toMd(`Orders (${orders.length})`, headers, rows);
}

function alertsToCsv(data) {
  const alerts = data.Alert || [];
  if (!alerts.length) return '';
  const headers = ['Alert ID', 'Date', 'Subject', 'Status', 'Symbol'];
  const rows = alerts.map(a => [a.id ?? '', a.createDate || a.createTime || '', a.subject || '', a.status || '', a.symbol || '']);
  return toCsv(headers, rows);
}

function alertsToMd(data) {
  const alerts = data.Alert || [];
  if (!alerts.length) return '';
  const headers = ['ID', 'Date', 'Subject', 'Status', 'Symbol'];
  const rows = alerts.map(a => [a.id ?? '', a.createDate || a.createTime || '', a.subject || '', a.status || '', a.symbol || '']);
  return toMd(`Alerts (${alerts.length})`, headers, rows);
}

function alertDetailToMd(data) {
  const headers = ['Field', 'Value'];
  const rows = [
    ['Alert ID', data.id ?? ''],
    ['Date', data.createDate || data.createTime || ''],
    ['Subject', data.subject || ''],
    ['Status', data.status || ''],
    ['Symbol', data.symbol || ''],
  ];
  if (data.msgText) rows.push(['Message', data.msgText]);
  if (data.readDate || data.readTime) rows.push(['Read Date', data.readDate || data.readTime]);
  if (data.deleteDate || data.deleteTime) rows.push(['Delete Date', data.deleteDate || data.deleteTime]);
  if (data.next) rows.push(['Next Alert ID', data.next]);
  return toMd('Alert Detail', headers, rows);
}

function alertDetailToCsv(data) {
  const headers = ['Alert ID', 'Date', 'Subject', 'Status', 'Symbol', 'Message'];
  const row = [data.id ?? '', data.createDate || data.createTime || '', data.subject || '', data.status || '', data.symbol || '', data.msgText || ''];
  return toCsv(headers, [row]);
}

function transactionDetailToMd(data) {
  const t = data || {};
  const b = t.brokerage || {};
  const p = b.product || {};
  const headers = ['Field', 'Value'];
  const rows = [
    ['Transaction ID', t.transactionId ?? ''],
    ['Date', t.transactionDate ? new Date(t.transactionDate).toISOString().split('T')[0] : ''],
    ['Type', t.transactionType || ''],
    ['Description', t.description?.trim() || ''],
    ['Amount', t.amount ?? ''],
  ];
  if (p.symbol) rows.push(['Symbol', p.symbol]);
  if (p.securityType) rows.push(['Security Type', p.securityType]);
  if (p.callPut) rows.push(['Call/Put', p.callPut]);
  if (p.strikePrice != null && p.strikePrice !== 0) rows.push(['Strike', p.strikePrice]);
  if (p.expiryYear) rows.push(['Expiry', formatExpiry(p)]);
  if (b.quantity != null) rows.push(['Quantity', b.quantity]);
  if (b.price != null) rows.push(['Price', b.price]);
  if (b.fee != null) rows.push(['Fee', b.fee]);
  if (b.settlementDate) rows.push(['Settlement Date', b.settlementDate]);
  if (b.settlementCurrency) rows.push(['Settlement Currency', b.settlementCurrency]);
  if (b.paymentCurrency) rows.push(['Payment Currency', b.paymentCurrency]);
  return toMd('Transaction Detail', headers, rows);
}

function transactionDetailToCsv(data) {
  const t = data || {};
  const b = t.brokerage || {};
  const p = b.product || {};
  const date = t.transactionDate ? new Date(t.transactionDate).toISOString().split('T')[0] : '';
  const expiry = formatExpiry(p);
  const headers = ['Transaction ID', 'Date', 'Type', 'Symbol', 'Security Type', 'Call/Put', 'Strike', 'Expiry', 'Quantity', 'Price', 'Amount', 'Fee', 'Description'];
  const row = [t.transactionId ?? '', date, t.transactionType || '', p.symbol || '', p.securityType || '', p.callPut || '', formatStrike(p.strikePrice), expiry, b.quantity ?? '', b.price ?? '', t.amount ?? '', b.fee ?? '', t.description?.trim() || ''];
  return toCsv(headers, [row]);
}

function gainsToMd(data) {
  const rows = (data.gains || []).map(g => [
    g.symbol, g.description || '', g.callPut || '', formatStrike(g.strikePrice), formatExpiry(g),
    g.dateAcquired ?? '', g.quantity, g.costPerShare, g.totalCost, g.marketValue, g.gain, g.gainPct, g.term,
  ]);
  return toMd(`Unrealized Gains (${data.totalCount} lots)`,
    ['Symbol', 'Description', 'C/P', 'Strike', 'Expiry', 'Acquired', 'Qty', 'Price/Share', 'Total Cost', 'Value', 'Gain', 'Gain %', 'Term'], rows);
}

// ── Search engine backends ───────────────────────────
async function searchTavily(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.tavily.apiKey}`,
    },
    body: JSON.stringify({ query, max_results: 5 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn(`[web_search] Tavily returned ${res.status}: ${body}`);
    return { error: `Search failed (HTTP ${res.status})`, results: [] };
  }
  const data = await res.json();
  return { results: (data.results || []).map(r => ({ title: r.title, url: r.url, description: r.content || '' })) };
}

async function searchKeiro(query) {
  const res = await fetch(`${config.keiro.baseUrl}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: config.keiro.apiKey, query }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn(`[web_search] Keiro returned ${res.status}: ${body}`);
    return { error: `Search failed (HTTP ${res.status})`, results: [] };
  }
  const data = await res.json();
  const results = data.data?.search_results || [];
  return { results: results.slice(0, 5).map(r => ({ title: r.title || '', url: r.url || '', description: r.snippet || '' })) };
}

// Tool registry — single source of truth
// Cache: rate_N → offerId (so booking prebook can resolve rate refs from hotel rates results)
// Overwritten on each rates call; only latest rates are bookable anyway (ephemeral).
let lastRateMap = {};
// Cache last prebookId so LLM doesn't need to track it across tool rounds
let lastPrebookId = null;

// ── Guest profile (persisted to data/guest_profile.json) ──
const GUEST_PROFILE_PATH = join(DATA_DIR, 'guest_profile.json');

async function loadGuestProfile() {
  try {
    const data = await readFile(GUEST_PROFILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch { return null; }
}

async function saveGuestProfile(profile) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(GUEST_PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf-8');
}

const tools = {
  current_datetime: {
    description: 'Returns the current date and time in UTC and local time with timezone. Takes no arguments.',
    parameters: {},
    execute: () => {
      const now = new Date();
      return {
        utc: now.toISOString(),
        local: now.toString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offset: now.getTimezoneOffset(),
      };
    },
  },
  web_search: {
    description: 'Search the web. Requires a "query" argument.',
    parameters: { query: 'string' },
    execute: async ({ query }) => {
      const engine = config.search.engine;
      if (engine === 'tavily') {
        const res = await searchTavily(query).catch(e => ({ error: e.message, results: [] }));
        return { ...res, sources: 'Tavily' };
      }
      if (engine === 'keiro') {
        const res = await searchKeiro(query).catch(e => ({ error: e.message, results: [] }));
        return { ...res, sources: 'Keiro' };
      }
      // 'both' — run in parallel, merge and deduplicate by URL
      const [keiro, tavily] = await Promise.all([
        searchKeiro(query).catch(e => ({ error: e.message, results: [] })),
        searchTavily(query).catch(e => ({ error: e.message, results: [] })),
      ]);
      const keiroOk = keiro.results.length > 0;
      const tavilyOk = tavily.results.length > 0;
      let sources;
      if (keiroOk && tavilyOk) sources = 'Keiro + Tavily';
      else if (keiroOk) sources = 'Keiro (Tavily failed)';
      else if (tavilyOk) sources = 'Tavily (Keiro failed)';
      else sources = 'both failed';
      const seen = new Set();
      const merged = [];
      for (const r of [...keiro.results, ...tavily.results]) {
        if (!seen.has(r.url)) {
          seen.add(r.url);
          merged.push(r);
        }
      }
      return { results: merged.slice(0, 8), sources };
    },
  },
  web_fetch: {
    description: 'Fetch a web page and extract its full content as markdown. Requires a "url" argument. ALWAYS use after web_search to read the most relevant result before answering.',
    parameters: { url: 'string' },
    execute: async ({ url }) => {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LLM-Workbench/1.0)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      const html = await res.text();
      const { document } = parseHTML(html);

      const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      turndown.remove(['script', 'style', 'noscript']);

      // Try Readability (article extraction)
      const article = new Readability(document).parse();

      let markdown, title;
      if (article && article.content) {
        markdown = turndown.turndown(article.content);
        title = article.title;
      } else {
        // Fallback: strip boilerplate from raw HTML
        const { document: doc2 } = parseHTML(html);
        for (const sel of ['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside']) {
          doc2.querySelectorAll(sel).forEach(el => el.remove());
        }
        markdown = turndown.turndown(doc2.toString());
        title = doc2.querySelector('title')?.textContent || '';
      }

      // Truncate to keep token usage reasonable
      const maxLen = 4000;
      if (markdown.length > maxLen) {
        markdown = markdown.slice(0, maxLen) + '\n\n[...truncated]';
      }

      return { url, title, content: markdown };
    },
  },
  save_file: {
    description: 'Save content to a file for download. Requires "filename" (e.g. "report.md", "data.csv") and "content" (the text content to save). Returns a download URL. Use for generated text, reports, code, or small data sets. Avoid for large data (50+ records) — use the source tool\'s saveAs parameter instead to prevent output truncation.',
    parameters: { filename: 'string', content: 'string' },
    execute: async ({ filename, content }) => {
      if (!filename || !content) return { error: 'Both "filename" and "content" are required.' };
      return await saveToFile(filename, content);
    },
  },
  list_files: {
    description: 'List files in the data directory. No arguments needed. Returns filename, size, and last modified date for each file.',
    parameters: {},
    execute: async () => {
      await mkdir(DATA_DIR, { recursive: true });
      const entries = await readdir(DATA_DIR);
      const files = await Promise.all(entries.map(async (name) => {
        const s = await stat(join(DATA_DIR, name));
        if (!s.isFile()) return null;
        return { name, size: s.size, modified: s.mtime.toISOString() };
      }));
      return files.filter(Boolean);
    },
  },
  file_read: {
    description: 'Read contents of a file from the data directory. Requires "filename". Optional "head" (number of lines from start). Use to inspect CSVs, downloaded files, or results from other tools.',
    parameters: { filename: 'string', head: 'number (optional)' },
    execute: async ({ filename, head }) => {
      if (!filename?.trim()) return { error: 'filename is required' };
      const safe = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = join(DATA_DIR, safe);
      try {
        let content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const totalLines = lines.length;
        if (head && head > 0) {
          content = lines.slice(0, head).join('\n');
        } else if (safe.endsWith('.csv') && totalLines > 10) {
          // For CSV files, show header + 5 rows — use run_python to process the full data
          content = lines.slice(0, 6).join('\n');
          content += `\n... (${totalLines - 6} more rows)\n[Use run_python with pd.read_csv('${safe}') to process this data. Do NOT attempt to analyze it by reading — use Python.]`;
        }
        if (content.length > 10000) content = content.slice(0, 10000) + '\n...[truncated]';
        return { filename: safe, totalLines, content };
      } catch (err) {
        if (err.code === 'ENOENT') return { error: `File not found: ${safe}` };
        return { error: err.message };
      }
    },
  },
  run_command: {
    description: 'Run a shell command on the server. Requires user approval before execution. Requires a "command" argument (the shell command to run). Use for tasks like listing files, checking system info, installing packages, or any shell operation the user requests.',
    parameters: { command: 'string' },
    execute: async ({ command }, context) => {
      if (!command?.trim()) return { error: 'command is required' };
      if (!context?.confirmFn) return { error: 'No confirmation channel available' };

      const approved = await context.confirmFn(command);
      if (!approved) return { denied: true, message: 'User denied command execution.' };

      const { execSync } = await import('child_process');
      try {
        const stdout = execSync(command, {
          encoding: 'utf-8',
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          cwd: process.env.HOME,
        });
        return { command, exitCode: 0, stdout: stdout.slice(0, 8000) };
      } catch (err) {
        return {
          command,
          exitCode: err.status ?? 1,
          stdout: (err.stdout || '').slice(0, 4000),
          stderr: (err.stderr || '').slice(0, 4000),
        };
      }
    },
  },
  run_python: {
    description: 'Execute a Python script. Requires user approval. Requires "code" (Python source). The script runs with cwd set to the data directory, so it can read/write data files directly by filename. Any new or modified files are auto-detected and returned with download URLs.\n\nOutput rules:\n- Quick answers (single number, short list, yes/no) → print() to console.\n- Reports, tables, formatted results → save to a file (CSV, MD, or HTML) AND print() a brief summary. Example: write a CSV then print("Saved net_income_report.csv — 12 rows, total: $45,230").\n- Charts/visualizations → save as PNG/HTML file. Use matplotlib, plotly, etc.\n- ALWAYS print() something so the user sees immediate feedback, even when saving files.\n- NEVER hardcode or inline data in the script. If data files exist in the data directory (check with list_files first), read them with Python (e.g. pandas.read_csv, open()). The script runs in the data directory so just use the filename directly.\n- Keep scripts concise. Use pandas for CSV processing when appropriate.',
    parameters: { code: 'string' },
    execute: async ({ code }, context) => {
      const t0 = Date.now();
      const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
      if (!code?.trim()) return { error: 'code is required' };
      if (!context?.confirmFn) return { error: 'No confirmation channel available' };

      let approved = true;
      if (context.autorun) {
        console.log(`[run_python] autorun enabled, skipping confirmation (${elapsed()})`);
      } else {
        console.log(`[run_python] requesting user confirmation...`);
        approved = await context.confirmFn(`Python script:\n${code}`);
        console.log(`[run_python] confirmation ${approved ? 'approved' : 'denied'} (${elapsed()})`);
      }
      if (!approved) return { denied: true, message: 'User denied Python execution.' };

      // Auto-fix JS-style booleans/null → Python (common LLM mistake)
      // Pass 1: keyword args (na=false → na=False, inplace=true → inplace=True)
      code = code.replace(/(\w\s*=\s*)true\b/g, '$1True')
                 .replace(/(\w\s*=\s*)false\b/g, '$1False')
                 .replace(/(\w\s*=\s*)null\b/g, '$1None');
      // Pass 2: standalone null → None (null is never valid Python, always means None)
      code = code.replace(/\bnull\b/g, 'None');

      await mkdir(DATA_DIR, { recursive: true });
      const tmpFile = join(DATA_DIR, '.tmp_script.py');
      await writeFile(tmpFile, code, 'utf-8');

      // Snapshot files before execution to detect new/changed files
      const before = new Map();
      for (const name of await readdir(DATA_DIR)) {
        if (name.startsWith('.tmp_script')) continue;
        const s = await stat(join(DATA_DIR, name)).catch(() => null);
        if (s?.isFile()) before.set(name, s.mtimeMs);
      }
      console.log(`[run_python] file snapshot: ${before.size} existing files (${elapsed()})`);

      const pythonBin = PYTHON_VENV ? join(PYTHON_VENV, 'bin', 'python') : 'python3';
      console.log(`[run_python] spawning: ${pythonBin} ${tmpFile} (timeout=120s) (${elapsed()})`);
      const TIMEOUT_MS = 120000;
      const { exitCode, stdout, stderr, timedOut } = await new Promise((resolve) => {
        let out = '', err = '', resolved = false;
        const finish = (result) => { if (!resolved) { resolved = true; resolve(result); } };
        const proc = spawn(pythonBin, [tmpFile], {
          cwd: DATA_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const killTimer = setTimeout(() => {
          console.warn(`[run_python] TIMEOUT after ${TIMEOUT_MS / 1000}s — killing pid ${proc.pid}`);
          proc.kill('SIGKILL');
          finish({ exitCode: 137, stdout: out, stderr: err + '\n[run_python] Process killed: exceeded 120s timeout', timedOut: true });
        }, TIMEOUT_MS);
        proc.stdout.on('data', (d) => { if (out.length < 2 * 1024 * 1024) out += d; });
        proc.stderr.on('data', (d) => { if (err.length < 2 * 1024 * 1024) err += d; });
        proc.on('close', (code) => { clearTimeout(killTimer); finish({ exitCode: code ?? 1, stdout: out, stderr: err, timedOut: false }); });
        proc.on('error', (e) => { clearTimeout(killTimer); finish({ exitCode: 1, stdout: '', stderr: e.message, timedOut: false }); });
      });
      console.log(`[run_python] process exited: code=${exitCode} timedOut=${timedOut} stdout=${stdout.length}B stderr=${stderr.length}B (${elapsed()})`);
      await unlink(tmpFile).catch(() => {});

      // Detect new or modified files
      const outputFiles = [];
      for (const name of await readdir(DATA_DIR)) {
        if (name.startsWith('.tmp_script')) continue;
        const s = await stat(join(DATA_DIR, name)).catch(() => null);
        if (!s?.isFile()) continue;
        const prevMtime = before.get(name);
        if (prevMtime === undefined || s.mtimeMs > prevMtime) {
          outputFiles.push({
            name,
            size: s.size,
            url: `/files/${encodeURIComponent(name)}`,
          });
        }
      }
      console.log(`[run_python] detected ${outputFiles.length} new/modified files (${elapsed()})`);

      const result = { exitCode, stdout: stdout.slice(0, 8000) };
      if (timedOut) result.timedOut = true;
      if (stderr) result.stderr = stderr.slice(0, 4000);
      if (outputFiles.length) result.files = outputFiles;
      console.log(`[run_python] done (${elapsed()})`);
      return result;
    },
  },
  etrade_account: {
    description: 'Retrieve E*TRADE brokerage and market data. Requires an "action" argument.\n\n**Account actions** (require "accountIdKey" — can be the encoded key from "list", a numeric accountId, OR a description like "IRA", "Rollover IRA", "brokerage" — auto-resolved):\n- "list": list accounts\n- "balance": account balance\n- "portfolio": positions/holdings\n- "transactions": transaction history (auto-paginates to fetch ALL matching transactions within the date range; **defaults to Jan 1 of current year** if no startDate given; use startDate/endDate in MMDDYYYY to query other periods; ALWAYS pass startDate explicitly when the user specifies a date range — never ask the user to confirm, just do it; maxPages to limit pagination — 0=unlimited which is the default)\n- "gains": unrealized gains with lot-level cost basis and short/long term\n- "orders": order history (optional status: OPEN/EXECUTED/CANCELLED/etc, fromDate/toDate in MMDDYYYY, count max 100)\n- "transaction_detail": single transaction detail (requires transactionId)\n\n**Market data actions** (no accountIdKey needed):\n- "quote": real-time quotes (requires "symbols" — comma-separated, up to 25; optional detailFlag: ALL/FUNDAMENTAL/INTRADAY/OPTIONS/WEEK_52)\n- "optionchains": option chains with full Greeks (Delta, Gamma, Theta, Vega, Rho, IV) and bid/ask/volume/OI (requires "symbol"; optional expiryYear/expiryMonth/expiryDay, strikePriceNear, noOfStrikes, chainType: CALL/PUT/CALLPUT, includeWeekly)\n- "optionexpiry": option expiration dates (requires "symbol")\n- "lookup": product/symbol lookup (requires "search" — company name or partial symbol)\n\n**User alerts:**\n- "alerts": account/stock alerts (optional count 1-300, category: STOCK/ACCOUNT, status: READ/UNREAD)\n- "alert_detail": single alert detail (requires alertId)\n\nTo export data, add "saveAs" with a filename (.csv/.md/.json). Usage guide: "gains" for open positions with cost basis; "transactions" for trade history; "orders" for order status/fills; "quote" for current prices; "optionchains" for available options with Greeks (Delta, Theta, IV, etc.).',
    parameters: { action: 'string', accountIdKey: 'string (optional)', startDate: 'string (optional)', endDate: 'string (optional)', count: 'number (optional)', maxPages: 'number (optional, transactions only — 0=unlimited, default 0)', saveAs: 'string (optional)', symbols: 'string (optional)', symbol: 'string (optional)', detailFlag: 'string (optional)', expiryYear: 'string (optional)', expiryMonth: 'string (optional)', expiryDay: 'string (optional)', strikePriceNear: 'string (optional)', noOfStrikes: 'string (optional)', chainType: 'string (optional)', includeWeekly: 'boolean (optional)', search: 'string (optional)', status: 'string (optional)', fromDate: 'string (optional)', toDate: 'string (optional)', category: 'string (optional)', transactionId: 'string (optional)', alertId: 'string (optional)' },
    execute: async ({ action, accountIdKey, startDate, endDate, count, maxPages, saveAs, symbols, symbol, detailFlag, expiryYear, expiryMonth, expiryDay, strikePriceNear, noOfStrikes, chainType, includeWeekly, search, status, fromDate, toDate, category, transactionId, alertId }) => {
      const _logArgs = { action, accountIdKey, startDate, endDate, count, maxPages, saveAs, symbols, symbol, detailFlag, expiryYear, expiryMonth, expiryDay, strikePriceNear, noOfStrikes, chainType, includeWeekly, search, status, fromDate, toDate, category, transactionId, alertId };
      // Strip undefined args for cleaner logs
      for (const k of Object.keys(_logArgs)) { if (_logArgs[k] === undefined) delete _logArgs[k]; }
      const _log = (raw, formatted) => logToolCall('etrade_account', action, { args: _logArgs, rawResult: raw, formattedResult: formatted });

      if (!etrade.isAuthenticated()) {
        return { error: 'E*TRADE not authenticated. Click "E*TRADE (connect)" in the status bar to authenticate.' };
      }
      let result;
      try {
      switch (action) {
        case 'list':
          result = await etrade.listAccounts();
          break;
        case 'balance':
          if (!accountIdKey) return { error: 'accountIdKey required. Use action "list" first.' };
          result = await etrade.getBalance(accountIdKey);
          break;
        case 'portfolio':
          if (!accountIdKey) return { error: 'accountIdKey required. Use action "list" first.' };
          result = await etrade.getPortfolio(accountIdKey);
          break;
        case 'transactions':
          if (!accountIdKey) return { error: 'accountIdKey required. Use action "list" first.' };
          result = await etrade.getTransactions(accountIdKey, { count, startDate, endDate, maxPages });
          break;
        case 'gains':
          if (!accountIdKey) return { error: 'accountIdKey required. Use action "list" first.' };
          result = await etrade.getGains(accountIdKey);
          break;
        // Market data actions
        case 'quote':
          if (!symbols) return { error: 'symbols required (comma-separated, e.g. "AAPL,MSFT").' };
          result = await etrade.getQuotes(symbols, { detailFlag });
          break;
        case 'optionchains':
          if (!symbol) return { error: 'symbol required.' };
          result = await etrade.getOptionChains({ symbol, expiryYear, expiryMonth, expiryDay, strikePriceNear, noOfStrikes, chainType, includeWeekly });
          // Attach query expiry so formatters can fill empty per-option expiryDate
          if (expiryYear) result._queryExpiryYear = expiryYear;
          if (expiryMonth) result._queryExpiryMonth = expiryMonth;
          if (expiryDay) result._queryExpiryDay = expiryDay;
          break;
        case 'optionexpiry':
          if (!symbol) return { error: 'symbol required.' };
          result = await etrade.getOptionExpireDates(symbol);
          break;
        case 'lookup':
          if (!search) return { error: 'search term required.' };
          result = await etrade.lookupProduct(search);
          break;
        // Account activity actions
        case 'orders':
          if (!accountIdKey) return { error: 'accountIdKey required. Use action "list" first.' };
          result = await etrade.getOrders(accountIdKey, { status, fromDate, toDate, count });
          break;
        case 'alerts':
          result = await etrade.getAlerts({ count, category, status });
          break;
        case 'alert_detail':
          if (!alertId) return { error: 'alertId required.' };
          result = await etrade.getAlertDetails(alertId);
          break;
        case 'transaction_detail':
          if (!accountIdKey) return { error: 'accountIdKey required.' };
          if (!transactionId) return { error: 'transactionId required.' };
          result = await etrade.getTransactionDetail(accountIdKey, transactionId);
          break;
        default:
          return { error: `Unknown action: ${action}. Use: list, balance, portfolio, transactions, gains, quote, optionchains, optionexpiry, lookup, orders, alerts, alert_detail, transaction_detail` };
      }
      } catch (apiErr) {
        const errResult = { error: `${action} failed: ${apiErr.message}` };
        await _log(null, errResult);
        return errResult;
      }
      const formatters = {
        transactions: transactionsToCsv, portfolio: portfolioToCsv, list: accountsToCsv,
        balance: balanceToCsv, gains: gainsToCsv, quote: quotesToCsv,
        optionchains: optionChainsToCsv, optionexpiry: optionExpireDatesToCsv,
        lookup: lookupToCsv, orders: ordersToCsv, alerts: alertsToCsv,
        alert_detail: alertDetailToCsv, transaction_detail: transactionDetailToCsv,
      };
      const mdFormatters = {
        transactions: transactionsToMd, portfolio: portfolioToMd, list: accountsToMd,
        balance: balanceToMd, gains: gainsToMd, quote: quotesToMd,
        optionchains: optionChainsToMd, optionexpiry: optionExpireDatesToMd,
        lookup: lookupToMd, orders: ordersToMd, alerts: alertsToMd,
        alert_detail: alertDetailToMd, transaction_detail: transactionDetailToMd,
      };
      // Extract lightweight summary metadata per action
      function summarize(act, res) {
        switch (act) {
          case 'list': return { totalCount: res.totalCount ?? res.accounts?.length ?? 0 };
          case 'balance': return { accountId: (res.accountId || ''), accountType: (res.accountType || '') };
          case 'portfolio': {
            const positions = res.AccountPortfolio?.[0]?.Position || [];
            const symbols = [...new Set(positions.map(p => p.Product?.symbol).filter(Boolean))];
            return { totalPositions: res.totalPositions ?? positions.length, uniqueSymbols: symbols };
          }
          case 'transactions': {
            const txns = res.Transaction || [];
            const symbols = [...new Set(txns.map(t => t.brokerage?.product?.symbol || t.brokerage?.displaySymbol).filter(Boolean))];
            const secTypes = [...new Set(txns.map(t => t.brokerage?.product?.securityType).filter(Boolean))];
            const txnTypes = [...new Set(txns.map(t => t.transactionType).filter(Boolean))];
            return {
              totalCount: res.totalCount ?? 0, pagesFetched: res.pagesFetched ?? 1,
              queryStartDate: res.queryStartDate, queryEndDate: res.queryEndDate,
              uniqueSymbols: symbols, securityTypes: secTypes, transactionTypes: txnTypes,
            };
          }
          case 'gains': return { totalCount: res.totalCount ?? 0, totalGain: res.totalGain, totalGainPct: res.totalGainPct };
          case 'quote': return { totalCount: res.totalCount ?? res.quotes?.length ?? 0 };
          case 'optionchains': return { totalPairs: res.OptionPair?.length ?? 0 };
          case 'optionexpiry': return { totalCount: res.totalCount ?? res.expirationDates?.length ?? 0 };
          case 'lookup': return { totalCount: res.totalCount ?? res.products?.length ?? 0 };
          case 'orders': {
            const orders = res.Order || [];
            const symbols = [...new Set(orders.map(o => o.OrderDetail?.[0]?.Instrument?.[0]?.Product?.symbol).filter(Boolean))];
            return { totalCount: res.totalCount ?? orders.length, uniqueSymbols: symbols };
          }
          case 'alerts': return { totalCount: res.totalCount ?? res.Alert?.length ?? 0 };
          case 'alert_detail': return { alertId: res.id ?? '' };
          case 'transaction_detail': return { transactionId: res.transactionId ?? '' };
          default: return {};
        }
      }
      // Save to file if requested
      if (saveAs && result && !result.error) {
        let content;
        if (saveAs.endsWith('.json')) {
          content = JSON.stringify(result, null, 2);
        } else if (saveAs.endsWith('.md') && mdFormatters[action]) {
          content = mdFormatters[action](result);
        } else {
          content = formatters[action]?.(result) || JSON.stringify(result, null, 2);
        }
        if (!content) return { ...result, saveError: 'No data to save' };
        const file = await saveToFile(saveAs, content);
        const out = { ...summarize(action, result), savedFile: file };
        await _log(result, out);
        return out;
      }
      // For large result sets, auto-save to CSV and return summary + truncated preview
      const ROW_THRESHOLD = 30;
      const optionPairCount = result.OptionPair?.length || 0;
      const rowCount = result.Transaction?.length || result.AccountPortfolio?.[0]?.Position?.length || result.gains?.length || result.Order?.length || (optionPairCount * 2) || result.quotes?.length || result.Alert?.length || 0;
      if (rowCount > ROW_THRESHOLD && formatters[action]) {
        const autoFile = `${action}_${Date.now()}.csv`;
        const csvContent = formatters[action](result);
        if (csvContent) {
          const file = await saveToFile(autoFile, csvContent);
          const mdFormatter = mdFormatters[action];
          // Build a truncated copy for the preview (first 15 items)
          const truncated = { ...result };
          if (truncated.Transaction) truncated.Transaction = truncated.Transaction.slice(0, 15);
          if (truncated.Order) truncated.Order = truncated.Order.slice(0, 15);
          if (truncated.gains) truncated.gains = truncated.gains.slice(0, 15);
          if (truncated.AccountPortfolio?.[0]?.Position) {
            truncated.AccountPortfolio = [{ ...truncated.AccountPortfolio[0], Position: truncated.AccountPortfolio[0].Position.slice(0, 15) }];
          }
          if (truncated.OptionPair) truncated.OptionPair = truncated.OptionPair.slice(0, 8);
          if (truncated.quotes) truncated.quotes = truncated.quotes.slice(0, 15);
          if (truncated.Alert) truncated.Alert = truncated.Alert.slice(0, 15);
          const preview = mdFormatter ? mdFormatter(truncated) : null;
          const out = {
            ...summarize(action, result),
            savedFile: file,
            _autoSaved: true,
            _note: `${rowCount} rows — auto-saved full data to ${autoFile}. Preview shows first 15 rows.`,
            ...(preview ? { _markdown: preview } : {}),
          };
          await _log(result, out);
          return out;
        }
      }
      // Return pre-formatted markdown table + lightweight summary (no raw data)
      const mdFormatter = mdFormatters[action];
      if (mdFormatter && result && !result.error) {
        const table = mdFormatter(result);
        if (table) {
          const out = { _markdown: table, ...summarize(action, result) };
          await _log(result, out);
          return out;
        }
      }
      await _log(result, result);
      return result;
    },
  },

  // ── LiteAPI Hotel & Travel Tools ─────────────────────

  hotel: {
    description: 'Hotel search, details, rates, and reviews via LiteAPI. Requires "action" argument.\n\n'
      + 'Actions:\n'
      + '- "search": find hotels. Params: countryCode, cityName, hotelName, aiSearch (natural language), latitude/longitude/radius, placeId, limit (default 5), offset, minRating, starRating, minReviewsCount\n'
      + '- "details": full hotel info with photos, amenities, rooms, policies. Requires hotelId\n'
      + '- "rates": real-time pricing & availability. Requires checkin (YYYY-MM-DD), checkout (YYYY-MM-DD), occupancies (e.g. [{"adults":2}] or [{"adults":2,"children":[5,8]}]), guestNationality (2-letter code, default "US"), currency (default "USD"). Location via: hotelIds (array), or countryCode+cityName, or latitude+longitude+radius\n'
      + '- "reviews": guest reviews for a hotel. Requires hotelId\n'
      + '- "semantic_search": natural language hotel search (beta). Requires query\n'
      + '- "ask": Q&A about a specific hotel (beta). Requires hotelId and question',
    parameters: {
      action: 'string',
      hotelId: 'string (optional)',
      countryCode: 'string (optional)',
      cityName: 'string (optional)',
      hotelName: 'string (optional)',
      aiSearch: 'string (optional)',
      latitude: 'number (optional)',
      longitude: 'number (optional)',
      radius: 'number (optional)',
      placeId: 'string (optional)',
      limit: 'number (optional, default 5)',
      offset: 'number (optional)',
      minRating: 'number (optional)',
      starRating: 'number (optional)',
      minReviewsCount: 'number (optional)',
      checkin: 'string (optional, YYYY-MM-DD)',
      checkout: 'string (optional, YYYY-MM-DD)',
      occupancies: 'array (optional, e.g. [{"adults":2}])',
      guestNationality: 'string (optional, 2-letter code)',
      currency: 'string (optional, default USD)',
      hotelIds: 'array (optional)',
      query: 'string (optional)',
      question: 'string (optional)',
    },
    execute: async (args) => {
      if (!liteapi.isConfigured()) return { error: 'LiteAPI not configured. Set LITEAPI_KEY in .env' };
      const { action, ...params } = args;
      if (!action) return { error: 'Missing "action". Use: search, details, rates, reviews, semantic_search, ask' };

      switch (action) {
        case 'search': {
          const { countryCode, cityName, hotelName, aiSearch, latitude, longitude, radius, placeId, limit = 5, offset, minRating, starRating, minReviewsCount } = params;
          const data = await liteapi.searchHotels({ countryCode, cityName, hotelName, aiSearch, latitude, longitude, radius, placeId, limit, offset, minRating, starRating, minReviewsCount });
          const hotels = data?.data || [];
          const _images = [];
          const results = hotels.map(h => {
            if (h.thumbnail) _images.push(h.thumbnail);
            return { hotelId: h.id, name: h.name, starRating: h.starRating, rating: h.rating, reviewCount: h.reviewCount, city: h.city, country: h.country, address: h.address, thumbnail: h.thumbnail };
          });
          return { hotels: results, totalCount: data?.totalCount || results.length, ...(_images.length ? { _images } : {}) };
        }

        case 'details': {
          if (!params.hotelId) return { error: 'hotelId required for "details" action' };
          const data = await liteapi.getHotelDetails(params.hotelId);
          const hotel = data?.data || data || {};
          // Collect images: mix hotel + room photos for variety, dedupe
          const hotelImgs = new Set();
          const roomImgs = new Set();
          if (hotel.thumbnail) hotelImgs.add(hotel.thumbnail);
          if (hotel.hotelImages) hotel.hotelImages.forEach(img => { if (img.url) hotelImgs.add(img.url); });
          if (hotel.rooms) hotel.rooms.forEach(room => {
            if (room.photos) room.photos.forEach(p => {
              if (p.url && !hotelImgs.has(p.url)) roomImgs.add(p.url);
            });
          });
          // Balance: up to 6 hotel photos + up to 6 room photos (fill remaining with whichever has more)
          const hotelSlice = [...hotelImgs].slice(0, 6);
          const roomSlice = [...roomImgs].slice(0, 12 - hotelSlice.length);
          const _images = [...hotelSlice, ...roomSlice];
          // Strip HTML tags from room descriptions
          const stripHtml = (s) => s ? s.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim() : '';
          const checkinCheckout = hotel.checkinCheckoutTimes || {};
          const result = {
            hotelId: hotel.id, name: hotel.name, rating: hotel.rating, reviewCount: hotel.reviewCount,
            address: hotel.address, city: hotel.city, country: hotel.country,
            description: stripHtml(hotel.hotelDescription),
            facilities: hotel.hotelFacilities,
            rooms: hotel.rooms?.slice(0, 10).map(r => ({
              name: r.roomName, description: stripHtml(r.description),
              maxOccupancy: r.maxOccupancy, bedTypes: r.bedTypes,
              roomPhotos: r.photos?.length || 0,
            })),
            policies: hotel.policies?.map(p => ({ name: p.name, description: stripHtml(p.description) })),
            checkIn: checkinCheckout.checkout || hotel.checkIn,
            checkOut: checkinCheckout.checkin || hotel.checkOut,
            parking: hotel.parking, petsAllowed: hotel.petsAllowed, childAllowed: hotel.childAllowed,
          };
          return { ...result, imageCount: _images.length, hotelPhotos: hotelSlice.length, roomPhotos: roomSlice.length, _images };
        }

        case 'rates': {
          const { checkin, checkout, occupancies, guestNationality = 'US', currency = 'USD', hotelIds, countryCode, cityName, latitude, longitude, radius } = params;
          if (!checkin || !checkout) return { error: 'checkin and checkout (YYYY-MM-DD) required for "rates" action' };
          const occ = typeof occupancies === 'string' ? JSON.parse(occupancies) : occupancies || [{ adults: 2 }];
          const body = { checkin, checkout, occupancies: occ, guestNationality, currency };
          if (hotelIds) body.hotelIds = typeof hotelIds === 'string' ? JSON.parse(hotelIds) : hotelIds;
          else if (countryCode && cityName) { body.countryCode = countryCode; body.cityName = cityName; }
          else if (latitude && longitude) { body.latitude = latitude; body.longitude = longitude; if (radius) body.radius = radius; }
          else return { error: 'Provide hotelIds, countryCode+cityName, or latitude+longitude for location' };
          const data = await liteapi.getHotelRates(body);
          const allHotels = data?.data || [];
          // Cap hotels: 10 for city-wide, all for hotelIds
          const maxHotels = hotelIds ? allHotels.length : 10;
          const maxRoomsPerHotel = hotelIds?.length === 1 ? 10 : 3; // more detail for single hotel
          // Build rate map (offerIds stored separately — stripped from LLM context)
          const _rateMap = {};
          let rateIdx = 0;
          const hotels = allHotels.slice(0, maxHotels).map(h => {
            const rooms = (h.roomTypes || []).flatMap(rt =>
              (rt.rates || []).map(r => ({
                roomName: r.name,
                boardName: r.boardName || r.boardType,
                offerId: rt.offerId, // prebook uses offerId from roomType level
                maxOccupancy: r.maxOccupancy,
                price: r.retailRate?.total?.[0] || null,
                cancellation: r.cancellationPolicies?.refundableTag || 'unknown',
              }))
            );
            // Dedupe by roomName+boardName, keep cheapest
            const seen = new Map();
            for (const r of rooms) {
              const key = `${r.roomName}|${r.boardName}`;
              const existing = seen.get(key);
              if (!existing || (r.price?.amount || Infinity) < (existing.price?.amount || Infinity)) {
                seen.set(key, r);
              }
            }
            return {
              hotelId: h.hotelId,
              rooms: [...seen.values()].slice(0, maxRoomsPerHotel).map(r => {
                // Replace offerId with short ref for LLM, store full offerId in _rateMap
                const ref = `rate_${rateIdx++}`;
                _rateMap[ref] = r.offerId;
                return { roomName: r.roomName, boardName: r.boardName, rateId: ref, maxOccupancy: r.maxOccupancy, price: r.price, cancellation: r.cancellation };
              }),
            };
          });
          // Cache rate map so booking prebook can resolve rate_N refs
          lastRateMap = _rateMap;
          return {
            hotels,
            totalHotels: allHotels.length,
            currency,
            checkin,
            checkout,
            _rateMap,
          };
        }

        case 'reviews': {
          if (!params.hotelId) return { error: 'hotelId required for "reviews" action' };
          const data = await liteapi.getHotelReviews(params.hotelId);
          const all = data?.data || (Array.isArray(data) ? data : []);
          const total = all.length;
          // Cap to 10 most recent, keep only useful fields
          const reviews = all.slice(0, 10).map(r => ({
            score: r.averageScore, name: r.name, date: r.date?.split('T')[0],
            type: r.type, headline: r.headline || undefined,
            pros: r.pros || undefined, cons: r.cons || undefined,
          }));
          // Compute average
          const avg = total > 0 ? (all.reduce((s, r) => s + (r.averageScore || 0), 0) / total).toFixed(1) : null;
          return { totalReviews: total, averageScore: avg, reviews };
        }

        case 'semantic_search': {
          if (!params.query) return { error: 'query required for "semantic_search" action' };
          const data = await liteapi.semanticSearch(params.query, params);
          const hotels = data?.data || [];
          const _images = [];
          const results = hotels.map(h => {
            if (h.thumbnail) _images.push(h.thumbnail);
            return { hotelId: h.id, name: h.name, starRating: h.starRating, rating: h.rating, city: h.city, address: h.address };
          });
          return { hotels: results, ...(_images.length ? { _images } : {}) };
        }

        case 'ask': {
          if (!params.hotelId || !params.question) return { error: 'hotelId and question required for "ask" action' };
          const data = await liteapi.askHotel(params.hotelId, params.question);
          return data?.data || data || {};
        }

        default:
          return { error: `Unknown hotel action "${action}". Use: search, details, rates, reviews, semantic_search, ask` };
      }
    },
  },

  travel: {
    description: 'Travel reference data and weather via LiteAPI. Requires "action" argument.\n\n'
      + 'Actions:\n'
      + '- "weather": destination weather forecast. Requires startDate (YYYY-MM-DD), endDate (YYYY-MM-DD). Location via: cityName (auto-geocoded), or latitude/longitude.\n'
      + '- "places": search for destinations/areas (returns placeId, address). Requires textQuery (e.g. "Naples, FL"). Optional: type, language\n'
      + '- "countries": list all countries (no params)\n'
      + '- "cities": list cities in a country. Requires countryCode\n'
      + '- "iata_codes": list IATA airport codes (no params)\n'
      + '- "price_index": city-level hotel price index. Params: cityName, countryCode, checkin, checkout',
    parameters: {
      action: 'string',
      textQuery: 'string (optional, for places search)',
      countryCode: 'string (optional)',
      cityName: 'string (optional)',
      latitude: 'number (optional)',
      longitude: 'number (optional)',
      startDate: 'string (optional, YYYY-MM-DD for weather)',
      endDate: 'string (optional, YYYY-MM-DD for weather)',
      type: 'string (optional)',
      language: 'string (optional)',
      checkin: 'string (optional)',
      checkout: 'string (optional)',
    },
    execute: async (args) => {
      if (!liteapi.isConfigured()) return { error: 'LiteAPI not configured. Set LITEAPI_KEY in .env' };
      const { action, ...params } = args;
      if (!action) return { error: 'Missing "action". Use: weather, places, countries, cities, iata_codes, price_index' };

      switch (action) {
        case 'weather': {
          if (!params.startDate || !params.endDate) return { error: 'startDate and endDate (YYYY-MM-DD) required for "weather"' };
          let { latitude, longitude } = params;
          // Auto-geocode from cityName if no lat/lng provided
          if ((!latitude || !longitude) && params.cityName) {
            const places = await liteapi.searchPlaces(params.cityName);
            const place = places?.data?.[0];
            if (place?.placeId) {
              const details = await liteapi.getPlaceDetails(place.placeId);
              const loc = details?.data?.location;
              if (loc) { latitude = loc.latitude; longitude = loc.longitude; }
            }
          }
          if (!latitude || !longitude) return { error: 'Provide cityName or latitude/longitude for weather' };
          const data = await liteapi.getWeather({ latitude, longitude, startDate: params.startDate, endDate: params.endDate });
          const wd = data?.weatherData?.[0]?.detailedWeatherData || data?.data || data || {};
          // Flatten daily forecasts for LLM readability
          const daily = wd.daily?.map(d => ({
            date: d.date, summary: d.summary?.replace(/^Date:.*Summary:\s*/, ''),
            tempHigh: d.temp?.max, tempLow: d.temp?.min,
            humidity: d.humidity, windSpeed: d.wind_speed,
            rain: d.weather?.[0]?.description, clouds: d.clouds, uvi: d.uvi,
          }));
          return { timezone: wd.timezone, daily: daily || [] };
        }
        case 'places': {
          if (!params.textQuery) return { error: 'textQuery required for "places" action (e.g. "Naples, FL")' };
          const data = await liteapi.searchPlaces(params.textQuery, params);
          return data?.data || data || {};
        }
        case 'countries': {
          const data = await liteapi.listCountries();
          return data?.data || data || {};
        }
        case 'cities': {
          if (!params.countryCode) return { error: 'countryCode required for "cities" action' };
          const data = await liteapi.listCities(params.countryCode);
          return data?.data || data || {};
        }
        case 'iata_codes': {
          const data = await liteapi.getIataCodes();
          return data?.data || data || {};
        }
        case 'price_index': {
          const data = await liteapi.getPriceIndex(params);
          return data?.data || data || {};
        }
        default:
          return { error: `Unknown travel action "${action}". Use: weather, places, countries, cities, iata_codes, price_index` };
      }
    },
  },

  booking: {
    description: 'Hotel booking operations via LiteAPI. Requires "action" argument.\n\n'
      + 'Actions:\n'
      + '- "prebook": lock a rate before booking. Requires rateId (use the rate_N reference from hotel rates results, e.g. "rate_0"). Returns prebookId (auto-cached for book action).\n'
      + '- "book": complete reservation. prebookId is auto-filled from last prebook. holder is auto-filled from saved guest profile if available (shown in prebook result). If no saved profile, ask user for firstName, lastName, email, phone and pass as holder.\n'
      + '- "list": list all bookings (no params)\n'
      + '- "details": get booking info. Requires bookingId\n'
      + '- "cancel": cancel a booking. Requires bookingId\n\n'
      + 'Booking flow: (1) hotel rates → pick rate_N, (2) booking prebook with rateId, (3) booking book with holder info. Steps are sequential — do NOT skip prebook.',
    parameters: {
      action: 'string',
      rateId: 'string (optional)',
      prebookId: 'string (optional)',
      bookingId: 'string (optional)',
      holder: 'object (optional, {firstName, lastName, email, phone})',
      guests: 'array (optional, [{firstName, lastName}])',
      payment: 'object (optional)',
      clientReference: 'string (optional)',
    },
    execute: async (args) => {
      if (!liteapi.isConfigured()) return { error: 'LiteAPI not configured. Set LITEAPI_KEY in .env' };
      const { action, ...params } = args;
      if (!action) return { error: 'Missing "action". Use: prebook, book, list, details, cancel' };

      switch (action) {
        case 'prebook': {
          if (!params.rateId) return { error: 'rateId required for "prebook" action (use rate_N reference from hotel rates results)' };
          // Resolve rate_N ref to actual offerId
          const offerId = lastRateMap[params.rateId] || params.rateId;
          if (offerId === params.rateId && params.rateId.startsWith('rate_')) {
            return { error: `Could not resolve "${params.rateId}" — rate references expire. Please search rates again first.` };
          }
          const data = await liteapi.prebook(offerId);
          const pb = data?.data || data || {};
          // Cache prebookId for the book action
          lastPrebookId = pb.prebookId || null;
          // Include saved guest profile so LLM can confirm or ask for info
          const savedGuest = await loadGuestProfile();
          return {
            prebookId: pb.prebookId,
            hotelId: pb.hotelId,
            price: pb.price, currency: pb.currency,
            checkin: pb.checkin, checkout: pb.checkout,
            cancellation: pb.cancellationPolicies?.refundableTag,
            paymentTypes: pb.paymentTypes,
            savedGuestProfile: savedGuest || 'none — ask user for firstName, lastName, email, phone',
          };
        }
        case 'book': {
          // Auto-resolve prebookId from last prebook if not provided
          const prebookId = params.prebookId || lastPrebookId;
          if (!prebookId) return { error: 'prebookId required — run prebook first to lock a rate' };
          // Build holder: use provided holder, or fall back to saved guest profile
          let holder = params.holder ? (typeof params.holder === 'string' ? JSON.parse(params.holder) : params.holder) : null;
          if (!holder) {
            const saved = await loadGuestProfile();
            if (saved) holder = saved;
            else return { error: 'No guest profile saved. Provide holder ({firstName, lastName, email, phone})' };
          }
          if (!holder.firstName || !holder.lastName || !holder.email) return { error: 'holder must have firstName, lastName, and email' };
          // Auto-generate guests from holder (API requires guests[].email + occupancyNumber)
          let guests = typeof params.guests === 'string' ? JSON.parse(params.guests) : params.guests;
          if (!guests || !guests.length) {
            guests = [{ occupancyNumber: 1, firstName: holder.firstName, lastName: holder.lastName, email: holder.email, phone: holder.phone || '' }];
          }
          const payment = params.payment ? (typeof params.payment === 'string' ? JSON.parse(params.payment) : params.payment) : { method: 'ACC_CREDIT_CARD' };
          const body = { prebookId, holder, guests, payment };
          if (params.clientReference) body.clientReference = params.clientReference;
          const data = await liteapi.book(body);
          const booking = data?.data || data || {};
          // Save guest profile on successful booking
          if (booking.status === 'CONFIRMED') {
            await saveGuestProfile({ firstName: holder.firstName, lastName: holder.lastName, email: holder.email, phone: holder.phone || '' });
          }
          // Return compact summary (full response is huge)
          return {
            bookingId: booking.bookingId, status: booking.status,
            confirmationCode: booking.hotelConfirmationCode,
            hotel: booking.hotel?.name || booking.hotelName,
            checkin: booking.checkin, checkout: booking.checkout,
            price: booking.price, currency: booking.currency,
            guest: `${booking.firstName} ${booking.lastName}`,
            email: booking.email,
            cancellation: booking.cancellationPolicies?.refundableTag,
            paymentStatus: booking.paymentStatus,
          };
        }
        case 'list': {
          const data = await liteapi.listBookings();
          return data?.data || data || {};
        }
        case 'details': {
          if (!params.bookingId) return { error: 'bookingId required for "details" action' };
          const data = await liteapi.getBooking(params.bookingId);
          return data?.data || data || {};
        }
        case 'cancel': {
          if (!params.bookingId) return { error: 'bookingId required for "cancel" action' };
          const data = await liteapi.cancelBooking(params.bookingId);
          return data?.data || data || {};
        }
        default:
          return { error: `Unknown booking action "${action}". Use: prebook, book, list, details, cancel` };
      }
    },
  },
};

// ── Command confirmation ────────────────────────────
const pendingConfirmations = new Map(); // conversationId → { resolve, command }

const CONFIRMATION_TIMEOUT_MS = 120000; // 2 minutes

export function requestConfirmation(conversationId, command) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingConfirmations.has(conversationId)) {
        console.warn(`[confirm] timeout after ${CONFIRMATION_TIMEOUT_MS / 1000}s for conversation ${conversationId}`);
        pendingConfirmations.delete(conversationId);
        resolve(false);
      }
    }, CONFIRMATION_TIMEOUT_MS);
    pendingConfirmations.set(conversationId, { resolve, command, timer });
  });
}

export function resolveConfirmation(conversationId, approved) {
  const pending = pendingConfirmations.get(conversationId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingConfirmations.delete(conversationId);
  pending.resolve(approved);
  return true;
}

export function cancelConfirmation(conversationId) {
  const pending = pendingConfirmations.get(conversationId);
  if (!pending) return false;
  console.warn(`[confirm] cancelled for conversation ${conversationId} (client disconnected)`);
  clearTimeout(pending.timer);
  pendingConfirmations.delete(conversationId);
  pending.resolve(false);
  return true;
}

// Tool enable/disable state
const disabledTools = new Set();

export function listTools() {
  return Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description.split('\n')[0],
    parameters: Object.keys(t.parameters),
    enabled: !disabledTools.has(name),
  }));
}

export function setToolEnabled(name, enabled) {
  if (!tools[name]) return false;
  if (enabled) disabledTools.delete(name);
  else disabledTools.add(name);
  return true;
}

// Build system prompt from registry
export function getSystemPrompt({ applets = false } = {}) {
  const toolList = Object.entries(tools)
    .filter(([name]) => !disabledTools.has(name))
    .map(([name, t]) => `- ${name}: ${t.description}`)
    .join('\n');

  const now = new Date();
  const datetime = {
    utc: now.toISOString(),
    local: now.toString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset: now.getTimezoneOffset(),
  };

  return `You are a helpful, knowledgeable assistant.

## Current Date and Time
Today is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. The current time is ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })} (${datetime.timezone}, UTC offset: ${datetime.offset >= 0 ? '-' : '+'}${Math.abs(datetime.offset / 60)}h). UTC: ${datetime.utc}.
Use this date when answering ANY question involving dates, time, age, deadlines, schedules, or "today/yesterday/tomorrow". Your training data may be outdated — for questions about current events, people in office, recent news, or anything time-sensitive, ALWAYS use web_search first before answering.

## Tool Call Format (MANDATORY — bare JSON without tags is SILENTLY DROPPED)

CRITICAL: Every tool call MUST be wrapped in <tool_call></tool_call> tags. Bare JSON without these tags will NOT execute — it will be displayed as plain text and the tool will never run.

WRONG (silently ignored — tool never runs):
{"name": "run_python", "arguments": {"code": "print('hello')"}}

CORRECT (this actually executes):
<tool_call>
{"name": "run_python", "arguments": {"code": "print('hello')"}}
</tool_call>

Multiple tool calls (executed in parallel):
<tool_call>
{"name": "etrade_account", "arguments": {"action": "portfolio", "accountIdKey": "abc123"}}
</tool_call>
<tool_call>
{"name": "etrade_account", "arguments": {"action": "quote", "symbols": "AAPL,MSFT"}}
</tool_call>

CRITICAL JSON rules:
- All arguments go FLAT in the "arguments" object. NEVER nest "arguments" inside "arguments".
- Every opening { must have a matching closing }.
- WRONG: {"name": "etrade_account", "arguments": {"action": "portfolio", "arguments": {"accountIdKey": "x"}}}
- RIGHT: {"name": "etrade_account", "arguments": {"action": "portfolio", "accountIdKey": "x"}}

Available tools:
${toolList}

Tool rules:
- Output ONLY <tool_call> blocks when using tools, no other text before or after.
- Wait for the tool result before answering.
- Be proactive: when the user asks for data, CALL the tool immediately with the right parameters. NEVER ask "would you like me to run this?" or "should I re-run with different parameters?" — just do it.
- EXCEPTION to proactive rule — booking "book" action: ALWAYS stop and confirm with the user BEFORE calling booking book. Show them: hotel name, dates, room type, price, guest name. Wait for explicit "yes" / "book it" / "confirm". This spends real money — never auto-book.
- REMINDER: tool calls without <tool_call> tags DO NOT EXECUTE.

## Tool Routing — match user intent to the RIGHT tool
- Hotels, travel, trips, vacations, accommodation, resorts → use "hotel" tool (search, details, rates, reviews)
- Weather forecasts, destination info, places, airports, cities → use "travel" tool
- Hotel reservations, booking, cancellation → use "booking" tool
- Stock market, portfolio, options, E*TRADE accounts, trading → use "etrade_account" tool
- Web questions, current events, news → use "web_search" then "web_fetch"
- NEVER use etrade_account for travel/hotel queries. NEVER use hotel/travel for financial queries.

## FINANCIAL DATA INTEGRITY (applies to ALL E*TRADE / financial data)
- NEVER interpret, reformat, summarize, round, abbreviate, recalculate, or manually transcribe financial data. E*TRADE tool results are authoritative — present them EXACTLY as returned, or save them to a file and let Python do the analysis. Dropping digits, misplacing decimals, or rounding dollar amounts is a serious error (e.g. $92,891.35 must stay $92,891.35 — never $924.83, $92,891, or $92.9K).
- NEVER fabricate, interpolate, or invent financial figures. Only present values that appear verbatim in tool results. If a field or row doesn't exist in the data, don't create it.
- NEVER question or editorialize about live market data based on your training data. Stock prices change — if E*TRADE shows a stock at $400, that IS the price. Do not say "this seems unusually high" or "typically trades lower" based on stale training knowledge. Your training data prices are outdated; live data is ground truth.
- OPTIONS REASONING: Apply correct options logic. IV (implied volatility) reflects the market's expected move, NOT moneyness. High IV on an OTM option means the market expects a large move or is pricing event risk — it does NOT mean IV is high "because" the option is far OTM. OTM options with no catalyst typically have LOWER IV. Get the causality right: distance from strike is a reason to question why IV is elevated, never an explanation for it.
- NEVER substitute training-data knowledge for missing live data. If a tool call didn't return the data you need (e.g. IV, Greeks, a specific field), RETRY the tool with correct parameters or tell the user what's missing. NEVER say "the tool didn't return X, but here's what typically happens" — that's fabrication disguised as education. Either fetch real data or say you couldn't get it.
- For ANY calculation on financial data (sums, averages, filtering, grouping, date math, comparisons of more than 2-3 values) — ALWAYS save the data to a file first (using saveAs), then use run_python to process it. Never do mental math or manual arithmetic on financial figures.
- When etrade_account returns a "_markdown" table, DO NOT repeat or echo the table in your response. The user can see the data in the collapsible tool result. Instead, provide insights, answer the question, or highlight key findings. When the result is auto-saved (you see "_autoSaved"), use run_python with the saved CSV file for any analysis. The preview only shows the first 15 rows — the FULL dataset is in the CSV. NEVER claim data is missing or unavailable when it was auto-saved. If the preview doesn't show the rows you need, that means you MUST use run_python to read the CSV — the data IS there.
- ANALYSIS WORKFLOW: When the user asks to retrieve data AND perform calculations (e.g. "get transactions and calculate net income"), ALWAYS combine both steps into ONE etrade_account call with saveAs, then ONE run_python call. NEVER fetch data without saveAs when analysis is needed — the correct sequence is: (1) etrade_account with saveAs to get real data into a file, (2) run_python to read that file and compute results. This avoids dumping large tables on screen and ensures Python works with real data.
- Large result sets (30+ rows) are auto-saved to CSV. When you see "_autoSaved" in the result, the full data is already in the saved file — use that filename in your run_python script. Do NOT re-fetch the data.

## File & data workflow
- To save E*TRADE data to a file — use etrade_account with the "saveAs" parameter (e.g. saveAs: "CURRENT_TRANSACTIONS.csv"). This is the ONLY correct way. NEVER use run_python or save_file to save E*TRADE data — the data would be fabricated. Only etrade_account has real data.
- To see what data files are available — use list_files.
- To read file contents (CSVs, text files, downloaded data) — use file_read. Use head parameter for large files.
- To run Python scripts for data analysis, calculations, or CSV processing — use run_python. Scripts run in the data directory and can read/write files there directly. ONLY use run_python to process data that already exists in files — never to fetch or fabricate data.
- run_python output strategy: For quick calculations, just print(). For reports, tables, or analysis results — ALWAYS save to a file (CSV for data, MD for formatted reports, HTML for rich reports, PNG for charts) AND print a short summary. The tool auto-detects created files and returns download URLs. Never dump large tables to stdout — save them to a file instead.
- run_python data workflow: When the user asks for a CALCULATION, write the calculation script DIRECTLY — do NOT waste rounds on diagnostic scripts (list_files, file_read, print columns) unless the calculation script fails. You already know the column names from the tool results and CSV format. Transaction CSV columns: Date, Transaction ID, Type, Symbol, Security Type, Call/Put, Strike, Expiry, Quantity, Price, Amount, Fee, Description. Portfolio CSV columns: Symbol, Description, Security Type, Call/Put, Strike, Expiry, Quantity, Price Paid, Market Value, Total Cost, Total Gain, Total Gain Pct. If etrade_account auto-saved a file (you see "_autoSaved" and "savedFile"), use that filename directly. Only run a diagnostic script (print columns, head) AFTER a calculation script fails — never as a first step. NEVER do mental arithmetic on financial data — if the user asked for a calculation, you MUST produce the answer from a Python script, not from eyeballing data.
- run_python code quality — MANDATORY rules:
  1. FORBIDDEN: iterrows(), itertuples(), for-loops over DataFrame rows, iloc[0] inside loops. Use ONLY vectorized pandas: groupby().agg(), merge(), df[condition]['col'].sum(). Any script using iterrows WILL FAIL.
  2. Keep scripts under 40 lines. One task per script.
  3. Pick ONE output: print() a short summary OR save a file. Not both.
  4. Before submitting: mentally verify every string literal, bracket, quote, and f-string brace. A syntax error wastes an entire tool round.
  Example of CORRECT transaction analysis: df = pd.read_csv('file.csv'); by_type = df.groupby('Type')['Amount'].sum(); fees = df['Fee'].sum(); print(by_type.to_string()); print(f"Total fees: {fees:.2f}")
  Example of CORRECT option pair matching (vectorized, NOT iterrows) — USE THIS EXACT PATTERN:
    df = pd.read_csv('file.csv')
    opts = df[df['Security Type'].str.contains('OPTN|Option', na=False)]
    expired = opts[opts['Type']=='Option Expired']
    shorts = opts[opts['Type']=='Sold Short'].groupby(['Symbol','Call/Put','Strike','Expiry']).agg(Proceeds=('Amount','sum'), ShortFee=('Fee','sum'), ShortQty=('Quantity','sum')).reset_index()
    covers = opts[opts['Type']=='Bought To Cover'].groupby(['Symbol','Call/Put','Strike','Expiry']).agg(CoverCost=('Amount','sum'), CoverFee=('Fee','sum'), CoverQty=('Quantity','sum')).reset_index()
    m = shorts.merge(covers, on=['Symbol','Call/Put','Strike','Expiry'], how='outer', indicator=True)
    closed = m[m['_merge']=='both'].copy()
    closed['Gain'] = closed['Proceeds'] + closed['CoverCost'] - closed['ShortFee'] - closed['CoverFee']
    open_s = m[m['_merge']=='left_only']
    open_c = m[m['_merge']=='right_only']
    print("CLOSED PAIRS:"); print(closed[['Symbol','Call/Put','Strike','Expiry','ShortQty','Proceeds','CoverQty','CoverCost','Gain']].to_string(index=False))
    print(f"\\nTotal P&L: \${closed['Gain'].sum():,.2f}")
    if len(open_s): print("\\nOPEN SHORTS (no cover):"); print(open_s[['Symbol','Call/Put','Strike','Expiry','ShortQty','Proceeds']].to_string(index=False))
    if len(open_c): print("\\nORPHAN COVERS (short in prior period):"); print(open_c[['Symbol','Call/Put','Strike','Expiry','CoverQty','CoverCost']].to_string(index=False))
    if len(expired): print("\\nEXPIRED:"); print(expired[['Symbol','Call/Put','Strike','Expiry']].to_string(index=False))
- Option position status definitions (apply consistently):
  - Closed: Short Qty = Cover Qty (fully realized)
  - Over-covered: Cover Qty > Short Qty (still fully realized — calculate full P&L, do not skip)
  - Open: Short Qty > 0 and Cover Qty = 0 (unrealized)
  - Partial: 0 < Cover Qty < Short Qty (partially realized)
  - Expired: Closed via "Option Expired" at $0 cover cost (full premium retained, fully realized)
  - Orphan Cover: Cover Qty > 0 and Short Qty = 0 (short was in a prior period)
- Option analysis summary table format — use this EXACT layout:
  Symbol | Type | Strike | Expiry | Short Qty | Cover Qty | Status | Premium Received | Cover Cost | Fees | Net P&L
  Every cell must have a dollar amount. Net P&L: +sign for gains, -sign for losses. Open positions: show UNREALIZED. Orphan Covers: show PRIOR PERIOD.
  Footer rows:
  REALIZED TOTAL — Closed + Expired + Over-covered groups only
  OPEN EXPOSURE — Open + Partial groups only (UNREALIZED)
  PRIOR PERIOD — Orphan Cover groups only (NOT INCLUDED in realized total)
- Amount column sign rules: Sold Short amounts are POSITIVE (cash received), Bought To Cover amounts are NEGATIVE (cash paid). Use values as-is from the data — do NOT reverse signs. Net P&L = sum(Sold Short amounts) + sum(Bought To Cover amounts) - total fees.
- CRITICAL FALLBACK: If run_python is unavailable or exhausted, perform arithmetic INLINE using the transaction data already in context. Do NOT cite disabled Python, script truncation, or tool limits as a reason to skip math. Summing premiums and subtracting cover costs is basic addition — it does not require code execution. A response missing dollar amounts is incomplete.
- run_python error handling: If a script fails, DO NOT retry with the same approach. First run a small diagnostic script (e.g. print columns, print dtypes, print first row) to understand the data, then fix the actual issue. Maximum 1 retry after diagnosis.
- WHEN TO USE run_python vs direct answer: USE run_python for: any calculation involving more than 3 numbers, aggregations (sum, avg, count, group-by), data with more than 10 rows, date math, filtering/sorting data, or any question where getting the wrong number would be harmful. ANSWER DIRECTLY for: single value lookups, qualitative questions, comparing 2-3 values, or explaining what data means. RULE OF THUMB: if you need to count, sum, or iterate — use Python. Never do mental math on financial data.
- You are a LOCAL assistant running on the user's machine. You have real shell access via the run_command tool. When the user asks you to run commands, install packages, list files, or perform any shell operation — use run_command. NEVER say you cannot run commands or don't have access to the user's system.
- After web_search, ALWAYS use web_fetch on the most relevant result URL to get full details before answering. Search snippets alone are not sufficient.
- For ANY question about stock quotes, option chains, option Greeks, option expiration dates, or symbol lookup — ALWAYS use etrade_account (actions: quote, optionchains, optionexpiry, lookup) instead of web_search. These return real-time market data directly from E*TRADE. Only fall back to web_search if E*TRADE is not authenticated.
- EXISTING POSITIONS IV/Greeks: When the user asks about IV, Greeks, or details on options they ALREADY HOLD (e.g. "check my MU option's IV", "what's the delta on my calls"), do NOT fetch the full option chain or expiry list. Instead: (1) call "portfolio" with accountIdKey matching the account description (e.g. "IRA", "brokerage" — auto-resolved, no need to call "list" first) to see their exact positions (symbol, strike, expiry), (2) call "optionchains" with the EXACT expiryYear/expiryMonth/expiryDay and strikePriceNear matching the held position's strike, with noOfStrikes=3 to get a narrow slice. This returns IV and Greeks in just 2 rounds. NEVER call optionexpiry when the user already has positions — the expiry is in the portfolio data. NEVER call "list" just to look up an accountIdKey — pass the account description directly.
- General options analysis workflow (IV surface, term structure, "show all options"): (1) get current price with "quote" + available expirations with "optionexpiry" in parallel (ONE round), (2) immediately fetch "optionchains" — do NOT re-fetch quote or expiry dates you already have. For multi-expiry analysis, fetch up to 3 chains in parallel in ONE round, each with saveAs (e.g. saveAs: "MU_chain_apr17.csv"). Use strikePriceNear + noOfStrikes to limit each chain to ~20 strikes near ATM — do NOT fetch full chains for multi-expiry analysis as the combined data will be too large. You have limited tool rounds — NEVER waste rounds repeating calls you already made. (3) In the NEXT round (not the same round!), use run_python on the saved CSVs. NEVER mix optionchains + run_python in the same round — run_python executes in parallel and the files won't exist yet. NEVER guess prices, expiration dates, or Greeks — always fetch real data first.
- CRITICAL: Only present strike prices, premiums, and Greeks that appear EXACTLY in the tool results. NEVER interpolate, extrapolate, or invent strikes between the ones returned. If the chain shows strikes at 420 and 430, do NOT fabricate a 425 strike. Present only real data rows from the tool output.
- RANKING/FILTERING option chains: When the user asks for "most popular", "highest volume", "top N by OI", or any ranking/filtering of options — you MUST fetch the FULL chain (do NOT use noOfStrikes to limit). The full chain will auto-save to CSV. Then use run_python to sort/filter the CSV and find the answer. You cannot determine "most popular" from a subset — you need all strikes to compare. Example: fetch full chain with saveAs → run_python to sort by Open Interest or Volume → present top N results.
- When analyzing options positions from etrade_account, ALWAYS use the current date/time (provided above) to calculate days-to-expiry. Never estimate or guess expiration dates — compute them from the portfolio data. Verify your time-to-expiry math before reporting. Common covered call strategies use ~30-day income-generating calls, not imminent expirations — frame your analysis accordingly.

## Hotel & Travel Tools
- Hotel images are auto-displayed by the UI as thumbnails — do NOT output markdown image syntax (no ![](url)).
- Summarize hotels by: name, star rating, location, price range, key amenities. The user can see the photos automatically.
- Booking flow (MUST follow these steps in order):
  Step 1: hotel rates → pick rate_N
  Step 2: booking prebook with rateId → returns prebookId + savedGuestProfile + price
  Step 3: STOP. Show the user a confirmation summary: hotel name, room, dates, price, cancellation policy, guest name/email from savedGuestProfile. Ask "Shall I confirm this booking?" and WAIT for user response.
  Step 4: ONLY after user explicitly confirms → call booking book (holder auto-filled from saved profile, or pass new holder if user provides different info)
  NEVER skip Step 3. NEVER call booking book in the same tool round as prebook.
- Rate references (rate_0, rate_1, etc.) map to actual offerIds internally — just pass the reference string to the booking prebook action. prebookId is auto-cached from the last prebook.
- Rate IDs are ephemeral — prebook promptly after getting rates, do not delay.
- occupancies format example: [{"adults": 2}] or [{"adults": 2, "children": [5, 8]}]
- For hotel search, prefer aiSearch for natural language queries (e.g. "beachfront resort in Bali").
- When searching rates for a SPECIFIC hotel, use hotelIds (e.g. ["lp29df3"]) — NOT countryCode+cityName, which returns all hotels in the city and is much slower.
- Booking errors: "fraud check" (code 2013) in sandbox mode is usually rate limiting — too many book calls in quick succession. Wait a moment and retry. In production mode, fraud rejections are real and should be reported to the user. "invalid offerId" or "no prebook availability" means the rate expired — search rates again. "invalid prebookId" means the prebook expired — prebook again with a fresh rate.
- NEVER claim you "fabricated" or "didn't actually call" a tool. Tool results in the conversation are real — they came from actual API calls. If you see a tool result, it happened.

## Response Formatting

Adapt formatting to response length:
- **Under 50 words**: Plain text, no special formatting needed.
- **50–150 words**: Use **bold** for key terms. Keep to 1–2 short paragraphs.
- **150–300 words**: Use ## headers to break into sections. Use bullet points where appropriate.
- **Over 300 words**: Begin with a **Key Takeaway** block (2–3 bullets). Use headers, lists, and tables.

Rules:
- Answer the question in the first sentence. Never bury the conclusion.
- Use **bold** for key terms only — never bold entire sentences.
- Use bullet points for 3+ related items. Use numbered lists only for sequential steps.
- Use tables for comparisons of 3+ items.
- Use fenced code blocks with language tags for code. Use \`inline code\` for technical terms.
- Mermaid v11 diagrams are supported by the UI (NOT a tool — just use fenced \`\`\`mermaid code blocks in your response). No emoji in Mermaid text. Pie chart labels MUST be quoted: \`"AMD" : 35.06\` (not \`AMD : 35.06\`). Pie values must be positive — if ANY value is negative, use xychart-beta bar chart instead. For ANY bar or line chart, the FIRST LINE must be exactly "xychart-beta" — no other chart type keyword exists (not "barChart", "lineChart", "line chart", "bar chart"). Use "bar" and "line" as series keywords inside xychart-beta. Valid types: pie, xychart-beta, flowchart, timeline, mindmap, gantt, journey, sequenceDiagram.
- Keep paragraphs to 2–4 sentences.
- Use emoji sparingly as section markers (e.g., 📌 Key Point, ⚠️ Warning) — never inline or decorative.
- Use plain, direct language. No filler phrases or sycophantic openers.
- Separate major topic shifts with a horizontal rule (---).

${applets ? `## Applet Visualizations

When the user requests a visualization, chart, diagram, or interactive widget:
- Output a complete HTML document between <applet type="TYPE"> and </applet> tags
- TYPE must be one of: svg, chartjs, html
- The HTML must be self-contained — all CSS inline in <style>, all JS inline in <script>
- Data goes in a const at the top of <script> — separate data from rendering logic
- Dark theme: background #1a1a2e, text #e0e0e0, accent #4a9eff, secondary #7c3aed, success #10b981, warning #f59e0b, error #ef4444, surface #16213e, border #2a2a4a
- Responsive: use percentage widths, min/max constraints
- Max 50KB total HTML size
- For resize: window.parent.postMessage({ type: 'resize', height: document.body.scrollHeight }, '*')

For type="svg" applets:
- Use inline SVG directly in the HTML body
- Use viewBox for scaling, no fixed pixel dimensions on the SVG element
- Text: fill="#e0e0e0", font-family: system-ui
- Lines/borders: stroke="#2a2a4a"
- Shapes: fill with the accent palette above
- For flowcharts: use rounded rects, arrows with markers, labels centered in shapes

For type="chartjs" applets:
- Chart.js is available at /lib/chart.min.js — include via <script src="/lib/chart.min.js"></script>
- Create a <canvas id="chart"></canvas> in the body
- Instantiate with: new Chart(document.getElementById('chart'), config)
- Use dark theme defaults: grid color '#2a2a4a', tick color '#e0e0e0'
- Plugin.legend.labels.color = '#e0e0e0'

Example — complete working applet:
<applet type="chartjs">
<!DOCTYPE html>
<html><head>
<script src="/lib/chart.min.js"></script>
<style>body { margin: 0; padding: 16px; background: #1a1a2e; }</style>
</head><body>
<canvas id="chart"></canvas>
<script>
const DATA = [
  { label: 'AAPL', value: 42 },
  { label: 'MSFT', value: 31 },
  { label: 'GOOGL', value: 27 }
];
new Chart(document.getElementById('chart'), {
  type: 'bar',
  data: {
    labels: DATA.map(d => d.label),
    datasets: [{ label: 'Allocation %', data: DATA.map(d => d.value),
      backgroundColor: '#4a9eff', borderColor: '#4a9eff', borderWidth: 1 }]
  },
  options: {
    responsive: true,
    scales: { y: { ticks: { color: '#e0e0e0' }, grid: { color: '#2a2a4a' } },
              x: { ticks: { color: '#e0e0e0' }, grid: { color: '#2a2a4a' } } },
    plugins: { legend: { labels: { color: '#e0e0e0' } } }
  }
});
</script>
</body></html>
</applet>

For type="html" applets:
- Pure HTML/CSS/JS, no external libraries
- Use CSS grid or flexbox for layouts
- For tables: sticky headers, alternating row colors (#16213e / #1a1a2e), hover highlight #2a2a4a
- For interactive controls: style inputs/selects/buttons with the dark palette
- Canvas API is available for custom drawing and animation

` : ''}## FINAL REMINDER
All tool calls MUST use <tool_call></tool_call> tags. Bare JSON is silently ignored — the tool will NOT run.`;
}

// Parse all <tool_call>...</tool_call> blocks from LLM output
// Unescape JSON string escape sequences to produce the actual string value
function unescapeJsonString(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"');
}

// Try to repair malformed JSON in tool calls (common with run_python code containing newlines/quotes)
function repairToolCallJson(raw) {
  // Pre-fix: add missing opening quotes around string values (e.g. "name":etrade_account" → "name":"etrade_account")
  const quoteFixed = raw.replace(/:(\s*)([a-zA-Z_][a-zA-Z0-9_]*)"/g, ':$1"$2"');
  const nameMatch = quoteFixed.match(/"name"\s*:\s*"([^"]+)"/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  // If quote-fix produced valid JSON, use it directly
  try {
    const parsed = JSON.parse(quoteFixed);
    if (parsed.name) {
      console.log(`[parseToolCalls] repaired JSON by fixing missing quotes for tool "${name}"`);
      return { name: parsed.name, arguments: parsed.arguments || {} };
    }
  } catch { /* continue to other repair attempts */ }

  // Attempt 1: smart-escape literal newlines/tabs/CR inside JSON string values only
  try {
    let escaped = '';
    let esc_inStr = false;
    for (let j = 0; j < raw.length; j++) {
      const ch = raw[j];
      if (esc_inStr) {
        if (ch === '\\') { escaped += ch + (raw[++j] || ''); continue; }
        if (ch === '"') esc_inStr = false;
        if (ch === '\n') { escaped += '\\n'; continue; }
        if (ch === '\r') { escaped += '\\r'; continue; }
        if (ch === '\t') { escaped += '\\t'; continue; }
        escaped += ch;
      } else {
        if (ch === '"') esc_inStr = true;
        escaped += ch;
      }
    }
    const parsed = JSON.parse(escaped);
    if (parsed.name) {
      console.log(`[parseToolCalls] repaired JSON by smart-escaping newlines for tool "${name}"`);
      return { name: parsed.name, arguments: parsed.arguments || {} };
    }
  } catch { /* continue to next attempt */ }

  // Attempt 2: manually extract string arguments for tools with large content
  // Unescape JSON sequences so values have real newlines (not literal \n)
  // Supports single-arg tools (run_python, run_command) and multi-arg (save_file)
  const toolArgMap = {
    run_python: { primary: 'code' },
    run_command: { primary: 'command' },
    save_file: { primary: 'content', extra: ['filename'] },
  };
  const argConfig = toolArgMap[name];
  if (argConfig) {
    // Helper: extract a quoted string value for a given key from raw JSON text
    const extractStringArg = (src, key) => {
      const pattern = new RegExp(`"${key}"\\s*:\\s*"`);
      const m = src.match(pattern);
      if (!m) return null;
      const start = m.index + m[0].length;
      let end = -1;
      for (let j = start; j < src.length; j++) {
        const ch = src[j];
        if (ch === '\\') { j++; continue; }
        if (ch === '\n' || ch === '\r') continue;
        if (ch === '"') {
          const after = src.slice(j + 1).trimStart();
          // Stop if followed by }} (end of object), or ,"key" (next argument)
          if (after.startsWith('}') || after.match(/^,\s*"/)) {
            end = j; break;
          }
        }
      }
      if (end === -1) {
        end = src.length - 1;
        while (end > start && /[\s}]/.test(src[end])) end--;
        if (src[end] !== '"') return null;
      }
      return end > start ? unescapeJsonString(src.slice(start, end)) : null;
    };

    const primary = extractStringArg(raw, argConfig.primary);
    if (primary !== null) {
      const args = { [argConfig.primary]: primary };
      // Extract extra args (short string args like filename)
      if (argConfig.extra) {
        for (const key of argConfig.extra) {
          const val = extractStringArg(raw, key);
          if (val !== null) args[key] = val;
        }
      }
      console.log(`[parseToolCalls] manually extracted args (${Object.keys(args).join(', ')}) for tool "${name}"`);
      return { name, arguments: args };
    }
  }

  return null;
}

export function parseToolCalls(text) {
  const calls = [];

  // Strip <think> blocks — models sometimes include reasoning that contains
  // JSON fragments resembling tool calls, which can confuse the fallback parser
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '');

  // Pre-normalize: fix = used instead of : in tool call JSON
  // Pattern 1: "name=tool_name" as a single token → "name": "tool_name"
  //   e.g. {"name=list_files", "arguments": {}} → {"name": "list_files", "arguments": {}}
  text = text.replace(/"(name|arguments)\s*=\s*([^"{}[\],]+)"/g, '"$1": "$2"');
  // Pattern 2: "key" = value (= as separator instead of :)
  //   e.g. {"name" = "list_files"} → {"name": "list_files"}
  text = text.replace(/"(\w+)"\s*=\s*/g, '"$1": ');

  // Primary: extract all <tool_call> blocks
  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    const raw = match[1];
    // Normalize Python-style literals to JSON (True→true, False→false, None→null)
    const normalized = raw.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
    try {
      const parsed = JSON.parse(normalized);
      if (parsed.name) calls.push({ name: parsed.name, arguments: parsed.arguments || {} });
    } catch (e) {
      // JSON parse failed — attempt repair (common with run_python code containing newlines)
      console.warn(`[parseToolCalls] JSON.parse failed: ${e.message}`);
      const repaired = repairToolCallJson(normalized);
      if (repaired) {
        calls.push(repaired);
      } else {
        console.error(`[parseToolCalls] Could not repair tool call. Raw (first 300 chars):\n${raw.slice(0, 300)}`);
      }
    }
  }
  if (calls.length > 0) return calls;

  // Fallback: detect bare JSON tool calls without tags (handles nested objects and missing braces)
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{"name"', i);
    if (start === -1) break;
    // String-aware brace counting — skip over JSON string contents so that
    // braces inside quoted values (e.g. Python code) don't confuse the parser
    let depth = 0, end = start, inString = false;
    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (ch === '\\') { j++; continue; } // skip escaped char
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    let candidate = text.slice(start, end);
    // If braces are unbalanced, try appending missing closing braces
    if (depth > 0) candidate += '}'.repeat(depth);
    // Try parsing directly, then with smart newline escaping, then full repair
    let parsed = null;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // Smart-escape: only escape literal newlines/tabs/CR inside JSON string values
      // (unlike blind replace, this preserves whitespace between JSON tokens)
      let escaped = '';
      let esc_inStr = false;
      for (let j = 0; j < candidate.length; j++) {
        const ch = candidate[j];
        if (esc_inStr) {
          if (ch === '\\') { escaped += ch + (candidate[++j] || ''); continue; }
          if (ch === '"') esc_inStr = false;
          if (ch === '\n') { escaped += '\\n'; continue; }
          if (ch === '\r') { escaped += '\\r'; continue; }
          if (ch === '\t') { escaped += '\\t'; continue; }
          escaped += ch;
        } else {
          if (ch === '"') esc_inStr = true;
          escaped += ch;
        }
      }
      try {
        parsed = JSON.parse(escaped);
        console.log(`[parseToolCalls] bare JSON parsed after smart-escaping newlines`);
      } catch {
        // Full repair as last resort
        const repaired = repairToolCallJson(candidate);
        if (repaired) calls.push(repaired);
      }
    }
    if (parsed && parsed.name && typeof parsed.arguments === 'object') {
      const args = parsed.arguments.arguments ? parsed.arguments.arguments : parsed.arguments;
      calls.push({ name: parsed.name, arguments: args });
    }
    i = end;
  }
  return calls;
}

// Execute a tool by name
export async function executeTool(name, args, context) {
  if (disabledTools.has(name)) {
    return JSON.stringify({ error: `Tool "${name}" is currently disabled.` });
  }
  let tool = tools[name];
  if (!tool) {
    // Fuzzy match: find tool names containing the input or vice versa
    const available = Object.keys(tools);
    const close = available.find(t => t.includes(name) || name.includes(t));
    if (close) {
      console.log(`[tools] Auto-corrected "${name}" → "${close}"`);
      tool = tools[close];
      name = close;
    } else {
      return JSON.stringify({ error: `Unknown tool: ${name}. Available tools: ${available.join(', ')}` });
    }
  }
  try {
    console.log(`[tools] executing "${name}" args=${JSON.stringify(args).slice(0, 200)}`);
    const t0 = Date.now();
    const result = await tool.execute(args, context);
    console.log(`[tools] "${name}" completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // Log LiteAPI tool calls (hotel, travel, booking) — etrade has its own internal logging
    if (['hotel', 'travel', 'booking'].includes(name)) {
      const action = args?.action || 'unknown';
      // Strip _images and _rateMap from logged result to keep logs readable
      const { _images, _rateMap, ...loggableResult } = result || {};
      if (_images) loggableResult._imageCount = _images.length;
      if (_rateMap) loggableResult._rateCount = Object.keys(_rateMap).length;
      logToolCall(name, action, { args, rawResult: loggableResult, formattedResult: loggableResult });
    }
    return JSON.stringify(result);
  } catch (err) {
    console.error(`[tools] "${name}" error: ${err.message}`);
    if (['hotel', 'travel', 'booking'].includes(name)) {
      logToolCall(name, args?.action || 'error', { args, rawResult: { error: err.message }, formattedResult: { error: err.message } });
    }
    return JSON.stringify({ error: err.message });
  }
}
