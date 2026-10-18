import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAW_CONFIG, type RoomPublic } from '@last-table/shared';
import { MONSTER, ThreatDirector } from '../src/kitchen/threats';
import { QUICK_CHOP_QUALITY } from '../src/kitchen/sim';
import { bench, type Bench } from './bench';
import { lobbyOf } from './net';

/** 第二輪試玩回饋：一鍵切、拍肩提神、怪物的反制（丟東西、緊急照明）、沒有怪物的模式 */

const director = (b: Bench) => b.sim.threats as ThreatDirector;

function monsterIn(b: Bench, x: number, z: number): void {
  const m = director(b).monster;
  Object.assign(m, { enabled: true, mode: 'patrol', x, z, yaw: 0, path: [], modeSince: b.sim.t, kitchenLeft: MONSTER.stayMs });
}

describe('一鍵切', () => {
  it('看著備料台按右鍵：用這份食材常用的切法自動切完（一致性 80%）', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    b.act('P1', 'pantry', 'take', { type: 'potato' });
    b.act('P1', 'prep_a', 'place');
    b.act('P1', 'prep_a', 'peel');
    b.run(3);
    const r = b.act('P1', 'prep_a', 'quick', { mode: 'use' });
    expect(r.ok).toBe(true);
    b.run(5);
    const it = b.sim.items.get(b.sim.stations.get('prep_a')!.items[0])!;
    expect(it.cut).not.toBe('WHOLE');
    expect(it.cutQuality).toBe(QUICK_CHOP_QUALITY);
    // 已經切過：不能再切
    expect(b.act('P1', 'prep_a', 'quick_chop').ok).toBe(false);
  });

  it('要削皮的沒削：提示先削皮', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    b.act('P1', 'pantry', 'take', { type: 'potato' });
    b.act('P1', 'prep_a', 'place');
    expect(b.act('P1', 'prep_a', 'quick_chop').message).toContain('削皮');
  });
});

describe('拍肩提神（嗜睡學徒）', () => {
  it('還沒睡著也能拍：每次睡意 −25', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D14', P2: 'D03' } });
    b.open();
    const st = (b.sim.flaws as unknown as { seats: Map<string, { drowsy: number }> }).seats.get('P1')!;
    st.drowsy = 70;
    Object.assign(b.poses.P2, { x: b.poses.P1.x + 1, z: b.poses.P1.z });
    expect(b.coop('P2', 'tap', { to: 'P1' }).ok).toBe(true);
    expect(st.drowsy).toBe(70 - DEFAULT_FLAW_CONFIG.D14.tapRelief);
  });
});

describe('怪物的反制', () => {
  it('監視器的緊急照明：牠在裡面時把牠逼回後門，90 秒充電；牠不在時不會浪費', () => {
    const b = bench({ threats: true });
    b.open();
    expect(b.act('P2', 'cctv', 'flash').ok).toBe(true);
    expect(b.sim.flashReadyAt).toBe(0);
    monsterIn(b, 2, 16);
    const r = b.act('P2', 'cctv', 'flash');
    expect(r.ok).toBe(true);
    expect(director(b).monster.mode).toBe('leave');
    expect(b.act('P2', 'cctv', 'flash').message).toContain('充電');
  });

  it('把食材丟到牠身上：愣住 3 秒（撲抓也中斷）', () => {
    const b = bench({ threats: true, seats: ['P1'] });
    b.open();
    b.act('P1', 'pantry', 'take', { type: 'onion' });
    Object.assign(b.poses.P1, { x: 5, z: 12, yaw: Math.PI / 2 });
    monsterIn(b, 2, 12);
    const m = director(b).monster;
    m.tune.speed = 0;
    expect(b.coop('P1', 'toss', { to: 'monster' }).ok).toBe(true);
    b.run(1);
    expect(m.stunUntil).toBeGreaterThan(b.sim.t);
    expect(b.sim.publicState().threats.monster?.stunLeft).toBeGreaterThan(0);
  });

  it('怪物變弱了：比較晚才想進來、追得比較慢、停留比較短', () => {
    expect(MONSTER.hungerEnter).toBeGreaterThanOrEqual(100);
    expect(MONSTER.speed.chase).toBeLessThan(3.5);
    expect(MONSTER.stayMs).toBeLessThanOrEqual(40_000);
    expect(MONSTER.hungerCap).toBeGreaterThan(MONSTER.hungerEnter);
  });
});

describe('沒有怪物的模式', () => {
  it('房主在大廳勾「沒有怪物」→ 開班後後門的東西不會出現，那位客人照常', async () => {
    const t = await lobbyOf(2, ['D04', 'D03'], { threats: true });
    try {
      const others = Object.values(t.clients).filter((c) => c !== t.host);
      expect((await others[0].call<{ ok: boolean }>('room:options', { noMonster: true })).ok).toBe(false);
      expect((await t.host.call<{ ok: boolean }>('room:options', { noMonster: true })).ok).toBe(true);
      await t.host.waitFor<RoomPublic>('room:state', (r) => !!r.noMonster);
      await t.host.call('room:start');
      const room = t.server.manager.rooms.get(t.code)!;
      const th = room.sim!.threats as unknown as ThreatDirector;
      expect(th.monster.enabled).toBe(false);
      th.monster.hunger = 1e6;
      room.advance(30_000);
      expect(th.monster.present).toBe(false);
      expect(th.guest.enabled).toBe(true);
    } finally {
      await t.close();
    }
  });
});
