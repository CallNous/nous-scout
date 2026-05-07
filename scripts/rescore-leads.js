#!/usr/bin/env node
// Re-score existing scout_leads with updated size + premium + type-exclusion logic.
//
// Reads summary columns from Supabase (review_count, review_velocity,
// staff_count, shop_name, types), applies the new scoring adjustments,
// and PATCHes nous_score, priority_tier, maturity_tier, est_revenue.
//
// Does NOT re-run the full pipeline (scraper, analyzer). Only adjusts
// scores using data already in Supabase.
//
// Usage:
//   node scripts/rescore-leads.js              # all leads
//   node scripts/rescore-leads.js --city Toronto
//   node scripts/rescore-leads.js --dry-run    # preview changes

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/lib/franchises.js';

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
]);

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing Supabase env vars.');
  process.exit(1);
}

const args = process.argv.slice(2);
function flag(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}
const CITY = flag('--city');
const DRY_RUN = args.includes('--dry-run');

const SB_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchAllLeads() {
  const params = new URLSearchParams();
  params.set('select', 'id,shop_name,city,review_count,review_velocity,staff_count,nous_score,priority_tier,maturity_tier,est_revenue,types,signals');
  if (CITY) params.append('city', `eq.${CITY}`);
  params.append('order', 'nous_score.desc.nullslast');

  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/scout_leads?${params}`;
  const res = await fetch(url, { headers: { ...SB_HEADERS, Range: '0-999' } });
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

const cfg = loadConfig();
const sw = cfg.sizeWeights || {};
const excludeTypes = cfg.excludeTypes || [];
const premiumNameKw = cfg.premiumNameKeywords || [];
const tiers = cfg.tiers;

function rescoreLead(lead) {
  const reviewCount = lead.review_count || 0;
  const reviewVelocity = lead.review_velocity || 0;
  const staffCount = lead.staff_count || 0;
  const types = Array.isArray(lead.types) ? lead.types : [];
  const nameLower = (lead.shop_name || '').toLowerCase();
  const signals = lead.signals || {};
  const hasPremiumServices = signals.has_premium_services === true;

  // Recompute maturity from summary columns
  let matScore = 0;
  if (reviewCount >= 500) matScore += 4;
  else if (reviewCount >= 200) matScore += 3;
  else if (reviewCount >= 80) matScore += 2;
  else if (reviewCount >= 30) matScore += 1;

  if (reviewVelocity >= 150) matScore += 3;
  else if (reviewVelocity >= 60) matScore += 2;
  else if (reviewVelocity >= 20) matScore += 1;

  if (staffCount >= 4) matScore += 2;
  else if (staffCount >= 2) matScore += 1;

  let matTier, estRevenue;
  if (matScore >= 10) { matTier = 'premium'; estRevenue = '$2M+'; }
  else if (matScore >= 8) { matTier = 'established'; estRevenue = '$1M+'; }
  else if (matScore >= 5) { matTier = 'growing'; estRevenue = '$500K-1M'; }
  else if (matScore >= 3) { matTier = 'small'; estRevenue = '$250K-500K'; }
  else { matTier = 'micro'; estRevenue = '<$250K'; }

  // Quick-lube type exclusion
  const hasExcludedType = types.some((t) => excludeTypes.includes(t));
  if (hasExcludedType) {
    matTier = 'micro';
    estRevenue = '<$250K';
  }

  // Size bonus on top of existing nous_score
  let baseScore = lead.nous_score || 0;
  let sizeBonus = 0;
  if (reviewCount >= 200 && sw.review_count_200_plus) sizeBonus += sw.review_count_200_plus;
  if (reviewVelocity >= 100 && sw.review_velocity_100_plus) sizeBonus += sw.review_velocity_100_plus;
  if (staffCount >= 3 && sw.staff_count_3_plus) sizeBonus += sw.staff_count_3_plus;
  if (premiumNameKw.some((kw) => nameLower.includes(kw))) sizeBonus += 1;
  if (hasPremiumServices) sizeBonus += 1;

  const adjustedScore = Math.min(10, baseScore + Math.min(3, sizeBonus));
  const priorityTier = adjustedScore >= tiers.hot ? 'HOT' : adjustedScore >= tiers.warm ? 'WARM' : 'COLD';

  return {
    nous_score: adjustedScore,
    priority_tier: priorityTier,
    maturity_tier: matTier,
    est_revenue: estRevenue,
  };
}

const leads = await fetchAllLeads();
console.log(`Loaded ${leads.length} leads${CITY ? ` (city=${CITY})` : ''}.`);

if (leads.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

const stats = { updated: 0, unchanged: 0, errors: 0, hidden: 0 };
let processed = 0;

for (const lead of leads) {
  processed++;
  const patch = rescoreLead(lead);
  const changed =
    patch.nous_score !== lead.nous_score ||
    patch.priority_tier !== lead.priority_tier ||
    patch.maturity_tier !== lead.maturity_tier ||
    patch.est_revenue !== lead.est_revenue;

  if (!changed) {
    stats.unchanged++;
    continue;
  }

  if (patch.maturity_tier === 'small' || patch.maturity_tier === 'micro') stats.hidden++;

  const delta = patch.nous_score - (lead.nous_score || 0);
  const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
  console.log(
    `  [${processed}/${leads.length}] ${lead.shop_name} (${lead.city}): ` +
    `score ${lead.nous_score ?? '?'}→${patch.nous_score} (${deltaStr}), ` +
    `tier ${lead.priority_tier ?? '?'}→${patch.priority_tier}, ` +
    `maturity ${lead.maturity_tier ?? '?'}→${patch.maturity_tier}`
  );

  if (DRY_RUN) { stats.updated++; continue; }

  try {
    await patchLead(lead.id, patch);
    stats.updated++;
  } catch (err) {
    stats.errors++;
    console.error(`    ERROR: ${err.message}`);
  }
}

console.log(
  `\nDone. updated: ${stats.updated}  |  unchanged: ${stats.unchanged}  |  hidden (small/micro): ${stats.hidden}  |  errors: ${stats.errors}`
);
