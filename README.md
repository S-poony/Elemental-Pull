# Elemental Pull

**[▶ Play it in your browser](https://s-poony.github.io/Elemental-Pull/)** — no install, works on phones, and can be added to a home screen to play offline.

A small game. You drop tiles onto a 5×5 board, they attract each other, and you score by how much motion your placement sets off. You lose when there's nowhere legal left to drop.

## The rules

Colours chase in a cycle: **red pulls green, green pulls blue, blue pulls red.** Same-colour tiles don't pull each other at all.

1. **Attraction adds up.** Every tile is pulled by the nearest tile that attracts it in each of the four directions, and a pull gets weaker with distance (1/d²). A group's pulls sum into one vector, and the group slides one cell along whichever axis wins. Two distant attractors really can out-pull one close one.
2. **When the pulls cancel, motion persists.** A group pulled equally hard from several sides carries on the way it was already going, rather than deadlocking. A group that nothing attracts doesn't move at all — momentum is a tiebreak between real pulls, not a substitute for them.
3. **Strongest first.** Every group that wants to move moves in the same tick, committed in order of pull strength. A group whose path was taken waits for the next tick instead of cancelling anyone else's move.

Tiles connect on contact — any two touching tiles bind into one group.

**Where you can drop.** Any empty cell that isn't directly above, below, left or right of a tile already on the board. Diagonals are fine. Because that's the same adjacency binding uses, a tile can never fuse the moment it lands — you can only aim it and let the pulls do the rest. The game ends when every empty cell is touching something.

**Scoring: one point per tile that moves, per step.** A placement that nudges one tile once is worth 1; a placement that sets off a twelve-step cascade across half the board is worth dozens. Tiles that slide off the edge still explode and leave the board — that's what keeps the edge clear enough to keep playing — but the explosion itself scores nothing. The points are in the reaction, not the disposal.

## Code

Built with React, TypeScript, Vite and Tailwind. The one structural rule is that **every game rule lives in `physics.ts`** — the component never re-derives any of it, which is what makes the arrows drawn on the board a guarantee about the next tick rather than a second opinion about it.

- `physics.ts` — the whole rule set, pure and free of React. Nothing here touches the DOM.
- `game.tsx` — board, HUD, sounds, animation timing.
- `tests/physics.test.ts` — scenario tests plus the two structural guarantees the design rests on: a tick never freezes while any group wants to move, and every cascade terminates. Also fuzzes full games and compares against the previous engine.
- `scripts/make-icons.mjs` — draws the app icons from the game's own palette.
- `CLAUDE.md` — the invariants that are easy to break by accident, and why each one is there.

```
npm install
npm run dev     # play it
npm test        # physics suite
npm run build
```

## Installing it

It's a PWA — `public/manifest.webmanifest` plus `public/sw.js` — so it installs to a home screen from the browser and plays offline after the first visit. Icons are generated rather than committed by hand:

```
node scripts/make-icons.mjs
```

`PLAYSTORE.md` covers wrapping the same build as an Android app.

## Deploying

GitHub Pages, automatically, on every push to `main`. `vite.config.ts` derives the base path from the repository name at build time, so renaming the repo doesn't break the deployed asset paths.

> There must never be a `vite.config.js` in the repo root — Vite resolves it *before* `vite.config.ts`, so a stray compiled copy silently becomes the real config.
