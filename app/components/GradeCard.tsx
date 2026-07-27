"use client";

import type { Grade } from "@/lib/engine/drills.ts";
import { MASTERY_THRESHOLD, drillXp } from "@/lib/engine/scoring.ts";

function tone(score: number): string {
  if (score >= MASTERY_THRESHOLD) return "up";
  if (score >= 55) return "warn";
  return "down";
}

export default function GradeCard({
  grade,
  onNext,
  nextLabel = "下一題",
  recorded = true,
}: {
  grade: Grade;
  onNext: () => void;
  nextLabel?: string;
  /** False for a try-out of a locked drill, where nothing is stored. */
  recorded?: boolean;
}) {
  return (
    <div className="card stack">
      <div className="verdict">
        <span className={`verdict-score ${tone(grade.score)}`}>{Math.round(grade.score)}</span>
        <div>
          <p className="eyebrow">評分結果</p>
          <h2>{grade.verdict}</h2>
          {/* Never promise XP for a try-out — the banner above already says
              nothing is recorded, and two contradictory claims on one screen
              is worse than either message alone. */}
          <p className="tiny">
            {recorded ? `+${drillXp(grade.score)} XP · ` : "試做，未計入進度 · "}
            {grade.score >= MASTERY_THRESHOLD
              ? `達到精熟門檻（${MASTERY_THRESHOLD} 分）`
              : `距離精熟門檻還差 ${Math.ceil(MASTERY_THRESHOLD - grade.score)} 分`}
          </p>
        </div>
      </div>

      <div className="breakdown">
        {grade.breakdown.map((item) => (
          <div key={item.label} className="breakdown-item">
            <div className="row-between">
              <span>{item.label}</span>
              <b className={item.points >= item.max * 0.7 ? "up" : item.points > 0 ? "warn" : "down"}>
                {Math.round(item.points)} / {item.max}
              </b>
            </div>
            <div className="meter">
              <i style={{ width: `${Math.max(0, Math.min(100, (item.points / item.max) * 100))}%` }} />
            </div>
            <p>{item.note}</p>
          </div>
        ))}
      </div>

      {grade.suggestion && (
        <div className="suggestion">
          <span>{grade.suggestion.label}</span>
          <b className="num">{grade.suggestion.value}</b>
          <p>{grade.suggestion.why}</p>
        </div>
      )}

      <div className="lesson-box">{grade.lesson}</div>

      <button className="btn btn-primary btn-lg" onClick={onNext}>
        {nextLabel} →
      </button>
    </div>
  );
}
