// Optional server-side mirror of a learner's progress.
//
// The product is local-first: `lib/store/profile.ts` treats the browser as the
// source of truth and these tables as a best-effort backup for signed-in users.
// Nothing in the training flow blocks on the database being present.

import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable("profiles", {
  /** Stable identity, currently the authenticated workspace email. */
  userId: text("user_id").primaryKey(),
  xp: integer("xp").notNull().default(0),
  streakDays: integer("streak_days").notNull().default(0),
  drillsCompleted: integer("drills_completed").notNull().default(0),
  /** Full ProgressProfile JSON. Kept whole so a schema change cannot lose data. */
  payload: text("payload").notNull(),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    ruleSetId: text("rule_set_id").notNull(),
    symbol: text("symbol").notNull(),
    interval: text("interval").notNull(),
    /** IN_PROGRESS | PASSED | FAILED */
    status: text("status").notNull(),
    profit: real("profit").notNull(),
    profitPct: real("profit_pct").notNull(),
    tradingDays: integer("trading_days").notNull(),
    trades: integer("trades").notNull(),
    totalR: real("total_r").notNull(),
    breach: text("breach"),
    disciplineScore: integer("discipline_score").notNull(),
    finishedAt: integer("finished_at").notNull(),
  },
  (table) => [index("runs_user_finished_idx").on(table.userId, table.finishedAt)],
);

export const drillAttempts = sqliteTable(
  "drill_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    drillId: text("drill_id").notNull(),
    /** Scenario seed, so any attempt can be replayed exactly. */
    seed: text("seed").notNull(),
    score: real("score").notNull(),
    attemptedAt: integer("attempted_at").notNull(),
  },
  (table) => [index("attempts_user_drill_idx").on(table.userId, table.drillId)],
);
