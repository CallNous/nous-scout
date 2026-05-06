#!/usr/bin/env node
// Upgrade leads stuck at 'area' (city-centroid) confidence to rooftop
// accuracy by querying Google Places Text Search. Nominatim couldn't find
// these specific addresses, but Google has them as business listings.
//
// Strategy per row:
//   POST /v1/places:searchText with "<shop_name> <city> <province>"
//   First result -> place.location.{latitude,longitude} -> confidence
//     downgraded to 'house_number'.
//   Validate against the GTA bounding box; reject any result outside.
//   Also persist place_id if not already set, for future use.
//
// Cost: ~$32/1k for Text Search (New). 75 queries ~= $2.40, comfortably
// inside Google's $200/mo Maps Platform credit. Effectively free.
//
// Usage:
//   node scripts/upgrade-area-geocodes.js
//   node scripts/upgrade-area-geocodes.js --limit 5
//   node scripts/upgrade-area-geocodes.js --dry-run
//
// Env: GOOGLE_PLACES_API_KEY (in nous-scout/.env or nous-web/.env.local)
//      NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'undici';

function loadFromFileIfMissing(p, keys) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!keys.includes(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
loadFromFileIfMissing(path.resolve('../nous-web/.env.local'), [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GOOGLE_PLACES_API_KEY',
]);

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing Supabase env vars.');
  process.exit(1);
}
if (!PLACES_KEY) {
  console.error(
    'GOOGLE_PLACES_API_KEY not set. Provision one at\n' +
      '  https://console.cloud.google.com/  -> Enable "Places API (New)" -> Credentials\n' +
      'and add to nous-web/.env.local as GOOGLE_PLACES_API_KEY=AIza...'
  );
  process.exit(1);
}

const args = process.argv.slice(2);
function flag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}
const LIMIT = flag('--limit') ? parseInt(flag('--limit'), 10) : null;
const DRY_RUN = args.includes('--dry-run');

const GTA_BBOX = { latMin: 43.0, latMax: 44.7, lngMin: -80.6, lngMax: -78.4 };
function inGta(lat, lng) {
  return (
    lat >= GTA_BBOX.latMin &&
    lat <= GTA_BBOX.latMax &&
    lng >= GTA_BBOX.lngMin &&
    lng <= GTA_BBOX.lngMax
  );
}

const SB_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchAreaLeads() {
  const params = new URLSearchParams();
  params.set(
    'select',
    'id,shop_name,city,province,address,place_id,latitude,longitude,geocode_confidence'
  );
  params.append('geocode_confidence', 'eq.area');
  params.append('order', 'priority_tier.asc,nous_score.desc.nullslast');
  if (LIMIT) params.append('limit', String(LIMIT));
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/scout_leads?${params}`;
  const res = await fetch(url, { headers: SB_HEADERS });
  if (!res.ok) throw new Error(`Supabase fetch ${res.status}: ${await res.text()}`);
  return res.json();
}

async function patchLead(id, patch) {
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/scout_leads?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase patch ${res.status}: ${await res.text()}`);
}

const FIELD_MASK = [
  'places.id',
  'places.location',
  'places.formattedAddress',
  'places.displayName',
].join(',');

async function placesTextSearch(textQuery) {
  const res = await request('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery,
      regionCode: 'CA',
      maxResultCount: 1,
    }),
  });
  const data = await res.body.json();
  if (res.statusCode >= 400) {
    throw new Error(
      `Places ${res.statusCode}: ${JSON.stringify(data).slice(0, 200)}`
    );
  }
  return data;
}

// ~100 ms between calls; well under any Google Places quota.
const RATE_LIMIT_MS = 120;
let lastCall = 0;
async function paced(fn) {
  const wait = lastCall + RATE_LIMIT_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

const leads = await fetchAreaLeads();
console.log(`Found ${leads.length} leads at 'area' confidence to upgrade.`);
if (leads.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}
if (DRY_RUN) console.log('--dry-run: not writing.');

const stats = { upgraded: 0, out_of_box: 0, no_result: 0, errors: 0 };
let processed = 0;

for (const lead of leads) {
  processed++;
  const label = `${(lead.shop_name ?? lead.id).slice(0, 35)} (${lead.city ?? ''})`;
  try {
    const province = lead.province || 'ON';
    const textQuery = `${lead.shop_name}, ${lead.city}, ${province}`;
    const data = await paced(() => placesTextSearch(textQuery));
    const place = data.places?.[0];
    if (!place || !place.location) {
      stats.no_result++;
      console.log(`  [${processed}/${leads.length}] ${label} -> no result`);
      continue;
    }
    const lat = place.location.latitude;
    const lng = place.location.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inGta(lat, lng)) {
      stats.out_of_box++;
      console.log(
        `  [${processed}/${leads.length}] ${label} -> rejected ${lat},${lng} (out of GTA)`
      );
      continue;
    }
    stats.upgraded++;
    console.log(
      `  [${processed}/${leads.length}] ${label} -> ${lat.toFixed(5)},${lng.toFixed(5)}` +
        ` (${(place.formattedAddress ?? '').slice(0, 50)})`
    );
    if (DRY_RUN) continue;

    const patch = {
      latitude: lat,
      longitude: lng,
      geocode_confidence: 'house_number',
      geocoded_at: new Date().toISOString(),
    };
    if (!lead.place_id && place.id) patch.place_id = place.id;
    await patchLead(lead.id, patch);
  } catch (err) {
    stats.errors++;
    console.error(`  [${processed}/${leads.length}] ${label} -> ERROR ${err.message}`);
  }
}

console.log('\nDone.');
console.log(
  `  upgraded: ${stats.upgraded}  |  no result: ${stats.no_result}  |  out of box: ${stats.out_of_box}  |  errors: ${stats.errors}`
);
