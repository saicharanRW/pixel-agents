#!/usr/bin/env node
/**
 * Fetch employee working/idle status and tasks from the Huly database,
 * then generate seat-assignments.json for the pixel-agents office layout.
 *
 * Usage:
 *   node scripts/fetch-huly-status.js
 *
 * The script reads the default-layout-1.json to find PC chairs and benches,
 * queries the DB for employees + tasks, and writes seat-assignments.json.
 * After running, reload the extension (or press F5) to see updated layout.
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// --- Config ---
const DB_CONFIG = {
  host: 'huly-db-do-user-16457911-0.e.db.ondigitalocean.com',
  port: 25060,
  user: 'huly_readonly',
  password: '+LU1oj1GnO3oSleg2MvTaNTmf5JN5J9T',
  database: 'defaultdb',
  ssl: { rejectUnauthorized: false },
};

const LAYOUT_PATH = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'default-layout-1.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'seat-assignments.json');

// --- Main ---
async function main() {
  // 1. Read layout to get PC chairs and benches
  console.log('Reading layout...');
  const layout = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8'));

  const pcChairs = layout.furniture
    .filter((f) => f.uid.startsWith('f-ws-c'))
    .sort((a, b) => a.row - b.row || a.col - b.col);

  const benches = layout.furniture
    .filter((f) => f.type === 'WOODEN_BENCH')
    .sort((a, b) => a.row - b.row || a.col - b.col);

  console.log(`Found ${pcChairs.length} PC chairs, ${benches.length} benches`);

  // 2. Connect to DB
  console.log('Connecting to Huly DB...');
  const client = new Client(DB_CONFIG);
  await client.connect();

  try {
    // 3. Get all active employees
    const employeesResult = await client.query(`
      SELECT _id, data->>'name' as name
      FROM contact
      WHERE _class = 'contact:class:Person'
        AND data->'contact:mixin:Employee'->>'active' = 'true'
      ORDER BY data->>'name'
    `);

    // 4. Get employees who have In Progress tasks (= working)
    const workingResult = await client.query(`
      SELECT DISTINCT t.data->>'assignee' as assignee_id
      FROM task t
      JOIN contact c ON t.data->>'assignee' = c._id
      WHERE t.data->>'status' = 'tracker:status:InProgress'
        AND c.data->'contact:mixin:Employee'->>'active' = 'true'
    `);
    const workingIds = new Set(workingResult.rows.map((r) => r.assignee_id));

    // 5. Get all tasks per person (In Progress, Todo, Backlog, Under Review)
    const tasksResult = await client.query(`
      SELECT
        t.data->>'assignee' as assignee_id,
        t.data->>'title' as title,
        t.data->>'identifier' as identifier,
        t.data->>'status' as status,
        t.data->>'priority' as priority
      FROM task t
      JOIN contact c ON t.data->>'assignee' = c._id
      WHERE c.data->'contact:mixin:Employee'->>'active' = 'true'
        AND t.data->>'status' IN (
          'tracker:status:InProgress',
          'tracker:status:Todo',
          'tracker:status:Backlog',
          'tracker:status:UnderReview'
        )
      ORDER BY
        CASE t.data->>'status'
          WHEN 'tracker:status:InProgress' THEN 1
          WHEN 'tracker:status:UnderReview' THEN 2
          WHEN 'tracker:status:Todo' THEN 3
          WHEN 'tracker:status:Backlog' THEN 4
        END,
        (t.data->>'priority')::int DESC
    `);

    const STATUS_MAP = {
      'tracker:status:InProgress': 'In Progress',
      'tracker:status:UnderReview': 'Under Review',
      'tracker:status:Todo': 'Todo',
      'tracker:status:Backlog': 'Backlog',
    };

    const tasksByPerson = {};
    for (const row of tasksResult.rows) {
      if (!tasksByPerson[row.assignee_id]) tasksByPerson[row.assignee_id] = [];
      tasksByPerson[row.assignee_id].push({
        title: row.title,
        identifier: row.identifier,
        status: STATUS_MAP[row.status] || row.status,
        priority: parseInt(row.priority) || 0,
      });
    }

    // 6. Split employees into working and idle
    const workingPeople = [];
    const idlePeople = [];

    for (const emp of employeesResult.rows) {
      const person = {
        id: emp._id,
        name: emp.name,
        tasks: tasksByPerson[emp._id] || [],
      };
      if (workingIds.has(emp._id)) {
        workingPeople.push(person);
      } else {
        idlePeople.push(person);
      }
    }

    console.log(`Working: ${workingPeople.length}, Idle: ${idlePeople.length}`);

    // 7. Assign seats
    if (workingPeople.length > pcChairs.length) {
      console.warn(`Warning: ${workingPeople.length} working people but only ${pcChairs.length} PC chairs. Some will overflow to benches.`);
    }
    if (idlePeople.length > benches.length) {
      console.warn(`Warning: ${idlePeople.length} idle people but only ${benches.length} benches. Some will overflow.`);
    }

    const working = workingPeople.map((person, i) => ({
      ...person,
      status: 'working',
      seat: i < pcChairs.length
        ? { furnitureUid: pcChairs[i].uid, type: pcChairs[i].type, col: pcChairs[i].col, row: pcChairs[i].row }
        : { furnitureUid: benches[i - pcChairs.length]?.uid || 'overflow', type: 'WOODEN_BENCH', col: 0, row: 0 },
    }));

    const idle = idlePeople.map((person, i) => ({
      ...person,
      status: 'idle',
      seat: i < benches.length
        ? { furnitureUid: benches[i].uid, type: 'WOODEN_BENCH', col: benches[i].col, row: benches[i].row }
        : { furnitureUid: pcChairs[workingPeople.length + (i - benches.length)]?.uid || 'overflow', type: 'PC_CHAIR', col: 0, row: 0 },
    }));

    // 8. Write output
    const output = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalEmployees: workingPeople.length + idlePeople.length,
        working: workingPeople.length,
        idle: idlePeople.length,
        pcChairs: pcChairs.length,
        benches: benches.length,
      },
      working,
      idle,
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log(`\nWritten to ${OUTPUT_PATH}`);
    console.log(`\n--- Summary ---`);
    console.log(`Total employees: ${output.summary.totalEmployees}`);
    console.log(`Working (at PCs): ${output.summary.working}`);
    console.log(`Idle (on benches): ${output.summary.idle}`);
    console.log(`\nReload the extension (F5) to see the updated layout.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
