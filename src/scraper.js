// Website signal extractor.
// Cheerio-first, with a Puppeteer escalation path for JS-heavy shells like Wix
// and Squarespace hydrated pages. 8-second hard timeout on the initial fetch.
//
// Output shape matches what scorer.js expects plus a few "richer signal"
// fields that feed the HTML report and pitch generator.

import { request } from 'undici';
import * as cheerio from 'cheerio';
import { log } from './lib/logger.js';

const FETCH_TIMEOUT_MS = 8000;
const MIN_BODY_CHARS = 500;

let puppeteerInstance = null;
async function getPuppeteerBrowser() {
  if (puppeteerInstance) return puppeteerInstance;
  try {
    const puppeteer = await import('puppeteer');
    puppeteerInstance = await puppeteer.default.launch({
      headless: 'new',
      args: ['--no-sandbox'],
    });
    return puppeteerInstance;
  } catch (err) {
    log.warn(`puppeteer unavailable (${err.message}) — JS-heavy sites will be scraped lightly`);
    return null;
  }
}

export async function closeBrowser() {
  if (puppeteerInstance) {
    try {
      await puppeteerInstance.close();
    } catch {
      // ignore
    }
    puppeteerInstance = null;
  }
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await request(url, {
      method: 'GET',
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; NOUS-Scout/0.1; +https://nous.example/scout)',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: ctrl.signal,
      maxRedirections: 3,
    });
    if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);
    return await res.body.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchHtmlWithPuppeteer(url) {
  const browser = await getPuppeteerBrowser();
  if (!browser) return null;
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: FETCH_TIMEOUT_MS * 2 });
    return await page.content();
  } finally {
    await page.close();
  }
}

// Franchise networks that are less obvious than the big chains in the blocklist.
// These shops look independent but are part of a network — flag them.
const FRANCHISE_NETWORKS = [
  { pattern: /tirecraft/i, name: 'Tirecraft' },
  { pattern: /signature\s*tire/i, name: 'Signature Tire' },
  { pattern: /point\s*s\b/i, name: 'Point S' },
  { pattern: /tbc\s*(brands|corporation)/i, name: 'TBC Brands' },
  { pattern: /monro\.com/i, name: 'Monro' },
  { pattern: /active\s*green/i, name: 'Active Green+Ross' },
  { pattern: /integra\s*tire/i, name: 'Integra Tire' },
  { pattern: /trail\s*tire/i, name: 'Trail Tire' },
  { pattern: /autopro\b/i, name: 'NAPA Autopro' },
  { pattern: /carquest/i, name: 'Carquest' },
  { pattern: /certified\s*auto\s*repair/i, name: 'Certified Auto Repair' },
  { pattern: /technet/i, name: 'TechNet' },
];

function detectFranchiseNetwork(html, url) {
  const fullText = html + ' ' + (url || '');
  for (const f of FRANCHISE_NETWORKS) {
    if (f.pattern.test(fullText)) return f.name;
  }
  return null;
}

function detectPlatform(html, headers = {}) {
  const h = html.toLowerCase();
  if (h.includes('wix.com') || h.includes('_wix')) return 'Wix';
  if (h.includes('squarespace')) return 'Squarespace';
  if (h.includes('shopify')) return 'Shopify';
  if (h.includes('wp-content') || h.includes('wordpress')) return 'WordPress';
  if (h.includes('webflow')) return 'Webflow';
  if (h.includes('godaddy') || h.includes('dpbolvw')) return 'GoDaddy';
  return 'custom';
}

function extractSocialLinks($) {
  const out = { facebook: null, instagram: null, youtube: null, tiktok: null };
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').toLowerCase();
    if (!out.facebook && href.includes('facebook.com/')) out.facebook = $(el).attr('href');
    if (!out.instagram && href.includes('instagram.com/')) out.instagram = $(el).attr('href');
    if (!out.youtube && href.includes('youtube.com/')) out.youtube = $(el).attr('href');
    if (!out.tiktok && href.includes('tiktok.com/')) out.tiktok = $(el).attr('href');
  });
  return out;
}

function extractEmails(html) {
  // Pull from mailto: links first (most reliable), then fall back to body text
  const $ = cheerio.load(html);
  const fromMailto = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const email = href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (email && email.includes('@')) fromMailto.push(email);
  });

  // Also scan body text, but more carefully — require word boundaries
  const bodyText = $('body').text();
  const fromText = (bodyText.match(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,6}\b/gi) || [])
    .map((m) => m.toLowerCase());

  const all = [...fromMailto, ...fromText];
  // Dedupe and filter junk (sentry, wixpress, internal tracking pixels)
  const junk = ['sentry', 'wixpress', 'getnetdriven', 'cloudflare', 'googleapis'];
  return [...new Set(all)]
    .filter((e) => !junk.some((j) => e.includes(j)))
    .slice(0, 3);
}

function analyzeHtml(html, url) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const lc = bodyText.toLowerCase();
  const fullLc = html.toLowerCase();

  const hasBooking =
    /calendly\.com|book(ing)?\s+(now|online|appointment)|schedule(\s+an?)?\s+appointment|appointment\s+form/i.test(
      html
    ) ||
    $('a[href*="calendly"], a[href*="book"], form[action*="book"]').length > 0;

  const callForPricing = /call\s+(us\s+)?for\s+(pricing|quote|a\s+quote|details)|call\s+for\s+price/i.test(
    bodyText
  );

  const hasHours =
    /\b(mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?|sun(day)?)\b[\s:]+\d/i.test(
      bodyText
    ) ||
    $('[itemprop="openingHours"], [class*="hours"], [id*="hours"]').length > 0;

  const hasServiceDetail =
    /(tire\s+(installation|rotation|balancing|change|repair)|alignment|brake|oil\s+change|wheel\s+alignment|seasonal\s+storage)/i.test(
      bodyText
    );

  const tireCatalogSignals = /(shop\s+tires|buy\s+tires|tire\s+(catalog|catalogue|finder)|browse\s+tires|tire\s+inventory)/i.test(
    bodyText
  );
  const hasTireConnect = fullLc.includes('tireconnect');

  const staticPricing =
    /price\s+list|price\s+sheet|\.pdf"[^>]*price|download\s+our\s+(price|tire)/i.test(html);

  const hasEcommerce =
    /add\s+to\s+cart|checkout|shopping\s+cart|your\s+cart|cart\(0\)/i.test(html) ||
    $('form[action*="cart"], button[class*="cart"]').length > 0;

  const basicContactOnly = !hasServiceDetail && bodyText.length < 2000;

  // NOUS-specific: site says "call to book" or "call to schedule" — no self-serve booking
  const callToBook = /call\s+(us\s+)?(to\s+)?(book|schedule|make\s+an?\s+appointment)|phone\s+us\s+to\s+(book|schedule)|give\s+us\s+a\s+call\s+to\s+(book|schedule)/i.test(
    bodyText
  );

  // No SMS/text contact option
  const hasTextContact = /text\s+us|sms|send\s+(us\s+)?a\s+text|message\s+us|chat\s+with\s+us|live\s+chat/i.test(
    bodyText
  ) || $('a[href^="sms:"]').length > 0;

  const weekendHoursGuess = /sat(urday)?[\s:-]*(closed)/i.test(bodyText);
  const hasWeekendHours = /sat(urday)?[\s:]+\d/i.test(bodyText) || /sun(day)?[\s:]+\d/i.test(bodyText);
  const hasEveningHours = /(5|6|7|8|9)\s*(pm|p\.m\.)/i.test(bodyText);

  return {
    site_unreachable: false,
    page_title: ($('title').first().text() || '').trim().slice(0, 200),
    meta_description: ($('meta[name="description"]').attr('content') || '').slice(0, 300),
    has_ssl: url.startsWith('https://'),
    platform_detected: detectPlatform(html),
    franchise_network: detectFranchiseNetwork(html, url),
    social_links: extractSocialLinks($),
    mailto_emails: extractEmails(bodyText).slice(0, 5),

    // NOUS signals
    no_online_booking: !hasBooking,
    call_for_pricing: callForPricing,
    call_to_book: callToBook,
    no_text_contact: !hasTextContact,
    no_hours_listed: !hasHours,
    basic_contact_only: basicContactOnly,

    // TC signals
    no_tire_catalog: !tireCatalogSignals,
    already_has_tireconnect: hasTireConnect,
    static_pricing: staticPricing,
    no_ecommerce: !hasEcommerce,

    // Scheduling gaps (inform the hours_gap boost)
    has_weekend_hours: hasWeekendHours && !weekendHoursGuess,
    has_evening_hours: hasEveningHours,

    // Rough quality heuristic
    estimated_page_quality:
      bodyText.length > 3000 && $('img').length > 5 && $('nav, header').length > 0
        ? 'professional'
        : bodyText.length > 1200
          ? 'medium'
          : 'basic',

    body_length: bodyText.length,
  };
}

export async function scrapeSite(url) {
  if (!url) return { site_unreachable: true, reason: 'no_url' };
  try {
    let html = await fetchHtml(url);
    let signals = analyzeHtml(html, url);
    // Escalate if body too sparse (suggests JS-rendered shell)
    if (signals.body_length < MIN_BODY_CHARS) {
      log.debug(`sparse body (${signals.body_length}) — escalating to puppeteer: ${url}`);
      const puppeteerHtml = await fetchHtmlWithPuppeteer(url);
      if (puppeteerHtml) {
        html = puppeteerHtml;
        signals = analyzeHtml(html, url);
      }
    }
    return signals;
  } catch (err) {
    log.warn(`scrape failed: ${url} — ${err.message}`);
    return { site_unreachable: true, reason: err.message };
  }
}

async function selftest() {
  const url = process.argv[process.argv.indexOf('--selftest') + 1] || 'https://example.com';
  const out = await scrapeSite(url);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
  await closeBrowser();
}

if (process.argv.includes('--selftest')) {
  selftest().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
