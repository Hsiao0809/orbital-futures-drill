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
- Drill scenarios are seeded and reproducible. Randomness belongs in
  `lib/store/client.ts` or `lib/engine/rng.ts`, never in a component render.

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

### Note on a superseded rule

Earlier revisions required the training surface to fit in one desktop viewport
with no page scrolling. That constraint belonged to the previous single-page
drill. The product is now a multi-route application whose pages legitimately
scroll; the replacement requirement is that **the primary decision surface —
chart, risk HUD, and the action control — is visible together without
scrolling** on the drill and exam screens.

## Ownership and release flow

- `main` is the review-approved source of truth.
- GitHub is the collaboration remote for Codex and Claude.
- The private ORBITAL preview is released separately only after a successful
  build and manual product QA. A pushed branch or open PR is not a release.
