import { afterEach, describe, expect, it } from 'vitest';
import { type KitchenPublic, type Seat } from '@last-table/shared';
import { TestClient, placeAt, serverRoom, sleep, startedTable, type Table } from './net';
import { bench } from './bench';
import type { ThreatDirector } from '../src/kitchen/threats';

/**
 * 料理沙盒擴充第五階段：多人同步與恐怖事件。
 *   - 多人同時備料、烹調、調味、出餐：食材不重複扣除、不重複計分、狀態不分歧；
 *   - 重新連線後，攪拌好的拌料、泡水、受熱紀錄、委託都恢復；
 *   - 怪物抓人、客人擋路不會改變任何料理資料（同樣的操作，有沒有恐怖事件，料理結果完全一樣）。
 */

const tables: Table[] = [];
const extras: Array<{ close(): void }> = [];
afterEach(async () => {
  while (tables.length) await tables.pop()!.close();
  while (extras.length) extras.pop()!.close();
});
const track = async (t: Promise<Table>) => {
  const table = await t;
  tables.push(table);
  return table;
};
const kitchenOf = (t: Table): KitchenPublic => serverRoom(t).sim!.publicState();

describe('多人同時操作（Socket）', () => {
  it('兩個人同時搶架上最後一份食材：只有一個人拿到，庫存不會變成負的', async () => {
    const t = await track(startedTable());
    const room = serverRoom(t);
    room.advance(5100);
    const fridge = room.sim!.stations.get('fridge')!;
    fridge.stock.salmon = 1;
    placeAt(t, 'P1', 'fridge');
    placeAt(t, 'P2', 'fridge');
    const [a, b] = await Promise.all([t.clients.P1.action('fridge', 'take', { type: 'salmon' }), t.clients.P2.action('fridge', 'take', { type: 'salmon' })]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
    expect(fridge.stock.salmon).toBe(0);
    expect([...room.sim!.items.values()].filter((x) => x.type === 'salmon').length).toBe(1);
  });

  it('兩個人同時把東西放進攪拌碗、一個人攪拌：拌料只有一份，大家看到的狀態一樣', async () => {
    const t = await track(startedTable());
    const room = serverRoom(t);
    room.advance(5100);
    placeAt(t, 'P1', 'pantry');
    placeAt(t, 'P2', 'fridge');
    await Promise.all([t.clients.P1.action('pantry', 'take', { type: 'flour' }), t.clients.P2.action('fridge', 'take', { type: 'milk' })]);
    placeAt(t, 'P1', 'mixer');
    placeAt(t, 'P2', 'mixer');
    const [p1, p2] = await Promise.all([t.clients.P1.action('mixer', 'place'), t.clients.P2.action('mixer', 'place')]);
    expect(p1.ok && p2.ok).toBe(true);
    expect((await t.clients.P1.action('mixer', 'mix')).ok).toBe(true);
    // 攪拌中另一個人也按攪拌：他自己開始攪拌（不會變成兩份）
    room.advance(2600);
    await sleep(150);
    const k = kitchenOf(t);
    expect(k.stations.mixer.items.length).toBe(1);
    const m = k.items[k.stations.mixer.items[0]];
    expect(m.mix?.kind).toBe('batter');
    // 三個客戶端最後收到的廚房狀態裡，這份拌料一模一樣
    await sleep(200);
    const views = (['P1', 'P2', 'P3'] as Seat[]).map((s) => t.clients[s].kitchen!.items[m.id]);
    for (const v of views) expect(v?.mix).toEqual(m.mix);
  });

  it('同時出同一張單：只有一次出餐、一次計分（另一個人得到「單已經不在」）', async () => {
    const t = await track(startedTable({}, ['D04', 'D03', 'D04'], 2));
    const room = serverRoom(t);
    room.advance(5100);
    const sim = room.sim!;
    sim.skipPrep();
    room.advance(300);
    const order = sim.orders.find((o) => o.status === 'open');
    expect(order).toBeTruthy();
    // 兩個人手上各有一盤
    for (const s of ['P1', 'P2'] as Seat[]) {
      placeAt(t, s, 'plating');
      await t.clients[s].action('plating', 'new_plate', { vessel: 'plate', hold: true });
    }
    placeAt(t, 'P1', 'pass');
    placeAt(t, 'P2', 'pass');
    const [a, b] = await Promise.all([t.clients.P1.action('pass', 'serve', { orderId: order!.id }), t.clients.P2.action('pass', 'serve', { orderId: order!.id })]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
    expect(sim.stats.served).toBe(1);
  });

  it('重新連線：攪拌好的拌料、泡水的米粉、受熱紀錄、委託都從伺服器恢復', async () => {
    const t = await track(startedTable());
    const room = serverRoom(t);
    room.advance(5100);
    const c = t.clients.P2;
    placeAt(t, 'P2', 'pantry');
    await c.action('pantry', 'take', { type: 'rice_noodle' });
    placeAt(t, 'P2', 'sink');
    await c.action('sink', 'place');
    await c.action('sink', 'soak');
    room.advance(12_000);
    placeAt(t, 'P2', 'fridge');
    await c.action('fridge', 'take', { type: 'egg' });
    placeAt(t, 'P2', 'pan_a');
    await c.action('pan_a', 'heat', { level: 'MED' });
    await c.action('pan_a', 'place');
    room.advance(6000);
    const before = kitchenOf(t);
    c.close();
    await sleep(100);
    const c2 = new TestClient(t.url, 'Bao2');
    extras.push({ close: () => c2.close() });
    await c2.connect();
    const r = await c2.call<{ ok: boolean; sync: { kitchen: KitchenPublic } }>('room:rejoin', { code: t.code, token: c.token });
    expect(r.ok).toBe(true);
    const k = r.sync.kitchen;
    const noodle = Object.values(k.items).find((x) => x.type === 'rice_noodle')!;
    const egg = Object.values(k.items).find((x) => x.type === 'egg')!;
    expect(noodle.soaked).toBeGreaterThan(0.5);
    expect(k.stations.sink.soak).toBe(true);
    expect(egg.cookSec?.pan).toBeGreaterThan(3);
    expect(egg.lastMode).toBe('pan');
    expect(k.menu).toEqual(before.menu);
  });
});

describe('恐怖事件不會破壞料理資料', () => {
  /** 同樣的料理操作：一次有怪物把人抓走、客人亂走，一次完全沒有恐怖事件 */
  function cook(threats: boolean) {
    const b = bench({ seats: ['P1', 'P2'], threats });
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'salmon' });
    b.act('P1', 'pan_a', 'heat', { level: 'MED' });
    b.act('P1', 'pan_a', 'place');
    b.act('P2', 'pantry', 'take', { type: 'flour' });
    b.act('P2', 'mixer', 'place');
    b.act('P2', 'fridge', 'take', { type: 'milk' });
    b.act('P2', 'mixer', 'place');
    b.act('P2', 'mixer', 'mix');
    b.act('P1', 'oven', 'heat', { level: 'HIGH' });
    if (threats) {
      const d = b.sim.threats as ThreatDirector;
      d.monster.forceEmerge(b.sim);
      b.sim.trap('P1');
    }
    b.run(30);
    return [...b.sim.items.values()].map((x) => ({ type: x.type, doneness: x.doneness, brownA: x.brownA, brownB: x.brownB, temp: x.temp, mix: x.mix?.kind, cookSec: x.cookSec })).sort((a, z) => a.type.localeCompare(z.type));
  }

  it('有怪物抓人、沒有怪物：鍋裡的鮭魚、攪拌碗的麵糊、烤箱的溫度完全一樣', () => {
    expect(cook(true)).toEqual(cook(false));
  });
});
