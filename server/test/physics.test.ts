import { describe, expect, it } from 'vitest';
import { PHYSICS, avoidBodies, forwardOf, type Seat } from '@last-table/shared';
import { snapshot, restore } from '../src/save/snapshot';
import { SIM_SKIP } from '../src/rooms/room';
import { KitchenSim } from '../src/kitchen/sim';
import { bench } from './bench';

/** 簡單的物理：積水與滑倒、擦地、丟東西、人與人的碰撞與衝撞、湯滾出來 */

type B = ReturnType<typeof bench>;
const place = (b: B, r: Seat, x: number, z: number, yaw = 0) => Object.assign(b.poses[r], { x, z, yaw });
/** 讓 r 面向 (x, z) */
const faceTo = (b: B, r: Seat, x: number, z: number) => {
  const p = b.poses[r];
  p.yaw = Math.atan2(-(x - p.x), -(z - p.z));
};

describe('積水與滑倒', () => {
  it('跑步踩到積水會滑一段、手上的東西掉到地上、一段時間不能動；用走的不會滑', () => {
    const b = bench({ seats: ['P1', 'P2'] });
    b.open();
    expect(b.act('P1', 'pantry', 'take', { type: 'onion' }).ok).toBe(true);
    place(b, 'P1', 0, 14 - 1.5, 0);
    place(b, 'P2', 6, 12);
    b.sim.physics.spill(0, 11.6, 0.5, 'water');
    // 用走的：不會滑
    expect(b.sim.physics.onMove('P1', 0, 12.2, 0, 12.0, 2.3).slide).toBeUndefined();
    const r = b.sim.physics.onMove('P1', 0, 11.9, 0, 11.7, 4.4);
    expect(r.slide).toBeDefined();
    expect(r.slide!.z).toBeLessThan(11.7 - 1);
    expect(b.sim.physics.frozen('P1')).toBe(true);
    expect(b.sim.players.P1.held).toBeNull();
    expect(b.sim.publicState().coop.floor.length).toBe(1);
    expect(b.events.some((x) => x.to === 'P1' && x.e.visual === 'slip')).toBe(true);
    b.run(PHYSICS.slip.ms / 1000 + 0.2);
    expect(b.sim.physics.frozen('P1')).toBe(false);
    // 冷卻中不會馬上再滑
    expect(b.sim.physics.onMove('P1', 0, 11.9, 0, 11.7, 4.4).slide).toBeUndefined();
  });

  it('積水放久會乾；靠近按 X 可以擦乾', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    b.sim.physics.spill(0, 12, 0.5, 'water');
    place(b, 'P1', 0, 12.8);
    const r = b.coop('P1', 'mop');
    expect(r.ok).toBe(true);
    b.run(PHYSICS.puddle.mopMs / 1000 + 0.2);
    expect(b.sim.physics.puddles.length).toBe(0);
    expect(b.coop('P1', 'mop').ok).toBe(false);
    b.sim.physics.spill(2, 12, 0.5, 'water');
    b.run(PHYSICS.puddle.dryMs / 1000 + 1);
    expect(b.sim.physics.puddles.length).toBe(0);
  });

  it('湯開大火滾太久會溢出來：爐子前面多一灘', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    const s = b.sim.stations.get('stove_a')!;
    s.liquid = 2;
    s.vessel = 100;
    s.heat = 'HIGH';
    b.run(PHYSICS.boilOver.afterMs / 1000 + 0.5);
    expect(b.sim.physics.puddles.length).toBe(1);
    expect(b.events.some((x) => x.e.kind === 'boil_over')).toBe(true);
  });
});

describe('丟東西', () => {
  it('隊友面向你、手有空：接住', () => {
    const b = bench({ seats: ['P1', 'P2'] });
    b.open();
    b.act('P1', 'pantry', 'take', { type: 'onion' });
    place(b, 'P1', -2, 14.5);
    place(b, 'P2', 2, 14.5);
    faceTo(b, 'P2', -2, 14.5);
    const r = b.coop('P1', 'toss', { to: 'P2' });
    expect(r.ok).toBe(true);
    expect(b.sim.publicState().physics!.flights.length).toBe(1);
    b.run(1);
    expect(b.sim.players.P2.held?.kind).toBe('item');
    expect(b.sim.physics.flights.length).toBe(0);
  });

  it('背對著你：沒接到，掉在地上（生的變髒）；蛋會摔破、灑一灘', () => {
    const b = bench({ seats: ['P1', 'P2'] });
    b.open();
    b.act('P1', 'pantry', 'take', { type: 'onion' });
    place(b, 'P1', -2, 14.5);
    place(b, 'P2', 2, 14.5);
    faceTo(b, 'P2', 6, 14.5);
    b.coop('P1', 'toss', { to: 'P2' });
    b.run(1);
    expect(b.sim.players.P2.held).toBeNull();
    const floor = b.sim.publicState().coop.floor;
    expect(floor.length).toBe(1);
    expect(floor[0].type).toBe('onion');

    b.act('P1', 'fridge', 'take', { type: 'egg' });
    place(b, 'P1', -2, 14.5);
    const before = b.sim.items.size;
    b.coop('P1', 'toss', { to: 'P2' });
    b.run(1);
    expect(b.sim.items.size).toBe(before - 1);
    expect(b.sim.physics.puddles.length).toBe(1);
  });

  it('太遠、中間有牆、盤子都不能丟；沒有目標就丟到前面的地上', () => {
    const b = bench({ seats: ['P1', 'P2'] });
    b.open();
    b.act('P1', 'pantry', 'take', { type: 'onion' });
    place(b, 'P1', -2, 14.5);
    place(b, 'P2', 6, 2);
    expect(b.coop('P1', 'toss', { to: 'P2' }).ok).toBe(false);
    place(b, 'P1', 5, 12, Math.PI / 2);
    expect(b.coop('P1', 'toss').ok).toBe(true);
    b.run(1);
    const f = b.sim.publicState().coop.floor[0];
    const [fx, fz] = forwardOf(Math.PI / 2);
    expect(Math.hypot(f.x - (5 + fx * PHYSICS.toss.floorDistance), f.z - (12 + fz * PHYSICS.toss.floorDistance))).toBeLessThan(0.4);
  });
});

describe('人與人的碰撞', () => {
  it('不能擠進隊友的身體；可以從旁邊擦過、可以離開', () => {
    const r = avoidBodies(0, 0, 0.5, 0, [{ x: 0.6, z: 0, r: 0.27 }]);
    expect(r.blocked).toBe(true);
    expect(Math.hypot(r.x - 0.6, r.z)).toBeGreaterThanOrEqual(0.54 - 1e-6);
    // 已經重疊時往外走：放行
    expect(avoidBodies(0.5, 0, 0.3, 0, [{ x: 0.6, z: 0, r: 0.27 }]).blocked).toBe(false);
    const b = bench({ seats: ['P1', 'P2'] });
    b.open();
    place(b, 'P2', 0, 12);
    expect(b.sim.physics.onMove('P1', 0, 12.8, 0, 12.25, 2.0).block).toBe(true);
    expect(b.sim.physics.onMove('P1', 0, 12.8, 0.6, 12.8, 2.0).block).toBeUndefined();
  });

  it('跑步撞到人：對方被推開、手上的東西晃（停下來就穩住，不然會掉）', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D03', P2: 'D03' } });
    b.open();
    b.act('P2', 'pantry', 'take', { type: 'onion' });
    place(b, 'P2', 0, 12);
    b.sim.physics.onMove('P1', 0, 13, 0, 12.55, 4.4);
    expect(b.poses.P2.z).toBeLessThan(12 - 0.5);
    expect(b.sim.publicState().coop.wobbles.some((w) => w.seat === 'P2' && w.cause === 'bump')).toBe(true);
    // 不停下來（速度維持）：掉在地上
    b.poses.P2.speed = 3;
    b.run(2);
    expect(b.sim.players.P2.held).toBeNull();
  });
});

describe('存檔', () => {
  it('積水、飛在空中的東西都存得下來、讀得回來', () => {
    const b = bench({ seats: ['P1', 'P2'] });
    b.open();
    b.sim.physics.spill(1, 12, 0.5, 'soup');
    b.act('P1', 'pantry', 'take', { type: 'onion' });
    place(b, 'P1', -2, 14.5);
    place(b, 'P2', 2, 14.5);
    faceTo(b, 'P2', -2, 14.5);
    b.coop('P1', 'toss', { to: 'P2' });
    const snap = snapshot(b.sim, { skip: SIM_SKIP });
    const sim2 = new KitchenSim({ pose: (r) => b.poses[r] ?? null, teleport: () => undefined, event: () => undefined }, { ...b.sim.opts });
    restore(sim2, snap, { skip: SIM_SKIP });
    expect(sim2.physics.puddles).toEqual(b.sim.physics.puddles);
    expect(sim2.physics.flights.length).toBe(1);
    expect(sim2.physics.sim).toBe(sim2);
    for (let i = 0; i < 10; i++) sim2.tick();
    expect(sim2.players.P2.held?.kind).toBe('item');
  });
});

describe('物理（真的 Socket）', () => {
  it('跑過積水：伺服器把人放到滑到的位置、送出滑倒事件；之後一秒的移動不算數', async () => {
    const { startedTable, serverRoom, serverPose, place, sleep } = await import('./net');
    const t = await startedTable({}, ['D03', 'D04'], 2);
    try {
      const room = serverRoom(t);
      room.advance(5100);
      const c = t.clients.P1;
      place(t, 'P1', 5.5, 12.5, Math.PI / 2);
      room.sim!.physics.spill(4.2, 12.5, 0.45, 'water');
      // 往 -x 跑（約 4.3 m/s）
      let slipped = false;
      for (let i = 0; i < 14 && !slipped; i++) {
        c.x -= 0.15;
        c.fire('player:move', { x: c.x, y: 1.6, z: c.z, yaw: Math.PI / 2, seq: ++c.seq });
        await sleep(35);
        slipped = room.sim!.physics.frozen('P1');
      }
      expect(slipped).toBe(true);
      const e = await c.waitFor<{ visual?: string; at?: [number, number] }>('kitchen:event', (x) => (x as { visual?: string }).visual === 'slip');
      const pose = serverPose(t, 'P1');
      expect(pose.x).toBeLessThan(4.2 - 0.8);
      expect(Math.hypot(pose.x - e.at![0], pose.z - e.at![1])).toBeLessThan(0.05);
      // 滑倒中送來的移動：只取轉頭
      c.fire('player:move', { x: 9, y: 1.6, z: 12.5, yaw: 0, seq: ++c.seq });
      await sleep(60);
      expect(serverPose(t, 'P1').x).toBeLessThan(4);
    } finally {
      await t.close();
    }
  });
});
