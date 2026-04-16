# NOUS Scout

Node.js CLI that finds independent tire shops in a given city, scrapes their Google reviews + website, and ranks each shop on two signals:

1. **NOUS signal score** — how likely they're losing calls and would benefit from the NOUS AI phone agent.
2. **TireConnect signal score** — how likely they have no online tire catalog and would benefit from TireConnect.

Outputs a ranked CSV and a standalone HTML report. Optionally enriches HOT shops with Apollo.io owner contacts for direct outreach.

## Quick start

```
cp .env.example .env
# fill in GOOGLE_PLACES_API_KEY and ANTHROPIC_API_KEY
npm install
node src/index.js "Toronto" "ON" --max 20
```

Open `output/toronto-on-<timestamp>.html` in a browser.

## CLI flags

| Flag | Default | What it does |
|---|---|---|
| `<city> <province>` | required | e.g. `"Toronto" "ON"` |
| `--radius <km>` | 25 | Places search radius |
| `--max <n>` | 50 | Max shops to process |
| `--model <name>` | claude-haiku-4-5 | Anthropic model for review analysis |
| `--no-cache` | off | Skip cache reads (still writes) |
| `--batch <file>` | — | Newline-separated `City, Province` list |
| `--enrich` | off | Turn on Apollo enrichment |
| `--enrich-scope hot\|all` | hot | Which tier of shops to enrich |
| `--apollo-contacts-only` | off | Only lookup your existing Apollo contacts (zero credit spend) |
| `--min-credits <n>` | 10 | Stop revealing once Apollo balance falls below this |

## Module map

| File | Responsibility |
|---|---|
| `src/index.js` | CLI entry + orchestration pipeline |
| `src/places.js` | Google Places API (New) — Text Search + Details via REST |
| `src/scraper.js` | Cheerio-first website scraper (Puppeteer fallback) |
| `src/analyzer.js` | Claude review sentiment analysis (Haiku 4.5 + prompt caching) |
| `src/pitch.js` | Claude cold-email opener generator (Sonnet 4.6) |
| `src/enricher.js` | Apollo.io owner lookup (optional) |
| `src/scorer.js` | Pure scoring function — reads `config/scoring.json` |
| `src/cache.js` | JSON-backed cache (crash-resume + cost savings on reruns) |
| `src/reporter.js` | CSV + HTML + Apollo-ready CSV |
| `src/lib/` | logger, rate limiter, franchise blocklist loader |
| `config/scoring.json` | All scoring weights + franchise blocklist + tier thresholds |

## Adjusting scoring

Edit `config/scoring.json`. No code changes needed. Keys:

- `franchises` — names to filter out of Places results (case-insensitive).
- `nous_weights` — map of signal name → integer weight added to NOUS score.
- `tc_weights` — same, for TireConnect.
- `tiers.hot` / `tiers.warm` — NOUS score thresholds for tier assignment.
- `tc_opportunity.yes` / `tc_opportunity.maybe` — TC score thresholds.

## Adding cities

Single run: `node src/index.js "Halifax" "NS"`.

Batch run: make a file like `cities.txt`:

```
Toronto, ON
Ottawa, ON
Montreal, QC
```

Then: `node src/index.js --batch cities.txt`.

## Signal definitions

### NOUS signals (reviews)
- `missed_calls_mentioned` — reviews mention voicemail, no answer, couldn't reach
- `after_hours_issues` — reviews mention evenings/weekends unreachability
- `wait_times_mentioned` — reviews mention being put on hold or long waits
- `responsiveness_score` — 1–5, Claude's overall read

### NOUS signals (website)
- `no_online_booking` — no booking widget, Calendly, or appointment form
- `call_for_pricing` — site says "call for pricing" somewhere
- `no_hours_listed` — hours not on site
- `basic_contact_only` — only phone/contact form, no service detail

### TireConnect signals (website)
- `no_tire_catalog` — no "shop tires", "browse tires", tire e-commerce iframe
- `already_has_tireconnect` — `tireconnect.ca` appears on page (flag — existing customer, not a prospect)
- `static_pricing` — PDF links / static tables instead of dynamic catalog
- `no_ecommerce` — no cart, no add-to-cart, no checkout flow

## Known limitations

- **JS-heavy sites** (Wix, Squarespace with hydration) may look empty to Cheerio. Scraper escalates to Puppeteer when the HTML body is sparse.
- **Google Places API quotas** — $200/mo free credit covers ~140 full city runs. Beyond that you pay.
- **Apollo credits decay** — the free plan is small. See `--min-credits` flag and the credit estimator printed at run start.
- **Review recency** — Google Places only returns up to 5 reviews per shop and you don't control which 5. Signal quality varies.
- **Franchise detection** is string-matching only — a shop named "Bob's Canadian Tire Service" would be incorrectly filtered. Edit `franchises` in `config/scoring.json` if you see false positives.

## Costs (per city, `--max 50`)

- Google Places: ~$1.38 (covered by $200/mo free credit up to ~140 runs)
- Claude (Haiku review analysis + Sonnet pitch): ~$0.25
- Apollo: 0 credits with `--apollo-contacts-only`, otherwise up to 50 export credits per city on `--enrich-scope all`

See the plan file in `~/.claude/plans/` for the full cost breakdown.
