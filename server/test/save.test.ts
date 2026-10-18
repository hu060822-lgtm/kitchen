import { describe, expect, it } from 'vitest';
import { SEATS, type Seat } from '@last-table/shared';
import { KitchenSim } from '../src/kitchen/sim';
import { createThreats } from '../src/kitchen/threats';
import { rng } from '../src/kitchen/orders';
import { SIM_SKIP } from '../src/rooms/room';
import { restore, revive, snapshot } from '../src/save/snapshot';
import { bench, type Bench } from './bench';

/**
 * 房主模式的存檔：快照與還原。
 * 最重要的性質：存檔、讀檔之後接著玩，和沒有存讀檔一路玩下去，結果一模一樣
 * （包括亂數、怪物、客人、缺陷卡的計時器、訂單排程、鍋裡的每一份食材）。
 */

describe('快照工具', () => {
  it('Map、Set、Infinity、NaN、亂數狀態都能保存與還原', () => {
    const r = rng(42);
    r();
    r();
    const src = { m: new Map([['a', { x: 1 }]]), s: new Set([1, 2]), inf: Infinity, ninf: -Infinity, nan: NaN, r, nested: { list: [1, { y: 2 }] } };
    const json = JSON.parse(JSON.stringify(snapshot(src)));
    const target = { m: new Map<string, { x: number }>([['b', { x: 9 }]]), s: new Set<number>(), inf: 0, ninf: 0, nan: 0, r: rng(1), nested: { list: [] as unknown[] } };
    restore(target, json);
    expect([...target.m.keys()]).toEqual(['a']);
    expect(target.m.get('a')).toEqual({ x: 1 });
    expect([...target.s]).toEqual([1, 2]);
    expect(target.inf).toBe(Infinity);
    expect(target.ninf).toBe(-Infinity);
    expect(Number.isNaN(target.nan)).toBe(true);
    // 亂數接著產生同樣的序列
    expect([target.r(), target.r()]).toEqual([r(), r()]);
    expect(target.nested).toEqual({ list: [1, { y: 2 }] });
  });

  it('循環參照會被拒絕（不會產生壞掉的存檔）', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => snapshot(a)).toThrow(/循環/);
  });

  it('類別實例疊回時保留方法；skip 的欄位不保存也不覆蓋', () => {
    class Box {
      v = 1;
      back = 'keep';
      twice(): number {
        return this.v * 2;
      }
    }
    const j = snapshot({ b: Object.assign(new Box(), { v: 5, back: 'saved' }) }, { skip: new Set(['back']) });
    const t = { b: new Box() };
    restore(t, j, { skip: new Set(['back']) });
    expect(t.b.twice()).toBe(10);
    expect(t.b.back).toBe('keep');
    expect(revive(j)).toEqual({ b: { v: 5 } });
  });
});

/** 一班進行中：好幾個人、怪物、客人、缺陷卡、鍋裡有東西、攪拌碗、烤箱、訂單 */
function busyShift(): Bench {
  const b = bench({ seats: ['P1', 'P2', 'P3'], threats: true, flaws: { P1: 'D09', P2: 'D14', P3: 'D01' }, seed: 7 });
  b.open();
  b.act('P1', 'fridge', 'take', { type: 'salmon' });
  b.act('P1', 'pan_a', 'heat', { level: 'MED' });
  b.act('P1', 'pan_a', 'place');
  b.act('P2', 'pantry', 'take', { type: 'flour' });
  b.act('P2', 'mixer', 'place');
  b.act('P2', 'fridge', 'take', { type: 'milk' });
  b.act('P2', 'mixer', 'place');
  b.act('P2', 'mixer', 'mix');
  b.act('P3', 'oven', 'heat', { level: 'HIGH' });
  b.act('P3', 'pantry', 'take', { type: 'rice_noodle' });
  b.act('P3', 'sink', 'place');
  b.act('P3', 'sink', 'soak');
  b.run(95);
  return b;
}

/** 讀檔：玩家位置（房間存檔的一部分）複製一份，用同樣的設定建立新的模擬 */
function fresh(src: Bench): KitchenSim {
  const poses = JSON.parse(JSON.stringify(src.poses)) as Bench['poses'];
  const sim = new KitchenSim({ pose: (r) => poses[r] ?? null, teleport: (r, x, z, yaw) => void Object.assign(poses[r], { x, z, yaw }), event: () => undefined }, src.sim.opts);
  if (src.sim.threats) sim.threats = createThreats();
  return sim;
}

const view = (sim: KitchenSim) => ({
  pub: sim.publicState(),
  priv: Object.fromEntries(SEATS.filter((s) => sim.seats.includes(s)).map((s: Seat) => [s, sim.flaws.privateFor(s)])),
  threats: sim.threats?.debug(),
});

describe('存檔、讀檔之後接著玩，和一路玩下去完全一樣', () => {
  it('營業中途存檔：再跑 120 秒、做同樣的操作，兩邊的廚房、缺陷卡、怪物、客人狀態一模一樣', () => {
    const a = busyShift();
    const saved = JSON.parse(JSON.stringify(snapshot(a.sim, { skip: SIM_SKIP })));
    const simB = fresh(a);
    restore(simB, saved, { skip: SIM_SKIP });
    // 讀回來的狀態本身就一樣
    expect(view(simB)).toEqual(view(a.sim));
    // 接著做同樣的事
    const more = (sim: KitchenSim) => {
      const act = (role: Seat, stationId: string, action: string, args: Record<string, unknown> = {}) => sim.handle(role, { stationId, action, args, requestId: `${role}-${action}-${sim.t}` });
      for (let i = 0; i < 1200; i++) {
        sim.tick();
        if (i === 50) act('P1', 'pan_a', 'flip');
        if (i === 300) act('P2', 'mixer', 'pick');
      }
    };
    more(a.sim);
    more(simB);
    expect(view(simB)).toEqual(view(a.sim));
  });

  it('重送存檔前送過的同一個 requestId：讀檔後仍然只執行一次（去重快取也在存檔裡）', () => {
    const a = busyShift();
    const r1 = a.sim.handle('P1', { stationId: 'fridge', action: 'take', args: { type: 'egg' }, requestId: 'dup-1' });
    const simB = fresh(a);
    restore(simB, JSON.parse(JSON.stringify(snapshot(a.sim, { skip: SIM_SKIP }))), { skip: SIM_SKIP });
    const stock = simB.stations.get('fridge')!.stock.egg;
    const r2 = simB.handle('P1', { stationId: 'fridge', action: 'take', args: { type: 'egg' }, requestId: 'dup-1' });
    expect(r2).toEqual(r1);
    expect(simB.stations.get('fridge')!.stock.egg).toBe(stock);
  });

  it('存檔是純資料：可以轉成 JSON 再讀回，大小合理', () => {
    const a = busyShift();
    const text = JSON.stringify(snapshot(a.sim, { skip: SIM_SKIP }));
    expect(text.length).toBeLessThan(2_000_000);
    expect(text).not.toContain('function');
  });
});
