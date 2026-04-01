/**
 * Dynamic layout generator — creates office rooms from project/employee data.
 *
 * Each project gets its own room with desks+chairs for workers and benches
 * for idle people. Rooms are arranged in a grid layout.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentEntry {
  id: string;
  name: string;
  project: string;
  isWorking: boolean;
  tasks: Array<{ title: string; identifier: string; status: string; priority: number }>;
}

interface PlacedFurniture {
  uid: string;
  type: string;
  col: number;
  row: number;
  color?: { h: number; s: number; b: number; c: number; colorize?: boolean };
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
  tileColors?: Array<FloorColor | null>;
}

interface StaticAgent {
  id: number;
  name: string;
  seatUid: string;
  isWorking: boolean;
  tasks: Array<{ title: string; identifier: string; status: string; priority: number }>;
  project: string;
}

interface GeneratedLayout {
  layout: OfficeLayout;
  agents: StaticAgent[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TILE_VOID = 255;
const TILE_WALL = 0;
const TILE_FLOOR = 1;

// Room dimensions
const ROOM_INNER_W = 10;
const ROOM_W = ROOM_INNER_W + 2; // 12 (with walls)
const CORRIDOR_W = 2;
const ROOMS_PER_ROW = 4;
const CORRIDOR_H = 2; // vertical corridor between room rows

// Worker row: 2 tiles for desk+chair combo + 1 tile walkway
const WORKER_ROW_H = 3;
// Min room inner height (walkway + bench row + walkway)
const MIN_INNER_H = 6;
const SEATS_PER_ROW = 2;
const BENCHES_PER_ROW = 4;

// Floor colors per project (cycle through these)
const ROOM_COLORS: FloorColor[] = [
  { h: 35, s: 30, b: 15, c: 0, colorize: true },   // Warm beige
  { h: 210, s: 25, b: 10, c: 0, colorize: true },   // Cool blue
  { h: 140, s: 20, b: 10, c: 0, colorize: true },   // Sage green
  { h: 280, s: 20, b: 5, c: 0, colorize: true },    // Soft purple
  { h: 25, s: 35, b: 10, c: 0, colorize: true },    // Warm amber
  { h: 340, s: 20, b: 10, c: 0, colorize: true },   // Dusty rose
  { h: 180, s: 25, b: 10, c: 0, colorize: true },   // Teal
  { h: 60, s: 25, b: 15, c: 0, colorize: true },    // Olive
];

// ── Room generator ────────────────────────────────────────────────────────────

interface ProjectGroup {
  project: string;
  workers: AgentEntry[];
  idle: AgentEntry[];
}

function calcRoomInnerH(workerCount: number, idleCount: number): number {
  const workerRows = Math.ceil(workerCount / SEATS_PER_ROW);
  const benchRows = Math.ceil(idleCount / BENCHES_PER_ROW);
  // top walkway + worker rows + gap + bench rows + bottom walkway
  const needed = 1 + workerRows * WORKER_ROW_H + (benchRows > 0 ? 1 + benchRows : 0) + 1;
  return Math.max(needed, MIN_INNER_H);
}

function generateRoom(
  group: ProjectGroup,
  roomOffsetCol: number,
  roomOffsetRow: number,
  roomColor: FloorColor,
  tiles: number[],
  tileColors: Array<FloorColor | null>,
  furniture: PlacedFurniture[],
  agents: StaticAgent[],
  globalCols: number,
  nextAgentId: { value: number },
): number {
  const workerCount = group.workers.length;
  const idleCount = group.idle.length;
  const workerRows = Math.ceil(workerCount / SEATS_PER_ROW);
  const benchRows = Math.ceil(idleCount / BENCHES_PER_ROW);
  const innerH = calcRoomInnerH(workerCount, idleCount);
  const roomH = innerH + 2; // add top+bottom walls

  const prefix = group.project.replace(/[^A-Za-z0-9]/g, '');

  // Fill tiles
  for (let r = 0; r < roomH; r++) {
    for (let c = 0; c < ROOM_W; c++) {
      const gr = roomOffsetRow + r;
      const gc = roomOffsetCol + c;
      const idx = gr * globalCols + gc;

      const isWall = r === 0 || r === roomH - 1 || c === 0 || c === ROOM_W - 1;
      // Door opening at bottom center
      const isDoor = r === roomH - 1 && (c === 5 || c === 6);

      if (isWall && !isDoor) {
        tiles[idx] = TILE_WALL;
        tileColors[idx] = roomColor;
      } else {
        tiles[idx] = TILE_FLOOR;
        tileColors[idx] = roomColor;
      }
    }
  }

  // Place desks and chairs for workers
  let workerIdx = 0;
  for (let wr = 0; wr < workerRows && workerIdx < workerCount; wr++) {
    // Each worker row starts at: top wall (1) + top walkway (1) + wr * WORKER_ROW_H
    const baseRow = roomOffsetRow + 1 + 1 + wr * WORKER_ROW_H;

    for (let seat = 0; seat < SEATS_PER_ROW && workerIdx < workerCount; seat++) {
      // Seat 0: chair at col 1, desk at col 2-4
      // Seat 1: chair at col 6, desk at col 7-9
      const chairCol = roomOffsetCol + 1 + seat * 5;
      const deskCol = roomOffsetCol + 2 + seat * 5;

      const deskUid = `${prefix}-dk-${wr * 2 + seat}`;
      const chairUid = `${prefix}-ch-${wr * 2 + seat}`;
      const pcUid = `${prefix}-pc-${wr * 2 + seat}`;

      // Place desk (DESK_FRONT: 3×2, top row is background)
      furniture.push({
        uid: deskUid,
        type: 'DESK_FRONT',
        col: deskCol,
        row: baseRow,
      });

      // Place PC on desk
      furniture.push({
        uid: pcUid,
        type: 'PC_FRONT_OFF',
        col: deskCol + 1,
        row: baseRow,
      });

      // Place chair (WOODEN_CHAIR_SIDE: 1×2, top row is background)
      furniture.push({
        uid: chairUid,
        type: 'WOODEN_CHAIR_SIDE',
        col: chairCol,
        row: baseRow,
      });

      // Assign agent to this chair
      const worker = group.workers[workerIdx];
      agents.push({
        id: nextAgentId.value++,
        name: worker.name,
        seatUid: chairUid,
        isWorking: true,
        tasks: worker.tasks,
        project: worker.project,
      });

      workerIdx++;
    }
  }

  // Place benches for idle people
  let idleIdx = 0;
  if (idleCount > 0) {
    const benchBaseRow = roomOffsetRow + 1 + 1 + workerRows * WORKER_ROW_H + 1;

    for (let br = 0; br < benchRows && idleIdx < idleCount; br++) {
      for (let bi = 0; bi < BENCHES_PER_ROW && idleIdx < idleCount; bi++) {
        const benchCol = roomOffsetCol + 1 + bi * 2 + (bi >= 2 ? 1 : 0);
        const benchUid = `${prefix}-bn-${br * BENCHES_PER_ROW + bi}`;

        furniture.push({
          uid: benchUid,
          type: 'WOODEN_BENCH',
          col: benchCol,
          row: benchBaseRow + br,
        });

        const idlePerson = group.idle[idleIdx];
        agents.push({
          id: nextAgentId.value++,
          name: idlePerson.name,
          seatUid: benchUid,
          isWorking: false,
          tasks: idlePerson.tasks,
          project: idlePerson.project,
        });

        idleIdx++;
      }
    }
  }

  // Add a bookshelf or plant for decoration
  const decoRow = roomOffsetRow + 1;
  furniture.push({
    uid: `${prefix}-deco-0`,
    type: 'BOOKSHELF_FRONT',
    col: roomOffsetCol + ROOM_W - 2,
    row: decoRow,
  });

  return roomH;
}

// ── Main generator ────────────────────────────────────────────────────────────

export function generateLayoutFromProjects(
  working: AgentEntry[],
  idle: AgentEntry[],
): GeneratedLayout {
  console.log(
    `[LayoutGenerator] Generating layout for ${working.length} workers, ${idle.length} idle`,
  );

  // Group by project
  const projectMap = new Map<string, ProjectGroup>();

  for (const entry of working) {
    let group = projectMap.get(entry.project);
    if (!group) {
      group = { project: entry.project, workers: [], idle: [] };
      projectMap.set(entry.project, group);
    }
    group.workers.push(entry);
  }

  for (const entry of idle) {
    let group = projectMap.get(entry.project);
    if (!group) {
      group = { project: entry.project, workers: [], idle: [] };
      projectMap.set(entry.project, group);
    }
    group.idle.push(entry);
  }

  const projects = Array.from(projectMap.values());
  console.log(`[LayoutGenerator] ${projects.length} projects found`);

  // Calculate room sizes and global layout dimensions
  const roomHeights = projects.map((p) => {
    const innerH = calcRoomInnerH(p.workers.length, p.idle.length);
    return innerH + 2;
  });

  // Arrange rooms in a grid
  const numRoomRows = Math.ceil(projects.length / ROOMS_PER_ROW);
  const roomRowHeights: number[] = [];

  for (let rr = 0; rr < numRoomRows; rr++) {
    let maxH = 0;
    for (
      let ri = rr * ROOMS_PER_ROW;
      ri < Math.min((rr + 1) * ROOMS_PER_ROW, projects.length);
      ri++
    ) {
      maxH = Math.max(maxH, roomHeights[ri]);
    }
    roomRowHeights.push(maxH);
  }

  const roomsInLastRow =
    projects.length % ROOMS_PER_ROW || ROOMS_PER_ROW;
  const maxRoomsInRow = Math.min(projects.length, ROOMS_PER_ROW);
  const globalCols = maxRoomsInRow * ROOM_W + Math.max(0, maxRoomsInRow - 1) * CORRIDOR_W;
  const globalRows =
    roomRowHeights.reduce((sum, h) => sum + h, 0) +
    Math.max(0, numRoomRows - 1) * CORRIDOR_H;

  console.log(
    `[LayoutGenerator] Grid: ${globalCols}×${globalRows} ` +
      `(${maxRoomsInRow} rooms/row × ${numRoomRows} rows)`,
  );

  // Initialize tiles to VOID
  const tiles = new Array(globalCols * globalRows).fill(TILE_VOID);
  const tileColors = new Array<FloorColor | null>(globalCols * globalRows).fill(null);
  const furniture: PlacedFurniture[] = [];
  const agents: StaticAgent[] = [];
  const nextAgentId = { value: 1 };

  // Fill corridor tiles (walkable floor)
  // Horizontal corridors between rooms
  let currentRow = 0;
  for (let rr = 0; rr < numRoomRows; rr++) {
    const roomsThisRow =
      rr < numRoomRows - 1 ? ROOMS_PER_ROW : roomsInLastRow;

    // Place rooms in this row
    for (let ri = 0; ri < roomsThisRow; ri++) {
      const projectIdx = rr * ROOMS_PER_ROW + ri;
      const roomCol = ri * (ROOM_W + CORRIDOR_W);
      const color = ROOM_COLORS[projectIdx % ROOM_COLORS.length];

      generateRoom(
        projects[projectIdx],
        roomCol,
        currentRow,
        color,
        tiles,
        tileColors,
        furniture,
        agents,
        globalCols,
        nextAgentId,
      );
    }

    // Fill corridor between room rows
    currentRow += roomRowHeights[rr];
    if (rr < numRoomRows - 1) {
      for (let cr = 0; cr < CORRIDOR_H; cr++) {
        for (let cc = 0; cc < globalCols; cc++) {
          const idx = (currentRow + cr) * globalCols + cc;
          tiles[idx] = TILE_FLOOR;
          tileColors[idx] = { h: 0, s: 0, b: 20, c: 0, colorize: true };
        }
      }
      currentRow += CORRIDOR_H;
    }
  }

  // Fill vertical corridors between rooms (within each room row)
  currentRow = 0;
  for (let rr = 0; rr < numRoomRows; rr++) {
    const roomsThisRow =
      rr < numRoomRows - 1 ? ROOMS_PER_ROW : roomsInLastRow;

    for (let ri = 0; ri < roomsThisRow - 1; ri++) {
      const corridorCol = (ri + 1) * ROOM_W + ri * CORRIDOR_W;
      for (let cr = 0; cr < roomRowHeights[rr]; cr++) {
        for (let cc = 0; cc < CORRIDOR_W; cc++) {
          const idx = (currentRow + cr) * globalCols + corridorCol + cc;
          if (tiles[idx] === TILE_VOID) {
            tiles[idx] = TILE_FLOOR;
            tileColors[idx] = { h: 0, s: 0, b: 20, c: 0, colorize: true };
          }
        }
      }
    }
    currentRow += roomRowHeights[rr] + (rr < numRoomRows - 1 ? CORRIDOR_H : 0);
  }

  const layout: OfficeLayout = {
    version: 1,
    cols: globalCols,
    rows: globalRows,
    tiles,
    furniture,
    tileColors,
  };

  console.log(
    `[LayoutGenerator] Generated: ${furniture.length} furniture items, ${agents.length} agents`,
  );

  return { layout, agents };
}
