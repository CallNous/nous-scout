// Pure-JS cache, backed by a single cache.json file in the project root.
// No native deps. At our scale (hundreds of entries max per run) this is
// plenty fast and keeps the install requirements down to "node and that's it".
//
// Keyed tables:
//   places_search   — keyed by query string
//   place_details   — keyed by place_id
//   scrapes         — keyed by place_id
//   analyses        — keyed by sha1(reviews_text)
//   pitches         — keyed by custom string
//   enrichments     — keyed by place_id

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CACHE_PATH = path.resolve('cache.json');

let state = null;
let dirty = false;
let flushTimer = null;

function load() {
  if (state) return state;
  try {
    if (fs.existsSync(CACHE_PATH)) {
      state = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } else {
      state = {};
    }
  } catch (err) {
    // If the cache file is corrupt, back it up and start fresh.
    const backup = `${CACHE_PATH}.corrupt-${Date.now()}`;
    try { fs.renameSync(CACHE_PATH, backup); } catch { /* ignore */ }
    // eslint-disable-next-line no-console
    console.warn(`[cache] cache.json unreadable (${err.message}); moved to ${backup}`);
    state = {};
  }
  for (const k of ['places_search', 'place_details', 'scrapes', 'analyses', 'pitches', 'enrichments']) {
    if (!state[k]) state[k] = {};
  }
  return state;
}

function flush() {
  if (!dirty || !state) return;
  const tmp = `${CACHE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, CACHE_PATH);
  dirty = false;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 300);
}

export function hashString(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function getKey(table, key) {
  const s = load();
  const entry = s[table][key];
  return entry ? entry.value : null;
}

function putKey(table, key, value) {
  const s = load();
  s[table][key] = { value, fetched_at: Date.now() };
  scheduleFlush();
}

export const cache = {
  getSearch: (q) => getKey('places_search', q),
  putSearch: (q, v) => putKey('places_search', q, v),

  getDetails: (id) => getKey('place_details', id),
  putDetails: (id, v) => putKey('place_details', id, v),

  getScrape: (id) => getKey('scrapes', id),
  putScrape: (id, v) => putKey('scrapes', id, v),

  getAnalysis: (text) => getKey('analyses', hashString(text)),
  putAnalysis: (text, v) => putKey('analyses', hashString(text), v),

  getPitch: (key) => getKey('pitches', key),
  putPitch: (key, text) => putKey('pitches', key, text),

  getEnrichment: (id) => getKey('enrichments', id),
  putEnrichment: (id, v) => putKey('enrichments', id, v),

  flush,
  close: () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush();
    state = null;
  },
};
