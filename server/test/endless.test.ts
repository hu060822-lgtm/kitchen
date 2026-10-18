import { describe, expect, it } from 'vitest';
import { ENDLESS_CHALLENGES, endlessBase, endlessChallengeCount, endlessDay, type RoomPublic } from '@last-table/shared';
import type { ThreatDirector } from '../src/kitchen/threats';
import { bench } from './bench';
import { lobbyOf } from './net';

/** 無盡模式：每天隨機的考驗，天數越多越難；跑單超過上限就結束 */

describe('無盡模式的每一天', () => {
  it('同一個種子、同一天抽到一樣的考驗；考驗數量隨天數增加；不會抽到還沒開放的考驗', () => {
    expect(endlessDay(3, 42)).toEqual(endlessDay(3, 42));
    for (let d = 1; d <= 20; d++) {
      const day = endlessDay(d, 7);
      expect(day.challenges.length).toBe(Math.min(endlessChallengeCount(d), ENDLESS_CHALLENGES.filter((c) => c.from <= d).length));
      expect(new Set(day.challenges).size).toBe(day.challenges.length);
      for (const id of day.challenges) expect(ENDLESS_CHALLENGES.find((c) => c.id === id)!.from).toBeLessThanOrEqual(d);
    }
    // 不同的種子：至少有某幾天抽到不同的考驗
    const diff = Array.from({ length: 10 }, (_, i) => i + 1).some((d) => endlessDay(d, 1).challenges.join() !== endlessDay(d, 2).challenges.join());
    expect(diff).toBe(true);
  });

  it('基本難度越後面越難；怪物追人的速度永遠比人跑步慢', () => {
    const d1 = endlessBase(1);
    const d9 = endlessBase(9);
    expect(d9.monster.hunger).toBeLessThan(d1.monster.hunger);
    expect(d9.monster.noise).toBeGreaterThan(d1.monster.noise);
    expect(d9.patience).toBeLessThan(d1.patience);
    expect(d9.extra).toBeGreaterThan(d1.extra);
    expect(d9.guest.stepMs).toBeLessThan(d1.guest.stepMs);
    for (let d = 1; d <= 40; d++) for (let s = 1; s < 30; s++) expect(3.8 * endlessDay(d, s).monster.speed).toBeLessThan(4.4);
  });

  it('考驗真的生效：缺貨、碗盤不夠、後門鎖壞了、跑單超過上限提早打烊', () => {
    const normal = bench({ seats: ['P1'] });
    const hard = bench({ seats: ['P1'], stockMul: 0.5, dishMul: 0.5, backLockBroken: true, missLimit: 0 });
    const stock = (b: ReturnType<typeof bench>) => b.sim.publicState().stations.fridge.stock!.egg!;
    expect(stock(hard)).toBeLessThan(stock(normal));
    expect(hard.sim.publicState().stations.plating.dishes!.plate).toBeLessThan(normal.sim.publicState().stations.plating.dishes!.plate);
    hard.open();
    const r = hard.act('P1', 'cctv', 'back_door');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('壞了');
    // 讓單一直跑掉
    hard.run(590);
    expect(hard.sim.phase).toBe('CLOSED');
    expect(hard.sim.stats.missed).toBeGreaterThanOrEqual(1);
    expect(hard.events.some((x) => x.e.text?.includes('撐不下去'))).toBe(true);
  });
});

describe('無盡模式（房間）', () => {
  it('房主選無盡模式 → 今天的威脅照設定；撐過 → 下一天；沒撐過只能從第 1 天重新開始', async () => {
    const t = await lobbyOf(2, ['D04', 'D03'], { threats: true });
    try {
      expect((await t.host.call<{ ok: boolean }>('room:night', { night: 0, endless: true })).ok).toBe(true);
      const st = await t.host.waitFor<RoomPublic>('room:state', (r) => !!r.endless);
      expect(st.endless!.day).toBe(1);
      expect((await t.host.call<{ ok: boolean }>('room:start')).ok).toBe(true);
      const room = t.server.manager.rooms.get(t.code)!;
      const today = endlessDay(1, st.endless!.seed, 2);
      const th = room.sim!.threats as unknown as ThreatDirector;
      expect(th.monster.tune).toEqual(today.monster);
      expect(th.guest.tune).toEqual(today.guest);
      expect(room.sim!.opts.missLimit).toBe(today.missLimit);
      // 撐過：下一天
      room.sim!.closeShift();
      expect((await t.host.call<{ ok: boolean }>('room:night', { night: 0, endless: true, start: true, next: true })).ok).toBe(true);
      expect(room.endless).toBe(2);
      expect((room.sim!.threats as unknown as ThreatDirector).monster.tune).toEqual(endlessDay(2, st.endless!.seed, 2).monster);
      // 沒撐過：不能下一天，只能重來
      room.sim!.stats.missed = 99;
      room.sim!.closeShift();
      expect((await t.host.call<{ ok: boolean }>('room:night', { night: 0, endless: true, start: true, next: true })).ok).toBe(false);
      expect((await t.host.call<{ ok: boolean }>('room:night', { night: 0, endless: true, start: true })).ok).toBe(true);
      expect(room.endless).toBe(1);
      // 回到大廳選某一晚：離開無盡模式
      room.restart();
      expect((await t.host.call<{ ok: boolean }>('room:night', { night: 2 })).ok).toBe(true);
      expect(room.endless).toBe(0);
    } finally {
      await t.close();
    }
  });
});
