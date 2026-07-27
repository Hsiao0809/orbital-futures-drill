"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import Chart, { type PriceLine } from "@/app/components/Chart";
import RiskHud from "@/app/components/RiskHud";
import { useProfile } from "@/lib/store/profile.ts";
import { saveRunDetail } from "@/lib/store/lastRun.ts";
import { fetchCandles, INTERVALS } from "@/lib/market/client.ts";
import {
  advance,
  closePosition,
  createAccount,
  dayNumber,
  finalise,
  markedEquity,
  openPosition,
  usedMargin,
} from "@/lib/engine/account.ts";
import { RULE_SETS, evaluate, getRuleSet, describePending, runStatus } from "@/lib/engine/propRules.ts";
import { sizePosition, maxDefensibleRisk } from "@/lib/engine/sizing.ts";
import { atr } from "@/lib/engine/indicators.ts";
import { diagnose, disciplineScore } from "@/lib/engine/diagnostics.ts";
import { applyRunOutcome } from "@/lib/engine/scoring.ts";
import { evaluationUnlocked } from "@/lib/engine/curriculum.ts";
import type { Diagnostic } from "@/lib/engine/diagnostics.ts";
import type { AdvanceEvent } from "@/lib/engine/account.ts";
import type {
  AccountState,
  Candle,
  Interval,
  RuleMetrics,
  RunRecord,
  RunStatus,
  Side,
} from "@/lib/engine/types.ts";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "LINKUSDT", "AVAXUSDT", "ARBUSDT", "SUIUSDT"];
const WARMUP = 60;
/** Stable empty array so the "no data yet" case does not re-key every callback. */
const NO_CANDLES: Candle[] = [];

type Phase = "SETUP" | "RUNNING" | "DONE";

type RunResults = {
  record: RunRecord;
  flags: Diagnostic[];
  discipline: number;
  finalMetrics: RuleMetrics;
  status: RunStatus;
};

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function price(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.abs(value) >= 1000
    ? value.toLocaleString("en-US", { maximumFractionDigits: 1 })
    : Math.abs(value) >= 1
      ? value.toFixed(2)
      : value.toFixed(5);
}
function stamp(time: number): string {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
  }).format(time);
}

export default function ExamSimulator() {
  const { profile, ready, update } = useProfile();

  const [phase, setPhase] = useState<Phase>("SETUP");
  const [ruleSetId, setRuleSetId] = useState(RULE_SETS[0].id);
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [interval, setIntervalChoice] = useState<Interval>("1h");

  const [market, setMarket] = useState<{ key: string; candles: Candle[]; error: string | null } | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  const [account, setAccount] = useState<AccountState | null>(null);
  const [cursor, setCursor] = useState(WARMUP);
  const [log, setLog] = useState<string[]>([]);
  const [results, setResults] = useState<RunResults | null>(null);

  // Trade ticket
  const [side, setSide] = useState<Side>("LONG");
  const [stopAtr, setStopAtr] = useState(1.5);
  const [riskPct, setRiskPct] = useState(0.01);
  const [targetR, setTargetR] = useState(2);

  const rules = getRuleSet(ruleSetId);
  const say = useCallback((line: string) => setLog((items) => [line, ...items].slice(0, 60)), []);

  // Only the async continuation writes state, so nothing is set synchronously
  // inside the effect body.
  const marketKey = `${symbol}:${interval}`;
  useEffect(() => {
    let cancelled = false;
    void fetchCandles(symbol, interval, 1000).then((result) => {
      if (cancelled) return;
      setMarket({
        key: `${symbol}:${interval}`,
        candles: "error" in result ? [] : result.candles,
        error: "error" in result ? result.error : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [symbol, interval]);

  // Never run an exam against candles fetched for a different symbol.
  const fresh = market && market.key === marketKey ? market : null;
  const candles = fresh?.candles ?? NO_CANDLES;
  const loading = !fresh;
  const error = setupError ?? fresh?.error ?? null;

  const start = () => {
    if (candles.length < WARMUP + 60) {
      setSetupError("歷史資料不足以進行一次完整考試，請換一個合約或週期。");
      return;
    }
    setSetupError(null);
    setAccount(createAccount(rules));
    setCursor(WARMUP);
    setResults(null);
    setLog([`考試開始：${rules.label} · ${symbol} ${interval}。起始資金 ${money(rules.initialBalance)} U。`]);
    setPhase("RUNNING");
  };

  const current = candles[cursor];
  const mark = current?.close ?? 0;
  const metrics = useMemo(
    () => (account ? evaluate(account, markedEquity(account, mark)) : null),
    [account, mark],
  );

  // --- trade ticket maths ---------------------------------------------------
  const range = account && current ? atr(candles, cursor) : 0;
  const stopPrice = current ? (side === "LONG" ? mark - range * stopAtr : mark + range * stopAtr) : 0;
  const targetPrice = current
    ? side === "LONG"
      ? mark + range * stopAtr * targetR
      : mark - range * stopAtr * targetR
    : 0;

  const sizing = useMemo(() => {
    if (!account || !metrics || !current || range <= 0) return null;
    return sizePosition({
      equity: metrics.equity,
      riskPct,
      entry: mark,
      stop: stopPrice,
      side,
      rules,
    });
  }, [account, metrics, current, range, riskPct, mark, stopPrice, side, rules]);

  /**
   * Settle the run: close everything out, score it, and persist. Done here in
   * an event handler rather than in render or an effect, because it reads the
   * clock and writes to storage.
   */
  const finish = useCallback(
    (state: AccountState, index: number) => {
      const closed = finalise(state, candles, index);
      const finalMetrics = evaluate(closed, closed.balance);
      const flags = diagnose(closed, { plannedRiskPct: riskPct });
      const discipline = disciplineScore(flags);
      const status = runStatus(closed, finalMetrics);
      const record: RunRecord = {
        id: `run-${Date.now()}`,
        ruleSetId: rules.id,
        symbol,
        interval,
        status,
        profit: closed.balance - rules.initialBalance,
        profitPct: (closed.balance - rules.initialBalance) / rules.initialBalance,
        tradingDays: finalMetrics.tradingDays,
        trades: closed.trades.length,
        totalR: closed.trades.reduce((sum, item) => sum + item.rMultiple, 0),
        breach: closed.breach?.code ?? null,
        disciplineScore: discipline,
        finishedAt: Date.now(),
      };

      setAccount(closed);
      setResults({ record, flags, discipline, finalMetrics, status });
      setPhase("DONE");

      update((profileState) => applyRunOutcome(profileState, record, flags));
      saveRunDetail({
        record,
        trades: closed.trades,
        days: closed.days,
        flags,
        breachMessage: closed.breach?.message ?? null,
      });
    },
    [candles, riskPct, rules, symbol, interval, update],
  );

  const describeEvents = useCallback(
    (events: AdvanceEvent[], at: number): string[] =>
      events.flatMap((event) => {
        if (event.kind === "EXIT") {
          const label =
            event.reason === "STOP" ? "停損"
            : event.reason === "TARGET" ? "停利"
            : event.reason === "LIQUIDATION" ? "強制平倉"
            : event.reason === "RULE_FLATTEN" ? "違規強制平倉"
            : "平倉";
          return [
            `${stamp(candles[at].time)}　${label} @ ${price(event.price)}　${event.pnl >= 0 ? "+" : ""}${event.pnl.toFixed(2)} U`,
          ];
        }
        if (event.kind === "DAY_ROLL") {
          return [
            `── 第 ${event.dayIndex} 日結算：${event.summary.pnl >= 0 ? "+" : ""}${event.summary.pnl.toFixed(2)} U，日限額已重置 ──`,
          ];
        }
        if (event.kind === "BREACH") return [`⚠ ${event.message}`];
        return [];
      }),
    [candles],
  );

  const advanceOne = useCallback(() => {
    if (!account || account.breach) return;
    const next = cursor + 1;
    if (next >= candles.length) return;
    const result = advance(account, candles, next);
    setAccount(result.state);
    setCursor(next);
    const lines = describeEvents(result.events, next);
    if (lines.length) setLog((items) => [...lines.reverse(), ...items].slice(0, 60));
    // A breached account has no decisions left to make; settle immediately.
    if (result.state.breach) finish(result.state, next);
  }, [account, candles, cursor, describeEvents, finish]);

  /** Run forward until the calendar day changes, a fill happens, or we breach. */
  const advanceToNextDay = useCallback(() => {
    if (!account || account.breach) return;
    let state = account;
    let index = cursor;
    const startDay = dayNumber(candles[cursor].time);
    const lines: string[] = [];
    let guard = 0;
    while (index + 1 < candles.length && guard < 400) {
      guard += 1;
      index += 1;
      const result = advance(state, candles, index);
      state = result.state;
      lines.push(...describeEvents(result.events, index));
      if (state.breach) break;
      if (dayNumber(candles[index].time) !== startDay && state.positions.length === 0) break;
    }
    setAccount(state);
    setCursor(index);
    setLog((items) => [...lines.reverse(), ...items].slice(0, 60));
    if (state.breach) finish(state, index);
  }, [account, candles, cursor, describeEvents, finish]);

  const submitTrade = () => {
    if (!account || !sizing || !current) return;
    if (sizing.qty <= 0) {
      say("口數為 0，這筆單沒有送出。");
      return;
    }
    const notional = sizing.qty * mark;
    const free = markedEquity(account, mark) - usedMargin(account);
    // Pick the smallest leverage that keeps margin under half the free equity,
    // so a position never locks up the whole account.
    const leverage = Math.max(
      1,
      Math.min(rules.maxLeverage, Math.ceil(notional / Math.max(free * 0.5, 1e-9))),
    );
    const result = openPosition(
      account,
      { side, qty: sizing.qty, leverage, stop: stopPrice, target: targetR > 0 ? targetPrice : null },
      candles,
      cursor,
    );
    if (!result.ok) {
      say(`✕ 下單被拒：${result.error}`);
      return;
    }
    setAccount(result.state);
    say(
      `${stamp(current.time)}　開倉 ${side} ${sizing.qty.toFixed(4)} @ ${price(result.position.entry)}　停損 ${price(stopPrice)}　風險 ${sizing.riskUsd.toFixed(2)} U（${leverage}×）`,
    );
  };

  const flatten = () => {
    if (!account) return;
    let state = account;
    for (const position of account.positions) {
      state = closePosition(state, position.id, candles, cursor, "MANUAL");
    }
    setAccount(state);
    say("手動平掉所有部位。");
  };

  const restart = () => {
    setAccount(null);
    setResults(null);
    setPhase("SETUP");
    setLog([]);
  };

  if (!ready) {
    return <main className="empty"><p>載入中…</p></main>;
  }

  if (!evaluationUnlocked(profile)) {
    return (
      <main className="stack">
        <div className="card stack">
          <p className="eyebrow">尚未開放</p>
          <h2>完整考試模擬需要先完成訓練階梯</h2>
          <p className="note">
            這不是刁難。在還沒辦法穩定算出正確部位、也還沒建立停機規則之前跑一次完整考試，
            結果幾乎完全由運氣決定，你不會從中學到任何可複製的東西。
          </p>
          <Link href="/train" className="btn btn-primary">前往訓練 →</Link>
        </div>
      </main>
    );
  }

  // --- setup ----------------------------------------------------------------
  if (phase === "SETUP") {
    return (
      <main className="stack-lg">
        <header className="page-head">
          <p className="eyebrow">考試模擬</p>
          <h1>在真實規則壓力下跑完一整段行情。</h1>
          <p className="lede">
            多日連續交易、跨日結算、規則逐根判定。任何一根 K 線的影線觸及限額都會立刻結束考試，
            跟真實程式一樣，不會等你收盤。
          </p>
        </header>

        <div className="split">
          <div className="card stack">
            <p className="eyebrow">選擇規則檔</p>
            <div className="stack-sm">
              {RULE_SETS.map((item) => (
                <button
                  key={item.id}
                  className={`choice ${ruleSetId === item.id ? "correct" : ""}`}
                  onClick={() => setRuleSetId(item.id)}
                >
                  <span className="choice-key">{item.id === ruleSetId ? "✓" : ""}</span>
                  <span>
                    <strong>{item.label}</strong>
                    <span>
                      目標 +{(item.profitTarget * 100).toFixed(0)}%　·　日虧損 {(item.maxDailyLoss * 100).toFixed(0)}%　·
                      最大回撤 {(item.maxDrawdown * 100).toFixed(0)}%　·　最低 {item.minTradingDays} 個交易日
                      {item.maxSingleDayProfitShare ? `　·　一致性 ${(item.maxSingleDayProfitShare * 100).toFixed(0)}%` : ""}
                    </span>
                    <span style={{ marginTop: 5, color: "var(--amber)" }}>{item.note}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <aside className="stack">
            <div className="card stack">
              <p className="eyebrow">市場</p>
              <label className="field">
                <span>合約</span>
                <select value={symbol} onChange={(event) => setSymbol(event.target.value)}>
                  {SYMBOLS.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>K 線週期</span>
                <select value={interval} onChange={(event) => setIntervalChoice(event.target.value as Interval)}>
                  {INTERVALS.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>
              <p className="tiny">
                {loading
                  ? "正在載入歷史資料…"
                  : error
                    ? error
                    : `已載入 ${candles.length} 根 K 線，約 ${Math.round((candles.length * (interval === "5m" ? 5 : interval === "15m" ? 15 : interval === "1h" ? 60 : 240)) / 1440)} 個交易日。`}
              </p>
              <button className="btn btn-primary btn-lg" disabled={loading || !candles.length} onClick={start}>
                開始考試 →
              </button>
            </div>
          </aside>
        </div>
      </main>
    );
  }

  if (!account || !metrics || !current) {
    return <main className="empty"><p>準備中…</p></main>;
  }

  // --- results screen -------------------------------------------------------
  if (phase === "DONE" && results) {
    const { record, flags, discipline, finalMetrics, status } = results;
    const pending = describePending(rules, finalMetrics.pending);
    // Only a run that actually reached the profit target can be described as
    // "blocked by the soft rules"; everything else simply fell short.
    const targetMet = finalMetrics.profitRemaining <= 0;
    return (
      <main className="stack-lg">
        <header className="stack">
          <p className="eyebrow">考試結果 · {rules.label}</p>
          <div className="row">
            <h1>
              {status === "PASSED" ? "通過" : status === "FAILED" ? "違規出局" : "已完成，但未達標"}
            </h1>
            <span className={`pill ${status === "PASSED" ? "pill-green" : status === "FAILED" ? "pill-red" : "pill-amber"}`}>
              {status === "PASSED" ? "通過" : status === "FAILED" ? "不通過" : "未完成"}
            </span>
          </div>
          {account.breach && <div className="banner bad"><span>✕</span><span>{account.breach.message}</span></div>}
          {status !== "FAILED" && targetMet && pending.length > 0 && (
            <div className="banner">
              <span>!</span>
              <span>帳面獲利已達標，但以下條件尚未滿足：{pending.join("　")}</span>
            </div>
          )}
          {status !== "FAILED" && !targetMet && (
            <div className="banner">
              <span>!</span>
              <span>
                沒有違規，但也還沒到達獲利目標：還差 {money(finalMetrics.profitRemaining)} U
                （目前 {(finalMetrics.profitPct * 100).toFixed(2)}%，目標 {(rules.profitTarget * 100).toFixed(0)}%）。
                {pending.length > 0 && `　此外：${pending.join("　")}`}
              </span>
            </div>
          )}
        </header>

        <div className="grid-4">
          <div className="stat">
            <span>最終損益</span>
            <b className={`num ${record.profit >= 0 ? "up" : "down"}`}>
              {record.profit >= 0 ? "+" : ""}{record.profit.toFixed(2)} U
            </b>
            <i>{(record.profitPct * 100).toFixed(2)}%</i>
          </div>
          <div className="stat">
            <span>紀律分數</span>
            <b className={`num ${discipline >= 80 ? "up" : discipline >= 55 ? "warn" : "down"}`}>{discipline}</b>
            <i>{flags.length} 項行為問題</i>
          </div>
          <div className="stat">
            <span>累計 R</span>
            <b className={`num ${record.totalR >= 0 ? "up" : "down"}`}>{record.totalR.toFixed(2)}R</b>
            <i>{record.trades} 筆交易</i>
          </div>
          <div className="stat">
            <span>交易日</span>
            <b className="num">{record.tradingDays}</b>
            <i>手續費與資金費 {(account.feesPaid + account.fundingPaid).toFixed(2)} U</i>
          </div>
        </div>

        <section className="split">
          <div className="card stack">
            <p className="eyebrow">行為診斷</p>
            {flags.length ? (
              <div className="stack-sm">
                {flags.map((flag) => (
                  <div key={flag.code} className={`flag sev-${flag.severity}`}>
                    <div className="row-between">
                      <h3>{flag.title}</h3>
                      <span className={`pill ${flag.severity === 3 ? "pill-red" : flag.severity === 2 ? "pill-amber" : "pill-mute"}`}>
                        {flag.severity === 3 ? "致命" : flag.severity === 2 ? "耗損" : "注意"} × {flag.count}
                      </span>
                    </div>
                    <p className="evidence">{flag.evidence}</p>
                    <p className="coaching">{flag.coaching}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="banner info">
                <span>✓</span>
                <span>沒有偵測到行為問題。每一筆都有停損、部位一致、沒有在限額邊緣下注。這是最難的部分。</span>
              </div>
            )}
          </div>

          <aside className="stack">
            <div className="card stack">
              <p className="eyebrow">每日權益</p>
              {account.days.map((day) => (
                <div key={day.dayIndex} className="row-between" style={{ fontSize: 12 }}>
                  <span className="dim">第 {day.dayIndex + 1} 日 · {day.trades} 筆</span>
                  <b className={`num ${day.pnl >= 0 ? "up" : "down"}`}>
                    {day.pnl >= 0 ? "+" : ""}{day.pnl.toFixed(2)} U
                  </b>
                </div>
              ))}
            </div>
            <div className="card stack">
              <p className="eyebrow">下一步</p>
              <p className="note">
                這次結果已計入你的能力值與訓練紀錄。
              </p>
              <button className="btn btn-primary btn-lg" onClick={restart}>再考一次 →</button>
              <Link href="/journal" className="btn">查看完整交易紀錄</Link>
            </div>
          </aside>
        </section>
      </main>
    );
  }

  // --- running --------------------------------------------------------------
  const lines: PriceLine[] = account.positions.flatMap((position) => {
    const out: PriceLine[] = [
      { price: position.entry, label: `${position.side} 進場`, color: "#c8f466" },
    ];
    if (position.stop !== null) out.push({ price: position.stop, label: "停損", color: "#f26c7c", dashed: true });
    if (position.target !== null) out.push({ price: position.target, label: "停利", color: "#6ee7b7", dashed: true });
    return out;
  });

  const equity = markedEquity(account, mark);
  const defensible = maxDefensibleRisk(metrics, riskPct);
  const barsLeft = candles.length - 1 - cursor;

  return (
    <main className="stack">
      <header className="row-between">
        <div>
          <p className="eyebrow">{rules.label} · {symbol} {interval}</p>
          <div className="row">
            <h1 className="num">{money(equity)} U</h1>
            <span className={`pill ${metrics.profit >= 0 ? "pill-green" : "pill-red"}`}>
              {metrics.profit >= 0 ? "+" : ""}{metrics.profit.toFixed(2)} U
            </span>
            <span className="pill pill-mute">第 {account.dayIndex + 1} 個交易日</span>
            <span className="pill pill-mute">{stamp(current.time)} UTC</span>
          </div>
        </div>
        <div className="row">
          <button className="btn btn-sm" onClick={() => finish(account, cursor)}>結束並結算</button>
        </div>
      </header>

      <div className="split-wide">
        <div className="stack">
          <Chart candles={candles} visible={cursor + 1} lines={lines} height={420} />

          <div className="card row" style={{ padding: 12 }}>
            <button className="btn" onClick={advanceOne} disabled={barsLeft <= 0}>
              下一根 K 線 →
            </button>
            <button className="btn" onClick={advanceToNextDay} disabled={barsLeft <= 0}>
              快轉到下一個交易日 ⇥
            </button>
            {account.positions.length > 0 && (
              <button className="btn btn-danger" onClick={flatten}>全部平倉</button>
            )}
            <span className="tiny" style={{ marginLeft: "auto" }}>剩餘 {barsLeft} 根 K 線</span>
          </div>

          {/* --- trade ticket ------------------------------------------------ */}
          <div className="card stack">
            <p className="eyebrow">下單</p>
            <div className="side-buttons">
              <button className={`side-btn ${side === "LONG" ? "sel-long" : ""}`} onClick={() => setSide("LONG")}>
                <strong>LONG</strong><span>做多</span>
              </button>
              <button className={`side-btn ${side === "SHORT" ? "sel-short" : ""}`} onClick={() => setSide("SHORT")}>
                <strong>SHORT</strong><span>做空</span>
              </button>
              <div className="stat stat-sm">
                <span>現價</span>
                <b className="num">{price(mark)}</b>
              </div>
            </div>

            <div className="grid-3">
              <label className="field">
                <span>停損距離 · {stopAtr.toFixed(2)} ATR（{price(stopPrice)}）</span>
                <input type="range" min="0.5" max="4" step="0.1" value={stopAtr}
                  onChange={(event) => setStopAtr(Number(event.target.value))} />
              </label>
              <label className="field">
                <span>單筆風險 · {(riskPct * 100).toFixed(2)}%</span>
                <input type="range" min="0.0025" max="0.03" step="0.0025" value={riskPct}
                  onChange={(event) => setRiskPct(Number(event.target.value))} />
              </label>
              <label className="field">
                <span>停利 · {targetR === 0 ? "手動管理" : `${targetR.toFixed(1)}R（${price(targetPrice)}）`}</span>
                <input type="range" min="0" max="5" step="0.5" value={targetR}
                  onChange={(event) => setTargetR(Number(event.target.value))} />
              </label>
            </div>

            {sizing && (
              <div className="grid-4">
                <div className="stat stat-sm">
                  <span>口數</span><b className="num">{sizing.qty.toFixed(4)}</b>
                </div>
                <div className="stat stat-sm">
                  <span>名目價值</span><b className="num">{money(sizing.notional)} U</b>
                </div>
                <div className="stat stat-sm">
                  <span>停損虧損</span>
                  <b className={`num ${sizing.riskUsd > defensible.riskUsd ? "down" : "warn"}`}>
                    {sizing.riskUsd.toFixed(2)} U
                  </b>
                </div>
                <div className="stat stat-sm">
                  <span>建議風險上限</span>
                  <b className="num">{defensible.riskUsd.toFixed(2)} U</b>
                  <i>{defensible.limitedBy === "BASE" ? "依計畫風險" : "受剩餘限額壓縮"}</i>
                </div>
              </div>
            )}

            <button className="btn btn-primary btn-lg" onClick={submitTrade} disabled={!sizing || sizing.qty <= 0}>
              送出 {side} 委託
            </button>
            {sizing && sizing.constraints.length > 0 && (
              <p className="tiny warn">{sizing.constraints.join("　·　")}</p>
            )}
          </div>

          {/* --- positions ---------------------------------------------------- */}
          {account.positions.length > 0 && (
            <div className="card stack">
              <p className="eyebrow">持倉</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>方向</th><th className="num">口數</th><th className="num">進場</th>
                      <th className="num">停損</th><th className="num">浮動</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {account.positions.map((position) => {
                      const unrealised = (mark - position.entry) * position.qty * (position.side === "LONG" ? 1 : -1);
                      return (
                        <tr key={position.id}>
                          <td className={position.side === "LONG" ? "up" : "down"}>{position.side}</td>
                          <td className="num">{position.qty.toFixed(4)}</td>
                          <td className="num">{price(position.entry)}</td>
                          <td className="num">{position.stop === null ? "無" : price(position.stop)}</td>
                          <td className={`num ${unrealised >= 0 ? "up" : "down"}`}>
                            {unrealised >= 0 ? "+" : ""}{unrealised.toFixed(2)} U
                          </td>
                          <td>
                            <button className="btn btn-sm btn-danger"
                              onClick={() => { setAccount(closePosition(account, position.id, candles, cursor, "MANUAL")); say("手動平倉。"); }}>
                              平倉
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <aside className="stack">
          <div className="card stack">
            <p className="eyebrow">風險預算</p>
            <RiskHud metrics={metrics} rules={rules} pendingRisk={sizing?.riskUsd ?? 0} />
          </div>

          <div className="card stack">
            <p className="eyebrow">事件記錄</p>
            <div className="stack-sm scroll-y" style={{ maxHeight: 260 }}>
              {log.map((line, index) => (
                <p key={`${line}-${index}`} className="tiny" style={{ color: index === 0 ? "var(--ink)" : undefined }}>
                  {line}
                </p>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
