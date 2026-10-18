import { describe, expect, it } from 'vitest';
import { BASKET_SLOTS, CARRY_MAX, RACK_CAPACITY, STATION_BY_ID } from '@last-table/shared';
import { STRUGGLE } from '../src/kitchen/sim';
import type { ThreatDirector } from '../src/kitchen/threats';
import { bench } from './bench';

/** 第一版試玩的回饋：自己掙脫鐵籠、一次拿多個食材、成品架（肉菜分開） */

describe('鐵籠：單人也能自己掙脫', () => {
  it('沒有隊友能救（單人）：按掙脫 7 秒後出來；過程很吵（怪物聽得到）', () => {
    const b = bench({ seats: ['P1'], threats: true });
    b.open();
    b.sim.trap('P1');
    expect(b.sim.canBeRescued('P1')).toBe(false);
    const r = b.sim.handle('P1', { stationId: 'cage', action: 'struggle', args: {}, requestId: 's1' });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('7 秒');
    const m = (b.sim.threats as ThreatDirector).monster;
    // 開始搖就有聲音（noise 進到怪物的佇列）
    expect((m as unknown as { noises: unknown[] }).noises.length).toBeGreaterThan(0);
    b.run(STRUGGLE.soloMs / 1000 - 0.5);
    expect(b.sim.status('P1')).toBe('trapped');
    b.run(0.7);
    expect(b.sim.status('P1')).toBe('ok');
    expect(b.sim.stats.escaped).toBe(1);
    expect(b.events.some((x) => x.e.kind === 'rescued' && x.e.text?.includes('自己掙脫'))).toBe(true);
  });

  it('有隊友時也能自己掙脫，只是比較慢（18 秒）；隊友先撬開就直接出來', () => {
    const b = bench();
    b.open();
    b.sim.trap('P2');
    expect(b.sim.canBeRescued('P2')).toBe(true);
    const r = b.sim.handle('P2', { stationId: 'cage', action: 'struggle', args: {}, requestId: 's2' });
    expect(r.message).toContain('18 秒');
    b.run(8);
    expect(b.sim.status('P2')).toBe('trapped');
    b.at('P3', 'cage');
    expect(b.act('P3', 'cage', 'rescue').ok).toBe(true);
    b.run(2.6);
    expect(b.sim.status('P2')).toBe('ok');
    expect(b.sim.players.P2.task).toBeNull();
    expect(b.sim.stats.escaped).toBe(0);
  });

  it('其他人都被抓了：剩下的人算「沒人能救」，用快的 7 秒', () => {
    const b = bench();
    b.open();
    b.sim.trap('P1');
    b.sim.trap('P2');
    b.sim.trap('P3');
    expect(b.sim.canBeRescued('P1')).toBe(false);
  });

  it('被關著時其他操作仍然擋下，訊息會說明可以自己掙脫', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    b.sim.trap('P1');
    const r = b.sim.handle('P1', { stationId: 'fridge', action: 'take', args: { type: 'egg' }, requestId: 'x' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('掙脫');
  });
});

describe('物品欄：左手、右手、菜籃 2 格', () => {
  it(`一次拿 3 顆蛋：目前的手 1、另一隻手 1、菜籃 1；最多帶 ${CARRY_MAX} 份`, () => {
    const b = bench();
    b.open();
    const r = b.act('P1', 'fridge', 'take', { type: 'egg', count: 3 });
    expect(r.ok).toBe(true);
    const p = b.sim.players.P1;
    expect(p.held?.kind).toBe('item');
    expect(p.other?.kind).toBe('item');
    expect(p.basket.length).toBe(1);
    // 再拿 3 份番茄：只放得下 1 份（菜籃第 2 格）
    const r2 = b.act('P1', 'fridge', 'take', { type: 'tomato', count: 3 });
    expect(r2.ok).toBe(true);
    expect(r2.message).toContain('放不下');
    expect(p.basket.length).toBe(BASKET_SLOTS);
    expect(b.act('P1', 'fridge', 'take', { type: 'tomato' }).ok).toBe(false);
  });

  it('用掉目前的手：先改用另一隻拿著東西的手；兩隻手都空了才從菜籃補', () => {
    const b = bench();
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'egg', count: 3 });
    const p = b.sim.players.P1;
    const side = p.side;
    expect(b.act('P1', 'prep_b', 'place').ok).toBe(true);
    // 換成另一隻拿著蛋的手（菜籃那份還在）
    expect(p.held?.kind).toBe('item');
    expect(p.other).toBeNull();
    expect(p.basket.length).toBe(1);
    expect(p.side).not.toBe(side);
    b.act('P1', 'prep_a', 'place');
    // 兩隻手都空了：菜籃那一份補到手上
    expect(p.held?.kind).toBe('item');
    expect(p.basket.length).toBe(0);
  });

  it('一隻手拿著盤子，另一隻手還能拿東西；動作要用的東西在另一隻手時自動換手', () => {
    const b = bench();
    b.open();
    expect(b.act('P1', 'plating', 'new_plate', { vessel: 'plate', hold: true }).ok).toBe(true);
    expect(b.act('P1', 'fridge', 'take', { type: 'tomato' }).ok).toBe(true);
    const p = b.sim.players.P1;
    expect(p.held?.kind).toBe('plate');
    expect(p.other?.kind).toBe('item');
    // 放上砧板：用拿著番茄的那隻手
    expect(b.act('P1', 'prep_b', 'place').ok).toBe(true);
    expect(p.held?.kind).toBe('plate');
    expect(p.other).toBeNull();
    // 兩隻手都滿才拿不下
    b.act('P1', 'fridge', 'take', { type: 'egg' });
    expect(b.act('P1', 'prep_b', 'pick').ok).toBe(false);
  });

  it('換手：兩隻手都有東西時對調；貨箱要用雙手', () => {
    const b = bench();
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'egg', count: 2 });
    const p = b.sim.players.P1;
    const before = JSON.stringify(p.held);
    const side = p.side;
    expect(b.sim.handle('P1', { stationId: 'self', action: 'swap', args: {}, requestId: 'sw1' }).ok).toBe(true);
    expect(JSON.stringify(p.other)).toBe(before);
    expect(p.side).not.toBe(side);
    // 手上有東西不能搬貨箱
    const d = b.sim.stations.get('delivery')!;
    d.crate = 'FRIDGE';
    expect(b.act('P1', 'delivery', 'take_crate').message).toContain('雙手');
  });

  it('單手廚師只有一隻手：拿 3 份＝手上 1、菜籃 2', () => {
    const b = bench({ flaws: { P1: 'D09' } });
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'egg', count: 3 });
    const p = b.sim.players.P1;
    expect(p.held?.kind).toBe('item');
    expect(p.other).toBeNull();
    expect(p.basket.length).toBe(2);
  });

  it('全部放回架上（兩隻手與菜籃裡屬於這個架子的原料）', () => {
    const b = bench();
    b.open();
    b.act('P1', 'pantry', 'take', { type: 'onion', count: 3 });
    expect(b.act('P1', 'pantry', 'store_all').ok).toBe(true);
    const p = b.sim.players.P1;
    expect(p.held).toBeNull();
    expect(p.other).toBeNull();
    expect(p.basket.length).toBe(0);
  });

  it('公開狀態帶著兩隻手與菜籃（介面顯示用）', () => {
    const b = bench();
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'egg', count: 3 });
    const me = b.sim.publicState().players.P1!;
    expect(me.other?.kind).toBe('item');
    expect(me.basket.length).toBe(1);
    expect(['L', 'R']).toContain(me.side);
  });
});

describe('成品架：處理好的食材暫放，肉與菜分開', () => {
  it('兩個成品架都在中島旁的廚房裡', () => {
    expect(STATION_BY_ID.rack_meat.zone).toBe('KITCHEN');
    expect(STATION_BY_ID.rack_veg.zone).toBe('KITCHEN');
  });

  it('肉只能放肉類架；蔬菜不能放肉類架', () => {
    const b = bench();
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'chicken' });
    expect(b.act('P1', 'rack_veg', 'place').ok).toBe(false);
    expect(b.act('P1', 'rack_meat', 'place').ok).toBe(true);
    b.act('P1', 'fridge', 'take', { type: 'tomato' });
    expect(b.act('P1', 'rack_meat', 'place').ok).toBe(false);
    expect(b.act('P1', 'rack_veg', 'place').ok).toBe(true);
    expect(b.sim.publicState().stations.rack_meat.items.length).toBe(1);
    // 拿起來
    expect(b.act('P2', 'rack_veg', 'pick').ok).toBe(true);
    expect(b.sim.players.P2.held?.kind).toBe('item');
  });

  it(`全部放上去：只放適合的，其他留在手上；容量 ${RACK_CAPACITY}`, () => {
    const b = bench();
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'egg', count: 2 });
    b.act('P1', 'fridge', 'take', { type: 'chicken', count: 2 });
    const r = b.act('P1', 'rack_veg', 'place_all');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('2 份不屬於');
    expect(b.sim.publicState().stations.rack_veg.items.length).toBe(2);
    expect(b.act('P1', 'rack_meat', 'place_all').ok).toBe(true);
    expect(b.sim.players.P1.held).toBeNull();
  });
});

describe('定時噴嚏：時間跳過一大段時不會連打', () => {
  it('跳過備料（時鐘一下子前進很多）之後，一秒內最多打一個噴嚏', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D16' }, prepMs: 300_000 });
    b.open();
    b.run(1);
    const sneezes = b.events.filter((x) => x.e.visual === 'sneeze' && x.to === 'P1');
    expect(sneezes.length).toBeLessThanOrEqual(1);
  });
});
