#!/usr/bin/env node
// Backfill opening_hours for scout_leads that don't have hours data yet.
// For each lead: Google Places Text Search by "shop_name city province" with
// includedType='tire_shop', match display name, fetch Place Details for
// regularOpeningHours, PATCH to Supabase.
//
// Usage:
//   node scripts/backfill-opening-hours.js                # all eligible rows
//   node scripts/backfill-opening-hours.js --city Toronto # filter by city
//   node scripts/backfill-opening-hours.js --limit 10     # cap rows touched
//   node scripts/backfill-opening-hours.js --dry-run      # plan, do not write
//
// Env vars (auto-loaded from nous-scout/.env + nous-web/.env.local):
//   GOOGLE_PLACES_API_KEY      required
//   NEXT_PUBLIC_SUPABASE_URL   required
//   SUPABASE_SERVICE_ROLE_KEY  required

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'undici';

// ---- Env loading
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
  console.error('GOOGLE_PLACES_API_KEY not set in .env');
  process.exit(1);
}

// ---- CLI args
const args = process.argv.slice(2);
function flag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}
const CITY = flag('--city');
const LIMIT = flag('--limit') ? parseInt(flag('--limit'), 10) : null;
const DRY_RUN = args.includes('--dry-run');

// ---- Supabase REST helpers
const SB_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchEligibleLeads() {
  const params = new URLSearchParams();
  params.set('select', 'id,shop_name,city,province');
  params.append('opening_hours', 'is.null');
  if (CITY) params.append('city', `eq.${CITY}`);
  params.append('order', 'nous_score.desc.nullslast');
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
  if (!res.ok) throw new Error(`Supabase PATCH ${res.status}: ${await res.text()}`);
}

// ---- Google Places helpers
const BASE = 'https://places.googleapis.com/v1';
const RATE_MS = 120;
let lastCall = 0;

async function paced(fn) {
  const wait = lastCall + RATE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

async function textSearch(query) {
  const res = await request(`${BASE}/places:searchText`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName',
    },
    body: JSON.stringify({ textQuery: query, includedType: 'tire_shop' }),
  });
  const data = await res.body.json();
  if (res.statusCode >= 400) {
    throw new Error(`Places search ${res.statusCode}: ${data?.error?.message || ''}`);
  }
  return data.places || [];
}

async function getPlaceDetails(placeId) {
  const resourceName = placeId.startsWith('places/') ? `/${placeId}` : `/places/${placeId}`;
  const res = await request(`${BASE}${resourceName}`, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': 'id,displayName,regularOpeningHours',
    },
  });
  const data = await res.body.json();
  if (res.statusCode >= 400) {
    throw new Error(`Places details ${res.statusCode}: ${data?.error?.message || ''}`);
  }
  return data;
}

function displayName(place) {
  if (!place.displayName) return '';
  return typeof place.displayName === 'string'
    ? place.displayName
    : place.displayName.text || '';
}

function nameMatch(a, b) {
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  return na.includes(nb) || nb.includes(na);
}

// ---- Main
async function main() {
  const leads = await fetchEligibleLeads();
  console.log(`${leads.length} leads without opening_hours${CITY ? ` in ${CITY}` : ''}.`);
  if (leads.length === 0) return;

  let updated = 0;
  let noMatch = 0;
  let noHours = 0;
  let errors = 0;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const query = `${lead.shop_name} ${lead.city} ${lead.province}`;
    try {
      const results = await paced(() => textSearch(query));
      const match = results.find((r) => nameMatch(displayName(r), lead.shop_name));
      if (!match) {
        noMatch++;
        console.log(`  [${i + 1}/${leads.length}] ${lead.shop_name} -- no match`);
        continue;
      }

      const rawId = (match.id || '').replace(/^places\//, '');
      const details = await paced(() => getPlaceDetails(rawId));
      const hours = details.regularOpeningHours || null;
      if (!hours) {
        noHours++;
        console.log(`  [${i + 1}/${leads.length}] ${lead.shop_name} -- matched but no hours`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [${i + 1}/${leads.length}] ${lead.shop_name} -- would write ${hours.weekdayDescriptions?.length || 0} day(s)`);
      } else {
        await patchLead(lead.id, { opening_hours: hours });
        console.log(`  [${i + 1}/${leads.length}] ${lead.shop_name} -- ${hours.weekdayDescriptions?.length || 0} day(s) saved`);
      }
      updated++;
    } catch (err) {
      errors++;
      console.error(`  [${i + 1}/${leads.length}] ${lead.shop_name} -- ERROR: ${err.message}`);
    }
  }

  console.log(`\nDone. updated=${updated} noMatch=${noMatch} noHours=${noHours} errors=${errors}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
