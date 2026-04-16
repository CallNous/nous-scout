// Google Places API (New) wrapper.
// Uses the v1 REST endpoints directly — no SDK dependency needed.
//
// - Text Search with includedType filter for cleaner results
// - Field masking so we only pay for what we fetch
// - Caches everything in the JSON cache so reruns cost nothing
//
// Docs: https://developers.google.com/maps/documentation/places/web-service/op-overview

import 'dotenv/config';
import { request } from 'undici';
import pRetry from 'p-retry';
import { cache } from './cache.js';
import { createLimiter } from './lib/rateLimit.js';
import { isFranchise, loadConfig } from './lib/franchises.js';
import { log } from './lib/logger.js';

const BASE = 'https://places.googleapis.com/v1';
const limit = createLimiter(100); // 100ms between Places calls

function apiKey() {
  const k = process.env.GOOGLE_PLACES_API_KEY;
  if (!k) throw new Error('GOOGLE_PLACES_API_KEY not set in .env');
  return k;
}

// Field mask for Text Search — lightweight, just enough for dedup + franchise filter
const SEARCH_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.types',
].join(',');

// Field mask for Place Details — the full set we need for scoring
const DETAIL_FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'websiteUri',
  'rating',
  'userRatingCount',
  'regularOpeningHours',
  'currentOpeningHours',
  'reviews',
  'googleMapsUri',
  'businessStatus',
  'types',
].join(',');

async function placesPost(pathname, body, fieldMask) {
  await limit();
  const res = await request(`${BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey(),
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
  });
  const data = await res.body.json();
  if (res.statusCode >= 400) {
    const msg = data?.error?.message || JSON.stringify(data).slice(0, 300);
    throw new Error(`Places ${pathname} HTTP ${res.statusCode}: ${msg}`);
  }
  return data;
}

async function placesGet(pathname, fieldMask) {
  await limit();
  const res = await request(`${BASE}${pathname}`, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': apiKey(),
      'X-Goog-FieldMask': fieldMask,
    },
  });
  const data = await res.body.json();
  if (res.statusCode >= 400) {
    const msg = data?.error?.message || JSON.stringify(data).slice(0, 300);
    throw new Error(`Places ${pathname} HTTP ${res.statusCode}: ${msg}`);
  }
  return data;
}

async function textSearch(query, location) {
  const cacheKey = `new::${query}::${location}`;
  const hit = cache.getSearch(cacheKey);
  if (hit) return hit;

  const body = {
    textQuery: `${query} ${location}`,
    // languageCode: 'en', // omit — let Google decide based on region
  };

  const data = await pRetry(
    () => placesPost('/places:searchText', body, SEARCH_FIELDS),
    { retries: 3, minTimeout: 500 }
  );
  const results = data.places || [];
  cache.putSearch(cacheKey, results);
  return results;
}

async function getPlaceDetails(placeId) {
  const hit = cache.getDetails(placeId);
  if (hit) return hit;

  // placeId from Text Search comes as "places/ChIJ…" — Details wants "/places/ChIJ…"
  const resourceName = placeId.startsWith('places/') ? `/${placeId}` : `/places/${placeId}`;

  const data = await pRetry(
    () => placesGet(resourceName, DETAIL_FIELDS),
    { retries: 3, minTimeout: 500 }
  );
  cache.putDetails(placeId, data);
  return data;
}

// Normalize the "id" field — New API returns resource name "places/ChIJ…"
// or just the raw ID depending on the endpoint. We store the raw ID.
function rawId(place) {
  const id = place.id || '';
  return id.replace(/^places\//, '');
}

function displayName(place) {
  // displayName can be { text: "...", languageCode: "en" } or just a string
  if (!place.displayName) return '';
  return typeof place.displayName === 'string'
    ? place.displayName
    : place.displayName.text || '';
}

// Normalize reviews from New API shape to what analyzer.js expects
function normalizeReviews(reviews) {
  if (!Array.isArray(reviews)) return [];
  return reviews.map((r) => ({
    rating: r.rating ?? null,
    author_name: r.authorAttribution?.displayName || 'Anonymous',
    text: r.text?.text || r.originalText?.text || '',
    time: r.publishTime || '',
    // Detect owner replies — useful for the "engaged owner" signal
    author_is_owner: r.authorAttribution?.isCurrentUser === true,
  }));
}

export async function findShops({ city, province, max }) {
  const cfg = loadConfig();
  const queries = cfg.searchQueries || ['tire shop'];
  const location = `${city} ${province}`;
  log.info(`Searching Places (New API) for ${queries.length} queries in ${location}…`);

  const resultGroups = await Promise.all(queries.map((q) => textSearch(q, location)));

  // Merge + dedupe by place id
  const merged = new Map();
  for (const group of resultGroups) {
    for (const r of group) {
      const id = rawId(r);
      if (id && !merged.has(id)) merged.set(id, r);
    }
  }
  log.info(`${merged.size} unique places found across all queries`);

  // Filter franchises + closed businesses
  const independents = [];
  for (const r of merged.values()) {
    const name = displayName(r);
    if (isFranchise(name)) continue;
    if (r.businessStatus && r.businessStatus !== 'OPERATIONAL') continue;
    independents.push(r);
  }
  log.info(`${independents.length} independents after franchise filter`);

  const capped = independents.slice(0, max);
  log.info(`Fetching details for top ${capped.length}`);

  const detailed = [];
  for (let i = 0; i < capped.length; i++) {
    const r = capped[i];
    const id = rawId(r);
    const name = displayName(r);
    try {
      const d = await getPlaceDetails(id);
      const dName = displayName(d);
      detailed.push({
        place_id: rawId(d) || id,
        name: dName || name,
        address: d.formattedAddress || r.formattedAddress || '',
        phone: d.nationalPhoneNumber || d.internationalPhoneNumber || '',
        website: d.websiteUri || '',
        rating: d.rating ?? r.rating ?? null,
        review_count: d.userRatingCount ?? r.userRatingCount ?? 0,
        opening_hours: d.regularOpeningHours || d.currentOpeningHours || null,
        reviews: normalizeReviews(d.reviews),
        google_url: d.googleMapsUri || '',
        types: d.types || [],
      });
      log.step(i + 1, capped.length, `details: ${dName || name}`);
    } catch (err) {
      log.warn(`details failed for ${name}: ${err.message}`);
    }
  }
  return detailed;
}

// --selftest: quick verification against real API
async function selftest() {
  const shops = await findShops({ city: 'Toronto', province: 'ON', max: 5 });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(shops.slice(0, 3), null, 2));
  cache.close();
}

if (process.argv.includes('--selftest')) {
  selftest().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
