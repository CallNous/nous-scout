#!/usr/bin/env node
// Geocode backfill using Google Places geometry.
// For leads with a place_id, fetches the exact lat/lng from Google Places
// Details API. This is the ground truth for business pin locations on
// Google Maps — more precise than Nominatim address geocoding.
//
// Usage:
//   node scripts/geocode-from-places.js                 # all eligible rows
//   node scripts/geocode-from-places.js --city Toronto  # filter by city
//   node scripts/geocode-from-places.js --limit 50      # cap rows
//   node scripts/geocode-from-places.js --dry-run       # preview only
//   node scripts/geocode-from-places.js --force          # re-geocode even if already geocoded
//
// Env vars (auto-loaded from nous-web/.env.local + nous-scout/.env):
//   GOOGLE_PLACES_API_KEY       required
//   NEXT_PUBLIC_SUPABASE_URL    required
//   SUPABASE_SERVICE_ROLE_KEY   required

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

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
  console.error('GOOGLE_PLACES_API_KEY not set.');
  process.exit(1);
}

const args = process.argv.slice(2);
function flag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}
const CITY = flag('--city');
const LIMIT = flag('--limit') ? parseInt(flag('--limit'), 10) : null;
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

const SB_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchEligibleLeads() {
  const params = new URLSearchParams();
  params.set('select', 'id,shop_name,city,place_id,geocode_confidence,latitude,longitude');
  params.append('place_id', 'not.is.null');
  if (!FORCE) {
    params.append('geocode_confidence', 'neq.place_details');
  }
  if (CITY) params.append('city', `eq.${CITY}`);
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

async function fetchPlaceLocation(placeId) {
  const resourceName = placeId.startsWith('places/') ? placeId : `places/${placeId}`;
  const url = `https://places.googleapis.com/v1/${resourceName}`;
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': 'location',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Places ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.location ?? null;
}

// 100ms pacing (well within Google's QPS limits)
const PACE_MS = 100;
let lastCall = 0;
async function paced(fn) {
  const wait = lastCall + PACE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

const leads = await fetchEligibleLeads();
console.log(
  `Found ${leads.length} leads with place_id to geocode via Google Places` +
  `${CITY ? ` (city=${CITY})` : ''}${LIMIT ? ` (limit=${LIMIT})` : ''}.`
);

if (leads.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

const cost = (leads.length * 0.005).toFixed(2);
console.log(`Est. API cost: ~$${cost} (${leads.length} x $0.005 Basic SKU).`);
if (DRY_RUN) console.log('--dry-run: not writing.');

const stats = { updated: 0, skipped: 0, failed: 0 };
let processed = 0;

for (const lead of leads) {
  processed++;
  const label = `${lead.shop_name} (${lead.city})`;
  try {
    const loc = await paced(() => fetchPlaceLocation(lead.place_id));
    if (!loc || loc.latitude == null || loc.longitude == null) {
      stats.skipped++;
      console.log(`  [${processed}/${leads.length}] ${label} -> no location returned`);
      continue;
    }

    const prevLat = lead.latitude;
    const prevLng = lead.longitude;
    const delta = prevLat != null
      ? Math.sqrt((loc.latitude - prevLat) ** 2 + (loc.longitude - prevLng) ** 2) * 111_000
      : null;
    const deltaStr = delta != null ? ` (delta: ${Math.round(delta)}m)` : '';

    console.log(
      `  [${processed}/${leads.length}] ${label} -> ${loc.latitude.toFixed(6)},${loc.longitude.toFixed(6)}${deltaStr}`
    );

    if (DRY_RUN) { stats.updated++; continue; }

    await patchLead(lead.id, {
      latitude: loc.latitude,
      longitude: loc.longitude,
      geocode_confidence: 'place_details',
      geocoded_at: new Date().toISOString(),
    });
    stats.updated++;
  } catch (err) {
    stats.failed++;
    console.error(`  [${processed}/${leads.length}] ${label} -> ERROR ${err.message}`);
  }
}

console.log(`\nDone. updated: ${stats.updated}  |  skipped: ${stats.skipped}  |  failed: ${stats.failed}`);
