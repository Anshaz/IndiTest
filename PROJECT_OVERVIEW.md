# IndiTest — Project Overview

What this project is, what it's made of, and — most importantly — what was
actually *learned* by building it. If you only read one section, read
[Key Findings](#key-findings): it's the actual output of everything else
in this document.

For "I just want to use the thing," see [`USAGE.md`](./USAGE.md) instead.
This document is the "what is all this and why" reference.

---

## What this is, in one paragraph

IndiTest started as a technical-analysis stock screener: a 0-6 confluence
score built from six textbook conditions (VWAP position, RSI momentum,
MACD, volume, price structure, volatility). It became something more
interesting than that: a running experiment in whether that kind of
screener actually has predictive value, using real backtesting discipline
— not "does the theory sound right," but "does it survive being checked
against data it couldn't have influenced." Most of this document is about
that experiment and what it found, because that's most of the actual work.

---

## Architecture: two separate things sharing one data folder

### 1. The production app — this is what you use

```
engine.js  →  the scoring logic. Single source of truth.
   ↑                ↑
scan.mjs      index.html
(daily,       (Auto Scan reads data/latest.json;
 automated)    Manual Lookup calls Twelve Data live)
```

`engine.js` is imported by both the daily scan job and the web page, so
they can't quietly compute different scores for the same ticker. Automated
by `.github/workflows/scan.yml` — see `USAGE.md` for what that means
practically (nothing you need to do).

### 2. The research toolkit — this is what answered "does it work"

A chain of scripts, each answering one more specific question than the
last, all reading/writing `data/history.jsonl`:

```
backfill.mjs               → bulk historical data (one-time, ~4-6 years)
      ↓
backtest.mjs                → does the 0-6 SCORE predict forward returns?
condition_breakdown.mjs     → does each CONDITION alone predict returns?
trade_simulation.mjs        → does it produce real profit using actual
                               entry/stop/target trade mechanics?
export_trade_dataset.mjs  → 
train_long_signal.py        → does a properly-regularized model find a
                               combination that survives an untouched
                               test period?
```

None of these run automatically. None of them need to. They were built to
answer a question once (or occasionally re-answer it as more data
accumulates); they are not part of the live app.

---

## The scoring engine: every condition, and its validation status

The single most important thing this document can tell you: **being in
the engine does not mean being proven.** Here is the honest status of
every signal `engine.js` computes.

### The original six (make up the visible 0-6 score)

| Condition | What it checks | Validation status |
|---|---|---|
| **VWAP Bias** | Price vs. volume-weighted average price | Tested extensively — no consistent edge, sign flips between time periods |
| **RSI Momentum** | Divergence / oversold bounce / healthy slope | Same — no consistent edge |
| **MACD Momentum** | Histogram turning up | Same — no consistent edge |
| **Volume vs SMA** | Above-average volume on the move | Same — no consistent edge |
| **Higher Low** | Structural higher low (also sets the stop) | Same — no consistent edge, and shows a *negative* trend at longer horizons |
| **ATR Expanded** | Volatility already expanding (flipped from the original "compression" theory after evidence) | **The one condition that looked real enough to act on — and then failed a proper train/test split.** See the ATR story below; this is the most important cautionary result in the whole project. |

**The 0-6 score itself**: tested via bucket-level backtest, per-condition
breakdown, direct combination trade simulation, and a full regularized
regression. **None of these showed the combined score beating simply
taking every setup, on data withheld from whatever produced the finding.**
Treat the score as a discretionary filter — a way to narrow attention — not
as something to execute against.

### Four more, added later — one now shown in the UI, three still background-only

| Condition | What it checks | Why it was added | Validation status | In the UI? |
|---|---|---|---|---|
| **RS** (Relative Strength vs SPY) | Beats the market's own return over 20 days | New *kind* of information — nothing else looks outside a ticker's own price history | Modest positive edge at 20d, weaker/mixed at shorter horizons | No |
| **NH52** (Near 52-Week High) | Within 10% of the trailing 252-day high | Real academic basis (George & Hwang, 2004) | No consistent edge found | No |
| **MOM** (12-1 Month Momentum) | 12-month return, excluding the most recent month | Real academic basis (Jegadeesh & Titman, 1993) — deliberately a different timeframe than anything else tested | **The strongest result in the project — see below.** Survived a per-condition split test AND an actual trade-simulation split test. | **Yes** — a column in Auto Scan, a line in Manual Lookup, and its own lesson card, all clearly caveated |
| **TREND** (MA Trend Stack) | Price above 50-day > 150-day > 200-day, 200-day rising | Structural trend alignment, different mechanism than an oscillator | No consistent edge found | No |

RS, NH52, and TREND are computed and logged into `data/history.jsonl` on
every scan but deliberately kept out of both the 0-6 score and the UI —
they haven't earned it yet. MOM is the one exception, and even it is
surfaced as clearly-separate context, not folded into the 0-6 score,
with its own lesson card stating plainly what was and wasn't confirmed
(see [Key Findings](#key-findings) below for the exact result, and the
"significance test" note there for what's still open).

### One more, research-only, not even fully testable yet

| Condition | What it checks | Status |
|---|---|---|
| **EARN** (Post-Earnings Surprise) | Recent positive earnings surprise, within a 60-day drift window | Free-tier Finnhub only provides ~1 year of earnings history, which doesn't meaningfully overlap the training period used everywhere else in this project. **Cannot currently be properly split-tested.** An eye-catching `+7.22pp` reading in one uncontrolled window is not evidence — there's no comparison period to check it against. See `README.md`'s earnings section for what would fix this (more calendar time, or a paid Finnhub tier). |

---

## The methodology, briefly explained

If you're wondering why so much of this project is testing infrastructure
rather than screener features, here's the short version of why each piece
exists:

- **Episode de-duplication**: a ticker sitting at the same score for 6
  straight days is mostly one price move, not six independent trials.
  Every backtest here counts the *first* day of a new state as one sample,
  not every day.
- **Train/test split**: any pattern found by looking at a full dataset can
  look real and still be noise. Every serious finding in this project was
  checked by freezing a decision (a threshold, a flipped condition, a
  regression's hyperparameters) using only data *before* 2024-10-01, then
  applying it *once*, unchanged, to data *after* that date. A result that
  only shows up in one half is treated as noise, however good it looked in
  the full dataset.
- **No-lookahead, enforced structurally**: every backfilled historical
  score uses only price data that would have existed on that actual day —
  proven, not assumed, by checking that truncating a series at day N
  produces an identical result to running the full series and reading day
  N off it.
- **Trade simulation over raw forward-return**: "the stock was up 3% five
  days later" isn't the same as "a trade using this app's actual stop and
  target made money." Several signals (ATR, Relative Strength) looked
  meaningfully better in raw returns than they did once run through real
  entry/stop/target mechanics — the trade simulator exists because that
  gap turned out to matter.

---

## Key findings

This is the actual point of the whole project. In order of how much
confidence each one deserves:

### 1. The original six-condition confluence score does not have a demonstrated edge

Tested every way this project knows how to test something: bucket
backtesting, per-condition isolation, direct trade simulation, and a
properly-disciplined regularized regression. None of it produced a
combined signal that beat simply taking every setup, on data withheld from
whatever produced the result. **Use the score as a filter for where to
look, not as a reason to enter a trade.**

### 2. ATR is the project's most important cautionary tale

A per-condition test found compression consistently *underperforming*
expansion — the opposite of the original assumption — with the rare
property of holding the same direction across every horizon tested. That
consistency is exactly what real evidence should look like, so the
condition was flipped based on it. **The flip then failed a real
train/test split**: best-performing bucket in one time period, worst in
the other. The single most convincing-looking finding in this entire
project turned out to be the clearest case of something that looked real
and wasn't. Worth remembering before trusting *any* single-window result,
including the ones below.

### 3. 12-1 Month Momentum is the one signal that has actually held up

- Split-tested at the condition level: same direction, same rough
  magnitude, in both the pre- and post-2024-10-01 periods, at all three
  horizons (5/10/20 days).
- Split-tested through actual trade simulation (not just raw return):
  direction still holds in both halves, though the edge shrinks to
  roughly **+0.01R to +0.04R per trade** once real stop/target mechanics
  are applied — small relative to the natural spread of individual trade
  outcomes.
- Backed by real, independently-replicated academic literature
  (Jegadeesh & Titman, 1993), chosen for that reason before testing it —
  not found first and rationalized after.
- **The one remaining rigor gap — whether that small an edge is
  statistically distinguishable from noise — now has a tool**:
  `scripts/significance_test.py`, a bootstrap test on the mean-R
  difference, run independently on both sides of the split. Validated
  against synthetic data with a known real edge, known pure noise, and a
  known vanishing edge (mirroring the ATR failure) before trusting it —
  all three came back correctly. Run it and read its own printed verdict
  for the current, final word on this; it's more up to date than this
  paragraph.
- **Now surfaced in the live app** — a column in Auto Scan, a line in
  Manual Lookup, and its own lesson card explaining exactly this: real
  evidence, still not proof, explicitly invoking the ATR comparison so
  the caveat is visible right where the number is, not buried in a
  document.
- **Still missing**: walk-forward validation beyond the single
  2024-10-01 split (one boundary tested is better than none, but not the
  same as repeated out-of-sample confirmation).

This is worth taking seriously. It is not yet worth trading on alone.

### 4. Relative Strength vs. SPY: a real but modest, mostly longer-horizon signal

Holds up reasonably at 20 days; weaker and less consistent at 5-10 days.
Combining it with ATR (the two conditions that individually looked most
promising) made results *worse*, not better — a useful negative result
in its own right, showing that "two good signals" doesn't imply "a good
combination."

### 5. Post-Earnings Surprise: an intriguing number that cannot currently be trusted

The largest raw edge measured in the whole project (+7.22pp at 20 days) —
and structurally untestable given current data coverage, since there's no
"before" period to compare it against. Treat as an anecdote until either
more real-time data accumulates or a paid data tier provides full history.

### 6. Everything else (RSI, MACD, Volume, Higher Low, Near-52-Week-High, MA Trend Stack)

No consistent edge found, across every method used to test it.

---

## Where things actually live

### Production (what runs the app)

| File | Role |
|---|---|
| `engine.js` | The scoring logic — single source of truth for both the scan and the page |
| `scripts/scan.mjs` | Daily automated scan (runs via GitHub Action) |
| `index.html` | The web app — Auto Scan + Manual Lookup |
| `.github/workflows/scan.yml` | The automation itself |
| `scripts/serve.mjs` | Local dev server (only for testing locally, never for the live site) |
| `watchlist.config.json` | Your tracked tickers and Stable/Speculative overrides |

### Research toolkit (what answered whether it works — not needed day-to-day)

| File | Question it answers |
|---|---|
| `scripts/backfill.mjs` | Bulk-generates years of historical scan data at once |
| `scripts/backtest.mjs` | Does the combined 0-6 score predict forward returns? (`--split`, `--profile`, episode dedup) |
| `scripts/condition_breakdown.mjs` | Does each condition, alone, predict forward returns? |
| `scripts/trade_simulation.mjs` | Does it produce real profit via actual entry/stop/target mechanics? (`--compare` for combinations) |
| `scripts/export_trade_dataset.mjs` | Turns simulated trades into a labeled dataset for modeling |
| `scripts/train_long_signal.py` | Properly train/test-disciplined regularized regression across all conditions |
| `scripts/significance_test.py` | Bootstrap test: is a condition's R-multiple edge distinguishable from noise? |
| `scripts/fetch_squeeze_scores.mjs` | Pulls Equibles' short-squeeze score (this one *is* wired into the daily automation and *is* shown in the UI) |
| `scripts/fetch_earnings_surprises.mjs` | Pulls Finnhub earnings-surprise history (research only) |
| `scripts/enrich_earnings_signal.mjs` | Adds the EARN signal to existing historical data (research only) |

### Data files

| File | What it holds |
|---|---|
| `data/latest.json` | Today's scan results — what Auto Scan displays |
| `data/history.jsonl` | Accumulated + backfilled historical scan records, with every condition logged — the research toolkit's raw material |
| `data/squeeze_scores.json` | Latest Equibles snapshot — feeds the UI's Squeeze column |
| `data/earnings_raw.json` | Cached raw Finnhub earnings data (research only) |
| `data/trade_dataset.jsonl` | Exported labeled trades for the Python regression (research only) |

---

## If you want to keep going

The two items that used to be listed here — a significance test for the
momentum edge, and surfacing it in the live UI — are both done. What's
actually left, if you want to keep pushing:

1. **Run `significance_test.py` on your own real data**, if you haven't
   yet, and read its verdict. It's the current final word on whether
   momentum's edge is real or noise — more current than any paragraph in
   this document.
2. **Walk-forward validation** for momentum, beyond the single
   2024-10-01 split — repeated out-of-sample confirmation across several
   rolling boundaries, not just one. The natural next rigor step if the
   significance test comes back clean.
3. **A genuinely different data source**, if the momentum finding
   plateaus here — fundamentals beyond earnings surprises, institutional
   flow (SEC EDGAR, free), or a different asset class entirely. Everything
   tested so far has been price/volume-derived except EARN; momentum
   being the standout among that whole family is itself a hint that
   further gains are more likely to come from genuinely new information
   than from further recombination of what's already here.

None of these are required. The project is in a genuinely stable,
well-tested state without them — this is just where the honest "what's
left" list starts now.
