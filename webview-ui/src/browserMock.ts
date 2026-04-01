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

interface MockPayload {
  characters: CharacterDirectionSprites[];
  floorSprites: string[][][];
  wallSets: string[][][][];
  furnitureCatalog: CatalogEntry[];
  furnitureSprites: Record<string, string[][]>;
  layout: unknown;
  seatAssignments: SeatAssignments | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Module-level state ─────────────────────────────────────────────────────────

let mockPayload: MockPayload | null = null;
// Seat mapping from seat-assignments.json: personId+project → seatUid
let seatLookup: Map<string, string> | null = null;

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

  const [layout, seatAssignments] = await Promise.all([
    assetIndex.defaultLayout
      ? fetch(`${base}assets/${assetIndex.defaultLayout}`).then((r) => r.json())
      : Promise.resolve(null),
    fetchJsonOptional<SeatAssignments>(`${base}assets/seat-assignments.json`),
  ]);

  mockPayload = {
    characters,
    floorSprites,
    wallSets,
    furnitureCatalog: catalog,
    furnitureSprites,
    layout,
    seatAssignments,
  };

  console.log(
    `[BrowserMock] Ready (${hasDecoded ? 'decoded-json' : 'browser-png-decode'}) — ${characters.length} chars, ${floorSprites.length} floors, ${wallSets.length} wall sets, ${catalog.length} furniture items`,
  );
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
  dispatch({ type: 'layoutLoaded', layout });
  dispatch({
    type: 'settingsLoaded',
    soundEnabled: false,
    extensionVersion: '1.2.0',
    lastSeenVersion: '1.1',
  });

  // Build seat lookup from static seat-assignments.json
  if (seatAssignments) {
    seatLookup = new Map();
    for (const entry of [...seatAssignments.working, ...seatAssignments.idle]) {
      // Key: personId::project for exact match, also name::project as fallback
      seatLookup.set(`${entry.id}::${entry.project}`, entry.seat.furnitureUid);
      seatLookup.set(`${entry.name}::${entry.project}`, entry.seat.furnitureUid);
    }

    // Dispatch initial agents from static file
    const allEntries = [...seatAssignments.working, ...seatAssignments.idle];
    const agents = allEntries.map((entry, index) => ({
      id: index + 1,
      name: entry.name,
      seatUid: entry.seat.furnitureUid,
      isWorking: entry.status === 'working',
      tasks: entry.tasks,
      project: entry.project,
    }));
    dispatch({ type: 'staticAgentsLoaded', agents });
    console.log(`[BrowserMock] Dispatched ${agents.length} static agents from seat-assignments.json`);
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

    const allEntries = [...data.working, ...data.idle];
    const agents = allEntries.map((entry, index) => {
      // Try to find a pre-assigned seat from the static seat-assignments
      const seatUid =
        seatLookup?.get(`${entry.id}::${entry.project}`) ??
        seatLookup?.get(`${entry.name}::${entry.project}`) ??
        '';
      if (!seatUid) {
        console.log(`[BrowserMock] No seat mapping for "${entry.name}" in project ${entry.project}`);
      }
      return {
        id: index + 1,
        name: entry.name,
        seatUid,
        isWorking: entry.isWorking,
        tasks: entry.tasks,
        project: entry.project,
      };
    });

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
