# LiteAPI Travel Integration

## Overview
Hotel and travel tools powered by [LiteAPI](https://liteapi.travel) integrated into LLM Workbench as three action-based tools: `hotel`, `travel`, and `booking`.

- **API Docs:** https://docs.liteapi.travel/reference/api-endpoints-overview
- **Data Base URL:** `https://api.liteapi.travel/v3.0`
- **Booking Base URL:** `https://book.liteapi.travel/v3.0`
- **Auth:** `X-API-Key` header
- **Sandbox key format:** `sand_c0155ab8-...`

---

## Setup

1. Get an API key from https://www.liteapi.travel
2. Add to `.env`:
   ```
   LITEAPI_KEY=sand_your-key-here
   ```
3. Restart the server — the three tools (`hotel`, `travel`, `booking`) auto-register when the key is present.

**Config path:** `config.liteapi.apiKey` in `src/config.js`

---

## Architecture

### Files
| File | Role |
|------|------|
| `src/services/liteapi.js` | Pure HTTP client — apiGet/apiPost/apiPut helpers, 19 exported functions, 30s timeouts |
| `src/services/tools.js` | Tool registration — 3 tools (`hotel`, `travel`, `booking`) with action-based routing |
| `src/routes/conversations.js` | `_images` stripping — removes image URLs from LLM context, replaces with `imageCount` |
| `src/config.js` | Config — reads `LITEAPI_KEY` env var |

### Tool Consolidation
Instead of 16 separate tools, endpoints are grouped into 3 action-based tools (same pattern as `etrade_account`):
- **`hotel`** — 6 actions: search, details, rates, reviews, semantic_search, ask
- **`travel`** — 6 actions: weather, places, countries, cities, iata_codes, price_index
- **`booking`** — 5 actions: prebook, book, list, details, cancel

### Image Handling
- Tool results include an `_images` array with all image URLs (thumbnails, hotel photos, room photos)
- Frontend `extractImageUrls()` auto-renders up to 12 clickable thumbnails below the tool result
- `conversations.js` strips `_images` from the LLM context and replaces with `imageCount: N` to save tokens
- The LLM never sees image URLs — only the browser does

---

## Tool Reference

### `hotel` — Hotel search, details, rates, reviews

#### Actions

**search** — Find hotels by location or natural language
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| countryCode | string | no | 2-letter country code |
| cityName | string | no | City name |
| hotelName | string | no | Hotel name filter |
| aiSearch | string | no | Natural language query (e.g. "beachfront resort in Bali") |
| latitude | number | no | Latitude for geo search |
| longitude | number | no | Longitude for geo search |
| radius | number | no | Radius in km (with lat/lng) |
| placeId | string | no | LiteAPI place ID |
| limit | number | no | Results per page (default 5) |
| offset | number | no | Pagination offset |
| minRating | number | no | Minimum guest rating |
| starRating | number | no | Star rating filter |
| minReviewsCount | number | no | Minimum review count |

Returns: `{ hotels: [...], totalCount, _images }` — each hotel has hotelId, name, starRating, rating, reviewCount, city, country, address, thumbnail.

**details** — Full hotel info with photos, amenities, rooms, policies
| Param | Type | Required |
|-------|------|----------|
| hotelId | string | yes |

Returns: hotel info + `_images` array (thumbnail, hotelImages, room photos).

**rates** — Real-time pricing and availability
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| checkin | string | yes | YYYY-MM-DD |
| checkout | string | yes | YYYY-MM-DD |
| occupancies | array | no | Default `[{"adults":2}]`. Example with children: `[{"adults":2,"children":[5,8]}]` |
| guestNationality | string | no | 2-letter code (default "US") |
| currency | string | no | Currency code (default "USD") |
| hotelIds | array | conditional | Array of hotel IDs |
| countryCode + cityName | string | conditional | Location by city |
| latitude + longitude | number | conditional | Location by coordinates |

Returns: `{ hotels: [{ hotelId, name, rooms: [{ roomName, boardType, rateId, price, cancellation }] }], currency }`

**reviews** — Guest reviews
| Param | Type | Required |
|-------|------|----------|
| hotelId | string | yes |

**semantic_search** — Natural language hotel discovery (beta)
| Param | Type | Required |
|-------|------|----------|
| query | string | yes |

Returns: hotel list with `_images`.

**ask** — Q&A about a specific hotel (beta)
| Param | Type | Required |
|-------|------|----------|
| hotelId | string | yes |
| question | string | yes |

---

### `travel` — Reference data and weather

#### Actions

**weather** — Destination weather forecast
| Param | Type | Required |
|-------|------|----------|
| cityName | string | conditional |
| countryCode | string | conditional |
| latitude | number | conditional |
| longitude | number | conditional |

**places** — Search for destinations/areas
| Param | Type | Required |
|-------|------|----------|
| query | string | yes |
| type | string | no |
| language | string | no |

**countries** — List all countries (no params)

**cities** — List cities in a country
| Param | Type | Required |
|-------|------|----------|
| countryCode | string | yes |

**iata_codes** — List IATA airport codes (no params)

**price_index** — City-level hotel price index
| Param | Type | Required |
|-------|------|----------|
| cityName | string | no |
| countryCode | string | no |
| checkin | string | no |
| checkout | string | no |

---

### `booking` — Hotel booking operations

#### Booking Flow
```
hotel rates (get rateId)
  → booking prebook (rateId → prebookId)
  → booking book (prebookId + guest info + payment → confirmation)
```
Rate IDs are ephemeral — prebook promptly after getting rates.

#### Actions

**prebook** — Lock a rate before booking
| Param | Type | Required |
|-------|------|----------|
| rateId | string | yes |

Returns: prebookId + price confirmation.

**book** — Complete reservation
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| prebookId | string | yes | From prebook result |
| holder | object | yes | `{firstName, lastName, email, phone}` |
| guests | array | no | `[{firstName, lastName}]` |
| payment | object | no | Payment details |
| clientReference | string | no | Your reference ID |

**list** — List all bookings (no params)

**details** — Get booking info
| Param | Type | Required |
|-------|------|----------|
| bookingId | string | yes |

**cancel** — Cancel a booking
| Param | Type | Required |
|-------|------|----------|
| bookingId | string | yes |

---

## API Client (`src/services/liteapi.js`)

### Internal Helpers
- `apiGet(base, path, params)` — GET with query params, `X-API-Key` header, 30s timeout
- `apiPost(base, path, body)` — POST with JSON body
- `apiPut(base, path, body)` — PUT with optional JSON body
- `isConfigured()` — returns `!!config.liteapi.apiKey`

### Exported Functions
| Function | API Endpoint | HTTP |
|----------|-------------|------|
| `searchHotels(params)` | `/data/hotels` | GET |
| `getHotelDetails(hotelId, params)` | `/data/hotel` | GET |
| `getHotelReviews(hotelId)` | `/data/reviews` | GET |
| `getWeather(params)` | `/data/weather` | GET |
| `semanticSearch(query, params)` | `/data/hotels/semantic-search` | GET |
| `askHotel(hotelId, question)` | `/data/hotel/ask` | GET |
| `searchPlaces(query, params)` | `/data/places` | GET |
| `listCountries()` | `/data/countries` | GET |
| `listCities(countryCode)` | `/data/cities` | GET |
| `getIataCodes()` | `/data/iataCodes` | GET |
| `getPriceIndex(params)` | `/price-index/city` | GET |
| `getHotelRates(body)` | `/hotels/rates` | POST |
| `getMinRates(body)` | `/hotels/min-rates` | POST |
| `prebook(rateId, params)` | `/rates/prebook` | POST |
| `book(body)` | `/rates/book` | POST |
| `listBookings()` | `/bookings` | GET |
| `getBooking(bookingId)` | `/bookings/{id}` | GET |
| `cancelBooking(bookingId)` | `/bookings/{id}` | PUT |

---

## LLM Context Optimization

In `src/routes/conversations.js`, after sending the full tool result to the frontend via SSE, image URLs are stripped before sending to the LLM:

```javascript
if (parsed._images) {
  const { _images, ...rest } = parsed;
  rest.imageCount = Array.isArray(_images) ? _images.length : 0;
  llmResult = JSON.stringify(rest);
}
```

This means:
- **Frontend** receives full result with `_images` array → renders thumbnails
- **LLM** receives compact result with `imageCount: 12` → no wasted context on URLs

---

## System Prompt Additions

Added to `getSystemPrompt()` in `src/services/tools.js`:
- Hotel images are auto-displayed — LLM should NOT output markdown image syntax
- Summarize hotels by name, star rating, location, price range, key amenities
- Booking flow reminder: rates → prebook → book
- Rate IDs are ephemeral — prebook promptly
- Occupancies format example: `[{"adults": 2, "children": [5, 8]}]`
- Prefer `aiSearch` for natural language queries

---

## Not Yet Implemented

These LiteAPI endpoints exist but are not wired up as tools:

| Category | Endpoints |
|----------|-----------|
| Vouchers | CRUD for vouchers, status updates, usage history |
| Loyalty | Program settings, guest management, points redemption |
| Analytics | Weekly/market/hotel analytics, commission reports |
| Hotel-level price index | `/price-index/hotels` |
| Room search by image | `/data/hotels/room-search` |
| Booking amendments | `/bookings/{id}/amend`, `/bookings/{id}/alternative-prebooks` |
| Reference data | `/data/currencies`, `/data/facilities`, `/data/hotelTypes`, `/data/chains`, `/data/languages` |

These can be added to the existing tools as new actions if needed.
