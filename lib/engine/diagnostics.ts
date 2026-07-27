// Behavioural diagnostics.
//
// A P&L number tells a trader nothing they can act on. These detectors read the
// trade log and name the specific habit that produced the number, because
// "you lost 4%" is not coaching but "you tripled your size after two losses,
// three sessions in a row" is.
//
// Every detector is evidence-based: it points at the trades that triggered it.

import type { AccountState, ClosedTrade, SkillId } from "./types.ts";

export type FlagCode =
  | "NO_STOP"
  | "OVERSIZED"
  | "REVENGE"
  | "TILT_SPIRAL"
  | "OVERTRADING"
  | "STOP_WIDENED"
  | "CUT_WINNER"
  | "LET_LOSER_RUN"
  | "LIMIT_ROULETTE"
  | "POST_TARGET_GREED"
  | "CONCENTRATION";

export type Diagnostic = {
  code: FlagCode;
  /** 1 = worth noticing, 2 = costing you money, 3 = this is why you fail. */
  severity: 1 | 2 | 3;
  count: number;
  title: string;
  /** What was observed, with numbers. */
  evidence: string;
  /** What to do instead. */
  coaching: string;
  /** Which competency this damages. */
  skill: SkillId;
  /** Trade ids that triggered the flag. */
  tradeIds: string[];
  /** Currency impact where it can be attributed, else null. */
  costUsd: number | null;
};

export type DiagnoseOptions = {
  /** Risk per trade the trader claims to run, as a fraction of equity. */
  plannedRiskPct: number;
  /** Trades per day above which the account is churning. */
  overtradingPerDay: number;
  /** Bars within which a new trade counts as a reaction to the last loss. */
  revengeWindowBars: number;
};

export const DEFAULT_DIAGNOSE_OPTIONS: DiagnoseOptions = {
  plannedRiskPct: 0.01,
  overtradingPerDay: 6,
  revengeWindowBars: 4,
};

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function usd(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)} U`;
}

export function diagnose(
  state: AccountState,
  options: Partial<DiagnoseOptions> = {},
): Diagnostic[] {
  const config = { ...DEFAULT_DIAGNOSE_OPTIONS, ...options };
  const trades = state.trades;
  const flags: Diagnostic[] = [];
  if (!trades.length) return flags;

  const risks = trades.filter((trade) => trade.plannedRiskUsd > 0).map((trade) => trade.plannedRiskUsd);
  const medianRisk = median(risks);

  // --- 1. Trading without a stop -------------------------------------------
  const naked = trades.filter((trade) => trade.initialStop === null);
  if (naked.length) {
    const cost = naked.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0);
    flags.push({
      code: "NO_STOP",
      severity: 3,
      count: naked.length,
      title: "無停損進場",
      evidence: `${naked.length} 筆交易在沒有設定停損的情況下進場，其中虧損部分共 ${usd(cost)}。`,
      coaching:
        "沒有停損就無法計算部位大小，也就無法保證單筆虧損落在日限額之內。考試帳戶不是死在看錯方向，是死在看錯方向而沒有出場計畫。下單前先決定「錯在哪裡」，再決定買多少。",
      skill: "DISCIPLINE",
      tradeIds: naked.map((trade) => trade.id),
      costUsd: cost,
    });
  }

  // --- 2. Oversizing --------------------------------------------------------
  const oversized = trades.filter(
    (trade) => trade.plannedRiskUsd > trade.equityAtOpen * config.plannedRiskPct * 1.5,
  );
  if (oversized.length) {
    const worst = Math.max(...oversized.map((trade) => trade.plannedRiskUsd / Math.max(trade.equityAtOpen, 1)));
    flags.push({
      code: "OVERSIZED",
      severity: oversized.length > trades.length * 0.3 ? 3 : 2,
      count: oversized.length,
      title: "部位超過計畫風險",
      evidence: `${oversized.length}/${trades.length} 筆交易的風險超過計畫值 ${(config.plannedRiskPct * 100).toFixed(2)}% 的 1.5 倍，最高一筆達帳戶的 ${(worst * 100).toFixed(2)}%。`,
      coaching:
        "部位大小不是感覺，是除法：風險金額 ÷（停損距離 + 來回手續費）= 口數。停損越近口數越大，這件事必須每一筆重算，不能沿用上一筆。",
      skill: "SIZING",
      tradeIds: oversized.map((trade) => trade.id),
      costUsd: null,
    });
  }

  // --- 3. Revenge trading ---------------------------------------------------
  const revenge: ClosedTrade[] = [];
  for (let index = 1; index < trades.length; index += 1) {
    const previous = trades[index - 1];
    const current = trades[index];
    if (previous.pnl >= 0) continue;
    const gap = current.openedIndex - previous.closedIndex;
    const bigger = medianRisk > 0 && current.plannedRiskUsd > medianRisk * 1.25;
    if (gap >= 0 && gap <= config.revengeWindowBars && bigger) revenge.push(current);
  }
  if (revenge.length) {
    const cost = revenge.reduce((sum, trade) => sum + trade.pnl, 0);
    flags.push({
      code: "REVENGE",
      severity: 3,
      count: revenge.length,
      title: "報復性交易",
      evidence: `${revenge.length} 筆交易在前一筆虧損後 ${config.revengeWindowBars} 根 K 線內、以高於平常 25% 以上的部位進場，合計 ${usd(cost)}。`,
      coaching:
        "虧損後想立刻賺回來，是帳戶最貴的一種情緒。設一條硬規則：任何一筆虧損之後，強制等待固定根數的 K 線，且下一筆的部位不得大於前一筆。把它變成機械流程，不要靠意志力。",
      skill: "DISCIPLINE",
      tradeIds: revenge.map((trade) => trade.id),
      costUsd: cost,
    });
  }

  // --- 4. Tilt spiral: losses stacking while size climbs --------------------
  let streak: ClosedTrade[] = [];
  const spirals: ClosedTrade[][] = [];
  for (const trade of trades) {
    if (trade.pnl < 0) {
      streak.push(trade);
    } else {
      if (streak.length >= 3) spirals.push(streak);
      streak = [];
    }
  }
  if (streak.length >= 3) spirals.push(streak);
  const escalating = spirals.filter((run) =>
    run.every((trade, index) => index === 0 || trade.plannedRiskUsd >= run[index - 1].plannedRiskUsd),
  );
  if (escalating.length) {
    const involved = escalating.flat();
    const cost = involved.reduce((sum, trade) => sum + trade.pnl, 0);
    flags.push({
      code: "TILT_SPIRAL",
      severity: 3,
      count: escalating.length,
      title: "連虧加碼螺旋",
      evidence: `出現 ${escalating.length} 段「連續 3 筆以上虧損、且部位一路放大」的區間，合計 ${usd(cost)}。`,
      coaching:
        "這是單一最常見的爆倉路徑。加一條停機規則：當日連續 2 筆虧損就結束當天交易。少賺一天，好過重考一次。",
      skill: "DISCIPLINE",
      tradeIds: involved.map((trade) => trade.id),
      costUsd: cost,
    });
  }

  // --- 5. Overtrading -------------------------------------------------------
  const perDay = new Map<number, number>();
  for (const trade of trades) perDay.set(trade.dayIndex, (perDay.get(trade.dayIndex) ?? 0) + 1);
  const busyDays = [...perDay.entries()].filter(([, count]) => count > config.overtradingPerDay);
  if (busyDays.length) {
    const feeDrag = state.feesPaid;
    flags.push({
      code: "OVERTRADING",
      severity: 2,
      count: busyDays.length,
      title: "過度交易",
      evidence: `${busyDays.length} 天的交易筆數超過 ${config.overtradingPerDay} 筆（最多 ${Math.max(...busyDays.map(([, count]) => count))} 筆）。整段期間手續費與資金費共 ${usd(-Math.abs(feeDrag))}。`,
      coaching:
        "考試不獎勵交易次數，只看那條權益曲線。把每日交易上限寫死，逼自己只拿最好的機會。頻率降下來，手續費侵蝕與情緒失誤會同時下降。",
      skill: "PATIENCE",
      tradeIds: [],
      costUsd: -Math.abs(feeDrag),
    });
  }

  // --- 6. Widening stops ----------------------------------------------------
  const widened = trades.filter((trade) => trade.stopWidenings > 0);
  if (widened.length) {
    const cost = widened.reduce((sum, trade) => sum + Math.min(0, trade.pnl), 0);
    flags.push({
      code: "STOP_WIDENED",
      severity: 3,
      count: widened.length,
      title: "把停損往外移",
      evidence: `${widened.length} 筆交易在持倉中將停損往不利方向移動，這些交易的虧損合計 ${usd(cost)}。`,
      coaching:
        "移動停損等於在最沒有判斷力的時刻推翻自己最有判斷力時的決定，而且會讓事前算好的部位大小失效。停損只能往獲利方向移。",
      skill: "DISCIPLINE",
      tradeIds: widened.map((trade) => trade.id),
      costUsd: cost,
    });
  }

  // --- 7. Cutting winners short --------------------------------------------
  const cutShort = trades.filter(
    (trade) => trade.reason === "MANUAL" && trade.rMultiple < 0.5 && trade.mfeR >= 1.5,
  );
  if (cutShort.length) {
    const leftOnTable = cutShort.reduce(
      (sum, trade) => sum + (trade.mfeR - trade.rMultiple) * trade.plannedRiskUsd,
      0,
    );
    flags.push({
      code: "CUT_WINNER",
      severity: 2,
      count: cutShort.length,
      title: "獲利抱不住",
      evidence: `${cutShort.length} 筆交易曾經浮盈 1.5R 以上，卻在低於 0.5R 時手動平倉，未實現的部分約 ${usd(leftOnTable)}。`,
      coaching:
        "如果你的停損是 1R，而你的獲利平均只有 0.4R，那即使勝率 60% 也是負期望值。進場前先寫下停利條件，然後讓它自己觸發，而不是盯著浮盈平倉。",
      skill: "READ",
      tradeIds: cutShort.map((trade) => trade.id),
      costUsd: null,
    });
  }

  // --- 8. Losses exceeding the planned risk ---------------------------------
  const overrun = trades.filter((trade) => trade.plannedRiskUsd > 0 && trade.rMultiple < -1.25);
  if (overrun.length) {
    const excess = overrun.reduce(
      (sum, trade) => sum + (trade.rMultiple + 1) * trade.plannedRiskUsd,
      0,
    );
    flags.push({
      code: "LET_LOSER_RUN",
      severity: 3,
      count: overrun.length,
      title: "虧損超出事前風險",
      evidence: `${overrun.length} 筆交易的虧損超過事前計算風險的 1.25 倍，超額部分約 ${usd(excess)}。`,
      coaching:
        "單筆虧損理論上不該超過 1R。超出代表停損被移走、被跳空穿過、或根本沒設。跳空無法避免，但可以用降低部位與避開高波動時段來控制。",
      skill: "SIZING",
      tradeIds: overrun.map((trade) => trade.id),
      costUsd: excess,
    });
  }

  // --- 9. Trading with almost no room left ----------------------------------
  const roulette = trades.filter(
    (trade) =>
      Number.isFinite(trade.bindingRoomAtOpen) &&
      trade.bindingRoomAtOpen > 0 &&
      trade.plannedRiskUsd > trade.bindingRoomAtOpen * 0.5,
  );
  if (roulette.length) {
    flags.push({
      code: "LIMIT_ROULETTE",
      severity: 3,
      count: roulette.length,
      title: "在限額邊緣下注",
      evidence: `${roulette.length} 筆交易在進場時，單筆風險就佔掉剩餘限額空間的一半以上。`,
      coaching:
        "這種交易即使做對也救不了帳戶，做錯就直接出局。規則很簡單：任何一筆單的風險不得超過剩餘限額空間的三分之一。低於三筆容錯，當天就該收工。",
      skill: "SIZING",
      tradeIds: roulette.map((trade) => trade.id),
      costUsd: null,
    });
  }

  // --- 10. Trading on past the target ---------------------------------------
  const targetEquity = state.rules.initialBalance * (1 + state.rules.profitTarget);
  const greedy = trades.filter((trade) => trade.equityAtOpen >= targetEquity);
  if (greedy.length) {
    const cost = greedy.reduce((sum, trade) => sum + trade.pnl, 0);
    flags.push({
      code: "POST_TARGET_GREED",
      severity: cost < 0 ? 3 : 1,
      count: greedy.length,
      title: "達標後繼續交易",
      evidence: `帳戶已達獲利目標之後仍開了 ${greedy.length} 筆交易，合計 ${usd(cost)}。`,
      coaching:
        "達標之後每一筆交易的報酬是零、風險是整個帳戶。唯一的例外是還沒滿足最低交易日或一致性條款——那也應該用最小部位去補天數，不是照常操作。",
      skill: "PATIENCE",
      tradeIds: greedy.map((trade) => trade.id),
      costUsd: cost,
    });
  }

  // --- 11. One-day accounts (consistency risk) ------------------------------
  const profitDays = state.days.filter((day) => day.pnl > 0);
  const totalProfit = state.days.reduce((sum, day) => sum + day.pnl, 0);
  if (state.rules.maxSingleDayProfitShare > 0 && totalProfit > 0 && profitDays.length) {
    const best = Math.max(...profitDays.map((day) => day.pnl));
    const share = best / totalProfit;
    if (share > state.rules.maxSingleDayProfitShare) {
      flags.push({
        code: "CONCENTRATION",
        severity: 3,
        count: 1,
        title: "獲利過度集中於單日",
        evidence: `最佳單日獲利佔總獲利的 ${(share * 100).toFixed(0)}%，超過一致性條款上限 ${(state.rules.maxSingleDayProfitShare * 100).toFixed(0)}%。`,
        coaching:
          "即使帳面已達標，這條規則也會讓你不通過。修正方式是拉長天數、縮小單日目標：與其一天賺 5%，不如五天各賺 1%。這條規則本質上是在測你能不能複製。",
        skill: "CONSISTENCY",
        tradeIds: [],
        costUsd: null,
      });
    }
  }

  return flags.sort((a, b) => b.severity - a.severity || b.count - a.count);
}

/**
 * Collapse diagnostics into a 0..100 discipline score. Severity 3 flags are
 * expensive on purpose: this number should be uncomfortable when it should be.
 */
export function disciplineScore(flags: Diagnostic[]): number {
  const penalty = flags.reduce((sum, flag) => {
    const unit = flag.severity === 3 ? 12 : flag.severity === 2 ? 6 : 2;
    return sum + unit + Math.min(unit, (flag.count - 1) * (unit / 4));
  }, 0);
  return Math.max(0, Math.round(100 - penalty));
}

/** The single most important thing to fix next. */
export function primaryWeakness(flags: Diagnostic[]): Diagnostic | null {
  return flags[0] ?? null;
}
