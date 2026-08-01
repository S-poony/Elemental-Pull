import React, { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react';
import { RotateCcw, HelpCircle, Trophy, ChevronUp, Volume2, VolumeX } from 'lucide-react';
import {
  GRID_SIZE,
  REFERENCE_FORCE,
  bindAdjacentPieces,
  computeDestructionScore,
  hasFreeOuterCell,
  isOuterEdge,
  planMoves,
  resolveTick,
  type ColorKey,
  type Dir,
  type Headings,
  type Piece,
} from './physics';

// All the rules live in physics.ts — this file is the board, the HUD and
// the animation timing, nothing more.

// --- TYPES ---
interface ColorConfig {
  name: string;
  // Tile fill, and a slightly deeper shade of the same hue used for the
  // tile's lower edge so pieces read as solid objects rather than flat
  // discs — the same trick 2048's tiles use.
  hex: string;
  dark: string;
}

interface DestroyedPiece {
  id: number;
  color: ColorKey;
  r: number;
  c: number;
}

interface ScoreFlash {
  amount: number;
  key: number;
}

// --- GAME CONFIG & CONSTANTS ---
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

export default function App() {
  // --- STATE ---
  const [pieces, setPieces] = useState<Piece[]>([]); // List of { id, color, r, c, groupId }
  // Each group's heading — the direction it last actually moved. Only
  // populated while a turn is resolving; cleared the moment the cascade
  // settles, so the board you make decisions against never carries
  // invisible momentum. Momentum decides only what happens DURING the
  // cascade you just triggered, which you can watch.
  const [headings, setHeadings] = useState<Headings>({});
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
        audioCtxRef.current.close().catch(() => { });
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
    setHeadings({});
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

  // One tick of the cascade. All the decision-making lives in resolveTick;
  // everything here is presentation — sounds, burst animations, scoring and
  // scheduling the next tick.
  const runResolutionStep = useCallback(
    (currentPieces: Piece[], currentHeadings: Headings) => {
      const result = resolveTick(currentPieces, currentHeadings);

      if (!result.moved) {
        // Nothing wanted to move, so the turn is over. Note this is now a
        // genuine rest state rather than a deadlock: planMoves guarantees
        // that if any group had a direction at all, at least one of them
        // moved. Getting here means every group is either balanced and
        // stationary or has nothing attracting it.
        setPieces(result.pieces);
        setHeadings({});
        setIsResolving(false);

        const turnScore = computeDestructionScore(turnDestroyedGroupSizesRef.current);
        if (turnScore > 0) setScore((prev) => prev + turnScore);
        turnDestroyedGroupSizesRef.current = [];

        if (!hasFreeOuterCell(result.pieces)) {
          setGameOver(true);
          setGameOverReason('No space left on the outer edge to place pieces!');
          playSound('lose');
        }
        return;
      }

      playSound('slide');

      if (result.destroyed.length > 0) {
        turnDestroyedGroupSizesRef.current.push(...result.destroyedGroupSizes);

        // Ghost snapshots so a burst can play exactly where each piece
        // vanished. Purely decorative — the authoritative board is
        // result.pieces.
        const snapshots: DestroyedPiece[] = result.destroyed.map((p) => ({
          id: p.id,
          color: p.color,
          r: p.r,
          c: p.c,
        }));
        setDestroyingPieces((prev) => [...prev, ...snapshots]);
        setTimeout(() => {
          setDestroyingPieces((prev) => prev.filter((d) => !snapshots.some((s) => s.id === d.id)));
        }, 500);
        playSound('vanish');
      }

      if (result.didBind) playSound('bind');

      setPieces(result.pieces);
      setHeadings(result.headings);

      setTimeout(() => {
        runResolutionStep(result.pieces, result.headings);
      }, 250);
    },
    [soundEnabled]
  );

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

    // --- BINDING PHASE (IMMEDIATE, BEFORE ANY ATTRACTION) ---
    const bindResult = bindAdjacentPieces(updatedPieces);
    const resolvedInitialPieces = bindResult.pieces;
    // Every turn starts from rest. Nothing on the board carries momentum
    // into a placement — headings only exist inside a cascade.
    const initialHeadings: Headings = {};

    if (bindResult.didBind) {
      // Trigger binding sound effect instantly if they immediately link up
      setTimeout(() => {
        playSound('bind');
      }, 80);
    }

    setPieces(resolvedInitialPieces);
    setHeadings(initialHeadings);
    setLastPlacedCell({ r, c });

    // Lock board and trigger resolution cascade
    // Starting a new turn — clear last turn's destroyed-group tally so
    // this turn's score is computed fresh once its cascade settles.
    turnDestroyedGroupSizesRef.current = [];
    setIsResolving(true);
    rollNextColor();

    setTimeout(() => {
      runResolutionStep(resolvedInitialPieces, initialHeadings);
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

  // Exactly what the engine would do on the next tick — same function,
  // same inputs — so the preview can never disagree with what happens.
  const plan = useMemo(() => planMoves(pieces, headings), [pieces, headings]);

  const attractingPieceIds = useMemo(() => {
    const ids = new Set<number>();
    Object.values(plan.forces).forEach((f) => f.attractorIds.forEach((id) => ids.add(id)));
    return ids;
  }, [plan]);

  // One arrow per moving group, parked on the piece at the leading edge of
  // the slide, so a long group gets a single clear "this end goes first"
  // marker instead of an arrow on every tile. Opacity tracks how hard the
  // group is being pulled, which makes the strongest-first ordering
  // visible: the boldest arrow is the one that commits first.
  const arrowByPieceId = useMemo(() => {
    const map: Record<number, { dir: Dir; coasting: boolean; strength: number }> = {};
    plan.accepted.forEach(({ groupId, dir, coasting, magnitude }) => {
      const groupPieces = pieces.filter((p) => p.groupId === groupId);
      if (groupPieces.length === 0) return;
      let lead = groupPieces[0];
      let bestProjection = lead.r * dir.dr + lead.c * dir.dc;
      groupPieces.forEach((p) => {
        const projection = p.r * dir.dr + p.c * dir.dc;
        if (projection > bestProjection) {
          bestProjection = projection;
          lead = p;
        }
      });
      map[lead.id] = {
        dir,
        coasting,
        strength: Math.min(1, Math.max(0.45, magnitude / REFERENCE_FORCE)),
      };
    });
    return map;
  }, [plan, pieces]);

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
          Red pulls green, green pulls blue, blue pulls red. <br />
          Tiles connect on contact. <br />
          Score points by taking tiles off the edges. </div>
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
                  const arrow = arrowByPieceId[p.id];
                  const hasDirectionalPull = !!arrow;

                  const arrowStyle: CSSProperties | null = arrow
                    ? arrow.dir.dr === -1
                      ? { top: '-7px', left: '50%', transform: 'translateX(-50%) rotate(0deg)' }
                      : arrow.dir.dr === 1
                        ? { bottom: '-7px', left: '50%', transform: 'translateX(-50%) rotate(180deg)' }
                        : arrow.dir.dc === -1
                          ? { left: '-7px', top: '50%', transform: 'translateY(-50%) rotate(-90deg)' }
                          : { right: '-7px', top: '50%', transform: 'translateY(-50%) rotate(90deg)' }
                    : null;

                  return {
                    p, colorConfig, hasUp, hasDown, hasLeft, hasRight, dist, scale, opacity, warning,
                    leftPercent, topPercent, boxPercent, isAttractor, arrow, hasDirectionalPull, arrowStyle
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
                      {renderInfo.map(({ p, colorConfig, dist, scale, opacity, warning, leftPercent, topPercent, boxPercent, isAttractor, arrow, hasDirectionalPull, arrowStyle }) => (
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

                              {/* Pull direction indicator — sits on the
                                  leading edge of the group, facing where it
                                  slides this tick. Filled when a net pull is
                                  driving it; hollow when the pulls cancelled
                                  and the group is coasting on momentum,
                                  which is the one case where the board alone
                                  doesn't explain the move. */}
                              {hasDirectionalPull && arrow && (
                                <div
                                  className="absolute w-4 h-4 rounded-full flex items-center justify-center"
                                  style={{
                                    ...(arrowStyle ?? {}),
                                    backgroundColor: arrow.coasting ? THEME.page : THEME.ink,
                                    border: arrow.coasting ? `2px solid ${THEME.ink}` : 'none',
                                    opacity: arrow.coasting ? 1 : arrow.strength,
                                  }}
                                >
                                  <ChevronUp size={10} color={arrow.coasting ? THEME.ink : '#FAF8EF'} />
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
