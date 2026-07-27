"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import GradeCard from "@/app/components/GradeCard";
import { BiasPanel, ChoicePanel, ExitPanel, SizingPanel, StopPanel } from "./panels";
import { useProfile } from "@/lib/store/profile.ts";
import { useSeed } from "@/lib/store/client.ts";
import { fetchCandles, INTERVALS } from "@/lib/market/client.ts";
import {
  DRILLS,
  generateBias,
  generateChoice,
  generateExit,
  generateSizing,
  generateStop,
  getDrill,
  gradeScenario,
  type AnyAnswer,
  type Grade,
  type Scenario,
} from "@/lib/engine/drills.ts";
import { MASTERY_STREAK, MASTERY_THRESHOLD, applyDrillOutcome } from "@/lib/engine/scoring.ts";
import { unlockedDrills } from "@/lib/engine/curriculum.ts";
import type { Candle, Interval } from "@/lib/engine/types.ts";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "LINKUSDT", "AVAXUSDT"];

type MarketData = { key: string; candles: Candle[]; error: string | null };
type Answered = { round: number; grade: Grade; chosenId: string | null };

export default function DrillRunner() {
  const params = useParams<{ drill: string }>();
  const drillId = typeof params.drill === "string" ? params.drill : DRILLS[0].id;
  const meta = getDrill(drillId);
  const { profile, ready, update } = useProfile();

  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [interval, setIntervalChoice] = useState<Interval>("15m");
  const [round, setRound] = useState(0);
  const [data, setData] = useState<MarketData | null>(null);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [session, setSession] = useState({ attempts: 0, total: 0 });

  // One stable seed per drill and round. `null` until the client mounts.
  const seed = useSeed(`${drillId}:${round}`);

  // Market data. Only the async continuation writes state, so there is no
  // synchronous setState inside the effect body.
  const marketKey = `${symbol}:${interval}`;
  useEffect(() => {
    if (!meta.needsMarket) return;
    let cancelled = false;
    void fetchCandles(symbol, interval).then((result) => {
      if (cancelled) return;
      setData({
        key: `${symbol}:${interval}`,
        candles: "error" in result ? [] : result.candles,
        error: "error" in result ? result.error : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [meta.needsMarket, symbol, interval]);

  // Stale data from a previous symbol must never be graded against.
  const market = data && data.key === marketKey ? data : null;
  const loadingMarket = meta.needsMarket && !market;

  // Scenario generation is pure, so it is a derivation rather than an effect.
  const scenario: Scenario | null = useMemo(() => {
    if (!seed) return null;
    if (meta.kind === "RULE_GUARD" || meta.kind === "TILT") return generateChoice(meta.kind, seed);
    if (meta.kind === "SIZING") return generateSizing(seed);
    if (!market?.candles.length) return null;
    if (meta.kind === "BIAS") return generateBias(seed, symbol, interval, market.candles);
    if (meta.kind === "STOP") return generateStop(seed, symbol, interval, market.candles);
    return generateExit(seed, symbol, interval, market.candles);
  }, [seed, meta.kind, market, symbol, interval]);

  // Keyed by round, so advancing the round clears the grade without an effect.
  const current = answered?.round === round ? answered : null;

  const submit = useCallback(
    (answer: AnyAnswer) => {
      if (!scenario || current) return;
      const grade = gradeScenario(scenario, answer);
      setAnswered({
        round,
        grade,
        chosenId:
          answer.kind === "RULE_GUARD" || answer.kind === "TILT" ? answer.value.choiceId : null,
      });
      setSession((state) => ({ attempts: state.attempts + 1, total: state.total + grade.score }));
      update((state) =>
        applyDrillOutcome(state, {
          drillId: meta.id,
          skill: meta.skill,
          score: grade.score,
          at: Date.now(),
        }),
      );
    },
    [scenario, current, round, update, meta.id, meta.skill],
  );

  const nextRound = useCallback(() => setRound((value) => value + 1), []);

  if (!ready) {
    return (
      <main className="empty">
        <p>載入中…</p>
      </main>
    );
  }

  if (!unlockedDrills(profile).includes(meta.id)) {
    return (
      <main className="stack">
        <div className="card stack">
          <p className="eyebrow">尚未解鎖</p>
          <h2>{meta.title}</h2>
          <p className="note">
            這個項目要先完成前面的訓練階段才會開放。順序是刻意的：在還不會計算部位之前練判讀，
            學到的東西沒辦法轉換成通過考試的能力。
          </p>
          <Link href="/train" className="btn" style={{ justifySelf: "start" }}>
            ← 回到訓練列表
          </Link>
        </div>
      </main>
    );
  }

  const record = profile.mastery[meta.id];
  const average = session.attempts ? session.total / session.attempts : null;
  const generationFailed = Boolean(seed) && !loadingMarket && !scenario && !market?.error;

  return (
    <main className="stack-lg">
      <header className="row-between">
        <div>
          <p className="eyebrow">
            <Link href="/train">訓練</Link> · {meta.title}
          </p>
          <h1>{meta.title}</h1>
          <p className="note" style={{ marginTop: 6, maxWidth: "72ch" }}>
            {meta.why}
          </p>
        </div>
        <div className="row">
          {average !== null && (
            <div className="stat stat-sm">
              <span>本次連續</span>
              <b className="num">{average.toFixed(0)}</b>
              <i>{session.attempts} 題平均</i>
            </div>
          )}
          {record && (
            <div className="stat stat-sm">
              <span>精熟進度</span>
              <b className="num">
                {Math.min(record.streak, MASTERY_STREAK)}/{MASTERY_STREAK}
              </b>
              <i>{record.mastered ? "已精熟" : `需連續 ${MASTERY_THRESHOLD} 分`}</i>
            </div>
          )}
        </div>
      </header>

      {meta.needsMarket && (
        <div className="card row" style={{ padding: 14 }}>
          <label className="field" style={{ minWidth: 180 }}>
            <span>合約</span>
            <select value={symbol} onChange={(event) => setSymbol(event.target.value)}>
              {SYMBOLS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 130 }}>
            <span>K 線週期</span>
            <select
              value={interval}
              onChange={(event) => setIntervalChoice(event.target.value as Interval)}
            >
              {INTERVALS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-sm btn-ghost" style={{ marginLeft: "auto" }} onClick={nextRound}>
            換一題
          </button>
        </div>
      )}

      {market?.error && (
        <div className="banner bad">
          <span>✕</span>
          <span>{market.error}</span>
        </div>
      )}
      {generationFailed && (
        <div className="banner">
          <span>!</span>
          <span>這段行情資料不足以產生訓練情境，請換一個合約、週期，或按「換一題」。</span>
        </div>
      )}

      {current ? (
        <GradeCard grade={current.grade} onNext={nextRound} nextLabel="下一題" />
      ) : loadingMarket ? (
        <div className="empty">
          <p>正在載入真實歷史 K 線…</p>
        </div>
      ) : !scenario ? (
        <div className="empty">
          <p>準備題目中…</p>
        </div>
      ) : scenario.kind === "BIAS" ? (
        <BiasPanel scenario={scenario} onAnswer={submit} />
      ) : scenario.kind === "STOP" ? (
        <StopPanel scenario={scenario} onAnswer={submit} />
      ) : scenario.kind === "EXIT" ? (
        <ExitPanel key={seed ?? "exit"} scenario={scenario} onAnswer={submit} />
      ) : scenario.kind === "SIZING" ? (
        <SizingPanel key={seed ?? "sizing"} scenario={scenario} onAnswer={submit} />
      ) : (
        <ChoicePanel scenario={scenario} onAnswer={submit} chosenId={null} />
      )}

      {/* Choice drills keep the question on screen beneath the grade so the
          learner can re-read the options against the explanation. */}
      {current && scenario && (scenario.kind === "RULE_GUARD" || scenario.kind === "TILT") && (
        <ChoicePanel scenario={scenario} onAnswer={submit} chosenId={current.chosenId} />
      )}
    </main>
  );
}
