import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/index";
import { profiles } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * Best-effort progress mirror.
 *
 * The trainer is local-first, so this endpoint must never be load-bearing:
 * with no D1 binding and no signed-in user it reports `stored: false` and the
 * browser carries on with `localStorage`. Callers ignore failures by design.
 */

async function currentUser(): Promise<string | null> {
  const requestHeaders = await headers();
  return requestHeaders.get("oai-authenticated-user-email");
}

export async function GET() {
  const userId = await currentUser();
  if (!userId) return NextResponse.json({ stored: false, reason: "anonymous" });
  try {
    const db = getDb();
    const rows = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
    if (!rows.length) return NextResponse.json({ stored: false, reason: "not-found" });
    return NextResponse.json({ stored: true, profile: JSON.parse(rows[0].payload) });
  } catch {
    return NextResponse.json({ stored: false, reason: "unavailable" });
  }
}

export async function POST(request: Request) {
  const userId = await currentUser();
  if (!userId) return NextResponse.json({ stored: false, reason: "anonymous" });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ stored: false, reason: "bad-json" }, { status: 400 });
  }

  const profile = payload as { version?: number; xp?: number; streakDays?: number; drillsCompleted?: number };
  if (profile?.version !== 1) {
    return NextResponse.json({ stored: false, reason: "unsupported-version" }, { status: 400 });
  }

  const row = {
    userId,
    xp: Math.max(0, Math.floor(Number(profile.xp) || 0)),
    streakDays: Math.max(0, Math.floor(Number(profile.streakDays) || 0)),
    drillsCompleted: Math.max(0, Math.floor(Number(profile.drillsCompleted) || 0)),
    payload: JSON.stringify(payload),
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    const db = getDb();
    await db
      .insert(profiles)
      .values(row)
      .onConflictDoUpdate({ target: profiles.userId, set: row });
    return NextResponse.json({ stored: true });
  } catch {
    return NextResponse.json({ stored: false, reason: "unavailable" });
  }
}
