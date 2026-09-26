#!/usr/bin/env node
// ===================================================================
// Reads data/history.jsonl (built by scripts/scan.mjs, one row per
// ticker per trading day) and reports forward returns by score bucket.
//
// This needs no separate data source: since scan.mjs logs every
// watchlist ticker's price every day regardless of its score, the log
// already contains the "what happened later" side of the question —
// for TICKER's row on day D, TICKER's row N days later (if the ticker
// stayed in the watchlist) gives the forward return directly.
//
// Will report "insufficient data" gracefully until enough daily runs
// have accumulated. You need at least (horizon + a couple dozen)
// trading days of history per horizon for the numbers to mean anything
// — this is a sanity check tool, not a substitute for a real
// walk-forward validation with correct handling of survivorship,
// re-entries, and position sizing.
//
// Usage: node scripts/backtest.mjs [horizonDays1,horizonDays2,...]
//   e.g. node scripts/backtest.mjs 5,10,20
// ===================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const MIN_SAMPLES_FOR_STATS = 20; // below this, don't pretend the average means anything

async function loadRows() {
  const logPath = path.join(ROOT, 'data', 'history.jsonl');
  let raw;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch (e) {
    console.log('No data/history.jsonl yet — run scripts/scan.mjs a few times first (once per trading day) to build up history.');
    process.exit(0);
  }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function groupByTicker(rows) {
  const byTicker = new Map();
  for (const r of rows) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }
  for (const rows of byTicker.values()) rows.sort((a, b) => a.date.localeCompare(b.date));
  return byTicker;
}

function scoreBucket(row) {
  const ratio = row.dailyMax ? row.dailyScore / row.dailyMax : 0;
  if (ratio >= 0.85) return '5-6/6 (max confluence)';
  if (ratio >= 0.55) return '4/6 (setup active)';
  if (ratio >= 0.3) return '2-3/6 (building)';
  return '0-1/6 (no setup)';
}

function computeForwardReturns(byTicker, horizons, dedupeEpisodes = true) {
  // bucket -> horizon -> [returns]
  const buckets = {};
  let totalRows = 0, episodeRows = 0;
  for (const rows of byTicker.values()) {
    let prevBucket = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.price === null || row.price === undefined) { prevBucket = null; continue; }
      const bucket = scoreBucket(row);
      totalRows++;

      // Only count the FIRST day a ticker enters a bucket as a sample. A
      // ticker sitting at 5/6 for 6 straight days is mostly the same
      // underlying price move counted 6 times, not 6 independent trials --
      // that inflates n and makes the stats look far more solid than they
      // are. This turns "consecutive days in the same bucket" into a single
      // episode, so n approximates independent signals instead of raw rows.
      const isNewEpisode = bucket !== prevBucket;
      prevBucket = bucket;
      if (dedupeEpisodes && !isNewEpisode) continue;
      episodeRows++;

      buckets[bucket] ??= {};
      for (const h of horizons) {
        const future = rows[i + h];
        if (!future || future.price === null || future.price === undefined) continue;
        const ret = (future.price - row.price) / row.price;
        buckets[bucket][h] ??= [];
        buckets[bucket][h].push(ret);
      }
    }
  }
  return { buckets, totalRows, episodeRows };
}

function summarize(returns) {
  const n = returns.length;
  if (n === 0) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const winRate = returns.filter(r => r > 0).length / n;
  const sorted = [...returns].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  return { n, meanPct: mean * 100, medianPct: median * 100, winRate: winRate * 100 };
}

function printBucketReport(rows, horizons, rawMode, label) {
  if (!rows.length) {
    console.log(`${label ? label + ': ' : ''}No rows in this range.`);
    return;
  }

  const dates = [...new Set(rows.map(r => r.date))].sort();
  console.log(`${label ? '--- ' + label + ' ---\n' : ''}${rows.length} rows across ${dates.length} trading day(s): ${dates[0]} → ${dates[dates.length - 1]}\n`);

  const maxHorizon = Math.max(...horizons);
  if (dates.length < maxHorizon + MIN_SAMPLES_FOR_STATS) {
    console.log(`Not enough history in this range for a meaningful ${maxHorizon}-day-forward read.`);
    console.log(`Have ${dates.length} trading day(s); want roughly ${maxHorizon + MIN_SAMPLES_FOR_STATS}+. Showing what's here anyway:\n`);
  }

  const byTicker = groupByTicker(rows);
  const { buckets, totalRows, episodeRows } = computeForwardReturns(byTicker, horizons, !rawMode);

  if (!rawMode) {
    console.log(`Episode de-duplication: ${totalRows} raw rows -> ${episodeRows} independent episodes.\n`);
  } else {
    console.log(`Raw mode: counting every row, including consecutive days in the same bucket.\n`);
  }

  const order = ['0-1/6 (no setup)', '2-3/6 (building)', '4/6 (setup active)', '5-6/6 (max confluence)'];
  for (const bucket of order) {
    if (!buckets[bucket]) continue;
    console.log(`\n${bucket}`);
    for (const h of horizons) {
      const stats = summarize(buckets[bucket][h] || []);
      if (!stats) { console.log(`  +${h}d: no samples yet`); continue; }
      const flag = stats.n < MIN_SAMPLES_FOR_STATS ? '  (low sample, n<' + MIN_SAMPLES_FOR_STATS + ')' : '';
      console.log(`  +${h}d: n=${stats.n}  mean=${stats.meanPct.toFixed(2)}%  median=${stats.medianPct.toFixed(2)}%  win-rate=${stats.winRate.toFixed(0)}%${flag}`);
    }
  }
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const consumed = new Set();

  const rawMode = args.includes('--raw');
  if (rawMode) consumed.add(args.indexOf('--raw'));

  function takeArgValue(flag) {
    const idx = args.indexOf(flag);
    if (idx === -1) return null;
    consumed.add(idx);
    consumed.add(idx + 1);
    return args[idx + 1] || null;
  }

  const splitDate = takeArgValue('--split');
  const beforeDate = takeArgValue('--before');
  const afterDate = takeArgValue('--after');
  const profileArg = takeArgValue('--profile'); // 'stable' | 'spec'

  const horizonArg = args.find((a, i) => !consumed.has(i)) || '5,10,20';
  const horizons = horizonArg.split(',').map(Number);

  let rows = await loadRows();
  if (!rows.length) { console.log('History log is empty.'); return; }

  if (profileArg) {
    const wantName = profileArg.toLowerCase().startsWith('spec') ? 'Speculative' : 'Stable';
    rows = rows.filter(r => r.profile === wantName);
    console.log(`Filtered to profile: ${wantName} (${rows.length} rows)\n`);
  }

  if (splitDate) {
    // Train/test comparison in one run: same rows, same logic, split purely
    // by signal date. A row's OWN date must fall on one side of the cutoff;
    // its forward return naturally lands a few days after that, which is
    // the whole point (measuring what happened next), not lookahead.
    console.log(`SPLIT AT ${splitDate} — comparing whether a pattern found across the full dataset holds up`);
    console.log(`independently in each half, rather than just re-confirming itself on the same data.\n`);
    const before = rows.filter(r => r.date < splitDate);
    const after = rows.filter(r => r.date >= splitDate);
    printBucketReport(before, horizons, rawMode, `BEFORE ${splitDate} (n=${before.length} rows)`);
    printBucketReport(after, horizons, rawMode, `ON/AFTER ${splitDate} (n=${after.length} rows)`);
    console.log(`Reminder: same caveats as a normal run (raw close-to-close returns, no fees/slippage/stop-outs).`);
    console.log(`Look for whether the SAME bucket wins at the SAME horizons in both halves independently —`);
    console.log(`a pattern that only shows up in one half is exactly what this split is meant to catch.`);
    return;
  }

  const filtered = rows.filter(r => (!beforeDate || r.date < beforeDate) && (!afterDate || r.date >= afterDate));
  if (beforeDate || afterDate) {
    console.log(`Filtered to ${beforeDate ? 'before ' + beforeDate : ''}${beforeDate && afterDate ? ' / ' : ''}${afterDate ? 'on or after ' + afterDate : ''}\n`);
  }
  printBucketReport(filtered, horizons, rawMode, null);

  console.log(`Reminder: this is raw forward return on the scan's own close price, no fees/slippage/stop-outs modeled${rawMode ? ', and consecutive same-bucket days are NOT de-duplicated (n includes correlated repeats)' : ''}. Treat it as a first directional sanity check on the scoring thresholds, not a validated backtest.`);
}

main().catch(err => { console.error('Backtest failed:', err); process.exit(1); });
