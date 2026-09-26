#!/usr/bin/env node
// ===================================================================
// Fetches Equibles' composite short-squeeze score for each watchlist
// ticker (one request per ticker, ~58 total on a 58-ticker watchlist --
// well under the free tier's 100/day cap) and writes:
//   - data/squeeze_scores.json   — latest snapshot, read by index.html
//   - data/squeeze_history.jsonl — one row per ticker per day, accumulating
//     for a future validation pass. The squeeze-score endpoint has no
//     historical time-series mode (unlike Twelve Data's price history),
//     so unlike engine.js's confluence score, THIS CANNOT BE BACKFILLED —
//     it only exists from whenever this script first starts running. Any
//     validation of it will need real calendar time to accumulate, same
//     as before backfill.mjs existed for prices.
//
// DELIBERATELY NOT folded into the 6-layer confluence score. Every
// condition already in that score was tested before being trusted, and
// several failed (see condition_breakdown.mjs, backtest.mjs --split).
// Squeeze score gets the same treatment: surfaced as separate context
// first, validated later once enough days exist -- not accepted as
// useful just because it sounds relevant. It's also worth being MORE
// skeptical of than the six price-based conditions, not less: those are
// direct calculations from raw prices; this is a third party's own
// proprietary composite model (peer percentiles + weighted blend +
// catalyst boosts) layered on top of the underlying FINRA data, which we
// have no independent way to audit.
//
// The squeeze-score endpoint bundles short interest %, days-to-cover,
// short-volume trend, and fails-to-deliver pressure into ONE response per
// ticker -- no separate call to a raw short-interest endpoint is needed.
//
// ETFs (SPY, QQQ) and crypto (BTC/USD) are expected to 404 -- Equibles'
// squeeze-score model explicitly covers only operating companies with
// FINRA short data, not ETFs or crypto. That's handled as "not covered",
// not an error.
//
// Usage: EQUIBLES_API_KEY=xxx node scripts/fetch_squeeze_scores.mjs
// ===================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const API_KEY = process.env.EQUIBLES_API_KEY;
if (!API_KEY) {
  console.error('Missing EQUIBLES_API_KEY environment variable.');
  process.exit(1);
}

// No documented per-minute limit, only the 100/day cap -- paced modestly
// anyway to be a good citizen and to leave headroom for retries.
const REQUEST_DELAY_MS = Number(process.env.EQUIBLES_REQUEST_DELAY_MS || 1200);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readConfig() {
  const raw = await fs.readFile(path.join(ROOT, 'watchlist.config.json'), 'utf8');
  return JSON.parse(raw);
}

export async function fetchSqueezeScore(ticker, apiKey, retries = 2) {
  const url = `https://api.equibles.com/v1/short-squeeze-scores?ticker=${encodeURIComponent(ticker)}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch (e) {
      if (attempt < retries) { await sleep(2000); continue; }
      return { error: `Network error: ${e.message}` };
    }

    if (res.status === 404) {
      return { notCovered: true }; // ETF, crypto, or otherwise outside the scored universe -- expected
    }
    if (res.status === 429) {
      if (attempt < retries) {
        const retryAfter = res.headers.get('Retry-After');
        await sleep(retryAfter ? Number(retryAfter) * 1000 : 5000);
        continue;
      }
      return { error: 'Rate limited repeatedly' };
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

    // Single-ticker lookup mode is documented as "returns only that row,"
    // but the docs' only full worked example shown is the multi-ticker
    // board mode -- be defensive about the exact shape (a 1-item data
    // array vs. fields sitting at the top level) rather than assume.
    const row = Array.isArray(body.data) && body.data.length ? body.data[0]
      : (body.ticker ? body : null);
    if (!row) return { error: 'Unexpected response shape (no row found)' };
    return { row, settlementDate: body.settlementDate || null };
  }
  return { error: 'Failed after retries' };
}

async function loadExistingHistory() {
  const logPath = path.join(ROOT, 'data', 'squeeze_history.jsonl');
  try {
    const raw = await fs.readFile(logPath, 'utf8');
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (e) {
    return [];
  }
}

export async function main() {
  const config = await readConfig();
  const tickers = [...new Set(config.tickers.map(t => t.trim()))];
  const todayStr = new Date().toISOString().slice(0, 10);

  console.log(`Fetching squeeze scores for ${tickers.length} tickers ` +
    `(~${(tickers.length * REQUEST_DELAY_MS / 1000 / 60).toFixed(1)} min, ` +
    `${tickers.length} of the 100/day free-tier requests)...`);

  const snapshot = {};
  const newHistoryRows = [];
  const errors = [];
  let notCoveredCount = 0;

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const result = await fetchSqueezeScore(ticker, API_KEY);

    if (result.notCovered) {
      notCoveredCount++;
      console.log(`  ${ticker}: not covered (ETF/crypto/outside scored universe)`);
    } else if (result.error) {
      errors.push({ ticker, message: result.error });
      console.warn(`  ${ticker}: ${result.error}`);
    } else {
      const r = result.row;
      snapshot[ticker] = {
        rank: r.rank,
        score: r.score,
        baseScore: r.baseScore,
        catalystBoost: r.catalystBoost,
        shortInterestPercentOfShares: r.shortInterestPercentOfShares,
        daysToCover: r.daysToCover,
        shortVolumeShareTrend: r.shortVolumeShareTrend,
        shortInterestChangePercent: r.shortInterestChangePercent,
        failsToDeliverPercentOfShares: r.failsToDeliverPercentOfShares,
        priceAboveVwap: r.priceAboveVwap,
        hasPriceSpikeCatalyst: r.hasPriceSpikeCatalyst,
        hasVolumeSurgeCatalyst: r.hasVolumeSurgeCatalyst,
        hasEarningsProximityCatalyst: r.hasEarningsProximityCatalyst,
        settlementDate: result.settlementDate
      };
      newHistoryRows.push({
        date: todayStr, ticker, score: r.score, rank: r.rank,
        daysToCover: r.daysToCover, shortInterestPercentOfShares: r.shortInterestPercentOfShares
      });
      console.log(`  ${ticker}: score=${r.score} rank=${r.rank} daysToCover=${r.daysToCover}`);
    }

    if (i < tickers.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    tickerCount: tickers.length,
    coveredCount: Object.keys(snapshot).length,
    notCoveredCount,
    errors,
    scores: snapshot
  };
  await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'data', 'squeeze_scores.json'), JSON.stringify(output, null, 2));

  // Append to history, deduped by (date, ticker) -- same pattern as scan.mjs's writeHistory
  const existing = await loadExistingHistory();
  const newKeys = new Set(newHistoryRows.map(r => `${r.date}|${r.ticker}`));
  const kept = existing.filter(r => !newKeys.has(`${r.date}|${r.ticker}`));
  const combined = [...kept, ...newHistoryRows];
  await fs.writeFile(path.join(ROOT, 'data', 'squeeze_history.jsonl'), combined.map(r => JSON.stringify(r)).join('\n') + '\n');

  console.log(`\nCovered: ${Object.keys(snapshot).length}, not covered: ${notCoveredCount}, errors: ${errors.length}`);
  console.log(`Wrote data/squeeze_scores.json and appended to data/squeeze_history.jsonl (${combined.length} total rows).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error('Squeeze score fetch failed:', err); process.exit(1); });
}
