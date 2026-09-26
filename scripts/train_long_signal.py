#!/usr/bin/env python3
"""
Fits an L1-regularized logistic regression predicting whether a simulated
trade (from export_trade_dataset.mjs) is favorable (exitR > 0), using the
7 entry-day condition flags as features, then reports whether the
resulting LONG-entry rule beats simply taking every setup.

STRICT TRAIN/TEST DISCIPLINE (this is the entire point of this script):
- TRAIN: everything before 2024-10-01
- TEST:  everything on/after 2024-10-01 -- frozen, never touched until
  the model and its decision threshold have already been finalized.

The regularization strength (C) and the LONG/NO-LONG probability
threshold are BOTH selected using time-respecting cross-validation
WITHIN the training period only (sklearn's TimeSeriesSplit -- each fold's
validation set is chronologically after its own training portion, never
before, so this doesn't leak future information even within training).
Once frozen, they are applied to the test period exactly once. There is
no step in this script that revisits the threshold or C based on how the
test period looks -- doing that would make the test period training data
in disguise, exactly the mistake this whole exercise has been trying to
avoid.

"favorable" is frozen as exitR > 0, matching trade_simulation.mjs's own
win-rate definition -- not a new bar invented for this analysis.

A null value for any of the 7 conditions (e.g. volume data excluded that
day) causes that row to be DROPPED, not imputed -- imputing would be an
extra, unstated modeling choice.

Usage:
    node scripts/export_trade_dataset.mjs 20 data/trade_dataset.jsonl
    python3 scripts/train_long_signal.py data/trade_dataset.jsonl
"""

import sys
import json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import TimeSeriesSplit

TRAIN_TEST_SPLIT_DATE = '2024-10-01'
CONDITION_KEYS = ['VWAP', 'RSI', 'MACD', 'VOL', 'HL', 'ATR', 'RS', 'NH52', 'MOM', 'TREND']
# NOTE ON A REJECTED DESIGN: an earlier version of this script gave NH52,
# MOM, and TREND a separate "_known" indicator column instead of dropping
# rows where they were null, to avoid discarding a year of otherwise-valid
# training data during their ~220-253 day warmup. That backfired: since
# all three warm up at nearly the same point in EVERY ticker's history,
# "_known" ended up acting as a disguised marker for "which calendar
# stretch is this" rather than a genuine per-observation feature -- and
# because the entire test period necessarily has _known=1 for all three
# (by definition, long after any warmup), a large fitted coefficient on
# it applied almost uniformly to every test row, regardless of the actual
# signal values (confirmed: this produced a single-feature coefficient
# 4-6x larger than anything else, and a model that flagged ~0% of test
# opportunities as LONG regardless of their real feature values). Simple,
# uniform drop-on-null for all 10 conditions is slower to accumulate
# usable data but doesn't have this failure mode.
MIN_SAMPLES_FOR_STATS = 20
C_CANDIDATES = [0.01, 0.03, 0.1, 0.3, 1.0, 3.0, 10.0]
THRESHOLD_CANDIDATES = np.round(np.arange(0.30, 0.91, 0.02), 2)
N_CV_FOLDS = 5
MIN_FOLDS_FOR_THRESHOLD = 3  # a majority of N_CV_FOLDS -- a threshold "winning" on only 1-2 folds' worth of evidence is easily just noise from those specific folds, not a real property of that threshold


def load_dataset(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    if not rows:
        print(f"No rows in {path} -- run export_trade_dataset.mjs first.")
        sys.exit(1)
    return pd.DataFrame(rows)


def build_features(df):
    """Extracts the 10 condition flags as 0/1 features, dropping any row
    with a null value for any of them (excluded, or not yet computable
    that day) rather than imputing or flagging. Returns the filtered df
    (index reset), its feature matrix, and how many rows were dropped."""
    original_n = len(df)
    cols = {}
    mask = pd.Series(True, index=df.index)
    for key in CONDITION_KEYS:
        col = df['conditions'].apply(lambda c: c.get(key) if isinstance(c, dict) else None)
        cols[key] = col
        mask &= col.notna()

    df_filtered = df[mask].reset_index(drop=True)
    X = pd.DataFrame({key: cols[key][mask].reset_index(drop=True).astype(int).values for key in CONDITION_KEYS})
    dropped = original_n - len(df_filtered)
    return df_filtered, X, dropped


def cv_select_threshold_for_C(X, y, exitR, C):
    """Time-respecting CV within training data: for regularization
    strength C, finds whichever decision threshold has the best AVERAGE
    held-out mean-R across folds, requiring at least MIN_SAMPLES_FOR_STATS
    selected trades in a fold for that fold to count toward a threshold's
    average (an average of one or two noisy trades isn't trustworthy).
    Returns (best_threshold, its_avg_score, folds_used) or (None, None, 0)
    if nothing had enough data to evaluate."""
    tscv = TimeSeriesSplit(n_splits=N_CV_FOLDS)
    threshold_fold_scores = {t: [] for t in THRESHOLD_CANDIDATES}

    for train_idx, val_idx in tscv.split(X):
        X_tr, X_val = X.iloc[train_idx], X.iloc[val_idx]
        y_tr = y.iloc[train_idx]
        exitR_val = exitR.iloc[val_idx].reset_index(drop=True)

        if y_tr.nunique() < 2:
            continue  # degenerate fold (all one class), skip

        model = LogisticRegression(l1_ratio=1, C=C, solver='liblinear', max_iter=1000, random_state=42)
        model.fit(X_tr, y_tr)
        probs_val = model.predict_proba(X_val)[:, 1]

        for t in THRESHOLD_CANDIDATES:
            selected = exitR_val[probs_val >= t]
            if len(selected) < MIN_SAMPLES_FOR_STATS:
                continue
            threshold_fold_scores[t].append(selected.mean())

    avg_scores = {t: np.mean(v) for t, v in threshold_fold_scores.items() if len(v) >= MIN_FOLDS_FOR_THRESHOLD}
    if not avg_scores:
        return None, None, 0
    best_t = max(avg_scores, key=avg_scores.get)
    return best_t, avg_scores[best_t], len(threshold_fold_scores[best_t])


def summarize_trades(sub_df):
    n = len(sub_df)
    if n == 0:
        return None
    mean_r = sub_df['exitR'].mean()
    median_r = sub_df['exitR'].median()
    win_rate = (sub_df['exitR'] > 0).mean() * 100
    target_pct = (sub_df['outcome'] == 'target').mean() * 100
    stop_pct = (sub_df['outcome'] == 'stop').mean() * 100
    timeout_pct = (sub_df['outcome'] == 'timeout').mean() * 100
    total_r = sub_df['exitR'].sum()
    return {
        'n': n, 'mean_r': mean_r, 'median_r': median_r, 'win_rate': win_rate,
        'target_pct': target_pct, 'stop_pct': stop_pct, 'timeout_pct': timeout_pct,
        'total_r': total_r, 'r_per_trade': total_r / n
    }


def print_stats(label, stats):
    if stats is None:
        print(f"  {label}: no trades")
        return
    flag = '  (LOW SAMPLE)' if stats['n'] < MIN_SAMPLES_FOR_STATS else ''
    print(f"  {label}: n={stats['n']}  mean={stats['mean_r']:+.2f}R  median={stats['median_r']:+.2f}R  "
          f"win-rate={stats['win_rate']:.0f}%{flag}")
    print(f"    outcomes: target={stats['target_pct']:.0f}%  stop={stats['stop_pct']:.0f}%  timeout={stats['timeout_pct']:.0f}%")
    print(f"    total R={stats['total_r']:+.1f}  R-per-trade={stats['r_per_trade']:+.3f}")


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/train_long_signal.py <dataset.jsonl>")
        sys.exit(1)

    path = sys.argv[1]
    df_raw = load_dataset(path)
    print(f"Loaded {len(df_raw)} labeled trades from {path}\n")

    df, X, dropped = build_features(df_raw)
    print(f"{dropped} trade(s) dropped (a condition was null/excluded that entry day); {len(df)} usable\n")

    y = df['favorable']
    exitR = df['exitR']

    train_mask = df['date'] < TRAIN_TEST_SPLIT_DATE
    df_train, X_train, y_train, exitR_train = (
        df[train_mask].reset_index(drop=True), X[train_mask].reset_index(drop=True),
        y[train_mask].reset_index(drop=True), exitR[train_mask].reset_index(drop=True)
    )
    df_test, X_test = df[~train_mask].reset_index(drop=True), X[~train_mask].reset_index(drop=True)

    print(f"TRAIN: {len(df_train)} trades, {df_train['date'].min()} -> {df_train['date'].max()}")
    print(f"TEST:  {len(df_test)} trades, {df_test['date'].min()} -> {df_test['date'].max()} "
          f"(frozen -- not touched again until the final report)\n")

    order = df_train['date'].argsort().values
    X_train_s = X_train.iloc[order].reset_index(drop=True)
    y_train_s = y_train.iloc[order].reset_index(drop=True)
    exitR_train_s = exitR_train.iloc[order].reset_index(drop=True)

    print('=' * 74)
    print('STEP 1 - selecting L1 strength (C) and decision threshold via time-respecting')
    print('cross-validation WITHIN the training period only')
    print('=' * 74)

    best = {'C': None, 'threshold': None, 'score': -np.inf}
    for C in C_CANDIDATES:
        t, score, folds_used = cv_select_threshold_for_C(X_train_s, y_train_s, exitR_train_s, C)
        if t is None:
            print(f"  C={C:<6}: no threshold had enough held-out samples across folds, skipped")
            continue
        print(f"  C={C:<6}: best threshold={t:.2f}  ->  avg held-out mean R={score:+.3f}  ({folds_used} usable folds)")
        if score > best['score']:
            best = {'C': C, 'threshold': t, 'score': score}

    if best['C'] is None:
        print("\nNo (C, threshold) combination had enough held-out samples to evaluate anywhere in the")
        print("training period. Not enough data yet for this analysis -- stopping here.")
        return

    print(f"\nFROZEN: C={best['C']}, threshold={best['threshold']:.2f} "
          f"(chosen by best average cross-validated mean R, using TRAIN data only)\n")

    print('=' * 74)
    print('STEP 2 - fitting the FINAL model on the FULL training period')
    print('=' * 74)
    final_model = LogisticRegression(l1_ratio=1, C=best['C'], solver='liblinear', max_iter=1000, random_state=42)
    final_model.fit(X_train, y_train)

    print("\nFitted coefficients (L1 regularization - a value at or near 0 means that")
    print("condition added no information beyond the others):")
    for key, coef in zip(X.columns, final_model.coef_[0]):
        marker = '  <- dropped by L1 (zero)' if abs(coef) < 1e-8 else ''
        print(f"  {key:12s}: {coef:+.3f}{marker}")
    print(f"  intercept: {final_model.intercept_[0]:+.3f}\n")

    # Safeguard: a feature that's nearly constant in the TEST period can't
    # discriminate anything there -- if it ALSO has a large fitted
    # coefficient, that combination applies almost the same fixed nudge to
    # every test prediction regardless of the other features' real values.
    # This is exactly what happened with an earlier "_known" flag design in
    # this script (a disguised time-period marker, not a genuine
    # observation-level feature) -- flagged automatically here so a repeat
    # doesn't silently produce a degenerate result again.
    test_variance = X_test.var()
    coef_by_key = dict(zip(X.columns, final_model.coef_[0]))
    flagged = [(k, test_variance[k], coef_by_key[k]) for k in X.columns
               if test_variance[k] < 0.01 and abs(coef_by_key[k]) > 0.3]
    if flagged:
        print("WARNING: the following feature(s) are nearly constant in the TEST period but have a")
        print("large fitted coefficient -- this can dominate every test prediction regardless of the")
        print("other features' real values (this exact pattern broke an earlier run of this script):")
        for key, var, coef in flagged:
            print(f"  {key}: test variance={var:.4f}, coefficient={coef:+.3f}")
        print("Treat the STEP 3 result below with real skepticism until this is investigated.\n")


    print('=' * 74)
    print('STEP 3 - applying the FROZEN model + threshold to the UNTOUCHED TEST period')
    print('(no re-tuning past this point, whatever the result looks like)')
    print('=' * 74 + '\n')

    test_probs = final_model.predict_proba(X_test)[:, 1]
    long_mask = test_probs >= best['threshold']
    print(f"Model flagged {long_mask.sum()} of {len(df_test)} test opportunities as LONG "
          f"({100 * long_mask.sum() / len(df_test):.0f}% of them)\n")

    baseline_stats = summarize_trades(df_test)
    long_stats = summarize_trades(df_test[long_mask])
    rejected_stats = summarize_trades(df_test[~long_mask])

    print("BASELINE (every test trade, no model filter):")
    print_stats('all', baseline_stats)
    print("\nMODEL-SELECTED LONG (P(favorable) >= frozen threshold):")
    print_stats('model-long', long_stats)
    print("\nMODEL-REJECTED (the model would have skipped these):")
    print_stats('model-rejected', rejected_stats)

    print("\n" + '=' * 74)
    if baseline_stats and long_stats and long_stats['n'] >= MIN_SAMPLES_FOR_STATS:
        if long_stats['mean_r'] > baseline_stats['mean_r']:
            print("VERDICT: model-selected LONG trades beat baseline on the untouched test period")
            print(f"({long_stats['mean_r']:+.2f}R vs {baseline_stats['mean_r']:+.2f}R). This is real evidence -")
            print("a signal derived only from training data, applied once, unchanged, to data it never saw.")
        else:
            print("VERDICT: model-selected LONG trades did NOT beat baseline on the untouched test period")
            print(f"({long_stats['mean_r']:+.2f}R vs {baseline_stats['mean_r']:+.2f}R).")
            print("Given these 7 conditions and this trade definition, there is not yet evidence for a")
            print("generalizable LONG-entry signal beyond simply taking every setup. That is a real,")
            print("useful answer, not a failed run.")
    else:
        print("VERDICT: too few model-selected trades in the test period to draw a conclusion either way.")
    print('=' * 74)

    print("\n(Reference only, NOT evidence - in-sample performance on the training data itself,")
    print("naturally looks more optimistic than the untouched test result just from being fit to it:)")
    train_probs = final_model.predict_proba(X_train)[:, 1]
    long_mask_train = train_probs >= best['threshold']
    print_stats('train baseline', summarize_trades(df_train))
    print_stats('train model-long', summarize_trades(df_train[long_mask_train]))


if __name__ == '__main__':
    main()
