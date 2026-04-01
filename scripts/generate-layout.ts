/**
 * Generate a layout JSON from the current Huly DB data.
 *
 * Usage:
 *   npx tsx scripts/generate-layout.ts
 *
 * Reads .env for DB credentials, queries Huly, generates rooms per project,
 * and writes the layout to webview-ui/public/assets/generated-layout.json.
 *
 * You can then open the extension, load this layout, and decorate it
 * (add flowers, sofas, paintings, etc.). The deployed site will use your
 * decorated layout as the base, with people assigned dynamically from the DB.
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ── DB Query (same as api/agents.ts) ──────────────────────────────────────────

const QUERY = `
  SELECT
    c._id as person_id,
    c.data->>'name' as person_name,
    s.data->>'identifier' as project_identifier,
    t.data->>'title' as task_title,
    t.data->>'identifier' as task_identifier,
    CASE t.data->>'status'
      WHEN 'tracker:status:InProgress' THEN 'In Progress'
      WHEN 'tracker:status:UnderReview' THEN 'Under Review'
      WHEN 'tracker:status:Todo' THEN 'Todo'
      ELSE 'Backlog'
    END as task_status,
    COALESCE((t.data->>'priority')::int, 0) as task_priority,
    CASE WHEN t.data->>'status' = 'tracker:status:InProgress' THEN true ELSE false END as is_in_progress
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
  ORDER BY c.data->>'name', s.data->>'identifier',
    CASE t.data->>'status'
      WHEN 'tracker:status:InProgress' THEN 1
      WHEN 'tracker:status:UnderReview' THEN 2
      WHEN 'tracker:status:Todo' THEN 3
      ELSE 4
    END,
    (t.data->>'priority')::int DESC
`;

// ── Layout generator (inline, same logic as layoutGenerator.ts) ───────────────

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

const TILE_VOID = 255;
const TILE_WALL = 0;
const TILE_FLOOR = 1;

const ROOM_INNER_W = 10;
const ROOM_W = ROOM_INNER_W + 2;
const CORRIDOR_W = 2;
const ROOMS_PER_ROW = 4;
const CORRIDOR_H = 2;
const WORKER_ROW_H = 3;
const MIN_INNER_H = 6;
const SEATS_PER_ROW = 2;
const BENCHES_PER_ROW = 4;

const ROOM_COLORS: FloorColor[] = [
  { h: 35, s: 30, b: 15, c: 0, colorize: true },
  { h: 210, s: 25, b: 10, c: 0, colorize: true },
  { h: 140, s: 20, b: 10, c: 0, colorize: true },
  { h: 280, s: 20, b: 5, c: 0, colorize: true },
  { h: 25, s: 35, b: 10, c: 0, colorize: true },
  { h: 340, s: 20, b: 10, c: 0, colorize: true },
  { h: 180, s: 25, b: 10, c: 0, colorize: true },
  { h: 60, s: 25, b: 15, c: 0, colorize: true },
];

interface ProjectGroup {
  project: string;
  workers: AgentEntry[];
  idle: AgentEntry[];
}

interface SeatMapping {
  seatUid: string;
  project: string;
  type: 'worker' | 'idle';
  index: number;
}

function calcRoomInnerH(workerCount: number, idleCount: number): number {
  const workerRows = Math.ceil(workerCount / SEATS_PER_ROW);
  const benchRows = Math.ceil(idleCount / BENCHES_PER_ROW);
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
  seatMap: SeatMapping[],
  globalCols: number,
): number {
  const workerCount = group.workers.length;
  const idleCount = group.idle.length;
  const workerRows = Math.ceil(workerCount / SEATS_PER_ROW);
  const benchRows = Math.ceil(idleCount / BENCHES_PER_ROW);
  const innerH = calcRoomInnerH(workerCount, idleCount);
  const roomH = innerH + 2;
  const prefix = group.project.replace(/[^A-Za-z0-9]/g, '');

  // Fill tiles
  for (let r = 0; r < roomH; r++) {
    for (let c = 0; c < ROOM_W; c++) {
      const gr = roomOffsetRow + r;
      const gc = roomOffsetCol + c;
      const idx = gr * globalCols + gc;
      const isWall = r === 0 || r === roomH - 1 || c === 0 || c === ROOM_W - 1;
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
    const baseRow = roomOffsetRow + 1 + 1 + wr * WORKER_ROW_H;
    for (let seat = 0; seat < SEATS_PER_ROW && workerIdx < workerCount; seat++) {
      const chairCol = roomOffsetCol + 1 + seat * 5;
      const deskCol = roomOffsetCol + 2 + seat * 5;
      const deskUid = `${prefix}-dk-${wr * 2 + seat}`;
      const chairUid = `${prefix}-ch-${wr * 2 + seat}`;
      const pcUid = `${prefix}-pc-${wr * 2 + seat}`;

      furniture.push({ uid: deskUid, type: 'DESK_FRONT', col: deskCol, row: baseRow });
      furniture.push({ uid: pcUid, type: 'PC_FRONT_OFF', col: deskCol + 1, row: baseRow });
      furniture.push({ uid: chairUid, type: 'WOODEN_CHAIR_SIDE', col: chairCol, row: baseRow });

      seatMap.push({ seatUid: chairUid, project: group.project, type: 'worker', index: workerIdx });
      workerIdx++;
    }
  }

  // Place benches for idle
  let idleIdx = 0;
  if (idleCount > 0) {
    const benchBaseRow = roomOffsetRow + 1 + 1 + workerRows * WORKER_ROW_H + 1;
    for (let br = 0; br < benchRows && idleIdx < idleCount; br++) {
      for (let bi = 0; bi < BENCHES_PER_ROW && idleIdx < idleCount; bi++) {
        const benchCol = roomOffsetCol + 1 + bi * 2 + (bi >= 2 ? 1 : 0);
        const benchUid = `${prefix}-bn-${br * BENCHES_PER_ROW + bi}`;
        furniture.push({ uid: benchUid, type: 'WOODEN_BENCH', col: benchCol, row: benchBaseRow + br });
        seatMap.push({ seatUid: benchUid, project: group.project, type: 'idle', index: idleIdx });
        idleIdx++;
      }
    }
  }

  // Decoration
  furniture.push({
    uid: `${prefix}-deco-0`,
    type: 'BOOKSHELF_FRONT',
    col: roomOffsetCol + ROOM_W - 2,
    row: roomOffsetRow + 1,
  });

  return roomH;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { HULY_DB_HOST, HULY_DB_PORT, HULY_DB_USER, HULY_DB_PASSWORD, HULY_DB_NAME, HULY_DB_SSL } =
    process.env;

  if (!HULY_DB_HOST || !HULY_DB_USER || !HULY_DB_PASSWORD) {
    console.error('Missing HULY_DB_* env vars. Check .env file.');
    process.exit(1);
  }

  console.log(`Connecting to ${HULY_DB_HOST}:${HULY_DB_PORT || '25060'}...`);

  const client = new Client({
    host: HULY_DB_HOST,
    port: parseInt(HULY_DB_PORT || '25060', 10),
    user: HULY_DB_USER,
    password: HULY_DB_PASSWORD,
    database: HULY_DB_NAME || 'defaultdb',
    ssl: HULY_DB_SSL !== 'false' ? { rejectUnauthorized: false } : false,
  });

  await client.connect();
  console.log('Connected. Querying...');

  const result = await client.query(QUERY);
  console.log(`Got ${result.rows.length} rows`);
  await client.end();

  // Group by person+project
  interface PersonProject {
    id: string;
    name: string;
    project: string;
    isWorking: boolean;
    tasks: Array<{ title: string; identifier: string; status: string; priority: number }>;
  }

  const groupMap = new Map<string, PersonProject>();
  for (const row of result.rows) {
    const key = `${row.person_id}::${row.project_identifier}`;
    let entry = groupMap.get(key);
    if (!entry) {
      entry = { id: row.person_id, name: row.person_name, project: row.project_identifier, isWorking: false, tasks: [] };
      groupMap.set(key, entry);
    }
    if (row.is_in_progress) entry.isWorking = true;
    entry.tasks.push({
      title: row.task_title,
      identifier: row.task_identifier,
      status: row.task_status,
      priority: row.task_priority,
    });
  }

  const employees = Array.from(groupMap.values());
  const working = employees.filter((e) => e.isWorking);
  const idle = employees.filter((e) => !e.isWorking);

  console.log(`${employees.length} entries: ${working.length} working, ${idle.length} idle`);

  // Group by project
  const projectMap = new Map<string, ProjectGroup>();
  for (const e of working) {
    let g = projectMap.get(e.project);
    if (!g) { g = { project: e.project, workers: [], idle: [] }; projectMap.set(e.project, g); }
    g.workers.push(e);
  }
  for (const e of idle) {
    let g = projectMap.get(e.project);
    if (!g) { g = { project: e.project, workers: [], idle: [] }; projectMap.set(e.project, g); }
    g.idle.push(e);
  }

  const projects = Array.from(projectMap.values());
  console.log(`${projects.length} projects`);

  // Calculate dimensions
  const roomHeights = projects.map((p) => calcRoomInnerH(p.workers.length, p.idle.length) + 2);
  const numRoomRows = Math.ceil(projects.length / ROOMS_PER_ROW);
  const roomRowHeights: number[] = [];
  for (let rr = 0; rr < numRoomRows; rr++) {
    let maxH = 0;
    for (let ri = rr * ROOMS_PER_ROW; ri < Math.min((rr + 1) * ROOMS_PER_ROW, projects.length); ri++) {
      maxH = Math.max(maxH, roomHeights[ri]);
    }
    roomRowHeights.push(maxH);
  }

  const maxRoomsInRow = Math.min(projects.length, ROOMS_PER_ROW);
  const globalCols = maxRoomsInRow * ROOM_W + Math.max(0, maxRoomsInRow - 1) * CORRIDOR_W;
  const globalRows = roomRowHeights.reduce((s, h) => s + h, 0) + Math.max(0, numRoomRows - 1) * CORRIDOR_H;

  const tiles = new Array(globalCols * globalRows).fill(TILE_VOID);
  const tileColors = new Array<FloorColor | null>(globalCols * globalRows).fill(null);
  const furniture: PlacedFurniture[] = [];
  const seatMap: SeatMapping[] = [];

  // Generate rooms
  let currentRow = 0;
  for (let rr = 0; rr < numRoomRows; rr++) {
    const roomsThisRow = rr < numRoomRows - 1 ? ROOMS_PER_ROW : (projects.length % ROOMS_PER_ROW || ROOMS_PER_ROW);
    for (let ri = 0; ri < roomsThisRow; ri++) {
      const projectIdx = rr * ROOMS_PER_ROW + ri;
      const roomCol = ri * (ROOM_W + CORRIDOR_W);
      const color = ROOM_COLORS[projectIdx % ROOM_COLORS.length];
      generateRoom(projects[projectIdx], roomCol, currentRow, color, tiles, tileColors, furniture, seatMap, globalCols);
    }

    // Corridors
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

  // Vertical corridors
  currentRow = 0;
  for (let rr = 0; rr < numRoomRows; rr++) {
    const roomsThisRow = rr < numRoomRows - 1 ? ROOMS_PER_ROW : (projects.length % ROOMS_PER_ROW || ROOMS_PER_ROW);
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

  // Write layout JSON
  const layout = {
    version: 1,
    cols: globalCols,
    rows: globalRows,
    tiles,
    furniture,
    tileColors,
  };

  const outPath = path.resolve(__dirname, '../webview-ui/public/assets/generated-layout.json');
  fs.writeFileSync(outPath, JSON.stringify(layout, null, 2));
  console.log(`\nLayout written to: ${outPath}`);
  console.log(`  Grid: ${globalCols} × ${globalRows}`);
  console.log(`  Furniture: ${furniture.length} items`);
  console.log(`  Rooms: ${projects.length}`);

  // Write seat map (for reference — which UID maps to which project slot)
  const seatMapPath = path.resolve(__dirname, '../webview-ui/public/assets/seat-map.json');
  fs.writeFileSync(seatMapPath, JSON.stringify(seatMap, null, 2));
  console.log(`  Seat map: ${seatMapPath} (${seatMap.length} seats)`);

  console.log('\nDone! Open the layout in the extension editor to decorate it.');
  console.log('Then update browserMock.ts to use generated-layout.json as the base layout.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
