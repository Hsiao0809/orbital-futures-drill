"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * `false` during server render and hydration, `true` afterwards.
 *
 * Anything that reads `localStorage`, `Math.random()` or the clock has to wait
 * for this, otherwise the server and client render different trees. Using
 * `useSyncExternalStore` rather than a mount effect keeps the transition to a
 * single render instead of a cascade.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

// --- scenario seeds ---------------------------------------------------------

const seeds = new Map<string, string>();

/**
 * A stable random seed for `key`, minted on first client read and remembered
 * for the lifetime of the page.
 *
 * The randomness lives in this module rather than in a component because a
 * seed generated during render is impure: React may re-render at any time, and
 * a fresh seed would swap the question out from under the learner mid-answer.
 * Returns `null` on the server so nothing random is ever server-rendered.
 */
export function useSeed(key: string): string | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => {
      let seed = seeds.get(key);
      if (!seed) {
        seed = Math.random().toString(36).slice(2, 10);
        seeds.set(key, seed);
      }
      return seed;
    },
    () => null,
  );
}
