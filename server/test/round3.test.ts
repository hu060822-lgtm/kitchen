import { describe, expect, it } from 'vitest';
import { RIFLE } from '@last-table/shared';
import { MONSTER, ThreatDirector } from '../src/kitchen/threats';
import { bench, type Bench } from './bench';

/** 第三輪回饋：左右手／菜籃自由切換、拿著盤子一次裝盤、後廚的來福槍 */

const director = (b: Bench) => b.sim.threats as ThreatDirector;
const swap = (b: Bench, r: 'P1' | 'P2' = 'P1') => b.sim.handle(r, { stationId: 'self', action: 'swap', args: {}, requestId: `sw${Math.random()}` });
const fire = (b: Bench, yaw?: number) => b.sim.handle('P1', { stationId: 'self', action: 'fire', args: yaw === undefined ? {} : { yaw }, requestId: `f${Math.random()}` });

function monsterIn(b: Bench, x: number, z: number): void {
  const m = director(b).monster;
  Object.assign(m, { enabled: true, mode: 'patrol', x, z, yaw: 0, path: [], modeSince: b.sim.t, kitchenLeft: MONSTER.stayMs });
  m.tune.speed = 0;
}

describe('左右手與菜籃自由切換', () => {
  it('空手也能換手；選了空著的手不會被自動換回去', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    const p = b.sim.players.P1;
    expect(p.side).toBe('R');
    expect(swap(b).ok).toBe(true);
    expect(p.side).toBe('L');
    b.act('P1', 'pantry', 'take', { type: 'onion' });
    expect(p.held?.kind).toBe('item');
    // 換到空著的右手：停在右手（不會因為右手空著又自動換回拿洋蔥的左手）
    expect(swap(b).ok).toBe(true);
    expect(p.side).toBe('R');
    expect(p.held).toBeNull();
    b.run(1);
    expect(p.side).toBe('R');
    expect(p.held).toBeNull();
    expect(p.other?.kind).toBe('item');
  });

  it('B 依序：這隻手 → 另一隻手 → 菜籃每一格（拿到手上）→ 回來；翻完東西都還在', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    const p = b.sim.players.P1;
    b.act('P1', 'pantry', 'take', { type: 'onion', count: 4 });
    // 拿 4 份：兩隻手＋菜籃 2 格
    expect(b.sim.carried('P1')).toBe(4);
    const before = JSON.stringify([p.held, p.other, [...p.basket].sort()]);
    const ids = new Set([p.held, p.other].map((h) => (h?.kind === 'item' ? h.id : '')).concat(p.basket));
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      expect(swap(b).ok).toBe(true);
      seen.push(p.held?.kind === 'item' ? p.held.id : '');
      // 不管翻到哪裡，總數不變
      expect(b.sim.carried('P1')).toBe(4);
    }
    // 第 2、3 次翻到菜籃的兩份
    expect(new Set(seen.slice(1, 3)).size).toBe(2);
    for (const id of seen) expect(ids.has(id)).toBe(true);
    // 回到起點
    expect(JSON.stringify([p.held, p.other, [...p.basket].sort()])).toBe(before);
  });

  it('翻到菜籃的那份拿去用掉：原本手上的留在菜籃裡', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    const p = b.sim.players.P1;
    b.act('P1', 'pantry', 'take', { type: 'onion', count: 3 });
    swap(b);
    swap(b); // 菜籃第 1 格到手上
    expect(p.browse).toBeTruthy();
    const using = p.held?.kind === 'item' ? p.held.id : '';
    expect(b.act('P1', 'prep_a', 'place').ok).toBe(true);
    expect(b.sim.stations.get('prep_a')!.items).toContain(using);
    expect(p.browse ?? null).toBeNull();
    expect(b.sim.carried('P1')).toBe(2);
  });
});

describe('拿著盤子一次裝盤', () => {
  it('平底鍋裡的兩份：拿著盤子按左鍵全部裝進盤子', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'egg' });
    b.act('P1', 'pan_a', 'place');
    b.act('P1', 'fridge', 'take', { type: 'egg' });
    b.act('P1', 'pan_a', 'place');
    expect(b.sim.stations.get('pan_a')!.items.length).toBe(2);
    expect(b.act('P1', 'plating', 'new_plate', { vessel: 'plate', hold: true }).ok).toBe(true);
    expect(b.sim.players.P1.held?.kind).toBe('plate');
    const r = b.act('P1', 'pan_a', 'quick', { mode: 'primary' });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('一次裝進');
    expect(b.sim.stations.get('pan_a')!.items.length).toBe(0);
    const plate = b.sim.plates.get((b.sim.players.P1.held as { id: string }).id)!;
    expect(plate.components.length).toBe(2);
  });

  it('成品架也可以；另一隻手拿著食材時，用盤子那隻手裝盤', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    b.act('P1', 'pantry', 'take', { type: 'onion', count: 2 });
    expect(b.act('P1', 'rack_veg', 'place_all').ok).toBe(true);
    b.act('P1', 'pantry', 'take', { type: 'potato' });
    b.act('P1', 'plating', 'new_plate', { vessel: 'plate', hold: true });
    expect(b.sim.players.P1.held?.kind).toBe('plate');
    expect(b.act('P1', 'rack_veg', 'plate_all').ok).toBe(true);
    expect(b.sim.stations.get('rack_veg')!.items.length).toBe(0);
    expect(b.sim.players.P1.other?.kind).toBe('item');
  });

  it('湯鍋：拿著碗按左鍵＝盛起來', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    b.act('P1', 'pantry', 'take', { type: 'stock' });
    b.act('P1', 'stove_a', 'place');
    b.act('P1', 'pantry', 'take', { type: 'potato' });
    b.act('P1', 'stove_a', 'place');
    b.act('P1', 'plating', 'new_plate', { vessel: 'bowl', hold: true });
    const r = b.act('P1', 'stove_a', 'quick', { mode: 'primary' });
    expect(r.ok).toBe(true);
    expect(b.sim.stations.get('stove_a')!.items.length).toBe(0);
    expect(b.sim.stations.get('stove_a')!.liquid).toBe(0);
  });
});

describe('後廚的來福槍', () => {
  it('雙手空著才能拿；拿了之後槍架上沒有、隊友拿不到；放回去之後又在', () => {
    const b = bench({ seats: ['P1', 'P2'], threats: true });
    b.open();
    b.act('P1', 'pantry', 'take', { type: 'onion' });
    expect(b.act('P1', 'gunrack', 'take').ok).toBe(false);
    b.act('P1', 'trash', 'discard');
    expect(b.act('P1', 'gunrack', 'quick', { mode: 'primary' }).ok).toBe(true);
    expect(b.sim.players.P1.held?.kind).toBe('rifle');
    expect(b.sim.publicState().rifle).toMatchObject({ ammo: RIFLE.ammo, holder: 'P1' });
    expect(b.act('P2', 'gunrack', 'take').ok).toBe(false);
    // 槍不能丟、不能換手
    expect(b.act('P1', 'trash', 'discard').ok).toBe(false);
    expect(swap(b).ok).toBe(false);
    expect(b.act('P1', 'gunrack', 'quick', { mode: 'primary' }).ok).toBe(true);
    expect(b.sim.publicState().rifle?.holder).toBeNull();
  });

  it('對準牠開槍：打中一次就把牠打退；一發用掉一顆子彈', () => {
    const b = bench({ seats: ['P1'], threats: true });
    b.open();
    b.act('P1', 'gunrack', 'take');
    monsterIn(b, 2, 12);
    // 站在 (6,12) 面向 -x（yaw = π/2）
    Object.assign(b.poses.P1, { x: 6, z: 12, yaw: Math.PI / 2 });
    const r = fire(b, Math.PI / 2);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('打中');
    expect(director(b).monster.mode).toBe('leave');
    expect(b.sim.rifleAmmo).toBe(RIFLE.ammo - 1);
    expect(b.events.some((x) => x.e.sound === 'gunshot')).toBe(true);
  });

  it('沒瞄準就打不中；牆後面打不到；子彈只有 4 發', () => {
    const b = bench({ seats: ['P1'], threats: true });
    b.open();
    b.act('P1', 'gunrack', 'take');
    monsterIn(b, 2, 12);
    Object.assign(b.poses.P1, { x: 6, z: 12, yaw: 0 });
    // 面向 -z：牠在左手邊
    expect(fire(b).message).toContain('沒打中');
    expect(director(b).monster.mode).not.toBe('leave');
    // 用戶端送來的朝向差太多：用伺服器的（還是沒對準）
    b.run(1);
    expect(fire(b, Math.PI / 2).message).toContain('沒打中');
    // 牆後面：牠在乾貨室，你在廚房
    b.run(1);
    monsterIn(b, 0, 22);
    Object.assign(b.poses.P1, { x: 0, z: 17, yaw: Math.PI });
    expect(fire(b, Math.PI).message).toContain('沒打中');
    b.run(1);
    expect(fire(b).ok).toBe(false);
    expect(b.sim.rifleAmmo).toBe(0);
    b.run(1);
    expect(fire(b).message).toContain('沒有子彈');
    // 子彈打完：放回去之後拿不起來
    b.act('P1', 'gunrack', 'return');
    expect(b.act('P1', 'gunrack', 'take').ok).toBe(false);
  });

  it('拿著槍被抓走：槍回到槍架', () => {
    const b = bench({ seats: ['P1', 'P2'], threats: true });
    b.open();
    b.act('P1', 'gunrack', 'take');
    b.sim.trap('P1');
    expect(b.sim.rifleHolder()).toBeNull();
    expect(b.act('P2', 'gunrack', 'take').ok).toBe(true);
  });

  it('連發有間隔', () => {
    const b = bench({ seats: ['P1'], threats: true });
    b.open();
    b.act('P1', 'gunrack', 'take');
    fire(b);
    expect(fire(b).message).toContain('拉槍機');
    expect(b.sim.rifleAmmo).toBe(RIFLE.ammo - 1);
  });
});
