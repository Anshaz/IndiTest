#!/usr/bin/env node
// ===================================================================
// Scheduled scan job. Run once a day (see .github/workflows/scan.yml).
//
// Fetches the whole watchlist.config.json list via TwelveData's batch
// endpoint (comma-separated symbols → ONE HTTP call per interval,
// regardless of watchlist size) and scores every ticker using the exact
// same engine.js the live "Manual Lookup" page in the browser uses, so
// the two can never quietly disagree.
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

const BATCH_CHUNK_SIZE = 100; // TwelveData batch supports up to ~120 symbols/call; stay under that with margin

async function readConfig() {
  const raw = await fs.readFile(path.join(ROOT, 'watchlist.config.json'), 'utf8');
  return JSON.parse(raw);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchBatch(symbols, interval, retries = 3) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbols.join(','))}&interval=${interval}&outputsize=100&apikey=${encodeURIComponent(API_KEY)}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url);
    const data = await res.json();

    // Single-symbol shape has 'values' at the top level. Multi-symbol batch
    // shape is an object keyed by symbol, each with its own 'status'/'values'.
    if (data.values) return { [symbols[0]]: data };

    if (data.status === 'error') {
      const rateLimited = /limit/i.test(data.message || '');
      if (rateLimited && attempt < retries) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw new Error(data.message || 'Unknown batch error');
    }
    return data; // { SYMBOL: { status, values, meta }, ... }
  }
  throw new Error(`Batch request for ${interval} failed after retries`);
}

async function fetchWatchlist(symbols, interval) {
  const out = {};
  for (const group of chunk(symbols, BATCH_CHUNK_SIZE)) {
    const batch = await fetchBatch(group, interval);
    Object.assign(out, batch);
    // small pacing gap between chunks — free tier is 8 req/min, we're
    // nowhere near that with 1-2 chunks, but stay polite regardless
    await new Promise(r => setTimeout(r, 500));
  }
  return out;
}

function normalizeSymbolResponse(symbolData, ticker) {
  if (!symbolData) return { error: 'No response for symbol' };
  if (symbolData.status === 'error') return { error: symbolData.message || 'Provider error' };
  if (!symbolData.values || !symbolData.values.length) return { error: 'No data returned' };
  const { bars, volumeReliable } = Engine.sanitizeOHLCV([...symbolData.values].reverse());
  if (bars.length < 10) return { error: 'Insufficient valid bars after cleaning' };
  return { bars, volumeReliable };
}

async function main() {
  const config = await readConfig();
  const tickers = [...new Set(config.tickers.map(t => t.trim()))];
  const profiles = config.profiles || {};

  console.log(`Scanning ${tickers.length} tickers...`);

  const [dailyRaw, weeklyRaw] = await Promise.all([
    fetchWatchlist(tickers, '1day'),
    fetchWatchlist(tickers, '1week')
  ]);

  const results = [];
  const errors = [];

  for (const ticker of tickers) {
    const daily = normalizeSymbolResponse(dailyRaw[ticker], ticker);
    const weekly = normalizeSymbolResponse(weeklyRaw[ticker], ticker);

    if (daily.error || weekly.error) {
      const message = daily.error || weekly.error;
      console.warn(`  ${ticker}: ${message}`);
      errors.push({ ticker, message });
      continue;
    }

    const hasExplicitProfile = Object.prototype.hasOwnProperty.call(profiles, ticker);
    const profileKey = hasExplicitProfile ? profiles[ticker] : Engine.classifyVolatility(daily.bars);
    const cfg = Engine.getProfileConfig(profileKey);

    const dailyResult = Engine.evaluateTicker(daily.bars, cfg, daily.volumeReliable);
    const weeklyResult = Engine.evaluateWeekly(weekly.bars, cfg);

    results.push({
      ticker,
      cfg: { name: cfg.name },
      autoClassified: !hasExplicitProfile,
      daily: dailyResult,
      weekly: weeklyResult
    });
    console.log(`  ${ticker}: ${dailyResult.score}/${dailyResult.maxScore} (${cfg.name}${!hasExplicitProfile ? ', auto' : ''})`);
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
