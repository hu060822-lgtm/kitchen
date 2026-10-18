import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ORDER,
  DRY_COOK_FACTOR,
  INGREDIENTS,
  INGREDIENT_IDS,
  OVEN_TARGET,
  SOAK_SEC,
  heatItem,
  isRawProtein,
  newItem,
  type IngredientId,
  type ItemState,
} from '@last-table/shared';
import { bench, chop, steady, type Bench } from './bench';

/** 料理沙盒擴充（企劃書 v3.0）第一階段：食材資料、處理方式、烤箱、攪拌碗、浸泡 */

/** 測試設定：直接把一份食材放到工作站上 */
function put(b: Bench, stationId: string, type: IngredientId, patch: Partial<ItemState> = {}): ItemState {
  const it = Object.assign(newItem(`t${Math.random().toString(36).slice(2, 8)}`, type, b.sim.t), patch);
  b.sim.items.set(it.id, it);
  b.sim.stations.get(stationId)!.items.push(it.id);
  return it;
}

describe('食材資料', () => {
  it('總共至少 42 種（企劃書 30 種＋豆芽＋水＋原本 12 種）', () => {
    expect(INGREDIENT_IDS.length).toBeGreaterThanOrEqual(44);
  });

  it('每一種都有分類、標籤、質地；熟度區間合理；口味在 0–3 之間', () => {
    for (const id of INGREDIENT_IDS) {
      const d = INGREDIENTS[id];
      expect(CATEGORY_ORDER, id).toContain(d.category);
      expect(d.tags.length, id).toBeGreaterThan(0);
      expect(d.texture, id).toBeDefined();
      expect(d.cuts[0], id).toBe('WHOLE');
      expect(d.heat.done[0], id).toBeLessThan(d.heat.done[1]);
      expect(d.heat.done[1], id).toBeLessThanOrEqual(d.heat.burnt);
      for (const band of Object.values(d.flavor)) for (const v of Object.values(band)) expect(v, id).toBeGreaterThanOrEqual(0), expect(v, id).toBeLessThanOrEqual(3);
    }
  });

  it('不能生吃的肉類與海鮮：會汙染砧板，而且有安全溫度', () => {
    for (const id of INGREDIENT_IDS) {
      const d = INGREDIENTS[id];
      if (!isRawProtein(d) || d.heat.rawOk) continue;
      expect(d.contaminates, id).toBe(true);
      expect(d.heat.safeTemp, id).toBeGreaterThan(60);
    }
  });

  it('冷藏架與乾貨架的存貨包含所有對應的食材', () => {
    const b = bench();
    const fridge = b.sim.stations.get('fridge')!;
    const pantry = b.sim.stations.get('pantry')!;
    for (const id of INGREDIENT_IDS) {
      const s = INGREDIENTS[id].storage === 'FRIDGE' ? fridge : pantry;
      expect((s.stock[id] ?? 0) + (s.high[id] ?? 0), id).toBeGreaterThan(0);
    }
  });
});

describe('新的處理方式', () => {
  it('胡蘿蔔可以切絲、檸檬擠汁、鷹嘴豆壓碎；不支援的切法會被擋下', () => {
    const b = bench();
    b.open();
    put(b, 'prep_a', 'carrot', { washed: true, peeled: true });
    expect(chop(b, 'P1', 'prep_a', 'SHRED', steady(10)).ok).toBe(true);
    b.sim.stations.get('prep_a')!.items = [];
    put(b, 'prep_a', 'lemon', { washed: true });
    expect(b.act('P1', 'prep_a', 'chop_start', { cut: 'MASHED' }).ok).toBe(false);
    expect(chop(b, 'P1', 'prep_a', 'JUICED', steady(3)).ok).toBe(true);
    b.sim.stations.get('prep_a')!.items = [];
    put(b, 'prep_a', 'chickpea', { washed: true });
    expect(chop(b, 'P1', 'prep_a', 'MASHED', steady(5)).ok).toBe(true);
  });

  it('蝦是生的海鮮：切過會汙染砧板，也要放肉類成品架', () => {
    const b = bench();
    b.open();
    put(b, 'prep_a', 'shrimp', { washed: true });
    expect(chop(b, 'P1', 'prep_a', 'CHOPPED', steady(6)).ok).toBe(true);
    expect(b.sim.stations.get('prep_a')!.contaminated).toBe(true);
    expect(b.act('P1', 'prep_a', 'pick').ok).toBe(true);
    expect(b.act('P1', 'rack_veg', 'place').ok).toBe(false);
    expect(b.act('P1', 'rack_meat', 'place').ok).toBe(true);
  });
});

describe('需要水的食材', () => {
  it('白米在乾鍋裡幾乎不會熟，在滾水裡會熟（同樣的溫度與時間）', () => {
    const dry = newItem('a', 'rice', 0);
    const wet = newItem('b', 'rice', 0);
    for (let i = 0; i < 900; i++) {
      heatItem(dry, { method: 'pan', vessel: 100, mode: 'pan' });
      heatItem(wet, { method: 'pot', vessel: 100, mode: 'potLiquid' });
    }
    expect(wet.doneness).toBeGreaterThanOrEqual(INGREDIENTS.rice.heat.done[0]);
    expect(dry.doneness).toBeLessThan(INGREDIENTS.rice.heat.done[0]);
    expect(dry.doneness / wet.doneness).toBeCloseTo(DRY_COOK_FACTOR, 1);
  });

  it('水槽可以接一杯水；倒進湯鍋會增加湯量', () => {
    const b = bench();
    b.open();
    expect(b.act('P1', 'sink', 'water').ok).toBe(true);
    expect(b.sim.items.get((b.sim.players.P1.held as { id: string }).id)!.type).toBe('water');
    expect(b.act('P1', 'stove_a', 'place').ok).toBe(true);
    expect(b.sim.stations.get('stove_a')!.liquid).toBe(1);
  });

  it('米粉：在水槽泡軟（約 20 秒）後可以炒；泡太久會爛', () => {
    const b = bench();
    b.open();
    expect(b.act('P1', 'pantry', 'take', { type: 'rice_noodle' }).ok).toBe(true);
    expect(b.act('P1', 'sink', 'place').ok).toBe(true);
    expect(b.act('P1', 'sink', 'soak').ok).toBe(true);
    b.run(SOAK_SEC + 1);
    const it = [...b.sim.items.values()].find((x) => x.type === 'rice_noodle')!;
    expect(it.soaked).toBeGreaterThanOrEqual(1);
    // 泡軟的米粉在平底鍋裡熟得比乾的快很多
    const soft = { ...it, doneness: 0, temp: 22 };
    const hard = { ...it, soaked: 0, doneness: 0, temp: 22 };
    for (let i = 0; i < 300; i++) {
      heatItem(soft, { method: 'pan', vessel: 180, mode: 'pan' });
      heatItem(hard, { method: 'pan', vessel: 180, mode: 'pan' });
    }
    expect(soft.doneness).toBeGreaterThan(hard.doneness * 3);
    b.run(40);
    expect(it.soaked!).toBeGreaterThan(2.5);
    expect(b.act('P1', 'sink', 'pick').ok).toBe(true);
    expect(b.sim.stations.get('sink')!.soak).toBe(false);
  });
});

describe('烤箱', () => {
  it('預熱要時間，預熱好會通知；兩面同時上色、比平底鍋朝下那面慢', () => {
    const b = bench();
    b.open();
    expect(b.act('P1', 'oven', 'heat', { level: 'MED' }).message).toContain('預熱中');
    b.run(10);
    expect(b.sim.stations.get('oven')!.vessel).toBeLessThan(OVEN_TARGET.MED - 5);
    b.run(80);
    expect(b.events.some((x) => x.e.text?.includes('烤箱預熱好了'))).toBe(true);
    const a = put(b, 'oven', 'sweet_potato', { washed: true, cut: 'SLICED' });
    const pan = newItem('p', 'sweet_potato', 0);
    pan.cut = 'SLICED';
    b.run(20);
    for (let i = 0; i < 200; i++) heatItem(pan, { method: 'pan', vessel: OVEN_TARGET.MED, mode: 'pan' });
    expect(a.brownA).toBeGreaterThan(0.2);
    expect(a.brownA).toBeCloseTo(a.brownB, 5);
    expect(a.brownA).toBeLessThan(pan.brownA);
    expect(pan.brownB).toBe(0);
    expect(a.methods).toContain('oven');
  });

  it('液體不能直接放進烤箱', () => {
    const b = bench();
    b.open();
    expect(b.act('P1', 'sink', 'water').ok).toBe(true);
    expect(b.act('P1', 'oven', 'place').ok).toBe(false);
  });
});

describe('攪拌碗', () => {
  it('麵粉＋牛奶＝麵糊（主體是麵粉）；裝盤後展開成兩個成分', () => {
    const b = bench();
    b.open();
    put(b, 'mixer', 'flour');
    put(b, 'mixer', 'milk');
    expect(b.act('P1', 'mixer', 'mix').ok).toBe(true);
    b.run(3);
    const s = b.sim.stations.get('mixer')!;
    expect(s.items.length).toBe(1);
    const m = b.sim.items.get(s.items[0])!;
    expect(m.type).toBe('flour');
    expect(m.mix?.kind).toBe('batter');
    expect(m.mix?.parts.map((p) => p.type)).toEqual(['milk']);
    // 下鍋煎熟，再裝盤
    expect(b.act('P1', 'mixer', 'pick').ok).toBe(true);
    b.act('P1', 'pan_a', 'heat', { level: 'MED' });
    expect(b.act('P1', 'pan_a', 'place').ok).toBe(true);
    b.run(40);
    expect(b.act('P1', 'pan_a', 'pick').ok).toBe(true);
    b.act('P1', 'plating', 'new_plate', { vessel: 'plate' });
    expect(b.act('P1', 'plating', 'add').ok).toBe(true);
    const plate = b.sim.plates.get(b.sim.stations.get('plating')!.plates[0])!;
    expect(plate.components.map((c) => c.type).sort()).toEqual(['flour', 'milk']);
    expect(plate.components.every((c) => c.mixedWith === m.id && c.mixKind === 'batter')).toBe(true);
    const milk = plate.components.find((c) => c.type === 'milk')!;
    expect(milk.methods).toContain('pan');
    expect(milk.temp).toBeGreaterThan(40);
  });

  it('生絞肉＋洋蔥末＋蛋液＝餡料，主體是絞肉（要熟透才安全）', () => {
    const b = bench();
    b.open();
    put(b, 'mixer', 'onion', { peeled: true, cut: 'MINCED' });
    put(b, 'mixer', 'ground_pork');
    put(b, 'mixer', 'egg', { cut: 'BEATEN' });
    b.act('P1', 'mixer', 'mix');
    b.run(3);
    const m = b.sim.items.get(b.sim.stations.get('mixer')!.items[0])!;
    expect(m.type).toBe('ground_pork');
    expect(m.mix?.kind).toBe('bound');
    expect(isRawProtein(INGREDIENTS[m.type])).toBe(true);
  });

  it('全是液體不能拌；只有一樣也不能拌', () => {
    const b = bench();
    b.open();
    put(b, 'mixer', 'milk');
    expect(b.act('P1', 'mixer', 'mix').ok).toBe(false);
    put(b, 'mixer', 'cream');
    expect(b.act('P1', 'mixer', 'mix').message).toContain('液體');
  });

  it('拌好的東西不能再拿去洗或切，也不能放回架上', () => {
    const b = bench();
    b.open();
    put(b, 'mixer', 'cabbage', { washed: true, cut: 'SHRED' });
    put(b, 'mixer', 'carrot', { washed: true, peeled: true, cut: 'SHRED' });
    b.act('P1', 'mixer', 'mix');
    b.run(3);
    expect(b.act('P1', 'mixer', 'pick').ok).toBe(true);
    expect(b.act('P1', 'prep_b', 'place').ok).toBe(false);
    expect(b.act('P1', 'sink', 'place').ok).toBe(false);
    expect(b.act('P1', 'fridge', 'store').ok).toBe(false);
  });
});
