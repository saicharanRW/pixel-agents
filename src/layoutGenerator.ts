/**
 * Dynamic layout generator — creates an OfficeLayout from Huly project/person data.
 *
 * Rooms are arranged in a uniform grid with consistent sizing.
 * Each project gets its own room.
 * Working persons get desk+chair+PC workstations.
 * Idle persons get bench seating.
 */

import type { HulyPerson } from './hulyClient.js';

// ── Tile types (must match webview TileType) ──
const WALL = 0;
const FLOOR = 1;
const VOID = 255;

// ── Room layout constants ──
const WALL_ROWS = 1;
const WORKSTATION_WIDTH = 5; // chair(1) + desk(3) + gap(1)
const WORKSTATIONS_PER_ROW = 2;
const WORKSTATION_ROW_HEIGHT = 2;
const BENCH_SPACING = 2;
const BENCH_ROW_HEIGHT = 2;
const BENCHES_PER_ROW = 4;
const VOID_GAP = 3; // visible gap between rooms
const PADDING = 1;

// Uniform room size — fits up to 6 working + 4 idle comfortably
const ROOM_WIDTH = PADDING + WORKSTATIONS_PER_ROW * WORKSTATION_WIDTH + PADDING; // 12
const ROOM_MIN_HEIGHT = 8;

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

function computeRoomHeight(group: ProjectGroup): number {
  const workingRows = Math.ceil(group.working.length / WORKSTATIONS_PER_ROW);
  const idleRows = Math.ceil(group.idle.length / BENCHES_PER_ROW);

  const workingHeight = workingRows * WORKSTATION_ROW_HEIGHT;
  const idleHeight = idleRows > 0 ? 1 + idleRows * BENCH_ROW_HEIGHT : 0;

  return WALL_ROWS + Math.max(workingHeight + idleHeight, 2) + PADDING;
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

  // Grid dimensions
  const gridCols = Math.ceil(Math.sqrt(groups.length));
  const gridRows = Math.ceil(groups.length / gridCols);

  // Uniform room height = max across all rooms
  const roomHeight = Math.max(ROOM_MIN_HEIGHT, ...groups.map((g) => computeRoomHeight(g)));

  // Total grid size
  const totalCols = gridCols * ROOM_WIDTH + (gridCols - 1) * VOID_GAP;
  const totalRows = gridRows * roomHeight + (gridRows - 1) * VOID_GAP;

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
    const gc = gi % gridCols;
    const gr = Math.floor(gi / gridCols);
    const startCol = gc * (ROOM_WIDTH + VOID_GAP);
    const startRow = gr * (roomHeight + VOID_GAP);
    const hue = ROOM_HUES[gi % ROOM_HUES.length];
    const floorColor: FloorColor = { h: hue, s: 25, b: 10, c: 0, colorize: true };

    // Fill entire room with floor + top wall row
    for (let r = 0; r < roomHeight; r++) {
      for (let c = 0; c < ROOM_WIDTH; c++) {
        if (r === 0) {
          setTile(startCol + c, startRow + r, WALL);
        } else {
          setTile(startCol + c, startRow + r, FLOOR);
          setTileColor(startCol + c, startRow + r, floorColor);
        }
      }
    }

    // Place workstations for working persons
    let personIdx = 0;
    const workingRowCount = Math.ceil(group.working.length / WORKSTATIONS_PER_ROW);
    for (let wr = 0; wr < workingRowCount; wr++) {
      const tileRow = startRow + WALL_ROWS + wr * WORKSTATION_ROW_HEIGHT;
      for (let ws = 0; ws < WORKSTATIONS_PER_ROW && personIdx < group.working.length; ws++) {
        const baseCol = startCol + PADDING + ws * WORKSTATION_WIDTH;
        furniture.push({ uid: nextUid('ch'), type: 'WOODEN_CHAIR_SIDE', col: baseCol, row: tileRow });
        furniture.push({ uid: nextUid('dk'), type: 'DESK_FRONT', col: baseCol + 1, row: tileRow });
        furniture.push({ uid: nextUid('pc'), type: 'PC_FRONT_OFF', col: baseCol + 1, row: tileRow });
        personIdx++;
      }
    }

    // Place benches for idle persons
    if (group.idle.length > 0) {
      const benchStartRow = startRow + WALL_ROWS + workingRowCount * WORKSTATION_ROW_HEIGHT + (workingRowCount > 0 ? 1 : 0);
      let idleIdx = 0;
      const idleRowCount = Math.ceil(group.idle.length / BENCHES_PER_ROW);
      for (let br = 0; br < idleRowCount; br++) {
        const tileRow = benchStartRow + br * BENCH_ROW_HEIGHT;
        for (let bi = 0; bi < BENCHES_PER_ROW && idleIdx < group.idle.length; bi++) {
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
      nextUid('dk');
      nextUid('pc');
      result.set(`${person.id}:${group.project}`, { seatUid: chairUid, isWorking: true });
    }
    for (const person of group.idle) {
      const benchUid = nextUid('bn');
      result.set(`${person.id}:${group.project}`, { seatUid: benchUid, isWorking: false });
    }
  }

  return result;
}
