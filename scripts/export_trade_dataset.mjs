#!/usr/bin/env node
// ===================================================================
// Exports a flat, labeled dataset for statistical modeling: one row per
// simulated trade, using the exact same, already-tested simulateTicker
// logic from trade_simulation.mjs (target/stop/timeout math, no-overlap
// entries, profile-specific reward multipliers), with the 7 entry-day
// condition flags as features and the trade's outcome as a label.
//
// Deliberately reuses simulateTicker rather than reimplementing trade
// logic in Python -- that function has 12+ unit tests behind it already
// (exact R-multiple math, the no-overlapping-trades rule, a corrected
// synthetic interaction-effect test) and reimplementing the same rules a
// second time in a second language is how two versions quietly drift
// apart. This script's only job is the export; all trade logic still
// lives in one place.
//
// "favorable" is frozen as exitR > 0 -- the SAME definition
// trade_simulation.mjs already uses for its own win-rate reporting, not
// a new bar invented for this analysis.
//
// No filter is applied here (every row with a valid stop is a candidate
// entry) -- this matches trade_simulation.mjs's own "baseline" semantics,
// so the exported dataset's un-filtered population is directly comparable
// to every baseline number already reported elsewhere in this project.
//
// Usage:
//   node scripts/export_trade_dataset.mjs [maxHoldingDays] [outputPath]
//   node scripts/export_trade_dataset.mjs 20 data/trade_dataset.jsonl
// ===================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTicker, groupByTicker } from './trade_simulation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

async function loadRows() {
  const logPath = path.join(ROOT, 'data', 'history.jsonl');
  let raw;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch (e) {
    console.error('No data/history.jsonl yet — run scripts/scan.mjs or scripts/backfill.mjs first.');
    process.exit(1);
  }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export async function buildDataset(maxHoldingDays) {
  const rows = await loadRows();
  const byTicker = groupByTicker(rows);

  const dataset = [];
  let skippedNoConditions = 0;

  for (const [ticker, tickerRows] of byTicker.entries()) {
    const trades = simulateTicker(tickerRows, maxHoldingDays); // no filter -- matches "baseline" everywhere else in this project
    const rowsByDate = new Map(tickerRows.map(r => [r.date, r]));

    for (const trade of trades) {
      const entryRow = rowsByDate.get(trade.entryDate);
      if (!entryRow || !entryRow.conditions) { skippedNoConditions++; continue; } // pre-schema-upgrade rows, or a lookup miss

      dataset.push({
        ticker,
        date: trade.entryDate,
        profile: trade.profile,
        conditions: entryRow.conditions, // {VWAP, RSI, MACD, VOL, HL, ATR, RS}, each true/false/null
        outcome: trade.outcome,
        exitR: trade.exitR,
        favorable: trade.exitR > 0 ? 1 : 0 // frozen definition, matches trade_simulation.mjs's own win-rate
      });
    }
  }

  return { dataset, skippedNoConditions };
}

export async function main() {
  const maxHoldingDays = Number(process.argv[2] || 20);
  const outPath = process.argv[3] || null;

  const { dataset, skippedNoConditions } = await buildDataset(maxHoldingDays);
  const output = dataset.map(d => JSON.stringify(d)).join('\n') + '\n';

  if (outPath) {
    const fullPath = path.isAbsolute(outPath) ? outPath : path.join(ROOT, outPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, output);
    console.error(`Wrote ${dataset.length} labeled trade examples to ${fullPath} ` +
      `(${skippedNoConditions} trades skipped: no condition data logged for that entry)`);
  } else {
    process.stdout.write(output);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error('Dataset export failed:', err); process.exit(1); });
}
