# IndiTest — Confluence Scorer

Two ways to use it:

- **Auto Scan** (default tab) — reads `data/latest.json`, produced once a day
  by a scheduled GitHub Action. No API key typed into the browser, no
  per-visit rate limit. Just open the page.
- **Manual Lookup** (backup tab) — the original live tool. Paste your Twelve
  Data key, pick tickers, hit Run. Use this for a ticker outside your daily
  watchlist, or to double-check something right now.

Both modes score with the exact same logic — `engine.js` is the single
source of truth, imported by both the page and the scan job, so they can't
quietly disagree.

## One-time setup for Auto Scan

1. **Push this repo to GitHub** (if it isn't already there).
2. **Add your API key as a repo secret**: repo → Settings → Secrets and
   variables → Actions → New repository secret →
   name it `TWELVEDATA_API_KEY`, paste your key.
3. **Enable GitHub Pages** (or any static host) pointed at the repo root, so
   `index.html` can `fetch('./data/latest.json')` — this only works when
   served over http(s); opening `index.html` directly as a local file
   (`file://`) will usually be blocked by the browser from reading local JSON.
4. **Trigger the first run manually**: repo → Actions →
   "Daily confluence scan" → Run workflow. After it finishes, `data/latest.json`
   will exist and the Auto Scan tab will populate.
5. After that, it runs on its own on the schedule in
   `.github/workflows/scan.yml` (weekdays, ~15 minutes after the US close —
   adjust the cron line for daylight saving or your own timing preference).

## Changing the watchlist

Edit `watchlist.config.json` directly — add/remove tickers from `"tickers"`,
optionally set `"profiles"` overrides. Anything not explicitly listed in
`"profiles"` gets auto-classified as Speculative vs Stable from its own
trailing volatility. Commit the change; the next scheduled run (or a manual
trigger) picks it up.

## Historical logging (for a future backtest)

Every scan run also appends today's scored results to `data/history.jsonl`
(one row per ticker per trading day) and writes a full daily snapshot to
`data/history/<date>.json`. Re-running the same day replaces that day's
rows instead of duplicating them.

This log doubles as its own price series — no separate data source needed
for a backtest, since the scan already fetches every watchlist ticker's
price daily regardless of score. Once enough days have accumulated, run:

```
node scripts/backtest.mjs           # default horizons: 5, 10, 20 trading days
node scripts/backtest.mjs 3,7,15    # or specify your own
```

It reports mean/median forward return and win rate per score bucket per
horizon, and tells you plainly when there isn't enough history yet to trust
the numbers (it needs roughly `horizon + 20` trading days minimum). Read the
caveats it prints at the end — it's a directional sanity check on the
scoring thresholds using raw close-to-close returns (no fees, slippage, or
stop-outs modeled), not a validated trading backtest.

## Files

| File | Purpose |
|---|---|
| `index.html` | The PWA — both Auto Scan and Manual Lookup tabs |
| `engine.js` | Shared scoring engine (pure functions, no DOM) |
| `scripts/scan.mjs` | Node job the scheduled Action runs; also logs history |
| `scripts/backtest.mjs` | Reads the accumulated history and reports forward returns by score bucket |
| `watchlist.config.json` | Editable ticker list + profile overrides for the auto scan |
| `.github/workflows/scan.yml` | The schedule + secret wiring |
| `data/latest.json` | Output of the last scan — committed by the Action, read by the page |
| `data/history.jsonl` | Growing per-ticker-per-day log — the backtest dataset |
| `data/history/<date>.json` | Full daily snapshot, one file per trading day |

## Trust level

This is a heuristic multi-factor screener, refactored for correctness —
not a backtested trading system. Treat scores as "how many layers of
confirmation lined up," not a validated edge. See prior conversation for
the full breakdown of what's solid vs. what's still untested assumption.
