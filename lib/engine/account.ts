// The account simulator.
//
// A deliberately pessimistic model of a USDⓈ-M perpetual account. Every
// modelling choice that could go either way resolves against the trader,
// because a trainer that flatters you is worse than no trainer at all.
//
// Documented assumptions:
//   * Entries fill at the close of the decision candle plus slippage.
//   * When a candle's range contains both the stop and the target, the stop is
//     assumed to have filled first. Intrabar sequence is unknowable from OHLC.
//   * A gap through a level fills at the open, not at the level.
//   * Funding is charged at 8h boundaries at a flat modelled rate; longs pay.
//   * Liquidation uses a flat maintenance-margin rate.

import { atr } from "./indicators.ts";
import { detectBreach, evaluate } from "./propRules.ts";
import type {
  AccountState,
  Candle,
  ClosedTrade,
  DaySummary,
  ExitReason,
  OpenIntent,
  RuleSet,
  SimPosition,
} from "./types.ts";

const DAY_MS = 86_400_000;
const FUNDING_MS = 8 * 60 * 60 * 1000;

export function dayNumber(time: number): number {
  return Math.floor(time / DAY_MS);
}

export function createAccount(rules: RuleSet): AccountState {
  return {
    rules,
    balance: rules.initialBalance,
    positions: [],
    trades: [],
    days: [],
    dayIndex: 0,
    dayStartEquity: rules.initialBalance,
    dayStartBalance: rules.initialBalance,
    dayLowEquity: rules.initialBalance,
    dayHighEquity: rules.initialBalance,
    dayTradeCount: 0,
    dayFees: 0,
    peakEquity: rules.initialBalance,
    peakEodBalance: rules.initialBalance,
    feesPaid: 0,
    fundingPaid: 0,
    breach: null,
    seq: 0,
  };
}

export function unrealizedPnl(state: AccountState, price: number): number {
  return state.positions.reduce((sum, position) => {
    const direction = position.side === "LONG" ? 1 : -1;
    return sum + (price - position.entry) * position.qty * direction;
  }, 0);
}

/** Equity as the rule set measures it — with or without open-trade P&L. */
export function equityOf(state: AccountState, price: number): number {
  return state.rules.includeUnrealized ? state.balance + unrealizedPnl(state, price) : state.balance;
}

/** Equity as the trader sees it in the UI — always mark-to-market. */
export function markedEquity(state: AccountState, price: number): number {
  return state.balance + unrealizedPnl(state, price);
}

export function usedMargin(state: AccountState): number {
  return state.positions.reduce((sum, position) => sum + position.margin, 0);
}

/** Slippage grows with the volatility regime: fast tape, worse fills. */
function slip(price: number, direction: "BUY" | "SELL", rules: RuleSet, volatilityFactor: number): number {
  const rate = rules.slippage * (1 + volatilityFactor);
  return direction === "BUY" ? price * (1 + rate) : price * (1 - rate);
}

function liquidationPrice(entry: number, side: "LONG" | "SHORT", leverage: number, mmr: number): number {
  const distance = Math.max(0, 1 / Math.max(leverage, 1e-9) - mmr);
  return side === "LONG" ? entry * (1 - distance) : entry * (1 + distance);
}

export type OpenResult =
  | { ok: true; state: AccountState; position: SimPosition }
  | { ok: false; error: string };

/**
 * Open a position at the close of `candles[index]`.
 *
 * `index` must be the last *visible* candle: the simulator never lets a
 * decision see the bar it is about to be filled against.
 */
export function openPosition(
  state: AccountState,
  intent: OpenIntent,
  candles: Candle[],
  index: number,
): OpenResult {
  if (state.breach) return { ok: false, error: "帳戶已違規，無法再開倉。" };
  const candle = candles[index];
  if (!candle) return { ok: false, error: "沒有可用的行情資料。" };
  if (!(intent.qty > 0)) return { ok: false, error: "口數必須大於 0。" };
  if (intent.leverage > state.rules.maxLeverage) {
    return { ok: false, error: `此規則檔的槓桿上限為 ${state.rules.maxLeverage}×。` };
  }
  if (intent.leverage < 1) return { ok: false, error: "槓桿不得小於 1×。" };

  const range = atr(candles, index);
  const volatilityFactor = candle.close ? Math.min(3, (range / candle.close) / 0.004) : 0;
  const entry = slip(candle.close, intent.side === "LONG" ? "BUY" : "SELL", state.rules, volatilityFactor);

  if (intent.stop !== null) {
    const stopIsWrongSide = intent.side === "LONG" ? intent.stop >= entry : intent.stop <= entry;
    if (stopIsWrongSide) return { ok: false, error: "停損價位在錯誤的一側。" };
  }
  if (intent.target !== null) {
    const targetIsWrongSide = intent.side === "LONG" ? intent.target <= entry : intent.target >= entry;
    if (targetIsWrongSide) return { ok: false, error: "停利價位在錯誤的一側。" };
  }

  const notional = entry * intent.qty;
  const margin = notional / intent.leverage;
  const equity = markedEquity(state, candle.close);
  const free = equity - usedMargin(state);
  if (margin > free) {
    return { ok: false, error: `保證金不足：需要 ${margin.toFixed(2)} U，可用 ${Math.max(0, free).toFixed(2)} U。` };
  }

  const entryFee = notional * state.rules.takerFee;
  const exitFeeEstimate = intent.stop !== null ? intent.stop * intent.qty * state.rules.takerFee : 0;
  const plannedRiskUsd =
    intent.stop !== null ? Math.abs(entry - intent.stop) * intent.qty + entryFee + exitFeeEstimate : 0;

  const metricsAtOpen = evaluate(state, equity);
  const position: SimPosition = {
    id: `p${state.seq + 1}`,
    side: intent.side,
    entry,
    qty: intent.qty,
    leverage: intent.leverage,
    stop: intent.stop,
    target: intent.target,
    initialStop: intent.stop,
    margin,
    entryFee,
    fundingPaid: 0,
    openedAt: candle.time,
    openedIndex: index,
    plannedRiskUsd,
    equityAtOpen: equity,
    bindingRoomAtOpen: metricsAtOpen.bindingRoom,
    liquidation: liquidationPrice(entry, intent.side, intent.leverage, state.rules.maintenanceMargin),
    bestPrice: entry,
    worstPrice: entry,
    stopMoves: 0,
    stopWidenings: 0,
    tags: intent.tags ?? [],
  };

  const next: AccountState = {
    ...state,
    seq: state.seq + 1,
    balance: state.balance - entryFee,
    feesPaid: state.feesPaid + entryFee,
    dayFees: state.dayFees + entryFee,
    dayTradeCount: state.dayTradeCount + 1,
    positions: [...state.positions, position],
  };
  return { ok: true, state: next, position };
}

/** Move a stop. Widening is recorded — diagnostics punish it, hard. */
export function modifyStop(state: AccountState, positionId: string, stop: number | null): AccountState {
  return {
    ...state,
    positions: state.positions.map((position) => {
      if (position.id !== positionId) return position;
      const widened =
        stop === null ||
        position.stop === null ||
        (position.side === "LONG" ? stop < position.stop : stop > position.stop);
      return {
        ...position,
        stop,
        stopMoves: position.stopMoves + 1,
        stopWidenings: position.stopWidenings + (widened ? 1 : 0),
      };
    }),
  };
}

function settle(
  state: AccountState,
  position: SimPosition,
  exitPrice: number,
  reason: ExitReason,
  candle: Candle,
  index: number,
): AccountState {
  const direction = position.side === "LONG" ? 1 : -1;
  const grossPnl = (exitPrice - position.entry) * position.qty * direction;
  const exitFee = exitPrice * position.qty * state.rules.takerFee;
  const fees = position.entryFee + exitFee;
  // Round-trip P&L. The entry fee already left `balance` when the trade was
  // opened, so it is subtracted here for *reporting* only — without it the
  // R multiple of a clean stop-out would come out better than −1R, which is
  // precisely the self-flattery this simulator exists to avoid.
  const pnl = grossPnl - fees - position.fundingPaid;
  const risk = position.plannedRiskUsd;

  const favourable = direction === 1 ? position.bestPrice - position.entry : position.entry - position.worstPrice;
  const adverse = direction === 1 ? position.entry - position.worstPrice : position.bestPrice - position.entry;

  const trade: ClosedTrade = {
    id: position.id,
    side: position.side,
    entry: position.entry,
    exit: exitPrice,
    qty: position.qty,
    leverage: position.leverage,
    initialStop: position.initialStop,
    plannedRiskUsd: risk,
    equityAtOpen: position.equityAtOpen,
    bindingRoomAtOpen: position.bindingRoomAtOpen,
    openedAt: position.openedAt,
    closedAt: candle.time,
    openedIndex: position.openedIndex,
    closedIndex: index,
    holdBars: index - position.openedIndex,
    reason,
    grossPnl,
    fees,
    funding: position.fundingPaid,
    pnl,
    rMultiple: risk > 0 ? pnl / risk : 0,
    mfeR: risk > 0 ? (favourable * position.qty) / risk : 0,
    maeR: risk > 0 ? (adverse * position.qty) / risk : 0,
    stopMoves: position.stopMoves,
    stopWidenings: position.stopWidenings,
    dayIndex: state.dayIndex,
    tags: position.tags,
  };

  return {
    ...state,
    balance: state.balance + grossPnl - exitFee,
    feesPaid: state.feesPaid + exitFee,
    dayFees: state.dayFees + exitFee,
    positions: state.positions.filter((item) => item.id !== position.id),
    trades: [...state.trades, trade],
  };
}

/** Close at the current candle's close, with slippage. */
export function closePosition(
  state: AccountState,
  positionId: string,
  candles: Candle[],
  index: number,
  reason: ExitReason = "MANUAL",
): AccountState {
  const position = state.positions.find((item) => item.id === positionId);
  const candle = candles[index];
  if (!position || !candle) return state;
  const range = atr(candles, index);
  const volatilityFactor = candle.close ? Math.min(3, (range / candle.close) / 0.004) : 0;
  const exit = slip(candle.close, position.side === "LONG" ? "SELL" : "BUY", state.rules, volatilityFactor);
  return settle(state, position, exit, reason, candle, index);
}

export function closeAll(
  state: AccountState,
  candles: Candle[],
  index: number,
  reason: ExitReason = "SESSION_END",
): AccountState {
  return state.positions.reduce(
    (acc, position) => closePosition(acc, position.id, candles, index, reason),
    state,
  );
}

/**
 * Which level, if any, a candle takes out. Adverse levels win ties: with only
 * OHLC we cannot know the intrabar path, so we assume the worst.
 */
function resolveExit(
  position: SimPosition,
  candle: Candle,
  rules: RuleSet,
): { price: number; reason: ExitReason } | null {
  const long = position.side === "LONG";
  const adverse: Array<{ price: number; reason: ExitReason }> = [];
  if (position.stop !== null) adverse.push({ price: position.stop, reason: "STOP" });
  adverse.push({ price: position.liquidation, reason: "LIQUIDATION" });

  const touched = adverse.filter((level) =>
    long ? candle.low <= level.price : candle.high >= level.price,
  );
  if (touched.length) {
    // Falling into a long: the first level hit is the highest one.
    touched.sort((a, b) => (long ? b.price - a.price : a.price - b.price));
    const level = touched[0];
    const gapped = long ? candle.open <= level.price : candle.open >= level.price;
    if (gapped) return { price: candle.open, reason: level.reason };
    const rate = level.reason === "LIQUIDATION" ? rules.slippage * 4 : rules.slippage;
    return { price: long ? level.price * (1 - rate) : level.price * (1 + rate), reason: level.reason };
  }

  if (position.target !== null && (long ? candle.high >= position.target : candle.low <= position.target)) {
    const gapped = long ? candle.open >= position.target : candle.open <= position.target;
    // Limit exits do not slip in your favour, but a gap does.
    return { price: gapped ? candle.open : position.target, reason: "TARGET" };
  }
  return null;
}

export type AdvanceEvent =
  | { kind: "EXIT"; positionId: string; reason: ExitReason; price: number; pnl: number }
  | { kind: "FUNDING"; amount: number }
  | { kind: "DAY_ROLL"; dayIndex: number; summary: DaySummary }
  | { kind: "BREACH"; message: string };

export type AdvanceResult = { state: AccountState; events: AdvanceEvent[] };

/**
 * Advance the account onto `candles[index]`: roll the calendar day, charge
 * funding, fill protective orders, mark open risk, and test every rule limit.
 */
export function advance(state: AccountState, candles: Candle[], index: number): AdvanceResult {
  const candle = candles[index];
  const previous = candles[index - 1];
  const events: AdvanceEvent[] = [];
  if (!candle) return { state, events };

  let next = state;

  // --- calendar day rollover ------------------------------------------------
  if (previous && dayNumber(candle.time) !== dayNumber(previous.time)) {
    const endEquity = markedEquity(next, previous.close);
    const summary: DaySummary = {
      dayIndex: next.dayIndex,
      startedAt: previous.time,
      startEquity: next.dayStartEquity,
      endEquity,
      lowEquity: next.dayLowEquity,
      highEquity: next.dayHighEquity,
      pnl: endEquity - next.dayStartEquity,
      trades: next.dayTradeCount,
      fees: next.dayFees,
    };
    next = {
      ...next,
      days: [...next.days, summary],
      dayIndex: next.dayIndex + 1,
      dayStartEquity: endEquity,
      dayStartBalance: next.balance,
      dayLowEquity: endEquity,
      dayHighEquity: endEquity,
      dayTradeCount: 0,
      dayFees: 0,
      peakEodBalance: Math.max(next.peakEodBalance, next.balance),
    };
    events.push({ kind: "DAY_ROLL", dayIndex: next.dayIndex, summary });
  }

  // --- funding --------------------------------------------------------------
  if (previous && next.positions.length && Math.floor(candle.time / FUNDING_MS) !== Math.floor(previous.time / FUNDING_MS)) {
    let charged = 0;
    next = {
      ...next,
      positions: next.positions.map((position) => {
        // Modelled as longs paying shorts at a flat rate.
        const notional = position.qty * candle.open;
        const amount = notional * next.rules.fundingRate8h * (position.side === "LONG" ? 1 : -1);
        charged += amount;
        return { ...position, fundingPaid: position.fundingPaid + amount };
      }),
    };
    next = { ...next, balance: next.balance - charged, fundingPaid: next.fundingPaid + charged };
    if (charged !== 0) events.push({ kind: "FUNDING", amount: charged });
  }

  // --- excursions and protective fills -------------------------------------
  next = {
    ...next,
    positions: next.positions.map((position) => ({
      ...position,
      bestPrice: position.side === "LONG" ? Math.max(position.bestPrice, candle.high) : Math.min(position.bestPrice, candle.low),
      worstPrice: position.side === "LONG" ? Math.min(position.worstPrice, candle.low) : Math.max(position.worstPrice, candle.high),
    })),
  };

  for (const position of [...next.positions]) {
    const exit = resolveExit(position, candle, next.rules);
    if (!exit) continue;
    next = settle(next, position, exit.price, exit.reason, candle, index);
    events.push({
      kind: "EXIT",
      positionId: position.id,
      reason: exit.reason,
      price: exit.price,
      pnl: next.trades[next.trades.length - 1].pnl,
    });
  }

  // --- marks and limit tests -----------------------------------------------
  const marked = markedEquity(next, candle.close);
  next = {
    ...next,
    dayLowEquity: Math.min(next.dayLowEquity, markedEquity(next, candle.low)),
    dayHighEquity: Math.max(next.dayHighEquity, markedEquity(next, candle.high)),
    peakEquity: Math.max(next.peakEquity, marked),
  };

  // Limits are tested against the worst equity seen inside the candle, not the
  // close. Real programmes breach you on the wick.
  const ruleEquity = next.rules.includeUnrealized
    ? Math.min(equityOf(next, candle.low), equityOf(next, candle.high))
    : next.balance;
  const breach = detectBreach(next, ruleEquity);
  if (breach && !next.breach) {
    next = closeAll({ ...next, breach }, candles, index, "RULE_FLATTEN");
    next = { ...next, breach };
    events.push({ kind: "BREACH", message: breach.message });
  }

  return { state: next, events };
}

/** Close out the final day so `days` covers the whole run. */
export function finalise(state: AccountState, candles: Candle[], index: number): AccountState {
  const candle = candles[index] ?? candles.at(-1);
  if (!candle) return state;
  const flat = closeAll(state, candles, index, "SESSION_END");
  const endEquity = flat.balance;
  const summary: DaySummary = {
    dayIndex: flat.dayIndex,
    startedAt: candle.time,
    startEquity: flat.dayStartEquity,
    endEquity,
    lowEquity: Math.min(flat.dayLowEquity, endEquity),
    highEquity: Math.max(flat.dayHighEquity, endEquity),
    pnl: endEquity - flat.dayStartEquity,
    trades: flat.dayTradeCount,
    fees: flat.dayFees,
  };
  return {
    ...flat,
    days: [...flat.days, summary],
    peakEodBalance: Math.max(flat.peakEodBalance, flat.balance),
  };
}

/** Convenience: the current risk-budget readout at a given price. */
export function snapshot(state: AccountState, price: number) {
  return evaluate(state, markedEquity(state, price));
}
