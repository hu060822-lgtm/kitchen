import { afterEach, describe, expect, it } from 'vitest';
import { createGameServer, type GameServer } from '../src/app';
import { RelayDirectory } from '../src/relay';
import { startHost, type HostHandle } from '../src/host';
import { TestClient } from './net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * 房間代碼查詢處：房主的應用程式登記「代碼 → 通道網址」，朋友只要輸入代碼。
 */

const URL_A = 'https://brave-lemon-kitchen.trycloudflare.com';
const URL_B = 'https://other-host-here.trycloudflare.com';
const SECRET = 'a'.repeat(32);

describe('RelayDirectory', () => {
  it('登記、查詢、更新、刪除；過期就忘掉', () => {
    let t = 0;
    const d = new RelayDirectory(1000, () => t);
    expect(d.register('ABC234', URL_A, SECRET)).toEqual({ ok: true });
    expect(d.lookup('ABC234')).toBe(URL_A);
    // 同一位房主換了通道網址（重開通道）
    expect(d.register('ABC234', URL_B, SECRET)).toEqual({ ok: true });
    expect(d.lookup('ABC234')).toBe(URL_B);
    t = 999;
    expect(d.lookup('ABC234')).toBe(URL_B);
    t = 2100;
    expect(d.lookup('ABC234')).toBeNull();
    expect(d.register('ABC234', URL_A, SECRET)).toEqual({ ok: true });
    expect(d.remove('ABC234', SECRET)).toEqual({ ok: true });
    expect(d.lookup('ABC234')).toBeNull();
  });

  it('別人不能搶走還在用的代碼，也不能刪掉', () => {
    const d = new RelayDirectory();
    d.register('ABC234', URL_A, SECRET);
    expect(d.register('ABC234', URL_B, 'b'.repeat(32))).toMatchObject({ ok: false, status: 409 });
    expect(d.remove('ABC234', 'b'.repeat(32))).toMatchObject({ ok: false, status: 403 });
    expect(d.lookup('ABC234')).toBe(URL_A);
  });

  it('只接受 Cloudflare 快速通道的 https 網址與正確的代碼格式', () => {
    const d = new RelayDirectory();
    for (const bad of ['http://brave.trycloudflare.com', 'https://evil.com', 'https://a.trycloudflare.com.evil.com', 'https://trycloudflare.com', 'https://a.trycloudflare.com/path', 'javascript:alert(1)', 42]) {
      expect(d.register('ABC234', bad, SECRET)).toMatchObject({ ok: false, status: 400 });
    }
    for (const code of ['abc234', 'ABC23', 'ABCDEFG', 'ABC10O', '../../']) expect(d.register(code, URL_A, SECRET)).toMatchObject({ ok: false, status: 400 });
    expect(d.register('ABC234', URL_A, 'short')).toMatchObject({ ok: false, status: 400 });
  });
});

describe('查詢處的 HTTP 介面（線上伺服器）', () => {
  const servers: GameServer[] = [];
  const hosts: HostHandle[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop()!;
      await s.close();
      await new Promise<void>((r) => s.http.close(() => r()));
    }
    while (hosts.length) await hosts.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  async function online(): Promise<{ s: GameServer; url: string }> {
    const s = createGameServer({ corsOrigins: true, debugTools: false, clientDist: null, hostMode: false });
    servers.push(s);
    const port = await s.listen(0);
    return { s, url: `http://127.0.0.1:${port}` };
  }

  const post = (base: string, body: unknown) => fetch(`${base}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('房主登記後，朋友用代碼查到房主的網址；線上伺服器自己的房間回答 here；查不到是 404', async () => {
    const { url } = await online();
    const r = await post(url, { code: 'QWE234', url: URL_A, secret: SECRET });
    expect(r.status).toBe(200);
    expect(await (await fetch(`${url}/api/locate/QWE234`)).json()).toEqual({ where: 'host', url: URL_A });
    expect(await (await fetch(`${url}/api/locate/qwe234`)).json()).toEqual({ where: 'host', url: URL_A });
    expect((await fetch(`${url}/api/locate/ZZZ999`)).status).toBe(404);
    expect((await fetch(`${url}/api/locate/bad!`)).status).toBe(400);

    // 線上伺服器自己的房間
    const c = new TestClient(url, 'Luz');
    await c.connect();
    const created = await c.call<{ roomCode: string }>('room:create', { name: 'Luz' });
    expect(await (await fetch(`${url}/api/locate/${created.roomCode}`)).json()).toEqual({ where: 'here' });
    c.close();

    // 刪除要密語
    const del = (secret: string) => fetch(`${url}/api/relay/QWE234`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret }) });
    expect((await del('x'.repeat(32))).status).toBe(403);
    expect((await del(SECRET)).status).toBe(200);
    expect((await fetch(`${url}/api/locate/QWE234`)).status).toBe(404);
  });

  it('壞的請求：網址不是通道、別人的代碼、太頻繁', async () => {
    const { url } = await online();
    expect((await post(url, { code: 'QWE234', url: 'https://evil.example', secret: SECRET })).status).toBe(400);
    expect((await post(url, { code: 'QWE234', url: URL_A, secret: SECRET })).status).toBe(200);
    expect((await post(url, { code: 'QWE234', url: URL_B, secret: 'z'.repeat(32) })).status).toBe(409);
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await post(url, { code: 'QWE234', url: URL_A, secret: SECRET })).status);
    expect(statuses).toContain(429);
  });

  it('找不到房間時，加入失敗會帶 reason: not_found（用戶端據此去查詢處）', async () => {
    const { url } = await online();
    const c = new TestClient(url, 'Bao');
    await c.connect();
    const r = await c.call<{ ok: boolean; reason?: string }>('room:join', { name: 'Bao', code: 'NOPE22' });
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    c.close();
  });

  it('房主模式的伺服器不開查詢處', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'lt-relay-'));
    dirs.push(d);
    const h = await startHost({ port: 0, lan: false, saveDir: d, clientDist: path.join(d, 'none'), gameVersion: 'test' });
    hosts.push(h);
    const r = await post(h.localUrl, { code: 'QWE234', url: URL_A, secret: SECRET });
    expect(r.status).toBe(404);
  });
});
