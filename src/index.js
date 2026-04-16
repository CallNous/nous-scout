// NOUS Scout CLI entry.
//
// Usage:
//   node src/index.js "Toronto" "ON" --max 20
//   node src/index.js "Toronto" "ON" --enrich --enrich-scope all
//   node src/index.js --batch cities.txt
//
// The orchestration pipeline per shop is:
//   places.details → scraper.scrape → analyzer.analyze → scorer.score
//   → (optional) enricher.enrich → pitch.generate → cache writeback
// After all shops are processed we sort by NOUS score and emit CSV + HTML.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { findShops } from './places.js';
import { scrapeSite, closeBrowser } from './scraper.js';
import { analyzeReviews } from './analyzer.js';
import { scoreShop } from './scorer.js';
import { generatePitch, generateTcPitch } from './pitch.js';
import { writeCsv, writeHtml, writeApolloCsv, outputPaths, writeCombinedHtml } from './reporter.js';
import { cache } from './cache.js';
import { log, enableFileLog } from './lib/logger.js';
import { enrichShop, estimateCreditSpend } from './enricher.js';

function parseArgs() {
  const program = new Command();
  program
    .name('nous-scout')
    .description('Find and score independent tire shops for NOUS + TireConnect prospecting')
    .argument('[city]', 'City name (e.g. "Toronto")')
    .argument('[province]', 'Province or state code (e.g. "ON")')
    .option('-r, --radius <km>', 'Search radius in km', '25')
    .option('-m, --max <n>', 'Max shops to process', '50')
    .option('--model <name>', 'Anthropic model for review analysis', 'claude-haiku-4-5')
    .option('--no-cache', 'Skip cache reads (still writes)')
    .option('--batch <file>', 'Newline-separated "City, Province" list')
    .option('--enrich', 'Enable Apollo.io owner enrichment', false)
    .option('--enrich-scope <scope>', 'hot|all', 'hot')
    .option('--apollo-contacts-only', 'Only look in your existing Apollo contacts; zero credit spend', false)
    .option('--min-credits <n>', 'Stop revealing when Apollo credits fall below this', '10')
    .option('--no-pitch', 'Skip AI-generated pitch angles')
    .option('--min-reviews <n>', 'Exclude shops with fewer than N reviews', '0');
  program.parse(process.argv);
  const opts = program.opts();
  const [city, province] = program.args;
  return { city, province, ...opts };
}

function readBatchFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [city, province] = line.split(',').map((s) => s.trim());
      return { city, province };
    })
    .filter((c) => c.city && c.province);
}

async function runOneCity({ city, province, args }) {
  const runLabel = `${city}-${province}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  enableFileLog(runLabel);
  log.info(`==============================`);
  log.info(`NOUS Scout — ${city}, ${province}`);
  log.info(`==============================`);

  const max = parseInt(args.max, 10);
  const minReviews = parseInt(args.minReviews, 10);
  let shops = await findShops({ city, province, max });
  if (shops.length === 0) {
    log.warn('No shops found. Exiting gracefully.');
    return;
  }

  if (minReviews > 0) {
    const before = shops.length;
    shops = shops.filter((s) => (s.review_count || 0) >= minReviews);
    log.info(`${before - shops.length} shops filtered out with <${minReviews} reviews → ${shops.length} remaining`);
  }

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    shop.cityInput = city;
    shop.provinceInput = province;
    log.step(i + 1, shops.length, `processing ${shop.name}`);

    // Scrape
    const cachedScrape = args.cache !== false ? cache.getScrape(shop.place_id) : null;
    if (cachedScrape) {
      shop.scrape = cachedScrape;
    } else if (shop.website) {
      shop.scrape = await scrapeSite(shop.website);
      cache.putScrape(shop.place_id, shop.scrape);
    } else {
      shop.scrape = { site_unreachable: true, reason: 'no_website_in_places' };
      cache.putScrape(shop.place_id, shop.scrape);
    }

    // Analyze reviews
    shop.analysis = await analyzeReviews(shop.reviews, { model: args.model });

    // Score
    shop.score = scoreShop(shop);
    log.info(`  → tier=${shop.score.priority_tier} nous=${shop.score.nous_score} tc=${shop.score.tc_score} conf=${shop.score.confidence}`);
  }

  // Enrichment (scoped, optional)
  if (args.enrich) {
    const scope = args.enrichScope;
    const pool = scope === 'all' ? shops : shops.filter((s) => s.score?.priority_tier === 'HOT');
    const projected = estimateCreditSpend(shops, scope);
    log.info(`Apollo enrichment: scope=${scope}, shops=${pool.length}, projected worst-case spend ≈ ${projected} credits`);
    if (args.apolloContactsOnly) log.info('--apollo-contacts-only: will NOT reveal new emails (zero credit spend)');
    const minCredits = parseInt(args.minCredits, 10);
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      log.step(i + 1, pool.length, `enriching ${s.name}`);
      try {
        s.enrichment = await enrichShop(s, {
          contactsOnly: args.apolloContactsOnly,
          creditsRemaining: null,
          minCredits,
        });
        if (s.enrichment?.owner_email) {
          log.info(`  → ${s.enrichment.owner_email} (${s.enrichment.apollo_source})`);
        } else {
          log.info(`  → ${s.enrichment?.apollo_source || 'no match'}`);
        }
      } catch (err) {
        log.warn(`enrich failed for ${s.name}: ${err.message}`);
      }
    }
  }

  // Pitches — generate NOUS pitch and TC pitch separately
  if (args.pitch !== false) {
    for (let i = 0; i < shops.length; i++) {
      const s = shops[i];
      // NOUS pitch for any shop that isn't fully cold + no TC
      if (!(s.score?.priority_tier === 'COLD' && s.score?.tc_opportunity === 'NO')) {
        log.step(i + 1, shops.length, `nous pitch ${s.name}`);
        s.pitch = await generatePitch(s, s.score);
      }
      // TC pitch for shops with TC opportunity
      if (s.score?.tc_opportunity === 'YES' || s.score?.tc_opportunity === 'MAYBE') {
        log.step(i + 1, shops.length, `tc pitch ${s.name}`);
        s.tc_pitch = await generateTcPitch(s, s.score);
      }
    }
  }

  // Output
  const paths = outputPaths(city, province);
  await writeCsv(shops, paths.csv);
  writeHtml(shops, paths.html, {
    city,
    province,
    runAt: new Date().toLocaleString(),
  });
  if (args.enrich) {
    await writeApolloCsv(shops, paths.apolloCsv);
    log.info(`Apollo CSV: ${paths.apolloCsv}`);
  }
  log.info(`CSV:  ${paths.csv}`);
  log.info(`HTML: ${paths.html}`);

  const hot = shops.filter((s) => s.score?.priority_tier === 'HOT').length;
  const warm = shops.filter((s) => s.score?.priority_tier === 'WARM').length;
  log.info(`Done. ${shops.length} shops — ${hot} HOT, ${warm} WARM`);
  return { city, province, shops };
}

async function main() {
  const args = parseArgs();
  try {
    if (args.batch) {
      const cities = readBatchFile(args.batch);
      log.info(`Batch run: ${cities.length} cities`);
      const allResults = [];
      for (const c of cities) {
        const result = await runOneCity({ city: c.city, province: c.province, args });
        if (result) allResults.push(result);
      }
      if (allResults.length > 1) {
        const batchName = path.basename(args.batch, path.extname(args.batch));
        const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        const combinedPath = path.join(path.resolve('output'), `${batchName}-combined-${ts}.html`);
        writeCombinedHtml(allResults, combinedPath);
        log.info(`Combined report: ${combinedPath}`);
      }
    } else {
      if (!args.city || !args.province) {
        log.error('Usage: node src/index.js "City" "Province" [--max N]');
        process.exit(1);
      }
      await runOneCity({ city: args.city, province: args.province, args });
    }
  } finally {
    await closeBrowser();
    cache.close();
  }
}

// Graceful shutdown on ctrl-c
process.on('SIGINT', async () => {
  log.warn('SIGINT received, flushing cache and exiting');
  try {
    await closeBrowser();
  } catch {
    // ignore
  }
  cache.close();
  process.exit(130);
});

main().catch((err) => {
  log.error(err.stack || err.message);
  cache.close();
  process.exit(1);
});
