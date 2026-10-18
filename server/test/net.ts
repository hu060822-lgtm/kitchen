import { io, type Socket } from 'socket.io-client';
import {
  SEATS,
  SPAWNS,
  STATION_BY_ID,
  moveWithCollision,
  stationFront,
  type KitchenActionResult,
  type FlawId,
  type KitchenPublic,
  type Seat,
} from '@last-table/shared';
import type { GameServer } from '../src/app';
import { createGameServer } from '../src/app';
import { findPath, NAV_BY_ID, nearestNode } from '../src/kitchen/threats/nav';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Captured {
  event: string;
  payload: unknown;
}

let reqSeq = 0;
export const nextReq = (): string => `t-${++reqSeq}`;

export class TestClient {
  readonly socket: Socket;
  readonly events: Captured[] = [];
  role: Seat | null = null;
  token = '';
  code = '';
  playerId = '';
  x = 0;
  z = 0;
  seq = 0;
  kitchen: KitchenPublic | null = null;

  constructor(url: string, readonly label: string) {
    this.socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    this.socket.onAny((event, payload) => {
      this.events.push({ event, payload });
      if (event === 'player:correct') {
        this.x = payload.x;
        this.z = payload.z;
      } else if (event === 'kitchen:state') this.kitchen = payload;
    });
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.connected) return resolve();
      this.socket.once('connect', () => resolve());
      this.socket.once('connect_error', reject);
    });
  }

  call<T = Record<string, unknown>>(event: string, payload?: unknown): Promise<T> {
    return new Promise((resolve) => {
      const ack = (r: T) => resolve(r);
      if (payload === undefined) this.socket.emit(event, ack);
      else this.socket.emit(event, payload, ack);
    });
  }

  fire(event: string, payload?: unknown): void {
    this.socket.emit(event, payload);
  }

  of<T = unknown>(event: string): T[] {
    return this.events.filter((e) => e.event === event).map((e) => e.payload as T);
  }

  mark(): number {
    return this.events.length;
  }

  async waitFor<T = unknown>(event: string, pred: (p: T) => boolean = () => true, timeout = 3000, from = 0): Promise<T> {
    const start = Date.now();
    let seen = this.events.slice(0, from).filter((e) => e.event === event).length;
    for (;;) {
      const all = this.events.filter((e) => e.event === event);
      for (; seen < all.length; seen++) if (pred(all[seen].payload as T)) return all[seen].payload as T;
      if (Date.now() - start > timeout) throw new Error(`[${this.label}] 等不到事件 ${event}`);
      await sleep(10);
    }
  }

  async expectNone(event: string, pred: (p: unknown) => boolean = () => true, ms = 250): Promise<void> {
    const from = this.events.length;
    await sleep(ms);
    const hit = this.events.slice(from).find((e) => e.event === event && pred(e.payload));
    if (hit) throw new Error(`[${this.label}] 不該收到 ${event}：${JSON.stringify(hit.payload).slice(0, 200)}`);
  }

  /** 工作站操作（requestId 可指定，用來測試去重） */
  action(stationId: string, action: string, args: Record<string, unknown> = {}, requestId = nextReq()): Promise<KitchenActionResult> {
    return this.call<KitchenActionResult>('kitchen:action', { stationId, action, args, requestId });
  }

  close(): void {
    this.socket.close();
  }
}

/* ------------------------------ 走路 ------------------------------ */

type Pt = [number, number];

export interface Table {
  server: GameServer;
  url: string;
  clients: Record<Seat, TestClient>;
  host: TestClient;
  code: string;
  close(): Promise<void>;
}

/** 這張桌子實際有的席位 */
export const seatsOf = (t: Table): Seat[] => SEATS.filter((s) => t.clients[s]);

export const serverRoom = (t: Table) => t.server.manager.rooms.get(t.code)!;
export const serverPose = (t: Table, role: Seat) => [...serverRoom(t).players.values()].find((p) => p.role === role)!.pose;

async function stepTo(c: TestClient, tx: number, tz: number, stepLen = 2.0): Promise<void> {
  for (let guard = 0; guard < 60; guard++) {
    const dist = Math.hypot(tx - c.x, tz - c.z);
    if (dist < 0.01) return;
    const k = Math.min(1, stepLen / dist);
    c.x += (tx - c.x) * k;
    c.z += (tz - c.z) * k;
    c.fire('player:move', { x: c.x, y: 1.6, z: c.z, yaw: Math.atan2(-(tx - c.x), -(tz - c.z)), seq: ++c.seq });
    await sleep(32); // 伺服器忽略間隔小於 25 ms 的移動封包
  }
  throw new Error(`[${c.label}] 走不到 ${tx},${tz}`);
}

/** 真的走到工作站前（經由路網繞過家具），由伺服器驗證每一步 */
export async function walkTo(t: Table, c: TestClient, stationId: string): Promise<void> {
  const s = STATION_BY_ID[stationId];
  const target: Pt = stationFront(s, 0.75);
  const boxes = serverRoom(t).colliders();
  const clear = (a: Pt, b: Pt) => {
    const r = moveWithCollision(a[0], a[1], b[0], b[1], boxes);
    return !r.blocked && Math.hypot(r.x - b[0], r.z - b[1]) < 0.02;
  };
  const pts: Pt[] = [];
  if (!clear([c.x, c.z], target)) {
    const from = nearestNode(c.x, c.z, boxes);
    const to = nearestNode(target[0], target[1], boxes);
    const ids = findPath(from.id, to.id, true);
    if (!ids) throw new Error(`[${c.label}] 找不到路到 ${stationId}`);
    for (const id of ids) pts.push([NAV_BY_ID[id].x, NAV_BY_ID[id].z]);
  }
  pts.push(target);
  for (const p of pts) await stepTo(c, p[0], p[1]);
  await sleep(40);
  // 面向工作站
  c.fire('player:move', { x: c.x, y: 1.6, z: c.z, yaw: s.facing + Math.PI, seq: ++c.seq });
  await sleep(30);
  const pose = serverPose(t, c.role!);
  if (Math.hypot(pose.x - target[0], pose.z - target[1]) > 0.1) throw new Error(`[${c.label}] 伺服器位置與客戶端不同（${stationId}）：伺服器 ${pose.x.toFixed(2)},${pose.z.toFixed(2)}，目標 ${target[0].toFixed(2)},${target[1].toFixed(2)}，路徑 ${JSON.stringify(pts.map((p) => p.map((v) => +v.toFixed(2))))}，狀態 ${serverRoom(t).sim?.status(c.role!)}／${serverRoom(t).sim?.flaws.frozen(c.role!)}／task ${JSON.stringify(serverRoom(t).sim?.players[c.role!].task)}`);
}

/** 測試設定：直接把玩家放到某個位置（伺服器與客戶端同步） */
export function place(t: Table, role: Seat, x: number, z: number, yaw = Math.PI): void {
  const pose = serverPose(t, role);
  pose.x = x;
  pose.z = z;
  pose.yaw = yaw;
  const c = t.clients[role];
  c.x = x;
  c.z = z;
}

/** 測試設定：放到工作站前 */
export function placeAt(t: Table, role: Seat, stationId: string): void {
  const s = STATION_BY_ID[stationId];
  const [x, z] = stationFront(s, 0.75);
  place(t, role, x, z, s.facing + Math.PI);
}

/* ------------------------------ 房間 ------------------------------ */

export async function startServer(overrides: Parameters<typeof createGameServer>[0] = {}): Promise<{ server: GameServer; url: string }> {
  const server = createGameServer({
    corsOrigins: true,
    moveSpeedMultiplier: 100,
    debugTools: false,
    manualClock: true,
    readyGate: false,
    prepSec: 5,
    serviceSec: 420,
    threats: false,
    ...overrides,
  });
  const port = await server.listen(0);
  return { server, url: `http://127.0.0.1:${port}` };
}

/** 預設的三人桌缺陷卡：對料理流程影響最小的組合（測試個別卡時另外指定） */
export const DEFAULT_TEST_FLAWS: FlawId[] = ['D04', 'D03', 'D04'];

/** 建立 n 人的大廳（1–8），每個人依序選 flaws[i]（null＝不選） */
export async function lobbyOf(n: number, flaws: Array<FlawId | null> = DEFAULT_TEST_FLAWS, overrides: Parameters<typeof createGameServer>[0] = {}): Promise<Table> {
  const { server, url } = await startServer(overrides);
  const names = ['Aki', 'Bao', 'Cleo', 'Dan', 'Eve', 'Fay', 'Gus', 'Hana'];
  const clients = {} as Record<Seat, TestClient>;
  const host = new TestClient(url, names[0]);
  await host.connect();
  const created = await host.call<{ ok: true; roomCode: string; token: string; playerId: string }>('room:create', { name: names[0] });
  if (!created.ok) throw new Error('建立房間失敗');
  host.code = created.roomCode;
  host.token = created.token;
  host.playerId = created.playerId;
  host.role = 'P1';
  clients.P1 = host;
  for (let i = 1; i < n; i++) {
    const c = new TestClient(url, names[i]);
    await c.connect();
    const j = await c.call<{ ok: boolean; roomCode: string; token: string; playerId: string; sync: { me: { role: Seat } } }>('room:join', { name: names[i], code: host.code });
    if (!j.ok) throw new Error(`加入失敗 ${names[i]}`);
    c.code = j.roomCode;
    c.token = j.token;
    c.playerId = j.playerId;
    c.role = j.sync.me.role;
    clients[c.role] = c;
  }
  for (let i = 0; i < n; i++) {
    const seat = SEATS[i];
    const f = flaws[i % Math.max(1, flaws.length)] ?? null;
    if (!f) continue;
    const r = await clients[seat].call<{ ok: boolean; error?: string }>('room:selectFlaw', { flaw: f });
    if (!r.ok) throw new Error(`選卡失敗 ${seat}：${r.error}`);
  }
  return {
    server,
    url,
    clients,
    host,
    code: host.code,
    close: async () => {
      for (const c of Object.values(clients)) c.close();
      await server.close();
    },
  };
}

export const lobbyOfThree = (overrides: Parameters<typeof createGameServer>[0] = {}, flaws: Array<FlawId | null> = DEFAULT_TEST_FLAWS): Promise<Table> => lobbyOf(3, flaws, overrides);

export async function startedTable(overrides: Parameters<typeof createGameServer>[0] = {}, flaws: Array<FlawId | null> = DEFAULT_TEST_FLAWS, n = 3): Promise<Table> {
  const t = await lobbyOf(n, flaws, overrides);
  const r = await t.host.call<{ ok: boolean; error?: string }>('room:start');
  if (!r.ok) throw new Error(`開始失敗：${r.error}`);
  for (const role of seatsOf(t)) {
    const c = t.clients[role];
    await c.waitFor('kitchen:state');
    await c.waitFor('player:correct');
    c.x = SPAWNS[role].pos[0];
    c.z = SPAWNS[role].pos[2];
  }
  return t;
}
