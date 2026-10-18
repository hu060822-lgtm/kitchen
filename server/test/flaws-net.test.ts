import { afterEach, describe, expect, it } from 'vitest';
import { type FlawId, type KitchenEvent, type KitchenPublic, type Seat } from '@last-table/shared';
import { TestClient, nextReq, place, placeAt, seatsOf, serverPose, serverRoom, sleep, startedTable, type Table } from './net';

/**
 * 缺陷卡的網路層：每位玩家收到的快照不同、私人資訊不外洩、重新連線完整恢復、
 * 1–8 人都能開始並操作、移動驗證套用速度倍率。
 */

const tables: Table[] = [];
const extras: Array<{ close(): void }> = [];
afterEach(async () => {
  while (tables.length) await tables.pop()!.close();
  while (extras.length) extras.pop()!.close();
});
const track = async (t: Promise<Table>) => {
  const x = await t;
  tables.push(x);
  return x;
};
const latest = (c: TestClient): KitchenPublic => c.of<KitchenPublic>('kitchen:state').at(-1)!;

async function rejoin(t: Table, seat: Seat): Promise<{ client: TestClient; sync: { kitchen: KitchenPublic; me: { role: Seat } } }> {
  const old = t.clients[seat];
  old.close();
  await sleep(80);
  const c = new TestClient(t.url, `${old.label}-2`);
  extras.push(c);
  await c.connect();
  const r = await c.call<{ ok: boolean; sync: { kitchen: KitchenPublic; me: { role: Seat } } }>('room:rejoin', { code: t.code, token: old.token });
  expect(r.ok).toBe(true);
  return { client: c, sync: r.sync };
}

describe('人數適配：1、2、4、6、8 人都能開始，每個席位都能操作', () => {
  for (const n of [1, 2, 4, 6, 8]) {
    it(`${n} 人`, async () => {
      const flaws: FlawId[] = ['D04', 'D01', 'D02', 'D03', 'D15'];
      const t = await track(startedTable({}, flaws, n));
      const room = serverRoom(t);
      expect(room.sim!.seats).toHaveLength(n);
      room.advance(5100);
      for (const s of seatsOf(t)) {
        const k = await t.clients[s].waitFor<KitchenPublic>('kitchen:state', (x) => x.phase === 'SERVICE');
        expect(Object.keys(k.players).sort()).toEqual(seatsOf(t).sort());
        expect(k.self?.flaw).toBe(flaws[seatsOf(t).indexOf(s) % flaws.length]);
        placeAt(t, s, 'fridge');
        const r = await t.clients[s].action('fridge', 'take', { type: 'egg' });
        expect(r.ok, `${s}：${r.message}`).toBe(true);
      }
      expect(room.sim!.orders.length).toBeGreaterThan(0);
    });
  }
});

describe('個人資訊只給本人', () => {
  it('幻聽外場的私人傳聞不會出現在其他人的任何封包裡；貼上訂單板之後才公開', async () => {
    const t = await track(startedTable({}, ['D01', 'D04', 'D02']));
    const room = serverRoom(t);
    room.advance(200);
    const a = t.clients.P1;
    const rumorEv = await a.waitFor<KitchenEvent>('kitchen:event', (e) => e.kind === 'flaw' && e.visual === 'rumor');
    const k = await a.waitFor<KitchenPublic>('kitchen:state', (x) => (x.self?.rumors?.length ?? 0) > 0);
    const rumor = k.self!.rumors![0];
    expect(rumorEv.text).toContain(rumor.text);
    room.advance(200);
    await sleep(150);
    for (const s of ['P2', 'P3'] as Seat[]) {
      const leak = t.clients[s].events.some((e) => JSON.stringify(e.payload ?? null).includes(rumor.text));
      expect(leak, `${s} 不該看到私人傳聞`).toBe(false);
    }
    expect((await a.action('coop', 'rumor_post', { rumorId: rumor.id })).ok).toBe(true);
    const seen = await t.clients.P2.waitFor<KitchenPublic>('kitchen:state', (x) => x.coop.rumors.some((r) => r.id === rumor.id));
    expect(seen.coop.rumors[0].text).toBe(rumor.text);
    expect(JSON.stringify(seen)).not.toContain('pitch'); // 提示音的音高（真假的線索）只給本人
  });

  it('健忘助手收到的快照裡，想不起來的單沒有菜名；其他人收到完整的單', async () => {
    const t = await track(startedTable({}, ['D15', 'D04', 'D04']));
    const room = serverRoom(t);
    room.advance(5100);
    room.advance(80_000);
    await sleep(250);
    const mine = latest(t.clients.P1).orders.filter((o) => o.status === 'open');
    const theirs = latest(t.clients.P2).orders.filter((o) => o.status === 'open');
    expect(mine.length).toBe(theirs.length);
    expect(mine.some((o) => o.forgotten && !o.recipeId && !o.requestId)).toBe(true);
    expect(theirs.every((o) => !o.forgotten && (o.recipeId || o.requestId))).toBe(true);
  });
});

describe('重新連線：缺陷狀態、計時器、手上的東西與互助標記完整恢復', () => {
  it('傳聞、冷卻、記憶、便條、標記、待接的交接都還在；冷卻不會被重連重置', async () => {
    const t = await track(startedTable({}, ['D01', 'D15', 'D02']));
    const room = serverRoom(t);
    room.advance(200);
    const { P1: a, P2: b, P3: c } = t.clients;
    const k1 = await a.waitFor<KitchenPublic>('kitchen:state', (x) => (x.self?.rumors?.length ?? 0) > 0);
    const rumors = k1.self!.rumors!;
    room.advance(5000);
    room.advance(2000);
    // P3 拍 P2（冷卻）、P2 拿蛋遞給 P3、P1 在備料台貼便條、P1 標記一台爐子
    placeAt(t, 'P2', 'fridge');
    await b.action('fridge', 'take', { type: 'egg' });
    const p2 = serverPose(t, 'P2');
    place(t, 'P3', p2.x + 1, p2.z);
    expect((await c.action('coop', 'tap', { to: 'P2' })).ok).toBe(true);
    expect((await b.action('coop', 'handoff', { to: 'P3' })).ok).toBe(true);
    placeAt(t, 'P1', 'prep_a');
    expect((await a.action('coop', 'note', { stationId: 'prep_a', label: 'todo' })).ok).toBe(true);
    expect((await a.call<{ ok: boolean }>('signal:mark', { targetId: 'pan_a', token: 'GEST_TAKE' })).ok).toBe(true);
    const before = room.kitchenFor([...room.players.values()].find((p) => p.role === 'P2')!);
    const coolTap = room.sim!.flaws.privateFor('P3')!.cooldowns.tap;

    // P2（健忘助手）重連：記憶、手上的蛋、待接的交接都在
    const r2 = await rejoin(t, 'P2');
    expect(r2.sync.me.role).toBe('P2');
    expect(r2.sync.kitchen.self!.flaw).toBe('D15');
    expect(r2.sync.kitchen.self!.memory).toEqual(before.self!.memory);
    expect(r2.sync.kitchen.players.P2!.held?.kind).toBe('item');
    expect(r2.sync.kitchen.coop.handoffs).toHaveLength(1);
    expect(r2.sync.kitchen.coop.notes).toHaveLength(1);
    expect(r2.sync.kitchen.coop.marks.some((m) => m.targetId === 'pan_a' && m.from === 'P1')).toBe(true);
    // P1（幻聽外場）重連：私人傳聞還在（同樣的 id 與到期時間）
    const r1 = await rejoin(t, 'P1');
    for (const r of rumors) expect(r1.sync.kitchen.self!.rumors!.find((x) => x.id === r.id)?.expiresAt).toBe(r.expiresAt);
    // P3 重連：拍肩的冷卻沒有被重置，也不能藉重連再拍一次
    const r3 = await rejoin(t, 'P3');
    expect(r3.sync.kitchen.self!.cooldowns.tap).toBe(coolTap);
    const again = await r3.client.call<{ ok: boolean; message: string }>('kitchen:action', { stationId: 'coop', action: 'tap', args: { to: 'P2' }, requestId: nextReq() });
    expect(again.ok).toBe(false);
    // 交接仍可完成（同一份伺服器狀態）
    const offer = r3.sync.kitchen.coop.handoffs[0];
    const acc = await r3.client.call<{ ok: boolean }>('kitchen:action', { stationId: 'coop', action: 'handoff_accept', args: { offerId: offer.id }, requestId: nextReq() });
    expect(acc.ok).toBe(true);
    expect(room.sim!.players.P3.held?.kind).toBe('item');
  });
});

describe('沉默侍者的移動速度由伺服器驗證', () => {
  it('在餐廳裡一次走 3 公尺：沉默侍者被接受，其他卡被拉回', async () => {
    const t = await track(startedTable({ moveSpeedMultiplier: 1 }, ['D04', 'D02', 'D03']));
    for (const [seat, ok] of [['P1', true], ['P2', false]] as Array<[Seat, boolean]>) {
      place(t, seat, -6, 4.2, Math.PI / 2);
      await sleep(400); // 移動預算補滿
      const c = t.clients[seat];
      c.fire('player:move', { x: -3, y: 1.6, z: 4.2, yaw: Math.PI / 2, seq: 100 + (ok ? 1 : 2) * 1000 });
      await sleep(120);
      expect(serverPose(t, seat).x, seat).toBeCloseTo(ok ? -3 : -6);
    }
  });
});

/** 一小步一小步走過去（每步 0.3 m），回傳伺服器最後接受的位置 */
async function walkLine(t: Table, seat: Seat, from: [number, number], to: [number, number]): Promise<{ x: number; z: number }> {
  place(t, seat, from[0], from[1], 0);
  const c = t.clients[seat];
  const n = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.3);
  for (let i = 1; i <= n; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / n;
    const z = from[1] + ((to[1] - from[1]) * i) / n;
    c.fire('player:move', { x, y: 1.6, z, yaw: 0, seq: ++c.seq + 5000 });
    await sleep(70);
  }
  await sleep(60);
  const p = serverPose(t, seat);
  return { x: p.x, z: p.z };
}

describe('Phase C：通行條件由伺服器的移動驗證判定', () => {
  it('幽閉外場走不進冷藏室（會收到說明），一般人走得進去；巨人過不了低門楣；小矮人鑽得過窄縫', async () => {
    const t = await track(startedTable({}, ['D12', 'D04', 'D07', 'D08'], 4));
    // 冷藏室門：x −7.75，z 19
    const d12 = await walkLine(t, 'P1', [-7.75, 18.0], [-7.75, 20.2]);
    expect(d12.z).toBeLessThan(19.3);
    expect(t.clients.P1.of<KitchenEvent>('kitchen:event').some((e) => e.visual === 'zone_block')).toBe(true);
    const d04 = await walkLine(t, 'P2', [-7.75, 18.0], [-7.75, 20.2]);
    expect(d04.z).toBeCloseTo(20.2);
    // 乾貨室前門（低門楣）：x 4.7
    const giant = await walkLine(t, 'P3', [4.7, 18.0], [4.7, 20.3]);
    expect(giant.z).toBeLessThan(19);
    const small = await walkLine(t, 'P4', [4.7, 18.0], [4.7, 20.3]);
    expect(small.z).toBeCloseTo(20.3);
    // 冷藏室 ↔ 乾貨室的窄縫：只有小矮人
    const crawl = await walkLine(t, 'P4', [-3.7, 21.35], [-2.0, 21.35]);
    expect(crawl.x).toBeCloseTo(-2.0);
    const notCrawl = await walkLine(t, 'P2', [-3.7, 21.35], [-2.0, 21.35]);
    expect(notCrawl.x).toBeLessThan(-3);
  });

  it('被關進冷藏室的鐵籠後，幽閉外場一定走得出來', async () => {
    const t = await track(startedTable({}, ['D12', 'D04']));
    const out = await walkLine(t, 'P1', [-7.2, 21.5], [-7.75, 17.5]);
    expect(out.z).toBeCloseTo(17.5);
  });
});

describe('Phase B／D：身體狀態由伺服器的移動驗證判定', () => {
  it('嗜睡學徒睡著時不能移動；奶油手拿著東西奔跑會失衡（伺服器從實際移動判斷）', async () => {
    const t = await track(startedTable({ moveSpeedMultiplier: 3 }, ['D14', 'D06']));
    const room = serverRoom(t);
    const sim = room.sim!;
    (sim.flaws as unknown as { seats: Map<Seat, { drowsy: number }> }).seats.get('P1')!.drowsy = 100;
    room.advance(200);
    expect(sim.flaws.asleep('P1')).toBe(true);
    const asleep = await walkLine(t, 'P1', [0, 12], [0, 13.5]);
    expect(asleep.z).toBeCloseTo(12);
    // 奶油手：拿著蛋快跑
    placeAt(t, 'P2', 'fridge');
    const r = await t.clients.P2.call<{ ok: boolean }>('kitchen:action', { stationId: 'fridge', action: 'take', args: { type: 'egg' }, requestId: nextReq() });
    expect(r.ok).toBe(true);
    place(t, 'P2', -1, 12, 0);
    const c = t.clients.P2;
    for (let i = 1; i <= 6; i++) {
      c.fire('player:move', { x: -1 + i * 0.4, y: 1.6, z: 12, yaw: 0, seq: ++c.seq + 9000 });
      await sleep(70);
    }
    expect(sim.flaws.privateFor('P2')!.wobble?.cause).toBe('run');
  });
});
