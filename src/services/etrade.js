import { OAuth } from 'oauth';
import config from '../config.js';

const BASE = config.etrade.sandbox
  ? 'https://apisb.etrade.com'
  : 'https://api.etrade.com';

const AUTH_BASE = config.etrade.sandbox
  ? 'https://apisb.etrade.com'
  : 'https://api.etrade.com';

const AUTHORIZE_URL = 'https://us.etrade.com/e/t/etws/authorize';

// OAuth 1.0a client
const oauth = new OAuth(
  `${AUTH_BASE}/oauth/request_token`,
  `${AUTH_BASE}/oauth/access_token`,
  config.etrade.consumerKey,
  config.etrade.consumerSecret,
  '1.0',
  'oob', // out-of-band callback (user copies verifier manually)
  'HMAC-SHA1'
);

// Session state
let requestToken = null;
let requestTokenSecret = null;
let accessToken = null;
let accessTokenSecret = null;
let cachedAccounts = null; // cache from listAccounts for accountId → accountIdKey lookup

function isAuthenticated() {
  return !!(accessToken && accessTokenSecret);
}

function disconnect() {
  accessToken = null;
  accessTokenSecret = null;
  requestToken = null;
  requestTokenSecret = null;
  cachedAccounts = null;
}

function getAuthorizeUrl(callbackUrl) {
  return new Promise((resolve, reject) => {
    oauth.getOAuthRequestToken((err, token, tokenSecret) => {
      if (err) return reject(new Error(`Request token failed: ${JSON.stringify(err)}`));
      requestToken = token;
      requestTokenSecret = tokenSecret;
      const url = `${AUTHORIZE_URL}?key=${config.etrade.consumerKey}&token=${token}`;
      resolve(url);
    });
  });
}

function handleCallback(verifier) {
  return new Promise((resolve, reject) => {
    oauth.getOAuthAccessToken(
      requestToken,
      requestTokenSecret,
      verifier,
      (err, token, tokenSecret) => {
        if (err) return reject(new Error(`Access token failed: ${JSON.stringify(err)}`));
        accessToken = token;
        accessTokenSecret = tokenSecret;
        resolve({ success: true });
      }
    );
  });
}

function apiGet(path, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}${path}`;
    const timer = setTimeout(() => reject(new Error('E*TRADE API request timed out')), timeoutMs);
    oauth.get(url, accessToken, accessTokenSecret, (err, data, response) => {
      clearTimeout(timer);
      if (err) return reject(new Error(`API error: ${err.statusCode} ${err.data || ''}`));
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error(`Invalid JSON response: ${String(data).slice(0, 200)}`));
      }
    });
  });
}

async function listAccounts() {
  const data = await apiGet('/v1/accounts/list.json');
  const accounts = data.AccountListResponse?.Accounts?.Account || [];
  cachedAccounts = accounts;
  return { accounts, totalCount: accounts.length };
}

// Resolve accountIdKey: if a numeric accountId is passed, look up the real accountIdKey
function resolveAccountIdKey(value) {
  if (!value) return null;
  // If it looks like a numeric accountId (all digits), try to find the encoded accountIdKey
  if (/^\d+$/.test(value) && cachedAccounts) {
    const match = cachedAccounts.find(a => String(a.accountId) === value || String(a.accountIdKey) === value);
    if (match && match.accountIdKey !== value) {
      console.log(`[etrade] Resolved numeric accountId ${value} → accountIdKey ${match.accountIdKey}`);
      return match.accountIdKey;
    }
  }
  return value;
}

async function getBalance(accountIdKey, instType = 'BROKERAGE') {
  accountIdKey = resolveAccountIdKey(accountIdKey) || accountIdKey;
  const data = await apiGet(`/v1/accounts/${accountIdKey}/balance.json?instType=${instType}&realTimeNAV=true`);
  return data.BalanceResponse || data;
}

async function getPortfolio(accountIdKey) {
  accountIdKey = resolveAccountIdKey(accountIdKey) || accountIdKey;
  const data = await apiGet(`/v1/accounts/${accountIdKey}/portfolio.json?view=COMPLETE&totalsRequired=true`);
  const result = data.PortfolioResponse || data;
  const positions = result?.AccountPortfolio?.[0]?.Position || [];
  result.totalPositions = Array.isArray(positions) ? positions.length : 0;
  return result;
}

async function getGains(accountIdKey) {
  accountIdKey = resolveAccountIdKey(accountIdKey) || accountIdKey;
  const data = await apiGet(`/v1/accounts/${accountIdKey}/portfolio.json?view=COMPLETE&totalsRequired=true&lotsRequired=true`);
  const result = data.PortfolioResponse || data;
  const positions = result?.AccountPortfolio?.[0]?.Position || [];

  // Flatten: one row per lot (or per position if no lots)
  const gains = [];
  for (const pos of positions) {
    const p = pos.Product || pos.product || {};
    const lots = pos.positionLot || pos.PositionLot || [];
    if (lots.length > 0) {
      for (const lot of lots) {
        gains.push({
          symbol: p.symbol,
          securityType: p.securityType,
          callPut: p.callPut,
          strikePrice: p.strikePrice,
          description: pos.symbolDescription,
          dateAcquired: lot.acquiredDate,
          quantity: lot.remainingQty ?? pos.quantity,
          costPerShare: lot.price,
          totalCost: lot.totalCost,
          marketValue: lot.marketValue,
          gain: lot.totalGain,
          gainPct: lot.totalGainPct,
          term: lot.termCode === 1 ? 'Long' : lot.termCode === 0 ? 'Short' : 'Unknown',
        });
      }
    } else {
      gains.push({
        symbol: p.symbol,
        securityType: p.securityType,
        callPut: p.callPut,
        strikePrice: p.strikePrice,
        description: pos.symbolDescription,
        dateAcquired: pos.dateAcquired,
        quantity: pos.quantity,
        costPerShare: pos.pricePaid,
        totalCost: pos.totalCost,
        marketValue: pos.marketValue,
        gain: pos.totalGain,
        gainPct: pos.totalGainPct,
        term: 'Unknown',
      });
    }
  }

  const totals = result?.Totals || result?.totals || {};
  return { gains, totalGain: totals.totalGainLoss, totalGainPct: totals.totalGainLossPct, totalCount: gains.length };
}

// Normalize date to MMDDYYYY format expected by E*TRADE
function normalizeDate(str) {
  if (!str) return null;
  // Already MMDDYYYY (8 digits, no separators)
  if (/^\d{8}$/.test(str)) return str;
  // Try parsing common formats: YYYY-MM-DD, MM/DD/YYYY, MM-DD-YYYY, etc.
  const d = new Date(str);
  if (!isNaN(d)) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${mm}${dd}${yyyy}`;
  }
  return str; // pass through as-is, let E*TRADE reject if invalid
}

// ── Market Data endpoints ────────────────────────────

async function getQuotes(symbols, { detailFlag = 'ALL', requireEarningsDate = true } = {}) {
  if (!symbols || !symbols.length) throw new Error('At least one symbol is required');
  const syms = Array.isArray(symbols) ? symbols : symbols.split(',').map(s => s.trim());
  const params = new URLSearchParams({ detailFlag });
  if (requireEarningsDate) params.set('requireEarningsDate', 'true');
  if (syms.length > 25) params.set('overrideSymbolCount', 'true');
  const data = await apiGet(`/v1/market/quote/${syms.join(',')}.json?${params}`);
  const quotes = data.QuoteResponse?.QuoteData || [];
  return { quotes, totalCount: quotes.length };
}

async function getOptionChains({ symbol, expiryYear, expiryMonth, expiryDay, strikePriceNear, noOfStrikes, includeWeekly, skipAdjusted = true, chainType = 'CALLPUT', optionCategory = 'STANDARD', priceType = 'ATNM' } = {}) {
  if (!symbol) throw new Error('symbol is required');
  const params = new URLSearchParams({ symbol, chainType, optionCategory, priceType });
  if (expiryYear) params.set('expiryYear', expiryYear);
  if (expiryMonth) params.set('expiryMonth', expiryMonth);
  if (expiryDay) params.set('expiryDay', expiryDay);
  if (strikePriceNear) params.set('strikePriceNear', strikePriceNear);
  if (noOfStrikes) params.set('noOfStrikes', noOfStrikes);
  if (includeWeekly) params.set('includeWeekly', 'true');
  if (skipAdjusted) params.set('skipAdjusted', 'true');
  const data = await apiGet(`/v1/market/optionchains.json?${params}`);
  const result = data.OptionChainResponse || data;
  return result;
}

async function getOptionExpireDates(symbol, expiryType) {
  if (!symbol) throw new Error('symbol is required');
  const params = new URLSearchParams({ symbol });
  if (expiryType) params.set('expiryType', expiryType);
  const data = await apiGet(`/v1/market/optionexpiredate.json?${params}`);
  const dates = data.OptionExpireDateResponse?.ExpirationDate || [];
  return { expirationDates: dates, totalCount: dates.length };
}

async function lookupProduct(search) {
  if (!search) throw new Error('search term is required');
  const data = await apiGet(`/v1/market/lookup/${encodeURIComponent(search)}.json`);
  const products = data.LookupResponse?.Data || [];
  return { products, totalCount: products.length };
}

// ── Account Activity endpoints ───────────────────────

async function getOrders(accountIdKey, { status, fromDate, toDate, marker, count = 100 } = {}) {
  accountIdKey = resolveAccountIdKey(accountIdKey) || accountIdKey;
  const params = new URLSearchParams();
  if (count) params.set('count', count);
  if (status) params.set('status', status);
  if (fromDate) params.set('fromDate', normalizeDate(fromDate));
  if (toDate) params.set('toDate', normalizeDate(toDate));
  if (marker) params.set('marker', marker);
  const qs = params.toString();
  const data = await apiGet(`/v1/accounts/${accountIdKey}/orders.json${qs ? '?' + qs : ''}`);
  const result = data.OrdersResponse || data;
  const orders = result?.Order || [];
  result.totalCount = Array.isArray(orders) ? orders.length : 0;
  return result;
}

async function getAlerts({ count = 25, category, status, direction, search } = {}) {
  const params = new URLSearchParams();
  if (count) params.set('count', count);
  if (category) params.set('category', category);
  if (status) params.set('status', status);
  if (direction) params.set('direction', direction);
  if (search) params.set('search', search);
  const qs = params.toString();
  const data = await apiGet(`/v1/user/alerts.json${qs ? '?' + qs : ''}`);
  const result = data.AlertsResponse || data;
  const alerts = result?.Alert || [];
  result.totalCount = Array.isArray(alerts) ? alerts.length : 0;
  return result;
}

async function getAlertDetails(alertId) {
  if (!alertId) throw new Error('alertId is required');
  const data = await apiGet(`/v1/user/alerts/${alertId}.json`);
  return data.AlertDetailsResponse || data;
}

async function getTransactionDetail(accountIdKey, transactionId) {
  accountIdKey = resolveAccountIdKey(accountIdKey) || accountIdKey;
  if (!transactionId) throw new Error('transactionId is required');
  const data = await apiGet(`/v1/accounts/${accountIdKey}/transactions/${transactionId}.json`);
  return data.TransactionDetailsResponse || data;
}

async function getTransactions(accountIdKey, { count = 50, startDate, endDate } = {}) {
  accountIdKey = resolveAccountIdKey(accountIdKey) || accountIdKey;
  // Default to last 30 days if no start date provided
  if (!startDate) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    startDate = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${d.getFullYear()}`;
  }
  let url = `/v1/accounts/${accountIdKey}/transactions.json?count=${count}`;
  const sd = normalizeDate(startDate);
  const ed = normalizeDate(endDate);
  if (sd) url += `&startDate=${sd}`;
  if (ed) url += `&endDate=${ed}`;
  try {
    const data = await apiGet(url, 180000);
    const result = data.TransactionListResponse || data;
    const txns = result?.Transaction || result?.transaction || [];
    result.totalCount = Array.isArray(txns) ? txns.length : 0;
    return result;
  } catch (err) {
    console.error(`[etrade] transactions error:`, err.message);
    throw err;
  }
}

export default {
  isAuthenticated,
  disconnect,
  getAuthorizeUrl,
  handleCallback,
  listAccounts,
  getBalance,
  getPortfolio,
  getGains,
  getTransactions,
  getQuotes,
  getOptionChains,
  getOptionExpireDates,
  lookupProduct,
  getOrders,
  getAlerts,
  getAlertDetails,
  getTransactionDetail,
};
