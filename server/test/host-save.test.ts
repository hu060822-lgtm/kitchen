import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FullSync, KitchenPublic, RoomPublic } from '@last-table/shared';
import { startHost, type HostHandle } from '../src/host';
import { SaveStore, validateSave } from '../src/save/store';
import { TestClient, sleep } from './net';

/**
 * 房主模式（Windows 應用程式自己開房）：存檔、讀檔、暫停、用暱稱回到原本的位置。
 * 全部透過真的 Socket 連線測試。
 */

const dirs: string[] = [];
const hosts: HostHandle[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  while (clients.length) clients.pop()!.close();
  while (hosts.length) await hosts.pop()!.close().catch(() => undefined);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'lt-save-'));
  dirs.push(d);
  return d;
}

async function host(saveDir: string, autosaveMs?: number): Promise<HostHandle> {
  const h = await startHost({ port: 0, lan: false, saveDir, clientDist: path.join(saveDir, 'no-client'), gameVersion: 'test', autosaveMs, prepSec: 30, serviceSec: 300 });
  hosts.push(h);
  return h;
}

async function client(h: HostHandle, label: string): Promise<TestClient> {
  const c = new TestClient(h.localUrl, label);
  clients.push(c);
  await c.connect();
  return c;
}

type Joined = { ok: boolean; roomCode: string; token: string; playerId: string; sync: FullSync; error?: string };

/** 兩個人開一班，按準備好，等時鐘開始 */
async function startShift(h: HostHandle): Promise<{ a: TestClient; b: TestClient; code: string }> {
  const a = await client(h, 'Luz');
  const b = await client(h, 'Bao');
  const created = await a.call<Joined>('room:create', { name: 'Luz' });
  a.token = created.token;
  const joined = await b.call<Joined>('room:join', { name: 'Bao', code: created.roomCode });
  b.token = joined.token;
  await a.call('room:selectFlaw', { flaw: 'D03' });
  await b.call('room:selectFlaw', { flaw: 'D04' });
  expect((await a.call<{ ok: boolean }>('room:start')).ok).toBe(true);
  await a.call('room:ready');
  await b.call('room:ready');
  await a.waitFor<RoomPublic>('room:state', (r) => !r.waiting && r.phase === 'PLAYING');
  return { a, b, code: created.roomCode };
}

const lastKitchen = (c: TestClient) => c.of<KitchenPublic>('kitchen:state').at(-1)!;

describe('房主模式：存檔與讀檔', () => {
  it('房主按存檔 → 關掉程式 → 重新開房讀檔：同樣的房間代碼，大家用原本的憑證回到原本的位置，班次暫停等大家準備好', async () => {
    const dir = tempDir();
    const h1 = await host(dir);
    const { a, b, code } = await startShift(h1);
    await sleep(400);
    // 房主以外的人不能存檔、不能暫停
    expect((await b.call<{ ok: boolean }>('room:save')).ok).toBe(false);
    expect((await b.call<{ ok: boolean }>('room:pause')).ok).toBe(false);
    const saved = await a.call<{ ok: boolean; file: string; savedAt: number }>('room:save');
    expect(saved.ok).toBe(true);
    const before = lastKitchen(a);
    const list = h1.saves();
    expect(list[0].file).toBe(saved.file);
    expect(list[0]).toMatchObject({ code, kind: 'manual', players: [expect.objectContaining({ name: 'Luz', host: true }), expect.objectContaining({ name: 'Bao' })] });

    // 關掉程式（會再存一份「關閉時存檔」）
    const exitFiles = await hosts.pop()!.close();
    expect(exitFiles.length).toBe(1);
    a.close();
    b.close();

    const h2 = await host(dir);
    const loaded = h2.load(saved.file);
    expect(loaded.code).toBe(code);
    // 房主的視窗直接用回傳的憑證回去；Bao 用原本的憑證
    const a2 = await client(h2, 'Luz2');
    const r1 = await a2.call<Joined>('room:rejoin', { code, token: loaded.token });
    expect(r1.ok).toBe(true);
    expect(r1.sync.me.isHost).toBe(true);
    expect(r1.sync.hostMode).toBe(true);
    expect(r1.sync.room.restored).toBe(true);
    expect(r1.sync.room.waiting?.why).toBe('restored');
    const b2 = await client(h2, 'Bao2');
    const r2 = await b2.call<Joined>('room:rejoin', { code, token: b.token });
    expect(r2.ok).toBe(true);
    // 讀回來的廚房：時間、食材庫存、訂單和存檔時一樣（時鐘暫停，不會往前跑）
    const k = r1.sync.kitchen!;
    expect(k.t).toBeGreaterThanOrEqual(before.t);
    expect(k.t - before.t).toBeLessThan(1500);
    expect(k.stations.fridge.stock).toEqual(before.stations.fridge.stock);
    await sleep(500);
    expect(h2.status().rooms[0].shiftSec).toBe(Math.round(k.t / 1000));
    // 兩個人都按準備好 → 繼續
    await a2.call('room:ready');
    await b2.call('room:ready');
    await a2.waitFor<RoomPublic>('room:state', (r) => !r.waiting);
    await sleep(500);
    expect(h2.status().rooms[0].shiftSec).toBeGreaterThanOrEqual(Math.round(k.t / 1000));
  });

  it('換了網址（憑證不見）也能回來：用同樣的暱稱加入；暱稱不對時說明還沒回來的人是誰', async () => {
    const dir = tempDir();
    const h1 = await host(dir);
    const { a } = await startShift(h1);
    const saved = await a.call<{ file: string }>('room:save');
    await hosts.pop()!.close();
    const h2 = await host(dir);
    const { code } = h2.load(saved.file);
    const x = await client(h2, 'stranger');
    const bad = await x.call<Joined>('room:join', { name: 'Nobody', code });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('Luz');
    expect(bad.error).toContain('Bao');
    const y = await client(h2, 'bao-again');
    const ok = await y.call<Joined>('room:join', { name: 'Bao', code });
    expect(ok.ok).toBe(true);
    expect(ok.sync.me.role).toBe('P2');
    // 已經回來的人，同樣的暱稱不能再搶一次
    const z = await client(h2, 'bao-twice');
    expect((await z.call<Joined>('room:join', { name: 'Bao', code })).ok).toBe(false);
  });

  it('暫停：只有房主可以；暫停後時鐘不走，大家按準備好才繼續', async () => {
    const dir = tempDir();
    const h = await host(dir);
    const { a, b } = await startShift(h);
    expect((await a.call<{ ok: boolean }>('room:pause')).ok).toBe(true);
    const st = await a.waitFor<RoomPublic>('room:state', (r) => r.waiting?.why === 'paused');
    expect(st.waiting!.need.length).toBe(2);
    const t0 = h.status().rooms[0].shiftSec;
    await sleep(1300);
    expect(h.status().rooms[0].shiftSec).toBe(t0);
    // 暫停中不能操作工作站
    const act = await a.call<{ ok: boolean }>('kitchen:action', { stationId: 'fridge', action: 'take', args: { type: 'egg' }, requestId: 'x1' });
    expect(act.ok).toBe(false);
    await a.call('room:ready');
    await b.call('room:ready');
    await a.waitFor<RoomPublic>('room:state', (r) => !r.waiting);
    await sleep(1200);
    expect(h.status().rooms[0].shiftSec).toBeGreaterThan(t0);
  });

  it('自動存檔：班次有前進才存，輪替三格；房間的「上次存檔」時間會告訴大家', async () => {
    const dir = tempDir();
    const h = await host(dir, 150);
    const { a } = await startShift(h);
    await sleep(1400);
    const autos = readdirSync(dir).filter((f) => f.startsWith('auto-') && f.endsWith('.json'));
    expect(autos.length).toBe(3);
    const st = a.of<RoomPublic>('room:state').at(-1)!;
    expect(st.savedAt).toBeGreaterThan(0);
    // 暫停時班次沒有前進：不再寫新的自動存檔
    await a.call('room:pause');
    await sleep(400);
    const stamp = () => Math.max(...h.saves().filter((s) => s.kind === 'auto').map((s) => s.savedAt));
    const s0 = stamp();
    await sleep(600);
    expect(stamp()).toBe(s0);
  });

  it('壞掉的存檔：校驗碼不符就拒絕；自動存檔壞掉時改讀上一份備份；檔名不能指到資料夾外', async () => {
    const dir = tempDir();
    const h = await host(dir, 120);
    await startShift(h);
    await sleep(900);
    const store = new SaveStore(dir, 'test');
    const auto = store.list().find((s) => s.kind === 'auto')!.file;
    const good = readFileSync(path.join(dir, auto), 'utf8');
    // 截斷：讀 .bak
    writeFileSync(path.join(dir, auto), good.slice(0, good.length / 2));
    expect(() => store.read(auto)).not.toThrow();
    // 改動內容：校驗碼不符
    const bad = JSON.parse(good);
    bad.state.room.players[0].name = 'Hacker';
    expect(() => validateSave(bad)).toThrow(/校驗碼/);
    expect(() => store.read('../etc/passwd.json')).toThrow(/檔名/);
    // 比遊戲新的存檔版本：拒絕並說明
    const future = JSON.parse(good);
    future.meta.version = 99;
    expect(() => validateSave(future)).toThrow();
  });

  it('匯出、匯入存檔（換電腦帶著走）', async () => {
    const dir = tempDir();
    const h = await host(dir);
    const { a } = await startShift(h);
    const saved = await a.call<{ file: string }>('room:save');
    const out = path.join(tempDir(), 'my-save.json');
    h.exportTo(saved.file, out);
    const dir2 = tempDir();
    const h2 = await host(dir2);
    const file = h2.importFrom(out);
    expect(h2.saves().map((s) => s.file)).toContain(file);
    expect(() => h2.importFrom(path.join(dir2, 'missing.json'))).toThrow();
  });
});

describe('線上模式不受影響', () => {
  it('不是房主模式：不能存檔、不能暫停，遊戲開始後也不能用暱稱加入', async () => {
    const { startedTable } = await import('./net');
    const t = await startedTable();
    try {
      const r = await t.host.call<{ ok: boolean }>('room:save');
      expect(r.ok).toBe(false);
      expect((await t.host.call<{ ok: boolean }>('room:pause')).ok).toBe(false);
      const c = new TestClient(t.url, 'late');
      await c.connect();
      const j = await c.call<{ ok: boolean }>('room:join', { name: 'Aki', code: t.code });
      expect(j.ok).toBe(false);
      c.close();
    } finally {
      await t.close();
    }
  });
});
