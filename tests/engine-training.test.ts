import test from "node:test";
import assert from "node:assert/strict";

import { createRng, hashSeed, pick, randInt, shuffle } from "../lib/engine/rng.ts";
import { atr, forwardOutcome, readStructure, swingPoints } from "../lib/engine/indicators.ts";
import {
  DRILLS,
  biasTruth,
  exitBest,
  generateBias,
  generateChoice,
  generateExit,
  generateSizing,
  generateStop,
  suggestStop,
  gradeBias,
  gradeChoice,
  gradeExit,
  gradeSizing,
  gradeStop,
  sizingTruth,
  sliceWindow,
  syntheticAccount,
} from "../lib/engine/drills.ts";
import { diagnose, disciplineScore } from "../lib/engine/diagnostics.ts";
import {
  SKILLS,
  applyDrillOutcome,
  applyRunOutcome,
  createProfile,
  drillXp,
  levelOf,
  readiness,
  updateMastery,
  updateSkill,
} from "../lib/engine/scoring.ts";
import {
  STAGES,
  currentStage,
  dailyPlan,
  evaluationUnlocked,
  stageStates,
  unlockedDrills,
} from "../lib/engine/curriculum.ts";
import { getRuleSet } from "../lib/engine/propRules.ts";
import type { Candle, ClosedTrade, ProgressProfile } from "../lib/engine/types.ts";

const HOUR = 3_600_000;

/** Deterministic synthetic tape with a controllable drift. */
function series(count: number, options: { start?: number; drift?: number; noise?: number; seed?: string } = {}): Candle[] {
  const { start = 100, drift = 0, noise = 0.004, seed = "tape" } = options;
  const rng = createRng(seed);
  const candles: Candle[] = [];
  let price = start;
  for (let index = 0; index < count; index += 1) {
    const open = price;
    const shock = (rng() - 0.5) * 2 * noise;
    const close = open * (1 + drift + shock);
    const wick = Math.abs(open - close) + open * noise * rng();
    candles.push({
      time: index * HOUR,
      open,
      high: Math.max(open, close) + wick * 0.5,
      low: Math.min(open, close) - wick * 0.5,
      close,
      volume: 1000,
    });
    price = close;
  }
  return candles;
}

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

test("the same seed always produces the same sequence", () => {
  const a = Array.from({ length: 8 }, () => createRng("orbital")());
  const b = Array.from({ length: 8 }, () => createRng("orbital")());
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, Array.from({ length: 8 }, () => createRng("orbital-2")()));
});

test("rng output stays inside [0, 1)", () => {
  const rng = createRng(42);
  for (let index = 0; index < 2000; index += 1) {
    const value = rng();
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`);
  }
});

test("randInt covers its whole inclusive range", () => {
  const rng = createRng("range");
  const seen = new Set<number>();
  for (let index = 0; index < 500; index += 1) seen.add(randInt(rng, 1, 5));
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5]);
});

test("shuffle preserves the multiset and does not mutate the input", () => {
  const input = [1, 2, 3, 4, 5, 6];
  const output = shuffle(createRng("s"), input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...output].sort((a, b) => a - b), input);
});

test("hashSeed is stable and discriminating", () => {
  assert.equal(hashSeed("abc"), hashSeed("abc"));
  assert.notEqual(hashSeed("abc"), hashSeed("abd"));
});

test("pick rejects an empty list", () => {
  assert.throws(() => pick(createRng(1), []));
});

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

test("ATR of a constant tape is zero, and rises with range", () => {
  const flat: Candle[] = Array.from({ length: 20 }, (_, index) => ({
    time: index * HOUR, open: 100, high: 100, low: 100, close: 100, volume: 1,
  }));
  assert.equal(atr(flat, 19), 0);

  const wide = flat.map((candle) => ({ ...candle, high: 102, low: 98 }));
  assert.equal(atr(wide, 19), 4);
});

test("swing points find the obvious pivot", () => {
  const prices = [10, 11, 12, 15, 12, 11, 10];
  const candles: Candle[] = prices.map((price, index) => ({
    time: index * HOUR, open: price, high: price, low: price, close: price, volume: 1,
  }));
  const points = swingPoints(candles, 2);
  assert.equal(points.length, 1);
  assert.equal(points[0].kind, "HIGH");
  assert.equal(points[0].index, 3);
});

test("structure reads a strong uptrend as an uptrend", () => {
  const candles = series(80, { drift: 0.006, noise: 0.002, seed: "up" });
  assert.equal(readStructure(candles, candles.length - 1).bias, "UPTREND");
});

test("structure reads a strong downtrend as a downtrend", () => {
  const candles = series(80, { drift: -0.006, noise: 0.002, seed: "down" });
  assert.equal(readStructure(candles, candles.length - 1).bias, "DOWNTREND");
});

test("forwardOutcome resolves ties against the trader", () => {
  const candles: Candle[] = [
    { time: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { time: HOUR, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    // This bar reaches +2 and −2 in the same candle. A long must be told the
    // adverse side happened first.
    { time: 2 * HOUR, open: 100, high: 110, low: 90, close: 100, volume: 1 },
  ];
  const outcome = forwardOutcome(candles, 1, 2, "LONG", 1);
  assert.equal(outcome.resolvedFirst, "ADVERSE");
});

test("forwardOutcome reports NEITHER on a quiet tape", () => {
  const candles = series(40, { drift: 0, noise: 0.0005, seed: "quiet" });
  const outcome = forwardOutcome(candles, 20, 5, "LONG", 3);
  assert.equal(outcome.resolvedFirst, "NEITHER");
});

// ---------------------------------------------------------------------------
// Drill metadata
// ---------------------------------------------------------------------------

test("every drill has unique metadata and a stated purpose", () => {
  const ids = DRILLS.map((drill) => drill.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const drill of DRILLS) {
    assert.ok(drill.why.length > 20, `${drill.id} must explain why it matters`);
    assert.ok(SKILLS.some((skill) => skill.id === drill.skill));
  }
});

test("sliceWindow refuses a series that is too short", () => {
  assert.equal(sliceWindow(series(10), createRng("x"), 12), null);
});

test("sliceWindow leaves exactly `horizon` bars hidden", () => {
  const slice = sliceWindow(series(400, { seed: "slice" }), createRng("x"), 12);
  assert.ok(slice);
  if (!slice) return;
  assert.equal(slice.candles.length - slice.visibleCount, 12);
});

// ---------------------------------------------------------------------------
// BIAS
// ---------------------------------------------------------------------------

test("a bias scenario is reproducible from its seed", () => {
  const candles = series(400, { drift: 0.001, seed: "bias-tape" });
  const a = generateBias("seed-1", "BTCUSDT", "15m", candles);
  const b = generateBias("seed-1", "BTCUSDT", "15m", candles);
  assert.ok(a && b);
  if (!a || !b) return;
  assert.deepEqual(a.candles, b.candles);
});

test("bias grading rewards the correct side and punishes loud wrongness most", () => {
  const candles = series(400, { drift: 0.004, noise: 0.002, seed: "bias-up" });
  const scenario = generateBias("bias-seed", "BTCUSDT", "15m", candles, 12);
  assert.ok(scenario);
  if (!scenario) return;
  const truth = biasTruth(scenario).answer;

  const confidentRight = gradeBias(scenario, { choice: truth, confidence: 3 });
  const timidRight = gradeBias(scenario, { choice: truth, confidence: 1 });
  assert.ok(confidentRight.score > timidRight.score, "confidence should pay when you are right");

  const wrong = truth === "LONG" ? "SHORT" : "LONG";
  const confidentWrong = gradeBias(scenario, { choice: wrong, confidence: 3 });
  const timidWrong = gradeBias(scenario, { choice: wrong, confidence: 1 });
  assert.ok(confidentWrong.score < timidWrong.score, "confidence should cost when you are wrong");
  assert.ok(confidentRight.score > confidentWrong.score);
});

test("bias scores always land inside 0..100", () => {
  const candles = series(500, { drift: -0.002, seed: "bias-range" });
  for (let index = 0; index < 25; index += 1) {
    const scenario = generateBias(`s${index}`, "ETHUSDT", "1h", candles, 10);
    if (!scenario) continue;
    for (const choice of ["LONG", "SHORT", "SKIP"] as const) {
      for (const confidence of [1, 2, 3] as const) {
        const grade = gradeBias(scenario, { choice, confidence });
        assert.ok(grade.score >= 0 && grade.score <= 100, `score ${grade.score}`);
      }
    }
  }
});

test("skipping a genuine move scores above taking the wrong side", () => {
  const candles = series(400, { drift: 0.005, noise: 0.001, seed: "trend" });
  const scenario = generateBias("skip-seed", "BTCUSDT", "15m", candles, 12);
  assert.ok(scenario);
  if (!scenario) return;
  const truth = biasTruth(scenario).answer;
  if (truth === "SKIP") return; // fixture landed on chop; nothing to compare
  const wrong = truth === "LONG" ? "SHORT" : "LONG";
  const skipped = gradeBias(scenario, { choice: "SKIP", confidence: 2 });
  const reversed = gradeBias(scenario, { choice: wrong, confidence: 2 });
  assert.ok(skipped.score > reversed.score, "missing a move is cheaper than fading it");
});

// ---------------------------------------------------------------------------
// SIZING
// ---------------------------------------------------------------------------

test("the exact sizing answer scores full marks", () => {
  for (let index = 0; index < 20; index += 1) {
    const scenario = generateSizing(`size-${index}`);
    const truth = sizingTruth(scenario);
    if (truth.qty <= 0) continue;
    const grade = gradeSizing(scenario, { qty: truth.qty });
    assert.ok(grade.score >= 99, `expected full marks, got ${grade.score} on seed size-${index}`);
  }
});

test("a human-precision answer still scores full marks, including when the cap binds", () => {
  // Regression: the safety check used an absolute 1e-6 tolerance against a
  // boundary of ~87 U. A learner typing six decimals lost all 25 safety points
  // for the correct answer, capping capped-question scores at 75 — below the
  // mastery threshold, so those questions could never be cleared.
  let cappedSeen = 0;
  for (let index = 0; index < 40; index += 1) {
    const scenario = generateSizing(`human-${index}`);
    const truth = sizingTruth(scenario);
    if (truth.qty <= 0) continue;
    if (truth.cappedByRoom) cappedSeen += 1;
    // What someone actually types, rather than the exact float.
    const typed = Number(truth.qty.toPrecision(6));
    const grade = gradeSizing(scenario, { qty: typed });
    assert.ok(
      grade.score >= 99,
      `seed human-${index}${truth.cappedByRoom ? " (cap binds)" : ""}: typed ${typed} scored ${grade.score}`,
    );
  }
  assert.ok(cappedSeen > 0, "the fixture set must include capped scenarios or this proves nothing");
});

test("ignoring the room cap is still penalised", () => {
  // The tolerance above must not soften the actual lesson.
  let checked = 0;
  for (let index = 0; index < 40; index += 1) {
    const scenario = generateSizing(`ignore-${index}`);
    const truth = sizingTruth(scenario);
    if (!truth.cappedByRoom || truth.ideal.qty <= 0) continue;
    checked += 1;
    const grade = gradeSizing(scenario, { qty: truth.ideal.qty });
    assert.ok(grade.score < 80, `sizing to plan while the cap binds should not reach mastery, got ${grade.score}`);
  }
  assert.ok(checked > 0, "no capped scenarios were exercised");
});

test("over-sizing is punished harder than under-sizing by the same margin", () => {
  const scenario = generateSizing("asym");
  const truth = sizingTruth(scenario);
  assert.ok(truth.qty > 0);
  const over = gradeSizing(scenario, { qty: truth.qty * 1.2 });
  const under = gradeSizing(scenario, { qty: truth.qty * 0.8 });
  assert.ok(over.score < under.score, `over ${over.score} should be worse than under ${under.score}`);
});

test("sizing scenarios are reproducible and stay inside the rule set", () => {
  const a = generateSizing("repeat");
  const b = generateSizing("repeat");
  assert.equal(a.entry, b.entry);
  assert.equal(a.stop, b.stop);
  assert.equal(a.rules.id, b.rules.id);
  assert.equal(a.side === "LONG" ? a.stop < a.entry : a.stop > a.entry, true);
});

test("sizing truth is capped by the remaining limit room, not just the risk plan", () => {
  const rules = { ...getRuleSet("bootcamp-1k"), takerFee: 0, slippage: 0 };
  // Day started at 1,000 and we are already 36 U down against a 40 U limit.
  const account = syntheticAccount(rules, { equity: 964, dayStartEquity: 1000, dayIndex: 1, dayPnls: [] });
  const scenario = {
    kind: "SIZING" as const,
    id: "sizing",
    seed: "capped",
    rules,
    account,
    symbol: "BTCUSDT",
    side: "LONG" as const,
    entry: 100,
    stop: 99,
    riskPct: 0.01,
    situation: "",
  };
  const truth = sizingTruth(scenario);
  assert.ok(truth.cappedByRoom, "only 4 U of room remains; a 9.64 U risk is indefensible");
  // Room 4 U, one third of it is 1.333 U, over a 1.00 stop distance.
  assert.ok(Math.abs(truth.qty - 4 / 3) < 1e-6, `got ${truth.qty}`);
});

test("zero room means the correct answer is not to trade", () => {
  const rules = { ...getRuleSet("bootcamp-1k"), takerFee: 0, slippage: 0 };
  const account = syntheticAccount(rules, { equity: 960, dayStartEquity: 1000, dayIndex: 1, dayPnls: [] });
  const scenario = {
    kind: "SIZING" as const, id: "sizing", seed: "none", rules, account,
    symbol: "BTCUSDT", side: "LONG" as const, entry: 100, stop: 99, riskPct: 0.01, situation: "",
  };
  assert.equal(sizingTruth(scenario).qty, 0);
  assert.equal(gradeSizing(scenario, { qty: 0 }).score, 100);
  assert.equal(gradeSizing(scenario, { qty: 1 }).score, 0);
});

// ---------------------------------------------------------------------------
// STOP
// ---------------------------------------------------------------------------

test("a stop on the wrong side scores zero", () => {
  const candles = series(400, { seed: "stop-tape" });
  const scenario = generateStop("stop-1", "SOLUSDT", "15m", candles);
  assert.ok(scenario);
  if (!scenario) return;
  const wrongSide = scenario.side === "LONG" ? scenario.entry * 1.01 : scenario.entry * 0.99;
  assert.equal(gradeStop(scenario, { stop: wrongSide }).score, 0);
});

test("an absurdly tight stop scores below a sensible one", () => {
  const candles = series(400, { seed: "stop-tape-2" });
  const scenario = generateStop("stop-2", "SOLUSDT", "15m", candles);
  assert.ok(scenario);
  if (!scenario) return;
  const direction = scenario.side === "LONG" ? -1 : 1;
  const tight = gradeStop(scenario, { stop: scenario.entry + direction * scenario.atr * 0.1 });
  const sensible = gradeStop(scenario, { stop: scenario.entry + direction * scenario.atr * 1.4 });
  assert.ok(tight.score < sensible.score, `tight ${tight.score} vs sensible ${sensible.score}`);
});

test("placement is penalised for being both too tight and too wide", () => {
  const candles = series(400, { seed: "stop-tape-3" });
  const scenario = generateStop("stop-3", "SOLUSDT", "15m", candles);
  assert.ok(scenario);
  if (!scenario) return;
  const direction = scenario.side === "LONG" ? -1 : 1;
  const ideal = suggestStop(scenario).atrUnits;
  const placement = (multiple: number) =>
    gradeStop(scenario, { stop: scenario.entry + direction * scenario.atr * multiple })
      .breakdown.find((item) => item.label === "位置")!.points;

  assert.ok(placement(ideal) > placement(ideal * 0.3), "a stop far inside the noise must score less");
  assert.ok(placement(ideal) > placement(ideal * 3), "a stop three times too wide must score less");
  assert.equal(placement(ideal), 70, "the reconciled stop should take the full placement mark");
});

test("across many tapes, sensible stops beat absurd ones on average", () => {
  let sensibleTotal = 0;
  let absurdTotal = 0;
  let counted = 0;
  for (let index = 0; index < 30; index += 1) {
    const candles = series(400, { seed: `agg-${index}`, drift: (index % 5) * 0.0015 - 0.003 });
    const scenario = generateStop(`agg-sc-${index}`, "SOLUSDT", "15m", candles);
    if (!scenario) continue;
    const direction = scenario.side === "LONG" ? -1 : 1;
    sensibleTotal += gradeStop(scenario, { stop: scenario.entry + direction * scenario.atr * 1.4 }).score;
    absurdTotal += gradeStop(scenario, { stop: scenario.entry + direction * scenario.atr * 9 }).score;
    counted += 1;
  }
  assert.ok(counted > 10, "the fixture set must actually produce scenarios");
  assert.ok(
    sensibleTotal / counted > absurdTotal / counted,
    `sensible ${(sensibleTotal / counted).toFixed(1)} vs absurd ${(absurdTotal / counted).toFixed(1)}`,
  );
});

test("every stop scenario is masterable", () => {
  // Regression: grading structure, noise-clearance and efficiency as three
  // independent components made them mutually unsatisfiable whenever the
  // nearest swing sat inside the noise band. Across 120 generated scenarios
  // the best achievable score fell below the 80 mastery threshold on 38% of
  // them — the learner could pick the single best stop on the slider and still
  // be unable to progress. A drill nobody can clear is not a hard drill.
  let checked = 0;
  for (let index = 0; index < 60; index += 1) {
    const candles = series(400, { seed: `masterable-${index}`, drift: ((index % 5) - 2) * 0.0015 });
    const scenario = generateStop(`ms-${index}`, "SOLUSDT", "15m", candles);
    if (!scenario) continue;
    checked += 1;
    const direction = scenario.side === "LONG" ? -1 : 1;
    let best = 0;
    for (let multiple = 0.2; multiple <= 5.001; multiple += 0.05) {
      const score = gradeStop(scenario, {
        stop: scenario.entry + direction * scenario.atr * multiple,
      }).score;
      if (score > best) best = score;
    }
    assert.ok(best >= 80, `seed ms-${index}: best achievable score is only ${best}`);
  }
  assert.ok(checked > 30, `expected a real sample, only exercised ${checked}`);
});

test("the suggested stop is itself a top answer", () => {
  for (let index = 0; index < 40; index += 1) {
    const candles = series(400, { seed: `suggest-${index}`, drift: ((index % 4) - 2) * 0.002 });
    const scenario = generateStop(`sg-${index}`, "SOLUSDT", "15m", candles);
    if (!scenario) continue;
    const grade = gradeStop(scenario, { stop: suggestStop(scenario).price });
    assert.ok(grade.score >= 95, `following the suggestion scored only ${grade.score}`);
    assert.equal(grade.suggestion, undefined, "a top answer should not be handed a correction");
  }
});

test("a stop that misses the mark is told where to aim", () => {
  const candles = series(400, { seed: "advice" });
  const scenario = generateStop("advice", "SOLUSDT", "15m", candles);
  assert.ok(scenario);
  if (!scenario) return;
  const direction = scenario.side === "LONG" ? -1 : 1;
  // Deliberately far too tight.
  const grade = gradeStop(scenario, { stop: scenario.entry + direction * scenario.atr * 0.1 });
  assert.ok(grade.score < 80);
  assert.ok(grade.suggestion, "a failing answer must carry a suggestion");
  assert.ok(grade.suggestion!.value.includes("ATR"), "the suggestion should be actionable");
  assert.ok(grade.suggestion!.why.length > 15, "the suggestion should explain itself");
});

test("stop grading ignores what happened after the decision", () => {
  // The same decision must score the same regardless of the hidden bars, or
  // the drill is scoring luck. Only the future differs between these two.
  const base = series(400, { seed: "path" });
  const scenario = generateStop("path", "SOLUSDT", "15m", base);
  assert.ok(scenario);
  if (!scenario) return;
  const anchor = scenario.visibleCount - 1;
  const wrecked = {
    ...scenario,
    candles: scenario.candles.map((candle, index) =>
      index > anchor
        ? { ...candle, low: candle.low * 0.8, high: candle.high * 0.8, close: candle.close * 0.8, open: candle.open * 0.8 }
        : candle,
    ),
  };
  const stop = suggestStop(scenario).price;
  assert.equal(gradeStop(scenario, { stop }).score, gradeStop(wrecked, { stop }).score);
});

test("stop grades stay inside 0..100 across many tapes", () => {
  for (let index = 0; index < 20; index += 1) {
    const candles = series(400, { seed: `stop-${index}`, drift: (index % 3) * 0.002 - 0.002 });
    const scenario = generateStop(`sc-${index}`, "SOLUSDT", "15m", candles);
    if (!scenario) continue;
    const direction = scenario.side === "LONG" ? -1 : 1;
    for (const multiple of [0.2, 1, 2, 5]) {
      const grade = gradeStop(scenario, { stop: scenario.entry + direction * scenario.atr * multiple });
      assert.ok(grade.score >= 0 && grade.score <= 100, `score ${grade.score}`);
      assert.equal(grade.breakdown.reduce((sum, item) => sum + item.max, 0), 100);
    }
  }
});

// ---------------------------------------------------------------------------
// EXIT
// ---------------------------------------------------------------------------

test("exitBest never looks past the stop-out", () => {
  const candles: Candle[] = [
    ...Array.from({ length: 60 }, (_, index) => ({
      time: index * HOUR, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1,
    })),
    { time: 60 * HOUR, open: 100, high: 100, low: 80, close: 80, volume: 1 }, // stop taken out
    { time: 61 * HOUR, open: 80, high: 200, low: 80, close: 200, volume: 1 }, // moon, but too late
  ];
  const scenario = {
    kind: "EXIT" as const, id: "exit", seed: "s", symbol: "BTCUSDT", interval: "15m" as const,
    candles, visibleCount: 60, structure: readStructure(candles, 59), atr: 1,
    side: "LONG" as const, entry: 100, stop: 95, horizon: 2,
  };
  assert.equal(exitBest(scenario).bestR, 0, "a move after the stop was never available to you");
});

test("giving back a large winner scores worse than banking part of it", () => {
  const candles = series(400, { drift: 0.004, seed: "exit-tape" });
  const scenario = generateExit("exit-1", "BTCUSDT", "15m", candles);
  assert.ok(scenario);
  if (!scenario) return;
  const best = exitBest(scenario).bestR;
  if (best < 1.5) return; // fixture did not produce a runner
  const gaveBack = gradeExit(scenario, { closedIndex: scenario.candles.length - 1, realisedR: -1, stoppedOut: true });
  const banked = gradeExit(scenario, { closedIndex: scenario.visibleCount + 3, realisedR: best * 0.6, stoppedOut: false });
  assert.ok(banked.score > gaveBack.score);
  assert.equal(gaveBack.breakdown[1].points, 0, "letting a 1R+ winner become a loss must zero the timing score");
});

test("on a trade that never worked, losing small scores well", () => {
  const candles: Candle[] = Array.from({ length: 90 }, (_, index) => ({
    time: index * HOUR, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1,
  }));
  const scenario = {
    kind: "EXIT" as const, id: "exit", seed: "s", symbol: "BTCUSDT", interval: "15m" as const,
    candles, visibleCount: 60, structure: readStructure(candles, 59), atr: 1,
    side: "LONG" as const, entry: 100, stop: 98.8, horizon: 24,
  };
  const small = gradeExit(scenario, { closedIndex: 70, realisedR: -0.15, stoppedOut: false });
  const full = gradeExit(scenario, { closedIndex: 84, realisedR: -1, stoppedOut: true });
  assert.ok(small.score > full.score);
});

// ---------------------------------------------------------------------------
// Choice drills
// ---------------------------------------------------------------------------

test("rule-guard scenarios are well formed and reproducible", () => {
  for (let index = 0; index < 40; index += 1) {
    const seed = `guard-${index}`;
    const scenario = generateChoice("RULE_GUARD", seed);
    const repeat = generateChoice("RULE_GUARD", seed);
    assert.equal(scenario.question, repeat.question, "same seed must give the same question");
    assert.equal(scenario.options.length, 4);
    assert.equal(new Set(scenario.options.map((option) => option.id)).size, 4);
    assert.ok(scenario.options.some((option) => option.id === scenario.correctId), "the correct id must exist");
    assert.ok(scenario.explanation.length > 40, "every answer needs a real explanation");
    assert.ok(scenario.situation.includes("U"), "the situation must quote live numbers");
  }
});

test("tilt scenarios are well formed", () => {
  for (let index = 0; index < 30; index += 1) {
    const scenario = generateChoice("TILT", `tilt-${index}`);
    assert.equal(scenario.options.length, 4);
    assert.ok(scenario.options.some((option) => option.id === scenario.correctId));
    assert.ok(scenario.explanation.length > 40);
  }
});

test("choice grading is all-or-nothing and names the right answer", () => {
  const scenario = generateChoice("RULE_GUARD", "grade-me");
  assert.equal(gradeChoice(scenario, scenario.correctId).score, 100);
  const wrong = scenario.options.find((option) => option.id !== scenario.correctId)!;
  const grade = gradeChoice(scenario, wrong.id);
  assert.equal(grade.score, 0);
  const answer = scenario.options.find((option) => option.id === scenario.correctId)!;
  assert.ok(grade.breakdown[0].note.includes(answer.label));
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function trade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    id: "t1", side: "LONG", entry: 100, exit: 99, qty: 1, leverage: 1,
    initialStop: 99, plannedRiskUsd: 10, equityAtOpen: 1000, bindingRoomAtOpen: 100,
    openedAt: 0, closedAt: HOUR, openedIndex: 0, closedIndex: 1, holdBars: 1,
    reason: "STOP", grossPnl: -10, fees: 0, funding: 0, pnl: -10, rMultiple: -1,
    mfeR: 0, maeR: 1, stopMoves: 0, stopWidenings: 0, dayIndex: 0, tags: [],
    ...overrides,
  };
}

function accountWith(trades: ClosedTrade[], ruleSetId = "bootcamp-1k") {
  const rules = getRuleSet(ruleSetId);
  return { ...syntheticAccount(rules, { equity: 1000, dayStartEquity: 1000, dayIndex: 0, dayPnls: [] }), trades };
}

test("a clean trade log produces no diagnostics", () => {
  const clean = [
    trade({ id: "a", pnl: 12, rMultiple: 1.2, reason: "TARGET", mfeR: 1.3 }),
    trade({ id: "b", pnl: -10, rMultiple: -1 }),
    trade({ id: "c", pnl: 20, rMultiple: 2, reason: "TARGET", mfeR: 2.1 }),
  ];
  assert.deepEqual(diagnose(accountWith(clean)), []);
  assert.equal(disciplineScore([]), 100);
});

test("trading without a stop is flagged at maximum severity", () => {
  const flags = diagnose(accountWith([trade({ initialStop: null, plannedRiskUsd: 0 })]));
  const flag = flags.find((item) => item.code === "NO_STOP");
  assert.ok(flag);
  assert.equal(flag?.severity, 3);
});

test("revenge trading needs both the timing and the size increase", () => {
  const timingOnly = diagnose(accountWith([
    trade({ id: "a", pnl: -10, closedIndex: 5 }),
    trade({ id: "b", openedIndex: 6, plannedRiskUsd: 10 }),
  ]));
  assert.ok(!timingOnly.some((flag) => flag.code === "REVENGE"), "same size is not revenge");

  const both = diagnose(accountWith([
    trade({ id: "a", pnl: -10, closedIndex: 5 }),
    trade({ id: "b", openedIndex: 6, plannedRiskUsd: 40 }),
  ]));
  assert.ok(both.some((flag) => flag.code === "REVENGE"));
});

test("a losing streak with escalating size is a tilt spiral", () => {
  const flags = diagnose(accountWith([
    trade({ id: "a", pnl: -10, plannedRiskUsd: 10, openedIndex: 0, closedIndex: 1 }),
    trade({ id: "b", pnl: -20, plannedRiskUsd: 20, openedIndex: 20, closedIndex: 21 }),
    trade({ id: "c", pnl: -40, plannedRiskUsd: 40, openedIndex: 40, closedIndex: 41 }),
  ]));
  assert.ok(flags.some((flag) => flag.code === "TILT_SPIRAL"));
});

test("a losing streak with shrinking size is not a tilt spiral", () => {
  const flags = diagnose(accountWith([
    trade({ id: "a", pnl: -40, plannedRiskUsd: 40, openedIndex: 0, closedIndex: 1 }),
    trade({ id: "b", pnl: -20, plannedRiskUsd: 20, openedIndex: 20, closedIndex: 21 }),
    trade({ id: "c", pnl: -10, plannedRiskUsd: 10, openedIndex: 40, closedIndex: 41 }),
  ]));
  assert.ok(!flags.some((flag) => flag.code === "TILT_SPIRAL"), "reducing size after losses is correct behaviour");
});

test("widening a stop is flagged", () => {
  const flags = diagnose(accountWith([trade({ stopWidenings: 1, stopMoves: 1 })]));
  assert.ok(flags.some((flag) => flag.code === "STOP_WIDENED"));
});

test("cutting a winner short is flagged only on a manual exit", () => {
  const manual = diagnose(accountWith([trade({ reason: "MANUAL", rMultiple: 0.2, mfeR: 2, pnl: 2 })]));
  assert.ok(manual.some((flag) => flag.code === "CUT_WINNER"));
  const stopped = diagnose(accountWith([trade({ reason: "STOP", rMultiple: 0.2, mfeR: 2, pnl: 2 })]));
  assert.ok(!stopped.some((flag) => flag.code === "CUT_WINNER"));
});

test("betting more than half the remaining room is limit roulette", () => {
  const flags = diagnose(accountWith([trade({ plannedRiskUsd: 60, bindingRoomAtOpen: 100 })]));
  assert.ok(flags.some((flag) => flag.code === "LIMIT_ROULETTE"));
  const safe = diagnose(accountWith([trade({ plannedRiskUsd: 20, bindingRoomAtOpen: 100 })]));
  assert.ok(!safe.some((flag) => flag.code === "LIMIT_ROULETTE"));
});

test("trading after the target is reached is flagged", () => {
  const rules = getRuleSet("bootcamp-1k");
  const past = rules.initialBalance * (1 + rules.profitTarget) + 5;
  const flags = diagnose(accountWith([trade({ equityAtOpen: past, plannedRiskUsd: 10 })]));
  assert.ok(flags.some((flag) => flag.code === "POST_TARGET_GREED"));
});

test("diagnostics are sorted by severity and every flag carries evidence", () => {
  const flags = diagnose(accountWith([
    trade({ id: "a", initialStop: null, plannedRiskUsd: 0 }),
    trade({ id: "b", reason: "MANUAL", rMultiple: 0.2, mfeR: 2, pnl: 2 }),
  ]));
  assert.ok(flags.length >= 2);
  for (let index = 1; index < flags.length; index += 1) {
    assert.ok(flags[index - 1].severity >= flags[index].severity);
  }
  for (const flag of flags) {
    assert.ok(flag.evidence.length > 10, `${flag.code} needs evidence`);
    assert.ok(flag.coaching.length > 20, `${flag.code} needs coaching`);
    assert.ok(flag.tradeIds.every((id) => typeof id === "string"));
  }
});

test("the discipline score falls as severe flags accumulate and never goes negative", () => {
  const one = disciplineScore(diagnose(accountWith([trade({ initialStop: null, plannedRiskUsd: 0 })])));
  assert.ok(one < 100 && one > 0);
  const many = disciplineScore(diagnose(accountWith(
    Array.from({ length: 12 }, (_, index) => trade({
      id: `t${index}`, initialStop: null, plannedRiskUsd: 0, stopWidenings: 1,
      pnl: -30, dayIndex: 0, openedIndex: index * 2, closedIndex: index * 2 + 1,
    })),
  )));
  assert.ok(many >= 0);
  assert.ok(many < one);
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

test("skill updates move fast early and slow later", () => {
  const early = updateSkill(40, 100, 0);
  const late = updateSkill(40, 100, 20);
  assert.ok(early > late, "a beginner should converge quickly");
  assert.ok(updateSkill(40, 100, 0) <= 100 && updateSkill(40, 0, 0) >= 0);
});

test("mastery needs three consecutive passes and is not lost afterwards", () => {
  let record = updateMastery(undefined, 95, 1);
  assert.equal(record.mastered, false);
  record = updateMastery(record, 90, 2);
  assert.equal(record.mastered, false);
  record = updateMastery(record, 85, 3);
  assert.equal(record.mastered, true);
  record = updateMastery(record, 10, 4);
  assert.equal(record.streak, 0, "a bad attempt breaks the streak");
  assert.equal(record.mastered, true, "but demonstrated mastery is not revoked");
});

test("one lucky attempt does not confer mastery", () => {
  let record = updateMastery(undefined, 100, 1);
  record = updateMastery(record, 20, 2);
  record = updateMastery(record, 100, 3);
  assert.equal(record.mastered, false);
});

test("levels are monotonic and XP thresholds increase", () => {
  let previous = -1;
  for (const xp of [0, 100, 250, 800, 5000, 50_000]) {
    const level = levelOf(xp).level;
    assert.ok(level >= previous, "levels must not go backwards as XP rises");
    previous = level;
  }
  assert.equal(levelOf(0).level, 1);
  assert.equal(levelOf(249).level, 1);
  assert.equal(levelOf(250).level, 2);
  assert.ok(levelOf(1_000_000).level <= 60);
});

test("XP rewards quality, not participation", () => {
  assert.ok(drillXp(100) > drillXp(80));
  assert.ok(drillXp(80) > drillXp(55));
  assert.equal(drillXp(20), drillXp(40), "everything below the pass mark is a flat consolation");
});

test("a drill outcome raises XP, the matching skill, and the drill count", () => {
  const before = createProfile();
  const after = applyDrillOutcome(before, { drillId: "sizing", skill: "SIZING", score: 90, at: Date.parse("2026-07-27T10:00:00Z") });
  assert.ok(after.xp > before.xp);
  assert.ok(after.skills.SIZING > before.skills.SIZING);
  assert.equal(after.skills.READ, before.skills.READ, "unrelated skills must not drift");
  assert.equal(after.drillsCompleted, 1);
  assert.equal(after.streakDays, 1);
});

test("the daily streak extends across consecutive days and resets after a gap", () => {
  const day1 = Date.parse("2026-07-20T10:00:00Z");
  let profile = applyDrillOutcome(createProfile(), { drillId: "sizing", skill: "SIZING", score: 80, at: day1 });
  profile = applyDrillOutcome(profile, { drillId: "sizing", skill: "SIZING", score: 80, at: day1 + 3_600_000 });
  assert.equal(profile.streakDays, 1, "two drills on one day is still one day");

  profile = applyDrillOutcome(profile, { drillId: "sizing", skill: "SIZING", score: 80, at: day1 + 86_400_000 });
  assert.equal(profile.streakDays, 2);

  profile = applyDrillOutcome(profile, { drillId: "sizing", skill: "SIZING", score: 80, at: day1 + 5 * 86_400_000 });
  assert.equal(profile.streakDays, 1, "a missed day resets the streak");
});

test("a failed run with severe flags lowers ratings; a clean pass raises them", () => {
  const base = createProfile();
  const failed = applyRunOutcome(base, {
    id: "r1", ruleSetId: "bootcamp-1k", symbol: "BTCUSDT", interval: "15m", status: "FAILED",
    profit: -80, profitPct: -0.08, tradingDays: 2, trades: 9, totalR: -5,
    breach: "DAILY_LOSS", disciplineScore: 30, finishedAt: Date.now(),
  }, diagnose(accountWith([trade({ initialStop: null, plannedRiskUsd: 0 })])));
  assert.ok(failed.skills.DISCIPLINE < base.skills.DISCIPLINE);

  const passed = applyRunOutcome(base, {
    id: "r2", ruleSetId: "bootcamp-1k", symbol: "BTCUSDT", interval: "15m", status: "PASSED",
    profit: 80, profitPct: 0.08, tradingDays: 5, trades: 12, totalR: 6,
    breach: null, disciplineScore: 95, finishedAt: Date.now(),
  }, []);
  assert.ok(passed.skills.DISCIPLINE > base.skills.DISCIPLINE);
  assert.ok(passed.xp > failed.xp);
});

test("run history is capped so a profile cannot grow without bound", () => {
  let profile = createProfile();
  for (let index = 0; index < 60; index += 1) {
    profile = applyRunOutcome(profile, {
      id: `r${index}`, ruleSetId: "bootcamp-1k", symbol: "BTCUSDT", interval: "15m", status: "COMPLETE" as never,
      profit: 0, profitPct: 0, tradingDays: 1, trades: 1, totalR: 0,
      breach: null, disciplineScore: 70, finishedAt: Date.now(),
    }, []);
  }
  assert.equal(profile.runHistory.length, 40);
});

test("readiness weights risk competencies above market reading", () => {
  const reader: ProgressProfile = { ...createProfile(), skills: { READ: 100, SIZING: 20, DISCIPLINE: 20, PATIENCE: 20, CONSISTENCY: 20 } };
  const risker: ProgressProfile = { ...createProfile(), skills: { READ: 20, SIZING: 100, DISCIPLINE: 100, PATIENCE: 100, CONSISTENCY: 100 } };
  assert.ok(readiness(risker).score > readiness(reader).score, "risk skills must dominate the readiness score");
});

test("readiness will not say you are ready without simulated passes", () => {
  const skilled: ProgressProfile = {
    ...createProfile(),
    drillsCompleted: 50,
    skills: { READ: 95, SIZING: 95, DISCIPLINE: 95, PATIENCE: 95, CONSISTENCY: 95 },
  };
  assert.notEqual(readiness(skilled).band, "可以進場考試", "ratings alone are not evidence");

  const proven: ProgressProfile = {
    ...skilled,
    runHistory: [1, 2].map((index) => ({
      id: `r${index}`, ruleSetId: "crypto-2step-p1", symbol: "BTCUSDT", interval: "15m" as const,
      status: "PASSED" as const, profit: 800, profitPct: 0.08, tradingDays: 5, trades: 14,
      totalR: 8, breach: null, disciplineScore: 92, finishedAt: Date.now(),
    })),
  };
  assert.equal(readiness(proven).band, "可以進場考試");
});

test("a brand new profile reports as not started and names a first gap", () => {
  const result = readiness(createProfile());
  assert.equal(result.band, "尚未開始");
  assert.ok(result.gaps.length > 0);
  assert.ok(result.score >= 0 && result.score <= 100);
});

// ---------------------------------------------------------------------------
// Curriculum
// ---------------------------------------------------------------------------

test("stages are ordered, uniquely named, and reference real drills", () => {
  const ids = STAGES.map((stage) => stage.id);
  assert.equal(new Set(ids).size, ids.length);
  STAGES.forEach((stage, index) => {
    assert.equal(stage.order, index + 1);
    for (const drillId of [...stage.drills, ...stage.required]) {
      assert.ok(DRILLS.some((drill) => drill.id === drillId), `unknown drill ${drillId} in ${stage.id}`);
    }
    if (stage.requires.stage) {
      assert.ok(ids.includes(stage.requires.stage));
      assert.ok(ids.indexOf(stage.requires.stage) < index, "a stage may only depend on an earlier one");
    }
  });
});

test("a new learner starts on stage one with only sizing unlocked", () => {
  const profile = createProfile();
  const states = stageStates(profile);
  assert.equal(states[0].unlocked, true);
  assert.equal(states[1].unlocked, false);
  assert.deepEqual(unlockedDrills(profile), ["sizing"]);
  assert.equal(currentStage(profile).stage.id, "foundations");
  assert.equal(evaluationUnlocked(profile), false);
});

test("mastering a stage unlocks the next one", () => {
  let profile = createProfile();
  for (let index = 0; index < 5; index += 1) {
    profile = applyDrillOutcome(profile, {
      drillId: "sizing", skill: "SIZING", score: 95, at: Date.now() + index * 86_400_000,
    });
  }
  assert.equal(profile.mastery.sizing.mastered, true);
  const states = stageStates(profile);
  assert.equal(states[0].cleared, true);
  assert.equal(states[1].unlocked, true, "invalidation should open once sizing is mastered");
  assert.ok(unlockedDrills(profile).includes("stop"));
});

test("mastering a stage always unlocks the next one, however long it took", () => {
  // Regression: unlocking required BOTH the previous stage cleared AND a skill
  // rating threshold. Mastery is three consecutive 80s, but the rating is a
  // lagging EWMA, so a learner who struggled before getting there could be
  // told a stage was cleared and still find the next one locked behind a
  // number they had no direct way to move.
  const paths: Array<[string, number[]]> = [
    ["straight to it", [80, 80, 80]],
    ["a few misses first", [30, 25, 40, 35, 45, 50, 55, 60, 80, 80, 80]],
    ["a long struggle", [...new Array(20).fill(20), 80, 80, 80]],
    ["a very long struggle", [...new Array(25).fill(10), 85, 85, 85]],
  ];

  for (const [label, scores] of paths) {
    let profile = createProfile();
    scores.forEach((score, index) => {
      profile = applyDrillOutcome(profile, {
        drillId: "sizing", skill: "SIZING", score, at: Date.now() + index * 86_400_000,
      });
    });
    assert.equal(profile.mastery.sizing.mastered, true, `${label}: fixture should reach mastery`);

    const states = stageStates(profile);
    assert.equal(states[0].cleared, true, `${label}: stage one should be cleared`);
    assert.equal(
      states[1].unlocked,
      true,
      `${label}: stage two locked despite a cleared stage one (SIZING ${profile.skills.SIZING.toFixed(0)})`,
    );
    assert.deepEqual(states[1].blockers, [], `${label}: a cleared stage should leave no blockers`);
  }
});

test("strong ratings open a stage without grinding the earlier drill", () => {
  // The rating route is the alternative, not a second hurdle.
  const capable: ProgressProfile = {
    ...createProfile(),
    skills: { READ: 90, SIZING: 90, DISCIPLINE: 90, PATIENCE: 90, CONSISTENCY: 90 },
  };
  assert.equal(stageStates(capable)[1].unlocked, true);
});

test("a learner with neither route open stays locked, and is told both", () => {
  const states = stageStates(createProfile());
  assert.equal(states[1].unlocked, false);
  assert.equal(states[1].blockers.length, 1);
  assert.match(states[1].blockers[0], /完成/);
  assert.match(states[1].blockers[0], /或/, "the alternative route should be spelled out");
});

test("the rating shortcut does not open the final evaluation", () => {
  // Ratings are an average; the capstone tests consistency, so it takes the
  // ladder. The shortcut exists to stop intermediate stages deadlocking, not
  // to let anyone skip to the exam.
  const capable: ProgressProfile = {
    ...createProfile(),
    skills: { READ: 99, SIZING: 99, DISCIPLINE: 99, PATIENCE: 99, CONSISTENCY: 99 },
  };
  assert.equal(evaluationUnlocked(capable), false);
  const exam = stageStates(capable).find((state) => state.stage.unlocksEvaluation)!;
  assert.ok(exam.blockers.length > 0);
  assert.ok(!exam.blockers[0].includes("或"), "the exam must not advertise a shortcut it does not honour");
});

test("the evaluation simulator stays locked until the ladder is cleared", () => {
  const halfway: ProgressProfile = {
    ...createProfile(),
    skills: { READ: 90, SIZING: 90, DISCIPLINE: 90, PATIENCE: 90, CONSISTENCY: 90 },
  };
  assert.equal(evaluationUnlocked(halfway), false, "ratings without mastery must not unlock the exam");

  const mastered: ProgressProfile = {
    ...halfway,
    mastery: Object.fromEntries(
      ["sizing", "stop", "bias", "exit", "rule-guard", "tilt"].map((id) => [
        id, { attempts: 5, score: 92, streak: 4, mastered: true, lastAttemptAt: Date.now() },
      ]),
    ),
  };
  assert.equal(evaluationUnlocked(mastered), true);
});

test("locked stages explain exactly what is missing", () => {
  const states = stageStates(createProfile());
  const locked = states.find((state) => !state.unlocked);
  assert.ok(locked);
  assert.ok((locked?.blockers.length ?? 0) > 0);
  assert.ok(locked?.blockers.every((text) => text.length > 3));
});

test("the daily plan only prescribes unlocked drills and leads with the stage requirement", () => {
  const profile = createProfile();
  const plan = dailyPlan(profile);
  const available = new Set(unlockedDrills(profile));
  assert.ok(plan.length > 0);
  assert.ok(plan.every((item) => available.has(item.drillId)));
  assert.equal(plan[0].drillId, "sizing");
  assert.equal(plan[0].priority, "核心");
  assert.ok(plan.every((item) => item.reason.length > 5));
});

test("the daily plan respects its size cap and never repeats a drill", () => {
  let profile = createProfile();
  for (let index = 0; index < 6; index += 1) {
    profile = applyDrillOutcome(profile, { drillId: "sizing", skill: "SIZING", score: 95, at: Date.now() });
    profile = applyDrillOutcome(profile, { drillId: "stop", skill: "READ", score: 95, at: Date.now() });
  }
  const plan = dailyPlan(profile, 3);
  assert.ok(plan.length <= 3);
  assert.equal(new Set(plan.map((item) => item.drillId)).size, plan.length);
});
