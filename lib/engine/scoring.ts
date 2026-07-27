// Progression: skills, XP, levels, mastery, readiness.
//
// The gamification here is deliberately "gated" rather than "cosmetic". Points
// that only go up teach nothing. Ratings that can fall, and modules that stay
// locked until a competency is demonstrated repeatedly, do.

import type { Diagnostic } from "./diagnostics.ts";
import type { MasteryRecord, ProgressProfile, RunRecord, SkillId, SkillVector } from "./types.ts";

export const SKILLS: Array<{ id: SkillId; label: string; blurb: string }> = [
  { id: "READ", label: "行情判讀", blurb: "在遮蔽未來的情況下辨識結構，並判斷這段行情值不值得參與。" },
  { id: "SIZING", label: "部位計算", blurb: "把停損距離、手續費與剩餘限額換算成唯一正確的口數。" },
  { id: "DISCIPLINE", label: "執行紀律", blurb: "行情走反時仍然照計畫出場，不移停損、不報復性加碼。" },
  { id: "PATIENCE", label: "等待能力", blurb: "沒有機會時不製造機會；達標之後能停手。" },
  { id: "CONSISTENCY", label: "穩定複製", blurb: "產出可重複的權益曲線，而不是靠單日暴利。" },
];

export const MASTERY_THRESHOLD = 80;
export const MASTERY_STREAK = 3;

const STARTING_RATING = 40;

export function emptySkills(): SkillVector {
  return { READ: STARTING_RATING, SIZING: STARTING_RATING, DISCIPLINE: STARTING_RATING, PATIENCE: STARTING_RATING, CONSISTENCY: STARTING_RATING };
}

export function createProfile(): ProgressProfile {
  return {
    version: 1,
    xp: 0,
    skills: emptySkills(),
    mastery: {},
    streakDays: 0,
    lastActiveDay: null,
    drillsCompleted: 0,
    runHistory: [],
    flagCounts: {},
  };
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

const RANKS = [
  "紙上作業員",
  "見習操作員",
  "訓練生",
  "初階操作員",
  "合格操作員",
  "風控熟手",
  "資深操作員",
  "考核候選人",
  "準受託交易員",
  "受託交易員",
];

/** XP required to *reach* a level, growing quadratically. */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return 250 * (level - 1) * level / 2;
}

export function levelOf(xp: number): { level: number; rank: string; into: number; span: number; toNext: number } {
  let level = 1;
  while (level < 60 && xp >= xpForLevel(level + 1)) level += 1;
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return {
    level,
    rank: RANKS[Math.min(RANKS.length - 1, Math.floor((level - 1) / 3))],
    into: xp - base,
    span: next - base,
    toNext: Math.max(0, next - xp),
  };
}

// ---------------------------------------------------------------------------
// Skill ratings
// ---------------------------------------------------------------------------

/**
 * Exponentially weighted update. Early attempts move the rating a lot so a new
 * learner reaches a truthful number quickly; later attempts move it slowly so
 * one bad session does not erase demonstrated competence.
 */
export function updateSkill(current: number, score: number, attempts: number): number {
  const alpha = attempts < 3 ? 0.45 : attempts < 8 ? 0.28 : 0.18;
  return Math.max(0, Math.min(100, current * (1 - alpha) + score * alpha));
}

export function applySkillDelta(skills: SkillVector, skill: SkillId, score: number, attempts: number): SkillVector {
  return { ...skills, [skill]: Math.round(updateSkill(skills[skill], score, attempts) * 10) / 10 };
}

// ---------------------------------------------------------------------------
// Mastery
// ---------------------------------------------------------------------------

export function updateMastery(record: MasteryRecord | undefined, score: number, at: number): MasteryRecord {
  const previous = record ?? { attempts: 0, score: 0, streak: 0, mastered: false, lastAttemptAt: 0 };
  const attempts = previous.attempts + 1;
  const rolling = previous.attempts ? previous.score * 0.7 + score * 0.3 : score;
  const streak = score >= MASTERY_THRESHOLD ? previous.streak + 1 : 0;
  return {
    attempts,
    score: Math.round(rolling * 10) / 10,
    streak,
    mastered: previous.mastered || streak >= MASTERY_STREAK,
    lastAttemptAt: at,
  };
}

// ---------------------------------------------------------------------------
// Applying results
// ---------------------------------------------------------------------------

export type DrillOutcome = {
  drillId: string;
  skill: SkillId;
  /** 0..100 */
  score: number;
  /** Wall-clock, ms epoch. */
  at: number;
};

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function bumpStreak(profile: ProgressProfile, at: number): Pick<ProgressProfile, "streakDays" | "lastActiveDay"> {
  const today = dayKey(at);
  if (profile.lastActiveDay === today) return { streakDays: profile.streakDays, lastActiveDay: today };
  const yesterday = dayKey(at - 86_400_000);
  return {
    streakDays: profile.lastActiveDay === yesterday ? profile.streakDays + 1 : 1,
    lastActiveDay: today,
  };
}

/** XP scales with score so scraping a pass is worth much less than nailing it. */
export function drillXp(score: number): number {
  if (score < 50) return 10;
  return Math.round(20 + (score - 50) * 2.4);
}

export function applyDrillOutcome(profile: ProgressProfile, outcome: DrillOutcome): ProgressProfile {
  const record = profile.mastery[outcome.drillId];
  const attempts = record?.attempts ?? 0;
  return {
    ...profile,
    xp: profile.xp + drillXp(outcome.score),
    skills: applySkillDelta(profile.skills, outcome.skill, outcome.score, attempts),
    mastery: { ...profile.mastery, [outcome.drillId]: updateMastery(record, outcome.score, outcome.at) },
    drillsCompleted: profile.drillsCompleted + 1,
    ...bumpStreak(profile, outcome.at),
  };
}

/**
 * A completed evaluation run moves the ratings much harder than a drill: it is
 * the closest thing to the real assessment.
 */
export function applyRunOutcome(
  profile: ProgressProfile,
  run: RunRecord,
  flags: Diagnostic[],
): ProgressProfile {
  const flagCounts = { ...profile.flagCounts };
  for (const flag of flags) flagCounts[flag.code] = (flagCounts[flag.code] ?? 0) + flag.count;

  // Each competency is scored from the run, then blended in with heavy weight.
  const hitBy = (skill: SkillId) =>
    flags.filter((flag) => flag.skill === skill).reduce((sum, flag) => sum + flag.severity * 8, 0);

  const passBonus = run.status === "PASSED" ? 18 : run.status === "FAILED" ? -12 : 0;
  const rBonus = Math.max(-15, Math.min(15, run.totalR * 3));

  let skills = profile.skills;
  for (const { id } of SKILLS) {
    const score = Math.max(0, Math.min(100, run.disciplineScore + passBonus + rBonus - hitBy(id)));
    skills = applySkillDelta(skills, id, score, profile.runHistory.length * 3 + 3);
  }

  const xpGain = 120 + (run.status === "PASSED" ? 400 : 0) + Math.round(Math.max(0, run.disciplineScore - 50) * 4);

  return {
    ...profile,
    xp: profile.xp + xpGain,
    skills,
    flagCounts,
    runHistory: [run, ...profile.runHistory].slice(0, 40),
    ...bumpStreak(profile, run.finishedAt),
  };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type Readiness = {
  /** 0..100 training completeness. Explicitly not a probability of passing. */
  score: number;
  band: "尚未開始" | "基礎建立中" | "接近可考" | "可以進場考試";
  /** The competencies dragging the score down, weakest first. */
  gaps: Array<{ skill: SkillId; label: string; rating: number; need: number }>;
  /** Plain-language summary. */
  summary: string;
};

/** Ratings a learner should hold before spending money on a real evaluation. */
export const READY_THRESHOLDS: SkillVector = {
  READ: 60,
  SIZING: 80,
  DISCIPLINE: 80,
  PATIENCE: 70,
  CONSISTENCY: 70,
};

export function readiness(profile: ProgressProfile): Readiness {
  const gaps = SKILLS.map(({ id, label }) => ({
    skill: id,
    label,
    rating: profile.skills[id],
    need: READY_THRESHOLDS[id],
  }))
    .filter((item) => item.rating < item.need)
    .sort((a, b) => a.rating - a.need - (b.rating - b.need));

  // Weighted toward the risk competencies, because that is what the assessment
  // actually tests. Reading the market is the smallest term on purpose.
  const weights: SkillVector = { READ: 0.15, SIZING: 0.25, DISCIPLINE: 0.3, PATIENCE: 0.15, CONSISTENCY: 0.15 };
  const weighted = SKILLS.reduce(
    (sum, { id }) => sum + Math.min(100, (profile.skills[id] / READY_THRESHOLDS[id]) * 100) * weights[id],
    0,
  );

  const passedRuns = profile.runHistory.filter((run) => run.status === "PASSED").length;
  const evidence = Math.min(15, passedRuns * 7.5);
  const score = Math.round(Math.max(0, Math.min(100, weighted * 0.85 + evidence)));

  const band: Readiness["band"] =
    profile.drillsCompleted === 0 && !profile.runHistory.length
      ? "尚未開始"
      : score >= 85 && passedRuns >= 2
        ? "可以進場考試"
        : score >= 65
          ? "接近可考"
          : "基礎建立中";

  const summary =
    band === "可以進場考試"
      ? `五項能力都達到門檻，而且已在模擬考試中通過 ${passedRuns} 次。此時再去付真實考試費，才是把錢花在刀口上。`
      : band === "接近可考"
        ? `主要能力已成形，還缺 ${gaps.length} 項與至少 ${Math.max(0, 2 - passedRuns)} 次模擬通過紀錄。先補完再考。`
        : gaps.length
          ? `優先補強「${gaps[0].label}」：目前 ${gaps[0].rating.toFixed(0)}，門檻 ${gaps[0].need}。`
          : "先完成幾次訓練，系統才能給出有意義的評估。";

  return { score, band, gaps, summary };
}
