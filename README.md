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

### Comparing combinations of conditions

Once an individual condition has survived a `condition_breakdown.mjs
--split` check, the natural next question is whether combining it with
another surviving condition adds real value, or whether they're just
redundant with each other. `--compare KEY1,KEY2,...` runs the trade
simulation four ways: no filter (baseline), each key alone, and all keys
combined (every one must be true that day) — so you can see directly
whether the combination beats either individual condition, or whether it's
no better than the stronger of the two alone.

```
node scripts/trade_simulation.mjs 20 --compare ATR,RS
node scripts/trade_simulation.mjs 20 --compare ATR,RS --split 2024-10-01
```

Validated against synthetic data with a deliberately real interaction
effect (a combined boost well beyond either condition's individual effect)
— the comparison correctly recovered it: baseline and each condition alone
showed a modest edge, the combined filter showed roughly double either
individual one, matching the injected ground truth.

## Three more signals: different mechanisms, not more oscillators

Every condition tested so far (VWAP, RSI, MACD, Volume, Higher Low, ATR,
Relative Strength) is a variation on "read something from the last ~20-50
days of price/volume." Rather than keep recombining the same kind of
input, these three come from a genuinely different place — chosen for
having a stronger evidence base than trader folklore, not because they're
popular:

- **`NH52` — Near 52-week high** (George & Hwang, 2004): is price within
  10% of its trailing-252-day high? One of the more-replicated findings in
  momentum research, and mechanically distinct from RSI — this is about
  anchoring near a salient reference price, not an overbought/oversold
  oscillator reading.
- **`MOM` — 12-1 month momentum** (Jegadeesh & Titman, 1993): the classic
  academic momentum factor — trailing ~12-month return, deliberately
  *excluding* the most recent ~1 month to dodge the well-documented
  short-term reversal effect. A genuinely different timeframe from
  anything else tested here (everything else looks at 20 trading days or
  less).
- **`TREND` — moving-average trend stack**: price above its 50-day average,
  which is above the 150-day, which is above the 200-day, with the 200-day
  itself still rising. Structural trend alignment across three timeframes
  at once, not a single oscillator's momentary reading.

**Same treatment as everything added after the original six**: surfaced as
new `conditions` keys, not folded into the 0-6 score, unvalidated until
they've actually been tested. `condition_breakdown.mjs` and
`train_long_signal.py` already know about all three — no new analysis code
needed, same as when `RS` was added.

Unit-tested with exact hand-computed values for all three (including a
specific check that `MOM`'s "skip the most recent month" window genuinely
excludes a huge injected price spike in that window, not just labels it),
and no-lookahead verified in `backfill.mjs` the same way as everything
else — a day's result is proven identical whether the series ends there or
continues 100 days further.

**To pick these up historically**, delete `data/history.jsonl` and re-run
`scripts/backfill.mjs` once more (same command as every time this has come
up before). Note that `DAILY_OUTPUTSIZE` in `scan.mjs` also increased from
260 to 300 days to give these comfortable margin above their 252/253-day
minimums — this costs nothing extra (Twelve Data charges 1 credit/symbol
regardless of size).

## A trained LONG-entry signal (regression, strict train/test discipline)

Testing conditions one at a time or in a handful of hand-picked combinations
(`--compare`) doesn't answer "which combination of conditions, weighted
correctly, gives the best entry rule." That needs a real model — but a
model is *more* prone to finding a convincing-looking pattern that isn't
real, not less, so the discipline matters even more here than everywhere
else in this project.

**The rule, stated once, applied everywhere below**: everything — which
regularization strength to use, which probability threshold counts as
"LONG," even that the threshold gets picked via cross-validation at all —
is decided using only the training period (before 2024-10-01). The test
period (on/after 2024-10-01) is touched exactly once, at the very end,
with a model and threshold that were already frozen before it was looked
at. If a result doesn't hold up there, that's the answer — not a cue to go
back and pick a different threshold.

This is Python (`scikit-learn`), not Node — the only part of this project
that is. Fitting a regularized logistic regression by hand in JavaScript
would mean either an unproven custom implementation or reinventing a
solved problem badly; `scikit-learn`'s implementation is well-tested and
what any real quant workflow would actually use. It never touches the live
app — this is a standalone analysis, same as `backtest.mjs` or
`condition_breakdown.mjs`, just in a different language for this one step.

```
pip install -r scripts/requirements.txt --break-system-packages

node scripts/export_trade_dataset.mjs 20 data/trade_dataset.jsonl
python3 scripts/train_long_signal.py data/trade_dataset.jsonl
```

**Step 1 — export**: `export_trade_dataset.mjs` reuses `trade_simulation.mjs`'s
own `simulateTicker` (the same tested target/stop/timeout/no-overlap logic
already used everywhere else) to produce one labeled row per simulated
trade — the 10 entry-day condition flags as features, and `favorable`
(`exitR > 0`, the same definition `trade_simulation.mjs` already uses for
its own win-rate) as the label. Trade logic itself is never reimplemented
in Python — only exported.

**Feature handling — uniform drop-on-null for all 10 conditions.** A row is
excluded if any of the 10 condition flags is null that day (e.g. volume
excluded, or one of the 3 newer signals hasn't warmed up yet — they need
220-253 days of price history to exist at all).

**This wasn't the first design, and the one before it is worth knowing
about.** An earlier version gave the 3 slower-warming signals (near 52-week
high, 12-1 month momentum, MA trend stack) a separate `_known` indicator
column instead of dropping the row, specifically to avoid discarding the
first year of every ticker's history during their warmup. It backfired:
because all three warm up at nearly the same point in every ticker's
history, `_known` ended up acting as a disguised marker for "which
calendar stretch is this" rather than a genuine per-observation feature —
and since the entire test period necessarily has `_known=1` for all three,
a large fitted coefficient on it (which is exactly what happened — one
came out 4-6x larger than any real feature) applied almost the same fixed
penalty to every test prediction, regardless of the actual signal values.
It produced a model that flagged next to none of the test period as LONG,
which looked like "no signal" but was actually a broken rule. Plain
drop-on-null is slower to accumulate usable data but doesn't have this
failure mode. `train_long_signal.py` now also automatically flags any
feature that's nearly constant in the test period combined with a large
coefficient — the exact signature of this bug — so a repeat of it (or
something like it) surfaces immediately instead of silently producing a
degenerate result again.

**Step 2 — fit and test**: `train_long_signal.py` splits by date (frozen,
matching every other split in this project), selects the L1 strength and
decision threshold via `TimeSeriesSplit` cross-validation *within the
training data only*, fits the final model on the full training period,
then applies it — unchanged — to the untouched test period exactly once.
Reports L1-shrunk coefficients (a condition shrunk to zero contributed no
information beyond the others), and whether the model-selected LONG trades
actually beat just taking every setup, on data the model never saw.

**A threshold needs a majority of cross-validation folds to back it, not
just two.** With a small training set, a threshold can "win" the selection
in Step 1 purely because it happened to look good on 1-2 folds' worth of
noisy data — not because it's actually a better rule. A real run of this
script hit exactly that: a threshold with only 2 of 5 folds' support beat
one with full 5-fold support on raw average score, got frozen, and then
selected **zero** test trades — not evidence of "no signal," a broken rule
that looked like one. `MIN_FOLDS_FOR_THRESHOLD` (default 3, a majority of
`N_CV_FOLDS`) now excludes thin-evidence thresholds from winning at all,
regardless of how good their raw average looks.

**Validated three ways before trusting any of this on real data**:
- **Leakage check**: ran the full pipeline once with test-period rows
  present in the file, and once with them stripped out entirely before the
  file was even read. The frozen regularization strength, threshold, and
  every coefficient came out identical both times — proof the test period
  has zero influence on any tuning decision, not just an assumption from
  reading the code. (This check also caught a real, separate reproducibility
  gap: `LogisticRegression`'s `liblinear` solver has internal randomness
  that isn't seeded by default, so re-fitting identical data in separate
  process runs could yield tiny coefficient differences from solver noise
  alone — now fixed with a pinned `random_state`, confirmed by re-running
  the same file three times and getting byte-identical output every time.)
- **Positive control**: synthetic data with a real, consistent relationship
  running through both periods — correctly recovered, and correctly beat
  baseline on the (synthetic) test period.
- **Negative control**: synthetic data where a real relationship exists
  only in the training period and is deliberately absent from the test
  period — the frozen model's *training* performance looked genuinely
  strong (which is exactly the trap: it would tempt anyone judging by that
  number alone), but applied to the untouched test period, it correctly
  and honestly reported no edge over baseline. That's the overfitting trap
  this whole discipline exists to catch, demonstrated working.

If your real data comes back the way the negative control did — solid-
looking training performance, no edge on the frozen test period — that is
the honest, useful answer this exercise was built to be capable of giving,
not a sign anything went wrong.

## Relative strength vs SPY

A stock going up isn't informative on its own if the whole market went up
more — none of the original 6 conditions look outside a ticker's own price
history to check that. This adds a 7th signal, `RS`, alongside the other 6:
does the ticker's own return over the trailing 20 trading days beat SPY's
return over the same window?

**Free** — SPY's data was already being fetched for the Market Regime
check; this reuses it, no new API calls. **Deliberately not folded into the
0-6 score**, same reasoning as everything else added after the original
six: surfaced as a `conditions.RS` flag and a continuous `excessReturnVsSpy`
value in each history row, ready for `condition_breakdown.mjs` (which
already picks it up automatically — no new analysis code needed) once
enough data has accumulated to say anything about it.

**No-lookahead, verified the same way as the rest of `backfill.mjs`**: SPY's
own series is sliced to "up to and including this day" independently for
every day evaluated, proven with the same truncated-vs-full-series test
used for the original walk-forward logic.

**To get this retroactively across your full price history**, delete
`data/history.jsonl` and re-run `scripts/backfill.mjs` once more (same
command as always — it recomputes everything, this time including `RS`).

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
| `scripts/export_trade_dataset.mjs` | Exports labeled trade data for the Python model below |
| `scripts/train_long_signal.py` | Trained LONG-entry signal, strict train/test discipline |
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
