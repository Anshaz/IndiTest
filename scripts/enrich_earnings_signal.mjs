#!/usr/bin/env node
// ===================================================================
// Enriches EXISTING data/history.jsonl rows with a post-earnings-drift
// signal (EARN), computed no-lookahead from data/earnings_raw.json
// (produced by scripts/fetch_earnings_surprises.mjs).
//
// Unlike the price-based signals, this doesn't need a separate backfill
// walk: Finnhub's endpoint already returns each ticker's FULL reporting
// history in one call, so for every row already in history.jsonl, this
// just asks "as of that row's date, what was the most recent EARNINGS
// report, and was it a positive surprise within the drift window" --
// using engine.js's postEarningsSignal(), which is no-lookahead by
// construction (it only ever considers reports dated on or before the
// date it's given).
//
// Adds `EARN` to each row's `conditions` object (true/false/null, same
// convention as every other condition) and a continuous
// `earningsSurprisePercent` field, without touching anything else in the
// row. Rows for tickers with no earnings data on file (not covered, or
// the fetch step wasn't run) get EARN: null, same as any other condition
// that couldn't be computed.
//
// Usage:
//   node scripts/fetch_earnings_surprises.mjs   (run first)
//   node scripts/enrich_earnings_signal.mjs [driftWindowDays]
// ===================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Engine from '../engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

export async function enrich(rows, earningsCache, driftWindowDays) {
  let enrichedCount = 0;
  const outRows = rows.map(row => {
    const history = earningsCache[row.ticker];
    const signal = history ? Engine.postEarningsSignal(history, row.date, driftWindowDays) : { insufficient: true };
    if (!signal.insufficient) enrichedCount++;

    return {
      ...row,
      conditions: {
        ...(row.conditions || {}),
        EARN: signal.insufficient ? null : signal.recentPositiveSurprise
      },
      earningsSurprisePercent: signal.insufficient ? null : signal.surprisePercent
    };
  });
  return { outRows, enrichedCount };
}

async function main() {
  const driftWindowDays = Number(process.argv[2] || 60);

  const historyPath = path.join(ROOT, 'data', 'history.jsonl');
  const earningsPath = path.join(ROOT, 'data', 'earnings_raw.json');

  let historyRaw, earningsRaw;
  try {
    historyRaw = await fs.readFile(historyPath, 'utf8');
  } catch (e) {
    console.error('No data/history.jsonl yet -- run scripts/scan.mjs or scripts/backfill.mjs first.');
    process.exit(1);
  }
  try {
    earningsRaw = await fs.readFile(earningsPath, 'utf8');
  } catch (e) {
    console.error('No data/earnings_raw.json yet -- run scripts/fetch_earnings_surprises.mjs first.');
    process.exit(1);
  }

  const rows = historyRaw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const earningsCache = JSON.parse(earningsRaw);

  console.log(`Enriching ${rows.length} history rows with a ${driftWindowDays}-day post-earnings-drift signal...`);
  console.log(`Earnings data available for ${Object.keys(earningsCache).length} ticker(s).\n`);

  const { outRows, enrichedCount } = await enrich(rows, earningsCache, driftWindowDays);

  await fs.writeFile(historyPath, outRows.map(r => JSON.stringify(r)).join('\n') + '\n');

  console.log(`${enrichedCount} of ${rows.length} rows got a real EARN reading (the rest: ticker not in ` +
    `earnings_raw.json, or no report had happened yet as of that row's date).`);
  console.log('data/history.jsonl updated in place. condition_breakdown.mjs and train_long_signal.py both ' +
    'already know about the new EARN key -- no further changes needed to test it.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error('Enrichment failed:', err); process.exit(1); });
}
