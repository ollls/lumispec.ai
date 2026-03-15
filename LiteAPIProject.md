# LiteAPI Integration Plan

## Overview
**LiteAPI** (liteapi.travel) — Hotel/travel API for building travel assistant tools in LLM Workbench.

- **Base URL:** `https://api.liteapi.travel/v3.0`
- **Book URL:** `https://book.liteapi.travel/v3.0`
- **Auth:** `X-API-Key` header
- **SDK:** `liteapi-node-sdk` (npm)
- **Docs:** https://docs.liteapi.travel/reference/api-endpoints-overview
- **Sandbox key format:** `sand_c0155ab8-...`

---

## All Available Endpoints

### 1. Hotel Data (Static)
| Method | Path | Description | Key Params |
|--------|------|-------------|------------|
| GET | `/data/hotels` | Search hotels | `countryCode`, `cityName`, `hotelName`, `latitude`/`longitude`/`radius`, `placeId`, `aiSearch`, `zip`, `minRating`, `minReviewsCount`, `facilityIds`, `hotelTypeIds`, `chainIds`, `starRating`, `language`, `hotelIds`, `limit`, `offset` |
| GET | `/data/hotel` | Hotel details | `hotelId` (required), `language`, `timeout` |
| GET | `/data/reviews` | Hotel reviews | `hotelId` (required), `language` |
| GET | `/data/places` | Search places/areas | text query, type, language |
| GET | `/data/places/{placeId}` | Get specific place | placeId |
| GET | `/data/cities` | Cities in a country | countryCode |
| GET | `/data/countries` | All countries | — |
| GET | `/data/currencies` | All currencies | — |
| GET | `/data/iataCodes` | IATA airport codes | — |
| GET | `/data/facilities` | Hotel facility types | — |
| GET | `/data/hotelTypes` | Hotel types | — |
| GET | `/data/chains` | Hotel chains | — |
| GET | `/data/languages` | Supported languages | — |
| GET | `/data/weather` | Weather data | location params |

### 2. AI/Beta Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/data/hotels/semantic-search` | Natural language hotel search |
| GET | `/data/hotels/room-search` | Search rooms by image + text |
| GET | `/data/hotel/ask` | Q&A about a specific hotel |

### 3. Search (Availability & Rates)
| Method | Path | Description | Key Params |
|--------|------|-------------|------------|
| POST | `/hotels/rates` | Hotel rates/availability | `checkin`, `checkout`, `currency`, `guestNationality`, `occupancies` (all required); location via `hotelIds`, `countryCode`+`cityName`, `lat`/`lng`/`radius`, `iataCode`, `placeId`, or `aiSearch`; filters: `minRating`, `starRating`, `boardType`, `refundableRatesOnly`, `facilities`, `roomAmenities`, `bedTypes` |
| POST | `/hotels/min-rates` | Minimum rate per hotel | Same search criteria, returns only lowest rate per hotel |

### 4. Booking
| Method | Path | Description | Key Params |
|--------|------|-------------|------------|
| POST | `/rates/prebook` | Create prebook session | `rateId`, `voucherCode`, `usePaymentSdk` |
| GET | `/prebooks/{prebookId}` | Get prebook details | prebookId |
| POST | `/rates/book` | Complete booking | `prebookId`, `holder` (name, email, phone), `guests[]`, `payment`, `clientReference` |
| GET | `/bookings` | List all bookings | — |
| GET | `/bookings/{bookingId}` | Booking details | bookingId |
| PUT | `/bookings/{bookingId}` | Cancel booking | bookingId |
| PUT | `/bookings/{bookingId}/amend` | Amend guest name | bookingId, new guest details |
| POST | `/bookings/{bookingId}/alternative-prebooks` | Amend dates/occupancies | bookingId, new dates/occupancies |

### 5. Vouchers
| Method | Path | Description |
|--------|------|-------------|
| POST | `/vouchers` | Create voucher |
| GET | `/vouchers` | List vouchers |
| GET | `/vouchers/{id}` | Get voucher |
| PUT | `/vouchers/{id}` | Update voucher |
| PUT | `/vouchers/{id}/status` | Update status |
| GET | `/vouchers/history` | Usage history |
| DELETE | `/vouchers/{id}` | Delete voucher |

### 6. Loyalty
| Method | Path | Description |
|--------|------|-------------|
| GET | `/loyalties` | Loyalty program settings |
| PUT | `/loyalties` | Update loyalty program |
| GET | `/guests` | All guests |
| GET | `/guests/{guestId}` | Specific guest |
| GET | `/guests/{guestId}/bookings` | Guest bookings |
| GET | `/guests/{guestId}/vouchers` | Guest vouchers |
| GET | `/guests/{guestId}/loyalty-points` | Guest loyalty points |
| POST | `/guests/{guestId}/loyalty-points/redeem` | Redeem points |

### 7. Analytics
| Method | Path | Description |
|--------|------|-------------|
| POST | `/analytics/weekly` | Weekly analytics |
| POST | `/analytics/report` | Detailed report |
| POST | `/analytics/markets` | Market analytics |
| POST | `/analytics/hotels` | Most booked hotels |
| POST | `/commissions/report` | Commission earnings |
| GET | `/bookings/guest-nationality-report` | Guest nationality report |
| GET | `/bookings/source-markets-report` | Destinations report |
| GET | `/bookings/hotels-sales-report` | Properties sales report |
| POST | `/bookings/search` | Search bookings by text |

### 8. Price Index
| Method | Path | Description |
|--------|------|-------------|
| GET | `/price-index/city` | City-level price index |
| GET | `/price-index/hotels` | Hotel-level price index |

---

## Proposed Tool Commands (for src/services/tools.js)

### Phase 1 — Core Discovery (implement first)
1. **`hotel_search`** — Find hotels by location/name, supports `aiSearch` for natural language
2. **`hotel_details`** — Full property info (photos, amenities, rooms, policies)
3. **`hotel_rates`** — Real-time pricing & availability for dates/occupancy
4. **`hotel_reviews`** — Guest reviews & sentiment
5. **`weather`** — Destination weather

### Phase 2 — Booking Flow
6. **`hotel_prebook`** — Lock a rate (returns prebookId)
7. **`hotel_book`** — Complete reservation with guest/payment info
8. **`booking_list`** — List all bookings
9. **`booking_details`** — Get specific booking info
10. **`booking_cancel`** — Cancel a booking

### Phase 3 — Reference & Extras
11. **`search_places`** — Destination/area lookup
12. **`list_countries`** / **`list_cities`** — Reference data
13. **`iata_codes`** — Airport code lookup
14. **`price_index`** — City-level pricing benchmarks
15. **`semantic_search`** — NLP hotel discovery (beta)
16. **`ask_hotel`** — Q&A about a property (beta)

---

## Booking Flow
```
search rates (POST /hotels/rates)
  → pick a rateId
  → prebook (POST /rates/prebook) → prebookId
  → book (POST /rates/book) with prebookId + guest info + payment
```

## Environment Variable Needed
- `LITEAPI_KEY` — LiteAPI API key (sandbox or production)
