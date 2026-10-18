import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NIGHTS, NIGHT_COUNT, STORY_TABLE, nightDef, type FullSync, type KitchenEvent, type RoomPublic } from '@last-table/shared';
import { buildSchedule } from '../src/kitchen/orders';
import type { ThreatDirector } from '../src/kitchen/threats';
import { DEFAULT_MONSTER_TUNE } from '../src/kitchen/threats/monster';
import { startHost, type HostHandle } from '../src/host';
import { bench, cookEggToast } from './bench';
import { TestClient, lobbyOf, sleep } from './net';

/**
 * 連續七晚：每晚的變化（委託、後門的東西、那位客人）、故事碎片、第七晚那位客人點餐。
 */

const storyEvents = (events: Array<{ e: KitchenEvent }>) => events.filter((x) => x.e.kind === 'story').map((x) => x.e);

describe('七晚的資料', () => {
  it('七晚都有標題、開場、變化、碎片、結尾；委託都存在；越後面越難', () => {
    expect(NIGHTS.length).toBe(NIGHT_COUNT);
    for (const n of NIGHTS) {
      expect(n.title && n.intro && n.outro && n.fragment.title && n.fragment.text).toBeTruthy();
      expect(n.changes.length).toBeGreaterThan(0);
    }
    // 那位客人越來越靠近、越來越快；後門的東西越來越想進來
    for (let i = 1; i < NIGHTS.length; i++) {
      const a = NIGHTS[i - 1];
      const b = NIGHTS[i];
      expect(b.guest.startIdx).toBeGreaterThanOrEqual(a.guest.startIdx);
      expect(b.guest.stepMs).toBeLessThanOrEqual(a.guest.stepMs);
      expect(b.guest.appearMs).toBeLessThanOrEqual(a.guest.appearMs);
      expect(b.monster.hunger).toBeLessThanOrEqual(a.monster.hunger);
    }
    expect(NIGHTS[6].guest.startIdx).toBeGreaterThan(NIGHTS[0].guest.startIdx);
    // 每晚的兩張委託不重複
    const all = NIGHTS.flatMap((n) => n.commissions);
    expect(new Set(all).size).toBe(all.length);
  });

  it('每晚的單：指定的兩張進階委託；第七晚多一張那位客人（最後一桌）的單', () => {
    for (const n of NIGHTS) {
      const plan = buildSchedule(1 + n.night * 7919, 3, n);
      const free = plan.filter((p) => p.kind === 'free').map((p) => p.requestId);
      for (const c of n.commissions) expect(free).toContain(c);
      const story = plan.filter((p) => p.story);
      if (n.night === 7) {
        expect(story).toHaveLength(1);
        expect(story[0]).toMatchObject({ recipeId: 'egg_toast', table: STORY_TABLE });
      } else expect(story).toHaveLength(0);
    }
    // 單班不受影響
    expect(buildSchedule(1, 3).some((p) => p.story)).toBe(false);
  });
});

describe('廚房模擬：故事', () => {
  it('營業到一半，出單機印出這一晚的故事碎片（只印一次）；快照裡有這一晚', () => {
    const b = bench({ seats: ['P1'], night: 3, prepMs: 1000, serviceMs: 100_000 });
    b.open();
    b.run(40);
    expect(storyEvents(b.events)).toHaveLength(0);
    expect(b.sim.publicState().night).toEqual({ night: 3, fragment: false, story: null });
    b.run(10);
    const ev = storyEvents(b.events);
    expect(ev).toHaveLength(1);
    expect(ev[0].story).toMatchObject({ night: 3, title: nightDef(3)!.fragment.title });
    b.run(30);
    expect(storyEvents(b.events)).toHaveLength(1);
    expect(b.sim.publicState().night?.fragment).toBe(true);
  });

  it('第七晚：那位客人點了煎蛋吐司 → 送到後他離開、後門的東西也走了、12 秒後提早打烊', () => {
    const b = bench({ seats: ['P1'], night: 7, threats: true, prepMs: 1000, serviceMs: 420_000 });
    b.open();
    const th = b.sim.threats as unknown as ThreatDirector;
    th.guest.tune = { ...nightDef(7)!.guest };
    th.monster.enabled = false; // 測試做菜時不要被抓走
    for (let i = 0; i < 300 && !b.sim.orders.some((o) => o.plan.story); i++) b.run(1);
    const order = b.sim.orders.find((o) => o.plan.story)!;
    expect(order).toBeTruthy();
    expect(b.sim.publicState().orders.find((o) => o.id === order.id)?.story).toBe(true);
    expect(b.sim.publicState().night?.story).toBe('open');
    expect(storyEvents(b.events).at(-1)?.story?.title).toBe('最後一道');
    // 點完餐之後他安靜地坐著
    expect(th.guest.calmUntil).toBe(Number.POSITIVE_INFINITY);

    // 先把其他的單清掉，讓出餐的單一定是他的
    for (const o of b.sim.orders) if (o.status === 'open' && !o.plan.story) o.status = 'missed';
    cookEggToast(b, 'P1');
    th.monster.enabled = true;
    const r = b.act('P1', 'pass', 'serve', { orderId: order.id });
    expect(r.ok).toBe(true);
    const end = storyEvents(b.events).at(-1)!;
    expect(end.story).toMatchObject({ ending: 'served', text: nightDef(7)!.outro });
    expect(th.guest.active).toBe(false);
    expect(th.monster.present).toBe(false);
    expect(th.monster.enabled).toBe(false);
    expect(b.sim.publicState().night?.story).toBe('served');
    b.run(11);
    expect(b.sim.phase).toBe('SERVICE');
    b.run(2);
    expect(b.sim.phase).toBe('CLOSED');
  });

  it('第七晚：那位客人的單沒出成 → 另一個結尾（他還在等）', () => {
    const b = bench({ seats: ['P1'], night: 7, prepMs: 1000, serviceMs: 420_000 });
    b.open();
    for (let i = 0; i < 300 && !b.sim.orders.some((o) => o.plan.story); i++) b.run(1);
    const order = b.sim.orders.find((o) => o.plan.story)!;
    b.run((order.deadline - b.sim.t) / 1000 + 1);
    expect(order.status).toBe('missed');
    const end = storyEvents(b.events).at(-1)!;
    expect(end.story).toMatchObject({ ending: 'missed', text: nightDef(7)!.outroMissed });
    expect(b.sim.publicState().night?.story).toBe('missed');
  });
});

describe('房間：選第幾晚、接著下一晚、存檔', () => {
  const dirs: string[] = [];
  const hosts: HostHandle[] = [];
  const clients: TestClient[] = [];
  afterEach(async () => {
    while (clients.length) clients.pop()!.close();
    while (hosts.length) await hosts.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('房主在大廳選第 4 晚 → 威脅照這一晚的設定；打烊後接著第 5 晚', async () => {
    const t = await lobbyOf(2, ['D04', 'D03'], { threats: true });
    try {
      // 只有房主可以選
      const others = Object.values(t.clients).filter((c) => c !== t.host);
      expect((await others[0].call<{ ok: boolean }>('room:night', { night: 4 })).ok).toBe(false);
      expect((await t.host.call<{ ok: boolean }>('room:night', { night: 9 })).ok).toBe(false);
      expect((await t.host.call<{ ok: boolean }>('room:night', { night: 4 })).ok).toBe(true);
      const st = await t.host.waitFor<RoomPublic>('room:state', (r) => r.night === 4);
      expect(st.night).toBe(4);
      expect((await t.host.call<{ ok: boolean }>('room:start')).ok).toBe(true);
      const room = t.server.manager.rooms.get(t.code)!;
      const th = room.sim!.threats as unknown as ThreatDirector;
      expect(th.guest.tune).toEqual(nightDef(4)!.guest);
      expect(th.monster.tune).toEqual(nightDef(4)!.monster);
      expect(room.sim!.publicState().night?.night).toBe(4);
      // 還沒打烊不能接下一晚
      expect((await t.host.call<{ ok: boolean }>('room:night', { night: 5, start: true })).ok).toBe(false);
      room.sim!.closeShift();
      expect((await t.host.call<{ ok: boolean }>('room:night', { night: 5, start: true })).ok).toBe(true);
      expect(room.night).toBe(5);
      expect(room.sim!.phase).not.toBe('CLOSED');
      expect((room.sim!.threats as unknown as ThreatDirector).monster.tune).toEqual(nightDef(5)!.monster);
      // 單班：預設
      room.restart();
      expect((await t.host.call<{ ok: boolean }>('room:night', { night: 0 })).ok).toBe(true);
      await t.host.call('room:start');
      expect((room.sim!.threats as unknown as ThreatDirector).monster.tune).toEqual(DEFAULT_MONSTER_TUNE);
      expect(room.sim!.publicState().night).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it('房主模式：存檔裡記得第幾晚；讀檔後同一晚、同樣的設定，打烊後可以接下一晚', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'lt-night-'));
    dirs.push(d);
    const h1 = await startHost({ port: 0, lan: false, saveDir: d, clientDist: path.join(d, 'none'), gameVersion: 'test', prepSec: 30, serviceSec: 300 });
    hosts.push(h1);
    const a = new TestClient(h1.localUrl, 'Luz');
    clients.push(a);
    await a.connect();
    const created = await a.call<{ roomCode: string; token: string }>('room:create', { name: 'Luz' });
    await a.call('room:selectFlaw', { flaw: 'D03' });
    await a.call('room:night', { night: 6 });
    await a.call('room:start');
    await a.call('room:ready');
    await sleep(300);
    const saved = await a.call<{ ok: boolean; file: string }>('room:save');
    expect(saved.ok).toBe(true);
    expect(h1.saves()[0].night).toBe(6);
    await hosts.pop()!.close();
    a.close();

    const h2 = await startHost({ port: 0, lan: false, saveDir: d, clientDist: path.join(d, 'none'), gameVersion: 'test', prepSec: 30, serviceSec: 300 });
    hosts.push(h2);
    const loaded = h2.load(saved.file);
    const a2 = new TestClient(h2.localUrl, 'Luz2');
    clients.push(a2);
    await a2.connect();
    const r = await a2.call<{ ok: boolean; sync: FullSync }>('room:rejoin', { code: created.roomCode, token: loaded.token });
    expect(r.ok).toBe(true);
    expect(r.sync.room.night).toBe(6);
    expect(r.sync.kitchen?.night?.night).toBe(6);
    // 讀進來的 server 端 room
    const status = h2.status().rooms[0];
    expect(status.code).toBe(created.roomCode);
  });
});
