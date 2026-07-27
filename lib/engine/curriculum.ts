// The curriculum ladder.
//
// Gating is the point. A learner who can pick direction but cannot size a
// position is not "70% of a trader" — they are someone who will fail an
// evaluation. So stages unlock only when the prerequisite competency has been
// demonstrated repeatedly, and the order puts risk mechanics before market
// reading on purpose.

import { DRILLS, getDrill } from "./drills.ts";
import { MASTERY_THRESHOLD, SKILLS } from "./scoring.ts";
import type { ProgressProfile, SkillId, SkillVector } from "./types.ts";

export type Stage = {
  id: string;
  order: number;
  title: string;
  goal: string;
  /** Drill ids practised in this stage. */
  drills: string[];
  /** Drills that must be mastered to clear the stage. */
  required: string[];
  /** Unlock conditions. */
  requires: { stage: string | null; skills: Partial<SkillVector> };
  /** Does clearing this stage unlock the full evaluation simulator? */
  unlocksEvaluation?: boolean;
};

export const STAGES: Stage[] = [
  {
    id: "foundations",
    order: 1,
    title: "第一階 · 風險機制",
    goal: "在看任何一張圖之前，先能把「我願意虧多少」翻譯成「我可以買多少」。這一階不談方向。",
    drills: ["sizing"],
    required: ["sizing"],
    requires: { stage: null, skills: {} },
  },
  {
    id: "invalidation",
    order: 2,
    title: "第二階 · 無效化",
    goal: "決定一筆交易在哪裡算是看錯。停損位置決定了部位大小，也決定了你會不會被雜訊反覆掃出場。",
    drills: ["stop", "sizing"],
    required: ["stop"],
    requires: { stage: "foundations", skills: { SIZING: 60 } },
  },
  {
    id: "structure",
    order: 3,
    title: "第三階 · 行情判讀",
    goal: "辨識這段行情有沒有值得參與的結構，並誠實標示自己的信心。判斷以一段行情為單位，不是一根 K 線。",
    drills: ["bias", "stop"],
    required: ["bias"],
    requires: { stage: "invalidation", skills: { SIZING: 65, READ: 45 } },
  },
  {
    id: "management",
    order: 4,
    title: "第四階 · 持倉管理",
    goal: "把做對的交易完整做完。目標不是抓最高點，是穩定擷取這段行情的一大部分，並且不讓浮盈變成虧損。",
    drills: ["exit", "bias"],
    required: ["exit"],
    requires: { stage: "structure", skills: { READ: 55 } },
  },
  {
    id: "rulecraft",
    order: 5,
    title: "第五階 · 規則守門",
    goal: "在限額壓力下做決策。這一階最接近真實考試：所有題目的數字都由規則引擎即時計算，沒有標準答案可以背。",
    drills: ["rule-guard", "sizing"],
    required: ["rule-guard"],
    requires: { stage: "management", skills: { SIZING: 70, DISCIPLINE: 55 } },
  },
  {
    id: "temperament",
    order: 6,
    title: "第六階 · 情緒管理",
    goal: "連虧與連勝都要能停手。把停機條件寫成規則，讓你不需要在狀態最差的時候依賴判斷力。",
    drills: ["tilt", "rule-guard"],
    required: ["tilt"],
    requires: { stage: "rulecraft", skills: { DISCIPLINE: 65 } },
  },
  {
    id: "evaluation",
    order: 7,
    title: "第七階 · 完整考試",
    goal: "在完整的規則檔下跑完一次多日考試，不違規、不靠單日暴利。通過兩次，你才算準備好去付真實考試費。",
    drills: [],
    required: [],
    requires: { stage: "temperament", skills: { SIZING: 75, DISCIPLINE: 70, PATIENCE: 60 } },
    unlocksEvaluation: true,
  },
];

export type StageState = {
  stage: Stage;
  unlocked: boolean;
  cleared: boolean;
  /** 0..1 progress through the stage's required drills. */
  progress: number;
  /** Human-readable reasons the stage is still locked. */
  blockers: string[];
};

function skillLabel(id: SkillId): string {
  return SKILLS.find((skill) => skill.id === id)?.label ?? id;
}

export function stageStates(profile: ProgressProfile): StageState[] {
  const states: StageState[] = [];
  const clearedIds = new Set<string>();

  for (const stage of STAGES) {
    const blockers: string[] = [];
    if (stage.requires.stage && !clearedIds.has(stage.requires.stage)) {
      const previous = STAGES.find((item) => item.id === stage.requires.stage);
      blockers.push(`先完成「${previous?.title ?? stage.requires.stage}」`);
    }
    for (const [skill, need] of Object.entries(stage.requires.skills) as Array<[SkillId, number]>) {
      const have = profile.skills[skill];
      if (have < need) blockers.push(`${skillLabel(skill)} 需達 ${need}（目前 ${have.toFixed(0)}）`);
    }

    const masteredCount = stage.required.filter((id) => profile.mastery[id]?.mastered).length;
    const progress = stage.required.length ? masteredCount / stage.required.length : clearedIds.size ? 1 : 0;
    const cleared = stage.required.length ? masteredCount === stage.required.length : blockers.length === 0;
    if (cleared && !blockers.length) clearedIds.add(stage.id);

    states.push({ stage, unlocked: blockers.length === 0, cleared: cleared && !blockers.length, progress, blockers });
  }
  return states;
}

export function currentStage(profile: ProgressProfile): StageState {
  const states = stageStates(profile);
  return states.find((state) => state.unlocked && !state.cleared) ?? states[states.length - 1];
}

export function evaluationUnlocked(profile: ProgressProfile): boolean {
  return stageStates(profile).some((state) => state.stage.unlocksEvaluation && state.unlocked);
}

export function unlockedDrills(profile: ProgressProfile): string[] {
  const unlocked = new Set<string>();
  for (const state of stageStates(profile)) {
    if (!state.unlocked) continue;
    for (const id of state.stage.drills) unlocked.add(id);
  }
  // The first stage is always available so a new learner has somewhere to start.
  if (!unlocked.size) unlocked.add("sizing");
  return DRILLS.filter((drill) => unlocked.has(drill.id)).map((drill) => drill.id);
}

// ---------------------------------------------------------------------------
// Daily plan
// ---------------------------------------------------------------------------

export type PlanItem = {
  drillId: string;
  title: string;
  reps: number;
  /** Why this drill was chosen today. */
  reason: string;
  priority: "核心" | "補強" | "維持";
};

/**
 * Today's practice. Weighted toward the current stage's required drills, then
 * toward the weakest competency, then a maintenance rep of something already
 * mastered so it does not decay.
 */
export function dailyPlan(profile: ProgressProfile, max = 4): PlanItem[] {
  const stage = currentStage(profile);
  const available = new Set(unlockedDrills(profile));
  const items: PlanItem[] = [];
  const used = new Set<string>();

  const add = (drillId: string, reps: number, reason: string, priority: PlanItem["priority"]) => {
    if (used.has(drillId) || !available.has(drillId) || items.length >= max) return;
    used.add(drillId);
    items.push({ drillId, title: getDrill(drillId).title, reps, reason, priority });
  };

  // 1. Whatever the current stage requires.
  for (const drillId of stage.stage.required) {
    const record = profile.mastery[drillId];
    const remaining = record?.mastered ? 0 : Math.max(1, 3 - (record?.streak ?? 0));
    if (remaining > 0) {
      add(
        drillId,
        remaining,
        record
          ? `本階段必修。連續達標 ${record.streak}/3 次（需 ${MASTERY_THRESHOLD} 分以上）。`
          : "本階段必修，尚未開始。",
        "核心",
      );
    }
  }

  // 2. The weakest competency that has an unlocked drill.
  const weakest = [...SKILLS]
    .map((skill) => ({ skill, rating: profile.skills[skill.id] }))
    .sort((a, b) => a.rating - b.rating);
  for (const { skill, rating } of weakest) {
    const drill = DRILLS.find((item) => item.skill === skill.id && available.has(item.id) && !used.has(item.id));
    if (drill) {
      add(drill.id, 2, `「${skill.label}」是目前最弱的一項（${rating.toFixed(0)} 分），這個項目直接練它。`, "補強");
      break;
    }
  }

  // 3. Stage practice drills, then maintenance on mastered ones.
  for (const drillId of stage.stage.drills) {
    add(drillId, 1, "本階段的搭配練習。", "維持");
  }
  for (const [drillId, record] of Object.entries(profile.mastery)) {
    if (!record.mastered) continue;
    const stale = Date.now() - record.lastAttemptAt > 5 * 86_400_000;
    if (stale) add(drillId, 1, "已精熟但超過 5 天沒練，做一次維持手感。", "維持");
  }

  return items;
}

/** A short "what should I do right now" line for the dashboard. */
export function nextAction(profile: ProgressProfile): string {
  const plan = dailyPlan(profile, 1);
  if (!plan.length) {
    return evaluationUnlocked(profile)
      ? "所有訓練階段都已解鎖。去跑一次完整考試模擬，那才是真正的檢驗。"
      : "今天的訓練已完成。";
  }
  return `${plan[0].title} × ${plan[0].reps}：${plan[0].reason}`;
}
