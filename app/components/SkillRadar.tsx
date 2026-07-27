"use client";

import { READY_THRESHOLDS, SKILLS } from "@/lib/engine/scoring.ts";
import type { SkillVector } from "@/lib/engine/types.ts";

const SIZE = 190;
const CENTRE = SIZE / 2;
const RADIUS = SIZE / 2 - 22;

function point(index: number, count: number, value: number): [number, number] {
  // Start at 12 o'clock and go clockwise.
  const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
  const distance = (Math.max(0, Math.min(100, value)) / 100) * RADIUS;
  return [CENTRE + Math.cos(angle) * distance, CENTRE + Math.sin(angle) * distance];
}

function polygon(values: number[]): string {
  return values.map((value, index) => point(index, values.length, value).join(",")).join(" ");
}

export default function SkillRadar({ skills }: { skills: SkillVector }) {
  const count = SKILLS.length;
  const current = SKILLS.map((skill) => skills[skill.id]);
  const targets = SKILLS.map((skill) => READY_THRESHOLDS[skill.id]);

  return (
    <div className="radar-wrap">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="五維能力雷達圖">
        {[25, 50, 75, 100].map((ring) => (
          <polygon
            key={ring}
            points={polygon(new Array(count).fill(ring))}
            fill="none"
            stroke="rgba(255,255,255,0.07)"
            strokeWidth="1"
          />
        ))}
        {SKILLS.map((skill, index) => {
          const [x, y] = point(index, count, 100);
          return <line key={skill.id} x1={CENTRE} y1={CENTRE} x2={x} y2={y} stroke="rgba(255,255,255,0.07)" />;
        })}

        {/* Threshold ring: the shape you need to fill before paying for a real
            evaluation. Showing the goal makes the gap legible at a glance. */}
        <polygon
          points={polygon(targets)}
          fill="none"
          stroke="rgba(255,192,97,0.5)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <polygon points={polygon(current)} fill="rgba(200,244,102,0.18)" stroke="#c8f466" strokeWidth="1.5" />
        {current.map((value, index) => {
          const [x, y] = point(index, count, value);
          return <circle key={SKILLS[index].id} cx={x} cy={y} r="2.5" fill="#c8f466" />;
        })}
      </svg>

      <div className="radar-legend">
        {SKILLS.map((skill) => {
          const value = skills[skill.id];
          const need = READY_THRESHOLDS[skill.id];
          const met = value >= need;
          return (
            <div key={skill.id} className="radar-legend-row" title={skill.blurb}>
              <span>{skill.label}</span>
              <div className={`meter ${met ? "meter-green" : "meter-amber"}`}>
                <i style={{ width: `${Math.min(100, value)}%` }} />
              </div>
              <b className={met ? "up" : "warn"}>{value.toFixed(0)}</b>
            </div>
          );
        })}
        <p className="tiny">虛線是進入真實考試前的建議門檻，不是滿分線。</p>
      </div>
    </div>
  );
}
