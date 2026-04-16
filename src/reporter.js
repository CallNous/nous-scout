// Output writer: CSV, interactive HTML, and (when --enrich is on) a second
// Apollo-import-ready CSV shaped for sequence import.
//
// HTML report is a single self-contained file with inline CSS + ~60 lines of
// vanilla JS for sortable columns and tier filtering. No external deps, no
// build step, opens straight from file://.

import fs from 'node:fs';
import path from 'node:path';
import { createObjectCsvWriter } from 'csv-writer';

function sanitizeFilename(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function flattenShop(shop) {
  const score = shop.score || {};
  const analysis = shop.analysis || {};
  const general = analysis.general || {};
  const nous = analysis.nous_signals || {};
  const scrape = shop.scrape || {};
  const enrichment = shop.enrichment || {};
  return {
    priority_tier: score.priority_tier || '',
    shop_name: shop.name || '',
    address: shop.address || '',
    phone: shop.phone || '',
    website: shop.website || '',
    rating: shop.rating ?? '',
    review_count: shop.review_count || 0,
    nous_score: score.nous_score ?? '',
    tc_score: score.tc_score ?? '',
    tc_opportunity: score.tc_opportunity || '',
    confidence: score.confidence ?? '',
    missed_calls_mentioned: nous.missed_calls_mentioned ?? '',
    after_hours_issues: nous.after_hours_issues ?? '',
    wait_times_mentioned: nous.wait_times_mentioned ?? '',
    no_online_booking: scrape.no_online_booking ?? '',
    no_tire_catalog: scrape.no_tire_catalog ?? '',
    already_has_tireconnect: scrape.already_has_tireconnect ?? '',
    platform_detected: scrape.platform_detected || '',
    overall_sentiment: general.overall_sentiment || '',
    reachability_complaint: general.reachability_complaint || general.reachability_complaint || '',
    top_praise: general.top_praise || '',
    shop_email: (shop.scrape?.mailto_emails || []).filter(Boolean).join(', ') || '',
    contact_names: (shop.analysis?.contact_names || []).map((c) => `${c.name}${c.role && c.role !== 'unknown' ? ` (${c.role})` : ''}`).join(', ') || '',
    maturity_tier: score.maturity?.tier || '',
    est_revenue: score.maturity?.est_revenue || '',
    review_velocity: score.maturity?.review_velocity ?? '',
    staff_count: score.maturity?.staff_count ?? '',
    franchise_network: (shop.scrape?.franchise_network) || '',
    nous_pitch: shop.pitch || '',
    tc_pitch: shop.tc_pitch || '',
    owner_name: enrichment.owner_name || '',
    owner_title: enrichment.owner_title || '',
    owner_email: enrichment.owner_email || '',
    linkedin_url: enrichment.linkedin_url || '',
    apollo_source: enrichment.apollo_source || '',
    notes: score.notes || '',
    google_url: shop.google_url || '',
  };
}

const CSV_HEADERS = [
  'priority_tier', 'shop_name', 'address', 'phone', 'website', 'rating', 'review_count',
  'nous_score', 'tc_score', 'tc_opportunity', 'confidence',
  'missed_calls_mentioned', 'after_hours_issues', 'wait_times_mentioned',
  'no_online_booking', 'no_tire_catalog', 'already_has_tireconnect', 'platform_detected',
  'overall_sentiment', 'reachability_complaint', 'top_praise',
  'maturity_tier', 'est_revenue', 'review_velocity', 'staff_count', 'franchise_network',
  'contact_names', 'shop_email', 'nous_pitch', 'tc_pitch',
  'owner_name', 'owner_title', 'owner_email', 'linkedin_url', 'apollo_source',
  'notes', 'google_url',
];

export async function writeCsv(shops, filePath) {
  const writer = createObjectCsvWriter({
    path: filePath,
    header: CSV_HEADERS.map((id) => ({ id, title: id })),
  });
  const rows = shops.map(flattenShop);
  await writer.writeRecords(rows);
  return filePath;
}

export async function writeApolloCsv(shops, filePath) {
  // Apollo's sequence-import CSV expects these columns
  const enrichedShops = shops.filter((s) => s.enrichment && s.enrichment.owner_email);
  const writer = createObjectCsvWriter({
    path: filePath,
    header: [
      { id: 'first_name', title: 'First Name' },
      { id: 'last_name', title: 'Last Name' },
      { id: 'email', title: 'Email' },
      { id: 'title', title: 'Title' },
      { id: 'company', title: 'Company' },
      { id: 'website', title: 'Website' },
      { id: 'phone', title: 'Phone' },
      { id: 'city', title: 'City' },
      { id: 'state', title: 'State' },
      { id: 'linkedin_url', title: 'LinkedIn URL' },
      { id: 'nous_score', title: 'NOUS Score' },
      { id: 'tc_score', title: 'TC Score' },
      { id: 'nous_pitch', title: 'NOUS Pitch' },
      { id: 'tc_pitch', title: 'TC Pitch' },
    ],
  });
  const rows = enrichedShops.map((s) => {
    const [first, ...rest] = (s.enrichment.owner_name || '').split(' ');
    return {
      first_name: first || '',
      last_name: rest.join(' '),
      email: s.enrichment.owner_email,
      title: s.enrichment.owner_title || '',
      company: s.name,
      website: s.website || '',
      phone: s.phone || '',
      city: s.cityInput || '',
      state: s.provinceInput || '',
      linkedin_url: s.enrichment.linkedin_url || '',
      nous_score: s.score?.nous_score ?? '',
      tc_score: s.score?.tc_score ?? '',
      nous_pitch: s.pitch || '',
      tc_pitch: s.tc_pitch || '',
    };
  });
  await writer.writeRecords(rows);
  return filePath;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tierClass(t) {
  if (t === 'HOT') return 'tier-hot';
  if (t === 'WARM') return 'tier-warm';
  return 'tier-cold';
}

export function renderHtml(shops, meta) {
  const hotCount = shops.filter((s) => s.score?.priority_tier === 'HOT').length;
  const warmCount = shops.filter((s) => s.score?.priority_tier === 'WARM').length;
  const coldCount = shops.filter((s) => s.score?.priority_tier === 'COLD').length;
  const tcYes = shops.filter((s) => s.score?.tc_opportunity === 'YES').length;
  const existingTc = shops.filter((s) => s.scrape?.already_has_tireconnect).length;

  const rows = shops
    .slice()
    .sort((a, b) => (b.score?.nous_score || 0) - (a.score?.nous_score || 0))
    .map((s) => {
      const f = flattenShop(s);
      const existingRow = s.scrape?.already_has_tireconnect ? ' row-existing-tc' : '';
      return `<tr class="${tierClass(f.priority_tier)}${existingRow}" data-tier="${f.priority_tier}" data-tc="${esc(f.tc_opportunity)}">
        <td><span class="tier-badge ${tierClass(f.priority_tier)}">${esc(f.priority_tier)}</span></td>
        <td><strong>${esc(f.shop_name)}</strong><br><small>${esc(f.address)}</small></td>
        <td class="num">${esc(f.nous_score)}</td>
        <td class="num">${esc(f.tc_score)}</td>
        <td class="num">${esc(f.confidence)}</td>
        <td>${esc(f.rating)}<br><small>(${esc(f.review_count)})</small></td>
        <td><span class="maturity-${f.maturity_tier}">${esc(f.est_revenue)}</span>${f.franchise_network ? `<br><small class="franchise-flag">${esc(f.franchise_network)}</small>` : ''}</td>
        <td>${f.website ? `<a href="${esc(f.website)}" target="_blank" rel="noopener">site</a>` : '—'} ${f.phone ? `<br><small>${esc(f.phone)}</small>` : ''}${f.shop_email ? `<br><small><a href="mailto:${esc(f.shop_email.split(',')[0])}">${esc(f.shop_email.split(',')[0])}</a></small>` : ''}</td>
        <td><em>${esc(f.reachability_complaint || '—')}</em></td>
        <td class="pitch">${esc(f.nous_pitch || '—')}</td>
        <td class="pitch">${esc(f.tc_pitch || '—')}</td>
        <td>${f.contact_names || f.owner_name ? `${esc(f.contact_names || f.owner_name)}${f.owner_email ? `<br><small>${esc(f.owner_email)}</small>` : ''}` : '—'}</td>
        <td><small>${esc(f.notes)}</small></td>
      </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>NOUS Scout — ${esc(meta.city)}, ${esc(meta.province)}</title>
<style>
  body { font: 14px/1.4 -apple-system, system-ui, sans-serif; margin: 0; background: #f5f6f8; color: #1a1a1a; }
  header { background: #111; color: white; padding: 20px 28px; }
  header h1 { margin: 0 0 6px; font-size: 22px; }
  header .meta { opacity: 0.75; font-size: 13px; }
  .summary { display: flex; gap: 20px; margin-top: 12px; flex-wrap: wrap; }
  .stat { background: rgba(255,255,255,0.08); padding: 8px 14px; border-radius: 6px; }
  .stat .n { font-size: 20px; font-weight: 600; display: block; }
  .stat .l { font-size: 11px; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.5px; }
  .controls { padding: 14px 28px; background: white; border-bottom: 1px solid #e5e7eb; display: flex; gap: 8px; align-items: center; }
  .controls button { border: 1px solid #d1d5db; background: white; padding: 6px 12px; border-radius: 4px; font-size: 13px; cursor: pointer; }
  .controls button.active { background: #111; color: white; border-color: #111; }
  .filter-label { font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
  .divider { width: 1px; height: 24px; background: #e5e7eb; margin: 0 8px; }
  .controls input { padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; flex: 1; max-width: 300px; }
  table { width: 100%; border-collapse: collapse; background: white; font-size: 13px; }
  th { text-align: left; background: #f9fafb; padding: 10px 12px; border-bottom: 2px solid #e5e7eb; font-weight: 600; cursor: pointer; user-select: none; position: sticky; top: 0; }
  th:hover { background: #f3f4f6; }
  td { padding: 12px; border-bottom: 1px solid #f1f2f4; vertical-align: top; }
  td.num { text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; }
  tr.tier-hot { background: #fef2f2; }
  tr.tier-warm { background: #fffbeb; }
  tr.tier-cold { background: white; }
  tr.row-existing-tc { background: #eff6ff !important; }
  .tier-badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; }
  .tier-badge.tier-hot { background: #dc2626; color: white; }
  .tier-badge.tier-warm { background: #f59e0b; color: white; }
  .tier-badge.tier-cold { background: #9ca3af; color: white; }
  .maturity-established { color: #15803d; font-weight: 600; }
  .maturity-growing { color: #2563eb; font-weight: 600; }
  .maturity-small { color: #9ca3af; }
  .maturity-micro { color: #d1d5db; }
  .maturity-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .maturity-badge.maturity-established { background: #dcfce7; color: #15803d; }
  .maturity-badge.maturity-growing { background: #dbeafe; color: #2563eb; }
  .maturity-badge.maturity-small { background: #f3f4f6; color: #6b7280; }
  .maturity-badge.maturity-micro { background: #f9fafb; color: #9ca3af; }
  .franchise-flag { color: #dc2626; font-weight: 600; }
  td.pitch { max-width: 320px; font-style: italic; color: #374151; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  small { color: #6b7280; }
  tr.hidden { display: none; }
  .view-toggle { padding: 10px 28px; background: #f9fafb; border-bottom: 2px solid #e5e7eb; display: flex; gap: 0; }
  .view-toggle button { padding: 10px 20px; border: none; background: none; font-size: 14px; font-weight: 600; cursor: pointer; color: #6b7280; border-bottom: 2px solid transparent; margin-bottom: -2px; }
  .view-toggle button.active { color: #111; border-bottom-color: #111; }
  .view-table, .view-calls { display: none; }
  .view-table.active, .view-calls.active { display: block; }
  .call-list { max-width: 800px; margin: 20px auto; padding: 0 16px; }
  .call-card { background: white; border-radius: 8px; padding: 16px 20px; margin-bottom: 12px; border: 1px solid #e5e7eb; }
  .call-card.tier-hot { border-left: 4px solid #dc2626; }
  .call-card.tier-warm { border-left: 4px solid #f59e0b; }
  .call-card.tier-cold { border-left: 4px solid #d1d5db; }
  .call-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .call-rank { font-size: 12px; color: #9ca3af; font-weight: 600; }
  .call-scores { font-size: 12px; color: #6b7280; margin-left: auto; }
  .tc-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; background: #2563eb; color: white; }
  .call-name { font-size: 17px; font-weight: 600; margin-bottom: 2px; }
  .call-address { font-size: 13px; color: #6b7280; margin-bottom: 10px; }
  .call-actions { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .call-btn { display: inline-flex; align-items: center; padding: 8px 18px; background: #16a34a; color: white; border-radius: 6px; font-weight: 600; font-size: 14px; text-decoration: none; }
  .call-btn:hover { background: #15803d; text-decoration: none; }
  .email-btn { display: inline-flex; padding: 8px 14px; background: #2563eb; color: white; border-radius: 6px; font-size: 13px; font-weight: 600; text-decoration: none; }
  .site-btn { display: inline-flex; padding: 8px 14px; background: #f3f4f6; color: #374151; border-radius: 6px; font-size: 13px; font-weight: 600; text-decoration: none; border: 1px solid #d1d5db; }
  .call-contact { font-size: 13px; margin-bottom: 6px; color: #2563eb; font-weight: 500; }
  .call-signal { font-size: 13px; margin-bottom: 6px; color: #b91c1c; }
  .call-pitch { font-size: 13px; margin-bottom: 4px; color: #374151; line-height: 1.5; }
  .call-meta { font-size: 12px; color: #9ca3af; margin-top: 8px; }
  .call-notes { margin-top: 10px; }
  .notes-input { width: 100%; padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; font-family: inherit; resize: vertical; color: #374151; }
  .notes-input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.1); }
  .notes-saved { font-size: 11px; color: #16a34a; margin-top: 3px; opacity: 0; transition: opacity 0.3s; }
  .notes-saved.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <h1>NOUS Scout — ${esc(meta.city)}, ${esc(meta.province)}</h1>
  <div class="meta">Run at ${esc(meta.runAt)} · ${shops.length} shops analyzed</div>
  <div class="summary">
    <div class="stat"><span class="n">${hotCount}</span><span class="l">HOT</span></div>
    <div class="stat"><span class="n">${warmCount}</span><span class="l">Warm</span></div>
    <div class="stat"><span class="n">${coldCount}</span><span class="l">Cold</span></div>
    <div class="stat"><span class="n">${tcYes}</span><span class="l">TC Opportunities</span></div>
    <div class="stat"><span class="n">${existingTc}</span><span class="l">Existing TC</span></div>
  </div>
</header>
<div class="view-toggle">
  <button class="active" data-view="table">Full Table</button>
  <button data-view="calls">Call List</button>
</div>
<div class="controls">
  <span class="filter-label">NOUS:</span>
  <button data-filter="ALL" class="active">All</button>
  <button data-filter="HOT">HOT</button>
  <button data-filter="WARM">WARM</button>
  <button data-filter="COLD">COLD</button>
  <span class="divider"></span>
  <span class="filter-label">TC:</span>
  <button data-tc-filter="ALL" class="active">All</button>
  <button data-tc-filter="YES">YES</button>
  <button data-tc-filter="MAYBE">MAYBE</button>
  <button data-tc-filter="NO">NO</button>
  <input type="search" id="search" placeholder="Filter by name, address, pitch…">
</div>
<div class="view-table active">
<table id="shops">
<thead>
<tr>
  <th data-sort="tier">Tier</th>
  <th data-sort="name">Shop</th>
  <th data-sort="nous">NOUS</th>
  <th data-sort="tc">TC</th>
  <th data-sort="conf">Conf</th>
  <th data-sort="rating">Rating</th>
  <th data-sort="revenue">Size</th>
  <th>Contact</th>
  <th>Reachability Issue</th>
  <th>NOUS Pitch</th>
  <th>TC Pitch</th>
  <th>Key People</th>
  <th>Notes</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</div>
<div class="view-calls">
<div class="call-list">
${renderCallList(shops)}
</div>
</div>
<script>
(function(){
  var tierBtns = document.querySelectorAll('.controls button[data-filter]');
  var tcBtns = document.querySelectorAll('.controls button[data-tc-filter]');
  var rows = document.querySelectorAll('#shops tbody tr');
  var search = document.getElementById('search');
  var activeFilter = 'ALL';
  var activeTcFilter = 'ALL';
  function apply() {
    var q = search.value.toLowerCase();
    rows.forEach(function(r){
      var tierOk = activeFilter === 'ALL' || r.dataset.tier === activeFilter;
      var tcOk = activeTcFilter === 'ALL' || r.dataset.tc === activeTcFilter;
      var text = r.textContent.toLowerCase();
      var matchQ = !q || text.indexOf(q) >= 0;
      r.classList.toggle('hidden', !(tierOk && tcOk && matchQ));
    });
  }
  tierBtns.forEach(function(b){
    b.addEventListener('click', function(){
      tierBtns.forEach(function(x){ x.classList.remove('active'); });
      b.classList.add('active');
      activeFilter = b.dataset.filter;
      apply();
    });
  });
  tcBtns.forEach(function(b){
    b.addEventListener('click', function(){
      tcBtns.forEach(function(x){ x.classList.remove('active'); });
      b.classList.add('active');
      activeTcFilter = b.dataset.tcFilter;
      apply();
    });
  });
  search.addEventListener('input', apply);

  // Notes persistence (localStorage)
  var NOTES_KEY = 'nous-scout-notes';
  function loadNotes() { try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '{}'); } catch { return {}; } }
  function saveNotes(notes) { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); }
  document.querySelectorAll('.notes-input').forEach(function(ta) {
    var shop = ta.dataset.shop;
    var notes = loadNotes();
    if (notes[shop]) ta.value = notes[shop];
    ta.addEventListener('input', function() {
      var n = loadNotes();
      n[shop] = ta.value;
      saveNotes(n);
    });
  });

  // View toggle (table vs call list)
  document.querySelectorAll('.view-toggle button').forEach(function(b){
    b.addEventListener('click', function(){
      document.querySelectorAll('.view-toggle button').forEach(function(x){ x.classList.remove('active'); });
      b.classList.add('active');
      var v = b.dataset.view;
      document.querySelector('.view-table').classList.toggle('active', v === 'table');
      document.querySelector('.view-calls').classList.toggle('active', v === 'calls');
      document.querySelector('.controls').style.display = v === 'table' ? 'flex' : 'none';
    });
  });

  var sortDir = {};
  document.querySelectorAll('th[data-sort]').forEach(function(th, idx){
    th.addEventListener('click', function(){
      var dir = sortDir[idx] = !sortDir[idx];
      var tbody = document.querySelector('#shops tbody');
      var sorted = Array.from(tbody.querySelectorAll('tr')).sort(function(a,b){
        var av = a.cells[idx].textContent.trim();
        var bv = b.cells[idx].textContent.trim();
        var an = parseFloat(av), bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) return dir ? an-bn : bn-an;
        return dir ? av.localeCompare(bv) : bv.localeCompare(av);
      });
      sorted.forEach(function(r){ tbody.appendChild(r); });
    });
  });
})();
</script>
</body>
</html>`;
}

function renderCallList(shops) {
  // Sort: WARM first, then by NOUS score desc, then TC score desc
  const tierOrder = { HOT: 0, WARM: 1, COLD: 2 };
  const sorted = shops
    .filter((s) => s.phone)
    .slice()
    .sort((a, b) => {
      const ta = tierOrder[a.score?.priority_tier] ?? 3;
      const tb = tierOrder[b.score?.priority_tier] ?? 3;
      if (ta !== tb) return ta - tb;
      const na = (b.score?.nous_score || 0) - (a.score?.nous_score || 0);
      if (na !== 0) return na;
      return (b.score?.tc_score || 0) - (a.score?.tc_score || 0);
    });

  return sorted.map((s, i) => {
    const f = flattenShop(s);
    const phone = f.phone.replace(/[^0-9+]/g, '');
    const hasTc = f.tc_opportunity === 'YES' || f.tc_opportunity === 'MAYBE';
    return `
    <div class="call-card ${tierClass(f.priority_tier)}" data-tier="${f.priority_tier}" data-tc="${f.tc_opportunity}">
      <div class="call-header">
        <span class="call-rank">#${i + 1}</span>
        <span class="tier-badge ${tierClass(f.priority_tier)}">${esc(f.priority_tier)}</span>
        ${hasTc ? `<span class="tc-badge">TC ${esc(f.tc_opportunity)}</span>` : ''}
        <span class="maturity-badge maturity-${f.maturity_tier}">${esc(f.est_revenue)}</span>
        <span class="call-scores">NOUS ${esc(f.nous_score)} · TC ${esc(f.tc_score)} · Conf ${esc(f.confidence)}</span>
      </div>
      <div class="call-name">${esc(f.shop_name)}</div>
      <div class="call-address">${esc(f.address)}</div>
      <div class="call-actions">
        <a href="tel:${phone}" class="call-btn">Call ${esc(f.phone)}</a>
        ${f.shop_email ? `<a href="mailto:${esc(f.shop_email.split(',')[0])}" class="email-btn">Email</a>` : ''}
        ${f.website ? `<a href="${esc(f.website)}" target="_blank" class="site-btn">Website</a>` : ''}
      </div>
      ${f.contact_names ? `<div class="call-contact"><strong>Ask for:</strong> ${esc(f.contact_names)}</div>` : ''}
      ${f.reachability_complaint ? `<div class="call-signal"><strong>Reachability:</strong> ${esc(f.reachability_complaint)}</div>` : ''}
      ${f.nous_pitch ? `<div class="call-pitch"><strong>NOUS opener:</strong> <em>${esc(f.nous_pitch)}</em></div>` : ''}
      ${f.tc_pitch ? `<div class="call-pitch"><strong>TC opener:</strong> <em>${esc(f.tc_pitch)}</em></div>` : ''}
      <div class="call-meta">${esc(f.rating)} rating · ${esc(f.review_count)} reviews · ~${esc(f.review_velocity)} reviews/yr · ${esc(f.staff_count)} staff${f.franchise_network ? ` · <span class="franchise-flag">${esc(f.franchise_network)} network</span>` : ''}${f.platform_detected ? ` · ${esc(f.platform_detected)} site` : ''}</div>
      <div class="call-notes">
        <textarea class="notes-input" data-shop="${esc(f.shop_name)}" placeholder="Call notes / next steps…" rows="2"></textarea>
      </div>
    </div>`;
  }).join('\n');
}

export function writeHtml(shops, filePath, meta) {
  fs.writeFileSync(filePath, renderHtml(shops, meta), 'utf8');
  return filePath;
}

export function makeRunLabel(city, province) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `${sanitizeFilename(city)}-${sanitizeFilename(province)}-${ts}`;
}

export function outputPaths(city, province) {
  const label = makeRunLabel(city, province);
  const dir = path.resolve('output');
  fs.mkdirSync(dir, { recursive: true });
  return {
    label,
    csv: path.join(dir, `${label}.csv`),
    html: path.join(dir, `${label}.html`),
    apolloCsv: path.join(dir, `${label}-apollo.csv`),
  };
}

export function writeCombinedHtml(cityResults, filePath) {
  // cityResults = [{ city, province, shops }, ...]
  const allShops = cityResults.flatMap((c) => c.shops);
  const totalHot = allShops.filter((s) => s.score?.priority_tier === 'HOT').length;
  const totalWarm = allShops.filter((s) => s.score?.priority_tier === 'WARM').length;
  const totalTcYes = allShops.filter((s) => s.score?.tc_opportunity === 'YES').length;
  const ts = new Date().toLocaleString();

  // Build city tabs
  const cityTabs = cityResults.map((c, i) => {
    const hot = c.shops.filter((s) => s.score?.priority_tier === 'HOT').length;
    const warm = c.shops.filter((s) => s.score?.priority_tier === 'WARM').length;
    const badge = hot > 0 ? ` <span class="tab-hot">${hot}</span>` : warm > 0 ? ` <span class="tab-warm">${warm}</span>` : '';
    return `<button class="city-tab${i === 0 ? ' active' : ''}" data-city="${i}">${esc(c.city)}${badge}</button>`;
  }).join('\n');

  // "All GTA" combined tab
  const allTab = `<button class="city-tab" data-city="all">All GTA <span class="tab-hot">${totalHot}</span></button>`;

  // Build per-city call lists
  const cityPanels = cityResults.map((c, i) => {
    return `<div class="city-panel${i === 0 ? ' active' : ''}" data-city="${i}">
      <div class="city-header">
        <h2>${esc(c.city)}, ${esc(c.province)}</h2>
        <span>${c.shops.length} shops · ${c.shops.filter(s => s.score?.priority_tier === 'HOT').length} HOT · ${c.shops.filter(s => s.score?.priority_tier === 'WARM').length} WARM · ${c.shops.filter(s => s.score?.tc_opportunity === 'YES').length} TC</span>
      </div>
      <div class="call-list">${renderCallList(c.shops)}</div>
    </div>`;
  }).join('\n');

  // All-GTA panel (sorted by priority across all cities)
  const allPanel = `<div class="city-panel" data-city="all">
    <div class="city-header">
      <h2>All GTA</h2>
      <span>${allShops.length} shops · ${totalHot} HOT · ${totalWarm} WARM · ${totalTcYes} TC</span>
    </div>
    <div class="call-list">${renderCallList(allShops)}</div>
  </div>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>NOUS Scout — GTA Combined</title>
<style>
  body { font: 14px/1.4 -apple-system, system-ui, sans-serif; margin: 0; background: #f5f6f8; color: #1a1a1a; }
  header { background: #111; color: white; padding: 20px 28px; }
  header h1 { margin: 0 0 6px; font-size: 22px; }
  header .meta { opacity: 0.75; font-size: 13px; }
  .summary { display: flex; gap: 20px; margin-top: 12px; flex-wrap: wrap; }
  .stat { background: rgba(255,255,255,0.08); padding: 8px 14px; border-radius: 6px; }
  .stat .n { font-size: 20px; font-weight: 600; display: block; }
  .stat .l { font-size: 11px; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.5px; }
  .city-tabs { display: flex; gap: 0; padding: 0 28px; background: white; border-bottom: 2px solid #e5e7eb; overflow-x: auto; }
  .city-tab { padding: 12px 18px; border: none; background: none; font-size: 13px; font-weight: 600; cursor: pointer; color: #6b7280; border-bottom: 2px solid transparent; margin-bottom: -2px; white-space: nowrap; }
  .city-tab.active { color: #111; border-bottom-color: #111; }
  .city-tab:hover { color: #374151; }
  .tab-hot { background: #dc2626; color: white; font-size: 10px; padding: 1px 5px; border-radius: 8px; margin-left: 4px; }
  .tab-warm { background: #f59e0b; color: white; font-size: 10px; padding: 1px 5px; border-radius: 8px; margin-left: 4px; }
  .city-panel { display: none; }
  .city-panel.active { display: block; }
  .city-header { padding: 16px 28px; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; gap: 16px; }
  .city-header h2 { margin: 0; font-size: 18px; }
  .city-header span { font-size: 13px; color: #6b7280; }
  .call-list { max-width: 800px; margin: 20px auto; padding: 0 16px; }
  .call-card { background: white; border-radius: 8px; padding: 16px 20px; margin-bottom: 12px; border: 1px solid #e5e7eb; }
  .call-card.tier-hot { border-left: 4px solid #dc2626; }
  .call-card.tier-warm { border-left: 4px solid #f59e0b; }
  .call-card.tier-cold { border-left: 4px solid #d1d5db; }
  .call-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .call-rank { font-size: 12px; color: #9ca3af; font-weight: 600; }
  .call-scores { font-size: 12px; color: #6b7280; margin-left: auto; }
  .tier-badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; }
  .tier-badge.tier-hot { background: #dc2626; color: white; }
  .tier-badge.tier-warm { background: #f59e0b; color: white; }
  .tier-badge.tier-cold { background: #9ca3af; color: white; }
  .tc-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; background: #2563eb; color: white; }
  .maturity-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .maturity-badge.maturity-established { background: #dcfce7; color: #15803d; }
  .maturity-badge.maturity-growing { background: #dbeafe; color: #2563eb; }
  .maturity-badge.maturity-small { background: #f3f4f6; color: #6b7280; }
  .maturity-badge.maturity-micro { background: #f9fafb; color: #9ca3af; }
  .franchise-flag { color: #dc2626; font-weight: 600; }
  .call-name { font-size: 17px; font-weight: 600; margin-bottom: 2px; }
  .call-address { font-size: 13px; color: #6b7280; margin-bottom: 10px; }
  .call-actions { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .call-btn { display: inline-flex; align-items: center; padding: 8px 18px; background: #16a34a; color: white; border-radius: 6px; font-weight: 600; font-size: 14px; text-decoration: none; }
  .call-btn:hover { background: #15803d; text-decoration: none; }
  .email-btn { display: inline-flex; padding: 8px 14px; background: #2563eb; color: white; border-radius: 6px; font-size: 13px; font-weight: 600; text-decoration: none; }
  .site-btn { display: inline-flex; padding: 8px 14px; background: #f3f4f6; color: #374151; border-radius: 6px; font-size: 13px; font-weight: 600; text-decoration: none; border: 1px solid #d1d5db; }
  .call-contact { font-size: 13px; margin-bottom: 6px; color: #2563eb; font-weight: 500; }
  .call-signal { font-size: 13px; margin-bottom: 6px; color: #b91c1c; }
  .call-pitch { font-size: 13px; margin-bottom: 4px; color: #374151; line-height: 1.5; }
  .call-meta { font-size: 12px; color: #9ca3af; margin-top: 8px; }
  .call-notes { margin-top: 10px; }
  .notes-input { width: 100%; padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; font-family: inherit; resize: vertical; color: #374151; box-sizing: border-box; }
  .notes-input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.1); }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  small { color: #6b7280; }
</style>
</head>
<body>
<header>
  <h1>NOUS Scout — GTA Combined Report</h1>
  <div class="meta">Generated ${esc(ts)} · ${cityResults.length} cities · ${allShops.length} shops</div>
  <div class="summary">
    <div class="stat"><span class="n">${totalHot}</span><span class="l">HOT</span></div>
    <div class="stat"><span class="n">${totalWarm}</span><span class="l">Warm</span></div>
    <div class="stat"><span class="n">${totalTcYes}</span><span class="l">TC Opportunities</span></div>
    <div class="stat"><span class="n">${allShops.length}</span><span class="l">Total Shops</span></div>
  </div>
</header>
<div class="city-tabs">
  ${allTab}
  ${cityTabs}
</div>
${allPanel}
${cityPanels}
<script>
(function(){
  var tabs = document.querySelectorAll('.city-tab');
  var panels = document.querySelectorAll('.city-panel');
  tabs.forEach(function(tab){
    tab.addEventListener('click', function(){
      tabs.forEach(function(t){ t.classList.remove('active'); });
      panels.forEach(function(p){ p.classList.remove('active'); });
      tab.classList.add('active');
      var city = tab.dataset.city;
      document.querySelector('.city-panel[data-city="'+city+'"]').classList.add('active');
    });
  });
  // Notes persistence
  var NOTES_KEY = 'nous-scout-notes';
  function loadNotes() { try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '{}'); } catch { return {}; } }
  function saveNotes(notes) { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); }
  document.querySelectorAll('.notes-input').forEach(function(ta) {
    var shop = ta.dataset.shop;
    var notes = loadNotes();
    if (notes[shop]) ta.value = notes[shop];
    ta.addEventListener('input', function() {
      var n = loadNotes();
      n[shop] = ta.value;
      saveNotes(n);
    });
  });
})();
</script>
</body>
</html>`;

  fs.writeFileSync(filePath, html, 'utf8');
  return filePath;
}

async function selftest() {
  const shops = [
    {
      place_id: 'a',
      name: "Joe's Tire",
      address: '123 Main St, Toronto ON',
      phone: '416-555-0001',
      website: 'https://example.com',
      rating: 4.1,
      review_count: 87,
      scrape: { no_online_booking: true, no_tire_catalog: true, already_has_tireconnect: false, platform_detected: 'WordPress' },
      analysis: { general: { overall_sentiment: 'mixed', reachability_complaint: 'Nobody answers the phone', top_praise: 'Great work on winter tires' }, nous_signals: { missed_calls_mentioned: true, after_hours_issues: true } },
      score: { priority_tier: 'HOT', nous_score: 8, tc_score: 6, confidence: 85, tc_opportunity: 'YES', notes: '' },
      pitch: 'Noticed a couple of your Google reviews mention calls going straight to voicemail — curious how you\'re currently handling inquiries after 5pm?',
    },
  ];
  const paths = outputPaths('Toronto', 'ON');
  await writeCsv(shops, paths.csv);
  writeHtml(shops, paths.html, { city: 'Toronto', province: 'ON', runAt: new Date().toLocaleString() });
  // eslint-disable-next-line no-console
  console.log(paths.csv);
  // eslint-disable-next-line no-console
  console.log(paths.html);
}

if (process.argv.includes('--selftest')) {
  selftest().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
