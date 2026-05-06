#!/usr/bin/env node
// Geocode backfill for scout_leads. Reads every row where latitude IS NULL,
// hits Nominatim once per row, writes lat / lng / confidence / geocoded_at
// back. Idempotent (only touches rows missing lat). Sequential, paced at
// ~1.1 s between calls because the public Nominatim instance enforces a
// strict 1 req/sec policy.
//
// Required only for one-time backfills of pre-existing scout_leads rows
// (HTML imports, etc.). New rows added via scripts/import-html-to-supabase.js
// pick up geocodes inline once that script wires in the same helper.
//
// Usage:
//   node scripts/backfill-geocodes.js                # all eligible rows
//   node scripts/backfill-geocodes.js --city Toronto # filter by city
//   node scripts/backfill-geocodes.js --tier HOT     # filter by tier
//   node scripts/backfill-geocodes.js --limit 20     # cap rows touched
//   node scripts/backfill-geocodes.js --dry-run      # plan, do not write
//   node scripts/backfill-geocodes.js --retry-failed # also retry confidence='failed'
//
// Env vars (auto-loaded from nous-web/.env.local + nous-scout/.env if missing):
//   NOMINATIM_USER_AGENT      required (e.g. 'Scout/1.0 (your@email.com)')
//   NEXT_PUBLIC_SUPABASE_URL  required
//   SUPABASE_SERVICE_ROLE_KEY required

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { geocodeAddress } from './lib/geocode-nominatim.js';

// ---- Env loading: scout's own .env first (handled by dotenv/config above),
// then fall back to nous-web/.env.local for Supabase + Nominatim UA.
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
const UA = process.env.NOMINATIM_USER_AGENT;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    'Missing Supabase env vars. Add NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to nous-web/.env.local.'
  );
  process.exit(1);
}
if (!UA) {
  console.error(
    "NOMINATIM_USER_AGENT not set. Add it to nous-web/.env.local, e.g. 'Scout/1.0 (you@example.com)'."
  );
  process.exit(1);
}

// ---- CLI args
const args = process.argv.slice(2);
function flag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}
const TIER = flag('--tier');
const CITY = flag('--city');
const LIMIT = flag('--limit') ? parseInt(flag('--limit'), 10) : null;
const DRY_RUN = args.includes('--dry-run');
const RETRY_FAILED = args.includes('--retry-failed');

// ---- Supabase REST helpers (no SDK needed; mirrors backfill-apollo-owners.js)
const SB_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchEligibleLeads() {
  const params = new URLSearchParams();
  params.set('select', 'id,shop_name,city,province,priority_tier,address,geocode_confidence');
  params.append('address', 'not.is.null');
  if (RETRY_FAILED) {
    // Either lat IS NULL, or (lat IS NULL OR confidence='failed') so we re-try
    // any row that previously failed.
    params.append(
      'or',
      '(latitude.is.null,geocode_confidence.eq.failed)'
    );
  } else {
    params.append('latitude', 'is.null');
  }
  if (TIER) params.append('priority_tier', `eq.${TIER}`);
  if (CITY) params.append('city', `eq.${CITY}`);
  // Highest-value rows first so a partial run still moves the needle.
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

// ---- Pacing: 1 req/sec public Nominatim limit. Use 1100 ms to stay safely
// under, since clock skew + connection setup can push us right against 1000.
const RATE_LIMIT_MS = 1100;
let lastCall = 0;
async function paced(fn) {
  const wait = lastCall + RATE_LIMIT_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

// ---- Main
const leads = await fetchEligibleLeads();
console.log(
  `Found ${leads.length} leads to geocode (latitude IS NULL${RETRY_FAILED ? ' OR confidence=failed' : ''}` +
    `${TIER ? `, tier=${TIER}` : ''}${CITY ? `, city=${CITY}` : ''}${LIMIT ? `, limit=${LIMIT}` : ''}).`
);

if (leads.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

const eta = Math.ceil((leads.length * RATE_LIMIT_MS) / 1000 / 60);
console.log(`Est. runtime: ~${eta} min at 1 req/sec.`);
if (DRY_RUN) {
  console.log('--dry-run: not writing.');
}

const stats = { house_number: 0, street: 0, area: 0, failed: 0, errors: 0 };
let processed = 0;

for (const lead of leads) {
  processed++;
  const label = `${lead.shop_name} (${lead.city})`;
  try {
    const result = await paced(() => geocodeAddress(lead.address));
    stats[result.confidence] = (stats[result.confidence] ?? 0) + 1;

    const summary =
      result.confidence === 'failed'
        ? 'FAIL no result'
        : `${result.confidence} ${result.lat?.toFixed(5)},${result.lng?.toFixed(5)}`;
    console.log(`  [${processed}/${leads.length}] ${label} -> ${summary}`);

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
  `  rooftop / house: ${stats.house_number}  |  street: ${stats.street}  |  area: ${stats.area}  |  failed: ${stats.failed}  |  errors: ${stats.errors}`
);
