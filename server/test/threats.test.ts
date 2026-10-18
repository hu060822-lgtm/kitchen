import { describe, expect, it } from 'vitest';
import { STATION_BY_ID, stationFront, type Seat } from '@last-table/shared';
import { GUEST, GUEST_SPOTS, MONSTER, ThreatDirector } from '../src/kitchen/threats';
import { NAV_EDGES, findPath } from '../src/kitchen/threats/nav';
import { bench, type Bench } from './bench';

const director = (b: Bench) => b.sim.threats as ThreatDirector;
const monster = (b: Bench) => director(b).monster;
const guest = (b: Bench) => director(b).guest;

/** 只留下一位在場的玩家（其他人放到餐廳最遠處、背對廚房，避免干擾） */
function isolate(b: Bench, keep: Seat[]): void {
  for (const r of ['P1', 'P2', 'P3'] as Seat[]) {
    if (keep.includes(r)) continue;
    Object.assign(b.poses[r], { x: 7.5, z: 0.8, yaw: 0, connected: true });
  }
}

/** 怪物放到某個位置、面向某個方向，處於巡邏 */
function putMonster(b: Bench, x: number, z: number, yaw: number): void {
  const m = monster(b);
  m.mode = 'patrol';
  m.modeSince = b.sim.t;
  m.x = x;
  m.z = z;
  m.yaw = yaw;
  m.path = [];
  m.enabled = true;
}

function openService(b: Bench): void {
  b.open();
}

describe('怪物：每一個狀態轉換都有明確條件', () => {
  it('飢餓值滿了：先在後門外刮門 6 秒（一定送到的預警），然後才進來', () => {
    const b = bench({ threats: true });
    openService(b);
    isolate(b, []);
    b.run(MONSTER.hungerEnter - 2);
    expect(monster(b).mode).toBe('dormant');
    b.run(3);
    const m = monster(b);
    expect(m.mode).toBe('lurk');
    expect(m.present).toBe(false);
    const pub = m.public();
    expect(pub.warnLeft).toBeGreaterThan(MONSTER.warnMs - 1500);
    expect(pub.warnLeft).toBeLessThanOrEqual(MONSTER.warnMs);
    const warn = b.events.find((x) => x.e.kind === 'monster_sound' && /刮門/.test(x.e.text ?? ''));
    expect(warn?.e.critical).toBe(true);
    expect(warn?.e.text).toContain('鎖後門');
    b.run(MONSTER.warnMs / 1000 + 0.3);
    expect(m.present).toBe(true);
    expect(b.events.some((x) => x.e.kind === 'monster_sound' && x.e.sound === 'backdoor')).toBe(true);
  });

  it('刮門的 6 秒內鎖上後門：牠進不來，走開（飢餓值變負的）', () => {
    const b = bench({ threats: true });
    openService(b);
    isolate(b, []);
    const m = monster(b);
    m.hunger = MONSTER.hungerEnter + 1;
    b.run(0.2);
    expect(m.mode).toBe('lurk');
    b.run(2);
    expect(b.act('P2', 'cctv', 'back_door').ok).toBe(true);
    b.run(0.2);
    expect(m.mode).toBe('dormant');
    expect(m.hunger).toBeLessThan(0);
    b.run(MONSTER.warnMs / 1000 + 1);
    expect(m.present).toBe(false);
  });

  it('廚房越吵越快出現：一直切菜的班次，怪物比安靜的班次早到', () => {
    const emergeAt = (noisy: boolean) => {
      const b = bench({ threats: true });
      openService(b);
      isolate(b, []);
      for (let s = 0; s < 120; s++) {
        if (noisy && s % 3 === 0) b.sim.noise(-8, 14, 5, 'chop');
        b.run(1);
        if (monster(b).mode !== 'dormant') return s;
      }
      return 999;
    };
    expect(emergeAt(true)).toBeLessThan(emergeAt(false));
  });

  it('追最近的人（照實際要走的路算），隔著牆也知道你在哪裡；餐廳裡的人不算', () => {
    const b = bench({ threats: true });
    openService(b);
    isolate(b, ['P1', 'P2']);
    // P1 在冷藏室（離後場近），P2 在出餐口旁
    Object.assign(b.poses.P1, { x: -6, z: 22 });
    Object.assign(b.poses.P2, { x: 1, z: 10.5 });
    putMonster(b, 0.6, 25.9, 0);
    b.run(0.1);
    expect(monster(b).mode).toBe('chase');
    expect(monster(b).target).toBe('P1');
    // P1 跑進餐廳：換追 P2
    Object.assign(b.poses.P1, { x: -6, z: 4 });
    b.run(0.2);
    expect(monster(b).target).toBe('P2');
  });

  it('追同一個人 20 秒就換追另一個人；只剩一個人就繼續追他', () => {
    const b = bench({ threats: true });
    openService(b);
    isolate(b, ['P1', 'P2']);
    Object.assign(b.poses.P1, { x: -1, z: 16.6 });
    Object.assign(b.poses.P2, { x: 3, z: 11 });
    putMonster(b, -1.5, 18.5, 0);
    const m = monster(b);
    m.tune = { ...m.tune, speed: 0 }; // 讓牠站著不動，只看換目標
    m.kitchenLeft = 120_000;
    b.run(0.1);
    expect(m.target).toBe('P1');
    b.run(MONSTER.switchMs / 1000 - 1);
    expect(m.target).toBe('P1');
    b.run(1.2);
    expect(m.target).toBe('P2');
    expect(b.events.some((x) => x.to === 'P2' && /盯上你/.test(x.e.text ?? ''))).toBe(true);
    // P2 躲進餐廳：只剩 P1
    Object.assign(b.poses.P2, { x: 7.5, z: 1 });
    b.run(0.2);
    expect(m.target).toBe('P1');
  });

  it('沒有追得到的人（都在餐廳或躲起來）：在後場晃；有人出來就追', () => {
    const b = bench({ threats: true });
    openService(b);
    isolate(b, []);
    putMonster(b, 0.6, 25.9, 0);
    monster(b).kitchenLeft = 60_000;
    b.run(1);
    expect(monster(b).mode).toBe('patrol');
    Object.assign(b.poses.P3, { x: 0, z: 12 });
    b.run(0.2);
    expect(monster(b).mode).toBe('chase');
    expect(monster(b).target).toBe('P3');
  });

  it('不會瞬間抓人：靠近後一定先有預備動作（有聲音與畫面預警）；抓到後接著追下一個人', () => {
    const b = bench({ threats: true });
    openService(b);
    isolate(b, ['P1', 'P2']);
    Object.assign(b.poses.P2, { x: 3, z: 11 });
    putMonster(b, -0.5, 16.6, 0);
    monster(b).kitchenLeft = 60_000;
    Object.assign(b.poses.P1, { x: -0.5, z: 15.6 });
    b.run(0.3);
    expect(monster(b).mode).toBe('windup');
    expect(b.events.some((x) => x.e.kind === 'monster_roar' && x.e.sound === 'screech')).toBe(true);
    expect(b.events.some((x) => x.e.kind === 'monster_roar' && x.e.visual === 'lunge')).toBe(true);
    b.run(MONSTER.windupMs / 1000 - 0.3);
    expect(b.sim.status('P1')).toBe('ok');
    b.run(0.5);
    expect(b.sim.status('P1')).toBe('trapped');
    expect(b.poses.P1.x).toBeLessThan(-7.5);
    expect(b.events.some((x) => x.e.kind === 'monster_grab' && x.e.role === 'P1')).toBe(true);
    // 時間還沒到：接著追 P2
    expect(monster(b).mode).toBe('chase');
    expect(monster(b).target).toBe('P2');
  });

  it('預備動作期間逃開：沒有抓到，繼續追；比走路快、比跑步慢', () => {
    const b = bench({ threats: true });
    openService(b);
    isolate(b, ['P3']);
    putMonster(b, -0.5, 16.6, 0);
    monster(b).kitchenLeft = 60_000;
    Object.assign(b.poses.P3, { x: -0.5, z: 15.6 });
    b.run(0.3);
    expect(monster(b).mode).toBe('windup');
    Object.assign(b.poses.P3, { x: -0.5, z: 12.5 });
    b.run(1);
    expect(b.sim.status('P3')).toBe('ok');
    expect(monster(b).mode).toBe('chase');
    expect(MONSTER.speed.chase).toBeGreaterThan(2.3);
    expect(MONSTER.speed.chase).toBeLessThan(4.4);
  });

  it('躲進置物櫃：牠不會打開櫃子，沒有別人可以追就去別處晃', () => {
    const b = bench({ threats: true });
    openService(b);
    isolate(b, ['P2']);
    putMonster(b, 5.6, 16.4, -Math.PI / 2);
    monster(b).kitchenLeft = 60_000;
    b.at('P2', 'locker_k');
    b.run(0.1);
    expect(monster(b).mode).toBe('chase');
    expect(b.act('P2', 'locker_k', 'hide').ok).toBe(true);
    b.run(10);
    expect(b.sim.status('P2')).toBe('hidden');
    expect(monster(b).mode).toBe('patrol');
    expect(b.act('P2', 'locker_k', 'leave').ok).toBe(true);
  });

  it('被抓走的人由隊友在鐵籠前撬開（2.5 秒）；離開就中斷', () => {
    const b = bench({ threats: true });
    openService(b);
    b.sim.trap('P2');
    expect(b.act('P2', 'fridge', 'take', { type: 'egg' }).ok).toBe(false);
    b.at('P3', 'cage');
    expect(b.act('P3', 'cage', 'rescue').ok).toBe(true);
    b.run(1);
    Object.assign(b.poses.P3, { x: 0, z: 12 });
    b.run(2);
    expect(b.sim.status('P2')).toBe('trapped');
    b.act('P3', 'cage', 'rescue');
    b.run(2.6);
    expect(b.sim.status('P2')).toBe('ok');
    expect(b.sim.stats.rescued).toBe(1);
  });

  it('防火門關上時，路網不能穿過防火門，要繞冷藏室或乾貨室', () => {
    expect(NAV_EDGES.some((e) => e.door === 'fire')).toBe(true);
    const open = findPath('HE2', 'K3', true)!;
    const closed = findPath('HE2', 'K3', false)!;
    expect(open).toContain('KFD');
    expect(closed).not.toContain('KFD');
    expect(closed.length).toBeGreaterThan(open.length);
  });

  it('任何人都能從監視器關上防火門 15 秒，冷卻 45 秒（冷卻是全隊共用的）', () => {
    const b = bench({ threats: true });
    openService(b);
    expect(b.act('P2', 'cctv', 'fire_door').ok).toBe(true);
    expect(b.sim.doors.fire).toBe(false);
    b.run(15.2);
    expect(b.sim.doors.fire).toBe(true);
    expect(b.act('P3', 'cctv', 'fire_door').ok).toBe(false);
    b.run(30);
    expect(b.act('P3', 'cctv', 'fire_door').ok).toBe(true);
  });
});

describe('永遠沒有點餐的客人：沒有人看著的時候才會動', () => {
  const lookAt = (b: Bench, r: Seat, x: number, z: number, from: [number, number]) => {
    Object.assign(b.poses[r], { x: from[0], z: from[1], yaw: Math.atan2(-(x - from[0]), -(z - from[1])) });
  };

  it('營業後 45 秒出現在最遠的座位；沒人看著 7 秒就往前移一個位置（附帶聽得到的聲音）', () => {
    const b = bench({ threats: true });
    openService(b);
    monster(b).enabled = false;
    isolate(b, []);
    b.run(GUEST.appearMs / 1000 + 0.2);
    expect(guest(b).active).toBe(true);
    expect(guest(b).idx).toBe(0);
    b.run(GUEST.stepMs / 1000 + 0.2);
    expect(guest(b).idx).toBe(1);
    const moved = b.events.filter((x) => x.e.kind === 'guest_moved' && x.e.sense === 'sound');
    expect(moved.length).toBe(1);
  });

  it('有人盯著他：他不動；所有人都轉開視線，他才會移動', () => {
    const b = bench({ threats: true });
    openService(b);
    monster(b).enabled = false;
    isolate(b, ['P2', 'P1']);
    b.run(GUEST.appearMs / 1000 + 0.2);
    const g = GUEST_SPOTS[0];
    lookAt(b, 'P2', g.x, g.z, [0, 5]);
    lookAt(b, 'P1', g.x, g.z, [1, 5]);
    b.run(20);
    expect(guest(b).idx).toBe(0);
    // 只有一個人轉身：另一個人還看著，他不動
    b.poses.P2.yaw += Math.PI;
    b.run(GUEST.stepMs / 1000 + 0.2);
    expect(guest(b).idx).toBe(0);
    // 兩個人都轉開 → 他開始移動
    b.poses.P1.yaw += Math.PI;
    b.run(GUEST.stepMs / 1000 + 0.2);
    expect(guest(b).idx).toBe(1);
  });

  it('看監視器也算看著他（不必待在餐廳）', () => {
    const b = bench({ threats: true });
    openService(b);
    monster(b).enabled = false;
    isolate(b, ['P3']);
    b.run(GUEST.appearMs / 1000 + 0.2);
    b.act('P3', 'cctv', 'watch', { on: true });
    b.run(20);
    expect(guest(b).idx).toBe(0);
    // 離開監視器就停止觀看
    Object.assign(b.poses.P3, { x: 0, z: 12 });
    b.run(GUEST.stepMs / 1000 + 0.5);
    expect(guest(b).idx).toBe(1);
  });

  it('一路走到出餐口前並擋住通道；任何人按住兩秒請他回座，安靜的時間一次比一次短', () => {
    const b = bench({ threats: true });
    openService(b);
    monster(b).enabled = false;
    isolate(b, []);
    b.run(GUEST.appearMs / 1000 + (GUEST.stepMs / 1000) * 8 + 2);
    expect(guest(b).idx).toBe(GUEST_SPOTS.length - 1);
    expect(director(b).blockers().some((x) => x.id === 'guest')).toBe(true);
    const [gx, gz] = [guest(b).x, guest(b).z];
    Object.assign(b.poses.P1, { x: gx + 1, z: gz + 0.6 });
    expect(b.sim.handle('P1', { stationId: 'guest', action: 'escort', requestId: 'e1' }).ok).toBe(true);
    b.run(2.1);
    expect(guest(b).idx).toBe(0);
    // 帶完位回廚房、背對餐廳（現在每個人都看得見，看著他他就不會動）
    Object.assign(b.poses.P1, { x: 0, z: 14, yaw: Math.PI });
    const calm1 = guest(b).calmUntil - b.sim.t;
    b.run(calm1 / 1000 + (GUEST.stepMs / 1000) * 2 + 1);
    expect(guest(b).idx).toBeGreaterThan(0);
    const g = guest(b);
    Object.assign(b.poses.P1, { x: g.x + 1, z: g.z + 0.3 });
    b.sim.handle('P1', { stationId: 'guest', action: 'escort', requestId: 'e2' });
    b.run(2.1);
    const calm2 = guest(b).calmUntil - b.sim.t;
    expect(calm2).toBeLessThan(calm1);
  });

  it('他不碰任何東西：廚房的狀態與他無關', () => {
    const b = bench({ threats: true });
    openService(b);
    monster(b).enabled = false;
    b.run(GUEST.appearMs / 1000 + (GUEST.stepMs / 1000) * 9);
    const s = b.sim.publicState();
    expect(Object.keys(s.items)).toHaveLength(0);
    expect(s.stations.pass.items).toHaveLength(0);
    const [fx, fz] = stationFront(STATION_BY_ID.pass, 0.5);
    expect(Math.hypot(guest(b).x - fx, guest(b).z - fz)).toBeLessThan(1.5);
  });
});

describe('怪物的進出規則：後門鎖、防火門驅趕、每次最多 60 秒', () => {
  it('每次最多待 60 秒（從進門算起）：剩 5 秒低吼預警，時間到從後門離開', () => {
    const b = bench({ threats: true });
    openService(b);
    isolate(b, []);
    const m = monster(b);
    m.hunger = 1e6;
    b.run(0.2);
    expect(m.mode).toBe('lurk');
    b.run(MONSTER.warnMs / 1000 + 0.2);
    expect(m.present).toBe(true);
    expect(m.public().kitchenLeft).toBeGreaterThan(MONSTER.stayMs - 500);
    b.run((MONSTER.stayMs - MONSTER.stayWarnMs) / 1000);
    expect(b.events.some((x) => x.e.kind === 'monster_sound' && /快要回後門外/.test(x.e.text ?? ''))).toBe(true);
    expect(m.mode).not.toBe('leave');
    b.run(MONSTER.stayWarnMs / 1000 + 0.3);
    expect(m.mode).toBe('leave');
    b.run(40);
    expect(m.mode).toBe('dormant');
  });

  it('鎖上後門（20 秒）：後門外的東西進不來；門一開就開始刮門；牠在裡面時鎖不了', () => {
    const b = bench({ threats: true });
    openService(b);
    isolate(b, []);
    expect(b.act('P2', 'cctv', 'back_door').ok).toBe(true);
    const m = monster(b);
    m.hunger = MONSTER.hungerEnter + 5;
    b.run(10);
    expect(m.mode).toBe('dormant');
    b.run(10.5);
    expect(m.mode).toBe('lurk');
    b.run(MONSTER.warnMs / 1000 + 0.2);
    expect(m.present).toBe(true);
    // 冷卻與防火門共用
    expect(b.act('P2', 'cctv', 'fire_door').ok).toBe(false);
    // 牠在裡面：鎖後門沒用（略過冷卻直接試）
    b.sim.fireDoor.readyAt = 0;
    expect(b.act('P3', 'cctv', 'back_door').message).toContain('已經在裡面');
  });

  it('防火門關著、牠在後走廊：走到門前撞門 2.5 秒（全隊聽得到），然後放棄離開', () => {
    const b = bench({ threats: true });
    openService(b);
    isolate(b, []);
    putMonster(b, 8.1, 23.0, Math.PI);
    expect(b.act('P2', 'cctv', 'fire_door').ok).toBe(true);
    b.run(0.2);
    const m = monster(b);
    expect(m.mode).toBe('bang');
    b.run(6);
    expect(b.events.some((x) => x.e.kind === 'monster_sound' && x.e.sound === 'door_slam')).toBe(true);
    expect(m.mode).toBe('leave');
    expect(m.hunger).toBeLessThan(0);
  });

  it('防火門關著、牠已經在廚房：沒有效果（只是擋住那條路）', () => {
    const b = bench({ threats: true });
    openService(b);
    isolate(b, []);
    putMonster(b, 0, 12, Math.PI);
    b.act('P2', 'cctv', 'fire_door');
    b.run(1);
    expect(monster(b).mode).not.toBe('bang');
  });
});
