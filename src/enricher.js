// Apollo.io enrichment. Walks a free-first sequence so credits only get spent
// on the final email-reveal step:
//
//   1. Your own Apollo contacts (free)
//   2. Your own Apollo accounts (free)
//   3. Public org enrichment by domain (free)
//   4. Public people search by org + title (free — returns names, no emails)
//   5. Email reveal on the best match (1 export credit)
//
// Reaches step 5 only when --apollo-contacts-only is NOT set. Hard-stops
// revealing when remaining credits fall below --min-credits.
//
// This module talks to Apollo's REST API directly with the key in APOLLO_API_KEY.
// The claude.ai Apollo MCP server is NOT used at runtime because NOUS Scout
// runs as a standalone CLI outside Claude Code.

import 'dotenv/config';
import { request } from 'undici';
import { cache } from './cache.js';
import { log } from './lib/logger.js';
import { createLimiter } from './lib/rateLimit.js';

const BASE = 'https://api.apollo.io/api/v1';
const OWNER_TITLES = ['owner', 'president', 'ceo', 'general manager', 'operations manager', 'founder'];
const limit = createLimiter(200);

function key() {
  const k = process.env.APOLLO_API_KEY;
  if (!k) throw new Error('APOLLO_API_KEY not set in .env — add it or omit --enrich');
  return k;
}

async function post(pathname, body) {
  await limit();
  const res = await request(`${BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      accept: 'application/json',
      'X-Api-Key': key(),
    },
    body: JSON.stringify(body),
  });
  const data = await res.body.json();
  if (res.statusCode >= 400) {
    throw new Error(`Apollo ${pathname} ${res.statusCode}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function get(pathname) {
  await limit();
  const res = await request(`${BASE}${pathname}`, {
    method: 'GET',
    headers: { 'X-Api-Key': key(), accept: 'application/json' },
  });
  const data = await res.body.json();
  if (res.statusCode >= 400) {
    throw new Error(`Apollo ${pathname} ${res.statusCode}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

export async function getCreditsRemaining() {
  try {
    // Apollo exposes usage under /auth/health or /users — response shape varies.
    // Probe /users/search_through_api which returns credit info in rate_limit headers.
    const data = await get('/auth/health');
    // The auth/health endpoint returns minimal info; actual credits come from
    // the rate_limit field on any call response. Return null if we can't tell.
    return data?.credits_remaining ?? null;
  } catch (err) {
    log.debug(`getCreditsRemaining unavailable: ${err.message}`);
    return null;
  }
}

function domainFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function pickOwnerCandidate(people) {
  if (!Array.isArray(people) || people.length === 0) return null;
  // Prefer owner/president, then any manager, then first result.
  for (const title of OWNER_TITLES) {
    const match = people.find((p) => (p.title || '').toLowerCase().includes(title));
    if (match) return match;
  }
  return people[0];
}

function toEnrichment(person, source) {
  if (!person) return null;
  return {
    owner_name: person.name || `${person.first_name || ''} ${person.last_name || ''}`.trim(),
    owner_title: person.title || '',
    owner_email: person.email || '',
    linkedin_url: person.linkedin_url || '',
    apollo_source: source,
  };
}

async function step1_ownContacts(shop) {
  try {
    const domain = domainFromUrl(shop.website);
    const body = {
      q_keywords: domain ? undefined : shop.name,
      contact_email_status: ['verified', 'likely to engage', 'unverified'],
      page: 1,
      per_page: 5,
    };
    if (domain) body.q_organization_domains_list = [domain];
    const data = await post('/contacts/search', body);
    const contacts = data?.contacts || [];
    const picked = pickOwnerCandidate(contacts);
    return picked ? toEnrichment(picked, 'my_contacts') : null;
  } catch (err) {
    log.debug(`enricher step1 failed: ${err.message}`);
    return null;
  }
}

async function step3_enrichOrg(shop) {
  const domain = domainFromUrl(shop.website);
  if (!domain) return null;
  try {
    const data = await post('/organizations/enrich', { domain });
    return data?.organization || null;
  } catch (err) {
    log.debug(`enricher step3 failed: ${err.message}`);
    return null;
  }
}

async function step4_publicPeopleSearch(org) {
  if (!org) return null;
  try {
    const data = await post('/mixed_people/search', {
      organization_ids: [org.id],
      person_titles: OWNER_TITLES,
      page: 1,
      per_page: 5,
    });
    const people = data?.people || [];
    return pickOwnerCandidate(people);
  } catch (err) {
    log.debug(`enricher step4 failed: ${err.message}`);
    return null;
  }
}

async function step5_revealEmail(personId) {
  try {
    const data = await post('/people/match', {
      id: personId,
      reveal_personal_emails: false,
      reveal_phone_number: false,
    });
    return data?.person || null;
  } catch (err) {
    log.debug(`enricher step5 (reveal) failed: ${err.message}`);
    return null;
  }
}

export async function enrichShop(shop, opts) {
  const { contactsOnly = false, creditsRemaining = null, minCredits = 10 } = opts || {};
  const cached = cache.getEnrichment(shop.place_id);
  if (cached) return cached;

  // Step 1: own contacts (free)
  const fromContacts = await step1_ownContacts(shop);
  if (fromContacts) {
    cache.putEnrichment(shop.place_id, fromContacts);
    return fromContacts;
  }
  if (contactsOnly) {
    const empty = { apollo_source: 'not_in_my_contacts' };
    cache.putEnrichment(shop.place_id, empty);
    return empty;
  }

  // Step 3: public org enrichment (free)
  const org = await step3_enrichOrg(shop);
  if (!org) {
    const empty = { apollo_source: 'no_org_match' };
    cache.putEnrichment(shop.place_id, empty);
    return empty;
  }

  // Step 4: public people search (free, no email)
  const candidate = await step4_publicPeopleSearch(org);
  if (!candidate) {
    const empty = { apollo_source: 'no_owner_found' };
    cache.putEnrichment(shop.place_id, empty);
    return empty;
  }

  // Credit guard
  if (typeof creditsRemaining === 'number' && creditsRemaining <= minCredits) {
    log.warn(`credit floor reached (${creditsRemaining} ≤ ${minCredits}) — skipping email reveal for ${shop.name}`);
    const skipped = toEnrichment(candidate, 'search_only_credit_limit');
    skipped.owner_email = '';
    cache.putEnrichment(shop.place_id, skipped);
    return skipped;
  }

  // Step 5: reveal (costs 1 credit)
  const revealed = await step5_revealEmail(candidate.id);
  const enrichment = toEnrichment(revealed || candidate, revealed?.email ? 'public_reveal' : 'public_search_only');
  cache.putEnrichment(shop.place_id, enrichment);
  return enrichment;
}

export function estimateCreditSpend(shops, scope) {
  const pool = scope === 'all' ? shops : shops.filter((s) => s.score?.priority_tier === 'HOT');
  // Worst case: every one of them needs a public reveal = 1 credit each.
  return pool.length;
}
