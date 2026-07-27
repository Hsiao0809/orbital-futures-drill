// Core domain types for the ORBITAL prop-evaluation trainer.
//
// Everything in `lib/engine` is pure and dependency-free so it can be unit
// tested with `node --test` and reused on both the server and the client.

export type Side = "LONG" | "SHORT";
export type Interval = "5m" | "15m" | "1h" | "4h";

export type Candle = {
  time: number; // open time, ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type MarketSeries = {
  symbol: string;
  interval: Interval;
  candles: Candle[];
};

// ---------------------------------------------------------------------------
// Prop firm rule modelling
// ---------------------------------------------------------------------------

/** How the hard "you are done" floor is computed. */
export type DrawdownMode =
  /** Floor fixed at `initialBalance * (1 - maxDrawdown)`. FTMO-style. */
  | "STATIC_INITIAL"
  /** Floor trails the highest intraday *equity* ever reached. Apex-style. */
  | "TRAILING_INTRADAY_EQUITY"
  /** Floor trails the highest *end-of-day balance*. Topstep-style. */
  | "TRAILING_EOD_BALANCE"
  /**
   * Trails intraday equity but stops trailing once the floor reaches
   * `initialBalance` (the account can no longer lose its own deposit).
   */
  | "TRAILING_UNTIL_BREAKEVEN";

/** What the daily loss limit is measured against. */
export type DailyLossBasis =
  | "INITIAL_BALANCE"
  | "DAY_START_EQUITY"
  | "DAY_START_BALANCE";

export type RuleSet = {
  id: string;
  /** Display label, e.g. "FTMO 10K · Phase 1". */
  label: string;
  /** Which real-world program family this models. Informational. */
  family: string;
  initialBalance: number;

  /** Profit needed to pass, as a fraction of initial balance. */
  profitTarget: number;
  /** Max loss in a single trading day, fraction of `dailyLossBasis`. 0 = no rule. */
  maxDailyLoss: number;
  dailyLossBasis: DailyLossBasis;
  /** Total drawdown allowance, fraction of initial balance. */
  maxDrawdown: number;
  drawdownMode: DrawdownMode;
  /** Whether unrealized P&L counts toward the loss limits (equity vs balance). */
  includeUnrealized: boolean;

  /** Minimum number of days with at least one closed trade. 0 = no rule. */
  minTradingDays: number;
  /** Hard cap on calendar days. 0 = unlimited. */
  maxTradingDays: number;
  /**
   * Consistency rule: the best single day may not exceed this fraction of
   * total profit. 0 = no rule.
   */
  maxSingleDayProfitShare: number;
  /** Minimum profit for a day to count as a "winning day" (Topstep-style). */
  minWinningDayProfit: number;
  /** Required number of winning days. 0 = no rule. */
  minWinningDays: number;

  /** Modelled taker fee per side, fraction of notional. */
  takerFee: number;
  /** Base slippage, fraction of price, scaled by volatility at fill time. */
  slippage: number;
  /** Modelled funding rate charged per 8h interval, fraction of notional. */
  fundingRate8h: number;
  /** Maintenance margin rate used for the liquidation model. */
  maintenanceMargin: number;
  /** Highest leverage the program permits. */
  maxLeverage: number;

  /** Short, human explanation of what kills accounts under this rule set. */
  note: string;
};

export type BreachCode =
  | "DAILY_LOSS"
  | "MAX_DRAWDOWN"
  | "LEVERAGE"
  | "TIME_LIMIT"
  | "LIQUIDATION";

export type RuleBreach = {
  code: BreachCode;
  /** Day index (0-based) on which the breach happened. */
  dayIndex: number;
  /** Equity at the moment of the breach. */
  equity: number;
  /** The threshold that was violated. */
  threshold: number;
  message: string;
};

export type PendingRuleFail =
  | "MIN_TRADING_DAYS"
  | "MIN_WINNING_DAYS"
  | "CONSISTENCY";

export type RunStatus = "IN_PROGRESS" | "PASSED" | "FAILED";

/** The live risk-budget readout. This is the product's core teaching surface. */
export type RuleMetrics = {
  equity: number;
  balance: number;
  profit: number;
  profitPct: number;
  /** 0..1 progress toward the profit target. */
  targetProgress: number;
  profitRemaining: number;

  /** Absolute equity level that triggers a daily-loss breach. */
  dailyLossFloor: number;
  dailyLossUsed: number;
  dailyLossAllowance: number;
  /** Currency room before the daily limit trips. Never below 0. */
  dailyRoom: number;

  /** Absolute equity level that ends the account. */
  drawdownFloor: number;
  /** Currency room before the account dies. Never below 0. */
  drawdownRoom: number;
  /** The binding constraint right now: whichever floor is nearer. */
  bindingFloor: number;
  bindingRoom: number;
  bindingConstraint: "DAILY" | "DRAWDOWN";

  tradingDays: number;
  tradingDaysRemaining: number;
  winningDays: number;
  /** Largest single-day profit as a share of total profit, 0..1. */
  worstConsistencyShare: number;
  /** Rules that are not yet satisfied but are not fatal. */
  pending: PendingRuleFail[];
};

// ---------------------------------------------------------------------------
// Positions, trades, account state
// ---------------------------------------------------------------------------

export type OpenIntent = {
  side: Side;
  /** Base-asset quantity. Derive it with `sizePosition` rather than guessing. */
  qty: number;
  leverage: number;
  /** Absolute stop price. `null` means the trade has no protective stop. */
  stop: number | null;
  /** Absolute take-profit price, or `null` to manage manually. */
  target: number | null;
  /** Free-form tags used by diagnostics and the journal. */
  tags?: string[];
};

export type SimPosition = {
  id: string;
  side: Side;
  /** Fill price including slippage. */
  entry: number;
  qty: number;
  leverage: number;
  stop: number | null;
  target: number | null;
  /** Stop as originally submitted, retained to detect stop widening. */
  initialStop: number | null;
  /** Margin locked at entry. */
  margin: number;
  entryFee: number;
  fundingPaid: number;
  openedAt: number;
  openedIndex: number;
  /** Currency risk implied by the initial stop. 0 when there was no stop. */
  plannedRiskUsd: number;
  /** Account equity when the trade was opened. Diagnostics need the context. */
  equityAtOpen: number;
  /** Room to the binding limit when the trade was opened. */
  bindingRoomAtOpen: number;
  /** Modelled liquidation price. */
  liquidation: number;
  /** Best and worst price reached while open. */
  bestPrice: number;
  worstPrice: number;
  stopMoves: number;
  stopWidenings: number;
  tags: string[];
};

export type ExitReason =
  | "STOP"
  | "TARGET"
  | "MANUAL"
  | "LIQUIDATION"
  | "SESSION_END"
  | "RULE_FLATTEN";

export type ClosedTrade = {
  id: string;
  side: Side;
  entry: number;
  exit: number;
  qty: number;
  leverage: number;
  initialStop: number | null;
  plannedRiskUsd: number;
  equityAtOpen: number;
  bindingRoomAtOpen: number;
  openedAt: number;
  closedAt: number;
  openedIndex: number;
  closedIndex: number;
  holdBars: number;
  reason: ExitReason;
  grossPnl: number;
  fees: number;
  funding: number;
  /** Net P&L after fees, slippage and funding. */
  pnl: number;
  /** Net P&L expressed in units of planned risk. 0 when risk was undefined. */
  rMultiple: number;
  /** Max favourable / adverse excursion in R. */
  mfeR: number;
  maeR: number;
  stopMoves: number;
  stopWidenings: number;
  dayIndex: number;
  tags: string[];
};

export type DaySummary = {
  dayIndex: number;
  /** Open time of the first candle of the day, ms epoch. */
  startedAt: number;
  startEquity: number;
  endEquity: number;
  /** Lowest equity reached during the day. */
  lowEquity: number;
  highEquity: number;
  pnl: number;
  trades: number;
  fees: number;
};

export type AccountState = {
  rules: RuleSet;
  /** Realized cash. */
  balance: number;
  positions: SimPosition[];
  trades: ClosedTrade[];
  days: DaySummary[];
  dayIndex: number;
  dayStartEquity: number;
  dayStartBalance: number;
  dayLowEquity: number;
  dayHighEquity: number;
  dayTradeCount: number;
  dayFees: number;
  /** Highest equity ever reached, for trailing drawdown modes. */
  peakEquity: number;
  /** Highest end-of-day balance, for EOD trailing drawdown modes. */
  peakEodBalance: number;
  feesPaid: number;
  fundingPaid: number;
  breach: RuleBreach | null;
  /** Monotonic counter used to mint position ids deterministically. */
  seq: number;
};

// ---------------------------------------------------------------------------
// Skill model
// ---------------------------------------------------------------------------

/**
 * The five competencies a funded trader is actually assessed on. Ratings are
 * 0..100 and move with an exponentially weighted average so a single bad
 * session does not erase demonstrated skill.
 */
export type SkillId =
  /** Reading market structure and picking a side with an edge. */
  | "READ"
  /** Translating a stop distance into a compliant position size. */
  | "SIZING"
  /** Honouring stops and daily limits once a trade goes against you. */
  | "DISCIPLINE"
  /** Waiting for a setup instead of manufacturing trades. */
  | "PATIENCE"
  /** Producing a steady equity curve rather than one lucky day. */
  | "CONSISTENCY";

export type SkillVector = Record<SkillId, number>;

export type ProgressProfile = {
  version: 1;
  xp: number;
  skills: SkillVector;
  /** Drill id -> mastery record. */
  mastery: Record<string, MasteryRecord>;
  /** Streak of distinct calendar days with at least one completed drill. */
  streakDays: number;
  lastActiveDay: string | null;
  /** Total completed drills, all time. */
  drillsCompleted: number;
  /** Completed evaluation runs, most recent first (capped). */
  runHistory: RunRecord[];
  /** Behaviour flag counters, all time. Used for the coaching engine. */
  flagCounts: Record<string, number>;
};

export type MasteryRecord = {
  attempts: number;
  /** Rolling average score, 0..100. */
  score: number;
  /** Consecutive attempts at or above the mastery threshold. */
  streak: number;
  mastered: boolean;
  lastAttemptAt: number;
};

export type RunRecord = {
  id: string;
  ruleSetId: string;
  symbol: string;
  interval: Interval;
  status: RunStatus;
  profit: number;
  profitPct: number;
  tradingDays: number;
  trades: number;
  /** Sum of R across all trades. */
  totalR: number;
  breach: BreachCode | null;
  disciplineScore: number;
  finishedAt: number;
};
