"use client";

// Local-first progress storage.
//
// The trainer must work with no database and no account: a learner should be
// able to open the site and start practising. `localStorage` is the source of
// truth; the D1 mirror behind `/api/profile` is an optional backup layered on
// top, so losing the network degrades sync, never the product.
//
// Exposed as an external store rather than component state so that every
// mounted component sees the same profile instance and a write from the drill
// runner immediately updates the nav bar.

import { useCallback, useSyncExternalStore } from "react";
import { createProfile } from "../engine/scoring.ts";
import type { ProgressProfile } from "../engine/types.ts";

const STORAGE_KEY = "orbital.profile.v1";
/** Legacy key from the pre-rebuild build; migrated once, then ignored. */
const LEGACY_XP_KEY = "orbital-futures-drill-career-xp";
const SYNC_DELAY_MS = 2500;

function migrate(raw: unknown): ProgressProfile {
  const base = createProfile();
  if (!raw || typeof raw !== "object") return base;
  const candidate = raw as Partial<ProgressProfile>;
  if (candidate.version !== 1) return base;
  // Merge field-by-field so a profile written by an older build that lacks a
  // newly added key still loads instead of throwing at the first read.
  return {
    ...base,
    ...candidate,
    skills: { ...base.skills, ...(candidate.skills ?? {}) },
    mastery: candidate.mastery ?? {},
    runHistory: Array.isArray(candidate.runHistory) ? candidate.runHistory : [],
    flagCounts: candidate.flagCounts ?? {},
  };
}

function readStorage(): ProgressProfile {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return migrate(JSON.parse(stored));
    // One-time carry-over so early users keep the XP they earned.
    const legacy = Number(window.localStorage.getItem(LEGACY_XP_KEY));
    const fresh = createProfile();
    return Number.isFinite(legacy) && legacy > 0 ? { ...fresh, xp: legacy } : fresh;
  } catch {
    return createProfile();
  }
}

function writeStorage(profile: ProgressProfile): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Quota or private-mode failures must not break a training session.
  }
}

// --- external store ---------------------------------------------------------

let cache: ProgressProfile | null = null;
const listeners = new Set<() => void>();
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function getSnapshot(): ProgressProfile {
  // Must be referentially stable between calls or React will loop.
  if (!cache) cache = readStorage();
  return cache;
}

/** `null` on the server so callers can tell "not loaded yet" from "empty". */
function getServerSnapshot(): ProgressProfile | null {
  return null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function commit(next: ProgressProfile): void {
  cache = next;
  writeStorage(next);
  for (const listener of listeners) listener();

  // Best-effort mirror to the server, debounced. Failures are silent by
  // design: the local copy is authoritative.
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    void fetch("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    }).catch(() => undefined);
  }, SYNC_DELAY_MS);
}

// --- hook -------------------------------------------------------------------

export type ProfileStore = {
  profile: ProgressProfile;
  /** False until the browser value has been read. Guards hydration. */
  ready: boolean;
  update: (updater: (current: ProgressProfile) => ProgressProfile) => void;
  reset: () => void;
};

const PLACEHOLDER = createProfile();

export function useProfile(): ProfileStore {
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const update = useCallback<ProfileStore["update"]>((updater) => {
    commit(updater(getSnapshot()));
  }, []);

  const reset = useCallback(() => {
    commit(createProfile());
  }, []);

  return { profile: stored ?? PLACEHOLDER, ready: stored !== null, update, reset };
}
