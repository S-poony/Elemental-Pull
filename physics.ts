// --- REACTOR ATTRACTOR: PHYSICS ---
//
// Everything in this file is pure: no React, no DOM, no randomness. The
// component drives it, the test suite drives it, and both see identical
// behaviour. Two laws describe the whole game:
//
//   1. Attraction adds up. Every piece is pulled by the nearest piece that
//      attracts it in each of the four directions, and a pull gets weaker
//      with distance (1/d²). A group's pulls sum into one vector, and the
//      group slides one cell along whichever axis wins.
//   2. When the pulls cancel, motion persists. A group being pulled from
//      several sides that exactly balance keeps going the way it was
//      already going, instead of deadlocking.
//
// Momentum is strictly a tiebreak between real pulls. A group that nothing
// attracts does not move, full stop — no matter how it was moving a moment
// ago. Friction, if you like; but really it's that "nothing is pulling me"
// and "the pulls cancel" are different situations, and only the second one
// is a tie that needs breaking.
//
// That's it. There is no tie-lock, no "closest pull on the board wins"
// filter, and no rule that cancels everyone's move when two groups
// disagree — the previous engine had all four, and between them they froze
// the board constantly.

// --- TYPES ---
export type ColorKey = 'R' | 'G' | 'B';

export interface Piece {
  id: number;
  color: ColorKey;
  r: number;
  c: number;
  groupId: number;
}

export interface Dir {
  dr: number;
  dc: number;
}

// A group's heading: the direction it last actually moved. Lives only for
// the duration of one turn's cascade — see clearing note in resolveTick.
export type Headings = Record<number, Dir>;

export interface GroupForce {
  groupId: number;
  // Net pull, in integer force units. +fx is right (dc +1), +fy is down
  // (dr +1), matching row/col orientation.
  fx: number;
  fy: number;
  // Strength of the winning axis — what strongest-first ordering sorts on.
  // Zero for a coasting group, which is correct: momentum yields to force.
  magnitude: number;
  // Where this group wants to go, or null if it is balanced and at rest.
  dir: Dir | null;
  // True when dir came from momentum rather than from a net pull.
  coasting: boolean;
  attractorIds: number[];
  pieceCount: number;
}

export interface AcceptedMove {
  groupId: number;
  dir: Dir;
  // Every group carried along, including the ones being shoved.
  groups: number[];
  coasting: boolean;
  magnitude: number;
}

export interface MovePlan {
  forces: Record<number, GroupForce>;
  moveByGroup: Record<number, Dir>;
  accepted: AcceptedMove[];
}

// --- BOARD CONSTANTS ---
// Was 8. Everything downstream reads this constant — the force table, the
// placement scan, the grid template in game.tsx — so the size is a genuine
// parameter, with one caveat: FORCE_UNIT below must stay divisible by d²
// for every d up to GRID_SIZE, which holds for any size up to 8.
export const GRID_SIZE = 5;

// Attraction is a three-way cycle: key attracts value, so the value is the
// one that moves. Same-color pieces are inert to each other — they never
// pull, though they do fuse if they end up touching.
export const ATTRACTION_RULES: Record<ColorKey, ColorKey> = {
  R: 'G',
  G: 'B',
  B: 'R',
};

export const isOnBoard = (r: number, c: number): boolean =>
  r >= 0 && r <= GRID_SIZE - 1 && c >= 0 && c <= GRID_SIZE - 1;

export const PULL_DIRS: Dir[] = [
  { dr: -1, dc: 0 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: -1 },
  { dr: 0, dc: 1 },
];

// Last-resort ordering for the vanishingly rare tie that survives both
// momentum rules and the sharpest-pull rule. Up, left, down, right.
const DIR_PRIORITY: Dir[] = [
  { dr: -1, dc: 0 },
  { dr: 0, dc: -1 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: 1 },
];

export const sameDir = (a: Dir, b: Dir): boolean => a.dr === b.dr && a.dc === b.dc;
const isReverse = (a: Dir, b: Dir): boolean => a.dr === -b.dr && a.dc === -b.dc;
const dirKey = (d: Dir): string => `${d.dr},${d.dc}`;

// --- FORCE WEIGHTS ---
// Force falls off as 1/d². Using floats here would be a trap: "these two
// pulls cancel exactly" is a load-bearing statement in this engine (it is
// what hands control to momentum), and floating point turns exact
// cancellation into a near-miss that silently moves the group. So weights
// are integers instead. 705600 is divisible by every d² for d = 1..8, so
// every weight below is exact and every sum of them is exact.
const FORCE_UNIT = 705600;
const FORCE_BY_DIST: number[] = (() => {
  const table: number[] = [0];
  for (let d = 1; d <= GRID_SIZE; d++) table.push(Math.round(FORCE_UNIT / (d * d)));
  return table;
})();
export const forceAtDistance = (d: number): number =>
  FORCE_BY_DIST[d] !== undefined ? FORCE_BY_DIST[d] : Math.round(FORCE_UNIT / (d * d));

// Reference strength for UI readouts. Deliberately the weight at distance
// 2, not 1: a piece one cell from its attractor is touching it, and
// touching pieces bind into one group and stop pulling each other. So
// distance 2 is the strongest pull that can actually exist on a settled
// board, and scaling against distance 1 would make every arrow look faint.
export const REFERENCE_FORCE = FORCE_BY_DIST[2];

// --- BINDING ---
// Two touching pieces fuse into one group when either attracts the other,
// or when they share a color. Fusing is what takes a pair out of play as a
// pulling pair, which is why cascades always terminate.
export const bindAdjacentPieces = (
  currentPieces: Piece[]
): { pieces: Piece[]; didBind: boolean } => {
  let didBind = false;
  const tempPieces = currentPieces.map((p) => ({ ...p }));

  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    for (let i = 0; i < tempPieces.length; i++) {
      for (let j = i + 1; j < tempPieces.length; j++) {
        const p1 = tempPieces[i];
        const p2 = tempPieces[j];
        if (p1.groupId === p2.groupId) continue;

        const isAdjacent =
          (Math.abs(p1.r - p2.r) === 1 && p1.c === p2.c) ||
          (Math.abs(p1.c - p2.c) === 1 && p1.r === p2.r);
        if (!isAdjacent) continue;

        const binds =
          ATTRACTION_RULES[p1.color] === p2.color ||
          ATTRACTION_RULES[p2.color] === p1.color ||
          p1.color === p2.color;
        if (!binds) continue;

        const targetGroupId = Math.min(p1.groupId, p2.groupId);
        const sourceGroupId = Math.max(p1.groupId, p2.groupId);
        tempPieces.forEach((p) => {
          if (p.groupId === sourceGroupId) p.groupId = targetGroupId;
        });
        mergedAny = true;
        didBind = true;
      }
    }
  }
  return { pieces: tempPieces, didBind };
};

// --- SENSING ---
// Scans outward from a piece in one direction for the nearest piece that
// attracts it. Inert pieces don't block the view — nothing shields a piece
// from attraction, which keeps the rule stateless and easy to eyeball.
export const findAttractorInDirection = (
  p: Piece,
  dr: number,
  dc: number,
  piecesList: Piece[]
): { target: Piece; dist: number } | null => {
  let currR = p.r + dr;
  let currC = p.c + dc;
  let dist = 0;
  while (isOnBoard(currR, currC)) {
    dist += 1;
    const hit = piecesList.find((item) => item.r === currR && item.c === currC);
    if (hit && hit.groupId !== p.groupId && ATTRACTION_RULES[hit.color] === p.color) {
      return { target: hit, dist };
    }
    currR += dr;
    currC += dc;
  }
  return null;
};

// --- DIRECTION FROM FORCE + MOMENTUM ---
// The tiebreak ladder, in order. Only the first two rungs are player-facing
// ("it keeps going"); the rest exist so that no configuration can ever
// deadlock, and they fire almost never.
export const resolveDirection = (
  fx: number,
  fy: number,
  heading: Dir | undefined,
  nearestByDir: Record<string, number>,
  hasPull: boolean
): { dir: Dir | null; coasting: boolean } => {
  // Nothing is attracting this group, so nothing moves it. This check has
  // to come first: without it, momentum would carry a group that has no
  // reason to move at all, and a lone tile with an empty board in front of
  // it would sail off the far edge.
  if (!hasPull) return { dir: null, coasting: false };

  const ax = Math.abs(fx);
  const ay = Math.abs(fy);

  // Pulled, but the pulls cancel. This is the tie momentum exists to
  // break: a group already in motion carries on, a group at rest stays
  // balanced where it is.
  if (ax === 0 && ay === 0) {
    return heading ? { dir: heading, coasting: true } : { dir: null, coasting: false };
  }

  if (ax > ay) return { dir: { dr: 0, dc: Math.sign(fx) }, coasting: false };
  if (ay > ax) return { dir: { dr: Math.sign(fy), dc: 0 }, coasting: false };

  // Exact diagonal tie: equal pull on both axes. Both components are
  // non-zero here, so there are exactly two candidates at right angles.
  const candidates: Dir[] = [
    { dr: Math.sign(fy), dc: 0 },
    { dr: 0, dc: Math.sign(fx) },
  ];

  if (heading) {
    // Carry straight on if the heading is one of the options.
    const straight = candidates.find((d) => sameDir(d, heading));
    if (straight) return { dir: straight, coasting: false };
    // Otherwise refuse to reverse: turning is cheaper than flipping.
    const notReversing = candidates.filter((d) => !isReverse(d, heading));
    if (notReversing.length === 1) return { dir: notReversing[0], coasting: false };
  }

  // Equal totals, so fall back to sharpness: follow whichever side has the
  // single closest attractor.
  let bestDist = Infinity;
  candidates.forEach((d) => {
    const dist = nearestByDir[dirKey(d)];
    if (dist !== undefined && dist < bestDist) bestDist = dist;
  });
  const sharpest = candidates.filter((d) => (nearestByDir[dirKey(d)] ?? Infinity) === bestDist);
  if (sharpest.length === 1) return { dir: sharpest[0], coasting: false };

  const byPriority = DIR_PRIORITY.find((pd) => sharpest.some((d) => sameDir(d, pd)));
  return { dir: byPriority ?? candidates[0], coasting: false };
};

// --- NET FORCE PER GROUP ---
export const computeGroupForces = (
  piecesList: Piece[],
  headings: Headings = {}
): Record<number, GroupForce> => {
  const acc: Record<
    number,
    {
      fx: number;
      fy: number;
      attractors: Set<number>;
      nearest: Record<string, number>;
      count: number;
      pulls: number;
    }
  > = {};

  piecesList.forEach((p) => {
    if (!acc[p.groupId]) {
      acc[p.groupId] = { fx: 0, fy: 0, attractors: new Set(), nearest: {}, count: 0, pulls: 0 };
    }
    acc[p.groupId].count += 1;
  });

  piecesList.forEach((p) => {
    const a = acc[p.groupId];
    PULL_DIRS.forEach(({ dr, dc }) => {
      const found = findAttractorInDirection(p, dr, dc, piecesList);
      if (!found) return;
      const w = forceAtDistance(found.dist);
      a.fx += dc * w;
      a.fy += dr * w;
      a.pulls += 1;
      a.attractors.add(found.target.id);
      const k = dirKey({ dr, dc });
      if (a.nearest[k] === undefined || found.dist < a.nearest[k]) a.nearest[k] = found.dist;
    });
  });

  const out: Record<number, GroupForce> = {};
  Object.keys(acc).forEach((key) => {
    const groupId = Number(key);
    const a = acc[groupId];
    const { dir, coasting } = resolveDirection(
      a.fx,
      a.fy,
      headings[groupId],
      a.nearest,
      a.pulls > 0
    );
    out[groupId] = {
      groupId,
      fx: a.fx,
      fy: a.fy,
      magnitude: Math.max(Math.abs(a.fx), Math.abs(a.fy)),
      dir,
      coasting,
      attractorIds: Array.from(a.attractors),
      pieceCount: a.count,
    };
  });
  return out;
};

// --- PUSHING ---
// A moving group shoves whatever sits in its path, and anything blocking
// that, breadth-first, until the whole chain is accounted for.
export const getPushSet = (
  startGroupId: number,
  dr: number,
  dc: number,
  currentPieces: Piece[]
): number[] => {
  const affected = new Set<number>([startGroupId]);
  let frontier = [startGroupId];

  while (frontier.length > 0) {
    const next: number[] = [];
    frontier.forEach((gId) => {
      currentPieces
        .filter((p) => p.groupId === gId)
        .forEach((piece) => {
          const blocking = currentPieces.find(
            (other) => other.r === piece.r + dr && other.c === piece.c + dc
          );
          if (blocking && !affected.has(blocking.groupId)) {
            affected.add(blocking.groupId);
            next.push(blocking.groupId);
          }
        });
    });
    frontier = next;
  }
  return Array.from(affected);
};

export const applyMoves = (piecesList: Piece[], moveByGroup: Record<number, Dir>): Piece[] =>
  piecesList.map((p) => {
    const m = moveByGroup[p.groupId];
    return m ? { ...p, r: p.r + m.dr, c: p.c + m.dc } : p;
  });

// Two pieces sharing a cell is only a problem on the board. Off the edge
// everything involved is about to be culled anyway, and refusing moves out
// there would block exactly the moves that score.
const hasOnBoardCollision = (piecesList: Piece[]): boolean => {
  const seen = new Set<string>();
  for (const p of piecesList) {
    if (!isOnBoard(p.r, p.c)) continue;
    const k = `${p.r},${p.c}`;
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
};

// --- MOVE PLANNING ---
// Strongest pull commits first. A group whose path was taken doesn't
// cancel anything — it simply isn't in this tick, and gets another look
// 250ms later when the next tick plans afresh. That single change is what
// turns "blocked" into "queued".
//
// Guarantee worth knowing: the first candidate can never be rejected. Its
// push set is closed by construction (anything in the way is inside it and
// moves too), so no collision is possible and nothing is committed yet to
// conflict with. Therefore at least one group moves on every tick where
// any group has a direction — a board-wide freeze is now unreachable.
export const planMoves = (piecesList: Piece[], headings: Headings = {}): MovePlan => {
  const forces = computeGroupForces(piecesList, headings);

  const movers = Object.values(forces)
    .filter((f) => f.dir !== null)
    .sort((a, b) => b.magnitude - a.magnitude || a.groupId - b.groupId);

  const moveByGroup: Record<number, Dir> = {};
  const accepted: AcceptedMove[] = [];
  let board = piecesList;

  movers.forEach((f) => {
    // Already being carried along by something stronger.
    if (moveByGroup[f.groupId] !== undefined) return;
    const dir = f.dir as Dir;

    const push = getPushSet(f.groupId, dir.dr, dir.dc, board);
    // Nothing moves twice in one tick, so a chain that reaches something
    // already committed waits instead.
    if (push.some((g) => moveByGroup[g] !== undefined)) return;

    const trial: Record<number, Dir> = { ...moveByGroup };
    push.forEach((g) => {
      trial[g] = dir;
    });
    if (hasOnBoardCollision(applyMoves(piecesList, trial))) return;

    push.forEach((g) => {
      moveByGroup[g] = dir;
    });
    accepted.push({
      groupId: f.groupId,
      dir,
      groups: push,
      coasting: f.coasting,
      magnitude: f.magnitude,
    });
    board = applyMoves(piecesList, moveByGroup);
  });

  return { forces, moveByGroup, accepted };
};

// --- HEADING BOOKKEEPING ---
// Rebuilds the heading map against the post-bind board. Three jobs at once:
// groups that were culled drop out (they have no pieces left to claim a
// heading), groups that merged inherit from whichever contributor was
// actually moving, and everything else passes through untouched.
export const remapHeadings = (
  headings: Headings,
  boundPieces: Piece[],
  prevGroupByPieceId: Record<number, number>,
  moveByGroup: Record<number, Dir>,
  forces: Record<number, GroupForce>
): Headings => {
  const contributors: Record<number, Set<number>> = {};
  boundPieces.forEach((p) => {
    const prev = prevGroupByPieceId[p.id];
    if (prev === undefined) return;
    if (!contributors[p.groupId]) contributors[p.groupId] = new Set();
    contributors[p.groupId].add(prev);
  });

  const out: Headings = {};
  Object.keys(contributors).forEach((key) => {
    const groupId = Number(key);
    const ranked = Array.from(contributors[groupId])
      .filter((old) => headings[old] !== undefined)
      .sort((a, b) => {
        // A group that moved this tick carries the momentum into the merge;
        // a stationary partner must not erase it.
        const movedA = moveByGroup[a] !== undefined ? 1 : 0;
        const movedB = moveByGroup[b] !== undefined ? 1 : 0;
        if (movedA !== movedB) return movedB - movedA;
        const magA = forces[a]?.magnitude ?? 0;
        const magB = forces[b]?.magnitude ?? 0;
        if (magA !== magB) return magB - magA;
        return a - b;
      });
    if (ranked.length > 0) out[groupId] = headings[ranked[0]];
  });
  return out;
};

// A freshly placed tile arrives with no heading at all. An earlier draft
// gave it one pointing inward from the edge it was dropped on, as a second
// lever for the player; combined with coasting that turned every placement
// into a tile sailing across the board under its own steam. Placement sets
// position and nothing else.

// --- ONE TICK ---
// Move, cull what left the board, then fuse whatever ended up touching.
// Returns the number of pieces that moved so the caller can score them, and
// the destroyed snapshots so it can animate the bursts.
export interface TickResult {
  pieces: Piece[];
  headings: Headings;
  plan: MovePlan;
  moved: boolean;
  // Pieces that changed cell this tick, counted BEFORE the off-board cull —
  // a group's final move off the edge is the payoff move and must score.
  movedPieceCount: number;
  destroyed: Piece[];
  didBind: boolean;
}

export const resolveTick = (piecesList: Piece[], headings: Headings): TickResult => {
  const plan = planMoves(piecesList, headings);

  if (plan.accepted.length === 0) {
    // The cascade has settled. Headings are deliberately dropped here
    // rather than carried into the next turn: a board at rest should be
    // fully readable from the tiles alone, with no invisible momentum the
    // player has to remember from several turns ago.
    return {
      pieces: piecesList,
      headings: {},
      plan,
      moved: false,
      movedPieceCount: 0,
      destroyed: [],
      didBind: false,
    };
  }

  const movedPieceCount = piecesList.filter(
    (p) => plan.moveByGroup[p.groupId] !== undefined
  ).length;

  let nextPieces = applyMoves(piecesList, plan.moveByGroup);
  const nextHeadings: Headings = { ...headings };
  Object.keys(plan.moveByGroup).forEach((g) => {
    nextHeadings[Number(g)] = plan.moveByGroup[Number(g)];
  });

  const escaped = new Set(
    nextPieces.filter((p) => !isOnBoard(p.r, p.c)).map((p) => p.groupId)
  );
  let destroyed: Piece[] = [];
  if (escaped.size > 0) {
    destroyed = nextPieces.filter((p) => escaped.has(p.groupId));
    nextPieces = nextPieces.filter((p) => !escaped.has(p.groupId));
  }

  const prevGroupByPieceId: Record<number, number> = {};
  nextPieces.forEach((p) => {
    prevGroupByPieceId[p.id] = p.groupId;
  });
  const bindResult = bindAdjacentPieces(nextPieces);
  nextPieces = bindResult.pieces;

  return {
    pieces: nextPieces,
    headings: remapHeadings(
      nextHeadings,
      nextPieces,
      prevGroupByPieceId,
      plan.moveByGroup,
      plan.forces
    ),
    plan,
    moved: true,
    movedPieceCount,
    destroyed,
    didBind: bindResult.didBind,
  };
};

// --- SCORING ---
// Motion is the score. Every piece that changes cell on a tick is worth
// POINTS_PER_MOVED_PIECE, counted fresh each tick, so a long cascade pays
// out over and over while a board that barely twitches pays almost nothing.
//
// Pieces leaving the board still explode — that's what keeps the edge clear
// and the game playable — but the explosion itself is worth zero. An earlier
// version scored destruction triangularly by group size; that rewarded
// hoarding one huge group and ignored the chain reactions the physics is
// actually about. Points now come from the reaction, not the disposal.
export const POINTS_PER_MOVED_PIECE = 1;

export const computeMovementScore = (movedPieceCount: number): number =>
  POINTS_PER_MOVED_PIECE * movedPieceCount;

// --- PLACEMENT ---
// A tile may go on any empty cell that doesn't orthogonally touch one
// already on the board. Placement used to be restricted to the outer edge;
// the whole board is open now, and the no-touching rule is what keeps the
// player from simply hand-assembling a group.
//
// Orthogonal deliberately matches bindAdjacentPieces exactly, which makes a
// useful guarantee: a placement can never fuse on arrival. Every new tile
// lands as its own group and has to be pulled into contact by the physics.
// Diagonal drops stay legal, so the tightest opening a player can engineer
// is a knight's-move-free diagonal pair — close, but still a real move away
// from binding.
export const isLegalPlacement = (r: number, c: number, piecesList: Piece[]): boolean => {
  if (!isOnBoard(r, c)) return false;
  return !piecesList.some(
    (p) =>
      (p.r === r && p.c === c) ||
      (Math.abs(p.r - r) + Math.abs(p.c - c) === 1)
  );
};

// Game over when the board offers nowhere legal left to drop.
export const hasLegalPlacement = (piecesList: Piece[]): boolean => {
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (isLegalPlacement(r, c, piecesList)) return true;
    }
  }
  return false;
};
