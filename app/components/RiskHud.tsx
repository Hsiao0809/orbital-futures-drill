"use client";

// The risk-budget readout.
//
// This is the single most valuable surface in the product. A trader who can
// see "you have 180 U before the daily rule kills this account, and the trade
// you are about to take risks 220 U" does not need to be told not to take it.

import { describeDrawdownMode } from "@/lib/engine/propRules.ts";
import { lossesUntilBreach } from "@/lib/engine/sizing.ts";
import type { RuleMetrics, RuleSet } from "@/lib/engine/types.ts";

function money(value: number): string {
  if (!Number.isFinite(value)) return "無限制";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Room expressed as a percentage of the allowance, for the meter fill. */
function fill(room: number, allowance: number): number {
  if (!Number.isFinite(allowance) || allowance <= 0) return 100;
  return Math.max(0, Math.min(100, (room / allowance) * 100));
}

/**
 * Colour by how much room is left, not by which metric it is. Plenty of room
 * must never render amber — a warning colour shown in the safe state trains
 * the trader to ignore it.
 */
function meterTone(percent: number): string {
  if (percent < 25) return "meter-red";
  if (percent < 60) return "meter-amber";
  return "meter-green";
}

export default function RiskHud({
  metrics,
  rules,
  /** Risk of the trade being contemplated, so the HUD can pre-warn. */
  pendingRisk = 0,
}: {
  metrics: RuleMetrics;
  rules: RuleSet;
  pendingRisk?: number;
}) {
  const room = metrics.bindingRoom;
  const perTradeCap = room / 3;
  const overCap = pendingRisk > perTradeCap + 1e-9;
  const fatal = pendingRisk >= room && pendingRisk > 0;

  // Measure the binding constraint against its own allowance, not always the
  // daily one — otherwise a trailing-drawdown account is scored on the wrong
  // denominator and shows green while it is one candle from being dead.
  const bindingAllowance =
    metrics.bindingConstraint === "DAILY"
      ? metrics.dailyLossAllowance
      : rules.initialBalance * rules.maxDrawdown;
  const roomPercent = fill(room, bindingAllowance);
  const tone = room <= 0 ? "" : roomPercent >= 60 ? "safe" : roomPercent >= 25 ? "caution" : "";
  const survivable = lossesUntilBreach(metrics, pendingRisk > 0 ? pendingRisk : metrics.equity * 0.01);

  return (
    <div className="hud">
      <div className={`hud-binding ${tone}`}>
        <span>距離{metrics.bindingConstraint === "DAILY" ? "當日虧損上限" : "帳戶死亡線"}還有</span>
        <b className="num">{money(room)} U</b>
        <p className="tiny">
          觸發水位 {money(metrics.bindingFloor)} U ·{" "}
          {metrics.bindingConstraint === "DAILY"
            ? "跨日後這條線會重置"
            : "這條線一旦觸及，考試直接結束"}
        </p>
      </div>

      {pendingRisk > 0 && (
        <div className={`banner ${fatal ? "bad" : overCap ? "" : "info"}`}>
          <span>{fatal ? "✕" : overCap ? "!" : "✓"}</span>
          <span>
            {fatal
              ? `這筆單的風險 ${money(pendingRisk)} U 已經大於剩餘空間 ${money(room)} U。停損一旦觸發，帳戶直接出局。`
              : overCap
                ? `風險 ${money(pendingRisk)} U 超過建議上限 ${money(perTradeCap)} U（剩餘空間的三分之一）。虧一次就只剩 ${Math.max(0, survivable - 1)} 次容錯。`
                : `風險 ${money(pendingRisk)} U 在安全範圍內，可承受 ${survivable} 次滿額虧損。`}
          </span>
        </div>
      )}

      <div className="hud-row">
        <div className="hud-label">
          <span>獲利目標進度</span>
          <b>
            {(metrics.profitPct * 100).toFixed(2)}% / {(rules.profitTarget * 100).toFixed(0)}%
          </b>
        </div>
        <div className="meter meter-green">
          <i style={{ width: `${metrics.targetProgress * 100}%` }} />
        </div>
        <p className="tiny">還差 {money(metrics.profitRemaining)} U</p>
      </div>

      <div className="hud-row">
        <div className="hud-label">
          <span>當日虧損空間</span>
          <b>
            {money(metrics.dailyRoom)} / {money(metrics.dailyLossAllowance)} U
          </b>
        </div>
        <div className={`meter ${meterTone(fill(metrics.dailyRoom, metrics.dailyLossAllowance))}`}>
          <i style={{ width: `${fill(metrics.dailyRoom, metrics.dailyLossAllowance)}%` }} />
        </div>
      </div>

      <div className="hud-row">
        <div className="hud-label">
          <span>最大回撤空間</span>
          <b>{money(metrics.drawdownRoom)} U</b>
        </div>
        <div className={`meter ${meterTone(fill(metrics.drawdownRoom, rules.initialBalance * rules.maxDrawdown))}`}>
          <i style={{ width: `${fill(metrics.drawdownRoom, rules.initialBalance * rules.maxDrawdown)}%` }} />
        </div>
        <p className="tiny">
          死亡線 {money(metrics.drawdownFloor)} U · {describeDrawdownMode(rules.drawdownMode)}
        </p>
      </div>

      <div className="grid-2">
        <div className="stat stat-sm">
          <span>交易日</span>
          <b className="num">
            {metrics.tradingDays}
            {rules.minTradingDays ? ` / ${rules.minTradingDays}` : ""}
          </b>
          <i>{rules.minTradingDays && metrics.tradingDays < rules.minTradingDays ? "尚未達標" : "已滿足"}</i>
        </div>
        <div className="stat stat-sm">
          <span>單日獲利佔比</span>
          <b className="num">
            {(metrics.worstConsistencyShare * 100).toFixed(0)}%
            {rules.maxSingleDayProfitShare ? ` / ${(rules.maxSingleDayProfitShare * 100).toFixed(0)}%` : ""}
          </b>
          <i>
            {!rules.maxSingleDayProfitShare
              ? "此規則檔無一致性條款"
              : metrics.pending.includes("CONSISTENCY")
                ? "已違反一致性"
                : "符合"}
          </i>
        </div>
      </div>
    </div>
  );
}
