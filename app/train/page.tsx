"use client";

import Link from "next/link";
import { useProfile } from "@/lib/store/profile.ts";
import { DRILLS } from "@/lib/engine/drills.ts";
import { MASTERY_STREAK, MASTERY_THRESHOLD, SKILLS } from "@/lib/engine/scoring.ts";
import { stageStates, unlockedDrills } from "@/lib/engine/curriculum.ts";

export default function TrainHub() {
  const { profile, ready } = useProfile();

  if (!ready) {
    return (
      <main className="empty">
        <p>載入中…</p>
      </main>
    );
  }

  const unlocked = new Set(unlockedDrills(profile));
  const stages = stageStates(profile);

  /** Which stage first introduces a drill, so a locked card can say why. */
  const gateFor = (drillId: string) =>
    stages.find((state) => state.stage.drills.includes(drillId));

  return (
    <main className="stack-lg">
      <header className="page-head">
        <p className="eyebrow">訓練</p>
        <h1>六種題型，每一種對應一個會讓你出局的環節。</h1>
        <p className="lede">
          全部以客觀標準評分：方向題以一段行情判定而非單根 K 線，部位題有唯一數學正解，
          規則題的數字由引擎即時計算，沒有答案可背。
        </p>
      </header>

      <section className="drill-grid">
        {DRILLS.map((drill) => {
          const open = unlocked.has(drill.id);
          const record = profile.mastery[drill.id];
          const gate = gateFor(drill.id);
          const skill = SKILLS.find((item) => item.id === drill.skill);

          const card = (
            <>
              <div className="row-between">
                <h3>{drill.title}</h3>
                {record?.mastered ? (
                  <span className="pill pill-green">已精熟</span>
                ) : open ? (
                  <span className="pill pill-lime">{drill.seconds} 秒 / 題</span>
                ) : (
                  <span className="pill pill-mute">🔒 未解鎖</span>
                )}
              </div>
              <div className="row">
                <span className="pill pill-mute">{skill?.label}</span>
                {drill.needsMarket && <span className="pill pill-mute">需要行情資料</span>}
              </div>
              <p className="why">{drill.why}</p>

              {open ? (
                record ? (
                  <>
                    <div className="meter">
                      <i style={{ width: `${Math.min(100, (record.streak / MASTERY_STREAK) * 100)}%` }} />
                    </div>
                    <p className="tiny">
                      平均 {record.score.toFixed(0)} 分 · 已練 {record.attempts} 次 ·
                      連續達標 {record.streak}/{MASTERY_STREAK}（需 {MASTERY_THRESHOLD} 分以上）
                    </p>
                  </>
                ) : (
                  <p className="tiny">尚未練習過。</p>
                )
              ) : (
                <p className="stage-blockers">
                  🔒 {gate?.blockers.join("　·　") ?? "完成前面的階段後解鎖"}
                </p>
              )}
            </>
          );

          return open ? (
            <Link key={drill.id} href={`/train/${drill.id}`} className="card drill-card">
              {card}
            </Link>
          ) : (
            <div key={drill.id} className="card drill-card locked">
              {card}
            </div>
          );
        })}
      </section>
    </main>
  );
}
