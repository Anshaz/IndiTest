#!/usr/bin/env node
// ===================================================================
// Backfills data/history.jsonl using a LONG price history pulled once
// per ticker, then replaying the exact same scoring engine day-by-day
// across it — instead of waiting weeks/months for the daily scheduled
// scan to accumulate enough rows for scripts/backtest.mjs to say
// anything meaningful.
//
// NO LOOKAHEAD: for "day i", the evaluation only ever sees
// bars[0..i] (that day's close and everything before it) — exactly
// what a live scan run on that actual day would have seen. This is
// enforced structurally (the loop always slices up to i+1), not by
// convention, and is unit-tested alongside this file.
//
// Rows from this script get `source: "backfill"`; rows already present
// for a given (date, ticker) from the real live scan are NEVER
// overwritten — the live-captured row is always treated as authoritative
// over a backfilled one for the same day.
//
// Usage:
//   TWELVEDATA_API_KEY=xxx node scripts/backfill.mjs [outputsize]
//   outputsize defaults to 1000 (~4 trading years). Twelve Data cost is
//   1 credit/symbol regardless of outputsize, so this is one paced
//   request per ticker, same budget as a normal scan.mjs run — just
//   with more rows back each time.
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

const REQUESTS_PER_MINUTE = Number(process.env.TWELVEDATA_REQUESTS_PER_MINUTE || 6);
const MIN_DELAY_MS = Math.ceil(60000 / REQUESTS_PER_MINUTE);
const OUTPUTSIZE = Number(process.argv[2] || 1000);
const MIN_WARMUP_BARS = 20; // classifyVolatility's own minimum before it'll even guess a profile

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Duplicated from scan.mjs deliberately rather than shared, so a change
// to the live scan's fetch/retry behavior can't silently alter this
// script's behavior (or vice versa) without someone touching both on
// purpose.
async function fetchOne(ticker, outputsize, retries = 3) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}&interval=1day&outputsize=${outputsize}&apikey=${encodeURIComponent(API_KEY)}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'error') {
      const creditLimited = /run out of api credits/i.test(data.message || '');
      if (creditLimited && attempt < retries) {
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

async function loadExistingHistory() {
  const logPath = path.join(ROOT, 'data', 'history.jsonl');
  try {
    const raw = await fs.readFile(logPath, 'utf8');
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (e) {
    return [];
  }
}

// The core no-lookahead walk: evaluates ticker/weekly scores for every day
// in the series, where day i's evaluation uses ONLY dailyBars[0..i].
// Exported as a named function (not inlined in main) specifically so it
// can be unit-tested in isolation for the no-lookahead property.
//
// spyBars (optional) is SPY's FULL fetched series, un-sliced -- for each
// day i, this function does its OWN no-lookahead slice of it (only SPY
// bars dated on or before that day), the same discipline as the ticker's
// own slice above. Passing the full series in and slicing per-day here
// (rather than pre-slicing outside) keeps that guarantee enforced in one
// place, the same way dailyBars.slice(0, i+1) is.
export function walkForward(ticker, dailyBars, volumeReliable, profiles, spyBars = null) {
  const rows = [];
  const hasExplicitProfile = Object.prototype.hasOwnProperty.call(profiles, ticker);

  for (let i = 0; i < dailyBars.length; i++) {
    const slice = dailyBars.slice(0, i + 1); // <-- the entire no-lookahead guarantee lives here

    const profileKey = hasExplicitProfile ? profiles[ticker] : Engine.classifyVolatility(slice);
    const cfg = Engine.getProfileConfig(profileKey);

    if (slice.length < cfg.minBars) continue; // matches evaluateTicker's own "insufficient data" behavior — skip rather than guess

    const weeklySlice = Engine.resampleToWeekly(slice);
    const dailyResult = Engine.evaluateTicker(slice, cfg, volumeReliable);
    const weeklyResult = Engine.evaluateWeekly(weeklySlice, cfg);

    let relativeStrength = { insufficient: true };
    if (spyBars) {
      const currentDate = dailyBars[i].t;
      const spySlice = spyBars.filter(b => b.t <= currentDate); // <-- same no-lookahead discipline, applied to SPY's own series
      relativeStrength = Engine.relativeStrength(slice, spySlice, 20);
    }

    // These three only look backward within the ticker's own already-sliced
    // series, so no additional no-lookahead handling is needed beyond the
    // slice itself.
    const high52w = Engine.fiftyTwoWeekHighProximity(slice);
    const momentum = Engine.momentum12Minus1(slice);
    const trend = Engine.trendStack(slice);

    const bar = dailyBars[i];
    rows.push({
      date: bar.t,
      ticker,
      profile: cfg.name,
      autoClassified: !hasExplicitProfile,
      dailyScore: dailyResult.score,
      dailyMax: dailyResult.maxScore,
      weeklyScore: weeklyResult.score,
      weeklyBullish: weeklyResult.bullish,
      price: dailyResult.details ? dailyResult.details.price : null,
      stop: dailyResult.stop,
      higherLowPrice: dailyResult.higherLow ? dailyResult.higherLow.price : null,
      atrPct: dailyResult.details ? dailyResult.details.atrPct : null,
      volumeReliable,
      conditions: {
        ...Engine.conditionFlags(dailyResult.conditions),
        RS: !relativeStrength.insufficient ? relativeStrength.outperforming : null,
        NH52: !high52w.insufficient ? high52w.nearHigh : null,
        MOM: !momentum.insufficient ? momentum.positive : null,
        TREND: !trend.insufficient ? trend.passes : null
      },
      excessReturnVsSpy: !relativeStrength.insufficient ? relativeStrength.excessReturn : null,
      pctFrom52wHigh: !high52w.insufficient ? high52w.pctFromHigh : null,
      return12m1: !momentum.insufficient ? momentum.return12m1 : null,
      source: 'backfill'
    });
  }
  return rows;
}

async function main() {
  const config = await readConfig();
  const tickers = [...new Set(config.tickers.map(t => t.trim()))];
  const profiles = config.profiles || {};

  console.log(`Backfilling ${tickers.length} tickers, outputsize=${OUTPUTSIZE} (~${Math.round(OUTPUTSIZE / 252)} trading years), paced at ~${REQUESTS_PER_MINUTE}/min...`);
  const estMinutes = Math.ceil(((tickers.length + 1) * MIN_DELAY_MS) / 60000);
  console.log(`Fetch phase estimated time: ~${estMinutes} minute(s)  (plus local computation after each fetch)\n`);

  // SPY's full history is fetched FIRST, unconditionally, before any other
  // ticker -- needed as the baseline for every OTHER ticker's day-by-day
  // relative-strength calculation. Same reasoning as scan.mjs: many
  // tickers sort ahead of SPY alphabetically, so capturing it "whenever
  // its turn comes up" in the main loop wouldn't supply it to those
  // earlier tickers.
  console.log('Fetching SPY baseline first (for relative-strength calculations)...');
  let spyBars = null;
  let spyVolumeReliable = null;
  const spyStart = Date.now();
  const spyFetched = await fetchOne('SPY', OUTPUTSIZE);
  if (spyFetched.error) {
    console.warn(`  SPY: ${spyFetched.error} — relative-strength will be unavailable for this backfill run`);
  } else {
    const sanitized = Engine.sanitizeOHLCV([...spyFetched.values].reverse());
    if (sanitized.bars.length >= MIN_WARMUP_BARS) {
      spyBars = sanitized.bars;
      spyVolumeReliable = sanitized.volumeReliable;
    } else {
      console.warn(`  SPY: only ${sanitized.bars.length} usable bars, relative-strength unavailable this run`);
    }
  }
  const spyElapsed = Date.now() - spyStart;
  if (MIN_DELAY_MS - spyElapsed > 0) await sleep(MIN_DELAY_MS - spyElapsed);

  const existingRows = await loadExistingHistory();
  const existingKeys = new Set(existingRows.map(r => `${r.date}|${r.ticker}`));
  console.log(`Existing history: ${existingRows.length} rows already logged — those (date, ticker) pairs will be kept as-is, never overwritten by backfill.\n`);

  const newRows = [];
  const errors = [];

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const started = Date.now();
    const isSpy = ticker === 'SPY';

    // SPY's own backfill turn reuses the baseline fetched above instead of
    // spending a second credit and round-trip on the same symbol.
    const fetched = isSpy
      ? (spyBars ? { reused: true } : { error: 'SPY baseline fetch failed above' })
      : await fetchOne(ticker, OUTPUTSIZE);

    if (fetched.error) {
      console.warn(`  ${ticker}: ${fetched.error}`);
      errors.push({ ticker, message: fetched.error });
    } else {
      let bars, volumeReliable;
      if (isSpy) {
        bars = spyBars;
        volumeReliable = spyVolumeReliable;
      } else {
        const sanitized = Engine.sanitizeOHLCV([...fetched.values].reverse());
        bars = sanitized.bars;
        volumeReliable = sanitized.volumeReliable;
      }

      if (bars.length < MIN_WARMUP_BARS) {
        console.warn(`  ${ticker}: only ${bars.length} usable bars after cleaning, skipping`);
        errors.push({ ticker, message: 'Insufficient bars after cleaning' });
      } else {
        const allRows = walkForward(ticker, bars, volumeReliable, profiles, spyBars);
        const freshRows = allRows.filter(r => !existingKeys.has(`${r.date}|${r.ticker}`));
        newRows.push(...freshRows);
        console.log(`  ${ticker}: ${bars.length} bars fetched -> ${allRows.length} days evaluated -> ${freshRows.length} new rows (${allRows.length - freshRows.length} already existed)`);
      }
    }

    if (i < tickers.length - 1 && !isSpy) {
      const elapsed = Date.now() - started;
      const remaining = MIN_DELAY_MS - elapsed;
      if (remaining > 0) await sleep(remaining);
    }
  }

  const combined = [...existingRows, ...newRows];
  const logPath = path.join(ROOT, 'data', 'history.jsonl');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, combined.map(r => JSON.stringify(r)).join('\n') + '\n');

  console.log(`\nWrote ${newRows.length} new backfilled rows (${combined.length} total in data/history.jsonl).`);
  if (errors.length) {
    console.warn(`${errors.length} ticker(s) failed:`, errors.map(e => e.ticker).join(', '));
  }
  console.log('\nRun scripts/backtest.mjs now — it reads the same file and needs no changes to pick this up.');
}

main().catch(err => { console.error('Backfill failed:', err); process.exit(1); });
