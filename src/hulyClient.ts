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
  project: string | null;
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
  host: process.env.HULY_DB_HOST || '',
  port: parseInt(process.env.HULY_DB_PORT || '25060', 10),
  user: process.env.HULY_DB_USER || '',
  password: process.env.HULY_DB_PASSWORD || '',
  database: process.env.HULY_DB_NAME || 'defaultdb',
  ssl: process.env.HULY_DB_SSL !== 'false',
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

export function getHulyConfig(): HulyDbConfig {
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

    return result.rows.map((row) => ({
      id: row.person_id,
      name: row.person_name,
      activeTaskCount: parseInt(row.active_task_count, 10),
      totalTaskCount: parseInt(row.total_task_count, 10),
      currentTask: row.current_task ?? null,
      currentTaskStatus: row.current_task_status ?? null,
      status: row.is_working ? 'busy' : 'idle',
      project: row.project_identifier ?? null,
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
