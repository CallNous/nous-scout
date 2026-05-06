#!/usr/bin/env node
// Rescue pass for scout_leads rows where the first geocode attempt failed.
// The first run via Nominatim chokes on addresses with unit/suite/# tokens
// like "200 Mulock Dr #11, Newmarket, ON L3Y 9B6". Strategy:
//
//   1. Strip unit/suite/# patterns from the address and retry.
//   2. If still no result, fall back to the Canadian postal code only,
//      which gives a street-level coordinate (~50-300 m from the door,
//      good enough for routing; the driver navigates the last block by
//      eye using the full address shown on the lead card).
//
// Idempotent: only touches rows where geocode_confidence='failed'. Re-runs
// are safe; rows already rescued (any non-failed confidence) are skipped.
//
// Usage:
//   node scripts/rescue-geocode-failed.js
//   node scripts/rescue-geocode-failed.js --limit 20
//   node scripts/rescue-geocode-failed.js --dry-run
//
// Env vars: same as backfill-geocodes.js (NEXT_PUBLIC_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, NOMINATIM_USER_AGENT).

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
const UA = process.env.NOMINATIM_USER_AGENT;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing Supabase env vars.');
  process.exit(1);
}
if (!UA) {
  console.error('Missing NOMINATIM_USER_AGENT.');
  process.exit(1);
}

// CLI args
const args = process.argv.slice(2);
function flag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}
const LIMIT = flag('--limit') ? parseInt(flag('--limit'), 10) : null;
const DRY_RUN = args.includes('--dry-run');

// ---- Address-cleaning helpers
//
// Strip a leading "unit 8, " specifier so the street comes first:
//   "unit 8, 1940 Ellesmere Rd, ..."  ->  "1940 Ellesmere Rd, ..."
function stripLeadingUnit(addr) {
  return addr.replace(
    /^\s*(unit|suite|ste|bldg|building)\s*#?\s*[\w-]+\s*,\s*/i,
    ''
  );
}

// Strip inline unit/suite/# patterns:
//   "200 Mulock Dr #11, Newmarket, ..."  ->  "200 Mulock Dr, Newmarket, ..."
//   "1950 Hwy 7 building C unit#2, ..."  ->  "1950 Hwy 7, ..."
//   "2655 Lawrence Ave E suite 11, ..."  ->  "2655 Lawrence Ave E, ..."
function stripInlineUnit(addr) {
  // " #11" or " # 11"
  let cleaned = addr.replace(/\s+#\s*[\w-]+(?=,|\s|$)/g, '');
  // " unit 2", " Unit #11", " suite 11", " ste 11", " bldg C", " building C unit#2"
  cleaned = cleaned.replace(
    /\s+(unit|suite|ste|bldg|building)\s*#?\s*[\w-]+/gi,
    ''
  );
  return cleaned;
}

function cleanAddress(addr) {
  const a = stripLeadingUnit(addr);
  const b = stripInlineUnit(a);
  // Collapse repeated whitespace and stray commas-before-commas left behind.
  return b.replace(/,\s*,/g, ',').replace(/\s+/g, ' ').trim();
}

// Canadian postal codes: A1A 1A1 or A1A1A1.
const POSTAL_RE = /\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)\b/i;

function extractPostal(addr) {
  const m = POSTAL_RE.exec(addr || '');
  if (!m) return null;
  return `${m[1].toUpperCase()} ${m[2].toUpperCase()}`;
}

// ---- Supabase
const SB_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchFailed() {
  const params = new URLSearchParams();
  params.set('select', 'id,shop_name,city,address,geocode_confidence');
  params.append('geocode_confidence', 'eq.failed');
  params.append('address', 'not.is.null');
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

// ---- Pacing
const RATE_LIMIT_MS = 1100;
let lastCall = 0;
async function paced(fn) {
  const wait = lastCall + RATE_LIMIT_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

// ---- Main
const leads = await fetchFailed();
console.log(`Found ${leads.length} failed leads to rescue${LIMIT ? ` (limit ${LIMIT})` : ''}.`);
if (leads.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

const eta = Math.ceil((leads.length * 2 * RATE_LIMIT_MS) / 1000 / 60);
console.log(`Est. runtime: up to ~${eta} min (worst case 2 retries per row).`);
if (DRY_RUN) console.log('--dry-run: not writing.');

const stats = { recovered_clean: 0, recovered_postal: 0, still_failed: 0, errors: 0 };
let processed = 0;

for (const lead of leads) {
  processed++;
  const label = `${lead.shop_name?.slice(0, 40) ?? lead.id} (${lead.city ?? ''})`;
  try {
    let result = null;
    let path = null;

    // 1. Cleaned address
    const cleaned = cleanAddress(lead.address);
    if (cleaned && cleaned !== lead.address) {
      const r = await paced(() => geocodeAddress(cleaned));
      if (r.confidence !== 'failed') {
        result = r;
        path = 'clean';
      }
    }

    // 2. Postal-code-only fallback
    if (!result) {
      const postal = extractPostal(lead.address);
      if (postal) {
        const r = await paced(() => geocodeAddress(`${postal} Canada`));
        if (r.confidence !== 'failed') {
          // Postal-only matches land at street-level at best; downgrade
          // confidence so the user knows it's approximate.
          result = { ...r, confidence: r.confidence === 'house_number' ? 'street' : r.confidence };
          path = 'postal';
        }
      }
    }

    if (!result) {
      stats.still_failed++;
      console.log(`  [${processed}/${leads.length}] ${label} -> still failed`);
      continue;
    }

    if (path === 'clean') stats.recovered_clean++;
    else stats.recovered_postal++;

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
  `  recovered (clean): ${stats.recovered_clean}  |  recovered (postal): ${stats.recovered_postal}  |  still failed: ${stats.still_failed}  |  errors: ${stats.errors}`
);
