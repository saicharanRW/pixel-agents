import type { IncomingMessage, ServerResponse } from 'http';

import { Client } from 'pg';

interface TaskRow {
  person_id: string;
  person_name: string;
  project_identifier: string;
  task_title: string;
  task_identifier: string;
  task_status: string;
  task_priority: number;
  is_in_progress: boolean;
}

interface TaskInfo {
  title: string;
  identifier: string;
  status: string;
  priority: number;
}

interface PersonProject {
  id: string;
  name: string;
  project: string;
  isWorking: boolean;
  tasks: TaskInfo[];
}

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

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=60, stale-while-revalidate=120',
  });
  res.end(body);
}

export default async function handler(_req: IncomingMessage, res: ServerResponse) {
  console.log('[API /agents] Request received at', new Date().toISOString());

  const { HULY_DB_HOST, HULY_DB_PORT, HULY_DB_USER, HULY_DB_PASSWORD, HULY_DB_NAME, HULY_DB_SSL } =
    process.env;

  if (!HULY_DB_HOST || !HULY_DB_USER || !HULY_DB_PASSWORD) {
    console.error('[API /agents] Missing required HULY_DB_* environment variables');
    sendJson(res, 500, { error: 'Database not configured' });
    return;
  }

  console.log(`[API /agents] Connecting to ${HULY_DB_HOST}:${HULY_DB_PORT || '25060'}`);

  const client = new Client({
    host: HULY_DB_HOST,
    port: parseInt(HULY_DB_PORT || '25060', 10),
    user: HULY_DB_USER,
    password: HULY_DB_PASSWORD,
    database: HULY_DB_NAME || 'defaultdb',
    ssl: HULY_DB_SSL !== 'false' ? { rejectUnauthorized: false } : false,
  });

  try {
    await client.connect();
    console.log('[API /agents] Connected to DB, running query...');

    const result = await client.query(QUERY);
    console.log(`[API /agents] Query returned ${result.rows.length} rows`);

    // Group rows by person+project
    const groupMap = new Map<string, PersonProject>();

    for (const row of result.rows as TaskRow[]) {
      const key = `${row.person_id}::${row.project_identifier}`;
      let entry = groupMap.get(key);
      if (!entry) {
        entry = {
          id: row.person_id,
          name: row.person_name,
          project: row.project_identifier,
          isWorking: false,
          tasks: [],
        };
        groupMap.set(key, entry);
      }
      if (row.is_in_progress) {
        entry.isWorking = true;
      }
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

    console.log(
      `[API /agents] Grouped into ${employees.length} entries (${working.length} working, ${idle.length} idle)`,
    );

    sendJson(res, 200, {
      timestamp: new Date().toISOString(),
      summary: {
        totalEntries: employees.length,
        working: working.length,
        idle: idle.length,
      },
      working,
      idle,
    });
  } catch (err) {
    console.error('[API /agents] DB query failed:', err);
    sendJson(res, 500, { error: 'Database query failed', message: String(err) });
  } finally {
    await client.end().catch(() => {});
    console.log('[API /agents] DB connection closed');
  }
}
