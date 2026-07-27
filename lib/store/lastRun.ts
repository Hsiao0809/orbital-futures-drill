"use client";

// The most recent completed evaluation, kept in full so the journal can show a
// real debrief rather than a summary row. Only one run is retained: the point
// of the journal is to act on the last session, not to browse an archive.

import type { Diagnostic } from "../engine/diagnostics.ts";
import type { ClosedTrade, DaySummary, RunRecord } from "../engine/types.ts";

const KEY = "orbital.lastrun.v1";

export type RunDetail = {
  record: RunRecord;
  trades: ClosedTrade[];
  days: DaySummary[];
  flags: Diagnostic[];
  breachMessage: string | null;
};

export function saveRunDetail(detail: RunDetail): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(detail));
  } catch {
    // A full quota must not lose the run that just finished on screen.
  }
}

export function loadRunDetail(): RunDetail | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RunDetail;
    return parsed?.record ? parsed : null;
  } catch {
    return null;
  }
}
