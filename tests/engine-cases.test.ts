import test from "node:test";
import assert from "node:assert/strict";

import {
  ARCHETYPES,
  CASE_CONTEXT_BARS,
  archetypeMeta,
  caseAnchor,
  caseAtr,
  caseBiasScenario,
  caseHeadline,
  caseProblems,
  caseScenario,
  caseStopScenario,
  caseWindowRange,
  classifyWindow,
  describeCase,
  isContinuousTape,
  matchFor,
  priceText,
} from "../lib/engine/cases.ts";
import { CASE_PACK_CAPTURED_AT, CASE_PACK_SOURCE, CASE_STUDIES } from "../lib/market/casePack.ts";
import { DRILLS, biasTruth, exitBest, gradeStop, suggestStop } from "../lib/engine/drills.ts";
import type { Candle, Interval } from "../lib/engine/types.ts";

// ---------------------------------------------------------------------------
// Pack integrity
// ---------------------------------------------------------------------------

test("the pack ships teaching material", () => {
  assert.ok(CASE_STUDIES.length >= 6, "教材數量不足");
  assert.ok(CASE_PACK_SOURCE.length > 0, "教材必須標示資料來源");
  assert.ok(CASE_PACK_CAPTURED_AT > 1_600_000_000_000, "擷取時間看起來不合理");
});

test("every case passes its own validation", () => {
  for (const study of CASE_STUDIES) {
    assert.deepEqual(caseProblems(study), [], `${study.id} 沒有通過教材自我檢查`);
  }
});

test("every case still classifies as the archetype it claims", () => {
  // The load-bearing test. A window is only teaching material because it
  // demonstrates something; if the screen no longer sees that thing in it, the
  // label is a lie and the case has to be regenerated rather than shipped.
  for (const study of CASE_STUDIES) {
    const match = matchFor(
      study.candles,
      caseAnchor(study),
      study.horizon,
      study.archetype,
      study.visibleCount,
    );
    assert.ok(match, `${study.id} 不再符合 ${study.archetype}`);
    assert.equal(match.archetype, study.archetype);
  }
});

test("cases carry a live, unbroken 24/7 tape", () => {
  for (const study of CASE_STUDIES) {
    assert.ok(isContinuousTape(study.candles, study.interval), `${study.id} 的 K 線有缺口`);
    const atrPct = caseAtr(study) / study.candles[caseAnchor(study)].close;
    assert.ok(atrPct >= 0.0015, `${study.id} 的波動太低（${atrPct}），不足以產生情境`);
  }
});

test("every archetype is represented and no symbol is reused", () => {
  const covered = new Set(CASE_STUDIES.map((study) => study.archetype));
  for (const meta of ARCHETYPES) {
    assert.ok(covered.has(meta.id), `教材缺少 ${meta.id} 這一課`);
  }
  const symbols = CASE_STUDIES.map((study) => study.symbol);
  assert.equal(new Set(symbols).size, symbols.length, "同一個合約被用在多則教材上");
});

test("every archetype points at a drill that exists", () => {
  for (const meta of ARCHETYPES) {
    assert.ok(
      DRILLS.some((drill) => drill.id === meta.drill),
      `${meta.id} 指向不存在的題型 ${meta.drill}`,
    );
  }
});

test("the board snapshot on each case is coherent", () => {
  for (const study of CASE_STUDIES) {
    assert.ok(study.board.rank >= 1, `${study.id} 的榜單名次不合理`);
    assert.ok(Number.isFinite(study.board.changePct), `${study.id} 的漲跌幅不是數字`);
    assert.ok(study.board.quoteVolumeUsd > 0, `${study.id} 沒有成交額`);
    const range = caseWindowRange(study);
    assert.ok(range.from < range.decisionAt && range.decisionAt < range.to, `${study.id} 的時間軸不合理`);
  }
});

// ---------------------------------------------------------------------------
// The material itself
// ---------------------------------------------------------------------------

test("descriptions are derived, complete and finite", () => {
  for (const study of CASE_STUDIES) {
    const analysis = describeCase(study);
    assert.ok(analysis.observable.length >= 4, `${study.id} 的可觀察事實太少`);
    assert.ok(analysis.outcome.length >= 4, `${study.id} 的結果說明太少`);
    assert.ok(analysis.question.length > 0, `${study.id} 沒有提問`);
    for (const fact of [...analysis.observable, ...analysis.outcome]) {
      assert.ok(fact.value.length > 0, `${study.id} 的「${fact.label}」沒有數值`);
      assert.ok(!fact.value.includes("NaN"), `${study.id} 的「${fact.label}」算出 NaN`);
      assert.ok(!fact.value.includes("Infinity"), `${study.id} 的「${fact.label}」算出 Infinity`);
    }
    for (const line of analysis.lines) {
      assert.ok(Number.isFinite(line.price), `${study.id} 的「${line.label}」不是有效價格`);
    }
    assert.ok(caseHeadline(study).includes(study.base), `${study.id} 的標題沒有標出合約`);
  }
});

test("each case replays as a gradeable scenario of its stated kind", () => {
  for (const study of CASE_STUDIES) {
    const kind = archetypeMeta(study.archetype).kind;
    const scenario = caseScenario(study);
    assert.equal(scenario.kind, kind, `${study.id} 產生的情境類型不符`);
    assert.equal(scenario.visibleCount, CASE_CONTEXT_BARS);
    assert.equal(scenario.candles.length, study.visibleCount + study.horizon);
    assert.ok(scenario.atr > 0, `${study.id} 的 ATR 不是正數`);
  }
});

test("stop cases stay masterable", () => {
  // Same invariant the drills hold: if the best available answer cannot reach
  // the mastery threshold, the case is unteachable rather than hard.
  for (const study of CASE_STUDIES) {
    if (archetypeMeta(study.archetype).kind !== "STOP") continue;
    const scenario = caseStopScenario(study);
    const grade = gradeStop(scenario, { stop: suggestStop(scenario).price });
    assert.ok(grade.score >= 80, `${study.id} 的建議停損只拿到 ${grade.score} 分`);
  }
});

test("each case's lesson matches what its tape actually did", () => {
  for (const study of CASE_STUDIES) {
    const scenario = caseScenario(study);
    if (study.archetype === "CHASE_TOP") {
      assert.equal(scenario.kind, "BIAS");
      // The whole point of the case: the board's own top was not a long.
      assert.notEqual(biasTruth(caseBiasScenario(study)).answer, "LONG", `${study.id} 的追高案例其實有效`);
    }
    if (study.archetype === "RANGE_CHOP") {
      assert.equal(biasTruth(caseBiasScenario(study)).answer, "SKIP", `${study.id} 並不是真的震盪`);
    }
    if (study.archetype === "TREND_PULLBACK") {
      assert.equal(scenario.kind, "EXIT");
      assert.ok(
        scenario.kind === "EXIT" && exitBest(scenario).bestR >= 0.6,
        `${study.id} 的續攻幅度不足以拿來教出場`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Screening rules
// ---------------------------------------------------------------------------

function syntheticTape(count: number, step = 900_000): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let index = 0; index < count; index += 1) {
    const open = price;
    const close = price * 1.001;
    candles.push({
      time: 1_700_000_000_000 + index * step,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 10,
    });
    price = close;
  }
  return candles;
}

test("continuity check rejects a tape with a hole in it", () => {
  const interval: Interval = "15m";
  const candles = syntheticTape(40);
  assert.ok(isContinuousTape(candles, interval));
  const holed = candles.map((candle, index) =>
    index >= 20 ? { ...candle, time: candle.time + 900_000 } : candle,
  );
  assert.equal(isContinuousTape(holed, interval), false);
});

test("classification refuses windows it cannot describe", () => {
  const candles = syntheticTape(200);
  // A window whose anchor sits before the context bars cannot be described.
  assert.deepEqual(classifyWindow(candles, 10, 24), []);
  // Nor one whose horizon runs off the end of the tape.
  assert.deepEqual(classifyWindow(candles, candles.length - 2, 24), []);
});

test("a flat tape produces no teaching material", () => {
  // 0.1% bars: below the liveness floor the drills use, so nothing qualifies.
  const candles = syntheticTape(200);
  for (let anchor = CASE_CONTEXT_BARS - 1; anchor < candles.length - 25; anchor += 1) {
    assert.deepEqual(classifyWindow(candles, anchor, 24), [], `第 ${anchor} 根不該產生教材`);
  }
});

test("price formatting keeps sub-cent alt prices distinguishable", () => {
  assert.notEqual(priceText(0.00001234), priceText(0.00001235));
  assert.equal(priceText(1234.5678), "1234.57");
  assert.equal(priceText(Number.NaN), "—");
});
