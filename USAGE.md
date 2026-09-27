# Using IndiTest day-to-day

**Short answer: nothing changed. You open the page, same as always.**

Everything built during the research phase of this project — the
backtesting, the regression, the extra data sources — runs separately from
the app you actually use. None of it needs to be re-run for the site to
keep working. This page explains exactly what's automatic, what you
actually touch, and the (rare) cases where you'd manually run something.

---

## What happens without you doing anything

Every weekday, ~15 minutes after the US market closes, a GitHub Action
runs on its own:

1. Scans your whole watchlist (`scan.mjs`) and writes the results.
2. Pulls fresh short-squeeze scores (`fetch_squeeze_scores.mjs`), if you've
   set up the optional Equibles key.
3. Commits both to the repo automatically.

You don't trigger this, watch it, or do anything for it to happen. It's in
`.github/workflows/scan.yml`, already configured, already running.

## What you actually do

**Open the site. Use one of the two tabs:**

- **Auto Scan** (default tab) — shows whatever the automated job produced
  last. No API key, no waiting, no rate limit. This is "check my watchlist
  right now" for the common case.
- **Manual Lookup** — for a ticker *outside* your daily watchlist, or to
  check something live instead of waiting for tomorrow's automated run.
  Needs your own free Twelve Data key, pasted into the page (stored in
  your browser, not sent anywhere else).

That's the entire day-to-day workflow. Everything else in this repo exists
to answer *"does any of this actually work,"* not to be part of using it.

## Reading what's on the page

- **The 0-6 score**: how many of the six original conditions lined up.
  Read this as a **filter, not a signal to execute on** — see
  [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) for exactly why, in
  detail. Short version: extensively tested, no combination of these six
  has been shown to beat just taking every setup.
- **Market Regime banner**: is the S&P 500 above its own 50-day trend.
  Context, not a rule.
- **Squeeze column**: Equibles' short-squeeze score, if you've set that
  key up. Separate from the 0-6 score on purpose, and not yet tested the
  way the six core conditions were.
- **12-1 Mom column**: 12-month return excluding the most recent month —
  the one additional signal that's actually survived real testing (see
  `PROJECT_OVERVIEW.md`). Still small and not yet checked for statistical
  significance — a data point worth noticing, not a reason to enter on its
  own. There's a lesson card on the page itself explaining exactly what
  was and wasn't confirmed.
- **Weekly trend**, **stop/target**: as before, unchanged.

## What's *not* shown on the page (still, and on purpose)

Three more signals — relative strength vs. SPY, 52-week-high proximity,
and post-earnings drift — were built and tested during the research phase
and are logged quietly in the background, but **not shown in the UI**.
They didn't clear the same bar momentum did (relative strength: modest,
mostly longer-horizon; 52-week-high: no consistent edge found;
post-earnings drift: can't even be properly tested yet given current data
coverage — see the overview doc). If one of them earns its way onto the
page later, that'll happen the same way momentum did: real testing first,
then a clearly-labeled, honestly-caveated addition — not a quiet
promotion.

## The only reasons you'd ever run something manually

You will almost never need this. The exceptions:

| Situation | What to run |
|---|---|
| The Action seems to have not run (page looks stale) | Repo → **Actions** tab → find "Daily confluence scan" → **Run workflow** button (manual trigger) |
| You add/remove tickers in `watchlist.config.json` | Nothing — next automatic run picks it up |
| You want to re-check whether one of the research
findings still holds, months from now, with more data | Re-run the specific research script — see `PROJECT_OVERVIEW.md`'s "Research toolkit" table |
| You're testing changes to the app locally, not on the live site | `node scripts/serve.mjs`, then open the printed `localhost` URL — **never** open `index.html` directly, browsers block it (see README) |

If you're not doing one of these four things, you don't need the terminal
at all.

## If something looks broken

- **Auto Scan shows nothing / an old date**: check the Actions tab for a
  failed run (usually a rate-limit hiccup, self-resolves next day) or
  trigger it manually as above.
- **Squeeze column is all dashes**: either the optional key isn't set, or
  that day's fetch hit its own hiccup — non-fatal, doesn't affect the main
  score.
- **Manual Lookup won't run**: check your Twelve Data key is pasted in
  and hasn't hit its daily free-tier cap (800 calls/day).

Everything else — what all the pieces mean, what was tested, what the
actual findings were — is in [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md).
