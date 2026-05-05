// Cold-email opener generator.
// For each scored shop, asks Grok 4.3 to write ONE sentence that references
// the shop's specific situation — their top complaint, their missing capability,
// or a pain point we can speak to credibly. Used as the opening line of an
// outreach email so the recipient sees we did homework before writing.
//
// Migrated 2026-05-05 from Claude Sonnet 4.6 to xAI Grok 4.3 per Anton's
// "all extraction/generation goes through Grok 4.3" rule. xAI handles
// prompt caching automatically (no cache_control field needed).
//
// Cached by (place_id + nous_score + top_complaint) so it only regenerates
// when scoring or review sentiment actually changes.

import 'dotenv/config';
import { request } from 'undici';
import fs from 'node:fs';
import path from 'node:path';
import { cache } from './cache.js';
import { createLimiter, sleep } from './lib/rateLimit.js';
import { log } from './lib/logger.js';

const MODEL = 'grok-4.3';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const limit = createLimiter(500);

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
loadFromFileIfMissing(path.resolve('../nous-web/.env.local'), ['XAI_API_KEY']);

function xaiKey() {
  const k = process.env.XAI_API_KEY;
  if (!k) throw new Error('XAI_API_KEY not set in .env (or nous-web/.env.local)');
  return k;
}

async function callGrok(systemPrompt, userPrompt, { maxTokens = 120, retries = 4 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await limit();
    try {
      const res = await request(XAI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${xaiKey()}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          temperature: 0.4,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });
      const data = await res.body.json();
      if (res.statusCode >= 400) {
        const err = new Error(`Grok ${res.statusCode}: ${JSON.stringify(data).slice(0, 200)}`);
        err.status = res.statusCode;
        throw err;
      }
      return data?.choices?.[0]?.message?.content || '';
    } catch (err) {
      const status = err.status || err.statusCode;
      if ((status === 429 || status === 503 || status === 529) && attempt < retries) {
        const wait = Math.min(2000 * 2 ** attempt, 30000);
        log.debug(`pitch Grok ${status}, retry ${attempt + 1}/${retries} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

const SYSTEM = `You write ONE-sentence cold-email openers for B2B outreach to independent tire shops.

Context: NOUS is an AI phone platform purpose-built for tire shops. It picks up calls ONLY when the shop's team can't — after hours, weekends, lunch rushes, or when every line is busy. It's a safety net, not a replacement. When the staff is available, they answer as usual. When they're not, NOUS catches the overflow, books appointments, checks inventory, gives pricing, and sends SMS confirmations so the shop never loses a job to voicemail.

The two value angles for NOUS are:
1. MISSED REVENUE — every unanswered call is a job that goes to the next shop. Customers don't leave voicemails.
2. TIME SAVINGS — the owner and staff shouldn't have to stop what they're doing to answer routine calls about hours, pricing, and appointment availability. NOUS handles the repetitive phone work so the team can focus on the cars in front of them.

NOUS does NOT replace the team. It catches overflow and after-hours calls so the humans can focus on higher-value work.

Your opener must reference something SPECIFIC about this shop — a review signal (missed calls, after-hours, booking friction, customers leaving) or a website gap (no online booking, "call to book", closed evenings/weekends). The owner should think "this person actually looked at my shop."

Rules:
- Exactly one sentence, max ~30 words.
- No greeting, no emoji, no superlatives, no cliches.
- Tone: curious and specific. A question or observation, not a sales pitch.
- Frame around lost revenue from unanswered calls OR time the owner/staff wastes on routine phone tasks — never about replacing people.
- ONLY reference phone/booking/reachability gaps. NEVER reference workmanship, pricing disputes, rudeness, in-person wait times, or service quality.
- Do NOT reference specific negative reviews or bad customer experiences. Keep it about the communication gap, not about specific complaints.
- If no review signal exists, reference a website gap (no booking, no after-hours contact, "call for pricing").
- If truly nothing, reference their review volume or hours in a neutral way.
- Return ONLY the sentence.`;

const TC_SYSTEM = `You write ONE-sentence cold-email openers for B2B outreach to independent tire shops about TireConnect — an embeddable online tire catalog by Bridgestone.

Context: TireConnect lets tire shops add a full tire shopping experience to their website — customers can browse inventory, see pricing, and request quotes 24/7. Shops without it force customers to call for every tire question, or lose them to competitors who let you shop online.

Your opener must reference a SPECIFIC gap on this shop's website — no tire catalog, no online inventory, static PDF price sheets, "call for pricing", or no e-commerce. The goal is for the shop owner to think "this person looked at my site."

Rules:
- Exactly one sentence.
- No greeting. Start directly with the observation.
- No emoji. No superlatives. No cliches.
- Tone: curious and specific, not salesy. A question or observation.
- Max ~30 words.
- ONLY reference tire catalog/inventory/e-commerce gaps. Do NOT reference phone issues, staffing, reviews, or anything unrelated to their online tire shopping experience.
- If the shop already has TireConnect or a tire catalog, do NOT generate a pitch. Return "N/A".
- Return ONLY the sentence. No quotes, no prose, no explanation.`;

function pitchKey(shop, score) {
  return [
    shop.place_id,
    score.nous_score,
    score.tc_score,
    shop.analysis?.general?.reachability_complaint || '',
    score.priority_tier,
  ].join('|');
}

function buildUserPrompt(shop, score) {
  const analysis = shop.analysis || {};
  const scrape = shop.scrape || {};
  const nous = analysis.nous_signals || {};
  const gen = analysis.general || {};

  const lines = [];
  lines.push(`Shop: ${shop.name}`);
  lines.push(`Location: ${shop.address || 'unknown'}`);
  lines.push(`Rating: ${shop.rating ?? '?'} (${shop.review_count || 0} reviews)`);
  lines.push(`NOUS score: ${score.nous_score}/10 — reasons: ${score.nous_reasons.join(', ') || 'none'}`);

  // Communication/reachability signals — this is what the opener should reference
  if (gen.reachability_complaint) lines.push(`Reachability complaint from reviews: ${gen.reachability_complaint}`);
  if (nous.missed_calls_mentioned) lines.push('SIGNAL: Reviews mention missed calls / voicemail / no answer');
  if (nous.after_hours_issues) lines.push('SIGNAL: Reviews mention after-hours / weekend unreachability');
  if (nous.wait_times_mentioned) lines.push('SIGNAL: Reviews mention long phone holds');
  if (nous.booking_difficulty) lines.push('SIGNAL: Reviews mention difficulty booking appointments');
  if (nous.went_to_competitor) lines.push('SIGNAL: Reviews mention customers going to another shop due to unreachability');
  if (scrape.no_online_booking) lines.push('WEBSITE: No online booking system found');
  if (scrape.call_to_book) lines.push('WEBSITE: Says "call to book" — no self-serve booking');
  if (scrape.call_for_pricing) lines.push('WEBSITE: Says "call for pricing"');
  if (scrape.no_text_contact) lines.push('WEBSITE: No text/SMS contact option');
  if (!scrape.has_evening_hours) lines.push('WEBSITE: No evening hours listed');
  if (!scrape.has_weekend_hours) lines.push('WEBSITE: Limited or no weekend hours');
  if (scrape.site_unreachable) lines.push('WEBSITE: Unreachable');

  // Context only — NOT for the opener
  if (gen.top_praise) lines.push(`(Context only, do NOT reference) Top praise: ${gen.top_praise}`);
  return `Write the one-sentence opener about phone/communication/booking gaps ONLY.\n\n${lines.join('\n')}`;
}

export async function generatePitch(shop, score) {
  const key = pitchKey(shop, score);
  const cached = cache.getPitch(key);
  if (cached) return cached;

  try {
    const raw = await callGrok(SYSTEM, buildUserPrompt(shop, score));
    const text = raw.trim().replace(/^["']|["']$/g, '');
    cache.putPitch(key, text);
    return text;
  } catch (err) {
    log.warn(`pitch failed for ${shop.name}: ${err.message}`);
    return '';
  }
}

function buildTcUserPrompt(shop, score) {
  const scrape = shop.scrape || {};
  const lines = [];
  lines.push(`Shop: ${shop.name}`);
  lines.push(`Location: ${shop.address || 'unknown'}`);
  lines.push(`Rating: ${shop.rating ?? '?'} (${shop.review_count || 0} reviews)`);
  lines.push(`TC score: ${score.tc_score}/10 — reasons: ${score.tc_reasons.join(', ') || 'none'}`);
  if (scrape.no_tire_catalog) lines.push('WEBSITE: No tire catalog or inventory browser found');
  if (scrape.no_ecommerce) lines.push('WEBSITE: No e-commerce / add-to-cart functionality');
  if (scrape.static_pricing) lines.push('WEBSITE: Uses static PDF price sheets instead of dynamic catalog');
  if (scrape.call_for_pricing) lines.push('WEBSITE: Says "call for pricing"');
  if (scrape.already_has_tireconnect) lines.push('WEBSITE: Already has TireConnect installed — return N/A');
  if (scrape.platform_detected) lines.push(`WEBSITE: Built on ${scrape.platform_detected}`);
  if (scrape.site_unreachable) lines.push('WEBSITE: Unreachable');
  return `Write the one-sentence opener about their missing online tire catalog.\n\n${lines.join('\n')}`;
}

function tcPitchKey(shop, score) {
  return `tc|${shop.place_id}|${score.tc_score}|${score.tc_reasons?.join(',') || ''}`;
}

export async function generateTcPitch(shop, score) {
  if (score.tc_opportunity === 'NO') return '';
  const key = tcPitchKey(shop, score);
  const cached = cache.getPitch(key);
  if (cached) return cached;

  try {
    const raw = await callGrok(TC_SYSTEM, buildTcUserPrompt(shop, score));
    const text = raw.trim().replace(/^["']|["']$/g, '');
    if (text === 'N/A' || text.toLowerCase().includes('n/a')) return '';
    cache.putPitch(key, text);
    return text;
  } catch (err) {
    log.warn(`tc pitch failed for ${shop.name}: ${err.message}`);
    return '';
  }
}

async function selftest() {
  const shop = {
    place_id: 'test123',
    name: "Joe's Tire & Auto",
    address: '123 Main St, Toronto ON',
    rating: 4.1,
    review_count: 87,
    reviews: [],
    analysis: {
      nous_signals: { missed_calls_mentioned: true, after_hours_issues: true, wait_times_mentioned: false, responsiveness_score: 2 },
      general: { overall_sentiment: 'mixed', top_complaint: 'Customers complain they can never reach the shop by phone', top_praise: 'Great workmanship on winter tire changes' },
    },
    scrape: { no_online_booking: true, no_tire_catalog: true, call_for_pricing: true },
  };
  const score = {
    nous_score: 8,
    tc_score: 4,
    priority_tier: 'HOT',
    nous_reasons: ['missed_calls_mentioned', 'after_hours_issues', 'no_online_booking', 'call_for_pricing'],
    tc_reasons: ['no_tire_catalog', 'call_for_pricing'],
  };
  const pitch = await generatePitch(shop, score);
  // eslint-disable-next-line no-console
  console.log(pitch);
  cache.close();
}

if (process.argv.includes('--selftest')) {
  selftest().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
