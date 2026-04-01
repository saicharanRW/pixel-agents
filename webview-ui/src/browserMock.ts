/**
 * Browser runtime mock — fetches assets and injects the same postMessage
 * events the VS Code extension would send.
 *
 * In Vite dev, it prefers pre-decoded JSON endpoints from middleware.
 * In plain browser builds, it falls back to decoding PNGs at runtime.
 *
 * Only imported in browser runtime; tree-shaken from VS Code webview runtime.
 */

import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
  FLOOR_TILE_SIZE,
  PNG_ALPHA_THRESHOLD,
  WALL_BITMASK_COUNT,
  WALL_GRID_COLS,
  WALL_PIECE_HEIGHT,
  WALL_PIECE_WIDTH,
} from '../../shared/assets/constants.ts';
import type {
  AssetIndex,
  CatalogEntry,
  CharacterDirectionSprites,
} from '../../shared/assets/types.ts';

interface SeatAssignmentEntry {
  id: string;
  name: string;
  status: string;
  tasks: Array<{ title: string; identifier: string; status: string; priority: number }>;
  seat: { furnitureUid: string; type: string; col: number; row: number };
  project: string;
}

interface SeatAssignments {
  working: SeatAssignmentEntry[];
  idle: SeatAssignmentEntry[];
}

interface SeatMapEntry {
  seatUid: string;
  project: string;
  type: 'worker' | 'idle';
  index: number;
}

interface MockPayload {
  characters: CharacterDirectionSprites[];
  floorSprites: string[][][];
  wallSets: string[][][][];
  furnitureCatalog: CatalogEntry[];
  furnitureSprites: Record<string, string[][]>;
  layout: unknown;
  seatAssignments: SeatAssignments | null;
  seatMap: SeatMapEntry[] | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Module-level state ─────────────────────────────────────────────────────────

let mockPayload: MockPayload | null = null;

// ── PNG decode helpers (browser fallback) ───────────────────────────────────

interface DecodedPng {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function rgbaToHex(r: number, g: number, b: number, a: number): string {
  if (a < PNG_ALPHA_THRESHOLD) return '';
  const rgb =
    `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
  if (a >= 255) return rgb;
  return `${rgb}${a.toString(16).padStart(2, '0').toUpperCase()}`;
}

function getPixel(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const idx = (y * width + x) * 4;
  return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
}

function readSprite(
  png: DecodedPng,
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0,
): string[][] {
  const sprite: string[][] = [];
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(png.data, png.width, offsetX + x, offsetY + y);
      row.push(rgbaToHex(r, g, b, a));
    }
    sprite.push(row);
  }
  return sprite;
}

async function decodePng(url: string): Promise<DecodedPng> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch PNG: ${url} (${res.status.toString()})`);
  }
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Failed to create 2d canvas context for PNG decode');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: imageData.data };
}

async function fetchJsonOptional<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function getIndexedAssetPath(kind: 'characters' | 'floors' | 'walls', relPath: string): string {
  return relPath.startsWith(`${kind}/`) ? relPath : `${kind}/${relPath}`;
}

async function decodeCharactersFromPng(
  base: string,
  index: AssetIndex,
): Promise<CharacterDirectionSprites[]> {
  const sprites: CharacterDirectionSprites[] = [];
  for (const relPath of index.characters) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('characters', relPath)}`);
    const byDir: CharacterDirectionSprites = { down: [], up: [], right: [] };

    for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
      const dir = CHARACTER_DIRECTIONS[dirIdx];
      const rowOffsetY = dirIdx * CHAR_FRAME_H;
      const frames: string[][][] = [];
      for (let frame = 0; frame < CHAR_FRAMES_PER_ROW; frame++) {
        frames.push(readSprite(png, CHAR_FRAME_W, CHAR_FRAME_H, frame * CHAR_FRAME_W, rowOffsetY));
      }
      byDir[dir] = frames;
    }

    sprites.push(byDir);
  }
  return sprites;
}

async function decodeFloorsFromPng(base: string, index: AssetIndex): Promise<string[][][]> {
  const floors: string[][][] = [];
  for (const relPath of index.floors) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('floors', relPath)}`);
    floors.push(readSprite(png, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE));
  }
  return floors;
}

async function decodeWallsFromPng(base: string, index: AssetIndex): Promise<string[][][][]> {
  const wallSets: string[][][][] = [];
  for (const relPath of index.walls) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('walls', relPath)}`);
    const set: string[][][] = [];
    for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
      const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
      const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
      set.push(readSprite(png, WALL_PIECE_WIDTH, WALL_PIECE_HEIGHT, ox, oy));
    }
    wallSets.push(set);
  }
  return wallSets;
}

async function decodeFurnitureFromPng(
  base: string,
  catalog: CatalogEntry[],
): Promise<Record<string, string[][]>> {
  const sprites: Record<string, string[][]> = {};
  for (const entry of catalog) {
    const png = await decodePng(`${base}assets/${entry.furniturePath}`);
    sprites[entry.id] = readSprite(png, entry.width, entry.height);
  }
  return sprites;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Call before createRoot() in main.tsx.
 * Fetches all pre-decoded assets from the Vite dev server and stores them
 * for dispatchMockMessages().
 */
export async function initBrowserMock(): Promise<void> {
  console.log('[BrowserMock] Loading assets...');

  const base = import.meta.env.BASE_URL; // '/' in dev, '/sub/' with a subpath, './' in production

  const [assetIndex, catalog] = await Promise.all([
    fetch(`${base}assets/asset-index.json`).then((r) => r.json()) as Promise<AssetIndex>,
    fetch(`${base}assets/furniture-catalog.json`).then((r) => r.json()) as Promise<CatalogEntry[]>,
  ]);

  const [decodedCharacters, decodedFloors, decodedWalls, decodedFurniture] = await Promise.all([
    fetchJsonOptional<CharacterDirectionSprites[]>(`${base}assets/decoded/characters.json`),
    fetchJsonOptional<string[][][]>(`${base}assets/decoded/floors.json`),
    fetchJsonOptional<string[][][][]>(`${base}assets/decoded/walls.json`),
    fetchJsonOptional<Record<string, string[][]>>(`${base}assets/decoded/furniture.json`),
  ]);

  const hasDecoded = !!(decodedCharacters && decodedFloors && decodedWalls && decodedFurniture);

  if (!hasDecoded) {
    console.log('[BrowserMock] Decoded JSON not found, decoding PNG assets in browser...');
  }

  const [characters, floorSprites, wallSets, furnitureSprites] = hasDecoded
    ? [decodedCharacters!, decodedFloors!, decodedWalls!, decodedFurniture!]
    : await Promise.all([
        decodeCharactersFromPng(base, assetIndex),
        decodeFloorsFromPng(base, assetIndex),
        decodeWallsFromPng(base, assetIndex),
        decodeFurnitureFromPng(base, catalog),
      ]);

  const [layout, seatAssignments, seatMap] = await Promise.all([
    fetchJsonOptional<unknown>(`${base}assets/generated-layout.json`).then(
      (r) => r ?? (assetIndex.defaultLayout
        ? fetch(`${base}assets/${assetIndex.defaultLayout}`).then((res) => res.json())
        : null),
    ),
    fetchJsonOptional<SeatAssignments>(`${base}assets/seat-assignments.json`),
    fetchJsonOptional<SeatMapEntry[]>(`${base}assets/seat-map.json`),
  ]);

  mockPayload = {
    characters,
    floorSprites,
    wallSets,
    furnitureCatalog: catalog,
    furnitureSprites,
    layout,
    seatAssignments,
    seatMap,
  };

  console.log(
    `[BrowserMock] Ready (${hasDecoded ? 'decoded-json' : 'browser-png-decode'}) — ${characters.length} chars, ${floorSprites.length} floors, ${wallSets.length} wall sets, ${catalog.length} furniture items`,
  );
}

// ── Seat assignment helper ────────────────────────────────────────────────────

interface StaticAgent {
  id: number;
  name: string;
  seatUid: string;
  isWorking: boolean;
  tasks: Array<{ title: string; identifier: string; status: string; priority: number }>;
  project: string;
}

function assignAgentsToSeats(
  entries: Array<{ id: string; name: string; status: string; project: string; tasks: Array<{ title: string; identifier: string; status: string; priority: number }> }>,
  seatMap: SeatMapEntry[],
): StaticAgent[] {
  // Group entries by project + type
  const projectWorkers = new Map<string, typeof entries>();
  const projectIdle = new Map<string, typeof entries>();

  for (const entry of entries) {
    const isWorking = entry.status === 'working';
    const map = isWorking ? projectWorkers : projectIdle;
    let list = map.get(entry.project);
    if (!list) {
      list = [];
      map.set(entry.project, list);
    }
    list.push(entry);
  }

  const agents: StaticAgent[] = [];
  let nextId = 1;

  for (const seat of seatMap) {
    const map = seat.type === 'worker' ? projectWorkers : projectIdle;
    const list = map.get(seat.project);
    if (!list || seat.index >= list.length) continue;

    const entry = list[seat.index];
    agents.push({
      id: nextId++,
      name: entry.name,
      seatUid: seat.seatUid,
      isWorking: entry.status === 'working',
      tasks: entry.tasks,
      project: entry.project,
    });
  }

  return agents;
}

/**
 * Call inside a useEffect in App.tsx — after the window message listener
 * in useExtensionMessages has been registered.
 */
export function dispatchMockMessages(): void {
  if (!mockPayload) return;

  const {
    characters,
    floorSprites,
    wallSets,
    furnitureCatalog,
    furnitureSprites,
    layout,
    seatAssignments,
    seatMap,
  } = mockPayload;

  function dispatch(data: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { data }));
  }

  // Must match the load order defined in CLAUDE.md:
  // characterSpritesLoaded → floorTilesLoaded → wallTilesLoaded → furnitureAssetsLoaded → layoutLoaded
  dispatch({ type: 'characterSpritesLoaded', characters });
  dispatch({ type: 'floorTilesLoaded', sprites: floorSprites });
  dispatch({ type: 'wallTilesLoaded', sets: wallSets });
  dispatch({ type: 'furnitureAssetsLoaded', catalog: furnitureCatalog, sprites: furnitureSprites });
  dispatch({
    type: 'settingsLoaded',
    soundEnabled: false,
    extensionVersion: '1.2.0',
    lastSeenVersion: '1.1',
  });

  // Send the decorated layout (generated-layout.json or fallback)
  dispatch({ type: 'layoutLoaded', layout });

  // Assign people to seats using the seat map
  if (seatAssignments && seatMap) {
    const agents = assignAgentsToSeats(
      [...seatAssignments.working, ...seatAssignments.idle],
      seatMap,
    );
    dispatch({ type: 'staticAgentsLoaded', agents });
    console.log(`[BrowserMock] Assigned ${agents.length} agents to seats from seat-map.json`);
  }

  // Start polling /api/agents every 5 minutes for live data
  startAgentPolling();

  console.log('[BrowserMock] Messages dispatched');
}

// ── Live API polling ──────────────────────────────────────────────────────────

interface ApiAgentEntry {
  id: string;
  name: string;
  project: string;
  isWorking: boolean;
  tasks: Array<{ title: string; identifier: string; status: string; priority: number }>;
}

interface ApiResponse {
  timestamp: string;
  summary: { totalEntries: number; working: number; idle: number };
  working: ApiAgentEntry[];
  idle: ApiAgentEntry[];
}

async function fetchAndDispatchAgents(): Promise<void> {
  console.log(`[BrowserMock] Polling /api/agents at ${new Date().toISOString()}...`);

  try {
    const res = await fetch('/api/agents');
    if (!res.ok) {
      console.error(`[BrowserMock] /api/agents returned ${res.status.toString()}`);
      return;
    }

    const data = (await res.json()) as ApiResponse;
    console.log(
      `[BrowserMock] API response: ${data.summary.totalEntries} entries ` +
        `(${data.summary.working} working, ${data.summary.idle} idle) ` +
        `at ${data.timestamp}`,
    );

    // Assign people to seats using the seat map (layout stays the same)
    const currentSeatMap = mockPayload?.seatMap;
    if (!currentSeatMap) {
      console.log('[BrowserMock] No seat map available, skipping agent assignment');
      return;
    }

    // Convert API entries to the format assignAgentsToSeats expects
    const allEntries = [
      ...data.working.map((e) => ({ ...e, status: 'working' })),
      ...data.idle.map((e) => ({ ...e, status: 'idle' })),
    ];
    const agents = assignAgentsToSeats(allEntries, currentSeatMap);

    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'staticAgentsLoaded', agents } }),
    );

    console.log(`[BrowserMock] Refreshed ${agents.length} agents from API`);
  } catch (err) {
    console.error('[BrowserMock] Failed to fetch /api/agents:', err);
  }
}

function startAgentPolling(): void {
  // First live fetch after a short delay (let initial static agents render first)
  setTimeout(() => {
    void fetchAndDispatchAgents();
  }, 3000);

  // Poll every 5 minutes
  setInterval(() => {
    void fetchAndDispatchAgents();
  }, POLL_INTERVAL_MS);
  console.log(`[BrowserMock] Agent polling started (every ${(POLL_INTERVAL_MS / 60000).toString()} min)`);
}
