// Grok-powered review analyzer.
// Sends each shop's up-to-5 Google reviews to Grok 4.3, gets back a JSON
// object with NOUS-relevant signals and a short sentiment read.
//
// Migrated 2026-05-05 from Claude Haiku 4.5 to xAI Grok 4.3 per Anton's
// "all extraction/generation goes through Grok 4.3" rule. xAI's chat
// completions endpoint is OpenAI-compatible. Prompt caching no longer
// requires an explicit cache_control field -- xAI caches identical
// system prompts within its TTL automatically.
//
// Cache layers:
//   1. xAI's automatic prompt cache (server-side, transparent)
//   2. SQLite cache keyed by hash of reviews text -- identical inputs
//      across runs return for free.

import 'dotenv/config';
import { request } from 'undici';
import fs from 'node:fs';
import path from 'node:path';
import { cache } from './cache.js';
import { createLimiter, sleep } from './lib/rateLimit.js';
import { log } from './lib/logger.js';

const DEFAULT_MODEL = 'grok-4.3';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const limit = createLimiter(500); // 500ms between Grok calls

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

const SYSTEM_PROMPT = `You are analyzing Google reviews for an independent tire shop. Your goal is to find signals that the shop is LOSING BUSINESS because they can't handle their phone volume — specifically the problems that an AI phone agent (24/7 call answering, automated booking, after-hours capture) would solve.

Context: NOUS is an AI phone platform that answers every call in <0.5 seconds, books appointments, provides pricing/inventory info, and works 24/7 including nights and weekends. Every missed call is a missed job — customers don't leave voicemails, they call the next shop.

ONLY flag signals that the reviews ACTUALLY mention. Do not infer from star ratings alone. If reviews only discuss service quality, pricing, or workmanship — those are NOT relevant signals.

Return ONLY valid JSON, no prose, no markdown fences:

{
  "nous_signals": {
    "missed_calls_mentioned": boolean,
    "after_hours_issues": boolean,
    "wait_times_mentioned": boolean,
    "booking_difficulty": boolean,
    "went_to_competitor": boolean,
    "responsiveness_score": number
  },
  "general": {
    "overall_sentiment": "positive" | "mixed" | "negative",
    "reachability_complaint": string | null,
    "top_praise": string | null
  },
  "contact_names": [
    { "name": string, "role": string }
  ]
}

Field definitions:
- missed_calls_mentioned: reviews mention voicemail, no answer, couldn't get through, busy signal, nobody picked up, had to call multiple times, phone rings endlessly, had to drive there in person because no one answered
- after_hours_issues: reviews mention being unable to reach the shop evenings, weekends, holidays, or outside posted hours; mention the shop was closed when they needed service
- wait_times_mentioned: reviews mention long phone holds, being put on hold, waiting on the line, slow to return calls or messages
- booking_difficulty: reviews mention difficulty scheduling or booking an appointment, having to call back repeatedly, walk-in only frustration, no online booking available
- went_to_competitor: reviews explicitly mention going elsewhere, trying another shop, or losing patience and leaving — because of reachability or responsiveness (NOT because of price or quality)
- responsiveness_score: integer 1-5, how reachable and responsive the shop seems SPECIFICALLY regarding phone/communication (not service quality)
- overall_sentiment: positive / mixed / negative (overall, not just reachability)
- reachability_complaint: one sentence summarizing the COMMUNICATION/REACHABILITY complaint if any exist (missed calls, can't get through, slow callbacks, no text response, booking friction). null if no such complaints. Do NOT include complaints about workmanship, pricing, rudeness, or wait times for physical service — ONLY phone/communication/booking issues.
- top_praise: one sentence, most common praise, or null
- contact_names: array of people mentioned BY NAME in the reviews who appear to work at or own the shop. For each, include "name" (first name only is fine) and "role" (one of: "owner", "manager", "technician", "staff", or "unknown"). ONLY include names of people who WORK at the shop, not customers/reviewers. Look for patterns like "Mike the owner", "spoke with Alex", "Samih helped us", "thanks to Raffi and his team". Return empty array [] if no staff names are mentioned.`;

function formatReviews(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) return '';
  return reviews
    .map((r, i) => {
      const rating = r.rating ?? '?';
      const author = r.author_name || 'Anonymous';
      const text = (r.text || '').replace(/\s+/g, ' ').trim();
      return `Review ${i + 1} (${rating}/5 by ${author}): ${text}`;
    })
    .join('\n\n');
}

function validate(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const n = obj.nous_signals;
  const g = obj.general;
  if (!n || !g) return false;
  if (typeof n.missed_calls_mentioned !== 'boolean') return false;
  if (typeof n.after_hours_issues !== 'boolean') return false;
  if (typeof n.wait_times_mentioned !== 'boolean') return false;
  if (typeof n.responsiveness_score !== 'number') return false;
  if (!['positive', 'mixed', 'negative'].includes(g.overall_sentiment)) return false;
  // New fields — allow missing for backwards compat with cached results
  if ('booking_difficulty' in n && typeof n.booking_difficulty !== 'boolean') return false;
  if ('went_to_competitor' in n && typeof n.went_to_competitor !== 'boolean') return false;
  return true;
}

async function callGrok(reviewsText, model, retries = 4) {
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
          model,
          max_tokens: 600,
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Reviews to analyze:\n\n${reviewsText}` },
          ],
        }),
      });
      const data = await res.body.json();
      if (res.statusCode >= 400) {
        const err = new Error(`Grok ${res.statusCode}: ${JSON.stringify(data).slice(0, 200)}`);
        err.status = res.statusCode;
        throw err;
      }
      const text = data?.choices?.[0]?.message?.content || '';
      return { text, usage: data?.usage };
    } catch (err) {
      const status = err.status || err.statusCode;
      if ((status === 429 || status === 503 || status === 529) && attempt < retries) {
        const wait = Math.min(2000 * 2 ** attempt, 30000);
        log.debug(`Grok ${status}, retry ${attempt + 1}/${retries} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

function parseJson(text) {
  // Grok with response_format json_object should return pure JSON, but strip
  // common wrappers just in case.
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export async function analyzeReviews(reviews, { model = DEFAULT_MODEL } = {}) {
  const reviewsText = formatReviews(reviews);
  if (!reviewsText) {
    return {
      nous_signals: {
        missed_calls_mentioned: false,
        after_hours_issues: false,
        wait_times_mentioned: false,
        responsiveness_score: 3,
      },
      general: { overall_sentiment: 'mixed', top_complaint: null, top_praise: null },
      skipped: 'no_reviews',
    };
  }

  const cached = cache.getAnalysis(reviewsText);
  if (cached) return cached;

  try {
    let { text } = await callGrok(reviewsText, model);
    let parsed = parseJson(text);
    if (!validate(parsed)) {
      log.warn('analyzer: first response invalid, retrying once');
      await sleep(400);
      ({ text } = await callGrok(
        `${reviewsText}\n\nIMPORTANT: Your previous response did not validate. Return ONLY the JSON object with EXACTLY the fields in the schema. No markdown, no prose.`,
        model
      ));
      parsed = parseJson(text);
    }
    if (!validate(parsed)) {
      log.warn('analyzer: second response still invalid, nulling signals');
      return null;
    }
    cache.putAnalysis(reviewsText, parsed);
    return parsed;
  } catch (err) {
    log.warn(`analyzer call failed: ${err.message}`);
    return null;
  }
}

async function selftest() {
  const fakeReviews = [
    { rating: 2, author_name: 'Jane', text: "Tried to call 3 times, nobody answered. Straight to voicemail both times. Had to drive over in person." },
    { rating: 5, author_name: 'Mike', text: 'Great work on my winter tires, fast turnaround.' },
    { rating: 3, author_name: 'Sarah', text: 'Decent shop but phone rings forever. Waited 8 minutes on hold last time.' },
    { rating: 1, author_name: 'Tom', text: "Called Saturday afternoon — closed. Had to wait till Monday to book. Lost me." },
    { rating: 4, author_name: 'Ashley', text: 'Good pricing, honest mechanics.' },
  ];
  const result = await analyzeReviews(fakeReviews);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  cache.close();
}

if (process.argv.includes('--selftest')) {
  selftest().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
