import test from "node:test";
import assert from "node:assert/strict";

import {
  advance,
  closePosition,
  createAccount,
  equityOf,
  finalise,
  markedEquity,
  openPosition,
} from "../lib/engine/account.ts";
import {
  RULE_SETS,
  consistencyShare,
  dailyLossAllowance,
  dailyLossFloor,
  detectBreach,
  drawdownFloor,
  evaluate,
  getRuleSet,
  runStatus,
} from "../lib/engine/propRules.ts";
import { lossesUntilBreach, maxDefensibleRisk, sizePosition } from "../lib/engine/sizing.ts";
import type { AccountState, Candle, RuleSet } from "../lib/engine/types.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

function candle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 1000 };
}

/** A flat tape at `price`, one candle per hour. */
function flatSeries(count: number, price: number, start = 0): Candle[] {
  return Array.from({ length: count }, (_, index) =>
    candle(start + index * HOUR, price, price, price, price),
  );
}

function rulesWithout(overrides: Partial<RuleSet>): RuleSet {
  return {
    ...getRuleSet("bootcamp-1k"),
    takerFee: 0,
    slippage: 0,
    fundingRate8h: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

test("every shipped rule set is internally coherent", () => {
  for (const rules of RULE_SETS) {
    assert.ok(rules.initialBalance > 0, `${rules.id} needs a balance`);
    assert.ok(rules.profitTarget > 0, `${rules.id} needs a target`);
    assert.ok(rules.maxDrawdown > 0, `${rules.id} needs a drawdown limit`);
    assert.ok(
      rules.maxDailyLoss === 0 || rules.maxDailyLoss <= rules.maxDrawdown,
      `${rules.id}: a daily limit looser than the total drawdown can never bind`,
    );
    assert.ok(rules.maxLeverage >= 1, `${rules.id} needs leverage >= 1`);
    assert.ok(rules.note.length > 10, `${rules.id} needs a teaching note`);
  }
});

test("rule set ids are unique", () => {
  const ids = RULE_SETS.map((rules) => rules.id);
  assert.equal(new Set(ids).size, ids.length);
});

// --- drawdown modes --------------------------------------------------------

test("static drawdown floor ignores profit", () => {
  const rules = rulesWithout({ maxDrawdown: 0.1, drawdownMode: "STATIC_INITIAL", initialBalance: 10_000 });
  const state = createAccount(rules);
  assert.equal(drawdownFloor(state), 9_000);
  const richer: AccountState = { ...state, balance: 12_000, peakEquity: 12_000 };
  assert.equal(drawdownFloor(richer), 9_000, "static floors must not move with profit");
});

test("intraday trailing drawdown follows the equity peak forever", () => {
  const rules = rulesWithout({
    maxDrawdown: 0.05,
    drawdownMode: "TRAILING_INTRADAY_EQUITY",
    initialBalance: 10_000,
  });
  const state: AccountState = { ...createAccount(rules), peakEquity: 11_000 };
  assert.equal(drawdownFloor(state), 10_500, "the floor rises above the deposit and keeps going");
});

test("trailing-until-breakeven freezes the floor at the initial balance", () => {
  const rules = rulesWithout({
    maxDrawdown: 0.06,
    drawdownMode: "TRAILING_UNTIL_BREAKEVEN",
    initialBalance: 10_000,
  });
  const early: AccountState = { ...createAccount(rules), peakEquity: 10_200 };
  assert.equal(drawdownFloor(early), 9_600, "still trailing while below breakeven");

  const later: AccountState = { ...createAccount(rules), peakEquity: 13_000 };
  assert.equal(drawdownFloor(later), 10_000, "frozen once it reaches the deposit");
});

test("end-of-day trailing drawdown uses balance, not intraday equity", () => {
  const rules = rulesWithout({
    maxDrawdown: 0.04,
    drawdownMode: "TRAILING_EOD_BALANCE",
    initialBalance: 25_000,
  });
  const state: AccountState = { ...createAccount(rules), peakEquity: 30_000, peakEodBalance: 26_000 };
  assert.equal(drawdownFloor(state), 25_000, "an intraday spike must not move an EOD floor");
});

// --- daily loss ------------------------------------------------------------

test("daily loss basis changes the allowance", () => {
  const base = rulesWithout({ initialBalance: 10_000, maxDailyLoss: 0.05 });

  const fromInitial: AccountState = {
    ...createAccount({ ...base, dailyLossBasis: "INITIAL_BALANCE" }),
    dayStartEquity: 12_000,
  };
  assert.equal(dailyLossAllowance(fromInitial), 500);
  assert.equal(dailyLossFloor(fromInitial), 11_500);

  const fromDayStart: AccountState = {
    ...createAccount({ ...base, dailyLossBasis: "DAY_START_EQUITY" }),
    dayStartEquity: 12_000,
  };
  assert.equal(dailyLossAllowance(fromDayStart), 600);
  assert.equal(dailyLossFloor(fromDayStart), 11_400);
});

test("a zero daily loss rule means no daily floor", () => {
  const rules = rulesWithout({ maxDailyLoss: 0 });
  const state = createAccount(rules);
  assert.equal(dailyLossAllowance(state), Number.POSITIVE_INFINITY);
  assert.equal(dailyLossFloor(state), Number.NEGATIVE_INFINITY);
  assert.equal(evaluate(state, rules.initialBalance).bindingConstraint, "DRAWDOWN");
});

test("the binding constraint is whichever floor is nearer", () => {
  const rules = rulesWithout({
    initialBalance: 10_000,
    maxDailyLoss: 0.02, // floor at 9,800
    dailyLossBasis: "DAY_START_EQUITY",
    maxDrawdown: 0.1, // floor at 9,000
    drawdownMode: "STATIC_INITIAL",
  });
  const fresh = evaluate(createAccount(rules), 10_000);
  assert.equal(fresh.bindingConstraint, "DAILY");
  assert.equal(fresh.bindingRoom, 200);

  // After a losing day the daily limit resets but the static floor does not.
  const late: AccountState = { ...createAccount(rules), balance: 9_100, dayStartEquity: 9_100 };
  const metrics = evaluate(late, 9_100);
  assert.equal(metrics.bindingConstraint, "DRAWDOWN");
  assert.equal(metrics.bindingRoom, 100);
});

test("remaining room never reports negative", () => {
  const rules = rulesWithout({ initialBalance: 10_000, maxDailyLoss: 0.05, maxDrawdown: 0.1 });
  const state = createAccount(rules);
  const metrics = evaluate(state, 8_000);
  assert.equal(metrics.dailyRoom, 0);
  assert.equal(metrics.drawdownRoom, 0);
});

// --- breaches --------------------------------------------------------------

test("breaching the daily limit is detected", () => {
  const rules = rulesWithout({ initialBalance: 10_000, maxDailyLoss: 0.05, dailyLossBasis: "DAY_START_EQUITY" });
  const state = createAccount(rules);
  assert.equal(detectBreach(state, 9_501), null);
  const breach = detectBreach(state, 9_500);
  assert.equal(breach?.code, "DAILY_LOSS");
});

test("drawdown breach takes precedence over the daily limit", () => {
  const rules = rulesWithout({
    initialBalance: 10_000,
    maxDailyLoss: 0.5,
    maxDrawdown: 0.05,
    drawdownMode: "STATIC_INITIAL",
  });
  const breach = detectBreach(createAccount(rules), 9_400);
  assert.equal(breach?.code, "MAX_DRAWDOWN");
});

// --- pass conditions -------------------------------------------------------

test("hitting the profit target is not enough when soft rules are unmet", () => {
  const rules = rulesWithout({
    initialBalance: 10_000,
    profitTarget: 0.08,
    minTradingDays: 3,
    maxSingleDayProfitShare: 0.4,
  });
  const state: AccountState = { ...createAccount(rules), balance: 10_800 };
  const metrics = evaluate(state, 10_800);
  assert.equal(metrics.profitRemaining, 0);
  assert.ok(metrics.pending.includes("MIN_TRADING_DAYS"));
  assert.equal(runStatus(state, metrics), "IN_PROGRESS", "min trading days must block the pass");
});

test("the consistency rule blocks a one-good-day account", () => {
  const rules = rulesWithout({ initialBalance: 10_000, maxSingleDayProfitShare: 0.4 });
  const state: AccountState = {
    ...createAccount(rules),
    days: [
      { dayIndex: 0, startedAt: 0, startEquity: 10_000, endEquity: 10_050, lowEquity: 10_000, highEquity: 10_050, pnl: 50, trades: 1, fees: 0 },
      { dayIndex: 1, startedAt: DAY, startEquity: 10_050, endEquity: 10_850, lowEquity: 10_050, highEquity: 10_850, pnl: 800, trades: 1, fees: 0 },
    ],
    balance: 10_850,
    dayStartEquity: 10_850,
  };
  const share = consistencyShare(state, 0);
  assert.ok(share > 0.9, `expected a lopsided share, got ${share}`);
  assert.ok(evaluate(state, 10_850).pending.includes("CONSISTENCY"));
});

test("consistency is not evaluated on a losing account", () => {
  const rules = rulesWithout({ maxSingleDayProfitShare: 0.4 });
  const state: AccountState = {
    ...createAccount(rules),
    days: [
      { dayIndex: 0, startedAt: 0, startEquity: 1000, endEquity: 1050, lowEquity: 1000, highEquity: 1050, pnl: 50, trades: 1, fees: 0 },
      { dayIndex: 1, startedAt: DAY, startEquity: 1050, endEquity: 900, lowEquity: 900, highEquity: 1050, pnl: -150, trades: 1, fees: 0 },
    ],
  };
  assert.equal(consistencyShare(state, 0), 0);
});

// --- sizing ----------------------------------------------------------------

test("position size accounts for round-trip fees", () => {
  const rules = { ...getRuleSet("bootcamp-1k"), takerFee: 0.0004, maxLeverage: 100 };
  const withFees = sizePosition({ equity: 10_000, riskPct: 0.01, entry: 100, stop: 99, side: "LONG", rules });
  const noFees = sizePosition({ equity: 10_000, riskPct: 0.01, entry: 100, stop: 99, side: "LONG", rules: { ...rules, takerFee: 0 } });

  assert.ok(withFees.qty < noFees.qty, "fees must reduce the size");
  assert.ok(Math.abs(withFees.riskUsd - 100) < 1e-6, "a stop-out should cost exactly the risk budget");
  assert.equal(noFees.qty, 100);
});

test("leverage caps size and says so", () => {
  const rules = { ...getRuleSet("bootcamp-1k"), takerFee: 0, maxLeverage: 5 };
  const result = sizePosition({ equity: 1_000, riskPct: 0.01, entry: 100, stop: 99.9, side: "LONG", rules });
  assert.equal(result.notional, 5_000);
  assert.ok(result.constraints.length > 0);
  assert.ok(result.riskUsd < 10, "capped size risks less than the budget, never more");
});

test("defensible risk shrinks as the limit approaches", () => {
  const rules = rulesWithout({ initialBalance: 10_000, maxDailyLoss: 0.05, dailyLossBasis: "DAY_START_EQUITY" });
  const roomy = evaluate(createAccount(rules), 10_000);
  assert.equal(maxDefensibleRisk(roomy, 0.01).limitedBy, "BASE");

  const tight: AccountState = { ...createAccount(rules), balance: 9_600, dayStartEquity: 10_000 };
  const metrics = evaluate(tight, 9_600);
  const capped = maxDefensibleRisk(metrics, 0.01);
  assert.equal(capped.limitedBy, "DAILY");
  assert.ok(capped.riskUsd < 100, "the cap must bite when only 100 U of room is left");
  assert.equal(Math.round(capped.riskUsd), 33);
});

test("lossesUntilBreach counts full-risk losses", () => {
  const rules = rulesWithout({ initialBalance: 10_000, maxDailyLoss: 0.05, dailyLossBasis: "DAY_START_EQUITY" });
  const metrics = evaluate(createAccount(rules), 10_000);
  assert.equal(lossesUntilBreach(metrics, 100), 5);
  assert.equal(lossesUntilBreach(metrics, 0), Number.POSITIVE_INFINITY);
});

// --- account mechanics -----------------------------------------------------

test("a flat tape with zero costs leaves equity untouched", () => {
  const rules = rulesWithout({});
  const candles = flatSeries(10, 100);
  let state = createAccount(rules);
  for (let index = 1; index < candles.length; index += 1) {
    state = advance(state, candles, index).state;
  }
  assert.equal(markedEquity(state, 100), rules.initialBalance);
});

test("opening and closing at the same price costs exactly the fees", () => {
  const rules = rulesWithout({ takerFee: 0.001, slippage: 0 });
  const candles = flatSeries(5, 100);
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 1, stop: 95, target: null }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const closed = closePosition(opened.state, opened.position.id, candles, 1);
  assert.equal(closed.trades.length, 1);
  assert.ok(Math.abs(closed.trades[0].pnl + 0.2) < 1e-9, "0.1 U in + 0.1 U out");
  assert.ok(Math.abs(closed.balance - (1000 - 0.2)) < 1e-9);
});

test("slippage always moves the fill against the trader", () => {
  const rules = rulesWithout({ slippage: 0.001, takerFee: 0 });
  const candles = flatSeries(5, 100);
  const long = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 1, stop: 95, target: null }, candles, 0);
  const short = openPosition(createAccount(rules), { side: "SHORT", qty: 1, leverage: 1, stop: 105, target: null }, candles, 0);
  assert.ok(long.ok && short.ok);
  if (!long.ok || !short.ok) return;
  assert.ok(long.position.entry > 100, "buying fills higher");
  assert.ok(short.position.entry < 100, "selling fills lower");
});

test("a stop and a target inside one candle resolves as a stop-out", () => {
  const rules = rulesWithout({});
  const candles = [
    candle(0, 100, 100, 100, 100),
    // The next bar spans both levels. OHLC cannot tell us the order, so the
    // simulator must assume the loss.
    candle(HOUR, 100, 110, 90, 105),
  ];
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 1, stop: 95, target: 108 }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const { state } = advance(opened.state, candles, 1);
  assert.equal(state.trades.length, 1);
  assert.equal(state.trades[0].reason, "STOP");
  assert.ok(state.trades[0].pnl < 0);
});

test("a gap through the stop fills at the open, not at the stop", () => {
  const rules = rulesWithout({});
  const candles = [candle(0, 100, 100, 100, 100), candle(HOUR, 90, 92, 88, 91)];
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 1, stop: 95, target: null }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const { state } = advance(opened.state, candles, 1);
  assert.equal(state.trades[0].exit, 90, "you do not get filled at a price that never traded");
  assert.ok(state.trades[0].rMultiple < -1, "a gap loses more than the planned 1R");
});

test("a target that gaps in your favour fills at the better open", () => {
  const rules = rulesWithout({});
  const candles = [candle(0, 100, 100, 100, 100), candle(HOUR, 112, 115, 111, 114)];
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 1, stop: 95, target: 108 }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const { state } = advance(opened.state, candles, 1);
  assert.equal(state.trades[0].reason, "TARGET");
  assert.equal(state.trades[0].exit, 112);
});

test("liquidation triggers before the account can go negative", () => {
  const rules = rulesWithout({ maintenanceMargin: 0.005 });
  const candles = [candle(0, 100, 100, 100, 100), candle(HOUR, 100, 100, 80, 82)];
  // 10x with no stop: liquidation sits near 90.5.
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 10, stop: null, target: null }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  assert.ok(Math.abs(opened.position.liquidation - 90.5) < 1e-9);
  const { state } = advance(opened.state, candles, 1);
  assert.equal(state.trades[0].reason, "LIQUIDATION");
  assert.ok(state.balance > 0, "the modelled loss stays bounded by the margin");
});

test("the stop is hit before liquidation when it is closer", () => {
  const rules = rulesWithout({});
  const candles = [candle(0, 100, 100, 100, 100), candle(HOUR, 100, 100, 80, 82)];
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 10, stop: 98, target: null }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  assert.equal(advance(opened.state, candles, 1).state.trades[0].reason, "STOP");
});

test("open is rejected above the rule set's leverage cap", () => {
  const rules = rulesWithout({ maxLeverage: 10 });
  const result = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 25, stop: 95, target: null }, flatSeries(3, 100), 0);
  assert.equal(result.ok, false);
});

test("open is rejected when margin exceeds free equity", () => {
  const rules = rulesWithout({ initialBalance: 1000, maxLeverage: 20 });
  const result = openPosition(createAccount(rules), { side: "LONG", qty: 500, leverage: 1, stop: 95, target: null }, flatSeries(3, 100), 0);
  assert.equal(result.ok, false);
});

test("a stop on the wrong side of entry is rejected", () => {
  const rules = rulesWithout({});
  const result = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 1, stop: 105, target: null }, flatSeries(3, 100), 0);
  assert.equal(result.ok, false);
});

// --- day rollover ----------------------------------------------------------

test("crossing midnight UTC rolls the day and resets the daily limit", () => {
  const rules = rulesWithout({ initialBalance: 1000, maxDailyLoss: 0.04, dailyLossBasis: "DAY_START_EQUITY" });
  const candles = [
    candle(23 * HOUR, 100, 100, 100, 100),
    candle(24 * HOUR, 100, 100, 100, 100), // next UTC day
  ];
  let state = createAccount(rules);
  state = { ...state, balance: 970 }; // lost 30 U today
  const before = evaluate(state, 970);
  assert.equal(Math.round(before.dailyRoom), 10);

  const { state: rolled, events } = advance(state, candles, 1);
  assert.ok(events.some((event) => event.kind === "DAY_ROLL"));
  assert.equal(rolled.dayIndex, 1);
  assert.equal(rolled.dayStartEquity, 970);
  const after = evaluate(rolled, 970);
  assert.ok(after.dailyRoom > before.dailyRoom, "a new day restores the daily allowance");
  assert.equal(Math.round(after.dailyRoom), Math.round(970 * 0.04));
});

test("a breach on the wick ends the run even if the candle closes back inside", () => {
  const rules = rulesWithout({
    initialBalance: 1000,
    maxDailyLoss: 0.05,
    dailyLossBasis: "DAY_START_EQUITY",
    maxDrawdown: 0.5, // keep the drawdown floor far away so the daily rule binds
    includeUnrealized: true,
    maxLeverage: 20,
  });
  const candles = [
    candle(0, 100, 100, 100, 100),
    // Dips 8% intrabar, closes flat. With 1x notional of 1000 U that is an
    // 80 U unrealised loss at the low: past the 50 U daily limit.
    candle(HOUR, 100, 100, 92, 100),
  ];
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 10, leverage: 2, stop: null, target: null }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const { state, events } = advance(opened.state, candles, 1);
  assert.ok(events.some((event) => event.kind === "BREACH"), "the wick must breach");
  assert.equal(state.breach?.code, "DAILY_LOSS");
  assert.equal(state.positions.length, 0, "a breached account is flattened");
});

test("a breach does not fire on unrealized loss when the rules exclude it", () => {
  const rules = rulesWithout({
    initialBalance: 1000,
    maxDailyLoss: 0.05,
    dailyLossBasis: "DAY_START_EQUITY",
    includeUnrealized: false,
    maxLeverage: 20,
  });
  const candles = [candle(0, 100, 100, 100, 100), candle(HOUR, 100, 100, 92, 100)];
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 10, leverage: 2, stop: null, target: null }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const { state } = advance(opened.state, candles, 1);
  assert.equal(state.breach, null);
  assert.equal(state.positions.length, 1);
});

test("equityOf honours the includeUnrealized flag", () => {
  const rules = rulesWithout({ includeUnrealized: false });
  const candles = flatSeries(3, 100);
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 1, stop: 95, target: null }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  assert.equal(equityOf(opened.state, 120), opened.state.balance);
  assert.ok(markedEquity(opened.state, 120) > opened.state.balance);
});

test("funding is charged when an 8h boundary is crossed", () => {
  const rules = rulesWithout({ fundingRate8h: 0.01 });
  const candles = [candle(7 * HOUR, 100, 100, 100, 100), candle(8 * HOUR, 100, 100, 100, 100)];
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 1, stop: 95, target: null }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const { state, events } = advance(opened.state, candles, 1);
  assert.ok(events.some((event) => event.kind === "FUNDING"));
  assert.ok(Math.abs(state.fundingPaid - 1) < 1e-9, "1% of 100 U notional");
});

test("finalise closes open positions and books the last day", () => {
  const rules = rulesWithout({});
  const candles = flatSeries(4, 100);
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 1, stop: 95, target: null }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const done = finalise(opened.state, candles, 3);
  assert.equal(done.positions.length, 0);
  assert.equal(done.days.length, 1);
  assert.equal(done.trades[0].reason, "SESSION_END");
});

test("R multiple is 1 when a target at 1R is reached", () => {
  const rules = rulesWithout({});
  const candles = [candle(0, 100, 100, 100, 100), candle(HOUR, 100, 106, 100, 105)];
  // Stop 5 below, target 5 above: a clean 1R.
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 1, stop: 95, target: 105 }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const { state } = advance(opened.state, candles, 1);
  assert.equal(state.trades[0].reason, "TARGET");
  assert.ok(Math.abs(state.trades[0].rMultiple - 1) < 1e-9);
});

test("R multiple is -1 when the stop is hit cleanly", () => {
  const rules = rulesWithout({});
  const candles = [candle(0, 100, 100, 100, 100), candle(HOUR, 100, 100, 94, 96)];
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 1, leverage: 1, stop: 95, target: 105 }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const { state } = advance(opened.state, candles, 1);
  assert.ok(Math.abs(state.trades[0].rMultiple + 1) < 1e-9);
});

test("a clean stop-out is still exactly -1R once fees are switched on", () => {
  // Regression guard: planned risk includes both fees, so the realised loss
  // must include both too, or every R statistic in the product flatters the
  // trader by the size of the entry commission.
  const rules = rulesWithout({ takerFee: 0.0005, slippage: 0 });
  const candles = [candle(0, 100, 100, 100, 100), candle(HOUR, 100, 100, 94, 96)];
  const opened = openPosition(createAccount(rules), { side: "LONG", qty: 2, leverage: 1, stop: 95, target: null }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const { state } = advance(opened.state, candles, 1);
  const trade = state.trades[0];
  assert.ok(trade.fees > 0, "the fixture must actually charge fees");
  assert.ok(Math.abs(trade.rMultiple + 1) < 1e-9, `expected -1R, got ${trade.rMultiple}`);
  assert.ok(Math.abs(trade.pnl + trade.plannedRiskUsd) < 1e-9);
});

test("reported round-trip P&L reconciles with the balance change", () => {
  const rules = rulesWithout({ takerFee: 0.001, slippage: 0 });
  const candles = flatSeries(3, 100);
  const start = createAccount(rules);
  const opened = openPosition(start, { side: "LONG", qty: 1, leverage: 1, stop: 95, target: null }, candles, 0);
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const closed = closePosition(opened.state, opened.position.id, candles, 1);
  const balanceDelta = closed.balance - start.balance;
  assert.ok(Math.abs(balanceDelta - closed.trades[0].pnl) < 1e-9, "pnl must equal the total balance move");
});
