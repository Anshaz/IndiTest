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

## ⚠️ Testing locally? Don't open index.html directly

**Never double-click `index.html` or open it as a `file:///...` URL.**
Every browser blocks the page from reading local files (`data/latest.json`,
`data/squeeze_scores.json`, etc.) when it's loaded that way — you'll get a
CORS error in the console and both Auto Scan and Manual Lookup's squeeze
data will silently fail, every time, on every browser. This isn't a bug
that can be fixed in the app's own code; it's a hardcoded browser security
rule.

Instead, serve the folder over `http://localhost` with the zero-dependency
server included in this repo:

```
node scripts/serve.mjs
```

Then open the URL it prints (`http://localhost:8080/index.html`) — not the
file itself. Ctrl+C stops the server. Pass a different port if 8080 is
taken: `node scripts/serve.mjs 3000`.

## One-time setup for Auto Scan

1. **Push this repo to GitHub** (if it isn't already there).
2. **Add your API key as a repo secret**: repo → Settings → Secrets and
   variables → Actions → New repository secret →
   name it `TWELVEDATA_API_KEY`, paste your key.
2b. **Optional — short-squeeze data**: add a second secret named
   `EQUIBLES_API_KEY` (free key from [equibles.com](https://equibles.com),
   no credit card, 100 requests/day) to populate the **Squeeze** column.
   Skip this and everything else works fine — that column just shows a
   dash. See [Short-squeeze scores](#short-squeeze-scores-optional) below
   for what this data actually is and its limitations.
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

**Episode de-duplication**: a ticker sitting at the same score for several
consecutive days isn't several independent signals — it's mostly the same
price move counted repeatedly. By default the backtest only counts the
*first* day a ticker enters a score bucket as one sample ("episode"), so `n`
approximates independent trials instead of raw rows. Run with `--raw`
(`node scripts/backtest.mjs 5,10,20 --raw`) to see the undeduped counts for
comparison — expect `n` to look a lot bigger and a lot less trustworthy.

**Train/test split**: if you tune a threshold or a condition after seeing a
pattern in your data, re-testing that change on the *same* data isn't real
validation — it's checking whether you copied the pattern correctly. Use
`--split DATE` to run the same bucket analysis independently on the data
before and on/after a cutoff date, so you can check whether a pattern found
across the whole dataset actually replicates in a period that couldn't have
influenced the decision:

```
node scripts/backtest.mjs 5,10,20 --split 2024-10-01
```

A real effect should show the *same* bucket winning at *roughly the same*
horizons in both halves. A pattern that only shows up in one half is
exactly what this is meant to catch — treat that as evidence the original
finding was noise, not as "needs more data." `--before DATE` and
`--after DATE` are also available individually if you just want one side.

### Backfilling history instead of waiting

Waiting for `data/history.jsonl` to accumulate one row per ticker per day in
real time means waiting weeks or months for a usable sample size. Instead:

```
node scripts/backfill.mjs           # ~4 trading years per ticker (default outputsize 1000)
node scripts/backfill.mjs 1500      # or a custom outputsize
```

This fetches each watchlist ticker's available price history **once** (still
just 1 Twelve Data credit per symbol regardless of how much history you ask
for), then replays the exact same scoring engine day-by-day across it — with
no lookahead: day *i*'s evaluation only ever sees that day's close and
everything before it, exactly what a live scan run on that actual day would
have seen. This is structurally enforced (unit-tested, not just assumed) and
produces the same row shape `scan.mjs` writes, tagged with `source:
"backfill"` so it's distinguishable from real live-scan rows if you ever
want to filter by one. Any (date, ticker) that already has a real, live-
logged row is left untouched — backfill only fills gaps, never overwrites.

Run it once to get months/years of backtest-ready data immediately, then
`scripts/backtest.mjs` picks it up with no changes needed — it reads the
same file either way.

### Per-condition breakdown

`backtest.mjs` tests whether the *combined* 0-6 score predicts forward
returns. `scripts/condition_breakdown.mjs` tests each of the 6 conditions
(VWAP, RSI, MACD, Volume, Higher Low, ATR) **independently** — splitting
history into "was this specific condition true" vs "false" and comparing
forward returns between the two groups. This is how you find out whether a
null result on the combined score means *none* of the 6 pieces carry
signal, or *some* do but summing them (with known redundancy between a few
of them) washes it out — those call for very different next steps.

```
node scripts/condition_breakdown.mjs         # default horizons: 5, 10, 20
node scripts/condition_breakdown.mjs 5,10
```

This needs each history row to carry a `conditions` field (which condition
was on/off that day) — added alongside this script. **If your
`data/history.jsonl` predates this, those rows won't have it**: delete the
file and re-run `scripts/backfill.mjs` to regenerate everything with the
new field (same command as always; nothing else changes). The script will
tell you plainly if most of your rows are missing it.

### Segmenting by profile

Every backtest above pools Stable (mega-cap) and Speculative (smaller/
newer/higher-beta) names together. `--profile stable` or `--profile spec`
filters to one group, on both `backtest.mjs` and `condition_breakdown.mjs`,
combinable with `--split`:

```
node scripts/backtest.mjs 5,10,20 --profile spec
node scripts/condition_breakdown.mjs 5,10 --profile spec --split 2024-10-01
```

Worth checking specifically because mega-caps are among the most efficiently
priced, most heavily analyzed instruments that exist — any pattern simple
enough to compute from public daily bars is exactly what gets arbitraged
away fastest there. If this scoring approach has a better chance anywhere,
it's more plausibly in the less-liquid, less-covered names, not the Stables.

### Trade simulation (actual entry/stop/target outcomes)

`backtest.mjs` and `condition_breakdown.mjs` both measure "average price
change N days later." That's not how you'd actually trade a signal — you'd
use the suggested entry, stop, and target. `scripts/trade_simulation.mjs`
simulates that directly: for each signal, enter at that day's price, hold
until price closes at/beyond the target, at/below the stop, or a max
holding period elapses, and report the outcome in R-multiples (1R = the
risk taken on entry).

```
node scripts/trade_simulation.mjs 20                          # default 20-day max hold
node scripts/trade_simulation.mjs 20 --split 2024-10-01 --profile spec
```

One position at a time per ticker — a new signal while a trade is still
open doesn't start a second, overlapping one; the next entry is only
considered after the current trade resolves. Target/reward are recomputed
from the already-logged `price`/`stop`/`profile` fields using the same
formula `engine.js` uses live, so no schema change or data regeneration is
needed for this one. Exit checks use daily close prices only (no intrabar
highs/lows are logged), so treat this as a reasonable approximation of real
fills, not an exact replay.

## Short-squeeze scores (optional)

`scripts/fetch_squeeze_scores.mjs` pulls a composite short-squeeze score
(0-100) per ticker from [Equibles](https://equibles.com), which re-serves
FINRA's official short-interest and short-volume data plus its own derived
metrics (peer percentiles, a weighted composite, and "catalyst" boosts for
things like an approaching earnings date). Requires the `EQUIBLES_API_KEY`
secret described in setup above — everything else in this project works
fine without it.

```
node scripts/fetch_squeeze_scores.mjs
```

**Running this (or `scan.mjs`/`backfill.mjs`) locally** without retyping the
key each time: copy `.env.example` to `.env`, fill in your real key(s), and
run with Node's built-in env-file support (Node 20.6+, no extra package
needed):

```
cp .env.example .env       # then edit .env with your real key(s)
node --env-file=.env scripts/fetch_squeeze_scores.mjs
```

`.env` is already covered by `.gitignore`, so it's never committed. This is
purely a local convenience — it's unrelated to the `EQUIBLES_API_KEY` /
`TWELVEDATA_API_KEY` **repo secrets** the scheduled GitHub Action uses;
setting one doesn't set the other, since the Action runs in GitHub's cloud
and never sees your local `.env` file.

One request per ticker (~58 on the default watchlist), comfortably under
the free tier's 100/day cap. ETFs (SPY, QQQ) and crypto (BTC/USD) will
always come back "not covered" — the model only covers operating companies
with FINRA short data, which is expected, not an error.

**Deliberately not folded into the 0-6 confluence score.** Every condition
already in that score was backtested before being trusted, and several
failed (see `condition_breakdown.mjs`, `backtest.mjs --split`). This gets
the same treatment: shown as separate context in the **Squeeze** column,
not blended into the score, until it's actually been validated the same
way. Worth being *more* skeptical of than the six price-based conditions,
not less — those are direct calculations from raw prices you can audit
yourself in `engine.js`; this is a third party's own proprietary composite
model layered on top of the underlying FINRA data, which isn't something
this project can independently verify.

**Can't be backfilled.** Unlike price history, the squeeze-score endpoint
has no historical time-series mode — it only reflects the current day.
`data/squeeze_history.jsonl` starts accumulating from whenever this script
first runs, one row per ticker per day, the same way `data/history.jsonl`
did before `backfill.mjs` existed. Validating whether this score means
anything will take real calendar time — realistically weeks to months
before there's enough data for `backtest.mjs`-style analysis to say
anything meaningful, using the exact same episode-dedup and `--split`
discipline already applied to everything else here.

## Files

| File | Purpose |
|---|---|
| `index.html` | The PWA — both Auto Scan and Manual Lookup tabs |
| `engine.js` | Shared scoring engine (pure functions, no DOM) |
| `scripts/scan.mjs` | Node job the scheduled Action runs; also logs history |
| `scripts/backtest.mjs` | Reads the accumulated history and reports forward returns by score bucket |
| `scripts/backfill.mjs` | One-time bulk historical fill of `data/history.jsonl`, no lookahead |
| `scripts/condition_breakdown.mjs` | Tests each of the 6 conditions independently for real signal |
| `scripts/trade_simulation.mjs` | Simulates actual entry/stop/target outcomes in R-multiples |
| `scripts/fetch_squeeze_scores.mjs` | Optional: pulls Equibles' short-squeeze score per ticker |
| `scripts/serve.mjs` | Zero-dependency local server — use this instead of opening `index.html` directly |
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
