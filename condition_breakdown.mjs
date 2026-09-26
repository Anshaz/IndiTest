#!/usr/bin/env node
// ===================================================================
// Per-condition breakdown. backtest.mjs tests whether the COMBINED
// 0-6 score predicts forward returns. This tests each of the 6
// conditions INDEPENDENTLY: for VWAP-above (say), split every logged
// day into "was true" vs "was false", and compare forward returns
// between those two groups. A null result on the combined score is
// compatible with either "none of the 6 pieces work" or "some pieces
// work but summing them washes it out" — this is what tells you which.
//
// Requires history rows to have a `conditions` field (added after the
// score/target/regime work). Rows logged before that was added won't
// have it and are skipped, with a warning if that's most of your data.
//
// Usage:
//   node scripts/condition_breakdown.mjs [horizons]
//   node scripts/condition_breakdown.mjs 5,10,20
// ===================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const MIN_SAMPLES_FOR_STATS = 20;
const CONDITION_KEYS = ['VWAP', 'RSI', 'MACD', 'VOL', 'HL', 'ATR'];
const CONDITION_LABELS = {
  VWAP: 'VWAP Bias', RSI: 'RSI Momentum', MACD: 'MACD Momentum',
  VOL: 'Volume vs SMA', HL: 'Higher Low', ATR: 'ATR Compressed'
};

// Deliberately duplicated (not imported) from backtest.mjs — same rationale
// as scan.mjs/backfill.mjs's duplicated fetch logic: a change to one script
// shouldn't silently alter another's behavior without someone touching both
// on purpose.
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

function groupByTicker(rows) {
  const byTicker = new Map();
  for (const r of rows) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }
  for (const rows of byTicker.values()) rows.sort((a, b) => a.date.localeCompare(b.date));
  return byTicker;
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

// For one condition key, splits into ON/OFF episodes (same first-day-of-a-
// new-state de-duplication as backtest.mjs's score buckets, and for the
// same reason: a condition sitting ON for 6 straight days is one episode,
// not six independent trials) and computes forward returns for each side.
function computeConditionReturns(byTicker, conditionKey, horizons) {
  const groups = { on: {}, off: {} };
  let episodes = 0;

  for (const rows of byTicker.values()) {
    let prevState = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.price === null || row.price === undefined) { prevState = null; continue; }
      if (!row.conditions) { prevState = null; continue; } // pre-schema row, skip
      const flag = row.conditions[conditionKey];
      if (flag === null || flag === undefined) { prevState = null; continue; } // excluded this row (e.g. volume unavailable)

      const state = flag ? 'on' : 'off';
      const isNewEpisode = state !== prevState;
      prevState = state;
      if (!isNewEpisode) continue;
      episodes++;

      for (const h of horizons) {
        const future = rows[i + h];
        if (!future || future.price === null || future.price === undefined) continue;
        const ret = (future.price - row.price) / row.price;
        groups[state][h] ??= [];
        groups[state][h].push(ret);
      }
    }
  }
  return { groups, episodes };
}

async function main() {
  const args = process.argv.slice(2);
  const horizonArg = args.find(a => !a.startsWith('--')) || '5,10,20';
  const horizons = horizonArg.split(',').map(Number);

  const rows = await loadRows();
  if (!rows.length) { console.log('History log is empty.'); return; }

  const withConditions = rows.filter(r => r.conditions).length;
  const pct = ((withConditions / rows.length) * 100).toFixed(0);
  console.log(`${rows.length} total rows, ${withConditions} (${pct}%) have condition-level data.\n`);

  if (withConditions === 0) {
    console.log('No rows have condition-level data yet — this field was added after your existing history');
    console.log('was logged. Delete data/history.jsonl and re-run scripts/backfill.mjs to regenerate with it');
    console.log('(same command as before; it fetches fresh and recomputes everything, this time including');
    console.log('per-condition flags), or just let new live scan runs accumulate rows with the field.');
    return;
  }
  if (withConditions < rows.length * 0.5) {
    console.log('WARNING: fewer than half your rows have condition-level data. The breakdown below only uses');
    console.log('those rows, which may be a much smaller and more recent sample than your full history.\n');
  }

  const byTicker = groupByTicker(rows);
  const edgeSummary = [];

  for (const key of CONDITION_KEYS) {
    const { groups, episodes } = computeConditionReturns(byTicker, key, horizons);
    console.log(`\n${'='.repeat(64)}`);
    console.log(`${CONDITION_LABELS[key]}  (${episodes} independent ON/OFF episodes)`);
    console.log('='.repeat(64));

    for (const h of horizons) {
      const onStats = summarize(groups.on[h] || []);
      const offStats = summarize(groups.off[h] || []);
      const fmt = s => s ? `n=${s.n}  mean=${s.meanPct.toFixed(2)}%  median=${s.medianPct.toFixed(2)}%  win=${s.winRate.toFixed(0)}%` : 'no samples';
      console.log(`  +${h}d  ON:  ${fmt(onStats)}`);
      console.log(`  +${h}d  OFF: ${fmt(offStats)}`);
      if (onStats && offStats) {
        const meanEdge = onStats.meanPct - offStats.meanPct;
        const winEdge = onStats.winRate - offStats.winRate;
        const lowSample = (onStats.n < MIN_SAMPLES_FOR_STATS || offStats.n < MIN_SAMPLES_FOR_STATS) ? '  (low sample)' : '';
        console.log(`        Edge (ON minus OFF): mean ${meanEdge >= 0 ? '+' : ''}${meanEdge.toFixed(2)}pp, win-rate ${winEdge >= 0 ? '+' : ''}${winEdge.toFixed(0)}pp${lowSample}`);
        edgeSummary.push({ key, h, meanEdge, winEdge, n: Math.min(onStats.n, offStats.n) });
      }
      console.log('');
    }
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log('RANKED BY |MEAN-RETURN EDGE| (ON minus OFF), largest first');
  console.log('='.repeat(64));
  edgeSummary.sort((a, b) => Math.abs(b.meanEdge) - Math.abs(a.meanEdge));
  for (const s of edgeSummary.slice(0, 12)) {
    const flag = s.n < MIN_SAMPLES_FOR_STATS ? '  (low sample)' : '';
    console.log(`  ${CONDITION_LABELS[s.key]} +${s.h}d: ${s.meanEdge >= 0 ? '+' : ''}${s.meanEdge.toFixed(2)}pp mean, ` +
      `${s.winEdge >= 0 ? '+' : ''}${s.winEdge.toFixed(0)}pp win-rate (n~${s.n})${flag}`);
  }

  console.log(`\nReminder: same caveats as backtest.mjs (raw close-to-close returns, no fees/slippage/stop-outs).`);
  console.log(`Additionally, this does NOT control for the other 5 conditions' state at the same time — a`);
  console.log(`condition's apparent edge here could partly reflect correlation with another condition (e.g.`);
  console.log(`VWAP-above and RSI-rising tend to co-occur in a trend) rather than independent signal of its own.`);
}

main().catch(err => { console.error('Condition breakdown failed:', err); process.exit(1); });
