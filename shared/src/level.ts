import type { Seat } from './seats';
import type { FlawId } from './flaws';

/**
 * 《最後一桌》餐廳的幾何（伺服器與客戶端共用）。
 *
 * 座標：x 橫向、z 往後場（+z）、y 向上，單位公尺。面向 +z 時，右手邊是 -x。
 *
 *   z=27 ┌──────────────┬──────────────────────────────┐
 *        │ 冷藏室 COLD  │  後走廊 HALL_N          後門 ▕ ← 送貨／入侵
 *        │ [冷藏架]     ├──────────────┬──┐  HALL_E  │
 *        │              │ 乾貨室 DRY    │   │         │
 *        │ [鐵籠]       │ [乾貨架] [櫃] │   │         │
 *   z=19 ├─門──────────┴──[爐 爐 鍋 鍋 烤]─門─┴─防火門─┤
 *        │ 水槽                                 監視器 │
 *        │ 備料A      [調味區｜備料B] 中島        置物櫃 │
 *        │ 裝盤區        出餐口      垃圾桶       ↓     │
 *   z=9  ├────────────[ 出 餐 窗 口 ]──────────旋轉門──┤
 *        │ 餐廳 DINING：六張桌子                        │
 *   z=0  └──────────────────[ 正門 ]─────────────────────┘
 *        x=+9（左側）                                  x=-9（右側）
 *
 * 後場有兩條路可以回到廚房（冷藏室門、乾貨室門、防火門），所以任何一條被擋住都有替代路線。
 */

export const WALL_HEIGHT = 3.2;
export const EYE_HEIGHT = 1.6;
export const PLAYER_RADIUS = 0.33;
/** 步行速度（m/s） */
export const WALK_SPEED = 2.3;
/** 客戶端互動距離（從工作站正面量起） */
export const INTERACT_RANGE = 1.9;
/** 伺服器接受的互動距離（含網路延遲容忍） */
export const SERVER_INTERACT_RANGE = 2.8;
/** 伺服器接受的最大移動速度（m/s，含容忍） */
export const MAX_SPEED = 7;

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Box extends Rect {
  id: string;
  kind: 'wall' | 'door' | 'prop' | 'entity';
  doorId?: DoorId;
  /** 回聲視野與畫面使用的高度（牆預設 WALL_HEIGHT） */
  height?: number;
}

export type ZoneId = 'DINING' | 'KITCHEN' | 'COLD' | 'DRY' | 'HALL_N' | 'HALL_E';

export interface ZoneDef extends Rect {
  id: ZoneId;
  label: string;
  /** 照明：亮（廚房）、昏暗（餐廳）、黑暗（後場）。影響怪物的視線距離與畫面 */
  light: 'bright' | 'dim' | 'dark';
}

export const ZONES: readonly ZoneDef[] = [
  { id: 'DINING', label: '餐廳', light: 'dim', minX: -9, maxX: 9, minZ: 0, maxZ: 9 },
  { id: 'KITCHEN', label: '廚房', light: 'bright', minX: -9, maxX: 9, minZ: 9.3, maxZ: 19 },
  { id: 'COLD', label: '冷藏室', light: 'dark', minX: -9, maxX: -3, minZ: 19.3, maxZ: 27 },
  { id: 'DRY', label: '乾貨室', light: 'dark', minX: -2.7, maxX: 6.9, minZ: 19.3, maxZ: 24.4 },
  { id: 'HALL_N', label: '後走廊', light: 'dark', minX: -2.7, maxX: 9, minZ: 24.7, maxZ: 27 },
  { id: 'HALL_E', label: '側走廊', light: 'dark', minX: 7.2, maxX: 9, minZ: 19.3, maxZ: 24.7 },
];
export const ZONE_BY_ID = Object.fromEntries(ZONES.map((z) => [z.id, z])) as Record<ZoneId, ZoneDef>;

export function zoneAt(x: number, z: number): ZoneDef | null {
  for (const zone of ZONES) if (x >= zone.minX && x <= zone.maxX && z >= zone.minZ && z <= zone.maxZ) return zone;
  return null;
}

export const LEVEL_BOUNDS: Rect = { minX: -9.5, maxX: 9.5, minZ: -0.5, maxZ: 27.5 };

/* ------------------------------------------------------------------ */
/* 門                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 會開關的門只有一扇：後走廊與廚房之間的防火門（失語員可以從監視器暫時關上，用來擋住怪物；
 * 關閉有時間上限，而且後場永遠還有另外兩條路）。其他門洞都是開著的通道。
 */
export type DoorId = 'fire';
export const DOOR_IDS: readonly DoorId[] = ['fire'];
export type DoorState = Record<DoorId, boolean>;
/** true＝開著 */
export const openDoors = (): DoorState => ({ fire: true });

/* ------------------------------------------------------------------ */
/* 牆                                                                  */
/* ------------------------------------------------------------------ */

const T = 0.3;
/** 低矮窄縫的位置（冷藏室東牆上） */
export const CRAWL_GAP = { x: -2.85, minZ: 21.0, maxZ: 21.7, height: 0.9 } as const;
const wall = (id: string, minX: number, maxX: number, minZ: number, maxZ: number, height = WALL_HEIGHT): Box => ({ id, kind: 'wall', minX, maxX, minZ, maxZ, height });

/** 牆面上的開口（給畫面與聲學資料用） */
export interface Opening {
  id: string;
  a: ZoneId;
  b: ZoneId;
  at: [number, number];
  width: number;
  /** 開口沿著哪個軸 */
  along: 'x' | 'z';
  door?: DoorId;
  label: string;
}

export const OPENINGS: readonly Opening[] = [
  { id: 'swing', a: 'DINING', b: 'KITCHEN', at: [4.25, 9.15], width: 1.5, along: 'x', label: '旋轉門' },
  { id: 'cold_door', a: 'KITCHEN', b: 'COLD', at: [-7.75, 19.15], width: 1.5, along: 'x', label: '冷藏室門' },
  { id: 'dry_door', a: 'KITCHEN', b: 'DRY', at: [4.7, 19.15], width: 1.4, along: 'x', label: '乾貨室門' },
  { id: 'fire', a: 'KITCHEN', b: 'HALL_E', at: [7.95, 19.15], width: 1.5, along: 'x', door: 'fire', label: '防火門' },
  { id: 'cold_hall', a: 'COLD', b: 'HALL_N', at: [-2.85, 25.45], width: 1.5, along: 'z', label: '冷藏室後門' },
  { id: 'dry_hall', a: 'DRY', b: 'HALL_N', at: [3.7, 24.55], width: 1.4, along: 'x', label: '乾貨室後門' },
  { id: 'hall_turn', a: 'HALL_N', b: 'HALL_E', at: [8.1, 24.7], width: 1.8, along: 'x', label: '走廊轉角' },
];

function buildWalls(): Box[] {
  return [
    // 外牆
    wall('out_s_l', -9 - T, -1, -T, 0),
    wall('out_s_r', 1, 9 + T, -T, 0),
    wall('out_w', -9 - T, -9, 0, 27),
    wall('out_e_1', 9, 9 + T, 0, 25),
    wall('out_e_2', 9, 9 + T, 26.4, 27),
    wall('out_n', -9 - T, 9 + T, 27, 27 + T),
    // 餐廳／廚房：出餐窗口（櫃台另外是道具）與旋轉門
    wall('front_1', -9, -3, 9, 9 + T),
    wall('front_2', 1, 3.5, 9, 9 + T),
    wall('front_3', 5, 9, 9, 9 + T),
    // 廚房／後場
    wall('back_1', -9, -8.5, 19, 19 + T),
    wall('back_2', -7, 4, 19, 19 + T),
    wall('back_3', 5.4, 7.2, 19, 19 + T),
    wall('back_4', 8.7, 9, 19, 19 + T),
    // 冷藏室東牆（往後走廊的開口在 z 24.7–26.2；z 21.0–21.7 是只有小矮人鑽得過的低矮窄縫）
    wall('cold_e_1', -3, -2.7, 19 + T, CRAWL_GAP.minZ),
    wall('cold_e_1b', -3, -2.7, CRAWL_GAP.maxZ, 24.7),
    wall('cold_e_2', -3, -2.7, 26.2, 27),
    // 乾貨室北牆（往後走廊的開口在 x 3–4.4）與東牆
    wall('dry_n_1', -2.7, 3, 24.4, 24.7),
    wall('dry_n_2', 4.4, 6.9, 24.4, 24.7),
    wall('dry_e', 6.9, 7.2, 19 + T, 24.7),
  ];
}

export const WALL_BOXES: readonly Box[] = buildWalls();

/**
 * 冷藏室與乾貨室之間的低矮窄縫（高 0.9 公尺、寬 0.7 公尺）：只有小矮人學徒鑽得過，
 * 其他玩家與怪物都被擋住（碰撞上就是一面牆，視線也被擋住）。
 */
export const CRAWL_BOX: Box = { id: 'crawl', kind: 'wall', minX: -3, maxX: -2.7, minZ: CRAWL_GAP.minZ, maxZ: CRAWL_GAP.maxZ, height: WALL_HEIGHT };

/** 乾貨室前門的門楣很低（1.75 公尺）：巨人助手過不去，要從防火門繞後走廊 */
export const LOW_DOOR_BOX: Box = { id: 'low_door', kind: 'door', minX: 4.0, maxX: 5.4, minZ: 19, maxZ: 19 + T, height: 1.75 };
export const LOW_DOOR_HEIGHT = 1.75;

/** 不會動的大型家具（碰撞用）：出餐窗口的櫃台、中島、爐台檯面、餐桌、正門、後門 */
export const FIXED_PROPS: readonly Box[] = [
  { id: 'pass_counter', kind: 'prop', minX: -3, maxX: 1, minZ: 9, maxZ: 9 + T, height: 1.05 },
  { id: 'island', kind: 'prop', minX: -3, maxX: 3, minZ: 13.4, maxZ: 15, height: 0.95 },
  { id: 'line', kind: 'prop', minX: -6.8, maxX: 3.5, minZ: 18.15, maxZ: 19, height: 0.95 },
  { id: 'plating_counter', kind: 'prop', minX: -8, maxX: -4, minZ: 9.3, maxZ: 10.1, height: 0.95 },
  { id: 'sink_counter', kind: 'prop', minX: -9, maxX: -8.2, minZ: 10.6, maxZ: 15.2, height: 0.95 },
  { id: 'fridge_shelf', kind: 'prop', minX: -8.6, maxX: -3.6, minZ: 26.2, maxZ: 27, height: 2.2 },
  { id: 'pantry_shelf', kind: 'prop', minX: -2.4, maxX: 2.4, minZ: 23.6, maxZ: 24.4, height: 2.0 },
  { id: 'cage', kind: 'prop', minX: -9, maxX: -7.6, minZ: 20.6, maxZ: 22.4, height: 2.2 },
  { id: 'entrance', kind: 'door', minX: -1, maxX: 1, minZ: -T, maxZ: 0, height: 2.6 },
  { id: 'backdoor', kind: 'door', minX: 9, maxX: 9 + T, minZ: 25, maxZ: 26.4, height: 2.4 },
  ...[-6, -1.5, 3].flatMap((x, i) =>
    [2.2, 6.2].map((z, j): Box => ({ id: `table_${i}_${j}`, kind: 'prop', minX: x - 0.6, maxX: x + 0.6, minZ: z - 0.45, maxZ: z + 0.45, height: 0.75 })),
  ),
];

export const FIRE_DOOR_BOX: Box = { id: 'fire', kind: 'door', doorId: 'fire', minX: 7.2, maxX: 8.7, minZ: 19, maxZ: 19 + T, height: 2.6 };

/* ------------------------------------------------------------------ */
/* 工作站                                                              */
/* ------------------------------------------------------------------ */

export type StationKind =
  | 'fridge'
  | 'pantry'
  | 'sink'
  | 'prep'
  | 'stove'
  | 'pan'
  | 'toaster'
  | 'spice'
  | 'plating'
  | 'pass'
  | 'trash'
  | 'cctv'
  | 'locker'
  | 'delivery'
  | 'cage'
  /** 回收窗口：客人吃完的髒盤送回來的地方 */
  | 'dishes'
  /** 交接架：任何人都可以放、拿（給不方便進去或不方便拿的人接手） */
  | 'shelf'
  /** 成品架：處理好的食材暫放（肉類與其他分開，避免交叉污染） */
  | 'rack'
  /** 烤箱：三段溫度、預熱慢、兩面同時上色（不用翻面，可以放著去做別的事） */
  | 'oven'
  /** 攪拌碗：把幾份食材拌成一份（麵糊、肉餡、拌料） */
  | 'mixer';

export interface StationDef {
  id: string;
  kind: StationKind;
  label: string;
  zone: ZoneId;
  /** 工作站中心（地面）[x, z] */
  pos: [number, number];
  /** 正面朝向（繞 Y 軸；正面法線為 (sin f, cos f)） */
  facing: number;
  /** 只有這些角色能使用；空陣列＝所有人 */
  roles: Seat[];
}

const F_PZ = 0; // 正面朝 +z
const F_MZ = Math.PI; // 正面朝 -z
const F_PX = Math.PI / 2; // 正面朝 +x
const F_MX = -Math.PI / 2; // 正面朝 -x

const st = (id: string, kind: StationKind, label: string, zone: ZoneId, pos: [number, number], facing: number, roles: Seat[] = []): StationDef => ({
  id,
  kind,
  label,
  zone,
  pos,
  facing,
  roles,
});

export const STATIONS: readonly StationDef[] = [
  st('pass', 'pass', '出餐口', 'KITCHEN', [-1, 9.3], F_PZ),
  st('plating', 'plating', '裝盤區', 'KITCHEN', [-6, 10.1], F_PZ),
  st('trash', 'trash', '垃圾桶', 'KITCHEN', [2.2, 9.7], F_PZ),
  st('sink', 'sink', '清洗區', 'KITCHEN', [-8.2, 11.6], F_PX),
  st('prep_a', 'prep', '備料台 A', 'KITCHEN', [-8.2, 14.2], F_PX),
  st('spice', 'spice', '調味區', 'KITCHEN', [-1.5, 13.4], F_MZ),
  st('prep_b', 'prep', '備料台 B', 'KITCHEN', [1.5, 15], F_PZ),
  st('stove_a', 'stove', '湯鍋 A', 'KITCHEN', [-5.6, 18.15], F_MZ),
  st('stove_b', 'stove', '湯鍋 B', 'KITCHEN', [-3.4, 18.15], F_MZ),
  st('pan_a', 'pan', '平底鍋 A', 'KITCHEN', [-1.2, 18.15], F_MZ),
  st('pan_b', 'pan', '平底鍋 B', 'KITCHEN', [1.0, 18.15], F_MZ),
  st('toaster', 'toaster', '烤麵包機', 'KITCHEN', [2.8, 18.15], F_MZ),
  st('cctv', 'cctv', '監視器與門禁', 'KITCHEN', [8.6, 12], F_MX),
  st('locker_k', 'locker', '置物櫃', 'KITCHEN', [8.6, 16.2], F_MX),
  st('fridge', 'fridge', '冷藏架', 'COLD', [-6.1, 26.2], F_MZ),
  st('cage', 'cage', '冷藏室的鐵籠', 'COLD', [-7.6, 21.5], F_PX),
  st('pantry', 'pantry', '乾貨架', 'DRY', [0, 23.6], F_MZ),
  st('locker_d', 'locker', '置物櫃', 'DRY', [6.5, 20.6], F_MX),
  st('delivery', 'delivery', '後門送貨區', 'HALL_N', [8.2, 25.7], F_MX),
  st('dish_return', 'dishes', '回收窗口', 'KITCHEN', [0.5, 9.3], F_PZ),
  st('shelf_cold', 'shelf', '冷藏室門口交接架', 'KITCHEN', [-8.75, 17.3], F_PX),
  st('shelf_line', 'shelf', '爐台旁交接架', 'KITCHEN', [6.2, 18.7], F_MZ),
  st('rack_veg', 'rack', '成品架・蔬菜與其他', 'KITCHEN', [-0.5, 15], F_PZ),
  st('rack_meat', 'rack', '成品架・肉類', 'KITCHEN', [-2.4, 15], F_PZ),
  st('oven', 'oven', '烤箱', 'KITCHEN', [8.6, 14.1], F_MX),
  st('mixer', 'mixer', '攪拌碗', 'KITCHEN', [1.2, 13.4], F_MZ),
];
export const STATION_BY_ID: Readonly<Record<string, StationDef>> = Object.fromEntries(STATIONS.map((s) => [s.id, s]));

export const roleCanUseStation = (role: Seat, s: StationDef): boolean => s.roles.length === 0 || s.roles.includes(role);

/** 工作站正前方的站立點（距正面 d 公尺） */
export function stationFront(s: StationDef, d = 0.6): [number, number] {
  return [s.pos[0] + Math.sin(s.facing) * d, s.pos[1] + Math.cos(s.facing) * d];
}

/** 置物櫃、監視器、交接架本身的碰撞（其他工作站都在家具上） */
const LOCKER_BOXES: Box[] = STATIONS.filter((s) => s.kind === 'locker' || s.kind === 'cctv' || s.kind === 'shelf' || s.kind === 'oven').map((s) => {
  // 靠牆的方向：正面朝 ±x 的家具在 x 方向薄、z 方向寬
  const alongX = Math.abs(Math.sin(s.facing)) < 0.5;
  const half = s.kind === 'shelf' ? [0.25, 0.5] : s.kind === 'oven' ? [0.35, 0.55] : [0.35, 0.5];
  const [hx, hz] = alongX ? [half[1], half[0]] : [half[0], half[1]];
  return {
    id: `prop_${s.id}`,
    kind: 'prop',
    minX: s.pos[0] - hx,
    maxX: s.pos[0] + hx,
    minZ: s.pos[1] - hz,
    maxZ: s.pos[1] + hz,
    height: s.kind === 'locker' ? 2.0 : s.kind === 'shelf' ? 1.5 : s.kind === 'oven' ? 1.0 : 1.6,
  };
});

/* ------------------------------------------------------------------ */
/* 碰撞                                                                */
/* ------------------------------------------------------------------ */

/** 動態的碰撞物（站在門口的客人、堵在走廊的怪物） */
export interface Blocker {
  id: string;
  x: number;
  z: number;
  r: number;
}

/**
 * 碰撞盒。flaw：這位玩家的缺陷卡會多或少一些阻擋——
 *   小矮人學徒（D08）鑽得過低矮窄縫；巨人助手（D07）過不了低門楣。
 * 省略 flaw＝一般玩家（怪物與導航也用這一份：窄縫對牠們是牆）。
 */
export function buildColliders(doors: Readonly<DoorState>, blockers: readonly Blocker[] = [], flaw: FlawId | null = null): Box[] {
  const boxes: Box[] = [...WALL_BOXES, ...FIXED_PROPS, ...LOCKER_BOXES];
  if (flaw !== 'D08') boxes.push(CRAWL_BOX);
  if (flaw === 'D07') boxes.push(LOW_DOOR_BOX);
  if (!doors.fire) boxes.push(FIRE_DOOR_BOX);
  for (const b of blockers) boxes.push({ id: b.id, kind: 'entity', minX: b.x - b.r, maxX: b.x + b.r, minZ: b.z - b.r, maxZ: b.z + b.r, height: 1.8 });
  return boxes;
}

export function circleHitsBox(x: number, z: number, r: number, b: Rect): boolean {
  const cx = Math.max(b.minX, Math.min(x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

export function hitsAny(x: number, z: number, r: number, boxes: readonly Rect[]): boolean {
  for (const b of boxes) if (circleHitsBox(x, z, r, b)) return true;
  return false;
}

/** 從 (fx, fz) 移動到 (tx, tz)，遇到牆時沿牆滑動（分軸解算） */
export function moveWithCollision(
  fx: number,
  fz: number,
  tx: number,
  tz: number,
  boxes: readonly Rect[],
  r: number = PLAYER_RADIUS,
): { x: number; z: number; blocked: boolean } {
  let x = fx;
  let z = fz;
  let blocked = false;
  const dist = Math.hypot(tx - fx, tz - fz);
  const steps = Math.max(1, Math.ceil(dist / 0.15));
  const sx = (tx - fx) / steps;
  const sz = (tz - fz) / steps;
  for (let i = 0; i < steps; i++) {
    if (!hitsAny(x + sx, z, r, boxes)) x += sx;
    else if (sx !== 0) blocked = true;
    if (!hitsAny(x, z + sz, r, boxes)) z += sz;
    else if (sz !== 0) blocked = true;
  }
  return { x, z, blocked };
}

/** 兩點之間的視線是否被牆或家具擋住（只考慮高度超過 minHeight 的東西） */
export function lineOfSight(ax: number, az: number, bx: number, bz: number, boxes: readonly Box[], minHeight = 1.3): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return true;
  for (const b of boxes) {
    if (b.kind === 'entity' || (b.height ?? WALL_HEIGHT) < minHeight) continue;
    if (segmentHitsRect(ax, az, dx, dz, b)) return false;
  }
  return true;
}

function segmentHitsRect(ox: number, oz: number, dx: number, dz: number, b: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const [o, d, lo, hi] of [
    [ox, dx, b.minX, b.maxX],
    [oz, dz, b.minZ, b.maxZ],
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
  return t1 > 0.001 && t0 < 0.999;
}

/* ------------------------------------------------------------------ */
/* 出生點                                                              */
/* ------------------------------------------------------------------ */

export interface SpawnPoint {
  pos: [number, number, number];
  yaw: number;
}

/** yaw=π 面向 +z（後場） */
export const SPAWNS: Record<Seat, SpawnPoint> = {
  P1: { pos: [-4.5, EYE_HEIGHT, 12], yaw: Math.PI },
  P2: { pos: [-1.5, EYE_HEIGHT, 11.5], yaw: Math.PI },
  P3: { pos: [1.5, EYE_HEIGHT, 12], yaw: Math.PI },
  P4: { pos: [-3.0, EYE_HEIGHT, 11.0], yaw: Math.PI },
  P5: { pos: [0.0, EYE_HEIGHT, 11.0], yaw: Math.PI },
  P6: { pos: [3.0, EYE_HEIGHT, 11.0], yaw: Math.PI },
  P7: { pos: [-6.0, EYE_HEIGHT, 12.0], yaw: Math.PI },
  P8: { pos: [5.5, EYE_HEIGHT, 12.0], yaw: Math.PI },
};

/** 水平朝向向量：yaw=0 → (0,-1) */
export const forwardOf = (yaw: number): [number, number] => [-Math.sin(yaw), -Math.cos(yaw)];

export const distanceXZ = (a: readonly [number, number, number], s: StationDef): number => Math.hypot(a[0] - s.pos[0], a[2] - s.pos[1]);
