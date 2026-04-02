/**
 * Standalone script — polls Huly DB and generates layout + persons JSON files.
 *
 * Usage:
 *   npx tsx scripts/generate-layout.ts           # run once
 *   npx tsx scripts/generate-layout.ts --watch   # poll every 10 minutes
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

// ── DB Config (from environment variables) ──
const DB_CONFIG = {
  host: process.env.HULY_DB_HOST || '',
  port: parseInt(process.env.HULY_DB_PORT || '25060', 10),
  user: process.env.HULY_DB_USER || '',
  password: process.env.HULY_DB_PASSWORD || '',
  database: process.env.HULY_DB_NAME || 'defaultdb',
  ssl: process.env.HULY_DB_SSL !== 'false' ? { rejectUnauthorized: false } : false,
};

const POLL_INTERVAL_MS = 600_000; // 10 minutes

// ── SQL Query ──
const HULY_PERSONS_QUERY = `
  SELECT
    t.data->>'assignee' as person_id,
    c.data->>'name' as person_name,
    COUNT(*) FILTER (WHERE t.data->>'status' = 'tracker:status:InProgress') as active_task_count,
    COUNT(*) as total_task_count,
    (array_agg(t.data->>'title' ORDER BY
      CASE t.data->>'status'
        WHEN 'tracker:status:InProgress' THEN 1
        WHEN 'tracker:status:UnderReview' THEN 2
        WHEN 'tracker:status:Todo' THEN 3
        ELSE 4
      END,
      (t.data->>'priority')::int DESC
    ))[1] as current_task,
    (array_agg(
      CASE t.data->>'status'
        WHEN 'tracker:status:InProgress' THEN 'In Progress'
        WHEN 'tracker:status:UnderReview' THEN 'Under Review'
        WHEN 'tracker:status:Todo' THEN 'Todo'
        ELSE 'Backlog'
      END
      ORDER BY
        CASE t.data->>'status'
          WHEN 'tracker:status:InProgress' THEN 1
          WHEN 'tracker:status:UnderReview' THEN 2
          WHEN 'tracker:status:Todo' THEN 3
          ELSE 4
        END,
        (t.data->>'priority')::int DESC
    ))[1] as current_task_status,
    BOOL_OR(t.data->>'status' = 'tracker:status:InProgress') as is_working,
    s.data->>'identifier' as project_identifier
  FROM space s
  JOIN task t ON t.space = s._id
  JOIN contact c ON t.data->>'assignee' = c._id
  WHERE s._class = 'tracker:class:Project'
    AND s.archived = false
    AND c.data->'contact:mixin:Employee'->>'active' = 'true'
    AND t.data->>'status' IN (
      'tracker:status:InProgress',
      'tracker:status:Todo',
      'tracker:status:Backlog',
      'tracker:status:UnderReview'
    )
  GROUP BY t.data->>'assignee', c.data->>'name', s.data->>'identifier'
  ORDER BY c.data->>'name'
`;

// ── Types ──
interface HulyPerson {
  id: string;
  name: string;
  activeTaskCount: number;
  totalTaskCount: number;
  currentTask: string | null;
  currentTaskStatus: string | null;
  status: 'busy' | 'idle';
  project: string | null;
}

// ── Tile types ──
const WALL = 0;
const FLOOR = 1;
const VOID = 255;

// ── Room layout ──
const WALL_ROWS = 1;
const WORKSTATION_WIDTH = 5; // chair(1) + desk(3) + gap(1)
const WORKSTATIONS_PER_ROW = 2;
const WORKSTATION_ROW_HEIGHT = 2;
const BENCH_SPACING = 2;
const BENCH_ROW_HEIGHT = 2;
const BENCHES_PER_ROW = 4;
const VOID_GAP = 3; // visible gap between rooms
const PADDING = 1;
const ROOM_WIDTH = PADDING + WORKSTATIONS_PER_ROW * WORKSTATION_WIDTH + PADDING; // 12
const ROOM_MIN_HEIGHT = 8;
const HULY_AGENT_ID_OFFSET = 10_000;

// ── Room color palette ──
const ROOM_HUES = [220, 150, 30, 280, 0, 180, 60, 310, 120, 45];

// ── Wall decorations — placed on the wall row ──
const WALL_DECOR = [
  'BOOKSHELF',           // 2x1
  'DOUBLE_BOOKSHELF',    // 2x2
  'WHITEBOARD',          // 2x2
  'LARGE_PAINTING',      // 2x2
  'SMALL_PAINTING',      // 1x2
  'SMALL_PAINTING_2',    // 1x2
  'CLOCK',               // 1x2
  'HANGING_PLANT',       // 1x2
];

// ── Floor decor — 1x1 or 1x2 items placed in empty floor space ──
const FLOOR_DECOR = [
  'PLANT',     // 1x2 (backgroundTiles:1)
  'PLANT_2',   // 1x2 (backgroundTiles:1)
  'CACTUS',    // 1x2 (backgroundTiles:1)
  'BIN',       // 1x1
  'POT',       // 1x1
];


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
    if (p.status === 'busy') group.working.push(p);
    else group.idle.push(p);
  }
  return Array.from(map.values()).sort((a, b) => a.project.localeCompare(b.project));
}

/** Seeded random for deterministic decoration placement */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** A room can contain one or more project groups merged together */
interface Room {
  groups: ProjectGroup[];
  totalWorking: number;
  totalIdle: number;
}

const ROOM_CAPACITY = 4; // max working people per normal room

/** Merge small projects into shared rooms so space isn't wasted */
function packIntoRooms(groups: ProjectGroup[]): Room[] {
  const rooms: Room[] = [];
  // Separate large projects (>= ROOM_CAPACITY/2 people) from small ones
  const large: ProjectGroup[] = [];
  const small: ProjectGroup[] = [];
  for (const g of groups) {
    const total = g.working.length + g.idle.length;
    if (total >= Math.ceil(ROOM_CAPACITY / 2)) {
      large.push(g);
    } else {
      small.push(g);
    }
  }

  // Each large project gets its own room
  for (const g of large) {
    rooms.push({ groups: [g], totalWorking: g.working.length, totalIdle: g.idle.length });
  }

  // Pack small projects into shared rooms (bin packing)
  let currentRoom: Room | null = null;
  for (const g of small) {
    const personCount = g.working.length + g.idle.length;
    if (currentRoom && currentRoom.totalWorking + currentRoom.totalIdle + personCount <= ROOM_CAPACITY) {
      // Fits in current room
      currentRoom.groups.push(g);
      currentRoom.totalWorking += g.working.length;
      currentRoom.totalIdle += g.idle.length;
    } else {
      // Start a new room
      currentRoom = { groups: [g], totalWorking: g.working.length, totalIdle: g.idle.length };
      rooms.push(currentRoom);
    }
  }

  return rooms;
}

function computeRoomHeightFromRoom(room: Room): number {
  const workingRows = Math.ceil(room.totalWorking / WORKSTATIONS_PER_ROW);
  const idleRows = Math.ceil(room.totalIdle / BENCHES_PER_ROW);
  const workingHeight = workingRows * WORKSTATION_ROW_HEIGHT;
  const idleHeight = idleRows > 0 ? 1 + idleRows * BENCH_ROW_HEIGHT : 0;
  return WALL_ROWS + Math.max(workingHeight + idleHeight, 2) + PADDING;
}

function generate(persons: HulyPerson[]) {
  const groups = groupByProject(persons).filter((g) => g.working.length + g.idle.length > 0);

  if (groups.length === 0) {
    return {
      layout: { version: 1, cols: 10, rows: 6, tiles: Array(60).fill(FLOOR), furniture: [] as any[], tileColors: Array(60).fill(null) },
      persons: [],
    };
  }

  // Pack small projects into shared rooms
  const rooms = packIntoRooms(groups);

  // Grid arrangement
  const gridCols = Math.ceil(Math.sqrt(rooms.length));
  const gridRows = Math.ceil(rooms.length / gridCols);
  const roomHeight = Math.max(ROOM_MIN_HEIGHT, ...rooms.map((r) => computeRoomHeightFromRoom(r)));
  const totalCols = gridCols * ROOM_WIDTH + (gridCols - 1) * VOID_GAP;
  const totalRows = gridRows * roomHeight + (gridRows - 1) * VOID_GAP;

  const tiles: number[] = new Array(totalCols * totalRows).fill(VOID);
  const tileColors: any[] = new Array(totalCols * totalRows).fill(null);
  const furniture: any[] = [];
  let uidCounter = 0;

  function nextUid(prefix: string): string {
    return `${prefix}-${++uidCounter}`;
  }

  function setTile(col: number, row: number, type: number): void {
    if (col >= 0 && col < totalCols && row >= 0 && row < totalRows) {
      tiles[row * totalCols + col] = type;
    }
  }

  function setTileColor(col: number, row: number, color: any): void {
    if (col >= 0 && col < totalCols && row >= 0 && row < totalRows) {
      tileColors[row * totalCols + col] = color;
    }
  }

  const personIdMap = new Map<string, number>();
  let nextId = HULY_AGENT_ID_OFFSET;
  const webviewPersons: any[] = [];

  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const gc = ri % gridCols;
    const gr = Math.floor(ri / gridCols);
    const startCol = gc * (ROOM_WIDTH + VOID_GAP);
    const startRow = gr * (roomHeight + VOID_GAP);
    const hue = ROOM_HUES[ri % ROOM_HUES.length];
    const floorColor = { h: hue, s: 25, b: 10, c: 0, colorize: true };
    const rand = seededRandom(ri * 1000 + 42);

    // Track which tiles are occupied by furniture
    const occupied = new Set<string>();
    function markOccupied(col: number, row: number, w: number, h: number): void {
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          occupied.add(`${col + c},${row + r}`);
        }
      }
    }
    function isOccupied(col: number, row: number, w: number, h: number): boolean {
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          if (occupied.has(`${col + c},${row + r}`)) return true;
        }
      }
      return false;
    }

    // Fill room tiles
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

    // ── Place workstations and benches for all groups in this room ──
    // Collect all working and idle persons across merged groups
    const allWorking: { person: HulyPerson; project: string }[] = [];
    const allIdle: { person: HulyPerson; project: string }[] = [];
    for (const group of room.groups) {
      for (const p of group.working) allWorking.push({ person: p, project: group.project });
      for (const p of group.idle) allIdle.push({ person: p, project: group.project });
    }

    // Place workstations
    let personIdx = 0;
    const workingRowCount = Math.ceil(allWorking.length / WORKSTATIONS_PER_ROW);
    for (let wr = 0; wr < workingRowCount; wr++) {
      const tileRow = startRow + WALL_ROWS + wr * WORKSTATION_ROW_HEIGHT;
      for (let ws = 0; ws < WORKSTATIONS_PER_ROW && personIdx < allWorking.length; ws++) {
        const baseCol = startCol + PADDING + ws * WORKSTATION_WIDTH;
        const chairUid = nextUid('ch');
        furniture.push({ uid: chairUid, type: 'WOODEN_CHAIR_SIDE', col: baseCol, row: tileRow });
        furniture.push({ uid: nextUid('dk'), type: 'DESK_FRONT', col: baseCol + 1, row: tileRow });
        furniture.push({ uid: nextUid('pc'), type: 'PC_FRONT_OFF', col: baseCol + 1, row: tileRow });
        markOccupied(baseCol, tileRow, 1, 2);
        markOccupied(baseCol + 1, tileRow, 3, 2);

        if (rand() < 0.4) {
          furniture.push({ uid: nextUid('dc'), type: 'COFFEE', col: baseCol + 3, row: tileRow });
        }

        const { person, project } = allWorking[personIdx];
        const mapKey = `${person.id}:${project}`;
        let numericId = personIdMap.get(mapKey);
        if (numericId === undefined) {
          numericId = nextId++;
          personIdMap.set(mapKey, numericId);
        }
        webviewPersons.push({
          id: numericId, name: person.name, status: person.status,
          currentTask: person.currentTask, currentTaskStatus: person.currentTaskStatus,
          activeTaskCount: person.activeTaskCount, project: person.project, seatUid: chairUid,
        });
        personIdx++;
      }
    }

    // Place benches for idle
    if (allIdle.length > 0) {
      const benchStartRow = startRow + WALL_ROWS + workingRowCount * WORKSTATION_ROW_HEIGHT + (workingRowCount > 0 ? 1 : 0);
      let idleIdx = 0;
      const idleRowCount = Math.ceil(allIdle.length / BENCHES_PER_ROW);
      for (let br = 0; br < idleRowCount; br++) {
        const tileRow = benchStartRow + br * BENCH_ROW_HEIGHT;
        for (let bi = 0; bi < BENCHES_PER_ROW && idleIdx < allIdle.length; bi++) {
          const col = startCol + PADDING + bi * BENCH_SPACING;
          const benchUid = nextUid('bn');
          furniture.push({ uid: benchUid, type: 'CUSHIONED_BENCH', col, row: tileRow });
          markOccupied(col, tileRow, 1, 1);

          const { person, project } = allIdle[idleIdx];
          const mapKey = `${person.id}:${project}`;
          let numericId = personIdMap.get(mapKey);
          if (numericId === undefined) {
            numericId = nextId++;
            personIdMap.set(mapKey, numericId);
          }
          webviewPersons.push({
            id: numericId, name: person.name, status: person.status,
            currentTask: person.currentTask, currentTaskStatus: person.currentTaskStatus,
            activeTaskCount: person.activeTaskCount, project: person.project, seatUid: benchUid,
          });
          idleIdx++;
        }
      }
    }

    // ── Wall decorations ──
    const wallRow = startRow;
    let wallCol = startCol + PADDING;
    const numWallDecor = 1 + Math.floor(rand() * 2);
    for (let wd = 0; wd < numWallDecor && wallCol < startCol + ROOM_WIDTH - PADDING - 1; wd++) {
      const item = WALL_DECOR[Math.floor(rand() * WALL_DECOR.length)];
      furniture.push({ uid: nextUid('wd'), type: item, col: wallCol, row: wallRow });
      wallCol += 3;
    }

    // ── Floor corner plants ──
    const bottomRow = startRow + roomHeight - 2;
    const rightCol = startCol + ROOM_WIDTH - PADDING - 1;
    if (!isOccupied(rightCol, bottomRow, 1, 1)) {
      const plantType = FLOOR_DECOR[Math.floor(rand() * 3)];
      furniture.push({ uid: nextUid('fd'), type: plantType, col: rightCol, row: bottomRow });
      markOccupied(rightCol, bottomRow, 1, 2);
    }

    const blCol = startCol + PADDING;
    const blRow = startRow + roomHeight - PADDING - 1;
    if (!isOccupied(blCol, blRow, 1, 1)) {
      if (rand() < 0.5) {
        const smallDecor = rand() < 0.5 ? 'BIN' : 'POT';
        furniture.push({ uid: nextUid('fd'), type: smallDecor, col: blCol, row: blRow });
        markOccupied(blCol, blRow, 1, 1);
      }
    }
  }

  return {
    layout: { version: 1, cols: totalCols, rows: totalRows, tiles, furniture, tileColors },
    persons: webviewPersons,
  };
}

// ── DB Fetch ──
async function fetchPersons(): Promise<HulyPerson[]> {
  const client = new Client(DB_CONFIG);
  try {
    await client.connect();
    const result = await client.query(HULY_PERSONS_QUERY);
    return result.rows.map((row: any) => ({
      id: row.person_id,
      name: row.person_name,
      activeTaskCount: parseInt(row.active_task_count, 10),
      totalTaskCount: parseInt(row.total_task_count, 10),
      currentTask: row.current_task ?? null,
      currentTaskStatus: row.current_task_status ?? null,
      status: row.is_working ? 'busy' as const : 'idle' as const,
      project: row.project_identifier ?? null,
    }));
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Main ──
async function run(): Promise<void> {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const resolvedDir = process.platform === 'win32' ? scriptDir.replace(/^\/([A-Za-z]:)/, '$1') : scriptDir;
  const assetsDir = path.resolve(resolvedDir, '..', 'webview-ui', 'public', 'assets');
  const distAssetsDir = path.resolve(resolvedDir, '..', 'dist', 'assets');

  console.log(`[generate-layout] Fetching from DB...`);
  const persons = await fetchPersons();
  console.log(`[generate-layout] Got ${persons.length} person-project entries`);

  const { layout, persons: webviewPersons } = generate(persons);
  console.log(`[generate-layout] Layout: ${layout.cols}x${layout.rows}, ${layout.furniture.length} furniture, ${webviewPersons.length} persons`);

  for (const dir of [assetsDir, distAssetsDir]) {
    if (!fs.existsSync(dir)) {
      console.log(`[generate-layout] Skipping ${dir} (not found)`);
      continue;
    }
    fs.writeFileSync(path.join(dir, 'generated-layout.json'), JSON.stringify(layout, null, 2), 'utf-8');
    fs.writeFileSync(path.join(dir, 'generated-persons.json'), JSON.stringify(webviewPersons, null, 2), 'utf-8');
    console.log(`[generate-layout] Written to ${dir}`);
  }

  console.log(`[generate-layout] Done at ${new Date().toISOString()}`);
}

const isWatch = process.argv.includes('--watch');

run().catch((err) => {
  console.error('[generate-layout] Error:', err);
  if (!isWatch) process.exit(1);
});

if (isWatch) {
  console.log(`[generate-layout] Watching — will refresh every ${POLL_INTERVAL_MS / 60000} minutes`);
  setInterval(() => {
    run().catch((err) => console.error('[generate-layout] Poll error:', err));
  }, POLL_INTERVAL_MS);
}
