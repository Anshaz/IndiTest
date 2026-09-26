#!/usr/bin/env node
// ===================================================================
// Simulates actual trades: for each signal day, enter at that day's
// price, hold until price closes at or beyond the target, closes at or
// below the stop, or a max holding period elapses -- then record the
// outcome in R-multiples (where 1R = the risk taken on entry, i.e. the
// distance from entry to stop).
//
// This is more decision-relevant than "average return N days later"
// (what backtest.mjs and condition_breakdown.mjs measure): it directly
// answers "if I'd taken every signal in bucket X using the app's own
// suggested stop and target, what would have happened," which is
// literally the decision you're weighing when you look at a signal.
//
// One position at a time per ticker: once a simulated trade opens, the
// next eligible entry for that ticker is only considered after the
// current one resolves (stop, target, or timeout). This avoids treating
// every day of an ongoing setup as a fresh, independent trade -- you
// wouldn't actually re-enter a position you're already in.
//
// IMPORTANT LIMITATION: outcomes are checked against daily CLOSE prices
// only (history.jsonl doesn't log intraday highs/lows), not true
// intrabar highs/lows. A day whose close doesn't reach the stop or
// target might still have touched it intrabar and reversed -- this
// makes the simulation a reasonable approximation, not an exact replay.
//
// target and reward:risk are recomputed from already-logged fields
// (price, stop, profile) using the same formula engine.js uses live —
// entry + (entry - stop) * rewardMultiplier — rather than requiring yet
// another schema change/backfill regeneration, since those three fields
// already fully determine it.
//
// Usage:
//   node scripts/trade_simulation.mjs [maxHoldingDays] [--split DATE] [--profile stable|spec]
//   node scripts/trade_simulation.mjs 20
//   node scripts/trade_simulation.mjs 20 --split 2024-10-01
//
//   node scripts/trade_simulation.mjs [maxHoldingDays] --compare KEY1,KEY2,...
//   Compares baseline (no filter) vs each condition alone vs all combined
//   (AND'd together) -- answers whether combining conditions adds real
//   value beyond either alone, or whether they're redundant:
//   node scripts/trade_simulation.mjs 20 --compare ATR,RS
//   node scripts/trade_simulation.mjs 20 --compare ATR,RS --split 2024-10-01
// ===================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const MIN_SAMPLES_FOR_STATS = 20;
const STABLE_REWARD_MULTIPLIER = 2.0; // must match getProfileConfig('stable').rewardMultiplier in engine.js
const SPEC_REWARD_MULTIPLIER = 2.5;   // must match getProfileConfig('spec').rewardMultiplier in engine.js

async function loadRows() {
  const logPath = path.join(ROOT, 'data', 'history.jsonl');
  let raw;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch (e) {
    console.log('No data/history.jsonl yet — run scripts/scan.mjs or scripts/backfill.mjs first.');
    process.exit(0);
  }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function groupByTicker(rows) {
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

function matchesFilter(row, filter) {
  if (!filter) return true;
  if (!row.conditions) return false;
  for (const [key, wanted] of Object.entries(filter)) {
    if (row.conditions[key] !== wanted) return false;
  }
  return true;
}

// Walks one ticker's row sequence, opening a simulated trade whenever a
// row has a usable stop AND matches conditionFilter (if given -- e.g.
// {ATR: true, RS: true} to only enter when both conditions are true that
// day), holding it (one at a time -- no overlapping entries) until it
// resolves. Returns one trade record per simulated entry.
//
// conditionFilter defaults to null (no filtering, exact prior behavior --
// every row with a valid stop is a candidate entry) so existing callers
// and tests are unaffected.
export function simulateTicker(rows, maxHoldingDays, conditionFilter = null) {
  const trades = [];
  let i = 0;

  while (i < rows.length) {
    const row = rows[i];

    if (row.price === null || row.price === undefined || row.stop === null || row.stop === undefined) {
      i++;
      continue;
    }
    if (!matchesFilter(row, conditionFilter)) {
      i++;
      continue;
    }

    const entry = row.price;
    const stopPrice = parseFloat(row.stop);
    const riskPerShare = entry - stopPrice;
    if (!(riskPerShare > 0)) { i++; continue; } // invalid/degenerate stop, skip this row as an entry

    const rewardMultiplier = row.profile === 'Speculative' ? SPEC_REWARD_MULTIPLIER : STABLE_REWARD_MULTIPLIER;
    const targetPrice = entry + riskPerShare * rewardMultiplier;

    let outcome = null;
    let exitIndex = i;
    const lastIndex = Math.min(i + maxHoldingDays, rows.length - 1);

    for (let j = i + 1; j <= lastIndex; j++) {
      const future = rows[j];
      if (future.price === null || future.price === undefined) continue; // gap, keep scanning within the window
      if (future.price <= stopPrice) { outcome = 'stop'; exitIndex = j; break; }
      if (future.price >= targetPrice) { outcome = 'target'; exitIndex = j; break; }
    }

    let exitR;
    if (outcome === 'target') {
      exitR = rewardMultiplier;
    } else if (outcome === 'stop') {
      exitR = -1;
    } else {
      outcome = 'timeout';
      exitIndex = lastIndex;
      const finalPrice = rows[lastIndex].price;
      exitR = (finalPrice !== null && finalPrice !== undefined) ? (finalPrice - entry) / riskPerShare : 0;
    }

    trades.push({
      bucket: scoreBucket(row),
      profile: row.profile,
      entryDate: row.date,
      outcome,
      exitR,
      holdingDays: exitIndex - i
    });

    i = exitIndex + 1; // no overlapping trades on this ticker -- resume only after this one resolves
  }

  return trades;
}

function summarizeTrades(trades) {
  const n = trades.length;
  if (n === 0) return null;
  const meanR = trades.reduce((a, t) => a + t.exitR, 0) / n;
  const sorted = [...trades].sort((a, b) => a.exitR - b.exitR);
  const medianR = sorted[Math.floor(n / 2)].exitR;
  const winRate = trades.filter(t => t.exitR > 0).length / n;
  const targetHits = trades.filter(t => t.outcome === 'target').length;
  const stopHits = trades.filter(t => t.outcome === 'stop').length;
  const timeouts = trades.filter(t => t.outcome === 'timeout').length;
  const avgHoldingDays = trades.reduce((a, t) => a + t.holdingDays, 0) / n;
  return { n, meanR, medianR, winRate: winRate * 100, targetHits, stopHits, timeouts, avgHoldingDays };
}

// Runs one filtered simulation across all tickers and returns its summary
// stats, ignoring score bucket entirely (a filtered comparison is testing
// specific CONDITIONS, not the aggregate score).
function runFiltered(rows, maxHoldingDays, conditionFilter) {
  const byTicker = groupByTicker(rows);
  const allTrades = [];
  for (const tickerRows of byTicker.values()) {
    allTrades.push(...simulateTicker(tickerRows, maxHoldingDays, conditionFilter));
  }
  return summarizeTrades(allTrades);
}

function printFilterStats(label, stats) {
  if (!stats) { console.log(`  ${label}: no trades`); return; }
  const flag = stats.n < MIN_SAMPLES_FOR_STATS ? '  (low sample)' : '';
  console.log(`  ${label}: n=${stats.n}  mean=${stats.meanR >= 0 ? '+' : ''}${stats.meanR.toFixed(2)}R  ` +
    `median=${stats.medianR >= 0 ? '+' : ''}${stats.medianR.toFixed(2)}R  win-rate=${stats.winRate.toFixed(0)}%  ` +
    `avg-hold=${stats.avgHoldingDays.toFixed(1)}d${flag}`);
  console.log(`    outcomes: ${stats.targetHits} hit target, ${stats.stopHits} hit stop, ${stats.timeouts} timed out`);
}

// Compares: no filter (baseline), each condition key alone, and all keys
// combined (AND'd together) -- directly answers "does combining these
// conditions add anything beyond either alone, or are they redundant."
function runComparison(rows, maxHoldingDays, keys, label) {
  if (!rows.length) {
    console.log(`${label ? label + ': ' : ''}No rows in this range.`);
    return;
  }
  const dates = [...new Set(rows.map(r => r.date))].sort();
  console.log(`${label ? '=== ' + label + ' ===\n' : ''}${rows.length} rows, ${dates.length} trading day(s): ${dates[0]} → ${dates[dates.length - 1]}\n`);

  console.log('Baseline (no condition filter, every row with a valid stop):');
  printFilterStats('all', runFiltered(rows, maxHoldingDays, null));
  console.log('');

  for (const key of keys) {
    console.log(`${key} alone:`);
    printFilterStats(`${key}=true`, runFiltered(rows, maxHoldingDays, { [key]: true }));
    console.log('');
  }

  if (keys.length > 1) {
    const combinedFilter = {};
    for (const key of keys) combinedFilter[key] = true;
    console.log(`${keys.join(' + ')} combined (all must be true):`);
    printFilterStats(keys.join('+'), runFiltered(rows, maxHoldingDays, combinedFilter));
    console.log('');
  }
}

function runSimulation(rows, maxHoldingDays, label) {
  if (!rows.length) {
    console.log(`${label ? label + ': ' : ''}No rows in this range.`);
    return;
  }

  const dates = [...new Set(rows.map(r => r.date))].sort();
  console.log(`${label ? '=== ' + label + ' ===\n' : ''}${rows.length} rows, ${dates.length} trading day(s): ${dates[0]} → ${dates[dates.length - 1]}`);

  const byTicker = groupByTicker(rows);
  const allTrades = [];
  for (const tickerRows of byTicker.values()) {
    allTrades.push(...simulateTicker(tickerRows, maxHoldingDays));
  }

  const withStop = rows.filter(r => r.stop !== null && r.stop !== undefined).length;
  console.log(`${withStop} of ${rows.length} rows had a usable stop -> ${allTrades.length} simulated trades ` +
    `(one position at a time per ticker, max ${maxHoldingDays}-day hold)\n`);

  const order = ['0-1/6 (no setup)', '2-3/6 (building)', '4/6 (setup active)', '5-6/6 (max confluence)'];
  for (const bucket of order) {
    const bucketTrades = allTrades.filter(t => t.bucket === bucket);
    const stats = summarizeTrades(bucketTrades);
    console.log(`${bucket}`);
    if (!stats) { console.log('  no trades\n'); continue; }
    const flag = stats.n < MIN_SAMPLES_FOR_STATS ? '  (low sample)' : '';
    console.log(`  n=${stats.n}  mean=${stats.meanR >= 0 ? '+' : ''}${stats.meanR.toFixed(2)}R  median=${stats.medianR >= 0 ? '+' : ''}${stats.medianR.toFixed(2)}R  ` +
      `win-rate=${stats.winRate.toFixed(0)}%  avg-hold=${stats.avgHoldingDays.toFixed(1)}d${flag}`);
    console.log(`  outcomes: ${stats.targetHits} hit target, ${stats.stopHits} hit stop, ${stats.timeouts} timed out\n`);
  }
}

function takeArgValue(args, consumed, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  consumed.add(idx);
  consumed.add(idx + 1);
  return args[idx + 1] || null;
}

async function main() {
  const args = process.argv.slice(2);
  const consumed = new Set();

  const splitDate = takeArgValue(args, consumed, '--split');
  const profileArg = takeArgValue(args, consumed, '--profile');
  const compareArg = takeArgValue(args, consumed, '--compare'); // e.g. "ATR,RS"
  const maxHoldingArg = args.find((a, i) => !consumed.has(i));
  const maxHoldingDays = maxHoldingArg ? Number(maxHoldingArg) : 20;

  let rows = await loadRows();
  if (!rows.length) { console.log('History log is empty.'); return; }

  if (profileArg) {
    const wantName = profileArg.toLowerCase().startsWith('spec') ? 'Speculative' : 'Stable';
    rows = rows.filter(r => r.profile === wantName);
    console.log(`Filtered to profile: ${wantName} (${rows.length} rows)\n`);
  }

  if (compareArg) {
    const keys = compareArg.split(',').map(k => k.trim().toUpperCase());
    console.log(`COMPARING CONDITIONS: ${keys.join(', ')} — does combining them add value beyond either alone?\n`);
    if (splitDate) {
      console.log(`SPLIT AT ${splitDate} — checked independently in both halves.\n`);
      const before = rows.filter(r => r.date < splitDate);
      const after = rows.filter(r => r.date >= splitDate);
      runComparison(before, maxHoldingDays, keys, `BEFORE ${splitDate}`);
      runComparison(after, maxHoldingDays, keys, `ON/AFTER ${splitDate}`);
    } else {
      runComparison(rows, maxHoldingDays, keys, null);
    }
  } else if (splitDate) {
    console.log(`SPLIT AT ${splitDate} — does trade expectancy hold up independently in both halves?\n`);
    const before = rows.filter(r => r.date < splitDate);
    const after = rows.filter(r => r.date >= splitDate);
    runSimulation(before, maxHoldingDays, `BEFORE ${splitDate}`);
    runSimulation(after, maxHoldingDays, `ON/AFTER ${splitDate}`);
  } else {
    runSimulation(rows, maxHoldingDays, null);
  }

  console.log(`Reminder: exit checks use daily CLOSE prices only (no intrabar highs/lows logged), so this is`);
  console.log(`an approximation of real fills, not an exact replay. R-multiples ignore fees, slippage, and`);
  console.log(`the possibility of not getting filled at the exact suggested entry price.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error('Trade simulation failed:', err); process.exit(1); });
}
