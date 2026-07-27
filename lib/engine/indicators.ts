// Market structure primitives.
//
// These exist to make drill grading *objective*. "Was that a good entry?" is
// unanswerable; "did price travel more than 1 ATR in your direction before it
// travelled 1 ATR against you?" is a measurable question, and it is the one the
// graders in `drills.ts` ask.

import type { Candle, Side } from "./types.ts";

export function trueRange(candle: Candle, previousClose: number): number {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose),
  );
}

/**
 * Wilder ATR over the `period` candles ending at `index` (inclusive).
 * Falls back to a simple range average when history is short.
 */
export function atr(candles: Candle[], index: number, period = 14): number {
  if (index <= 0) return Math.max(candles[0]?.high - candles[0]?.low || 0, 0);
  const start = Math.max(1, index - period + 1);
  let sum = 0;
  let count = 0;
  for (let i = start; i <= index; i += 1) {
    sum += trueRange(candles[i], candles[i - 1].close);
    count += 1;
  }
  return count ? sum / count : 0;
}

export function ema(values: number[], period: number): number[] {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const output: number[] = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    output.push(values[index] * k + output[index - 1] * (1 - k));
  }
  return output;
}

export type SwingPoint = { index: number; price: number; kind: "HIGH" | "LOW" };

/**
 * Fractal swing points: a high with `lookback` lower highs on each side (and
 * the mirror for lows). Used to describe structure and to judge whether a stop
 * was placed behind a real invalidation level or parked inside noise.
 */
export function swingPoints(candles: Candle[], lookback = 2): SwingPoint[] {
  const points: SwingPoint[] = [];
  for (let index = lookback; index < candles.length - lookback; index += 1) {
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= lookback; offset += 1) {
      if (candles[index].high <= candles[index - offset].high) isHigh = false;
      if (candles[index].high <= candles[index + offset].high) isHigh = false;
      if (candles[index].low >= candles[index - offset].low) isLow = false;
      if (candles[index].low >= candles[index + offset].low) isLow = false;
    }
    if (isHigh) points.push({ index, price: candles[index].high, kind: "HIGH" });
    else if (isLow) points.push({ index, price: candles[index].low, kind: "LOW" });
  }
  return points;
}

export type StructureBias = "UPTREND" | "DOWNTREND" | "RANGE";

export type StructureRead = {
  bias: StructureBias;
  /** 0..1 confidence derived from how cleanly swings are stacking. */
  strength: number;
  /** Nearest swing low below the last close, if any. */
  supportBelow: number | null;
  /** Nearest swing high above the last close, if any. */
  resistanceAbove: number | null;
  atr: number;
  /** ATR as a fraction of price — the volatility regime. */
  atrPct: number;
};

/** Describe the structure of `candles[0..index]`. */
export function readStructure(candles: Candle[], index: number, lookback = 40): StructureRead {
  const window = candles.slice(Math.max(0, index - lookback + 1), index + 1);
  const close = candles[index]?.close ?? 0;
  const points = swingPoints(window, 2);
  const highs = points.filter((point) => point.kind === "HIGH");
  const lows = points.filter((point) => point.kind === "LOW");

  let upVotes = 0;
  let downVotes = 0;
  for (let i = 1; i < highs.length; i += 1) {
    if (highs[i].price > highs[i - 1].price) upVotes += 1;
    else downVotes += 1;
  }
  for (let i = 1; i < lows.length; i += 1) {
    if (lows[i].price > lows[i - 1].price) upVotes += 1;
    else downVotes += 1;
  }

  const closes = window.map((candle) => candle.close);
  const fast = ema(closes, 8);
  const slow = ema(closes, 21);
  const slope = fast.at(-1)! - slow.at(-1)!;
  if (slope > 0) upVotes += 1.5;
  else if (slope < 0) downVotes += 1.5;

  const total = upVotes + downVotes;
  const edge = total ? Math.abs(upVotes - downVotes) / total : 0;
  const bias: StructureBias = edge < 0.28 ? "RANGE" : upVotes > downVotes ? "UPTREND" : "DOWNTREND";

  const offset = Math.max(0, index - lookback + 1);
  const supportBelow = lows
    .filter((point) => point.price < close)
    .map((point) => point.price)
    .sort((a, b) => b - a)[0] ?? null;
  const resistanceAbove = highs
    .filter((point) => point.price > close)
    .map((point) => point.price)
    .sort((a, b) => a - b)[0] ?? null;

  void offset;
  const range = atr(candles, index);
  return {
    bias,
    strength: Number(edge.toFixed(3)),
    supportBelow,
    resistanceAbove,
    atr: range,
    atrPct: close ? range / close : 0,
  };
}

export type ForwardOutcome = {
  /** Net move from the anchor close to the final close, in ATR units. */
  driftAtr: number;
  /** Best excursion in the tested direction, in ATR units. */
  favourableAtr: number;
  /** Worst excursion against the tested direction, in ATR units. */
  adverseAtr: number;
  /**
   * Whether price travelled `threshold` ATR in the tested direction *before*
   * travelling `threshold` ATR against it. This is the honest test of a
   * directional call: it accounts for path, not just endpoint.
   */
  resolvedFirst: "FAVOURABLE" | "ADVERSE" | "NEITHER";
  finalClose: number;
};

/**
 * Measure what happened over `horizon` candles after `anchorIndex`, normalised
 * by the volatility that was observable *at* the anchor.
 */
export function forwardOutcome(
  candles: Candle[],
  anchorIndex: number,
  horizon: number,
  side: Side,
  threshold = 1,
): ForwardOutcome {
  const anchor = candles[anchorIndex];
  const range = atr(candles, anchorIndex) || Math.max(anchor.high - anchor.low, 1e-9);
  const direction = side === "LONG" ? 1 : -1;
  const end = Math.min(candles.length - 1, anchorIndex + horizon);

  let favourable = 0;
  let adverse = 0;
  let resolvedFirst: ForwardOutcome["resolvedFirst"] = "NEITHER";

  for (let index = anchorIndex + 1; index <= end; index += 1) {
    const candle = candles[index];
    const up = (candle.high - anchor.close) / range;
    const down = (anchor.close - candle.low) / range;
    const favourableMove = direction === 1 ? up : down;
    const adverseMove = direction === 1 ? down : up;
    favourable = Math.max(favourable, favourableMove);
    adverse = Math.max(adverse, adverseMove);
    if (resolvedFirst === "NEITHER") {
      const hitFavourable = favourableMove >= threshold;
      const hitAdverse = adverseMove >= threshold;
      // Both inside one candle: we cannot know the sequence, so resolve
      // against the trader. Being pessimistic is the whole point of training.
      if (hitAdverse) resolvedFirst = "ADVERSE";
      else if (hitFavourable) resolvedFirst = "FAVOURABLE";
    }
  }

  const finalClose = candles[end].close;
  return {
    driftAtr: ((finalClose - anchor.close) / range) * direction,
    favourableAtr: favourable,
    adverseAtr: adverse,
    resolvedFirst,
    finalClose,
  };
}
