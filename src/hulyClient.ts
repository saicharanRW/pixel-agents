import { Client } from 'pg';
import * as vscode from 'vscode';

import { HULY_POLL_INTERVAL_MS } from './constants.js';

export interface HulyPerson {
  id: string;
  name: string;
  activeTaskCount: number;
  totalTaskCount: number;
  currentTask: string | null;
  currentTaskStatus: string | null;
  status: 'busy' | 'idle';
}

export interface HulyDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
}

const DEFAULT_DB_CONFIG: HulyDbConfig = {
  host: 'huly-db-do-user-16457911-0.e.db.ondigitalocean.com',
  port: 25060,
  user: 'huly_readonly',
  password: '+LU1oj1GnO3oSleg2MvTaNTmf5JN5J9T',
  database: 'defaultdb',
  ssl: true,
};

let pollTimer: ReturnType<typeof setInterval> | null = null;

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
    BOOL_OR(t.data->>'status' = 'tracker:status:InProgress') as is_working
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
  GROUP BY t.data->>'assignee', c.data->>'name'
  ORDER BY c.data->>'name'
`;

export function getHulyDbConfig(): HulyDbConfig {
  const cfg = vscode.workspace.getConfiguration('pixel-agents');
  return {
    host: cfg.get<string>('hulyDbHost') || DEFAULT_DB_CONFIG.host,
    port: cfg.get<number>('hulyDbPort') || DEFAULT_DB_CONFIG.port,
    user: cfg.get<string>('hulyDbUser') || DEFAULT_DB_CONFIG.user,
    password: cfg.get<string>('hulyDbPassword') || DEFAULT_DB_CONFIG.password,
    database: cfg.get<string>('hulyDbName') || DEFAULT_DB_CONFIG.database,
    ssl: cfg.get<boolean>('hulyDbSsl') ?? DEFAULT_DB_CONFIG.ssl,
  };
}

export async function fetchHulyPersons(config: HulyDbConfig): Promise<HulyPerson[]> {
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
  });

  try {
    await client.connect();
    const result = await client.query(HULY_PERSONS_QUERY);

    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.person_id as string,
      name: row.person_name as string,
      activeTaskCount: parseInt(row.active_task_count as string, 10),
      totalTaskCount: parseInt(row.total_task_count as string, 10),
      currentTask: (row.current_task as string) ?? null,
      currentTaskStatus: (row.current_task_status as string) ?? null,
      status: (row.is_working ? 'busy' : 'idle') as 'busy' | 'idle',
    }));
  } catch (err) {
    console.error('[Huly] DB query failed:', err);
    return [];
  } finally {
    await client.end().catch(() => {});
  }
}

export function startHulyPolling(
  config: HulyDbConfig,
  onUpdate: (persons: HulyPerson[]) => void,
): void {
  stopHulyPolling();

  // Fetch immediately
  void fetchHulyPersons(config).then((persons) => {
    console.log(`[Huly] Loaded ${persons.length} persons from DB`);
    onUpdate(persons);
  });

  // Poll on interval
  pollTimer = setInterval(() => {
    void fetchHulyPersons(config).then((persons) => {
      console.log(`[Huly] Refreshed ${persons.length} persons from DB`);
      onUpdate(persons);
    });
  }, HULY_POLL_INTERVAL_MS);
}

export function stopHulyPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
