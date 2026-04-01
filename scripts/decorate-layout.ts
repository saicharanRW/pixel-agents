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
    const w = f.type.includes('DESK') ? 3 : 1;
    const h = f.type === 'WOODEN_BENCH' || f.type === 'POT' || f.type === 'BIN' || f.type === 'COFFEE' || f.type === 'CUSHIONED_BENCH' ? 1 : 2;
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

function decorateRoom(room: Room, occ: Set<string>): PlacedFurniture[] {
  const added: PlacedFurniture[] = [];
  const { innerLeft: iL, innerTop: iT, innerRight: iR, innerBottom: iB, prefix: p, top: wallRow } = room;
  const h = iB - iT + 1;

  // ── Wall items (placed ON the wall row — canPlaceOnWalls) ───────────
  // These are the CORRECT IDs from the catalog (no _FRONT suffix for wall/decor items)
  added.push({ uid: uid(p, 'wb'), type: 'WHITEBOARD', col: iL + 3, row: wallRow });
  added.push({ uid: uid(p, 'pt1'), type: 'SMALL_PAINTING', col: iL, row: wallRow });
  added.push({ uid: uid(p, 'pt2'), type: 'SMALL_PAINTING_2', col: iR, row: wallRow });
  added.push({ uid: uid(p, 'clk'), type: 'CLOCK', col: iR - 2, row: wallRow });

  // ── Plants on floor (PLANT is 1x2 tiles) ───────────────────────────
  // Place in corners and edges where there's free space
  place(iR, iT, 1, 2, 'PLANT', uid(p, 'pl'), occ, added);
  place(iL, iB - 1, 1, 2, 'PLANT_2', uid(p, 'pl'), occ, added);
  if (h > 6) place(iR, iB - 1, 1, 2, 'CACTUS', uid(p, 'pl'), occ, added);

  // ── Bin (1x1) ──────────────────────────────────────────────────────
  place(iL, iB, 1, 1, 'BIN', uid(p, 'bin'), occ, added);

  // ── Pots flanking door (1x1) ───────────────────────────────────────
  place(room.left + 4, iB, 1, 1, 'POT', uid(p, 'pot'), occ, added);
  place(room.left + 7, iB, 1, 1, 'POT', uid(p, 'pot'), occ, added);

  // ── Coffee on desk surface ─────────────────────────────────────────
  // Surface items overlap desks, so just place directly
  added.push({ uid: uid(p, 'cof'), type: 'COFFEE', col: iL + 2, row: iT + 1 });

  // ── Lounge in bigger rooms ─────────────────────────────────────────
  if (h >= 9) {
    const lr = iB - 2;
    const lc = iL + 3;
    if (place(lc, lr, 2, 2, 'COFFEE_TABLE', uid(p, 'ct'), occ, added)) {
      place(lc, lr + 2, 2, 1, 'SOFA_FRONT', uid(p, 'sf'), occ, added);
    }
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
  for (const room of rooms) {
    const items = decorateRoom(room, occ);
    layout.furniture.push(...items);
    total += items.length;
    console.log(`  ${room.prefix}: +${items.length} items`);
  }

  // Corridor plants
  let hallPlants = 0;
  const roomTiles = new Set<string>();
  for (const room of rooms)
    for (let r = room.top; r <= room.bottom; r++)
      for (let c = room.left; c <= room.right; c++)
        roomTiles.add(`${c},${r}`);

  for (let r = 1; r < layout.rows - 1; r += 7) {
    for (let c = 1; c < layout.cols - 1; c += 9) {
      if (roomTiles.has(`${c},${r}`)) continue;
      const t = layout.tiles[r * layout.cols + c];
      if (t === TILE_VOID || t === TILE_WALL) continue;
      if (place(c, r, 1, 1, 'POT', `hall-pot-${hallPlants}`, occ, layout.furniture)) hallPlants++;
    }
  }
  total += hallPlants;

  console.log(`\nTotal added: ${total}, Final: ${layout.furniture.length} items`);
  fs.writeFileSync(LAYOUT_PATH, JSON.stringify(layout, null, 2));
  console.log(`Written to ${LAYOUT_PATH}`);
}

main();
