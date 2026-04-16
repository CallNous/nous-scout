// Pure scoring. Reads weights + thresholds from config/scoring.json and
// computes NOUS score, TC score, confidence, priority tier, and TC opportunity.
//
// Every weight is data-driven — to retune, edit config/scoring.json, not this file.

import { loadConfig } from './lib/franchises.js';

function safeBool(v) {
  return v === true;
}

function hoursGapSignal(shop) {
  // Boost when shop is closed nights/weekends AND reviews mention after-hours pain
  const scrape = shop.scrape || {};
  const analysis = shop.analysis || {};
  const noEvening = scrape.has_evening_hours === false;
  const noWeekend = scrape.has_weekend_hours === false;
  const closedSomewhere = noEvening || noWeekend;
  return closedSomewhere && safeBool(analysis?.nous_signals?.after_hours_issues);
}

function computeMaturity(shop) {
  // Estimate business maturity / likely revenue bracket based on available signals.
  // Not exact — but filters out hobby operations from real businesses.
  const reviewCount = shop.review_count || 0;
  const staffNames = shop.analysis?.contact_names || [];
  const staffCount = staffNames.length;
  const ownerCount = staffNames.filter((c) => c.role === 'owner' || c.role === 'manager').length;
  const scrape = shop.scrape || {};
  const hasProSite = scrape.estimated_page_quality === 'professional';
  const hasMedSite = scrape.estimated_page_quality === 'medium';
  const hours = shop.opening_hours;
  const daysOpen = hours?.weekdayDescriptions?.filter((d) => !d.toLowerCase().includes('closed')).length || 0;

  // Review velocity — estimate reviews per year from the 5 most recent
  let reviewsPerYear = 0;
  if (Array.isArray(shop.reviews) && shop.reviews.length >= 2) {
    const times = shop.reviews
      .map((r) => r.time ? new Date(r.time).getTime() : 0)
      .filter((t) => t > 0)
      .sort((a, b) => b - a);
    if (times.length >= 2) {
      const spanMs = times[0] - times[times.length - 1];
      const spanYears = spanMs / (365.25 * 24 * 60 * 60 * 1000);
      if (spanYears > 0.05) reviewsPerYear = Math.round(times.length / spanYears);
    }
  }

  // Revenue bracket estimate
  // ~5-10% of customers leave reviews, avg ticket $250
  // 200+ reviews total w/ active velocity → likely $500K+
  // 500+ reviews → likely $1M+
  let score = 0;
  if (reviewCount >= 500) score += 4;
  else if (reviewCount >= 200) score += 3;
  else if (reviewCount >= 80) score += 2;
  else if (reviewCount >= 30) score += 1;

  if (reviewsPerYear >= 150) score += 3;
  else if (reviewsPerYear >= 60) score += 2;
  else if (reviewsPerYear >= 20) score += 1;

  if (staffCount >= 4) score += 2;
  else if (staffCount >= 2) score += 1;

  if (hasProSite) score += 1;
  else if (hasMedSite) score += 0.5;

  if (daysOpen >= 6) score += 1;

  // Bracket
  let tier, estRevenue;
  if (score >= 8) { tier = 'established'; estRevenue = '$1M+'; }
  else if (score >= 5) { tier = 'growing'; estRevenue = '$500K-1M'; }
  else if (score >= 3) { tier = 'small'; estRevenue = '$250K-500K'; }
  else { tier = 'micro'; estRevenue = '<$250K'; }

  return {
    tier,
    est_revenue: estRevenue,
    review_velocity: reviewsPerYear,
    staff_count: staffCount,
    days_open: daysOpen,
  };
}

function computeConfidence(shop) {
  // 0–100 — how much real signal did we collect?
  let score = 0;
  if (shop.website) score += 15;
  if (shop.scrape && !shop.scrape.site_unreachable) score += 20;
  if (shop.scrape && shop.scrape.body_length > 1500) score += 10;
  if (Array.isArray(shop.reviews) && shop.reviews.length >= 3) score += 15;
  if (Array.isArray(shop.reviews) && shop.reviews.length >= 5) score += 5;
  if (shop.analysis) score += 15;
  if (shop.opening_hours) score += 10;
  if (shop.phone) score += 5;
  if (shop.review_count >= 20) score += 5;
  return Math.min(100, score);
}

export function scoreShop(shop) {
  const cfg = loadConfig();
  const w = cfg.nousWeights;
  const tcw = cfg.tcWeights;

  const scrape = shop.scrape || {};
  const analysis = shop.analysis || {};
  const nous = analysis.nous_signals || {};

  const ratingInSweet =
    typeof shop.rating === 'number' &&
    shop.rating >= cfg.ratingSweetSpot.min &&
    shop.rating <= cfg.ratingSweetSpot.max;
  const establishedVolume = (shop.review_count || 0) >= cfg.establishedReviewCount;
  const hasTcAlready = safeBool(scrape.already_has_tireconnect);

  // NOUS score
  let nousScore = 0;
  const nousReasons = [];
  const add = (cond, key) => {
    if (cond && w[key]) {
      nousScore += w[key];
      nousReasons.push(key);
    }
  };
  add(safeBool(scrape.no_online_booking), 'no_online_booking');
  add(safeBool(nous.missed_calls_mentioned), 'missed_calls_mentioned');
  add(safeBool(nous.after_hours_issues), 'after_hours_issues');
  add(safeBool(scrape.call_for_pricing), 'call_for_pricing');
  add(safeBool(nous.wait_times_mentioned), 'wait_times_mentioned');
  add(safeBool(nous.booking_difficulty), 'booking_difficulty');
  add(safeBool(nous.went_to_competitor), 'went_to_competitor');
  add(ratingInSweet, 'rating_sweet_spot');
  add(establishedVolume, 'established_volume');
  add(hoursGapSignal(shop), 'hours_gap_with_after_hours_complaints');
  add(safeBool(scrape.call_to_book), 'call_to_book');
  nousScore = Math.min(10, nousScore);

  // TC score
  let tcScore = 0;
  const tcReasons = [];
  const addTc = (cond, key) => {
    if (cond && tcw[key]) {
      tcScore += tcw[key];
      tcReasons.push(key);
    }
  };
  addTc(safeBool(scrape.no_tire_catalog), 'no_tire_catalog');
  addTc(safeBool(scrape.static_pricing), 'static_pricing');
  addTc(safeBool(scrape.no_ecommerce), 'no_ecommerce');
  addTc(safeBool(scrape.call_for_pricing), 'call_for_pricing');
  addTc(safeBool(scrape.basic_contact_only), 'basic_contact_only');
  tcScore = Math.min(10, tcScore);

  const notes = [];
  if (hasTcAlready) {
    tcScore = 0;
    notes.push('existing TC customer');
  }
  if (scrape.site_unreachable) notes.push(`site unreachable (${scrape.reason || 'timeout'})`);

  // Tiering
  const tiers = cfg.tiers;
  const priority_tier = nousScore >= tiers.hot ? 'HOT' : nousScore >= tiers.warm ? 'WARM' : 'COLD';

  const tco = cfg.tcOpportunity;
  const tc_opportunity = hasTcAlready
    ? 'NO'
    : tcScore >= tco.yes
      ? 'YES'
      : tcScore >= tco.maybe
        ? 'MAYBE'
        : 'NO';

  const maturity = computeMaturity(shop);

  return {
    nous_score: nousScore,
    tc_score: tcScore,
    confidence: computeConfidence(shop),
    priority_tier,
    tc_opportunity,
    nous_reasons: nousReasons,
    tc_reasons: tcReasons,
    maturity,
    notes: notes.join('; '),
  };
}

async function selftest() {
  const fixture = {
    name: "Joe's Tire",
    website: 'https://example.com',
    rating: 4.0,
    review_count: 120,
    phone: '555-0000',
    opening_hours: { weekday_text: ['Mon: 9am'] },
    reviews: [{ text: 'nobody answers the phone' }],
    scrape: {
      site_unreachable: false,
      body_length: 3000,
      no_online_booking: true,
      call_for_pricing: true,
      no_tire_catalog: true,
      static_pricing: true,
      no_ecommerce: true,
      basic_contact_only: false,
      already_has_tireconnect: false,
      has_weekend_hours: false,
      has_evening_hours: false,
    },
    analysis: {
      nous_signals: {
        missed_calls_mentioned: true,
        after_hours_issues: true,
        wait_times_mentioned: false,
        responsiveness_score: 2,
      },
      general: { overall_sentiment: 'mixed', top_complaint: 'phone issues', top_praise: null },
    },
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(scoreShop(fixture), null, 2));
}

if (process.argv.includes('--selftest')) {
  selftest();
}
