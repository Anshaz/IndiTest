#!/usr/bin/env node
// ===================================================================
// Scheduled scan job. Run once a day (see .github/workflows/scan.yml).
//
// Fetches each watchlist ticker's daily bars with ONE paced request per
// symbol (see note below on why not the batch endpoint), derives weekly
// bars locally by resampling, and scores everything using the exact same
// engine.js the live "Manual Lookup" page in the browser uses, so the two
// can never quietly disagree.
//
// Output: data/latest.json — read directly by index.html's Auto Scan tab.
//
// Usage:  TWELVEDATA_API_KEY=xxx node scripts/scan.mjs
// ===================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Engine from '../engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const API_KEY = process.env.TWELVEDATA_API_KEY;
if (!API_KEY) {
  console.error('Missing TWELVEDATA_API_KEY environment variable.');
  process.exit(1);
}

// The comma-separated /time_series "batch" endpoint looked like an
// optimization (1 HTTP call instead of N) but is billed at a much higher
// weight per symbol on the free/Basic plan than a standard single-symbol
// call — confirmed by a real run: 33 tickers batched cost 165 credits
// (5/symbol) against an 8-credits/minute cap. A plain single-symbol
// /time_series call is the documented standard weight (1 credit/symbol),
// so we fetch one ticker at a time, paced under that per-minute budget.
//
// We also only fetch DAILY bars now (with enough history to resample into
// weekly bars locally — see Engine.resampleToWeekly), which halves the
// number of requests needed per ticker: 1 instead of 2.
const REQUESTS_PER_MINUTE = Number(process.env.TWELVEDATA_REQUESTS_PER_MINUTE || 6); // buffer under the observed 8/min cap
const MIN_DELAY_MS = Math.ceil(60000 / REQUESTS_PER_MINUTE);
const DAILY_OUTPUTSIZE = 260; // ~1 trading year — resamples to ~50 weekly bars, comfortably above MACD's ~35-bar need

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchOne(ticker, retries = 3) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}&interval=1day&outputsize=${DAILY_OUTPUTSIZE}&apikey=${encodeURIComponent(API_KEY)}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'error') {
      const creditLimited = /run out of api credits/i.test(data.message || '');
      if (creditLimited && attempt < retries) {
        // Credits reset on the minute boundary — wait a full minute plus a
        // safety margin rather than guessing at the exact reset instant.
        console.warn(`  ${ticker}: hit per-minute credit limit, waiting 65s (attempt ${attempt + 1}/${retries})...`);
        await sleep(65000);
        continue;
      }
      return { error: data.message || 'Provider error' };
    }
    if (!data.values || !data.values.length) return { error: 'No data returned' };
    return { values: data.values };
  }
  return { error: 'Failed after retries (persistent rate limit)' };
}

async function readConfig() {
  const raw = await fs.readFile(path.join(ROOT, 'watchlist.config.json'), 'utf8');
  return JSON.parse(raw);
}

function normalizeAndSplit(values) {
  const { bars: dailyBars, volumeReliable } = Engine.sanitizeOHLCV([...values].reverse());
  if (dailyBars.length < 10) return { error: 'Insufficient valid bars after cleaning' };
  const weeklyBars = Engine.resampleToWeekly(dailyBars);
  if (weeklyBars.length < 15) return { error: 'Not enough history to resample a usable weekly series' };
  return { dailyBars, weeklyBars, volumeReliable };
}

async function main() {
  const config = await readConfig();
  const tickers = [...new Set(config.tickers.map(t => t.trim()))];
  const profiles = config.profiles || {};

  console.log(`Scanning ${tickers.length} tickers (paced at ~${REQUESTS_PER_MINUTE}/min, 1 request each)...`);
  const estMinutes = Math.ceil((tickers.length * MIN_DELAY_MS) / 60000);
  console.log(`Estimated time: ~${estMinutes} minute(s)`);

  const results = [];
  const errors = [];

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const started = Date.now();

    const fetched = await fetchOne(ticker);
    if (fetched.error) {
      console.warn(`  ${ticker}: ${fetched.error}`);
      errors.push({ ticker, message: fetched.error });
    } else {
      const normalized = normalizeAndSplit(fetched.values);
      if (normalized.error) {
        console.warn(`  ${ticker}: ${normalized.error}`);
        errors.push({ ticker, message: normalized.error });
      } else {
        const hasExplicitProfile = Object.prototype.hasOwnProperty.call(profiles, ticker);
        const profileKey = hasExplicitProfile ? profiles[ticker] : Engine.classifyVolatility(normalized.dailyBars);
        const cfg = Engine.getProfileConfig(profileKey);

        const dailyResult = Engine.evaluateTicker(normalized.dailyBars, cfg, normalized.volumeReliable);
        const weeklyResult = Engine.evaluateWeekly(normalized.weeklyBars, cfg);

        results.push({
          ticker,
          cfg: { name: cfg.name },
          autoClassified: !hasExplicitProfile,
          daily: dailyResult,
          weekly: weeklyResult
        });
        console.log(`  ${ticker}: ${dailyResult.score}/${dailyResult.maxScore} (${cfg.name}${!hasExplicitProfile ? ', auto' : ''})`);
      }
    }

    // Pace to stay under the per-minute credit budget, but don't sleep
    // after the very last request or if a retry-wait already ate the gap.
    if (i < tickers.length - 1) {
      const elapsed = Date.now() - started;
      const remaining = MIN_DELAY_MS - elapsed;
      if (remaining > 0) await sleep(remaining);
    }
  }

  // Highest-conviction setups first — this is the whole point of the
  // auto-scan: open the page, see what's actionable, no manual scanning.
  results.sort((a, b) => (b.daily.score / b.daily.maxScore) - (a.daily.score / a.daily.maxScore));

  const output = {
    generatedAt: new Date().toISOString(),
    tickerCount: tickers.length,
    successCount: results.length,
    errors,
    results
  };

  const outPath = path.join(ROOT, 'data', 'latest.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${results.length}/${tickers.length} results to ${outPath}`);

  await writeHistory(output);

  if (errors.length) {
    console.warn(`${errors.length} ticker(s) failed:`, errors.map(e => e.ticker).join(', '));
  }
}

// ===================== HISTORY LOGGING =====================
// Every run appends today's scored results to a growing dataset. This is
// what makes a future backtest possible without ever calling the API
// retroactively: since we already fetch every watchlist ticker's price
// daily to compute the score, that same data point IS the price series a
// backtest needs. In N weeks, joining today's row for TICKER against the
// row for TICKER N sessions later gives a forward return — no extra fetch,
// just reading our own accumulated logs.
async function writeHistory(output) {
  const dateStr = output.generatedAt.slice(0, 10); // YYYY-MM-DD

  // 1) Full daily snapshot, one file per day — useful for debugging/audit,
  //    and safe to overwrite if the job is re-run the same day.
  const snapshotDir = path.join(ROOT, 'data', 'history');
  await fs.mkdir(snapshotDir, { recursive: true });
  await fs.writeFile(path.join(snapshotDir, `${dateStr}.json`), JSON.stringify(output, null, 2));

  // 2) Flat append-only log, one row per ticker per day — the actual
  //    backtest-ready dataset. Deduped on (date, ticker) so re-running the
  //    same day (e.g. a manual trigger after the scheduled one) replaces
  //    that day's rows instead of duplicating them.
  const logPath = path.join(ROOT, 'data', 'history.jsonl');
  let existingLines = [];
  try {
    const raw = await fs.readFile(logPath, 'utf8');
    existingLines = raw.split('\n').filter(Boolean);
  } catch (e) { /* first run, no log yet */ }

  const newRows = output.results.map(r => ({
    date: dateStr,
    ticker: r.ticker,
    profile: r.cfg.name,
    autoClassified: r.autoClassified,
    dailyScore: r.daily.score,
    dailyMax: r.daily.maxScore,
    weeklyScore: r.weekly.score,
    weeklyBullish: r.weekly.bullish,
    price: r.daily.details ? r.daily.details.price : null,
    stop: r.daily.stop,
    higherLowPrice: r.daily.higherLow ? r.daily.higherLow.price : null,
    atrPct: r.daily.details ? r.daily.details.atrPct : null,
    volumeReliable: r.daily.volumeReliable
  }));
  const newKeys = new Set(newRows.map(r => `${r.date}|${r.ticker}`));

  const kept = existingLines.filter(line => {
    try {
      const row = JSON.parse(line);
      return !newKeys.has(`${row.date}|${row.ticker}`);
    } catch (e) { return false; } // drop unparseable lines instead of crashing the whole log
  });

  const allLines = [...kept, ...newRows.map(r => JSON.stringify(r))];
  await fs.writeFile(logPath, allLines.join('\n') + '\n');
  console.log(`History log: ${logPath} now has ${allLines.length} rows`);
}

main().catch(err => {
  console.error('Scan failed:', err);
  process.exit(1);
});
