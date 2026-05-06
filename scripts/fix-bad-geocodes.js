#!/usr/bin/env node
// One-shot fix for the 63 leads that the rescue pass landed in Alberta
// (49.000, -112.788) because Nominatim's postal-only fallback returns
// garbage for Canadian postal codes it doesn't index.
//
// Strategy:
//   1. Find all leads with lat/lng outside the GTA bounding box.
//   2. Reset their geocode_confidence to 'failed' and clear lat/lng.
//   3. Try in order, validating every result against the GTA bbox so a
//      bogus Nominatim hit can never write bad data again:
//        a. Cleaned address (strip unit/suite/# tokens).
//        b. Shop name + city + ON, Canada (Nominatim sometimes has the
//           business listed as an OSM node).
//        c. City + ON, Canada (city centroid; downgraded to 'area').
//   4. Anything that still fails after path c stays geocoded=NULL and
//      will be skipped by the route-optimize endpoint.
//
// Usage:
//   node scripts/fix-bad-geocodes.js
//   node scripts/fix-bad-geocodes.js --dry-run

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { geocodeAddress } from './lib/geocode-nominatim.js';

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
  'NOMINATIM_USER_AGENT',
]);

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY || !process.env.NOMINATIM_USER_AGENT) {
  console.error('Missing required env vars.');
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

// Generous GTA box: Burlington in the west, Oshawa in the east, Niagara
// in the south, Newmarket in the north. A real GTA tire shop will not
// land outside this.
const GTA_BBOX = { latMin: 43.0, latMax: 44.7, lngMin: -80.6, lngMax: -78.4 };
function inGta(lat, lng) {
  return (
    lat >= GTA_BBOX.latMin &&
    lat <= GTA_BBOX.latMax &&
    lng >= GTA_BBOX.lngMin &&
    lng <= GTA_BBOX.lngMax
  );
}

// Address cleaning (mirrors rescue-geocode-failed.js)
function stripLeadingUnit(addr) {
  return addr.replace(
    /^\s*(unit|suite|ste|bldg|building)\s*#?\s*[\w-]+\s*,\s*/i,
    ''
  );
}
function stripInlineUnit(addr) {
  let cleaned = addr.replace(/\s+#\s*[\w-]+(?=,|\s|$)/g, '');
  cleaned = cleaned.replace(
    /\s+(unit|suite|ste|bldg|building)\s*#?\s*[\w-]+/gi,
    ''
  );
  return cleaned;
}
function cleanAddress(addr) {
  const a = stripLeadingUnit(addr);
  const b = stripInlineUnit(a);
  return b.replace(/,\s*,/g, ',').replace(/\s+/g, ' ').trim();
}

const SB_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchOutOfBox() {
  // PostgREST 'or' for the box-edge filter.
  const params = new URLSearchParams();
  params.set('select', 'id,shop_name,city,province,address,latitude,longitude,geocode_confidence');
  params.append('latitude', 'not.is.null');
  params.append(
    'or',
    `(latitude.lt.${GTA_BBOX.latMin},latitude.gt.${GTA_BBOX.latMax},longitude.lt.${GTA_BBOX.lngMin},longitude.gt.${GTA_BBOX.lngMax})`
  );
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

const RATE_LIMIT_MS = 1100;
let lastCall = 0;
async function paced(fn) {
  const wait = lastCall + RATE_LIMIT_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

// Try a single Nominatim query; reject the result if it lands outside GTA.
async function tryQuery(query) {
  const r = await paced(() => geocodeAddress(query));
  if (r.confidence === 'failed') return null;
  if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return null;
  if (!inGta(r.lat, r.lng)) return null;
  return r;
}

const leads = await fetchOutOfBox();
console.log(`Found ${leads.length} leads with lat/lng outside the GTA bbox.`);
if (leads.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}
const eta = Math.ceil((leads.length * 3 * RATE_LIMIT_MS) / 1000 / 60);
console.log(`Est. runtime: up to ~${eta} min (3 queries per lead worst case).`);
if (DRY_RUN) console.log('--dry-run: not writing.');

const stats = { clean: 0, shop_name: 0, city: 0, still_failed: 0, errors: 0 };
let processed = 0;

for (const lead of leads) {
  processed++;
  const label = `${(lead.shop_name ?? lead.id).slice(0, 35)} (${lead.city ?? ''})`;
  try {
    let result = null;
    let path = null;

    // Path A: cleaned address.
    const cleaned = cleanAddress(lead.address);
    if (cleaned) {
      const r = await tryQuery(cleaned);
      if (r) {
        result = r;
        path = 'clean';
      }
    }

    // Path B: business name + city.
    if (!result && lead.shop_name && lead.city) {
      const province = lead.province || 'ON';
      const q = `${lead.shop_name}, ${lead.city}, ${province}, Canada`;
      const r = await tryQuery(q);
      if (r) {
        result = r;
        path = 'shop_name';
      }
    }

    // Path C: city centroid (downgrade confidence to 'area').
    if (!result && lead.city) {
      const province = lead.province || 'ON';
      const q = `${lead.city}, ${province}, Canada`;
      const r = await tryQuery(q);
      if (r) {
        result = { ...r, confidence: 'area' };
        path = 'city';
      }
    }

    if (!result) {
      stats.still_failed++;
      console.log(`  [${processed}/${leads.length}] ${label} -> still failed; clearing lat/lng`);
      if (!DRY_RUN) {
        await patchLead(lead.id, {
          latitude: null,
          longitude: null,
          geocode_confidence: 'failed',
          geocoded_at: new Date().toISOString(),
        });
      }
      continue;
    }

    stats[path]++;
    console.log(
      `  [${processed}/${leads.length}] ${label} -> ${path}/${result.confidence} ${result.lat.toFixed(5)},${result.lng.toFixed(5)}`
    );

    if (DRY_RUN) continue;

    await patchLead(lead.id, {
      latitude: result.lat,
      longitude: result.lng,
      geocode_confidence: result.confidence,
      geocoded_at: new Date().toISOString(),
    });
  } catch (err) {
    stats.errors++;
    console.error(`  [${processed}/${leads.length}] ${label} -> ERROR ${err.message}`);
  }
}

console.log('\nDone.');
console.log(
  `  clean: ${stats.clean}  |  shop_name: ${stats.shop_name}  |  city: ${stats.city}  |  still failed: ${stats.still_failed}  |  errors: ${stats.errors}`
);
