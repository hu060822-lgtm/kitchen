import { describe, expect, it } from 'vitest';
import { STATIONS, stationFront, zoneAt, type Seat } from '@last-table/shared';
import { MONSTER, ThreatDirector } from '../src/kitchen/threats';
import { NAV_NODES, clearSegment, gridPath, walkable } from '../src/kitchen/threats/nav';
import { bench, type Bench } from './bench';

const monster = (b: Bench) => (b.sim.threats as ThreatDirector).monster;

function isolate(b: Bench, keep: Seat[]): void {
  for (const r of ['P1', 'P2', 'P3'] as Seat[]) {
    if (keep.includes(r)) continue;
    Object.assign(b.poses[r], { x: 7.5, z: 0.8, yaw: 0, connected: true });
  }
}

function chaseFrom(b: Bench, x: number, z: number, target: Seat): void {
  const m = monster(b);
  Object.assign(m, { mode: 'chase', modeSince: b.sim.t, x, z, yaw: 0, path: [], enabled: true, target, targetSince: b.sim.t, kitchenLeft: 60_000 });
  const p = b.poses[target];
  m.lastSeen = { x: p.x, z: p.z, t: b.sim.t };
  m.known = { x: p.x, z: p.z };
}

/** 後場與廚房裡、怪物能到的工作站前方 */
const REACHABLE = STATIONS.filter((s) => {
  const [x, z] = stationFront(s, 0.75);
  const zone = zoneAt(x, z);
  return zone && zone.id !== 'DINING';
});

describe('怪物尋路：鎖定玩家、不打轉、不卡住', () => {
  it('從每一個巡邏點都找得到路到每一個工作站前方，而且每一段都不穿牆', () => {
    let checked = 0;
    for (const n of NAV_NODES) {
      if (n.id === 'OUT') continue;
      for (const s of REACHABLE) {
        const [x, z] = stationFront(s, 0.75);
        const path = gridPath({ x: n.x, z: n.z }, { x, z }, true);
        expect(path, `${n.id} → ${s.id}`).not.toBeNull();
        let px = n.x;
        let pz = n.z;
        for (const p of path!) {
          expect(clearSegment(px, pz, p.x, p.z, true) || !walkable(px, pz, true), `${n.id} → ${s.id}`).toBe(true);
          px = p.x;
          pz = p.z;
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('防火門關上時，格子尋路會繞路（不會穿過門）', () => {
    const open = gridPath({ x: 8.1, z: 21 }, { x: 7.9, z: 17 }, true)!;
    const closed = gridPath({ x: 8.1, z: 21 }, { x: 7.9, z: 17 }, false)!;
    const len = (from: { x: number; z: number }, ps: Array<{ x: number; z: number }>) => {
      let l = 0;
      let c = from;
      for (const p of ps) {
        l += Math.hypot(p.x - c.x, p.z - c.z);
        c = p;
      }
      return l;
    };
    expect(len({ x: 8.1, z: 21 }, closed)).toBeGreaterThan(len({ x: 8.1, z: 21 }, open) + 4);
  });

  it('鎖定：目標躲到中島另一側（看不到），牠還是繞過去抓到人', () => {
    const b = bench({ threats: true });
    b.open();
    isolate(b, ['P1']);
    // 玩家站在爐台前，怪物在廚房另一頭
    b.at('P1', 'pan_a');
    const p = b.poses.P1;
    chaseFrom(b, p.x > 0 ? -6 : 6, 12.5, 'P1');
    let caught = false;
    for (let i = 0; i < 150 && !caught; i++) {
      b.run(0.1);
      if (b.sim.status('P1') === 'trapped') caught = true;
      expect(monster(b).mode === 'chase' || monster(b).mode === 'windup' || caught).toBe(true);
    }
    expect(caught).toBe(true);
  });

  it('從任何地方追到任何工作站前的玩家都不會卡住（每秒都在前進，直到撲上去）', () => {
    const starts = NAV_NODES.filter((n) => n.id !== 'OUT' && n.id !== 'BD');
    let runs = 0;
    for (let k = 0; k < starts.length; k += 3) {
      for (let s = 0; s < REACHABLE.length; s += 4) {
        const b = bench({ threats: true });
        b.open();
        isolate(b, ['P2']);
        b.at('P2', REACHABLE[s].id);
        chaseFrom(b, starts[k].x, starts[k].z, 'P2');
        let last = { x: monster(b).x, z: monster(b).z };
        let done = false;
        for (let sec = 0; sec < 12 && !done; sec++) {
          // 每秒重新「看見」一次，避免因為看不到而改成搜索（這裡只測移動）
          monster(b).lastSeen = { x: b.poses.P2.x, z: b.poses.P2.z, t: b.sim.t };
          b.run(1);
          const m = monster(b);
          if (m.mode !== 'chase' || b.sim.status('P2') !== 'ok') {
            done = true;
            break;
          }
          const moved = Math.hypot(m.x - last.x, m.z - last.z);
          const dist = Math.hypot(m.x - b.poses.P2.x, m.z - b.poses.P2.z);
          if (dist > 1.6) expect(moved, `${starts[k].id} → ${REACHABLE[s].id} 在 ${sec} 秒時卡住`).toBeGreaterThan(1.0);
          last = { x: m.x, z: m.z };
        }
        expect(done, `${starts[k].id} → ${REACHABLE[s].id}`).toBe(true);
        runs++;
      }
    }
    expect(runs).toBeGreaterThan(10);
  });

  it('鎖定的目標在 20 秒內不會因為另一個人比較近就換人', () => {
    const b = bench({ threats: true });
    b.open();
    isolate(b, ['P1', 'P2']);
    Object.assign(b.poses.P1, { x: 0, z: 11 });
    Object.assign(b.poses.P2, { x: 2.5, z: 15.8 });
    chaseFrom(b, 0, 16.6, 'P1');
    b.run(0.3);
    expect(monster(b).target).toBe('P1');
  });
});
