import { SPAWNS, STATION_BY_ID, stationFront, type KitchenActionResult, type KitchenEvent, type Seat } from '@last-table/shared';
import { KitchenSim, type PoseView, type SimOptions } from '../src/kitchen/sim';
import { createThreats } from '../src/kitchen/threats';

/**
 * 廚房模擬的測試台：沒有網路，玩家位置由測試直接設定，時鐘由測試手動推進。
 */
export interface Bench {
  sim: KitchenSim;
  poses: Record<Seat, PoseView>;
  events: Array<{ e: KitchenEvent; to: Seat | 'all' }>;
  /** 站到工作站前 */
  at(role: Seat, stationId: string): void;
  act(role: Seat, stationId: string, action: string, args?: Record<string, unknown>, requestId?: string): KitchenActionResult;
  /** 互助操作（stationId＝'coop'，不移動玩家） */
  coop(role: Seat, action: string, args?: Record<string, unknown>, requestId?: string): KitchenActionResult;
  /** 推進 sec 秒 */
  run(sec: number): void;
  /** 跳過備料階段 */
  open(): void;
}

let rq = 0;

export function bench(opts: Partial<SimOptions> & { threats?: boolean } = {}): Bench {
  const poses = {} as Record<Seat, PoseView>;
  const seats: Seat[] = opts.seats ?? ['P1', 'P2', 'P3'];
  for (const r of seats) poses[r] = { x: SPAWNS[r].pos[0], z: SPAWNS[r].pos[2], yaw: SPAWNS[r].yaw, crouch: false, connected: true, speed: 0 };
  const events: Bench['events'] = [];
  const sim = new KitchenSim(
    {
      pose: (r) => poses[r] ?? null,
      teleport: (r, x, z, yaw) => Object.assign(poses[r], { x, z, yaw }),
      event: (e, to) => void events.push({ e, to }),
    },
    { prepMs: 10_000, serviceMs: 600_000, seed: 1, ...opts },
  );
  if (opts.threats) sim.threats = createThreats();
  const b: Bench = {
    sim,
    poses,
    events,
    at(role, stationId) {
      const s = STATION_BY_ID[stationId];
      const [x, z] = stationFront(s, 0.75);
      Object.assign(poses[role], { x, z, yaw: s.facing + Math.PI });
    },
    act(role, stationId, action, args = {}, requestId = `r${++rq}`) {
      b.at(role, stationId);
      return sim.handle(role, { stationId, action, args, requestId });
    },
    coop(role, action, args = {}, requestId = `c${++rq}`) {
      return sim.handle(role, { stationId: 'coop', action, args, requestId });
    },
    run(sec) {
      for (let i = 0; i < Math.round(sec * 10); i++) sim.tick();
    },
    open() {
      sim.skipPrep();
    },
  };
  return b;
}

/** 穩定的節奏（每刀 220 ms） */
export const steady = (n: number, gap = 220): number[] => Array.from({ length: n }, (_, i) => i * gap);
/** 忽快忽慢的節奏 */
export const sloppy = (n: number): number[] => {
  const out = [0];
  for (let i = 1; i < n; i++) out.push(out[i - 1] + (i % 2 ? 90 : 420));
  return out;
};

/** 下刀：先選切法，等待實際花掉的時間，再送出節奏 */
export function chop(b: Bench, role: Seat, station: string, cut: string, presses: number[]): KitchenActionResult {
  const r = b.act(role, station, 'chop_start', { cut });
  if (!r.ok) return r;
  b.run(Math.ceil(presses[presses.length - 1] / 100) / 10);
  return b.act(role, station, 'chop', { presses });
}

function must(r: KitchenActionResult, what: string): KitchenActionResult {
  if (!r.ok) throw new Error(`${what}：${r.message}`);
  return r;
}

/**
 * 煎蛋吐司（照食譜）。回傳裝好盤、拿在手上的玩家。可調整每一步，用來測試失誤。
 */
export function cookEggToast(
  b: Bench,
  role: Seat,
  o: { toastLevel?: number; eggSec?: number; heat?: 'LOW' | 'MED' | 'HIGH'; salt?: number; leaveFire?: boolean } = {},
): void {
  const { toastLevel = 3, eggSec = 23, heat = 'MED', salt = 0.5 } = o;
  // 怕火廚師單人：先戴隔熱手套（自救方式，之後 30 秒可以操作火源，最多中火）
  if (b.sim.flaws.has(role, 'D10')) {
    must(b.act(role, 'toaster', 'glove'), '戴手套');
    b.run(3.1);
  }
  must(b.act(role, 'pantry', 'take', { type: 'bread' }), '拿吐司');
  must(b.act(role, 'toaster', 'place'), '放吐司');
  must(b.act(role, 'toaster', 'start', { level: toastLevel }), '烤吐司');
  must(b.act(role, 'fridge', 'take', { type: 'egg' }), '拿蛋');
  must(b.act(role, 'pan_a', 'heat', { level: heat }), '開火');
  must(b.act(role, 'pan_a', 'place'), '下蛋');
  b.run(eggSec);
  if (!o.leaveFire) must(b.act(role, 'pan_a', 'heat', { level: 'OFF' }), '關火');
  must(b.act(role, 'plating', 'new_plate', { vessel: 'plate' }), '拿盤子');
  const plateId = b.sim.publicState().stations.plating.plates.at(-1)!;
  must(b.act(role, 'pan_a', 'pick'), '起鍋');
  must(b.act(role, 'plating', 'add', { plateId }), '蛋裝盤');
  for (let i = 0; i < 100 && b.sim.publicState().stations.toaster.toast; i++) b.run(0.5);
  must(b.act(role, 'toaster', 'pick'), '拿吐司');
  must(b.act(role, 'plating', 'add', { plateId }), '吐司裝盤');
  must(b.act(role, 'fridge', 'take', { type: 'butter' }), '拿奶油');
  must(b.act(role, 'plating', 'add', { plateId }), '奶油裝盤');
  if (salt > 0) {
    must(b.act(role, 'spice', 'measure', { seasoning: 'salt', units: salt }), '量鹽');
    must(b.act(role, 'plating', 'pour', { plateId }), '加鹽');
  }
  must(b.act(role, 'spice', 'measure', { seasoning: 'pepper', units: 0.5 }), '量胡椒');
  must(b.act(role, 'plating', 'pour', { plateId }), '加胡椒');
  must(b.act(role, 'plating', 'pick', { plateId }), '端盤');
}

export function serveFirst(b: Bench, role: Seat, recipeId?: string): KitchenActionResult {
  const order = b.sim.publicState().orders.find((x) => x.status === 'open' && (!recipeId || x.recipeId === recipeId));
  if (!order) throw new Error('沒有可以出的單');
  return b.act(role, 'pass', 'serve', { orderId: order.id });
}
