"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useProfile } from "@/lib/store/profile.ts";
import { useMounted } from "@/lib/store/client.ts";
import { loadRunDetail } from "@/lib/store/lastRun.ts";
import { getRuleSet } from "@/lib/engine/propRules.ts";
import { SKILLS } from "@/lib/engine/scoring.ts";

const FLAG_LABELS: Record<string, string> = {
  NO_STOP: "無停損進場",
  OVERSIZED: "部位超額",
  REVENGE: "報復性交易",
  TILT_SPIRAL: "連虧加碼",
  OVERTRADING: "過度交易",
  STOP_WIDENED: "外移停損",
  CUT_WINNER: "獲利抱不住",
  LET_LOSER_RUN: "虧損超額",
  LIMIT_ROULETTE: "限額邊緣下注",
  POST_TARGET_GREED: "達標後續做",
  CONCENTRATION: "獲利集中",
};

function price(value: number): string {
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

const REASON_LABELS: Record<string, string> = {
  STOP: "停損", TARGET: "停利", MANUAL: "手動", LIQUIDATION: "強平",
  SESSION_END: "收盤", RULE_FLATTEN: "違規平倉",
};

export default function Journal() {
  const { profile, ready, reset } = useProfile();
  const mounted = useMounted();
  // Read once after hydration. Navigating here from the exam always mounts a
  // fresh instance, so a run finished this session is picked up without a
  // reload and no subscription is needed.
  const detail = useMemo(() => (mounted ? loadRunDetail() : null), [mounted]);

  if (!ready) {
    return <main className="empty"><p>載入中…</p></main>;
  }

  const runs = profile.runHistory;
  const totalFlags = Object.entries(profile.flagCounts).sort((a, b) => b[1] - a[1]);

  return (
    <main className="stack-lg">
      <header className="page-head">
        <p className="eyebrow">紀錄與診斷</p>
        <h1>你的錯誤有名字，而且會重複。</h1>
        <p className="lede">
          單看損益學不到東西。這裡把每次考試拆解成具體的行為模式，並統計哪些習慣反覆出現。
        </p>
      </header>

      {/* --- recurring habits ------------------------------------------------ */}
      <section className="card stack">
        <p className="eyebrow">累計行為統計</p>
        {totalFlags.length ? (
          <>
            <p className="note">
              以下是所有考試模擬累計偵測到的行為問題。出現次數最多的那一項，就是你的主要瓶頸。
            </p>
            <div className="stack-sm">
              {totalFlags.map(([code, count]) => {
                const max = totalFlags[0][1] || 1;
                return (
                  <div key={code} className="radar-legend-row" style={{ gridTemplateColumns: "130px 1fr 40px" }}>
                    <span>{FLAG_LABELS[code] ?? code}</span>
                    <div className="meter meter-red">
                      <i style={{ width: `${(count / max) * 100}%` }} />
                    </div>
                    <b className="num">{count}</b>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p className="note">還沒有累計資料。完成一次考試模擬後這裡會出現統計。</p>
        )}
      </section>

      {/* --- last run debrief ------------------------------------------------ */}
      {detail ? (
        <section className="stack">
          <div className="row-between">
            <div>
              <p className="eyebrow">最近一次考試 · 完整檢討</p>
              <h2>
                {getRuleSet(detail.record.ruleSetId).label} · {detail.record.symbol} {detail.record.interval}
              </h2>
            </div>
            <span className={`pill ${detail.record.status === "PASSED" ? "pill-green" : detail.record.status === "FAILED" ? "pill-red" : "pill-amber"}`}>
              {detail.record.status === "PASSED" ? "通過" : detail.record.status === "FAILED" ? "違規出局" : "未達標"}
            </span>
          </div>

          {detail.breachMessage && (
            <div className="banner bad"><span>✕</span><span>{detail.breachMessage}</span></div>
          )}

          <div className="grid-4">
            <div className="stat">
              <span>損益</span>
              <b className={`num ${detail.record.profit >= 0 ? "up" : "down"}`}>
                {detail.record.profit >= 0 ? "+" : ""}{detail.record.profit.toFixed(2)} U
              </b>
            </div>
            <div className="stat">
              <span>累計 R</span>
              <b className={`num ${detail.record.totalR >= 0 ? "up" : "down"}`}>{detail.record.totalR.toFixed(2)}R</b>
            </div>
            <div className="stat">
              <span>紀律分數</span>
              <b className="num">{detail.record.disciplineScore}</b>
            </div>
            <div className="stat">
              <span>勝率</span>
              <b className="num">
                {detail.trades.length
                  ? `${Math.round((detail.trades.filter((t) => t.pnl > 0).length / detail.trades.length) * 100)}%`
                  : "—"}
              </b>
              <i>{detail.trades.length} 筆</i>
            </div>
          </div>

          {detail.flags.length > 0 && (
            <div className="card stack">
              <p className="eyebrow">當次診斷</p>
              <div className="stack-sm">
                {detail.flags.map((flag) => (
                  <div key={flag.code} className={`flag sev-${flag.severity}`}>
                    <div className="row-between">
                      <h3>{flag.title}</h3>
                      <span className="pill pill-mute">
                        影響「{SKILLS.find((skill) => skill.id === flag.skill)?.label}」
                      </span>
                    </div>
                    <p className="evidence">{flag.evidence}</p>
                    <p className="coaching">{flag.coaching}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card card-flush">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>時間</th><th>方向</th><th className="num">進場</th><th className="num">出場</th>
                    <th>出場原因</th><th className="num">R</th><th className="num">損益</th>
                    <th className="num">最大浮盈</th><th className="num">持有</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.trades.map((trade) => (
                    <tr key={trade.id}>
                      <td className="dim">{stamp(trade.openedAt)}</td>
                      <td className={trade.side === "LONG" ? "up" : "down"}>{trade.side}</td>
                      <td className="num">{price(trade.entry)}</td>
                      <td className="num">{price(trade.exit)}</td>
                      <td className={trade.reason === "LIQUIDATION" || trade.reason === "RULE_FLATTEN" ? "down" : "dim"}>
                        {REASON_LABELS[trade.reason] ?? trade.reason}
                      </td>
                      <td className={`num ${trade.rMultiple >= 0 ? "up" : "down"}`}>{trade.rMultiple.toFixed(2)}</td>
                      <td className={`num ${trade.pnl >= 0 ? "up" : "down"}`}>{trade.pnl.toFixed(2)}</td>
                      <td className="num dim">{trade.mfeR.toFixed(2)}R</td>
                      <td className="num dim">{trade.holdBars}</td>
                    </tr>
                  ))}
                  {!detail.trades.length && (
                    <tr><td colSpan={9} className="dim">這次考試沒有成交任何交易。</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : (
        <div className="empty">
          <p>還沒有考試模擬紀錄。</p>
          <Link href="/exam" className="btn btn-primary">開始一次考試模擬 →</Link>
        </div>
      )}

      {/* --- run history ------------------------------------------------------ */}
      {runs.length > 0 && (
        <section className="card card-flush">
          <div style={{ padding: "16px 18px 0" }}>
            <p className="eyebrow">歷次考試</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>規則檔</th><th>市場</th><th>結果</th>
                  <th className="num">損益</th><th className="num">R</th>
                  <th className="num">紀律</th><th className="num">交易日</th><th>違規</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{getRuleSet(run.ruleSetId).label}</td>
                    <td className="dim">{run.symbol} {run.interval}</td>
                    <td>
                      <span className={`pill ${run.status === "PASSED" ? "pill-green" : run.status === "FAILED" ? "pill-red" : "pill-mute"}`}>
                        {run.status === "PASSED" ? "通過" : run.status === "FAILED" ? "出局" : "未達標"}
                      </span>
                    </td>
                    <td className={`num ${run.profit >= 0 ? "up" : "down"}`}>
                      {run.profit >= 0 ? "+" : ""}{run.profit.toFixed(0)}
                    </td>
                    <td className={`num ${run.totalR >= 0 ? "up" : "down"}`}>{run.totalR.toFixed(1)}</td>
                    <td className="num">{run.disciplineScore}</td>
                    <td className="num">{run.tradingDays}</td>
                    <td className="dim">{run.breach ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card stack">
        <p className="eyebrow">資料</p>
        <p className="note">
          你的進度只存在這台裝置的瀏覽器中。清除瀏覽器資料會一併清除訓練紀錄。
        </p>
        <button
          className="btn btn-danger btn-sm"
          style={{ justifySelf: "start" }}
          onClick={() => {
            if (window.confirm("確定要清除所有訓練進度嗎？這個動作無法復原。")) reset();
          }}
        >
          清除所有進度
        </button>
      </section>
    </main>
  );
}
