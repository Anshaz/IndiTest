#!/usr/bin/env python3
"""
Bootstrap significance test: is a condition's observed mean-R difference
(true vs. false) actually distinguishable from noise, or just what you'd
expect from a few hundred trades by chance? This is the one rigor gap
flagged in PROJECT_OVERVIEW.md's "if you want to keep going" list, after
12-1 Month Momentum survived both the per-condition split test and the
actual trade-simulation split test.

WHY BOOTSTRAP, NOT A T-TEST: R-multiples aren't a smooth continuous
distribution -- they have mass points (exactly -1.0 for every stop-out,
exactly the reward multiplier for every target hit), so a t-test's
normality assumption doesn't really apply to individual trades. A
bootstrap resamples the ACTUAL observed trades directly and makes no
distributional assumption -- it directly answers "how much would this
look different if I re-drew trades from the same underlying pool,"
which is the honest version of the question being asked.

Run separately on BEFORE and AFTER 2024-10-01 -- the same frozen split
used everywhere else in this project. A real, non-noise edge should look
distinguishable from zero in both periods independently, not just when
the whole dataset is pooled together.

Usage:
    node scripts/export_trade_dataset.mjs 20 data/trade_dataset.jsonl   (if not already done)
    python3 scripts/significance_test.py data/trade_dataset.jsonl MOM
    python3 scripts/significance_test.py data/trade_dataset.jsonl MOM --split 2024-06-01
"""

import sys
import json
import argparse
import numpy as np
import pandas as pd

DEFAULT_SPLIT_DATE = '2024-10-01'
N_BOOTSTRAP = 10000
MIN_SAMPLES = 20


def load_dataset(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    if not rows:
        print(f"No rows in {path}.")
        sys.exit(1)
    return pd.DataFrame(rows)


def bootstrap_mean_diff(true_vals, false_vals, n_boot, rng):
    """Vectorized: draws all n_boot resamples for both groups in one shot
    rather than looping in Python, since group sizes can run into the
    thousands and this needs to run twice (BEFORE/AFTER) per condition."""
    true_resamples = rng.choice(true_vals, size=(n_boot, len(true_vals)), replace=True)
    false_resamples = rng.choice(false_vals, size=(n_boot, len(false_vals)), replace=True)
    return true_resamples.mean(axis=1) - false_resamples.mean(axis=1)


def test_one_period(label, df, key, n_boot, seed):
    known = df[df['conditions'].apply(lambda c: isinstance(c, dict) and c.get(key) is not None)]
    true_grp = known[known['conditions'].apply(lambda c: c.get(key) is True)]['exitR']
    false_grp = known[known['conditions'].apply(lambda c: c.get(key) is False)]['exitR']

    print(f"{label}:")
    if len(true_grp) < MIN_SAMPLES or len(false_grp) < MIN_SAMPLES:
        print(f"  Not enough samples (true={len(true_grp)}, false={len(false_grp)}, "
              f"need >= {MIN_SAMPLES} each) -- skipping.\n")
        return None

    rng = np.random.default_rng(seed)
    observed_diff = true_grp.mean() - false_grp.mean()
    diffs = bootstrap_mean_diff(true_grp.values, false_grp.values, n_boot, rng)
    ci_low, ci_high = np.percentile(diffs, [2.5, 97.5])
    frac_le_zero = float((diffs <= 0).mean())
    significant = ci_low > 0 or ci_high < 0

    print(f"  {key}=true : n={len(true_grp):5d}  mean={true_grp.mean():+.3f}R  median={true_grp.median():+.3f}R")
    print(f"  {key}=false: n={len(false_grp):5d}  mean={false_grp.mean():+.3f}R  median={false_grp.median():+.3f}R")
    print(f"  Observed difference (true minus false): {observed_diff:+.3f}R")
    print(f"  95% bootstrap CI on that difference: [{ci_low:+.3f}, {ci_high:+.3f}]  ({n_boot} resamples)")
    print(f"  Fraction of resamples with difference <= 0: {frac_le_zero:.1%}")
    print(f"  {'SIGNIFICANT at 95% (CI excludes zero)' if significant else 'NOT significant at 95% (CI includes zero)'}\n")
    return {'label': label, 'n_true': len(true_grp), 'n_false': len(false_grp),
            'observed_diff': observed_diff, 'ci_low': ci_low, 'ci_high': ci_high, 'significant': significant}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('dataset', help='Path to the exported trade dataset (JSONL)')
    parser.add_argument('condition', help='Condition key to test, e.g. MOM')
    parser.add_argument('--split', default=DEFAULT_SPLIT_DATE, help=f'Split date (default {DEFAULT_SPLIT_DATE})')
    parser.add_argument('--n-boot', type=int, default=N_BOOTSTRAP, help=f'Bootstrap resamples (default {N_BOOTSTRAP})')
    parser.add_argument('--seed', type=int, default=42, help='Random seed, for reproducibility')
    args = parser.parse_args()

    df = load_dataset(args.dataset)
    print(f"Loaded {len(df)} trades from {args.dataset}\n")
    print(f"Bootstrap significance test for condition: {args.condition}")
    print(f"({args.n_boot} resamples per period, 95% confidence interval, seed={args.seed})\n")

    before = df[df['date'] < args.split]
    after = df[df['date'] >= args.split]

    result_before = test_one_period(f"BEFORE {args.split}", before, args.condition, args.n_boot, args.seed)
    result_after = test_one_period(f"ON/AFTER {args.split}", after, args.condition, args.n_boot, args.seed)

    print('=' * 70)
    if result_before and result_after:
        if result_before['significant'] and result_after['significant'] and \
           (result_before['observed_diff'] > 0) == (result_after['observed_diff'] > 0):
            print(f"VERDICT: {args.condition}'s edge is statistically significant in BOTH periods, same")
            print(f"direction in both. This clears the last rigor gap this project had open for this")
            print(f"condition -- as real a result as anything else validated here.")
        elif result_before['significant'] or result_after['significant']:
            print(f"VERDICT: significant in one period but not both (or not in the same direction).")
            print(f"That's the same failure signature that sank the original ATR finding -- treat this")
            print(f"as NOT yet confirmed, not as a partial win.")
        else:
            print(f"VERDICT: not statistically significant in either period at 95% confidence. The")
            print(f"observed mean-R gap is consistent with noise given the sample sizes involved --")
            print(f"a real, honest answer, not a failed test.")
    else:
        print("VERDICT: not enough data in one or both periods to reach a conclusion yet.")
    print('=' * 70)
    print(f"\nReminder: this tests ONE condition in isolation. It does not correct for the many")
    print(f"comparisons already run across this whole project (a real, separate concern) -- read")
    print(f"this as one more careful piece of evidence about {args.condition} specifically, not a")
    print(f"final, all-purpose verdict.")


if __name__ == '__main__':
    main()
