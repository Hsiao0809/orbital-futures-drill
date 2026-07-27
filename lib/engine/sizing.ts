// Position sizing.
//
// Every funded trader does this arithmetic before every trade, and it is the
// single most teachable skill in the product: given an account, a rule set and
// a stop distance, there is exactly one correct size.

import type { RuleMetrics, RuleSet, Side } from "./types.ts";

export type SizingInput = {
  equity: number;
  /** Fraction of equity to risk, e.g. 0.005 for 0.5%. */
  riskPct: number;
  entry: number;
  stop: number;
  side: Side;
  rules: RuleSet;
  /** Cap leverage below the rule set's maximum, e.g. a personal limit. */
  leverageCap?: number;
};

export type SizingResult = {
  qty: number;
  notional: number;
  margin: number;
  leverage: number;
  /** Distance from entry to stop, in price. */
  stopDistance: number;
  /** Stop distance as a fraction of entry. */
  stopPct: number;
  /** Loss if the stop fills, including both fees. This is the real risk. */
  riskUsd: number;
  /** Risk as a fraction of equity. */
  riskPctActual: number;
  /** Reasons the ideal size had to be reduced. */
  constraints: string[];
};

/**
 * Size a position so that a stop-out costs `riskPct` of equity, *including*
 * round-trip fees. Traders who size on price distance alone systematically risk
 * more than they think; on a tight stop the fees can be a third of the risk.
 */
export function sizePosition(input: SizingInput): SizingResult {
  const { equity, riskPct, entry, stop, rules } = input;
  const stopDistance = Math.abs(entry - stop);
  const constraints: string[] = [];

  if (stopDistance <= 0 || entry <= 0 || equity <= 0 || riskPct <= 0) {
    return {
      qty: 0, notional: 0, margin: 0, leverage: 0,
      stopDistance, stopPct: 0, riskUsd: 0, riskPctActual: 0,
      constraints: ["停損距離或帳戶參數無效"],
    };
  }

  const riskBudget = equity * riskPct;
  // Solving qty from: qty*stopDistance + qty*entry*fee + qty*stop*fee = budget
  const feePerUnit = (entry + stop) * rules.takerFee;
  const costPerUnit = stopDistance + feePerUnit;
  let qty = riskBudget / costPerUnit;

  const maxLeverage = Math.min(rules.maxLeverage, input.leverageCap ?? rules.maxLeverage);
  const maxNotional = equity * maxLeverage;
  if (qty * entry > maxNotional) {
    qty = maxNotional / entry;
    constraints.push(`受 ${maxLeverage}× 槓桿上限限制，無法達到目標風險`);
  }

  const notional = qty * entry;
  const riskUsd = qty * costPerUnit;
  const leverage = equity ? notional / equity : 0;

  return {
    qty,
    notional,
    margin: leverage > 0 ? notional / Math.max(1, Math.ceil(leverage)) : 0,
    leverage,
    stopDistance,
    stopPct: stopDistance / entry,
    riskUsd,
    riskPctActual: riskUsd / equity,
    constraints,
  };
}

/**
 * The largest risk that is defensible right now.
 *
 * A trader with 3% of equity left before the daily limit must not risk 2% on
 * one trade: one loss and they are one bad tick from being done. The rule of
 * thumb encoded here is that no single trade may consume more than
 * `roomFraction` of the *binding* remaining room, so a losing trade always
 * leaves the account alive and able to trade tomorrow.
 */
export function maxDefensibleRisk(
  metrics: RuleMetrics,
  baseRiskPct: number,
  roomFraction = 1 / 3,
): { riskUsd: number; riskPct: number; limitedBy: "BASE" | "DAILY" | "DRAWDOWN" } {
  const base = metrics.equity * baseRiskPct;
  const room = Number.isFinite(metrics.bindingRoom) ? metrics.bindingRoom * roomFraction : Number.POSITIVE_INFINITY;
  if (base <= room) return { riskUsd: base, riskPct: baseRiskPct, limitedBy: "BASE" };
  return {
    riskUsd: Math.max(0, room),
    riskPct: metrics.equity ? Math.max(0, room) / metrics.equity : 0,
    limitedBy: metrics.bindingConstraint === "DAILY" ? "DAILY" : "DRAWDOWN",
  };
}

/**
 * How many consecutive full-risk losses the account can absorb before the
 * binding limit trips. Below ~3 the trader is effectively on a coin flip for
 * their account, which is the moment to stop trading for the day.
 */
export function lossesUntilBreach(metrics: RuleMetrics, riskUsd: number): number {
  if (riskUsd <= 0) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(metrics.bindingRoom)) return Number.POSITIVE_INFINITY;
  return Math.floor(metrics.bindingRoom / riskUsd);
}
