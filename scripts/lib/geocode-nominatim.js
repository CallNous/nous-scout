// Single-function wrapper around Nominatim, OpenStreetMap's public geocoder.
// Used by scripts/backfill-geocodes.js and scripts/import-html-to-supabase.js
// (when the import script gains a geocoding step). Same contract on both
// sides so the source can swap to Google Places Details, via the existing
// scout_leads.place_id column, without changing call sites.
//
// Requires NOMINATIM_USER_AGENT env var. Public Nominatim blocks UA-less
// traffic per https://operations.osmfoundation.org/policies/nominatim/
//
// IMPORTANT: callers must enforce the 1 req/sec public rate limit. This
// helper does not sleep on its own.

import { request } from 'undici';

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/**
 * Geocode a single address via Nominatim.
 *
 * @param {string} address Free-form address; Nominatim parses it.
 * @returns {Promise<{
 *   lat: number | null,
 *   lng: number | null,
 *   confidence: 'house_number' | 'street' | 'area' | 'failed',
 *   raw?: object,
 * }>}
 */
export async function geocodeAddress(address) {
  const ua = process.env.NOMINATIM_USER_AGENT;
  if (!ua) {
    throw new Error(
      'NOMINATIM_USER_AGENT env var is required by the Nominatim usage policy.'
    );
  }
  if (!address || typeof address !== 'string' || address.trim().length === 0) {
    return { lat: null, lng: null, confidence: 'failed' };
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', address);
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'ca');
  url.searchParams.set('addressdetails', '1');

  const { statusCode, body } = await request(url.toString(), {
    method: 'GET',
    headers: {
      'User-Agent': ua,
      'Accept-Language': 'en',
    },
  });

  if (statusCode === 429 || statusCode === 503) {
    throw new Error(`Nominatim rate-limited (HTTP ${statusCode}). Slow down.`);
  }
  if (statusCode !== 200) {
    const text = await body.text();
    throw new Error(`Nominatim HTTP ${statusCode}: ${text.slice(0, 200)}`);
  }

  const results = await body.json();
  if (!Array.isArray(results) || results.length === 0) {
    return { lat: null, lng: null, confidence: 'failed' };
  }

  const top = results[0];
  const lat = parseFloat(top.lat);
  const lng = parseFloat(top.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { lat: null, lng: null, confidence: 'failed' };
  }

  let confidence;
  if (top.address && top.address.house_number) {
    confidence = 'house_number';
  } else if (
    Number.isFinite(top.place_rank) &&
    top.place_rank >= 26 &&
    top.place_rank <= 30
  ) {
    confidence = 'street';
  } else {
    confidence = 'area';
  }

  return { lat, lng, confidence, raw: top };
}
