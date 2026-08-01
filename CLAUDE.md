# CLAUDE.md

Guidance for Claude Code working in this repo. The game's rules are in `README.md` — read those first, this file is about the things the code won't tell you.

## Layout

- **`physics.ts`** — every rule, as pure functions. No React, no DOM, no randomness, no `Date`.
- **`game.tsx`** — board, HUD, sounds, animation timing. One default-export component.
- **`tests/physics.test.ts`** — the suite. Plain TypeScript, no test framework.
- **`src/main.tsx`**, `src/styles.css`, `index.html` — Vite entry, Tailwind v4 via `@tailwindcss/vite`.

**Rule changes go in `physics.ts`, always.** `game.tsx` must never re-derive game logic — the overlay calls the same `planMoves` the engine calls, on the same inputs, which is what makes the on-board arrows a guarantee rather than a guess. If you find yourself reimplementing a rule in the component to drive a visual, you've introduced a way for the preview to lie.

## Invariants that are easy to break

**Momentum is a tiebreak between real pulls, never a substitute for one.** `resolveDirection` checks `hasPull` *before* anything else. This is not defensive coding — it's the whole distinction between "the pulls cancel" (a tie, hand it to momentum) and "nothing is pulling me" (rest). Collapsing the two ships a game where every placed tile sails across the board and off the far edge, and every bound pair keeps sliding forever, because bound pieces stop pulling each other and their net force drops to zero. That bug shipped once; the `regression:` blocks in the suite exist to stop it shipping twice.

**Headings never survive a turn.** `resolveTick` returns `{}` for headings the moment nothing moves. A board at rest must be fully readable from the tiles alone — no invisible momentum carried over from turns ago. Anything that seeds a heading outside a cascade (an entry direction on placement, say) reintroduces exactly the drift bug above.

**Force weights are integers and must stay integers.** `FORCE_UNIT = 705600` is divisible by every d² for d = 1..8, so every weight and every sum of weights is exact. "These pulls cancel exactly" is a load-bearing statement — it's what hands control to momentum — and floats turn exact cancellation into a near-miss that silently moves the group.

**Every colour pair binds on contact, so nothing is ever pushed.** R–G, G–B and B–R each attract one way, and matching colours bind too, so *any* two touching tiles fuse. Two distinct groups therefore can never be adjacent at rest, so a one-cell move can never land on another group, so `getPushSet` always returns a single group. The push machinery is a dormant guard in case binding is ever loosened; a test asserts the singleton property. Don't write UI copy or docs claiming groups shove each other.

**Score is motion, and it's paid per tick.** `computeMovementScore(result.movedPieceCount)` is added in `runResolutionStep` on every tick that moved, not banked until the cascade settles — the HUD number climbing has to match the tiles actually sliding. `movedPieceCount` is measured *before* the off-board cull, because a group's last move off the edge is the payoff move; count it after and the biggest slides silently score short. This replaced a triangular destruction score (points per destroyed group, scaled by size), which rewarded hoarding one large group and paid nothing for the chain reactions the physics exists to produce. Explosions are still how the edge stays clear, but they're worth zero.

**A tick never freezes.** In `planMoves`, the first (strongest) candidate can't be rejected: its push set is closed by construction and nothing is committed yet to collide with. So if any group has a direction, at least one moves. Preserve this if you touch the greedy loop — it's the property the whole redesign rests on, and it's asserted directly in the suite.

## Testing

```
npm test
```

Compiles `physics.ts` + the suite to `.test-build/` with `tsc` (CommonJS) and runs it on Node. `.test-build/` is gitignored. Exit code is non-zero on failure.

Write scenarios with the `board([...])` picture helper. **It calls `bindAdjacentPieces`**, so any two tiles you draw next to each other come out as one group — which will quietly invalidate the scenario you thought you were testing. Leave a gap of at least two cells between things meant to stay separate. A distance-1 attractor can't exist on a settled board for the same reason, which is why `REFERENCE_FORCE` scales UI readouts against distance 2, not 1.

Prefer structural assertions over pinned outputs: no freeze, always terminates, no overlapping tiles, deterministic under array reordering. The suite also fuzzes 200 full games and prints a side-by-side against the pre-rewrite engine (kept verbatim in the test file as `oldResolve`) — useful for catching accidental difficulty changes, since fewer locks means longer games.

## Environment gotcha

`node_modules` may hold Windows-only binaries for rollup and esbuild, in which case `npm run build` and anything using esbuild fail on Linux with `Cannot find module @rollup/rollup-linux-x64-gnu`. That's a platform mismatch, not a code error. Validate with:

```
npx tsc -p tsconfig.app.json --noEmit
```

which typechecks `game.tsx`, `src/` and everything they import, including JSX.

## `game.tsx` notes

Board geometry is done in percentages so it stays consistent across breakpoints instead of drifting apart at Tailwind's responsive sizes. Two CSS quirks are already handled and commented, don't "simplify" them away: percentage `padding` resolves against the *containing block's* width, while grid `gap` percentages resolve against the grid's own content box — so the two need different conversions from the same underlying fraction.

The off-grid rendering machinery is vestigial. Pieces are culled the instant they leave the board, so `BOUNDS_MARGIN` and `MAX_MARGIN_CELLS` are `0`, and `trueDistPastEdge` / `getPieceVisualStyle` always return the identity case. Harmless, but don't spend time reasoning about the compression maths — it never runs.

## Deploy

GitHub Pages on push to `main` (`.github/workflows/deploy-pages.yml`). `vite.config.ts` sets `base` from `GITHUB_REPOSITORY` when running under Actions, so the built asset paths work from a repo subpath.

## Conventions

Comments here explain *why*, not what — several of them are the only record of a decision that looks arbitrary otherwise (integer weights, the `hasPull` guard, heading lifetime, the dormant push code). Keep that going; if you remove a rule, remove its comment, but if you change one, say what it replaced and why.
