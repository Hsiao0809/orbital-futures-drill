# ORBITAL — Collaboration Guide

## Product contract

ORBITAL is a paper-only trainer for crypto prop firm evaluations. It teaches the
things that actually decide those evaluations — position sizing, limit
awareness, and behavioural discipline — using real historical candles and an
accurate rule engine.

It is not an exchange client, a signal service, or a promise of profit.

## Non-negotiable rules

- **Never** add live trading, exchange credentials, order routing, or any claim
  that the product can make users money.
- **Never** present the readiness score as a probability of passing a real
  evaluation. It is training completeness, and the UI must keep saying so.
- Rule set presets model rule *structures*, not any named firm's current terms.
  Do not attach a company name to a preset — terms change, and a stale claim
  about a real business is a liability.
- Modelled costs (fees, slippage, funding) must stay visibly labelled as
  estimates wherever they affect a displayed number.

## Engine invariants

`lib/engine/` is pure, dependency-free, and covered by `tests/`. These
behaviours are load-bearing; changing one means changing its test deliberately,
never deleting it:

- **Ambiguity resolves against the trader.** A candle containing both the stop
  and the target is a stop-out. A gap through a level fills at the open. Limits
  are tested against the worst equity inside the candle, not the close.
- **Planned risk includes both fees.** A clean stop-out must come out at exactly
  −1R, or every R statistic in the product flatters the user.
- **Over-sizing is penalised harder than under-sizing** by the same margin, in
  every grader that scores a size.
- **Nothing is graded on a single candle.** Directional grading is path-aware
  over a horizon, normalised by the ATR observable at the decision point.
- **Only score what the learner could know when they decided.** Whether a stop
  was subsequently swept is an outcome, not a decision; report it, do not
  grade it. The stop drill once put 40% of its marks on that, which made the
  best achievable score fall below the mastery threshold on 38% of generated
  scenarios — the drill was unpassable, not hard.
- **Every drill must be masterable.** If a sweep of the answer space cannot
  reach 80 on a scenario, the grader is broken. `tests/engine-training.test.ts`
  enforces this for the stop drill; add the same guard to any new drill.
- **A failing answer says where to aim.** Populate `Grade.suggestion` with a
  concrete target and the reasoning behind it. A bare score teaches nothing.
- **Teach before testing.** A drill that requires knowledge the interface never
  supplied is a guessing game. Where there is a method, show it worked through
  with the current question's own numbers, at enough precision that following
  it scores full marks.
- Drill scenarios are seeded and reproducible. Randomness belongs in
  `lib/store/client.ts` or `lib/engine/rng.ts`, never in a component render.

## Case studies (`/learn`)

Teaching material is curated tape, not generated tape: fixed windows screened
off the recent 24h gainers/losers board, stored in `lib/market/casePack.ts` and
described by `lib/engine/cases.ts`. Three rules keep it from rotting:

- **No authored numbers.** Every figure the learner reads is recomputed from the
  case's own candles by the same primitives the graders use. The pack stores
  candles and a label; it never stores a sentence claiming what those candles
  did. If you find yourself writing a number into the pack, you are building a
  way for the material and the grading to disagree.
- **A case must keep classifying as its own label.** `classifyWindow` both finds
  cases and re-verifies them in `tests/engine-cases.test.ts`. Loosening a screen
  to keep a favourite window is how a "stop hunt" lesson ends up pointing at a
  window with no stop hunt in it.
- **Say which tape it is.** The generator prefers USDⓈ-M perpetuals and falls
  back to Binance's public spot mirror when they are unreachable; whichever
  answered is recorded per case and shown in the UI. Perp and spot are not the
  same series and the material must never imply they are.

Regenerate with `npm run build:cases`. The board changes daily, so a rerun
swaps the case set; the generator self-checks before writing and fails rather
than emitting material that teaches the wrong thing.

## Working rules

- Make product changes on a feature branch (`codex/...` or `claude/...`), then
  open a pull request into `main`.
- Do not overwrite or reset other contributors' work. Inspect `git status` and
  fetch the remote before non-trivial work.
- Progress storage is local-first. `localStorage` is the source of truth and the
  D1 mirror is best-effort; no training flow may block on the database or the
  network.
- Headings stay small and dense. This is an instrument panel — vertical space
  belongs to the numbers, not to titles.

## Validation

```bash
npm test          # engine unit tests
npm run lint      # must be clean
npm run build     # must succeed
```

`npm run lint` is now **clean with zero errors and zero warnings**, and should
be kept that way. The previous baseline of `react-hooks/set-state-in-effect`
findings was resolved by moving derived state into `useMemo` and external state
into `useSyncExternalStore`; do not reintroduce those patterns, and do not
silence the rule with disables.

For chart, layout, or interaction changes, run the site and verify the affected
flow in a browser. Binance returns HTTP 451 from some IP ranges, in which case
stub `/api/klines` to exercise the market-data drills. Describe the exact
scenario tested in the pull request.

### Layout: working pages do not scroll

Every working page (`/train`, `/train/*`, `/exam`, `/journal`) fits one desktop
viewport. Panels scroll inside themselves; the page never does. Opt in with
`viewport` on the `<main>`, and mark the region that should absorb the space
with `grow pane`. Below 900x600 this relaxes to normal scrolling, because a
locked 100vh on a small screen puts content out of reach.

The dashboard is the single exception: it is a reading surface, not a working
one.

**Unused width is spent as height.** On a page that cannot scroll, every
paragraph capped short of its container wraps to an extra line, and every
control that inflates to fill a stretched column steals rows from the chart.
Two rules follow:

- A measure cap (`max-width: 76ch` on `.lede`) belongs to prose sitting
  directly on the page. Inside a card the card *is* the measure, so the cap is
  removed there.
- `.stack` is a flex column, never a grid. A grid's default
  `align-content: stretch` inflates every auto row to fill a stretched
  `.viewport .split` column — two dropdowns and a button spread over 660px of
  card is what that looks like. Flex keeps rows at content height and leaves
  the slack for `.grow` to claim deliberately.

`layout-check` asserts both: no page-level scrolling, and body copy using at
least 88% of its card's content width.

The rule that matters underneath: **the thing the learner has to act on is
never below the fold.** Teaching material buried under a risk readout, or a
submit button pushed off the bottom of its column, may as well not exist. A
previous revision relaxed this rule when the app went multi-route; that was a
mistake and it was reinstated.

## Ownership and release flow

- `main` is the review-approved source of truth.
- GitHub is the collaboration remote for Codex and Claude.
- The private ORBITAL preview is released separately only after a successful
  build and manual product QA. A pushed branch or open PR is not a release.
