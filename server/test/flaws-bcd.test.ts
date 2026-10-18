import { describe, expect, it } from 'vitest';
import {
  CUT_STROKES,
  DEFAULT_FLAW_CONFIG,
  FLAW_IDS,
  PLAYER_RADIUS,
  SPAWNS,
  STATIONS,
  buildColliders,
  flawRadius,
  flawSpeedMultiplier,
  flawZoneBlocked,
  hitsAny,
  mergeFlawConfig,
  moveWithCollision,
  openDoors,
  stationFront,
  zoneAt,
  type FlawId,
  type KitchenEvent,
  type Seat,
} from '@last-table/shared';
import { DISH_RETURN_MS } from '../src/kitchen/sim';
import { scorePlate } from '../src/kitchen/scoring';
import { bench, chop, cookEggToast, serveFirst, steady, type Bench } from './bench';

/* ------------------------------ 共用 ------------------------------ */

const privateOf = (b: Bench, s: Seat) => b.sim.flaws.privateFor(s)!;
const coopPub = (b: Bench) => b.sim.publicState().coop;
const held = (b: Bench, s: Seat) => b.sim.players[s].held;
const taskMs = (b: Bench, s: Seat): number => {
  const t = b.sim.players[s].task!;
  return t.endsAt - t.startedAt;
};
const near = (b: Bench, a: Seat, other: Seat, d = 1.0): void => {
  Object.assign(b.poses[other], { x: b.poses[a].x + d, z: b.poses[a].z, yaw: 0 });
};
const eventsTo = (b: Bench, s: Seat) => b.events.filter((x) => x.to === s || x.to === 'all').map((x) => x.e);
const deliveredTo = (b: Bench, s: Seat, from = 0): KitchenEvent[] =>
  b.events
    .slice(from)
    .filter((x) => x.to === s || x.to === 'all')
    .map((x) => b.sim.flaws.filterEvent(s, x.e))
    .filter((e): e is KitchenEvent => !!e && !!(e.text || e.sound || e.visual));
function openUntil(b: Bench, recipeId: string): void {
  b.open();
  for (let i = 0; i < 400 && !b.sim.orders.some((o) => o.status === 'open' && o.recipeId === recipeId); i++) b.run(1);
}
const take = (b: Bench, s: Seat, type: string) => b.act(s, ['egg', 'butter', 'tomato', 'chicken', 'mushroom', 'scallion', 'chili'].includes(type) ? 'fridge' : 'pantry', 'take', { type });
const setSpeed = (b: Bench, s: Seat, speed: number) => (b.poses[s].speed = speed);

/* ============================== Phase B ============================== */

describe('D06 奶油手', () => {
  it('補償：切菜少三分之一的刀數、削皮快 50%', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D06', P2: 'D04' } });
    b.open();
    take(b, 'P1', 'onion');
    b.act('P1', 'prep_b', 'place');
    expect(b.act('P1', 'prep_b', 'peel').ok).toBe(true);
    expect(taskMs(b, 'P1')).toBe(1250);
    b.run(1.3);
    const r = b.act('P1', 'prep_b', 'chop_start', { cut: 'DICED' });
    expect(r.need).toBe(Math.ceil(CUT_STROKES.DICED / 1.5));
    expect(r.need).toBeLessThan(CUT_STROKES.DICED);
  });

  it('失衡有挽救窗口：停下來就穩住，不會掉；靜止與交接永遠安全', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D06', P2: 'D04' } });
    b.open();
    take(b, 'P1', 'tomato');
    // 靜止：不會失衡
    b.sim.flaws.onMove('P1', 0, 0);
    expect(privateOf(b, 'P1').wobble).toBeFalsy();
    // 奔跑：失衡（不是馬上掉）
    setSpeed(b, 'P1', 4.2);
    b.sim.flaws.onMove('P1', 4.2, 0);
    const w = privateOf(b, 'P1').wobble!;
    expect(w.cause).toBe('run');
    expect(w.until - b.sim.t).toBe(DEFAULT_FLAW_CONFIG.D06.windowMs);
    expect(coopPub(b).wobbles.map((x) => x.seat)).toEqual(['P1']);
    expect(eventsTo(b, 'P1').some((e) => e.visual === 'wobble' && e.critical)).toBe(true);
    // 停下來（0.45 秒沒有移動＝靜止）再撐 0.35 秒：穩住
    setSpeed(b, 'P1', 0);
    b.run(1.0);
    expect(privateOf(b, 'P1').wobble).toBeFalsy();
    expect(held(b, 'P1')?.kind).toBe('item');
    expect(coopPub(b).floor).toHaveLength(0);
  });

  it('沒救回來才會掉：掉在地上的生食材撿起來要重新洗；按 X 穩住有冷卻', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D06', P2: 'D04' } });
    b.open();
    take(b, 'P1', 'tomato');
    const id = (held(b, 'P1') as { id: string }).id;
    setSpeed(b, 'P1', 4.2);
    // 一直跑：挽救窗口結束就掉
    for (let i = 0; i < 17; i++) {
      b.sim.flaws.onMove('P1', 4.2, 0);
      b.run(0.1);
    }
    expect(held(b, 'P1')).toBeNull();
    const floor = coopPub(b).floor;
    expect(floor).toHaveLength(1);
    expect(b.sim.items.get(id)!.floorDirty).toBe(true);
    // 隊友撿起來（潔癖主廚以外的人都可以）
    Object.assign(b.poses.P2, { x: floor[0].x + 0.5, z: floor[0].z });
    expect(b.coop('P2', 'pickup', { floorId: floor[0].id }).ok).toBe(true);
    expect(held(b, 'P2')).toEqual({ kind: 'item', id });
    // 重新洗乾淨
    b.act('P2', 'sink', 'place');
    expect(b.act('P2', 'sink', 'wash').ok).toBe(true);
    b.run(2.1);
    expect(b.sim.items.get(id)!.floorDirty).toBe(false);
    // X 穩住：可以用，但有冷卻
    take(b, 'P1', 'egg');
    b.run(3);
    setSpeed(b, 'P1', 2.0);
    b.sim.flaws.onMove('P1', 2.0, 6);
    b.sim.flaws.onMove('P1', 2.0, 6); // 轉向角速度有平滑：要持續急轉才算
    b.sim.flaws.onMove('P1', 2.0, 6);
    expect(privateOf(b, 'P1').wobble?.cause).toBe('turn');
    expect(b.coop('P1', 'grip').ok).toBe(true);
    expect(privateOf(b, 'P1').wobble).toBeFalsy();
    b.run(3);
    b.sim.flaws.onMove('P1', 2.0, 6);
    b.sim.flaws.onMove('P1', 2.0, 6);
    expect(b.coop('P1', 'grip').ok).toBe(false);
  });

  it('互助：隊友在範圍內接住失衡的東西（東西真的換手）；太遠接不到', () => {
    const b = bench({ seats: ['P1', 'P2', 'P3'], flaws: { P1: 'D06', P2: 'D04', P3: 'D02' } });
    b.open();
    take(b, 'P1', 'egg');
    const h = held(b, 'P1');
    setSpeed(b, 'P1', 4.5);
    b.sim.flaws.onMove('P1', 4.5, 0);
    near(b, 'P1', 'P3', 3.5);
    expect(b.coop('P3', 'catch', { to: 'P1' }).ok).toBe(false);
    near(b, 'P1', 'P2', 1.2);
    expect(b.coop('P2', 'catch', { to: 'P1' }).ok).toBe(true);
    expect(held(b, 'P2')).toEqual(h);
    expect(held(b, 'P1')).toBeNull();
    expect(privateOf(b, 'P1').wobble).toBeFalsy();
    expect(b.sim.flaws.telemetrySnapshot().D06!.coopOk).toBeGreaterThan(0);
  });

  it('掉在地上的菜：食品安全上限 30（照樣有原因說明）', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D04' } });
    openUntil(b, 'egg_toast');
    cookEggToast(b, 'P1');
    const plateId = (held(b, 'P1') as { id: string }).id;
    const plate = b.sim.plates.get(plateId)!;
    plate.components[0].floorDirty = true;
    const order = b.sim.orders.find((o) => o.status === 'open' && o.recipeId === 'egg_toast')!;
    const r = scorePlate(plate, order, b.sim.t, 'P1');
    expect(r.cap?.max).toBe(30);
    expect(r.reasons.some((x) => x.text.includes('掉在地上'))).toBe(true);
  });

  it('單人可以完成煎蛋吐司（≥ 90 分）', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D06' } });
    openUntil(b, 'egg_toast');
    cookEggToast(b, 'P1');
    expect(serveFirst(b, 'P1', 'egg_toast').result!.total).toBeGreaterThanOrEqual(90);
  });

  it('效果可調：挽救窗口可以用設定改', () => {
    const cfg = mergeFlawConfig(DEFAULT_FLAW_CONFIG, { D06: { windowMs: 3000 } });
    const b = bench({ seats: ['P1'], flaws: { P1: 'D06' }, flawConfig: cfg });
    b.open();
    take(b, 'P1', 'egg');
    b.sim.flaws.onMove('P1', 4.5, 0);
    expect(privateOf(b, 'P1').wobble!.until - b.sim.t).toBe(3000);
  });
});

describe('D09 單手廚師', () => {
  it('雙手工序（打蛋）：自己做會被擋下並說明怎麼解；隊友扶穩就能做', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D09', P2: 'D04' } });
    b.open();
    take(b, 'P1', 'egg');
    b.act('P1', 'prep_b', 'place');
    const r = b.act('P1', 'prep_b', 'chop_start', { cut: 'BEATEN' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('雙手');
    b.at('P2', 'prep_b');
    expect(b.coop('P2', 'steady', { stationId: 'prep_b' }).ok).toBe(true);
    expect(coopPub(b).steadies).toHaveLength(1);
    expect(b.act('P1', 'prep_b', 'chop_start', { cut: 'BEATEN' }).ok).toBe(true);
    expect(coopPub(b).steadies).toHaveLength(0); // 用掉了
  });

  it('扶的人走開就放手（不會被綁住）；扶穩 8 秒後失效', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D09', P2: 'D04' } });
    b.open();
    b.at('P2', 'prep_b');
    b.coop('P2', 'steady', { stationId: 'prep_b' });
    Object.assign(b.poses.P2, { x: -5, z: 12 });
    b.run(0.2);
    expect(coopPub(b).steadies).toHaveLength(0);
    b.at('P2', 'prep_b');
    b.coop('P2', 'steady', { stationId: 'prep_b' });
    b.run(8.2);
    expect(coopPub(b).steadies).toHaveLength(0);
  });

  it('單人自救：用夾具固定（4 秒）之後 20 秒內可以打蛋、盛湯', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D09' } });
    b.open();
    take(b, 'P1', 'egg');
    b.act('P1', 'prep_b', 'place');
    expect(b.act('P1', 'prep_b', 'clamp').ok).toBe(true);
    expect(taskMs(b, 'P1')).toBe(4000);
    b.run(4.1);
    expect(privateOf(b, 'P1').clamps!.prep_b).toBeGreaterThan(b.sim.t);
    expect(b.act('P1', 'prep_b', 'chop_start', { cut: 'BEATEN' }).ok).toBe(true);
    b.run(21);
    expect(privateOf(b, 'P1').clamps!.prep_b).toBeUndefined();
  });

  it('補償：清洗、擦砧板快 30%；一般操作（切丁）不受影響', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D09' } });
    b.open();
    take(b, 'P1', 'tomato');
    b.act('P1', 'sink', 'place');
    b.act('P1', 'sink', 'wash');
    expect(taskMs(b, 'P1')).toBe(1400);
    b.run(1.5);
    b.act('P1', 'sink', 'pick');
    b.act('P1', 'prep_b', 'place');
    expect(b.act('P1', 'prep_b', 'chop_start', { cut: 'DICED' }).need).toBe(CUT_STROKES.DICED);
  });

  it('單人可以完成煎蛋吐司（≥ 90 分）', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D09' } });
    openUntil(b, 'egg_toast');
    cookEggToast(b, 'P1');
    expect(serveFirst(b, 'P1', 'egg_toast').result!.total).toBeGreaterThanOrEqual(90);
  });
});

describe('D10 怕火廚師', () => {
  it('不能直接操作火源；戴手套（3 秒）後 30 秒內可以，但不能開大火', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D10' } });
    b.open();
    const r = b.act('P1', 'pan_a', 'heat', { level: 'MED' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('怕火');
    expect(b.act('P1', 'pan_a', 'glove').ok).toBe(true);
    b.run(3.1);
    expect(privateOf(b, 'P1').gloveUntil).toBeGreaterThan(b.sim.t);
    expect(b.act('P1', 'pan_a', 'heat', { level: 'HIGH' }).ok).toBe(false);
    expect(b.act('P1', 'pan_a', 'heat', { level: 'MED' }).ok).toBe(true);
    b.run(30);
    expect(b.act('P1', 'pan_a', 'heat', { level: 'OFF' }).ok).toBe(false);
  });

  it('補償：一次量兩種調味料、一次倒完；其他卡不行', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D10', P2: 'D04' } });
    b.open();
    b.act('P1', 'plating', 'new_plate', { vessel: 'plate' });
    const plateId = b.sim.publicState().stations.plating.plates[0];
    expect(b.act('P1', 'spice', 'measure', { seasoning: 'sugar', units: 0.5, seasoning2: 'vinegar', units2: 1 }).ok).toBe(true);
    expect(b.act('P1', 'plating', 'pour', { plateId }).ok).toBe(true);
    expect(b.sim.plates.get(plateId)!.seasoning).toEqual({ sugar: 0.5, vinegar: 1 });
    expect(b.act('P2', 'spice', 'measure', { seasoning: 'sugar', units: 0.5, seasoning2: 'vinegar', units2: 1 }).ok).toBe(false);
  });

  it('補償：清洗、削皮快 20%、切菜少 1 刀', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D10' } });
    b.open();
    take(b, 'P1', 'onion');
    b.act('P1', 'prep_b', 'place');
    b.act('P1', 'prep_b', 'peel');
    expect(taskMs(b, 'P1')).toBe(2000);
    b.run(2.1);
    expect(b.act('P1', 'prep_b', 'chop_start', { cut: 'SLICED' }).need).toBe(CUT_STROKES.SLICED - 1);
  });

  it('單人：冷盤（酸甜番茄）不碰火就能做好；熱菜靠手套自救', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D10' }, schedule: [{ at: 1, kind: 'free', requestId: 'sour_sweet', table: 1 }] });
    b.open();
    b.run(2);
    take(b, 'P1', 'tomato');
    b.act('P1', 'sink', 'place');
    b.act('P1', 'sink', 'wash');
    b.run(1.7);
    b.act('P1', 'sink', 'pick');
    b.act('P1', 'prep_b', 'place');
    expect(chop(b, 'P1', 'prep_b', 'DICED', steady(CUT_STROKES.DICED - 1)).ok).toBe(true);
    b.act('P1', 'prep_b', 'pick');
    b.act('P1', 'plating', 'new_plate', { vessel: 'plate' });
    const plateId = b.sim.publicState().stations.plating.plates[0];
    b.act('P1', 'plating', 'add', { plateId });
    b.act('P1', 'spice', 'measure', { seasoning: 'sugar', units: 1, seasoning2: 'vinegar', units2: 1 });
    b.act('P1', 'plating', 'pour', { plateId });
    b.act('P1', 'plating', 'pick', { plateId });
    const r = serveFirst(b, 'P1');
    expect(r.ok).toBe(true);
    expect(r.result!.total).toBeGreaterThanOrEqual(80);
  });

  it('單人可以完成煎蛋吐司（手套）', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D10' } });
    openUntil(b, 'egg_toast');
    cookEggToast(b, 'P1');
    expect(serveFirst(b, 'P1', 'egg_toast').result!.total).toBeGreaterThanOrEqual(90);
  });
});

describe('碗盤循環（所有人）與 D11 潔癖主廚', () => {
  it('出餐後 25 秒髒盤回到回收窗口；拿去水槽洗好就回到裝盤區', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D04' } });
    openUntil(b, 'egg_toast');
    const start = b.sim.dishState().clean.plate;
    cookEggToast(b, 'P1');
    expect(b.sim.dishState().clean.plate).toBe(start - 1);
    serveFirst(b, 'P1', 'egg_toast');
    b.run(DISH_RETURN_MS / 1000 - 1);
    expect(b.sim.dishState().back.plate).toBe(0);
    b.run(1.2);
    expect(b.sim.dishState().back.plate).toBe(1);
    expect(b.act('P1', 'dish_return', 'take').ok).toBe(true);
    expect(held(b, 'P1')).toEqual({ kind: 'dirty', plate: 1, bowl: 0 });
    expect(b.act('P1', 'sink', 'load').ok).toBe(true);
    expect(b.act('P1', 'sink', 'wash_dishes').ok).toBe(true);
    b.run(1.6);
    expect(b.sim.dishState().clean.plate).toBe(start);
  });

  it('沒有乾淨的盤子時拿不到新盤子（並說明怎麼解）；丟掉的菜盤子也會送去回收窗口', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D04' }, dishes: { plate: 1, bowl: 0 } });
    b.open();
    expect(b.act('P1', 'plating', 'new_plate', { vessel: 'plate', hold: true }).ok).toBe(true);
    const r = b.act('P1', 'plating', 'new_plate', { vessel: 'plate' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('洗');
    expect(b.act('P1', 'trash', 'discard').ok).toBe(true);
    expect(b.sim.dishState().back.plate).toBe(1);
  });

  it('D11：回收窗口要用托盤（2.5 秒、一次 6 個）；丟垃圾要踩踏板；地上的東西不撿', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D11', P2: 'D04' } });
    b.open();
    b.sim.stations.get('dish_return')!.dirty = { plate: 5, bowl: 2 };
    const r = b.act('P1', 'dish_return', 'take');
    expect(r.ok).toBe(true);
    expect(b.sim.players.P1.task?.kind).toBe('tray');
    b.run(2.6);
    expect(held(b, 'P1')).toEqual({ kind: 'dirty', plate: 5, bowl: 1, tray: true });
    // 其他人徒手最多 4 個
    b.sim.stations.get('dish_return')!.dirty = { plate: 6, bowl: 0 };
    b.act('P2', 'dish_return', 'take');
    expect(held(b, 'P2')).toEqual({ kind: 'dirty', plate: 4, bowl: 0 });
    // 丟垃圾：踩踏板
    b.act('P1', 'sink', 'load');
    take(b, 'P1', 'bread');
    b.act('P1', 'trash', 'discard');
    expect(b.sim.players.P1.task?.kind).toBe('pedal');
    b.run(1.3);
    expect(held(b, 'P1')).toBeNull();
  });

  it('D11 補償：洗碗、擦砧板快一倍；隊友把髒盤放上碗盤架，他直接洗', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D11', P2: 'D04' } });
    b.open();
    b.sim.stations.get('dish_return')!.dirty = { plate: 4, bowl: 0 };
    b.act('P2', 'dish_return', 'take');
    b.act('P2', 'sink', 'load');
    b.act('P1', 'sink', 'wash_dishes');
    expect(taskMs(b, 'P1')).toBe(Math.round(4 * 700 * 0.5));
    b.run(1.5);
    expect(b.sim.dishState().rack.plate).toBe(0);
    b.act('P1', 'prep_a', 'wipe');
    expect(taskMs(b, 'P1')).toBe(1000);
  });

  it('D11：不在沒擦的砧板上做事；有人要在髒砧板上切生菜時提早收到警告；不接徒手遞來的髒盤', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D11', P2: 'D04' } });
    b.open();
    take(b, 'P2', 'chicken');
    b.act('P2', 'prep_a', 'place');
    chop(b, 'P2', 'prep_a', 'DICED', steady(CUT_STROKES.DICED));
    b.act('P2', 'prep_a', 'pick');
    b.act('P2', 'trash', 'discard');
    expect(b.sim.publicState().stations.prep_a.contaminated).toBe(true);
    take(b, 'P1', 'tomato');
    const r = b.act('P1', 'prep_a', 'place');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('擦');
    b.act('P1', 'fridge', 'store');
    take(b, 'P2', 'tomato');
    b.act('P2', 'prep_a', 'place');
    expect(privateOf(b, 'P1').hints!.some((h) => h.kind === 'contamination' && h.text.includes('番茄'))).toBe(true);
    // 徒手遞髒盤：拒絕
    b.act('P2', 'prep_a', 'pick');
    b.act('P2', 'trash', 'discard');
    b.sim.stations.get('dish_return')!.dirty = { plate: 1, bowl: 0 };
    b.act('P2', 'dish_return', 'take');
    near(b, 'P2', 'P1', 1);
    const offer = b.coop('P2', 'handoff', { to: 'P1' });
    expect(offer.ok).toBe(true);
    const id = coopPub(b).handoffs[0].id;
    expect(b.coop('P1', 'handoff_accept', { offerId: id }).ok).toBe(false);
  });

  it('單人可以完成煎蛋吐司（≥ 90 分）', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D11' } });
    openUntil(b, 'egg_toast');
    cookEggToast(b, 'P1');
    expect(serveFirst(b, 'P1', 'egg_toast').result!.total).toBeGreaterThanOrEqual(90);
  });
});

/* ============================== Phase C ============================== */

/** 從出生點出發，在網格上找得到路到每個工作站前方（實際的碰撞與半徑） */
function reachable(flaw: FlawId | null): Set<string> {
  const boxes = buildColliders(openDoors(), [], flaw);
  const r = flawRadius(flaw, DEFAULT_FLAW_CONFIG, PLAYER_RADIUS);
  const step = 0.2;
  const key = (x: number, z: number) => `${Math.round(x / step)},${Math.round(z / step)}`;
  const start: [number, number] = [SPAWNS.P1.pos[0], SPAWNS.P1.pos[2]];
  const seen = new Set<string>([key(...start)]);
  const queue: Array<[number, number]> = [start];
  while (queue.length) {
    const [x, z] = queue.shift()!;
    for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const nx = x + dx;
      const nz = z + dz;
      const k = key(nx, nz);
      if (seen.has(k) || nx < -9.4 || nx > 9.4 || nz < 0.1 || nz > 27.4) continue;
      if (hitsAny(nx, nz, r, boxes)) continue;
      if (flawZoneBlocked(flaw, zoneAt(x, z)?.id ?? null, zoneAt(nx, nz)?.id ?? null)) continue;
      seen.add(k);
      queue.push([nx, nz]);
    }
  }
  const out = new Set<string>();
  for (const s of STATIONS) {
    const [fx, fz] = stationFront(s, 0.75);
    // 附近 0.3 m 內有任何一格到得了就算
    for (const [dx, dz] of [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]]) if (seen.has(key(fx + dx, fz + dz))) out.add(s.id);
  }
  return out;
}

describe('地圖與移動（Phase C）', () => {
  it('每張卡都到得了所有工作站（幽閉外場除了冷藏室裡的冷藏架與鐵籠）：狹窄通道都有替代路線', () => {
    for (const flaw of [null, ...FLAW_IDS] as Array<FlawId | null>) {
      const got = reachable(flaw);
      const expected = STATIONS.filter((s) => !(flaw === 'D12' && s.zone === 'COLD')).map((s) => s.id);
      for (const id of expected) expect(got.has(id), `${flaw ?? '一般'} 到不了 ${id}`).toBe(true);
    }
  });

  it('D07 巨人：過不了低門楣（實際碰撞），一般人過得去；搬貨箱快 25%', () => {
    const through = (flaw: FlawId | null) => {
      const r = moveWithCollision(4.7, 18.3, 4.7, 20.2, buildColliders(openDoors(), [], flaw), flawRadius(flaw, DEFAULT_FLAW_CONFIG, PLAYER_RADIUS));
      return !r.blocked;
    };
    expect(through(null)).toBe(true);
    expect(through('D08')).toBe(true);
    expect(through('D07')).toBe(false);
    expect(flawSpeedMultiplier('D07', 'KITCHEN', 'crate', DEFAULT_FLAW_CONFIG)).toBe(1.25);
    expect(flawSpeedMultiplier('D07', 'KITCHEN', 'item', DEFAULT_FLAW_CONFIG)).toBe(1);
  });

  it('D08 小矮人：鑽得過冷藏室與乾貨室之間的窄縫（別人與怪物都過不去）', () => {
    const through = (flaw: FlawId | null) => {
      const r = moveWithCollision(-3.6, 21.35, -2.0, 21.35, buildColliders(openDoors(), [], flaw), flawRadius(flaw, DEFAULT_FLAW_CONFIG, PLAYER_RADIUS));
      return !r.blocked;
    };
    expect(through('D08')).toBe(true);
    expect(through(null)).toBe(false);
    expect(through('D07')).toBe(false);
  });

  it('最上層的存貨：一般人踩踏凳 1.5 秒、巨人伸手就拿、小矮人拿不到', () => {
    const b = bench({ seats: ['P1', 'P2', 'P3'], flaws: { P1: 'D07', P2: 'D08', P3: 'D04' } });
    b.open();
    const high = () => b.sim.publicState().stations.fridge.high!.egg!;
    const h0 = high();
    expect(h0).toBeGreaterThan(0);
    expect(b.act('P1', 'fridge', 'take_high', { type: 'egg' }).ok).toBe(true);
    expect(held(b, 'P1')?.kind).toBe('item');
    expect(high()).toBe(h0 - 1);
    const r = b.act('P2', 'fridge', 'take_high', { type: 'egg' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('搆不到');
    expect(b.act('P3', 'fridge', 'take_high', { type: 'egg' }).ok).toBe(true);
    expect(b.sim.players.P3.task?.kind).toBe('stool');
    expect(taskMs(b, 'P3')).toBe(1500);
    b.run(1.6);
    expect(held(b, 'P3')?.kind).toBe('item');
    expect(high()).toBe(h0 - 2);
  });

  it('D08：看不到湯鍋裡面；墊腳看一下（1 秒）之後 12 秒看得到；其他人一直看得到', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D08', P2: 'D04' } });
    b.open();
    take(b, 'P2', 'onion');
    b.act('P2', 'stove_a', 'place');
    const pub = b.sim.publicState().stations;
    expect(b.sim.flaws.stationsFor('P2', pub).stove_a.items).toHaveLength(1);
    expect(b.sim.flaws.stationsFor('P1', pub).stove_a).toMatchObject({ hidden: true, items: [] });
    expect(b.act('P1', 'stove_a', 'peek').ok).toBe(true);
    b.run(1.1);
    expect(b.sim.flaws.stationsFor('P1', b.sim.publicState().stations).stove_a.items).toHaveLength(1);
    b.run(12.2);
    expect(b.sim.flaws.stationsFor('P1', b.sim.publicState().stations).stove_a.hidden).toBe(true);
  });

  it('D12 幽閉外場：走不進冷藏室（但走得出來）、不躲置物櫃；在廚房交接距離 2.6 m、移動快 15%', () => {
    expect(flawZoneBlocked('D12', 'KITCHEN', 'COLD')).toBe(true);
    expect(flawZoneBlocked('D12', 'COLD', 'KITCHEN')).toBe(false);
    expect(flawZoneBlocked('D12', 'COLD', 'COLD')).toBe(false);
    expect(flawZoneBlocked('D04', 'KITCHEN', 'COLD')).toBe(false);
    expect(flawSpeedMultiplier('D12', 'KITCHEN', null, DEFAULT_FLAW_CONFIG)).toBe(1.15);
    expect(flawSpeedMultiplier('D12', 'DRY', null, DEFAULT_FLAW_CONFIG)).toBe(1);
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D12', P2: 'D04' } });
    b.open();
    expect(b.act('P1', 'locker_k', 'hide').ok).toBe(false);
    take(b, 'P2', 'egg');
    Object.assign(b.poses.P2, { x: 0, z: 12 });
    Object.assign(b.poses.P1, { x: 2.4, z: 12 });
    expect(b.coop('P2', 'handoff', { to: 'P1' }).ok).toBe(true);
    expect(b.coop('P1', 'handoff_accept', { offerId: coopPub(b).handoffs[0].id }).ok).toBe(true);
  });

  it('交接架：任何人都能放、拿（食材與盤子），最多 4 樣', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D04', P2: 'D12' } });
    b.open();
    take(b, 'P1', 'egg');
    expect(b.act('P1', 'shelf_cold', 'place').ok).toBe(true);
    expect(b.act('P2', 'shelf_cold', 'pick').ok).toBe(true);
    expect(held(b, 'P2')?.kind).toBe('item');
  });

  it('D13 暴衝快遞：伺服器允許的速度上限 1.4 倍（實際速度由慣性模型決定）', () => {
    expect(flawSpeedMultiplier('D13', 'KITCHEN', null, DEFAULT_FLAW_CONFIG)).toBe(1.4);
    const cfg = mergeFlawConfig(DEFAULT_FLAW_CONFIG, { D13: { maxMult: 1.2 } });
    expect(flawSpeedMultiplier('D13', 'DINING', 'plate', cfg)).toBe(1.2);
  });

  it('任何人都能在地上畫路線箭頭（30 秒、每人最多 4 個、只能畫在身邊）', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D04', P2: 'D13' } });
    b.open();
    const { x, z } = b.poses.P1;
    for (let i = 0; i < 5; i++) expect(b.coop('P1', 'route', { x, z: z - i * 0.5, yaw: 0 }).ok).toBe(true);
    expect(coopPub(b).routes).toHaveLength(4);
    expect(b.coop('P1', 'route', { x: x + 8, z, yaw: 0 }).ok).toBe(false);
    b.run(30.2);
    expect(coopPub(b).routes).toHaveLength(0);
  });

  it('單人可以完成煎蛋吐司：D07、D08、D12（隊友不在時用送貨補冷藏室的料）、D13', () => {
    for (const flaw of ['D07', 'D08', 'D13'] as FlawId[]) {
      const b = bench({ seats: ['P1'], flaws: { P1: flaw } });
      openUntil(b, 'egg_toast');
      cookEggToast(b, 'P1');
      expect(serveFirst(b, 'P1', 'egg_toast').result!.total).toBeGreaterThanOrEqual(90);
    }
  });
});

/* ============================== Phase D ============================== */

describe('D05 大嗓門', () => {
  it('召集：全隊不論距離都收到（危險等級、附位置）；身邊 6 m 內 4 秒聽不到一般聲音，安靜區例外', () => {
    const b = bench({ seats: ['P1', 'P2', 'P3', 'P4'], flaws: { P1: 'D05', P2: 'D04', P3: 'D03', P4: 'D04' } });
    b.open();
    Object.assign(b.poses.P1, { x: 0, z: 12 });
    Object.assign(b.poses.P2, { x: 2, z: 12 }); // 身邊
    Object.assign(b.poses.P3, { x: -6, z: 25 }); // 冷藏室（安靜區、很遠）
    Object.assign(b.poses.P4, { x: 6, z: 3 }); // 餐廳，很遠
    const n = b.events.length;
    expect(b.coop('P1', 'rally', { token: 'GEST_HELP' }).ok).toBe(true);
    for (const s of ['P2', 'P3', 'P4'] as Seat[]) expect(deliveredTo(b, s, n).some((e) => e.visual === 'rally' && e.critical && e.at)).toBe(true);
    expect(coopPub(b).rallies).toHaveLength(1);
    // 干擾：聲音提示
    const m = b.events.length;
    b.sim.emit({ kind: 'toast_pop', at: [2.8, 18], sound: 'toast_pop', text: '吐司跳起來了' }, 'all');
    expect(deliveredTo(b, 'P2', m)).toHaveLength(0);
    expect(deliveredTo(b, 'P1', m)).toHaveLength(0);
    expect(deliveredTo(b, 'P4', m)).toHaveLength(1);
    expect(privateOf(b, 'P2').muffledUntil).toBeGreaterThan(b.sim.t);
    // 安靜區的人不受影響（就算在範圍內）
    Object.assign(b.poses.P3, { x: -4, z: 20 });
    Object.assign(b.poses.P1, { x: -4, z: 18 });
    b.run(20.1);
    b.coop('P1', 'rally');
    const q = b.events.length;
    b.sim.emit({ kind: 'toast_pop', sound: 'toast_pop', text: '吐司跳起來了' }, 'all');
    expect(deliveredTo(b, 'P3', q)).toHaveLength(1);
    // 4 秒後恢復
    b.run(4.1);
    const r = b.events.length;
    b.sim.emit({ kind: 'toast_pop', sound: 'toast_pop', text: '吐司跳起來了' }, 'all');
    expect(deliveredTo(b, 'P1', r)).toHaveLength(1);
  });

  it('冷卻 20 秒；隊友可以回應召集；危險事件不受干擾', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D05', P2: 'D04' } });
    b.open();
    b.coop('P1', 'rally');
    expect(b.coop('P1', 'rally').ok).toBe(false);
    const id = coopPub(b).rallies[0].id;
    expect(b.coop('P2', 'rally_reply', { rallyId: id, token: 'GEST_YES' }).ok).toBe(true);
    expect(coopPub(b).rallies[0].replies).toEqual([{ by: 'P2', token: 'GEST_YES' }]);
    near(b, 'P1', 'P2', 1);
    const n = b.events.length;
    b.sim.emit({ kind: 'monster_grab', text: '牠抓住了人', critical: true, sound: 'grab' }, 'all');
    expect(deliveredTo(b, 'P2', n)).toHaveLength(1);
    b.run(20.1);
    expect(b.coop('P1', 'rally').ok).toBe(true);
  });
});

describe('D14 嗜睡學徒', () => {
  it('睡意隨時間累積、有預警；到 100 睡著 5 秒（不能操作、不能移動），之後醒來', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D14' } });
    b.open();
    b.run(10);
    expect(privateOf(b, 'P1').drowsy!.level).toBeGreaterThanOrEqual(8);
    b.sim.flaws['seats'].get('P1')!.drowsy = 59;
    b.run(2);
    expect(privateOf(b, 'P1').drowsy!.state).toBe('warn');
    expect(eventsTo(b, 'P1').some((e) => e.visual === 'yawn')).toBe(true);
    b.sim.flaws['seats'].get('P1')!.drowsy = 99.5;
    b.run(1.1);
    expect(privateOf(b, 'P1').drowsy!.state).toBe('asleep');
    expect(b.sim.flaws.frozen('P1')).toBe(true);
    expect(b.act('P1', 'fridge', 'take', { type: 'egg' }).ok).toBe(false);
    expect(coopPub(b).drowsy[0]).toMatchObject({ seat: 'P1', state: 'asleep' });
    b.run(5.1);
    expect(privateOf(b, 'P1').drowsy!.state).not.toBe('asleep');
    expect(privateOf(b, 'P1').drowsy!.level).toBe(35);
  });

  it('互助：隊友拍肩直接叫醒；自救：洗把臉 −40（45 秒冷卻）', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D14', P2: 'D04' } });
    b.open();
    b.sim.flaws['seats'].get('P1')!.drowsy = 100;
    b.run(0.2);
    expect(b.sim.flaws.asleep('P1')).toBe(true);
    near(b, 'P1', 'P2', 1);
    expect(b.coop('P2', 'tap', { to: 'P1' }).ok).toBe(true);
    expect(b.sim.flaws.asleep('P1')).toBe(false);
    expect(b.sim.flaws.telemetrySnapshot().D14!.coopOk).toBeGreaterThan(0);
    b.sim.flaws['seats'].get('P1')!.drowsy = 70;
    expect(b.act('P1', 'sink', 'splash').ok).toBe(true);
    b.run(2.1);
    expect(privateOf(b, 'P1').drowsy!.level).toBeLessThanOrEqual(32);
    expect(b.act('P1', 'sink', 'splash').ok).toBe(false);
  });

  it('端著盤子時會先撐住（最多 8 秒），不會毫無預警地睡著', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D14' } });
    b.open();
    b.act('P1', 'plating', 'new_plate', { vessel: 'plate', hold: true });
    b.sim.flaws['seats'].get('P1')!.drowsy = 100;
    b.run(1);
    expect(b.sim.flaws.asleep('P1')).toBe(false);
    expect(privateOf(b, 'P1').drowsy!.holding).toBe(true);
    b.run(8);
    expect(b.sim.flaws.asleep('P1')).toBe(true);
    expect(held(b, 'P1')?.kind).toBe('plate'); // 睡著也不會掉
  });

  it('雙爐：清醒時在 4.2 m 內可以操作最近碰過的兩個爐具；快睡著或被接管就不行', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D14', P2: 'D04' } });
    b.open();
    b.act('P1', 'pan_a', 'heat', { level: 'LOW' });
    b.act('P1', 'pan_b', 'heat', { level: 'LOW' });
    expect(privateOf(b, 'P1').links!.sort()).toEqual(['pan_a', 'pan_b']);
    // 站在兩鍋中間偏後，離正前方超過一般互動距離
    Object.assign(b.poses.P1, { x: -0.1, z: 14.6 });
    const act = (st: string, level: string) => b.sim.handle('P1', { stationId: st, action: 'heat', args: { level }, requestId: `x${Math.random()}` });
    expect(b.sim.inRange('P1', 'pan_a')).toBe(false);
    expect(act('pan_a', 'MED').ok).toBe(true);
    expect(act('pan_b', 'MED').ok).toBe(true);
    expect(act('stove_a', 'MED').ok).toBe(false);
    // 被接管
    b.at('P2', 'pan_b');
    expect(b.coop('P2', 'takeover', { stationId: 'pan_b' }).ok).toBe(true);
    expect(coopPub(b).links.find((l) => l.stationId === 'pan_b')?.takenBy).toBe('P2');
    expect(act('pan_b', 'OFF').ok).toBe(false);
    // 快睡著：雙爐暫停
    b.sim.flaws['seats'].get('P1')!.drowsy = 90;
    expect(act('pan_a', 'OFF').ok).toBe(false);
  });

  it('單人可以完成煎蛋吐司（≥ 90 分）', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D14' } });
    openUntil(b, 'egg_toast');
    cookEggToast(b, 'P1');
    expect(serveFirst(b, 'P1', 'egg_toast').result!.total).toBeGreaterThanOrEqual(90);
  });
});

describe('D16 定時噴嚏', () => {
  it('每 30 秒一次，3 秒前有前兆（隊友也看得到）；站著不動就沒事', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D16', P2: 'D04' }, prepMs: 60_000 });
    take(b, 'P1', 'egg');
    b.run(26.9);
    expect(coopPub(b).sneezes).toHaveLength(0);
    b.run(0.2);
    expect(coopPub(b).sneezes).toEqual([{ seat: 'P1', at: 30_000 }]);
    expect(eventsTo(b, 'P1').some((e) => e.visual === 'sneeze_warn' && e.critical)).toBe(true);
    setSpeed(b, 'P1', 0);
    b.run(3);
    expect(privateOf(b, 'P1').sneezeAt).toBe(60_000);
    expect(held(b, 'P1')?.kind).toBe('item');
    expect(privateOf(b, 'P1').wobble).toBeFalsy();
  });

  it('噴嚏時量匙會灑掉；拿著東西走動會失衡（隊友可以接住）', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D16', P2: 'D04' }, prepMs: 120_000 });
    b.act('P1', 'spice', 'measure', { seasoning: 'salt', units: 1 });
    b.run(30.1);
    expect(held(b, 'P1')).toBeNull();
    take(b, 'P1', 'egg');
    setSpeed(b, 'P1', 2.3);
    b.run(30);
    expect(privateOf(b, 'P1').wobble?.cause).toBe('sneeze');
    near(b, 'P1', 'P2', 1);
    expect(b.coop('P2', 'catch', { to: 'P1' }).ok).toBe(true);
    expect(held(b, 'P2')?.kind).toBe('item');
  });

  it('嗅覺：附近的鍋子過熟會聞到（只有提示）；可以把氣味警告送給全隊（附標記）', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D16', P2: 'D04' } });
    b.open();
    take(b, 'P2', 'egg');
    b.act('P2', 'pan_a', 'heat', { level: 'HIGH' });
    b.act('P2', 'pan_a', 'place');
    b.at('P1', 'pan_b');
    let hint;
    for (let i = 0; i < 120 && !hint; i++) {
      b.run(1);
      hint = privateOf(b, 'P1').hints?.find((h) => h.kind === 'smell' && h.stationId === 'pan_a');
    }
    expect(hint).toBeTruthy();
    expect(hint!.text).toMatch(/焦/);
    expect(hint!.text).not.toMatch(/\d+°/);
    expect(b.coop('P1', 'smell', { hintId: hint!.id }).ok).toBe(true);
    expect(coopPub(b).marks.some((m) => m.targetId === 'pan_a' && m.from === 'P1')).toBe(true);
  });

  it('單人可以完成煎蛋吐司（≥ 90 分）', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D16' } });
    openUntil(b, 'egg_toast');
    cookEggToast(b, 'P1');
    expect(serveFirst(b, 'P1', 'egg_toast').result!.total).toBeGreaterThanOrEqual(90);
  });
});

describe('B–D 的共通規則', () => {
  it('重連一致：個人狀態（睡意、噴嚏倒數、手套、夾具）只來自伺服器，重送同一個 requestId 不會重複觸發', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D05', P2: 'D10' } });
    b.open();
    const a = b.coop('P1', 'rally', {}, 'same');
    const c = b.coop('P1', 'rally', {}, 'same');
    expect(c).toBe(a);
    expect(coopPub(b).rallies).toHaveLength(1);
    b.act('P2', 'pan_a', 'glove');
    b.run(3.1);
    const before = privateOf(b, 'P2').gloveUntil;
    expect(b.sim.flaws.privateFor('P2')!.gloveUntil).toBe(before);
  });

  it('個人資訊只給本人：別人的快照裡沒有睡意數值、噴嚏倒數、提示內容', () => {
    const b = bench({ seats: ['P1', 'P2', 'P3'], flaws: { P1: 'D14', P2: 'D16', P3: 'D04' } });
    b.open();
    b.run(5);
    const mine = privateOf(b, 'P3');
    expect(mine.drowsy).toBeUndefined();
    expect(mine.sneezeAt).toBeUndefined();
    expect(JSON.stringify(b.sim.publicState())).not.toContain('"level"');
  });
});
