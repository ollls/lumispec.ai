import config from '../config.js';

const DATA_BASE = 'https://api.liteapi.travel/v3.0';
const BOOK_BASE = 'https://book.liteapi.travel/v3.0';

function headers() {
  return {
    'X-API-Key': config.liteapi.apiKey,
    'Accept': 'application/json',
  };
}

export function isConfigured() {
  return !!config.liteapi.apiKey;
}

async function apiGet(base, path, params = {}) {
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: headers(),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LiteAPI ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function apiPost(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LiteAPI ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function apiPut(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LiteAPI ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Hotel Data (Static) ────────────────────────────

export async function searchHotels(params) {
  return apiGet(DATA_BASE, '/data/hotels', params);
}

export async function getHotelDetails(hotelId, params = {}) {
  return apiGet(DATA_BASE, '/data/hotel', { hotelId, ...params });
}

export async function getHotelReviews(hotelId) {
  return apiGet(DATA_BASE, '/data/reviews', { hotelId });
}

export async function getWeather(params) {
  return apiGet(DATA_BASE, '/data/weather', params);
}

// ── AI/Beta ────────────────────────────────────────

export async function semanticSearch(query, params = {}) {
  return apiGet(DATA_BASE, '/data/hotels/semantic-search', { query, ...params });
}

export async function askHotel(hotelId, question) {
  return apiGet(DATA_BASE, '/data/hotel/ask', { hotelId, question });
}

// ── Reference Data ─────────────────────────────────

export async function searchPlaces(textQuery, params = {}) {
  return apiGet(DATA_BASE, '/data/places', { textQuery, ...params });
}

export async function getPlaceDetails(placeId) {
  return apiGet(DATA_BASE, `/data/places/${encodeURIComponent(placeId)}`);
}

export async function listCountries() {
  return apiGet(DATA_BASE, '/data/countries');
}

export async function listCities(countryCode) {
  return apiGet(DATA_BASE, '/data/cities', { countryCode });
}

export async function getIataCodes() {
  return apiGet(DATA_BASE, '/data/iataCodes');
}

export async function getPriceIndex(params) {
  return apiGet(DATA_BASE, '/price-index/city', params);
}

// ── Rates & Availability ───────────────────────────

export async function getHotelRates(body) {
  return apiPost(BOOK_BASE, '/hotels/rates', body);
}

export async function getMinRates(body) {
  return apiPost(BOOK_BASE, '/hotels/min-rates', body);
}

// ── Booking (with cooldown to avoid rate-limit "fraud check" rejections) ──

const bookingCooldown = { lastCall: 0, minGapMs: 3000 };

async function withCooldown(fn) {
  const now = Date.now();
  const elapsed = now - bookingCooldown.lastCall;
  if (elapsed < bookingCooldown.minGapMs) {
    await new Promise(r => setTimeout(r, bookingCooldown.minGapMs - elapsed));
  }
  bookingCooldown.lastCall = Date.now();
  return fn();
}

export async function prebook(offerId, params = {}) {
  return withCooldown(() => apiPost(BOOK_BASE, '/rates/prebook', { offerId, ...params }));
}

export async function book(body) {
  return withCooldown(() => apiPost(BOOK_BASE, '/rates/book', body));
}

export async function listBookings() {
  return apiGet(BOOK_BASE, '/bookings');
}

export async function getBooking(bookingId) {
  return apiGet(BOOK_BASE, `/bookings/${encodeURIComponent(bookingId)}`);
}

export async function cancelBooking(bookingId) {
  return apiPut(BOOK_BASE, `/bookings/${encodeURIComponent(bookingId)}`);
}

export default {
  isConfigured,
  searchHotels,
  getHotelDetails,
  getHotelReviews,
  getWeather,
  semanticSearch,
  askHotel,
  searchPlaces,
  getPlaceDetails,
  listCountries,
  listCities,
  getIataCodes,
  getPriceIndex,
  getHotelRates,
  getMinRates,
  prebook,
  book,
  listBookings,
  getBooking,
  cancelBooking,
};
