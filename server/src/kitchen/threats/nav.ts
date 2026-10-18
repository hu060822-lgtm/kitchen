import { FIRE_DOOR_BOX, buildColliders, moveWithCollision, openDoors, type Box, type Rect } from '@last-table/shared';

/**
 * 怪物的路網：後場與廚房裡的節點，邊由「實際走得過去」自動計算（與玩家使用同一份碰撞資料）。
 * 穿過防火門的邊標記為 door='fire'：門關著時不能走，只能繞冷藏室或乾貨室。
 * 怪物不會進入餐廳（那是客人的地方）。
 */

export interface NavNode {
  id: string;
  x: number;
  z: number;
}

export interface NavEdge {
  a: string;
  b: string;
  len: number;
  door?: 'fire';
}

const N = (id: string, x: number, z: number): NavNode => ({ id, x, z });

export const NAV_NODES: readonly NavNode[] = [
  N('OUT', 10.4, 25.7),
  N('BD', 8.2, 25.7),
  N('HN1', 4.6, 25.9),
  N('HN2', 0.6, 25.9),
  N('HN3', -1.9, 25.6),
  N('CH', -4.3, 25.4),
  N('C1', -5.6, 24.3),
  N('C2', -6.2, 21.0),
  N('C3', -7.4, 20.0),
  N('KCD', -7.7, 17.6),
  N('HE1', 8.1, 23.6),
  N('HE2', 8.1, 20.3),
  N('KFD', 7.95, 17.9),
  N('DH', 3.7, 24.55),
  N('D1', 3.7, 23.2),
  N('D2', 3.2, 21.2),
  N('D3', 4.7, 20.0),
  N('KDD', 4.7, 17.6),
  N('K1', -5.0, 16.9),
  N('K2', -0.5, 16.6),
  N('K3', 5.6, 16.4),
  N('K4', 6.6, 12.6),
  N('K5', 0.0, 11.7),
  N('K6', -5.2, 12.2),
];
export const NAV_BY_ID: Readonly<Record<string, NavNode>> = Object.fromEntries(NAV_NODES.map((n) => [n.id, n]));

/** 路網用的碰撞：門全開、沒有實體擋路、正門與後門不算（怪物從後門進出） */
function navColliders(): Box[] {
  return buildColliders(openDoors()).filter((b) => b.id !== 'backdoor' && b.id !== 'entrance');
}

function segHitsRect(ax: number, az: number, bx: number, bz: number, r: Rect): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  for (const [o, d, lo, hi] of [
    [ax, dx, r.minX, r.maxX],
    [az, dz, r.minZ, r.maxZ],
  ] as const) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false;
    } else {
      let a = (lo - o) / d;
      let c = (hi - o) / d;
      if (a > c) [a, c] = [c, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, c);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function buildEdges(): NavEdge[] {
  const boxes = navColliders();
  const edges: NavEdge[] = [];
  const nodes = NAV_NODES.filter((n) => n.id !== 'OUT');
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const len = Math.hypot(a.x - b.x, a.z - b.z);
      if (len > 7.5) continue;
      const m = moveWithCollision(a.x, a.z, b.x, b.z, boxes, 0.38);
      if (Math.hypot(m.x - b.x, m.z - b.z) > 0.05) continue;
      edges.push({ a: a.id, b: b.id, len, door: segHitsRect(a.x, a.z, b.x, b.z, FIRE_DOOR_BOX) ? 'fire' : undefined });
    }
  }
  edges.push({ a: 'OUT', b: 'BD', len: 2.2 });
  return edges;
}

export const NAV_EDGES: readonly NavEdge[] = buildEdges();

/** 最短路徑（Dijkstra）；fireOpen＝false 時不能穿過防火門 */
export function findPath(from: string, to: string, fireOpen: boolean): string[] | null {
  if (from === to) return [from];
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const open = new Set<string>([from]);
  while (open.size) {
    let cur = '';
    let best = Infinity;
    for (const id of open) {
      const d = dist.get(id)!;
      if (d < best) {
        best = d;
        cur = id;
      }
    }
    open.delete(cur);
    if (cur === to) break;
    for (const e of NAV_EDGES) {
      if (e.door === 'fire' && !fireOpen) continue;
      const next = e.a === cur ? e.b : e.b === cur ? e.a : null;
      if (!next) continue;
      const nd = best + e.len;
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd);
        prev.set(next, cur);
        open.add(next);
      }
    }
  }
  if (!prev.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0])!);
  return path;
}

/** 離某個點最近、而且直線走得到的節點 */
export function nearestNode(x: number, z: number, boxes: readonly Box[] = navColliders()): NavNode {
  let best: NavNode = NAV_NODES[1];
  let bd = Infinity;
  for (const n of NAV_NODES) {
    if (n.id === 'OUT') continue;
    const d = Math.hypot(n.x - x, n.z - z);
    if (d >= bd) continue;
    const m = moveWithCollision(x, z, n.x, n.z, boxes, 0.3);
    if (Math.hypot(m.x - n.x, m.z - n.z) > 0.1) continue;
    bd = d;
    best = n;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 格狀尋路：怪物實際移動用                                             */
/* ------------------------------------------------------------------ */

/**
 * 路網節點只用來定巡邏點；實際走路用細格子（12.5 cm）上的 A*，再把路徑拉直。
 * 每一格都和牆、家具保持 CLEARANCE 的距離，所以照著路徑走不會擦到東西、不會卡住；
 * 起點永遠是怪物現在的位置，不會因為「最近的節點在背後」而來回打轉。
 * 餐廳（z < 9.3）整片不能走：怪物不進前場。後門外有一小塊可以走（牠從那裡進出）。
 */
export const GRID = { cell: 0.125, minX: -9.6, maxX: 10.9, minZ: 9.3, maxZ: 27.6, clearance: 0.3 } as const;
const GW = Math.ceil((GRID.maxX - GRID.minX) / GRID.cell);
const GH = Math.ceil((GRID.maxZ - GRID.minZ) / GRID.cell);

export interface Pt {
  x: number;
  z: number;
}

function buildGrid(fireOpen: boolean, c: number): Uint8Array {
  const boxes = buildColliders({ fire: fireOpen }).filter((b) => b.id !== 'backdoor' && b.id !== 'entrance');
  const free = new Uint8Array(GW * GH);
  for (let j = 0; j < GH; j++) {
    const z = GRID.minZ + (j + 0.5) * GRID.cell;
    for (let i = 0; i < GW; i++) {
      const x = GRID.minX + (i + 0.5) * GRID.cell;
      const inside = x <= 9.0 || (x <= GRID.maxX && z >= 25.0 && z <= 26.4);
      if (!inside) continue;
      let hit = false;
      for (const b of boxes) {
        if (x > b.minX - c && x < b.maxX + c && z > b.minZ - c && z < b.maxZ + c) {
          hit = true;
          break;
        }
      }
      if (!hit) free[j * GW + i] = 1;
    }
  }
  return free;
}

const GRIDS = new Map<string, Uint8Array>();
/** clr：和家具保持的距離（怪物用預設值；測試讓玩家走路時用大一點的值） */
function grid(fireOpen: boolean, clr: number = GRID.clearance): Uint8Array {
  const key = `${fireOpen ? 1 : 0}:${clr}`;
  let g = GRIDS.get(key);
  if (!g) GRIDS.set(key, (g = buildGrid(fireOpen, clr)));
  return g;
}

const cellOf = (x: number, z: number): [number, number] => [Math.floor((x - GRID.minX) / GRID.cell), Math.floor((z - GRID.minZ) / GRID.cell)];
const centerOf = (i: number, j: number): Pt => ({ x: GRID.minX + (i + 0.5) * GRID.cell, z: GRID.minZ + (j + 0.5) * GRID.cell });

export function walkable(x: number, z: number, fireOpen: boolean, clr: number = GRID.clearance): boolean {
  const [i, j] = cellOf(x, z);
  if (i < 0 || j < 0 || i >= GW || j >= GH) return false;
  return grid(fireOpen, clr)[j * GW + i] === 1;
}

/** 離 (x, z) 最近的可走格（玩家貼著櫃台站時，終點會落在不能走的格子裡） */
export function nearestWalkable(x: number, z: number, fireOpen: boolean, maxR = 2.5, clr: number = GRID.clearance): Pt | null {
  const g = grid(fireOpen, clr);
  const [ci, cj] = cellOf(x, z);
  const maxRing = Math.ceil(maxR / GRID.cell);
  for (let r = 0; r <= maxRing; r++) {
    let best: Pt | null = null;
    let bd = Infinity;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= GW || j >= GH || !g[j * GW + i]) continue;
        const p = centerOf(i, j);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
    }
    if (best) return r === 0 ? { x, z } : best;
  }
  return null;
}

/** 兩點之間的直線是否整段都在可走的格子上 */
export function clearSegment(ax: number, az: number, bx: number, bz: number, fireOpen: boolean, clr: number = GRID.clearance): boolean {
  const len = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(len / (GRID.cell * 0.5)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    if (!walkable(ax + (bx - ax) * t, az + (bz - az) * t, fireOpen, clr)) return false;
  }
  return true;
}

/** 二元堆積（A* 的開放清單） */
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    const a = this.ids;
    const k = this.keys;
    a.push(id);
    k.push(key);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.ids;
    const k = this.keys;
    const top = a[0];
    const lastId = a.pop()!;
    const lastKey = k.pop()!;
    if (a.length) {
      a[0] = lastId;
      k[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && k[l] < k[m]) m = l;
        if (r < a.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}

const G_COST = new Float32Array(GW * GH);
const G_PREV = new Int32Array(GW * GH);
const G_STAMP = new Uint32Array(GW * GH);
const G_CLOSED = new Uint32Array(GW * GH);
let stamp = 0;

/**
 * 從 from 走到 to 的路徑（已拉直，不含起點）。走不到就回傳 null。
 * 8 方向、不切牆角；起點或終點落在不能走的格子時，先移到最近的可走格。
 */
export function gridPath(from: Pt, to: Pt, fireOpen: boolean, maxCells = 60000, clr: number = GRID.clearance): Pt[] | null {
  const g = grid(fireOpen, clr);
  const s = walkable(from.x, from.z, fireOpen, clr) ? from : nearestWalkable(from.x, from.z, fireOpen, 2.5, clr);
  const e = walkable(to.x, to.z, fireOpen, clr) ? to : nearestWalkable(to.x, to.z, fireOpen, 2.5, clr);
  if (!s || !e) return null;
  if (clearSegment(s.x, s.z, e.x, e.z, fireOpen, clr)) return s === from ? [e] : [s, e];
  const [si, sj] = cellOf(s.x, s.z);
  const [ei, ej] = cellOf(e.x, e.z);
  const start = sj * GW + si;
  const goal = ej * GW + ei;
  stamp++;
  const heap = new Heap();
  const h = (i: number, j: number) => {
    const dx = Math.abs(i - ei);
    const dz = Math.abs(j - ej);
    return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
  };
  G_STAMP[start] = stamp;
  G_COST[start] = 0;
  G_PREV[start] = -1;
  heap.push(start, h(si, sj));
  let found = false;
  let expanded = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (G_CLOSED[cur] === stamp) continue;
    G_CLOSED[cur] = stamp;
    if (cur === goal) {
      found = true;
      break;
    }
    if (++expanded > maxCells) break;
    const ci = cur % GW;
    const cj = (cur - ci) / GW;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= GW || nj >= GH) continue;
        const n = nj * GW + ni;
        if (!g[n] || G_CLOSED[n] === stamp) continue;
        if (di && dj && (!g[cj * GW + ni] || !g[nj * GW + ci])) continue;
        const cost = G_COST[cur] + (di && dj ? Math.SQRT2 : 1);
        if (G_STAMP[n] === stamp && cost >= G_COST[n]) continue;
        G_STAMP[n] = stamp;
        G_COST[n] = cost;
        G_PREV[n] = cur;
        heap.push(n, cost + h(ni, nj));
      }
    }
  }
  if (!found) return null;
  const cells: Pt[] = [];
  for (let c = goal; c !== -1; c = G_PREV[c]) {
    const i = c % GW;
    cells.push(centerOf(i, (c - i) / GW));
  }
  cells.reverse();
  cells[0] = s;
  cells[cells.length - 1] = e;
  // 拉直：從目前的錨點盡量直線連到最遠的格子
  const out: Pt[] = [];
  let anchor = 0;
  if (s !== from) out.push(s);
  while (anchor < cells.length - 1) {
    let far = anchor + 1;
    // 往前延伸，直到看不到為止（每 4 格檢查一次，夠快也夠直）
    for (let k = anchor + 2; k < cells.length; k += k + 4 < cells.length ? 4 : 1) {
      if (!clearSegment(cells[anchor].x, cells[anchor].z, cells[k].x, cells[k].z, fireOpen, clr)) break;
      far = k;
    }
    out.push(cells[far]);
    anchor = far;
  }
  return out;
}
