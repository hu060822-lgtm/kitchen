import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TUTORIAL_STEP_BY_ID, type FullSync, type TutorialStepId } from '@last-table/shared';
import { Tutorial } from '../src/kitchen/tutorial';
import type { ThreatDirector } from '../src/kitchen/threats';
import { startHost, type HostHandle } from '../src/host';
import { bench, cookEggToast, serveFirst, type Bench } from './bench';
import { TestClient, startServer, sleep } from './net';

/**
 * 教學關「第一班」：伺服器依廚房的實際狀態判定每一步。
 */

function tutorialBench(): Bench & { tut: Tutorial } {
  const b = bench({ seats: ['P1'], schedule: [], threats: true, prepMs: 5000, serviceMs: 3_600_000 });
  const tut = new Tutorial();
  b.sim.tutorial = tut;
  tut.begin(b.sim);
  return Object.assign(b, { tut });
}

const step = (b: Bench): TutorialStepId => b.sim.publicState().tutorial!.step;
const ack = (b: Bench, id: TutorialStepId) => b.sim.handle('P1', { stationId: 'tutorial', action: 'ack', args: { step: id }, requestId: `ack-${id}-${Math.random()}` });

describe('教學關：一整輪', () => {
  it('從歡迎到完成：看單、查食譜、做一份煎蛋吐司出餐、看著客人、請他回座、躲過後門的東西', () => {
    const b = tutorialBench();
    const th = b.sim.threats as unknown as ThreatDirector;
    expect(b.sim.phase).toBe('SERVICE');
    expect(step(b)).toBe('welcome');
    // 威脅一開始是關的：跑很久也不會出現
    b.run(80);
    expect(th.guest.active).toBe(false);
    expect(th.monster.present).toBe(false);
    expect(step(b)).toBe('welcome');

    // 只能確認目前這一步
    expect(ack(b, 'tickets').ok).toBe(false);
    expect(ack(b, 'welcome').ok).toBe(true);
    expect(step(b)).toBe('move');
    b.poses.P1.x += 3;
    b.run(0.2);
    expect(step(b)).toBe('tickets');
    // 進入「看單」：出了一張煎蛋吐司
    b.run(0.5);
    const order = b.sim.publicState().orders.find((o) => o.status === 'open');
    expect(order?.recipeId).toBe('egg_toast');
    expect(b.sim.publicState().menu).toContain('egg_toast');
    expect(ack(b, 'tickets').ok).toBe(true);
    expect(ack(b, 'cookbook').ok).toBe(true);
    expect(step(b)).toBe('pantry');

    // 照教學的順序做一份煎蛋吐司：每一步依實際狀態過
    const go = (stationId: string, action: string, args: Record<string, unknown> = {}) => {
      const res = b.act('P1', stationId, action, args);
      expect(res.ok, `${stationId}:${action} ${res.message}`).toBe(true);
      b.run(0.2);
    };
    expect(step(b)).toBe('pantry');
    go('pantry', 'take', { type: 'bread' });
    expect(step(b)).toBe('toaster');
    go('toaster', 'quick', { mode: 'primary' });
    go('toaster', 'quick', { mode: 'use' });
    expect(step(b)).toBe('fridge');
    // 兩顆蛋、一份奶油：兩隻手放不下，奶油進菜籃
    go('fridge', 'take', { type: 'egg', count: 2 });
    expect(step(b)).toBe('fridge');
    go('fridge', 'take', { type: 'butter' });
    expect(b.sim.players.P1.basket.length).toBe(1);
    expect(step(b)).toBe('hands');
    // 按兩次 B
    for (let i = 0; i < 2; i++) b.sim.handle('P1', { stationId: 'self', action: 'swap', args: {}, requestId: `sw${i}` });
    b.run(0.2);
    expect(step(b)).toBe('pan');
    // 翻回原本的手（翻完一圈）
    for (let i = 0; i < 2; i++) b.sim.handle('P1', { stationId: 'self', action: 'swap', args: {}, requestId: `sw-back${i}` });
    go('pan_a', 'quick', { mode: 'use' });
    // 左鍵兩下：兩顆蛋都下鍋（放下之後自動換到另一隻拿著蛋的手）
    go('pan_a', 'quick', { mode: 'primary' });
    go('pan_a', 'quick', { mode: 'primary' });
    expect(b.sim.stations.get('pan_a')!.items.map((id) => b.sim.items.get(id)!.type)).toEqual(['egg', 'egg']);
    expect(step(b)).toBe('cooked');
    b.run(23);
    for (let i = 0; i < 100 && b.sim.publicState().stations.toaster.toast; i++) b.run(0.5);
    expect(step(b)).toBe('butter');
    go('pan_a', 'heat', { level: 'OFF' });
    // 裝盤區左鍵：自動拿盤子、把手上的奶油裝上去
    go('plating', 'quick', { mode: 'primary' });
    expect(step(b)).toBe('plate_all');
    // 空手左鍵端起盤子，到平底鍋、烤麵包機各按一下左鍵
    go('plating', 'quick', { mode: 'primary' });
    expect(b.sim.players.P1.held?.kind).toBe('plate');
    go('pan_a', 'quick', { mode: 'primary' });
    go('toaster', 'quick', { mode: 'primary' });
    expect(step(b)).toBe('season');
    go('plating', 'quick', { mode: 'primary' });
    const plateId = b.sim.publicState().stations.plating.plates.at(-1)!;
    go('spice', 'measure', { seasoning: 'salt', units: 0.5 });
    go('plating', 'pour', { plateId });
    expect(step(b)).toBe('season');
    go('spice', 'measure', { seasoning: 'pepper', units: 0.5 });
    go('plating', 'pour', { plateId });
    expect(step(b)).toBe('serve');
    go('plating', 'pick', { plateId });
    const r = serveFirst(b, 'P1', 'egg_toast');
    expect(r.ok).toBe(true);
    b.run(0.2);
    expect(b.sim.publicState().tutorial!.score).toBe(r.result!.total);
    expect(step(b)).toBe('puddle');

    // 地上的水：擦乾
    const pud = b.sim.publicState().tutorial!.puddle!;
    expect(pud).toBeTruthy();
    Object.assign(b.poses.P1, { x: pud[0] + 0.5, z: pud[1], speed: 0 });
    expect(b.coop('P1', 'mop').ok).toBe(true);
    b.run(3);
    expect(step(b)).toBe('crew');
    expect(ack(b, 'crew').ok).toBe(true);
    expect(step(b)).toBe('guest_look');

    // 那位客人：坐在靠門的位子；站在餐廳看著他 1.5 秒
    expect(th.guest.active).toBe(true);
    Object.assign(b.poses.P1, { x: th.guest.x, z: th.guest.z - 3, yaw: Math.PI });
    b.run(2);
    expect(step(b)).toBe('guest_escort');
    expect(th.guest.state).toBe('kitchen');
    // 請他回座位
    Object.assign(b.poses.P1, { x: th.guest.x, z: th.guest.z + 1.2, yaw: 0 });
    const e = b.sim.handle('P1', { stationId: 'guest', action: 'escort', args: {}, requestId: 'esc' });
    expect(e.ok).toBe(true);
    b.run(2.5);
    expect(step(b)).toBe('backdoor');
    // 鎖後門
    go('cctv', 'quick', { mode: 'use' });
    expect(step(b)).toBe('rifle');
    go('gunrack', 'quick', { mode: 'primary' });
    expect(step(b)).toBe('monster');
    expect(th.monster.tune.speed).toBeLessThan(1);

    // 後門的東西：站在餐廳（牠不會進餐廳），等牠進來又離開
    Object.assign(b.poses.P1, { x: -6, z: 4, yaw: 0 });
    let appeared = false;
    for (let i = 0; i < 1600 && step(b) === 'monster'; i++) {
      b.run(0.1);
      if (th.monster.present) appeared = true;
    }
    expect(appeared).toBe(true);
    expect(step(b)).toBe('done');
    expect(th.monster.present).toBe(false);
    // 完成之後威脅都停了
    b.run(60);
    expect(th.monster.present).toBe(false);
    expect(th.guest.state).toBe('seated');
    expect(th.monster.tune.speed).toBe(1);
  });

  it('後門的東西進來時，用來福槍打中牠：牠離開後這一步就過', () => {
    const b = tutorialBench();
    b.tut.idx = TUTORIAL_STEP_BY_ID.rifle.index;
    b.act('P1', 'gunrack', 'take');
    b.run(0.2);
    expect(step(b)).toBe('monster');
    const th = b.sim.threats as unknown as ThreatDirector;
    // 先站在餐廳等牠走進廚房
    Object.assign(b.poses.P1, { x: -6, z: 4, yaw: 0 });
    for (let i = 0; i < 900 && !(th.monster.present && th.monster.z < 18.5); i++) b.run(0.1);
    expect(th.monster.present).toBe(true);
    th.monster.tune.speed = 0;
    // 站到牠旁邊 4 公尺、面向牠
    const m = th.monster;
    Object.assign(b.poses.P1, { x: m.x - 4, z: m.z, yaw: -Math.PI / 2 });
    const r = b.sim.handle('P1', { stationId: 'self', action: 'fire', args: { yaw: -Math.PI / 2 }, requestId: 'shot' });
    expect(r.message).toContain('打中');
    th.monster.tune.speed = 1;
    for (let i = 0; i < 600 && step(b) === 'monster'; i++) b.run(0.1);
    expect(step(b)).toBe('done');
    // 教學用掉的子彈會補回來
    expect(b.sim.rifleAmmo).toBe(4);
  });

  it('順序不同也會過：先煎好蛋、烤好吐司，再回頭確認看單和食譜，做過的步驟一起過', () => {
    const b = tutorialBench();
    ack(b, 'welcome');
    b.poses.P1.x += 3;
    b.run(0.3);
    ack(b, 'tickets');
    ack(b, 'cookbook');
    // 一口氣做完整盤（還沒出餐）
    cookEggToast(b, 'P1');
    b.run(0.2);
    // 換手要自己試過（按兩次 B）
    expect(step(b)).toBe('hands');
    for (let i = 0; i < 2; i++) b.sim.handle('P1', { stationId: 'self', action: 'swap', args: {}, requestId: `o${i}` });
    b.run(0.2);
    expect(step(b)).toBe('serve');
  });

  it('後門的東西一直沒出現或玩家一直躲著：150 秒後也會結束這一步；被關在鐵籠裡時要先出來', () => {
    const b = tutorialBench();
    b.tut.idx = TUTORIAL_STEP_BY_ID.monster.index;
    expect(b.tut.step).toBe('monster');
    const th = b.sim.threats as unknown as ThreatDirector;
    th.monster.banish(); // 模擬牠沒有出現
    b.tut.enteredAt = b.sim.t;
    b.run(149);
    expect(step(b)).toBe('monster');
    b.sim.players.P1.status = 'trapped';
    b.run(5);
    expect(step(b)).toBe('monster');
    b.sim.players.P1.status = 'ok';
    b.run(0.2);
    expect(step(b)).toBe('done');
  });
});

describe('教學關：房間', () => {
  const dirs: string[] = [];
  const hosts: HostHandle[] = [];
  const clients: TestClient[] = [];
  afterEach(async () => {
    while (clients.length) clients.pop()!.close();
    while (hosts.length) await hosts.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('一個人開教學房間就直接開班（不用缺陷卡、不用按準備好）；別人不能加入', async () => {
    const { server, url } = await startServer({ threats: true });
    try {
      const a = new TestClient(url, 'Luz');
      clients.push(a);
      await a.connect();
      const r = await a.call<{ ok: boolean; roomCode: string; sync: FullSync }>('room:tutorial', { name: 'Luz' });
      expect(r.ok).toBe(true);
      expect(r.sync.room.tutorial).toBe(true);
      expect(r.sync.room.phase).toBe('PLAYING');
      expect(r.sync.room.waiting).toBeNull();
      expect(r.sync.kitchen?.tutorial).toMatchObject({ step: 'welcome', index: 0 });
      expect(r.sync.kitchen?.phase).toBe('SERVICE');
      const b = new TestClient(url, 'Bao');
      clients.push(b);
      await b.connect();
      const j = await b.call<{ ok: boolean; error?: string }>('room:join', { name: 'Bao', code: r.roomCode });
      expect(j.ok).toBe(false);
      expect(j.error).toContain('教學');
      // 確認「歡迎」
      const k = await a.call<{ ok: boolean }>('kitchen:action', { stationId: 'tutorial', action: 'ack', args: { step: 'welcome' }, requestId: 'w1' });
      expect(k.ok).toBe(true);
    } finally {
      await server.close();
      await new Promise<void>((res) => server.http.close(() => res()));
    }
  });

  it('房主模式（應用程式）不會把教學關存檔', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'lt-tut-'));
    dirs.push(d);
    const h = await startHost({ port: 0, lan: false, saveDir: d, clientDist: path.join(d, 'none'), gameVersion: 'test', autosaveMs: 100 });
    hosts.push(h);
    const a = new TestClient(h.localUrl, 'Luz');
    clients.push(a);
    await a.connect();
    await a.call('room:tutorial', { name: 'Luz' });
    await sleep(600);
    expect((await a.call<{ ok: boolean }>('room:save')).ok).toBe(false);
    expect(h.saveAll('manual')).toEqual([]);
    expect(readdirSync(d).filter((f) => f.endsWith('.json'))).toEqual([]);
  });
});
