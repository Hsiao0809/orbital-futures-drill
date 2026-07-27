// Prop firm rule modelling.
//
// This is the heart of the product. Evaluations are not lost by picking the
// wrong direction — they are lost by breaching a limit. So the engine models
// those limits precisely and, more importantly, reports how much room is left
// *before* the trader acts.
//
// The presets below model the rule *structures* that crypto prop programmes
// commonly use. They are deliberately generic: real firms change their terms,
// so treat these as training profiles rather than as any firm's current offer.

import type {
  AccountState,
  DrawdownMode,
  PendingRuleFail,
  RuleBreach,
  RuleMetrics,
  RuleSet,
  RunStatus,
} from "./types.ts";

const BASE_COSTS = {
  takerFee: 0.0004,
  slippage: 0.0002,
  fundingRate8h: 0.0001,
  maintenanceMargin: 0.005,
} as const;

function ruleSet(partial: Omit<RuleSet, keyof typeof BASE_COSTS> & Partial<RuleSet>): RuleSet {
  return { ...BASE_COSTS, ...partial };
}

export const RULE_SETS: RuleSet[] = [
  ruleSet({
    id: "bootcamp-1k",
    label: "新手訓練營 · 1,000 U",
    family: "ORBITAL 內建",
    initialBalance: 1000,
    profitTarget: 0.06,
    maxDailyLoss: 0.04,
    dailyLossBasis: "DAY_START_EQUITY",
    maxDrawdown: 0.08,
    drawdownMode: "STATIC_INITIAL",
    includeUnrealized: true,
    minTradingDays: 2,
    maxTradingDays: 0,
    maxSingleDayProfitShare: 0,
    minWinningDayProfit: 0,
    minWinningDays: 0,
    maxLeverage: 10,
    note: "寬鬆的靜態回撤，先建立「先算風險再下單」的習慣。沒有一致性條款。",
  }),
  ruleSet({
    id: "crypto-2step-p1",
    label: "兩階段 · 第一階段 · 10,000 U",
    family: "加密貨幣 Prop（兩階段）",
    initialBalance: 10000,
    profitTarget: 0.08,
    maxDailyLoss: 0.05,
    dailyLossBasis: "DAY_START_EQUITY",
    maxDrawdown: 0.1,
    drawdownMode: "STATIC_INITIAL",
    includeUnrealized: true,
    minTradingDays: 3,
    maxTradingDays: 0,
    maxSingleDayProfitShare: 0.4,
    minWinningDayProfit: 0,
    minWinningDays: 0,
    maxLeverage: 20,
    note: "未實現損益計入上限：抱著一張浮虧單過夜就可能在你沒平倉的情況下違規。",
  }),
  ruleSet({
    id: "crypto-2step-p2",
    label: "兩階段 · 第二階段 · 10,000 U",
    family: "加密貨幣 Prop（兩階段）",
    initialBalance: 10000,
    profitTarget: 0.05,
    maxDailyLoss: 0.05,
    dailyLossBasis: "DAY_START_EQUITY",
    maxDrawdown: 0.1,
    drawdownMode: "STATIC_INITIAL",
    includeUnrealized: true,
    minTradingDays: 3,
    maxTradingDays: 0,
    maxSingleDayProfitShare: 0.4,
    minWinningDayProfit: 0,
    minWinningDays: 0,
    maxLeverage: 20,
    note: "目標砍半但限制不變。多數人在這一關輸給「已經很接近了」的急躁。",
  }),
  ruleSet({
    id: "crypto-1step-trailing",
    label: "單階段 · 追蹤回撤 · 10,000 U",
    family: "加密貨幣 Prop（單階段）",
    initialBalance: 10000,
    profitTarget: 0.1,
    maxDailyLoss: 0.04,
    dailyLossBasis: "DAY_START_EQUITY",
    maxDrawdown: 0.06,
    drawdownMode: "TRAILING_UNTIL_BREAKEVEN",
    includeUnrealized: true,
    minTradingDays: 3,
    maxTradingDays: 0,
    maxSingleDayProfitShare: 0.35,
    minWinningDayProfit: 0,
    minWinningDays: 0,
    maxLeverage: 20,
    note: "死亡線會跟著你的權益新高往上爬。獲利之後回吐，比一開始就虧更容易出局。",
  }),
  ruleSet({
    id: "crypto-instant-5k",
    label: "即時資金 · 盤中追蹤 · 5,000 U",
    family: "加密貨幣 Prop（即時資金）",
    initialBalance: 5000,
    profitTarget: 0.06,
    maxDailyLoss: 0.03,
    dailyLossBasis: "DAY_START_EQUITY",
    maxDrawdown: 0.05,
    drawdownMode: "TRAILING_INTRADAY_EQUITY",
    includeUnrealized: true,
    minTradingDays: 5,
    maxTradingDays: 0,
    maxSingleDayProfitShare: 0.3,
    minWinningDayProfit: 25,
    minWinningDays: 3,
    maxLeverage: 10,
    note: "最嚴格的模式：回撤線追蹤盤中權益最高點，而且永不凍結。一根反轉就可能結束。",
  }),
  ruleSet({
    id: "crypto-eod-trailing",
    label: "日結追蹤 · 25,000 U",
    family: "加密貨幣 Prop（日結追蹤）",
    initialBalance: 25000,
    profitTarget: 0.06,
    maxDailyLoss: 0.02,
    dailyLossBasis: "INITIAL_BALANCE",
    maxDrawdown: 0.04,
    drawdownMode: "TRAILING_EOD_BALANCE",
    includeUnrealized: false,
    minTradingDays: 5,
    maxTradingDays: 30,
    maxSingleDayProfitShare: 0.5,
    minWinningDayProfit: 100,
    minWinningDays: 3,
    maxLeverage: 10,
    note: "回撤線只在收盤結算後上移，且日虧損以初始資金計算。適合練「每天穩定拿一點」。",
  }),
];

export const DEFAULT_RULE_SET_ID = "bootcamp-1k";

export function getRuleSet(id: string): RuleSet {
  return RULE_SETS.find((item) => item.id === id) ?? RULE_SETS[0];
}

export function describeDrawdownMode(mode: DrawdownMode): string {
  switch (mode) {
    case "STATIC_INITIAL":
      return "靜態：死亡線固定在初始資金下方，獲利不會改變它。";
    case "TRAILING_INTRADAY_EQUITY":
      return "盤中追蹤：死亡線跟著盤中權益最高點上移，且不會停止。";
    case "TRAILING_EOD_BALANCE":
      return "日結追蹤：死亡線只在每日收盤結算後、依當日結算餘額上移。";
    case "TRAILING_UNTIL_BREAKEVEN":
      return "追蹤至損益兩平：死亡線上移到初始資金後凍結，之後不再往上。";
  }
}

// ---------------------------------------------------------------------------
// Live limit maths
// ---------------------------------------------------------------------------

/** Absolute equity level at which the account is dead. */
export function drawdownFloor(state: AccountState): number {
  const { rules } = state;
  const allowance = rules.initialBalance * rules.maxDrawdown;
  switch (rules.drawdownMode) {
    case "STATIC_INITIAL":
      return rules.initialBalance - allowance;
    case "TRAILING_INTRADAY_EQUITY":
      return state.peakEquity - allowance;
    case "TRAILING_EOD_BALANCE":
      return state.peakEodBalance - allowance;
    case "TRAILING_UNTIL_BREAKEVEN":
      return Math.min(state.peakEquity - allowance, rules.initialBalance);
  }
}

/** Currency amount the trader may lose today before the daily rule trips. */
export function dailyLossAllowance(state: AccountState): number {
  const { rules } = state;
  if (!rules.maxDailyLoss) return Number.POSITIVE_INFINITY;
  const basis =
    rules.dailyLossBasis === "INITIAL_BALANCE"
      ? rules.initialBalance
      : rules.dailyLossBasis === "DAY_START_BALANCE"
        ? state.dayStartBalance
        : state.dayStartEquity;
  return basis * rules.maxDailyLoss;
}

/** Absolute equity level at which the daily rule trips. */
export function dailyLossFloor(state: AccountState): number {
  const allowance = dailyLossAllowance(state);
  if (!Number.isFinite(allowance)) return Number.NEGATIVE_INFINITY;
  return state.dayStartEquity - allowance;
}

/**
 * The largest single-day profit as a share of total profit. Returns 0 when the
 * account is not in profit, because the rule only bites on a passing account.
 */
export function consistencyShare(state: AccountState, currentDayPnl: number): number {
  const dayPnls = [...state.days.map((day) => day.pnl), currentDayPnl];
  const totalProfit = dayPnls.reduce((sum, value) => sum + value, 0);
  if (totalProfit <= 0) return 0;
  const best = Math.max(...dayPnls);
  return best <= 0 ? 0 : Math.min(1, best / totalProfit);
}

function countWinningDays(state: AccountState, currentDayPnl: number): number {
  const threshold = state.rules.minWinningDayProfit;
  const dayPnls = [...state.days.map((day) => day.pnl), currentDayPnl];
  return dayPnls.filter((pnl) => pnl > 0 && pnl >= threshold).length;
}

/** Distinct days on which at least one trade was closed. */
export function tradingDays(state: AccountState): number {
  const closed = new Set(state.trades.map((trade) => trade.dayIndex));
  return closed.size;
}

/**
 * The full risk-budget readout. Everything the trader needs to answer "can I
 * take this trade?" comes from here.
 */
export function evaluate(state: AccountState, equity: number): RuleMetrics {
  const { rules } = state;
  const profit = equity - rules.initialBalance;
  const currentDayPnl = equity - state.dayStartEquity;

  const ddFloor = drawdownFloor(state);
  const dailyFloor = dailyLossFloor(state);
  const allowance = dailyLossAllowance(state);

  const drawdownRoom = Math.max(0, equity - ddFloor);
  const dailyRoom = Number.isFinite(dailyFloor) ? Math.max(0, equity - dailyFloor) : Number.POSITIVE_INFINITY;
  const dailyBinds = dailyRoom < drawdownRoom;

  const days = tradingDays(state);
  const winningDays = countWinningDays(state, currentDayPnl);
  const share = consistencyShare(state, currentDayPnl);

  const pending: PendingRuleFail[] = [];
  if (rules.minTradingDays && days < rules.minTradingDays) pending.push("MIN_TRADING_DAYS");
  if (rules.minWinningDays && winningDays < rules.minWinningDays) pending.push("MIN_WINNING_DAYS");
  if (rules.maxSingleDayProfitShare && share > rules.maxSingleDayProfitShare) pending.push("CONSISTENCY");

  const targetAmount = rules.initialBalance * rules.profitTarget;

  return {
    equity,
    balance: state.balance,
    profit,
    profitPct: profit / rules.initialBalance,
    targetProgress: targetAmount ? Math.max(0, Math.min(1, profit / targetAmount)) : 1,
    profitRemaining: Math.max(0, targetAmount - profit),

    dailyLossFloor: dailyFloor,
    dailyLossUsed: Math.max(0, state.dayStartEquity - equity),
    dailyLossAllowance: allowance,
    dailyRoom,

    drawdownFloor: ddFloor,
    drawdownRoom,
    bindingFloor: dailyBinds ? dailyFloor : ddFloor,
    bindingRoom: dailyBinds ? dailyRoom : drawdownRoom,
    bindingConstraint: dailyBinds ? "DAILY" : "DRAWDOWN",

    tradingDays: days,
    tradingDaysRemaining: rules.maxTradingDays ? Math.max(0, rules.maxTradingDays - state.dayIndex - 1) : Number.POSITIVE_INFINITY,
    winningDays,
    worstConsistencyShare: share,
    pending,
  };
}

/**
 * Detect a hard breach at the given equity. Returns `null` when the account is
 * still alive. Checked on every candle, including on unrealized P&L when the
 * rule set says so — that is exactly how real programmes kill accounts.
 */
export function detectBreach(state: AccountState, equity: number): RuleBreach | null {
  if (state.breach) return state.breach;
  const ddFloor = drawdownFloor(state);
  if (equity <= ddFloor) {
    return {
      code: "MAX_DRAWDOWN",
      dayIndex: state.dayIndex,
      equity,
      threshold: ddFloor,
      message: `帳戶權益 ${equity.toFixed(2)} U 觸及最大回撤死亡線 ${ddFloor.toFixed(2)} U，考試結束。`,
    };
  }
  const dailyFloor = dailyLossFloor(state);
  if (Number.isFinite(dailyFloor) && equity <= dailyFloor) {
    return {
      code: "DAILY_LOSS",
      dayIndex: state.dayIndex,
      equity,
      threshold: dailyFloor,
      message: `當日虧損觸及上限（權益 ${equity.toFixed(2)} U ≤ ${dailyFloor.toFixed(2)} U），考試結束。`,
    };
  }
  if (state.rules.maxTradingDays && state.dayIndex >= state.rules.maxTradingDays) {
    return {
      code: "TIME_LIMIT",
      dayIndex: state.dayIndex,
      equity,
      threshold: state.rules.maxTradingDays,
      message: `已超過 ${state.rules.maxTradingDays} 個交易日的時間限制。`,
    };
  }
  return null;
}

/**
 * Overall pass/fail. An account only passes once the profit target is met *and*
 * every soft rule is satisfied — this is where "I hit the target on day one"
 * traders discover the consistency rule.
 */
export function runStatus(state: AccountState, metrics: RuleMetrics): RunStatus {
  if (state.breach) return "FAILED";
  if (metrics.profitRemaining > 0) return "IN_PROGRESS";
  return metrics.pending.length ? "IN_PROGRESS" : "PASSED";
}

/** Human-readable reason a target-hitting account still has not passed. */
export function describePending(rules: RuleSet, pending: PendingRuleFail[]): string[] {
  return pending.map((code) => {
    switch (code) {
      case "MIN_TRADING_DAYS":
        return `尚未達到最低 ${rules.minTradingDays} 個交易日。`;
      case "MIN_WINNING_DAYS":
        return `尚未達到 ${rules.minWinningDays} 個獲利日（單日需 ≥ ${rules.minWinningDayProfit} U）。`;
      case "CONSISTENCY":
        return `違反一致性條款：單日獲利不得超過總獲利的 ${(rules.maxSingleDayProfitShare * 100).toFixed(0)}%。`;
    }
  });
}
