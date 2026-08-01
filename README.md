# Reactor-Attractor

A small game. You drop tiles on the outer edge of an 8×8 board, they attract each other, and you score by sliding connected groups off the edge. You lose when the edge is completely full.

## The rules

Colours chase in a cycle: **red pulls green, green pulls blue, blue pulls red.** Same-colour tiles don't pull each other at all.

1. **Attraction adds up.** Every tile is pulled by the nearest tile that attracts it in each of the four directions, and a pull gets weaker with distance (1/d²). A group's pulls sum into one vector, and the group slides one cell along whichever axis wins. Two distant attractors really can out-pull one close one.
2. **When the pulls cancel, motion persists.** A group pulled equally hard from several sides carries on the way it was already going, rather than deadlocking. A group that nothing attracts doesn't move at all — momentum is a tiebreak between real pulls, not a substitute for them.
3. **Strongest first.** Every group that wants to move moves in the same tick, committed in order of pull strength. A group whose path was taken waits for the next tick instead of cancelling anyone else's move.

Tiles connect on contact — any two touching tiles bind into one group. A connected group slid off the edge vanishes and scores, and bigger groups score much more than the same tiles leaving one at a time.

## Code

- `physics.ts` — the whole rule set, pure and free of React. Nothing here touches the DOM.
- `game.tsx` — board, HUD, sounds, animation timing.
- `tests/physics.test.ts` — scenario tests plus the two structural guarantees the design rests on: a tick never freezes while any group wants to move, and every cascade terminates. Also fuzzes full games and compares against the previous engine.

```
npm install
npm run dev     # play it
npm test        # physics suite
npm run build
```
