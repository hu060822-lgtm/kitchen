import { afterEach, describe, expect, it } from 'vitest';
import type { KitchenActionResult, RoomPublic } from '@last-table/shared';
import { nextReq, serverRoom, sleep, startedTable, type Table } from './net';

/** 讀完操作說明才開始計時：全員按「準備好」（或房主決定不等），班次時鐘才開始走 */

const tables: Table[] = [];
afterEach(async () => {
  while (tables.length) await tables.pop()!.close();
});

describe('開班前等大家讀完操作說明', () => {
  it('時鐘不走、不能操作工作站；全員準備好才開始', async () => {
    const t = await startedTable({ readyGate: true, manualClock: false }, ['D04', 'D03'], 2);
    tables.push(t);
    const room = serverRoom(t);
    expect(room.clockStarted).toBe(false);
    const t0 = room.sim!.t;
    await sleep(350);
    expect(room.sim!.t).toBe(t0);
    const [a, b] = Object.values(t.clients);
    const r = await a.call<KitchenActionResult>('kitchen:action', { stationId: 'fridge', action: 'take', args: { type: 'egg' }, requestId: nextReq() });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('操作說明');
    // 一個人準備好：還在等
    expect((await a.call<{ ok: boolean }>('room:ready')).ok).toBe(true);
    await sleep(80);
    expect(room.clockStarted).toBe(false);
    expect(a.of<RoomPublic>('room:state').at(-1)!.waiting?.ready.length).toBe(1);
    // 不是房主不能決定不等
    const notHost = t.host === a ? b : a;
    expect((await notHost.call<{ ok: boolean }>('room:forceStart')).ok).toBe(false);
    // 第二個人準備好：開始
    expect((await b.call<{ ok: boolean }>('room:ready')).ok).toBe(true);
    await sleep(350);
    expect(room.clockStarted).toBe(true);
    expect(room.sim!.t).toBeGreaterThan(t0);
    expect(a.of<RoomPublic>('room:state').at(-1)!.waiting).toBeNull();
  });

  it('房主可以決定不等；斷線的人不擋', async () => {
    const t = await startedTable({ readyGate: true, manualClock: false }, ['D04', 'D03', 'D02'], 3);
    tables.push(t);
    const room = serverRoom(t);
    expect((await t.host.call<{ ok: boolean }>('room:forceStart')).ok).toBe(true);
    expect(room.clockStarted).toBe(true);

    const t2 = await startedTable({ readyGate: true, manualClock: false }, ['D04', 'D03'], 2);
    tables.push(t2);
    const room2 = serverRoom(t2);
    const others = Object.values(t2.clients).filter((c) => c !== t2.host);
    expect((await t2.host.call<{ ok: boolean }>('room:ready')).ok).toBe(true);
    expect(room2.clockStarted).toBe(false);
    others[0].close();
    await sleep(200);
    expect(room2.clockStarted).toBe(true);
  });
});
