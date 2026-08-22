// ===================================================================
// Confluence Scoring Engine — shared, isomorphic (browser + Node.js).
//
// This is the SINGLE source of truth for the indicator math and the
// 6-layer confluence scoring logic. Both the live in-browser "Manual
// Lookup" tool (index.html) and the scheduled "Auto Scan" job
// (scripts/scan.mjs) import THIS file, so the two modes can never
// silently drift apart and disagree on what a "5/6" means.
//
// No DOM, no localStorage, no fetch — pure functions of OHLCV data in,
// scores out. Safe to run in a browser <script> tag or `require()` from
// Node.
// ===================================================================
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;               // Node / CommonJS (scan.mjs, tests)
  }
  if (root) {
    Object.assign(root, mod);           // Browser: attach as globals, same
  }                                      // names the old inline script used.
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {

  const DEFAULT_PROFILES = {
    // Stable — mega-cap / lower-volatility, spanning more sectors
    "ADBE": "stable", "AAPL": "stable", "AMD": "stable", "AMAT": "stable",
    "AMZN": "stable", "ANET": "stable", "ASML": "stable", "AVGO": "stable",
    "CDNS": "stable", "GOOGL": "stable", "LLY": "stable", "LRCX": "stable",
    "MA": "stable", "META": "stable", "MSFT": "stable", "MU": "stable",
    "NFLX": "stable", "NVDA": "stable", "ORCL": "stable", "QCOM": "stable",
    "V": "stable", "NOW": "stable",
    "JPM": "stable", "GS": "stable", "JNJ": "stable", "UNH": "stable",
    "PG": "stable", "KO": "stable", "WMT": "stable", "COST": "stable",
    "XOM": "stable", "CVX": "stable", "CAT": "stable", "DIS": "stable",
    "INTC": "stable", "SPY": "stable", "QQQ": "stable",
    // Speculative — low-float / high-beta / newer, spanning more themes
    "BBAI": "spec", "BTC/USD": "spec", "CRWD": "spec", "HIMS": "spec",
    "MARA": "spec", "MELI": "spec", "PLTR": "spec", "SNDK": "spec",
    "SOFI": "spec", "TTD": "spec", "TSLA": "spec",
    "COIN": "spec", "RIOT": "spec", "MRNA": "spec", "RIVN": "spec",
    "LCID": "spec", "BABA": "spec", "NIO": "spec", "RKLB": "spec",
    "IONQ": "spec", "CRCL": "spec"
  };

  // ===================== INDICATOR MATH =====================
  function ema(data, period) {
    const k = 2 / (period + 1);
    const out = [];
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) { out.push(null); sum += data[i]; continue; }
      if (i === period - 1) { sum += data[i]; out.push(sum / period); continue; }
      out.push(data[i] * k + out[i - 1] * (1 - k));
    }
    return out;
  }

  function sma(data, period) {
    const out = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) { out.push(null); continue; }
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[i - j];
      out.push(sum / period);
    }
    return out;
  }

  function rsi(closes, period = 14) {
    const out = [];
    let gains = 0, losses = 0;
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) { out.push(null); continue; }
      const change = closes[i] - closes[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      if (i < period) {
        gains += gain; losses += loss;
        out.push(null); continue;
      }
      if (i === period) {
        gains = (gains + gain) / period;
        losses = (losses + loss) / period;
      } else {
        gains = (gains * (period - 1) + gain) / period;
        losses = (losses * (period - 1) + loss) / period;
      }
      if (losses === 0) { out.push(100); continue; }
      const rs = gains / losses;
      out.push(100 - (100 / (1 + rs)));
    }
    return out;
  }

  // EMA over a series that may start with leading nulls. Walks forward from the
  // first non-null index instead of relying on positional reconstruction, so it
  // stays correct even if the input has internal gaps.
  function emaFromIndex(values, period) {
    const k = 2 / (period + 1);
    const out = new Array(values.length).fill(null);
    let startIdx = -1;
    for (let i = 0; i < values.length; i++) {
      if (values[i] !== null && values[i] !== undefined && !Number.isNaN(values[i])) { startIdx = i; break; }
    }
    if (startIdx === -1) return out;

    let sum = 0, count = 0, seeded = false;
    for (let i = startIdx; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || Number.isNaN(v)) { out[i] = null; continue; }
      if (!seeded) {
        sum += v; count++;
        if (count === period) { out[i] = sum / period; seeded = true; }
        continue;
      }
      const prev = out[i - 1];
      out[i] = prev !== null ? v * k + prev * (1 - k) : v;
    }
    return out;
  }

  function macd(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast = ema(closes, fast);
    const emaSlow = ema(closes, slow);
    const macdLine = emaFast.map((v, i) => v !== null && emaSlow[i] !== null ? v - emaSlow[i] : null);
    const signalLine = emaFromIndex(macdLine, signal);
    const histogram = macdLine.map((v, i) => v !== null && signalLine[i] !== null ? v - signalLine[i] : null);
    return { macdLine, signalLine, histogram };
  }

  // Rolling-window VWAP. The previous version accumulated from the first bar
  // TwelveData happened to return (whatever `outputsize` gave us), so the
  // "VWAP" value silently drifted depending on how much history was fetched
  // and never reset — not a real fair-value anchor. A fixed rolling window
  // (20 daily bars ≈ 1 trading month, 10 weekly bars ≈ 1 quarter) is
  // deterministic and matches how VWAP is actually used as a short-term
  // value reference in swing setups.
  function vwap(ohlcv, period = 20) {
    const out = new Array(ohlcv.length).fill(null);
    let cumTPV = 0, cumVol = 0;
    const window = [];
    for (let i = 0; i < ohlcv.length; i++) {
      const tp = (ohlcv[i].h + ohlcv[i].l + ohlcv[i].c) / 3;
      const v = ohlcv[i].v > 0 ? ohlcv[i].v : 0;
      window.push({ tpv: tp * v, v });
      cumTPV += tp * v;
      cumVol += v;
      if (window.length > period) {
        const dropped = window.shift();
        cumTPV -= dropped.tpv;
        cumVol -= dropped.v;
      }
      out[i] = cumVol > 0 ? cumTPV / cumVol : tp;
    }
    return out;
  }

  function volumeProfileHVN(ohlcv, bins = 20) {
    const minP = Math.min(...ohlcv.map(d => d.l));
    const maxP = Math.max(...ohlcv.map(d => d.h));
    const binSize = (maxP - minP) / bins || 1;
    const volMap = new Array(bins).fill(0);
    for (const d of ohlcv) {
      const tp = (d.h + d.l + d.c) / 3;
      const idx = Math.min(Math.floor((tp - minP) / binSize), bins - 1);
      volMap[idx] += d.v;
    }
    let maxVol = 0, maxIdx = 0;
    for (let i = 0; i < bins; i++) { if (volMap[i] > maxVol) { maxVol = volMap[i]; maxIdx = i; } }
    return minP + (maxIdx + 0.5) * binSize;
  }

  function atr(ohlcv, period = 14) {
    const out = [];
    for (let i = 0; i < ohlcv.length; i++) {
      if (i === 0) { out.push(ohlcv[i].h - ohlcv[i].l); continue; }
      const tr1 = ohlcv[i].h - ohlcv[i].l;
      const tr2 = Math.abs(ohlcv[i].h - ohlcv[i-1].c);
      const tr3 = Math.abs(ohlcv[i].l - ohlcv[i-1].c);
      const tr = Math.max(tr1, tr2, tr3);
      if (i < period) {
        out.push(tr);
      } else if (i === period) {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += out[j];
        out.push(sum / period);
      } else {
        out.push((out[i-1] * (period - 1) + tr) / period);
      }
    }
    return out;
  }

  function findSwingLows(ohlcv, lookback = 3) {
    const lows = [];
    for (let i = lookback; i < ohlcv.length - lookback; i++) {
      let isLow = true;
      for (let j = 1; j <= lookback; j++) {
        if (ohlcv[i].l >= ohlcv[i-j].l || ohlcv[i].l >= ohlcv[i+j].l) { isLow = false; break; }
      }
      if (isLow) lows.push({ index: i, price: ohlcv[i].l });
    }
    return lows;
  }

  function findHigherLow(ohlcv) {
    // Confirmed swing lows
    const lows = findSwingLows(ohlcv, 3);
    if (lows.length >= 2) {
      const last = lows[lows.length - 1];
      const prev = lows[lows.length - 2];
      if (last.price > prev.price) return { price: last.price, prevPrice: prev.price, confirmed: true };
    }
    // Fallback: recent 1-bar lows (unconfirmed, for early detection)
    const recent = [];
    const start = Math.max(3, ohlcv.length - 15);
    for (let i = start; i < ohlcv.length - 1; i++) {
      if (ohlcv[i].l < ohlcv[i-1].l && ohlcv[i].l <= ohlcv[i+1].l) {
        recent.push({ index: i, price: ohlcv[i].l });
      }
    }
    if (recent.length >= 2) {
      const last = recent[recent.length - 1];
      const prev = recent[recent.length - 2];
      if (last.price > prev.price) return { price: last.price, prevPrice: prev.price, confirmed: false };
    }
    return null;
  }

  function findRSIDivergence(closes, rsiVals, lookback = 12) {
    const n = closes.length;
    if (n < lookback + 5) return false;
    // Find 2-bar swing lows in closes
    const swingLows = [];
    for (let i = 2; i < n - 2; i++) {
      if (closes[i] < closes[i-1] && closes[i] < closes[i-2] &&
          closes[i] < closes[i+1] && closes[i] < closes[i+2]) {
        if (rsiVals[i] !== null) swingLows.push({ idx: i, price: closes[i], rsi: rsiVals[i] });
      }
    }
    const recent = swingLows.filter(s => s.idx >= n - lookback - 2);
    if (recent.length < 2) return false;
    const low1 = recent[recent.length - 2];
    const low2 = recent[recent.length - 1];
    return low2.price < low1.price && low2.rsi > low1.rsi;
  }

  function findRSIOversoldBounce(rsiVals, threshold = 40, lookback = 12) {
    const recent = rsiVals.slice(-lookback).filter(v => v !== null);
    if (recent.length < 3) return false;
    const minVal = Math.min(...recent);
    if (minVal >= threshold) return false;
    const current = recent[recent.length - 1];
    return current > minVal;
  }

  function findRSISlope(rsiVals) {
    const last3 = rsiVals.slice(-3).filter(v => v !== null);
    if (last3.length < 3) return false;
    const [a, b, c] = last3;
    return c > 45 && c < 70 && c > b && b > a;
  }

  function atrPercentile(ohlcv, cfg, atrPeriod = 14, lookback = 50) {
    const atrVals = atr(ohlcv, atrPeriod);
    const recent = atrVals.slice(-lookback).filter(v => v !== null && !isNaN(v));
    if (recent.length < 10) return { percentile: 50, compressed: false, expanded: false };
    const current = recent[recent.length - 1];
    const sorted = [...recent].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= current);
    const pct = (rank / sorted.length) * 100;
    const compressedThreshold = cfg ? cfg.atrCompressed : 30;
    return { percentile: pct, compressed: pct < compressedThreshold, expanded: pct > 70 };
  }

  // ===================== PROFILE CONFIG =====================
  // Accepts a resolved profile key ('spec' | 'stable') directly. Use
  // getProfileConfigForTicker(ticker) when you want the saved/default lookup.
  function getProfileConfig(profileKey) {
    const p = profileKey;
    if (p === 'spec') {
      return {
        name: 'Speculative',
        rsiOverbought: 75,
        volMultiplier: 1.0,
        hvnRange: 0.10,
        macdStrict: false,
        weeklyRequired: false,
        minBars: 40,
        atrCompressed: 40,
        stopAtrMultiplier: 1.0, // wider cushion — spec names whipsaw more, a flat % is too tight in high-ATR names and too loose in low-ATR ones
        rewardMultiplier: 2.5 // spec names run further once they move — a wider target captures more of that, at the cost of a lower hit rate
      };
    }
    return {
      name: 'Stable',
      rsiOverbought: 60,
      volMultiplier: 1.1,
      hvnRange: 0.05,
      macdStrict: true,
      weeklyRequired: true,
      minBars: 60,
      atrCompressed: 25,
      stopAtrMultiplier: 0.5,
      rewardMultiplier: 2.0
    };
  }

  function getProfileConfigForTicker(ticker) {
    return getProfileConfig(getTickerProfile(ticker));
  }

  // Auto-classifies a ticker as Speculative vs Stable from its own realized
  // volatility instead of only trusting a hardcoded ~30-symbol whitelist.
  // Any ticker typed in ad hoc (not in DEFAULT_PROFILES and never manually
  // set) previously fell back to "Stable" silently — wrong for, say, a
  // random small-cap — which meant it was scored with thresholds tuned for
  // mega-caps. This uses trailing ATR as a % of price over the last 20 bars.
  function classifyVolatility(ohlcv) {
    if (ohlcv.length < 20) return 'stable';
    const atrVals = atr(ohlcv, 14).slice(-20).filter(v => v !== null && !isNaN(v));
    if (!atrVals.length) return 'stable';
    const avgAtrPct = atrVals.reduce((sum, v, i) => {
      const price = ohlcv[ohlcv.length - atrVals.length + i].c;
      return sum + (price > 0 ? (v / price) * 100 : 0);
    }, 0) / atrVals.length;
    return avgAtrPct >= 3.5 ? 'spec' : 'stable';
  }


  // ===================== MACD EVALUATION =====================
  function evaluateMACD(hist, cfg) {
    const histNow = hist[hist.length - 1];
    const histPrev = hist[hist.length - 2];
    const histPrev2 = hist[hist.length - 3];
    if (histNow === null || histPrev === null) return { signal: false, value: histNow };
    const turningUp = histNow > histPrev;
    if (cfg.macdStrict) {
      const twoBarsUp = histPrev2 !== null && histPrev > histPrev2;
      const continuation = histNow > 0 && turningUp;
      const reversal = histNow < 0 && turningUp && twoBarsUp;
      return { signal: reversal || continuation, value: histNow };
    }
    const crossover = histNow > 0 && histPrev < 0;
    return { signal: turningUp || crossover, value: histNow };
  }

  // ===================== DAILY SCORING (6 layers, or 5 if volume data is unusable) =====================
  function evaluateTicker(ohlcv, cfg, volumeReliable = true) {
    const closes = ohlcv.map(d => d.c);
    const volumes = ohlcv.map(d => d.v);
    const last = ohlcv[ohlcv.length - 1];

    if (ohlcv.length < cfg.minBars) {
      return { score: 0, maxScore: 6, conditions: [], action: 'Insufficient data (need ' + cfg.minBars + '+ bars)', details: {}, stop: null, target: null, riskPerShare: null, rewardMultiplier: cfg.rewardMultiplier, divergence: false, volumeReliable: true, higherLow: null, atr: { compressed: false, expanded: false, percentile: 0 } };
    }

    // 1. VWAP Bias — above, near, or reclaiming
    const vwapVals = vwap(ohlcv);
    const vwapLast = vwapVals[vwapVals.length - 1];
    const prevPrice = ohlcv[ohlcv.length - 2].c;
    const prevVWAP = vwapVals[vwapVals.length - 2];
    const aboveVWAP = last.c > vwapLast;
    const nearVWAP = last.c >= vwapLast * 0.985 && last.c > prevPrice;
    const reclaimingVWAP = last.c > vwapLast && prevPrice <= prevVWAP;
    const vwapSignal = aboveVWAP || nearVWAP || reclaimingVWAP;

    // 2. RSI Momentum — divergence, oversold bounce, or healthy slope
    const rsiVals = rsi(closes, 14);
    const rsiNow = rsiVals[rsiVals.length - 1];
    const hasDivergence = findRSIDivergence(closes, rsiVals, 12);
    const oversoldBounce = findRSIOversoldBounce(rsiVals, cfg.name === 'Speculative' ? 35 : 40, 12);
    const healthySlope = findRSISlope(rsiVals);
    const rsiSignal = (hasDivergence || oversoldBounce || healthySlope) && (rsiNow !== null && rsiNow < cfg.rsiOverbought);

    // 3. MACD Momentum
    const macdData = macd(closes);
    const macdResult = evaluateMACD(macdData.histogram, cfg);

    // 4. Volume (skipped from scoring if the feed doesn't actually carry usable volume)
    const volSMA = sma(volumes, 9);
    const volNow = volumes[volumes.length - 1];
    const volSmaNow = volSMA[volSMA.length - 1];
    const volAbove = volumeReliable && volSmaNow > 0 && volNow > volSmaNow * cfg.volMultiplier;

    // 5. Structure — higher low
    const hl = findHigherLow(ohlcv);
    const hasHigherLow = hl !== null;

    // 6. Volatility — ATR compressed
    const atrPct = atrPercentile(ohlcv, cfg);
    const atrCompressed = atrPct.compressed;

    const conditions = [
      { name: 'VWAP Bias', on: vwapSignal, detail: aboveVWAP ? 'Above' : reclaimingVWAP ? 'Reclaiming' : nearVWAP ? 'Near & rising' : 'Below' },
      { name: 'RSI Momentum', on: rsiSignal, detail: hasDivergence ? 'Divergence' : oversoldBounce ? 'Oversold bounce' : healthySlope ? 'Rising 45-70' : 'Weak' },
      { name: 'MACD Momentum', on: macdResult.signal, detail: macdResult.value !== null ? macdResult.value.toFixed(3) : '-' },
      volumeReliable
        ? { name: 'Volume > ' + cfg.volMultiplier + '×SMA', on: volAbove, detail: volSmaNow ? Math.round(volSmaNow).toLocaleString() : '-' }
        : { name: 'Volume (unavailable)', on: false, excluded: true, detail: 'Feed has no reliable volume for this symbol' },
      { name: 'Higher Low', on: hasHigherLow, detail: hl ? '$' + hl.price.toFixed(2) + (hl.confirmed ? '' : ' (early)') : 'None' },
      { name: 'ATR Compressed', on: atrCompressed, detail: Math.round(atrPct.percentile) + 'pct' }
    ];

    const scored = conditions.filter(c => !c.excluded);
    const score = scored.filter(c => c.on).length;
    const maxScore = scored.length;

    // Action text keyed by score *ratio* rather than a fixed 0-6 table, so it
    // still makes sense on the rare 5-condition case (unreliable volume).
    const ratio = score / maxScore;
    let action;
    if (score <= 1) action = 'No setup. Wait for momentum and liquidity to align.';
    else if (ratio < 0.4) action = 'Weak signal. One layer alone is not enough.';
    else if (ratio < 0.55) action = 'Building — watchlist. Divergence or structure forming. Set alerts.';
    else if (ratio < 0.7) action = 'Building — plan entry. Momentum aligning above VWAP. Watch for ATR compression.';
    else if (ratio < 0.85) action = 'Setup active. Strong momentum. Enter if ATR compressed.';
    else if (score < maxScore) action = 'High conviction — execute. Most layers aligned. Stop below higher low.';
    else action = 'Max confluence — execute. All layers aligned. Stop below higher low.';

    // Stop is ATR-scaled instead of a flat 1.5% cushion below the higher low —
    // a flat % is arbitrary noise-band for a $2 speculative stock and far too
    // tight/loose across different volatility regimes. cfg.stopAtrMultiplier
    // is wider for Speculative names, tighter for Stable ones.
    const atrVals = atr(ohlcv, 14);
    const atrNow = atrVals[atrVals.length - 1];
    const stopPrice = hl && atrNow
      ? (hl.price - atrNow * cfg.stopAtrMultiplier).toFixed(2)
      : (hl ? (hl.price * 0.985).toFixed(2) : null);

    // Take-profit target: entry (current close) plus the same risk distance
    // the stop already defines, scaled by a profile-specific reward:risk
    // multiple. Same R-multiple logic the app's own trade-example cards
    // already use ("risk $0.15, reward $0.70 = 1:4.7 R:R") — this just
    // computes it automatically instead of leaving it as a worked example.
    // This is a target derived from volatility structure, not a prediction
    // of where price will actually go — treat it as a planning reference,
    // not a guarantee, same as the stop.
    let targetPrice = null;
    let riskPerShare = null;
    if (stopPrice !== null) {
      riskPerShare = last.c - parseFloat(stopPrice);
      if (riskPerShare > 0) {
        targetPrice = (last.c + riskPerShare * cfg.rewardMultiplier).toFixed(2);
      }
    }

    return {
      score,
      maxScore,
      conditions,
      action,
      divergence: hasDivergence,
      atr: atrPct,
      higherLow: hl,
      stop: stopPrice,
      target: targetPrice,
      rewardMultiplier: cfg.rewardMultiplier,
      riskPerShare: riskPerShare !== null ? riskPerShare.toFixed(2) : null,
      volumeReliable,
      details: {
        price: last.c,
        vwap: vwapLast,
        rsi: rsiNow ? rsiNow.toFixed(1) : '-',
        macdHist: macdResult.value !== null ? macdResult.value.toFixed(3) : '-',
        volume: volNow,
        volSMA: volSmaNow ? Math.round(volSmaNow) : '-',
        hvn: volumeProfileHVN(ohlcv).toFixed(2),
        atrPct: Math.round(atrPct.percentile)
      }
    };
  }

  // ===================== WEEKLY SCORING =====================
  function evaluateWeekly(ohlcv, cfg) {
    const closes = ohlcv.map(d => d.c);
    const last = ohlcv[ohlcv.length - 1];
    if (ohlcv.length < 20) return { score: 0, trend: 'Insufficient data', bullish: false };

    const vwapVals = vwap(ohlcv, 10);
    const aboveVWAP = last.c > vwapVals[vwapVals.length - 1];

    const macdData = macd(closes);
    const hist = macdData.histogram;
    const histNow = hist[hist.length - 1];
    const histPrev = hist[hist.length - 2];
    const improving = histNow !== null && histPrev !== null && histNow > histPrev;

    let score = 0;
    if (aboveVWAP) score++;
    if (improving) score++;

    const trend = aboveVWAP && improving ? 'Bullish' : aboveVWAP ? 'Cautiously bullish' : improving ? 'Bearish, improving' : 'Bearish';
    return { score, trend, bullish: aboveVWAP };
  }


  // Drops rows with non-finite OHLC, non-positive prices, or high < low.
  // Flags whether volume data is actually usable (some symbols — crypto pairs,
  // certain forex/index feeds — return 0 or missing volume). Previously a
  // missing-volume symbol silently failed every volume-dependent condition
  // with no indication why; now callers get an explicit signal.
  function sanitizeOHLCV(rawValues) {
    const cleaned = [];
    let volSamples = 0, volNonZero = 0;
    for (const v of rawValues) {
      const o = parseFloat(v.open), h = parseFloat(v.high), l = parseFloat(v.low), c = parseFloat(v.close);
      let vol = parseFloat(v.volume);
      if (![o, h, l, c].every(Number.isFinite)) continue;
      if (o <= 0 || h <= 0 || l <= 0 || c <= 0 || h < l) continue;
      if (!Number.isFinite(vol) || vol < 0) vol = 0;
      volSamples++;
      if (vol > 0) volNonZero++;
      cleaned.push({ o, h, l, c, v: vol, t: v.datetime || null });
    }
    const volumeReliable = volSamples > 0 && (volNonZero / volSamples) > 0.8;
    return { bars: cleaned, volumeReliable };
  }

  // Aggregates daily bars into weekly bars locally (Mon-Fri grouped by ISO
  // week), so evaluateWeekly() can run without a second API call. Requires
  // the `t` (datetime) field sanitizeOHLCV now preserves. Needs enough
  // trailing daily history to produce ~35+ weekly bars for MACD(12,26,9) to
  // have a valid signal line — pass at least ~200 daily bars in.
  function isoWeekKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    d.setUTCDate(d.getUTCDate() - day); // back up to Monday of that week
    return d.toISOString().slice(0, 10);
  }

  function resampleToWeekly(dailyBars) {
    const weeks = new Map(); // weekKey -> array of bars, in original (ascending) order
    for (const bar of dailyBars) {
      if (!bar.t) continue; // can't bucket without a date
      const key = isoWeekKey(bar.t);
      if (!weeks.has(key)) weeks.set(key, []);
      weeks.get(key).push(bar);
    }
    const keys = [...weeks.keys()].sort();
    return keys.map(key => {
      const group = weeks.get(key);
      return {
        o: group[0].o,
        h: Math.max(...group.map(b => b.h)),
        l: Math.min(...group.map(b => b.l)),
        c: group[group.length - 1].c,
        v: group.reduce((sum, b) => sum + b.v, 0),
        t: key
      };
    });
  }

  return {
    DEFAULT_PROFILES,
    ema, sma, rsi, emaFromIndex, macd, vwap, volumeProfileHVN, atr,
    findSwingLows, findHigherLow, findRSIDivergence, findRSIOversoldBounce, findRSISlope,
    atrPercentile, getProfileConfig, classifyVolatility,
    evaluateMACD, evaluateTicker, evaluateWeekly, sanitizeOHLCV, resampleToWeekly
  };
});
