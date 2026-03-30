import { writeFile } from 'fs/promises';
import { join, resolve, basename } from 'path';
import config from '../config.js';
import etrade from '../services/etrade.js';
import { logToolCall } from './index.js';

// ── Shared helpers ───────────────────────────────────
function formatExpiry(p) {
  if (!p.expiryYear) return '';
  const yr = Number(p.expiryYear);
  const fullYear = yr < 100 ? 2000 + yr : yr;
  return `${fullYear}-${String(p.expiryMonth).padStart(2, '0')}-${String(p.expiryDay).padStart(2, '0')}`;
}

function formatStrike(v) { return v != null && v !== 0 ? v : ''; }

// ── CSV helpers ──────────────────────────────────────
function csvEscape(v) {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map(r => r.map(csvEscape).join(','))].join('\n');
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

// ── CSV formatters ───────────────────────────────────
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
    const all = q.All || q.Intraday || q.Fundamental || q.Week52 || q.MutualFund || {};
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

function optionChainsToCsv(data) {
  const pairs = data.OptionPair || [];
  if (!pairs.length) return '';
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

function optionExpireDatesToCsv(data) {
  const dates = data.expirationDates || [];
  if (!dates.length) return '';
  const headers = ['Year', 'Month', 'Day', 'Expiry Type'];
  const rows = dates.map(d => [d.year ?? '', d.month ?? '', d.day ?? '', d.expiryType ?? '']);
  return toCsv(headers, rows);
}

function lookupToCsv(data) {
  const products = data.products || [];
  if (!products.length) return '';
  const headers = ['Symbol', 'Description', 'Type'];
  const rows = products.map(p => [p.symbol || '', p.description || '', p.type || '']);
  return toCsv(headers, rows);
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

function alertsToCsv(data) {
  const alerts = data.Alert || [];
  if (!alerts.length) return '';
  const headers = ['Alert ID', 'Date', 'Subject', 'Status', 'Symbol'];
  const rows = alerts.map(a => [a.id ?? '', a.createDate || a.createTime || '', a.subject || '', a.status || '', a.symbol || '']);
  return toCsv(headers, rows);
}

function alertDetailToCsv(data) {
  const headers = ['Alert ID', 'Date', 'Subject', 'Status', 'Symbol', 'Message'];
  const row = [data.id ?? '', data.createDate || data.createTime || '', data.subject || '', data.status || '', data.symbol || '', data.msgText || ''];
  return toCsv(headers, [row]);
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

// ── Markdown formatters ──────────────────────────────
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

function gainsToMd(data) {
  const rows = (data.gains || []).map(g => [
    g.symbol, g.description || '', g.callPut || '', formatStrike(g.strikePrice), formatExpiry(g),
    g.dateAcquired ?? '', g.quantity, g.costPerShare, g.totalCost, g.marketValue, g.gain, g.gainPct, g.term,
  ]);
  return toMd(`Unrealized Gains (${data.totalCount} lots)`,
    ['Symbol', 'Description', 'C/P', 'Strike', 'Expiry', 'Acquired', 'Qty', 'Price/Share', 'Total Cost', 'Value', 'Gain', 'Gain %', 'Term'], rows);
}

function quotesToMd(data) {
  const quotes = data.quotes || [];
  if (!quotes.length) return '';
  const headers = ['Symbol', 'Company', 'Last', 'Change', 'Change %', 'Bid', 'Ask', 'Volume', '52w High', '52w Low', 'P/E'];
  const rows = quotes.map(q => {
    const all = q.All || q.Intraday || q.Fundamental || q.Week52 || q.MutualFund || {};
    return [
      q.Product?.symbol || '', all.companyName || q.Product?.symbolDescription || '',
      all.lastTrade ?? '', all.changeClose ?? all.change ?? '',
      all.changeClosePercentage ?? all.changePct ?? '', all.bid ?? '', all.ask ?? '',
      all.totalVolume ?? all.volume ?? '', all.high52 ?? '', all.low52 ?? '', all.pe ?? '',
    ];
  });
  return toMd(`Quotes (${quotes.length})`, headers, rows);
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

function optionExpireDatesToMd(data) {
  const dates = data.expirationDates || [];
  if (!dates.length) return '';
  const headers = ['Year', 'Month', 'Day', 'Type'];
  const rows = dates.map(d => [d.year ?? '', d.month ?? '', d.day ?? '', d.expiryType ?? '']);
  return toMd(`Option Expiration Dates (${dates.length})`, headers, rows);
}

function lookupToMd(data) {
  const products = data.products || [];
  if (!products.length) return '';
  const headers = ['Symbol', 'Description', 'Type'];
  const rows = products.map(p => [p.symbol || '', p.description || '', p.type || '']);
  return toMd(`Product Lookup (${products.length})`, headers, rows);
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

// ── Formatter maps ───────────────────────────────────
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

export default {
  group: 'finance',
  condition: () => etrade.isAuthenticated(),
  status: {
    label: 'E*TRADE',
    interval: 0,
    poll: async () => {
      const configured = !!(config.etrade.consumerKey && config.etrade.consumerSecret);
      if (!configured) return null;
      return etrade.isAuthenticated() ? 'ok' : 'unauth';
    },
    auth: {
      start: async () => {
        const url = await etrade.getAuthorizeUrl();
        return { url };
      },
      complete: async (input) => {
        await etrade.handleCallback(input.trim());
        return { ok: true };
      },
      disconnect: async () => {
        etrade.disconnect();
        return { ok: true };
      },
    },
  },
  routing: [
    '- Stock market, portfolio, options, E*TRADE accounts, trading → use "etrade_account" tool',
  ],
  prompt: `## FINANCIAL DATA INTEGRITY (applies to ALL E*TRADE / financial data)
- NEVER interpret, reformat, summarize, round, abbreviate, recalculate, or manually transcribe financial data. E*TRADE tool results are authoritative — present them EXACTLY as returned, or save them to a file and let Python do the analysis. Dropping digits, misplacing decimals, or rounding dollar amounts is a serious error (e.g. $92,891.35 must stay $92,891.35 — never $924.83, $92,891, or $92.9K).
- NEVER fabricate, interpolate, or invent financial figures. Only present values that appear verbatim in tool results. If a field or row doesn't exist in the data, don't create it.
- NEVER question or editorialize about live market data based on your training data. Stock prices change — if E*TRADE shows a stock at $400, that IS the price. Do not say "this seems unusually high" or "typically trades lower" based on stale training knowledge. Your training data prices are outdated; live data is ground truth.
- OPTIONS REASONING: Apply correct options logic. IV (implied volatility) reflects the market's expected move, NOT moneyness. High IV on an OTM option means the market expects a large move or is pricing event risk — it does NOT mean IV is high "because" the option is far OTM. OTM options with no catalyst typically have LOWER IV. Get the causality right: distance from strike is a reason to question why IV is elevated, never an explanation for it.
- NEVER substitute training-data knowledge for missing live data. If a tool call didn't return the data you need (e.g. IV, Greeks, a specific field), RETRY the tool with correct parameters or tell the user what's missing. NEVER say "the tool didn't return X, but here's what typically happens" — that's fabrication disguised as education. Either fetch real data or say you couldn't get it.
- For ANY calculation on financial data (sums, averages, filtering, grouping, date math, comparisons of more than 2-3 values) — use run_python to process it. Never do mental math or manual arithmetic on financial figures.
- When etrade_account returns a "_markdown" table, DO NOT repeat or echo the table in your response. The user can see the data in the collapsible tool result. Instead, provide insights, answer the question, or highlight key findings.
- To save E*TRADE data for Python analysis — use etrade_account with "saveAs" parameter (e.g. saveAs: "transactions.csv"). Files are saved to the source project directory. NEVER use run_python to fabricate E*TRADE data — only etrade_account has real data.
- Large result sets (30+ rows) are auto-saved to CSV in the project directory. When you see "_autoSaved", use that filename directly in run_python.
- run_python runs in the source project directory — same location as saved files. Use filenames directly (e.g. pd.read_csv('transactions.csv')).
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
- For ANY question about stock quotes, option chains, option Greeks, option expiration dates, or symbol lookup — ALWAYS use etrade_account (actions: quote, optionchains, optionexpiry, lookup) instead of web_search. These return real-time market data directly from E*TRADE. Only fall back to web_search if E*TRADE is not authenticated.
- EXISTING POSITIONS IV/Greeks: When the user asks about IV, Greeks, or details on options they ALREADY HOLD (e.g. "check my MU option's IV", "what's the delta on my calls"), do NOT fetch the full option chain or expiry list. Instead: (1) call "portfolio" with accountIdKey matching the account description (e.g. "IRA", "brokerage" — auto-resolved, no need to call "list" first) to see their exact positions (symbol, strike, expiry), (2) call "optionchains" with the EXACT expiryYear/expiryMonth/expiryDay and strikePriceNear matching the held position's strike, with noOfStrikes=3 to get a narrow slice. This returns IV and Greeks in just 2 rounds. NEVER call optionexpiry when the user already has positions — the expiry is in the portfolio data. NEVER call "list" just to look up an accountIdKey — pass the account description directly.
- General options analysis workflow (IV surface, term structure, "show all options"): (1) get current price with "quote" + available expirations with "optionexpiry" in parallel (ONE round), (2) immediately fetch "optionchains" — do NOT re-fetch quote or expiry dates you already have. For multi-expiry analysis, fetch up to 3 chains in parallel in ONE round. Use strikePriceNear + noOfStrikes to limit each chain to ~20 strikes near ATM — do NOT fetch full chains for multi-expiry analysis as the combined data will be too large. You have limited tool rounds — NEVER waste rounds repeating calls you already made. NEVER guess prices, expiration dates, or Greeks — always fetch real data first.
- CRITICAL: Only present strike prices, premiums, and Greeks that appear EXACTLY in the tool results. NEVER interpolate, extrapolate, or invent strikes between the ones returned. If the chain shows strikes at 420 and 430, do NOT fabricate a 425 strike. Present only real data rows from the tool output.
- OPTION CHAIN DISPLAY: When presenting option chain data, display ALL returned strikes in the table — do NOT cherry-pick or truncate. The user needs the complete picture to make trading decisions.
- OPTION CHAIN FETCHING: When the user asks for a specific delta range, covered calls, or any filtered view of options — fetch the FULL chain for that expiry (omit noOfStrikes, omit strikePriceNear). Do NOT crawl through multiple strikePriceNear values — that wastes rounds. For simple "show me the chain" requests, use strikePriceNear (current price) + noOfStrikes=25 to get ~25 strikes around ATM.
- RANKING/FILTERING option chains: When the user asks for "most popular", "highest volume", "top N by OI", or any ranking/filtering of options — you MUST fetch the FULL chain (do NOT use noOfStrikes to limit). You cannot determine "most popular" from a subset — you need all strikes to compare.
- When analyzing options positions from etrade_account, ALWAYS use the current date/time (provided above) to calculate days-to-expiry. Never estimate or guess expiration dates — compute them from the portfolio data. Verify your time-to-expiry math before reporting. Common covered call strategies use ~30-day income-generating calls, not imminent expirations — frame your analysis accordingly.`,
  tools: {
    etrade_account: {
      description: 'Retrieve E*TRADE brokerage and market data. Requires an "action" argument.\n\n**Account actions** (require "accountIdKey" — can be the encoded key from "list", a numeric accountId, OR a description like "IRA", "Rollover IRA", "brokerage" — auto-resolved):\n- "list": list accounts\n- "balance": account balance\n- "portfolio": positions/holdings\n- "transactions": transaction history (auto-paginates to fetch ALL matching transactions within the date range; **defaults to Jan 1 of current year** if no startDate given; use startDate/endDate in MMDDYYYY to query other periods; ALWAYS pass startDate explicitly when the user specifies a date range — never ask the user to confirm, just do it; maxPages to limit pagination — 0=unlimited which is the default)\n- "gains": unrealized gains with lot-level cost basis and short/long term\n- "orders": order history (optional status: OPEN/EXECUTED/CANCELLED/etc, fromDate/toDate in MMDDYYYY, count max 100)\n- "transaction_detail": single transaction detail (requires transactionId)\n\n**Market data actions** (no accountIdKey needed):\n- "quote": real-time quotes (requires "symbols" — comma-separated, up to 25; optional detailFlag: ALL/FUNDAMENTAL/INTRADAY/OPTIONS/WEEK_52)\n- "optionchains": option chains with full Greeks (Delta, Gamma, Theta, Vega, Rho, IV) and bid/ask/volume/OI (requires "symbol"; optional expiryYear/expiryMonth/expiryDay, strikePriceNear, noOfStrikes, chainType: CALL/PUT/CALLPUT, includeWeekly)\n- "optionexpiry": option expiration dates (requires "symbol")\n- "lookup": product/symbol lookup (requires "search" — company name or partial symbol)\n\n**User alerts:**\n- "alerts": account/stock alerts (optional count 1-300, category: STOCK/ACCOUNT, status: READ/UNREAD)\n- "alert_detail": single alert detail (requires alertId)\n\nTo export data for Python analysis, add "saveAs" with a filename (.csv/.md/.json) — saves to the source project directory. Usage guide: "gains" for open positions with cost basis; "transactions" for trade history; "orders" for order status/fills; "quote" for current prices; "optionchains" for available options with Greeks (Delta, Theta, IV, etc.).',
      parameters: { action: 'string', accountIdKey: 'string (optional)', startDate: 'string (optional)', endDate: 'string (optional)', count: 'number (optional)', maxPages: 'number (optional, transactions only — 0=unlimited, default 0)', saveAs: 'string (optional, filename to save in project dir)', symbols: 'string (optional)', symbol: 'string (optional)', detailFlag: 'string (optional)', expiryYear: 'string (optional)', expiryMonth: 'string (optional)', expiryDay: 'string (optional)', strikePriceNear: 'string (optional)', noOfStrikes: 'string (optional)', chainType: 'string (optional)', includeWeekly: 'boolean (optional)', search: 'string (optional)', status: 'string (optional)', fromDate: 'string (optional)', toDate: 'string (optional)', category: 'string (optional)', transactionId: 'string (optional)', alertId: 'string (optional)' },
      execute: async ({ action, accountIdKey, startDate, endDate, count, maxPages, saveAs, symbols, symbol, detailFlag, expiryYear, expiryMonth, expiryDay, strikePriceNear, noOfStrikes, chainType, includeWeekly, search, status, fromDate, toDate, category, transactionId, alertId }) => {
        const _logArgs = { action, accountIdKey, startDate, endDate, count, maxPages, saveAs, symbols, symbol, detailFlag, expiryYear, expiryMonth, expiryDay, strikePriceNear, noOfStrikes, chainType, includeWeekly, search, status, fromDate, toDate, category, transactionId, alertId };
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
          case 'quote':
            if (!symbols) return { error: 'symbols required (comma-separated, e.g. "AAPL,MSFT").' };
            result = await etrade.getQuotes(symbols, { detailFlag });
            break;
          case 'optionchains':
            if (!symbol) return { error: 'symbol required.' };
            result = await etrade.getOptionChains({ symbol, expiryYear, expiryMonth, expiryDay, strikePriceNear, noOfStrikes, chainType, includeWeekly });
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

        // Save to project directory if requested
        if (saveAs && result && !result.error && config.sourceDir) {
          let content;
          if (saveAs.endsWith('.json')) {
            content = JSON.stringify(result, null, 2);
          } else if (saveAs.endsWith('.md') && mdFormatters[action]) {
            content = mdFormatters[action](result);
          } else {
            content = formatters[action]?.(result) || JSON.stringify(result, null, 2);
          }
          if (content) {
            const safe = basename(saveAs).replace(/[^a-zA-Z0-9._-]/g, '_');
            const full = join(resolve(config.sourceDir), safe);
            await writeFile(full, content, 'utf-8');
            const out = { ...summarize(action, result), savedFile: { filename: safe, size: Buffer.byteLength(content, 'utf-8') } };
            await _log(result, out);
            return out;
          }
        }

        // Auto-save large results to project directory
        if (config.sourceDir) {
          const ROW_THRESHOLD = 30;
          const optionPairCount = result.OptionPair?.length || 0;
          const rowCount = result.Transaction?.length || result.AccountPortfolio?.[0]?.Position?.length || result.gains?.length || result.Order?.length || (optionPairCount * 2) || result.quotes?.length || result.Alert?.length || 0;
          if (rowCount > ROW_THRESHOLD && formatters[action]) {
            const autoFile = `${action}_${Date.now()}.csv`;
            const csvContent = formatters[action](result);
            if (csvContent) {
              const full = join(resolve(config.sourceDir), autoFile);
              await writeFile(full, csvContent, 'utf-8');
              const mdFmt = mdFormatters[action];
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
              const preview = mdFmt ? mdFmt(truncated) : null;
              const out = {
                ...summarize(action, result),
                savedFile: { filename: autoFile, size: Buffer.byteLength(csvContent, 'utf-8') },
                _autoSaved: true,
                _note: `${rowCount} rows — auto-saved to ${autoFile} in project directory. Preview shows first 15 rows. In run_python use: pd.read_csv('${autoFile}')`,
                ...(preview ? { _markdown: preview } : {}),
              };
              await _log(result, out);
              return out;
            }
          }
        }

        // Return pre-formatted markdown table + lightweight summary
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
  },
};
