// Drills: the deliberate-practice layer.
//
// Each drill isolates one competency and grades it against an objective
// standard. Two design rules run through all of them:
//
//   1. Nothing is graded on a single candle. Direction over one bar is noise;
//      the graders ask path-aware questions over a horizon instead.
//   2. Over-risking always scores worse than under-risking by the same margin.
//      An evaluation account punishes those two errors asymmetrically, so the
//      trainer must too.

import { atr, forwardOutcome, readStructure, swingPoints, type StructureRead } from "./indicators.ts";
import { createRng, pick, randInt, type Rng } from "./rng.ts";
import { evaluate, getRuleSet } from "./propRules.ts";
import { createAccount } from "./account.ts";
import { maxDefensibleRisk, sizePosition } from "./sizing.ts";
import type {
  AccountState,
  Candle,
  ClosedTrade,
  DaySummary,
  Interval,
  RuleSet,
  Side,
  SkillId,
} from "./types.ts";

export type DrillKind = "BIAS" | "SIZING" | "STOP" | "EXIT" | "RULE_GUARD" | "TILT";

export type DrillMeta = {
  id: string;
  kind: DrillKind;
  title: string;
  skill: SkillId;
  blurb: string;
  /** Why this matters for passing an evaluation. */
  why: string;
  /** Roughly how long one attempt takes, in seconds. */
  seconds: number;
  /** Does the drill need live market data? */
  needsMarket: boolean;
};

export const DRILLS: DrillMeta[] = [
  {
    id: "bias",
    kind: "BIAS",
    title: "方向判讀",
    skill: "READ",
    blurb: "看結構決定方向，並標示信心程度。",
    why: "不是猜下一根，而是判斷未來一段行情會先走到 +1 ATR 還是 −1 ATR。同一根同時觸及一律判定不利，跟真實停損一樣殘酷。",
    seconds: 45,
    needsMarket: true,
  },
  {
    id: "sizing",
    kind: "SIZING",
    title: "部位計算",
    skill: "SIZING",
    blurb: "把帳戶狀態與停損距離換算成合規口數。",
    why: "考試帳戶最常見的死法：口數用感覺決定。這題只有一個正確答案，而且會把手續費與剩餘限額一起算進去。",
    seconds: 60,
    needsMarket: false,
  },
  {
    id: "stop",
    kind: "STOP",
    title: "停損放置",
    skill: "READ",
    blurb: "決定這筆交易的無效化價位。",
    why: "停損放在雜訊裡會被反覆掃掉，放太寬又讓部位小到沒意義。只評下單前判斷得出來的東西，不評事後運氣；沒達標會直接告訴你建議位置。",
    seconds: 50,
    needsMarket: true,
  },
  {
    id: "exit",
    kind: "EXIT",
    title: "出場管理",
    skill: "READ",
    blurb: "逐根管理一筆已進場的部位。",
    why: "拿到的 R 倍數會跟這段行情理論最佳 R 相比。抱不住與抱太久，兩邊都扣分。",
    seconds: 90,
    needsMarket: true,
  },
  {
    id: "rule-guard",
    kind: "RULE_GUARD",
    title: "規則守門",
    skill: "SIZING",
    blurb: "在限額壓力下選出唯一不違規的動作。",
    why: "這是通過考試最直接相關的能力，也是市面上沒有人在練的一項。所有數字都由規則引擎即時算出，不是背答案。",
    seconds: 60,
    needsMarket: false,
  },
  {
    id: "tilt",
    kind: "TILT",
    title: "情緒控制",
    skill: "DISCIPLINE",
    blurb: "連續虧損之後，下一步該做什麼。",
    why: "連虧加碼是最常見的爆倉路徑。這題訓練的是把停機變成規則，而不是靠意志力。",
    seconds: 40,
    needsMarket: false,
  },
];

export function getDrill(id: string): DrillMeta {
  return DRILLS.find((drill) => drill.id === id) ?? DRILLS[0];
}

// ---------------------------------------------------------------------------
// Scenario shapes
// ---------------------------------------------------------------------------

export type MarketContext = {
  symbol: string;
  interval: Interval;
  /** Context bars plus hidden bars. Reveal only `visibleCount` to the learner. */
  candles: Candle[];
  visibleCount: number;
  structure: StructureRead;
  atr: number;
};

export type BiasScenario = MarketContext & {
  kind: "BIAS";
  id: string;
  seed: string;
  horizon: number;
};

export type SizingScenario = {
  kind: "SIZING";
  id: string;
  seed: string;
  rules: RuleSet;
  account: AccountState;
  symbol: string;
  side: Side;
  entry: number;
  stop: number;
  /** The risk budget the learner is told to work to. */
  riskPct: number;
  /** Narrative describing the account situation. */
  situation: string;
};

export type StopScenario = MarketContext & {
  kind: "STOP";
  id: string;
  seed: string;
  side: Side;
  entry: number;
  horizon: number;
};

export type ExitScenario = MarketContext & {
  kind: "EXIT";
  id: string;
  seed: string;
  side: Side;
  entry: number;
  stop: number;
  horizon: number;
};

export type ChoiceOption = { id: string; label: string; detail: string };

export type ChoiceScenario = {
  kind: "RULE_GUARD" | "TILT";
  id: string;
  seed: string;
  rules: RuleSet;
  account: AccountState;
  /** Live numbers the learner must reason from. */
  situation: string;
  question: string;
  options: ChoiceOption[];
  correctId: string;
  explanation: string;
};

export type Scenario = BiasScenario | SizingScenario | StopScenario | ExitScenario | ChoiceScenario;

export type Grade = {
  score: number;
  /** Headline verdict. */
  verdict: string;
  /** Itemised breakdown, each worth part of the score. */
  breakdown: Array<{ label: string; points: number; max: number; note: string }>;
  /** The teaching point. */
  lesson: string;
  /**
   * What a good answer looked like. Shown when the learner falls short —
   * being told only that you scored 62 teaches nothing about where to aim.
   */
  suggestion?: { label: string; value: string; why: string };
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round = (value: number) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------
// Market scenario slicing
// ---------------------------------------------------------------------------

const CONTEXT_BARS = 60;

/**
 * Pick a random window from a candle series, leaving `horizon` bars hidden.
 * Windows whose context is flat-lined are rejected: a drill with no structure
 * to read teaches nothing.
 */
export function sliceWindow(
  candles: Candle[],
  rng: Rng,
  horizon: number,
  contextBars = CONTEXT_BARS,
): { candles: Candle[]; visibleCount: number; anchorIndex: number } | null {
  const need = contextBars + horizon;
  if (candles.length < need + 5) return null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const start = randInt(rng, 0, candles.length - need - 1);
    const window = candles.slice(start, start + need);
    const anchor = contextBars - 1;
    const range = atr(window, anchor);
    const price = window[anchor].close;
    if (!price || !range) continue;
    // Require a live-enough tape: ATR at least 0.15% of price.
    if (range / price < 0.0015) continue;
    return { candles: window, visibleCount: contextBars, anchorIndex: anchor };
  }
  const window = candles.slice(-need);
  return window.length === need
    ? { candles: window, visibleCount: contextBars, anchorIndex: contextBars - 1 }
    : null;
}

// ---------------------------------------------------------------------------
// BIAS
// ---------------------------------------------------------------------------

export function generateBias(
  seed: string,
  symbol: string,
  interval: Interval,
  candles: Candle[],
  horizon = 12,
): BiasScenario | null {
  const rng = createRng(seed);
  const slice = sliceWindow(candles, rng, horizon);
  if (!slice) return null;
  return {
    kind: "BIAS",
    id: "bias",
    seed,
    symbol,
    interval,
    candles: slice.candles,
    visibleCount: slice.visibleCount,
    horizon,
    structure: readStructure(slice.candles, slice.anchorIndex),
    atr: atr(slice.candles, slice.anchorIndex),
  };
}

export type BiasAnswer = { choice: Side | "SKIP"; confidence: 1 | 2 | 3 };

/** What the tape actually did, resolved path-aware and pessimistically. */
export function biasTruth(scenario: BiasScenario): { answer: Side | "SKIP"; outcome: ReturnType<typeof forwardOutcome> } {
  const anchor = scenario.visibleCount - 1;
  const asLong = forwardOutcome(scenario.candles, anchor, scenario.horizon, "LONG", 1);
  if (asLong.resolvedFirst === "FAVOURABLE") return { answer: "LONG", outcome: asLong };
  if (asLong.resolvedFirst === "ADVERSE") return { answer: "SHORT", outcome: asLong };
  return { answer: "SKIP", outcome: asLong };
}

export function gradeBias(scenario: BiasScenario, answer: BiasAnswer): Grade {
  const { answer: truth, outcome } = biasTruth(scenario);
  const correct = answer.choice === truth;
  const tookChop = truth === "SKIP" && answer.choice !== "SKIP";
  const missedMove = truth !== "SKIP" && answer.choice === "SKIP";

  // Baselines leave headroom below them so the calibration term below stays
  // visible instead of being swallowed by the 0 floor.
  let directionPoints: number;
  let note: string;
  if (correct && truth === "SKIP") {
    directionPoints = 70;
    note = "行情在這段時間內沒有走出 1 ATR 的單邊，選擇不參與是正確的。";
  } else if (correct) {
    directionPoints = 70;
    note = `價格先走到 ${truth} 方向的 +1 ATR（最大順向 ${outcome.favourableAtr.toFixed(2)} ATR）。`;
  } else if (missedMove) {
    directionPoints = 34;
    note = `行情確實走出了 ${truth} 方向的單邊，你錯過了，但沒有虧錢。`;
  } else if (tookChop) {
    directionPoints = 24;
    note = "這段是震盪，兩邊都沒有走出 1 ATR。在這種行情進場是手續費與情緒的雙重消耗。";
  } else {
    directionPoints = 18;
    note = `方向相反：價格先走到 ${truth} 方向的 +1 ATR。這是唯一一種會真的讓你虧錢的錯誤。`;
  }

  // Confidence calibration: being loudly wrong costs more than being quietly
  // wrong, because the loud calls are the ones you size up.
  const calibration = correct ? (answer.confidence - 1) * 15 : -(answer.confidence - 1) * 9;
  const calibrationNote = correct
    ? answer.confidence === 3
      ? "高信心且判斷正確，這是可以放大部位的情境。"
      : "判斷正確但信心保守，長期會少拿到報酬。"
    : answer.confidence === 3
      ? "高信心卻判斷錯誤，這種交易通常也是部位下最大的那一筆，代價最高。"
      : "信心低且判斷錯誤，至少沒有在錯誤的方向上加碼。";

  const score = clamp(directionPoints + calibration, 0, 100);
  return {
    score,
    verdict: correct ? "判讀正確" : missedMove ? "過度保守" : "判讀錯誤",
    breakdown: [
      { label: "方向判讀", points: directionPoints, max: 70, note },
      { label: "信心校準", points: calibration, max: 30, note: calibrationNote },
    ],
    lesson:
      `結構讀數：${scenario.structure.bias === "UPTREND" ? "上升結構" : scenario.structure.bias === "DOWNTREND" ? "下降結構" : "區間"}` +
      `（強度 ${(scenario.structure.strength * 100).toFixed(0)}%）。` +
      `實際結果：順向最大 ${outcome.favourableAtr.toFixed(2)} ATR、逆向最大 ${outcome.adverseAtr.toFixed(2)} ATR。` +
      "在真實考試中，逆向擴張才是決定你會不會被掃損的變數，不是最終收在哪裡。",
  };
}

// ---------------------------------------------------------------------------
// SIZING
// ---------------------------------------------------------------------------

/** Build a plausible mid-evaluation account for the maths drills. */
export function syntheticAccount(
  rules: RuleSet,
  options: {
    equity: number;
    dayStartEquity: number;
    peakEquity?: number;
    peakEodBalance?: number;
    dayIndex: number;
    /** P&L of each completed day, oldest first. */
    dayPnls?: number[];
  },
): AccountState {
  const base = createAccount(rules);
  const dayPnls = options.dayPnls ?? [];
  const days: DaySummary[] = [];
  const trades: ClosedTrade[] = [];
  let running = rules.initialBalance;
  dayPnls.forEach((pnl, index) => {
    const start = running;
    running += pnl;
    days.push({
      dayIndex: index,
      startedAt: index * 86_400_000,
      startEquity: start,
      endEquity: running,
      lowEquity: Math.min(start, running),
      highEquity: Math.max(start, running),
      pnl,
      trades: 1,
      fees: 0,
    });
    trades.push({
      id: `synthetic-${index}`,
      side: "LONG",
      entry: 100,
      exit: 100,
      qty: 0,
      leverage: 1,
      initialStop: 99,
      plannedRiskUsd: Math.abs(pnl) || 1,
      equityAtOpen: start,
      bindingRoomAtOpen: Number.POSITIVE_INFINITY,
      openedAt: index * 86_400_000,
      closedAt: index * 86_400_000,
      openedIndex: 0,
      closedIndex: 1,
      holdBars: 1,
      reason: "MANUAL",
      grossPnl: pnl,
      fees: 0,
      funding: 0,
      pnl,
      rMultiple: pnl >= 0 ? 1 : -1,
      mfeR: 1,
      maeR: 1,
      stopMoves: 0,
      stopWidenings: 0,
      dayIndex: index,
      tags: ["synthetic"],
    });
  });

  return {
    ...base,
    balance: options.equity,
    days,
    trades,
    dayIndex: options.dayIndex,
    dayStartEquity: options.dayStartEquity,
    dayStartBalance: options.dayStartEquity,
    dayLowEquity: Math.min(options.dayStartEquity, options.equity),
    dayHighEquity: Math.max(options.dayStartEquity, options.equity),
    peakEquity: options.peakEquity ?? Math.max(rules.initialBalance, options.equity, options.dayStartEquity),
    peakEodBalance: options.peakEodBalance ?? Math.max(rules.initialBalance, options.dayStartEquity),
  };
}

const SIZING_SYMBOLS: Array<{ symbol: string; price: number }> = [
  { symbol: "BTCUSDT", price: 64000 },
  { symbol: "ETHUSDT", price: 3100 },
  { symbol: "SOLUSDT", price: 148 },
  { symbol: "BNBUSDT", price: 570 },
  { symbol: "LINKUSDT", price: 14.2 },
  { symbol: "ARBUSDT", price: 0.82 },
];

export function generateSizing(seed: string, ruleSetId?: string): SizingScenario {
  const rng = createRng(seed);
  const rules = getRuleSet(ruleSetId ?? pick(rng, ["bootcamp-1k", "crypto-2step-p1", "crypto-1step-trailing"]));

  // Put the account somewhere between -3% and +6%, mid-day, with some history.
  const drift = (rng() * 0.09 - 0.03) * rules.initialBalance;
  const dayIndex = randInt(rng, 0, 4);
  const dayPnls = Array.from({ length: dayIndex }, () => (rng() * 0.03 - 0.01) * rules.initialBalance);
  const dayStartEquity = rules.initialBalance + dayPnls.reduce((sum, value) => sum + value, 0);
  const intradayPnl = (rng() * 0.05 - 0.035) * rules.initialBalance;
  const equity = dayStartEquity + intradayPnl;

  const account = syntheticAccount(rules, {
    equity,
    dayStartEquity,
    dayIndex,
    dayPnls,
    peakEquity: Math.max(rules.initialBalance, dayStartEquity + Math.abs(drift)),
  });

  const market = pick(rng, SIZING_SYMBOLS);
  const jitter = 1 + (rng() - 0.5) * 0.08;
  const entry = round(market.price * jitter);
  const side: Side = rng() > 0.5 ? "LONG" : "SHORT";
  const stopPct = 0.004 + rng() * 0.016; // 0.4% .. 2.0%
  const stop = round(side === "LONG" ? entry * (1 - stopPct) : entry * (1 + stopPct));
  const riskPct = pick(rng, [0.005, 0.0075, 0.01]);

  const metrics = evaluate(account, equity);
  const situation =
    `${rules.label}｜第 ${dayIndex + 1} 個交易日。` +
    `帳戶權益 ${equity.toFixed(2)} U（起始 ${rules.initialBalance.toLocaleString()} U）。` +
    `今日開盤權益 ${dayStartEquity.toFixed(2)} U，目前當日${intradayPnl >= 0 ? "獲利" : "虧損"} ${Math.abs(intradayPnl).toFixed(2)} U。` +
    `距離日虧損上限還有 ${metrics.dailyRoom.toFixed(2)} U，距離最大回撤死亡線還有 ${metrics.drawdownRoom.toFixed(2)} U。`;

  return {
    kind: "SIZING",
    id: "sizing",
    seed,
    rules,
    account,
    symbol: market.symbol,
    side,
    entry,
    stop,
    riskPct,
    situation,
  };
}

export type SizingAnswer = { qty: number };

/**
 * The correct size is the *smaller* of the planned-risk size and the size that
 * keeps a single loss below a third of the remaining limit room. Learners who
 * only compute the first number blow up in the last week of an evaluation.
 */
export function sizingTruth(scenario: SizingScenario): {
  qty: number;
  riskUsd: number;
  cappedByRoom: boolean;
  ideal: ReturnType<typeof sizePosition>;
  defensible: ReturnType<typeof maxDefensibleRisk>;
} {
  const metrics = evaluate(scenario.account, scenario.account.balance);
  const ideal = sizePosition({
    equity: metrics.equity,
    riskPct: scenario.riskPct,
    entry: scenario.entry,
    stop: scenario.stop,
    side: scenario.side,
    rules: scenario.rules,
  });
  const defensible = maxDefensibleRisk(metrics, scenario.riskPct);
  const capped = defensible.riskUsd < ideal.riskUsd - 1e-9;
  const effective = capped
    ? sizePosition({
        equity: metrics.equity,
        riskPct: defensible.riskPct,
        entry: scenario.entry,
        stop: scenario.stop,
        side: scenario.side,
        rules: scenario.rules,
      })
    : ideal;
  return { qty: effective.qty, riskUsd: effective.riskUsd, cappedByRoom: capped, ideal, defensible };
}

export function gradeSizing(scenario: SizingScenario, answer: SizingAnswer): Grade {
  const truth = sizingTruth(scenario);
  if (truth.qty <= 0) {
    return {
      score: answer.qty <= 0 ? 100 : 0,
      verdict: answer.qty <= 0 ? "正確：這筆單不該下" : "錯誤：這筆單不該下",
      breakdown: [{ label: "是否該交易", points: answer.qty <= 0 ? 100 : 0, max: 100, note: "剩餘限額空間已經不足以承擔任何一筆合規的風險。" }],
      lesson: "當剩餘空間小於一筆單的風險，正確答案是零口數。停手也是一種部位管理。",
    };
  }

  const ratio = answer.qty / truth.qty;
  // Asymmetric: under-sizing by 30% zeroes out, over-sizing by 15% zeroes out.
  const accuracy =
    ratio <= 1
      ? 100 * Math.max(0, 1 - (1 - ratio) / 0.3)
      : 100 * Math.max(0, 1 - (ratio - 1) / 0.15);

  const impliedRisk = Math.abs(scenario.entry - scenario.stop) * answer.qty +
    (scenario.entry + scenario.stop) * answer.qty * scenario.rules.takerFee;
  const metrics = evaluate(scenario.account, scenario.account.balance);

  const breakdown = [
    {
      label: "口數精確度",
      points: Math.round(accuracy * 0.75),
      max: 75,
      note:
        `正解 ${truth.qty.toFixed(4)} 口（風險 ${truth.riskUsd.toFixed(2)} U）。你的答案 ${answer.qty.toFixed(4)} 口 ` +
        `＝ 正解的 ${(ratio * 100).toFixed(0)}%，實際風險 ${impliedRisk.toFixed(2)} U。`,
    },
  ];

  // Relative, not absolute. When the room cap binds, the correct answer sits
  // exactly on this boundary, so an absolute 1e-6 slack meant a learner typing
  // a rounded decimal lost all 25 points for the right answer — capping the
  // score at 75 and making those questions impossible to master.
  const perTradeCap = metrics.bindingRoom / 3;
  const safe = impliedRisk <= perTradeCap * 1.01 + 1e-9;
  breakdown.push({
    label: "限額安全性",
    points: safe ? 25 : ratio > 1 ? 0 : 12,
    max: 25,
    note: safe
      ? `這個部位的風險不超過剩餘空間（${metrics.bindingRoom.toFixed(2)} U）的三分之一，虧了還能再交易。`
      : `風險 ${impliedRisk.toFixed(2)} U 超過剩餘空間 ${metrics.bindingRoom.toFixed(2)} U 的三分之一，這筆單一旦虧損就會把帳戶推到懸崖邊。`,
  });

  const score = clamp(breakdown.reduce((sum, item) => sum + item.points, 0), 0, 100);
  return {
    score,
    verdict: score >= 85 ? "計算正確" : ratio > 1.1 ? "部位過大" : score >= 60 ? "接近正解" : "計算偏差過大",
    breakdown,
    lesson:
      `公式：口數 =　風險金額 ÷（停損距離 + 進出手續費）。` +
      `本題風險金額 ${(metrics.equity * scenario.riskPct).toFixed(2)} U、停損距離 ${Math.abs(scenario.entry - scenario.stop).toFixed(4)}。` +
      (truth.cappedByRoom
        ? `　注意：本題的正解被「剩餘限額」壓低了——依 ${(scenario.riskPct * 100).toFixed(2)}% 計畫風險本來可以下更大，` +
          `但剩餘空間只有 ${metrics.bindingRoom.toFixed(2)} U（受限於${metrics.bindingConstraint === "DAILY" ? "當日虧損上限" : "最大回撤"}），必須縮小。`
        : "　本題剩餘空間充足，計畫風險就是正解。"),
  };
}

// ---------------------------------------------------------------------------
// STOP
// ---------------------------------------------------------------------------

export function generateStop(
  seed: string,
  symbol: string,
  interval: Interval,
  candles: Candle[],
  horizon = 20,
): StopScenario | null {
  const rng = createRng(seed);
  const slice = sliceWindow(candles, rng, horizon);
  if (!slice) return null;
  const anchor = slice.visibleCount - 1;
  const structure = readStructure(slice.candles, anchor);
  const side: Side = structure.bias === "DOWNTREND" ? "SHORT" : structure.bias === "UPTREND" ? "LONG" : rng() > 0.5 ? "LONG" : "SHORT";
  return {
    kind: "STOP",
    id: "stop",
    seed,
    symbol,
    interval,
    candles: slice.candles,
    visibleCount: slice.visibleCount,
    structure,
    atr: atr(slice.candles, anchor),
    side,
    entry: slice.candles[anchor].close,
    horizon,
  };
}

export type StopAnswer = { stop: number };

/**
 * The largest single-bar move against `side` in the recent visible window,
 * in ATR. This is the noise a stop has to clear, and crucially it is
 * observable at the moment of the decision — unlike whether the stop was
 * actually swept, which is an outcome the learner cannot influence.
 */
export function observableNoise(scenario: StopScenario, lookback = 20): number {
  const anchor = scenario.visibleCount - 1;
  const range = scenario.atr || 1e-9;
  let worst = 0;
  for (let index = Math.max(1, anchor - lookback + 1); index <= anchor; index += 1) {
    const candle = scenario.candles[index];
    const adverse =
      scenario.side === "LONG" ? candle.close - candle.low : candle.high - candle.close;
    worst = Math.max(worst, adverse / range);
  }
  return worst;
}

/** Nearest swing level the stop should sit behind, if the window has one. */
export function invalidationLevel(scenario: StopScenario): number | undefined {
  const window = scenario.candles.slice(0, scenario.visibleCount);
  const points = swingPoints(window, 2);
  return scenario.side === "LONG"
    ? points.filter((p) => p.kind === "LOW" && p.price < scenario.entry).map((p) => p.price).sort((a, b) => b - a)[0]
    : points.filter((p) => p.kind === "HIGH" && p.price > scenario.entry).map((p) => p.price).sort((a, b) => a - b)[0];
}

/**
 * A defensible stop for this setup: behind the nearest invalidation level with
 * a small buffer, otherwise just clear of the observable noise — then clamped
 * into the range where the position size still means something.
 */
export function suggestStop(scenario: StopScenario): { price: number; atrUnits: number; why: string } {
  const direction = scenario.side === "LONG" ? -1 : 1;
  const reference = invalidationLevel(scenario);
  const noise = observableNoise(scenario);
  // Clearing the noise is non-negotiable — a stop inside it is not a stop.
  // The margin is deliberately above the 1.15 the grader wants, so the
  // suggestion does not land exactly on its own threshold and lose points to
  // floating-point rounding.
  const floor = Math.max(0.8, noise * 1.25);

  let atrUnits: number;
  let why: string;
  if (reference !== undefined) {
    const beyond = Math.abs(scenario.entry - reference) / scenario.atr + 0.25;
    atrUnits = clamp(Math.max(beyond, floor), floor, 3);
    why =
      `最近的結構${scenario.side === "LONG" ? "低點" : "高點"}在 ${reference.toFixed(4)}，` +
      `放在它之外約 0.25 ATR；同時至少要蓋過近期單根最大逆向影線 ${noise.toFixed(2)} ATR。`;
  } else {
    atrUnits = clamp(floor, 0.8, 3);
    why = `這段沒有明顯的結構點，改用波動判斷：近期單根最大逆向影線 ${noise.toFixed(2)} ATR，留 25% 緩衝。`;
  }
  return { price: scenario.entry + direction * scenario.atr * atrUnits, atrUnits, why };
}

/**
 * Grading is on the decision, not the outcome.
 *
 * An earlier version put 40 of 100 points on whether the stop was actually
 * swept. Across a sample of 120 generated scenarios that made the *best
 * achievable* score fall below the 80 mastery threshold on 38% of them: the
 * learner could pick the single best stop on the slider and still be unable to
 * pass, because the tape had already decided. That is the same luck-scoring
 * mistake the bias drill deliberately avoids.
 *
 * What is scored now is knowable before the candle prints: is the stop behind
 * a real invalidation level, does it clear the noise this market has recently
 * been producing, and is it tight enough for the position to be worth taking.
 * What actually happened is reported as feedback instead.
 */
export function gradeStop(scenario: StopScenario, answer: StopAnswer): Grade {
  const anchor = scenario.visibleCount - 1;
  const long = scenario.side === "LONG";
  const distance = Math.abs(scenario.entry - answer.stop);
  const atrUnits = scenario.atr ? distance / scenario.atr : 0;
  const suggested = suggestStop(scenario);

  const wrongSide = long ? answer.stop >= scenario.entry : answer.stop <= scenario.entry;
  if (wrongSide || distance <= 0) {
    return {
      score: 0,
      verdict: "停損方向錯誤",
      breakdown: [{ label: "有效性", points: 0, max: 100, note: "停損必須放在進場價的不利側。" }],
      lesson: "做多的停損在下方，做空的停損在上方。這一步錯，後面的部位計算全部無效。",
      suggestion: {
        label: "建議停損",
        value: `${suggested.price.toFixed(4)}（${suggested.atrUnits.toFixed(2)} ATR）`,
        why: suggested.why,
      },
    };
  }

  // Scored against the stop that reconciles all three pressures, so a perfect
  // score is always reachable. Grading each pressure independently made them
  // mutually unsatisfiable whenever the nearest structure sat inside the noise
  // band — the learner could not win no matter what they picked.
  const reference = invalidationLevel(scenario);
  const drift = Math.abs(atrUnits - suggested.atrUnits) / Math.max(suggested.atrUnits, 1e-9);
  const placementPoints = Math.round(clamp(1 - Math.max(0, drift - 0.25) / 0.75, 0, 1) * 70);
  const placementNote =
    drift <= 0.25
      ? `${atrUnits.toFixed(2)} ATR，落在這個設定的合理區間內。`
      : `${atrUnits.toFixed(2)} ATR，離合理位置 ${suggested.atrUnits.toFixed(2)} ATR 偏離 ${(drift * 100).toFixed(0)}%。` +
        (atrUnits < suggested.atrUnits
          ? reference !== undefined
            ? `太近了——結構${long ? "低點" : "高點"}在 ${reference.toFixed(4)}，停在它之內等於自願被掃。`
            : "太近了，還在近期波動範圍內。"
          : "太遠了，同樣的風險金額只能換到很小的部位。");

  const noise = observableNoise(scenario);
  const clearance = noise > 0 ? atrUnits / noise : 2;
  let noisePoints: number;
  let noiseNote: string;
  if (clearance >= 1.15) {
    noisePoints = 30;
    noiseNote = `近期單根最大逆向影線 ${noise.toFixed(2)} ATR，你的停損在它之外，不會被一般波動掃到。`;
  } else if (clearance >= 0.85) {
    noisePoints = 17;
    noiseNote = `停損幾乎貼著近期最大逆向影線 ${noise.toFixed(2)} ATR，容錯很小。`;
  } else {
    noisePoints = Math.round(clamp(clearance / 0.85, 0, 1) * 10);
    noiseNote = `停損落在近期雜訊範圍（單根最大逆向 ${noise.toFixed(2)} ATR）之內，被掃只是時間問題。`;
  }

  // What actually happened — reported, not scored. ---------------------------
  const end = Math.min(scenario.candles.length - 1, anchor + scenario.horizon);
  const target = long ? scenario.entry + scenario.atr * 1.5 : scenario.entry - scenario.atr * 1.5;
  let sweptAt: number | null = null;
  let reachedTarget = false;
  for (let index = anchor + 1; index <= end; index += 1) {
    const candle = scenario.candles[index];
    const stopped = long ? candle.low <= answer.stop : candle.high >= answer.stop;
    const hitTarget = long ? candle.high >= target : candle.low <= target;
    if (stopped && sweptAt === null) sweptAt = index;
    if (hitTarget && sweptAt === null) { reachedTarget = true; break; }
    if (stopped) break;
  }
  const outcome = reachedTarget
    ? "後續發展：沒有被掃到，價格走到了 +1.5 ATR。"
    : sweptAt === null
      ? "後續發展：沒有被掃到，但行情也沒走到目標。"
      : `後續發展：第 ${sweptAt - anchor} 根 K 線觸發了這個停損。`;

  const score = clamp(placementPoints + noisePoints, 0, 100);
  const grade: Grade = {
    score,
    verdict: score >= 80 ? "位置良好" : score >= 55 ? "可用但不理想" : "位置有問題",
    breakdown: [
      { label: "位置", points: placementPoints, max: 70, note: placementNote },
      { label: "抗雜訊", points: noisePoints, max: 30, note: noiseNote },
    ],
    lesson:
      "好的停損要同時放在「到這裡我就看錯了」的結構之外，而且遠到不會被這個市場的日常波動掃到——" +
      "但又不能遠到部位小得沒有意義。這些在下單前全都判斷得出來。" +
      `事後有沒有被掃到不列入評分，因為那不是你當下能決定的事。${outcome}`,
  };
  if (score < 80) {
    grade.suggestion = {
      label: "建議停損",
      value: `${suggested.price.toFixed(4)}（${suggested.atrUnits.toFixed(2)} ATR）`,
      why: suggested.why,
    };
  }
  return grade;
}

// ---------------------------------------------------------------------------
// EXIT
// ---------------------------------------------------------------------------

export function generateExit(
  seed: string,
  symbol: string,
  interval: Interval,
  candles: Candle[],
  horizon = 24,
): ExitScenario | null {
  const rng = createRng(seed);
  const slice = sliceWindow(candles, rng, horizon);
  if (!slice) return null;
  const anchor = slice.visibleCount - 1;
  const structure = readStructure(slice.candles, anchor);
  const range = atr(slice.candles, anchor);
  const side: Side = structure.bias === "DOWNTREND" ? "SHORT" : "LONG";
  const entry = slice.candles[anchor].close;
  return {
    kind: "EXIT",
    id: "exit",
    seed,
    symbol,
    interval,
    candles: slice.candles,
    visibleCount: slice.visibleCount,
    structure,
    atr: range,
    side,
    entry,
    stop: side === "LONG" ? entry - range * 1.2 : entry + range * 1.2,
    horizon,
  };
}

export type ExitAnswer = {
  /** Index within the scenario's candle array at which the learner closed. */
  closedIndex: number;
  /** Realised R at that exit, computed by the runner. */
  realisedR: number;
  /** Whether the exit was a stop-out rather than a decision. */
  stoppedOut: boolean;
};

/** Best R that was actually available in the window, and where it peaked. */
export function exitBest(scenario: ExitScenario): { bestR: number; atIndex: number } {
  const anchor = scenario.visibleCount - 1;
  const risk = Math.abs(scenario.entry - scenario.stop);
  const long = scenario.side === "LONG";
  let bestR = 0;
  let atIndex = anchor;
  for (let index = anchor + 1; index < scenario.candles.length; index += 1) {
    const candle = scenario.candles[index];
    // Once the stop is hit the run is over; nothing beyond it was reachable.
    if (long ? candle.low <= scenario.stop : candle.high >= scenario.stop) break;
    const excursion = long ? candle.high - scenario.entry : scenario.entry - candle.low;
    const r = excursion / risk;
    if (r > bestR) { bestR = r; atIndex = index; }
  }
  return { bestR: round(bestR), atIndex };
}

export function gradeExit(scenario: ExitScenario, answer: ExitAnswer): Grade {
  const { bestR, atIndex } = exitBest(scenario);
  const anchor = scenario.visibleCount - 1;
  const captured = bestR > 0 ? clamp(answer.realisedR / bestR, -1, 1) : 0;

  let capturePoints: number;
  let captureNote: string;
  if (bestR < 0.4) {
    // The trade never worked. The skill on show is losing small.
    capturePoints = Math.round(clamp(1 + answer.realisedR, 0, 1) * 70);
    captureNote = answer.realisedR > -0.5
      ? `這段行情最多只給了 ${bestR.toFixed(2)}R，本來就不是一筆好交易。你只賠了 ${answer.realisedR.toFixed(2)}R，控制得不錯。`
      : `這段行情最多只給了 ${bestR.toFixed(2)}R，而你賠掉 ${Math.abs(answer.realisedR).toFixed(2)}R。行情不動的時候，早點承認並離場。`;
  } else {
    capturePoints = Math.round(clamp(captured, 0, 1) * 70);
    captureNote = `這段行情最高給到 ${bestR.toFixed(2)}R（第 ${atIndex - anchor} 根），你拿到 ${answer.realisedR.toFixed(2)}R，擷取率 ${(captured * 100).toFixed(0)}%。`;
  }

  // Holding to a stop-out after being deep in profit is the expensive mistake.
  const gaveBack = bestR >= 1.5 && answer.realisedR <= 0;
  const timingPoints = gaveBack ? 0 : answer.stoppedOut && bestR >= 1 ? 10 : 30;
  const timingNote = gaveBack
    ? `曾經浮盈 ${bestR.toFixed(2)}R 卻讓它變成虧損。浮盈超過 1R 之後把停損移到成本價，是最便宜的保險。`
    : answer.stoppedOut && bestR >= 1
      ? "被停損出場，但這段行情確實給過機會。考慮用分批出場或移動停損鎖住一部分。"
      : "出場時機合理。";

  const score = clamp(capturePoints + timingPoints, 0, 100);
  return {
    score,
    verdict: score >= 80 ? "管理良好" : score >= 55 ? "尚可" : gaveBack ? "獲利回吐" : "管理不佳",
    breakdown: [
      { label: "報酬擷取", points: capturePoints, max: 70, note: captureNote },
      { label: "出場時機", points: timingPoints, max: 30, note: timingNote },
    ],
    lesson:
      "出場的目標不是抓到最高點，是穩定拿到這段行情的一大部分。" +
      "能長期做到 50–70% 擷取率、而且從不讓 1R 以上的浮盈變成虧損，就足以通過大多數考試。",
  };
}

// ---------------------------------------------------------------------------
// RULE_GUARD and TILT (choice drills)
// ---------------------------------------------------------------------------

type ChoiceTemplate = (rng: Rng) => ChoiceScenario | null;

function money(value: number): string {
  return `${value.toFixed(2)} U`;
}

function buildChoice(
  kind: "RULE_GUARD" | "TILT",
  seed: string,
  rules: RuleSet,
  account: AccountState,
  parts: { situation: string; question: string; options: ChoiceOption[]; correctId: string; explanation: string },
): ChoiceScenario {
  return { kind, id: kind === "RULE_GUARD" ? "rule-guard" : "tilt", seed, rules, account, ...parts };
}

/** Templates compute every number from the live rule engine, never hardcoded. */
function ruleGuardTemplates(seed: string): ChoiceTemplate[] {
  return [
    // 1. Almost out of daily room.
    (rng) => {
      const rules = getRuleSet(pick(rng, ["crypto-2step-p1", "bootcamp-1k", "crypto-instant-5k"]));
      const dayStartEquity = rules.initialBalance * (1 + (rng() * 0.04 - 0.01));
      const allowance = dayStartEquity * rules.maxDailyLoss;
      // Leave between 1.0 and 1.6 planned risks of room.
      const riskPct = 0.01;
      const plannedRisk = dayStartEquity * riskPct;
      const room = plannedRisk * (1 + rng() * 0.6);
      const equity = dayStartEquity - (allowance - room);
      const account = syntheticAccount(rules, { equity, dayStartEquity, dayIndex: randInt(rng, 1, 4), dayPnls: [] });
      const metrics = evaluate(account, equity);
      return buildChoice("RULE_GUARD", seed, rules, account, {
        situation:
          `${rules.label}。今日開盤權益 ${money(dayStartEquity)}，目前 ${money(equity)}。` +
          `當日虧損上限為 ${money(allowance)}，你已用掉 ${money(metrics.dailyLossUsed)}，` +
          `剩下 ${money(metrics.dailyRoom)}。你計畫的單筆風險是 ${money(plannedRisk)}（帳戶的 1%）。`,
        question: "現在出現一個你很有把握的設定。你該怎麼做？",
        options: [
          { id: "a", label: "照原計畫進場", detail: `風險 ${money(plannedRisk)}，佔剩餘空間的 ${((plannedRisk / metrics.dailyRoom) * 100).toFixed(0)}%。` },
          { id: "b", label: "把部位縮到剩餘空間的三分之一", detail: `風險降到 ${money(metrics.dailyRoom / 3)}，虧了還有兩次容錯。` },
          { id: "c", label: "加大部位把今天賺回來", detail: "既然有把握，用兩倍風險一次補回當日虧損。" },
          { id: "d", label: "取消停損以避免被掃出場", detail: "設定有把握，先不設停損，等它走出來。" },
        ],
        correctId: "b",
        explanation:
          `剩餘空間 ${money(metrics.dailyRoom)} 只能承受 ${Math.floor(metrics.dailyRoom / plannedRisk)} 筆滿額虧損。` +
          "在容錯少於三筆的時候照常下單，等於把帳戶押在單一交易上。正確做法是縮小到剩餘空間的三分之一，" +
          "或直接結束當日交易——明天的日限額會重置，但爆掉的帳戶不會。",
      });
    },

    // 2. Target hit but minimum trading days not met.
    (rng) => {
      const rules = getRuleSet(pick(rng, ["crypto-2step-p1", "crypto-instant-5k", "crypto-eod-trailing"]));
      if (!rules.minTradingDays) return null;
      const dayIndex = Math.max(0, rules.minTradingDays - 2);
      const target = rules.initialBalance * rules.profitTarget;
      const dayPnls = Array.from({ length: dayIndex }, () => target / Math.max(1, dayIndex));
      const dayStartEquity = rules.initialBalance + dayPnls.reduce((a, b) => a + b, 0);
      const equity = rules.initialBalance + target * 1.05;
      const account = syntheticAccount(rules, { equity, dayStartEquity, dayIndex, dayPnls });
      const metrics = evaluate(account, equity);
      return buildChoice("RULE_GUARD", seed, rules, account, {
        situation:
          `${rules.label}。你已經達到獲利目標：權益 ${money(equity)}，獲利 ${(metrics.profitPct * 100).toFixed(2)}%（目標 ${(rules.profitTarget * 100).toFixed(0)}%）。` +
          `但目前只交易了 ${metrics.tradingDays} 天，規則要求最少 ${rules.minTradingDays} 天。`,
        question: "接下來幾天你該怎麼操作？",
        options: [
          { id: "a", label: "照常交易直到天數達標", detail: "維持原本的部位大小，繼續找機會。" },
          { id: "b", label: "用最小部位開平單補足天數", detail: "每天做一筆風險極小的交易，只為滿足交易日條件。" },
          { id: "c", label: "停止交易，直接申請通過", detail: "獲利目標已經達成，天數應該可以通融。" },
          { id: "d", label: "加大部位多賺一些當緩衝", detail: "反正還要交易幾天，順便把獲利做厚。" },
        ],
        correctId: "b",
        explanation:
          "獲利目標已達成的那一刻，繼續承擔正常風險的期望報酬是零、風險是整個帳戶。" +
          "但天數條件不會通融，所以也不能停手。唯一理性的做法是把部位縮到最小，只為了讓天數計數器往前走。" +
          (rules.maxSingleDayProfitShare
            ? `　另外注意這個規則檔有一致性條款（單日不得超過總獲利的 ${(rules.maxSingleDayProfitShare * 100).toFixed(0)}%），小額交易同時也在稀釋單日佔比。`
            : ""),
      });
    },

    // 3. Consistency rule breached on paper.
    (rng) => {
      const rules = getRuleSet(pick(rng, ["crypto-2step-p1", "crypto-1step-trailing", "crypto-instant-5k"]));
      if (!rules.maxSingleDayProfitShare) return null;
      const target = rules.initialBalance * rules.profitTarget;
      const bigDay = target * 0.85;
      const dayPnls = [target * 0.05, bigDay, target * 0.1];
      const dayStartEquity = rules.initialBalance + dayPnls.reduce((a, b) => a + b, 0);
      const account = syntheticAccount(rules, { equity: dayStartEquity, dayStartEquity, dayIndex: dayPnls.length, dayPnls });
      const metrics = evaluate(account, dayStartEquity);
      return buildChoice("RULE_GUARD", seed, rules, account, {
        situation:
          `${rules.label}。權益 ${money(dayStartEquity)}，獲利已達 ${(metrics.profitPct * 100).toFixed(2)}%，超過 ${(rules.profitTarget * 100).toFixed(0)}% 的目標。` +
          `但其中一天就賺了 ${money(bigDay)}，佔總獲利的 ${(metrics.worstConsistencyShare * 100).toFixed(0)}%，` +
          `而一致性條款規定單日不得超過 ${(rules.maxSingleDayProfitShare * 100).toFixed(0)}%。`,
        question: "要讓這個帳戶真的通過，接下來該做什麼？",
        options: [
          { id: "a", label: "什麼都不做，等審核", detail: "獲利目標已達成，應該會過。" },
          { id: "b", label: "接下來幾天用小額穩定累積獲利", detail: "把總獲利做大，讓那一天的佔比降到門檻以下。" },
          { id: "c", label: "刻意虧掉一部分，降低那天的絕對金額", detail: "把獲利吐回去一些來平衡。" },
          { id: "d", label: "再做一個同樣大的獲利日", detail: "兩個大日子互相抵銷佔比。" },
        ],
        correctId: "b",
        explanation:
          `一致性條款看的是「最佳單日 ÷ 總獲利」。分母變大，比例就會下降；` +
          `目前需要總獲利至少 ${money(bigDay / rules.maxSingleDayProfitShare)} 才能讓那天降到門檻內，` +
          `也就是還要再累積約 ${money(Math.max(0, bigDay / rules.maxSingleDayProfitShare - dayPnls.reduce((a, b) => a + b, 0)))}。` +
          "刻意虧損會同時縮小分子與分母，比例反而可能上升；再做一個大日子則只是把問題換一天。",
      });
    },

    // 4. Trailing drawdown has moved up behind you.
    (rng) => {
      const rules = getRuleSet(pick(rng, ["crypto-1step-trailing", "crypto-instant-5k"]));
      const peak = rules.initialBalance * (1 + rules.profitTarget * (0.5 + rng() * 0.3));
      const equity = peak * (1 - rules.maxDrawdown * (0.45 + rng() * 0.25));
      const account = syntheticAccount(rules, {
        equity,
        dayStartEquity: peak,
        dayIndex: randInt(rng, 2, 6),
        dayPnls: [],
        peakEquity: peak,
      });
      const metrics = evaluate(account, equity);
      return buildChoice("RULE_GUARD", seed, rules, account, {
        situation:
          `${rules.label}（追蹤式回撤）。你的權益一度來到 ${money(peak)}，目前回落到 ${money(equity)}。` +
          `因為回撤線會跟著權益高點上移，現在的死亡線是 ${money(metrics.drawdownFloor)}，` +
          `你距離它只剩 ${money(metrics.drawdownRoom)}——而距離初始資金其實還有 ${money(equity - rules.initialBalance)} 的獲利。`,
        question: "這個狀況下最重要的認知是什麼？",
        options: [
          { id: "a", label: "還在獲利，所以風險不大", detail: "帳戶仍高於初始資金，離出局還遠。" },
          { id: "b", label: "可用空間已經縮小，必須按新的空間重算部位", detail: `依剩餘 ${money(metrics.drawdownRoom)} 重新計算單筆風險上限。` },
          { id: "c", label: "趕快把回撤賺回來，讓死亡線再往上", detail: "回到前高就能重新拉開距離。" },
          { id: "d", label: "回撤線只在收盤後才會更新，日內不用管", detail: "盤中波動不影響追蹤。" },
        ],
        correctId: "b",
        explanation:
          "追蹤式回撤的殘酷之處，在於「帳面還在賺錢」和「距離出局很近」可以同時成立。" +
          `你的實際可用空間是 ${money(metrics.drawdownRoom)}，不是 ${money(equity - rules.initialBalance)}。` +
          "部位大小必須依前者計算。想快點賺回來只會讓風險更集中；" +
          (rules.drawdownMode === "TRAILING_INTRADAY_EQUITY"
            ? "而且這個規則檔的回撤線追蹤盤中權益，連未實現獲利創新高都會把死亡線往上推。"
            : "而這個規則檔的回撤線在達到損益兩平前都會持續上移。"),
      });
    },

    // 5. Unrealized loss counts toward the limit.
    (rng) => {
      const rules = getRuleSet(pick(rng, ["crypto-2step-p1", "crypto-2step-p2", "crypto-instant-5k"]));
      if (!rules.includeUnrealized) return null;
      const dayStartEquity = rules.initialBalance * (1 + rng() * 0.03);
      const allowance = dayStartEquity * rules.maxDailyLoss;
      const unrealised = -allowance * (0.6 + rng() * 0.25);
      const equity = dayStartEquity + unrealised;
      const account = syntheticAccount(rules, { equity, dayStartEquity, dayIndex: randInt(rng, 1, 5), dayPnls: [] });
      const metrics = evaluate(account, equity);
      return buildChoice("RULE_GUARD", seed, rules, account, {
        situation:
          `${rules.label}。你手上有一筆未平倉部位，目前浮虧 ${money(Math.abs(unrealised))}。` +
          `帳戶已實現損益還是持平，但這個規則檔的損益上限「計入未實現損益」，` +
          `所以你的有效權益是 ${money(equity)}，距離當日上限只剩 ${money(metrics.dailyRoom)}。`,
        question: "你打算讓這筆單過夜。正確的判斷是？",
        options: [
          { id: "a", label: "沒平倉就不算虧，可以放著", detail: "只要不認賠，帳面就還沒定案。" },
          { id: "b", label: "縮減或平掉部位，把浮虧控制在剩餘空間之內", detail: `目前只要再往不利方向走 ${money(metrics.dailyRoom)} 就會違規。` },
          { id: "c", label: "加碼攤平降低平均成本", detail: "成本拉近一點，反彈就能解套。" },
          { id: "d", label: "把停損拉遠避免被掃到", detail: "先撐過這段波動再說。" },
        ],
        correctId: "b",
        explanation:
          "「沒平倉就不算虧」在計入未實現損益的規則檔下是致命誤解——系統看的是權益，不是你的心情。" +
          `再往不利方向 ${money(metrics.dailyRoom)}（約 ${((metrics.dailyRoom / equity) * 100).toFixed(2)}% 的帳戶波動）就會直接違規，` +
          "而且是在你睡覺、無法反應的時候。加碼攤平與拉遠停損都是把可能的損失放大，方向完全相反。",
      });
    },
  ];
}

function tiltTemplates(seed: string): ChoiceTemplate[] {
  return [
    (rng) => {
      const rules = getRuleSet(pick(rng, ["bootcamp-1k", "crypto-2step-p1"]));
      const losses = randInt(rng, 2, 3);
      const riskPct = 0.01;
      const lost = rules.initialBalance * riskPct * losses;
      const dayStartEquity = rules.initialBalance;
      const equity = dayStartEquity - lost;
      const account = syntheticAccount(rules, { equity, dayStartEquity, dayIndex: randInt(rng, 1, 4), dayPnls: [] });
      const metrics = evaluate(account, equity);
      return buildChoice("TILT", seed, rules, account, {
        situation:
          `你今天連續 ${losses} 筆虧損，每筆都是計畫中的 1%，合計 ${money(lost)}。` +
          `三筆都照計畫停損，執行沒有問題。目前距離當日上限還有 ${money(metrics.dailyRoom)}。`,
        question: "現在最正確的下一步是什麼？",
        options: [
          { id: "a", label: "結束當日交易，明天再來", detail: "連續虧損通常代表當下的行情特性與你的方法不合。" },
          { id: "b", label: "繼續照原計畫交易", detail: "既然執行沒問題，就是機率問題，繼續做。" },
          { id: "c", label: "加大部位，一筆賺回三筆", detail: "行情該回頭了，用三倍部位補回來。" },
          { id: "d", label: "換一個沒在看的幣種試手氣", detail: "換標的換運氣。" },
        ],
        correctId: "a",
        explanation:
          "選項 B 在數學上不算錯——執行正確的連虧確實可能只是機率。但在考試帳戶上，B 和 A 的差別在於「風險」而非「期望值」：" +
          "停手的代價是少賺一天，繼續的代價可能是重考。連續虧損也是一個訊號，代表今天的行情結構與你的方法不匹配。" +
          "把「當日連續 2–3 筆虧損就收工」寫成硬規則，你就不需要在情緒最差的時候做判斷。",
      });
    },
    (rng) => {
      const rules = getRuleSet("crypto-2step-p1");
      const gain = rules.initialBalance * 0.035;
      const dayStartEquity = rules.initialBalance;
      const equity = dayStartEquity + gain;
      const account = syntheticAccount(rules, { equity, dayStartEquity, dayIndex: randInt(rng, 1, 3), dayPnls: [] });
      return buildChoice("TILT", seed, rules, account, {
        situation:
          `今天非常順：三筆交易全對，帳戶從 ${money(dayStartEquity)} 來到 ${money(equity)}，單日 +${((gain / dayStartEquity) * 100).toFixed(2)}%。` +
          `你感覺完全讀懂了這個市場。這個規則檔的一致性條款是單日不得超過總獲利的 ${(rules.maxSingleDayProfitShare * 100).toFixed(0)}%。`,
        question: "這時候的風險是什麼？",
        options: [
          { id: "a", label: "沒有風險，順的時候就該多做", detail: "把握手感，趁勢加大。" },
          { id: "b", label: "連勝後的過度自信，加上一致性條款正在被觸發", detail: "今天已經佔了總獲利的絕大部分。" },
          { id: "c", label: "只要注意不要違反日虧損上限就好", detail: "今天在賺錢，日限額不是問題。" },
          { id: "d", label: "應該立刻提高槓桿鎖住手感", detail: "趁狀態好放大報酬。" },
        ],
        correctId: "b",
        explanation:
          "連勝造成的過度自信，和連虧造成的報復心態，是同一枚硬幣的兩面，而前者更危險因為它感覺很好。" +
          `此外，單日大幅獲利會直接推高一致性比例：如果今天佔了總獲利的 ${(rules.maxSingleDayProfitShare * 100).toFixed(0)}% 以上，` +
          "即使最後達標也不會通過。順的那天更應該提早收工。",
      });
    },
    (rng) => {
      const rules = getRuleSet(pick(rng, ["crypto-2step-p1", "crypto-1step-trailing"]));
      const target = rules.initialBalance * rules.profitTarget;
      const equity = rules.initialBalance + target * 0.88;
      const account = syntheticAccount(rules, {
        equity,
        dayStartEquity: equity,
        dayIndex: randInt(rng, 4, 9),
        dayPnls: [],
        peakEquity: equity,
      });
      const metrics = evaluate(account, equity);
      return buildChoice("TILT", seed, rules, account, {
        situation:
          `你已經很接近了：獲利 ${(metrics.profitPct * 100).toFixed(2)}%，只差 ${money(metrics.profitRemaining)} 就達到 ${(rules.profitTarget * 100).toFixed(0)}% 目標。` +
          `這個帳戶你已經經營了 ${account.dayIndex + 1} 天。`,
        question: "「只差一點點」這個心理狀態帶來的最大危險是什麼？",
        options: [
          { id: "a", label: "為了盡快結束而放大部位", detail: "剩下這段用大單一次做完。" },
          { id: "b", label: "沒有危險，接近目標時本來就該加速", detail: "衝刺是合理的。" },
          { id: "c", label: "應該完全停止交易等它自己達標", detail: "不動就不會錯。" },
          { id: "d", label: "把停損拿掉避免功虧一簣", detail: "不要在最後被掃出場。" },
        ],
        correctId: "a",
        explanation:
          "越接近目標，放棄的成本感覺越高，人就越願意用不合比例的風險去換那最後一段——這是「沉沒成本」在交易上的版本。" +
          `實際上剩下的 ${money(metrics.profitRemaining)} 只需要 ${Math.ceil(metrics.profitRemaining / (equity * 0.01))} 筆 1R 的獲利交易，` +
          "用原本的部位大小、多花幾天完成就好。C 是錯的（多數規則檔有最低交易日，完全不動反而無法通過），D 更是直接把帳戶交給運氣。",
      });
    },
  ];
}

export function generateChoice(kind: "RULE_GUARD" | "TILT", seed: string): ChoiceScenario {
  const rng = createRng(seed);
  const templates = kind === "RULE_GUARD" ? ruleGuardTemplates(seed) : tiltTemplates(seed);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const built = pick(rng, templates)(rng);
    if (built) return built;
  }
  // Templates can decline (a rule set without the relevant rule); fall back to
  // the first one that always produces output.
  const fallback = templates[0](createRng(`${seed}-fallback`));
  if (fallback) return fallback;
  throw new Error("no choice template produced a scenario");
}

export function gradeChoice(scenario: ChoiceScenario, chosenId: string): Grade {
  const correct = chosenId === scenario.correctId;
  const chosen = scenario.options.find((option) => option.id === chosenId);
  const answer = scenario.options.find((option) => option.id === scenario.correctId);
  return {
    score: correct ? 100 : 0,
    verdict: correct ? "正確" : "錯誤",
    breakdown: [
      {
        label: "決策",
        points: correct ? 100 : 0,
        max: 100,
        note: correct
          ? `「${chosen?.label ?? ""}」是唯一同時滿足規則與風險控制的選項。`
          : `你選了「${chosen?.label ?? "—"}」，正解是「${answer?.label ?? ""}」。`,
      },
    ],
    lesson: scenario.explanation,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export type AnyAnswer =
  | { kind: "BIAS"; value: BiasAnswer }
  | { kind: "SIZING"; value: SizingAnswer }
  | { kind: "STOP"; value: StopAnswer }
  | { kind: "EXIT"; value: ExitAnswer }
  | { kind: "RULE_GUARD" | "TILT"; value: { choiceId: string } };

export function gradeScenario(scenario: Scenario, answer: AnyAnswer): Grade {
  if (scenario.kind === "BIAS" && answer.kind === "BIAS") return gradeBias(scenario, answer.value);
  if (scenario.kind === "SIZING" && answer.kind === "SIZING") return gradeSizing(scenario, answer.value);
  if (scenario.kind === "STOP" && answer.kind === "STOP") return gradeStop(scenario, answer.value);
  if (scenario.kind === "EXIT" && answer.kind === "EXIT") return gradeExit(scenario, answer.value);
  if ((scenario.kind === "RULE_GUARD" || scenario.kind === "TILT") && (answer.kind === "RULE_GUARD" || answer.kind === "TILT")) {
    return gradeChoice(scenario, answer.value.choiceId);
  }
  throw new Error(`answer of kind ${answer.kind} does not match scenario ${scenario.kind}`);
}
