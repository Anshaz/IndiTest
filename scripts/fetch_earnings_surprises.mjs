#!/usr/bin/env node
// ===================================================================
// Fetches each watchlist ticker's quarterly earnings-surprise history
// from Finnhub (GET /stock/earnings) and caches it to
// data/earnings_raw.json, for use by scripts/enrich_earnings_signal.mjs.
//
// IMPORTANT HONEST CAVEAT: the exact response field names below (actual,
// estimate, period, quarter, surprise, surprisePercent, symbol, year) are
// the best-evidenced shape cross-referenced across Finnhub's own official
// Go/Python/JS/PHP/Elixir client SDKs (all wrapping the same single
// company_earnings call), NOT independently verified against a live API
// response -- that needs a real account/key this environment doesn't
// have. Parsing below is deliberately defensive: if the live response
// doesn't match, this reports a clear per-ticker error rather than
// silently producing wrong data. If you see parsing errors on your first
// real run, paste one raw response back and the parser can be corrected
// precisely, the same way the Equibles integration was refined earlier.
//
// One request per ticker, well within Finnhub's free-tier 60 calls/min --
// paced conservatively at 50/min to leave real margin.
//
// Usage: FINNHUB_API_KEY=xxx node scripts/fetch_earnings_surprises.mjs
// ===================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const API_KEY = process.env.FINNHUB_API_KEY;
if (!API_KEY) {
  console.error('Missing FINNHUB_API_KEY environment variable.');
  process.exit(1);
}

const REQUESTS_PER_MINUTE = Number(process.env.FINNHUB_REQUESTS_PER_MINUTE || 50);
const MIN_DELAY_MS = Math.ceil(60000 / REQUESTS_PER_MINUTE);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readConfig() {
  const raw = await fs.readFile(path.join(ROOT, 'watchlist.config.json'), 'utf8');
  return JSON.parse(raw);
}

// Normalizes one raw Finnhub earnings-surprise record into the shape
// engine.js's postEarningsSignal() expects: { period, surprisePercent }.
// Deliberately tolerant of a couple of plausible field-name variants
// (some Finnhub-adjacent tools use "date" instead of "period") without
// silently accepting something that isn't recognizable at all.
function normalizeRecord(raw) {
  const period = raw.period || raw.date || null;
  const surprisePercent = typeof raw.surprisePercent === 'number' ? raw.surprisePercent
    : (typeof raw.surprise_percent === 'number' ? raw.surprise_percent : null);
  if (!period || surprisePercent === null) return null;
  return { period, surprisePercent };
}

export async function fetchEarningsSurprises(ticker, apiKey, retries = 2) {
  const url = `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(apiKey)}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      if (attempt < retries) { await sleep(2000); continue; }
      return { error: `Network error: ${e.message}` };
    }

    if (res.status === 429) {
      if (attempt < retries) {
        await sleep(15000);
        continue;
      }
      return { error: 'Rate limited repeatedly' };
    }
    if (res.status === 404) {
      return { notCovered: true }; // ticker not covered (e.g. crypto pairs like BTC/USD)
    }
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }

    let body;
    try {
      body = await res.json();
    } catch (e) {
      return { error: 'Invalid JSON response' };
    }

    if (!Array.isArray(body)) {
      // Defensive: this is the "the shape didn't match what we expected"
      // case flagged in the file header -- surface it clearly rather than
      // guess.
      return { error: `Unexpected response shape (expected an array, got ${typeof body}) -- ` +
        `field names may need correcting, see this file's header comment` };
    }
    if (body.length === 0) {
      return { records: [] }; // covered, but no reports on file (e.g. a very new listing)
    }

    const records = body.map(normalizeRecord).filter(Boolean);
    if (records.length === 0) {
      return { error: `Response was a non-empty array but no record matched the expected fields -- ` +
        `field names likely need correcting, see this file's header comment` };
    }
    return { records };
  }
  return { error: 'Failed after retries' };
}

async function main() {
  const config = await readConfig();
  const tickers = [...new Set(config.tickers.map(t => t.trim()))];

  console.log(`Fetching earnings-surprise history for ${tickers.length} tickers ` +
    `(~${(tickers.length * MIN_DELAY_MS / 1000 / 60).toFixed(1)} min)...`);

  const cache = {};
  const errors = [];
  let notCoveredCount = 0;

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const result = await fetchEarningsSurprises(ticker, API_KEY);

    if (result.notCovered) {
      notCoveredCount++;
      console.log(`  ${ticker}: not covered`);
    } else if (result.error) {
      errors.push({ ticker, message: result.error });
      console.warn(`  ${ticker}: ${result.error}`);
    } else {
      cache[ticker] = result.records;
      console.log(`  ${ticker}: ${result.records.length} reports on file`);
    }

    if (i < tickers.length - 1) await sleep(MIN_DELAY_MS);
  }

  await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'data', 'earnings_raw.json'), JSON.stringify(cache, null, 2));

  console.log(`\nCovered: ${Object.keys(cache).length}, not covered: ${notCoveredCount}, errors: ${errors.length}`);
  console.log('Wrote data/earnings_raw.json. Run scripts/enrich_earnings_signal.mjs next.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error('Earnings fetch failed:', err); process.exit(1); });
}
