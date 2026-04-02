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

// ── DB Config ──
const DB_CONFIG = {
  host: 'huly-db-do-user-16457911-0.e.db.ondigitalocean.com',
  port: 25060,
  user: 'huly_readonly',
  password: '+LU1oj1GnO3oSleg2MvTaNTmf5JN5J9T',
  database: 'defaultdb',
  ssl: { rejectUnauthorized: false },
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

// ── Layout Generator (inline to keep script standalone) ──
const WALL = 0;
const FLOOR = 1;
const VOID = 255;

const WALL_ROWS = 1;
const WORKSTATION_WIDTH = 5;
const WORKSTATIONS_PER_ROW = 2;
const WORKSTATION_ROW_HEIGHT = 2;
const BENCH_SPACING = 2;
const BENCH_ROW_HEIGHT = 2;
const BENCHES_PER_ROW = 4;
const VOID_GAP = 1;
const PADDING = 1;
const ROOM_WIDTH = PADDING + WORKSTATIONS_PER_ROW * WORKSTATION_WIDTH + PADDING;
const ROOM_MIN_HEIGHT = 8;
const ROOM_HUES = [220, 150, 30, 280, 0, 180, 60, 310, 120, 45];
const HULY_AGENT_ID_OFFSET = 10_000;

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

function computeRoomHeight(group: ProjectGroup): number {
  const workingRows = Math.ceil(group.working.length / WORKSTATIONS_PER_ROW);
  const idleRows = Math.ceil(group.idle.length / BENCHES_PER_ROW);
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

  const gridCols = Math.ceil(Math.sqrt(groups.length));
  const gridRows = Math.ceil(groups.length / gridCols);
  const roomHeight = Math.max(ROOM_MIN_HEIGHT, ...groups.map((g) => computeRoomHeight(g)));
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

  // Build seat map alongside layout
  const personIdMap = new Map<string, number>();
  let nextId = HULY_AGENT_ID_OFFSET;
  const webviewPersons: any[] = [];

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const gc = gi % gridCols;
    const gr = Math.floor(gi / gridCols);
    const startCol = gc * (ROOM_WIDTH + VOID_GAP);
    const startRow = gr * (roomHeight + VOID_GAP);
    const hue = ROOM_HUES[gi % ROOM_HUES.length];
    const floorColor = { h: hue, s: 25, b: 10, c: 0, colorize: true };

    for (let r = 0; r < roomHeight; r++) {
      for (let c = 0; c < ROOM_WIDTH; c++) {
        if (r === 0) setTile(startCol + c, startRow + r, WALL);
        else {
          setTile(startCol + c, startRow + r, FLOOR);
          setTileColor(startCol + c, startRow + r, floorColor);
        }
      }
    }

    // Workstations
    let personIdx = 0;
    const workingRowCount = Math.ceil(group.working.length / WORKSTATIONS_PER_ROW);
    for (let wr = 0; wr < workingRowCount; wr++) {
      const tileRow = startRow + WALL_ROWS + wr * WORKSTATION_ROW_HEIGHT;
      for (let ws = 0; ws < WORKSTATIONS_PER_ROW && personIdx < group.working.length; ws++) {
        const baseCol = startCol + PADDING + ws * WORKSTATION_WIDTH;
        const chairUid = nextUid('ch');
        furniture.push({ uid: chairUid, type: 'WOODEN_CHAIR_SIDE', col: baseCol, row: tileRow });
        furniture.push({ uid: nextUid('dk'), type: 'DESK_FRONT', col: baseCol + 1, row: tileRow });
        furniture.push({ uid: nextUid('pc'), type: 'PC_FRONT_OFF', col: baseCol + 1, row: tileRow });

        const person = group.working[personIdx];
        const mapKey = `${person.id}:${group.project}`;
        let numericId = personIdMap.get(mapKey);
        if (numericId === undefined) {
          numericId = nextId++;
          personIdMap.set(mapKey, numericId);
        }
        webviewPersons.push({
          id: numericId,
          name: person.name,
          status: person.status,
          currentTask: person.currentTask,
          currentTaskStatus: person.currentTaskStatus,
          activeTaskCount: person.activeTaskCount,
          project: person.project,
          seatUid: chairUid,
        });
        personIdx++;
      }
    }

    // Benches
    if (group.idle.length > 0) {
      const benchStartRow = startRow + WALL_ROWS + workingRowCount * WORKSTATION_ROW_HEIGHT + (workingRowCount > 0 ? 1 : 0);
      let idleIdx = 0;
      const idleRowCount = Math.ceil(group.idle.length / BENCHES_PER_ROW);
      for (let br = 0; br < idleRowCount; br++) {
        const tileRow = benchStartRow + br * BENCH_ROW_HEIGHT;
        for (let bi = 0; bi < BENCHES_PER_ROW && idleIdx < group.idle.length; bi++) {
          const col = startCol + PADDING + bi * BENCH_SPACING;
          const benchUid = nextUid('bn');
          furniture.push({ uid: benchUid, type: 'WOODEN_BENCH', col, row: tileRow });

          const person = group.idle[idleIdx];
          const mapKey = `${person.id}:${group.project}`;
          let numericId = personIdMap.get(mapKey);
          if (numericId === undefined) {
            numericId = nextId++;
            personIdMap.set(mapKey, numericId);
          }
          webviewPersons.push({
            id: numericId,
            name: person.name,
            status: person.status,
            currentTask: person.currentTask,
            currentTaskStatus: person.currentTaskStatus,
            activeTaskCount: person.activeTaskCount,
            project: person.project,
            seatUid: benchUid,
          });
          idleIdx++;
        }
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
  // Handle Windows paths (remove leading / from /C:/...)
  const resolvedDir = process.platform === 'win32' ? scriptDir.replace(/^\/([A-Za-z]:)/, '$1') : scriptDir;
  const assetsDir = path.resolve(resolvedDir, '..', 'webview-ui', 'public', 'assets');
  const distAssetsDir = path.resolve(resolvedDir, '..', 'dist', 'assets');

  console.log(`[generate-layout] Fetching from DB...`);
  const persons = await fetchPersons();
  console.log(`[generate-layout] Got ${persons.length} person-project entries`);

  const { layout, persons: webviewPersons } = generate(persons);
  console.log(`[generate-layout] Layout: ${layout.cols}x${layout.rows}, ${layout.furniture.length} furniture, ${webviewPersons.length} persons`);

  // Write to both locations
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

// ── Entry point ──
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
