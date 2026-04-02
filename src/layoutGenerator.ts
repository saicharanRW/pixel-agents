/**
 * Dynamic layout generator — creates an OfficeLayout from Huly project/person data.
 *
 * Each project gets its own room separated by VOID columns.
 * Room size scales based on number of persons in the project.
 * Working persons get desk+chair+PC workstations.
 * Idle persons get bench seating.
 */

import type { HulyPerson } from './hulyClient.js';

// ── Tile types (must match webview TileType) ──
const WALL = 0;
const FLOOR = 1;
const VOID = 255;

// ── Layout constants ──
const WALL_ROWS = 1;
const WORKSTATION_WIDTH = 5; // chair(1) + desk(3) + gap(1)
const WORKSTATION_ROW_HEIGHT = 2;
const BENCH_SPACING = 2; // tiles between benches
const BENCH_ROW_HEIGHT = 2;
const VOID_GAP = 1;
const PADDING = 1; // left/right padding inside room

interface PlacedFurniture {
  uid: string;
  type: string;
  col: number;
  row: number;
}

interface FloorColor {
  h: number;
  s: number;
  b: number;
  c: number;
  colorize?: boolean;
}

interface OfficeLayout {
  version: 1;
  cols: number;
  rows: number;
  tiles: number[];
  furniture: PlacedFurniture[];
  tileColors: (FloorColor | null)[];
}

const ROOM_HUES = [220, 150, 30, 280, 0, 180, 60, 310, 120, 45];

interface ProjectGroup {
  project: string;
  working: HulyPerson[];
  idle: HulyPerson[];
}

function groupByProject(persons: HulyPerson[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const p of persons) {
    const key = p.project || 'Unassigned';
    let group = map.get(key);
    if (!group) {
      group = { project: key, working: [], idle: [] };
      map.set(key, group);
    }
    if (p.status === 'busy') {
      group.working.push(p);
    } else {
      group.idle.push(p);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.project.localeCompare(b.project));
}

/** How many workstations fit per row for this room width */
function workstationsPerRow(roomInnerWidth: number): number {
  return Math.max(1, Math.floor(roomInnerWidth / WORKSTATION_WIDTH));
}

/** How many benches fit per row for this room width */
function benchesPerRow(roomInnerWidth: number): number {
  return Math.max(1, Math.floor((roomInnerWidth + BENCH_SPACING) / BENCH_SPACING));
}

/** Compute the width a room needs based on its people */
function computeRoomWidth(group: ProjectGroup): number {
  const totalPeople = group.working.length + group.idle.length;
  if (totalPeople === 0) return 0; // skip empty projects

  // Width needed for working people (2 workstations per row = 10 inner)
  const wsPerRow = Math.min(group.working.length, 2);
  const workingWidth = wsPerRow * WORKSTATION_WIDTH;

  // Width needed for idle people (benches spaced 2 apart)
  const bnPerRow = Math.min(group.idle.length, 4);
  const idleWidth = bnPerRow > 0 ? (bnPerRow - 1) * BENCH_SPACING + 1 : 0;

  const innerWidth = Math.max(workingWidth, idleWidth, 3); // min 3 inner width
  return PADDING + innerWidth + PADDING;
}

/** Compute the height a room needs */
function computeRoomHeight(group: ProjectGroup, roomWidth: number): number {
  const innerWidth = roomWidth - PADDING * 2;
  const wsPerRow = workstationsPerRow(innerWidth);
  const bnPerRow = benchesPerRow(innerWidth);

  const workingRows = Math.ceil(group.working.length / wsPerRow);
  const idleRows = Math.ceil(group.idle.length / bnPerRow);

  const workingHeight = workingRows * WORKSTATION_ROW_HEIGHT;
  const idleHeight = idleRows > 0 ? 1 + idleRows * BENCH_ROW_HEIGHT : 0; // 1 gap row

  return WALL_ROWS + Math.max(workingHeight + idleHeight, 2) + 1; // +1 bottom padding
}

export function generateLayout(persons: HulyPerson[]): OfficeLayout {
  const groups = groupByProject(persons).filter(
    (g) => g.working.length + g.idle.length > 0,
  );

  if (groups.length === 0) {
    return {
      version: 1,
      cols: 10,
      rows: 6,
      tiles: Array(60).fill(FLOOR),
      furniture: [],
      tileColors: Array(60).fill(null),
    };
  }

  // Compute per-room dimensions
  const roomWidths = groups.map((g) => computeRoomWidth(g));
  const roomHeights = groups.map((g, i) => computeRoomHeight(g, roomWidths[i]));

  const totalRows = Math.max(...roomHeights, 6);
  let totalCols = 0;
  const roomStartCols: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    roomStartCols.push(totalCols);
    totalCols += roomWidths[i];
    if (i < groups.length - 1) totalCols += VOID_GAP;
  }

  const tiles: number[] = new Array(totalCols * totalRows).fill(VOID);
  const tileColors: (FloorColor | null)[] = new Array(totalCols * totalRows).fill(null);
  const furniture: PlacedFurniture[] = [];
  let uidCounter = 0;

  function nextUid(prefix: string): string {
    return `${prefix}-${++uidCounter}`;
  }

  function setTile(col: number, row: number, type: number): void {
    if (col >= 0 && col < totalCols && row >= 0 && row < totalRows) {
      tiles[row * totalCols + col] = type;
    }
  }

  function setTileColor(col: number, row: number, color: FloorColor): void {
    if (col >= 0 && col < totalCols && row >= 0 && row < totalRows) {
      tileColors[row * totalCols + col] = color;
    }
  }

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const startCol = roomStartCols[gi];
    const rw = roomWidths[gi];
    const rh = roomHeights[gi];
    const innerWidth = rw - PADDING * 2;
    const hue = ROOM_HUES[gi % ROOM_HUES.length];
    const floorColor: FloorColor = { h: hue, s: 25, b: 10, c: 0, colorize: true };

    // Fill room tiles — only as tall as needed
    for (let r = 0; r < rh && r < totalRows; r++) {
      for (let c = 0; c < rw; c++) {
        const col = startCol + c;
        if (r === 0) {
          setTile(col, r, WALL);
        } else {
          setTile(col, r, FLOOR);
          setTileColor(col, r, floorColor);
        }
      }
    }

    // Place workstations
    const wsPerRow = workstationsPerRow(innerWidth);
    let personIdx = 0;
    const workingRowCount = Math.ceil(group.working.length / wsPerRow);
    for (let wr = 0; wr < workingRowCount; wr++) {
      const tileRow = WALL_ROWS + wr * WORKSTATION_ROW_HEIGHT;
      for (let ws = 0; ws < wsPerRow && personIdx < group.working.length; ws++) {
        const baseCol = startCol + PADDING + ws * WORKSTATION_WIDTH;
        furniture.push({ uid: nextUid('ch'), type: 'WOODEN_CHAIR_SIDE', col: baseCol, row: tileRow });
        furniture.push({ uid: nextUid('dk'), type: 'DESK_FRONT', col: baseCol + 1, row: tileRow });
        furniture.push({ uid: nextUid('pc'), type: 'PC_FRONT_OFF', col: baseCol + 1, row: tileRow });
        personIdx++;
      }
    }

    // Place benches
    if (group.idle.length > 0) {
      const bnPerRow = benchesPerRow(innerWidth);
      const benchStartRow = WALL_ROWS + workingRowCount * WORKSTATION_ROW_HEIGHT + (workingRowCount > 0 ? 1 : 0);
      let idleIdx = 0;
      const idleRowCount = Math.ceil(group.idle.length / bnPerRow);
      for (let br = 0; br < idleRowCount; br++) {
        const tileRow = benchStartRow + br * BENCH_ROW_HEIGHT;
        for (let bi = 0; bi < bnPerRow && idleIdx < group.idle.length; bi++) {
          const col = startCol + PADDING + bi * BENCH_SPACING;
          furniture.push({ uid: nextUid('bn'), type: 'WOODEN_BENCH', col, row: tileRow });
          idleIdx++;
        }
      }
    }
  }

  return {
    version: 1,
    cols: totalCols,
    rows: totalRows,
    tiles,
    furniture,
    tileColors,
  };
}

/**
 * Build a mapping from (personId:project) → furniture seat UID.
 * Must mirror the exact same UID generation order as generateLayout().
 */
export function buildSeatMap(
  persons: HulyPerson[],
): Map<string, { seatUid: string; isWorking: boolean }> {
  const groups = groupByProject(persons).filter(
    (g) => g.working.length + g.idle.length > 0,
  );
  const result = new Map<string, { seatUid: string; isWorking: boolean }>();
  let uidCounter = 0;

  function nextUid(prefix: string): string {
    return `${prefix}-${++uidCounter}`;
  }

  for (const group of groups) {
    for (const person of group.working) {
      const chairUid = nextUid('ch');
      nextUid('dk'); // skip desk
      nextUid('pc'); // skip PC
      result.set(`${person.id}:${group.project}`, { seatUid: chairUid, isWorking: true });
    }
    for (const person of group.idle) {
      const benchUid = nextUid('bn');
      result.set(`${person.id}:${group.project}`, { seatUid: benchUid, isWorking: false });
    }
  }

  return result;
}
