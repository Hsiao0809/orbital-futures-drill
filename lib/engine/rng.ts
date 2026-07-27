// Deterministic pseudo-random numbers.
//
// Scenarios must be reproducible: a shared seed has to reproduce the exact same
// drill for a different learner, and tests need stable fixtures. `Math.random`
// gives us neither, so drills draw from a seeded mulberry32 generator.

export type Rng = () => number;

/** Hash an arbitrary string into a 32-bit seed. */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — small, fast, and good enough for scenario selection. */
export function createRng(seed: number | string): Rng {
  let state = (typeof seed === "string" ? hashSeed(seed) : seed >>> 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in `[min, max]`. */
export function randInt(rng: Rng, min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (!items.length) throw new Error("pick() needs a non-empty list");
  return items[randInt(rng, 0, items.length - 1)];
}

/** Fisher-Yates on a copy. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const output = items.slice();
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = randInt(rng, 0, index);
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}
