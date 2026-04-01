/**
 * Decorate the generated layout with furniture assets.
 * Usage: npx tsx scripts/decorate-layout.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const LAYOUT_PATH = path.resolve(__dirname, '../webview-ui/public/assets/generated-layout.json');

interface PlacedFurniture { uid: string; type: string; col: number; row: number; }
interface FloorColor { h: number; s: number; b: number; c: number; colorize?: boolean; }
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

function buildOccupied(layout: Layout): Set<string> {
  const occ = new Set<string>();
  for (let r = 0; r < layout.rows; r++)
    for (let c = 0; c < layout.cols; c++) {
      const t = layout.tiles[r * layout.cols + c];
      if (t === TILE_WALL || t === TILE_VOID) occ.add(`${c},${r}`);
    }
  for (const f of layout.furniture) {
    const w = f.type.includes('DESK') ? 3 : f.type === 'SOFA_FRONT' || f.type === 'SOFA_BACK' || f.type === 'COFFEE_TABLE' ? 2 : 1;
    const h = f.type === 'WOODEN_BENCH' || f.type === 'POT' || f.type === 'BIN' || f.type === 'COFFEE' || f.type === 'CUSHIONED_BENCH' || f.type === 'SOFA_FRONT' || f.type === 'SOFA_BACK' || f.type === 'BOOKSHELF' ? 1 : f.type === 'LARGE_PLANT' ? 3 : 2;
    for (let rr = f.row; rr < f.row + h; rr++)
      for (let cc = f.col; cc < f.col + w; cc++)
        occ.add(`${cc},${rr}`);
  }
  return occ;
}

function isFree(col: number, row: number, w: number, h: number, occ: Set<string>): boolean {
  for (let r = row; r < row + h; r++)
    for (let c = col; c < col + w; c++)
      if (occ.has(`${c},${r}`)) return false;
  return true;
}

function place(col: number, row: number, w: number, h: number, type: string, uid: string, occ: Set<string>, out: PlacedFurniture[]): boolean {
  if (!isFree(col, row, w, h, occ)) return false;
  for (let r = row; r < row + h; r++)
    for (let c = col; c < col + w; c++)
      occ.add(`${c},${r}`);
  out.push({ uid, type, col, row });
  return true;
}

let cnt = 0;
function uid(p: string, cat: string): string { return `${p}-${cat}-${cnt++}`; }

// Rotate through plant types per room
const PLANTS = ['PLANT', 'PLANT_2', 'CACTUS'];

function decorateRoom(room: Room, occ: Set<string>, roomIdx: number): PlacedFurniture[] {
  const added: PlacedFurniture[] = [];
  const { innerLeft: iL, innerTop: iT, innerRight: iR, innerBottom: iB, prefix: p, top: wallRow } = room;
  const rW = iR - iL + 1;
  const rH = iB - iT + 1;
  const plantA = PLANTS[roomIdx % 3];
  const plantB = PLANTS[(roomIdx + 1) % 3];
  const plantC = PLANTS[(roomIdx + 2) % 3];

  // ── WALL ITEMS ─────────────────────────────────────────────────────
  added.push({ uid: uid(p, 'wb'), type: 'WHITEBOARD', col: iL + 3, row: wallRow });
  added.push({ uid: uid(p, 'pt1'), type: 'SMALL_PAINTING', col: iL, row: wallRow });
  added.push({ uid: uid(p, 'pt2'), type: 'SMALL_PAINTING_2', col: iR, row: wallRow });
  added.push({ uid: uid(p, 'clk'), type: 'CLOCK', col: iR - 2, row: wallRow });
  // Hanging plant on wall
  added.push({ uid: uid(p, 'hp'), type: 'HANGING_PLANT', col: iL + 6, row: wallRow });

  // ── PLANTS in corners (1x2 each) ───────────────────────────────────
  // Top-right
  place(iR, iT, 1, 2, plantA, uid(p, 'pl'), occ, added);
  // Bottom-left
  place(iL, iB - 1, 1, 2, plantB, uid(p, 'pl'), occ, added);
  // Bottom-right
  place(iR, iB - 1, 1, 2, plantC, uid(p, 'pl'), occ, added);
  // Mid-left (if room is tall enough)
  if (rH >= 8) {
    const midRow = iT + Math.floor(rH / 2);
    place(iL, midRow, 1, 2, plantA, uid(p, 'pl'), occ, added);
  }

  // ── LARGE PLANT for big rooms (2x3) ────────────────────────────────
  if (rH >= 10) {
    place(iR - 1, iT, 2, 3, 'LARGE_PLANT', uid(p, 'lp'), occ, added);
  }

  // ── CACTUS extras along right wall ─────────────────────────────────
  if (rH >= 7) {
    place(iR, iT + 3, 1, 2, 'CACTUS', uid(p, 'cac'), occ, added);
  }

  // ── BINS (1x1) — one each side of room ─────────────────────────────
  place(iL, iB, 1, 1, 'BIN', uid(p, 'bin'), occ, added);
  place(iR, iB, 1, 1, 'BIN', uid(p, 'bin'), occ, added);

  // ── POTS flanking the door (1x1) ───────────────────────────────────
  place(room.left + 4, iB, 1, 1, 'POT', uid(p, 'pot'), occ, added);
  place(room.left + 7, iB, 1, 1, 'POT', uid(p, 'pot'), occ, added);
  // Extra pots near top corners
  place(iL, iT, 1, 1, 'POT', uid(p, 'pot'), occ, added);

  // ── COFFEE on desks (surface items — overlap desks) ────────────────
  added.push({ uid: uid(p, 'cof1'), type: 'COFFEE', col: iL + 2, row: iT + 1 });
  if (rW >= 8) {
    added.push({ uid: uid(p, 'cof2'), type: 'COFFEE', col: iL + 7, row: iT + 1 });
  }

  // ── SOFA + COFFEE TABLE lounge ─────────────────────────────────────
  // Try bottom area first, then mid area for tall rooms
  const loungeCol = iL + 2;
  if (rH >= 7) {
    const loungeRow = iB - 2;
    if (place(loungeCol, loungeRow, 2, 2, 'COFFEE_TABLE', uid(p, 'ct'), occ, added)) {
      // Sofa below table
      place(loungeCol, loungeRow + 2, 2, 1, 'SOFA_FRONT', uid(p, 'sf'), occ, added);
    }
  } else if (rH >= 5) {
    // Smaller room — just a sofa against bottom wall
    place(iL + 3, iB, 2, 1, 'SOFA_FRONT', uid(p, 'sf'), occ, added);
  }

  // ── BOOKSHELF on right wall ────────────────────────────────────────
  added.push({ uid: uid(p, 'bs'), type: 'BOOKSHELF', col: iR - 1, row: wallRow });

  // ── Extra CUSHIONED BENCH for seating variety ──────────────────────
  if (rH >= 6) {
    place(iL + 5, iB, 1, 1, 'CUSHIONED_BENCH', uid(p, 'cb'), occ, added);
  }

  return added;
}

function main() {
  console.log('Reading generated-layout.json...');
  const layout: Layout = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf-8'));
  console.log(`Layout: ${layout.cols}x${layout.rows}, ${layout.furniture.length} existing furniture`);

  const occ = buildOccupied(layout);
  const rooms = detectRooms(layout);
  console.log(`Detected ${rooms.length} rooms`);

  let total = 0;
  for (let i = 0; i < rooms.length; i++) {
    const items = decorateRoom(rooms[i], occ, i);
    layout.furniture.push(...items);
    total += items.length;
    console.log(`  ${rooms[i].prefix}: +${items.length} items`);
  }

  // Corridor decorations — plants and pots along hallways
  let hallItems = 0;
  const roomTiles = new Set<string>();
  for (const room of rooms)
    for (let r = room.top; r <= room.bottom; r++)
      for (let c = room.left; c <= room.right; c++)
        roomTiles.add(`${c},${r}`);

  // Potted plants in corridors
  for (let r = 0; r < layout.rows; r += 5) {
    for (let c = 0; c < layout.cols; c += 7) {
      if (roomTiles.has(`${c},${r}`)) continue;
      const t = layout.tiles[r * layout.cols + c];
      if (t === TILE_VOID || t === TILE_WALL) continue;
      if (place(c, r, 1, 1, 'POT', `hall-pot-${hallItems}`, occ, layout.furniture)) hallItems++;
    }
  }

  // Tall plants at corridor intersections
  for (let r = 2; r < layout.rows - 2; r += 14) {
    for (let c = 12; c < layout.cols; c += 14) {
      if (roomTiles.has(`${c},${r}`)) continue;
      const t = layout.tiles[r * layout.cols + c];
      if (t === TILE_VOID || t === TILE_WALL) continue;
      const plantType = PLANTS[hallItems % 3];
      if (place(c, r, 1, 2, plantType, `hall-plant-${hallItems}`, occ, layout.furniture)) hallItems++;
    }
  }

  total += hallItems;

  console.log(`\nTotal added: ${total}, Final: ${layout.furniture.length} items`);
  fs.writeFileSync(LAYOUT_PATH, JSON.stringify(layout, null, 2));
  console.log(`Written to ${LAYOUT_PATH}`);
}

main();
