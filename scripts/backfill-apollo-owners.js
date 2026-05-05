#!/usr/bin/env node
// Apollo owner-name backfill for the Phase 3.1 GTA leads (or any future
// scout_leads rows lacking owner data).
//
// Why a separate script instead of re-running scout: each scout pass already
// burns Places + Claude credits on the parts we DO have. This pulls the
// missing piece -- owner_name + owner_title + linkedin_url -- by hitting
// Apollo's /mixed_people/search endpoint with q_organization_domains_list,
// which is a SEARCH call (no per-result credit charge, no email reveal).
//
// What it skips deliberately:
//   - /organizations/enrich (1 credit per match)
//   - /people/match (1 credit per email reveal)
//
// What it produces per lead:
//   - owner_name, owner_title, linkedin_url, apollo_source='people_search'
//
// Idempotent: only touches rows with apollo_source IS NULL. Re-running is
// safe; rows already attempted (success or 'no_match') are skipped.
//
// Usage:
//   node scripts/backfill-apollo-owners.js                # all eligible leads
//   node scripts/backfill-apollo-owners.js --tier HOT     # HOT only
//   node scripts/backfill-apollo-owners.js --city Toronto # one city
//   node scripts/backfill-apollo-owners.js --limit 20     # cap rows touched
//   node scripts/backfill-apollo-owners.js --dry-run      # plan, don't write
//
// Env vars (auto-loaded from nous-web/.env.local + nous-scout/.env if not set):
//   APOLLO_API_KEY                  -- required
//   NEXT_PUBLIC_SUPABASE_URL        -- required
//   SUPABASE_SERVICE_ROLE_KEY       -- required

import 'dotenv/config';
import { request } from 'undici';
import fs from 'node:fs';
import path from 'node:path';

// ---- Env loading: scout's own .env first (handled by dotenv/config above),
// then fall back to nous-web/.env.local for Supabase keys.
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
loadFromFileIfMissing(path.resolve('../nous-web/.env.local'), [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'APOLLO_API_KEY',
]);

const APOLLO_KEY = process.env.APOLLO_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!APOLLO_KEY) {
  console.error('APOLLO_API_KEY not set. Add it to nous-scout/.env.');
  process.exit(1);
}
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing Supabase env vars. Add NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to nous-web/.env.local.');
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

// ---- Apollo client
const APOLLO_BASE = 'https://api.apollo.io/api/v1';
const OWNER_TITLES = ['owner', 'president', 'ceo', 'general manager', 'operations manager', 'founder'];
// 200 ms between calls -> 5 req/s. Apollo's free-tier limit is higher; this
// keeps us comfortably under any soft throttle.
const RATE_LIMIT_MS = 200;

let lastApolloCall = 0;
async function apolloPost(pathname, body) {
  const wait = lastApolloCall + RATE_LIMIT_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastApolloCall = Date.now();
  const res = await request(`${APOLLO_BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      accept: 'application/json',
      'X-Api-Key': APOLLO_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.body.json();
  if (res.statusCode >= 400) {
    throw new Error(`Apollo ${pathname} ${res.statusCode}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

function domainFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `http://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function pickOwnerCandidate(people) {
  if (!Array.isArray(people) || people.length === 0) return null;
  for (const title of OWNER_TITLES) {
    const match = people.find((p) => (p.title || '').toLowerCase().includes(title));
    if (match) return match;
  }
  return people[0];
}

// ---- Supabase REST helpers (no SDK needed)
const SB_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchEligibleLeads() {
  const params = new URLSearchParams();
  // Eligible = has a website, hasn't been attempted yet.
  params.set('select', 'id,shop_name,city,province,priority_tier,website,apollo_source,owner_name');
  params.append('apollo_source', 'is.null');
  params.append('website', 'not.is.null');
  if (TIER) params.append('priority_tier', `eq.${TIER}`);
  if (CITY) params.append('city', `eq.${CITY}`);
  // Order: HOT first, then by score desc — work the highest-value rows first
  // in case we need to abort partway.
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

// ---- Main
const leads = await fetchEligibleLeads();
console.log(`Found ${leads.length} eligible leads (apollo_source IS NULL, website set${TIER ? `, tier=${TIER}` : ''}${CITY ? `, city=${CITY}` : ''}${LIMIT ? `, limit=${LIMIT}` : ''}).`);

if (leads.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

if (DRY_RUN) {
  console.log('--dry-run set; not calling Apollo or writing to Supabase. First 5:');
  for (const l of leads.slice(0, 5)) {
    console.log(`  - ${l.shop_name} (${l.city}, ${l.priority_tier}) -> ${domainFromUrl(l.website)}`);
  }
  process.exit(0);
}

let attempted = 0;
let matched = 0;
let noMatch = 0;
let failed = 0;
const startedAt = Date.now();

for (const lead of leads) {
  attempted += 1;
  const domain = domainFromUrl(lead.website);
  if (!domain) {
    failed += 1;
    continue;
  }

  let candidate = null;
  let source = 'no_match';
  try {
    const data = await apolloPost('/mixed_people/search', {
      q_organization_domains_list: [domain],
      person_titles: OWNER_TITLES,
      page: 1,
      per_page: 10,
    });
    const people = data?.people || [];
    candidate = pickOwnerCandidate(people);
    if (candidate) {
      source = 'people_search';
      matched += 1;
    } else {
      noMatch += 1;
    }
  } catch (err) {
    console.error(`\n[${lead.shop_name}] Apollo error: ${err.message}`);
    failed += 1;
    continue;
  }

  const patch = {
    apollo_source: source,
  };
  if (candidate) {
    const fullName = candidate.name || `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim();
    if (fullName) patch.owner_name = fullName;
    if (candidate.title) patch.owner_title = candidate.title;
    if (candidate.linkedin_url) patch.linkedin_url = candidate.linkedin_url;
  }

  try {
    await patchLead(lead.id, patch);
  } catch (err) {
    console.error(`\n[${lead.shop_name}] Supabase patch failed: ${err.message}`);
    failed += 1;
    continue;
  }

  process.stdout.write(
    `\r[${attempted}/${leads.length}] matched=${matched} no_match=${noMatch} failed=${failed}`,
  );
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
process.stdout.write('\n');
console.log(`Done in ${elapsed}s. matched=${matched} no_match=${noMatch} failed=${failed}.`);
