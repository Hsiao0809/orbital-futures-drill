# ORBITAL Futures Drill — Collaboration Guide

## Product contract

ORBITAL is a paper-only training product for Binance USDⓈ-M perpetual futures.
It teaches decision quality, execution discipline, and risk awareness using
real historical candles. It is not an exchange client, signal service, or a
promise of profit.

## Working rules

- Make product changes on a feature branch (`codex/...` or `claude/...`), then
  open a pull request into `main`.
- Do not overwrite or reset other contributors' work. Inspect `git status` and
  fetch the remote before non-trivial work.
- Keep the primary desktop training surface within one viewport: no page-level
  vertical scrolling at normal desktop heights. Do visual QA for layout work.
- Preserve the core loop: real historical candle data, future candles hidden,
  clear long/short/wait decisions, and an immediate legible result.
- A wait while flat must not change account equity. Position P&L must only
  change through modeled fees, slippage, or price movement.
- Never add live trading, account credentials, or claims that the product can
  make users money.

## Validation

Run the build before requesting review:

```bash
npm run build
```

Also run `npm run lint` when changing React or TypeScript code and report its
result. The current baseline has pre-existing React effect-rule findings in
`app/page.tsx`; do not hide those with broad lint disables. A dedicated cleanup
should make lint required in CI once that baseline is resolved.

For chart, layout, or interaction changes, also run the local site and verify
the relevant flow at desktop size. Describe the exact scenario tested in the
pull request.

## Ownership and release flow

- `main` is the review-approved source of truth.
- GitHub is the collaboration remote for Codex and Claude.
- The private ORBITAL preview is released separately only after a successful
  build and manual product QA. A pushed branch or open PR is not a release.
