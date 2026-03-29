import { mkdir, writeFile, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import config from '../config.js';
import liteapi from '../services/liteapi.js';

import { fileURLToPath } from 'url';
const __dirname = import.meta.dirname || (() => { const f = fileURLToPath(import.meta.url); return f.substring(0, f.lastIndexOf('/')); })();
const DATA_DIR = resolve(__dirname, '../../data');

// Cache: rate_N → offerId (so booking prebook can resolve rate refs from hotel rates results)
let lastRateMap = {};
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

export default {
  group: 'travel',
  routing: [
    '- Hotels, travel, trips, vacations, accommodation, resorts → use "hotel" tool (search, details, rates, reviews)',
    '- Weather forecasts, destination info, places, airports, cities → use "travel" tool',
    '- Hotel reservations, booking, cancellation → use "booking" tool',
  ],
  prompt: `## Hotel & Travel Tools
- Hotel images are auto-displayed by the UI as thumbnails — do NOT output markdown image syntax (no ![](url)).
- Summarize hotels by: name, star rating, location, price range, key amenities. The user can see the photos automatically.
- Booking flow (MUST follow these steps in order):
  Step 1: hotel rates → pick rate_N
  Step 2: booking prebook with rateId → returns prebookId + savedGuestProfile + price
  Step 3: STOP. Show the user a confirmation summary: hotel name, room, dates, price, cancellation policy, guest name/email from savedGuestProfile. Ask "Shall I confirm this booking?" and WAIT for user response.
  Step 4: ONLY after user explicitly confirms → call booking book (holder auto-filled from saved profile, or pass new holder if user provides different info)
  NEVER skip Step 3. NEVER call booking book in the same tool round as prebook.
- EXCEPTION to proactive rule — booking "book" action: ALWAYS stop and confirm with the user BEFORE calling booking book. Show them: hotel name, dates, room type, price, guest name. Wait for explicit "yes" / "book it" / "confirm". This spends real money — never auto-book.
- Rate references (rate_0, rate_1, etc.) map to actual offerIds internally — just pass the reference string to the booking prebook action. prebookId is auto-cached from the last prebook.
- Rate IDs are ephemeral — prebook promptly after getting rates, do not delay.
- occupancies format example: [{"adults": 2}] or [{"adults": 2, "children": [5, 8]}]
- For hotel search, prefer aiSearch for natural language queries (e.g. "beachfront resort in Bali").
- When searching rates for a SPECIFIC hotel, use hotelIds (e.g. ["lp29df3"]) — NOT countryCode+cityName, which returns all hotels in the city and is much slower.
- Booking errors: "fraud check" (code 2013) in sandbox mode is usually rate limiting — too many book calls in quick succession. Wait a moment and retry. In production mode, fraud rejections are real and should be reported to the user. "invalid offerId" or "no prebook availability" means the rate expired — search rates again. "invalid prebookId" means the prebook expired — prebook again with a fresh rate.`,
  tools: {
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
            const hotelImgs = new Set();
            const roomImgs = new Set();
            if (hotel.thumbnail) hotelImgs.add(hotel.thumbnail);
            if (hotel.hotelImages) hotel.hotelImages.forEach(img => { if (img.url) hotelImgs.add(img.url); });
            if (hotel.rooms) hotel.rooms.forEach(room => {
              if (room.photos) room.photos.forEach(p => {
                if (p.url && !hotelImgs.has(p.url)) roomImgs.add(p.url);
              });
            });
            const hotelSlice = [...hotelImgs].slice(0, 6);
            const roomSlice = [...roomImgs].slice(0, 12 - hotelSlice.length);
            const _images = [...hotelSlice, ...roomSlice];
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
            const maxHotels = hotelIds ? allHotels.length : 10;
            const maxRoomsPerHotel = hotelIds?.length === 1 ? 10 : 3;
            const _rateMap = {};
            let rateIdx = 0;
            const hotels = allHotels.slice(0, maxHotels).map(h => {
              const rooms = (h.roomTypes || []).flatMap(rt =>
                (rt.rates || []).map(r => ({
                  roomName: r.name,
                  boardName: r.boardName || r.boardType,
                  offerId: rt.offerId,
                  maxOccupancy: r.maxOccupancy,
                  price: r.retailRate?.total?.[0] || null,
                  cancellation: r.cancellationPolicies?.refundableTag || 'unknown',
                }))
              );
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
                  const ref = `rate_${rateIdx++}`;
                  _rateMap[ref] = r.offerId;
                  return { roomName: r.roomName, boardName: r.boardName, rateId: ref, maxOccupancy: r.maxOccupancy, price: r.price, cancellation: r.cancellation };
                }),
              };
            });
            lastRateMap = _rateMap;
            return { hotels, totalHotels: allHotels.length, currency, checkin, checkout, _rateMap };
          }

          case 'reviews': {
            if (!params.hotelId) return { error: 'hotelId required for "reviews" action' };
            const data = await liteapi.getHotelReviews(params.hotelId);
            const all = data?.data || (Array.isArray(data) ? data : []);
            const total = all.length;
            const reviews = all.slice(0, 10).map(r => ({
              score: r.averageScore, name: r.name, date: r.date?.split('T')[0],
              type: r.type, headline: r.headline || undefined,
              pros: r.pros || undefined, cons: r.cons || undefined,
            }));
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
            const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
            if (params.startDate.slice(0, 10) < tomorrow) params.startDate = tomorrow;
            if (params.endDate.slice(0, 10) < tomorrow) params.endDate = tomorrow;
            let { latitude, longitude } = params;
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
            const offerId = lastRateMap[params.rateId] || params.rateId;
            if (offerId === params.rateId && params.rateId.startsWith('rate_')) {
              return { error: `Could not resolve "${params.rateId}" — rate references expire. Please search rates again first.` };
            }
            const data = await liteapi.prebook(offerId);
            const pb = data?.data || data || {};
            lastPrebookId = pb.prebookId || null;
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
            const prebookId = params.prebookId || lastPrebookId;
            if (!prebookId) return { error: 'prebookId required — run prebook first to lock a rate' };
            let holder = params.holder ? (typeof params.holder === 'string' ? JSON.parse(params.holder) : params.holder) : null;
            if (!holder) {
              const saved = await loadGuestProfile();
              if (saved) holder = saved;
              else return { error: 'No guest profile saved. Provide holder ({firstName, lastName, email, phone})' };
            }
            if (!holder.firstName || !holder.lastName || !holder.email) return { error: 'holder must have firstName, lastName, and email' };
            let guests = typeof params.guests === 'string' ? JSON.parse(params.guests) : params.guests;
            if (!guests || !guests.length) {
              guests = [{ occupancyNumber: 1, firstName: holder.firstName, lastName: holder.lastName, email: holder.email, phone: holder.phone || '' }];
            }
            const payment = params.payment ? (typeof params.payment === 'string' ? JSON.parse(params.payment) : params.payment) : { method: 'ACC_CREDIT_CARD' };
            const body = { prebookId, holder, guests, payment };
            if (params.clientReference) body.clientReference = params.clientReference;
            const data = await liteapi.book(body);
            const booking = data?.data || data || {};
            if (booking.status === 'CONFIRMED') {
              await saveGuestProfile({ firstName: holder.firstName, lastName: holder.lastName, email: holder.email, phone: holder.phone || '' });
            }
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
  },
};
