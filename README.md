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

## How the scan avoids rate limits

Twelve Data's free tier caps you at **8 API credits/minute**. The
comma-separated "batch" endpoint (multiple symbols in one HTTP call)
looked like the obvious optimization, but a real run showed it's billed
at a much higher weight per symbol on this plan (33 tickers batched cost
165 credits — 5/symbol) than a standard single-symbol call (1 credit/symbol,
per Twelve Data's docs). So `scan.mjs` now:

- fetches **one ticker at a time**, paced to stay under the per-minute
  budget (default: 6 requests/minute, tunable via `TWELVEDATA_REQUESTS_PER_MINUTE`)
- fetches **daily bars only** and derives weekly bars locally by
  resampling (`Engine.resampleToWeekly`), halving the requests needed per
  ticker
- retries automatically with a 65-second wait if it still hits the
  per-minute limit (e.g. from other API usage happening concurrently)

For a 33-ticker watchlist this takes roughly 5-10 minutes end to end,
occasionally more if it has to wait out a rate limit — that's expected,
not a bug. The job timeout is set to 30 minutes as a safety net for a
genuinely stuck run.

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

## Secrets & privacy

Your Twelve Data key never lives in a repo file: production reads it from
a GitHub Actions secret, and Manual Lookup keeps it in the browser's
`localStorage`. `.gitignore` covers local dev accidents (`.env`, editor/OS
cruft) — copy `.env.example` to `.env` if you want to run
`scan.mjs`/`backtest.mjs` locally (`node --env-file=.env scripts/scan.mjs`).

The thing actually worth deciding on purpose: `data/latest.json`,
`data/history.jsonl`, and `data/history/*.json` are **committed to the
repo by design** — that's how Auto Scan reads results with zero API calls.
If the repo is public, your watchlist and its daily scores are public too,
indefinitely (full history in git log). If you'd rather that stay private,
make the **repo** private rather than gitignoring those files — gitignoring
them just breaks Auto Scan (nothing for the page to fetch). A private repo
still works with GitHub Pages (GitHub Pro/Team/Enterprise) or you can serve
`data/` from anywhere else you control instead.
