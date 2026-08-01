import React, { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react';
import { RotateCcw, HelpCircle, Trophy, AlertTriangle, ChevronUp, Volume2, VolumeX } from 'lucide-react';

// --- TYPES ---
type ColorKey = 'R' | 'G' | 'B';

interface ColorConfig {
  name: string;
  // Tile fill, and a slightly deeper shade of the same hue used for the
  // tile's lower edge so pieces read as solid objects rather than flat
  // discs — the same trick 2048's tiles use.
  hex: string;
  dark: string;
}

interface Piece {
  id: number;
  color: ColorKey;
  r: number;
  c: number;
  groupId: number;
}

interface DestroyedPiece {
  id: number;
  color: ColorKey;
  r: number;
  c: number;
}

interface Pull {
  attractedGroupId: number;
  pieceId: number;
  dr: number;
  dc: number;
  dist: number;
  attractorId: number;
}

interface Dir {
  dr: number;
  dc: number;
}

interface GroupInfo {
  groupId: number;
  dist: number;
  isTieLocked: boolean;
  attractorIds: number[];
  sensingPieceIds: number[];
  dr: number;
  dc: number;
}

interface ValidGroupPull {
  attractedGroupId: number;
  dr: number;
  dc: number;
  dist: number;
}

interface Claim {
  pull: ValidGroupPull;
  affectedGroupIds: number[];
}

interface ScoreFlash {
  amount: number;
  key: number;
}

// --- GAME CONFIG & CONSTANTS ---
const GRID_SIZE = 8;
// Warm-toned red/green/blue chosen to sit on the tan board without
// fighting it — same hues as before, pulled towards 2048's palette.
const COLORS: Record<ColorKey, ColorConfig> = {
  R: { name: 'Red', hex: '#F2603C', dark: '#D64A28' },
  G: { name: 'Green', hex: '#9DBF56', dark: '#82A340' },
  B: { name: 'Blue', hex: '#6BA3C9', dark: '#5089AF' },
};

// --- 2048-STYLE THEME ---
// One place for the board's warm neutrals so the header, HUD, board,
// links and overlays can't drift apart from each other.
const THEME = {
  page: '#FAF8EF',       // cream page background
  board: '#BBADA0',      // tan board box
  cell: '#CDC1B4',       // empty cell, a shade lighter than the board
  ink: '#776E65',        // primary text
  inkSoft: '#A29A90',    // secondary text / labels
  button: '#8F7A66',     // buttons + group link bridges
  buttonHover: '#9F8B77',
} as const;

// Attraction rules: Key attracts Value (Value is pulled towards Key).
// The cycle is directional — a piece is pulled towards the nearest piece
// of the color that attracts it, and two touching pieces bind whenever
// EITHER of them attracts the other. Same-color pieces are inert to each
// other and never move on their account.
const ATTRACTION_RULES: Record<ColorKey, ColorKey> = {
  R: 'G', // Red attracts Green
  G: 'B', // Green attracts Blue
  B: 'R', // Blue attracts Red
};

// Check if a cell is on the 8x8 outer edge
const isOuterEdge = (r: number, c: number): boolean => {
  return r === 0 || r === GRID_SIZE - 1 || c === 0 || c === GRID_SIZE - 1;
};

// Pieces are culled the instant they leave the visible board — no drift
// buffer past the edge. MIN_COORD/MAX_COORD line up exactly with the
// board's own bounds as a result.
const BOUNDS_MARGIN = 0;
const MIN_COORD = -BOUNDS_MARGIN;
const MAX_COORD = GRID_SIZE - 1 + BOUNDS_MARGIN;

// --- OFF-GRID VISUAL COMPRESSION ---
// Historically pieces could drift past the edge before being culled, so
// this reserved a compressed rendering margin around the board for them.
// Pieces now vanish the instant they leave the grid, so there's nothing
// left to render out there — the margin collapses to 0 and the board box
// simply fills the entire stage.
const MAX_MARGIN_CELLS = 0;
const OFFSET_SOFTNESS = 2.2;
const compressedOffset = (trueDist: number): number => (MAX_MARGIN_CELLS * trueDist) / (trueDist + OFFSET_SOFTNESS);

// Total stage size in "cell units": the 8x8 board plus compression margin
// on both sides. The bordered board itself only occupies GRID_BOX_SIZE_PCT
// of the stage — the rest is room for off-grid pieces to render into.
const STAGE_CELLS = GRID_SIZE + 2 * MAX_MARGIN_CELLS;
const CELL_STAGE_PCT = 100 / STAGE_CELLS;
const GRID_BOX_OFFSET_PCT = MAX_MARGIN_CELLS * CELL_STAGE_PCT;
const GRID_BOX_SIZE_PCT = GRID_SIZE * CELL_STAGE_PCT;

// The bordered board box has its own internal padding + gap between cells
// (drawn below via these exact same constants, as % of the box's own
// size — not px — so they scale with the box and stay in sync with the
// piece-overlay math at every screen size instead of drifting apart at
// Tailwind's responsive breakpoints).
const BOARD_PAD_FRAC = 0.025;
const CELL_GAP_FRAC = 0.01;
const CELL_CONTENT_FRAC = 1 - 2 * BOARD_PAD_FRAC;
// Size of one on-grid cell, and the left-edge-to-left-edge step to the
// next one, both expressed as a fraction of the board box's own size.
const ON_GRID_CELL_FRAC = (CELL_CONTENT_FRAC - (GRID_SIZE - 1) * CELL_GAP_FRAC) / GRID_SIZE;
const ON_GRID_STEP_FRAC = ON_GRID_CELL_FRAC + CELL_GAP_FRAC;
// Same cell size, converted into "stage cell units" so it can be used
// directly as a width/height alongside coordToStageCellUnits below.
const ON_GRID_CELL_STAGE_UNITS = ON_GRID_CELL_FRAC * GRID_SIZE;

// CSS quirk: a percentage `padding` resolves against the CONTAINING BLOCK's
// width (the stage), not against the padded element's own size (the board
// box) — even though the board box's own width is itself only
// GRID_BOX_SIZE_PCT% of the stage. So to actually get BOARD_PAD_FRAC worth
// of padding relative to the board box, the inline style must use this
// stage-relative value instead of BOARD_PAD_FRAC directly.
const BOARD_PAD_STAGE_PCT = BOARD_PAD_FRAC * GRID_BOX_SIZE_PCT;
// CSS Grid `gap` percentages, unlike padding, resolve against the grid
// container's own content box — which here is already the padded-in area
// (CELL_CONTENT_FRAC of the board box) — so this converts CELL_GAP_FRAC
// (a fraction of the board box) into the matching fraction of that smaller
// content box.
const CELL_GAP_GRID_PCT = (CELL_GAP_FRAC / CELL_CONTENT_FRAC) * 100;
// How far each bridge needs to reach past its own cell's edge, as a % of
// its own (small) box, so two neighboring bridges meet in the middle of
// the real inter-cell gap instead of each stopping short of it.
const BRIDGE_OVERSHOOT_PCT = (CELL_GAP_FRAC / ON_GRID_CELL_FRAC / 2) * 100;

// Base z-index for pieces (PIECES LAYER, see render): each piece's actual
// z-index is PIECE_Z_BASE - dist, so pieces closer to the grid stack above
// ones that have drifted further out. Set comfortably above BOUNDS_MARGIN
// (the furthest a piece can drift before being culled) so this never goes
// negative and sinks below the links layer's z-index: 0.
const PIECE_Z_BASE = 1000;

// Maps a single coordinate (row or col — can be negative or >= GRID_SIZE)
// to its position within the stage, in cell units from the stage's edge.
// On-grid coords land on the true left/top edge of their rendered cell
// (padding + gap included) instead of an idealized zero-gap grid, so
// pieces sit centered on the cells you actually see.
const coordToStageCellUnits = (coord: number): number => {
  if (coord >= 0 && coord <= GRID_SIZE - 1) {
    const leftFrac = BOARD_PAD_FRAC + coord * ON_GRID_STEP_FRAC;
    return MAX_MARGIN_CELLS + leftFrac * GRID_SIZE;
  }
  if (coord < 0) {
    return MAX_MARGIN_CELLS - compressedOffset(-coord);
  }
  const dist = coord - (GRID_SIZE - 1);
  return MAX_MARGIN_CELLS + (GRID_SIZE - 1) + compressedOffset(dist);
};

// True (uncompressed) distance past the board edge, in real grid cells —
// drives shrink/fade/warning intensity so it still reads as "8 is the
// cull line," even though the visual position itself is compressed.
const trueDistPastEdge = (r: number, c: number): number => {
  const dr = r < 0 ? -r : r > GRID_SIZE - 1 ? r - (GRID_SIZE - 1) : 0;
  const dc = c < 0 ? -c : c > GRID_SIZE - 1 ? c - (GRID_SIZE - 1) : 0;
  return Math.max(dr, dc);
};

// dist=0 (on-grid) -> full size, opaque, no warning.
// dist=BOUNDS_MARGIN (about to be culled) -> smallest/faintest, pulsing.
const OFFGRID_WARNING_THRESHOLD = 6;
const getPieceVisualStyle = (dist: number) => {
  const scale = 1 - 0.5 * (dist / (dist + 2));
  const opacity = 1 - 0.3 * (dist / (dist + 3));
  const warning = dist >= OFFGRID_WARNING_THRESHOLD;
  return { scale, opacity, warning };
};

// Pure helper function to bind adjacent pieces that have attraction relationships
const bindAdjacentPieces = (currentPieces: Piece[]): { pieces: Piece[]; didBind: boolean } => {
  let didBind = false;
  const tempPieces = currentPieces.map(p => ({ ...p }));

  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    for (let i = 0; i < tempPieces.length; i++) {
      for (let j = i + 1; j < tempPieces.length; j++) {
        const p1 = tempPieces[i];
        const p2 = tempPieces[j];

        if (p1.groupId !== p2.groupId) {
          // Check adjacency
          const isAdjacent = (Math.abs(p1.r - p2.r) === 1 && p1.c === p2.c) || 
                             (Math.abs(p1.c - p2.c) === 1 && p1.r === p2.r);

          if (isAdjacent) {
            // Pieces bind on contact when either one attracts the other,
            // and same-colored pieces bind too — they don't pull each
            // other, but they fuse into one group if they end up touching.
            const p1AttractsP2 = ATTRACTION_RULES[p1.color] === p2.color;
            const p2AttractsP1 = ATTRACTION_RULES[p2.color] === p1.color;
            const sameColor = p1.color === p2.color;

            if (p1AttractsP2 || p2AttractsP1 || sameColor) {
              const targetGroupId = Math.min(p1.groupId, p2.groupId);
              const sourceGroupId = Math.max(p1.groupId, p2.groupId);

              tempPieces.forEach((p) => {
                if (p.groupId === sourceGroupId) {
                  p.groupId = targetGroupId;
                }
              });
              mergedAny = true;
              didBind = true;
            }
          }
        }
      }
    }
  }
  return { pieces: tempPieces, didBind };
};

// Pure helper: scans from a piece in one direction, skipping over inert
// pieces/empty cells, to find the nearest piece that actually attracts it.
// Shared by the resolution engine and the live "who's attracting whom"
// overlay, so both always agree on exactly the same rules.
const findAttractorInDirection = (p: Piece, dr: number, dc: number, piecesList: Piece[]): { target: Piece; dist: number } | null => {
  let currR = p.r + dr;
  let currC = p.c + dc;
  let dist = 0;
  while (currR >= MIN_COORD && currR <= MAX_COORD && currC >= MIN_COORD && currC <= MAX_COORD) {
    dist += 1;
    const hit = piecesList.find((item) => item.r === currR && item.c === currC);
    if (hit) {
      if (hit.groupId !== p.groupId && ATTRACTION_RULES[hit.color] === p.color) {
        return { target: hit, dist };
      }
      // Inert relative to p — doesn't block the view, keep scanning.
    }
    currR += dr;
    currC += dc;
  }
  return null;
};

const PULL_DIRS: Dir[] = [
  { dr: -1, dc: 0 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: -1 },
  { dr: 0, dc: 1 }
];

// Pure helper: for every group on the board, finds its closest attractor(s)
// this tick. Returns:
//  - groupInfo: per-group breakdown (attractor piece ids, tie-locked or
//    not, pull direction) — used to drive the live highlight overlay even
//    while the board is idle or frozen in a tie-lock.
//  - validGroupPulls: flattened list of groups with a single unambiguous
//    closest pull — exactly what the resolution engine acts on.
const computeGroupPulls = (piecesList: Piece[]): { groupInfo: Record<number, GroupInfo>; validGroupPulls: ValidGroupPull[] } => {
  const pulls: Pull[] = [];
  piecesList.forEach((p) => {
    PULL_DIRS.forEach(({ dr, dc }) => {
      const found = findAttractorInDirection(p, dr, dc, piecesList);
      if (found) {
        pulls.push({ attractedGroupId: p.groupId, pieceId: p.id, dr, dc, dist: found.dist, attractorId: found.target.id });
      }
    });
  });

  const byGroup: Record<number, Pull[]> = {};
  pulls.forEach((pull) => {
    if (!byGroup[pull.attractedGroupId]) byGroup[pull.attractedGroupId] = [];
    byGroup[pull.attractedGroupId].push(pull);
  });

  const groupInfo: Record<number, GroupInfo> = {};
  const validGroupPulls: ValidGroupPull[] = [];

  Object.keys(byGroup).forEach((gId) => {
    const groupList = byGroup[Number(gId)];
    groupList.sort((a, b) => a.dist - b.dist);
    const bestDist = groupList[0].dist;
    const ties = groupList.filter((p) => p.dist === bestDist);

    const uniqueDirs: Dir[] = [];
    ties.forEach((t) => {
      if (!uniqueDirs.some((d) => d.dr === t.dr && d.dc === t.dc)) {
        uniqueDirs.push({ dr: t.dr, dc: t.dc });
      }
    });

    const isTieLocked = uniqueDirs.length > 1;
    const attractorIds = Array.from(new Set(ties.map((t) => t.attractorId)));
    // The piece(s) within the group whose own scan produced one of the
    // pulls at this group's best distance — relevant for both the tie
    // badge (when tied) and the directional arrow (when not), so neither
    // ends up plastered across every piece in the group.
    const sensingPieceIds = Array.from(new Set(ties.map((t) => t.pieceId)));

    groupInfo[Number(gId)] = {
      groupId: Number(gId),
      dist: bestDist,
      isTieLocked,
      attractorIds,
      sensingPieceIds,
      dr: isTieLocked ? 0 : uniqueDirs[0].dr,
      dc: isTieLocked ? 0 : uniqueDirs[0].dc
    };

    if (!isTieLocked) {
      validGroupPulls.push({ attractedGroupId: Number(gId), dr: uniqueDirs[0].dr, dc: uniqueDirs[0].dc, dist: bestDist });
    }
  });

  return { groupInfo, validGroupPulls };
};

// Push rule: a moving group shoves whatever group is directly in front of
// it, and if THAT group is in turn blocked by yet another group, the chain
// keeps extending (breadth-first) until every group that would have to
// move is accounted for. Without this chaining, a group three or more
// deep in a line would be left out of the affected set entirely — it
// wouldn't move, but the piece in front of it would still be assigned a
// tentative position right on top of it, which is exactly the kind of gap
// that let same-colored pieces visually overlap ("fuse") instead of
// cleanly blocking or binding.
const getPushSet = (startGroupId: number, dr: number, dc: number, currentPieces: Piece[]): number[] => {
  const affectedGroupIds = new Set<number>([startGroupId]);
  let frontier = [startGroupId];

  while (frontier.length > 0) {
    const nextFrontier: number[] = [];
    frontier.forEach((gId) => {
      const groupPieces = currentPieces.filter((p) => p.groupId === gId);
      groupPieces.forEach((piece) => {
        const nextR = piece.r + dr;
        const nextC = piece.c + dc;
        const blockingPiece = currentPieces.find((other) => other.r === nextR && other.c === nextC);

        if (blockingPiece && !affectedGroupIds.has(blockingPiece.groupId)) {
          affectedGroupIds.add(blockingPiece.groupId);
          nextFrontier.push(blockingPiece.groupId);
        }
      });
    });
    frontier = nextFrontier;
  }

  return Array.from(affectedGroupIds);
};

// Pure function: given the current board, works out exactly which group(s)
// would actually move THIS tick and in which direction. The resolver keeps
// only claims that do not conflict with another claim and ignores the
// heavier chain-reaction loop from the previous version.
const resolveWinningPulls = (piecesList: Piece[]): Claim[] => {
  const { validGroupPulls } = computeGroupPulls(piecesList);
  if (validGroupPulls.length === 0) return [];

  const globalMinDist = Math.min(...validGroupPulls.map((p) => p.dist));
  const candidatePulls = validGroupPulls.filter((p) => p.dist === globalMinDist);

  const claims: Claim[] = candidatePulls.map((pull) => ({
    pull,
    affectedGroupIds: getPushSet(pull.attractedGroupId, pull.dr, pull.dc, piecesList)
  }));

  const groupDirClaims: Record<number, Set<string>> = {};
  claims.forEach(({ pull, affectedGroupIds }) => {
    const dirKey = `${pull.dr},${pull.dc}`;
    affectedGroupIds.forEach((gId) => {
      if (!groupDirClaims[gId]) groupDirClaims[gId] = new Set();
      groupDirClaims[gId].add(dirKey);
    });
  });

  const conflictedGroupIds = new Set(
    Object.keys(groupDirClaims)
      .filter((gId) => groupDirClaims[Number(gId)].size > 1)
      .map(Number)
  );

  let survivors = claims.filter(
    ({ affectedGroupIds }) => !affectedGroupIds.some((gId) => conflictedGroupIds.has(gId))
  );

  if (survivors.length > 0) {
    const tentative: { groupId: number; r: number; c: number }[] = [];
    piecesList.forEach((p) => {
      const claim = survivors.find((s) => s.affectedGroupIds.includes(p.groupId));
      tentative.push(claim
        ? { groupId: p.groupId, r: p.r + claim.pull.dr, c: p.c + claim.pull.dc }
        : { groupId: p.groupId, r: p.r, c: p.c });
    });

    const occupied: Record<string, number> = {};
    const collidingGroupIds = new Set<number>();
    tentative.forEach((p) => {
      const key = `${p.r},${p.c}`;
      if (occupied[key] !== undefined && occupied[key] !== p.groupId) {
        collidingGroupIds.add(p.groupId);
        collidingGroupIds.add(occupied[key]);
      }
      occupied[key] = p.groupId;
    });

    if (collidingGroupIds.size > 0) {
      survivors = survivors.filter(
        ({ affectedGroupIds }) => !affectedGroupIds.some((gId) => collidingGroupIds.has(gId))
      );
    }
  }

  return survivors;
};

// --- SCORING ---
// Base points awarded per piece in a destroyed group, before the
// triangular group-size scaling and multi-group combo multiplier below.
const BASE_POINTS_PER_PIECE = 10;
// Extra multiplier added per additional group destroyed within the same
// turn (e.g. 3 separate single-piece groups destroyed together nets a
// 1 + 0.25*2 = 1.5x multiplier on their combined base total).
const COMBO_MULTIPLIER_STEP = 0.25;

// Turns a list of destroyed-group sizes (piece counts) from a single
// turn's resolution cascade into that turn's score. Each group's points
// scale TRIANGULARLY with its size (n*(n+1)/2) rather than linearly, so a
// single bound group of N pieces destroyed together is always worth
// strictly more than N pieces trickling off the board one at a time
// across N separate turns — even though the latter necessarily takes at
// least N turns to rack up the same piece count. Destroying several
// separate groups within the same turn is rewarded too, but more
// modestly, via a flat multiplier applied to the turn's combined total.
const computeDestructionScore = (groupSizes: number[]): number => {
  if (groupSizes.length === 0) return 0;
  const basePoints = groupSizes.reduce(
    (sum, n) => sum + (BASE_POINTS_PER_PIECE * n * (n + 1)) / 2,
    0
  );
  const comboMultiplier = 1 + COMBO_MULTIPLIER_STEP * (groupSizes.length - 1);
  return Math.round(basePoints * comboMultiplier);
};

export default function App() {
  // --- STATE ---
  const [pieces, setPieces] = useState<Piece[]>([]); // List of { id, color, r, c, groupId }
  const [nextColor, setNextColor] = useState<ColorKey>('R');
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(() => {
    return Number(localStorage.getItem('attractors_high_score')) || 0;
  });
  const [isResolving, setIsResolving] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [gameOverReason, setGameOverReason] = useState('');
  const [showTutorial, setShowTutorial] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [lastPlacedCell, setLastPlacedCell] = useState<{ r: number; c: number } | null>(null);
  // Transient "ghost" snapshots of pieces the instant they're destroyed —
  // { id, color, r, c } — used purely to render a brief destruction burst
  // animation at the exact spot each piece vanished. Has no bearing on the
  // authoritative `pieces` state or any game logic.
  const [destroyingPieces, setDestroyingPieces] = useState<DestroyedPiece[]>([]);
  // Brief "+N" pop shown in the HUD whenever score increases
  const [scoreFlash, setScoreFlash] = useState<ScoreFlash | null>(null); // { amount, key }
  const prevScoreRef = useRef(0);

  // For generating unique IDs
  const pieceIdCounter = useRef(0);

  // Accumulates the size (piece count) of every group destroyed so far
  // during the CURRENT turn's resolution cascade (a single placement can
  // trigger several resolution ticks before control returns to the
  // player). Reset at the start of each turn and scored as a whole once
  // the cascade settles — see computeDestructionScore.
  const turnDestroyedGroupSizesRef = useRef<number[]>([]);

  // Single reused AudioContext (browsers cap the number of concurrent
  // contexts, so creating a new one per sound effect breaks audio after
  // enough placements)
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Initialize first color
  useEffect(() => {
    rollNextColor();
  }, []);

  // Close the shared AudioContext when the component unmounts
  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  // Sync high score
  useEffect(() => {
    if (score > highScore) {
      setHighScore(score);
      localStorage.setItem('attractors_high_score', score.toString());
    }
  }, [score, highScore]);

  // Pop a brief "+N" indicator in the HUD whenever score increases
  useEffect(() => {
    const delta = score - prevScoreRef.current;
    if (delta > 0) {
      setScoreFlash({ amount: delta, key: Date.now() });
      const timeout = setTimeout(() => setScoreFlash(null), 900);
      prevScoreRef.current = score;
      return () => clearTimeout(timeout);
    }
    prevScoreRef.current = score;
  }, [score]);

  // Audio Synth triggers for feedback
  const playSound = (type: string) => {
    if (!soundEnabled) return;
    try {
      if (!audioCtxRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        audioCtxRef.current = new AudioContextClass();
      }
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'place') {
        osc.frequency.setValueAtTime(330, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } else if (type === 'slide') {
        osc.frequency.setValueAtTime(150, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.2);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      } else if (type === 'bind') {
        osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.08); // E5
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      } else if (type === 'lose') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(110, ctx.currentTime + 0.6);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.65);
        osc.start();
        osc.stop(ctx.currentTime + 0.65);
      } else if (type === 'vanish') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(500, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.35);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      }
    } catch (e) {
      console.warn("Audio Context blocked or unsupported");
    }
  };

  const rollNextColor = () => {
    const colors: ColorKey[] = ['R', 'G', 'B'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    setNextColor(randomColor);
  };

  const restartGame = () => {
    setPieces([]);
    setScore(0);
    setGameOver(false);
    setGameOverReason('');
    setIsResolving(false);
    setLastPlacedCell(null);
    setDestroyingPieces([]);
    turnDestroyedGroupSizesRef.current = [];
    rollNextColor();
  };

  // Helper to find piece at specific coordinates
  const getPieceAt = useCallback((r: number, c: number, list: Piece[] = pieces) => {
    return list.find((p) => p.r === r && p.c === c);
  }, [pieces]);

  // Main attraction calculation and single step execution
  const runResolutionStep = useCallback(async (currentPieces: Piece[]) => {
    let hasMovement = false;
    let nextPieces = [...currentPieces];

    // Identify each group's closest attractor(s) this tick, looking past
    // inert clutter, with the same board-wide tie-lock rule as the live
    // overlay: a group with more than one unique direction pulling at the
    // minimum distance freezes instead of moving. resolveWinningPulls is
    // the same function the live overlay uses, so what actually moves and
    // what the arrows predicted are guaranteed to match.
    const survivingClaims = resolveWinningPulls(nextPieces);

    if (survivingClaims.length > 0) {
          const moveByGroupId: Record<number, Dir> = {};
          survivingClaims.forEach(({ pull, affectedGroupIds }) => {
            affectedGroupIds.forEach((gId) => {
              moveByGroupId[gId] = { dr: pull.dr, dc: pull.dc };
            });
          });

          nextPieces = nextPieces.map((p) => {
            const move = moveByGroupId[p.groupId];
            if (move) {
              return { ...p, r: p.r + move.dr, c: p.c + move.dc };
            }
            return p;
          });
          playSound('slide');
          hasMovement = true;

          // Cull any group with a piece that has left the visible board —
          // pieces vanish the instant they cross the edge, and the whole
          // bound group goes with them. Each destroyed group's size is
          // tallied for this turn's score (see computeDestructionScore),
          // so losing a big bound group all at once is always worth more
          // than losing the same pieces individually across several turns.
          const escapedGroupIds = new Set(
            nextPieces
              .filter((p) => p.r < MIN_COORD || p.r > MAX_COORD || p.c < MIN_COORD || p.c > MAX_COORD)
              .map((p) => p.groupId)
          );
          if (escapedGroupIds.size > 0) {
            escapedGroupIds.forEach((gId) => {
              const groupSize = nextPieces.filter((p) => p.groupId === gId).length;
              turnDestroyedGroupSizesRef.current.push(groupSize);
            });

            // Snapshot the exact color/position of every piece about to be
            // culled so a brief "destroyed" burst animation can play right
            // where each one vanished, purely as a visual overlay layered on
            // top — it has no bearing on the authoritative board state
            // computed below.
            const destroyedSnapshots: DestroyedPiece[] = nextPieces
              .filter((p) => escapedGroupIds.has(p.groupId))
              .map((p) => ({ id: p.id, color: p.color, r: p.r, c: p.c }));
            setDestroyingPieces((prev) => [...prev, ...destroyedSnapshots]);
            setTimeout(() => {
              setDestroyingPieces((prev) =>
                prev.filter((d) => !destroyedSnapshots.some((s) => s.id === d.id))
              );
            }, 500);

            nextPieces = nextPieces.filter((p) => !escapedGroupIds.has(p.groupId));
            playSound('vanish');
          }

          // --- BINDING PHASE (POST-MOVEMENT) ---
          const bindResult = bindAdjacentPieces(nextPieces);
          if (bindResult.didBind) {
            playSound('bind');
            nextPieces = bindResult.pieces;
          }
        }
        // If survivingClaims is empty, every pull at the minimum distance was
        // entangled in a conflict with another — a board-wide tie-lock.
        // Nothing moves this tick; hasMovement stays false and control
        // returns to the player.

    // Update board state
    setPieces(nextPieces);

    if (hasMovement) {
      // Queue next tick of resolution animation
      setTimeout(() => {
        runResolutionStep(nextPieces);
      }, 250);
    } else {
      // Done resolving, return control to player
      setIsResolving(false);
      // Turn complete — tally every group destroyed across this whole
      // cascade (it can span several resolution ticks) into one turn
      // score, applying the size/combo scaling from computeDestructionScore.
      const turnScore = computeDestructionScore(turnDestroyedGroupSizesRef.current);
      if (turnScore > 0) {
        setScore((prev) => prev + turnScore);
      }
      turnDestroyedGroupSizesRef.current = [];
      // Check if board outer edge has absolutely no empty spaces
      let freeOuterCellExists = false;
      for (let r = 0; r < GRID_SIZE; r++) {
        for (let c = 0; c < GRID_SIZE; c++) {
          if (isOuterEdge(r, c) && !nextPieces.some((p) => p.r === r && p.c === c)) {
            freeOuterCellExists = true;
            break;
          }
        }
      }

      if (!freeOuterCellExists) {
        setGameOver(true);
        setGameOverReason('No space left on the outer edge to place pieces!');
        playSound('lose');
      }
    }
  }, [soundEnabled]);

  // Click handler to place active piece on the board
  const handleCellClick = (r: number, c: number) => {
    if (isResolving || gameOver) return;
    if (!isOuterEdge(r, c)) return;

    // Check if cell is occupied
    if (getPieceAt(r, c)) return;

    playSound('place');
    const newPieceId = pieceIdCounter.current++;
    const newPiece: Piece = {
      id: newPieceId,
      color: nextColor,
      r,
      c,
      groupId: newPieceId
    };

    const updatedPieces = [...pieces, newPiece];
    
    // --- BINDING PHASE (IMMEDIATE PRE-ATTRACTION PRE-RESOLUTION) ---
    const bindResult = bindAdjacentPieces(updatedPieces);
    const resolvedInitialPieces = bindResult.pieces;
    
    if (bindResult.didBind) {
      // Trigger binding sound effect instantly if they immediately link up
      setTimeout(() => {
        playSound('bind');
      }, 80);
    }

    setPieces(resolvedInitialPieces);
    setLastPlacedCell({ r, c });

    // Lock board and trigger resolution cascade
    // Starting a new turn — clear last turn's destroyed-group tally so
    // this turn's score is computed fresh once its cascade settles.
    turnDestroyedGroupSizesRef.current = [];
    setIsResolving(true);
    rollNextColor();

    setTimeout(() => {
      runResolutionStep(resolvedInitialPieces);
    }, 300);
  };

  // Determine connections between pieces of the same group for visuals
  const hasNeighborInGroup = (piece: Piece, dir: 'up' | 'down' | 'left' | 'right') => {
    let checkR = piece.r;
    let checkC = piece.c;
    if (dir === 'up') checkR--;
    if (dir === 'down') checkR++;
    if (dir === 'left') checkC--;
    if (dir === 'right') checkC++;

    const neighbor = pieces.find((p) => p.r === checkR && p.c === checkC);
    return neighbor && neighbor.groupId === piece.groupId;
  };

  // Live "who's attracting whom" state, recomputed from the current board
  // any time it changes — including while idle and while frozen in a
  // tie-lock, which is exactly when this is most useful to see.
  const attractionState = useMemo<Record<number, GroupInfo>>(() => computeGroupPulls(pieces).groupInfo, [pieces]);
  const attractingPieceIds = useMemo(() => {
    const ids = new Set<number>();
    Object.values(attractionState).forEach((info) => {
      info.attractorIds.forEach((id) => ids.add(id));
    });
    return ids;
  }, [attractionState]);

  // Which group(s) would actually move THIS tick, and in which direction —
  // the same global-min-distance + conflict resolution runResolutionStep
  // uses to commit moves. A group can have a perfectly valid closest pull
  // (present in attractionState) without being the one that wins the
  // board-wide race, so the arrow overlay checks this instead of just
  // "does this group have any pull at all."
  const winningPullByGroupId = useMemo<Record<number, Dir>>(() => {
    const map: Record<number, Dir> = {};
    resolveWinningPulls(pieces).forEach(({ pull }) => {
      // Only the originally-attracted group gets an arrow — groups merely
      // dragged along via a push chain didn't sense anything themselves.
      map[pull.attractedGroupId] = { dr: pull.dr, dc: pull.dc };
    });
    return map;
  }, [pieces]);

  return (
    <div
      className="min-h-screen flex flex-col select-none antialiased"
      style={{ backgroundColor: THEME.page, color: THEME.ink }}
    >

      {/* HEADER — full game name plus three icon buttons */}
      <header className="px-4 py-5 flex items-center justify-between max-w-lg w-full mx-auto">
        <h1 className="text-3xl font-bold tracking-tight" style={{ color: THEME.ink }}>
          Reactor Attractor
        </h1>
        <div className="flex items-center gap-2">
          {([
            { key: 'sound', onClick: () => setSoundEnabled(!soundEnabled), title: soundEnabled ? 'Mute' : 'Unmute', icon: soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} /> },
            { key: 'help', onClick: () => setShowTutorial(!showTutorial), title: 'How to play', icon: <HelpCircle size={18} /> },
            { key: 'restart', onClick: restartGame, title: 'New game', icon: <RotateCcw size={18} /> },
          ]).map((b) => (
            <button
              key={b.key}
              onClick={b.onClick}
              title={b.title}
              className="p-2 rounded-md text-white transition-colors"
              style={{ backgroundColor: THEME.button }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = THEME.buttonHover)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = THEME.button)}
            >
              {b.icon}
            </button>
          ))}
        </div>
      </header>

      {/* HOW TO PLAY — short, plain-language, collapsible */}
      {showTutorial && (
        <div className="max-w-lg w-full mx-auto px-4 pb-3 text-sm leading-relaxed" style={{ color: THEME.inkSoft }}>
          Drop tiles on the outer edge. Red pulls green, green pulls blue, blue pulls red — attracted tiles
          slide toward their attractor and connect on contact, and matching colors connect too. Pushed off
          the edge, a connected group vanishes and scores — bigger groups score more. The game ends when the
          edge is completely full.
        </div>
      )}

      {/* MAIN GAME LAYOUT */}
      <main className="flex-1 w-full mx-auto px-4 py-2 flex flex-col items-center justify-center">

        {/* INTERACTIVE PLAYING BOARD */}
        <div className="relative flex flex-col items-center w-full max-w-lg">

          {/* COMPACT HUD BAR — score, best, and next tile, as 2048's
              stacked label-over-value pills. */}
          <div className="w-full flex items-end justify-between gap-3 mb-3">
            <div className="flex items-end gap-2">
              <div className="relative rounded-md px-4 py-1.5 text-center min-w-[5.5rem]" style={{ backgroundColor: THEME.board }}>
                <div className="text-[10px] uppercase tracking-widest font-bold" style={{ color: '#EEE4DA' }}>Score</div>
                <div className="text-xl font-bold text-white tabular-nums leading-tight">{score}</div>
                {scoreFlash && (
                  <span
                    key={scoreFlash.key}
                    className="absolute -top-3 left-1/2 -translate-x-1/2 text-sm font-bold animate-bounce pointer-events-none"
                    style={{ color: THEME.ink }}
                  >
                    +{scoreFlash.amount}
                  </span>
                )}
              </div>
              <div className="rounded-md px-4 py-1.5 text-center min-w-[5.5rem]" style={{ backgroundColor: THEME.board }}>
                <div className="text-[10px] uppercase tracking-widest font-bold flex items-center justify-center gap-1" style={{ color: '#EEE4DA' }}>
                  <Trophy size={10} /> Best
                </div>
                <div className="text-xl font-bold text-white tabular-nums leading-tight">{highScore}</div>
              </div>
            </div>

            <div className="flex items-center gap-2 pb-1">
              <span className="text-[10px] uppercase tracking-widest font-bold hidden sm:inline" style={{ color: THEME.inkSoft }}>Next</span>
              <div
                className="w-8 h-8 rounded-md"
                style={{
                  backgroundColor: COLORS[nextColor]?.hex,
                  boxShadow: `inset 0 -3px 0 ${COLORS[nextColor]?.dark}`,
                }}
              />
            </div>
          </div>

          {/* STAGE — same size as the board now that pieces vanish the
              instant they leave the grid; no drift margin needed. */}
          <div className="relative w-full max-w-lg aspect-square">

            {/* Bordered board box — inset within the stage, still clips its
                own background/cells so the grid itself reads cleanly. */}
            <div
              className="absolute rounded-lg overflow-hidden"
              style={{
                left: `${GRID_BOX_OFFSET_PCT}%`,
                top: `${GRID_BOX_OFFSET_PCT}%`,
                width: `${GRID_BOX_SIZE_PCT}%`,
                height: `${GRID_BOX_SIZE_PCT}%`,
                padding: `${BOARD_PAD_STAGE_PCT}%`,
                backgroundColor: THEME.board,
              }}
            >
              {/* 8x8 GRID LAYOUT */}
              <div
                className="w-full h-full grid grid-cols-8 grid-rows-8 relative"
                style={{ gap: `${CELL_GAP_GRID_PCT}%` }}
              >
                {Array.from({ length: GRID_SIZE }).map((_, r) =>
                  Array.from({ length: GRID_SIZE }).map((_, c) => {
                    const isEdge = isOuterEdge(r, c);
                    const piece = getPieceAt(r, c);
                    const isLastPlaced = lastPlacedCell && lastPlacedCell.r === r && lastPlacedCell.c === c;

                    return (
                      <div
                        key={`${r}-${c}`}
                        onClick={() => handleCellClick(r, c)}
                        className={`relative rounded-md flex items-center justify-center select-none ${isEdge ? 'cursor-pointer' : 'cursor-default'}`}
                        style={{ backgroundColor: THEME.cell }}
                      >
                        {/* Persistent ghost of the next tile on every valid
                            edge cell — this, rather than a dashed outline, is
                            what marks a cell as playable, and it works on
                            touch devices where :hover never fires. */}
                        {isEdge && !piece && !isResolving && !gameOver && (
                          <div
                            className="absolute inset-1 rounded-md opacity-25 hover:opacity-60 active:opacity-75 transition-opacity"
                            style={{ backgroundColor: COLORS[nextColor]?.hex }}
                          />
                        )}

                        {/* Cell highlight for the last placed tile */}
                        {isLastPlaced && (
                          <div
                            className="absolute inset-0 rounded-md animate-pulse pointer-events-none"
                            style={{ boxShadow: `inset 0 0 0 2px ${THEME.button}` }}
                          />
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* LOSS / GAME OVER MODAL SCREEN */}
              {gameOver && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center p-6 z-30 text-center"
                  style={{ backgroundColor: 'rgba(238, 228, 218, 0.73)' }}
                >
                  <h3 className="text-4xl font-bold tracking-tight mb-4" style={{ color: THEME.ink }}>
                    Game over
                  </h3>

                  <div className="mb-6">
                    <p className="text-5xl font-bold tabular-nums" style={{ color: THEME.ink }}>{score}</p>
                    {score >= highScore && score > 0 && (
                      <span
                        className="text-[10px] uppercase tracking-widest px-2 py-0.5 rounded font-bold mt-2 inline-block animate-bounce text-white"
                        style={{ backgroundColor: THEME.button }}
                      >
                        New best
                      </span>
                    )}
                  </div>

                  <button
                    onClick={restartGame}
                    className="w-full max-w-xs py-3 text-white font-bold rounded-md transition-colors flex items-center justify-center space-x-2"
                    style={{ backgroundColor: THEME.button }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = THEME.buttonHover)}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = THEME.button)}
                  >
                    <RotateCcw size={16} />
                    <span>New game</span>
                  </button>
                </div>
              )}
            </div>

            {/* UNCLIPPED PIECE LAYER — spans the full stage (not just the
                bordered box) so off-grid pieces render at their real,
                compressed position instead of vanishing at the border. */}
            <div className="absolute inset-0 pointer-events-none z-10">
              {(() => {
                // Precompute everything once per piece so the links pass
                // and the pieces pass below can't drift out of sync with
                // each other.
                const renderInfo = pieces.map((p) => {
                  const colorConfig = COLORS[p.color];

                  const hasUp = hasNeighborInGroup(p, 'up');
                  const hasDown = hasNeighborInGroup(p, 'down');
                  const hasLeft = hasNeighborInGroup(p, 'left');
                  const hasRight = hasNeighborInGroup(p, 'right');

                  const dist = trueDistPastEdge(p.r, p.c);
                  const { scale, opacity, warning } = getPieceVisualStyle(dist);
                  const leftPercent = coordToStageCellUnits(p.c) * CELL_STAGE_PCT;
                  const topPercent = coordToStageCellUnits(p.r) * CELL_STAGE_PCT;
                  const isOnGrid = p.r >= 0 && p.r <= GRID_SIZE - 1 && p.c >= 0 && p.c <= GRID_SIZE - 1;
                  const boxStageUnits = isOnGrid ? ON_GRID_CELL_STAGE_UNITS : 1;
                  const boxPercent = boxStageUnits * CELL_STAGE_PCT;

                  const isAttractor = attractingPieceIds.has(p.id);
                  const groupPull = attractionState[p.groupId];
                  const isGroupTieLocked = groupPull?.isTieLocked;
                  const isSensingPiece = groupPull?.sensingPieceIds?.includes(p.id);
                  const isTieLocked = isGroupTieLocked && isSensingPiece;
                  const winningPull = winningPullByGroupId[p.groupId];
                  const hasDirectionalPull = !isGroupTieLocked && !!winningPull && isSensingPiece;

                  const arrowStyle: CSSProperties | null = hasDirectionalPull && winningPull
                    ? winningPull.dr === -1
                      ? { top: '-7px', left: '50%', transform: 'translateX(-50%) rotate(0deg)' }
                      : winningPull.dr === 1
                      ? { bottom: '-7px', left: '50%', transform: 'translateX(-50%) rotate(180deg)' }
                      : winningPull.dc === -1
                      ? { left: '-7px', top: '50%', transform: 'translateY(-50%) rotate(-90deg)' }
                      : { right: '-7px', top: '50%', transform: 'translateY(-50%) rotate(90deg)' }
                    : null;

                  return {
                    p, colorConfig, hasUp, hasDown, hasLeft, hasRight, dist, scale, opacity, warning,
                    leftPercent, topPercent, boxPercent, isAttractor, isTieLocked, hasDirectionalPull, arrowStyle
                  };
                });

                return (
                  <>
                    {/* LINKS LAYER — always painted beneath every piece, no
                        matter how far anything has drifted off-grid. Group
                        connectors are background scaffolding; they
                        shouldn't compete with pieces for visibility. */}
                    <div className="absolute inset-0" style={{ zIndex: 0 }}>
                      {renderInfo.map(({ p, hasUp, hasDown, hasLeft, hasRight, leftPercent, topPercent, boxPercent, scale, opacity }) => (
                        <div
                          key={`link-${p.id}`}
                          className="absolute transition-all duration-300 ease-out"
                          style={{ left: `${leftPercent}%`, top: `${topPercent}%`, width: `${boxPercent}%`, height: `${boxPercent}%`, opacity }}
                        >
                          <div className="relative w-full h-full flex items-center justify-center" style={{ transform: `scale(${scale})`, transformOrigin: 'center' }}>
                            {hasUp && (
                              <div className="absolute w-3 rounded-sm" style={{ backgroundColor: THEME.button, top: `-${BRIDGE_OVERSHOOT_PCT}%`, height: `calc(50% + ${BRIDGE_OVERSHOOT_PCT}%)` }} />
                            )}
                            {hasDown && (
                              <div className="absolute w-3 rounded-sm" style={{ backgroundColor: THEME.button, bottom: `-${BRIDGE_OVERSHOOT_PCT}%`, height: `calc(50% + ${BRIDGE_OVERSHOOT_PCT}%)` }} />
                            )}
                            {hasLeft && (
                              <div className="absolute h-3 rounded-sm" style={{ backgroundColor: THEME.button, left: `-${BRIDGE_OVERSHOOT_PCT}%`, width: `calc(50% + ${BRIDGE_OVERSHOOT_PCT}%)` }} />
                            )}
                            {hasRight && (
                              <div className="absolute h-3 rounded-sm" style={{ backgroundColor: THEME.button, right: `-${BRIDGE_OVERSHOOT_PCT}%`, width: `calc(50% + ${BRIDGE_OVERSHOOT_PCT}%)` }} />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* PIECES LAYER — every piece has its own explicit
                        z-index, PIECE_Z_BASE minus how far past the edge it
                        is, so pieces closer to the grid always render above
                        ones that have drifted further out (instead of
                        whichever happened to be later in the pieces array),
                        while still staying safely above the links layer's
                        z-index: 0 even at the furthest drift distance. */}
                    <div className="absolute inset-0">
                      {renderInfo.map(({ p, colorConfig, dist, scale, opacity, warning, leftPercent, topPercent, boxPercent, isAttractor, isTieLocked, hasDirectionalPull, arrowStyle }) => (
                        <div
                          key={p.id}
                          className="absolute transition-all duration-300 ease-out flex items-center justify-center"
                          style={{
                            left: `${leftPercent}%`,
                            top: `${topPercent}%`,
                            width: `${boxPercent}%`,
                            height: `${boxPercent}%`,
                            opacity,
                            zIndex: PIECE_Z_BASE - dist,
                          }}
                        >
                          <div className="relative w-full h-full flex items-center justify-center" style={{ transform: `scale(${scale})`, transformOrigin: 'center' }}>
                            <div className="relative w-full h-full flex items-center justify-center" style={{ padding: '4px' }}>
                              {/* Attractor halo — pulses in the piece's own
                                  color whenever it's currently the chosen
                                  attractor for some group, even off-grid or
                                  mid tie-lock. */}
                              {isAttractor && (
                                <div
                                  className="absolute inset-0 rounded-md animate-ping opacity-40"
                                  style={{ backgroundColor: colorConfig.hex, animationDuration: '1.8s' }}
                                />
                              )}

                              {/* Off-grid warning ring — pulses as a piece
                                  nears the cull threshold, so drift reads as
                                  "danger" and not just "small." */}
                              {warning && (
                                <div className="absolute -inset-1 rounded-md border-2 border-red-500/70 animate-pulse" />
                              )}

                              {/* The tile itself — rounded square with a
                                  darker bottom edge, 2048-style. */}
                              <div
                                className="w-full h-full rounded-md select-none relative"
                                style={{
                                  backgroundColor: colorConfig.hex,
                                  boxShadow: `inset 0 -4px 0 ${colorConfig.dark}`,
                                }}
                              />

                              {/* Pull direction indicator — sits on the edge
                                  of the tile facing where the group would
                                  slide this tick. */}
                              {hasDirectionalPull && (
                                <div
                                  className="absolute w-4 h-4 rounded-full flex items-center justify-center"
                                  style={{ ...(arrowStyle ?? {}), backgroundColor: THEME.ink }}
                                >
                                  <ChevronUp size={10} color="#FAF8EF" />
                                </div>
                              )}

                              {/* Tie-lock badge — this is the confusing
                                  case: two+ competing attractors at equal
                                  distance, so the group is frozen. Shown
                                  even while idle. */}
                              {isTieLocked && (
                                <div
                                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center animate-pulse"
                                  style={{ backgroundColor: '#EDC22E' }}
                                >
                                  <AlertTriangle size={9} color="#776E65" />
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* DESTRUCTION BURST LAYER — transient "ghost" pieces
                        rendered at the exact spot (on-grid or drifted
                        off-grid) where a piece vanished, purely a visual
                        echo layered on top of the authoritative board
                        state; see destroyingPieces state. */}
                    <div className="absolute inset-0 pointer-events-none z-20">
                      {destroyingPieces.map((d) => {
                        const colorConfig = COLORS[d.color];
                        const leftPercent = coordToStageCellUnits(d.c) * CELL_STAGE_PCT;
                        const topPercent = coordToStageCellUnits(d.r) * CELL_STAGE_PCT;
                        const isOnGrid = d.r >= 0 && d.r <= GRID_SIZE - 1 && d.c >= 0 && d.c <= GRID_SIZE - 1;
                        const boxPercent = (isOnGrid ? ON_GRID_CELL_STAGE_UNITS : 1) * CELL_STAGE_PCT;
                        return (
                          <div
                            key={`destroy-${d.id}`}
                            className="absolute flex items-center justify-center"
                            style={{ left: `${leftPercent}%`, top: `${topPercent}%`, width: `${boxPercent}%`, height: `${boxPercent}%` }}
                          >
                            <div className="relative w-full h-full flex items-center justify-center" style={{ padding: '4px' }}>
                              <div
                                className="absolute inset-0 rounded-md border-2 animate-piece-destroy-ring"
                                style={{ borderColor: colorConfig?.hex }}
                              />
                              <div
                                className="w-full h-full rounded-md animate-piece-destroy"
                                style={{
                                  backgroundColor: colorConfig?.hex,
                                  boxShadow: `inset 0 -4px 0 ${colorConfig?.dark}`,
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}
