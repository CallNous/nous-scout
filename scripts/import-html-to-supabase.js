#!/usr/bin/env node
// One-shot import of a previously-rendered nous-scout HTML report into the
// Supabase `scout_leads` table. Phase 3.1 of the Scout mobile build —
// preserves the GTA batch Anton already paid Places + Apollo + Claude
// credits for so it lands in the mobile app without re-pulling.
//
// Usage:
//   node scripts/import-html-to-supabase.js Output/cities-gta-combined-2026-04-16_17-50-21.html
//
// Env vars (loaded from nous-web/.env.local automatically if not already set):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Idempotent: dedup_key = "html:" + slug(shop_name) + ":" + slug(city) so
// re-running the script (with the same HTML or a different combined report)
// upserts cleanly. Status is preserved on existing rows; only the metadata
// fields refresh.

import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';

const HTML_PATH = process.argv[2];
if (!HTML_PATH) {
  console.error('Usage: node scripts/import-html-to-supabase.js <html-path>');
  process.exit(1);
}
if (!fs.existsSync(HTML_PATH)) {
  console.error(`File not found: ${HTML_PATH}`);
  process.exit(1);
}

// Lazy-load Supabase env from nous-web/.env.local if not already in env.
function ensureEnv() {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const candidate = path.resolve('../nous-web/.env.local');
  if (!fs.existsSync(candidate)) {
    console.error(`Env vars NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY not set, and ${candidate} not found.`);
    process.exit(1);
  }
  for (const line of fs.readFileSync(candidate, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

ensureEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

function slug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseInt0(s) {
  const n = parseInt(String(s ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloat0(s) {
  const n = parseFloat(String(s ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Pull a city/province pair from the panel header text "Toronto, ON".
function splitCityProvince(headerText, fallback) {
  const m = String(headerText || '').match(/^\s*(.+?),\s*([A-Z]{2})\s*$/);
  if (m) return { city: m[1].trim(), province: m[2] };
  return fallback;
}

// "NOUS 8 · TC 0 · Conf 55" → { nous_score: 8, tc_score: 0, confidence: 55 }
function parseScores(text) {
  const out = { nous_score: null, tc_score: null, confidence: null };
  if (!text) return out;
  const nous = text.match(/NOUS\s+(-?\d+(?:\.\d+)?)/i);
  const tc = text.match(/TC\s+(-?\d+(?:\.\d+)?)/i);
  const conf = text.match(/Conf\s+(-?\d+(?:\.\d+)?)/i);
  if (nous) out.nous_score = parseFloat(nous[1]);
  if (tc) out.tc_score = parseFloat(tc[1]);
  if (conf) out.confidence = parseFloat(conf[1]);
  return out;
}

// "4.7 rating · 105 reviews · ~9 reviews/yr · 1 staff" → split out
function parseMeta(text) {
  const out = { rating: null, review_count: null, review_velocity: null, staff_count: null };
  if (!text) return out;
  const rating = text.match(/(-?\d+(?:\.\d+)?)\s*rating/i);
  const reviews = text.match(/(\d[\d,]*)\s*reviews?\b/i);
  const velocity = text.match(/~?\s*(-?\d+(?:\.\d+)?)\s*reviews?\/yr/i);
  const staff = text.match(/(\d+)\s*staff/i);
  if (rating) out.rating = parseFloat(rating[1]);
  if (reviews) out.review_count = parseInt(reviews[1].replace(/,/g, ''), 10);
  if (velocity) out.review_velocity = parseFloat(velocity[1]);
  if (staff) out.staff_count = parseInt(staff[1], 10);
  return out;
}

function pickMaturityTier(maturityClass) {
  if (!maturityClass) return null;
  const m = maturityClass.match(/maturity-(established|growing|small|micro)/);
  return m ? m[1] : null;
}

// Strip the leading bold label from "Reachability: ..." / "NOUS opener: ..."
function stripPrefix(text, prefix) {
  if (!text) return null;
  const re = new RegExp(`^\\s*${prefix}\\s*:?\\s*`, 'i');
  const out = text.replace(re, '').trim();
  return out || null;
}

const html = fs.readFileSync(HTML_PATH, 'utf8');
const $ = cheerio.load(html);
const runId = path.basename(HTML_PATH, '.html');

// Skip the all-GTA combined panel (data-city="all") — every shop in it
// appears once in its per-city panel already, and we want stable city
// attribution.
const cityPanels = $('.city-panel').filter((_, el) => {
  const dc = $(el).attr('data-city');
  return dc != null && dc !== 'all';
}).toArray();

if (cityPanels.length === 0) {
  console.error('No per-city .city-panel elements found. Is this a combined HTML report?');
  process.exit(1);
}

const rows = [];
for (const panel of cityPanels) {
  const $panel = $(panel);
  const headerText = $panel.find('.city-header h2').first().text().trim();
  const { city, province } = splitCityProvince(headerText, { city: 'Unknown', province: 'ON' });

  $panel.find('.call-card').each((_, card) => {
    const $card = $(card);
    const tier = $card.attr('data-tier') || null;
    const tcOpp = $card.attr('data-tc') || null;
    const shopName = $card.find('.call-name').first().text().trim();
    if (!shopName) return;
    const address = $card.find('.call-address').first().text().trim() || null;
    const scores = parseScores($card.find('.call-scores').first().text());
    const meta = parseMeta($card.find('.call-meta').first().text());

    const maturityBadge = $card.find('.maturity-badge').first();
    const maturityTier = pickMaturityTier(maturityBadge.attr('class'));
    const estRevenue = maturityBadge.text().trim() || null;

    const franchiseFlag = $card.find('.franchise-flag').first().text().trim() || null;

    // Action buttons
    const phoneHref = $card.find('a.call-btn[href^="tel:"]').first().attr('href') || null;
    const phone = phoneHref ? phoneHref.replace(/^tel:/, '') : null;
    const website = $card.find('a.site-btn[href]').first().attr('href') || null;
    const emailHref = $card.find('a.email-btn[href^="mailto:"]').first().attr('href') || null;
    const shopEmail = emailHref ? emailHref.replace(/^mailto:/, '') : null;

    // Owner / contact strings
    const callContactRaw = $card.find('.call-contact').first().text().trim();
    const askForMatch = callContactRaw.match(/Ask\s+for:\s*(.+)$/i);
    const contactNames = askForMatch ? askForMatch[1].trim() : (callContactRaw || null);

    const reachability = stripPrefix($card.find('.call-signal').first().text(), 'Reachability');
    const nousPitch = $card.find('.call-pitch em').first().text().trim() || null;

    const dedupKey = `html:${slug(shopName)}:${slug(city)}`;
    rows.push({
      dedup_key: dedupKey,
      city,
      province,
      shop_name: shopName,
      address,
      phone,
      website,
      shop_email: shopEmail,
      rating: meta.rating,
      review_count: meta.review_count,
      priority_tier: tier,
      nous_score: scores.nous_score,
      tc_score: scores.tc_score,
      tc_opportunity: tcOpp,
      confidence: scores.confidence,
      maturity_tier: maturityTier,
      est_revenue: estRevenue,
      review_velocity: meta.review_velocity,
      staff_count: meta.staff_count,
      franchise_network: franchiseFlag,
      signals: {
        reachability_complaint: reachability,
      },
      nous_pitch: nousPitch,
      contact_names: contactNames,
      run_id: runId,
      source: 'html_import',
    });
  });
}

console.log(`Parsed ${rows.length} leads across ${cityPanels.length} cities.`);
const tierCounts = rows.reduce((acc, r) => {
  acc[r.priority_tier || 'NULL'] = (acc[r.priority_tier || 'NULL'] || 0) + 1;
  return acc;
}, {});
console.log('Tier breakdown:', tierCounts);
const withWebsite = rows.filter((r) => r.website).length;
console.log(`Leads with a website: ${withWebsite} / ${rows.length}`);

if (process.argv.includes('--dry-run')) {
  console.log('--dry-run set; not writing to Supabase. Sample row:');
  console.log(JSON.stringify(rows[0], null, 2));
  process.exit(0);
}

// Upsert in chunks. Supabase REST handles bulk POST with ?on_conflict + the
// resolution=merge-duplicates Prefer header.
const CHUNK = 100;
const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/scout_leads?on_conflict=dedup_key`;
let inserted = 0;
let failed = 0;

for (let i = 0; i < rows.length; i += CHUNK) {
  const chunk = rows.slice(i, i + CHUNK);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(chunk),
  });
  if (!res.ok) {
    failed += chunk.length;
    const body = await res.text().catch(() => '');
    console.error(`Chunk ${i}-${i + chunk.length} failed (${res.status}): ${body.slice(0, 300)}`);
    continue;
  }
  inserted += chunk.length;
  process.stdout.write(`\rUpserted ${inserted} / ${rows.length}`);
}

process.stdout.write('\n');
console.log(`Done. Upserted ${inserted}, failed ${failed}.`);
if (inserted > 0) {
  console.log(
    '\nNew rows need lat/lng for the route-optimize endpoint. Run:\n' +
      '  node scripts/backfill-geocodes.js\n' +
      '(Idempotent; only touches rows where latitude IS NULL.)'
  );
}
