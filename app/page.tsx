"use client";

import Link from "next/link";
import { useProfile } from "@/lib/store/profile.ts";
import { levelOf, readiness, SKILLS } from "@/lib/engine/scoring.ts";
import { currentStage, dailyPlan, evaluationUnlocked, stageStates } from "@/lib/engine/curriculum.ts";
import { getDrill } from "@/lib/engine/drills.ts";
import { getRuleSet } from "@/lib/engine/propRules.ts";
import SkillRadar from "./components/SkillRadar";

const BAND_TONE: Record<string, string> = {
  尚未開始: "pill-mute",
  基礎建立中: "pill-amber",
  接近可考: "pill-lime",
  可以進場考試: "pill-green",
};

export default function Dashboard() {
  const { profile, ready } = useProfile();

  if (!ready) {
    return (
      <main className="empty">
        <p>正在載入你的訓練進度…</p>
      </main>
    );
  }

  const level = levelOf(profile.xp);
  const state = readiness(profile);
  const plan = dailyPlan(profile);
  const stages = stageStates(profile);
  const stage = currentStage(profile);
  const examOpen = evaluationUnlocked(profile);
  const recentRuns = profile.runHistory.slice(0, 5);

  return (
    <main className="stack-lg">
      <header className="page-head">
        <p className="eyebrow">Prop 考試訓練系統</p>
        <h1>先在這裡失敗，別在付費考試裡失敗。</h1>
        <p className="lede">
          考試淘汰人的不是看錯方向，是日虧損上限、最大回撤、部位過大與虧損後的報復性交易。
        </p>
      </header>

      <section className="split-wide">
        <div className="stack">
          {/* --- readiness ------------------------------------------------ */}
          <div className="card stack">
            <div className="card-head">
              <div>
                <p className="eyebrow">考試準備度</p>
                <div className="row">
                  <span className="verdict-score accent">{state.score}</span>
                  <span className={`pill ${BAND_TONE[state.band] ?? "pill-mute"}`}>{state.band}</span>
                </div>
              </div>
              <div className="stat stat-sm" style={{ minWidth: 130 }}>
                <span>等級</span>
                <b className="num">L{level.level}</b>
                <i>{level.rank}</i>
              </div>
            </div>

            <div className="meter">
              <i style={{ width: `${level.span ? (level.into / level.span) * 100 : 100}%` }} />
            </div>
            <p className="tiny">
              距離 L{level.level + 1} 還需 {level.toNext.toLocaleString()} XP · 已完成 {profile.drillsCompleted} 次訓練
            </p>

            <div className="divider" />
            <p className="note">{state.summary}</p>
            <p className="tiny">
              這是訓練完成度，不是通過機率。沒有任何系統能預測你在真實考試中的結果。
            </p>
          </div>

          {/* --- today's plan --------------------------------------------- */}
          <div className="card stack">
            <div className="card-head">
              <div>
                <p className="eyebrow">今日訓練菜單</p>
                <h2>{stage.stage.title}</h2>
              </div>
              <span className="pill pill-lime">{Math.round(stage.progress * 100)}% 完成</span>
            </div>
            <p className="note">{stage.stage.goal}</p>

            {plan.length ? (
              <div className="stack-sm">
                {plan.map((item) => (
                  <Link key={item.drillId} href={`/train/${item.drillId}`} className="card drill-card" style={{ padding: 14 }}>
                    <div className="row-between">
                      <div className="row">
                        <span className={`pill ${item.priority === "核心" ? "pill-lime" : "pill-mute"}`}>{item.priority}</span>
                        <h3>{item.title}</h3>
                      </div>
                      <span className="num dim">× {item.reps}</span>
                    </div>
                    <p className="why">{item.reason}</p>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="note">目前沒有待完成的項目。去跑一次完整考試模擬吧。</p>
            )}
          </div>

          {/* --- ladder ---------------------------------------------------- */}
          <div className="card stack">
            <p className="eyebrow">訓練階梯</p>
            <p className="note">
              每一階都要連續三次達到 80 分才算精熟。這個門檻的存在是為了讓「運氣好過關」不算數。
            </p>
            <div className="ladder">
              {stages.map((item) => (
                <div
                  key={item.stage.id}
                  className={`stage ${item.cleared ? "cleared" : ""} ${item.unlocked && !item.cleared ? "active" : ""} ${!item.unlocked ? "locked" : ""}`}
                >
                  <span className="stage-num">{item.cleared ? "✓" : item.stage.order}</span>
                  <div>
                    <h3>{item.stage.title}</h3>
                    <p className="stage-goal">{item.stage.goal}</p>
                    {item.blockers.length > 0 && (
                      <p className="stage-blockers">🔒 {item.blockers.join("　·　")}</p>
                    )}
                  </div>
                  <div style={{ minWidth: 72, textAlign: "right" }}>
                    {item.stage.required.length > 0 && (
                      <>
                        <div className="meter" style={{ width: 72 }}>
                          <i style={{ width: `${item.progress * 100}%` }} />
                        </div>
                        <p className="tiny" style={{ marginTop: 5 }}>
                          {item.stage.required.filter((id) => profile.mastery[id]?.mastered).length}/
                          {item.stage.required.length} 精熟
                        </p>
                      </>
                    )}
                    {item.stage.unlocksEvaluation && (
                      <span className={`pill ${item.unlocked ? "pill-green" : "pill-mute"}`}>
                        {item.unlocked ? "已開放" : "未開放"}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* --- sidebar ----------------------------------------------------- */}
        <aside className="stack">
          <div className="card stack">
            <p className="eyebrow">五維能力</p>
            <SkillRadar skills={profile.skills} />
            <div className="divider" />
            <p className="tiny">
              {SKILLS.find((skill) => skill.id === state.gaps[0]?.skill)?.blurb ??
                "五項都已達門檻。接下來靠模擬考試累積實績。"}
            </p>
          </div>

          <div className="card stack">
            <p className="eyebrow">完整考試模擬</p>
            {examOpen ? (
              <>
                <p className="note">
                  多日連續交易、規則即時判定、跨日結算。跑完會產出行為診斷報告。
                </p>
                <Link href="/exam" className="btn btn-primary btn-lg">
                  開始考試模擬 →
                </Link>
              </>
            ) : (
              <>
                <p className="note">
                  考試模擬需要先完成訓練階梯。這不是刁難：在還不會計算部位的時候去跑完整考試，
                  你只會得到一次隨機結果，學不到東西。
                </p>
                <Link href="/train" className="btn btn-lg">
                  前往訓練 →
                </Link>
              </>
            )}
          </div>

          <div className="card stack">
            <p className="eyebrow">最近的考試模擬</p>
            {recentRuns.length ? (
              <div className="stack-sm">
                {recentRuns.map((run) => (
                  <div key={run.id} className="row-between" style={{ fontSize: 12 }}>
                    <div>
                      <span className={`pill ${run.status === "PASSED" ? "pill-green" : run.status === "FAILED" ? "pill-red" : "pill-mute"}`}>
                        {run.status === "PASSED" ? "通過" : run.status === "FAILED" ? "違規" : "完成"}
                      </span>
                      <p className="tiny" style={{ marginTop: 4 }}>
                        {getRuleSet(run.ruleSetId).label} · {run.symbol}
                      </p>
                    </div>
                    <b className={`num ${run.profit >= 0 ? "up" : "down"}`}>
                      {run.profit >= 0 ? "+" : ""}
                      {run.profit.toFixed(0)} U
                    </b>
                  </div>
                ))}
                <Link href="/journal" className="btn btn-sm btn-ghost">
                  查看完整紀錄與診斷 →
                </Link>
              </div>
            ) : (
              <p className="note">還沒有考試模擬紀錄。</p>
            )}
          </div>

          {plan[0] && (
            <div className="banner info">
              <span>▸</span>
              <span>
                現在最該做的一件事：<strong>{getDrill(plan[0].drillId).title}</strong>。{plan[0].reason}
              </span>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}
