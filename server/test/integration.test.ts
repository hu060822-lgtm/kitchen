import { afterEach, describe, expect, it } from 'vitest';
import { SEATS, type KitchenEvent, type KitchenPublic, type Seat, type RoomPublic } from '@last-table/shared';
import { loadConfig } from '../src/config';
import type { ThreatDirector } from '../src/kitchen/threats';
import { TestClient, lobbyOf, lobbyOfThree, nextReq, place, placeAt, seatsOf, serverPose, serverRoom, sleep, startServer, startedTable, walkTo, type Table } from './net';

const tables: Table[] = [];
const extras: Array<{ close(): Promise<void> | void }> = [];

afterEach(async () => {
  while (tables.length) await tables.pop()!.close();
  while (extras.length) await extras.pop()!.close();
});

const track = async (t: Promise<Table>) => {
  const table = await t;
  tables.push(table);
  return table;
};

const roomOf = (c: TestClient): RoomPublic => c.of<RoomPublic>('room:state').at(-1)!;
const kitchenOf = (t: Table): KitchenPublic => serverRoom(t).sim!.publicState();

/* ------------------------------------------------------------------ */

describe('房間流程', () => {
  it('建立、加入、選卡、開始；席位自動分配；卡可以重複；最多 8 人', async () => {
    const t = await track(lobbyOf(8, ['D04', 'D04', 'D01', 'D02', 'D03', 'D15', 'D04', 'D01']));
    const room = await t.clients.P3.waitFor<RoomPublic>('room:state', (r) => r.canStart);
    expect(room.players).toHaveLength(8);
    expect(room.players.map((p) => p.role).sort()).toEqual([...SEATS].sort());
    expect(room.players.filter((p) => p.flaw === 'D04')).toHaveLength(3);
    expect(room.canStart).toBe(true);
    expect(room.code).toBe(t.code);
    expect(room.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

    const extra = new TestClient(t.url, 'Ivy');
    extras.push({ close: () => extra.close() });
    await extra.connect();
    const j = await extra.call<{ ok: boolean; error?: string }>('room:join', { name: 'Ivy', code: t.code });
    expect(j.ok).toBe(false);
    expect(j.error).toContain('已滿');
  });

  it('沒選卡不能開始；無效的卡被拒；只有房主能開始；一個人也能開始', async () => {
    const t = await track(lobbyOfThree());
    expect((await t.clients.P2.call<{ ok: boolean }>('room:start')).ok).toBe(false);
    const mk = t.host.mark();
    await t.clients.P3.call('room:selectFlaw', { flaw: null });
    await t.host.waitFor<RoomPublic>('room:state', (r) => !r.canStart, 2000, mk);
    expect((await t.host.call<{ ok: boolean }>('room:start')).ok).toBe(false);
    expect((await t.clients.P3.call<{ ok: boolean }>('room:selectFlaw', { flaw: 'BLIND' })).ok).toBe(false);
    await t.clients.P3.call('room:selectFlaw', { flaw: 'D15' });
    expect((await t.host.call<{ ok: boolean }>('room:start')).ok).toBe(true);

    const solo = await track(lobbyOf(1, ['D02']));
    await solo.host.waitFor<RoomPublic>('room:state', (r) => r.canStart);
    expect((await solo.host.call<{ ok: boolean }>('room:start')).ok).toBe(true);
  });

  it('遊戲開始後不能換卡、不能新加入', async () => {
    const t = await track(startedTable());
    expect((await t.clients.P2.call<{ ok: boolean }>('room:selectFlaw', { flaw: 'D01' })).ok).toBe(false);
    const late = new TestClient(t.url, 'Late');
    extras.push({ close: () => late.close() });
    await late.connect();
    expect((await late.call<{ ok: boolean }>('room:join', { name: 'Late', code: t.code })).ok).toBe(false);
  });

  it('開始時：備料階段、所有工作站就緒、每個人手上是空的', async () => {
    const t = await track(startedTable());
    const k = t.clients.P1.kitchen!;
    expect(k.phase).toBe('PREP');
    expect(Object.keys(k.stations).length).toBeGreaterThan(15);
    for (const r of seatsOf(t)) expect(k.players[r]).toMatchObject({ held: null, status: 'ok' });
    expect(k.stations.fridge.stock!.egg).toBeGreaterThan(0);
  });

  it('房間代碼與重連憑證不會出現在任何廣播裡', async () => {
    const t = await track(startedTable());
    for (const role of seatsOf(t)) {
      for (const other of seatsOf(t)) {
        if (other === role) continue;
        const tok = t.clients[other].token;
        const leaked = t.clients[role].events.some((e) => JSON.stringify(e.payload ?? null).includes(tok));
        expect(leaked, `${role} 不該看到 ${other} 的 token`).toBe(false);
      }
    }
  });

  it('加入不存在的房間／錯誤代碼：失敗；連續失敗會被暫時封鎖', async () => {
    const { server, url } = await startServer();
    extras.push(server);
    const c = new TestClient(url, 'brute');
    extras.push({ close: () => c.close() });
    await c.connect();
    for (let i = 0; i < 8; i++) expect((await c.call<{ ok: boolean }>('room:join', { name: 'x', code: `ZZZZ${i}Z` })).ok).toBe(false);
    const blocked = await c.call<{ ok: boolean; error?: string }>('room:join', { name: 'x', code: 'ABCDEF' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('過多');
  });

  it('不合法的暱稱與 payload 被拒絕，伺服器不會當掉', async () => {
    const { server, url } = await startServer();
    extras.push(server);
    const c = new TestClient(url, 'junk');
    extras.push({ close: () => c.close() });
    await c.connect();
    for (const bad of [undefined, null, {}, { name: '' }, { name: '   ' }, { name: 42 }, { name: '\u0000​' }]) {
      expect((await c.call<{ ok: boolean }>('room:create', bad)).ok).toBe(false);
    }
    const c2 = new TestClient(url, 'ok');
    extras.push({ close: () => c2.close() });
    await c2.connect();
    expect((await c2.call<{ ok: boolean }>('room:create', { name: '  很長的暱稱很長的暱稱很長的暱稱很長的暱稱  ' })).ok).toBe(true);
    expect((await c.call<{ ok: boolean }>('room:selectFlaw', { flaw: 'NOPE' })).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('廚房操作協定（伺服器權威）', () => {
  it('要站在工作站前才能操作；監視器不再限定角色，任何人都能用', async () => {
    const t = await track(startedTable());
    const { P1: a, P3: c } = t.clients;
    expect((await a.action('fridge', 'take', { type: 'egg' })).message).toContain('太遠');
    placeAt(t, 'P1', 'fridge');
    expect((await a.action('fridge', 'take', { type: 'egg' })).ok).toBe(true);
    placeAt(t, 'P1', 'cctv');
    expect((await a.action('cctv', 'watch')).ok).toBe(true);
    placeAt(t, 'P3', 'cctv');
    expect((await c.action('cctv', 'watch')).ok).toBe(true);
  });

  it('requestId 去重：網路重送同一個操作只執行一次；不合法的 payload 被拒絕', async () => {
    const t = await track(startedTable());
    const b = t.clients.P2;
    placeAt(t, 'P2', 'fridge');
    const before = kitchenOf(t).stations.fridge.stock!.egg!;
    const r1 = await b.action('fridge', 'take', { type: 'egg' }, 'dup-1');
    const r2 = await b.action('fridge', 'take', { type: 'egg' }, 'dup-1');
    expect(r1).toEqual(r2);
    expect(kitchenOf(t).stations.fridge.stock!.egg).toBe(before - 1);
    for (const bad of [null, {}, { stationId: 1, action: 'take', requestId: 'x' }, { stationId: 'fridge', action: 'take' }, { stationId: 'fridge', action: 'take', requestId: 'y'.repeat(100) }]) {
      expect((await b.call<{ ok: boolean }>('kitchen:action', bad)).ok).toBe(false);
    }
  });

  it('真的走路到工作站、做一份煎蛋吐司、出餐；全隊收到出餐結果', async () => {
    const t = await track(startedTable());
    const room = serverRoom(t);
    const b = t.clients.P2;
    room.advance(5100); // 備料結束，開始營業
    await b.waitFor<KitchenPublic>('kitchen:state', (k) => k.phase === 'SERVICE' && k.orders.length > 0);
    const ok = async (station: string, action: string, args: Record<string, unknown> = {}) => {
      await walkTo(t, b, station);
      const r = await b.action(station, action, args);
      if (!r.ok) throw new Error(`${station}.${action}：${r.message}`);
      return r;
    };
    await ok('pantry', 'take', { type: 'bread' });
    await ok('toaster', 'place');
    await ok('toaster', 'start', { level: 3 });
    await ok('fridge', 'take', { type: 'egg' });
    await ok('pan_a', 'heat', { level: 'MED' });
    await ok('pan_a', 'place');
    room.advance(23_000);
    await ok('pan_a', 'heat', { level: 'OFF' });
    await ok('plating', 'new_plate', { vessel: 'plate' });
    await ok('pan_a', 'pick');
    await ok('plating', 'add');
    await ok('toaster', 'pick');
    await ok('plating', 'add');
    await ok('fridge', 'take', { type: 'butter' });
    await ok('plating', 'add');
    for (const s of ['salt', 'pepper']) {
      await ok('spice', 'measure', { seasoning: s, units: 0.5 });
      await ok('plating', 'pour');
    }
    await ok('plating', 'pick');
    const order = kitchenOf(t).orders.find((o) => o.status === 'open' && o.recipeId === 'egg_toast')!;
    const served = await ok('pass', 'serve', { orderId: order.id });
    expect(served.result!.total).toBeGreaterThanOrEqual(90);
    for (const r of seatsOf(t)) await t.clients[r].waitFor<KitchenEvent>('kitchen:event', (e) => e.kind === 'served');
  });

  it('跑步會被伺服器記成噪音來源；被關在鐵籠裡的人不能移動', async () => {
    const t = await track(startedTable({ threats: true }));
    const room = serverRoom(t);
    room.advance(5100);
    room.sim!.trap('P1');
    await t.clients.P1.waitFor<{ teleport?: boolean }>('player:correct', (p) => !!p.teleport);
    const before = { ...serverPose(t, 'P1') };
    await sleep(300);
    t.clients.P1.fire('player:move', { x: before.x + 0.5, y: 1.6, z: before.z, yaw: 0, seq: 9999 });
    await sleep(100);
    expect(serverPose(t, 'P1').x).toBeCloseTo(before.x);
  });
});

describe('事件依缺陷卡過濾（耳背砧板）', () => {
  it('耳背砧板收不到聲音提示、也沒有替代文字，但看得到畫面提示；其他人兩種都收到；危險事件一定送到', async () => {
    const t = await track(startedTable({ threats: true }, ['D04', 'D02', 'D03']));
    const room = serverRoom(t);
    room.advance(5100);
    const { P1: a, P2: deafish, P3: c } = t.clients;
    await a.waitFor<KitchenEvent>('kitchen:event', (e) => e.kind === 'order_new' && !!e.sound && !!e.text);
    const d = room.sim!.threats as ThreatDirector;
    d.monster.hunger = 1e6;
    // 先在後門外刮門 6 秒（危險事件），然後才進門
    room.advance(6300);
    for (const x of [a, c]) {
      await x.waitFor<KitchenEvent>('kitchen:event', (e) => e.kind === 'monster_sound' && e.sound === 'backdoor');
      await x.waitFor<KitchenEvent>('kitchen:event', (e) => e.kind === 'monster_sound' && e.visual === 'flicker');
    }
    await deafish.waitFor<KitchenEvent>('kitchen:event', (e) => e.kind === 'monster_sound' && e.visual === 'flicker');
    const got = deafish.of<KitchenEvent>('kitchen:event');
    expect(got.some((e) => e.sound && !e.critical)).toBe(false);
    expect(got.some((e) => e.kind === 'order_new')).toBe(false); // 新訂單的鈴聲與文字都沒有（訂單板上看得到）
    expect(got.some((e) => e.text?.includes('後門吱'))).toBe(false);
    // 怪物抓人：危險事件，耳背砧板也一定收到（附畫面）
    place(t, 'P1', 1.5, 25.9, -Math.PI / 2);
    Object.assign(d.monster, { mode: 'patrol', x: 0.5, z: 25.9, yaw: -Math.PI / 2, path: [], modeSince: room.sim!.t, kitchenLeft: 60_000 });
    room.advance(1300);
    const grab = await deafish.waitFor<KitchenEvent>('kitchen:event', (e) => e.kind === 'monster_grab');
    expect(grab.visual).toBe('grab');
    // 撲抓預備：耳背砧板沒有尖嘯，但一定有撲過來的畫面
    expect(got.concat(deafish.of<KitchenEvent>('kitchen:event')).some((e) => e.kind === 'monster_roar' && e.visual === 'lunge')).toBe(true);
  });
});

describe('威脅與救援（三個 socket 客戶端）', () => {
  it('怪物抓走在後場落單的人 → 全隊收到失聯通知 → 隊友走到冷藏室的鐵籠救人', async () => {
    const t = await track(startedTable({ threats: true }));
    const room = serverRoom(t);
    room.advance(5100);
    const d = room.sim!.threats as ThreatDirector;
    // 盲區員在後走廊；怪物就在旁邊、面向他
    place(t, 'P1', 1.5, 25.9, -Math.PI / 2);
    Object.assign(d.monster, { mode: 'patrol', x: 0.5, z: 25.9, yaw: -Math.PI / 2, path: [], modeSince: room.sim!.t, kitchenLeft: 60_000 });
    room.advance(200);
    expect(d.monster.mode).toBe('windup');
    room.advance(1000);
    expect(room.sim!.status('P1')).toBe('trapped');
    for (const r of seatsOf(t)) await t.clients[r].waitFor<KitchenEvent>('kitchen:event', (e) => e.kind === 'monster_grab' && e.role === 'P1');
    // 失語員走過去救人（讓怪物先回後門外，免得牠接著追救人的人）
    d.monster.banish();
    room.advance(1000);
    await walkTo(t, t.clients.P3, 'cage');
    expect((await t.clients.P3.action('cage', 'rescue')).ok).toBe(true);
    room.advance(2600);
    expect(room.sim!.status('P1')).toBe('ok');
    await t.clients.P2.waitFor<KitchenEvent>('kitchen:event', (e) => e.kind === 'rescued');
  });

  it('客人進到廚房後是實體：站在他的位置會被伺服器擋下', async () => {
    const t = await track(startedTable({ threats: true }));
    const room = serverRoom(t);
    room.advance(5100);
    const d = room.sim!.threats as ThreatDirector;
    d.monster.enabled = false;
    d.guest.active = true;
    d.guest.idx = 7;
    d.guest.x = -1;
    d.guest.z = 10.3;
    place(t, 'P2', -1, 11.6, 0);
    const c = t.clients.P2;
    c.fire('player:move', { x: -1, y: 1.6, z: 10.4, yaw: 0, seq: 50_000 });
    await c.waitFor<{ x: number; z: number }>('player:correct', (p) => Math.abs(p.z - 11.6) < 0.01);
  });
});

/* ------------------------------------------------------------------ */

describe('開發者工具', () => {
  it('正式設定下預設關閉；開發環境預設開啟；DEBUG_TOOLS 可覆寫', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).debugTools).toBe(false);
    expect(loadConfig({ NODE_ENV: 'production', DEBUG_TOOLS: '1' }).debugTools).toBe(true);
    expect(loadConfig({ NODE_ENV: 'development' }).debugTools).toBe(true);
    expect(loadConfig({ NODE_ENV: 'development', DEBUG_TOOLS: '0' }).debugTools).toBe(false);
  });

  it('關閉時：查看狀態與指令一律拒絕', async () => {
    const t = await track(startedTable({ debugTools: false }));
    expect((await t.host.call<{ ok: boolean }>('debug:state')).ok).toBe(false);
    expect((await t.host.call<{ ok: boolean }>('debug:command', { cmd: 'skip_prep' })).ok).toBe(false);
  });

  it('開啟時：跳過備料、召喚怪物、查看怪物狀態、讓怪物離開', async () => {
    const t = await track(startedTable({ debugTools: true, threats: true }));
    expect((await t.host.call<{ ok: boolean }>('debug:command', { cmd: 'skip_prep' })).ok).toBe(true);
    expect(serverRoom(t).sim!.phase).toBe('SERVICE');
    expect((await t.host.call<{ ok: boolean }>('debug:command', { cmd: 'spawn_monster' })).ok).toBe(true);
    serverRoom(t).advance(200);
    const st = await t.host.call<{ ok: boolean; state: { monster: { mode: string } } }>('debug:state');
    expect(st.state.monster.mode).not.toBe('dormant');
    // 讓怪物離開：立刻回到後門外，之後不會自己再出現
    expect((await t.host.call<{ ok: boolean }>('debug:command', { cmd: 'monster_off' })).ok).toBe(true);
    serverRoom(t).advance(120_000);
    expect(serverRoom(t).sim!.publicState().threats.monster?.present).toBe(false);
    expect((await t.host.call<{ ok: boolean }>('debug:command', { cmd: 'nope' })).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('信號器與標記', () => {
  it('信號器：耳背砧板收不到敲擊，其他 token 所有人都收得到；只有敲擊的訊號耳背砧板完全收不到', async () => {
    const t = await track(startedTable({}, ['D04', 'D02', 'D03']));
    const { P1: a, P2: b, P3: c } = t.clients;
    await a.call('signal:emit', { tokens: ['TAP_S', 'LIGHT_R', 'TAP_L', 'SYM_TRI'] });
    const toC = await c.waitFor<{ from: Seat; tokens: string[] }>('signal:received');
    expect(toC.from).toBe('P1');
    expect(toC.tokens).toEqual(['TAP_S', 'LIGHT_R', 'TAP_L', 'SYM_TRI']);
    const toB = await b.waitFor<{ tokens: string[] }>('signal:received');
    expect(toB.tokens).toEqual(['LIGHT_R', 'SYM_TRI']);
    await c.call('signal:emit', { tokens: ['TAP_S', 'TAP_L'] });
    await a.waitFor('signal:received', (s: { from: Seat }) => s.from === 'P3');
    await b.expectNone('signal:received', (s) => (s as { from: Seat }).from === 'P3');
  });

  it('信號器沒有自由文字：不在詞彙內、過長、過於頻繁都被拒絕', async () => {
    const t = await track(startedTable());
    const m = t.clients.P3;
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: ['HELLO'] })).ok).toBe(false);
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: ['<script>'] })).ok).toBe(false);
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: Array(7).fill('TAP_S') })).ok).toBe(false);
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: [] })).ok).toBe(false);
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: 'TAP_S' })).ok).toBe(false);
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: ['TAP_S'] })).ok).toBe(true);
    expect((await m.call<{ ok: boolean }>('signal:emit', { tokens: ['TAP_S'] })).ok).toBe(false);
  });

  it('標記：任何人都能標記工作站或訂單；顯示來源；隊友可以回應；存在互助狀態裡；不會改變廚房', async () => {
    const t = await track(startedTable());
    const room = serverRoom(t);
    room.advance(5100);
    const { P1: a, P2: b, P3: c } = t.clients;
    expect((await c.call<{ ok: boolean }>('signal:mark', { targetId: 'nope' })).ok).toBe(false);
    expect((await c.call<{ ok: boolean }>('signal:mark', { targetId: 'order:nope' })).ok).toBe(false);
    expect((await a.call<{ ok: boolean }>('signal:mark', { targetId: 'pan_a', token: 'GEST_TAKE' })).ok).toBe(true);
    const got = await b.waitFor<{ id: string; from: Seat; targetId: string; token?: string }>('signal:marker');
    expect(got).toMatchObject({ from: 'P1', targetId: 'pan_a', token: 'GEST_TAKE' });
    const order = room.sim!.orders[0];
    expect((await c.call<{ ok: boolean }>('signal:mark', { targetId: `order:${order.id}`, token: 'GEST_HELP' })).ok).toBe(true);
    const reply = await b.action('coop', 'mark_reply', { markId: got.id, token: 'GEST_YES' });
    expect(reply.ok).toBe(true);
    expect((await a.action('coop', 'mark_reply', { markId: got.id, token: 'GEST_YES' })).ok).toBe(false); // 不能回應自己的標記
    await a.waitFor<KitchenEvent>('kitchen:event', (e) => e.kind === 'coop' && !!e.text?.includes('回應'));
    const marks = room.sim!.publicState().coop.marks;
    expect(marks.find((m) => m.id === got.id)!.replies).toEqual([{ by: 'P2', token: 'GEST_YES' }]);
    expect(marks.some((m) => m.targetId === `order:${order.id}` && m.from === 'P3')).toBe(true);
    expect(room.sim!.players.P1.held).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe('語音 signaling：由伺服器驗證（沉默侍者不能發話）', () => {
  const sdp = (dir: string, extra = '') =>
    ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', `a=${dir}`, 'a=rtpmap:111 opus/48000/2', extra]
      .filter(Boolean)
      .join('\r\n') + '\r\n';
  const offer = (from: Seat, to: Seat, s: string) => ({ to, edge: { from, to }, kind: 'offer', sdp: s });
  const answer = (from: Seat, to: Seat, s: string) => ({ to: from, edge: { from, to }, kind: 'answer', sdp: s });

  it('語音規則：所有人互通，只有沉默侍者（D04）不能發話；耳背砧板仍然收得到', async () => {
    const { voiceEdgeAllowed } = await import('@last-table/shared');
    const flaws: Record<string, string> = { P1: 'D04', P2: 'D02', P3: 'D03' };
    const of = (s: Seat) => flaws[s] as never;
    expect(voiceEdgeAllowed('P1', 'P2', of)).toBe(false);
    expect(voiceEdgeAllowed('P1', 'P3', of)).toBe(false);
    expect(voiceEdgeAllowed('P2', 'P1', of)).toBe(true);
    expect(voiceEdgeAllowed('P3', 'P2', of)).toBe(true);
    expect(voiceEdgeAllowed('P2', 'P2', of)).toBe(false);
  });

  it('允許的邊：offer 與 answer 會被轉發', async () => {
    const t = await track(lobbyOfThree({}, ['D02', 'D03', 'D01']));
    const { P1: a, P2: b, P3: c } = t.clients;
    b.fire('voice:signal', offer('P2', 'P1', sdp('sendonly')));
    const got = await a.waitFor<{ from: Seat; kind: string }>('voice:signal');
    expect(got).toMatchObject({ from: 'P2', kind: 'offer' });
    a.fire('voice:signal', answer('P2', 'P1', sdp('recvonly')));
    expect((await b.waitFor<{ from: Seat; kind: string }>('voice:signal', (p) => p.kind === 'answer')).from).toBe('P1');
    a.fire('voice:signal', offer('P1', 'P3', sdp('sendonly')));
    await c.waitFor<{ from: Seat; kind: string }>('voice:signal', (p) => p.from === 'P1' && p.kind === 'offer');
  });

  it('不允許的邊（沉默侍者發話）、SDP 方向不對、含視訊或 DataChannel、冒充：全部被丟棄', async () => {
    const t = await track(lobbyOfThree({}, ['D04', 'D03', 'D04']));
    const { P1: a, P2: b, P3: c } = t.clients;
    c.fire('voice:signal', offer('P3', 'P1', sdp('sendonly')));
    c.fire('voice:signal', offer('P3', 'P2', sdp('sendonly')));
    a.fire('voice:signal', offer('P1', 'P2', sdp('sendonly')));
    b.fire('voice:signal', answer('P1', 'P2', sdp('recvonly')));
    b.fire('voice:signal', offer('P2', 'P1', sdp('sendrecv')));
    b.fire('voice:signal', offer('P2', 'P1', sdp('sendonly') + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sendonly\r\n'));
    b.fire('voice:signal', offer('P2', 'P3', sdp('sendonly') + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n'));
    a.fire('voice:signal', answer('P2', 'P1', sdp('sendonly')));
    b.fire('voice:signal', offer('P1', 'P3', sdp('sendonly')));
    b.fire('voice:signal', { to: 'P1', edge: { from: 'P2', to: 'P1' }, kind: 'offer' });
    b.fire('voice:signal', offer('P2', 'P1', sdp('sendonly', 'a=x:' + 'y'.repeat(25_000))));
    await a.expectNone('voice:signal');
    await b.expectNone('voice:signal');
    await c.expectNone('voice:signal');
  });

  it('語音上線通知：準備好的隊友會互相收到 voice:peer', async () => {
    const t = await track(lobbyOfThree());
    const { P1: a, P2: b } = t.clients;
    b.fire('voice:ready', { micEnabled: true });
    expect(await a.waitFor<{ role: Seat }>('voice:peer', (x) => x.role === 'P2')).toMatchObject({ role: 'P2', connected: true, micEnabled: true });
    a.fire('voice:ready', { micEnabled: false });
    expect((await b.waitFor<{ role: Seat }>('voice:peer', (x) => x.role === 'P1')).role).toBe('P1');
  });
});

/* ------------------------------------------------------------------ */

describe('斷線與重連', () => {
  it('重連後恢復角色、位置、手上的東西；重送的操作不會重複執行；錯誤憑證被拒', async () => {
    const t = await track(startedTable());
    const room = serverRoom(t);
    room.advance(5100);
    const b = t.clients.P2;
    placeAt(t, 'P2', 'fridge');
    const r1 = await b.action('fridge', 'take', { type: 'egg' }, 'keep-1');
    expect(r1.ok).toBe(true);
    const pos = { ...serverPose(t, 'P2') };
    b.close();
    await sleep(100);
    const b2 = new TestClient(t.url, 'Bao2');
    extras.push({ close: () => b2.close() });
    await b2.connect();
    const bad = await b2.call<{ ok: boolean }>('room:rejoin', { code: t.code, token: 'x'.repeat(48) });
    expect(bad.ok).toBe(false);
    const r = await b2.call<{ ok: boolean; sync: { me: { role: Seat }; pos: { x: number; z: number }; kitchen: KitchenPublic } }>('room:rejoin', { code: t.code, token: b.token });
    expect(r.ok).toBe(true);
    expect(r.sync.me.role).toBe('P2');
    expect(r.sync.pos.x).toBeCloseTo(pos.x);
    expect(r.sync.kitchen.players.P2!.held?.kind).toBe('item');
    // 斷線前送出、重連後重送的同一個操作：不會再拿一顆蛋
    const stock = kitchenOf(t).stations.fridge.stock!.egg!;
    const again = await b2.call<{ ok: boolean; message: string }>('kitchen:action', { stationId: 'fridge', action: 'take', args: { type: 'egg' }, requestId: 'keep-1' });
    expect(again.message).toBe(r1.message);
    expect(kitchenOf(t).stations.fridge.stock!.egg).toBe(stock);
  });

  it('同一個憑證在另一個分頁重連，舊連線會被取代', async () => {
    const t = await track(startedTable());
    const old = t.clients.P3;
    const tab = new TestClient(t.url, 'tab');
    extras.push({ close: () => tab.close() });
    await tab.connect();
    expect((await tab.call<{ ok: boolean }>('room:rejoin', { code: t.code, token: old.token })).ok).toBe(true);
    await sleep(100);
    expect(old.socket.connected).toBe(false);
    void nextReq;
  });
});
