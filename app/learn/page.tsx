"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import Chart, { type PriceLine } from "@/app/components/Chart";
import {
  ARCHETYPES,
  archetypeMeta,
  caseWindowRange,
  describeCase,
  type CaseStudy,
} from "@/lib/engine/cases.ts";
import { CASE_PACK_SOURCE, CASE_STUDIES } from "@/lib/market/casePack.ts";
import { getDrill } from "@/lib/engine/drills.ts";

const LINE_COLOURS: Record<string, string> = {
  ENTRY: "#cdf571",
  STRUCTURE: "#8ab4ff",
  STOP: "#7cebc0",
  NAIVE: "#fa7e8b",
};

const dateText = (ms: number) =>
  new Date(ms).toLocaleString("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** Cases in curriculum order, so the selector reads as a syllabus. */
const ORDERED: CaseStudy[] = ARCHETYPES.flatMap((meta) =>
  CASE_STUDIES.filter((study) => study.archetype === meta.id),
);

export default function LearnPage() {
  const [caseId, setCaseId] = useState(ORDERED[0]?.id ?? "");
  const [revealed, setRevealed] = useState(false);

  const study = ORDERED.find((item) => item.id === caseId) ?? ORDERED[0];
  const meta = archetypeMeta(study.archetype);
  const drill = getDrill(meta.drill);

  // Pure derivation, so switching cases needs no effect and no stale state.
  const analysis = useMemo(() => describeCase(study), [study]);
  const range = useMemo(() => caseWindowRange(study), [study]);

  const index = ORDERED.findIndex((item) => item.id === study.id);
  const go = (step: number) => {
    const next = ORDERED[(index + step + ORDERED.length) % ORDERED.length];
    setCaseId(next.id);
    // A new case must start hidden, or the lesson is spoiled before it is read.
    setRevealed(false);
  };

  const lines: PriceLine[] = analysis.lines.map((line) => ({
    price: line.price,
    label: line.label,
    color: LINE_COLOURS[line.role] ?? "#8ab4ff",
    dashed: line.role !== "ENTRY",
  }));

  const board = study.board;

  // Built as a string rather than as JSX fragments: the separators are
  // full-width and adjacent JSX expressions collapse their own whitespace.
  const subtitle = [
    `${study.base}／${study.interval}`,
    `${board.side === "GAINER" ? "漲幅榜" : "跌幅榜"}第 ${board.rank} 名` +
      `（24h ${board.changePct >= 0 ? "+" : ""}${board.changePct.toFixed(1)}%）`,
    `這段 K 線：${dateText(range.from)} – ${dateText(range.to)}`,
  ].join("　·　");

  return (
    <main className="viewport">
      <header className="row-between">
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="eyebrow">
            教材 · {meta.title} · {index + 1}/{ORDERED.length}
          </p>
          <h1>{analysis.question}</h1>
          <p className="note" style={{ marginTop: 6 }}>
            {subtitle}
          </p>
        </div>
        <div className="row" style={{ flex: "none" }}>
          <select
            aria-label="選擇案例"
            className="compact-select"
            value={study.id}
            onChange={(event) => {
              setCaseId(event.target.value);
              setRevealed(false);
            }}
          >
            {ARCHETYPES.map((item) => {
              const group = CASE_STUDIES.filter((entry) => entry.archetype === item.id);
              if (!group.length) return null;
              return (
                <optgroup key={item.id} label={item.title}>
                  {group.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {item.title} · {entry.base} {entry.interval}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
          <button className="btn btn-sm btn-ghost" onClick={() => go(-1)}>
            上一則
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => go(1)}>
            下一則
          </button>
          {/* The reveal lives in the header, not in the notes column. It is the
              one control every case needs, and a case with a longer list of
              observable facts would otherwise push it under the fold. */}
          <button
            className={revealed ? "btn btn-sm" : "btn btn-sm btn-primary"}
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? "收合後續" : `揭露後續 ${study.horizon} 根`}
          </button>
        </div>
      </header>

      <div className="split-wide grow">
        <div className="chart-column">
          <Chart
            candles={study.candles}
            visible={revealed ? study.candles.length : study.visibleCount}
            lines={lines}
            futureGapPx={revealed ? 16 : 108}
            fill
          />
        </div>

        {/* Keyed by case so switching one scrolls the notes back to the top
            instead of inheriting the previous case's scroll position. */}
        <aside key={study.id} className="stack pane">
          <div className="card stack-sm">
            <div className="row-between">
              <h3>這一課</h3>
              <span className="pill pill-lime">{meta.title}</span>
            </div>
            <p className="note">{meta.premise}</p>
            <div className="divider" />
            <p className="tiny">
              <b className="warn">賠錢的地方：</b>
              {meta.mistake}
            </p>
            <p className="tiny">
              <b className="accent">帶得走的規則：</b>
              {meta.rule}
            </p>
          </div>

          <div className="card stack-sm">
            <h3>決策當下看得到的</h3>
            <p className="tiny dim">
              只用揭露的 {study.visibleCount} 根 K 線算出來。這些是下單前就能知道的事。
            </p>
            {analysis.observable.map((fact) => (
              <div key={fact.label} className="stack-sm" style={{ gap: 3 }}>
                <div className="row-between">
                  <span className="tiny">{fact.label}</span>
                  <b className="num">{fact.value}</b>
                </div>
                {fact.note && <p className="tiny dim">{fact.note}</p>}
              </div>
            ))}
          </div>

          {revealed ? (
            <div className="card stack-sm">
              <div className="row-between">
                <h3>後續 {study.horizon} 根做了什麼</h3>
                <span className="pill pill-mute">已揭露</span>
              </div>
              {analysis.outcome.map((fact) => (
                <div key={fact.label} className="stack-sm" style={{ gap: 3 }}>
                  <div className="row-between">
                    <span className="tiny">{fact.label}</span>
                    <b className="num">{fact.value}</b>
                  </div>
                  {fact.note && <p className="tiny dim">{fact.note}</p>}
                </div>
              ))}
              <div className="divider" />
              <p className="tiny dim">
                後續發展是用來對照判斷的，不是用來評分的。同樣的決策換一段行情就會有不同結果，
                能練的是決策本身。
              </p>
              <Link href={`/train/${drill.id}`} className="btn btn-primary btn-lg">
                去練「{drill.title}」
              </Link>
            </div>
          ) : (
            <div className="card stack-sm">
              <h3>先自己判斷</h3>
              <p className="tiny">
                按上方的「揭露後續 {study.horizon} 根」之前，先回答標題那個問題：如果這是你的帳戶，
                你現在會做什麼、停損放哪裡、下多大的部位？想過再看答案，這一則才有訓練效果。
              </p>
            </div>
          )}

          <p className="tiny dim">
            資料來源：{CASE_PACK_SOURCE}。教材是歷史行情的教學範例，不是訊號、不是建議，
            也不代表這些合約接下來會怎麼走。
          </p>
        </aside>
      </div>
    </main>
  );
}
