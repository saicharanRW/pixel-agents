/**
 * Decorate the generated layout with furniture assets.
 * Usage: npx tsx scripts/decorate-layout.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const LAYOUT_PATH = path.resolve(__dirname, '../webview-ui/public/assets/generated-layout.json');

interface PlacedFurniture {
  uid: string;
  type: string;
  col: number;
  row: number;
  color?: { h: number; s: number; b: number; c: number; colorize?: boolean };
}

interface FloorColor {
  h: number; s: number; b: number; c: number; colorize?: boolean;
}

interface Layout {
  version: number; cols: number; rows: number;
  tiles: number[]; furniture: PlacedFurniture[]; tileColors: Array<FloorColor | null>;
}

const TILE_WALL = 0;
const TILE_VOID = 255;

interface Room {
  left: number; top: number; right: number; bottom: number;
  innerLeft: number; innerTop: number; innerRight: number; innerBottom: number;
  prefix: string;
}

function detectRooms(layout: Layout): Room[] {
  const { cols, tiles, furniture } = layout;
  const visited = new Set<string>();
  const rooms: Room[] = [];

  for (let r = 0; r < layout.rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const key = `${c},${r}`;
      if (visited.has(key)) continue;
      if (tiles[r * cols + c] !== TILE_WALL) continue;
      if (tiles[r * cols + (c + 1)] !== TILE_WALL) continue;
      if (tiles[(r + 1) * cols + c] !== TILE_WALL) continue;
      const tileDiag = tiles[(r + 1) * cols + (c + 1)];
      if (tileDiag === TILE_WALL || tileDiag === TILE_VOID) continue;

      let right = c;
      while (right < cols && tiles[r * cols + right] === TILE_WALL) right++;
      right--;
      let bottom = r;
      while (bottom < layout.rows && tiles[bottom * cols + c] === TILE_WALL) bottom++;
      bottom--;
      if (tiles[bottom * cols + right] !== TILE_WALL) continue;
      if (right - c < 5 || bottom - r < 5) continue;

      for (let rr = r; rr <= bottom; rr++)
        for (let cc = c; cc <= right; cc++)
          visited.add(`${cc},${rr}`);

      let prefix = '';
      for (const f of furniture) {
        if (f.col > c && f.col < right && f.row > r && f.row < bottom) {
          const match = /^([A-Za-z0-9]+)-/.exec(f.uid);
          if (match) { prefix = match[1]; break; }
        }
      }
      rooms.push({
        left: c, top: r, right, bottom,
        innerLeft: c + 1, innerTop: r + 1, innerRight: right - 1, innerBottom: bottom - 1,
        prefix,
      });
    }
  }
  return rooms;
}

// Build set of occupied tiles from existing furniture
function buildOccupied(layout: Layout): Set<string> {
  const occupied = new Set<string>();
  // Mark all non-floor tiles
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const tile = layout.tiles[r * layout.cols + c];
      if (tile === TILE_WALL || tile === TILE_VOID) {
        occupied.add(`${c},${r}`);
      }
    }
  }
  // Mark existing furniture (generous 3x2 for unknown types)
  for (const f of layout.furniture) {
    // Use known sizes or default
    const w = f.type.includes('DESK') ? 3 : f.type.includes('BENCH') ? 1 : f.type.includes('CHAIR') ? 1 : f.type.includes('PC') ? 1 : 1;
    const h = f.type.includes('DESK') ? 2 : f.type.includes('BENCH') ? 1 : f.type.includes('CHAIR') ? 2 : f.type.includes('PC') ? 2 : f.type.includes('BOOKSHELF') ? 1 : 2;
    for (let rr = f.row; rr < f.row + h; rr++)
      for (let cc = f.col; cc < f.col + w; cc++)
        occupied.add(`${cc},${rr}`);
  }
  return occupied;
}

function isFree(col: number, row: number, w: number, h: number, occupied: Set<string>): boolean {
  for (let r = row; r < row + h; r++)
    for (let c = col; c < col + w; c++)
      if (occupied.has(`${c},${r}`)) return false;
  return true;
}

function place(col: number, row: number, w: number, h: number, type: string, uid: string, occupied: Set<string>, out: PlacedFurniture[]): boolean {
  if (!isFree(col, row, w, h, occupied)) return false;
  for (let r = row; r < row + h; r++)
    for (let c = col; c < col + w; c++)
      occupied.add(`${c},${r}`);
  out.push({ uid, type, col, row });
  return true;
}

let counter = 0;
function uid(prefix: string, cat: string): string {
  return `${prefix}-${cat}-${counter++}`;
}

function decorateRoom(room: Room, occupied: Set<string>): PlacedFurniture[] {
  const added: PlacedFurniture[] = [];
  const { innerLeft: iL, innerTop: iT, innerRight: iR, innerBottom: iB, prefix: p, top: wallRow } = room;
  const w = iR - iL + 1;
  const h = iB - iT + 1;

  // ── Wall items (canPlaceOnWalls: bottom row sits ON the wall row) ───
  // These render above the wall. Place with row = wallRow (the wall tile row).
  added.push({ uid: uid(p, 'wb'), type: 'WHITEBOARD_FRONT', col: iL + Math.floor(w / 2) - 1, row: wallRow });
  added.push({ uid: uid(p, 'pt1'), type: 'SMALL_PAINTING_FRONT', col: iL, row: wallRow });
  added.push({ uid: uid(p, 'pt2'), type: 'SMALL_PAINTING_2_FRONT', col: iR, row: wallRow });
  added.push({ uid: uid(p, 'clk'), type: 'CLOCK_FRONT', col: iR - 2, row: wallRow });

  // ── Plants in corners (1×2 items, placed on floor) ──────────────────
  const plants = ['PLANT_FRONT', 'PLANT_2_FRONT', 'CACTUS_FRONT'];
  const pick = () => plants[counter % plants.length];

  // Top-right corner
  place(iR, iT, 1, 2, pick(), uid(p, 'pl'), occupied, added);
  // Bottom-left corner
  place(iL, iB - 1, 1, 2, pick(), uid(p, 'pl'), occupied, added);
  // Bottom-right corner
  if (h > 6) place(iR, iB - 1, 1, 2, pick(), uid(p, 'pl'), occupied, added);

  // ── Large plant if room is big enough ───────────────────────────────
  if (w >= 8 && h >= 10) {
    place(iR - 1, iT, 2, 3, 'LARGE_PLANT_FRONT', uid(p, 'lp'), occupied, added);
  }

  // ── Bin (1×1) near bottom-left ─────────────────────────────────────
  place(iL, iB, 1, 1, 'BIN', uid(p, 'bin'), occupied, added);

  // ── Pots (1×1) flanking the door opening (cols 5-6 of room) ────────
  const doorC = room.left + 4;
  place(doorC, iB, 1, 1, 'POT', uid(p, 'pot'), occupied, added);
  place(doorC + 3, iB, 1, 1, 'POT', uid(p, 'pot'), occupied, added);

  // ── Coffee on first desk (surface item) ────────────────────────────
  // Find the first desk and put coffee at its left tile
  // Coffee is 1×1, canPlaceOnSurfaces — it overlaps desks fine
  added.push({ uid: uid(p, 'cof'), type: 'COFFEE', col: iL + 1, row: iT + 1 });

  // ── Lounge area for big rooms ──────────────────────────────────────
  if (h >= 9) {
    const loungeRow = iB - 2;
    const loungeCol = iL + Math.floor(w / 2) - 1;
    if (place(loungeCol, loungeRow, 2, 2, 'COFFEE_TABLE_FRONT', uid(p, 'ct'), occupied, added)) {
      place(loungeCol, loungeRow + 2, 2, 1, 'SOFA_FRONT', uid(p, 'sf'), occupied, added);
    }
  }

  return added;
}

function main() {
  console.log('Reading generated-layout.json...');
  const layout: Layout = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf-8'));
  console.log(`Layout: ${layout.cols}×${layout.rows}, ${layout.furniture.length} existing furniture`);

  const occupied = buildOccupied(layout);
  const rooms = detectRooms(layout);
  console.log(`Detected ${rooms.length} rooms`);

  let total = 0;
  for (const room of rooms) {
    const items = decorateRoom(room, occupied);
    layout.furniture.push(...items);
    total += items.length;
    console.log(`  ${room.prefix}: +${items.length} items`);
  }

  // Corridor pots every few tiles
  let corridorPots = 0;
  const roomTiles = new Set<string>();
  for (const room of rooms)
    for (let r = room.top; r <= room.bottom; r++)
      for (let c = room.left; c <= room.right; c++)
        roomTiles.add(`${c},${r}`);

  for (let r = 0; r < layout.rows; r += 8) {
    for (let c = 0; c < layout.cols; c += 10) {
      if (roomTiles.has(`${c},${r}`)) continue;
      const tile = layout.tiles[r * layout.cols + c];
      if (tile === TILE_VOID || tile === TILE_WALL) continue;
      if (place(c, r, 1, 1, 'POT', `hall-pot-${corridorPots}`, occupied, layout.furniture)) corridorPots++;
    }
  }
  total += corridorPots;

  console.log(`\nTotal added: ${total}, Final furniture: ${layout.furniture.length}`);
  fs.writeFileSync(LAYOUT_PATH, JSON.stringify(layout, null, 2));
  console.log(`Written to ${LAYOUT_PATH}`);
}

main();
