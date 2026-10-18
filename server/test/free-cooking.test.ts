import { describe, expect, it } from 'vitest';
import { analyzeDish, gradeOf, newItem, type Cut, type IngredientId, type RecipeDef } from '@last-table/shared';
import { bench } from './bench';
import { cut, item, mixed, notesText, oven, pan, soup, wok } from './cookkit';

/**
 * 料理沙盒擴充第二階段：自由料理核心。
 * 不選食譜、直接拿食材做菜，系統依實際內容判定名稱、分類、四項品質與失敗原因。
 */

describe('自由料理：不選食譜也能做出合理的料理', () => {
  it('先爆香薑、再下豬肉與高麗菜快炒：薑香豬肉高麗菜炒（新創），四項品質都高', () => {
    const p = wok().add(cut('ginger', 'MINCED'));
    p.cook(7);
    p.add(item('pork_slices'), cut('cabbage', 'SLICED'));
    p.until('pork_slices', 0.2);
    const a = analyzeDish(p.plate('plate', { soy: 1, oil: 0.5 }));
    expect(a.kind, notesText(a)).toBe('new');
    expect(a.style).toBe('stir_fry');
    expect(a.name).toBe('薑香豬肉高麗菜炒');
    expect(a.notes.some((n) => n.ok && n.text.includes('先爆香薑'))).toBe(true);
    expect(a.notes.some((n) => n.ok && n.text.includes('薑去腥'))).toBe(true);
    expect(a.quality.total, notesText(a)).toBeGreaterThanOrEqual(75);
    expect(a.order).toEqual(['薑', '豬肉片', '高麗菜']);
    expect(a.record.find((r) => r.type === 'ginger')!.addedAt).toBe(0);
  });

  it('同樣的食材、不同的處理：高麗菜炒太久會軟爛，蔬菜保留脆度則加分', () => {
    // 先下豬肉，快熟了再下高麗菜（玩家照著熟度調整下鍋順序）
    const quick = wok().add(item('pork_slices')).cook(10).add(cut('cabbage', 'SLICED')).until('pork_slices', 0.25);
    const long = wok(150).add(item('pork_slices'), cut('cabbage', 'SLICED')).until('cabbage', 1.3);
    const a = analyzeDish(quick.plate('plate', { soy: 1 }));
    const b = analyzeDish(long.plate('plate', { soy: 1 }));
    expect(a.notes.some((n) => n.ok && n.text.includes('脆度')), notesText(a)).toBe(true);
    expect(notesText(b)).toContain('高麗菜炒太久');
    expect(b.quality.texture).toBeLessThan(a.quality.texture);
    expect(b.quality.total).toBeLessThan(a.quality.total);
  });

  it('同樣的食材、不同的烹調方式得到不同的料理：炒、水煮、燉', () => {
    const fried = analyzeDish(wok().add(cut('tofu', 'DICED'), cut('cabbage', 'SLICED')).until('cabbage', 0.2).plate('plate', { soy: 1 }));
    const boiled = soup().add(item('stock', { qty: 2 }), cut('tofu', 'DICED'), cut('cabbage', 'SLICED'));
    boiled.until('cabbage', 0.3);
    const b = analyzeDish(boiled.plate('bowl', { salt: 0.5 }, 2));
    const stew = soup().add(item('stock', { qty: 3 }), cut('tofu', 'DICED'), cut('cabbage', 'CHOPPED'), cut('chili', 'SLICED'));
    stew.cook(100);
    const c = analyzeDish(stew.plate('bowl', { soy: 1 }, 2.5));
    expect(fried.style).toBe('stir_fry');
    expect(b.style).toBe('boil');
    expect(b.form).toBe('soup');
    expect(b.name, notesText(b)).toBe('豆腐高麗菜湯');
    expect(c.style).toBe('stew');
    // 只放了一點辣椒、湯又多：吃不出辣，名稱不會寫「辣味」
    expect(c.taste.spicy).toBeLessThan(0.8);
    expect(c.name, notesText(c)).toBe('豆腐高麗菜煲');
    expect(new Set([fried.key, b.key, c.key]).size).toBe(3);
  });

  it('麵糊下鍋煎：起司玉米煎餅；奶油培根義大利麵是奶醬', () => {
    const batter = mixed(item('flour'), cut('egg', 'BEATEN'), item('milk'), cut('corn', 'CHOPPED'), cut('cheese', 'GRATED'));
    const pc = analyzeDish(pan(160).add(batter).until('flour', 0.15, { flipEvery: 12 }).plate('plate', { salt: 0.5 }));
    expect(pc.form).toBe('pancake');
    expect(pc.name).toBe('起司蛋玉米煎餅');
    expect(pc.kind, notesText(pc)).not.toBe('failed');

    const pot = soup().add(item('water', { qty: 2 }), item('spaghetti'));
    pot.cook(15);
    pot.add(cut('bacon', 'CHOPPED'), item('cream'));
    pot.until('spaghetti', 0.4);
    const pasta = analyzeDish(pot.plate('plate', { salt: 0.5, pepper: 0.5 }, 0.9));
    expect(pasta.form).toBe('noodle');
    expect(pasta.sauce).toBe('creamy');
    expect(pasta.name).toBe('奶油培根義大利麵');
    expect(pasta.kind, notesText(pasta)).toBe('new');
    expect(pasta.notes.some((n) => n.ok && n.text.includes('培根義大利麵'))).toBe(true);
  });

  it('罕見組合也能成立：地瓜、鷹嘴豆、洋蔥進烤箱，淋檸檬汁——新創、不是失敗（名稱以蛋白質為先）', () => {
    const o = oven(210).add(cut('sweet_potato', 'CHUNK'), item('chickpea'), cut('onion', 'SLICED'));
    o.until('sweet_potato', 0.15);
    const a = analyzeDish({ ...o.plate('plate', { salt: 0.5, oil: 0.5 }), components: [...o.items, cut('lemon', 'JUICED')] });
    expect(a.style).toBe('bake');
    expect(a.kind, notesText(a)).toBe('new');
    expect(a.name).toBe('檸檬鷹嘴豆洋蔥烤盤');
    expect(a.quality.total, notesText(a)).toBeGreaterThanOrEqual(60);
  });

  it('同樣的內容永遠得到同樣的結果（名稱、分類、品質、原因）', () => {
    const make = () => {
      const p = wok().add(cut('garlic', 'MINCED'));
      p.cook(6);
      p.add(item('shrimp'), cut('egg', 'BEATEN'));
      p.until('shrimp', 0.3);
      return analyzeDish(p.plate('plate', { salt: 0.5 }));
    };
    const a = make();
    expect(a).toEqual(make());
    // 蒜香炒蝦多加了蛋：保留食譜的主要特徵＝變體
    expect(a.name).toBe('蒜香炒蝦（加蛋）');
    expect(a.kind).toBe('variant');
  });
});

describe('已知食譜與變體', () => {
  it('照著做番茄炒蛋：辨識成已知食譜', () => {
    const a = analyzeDish(pan().add(cut('egg', 'BEATEN', { qty: 2 }), cut('tomato', 'DICED')).until('egg', 0.2, { flipEvery: 5 }).plate('plate', { sugar: 0.5, salt: 0.5 }));
    expect(a.kind, notesText(a)).toBe('known');
    expect(a.recipeId).toBe('tomato_egg');
    expect(a.name).toBe('番茄炒蛋');
    expect(a.key).toBe('r:tomato_egg');
  });

  it('替代食材是變體，不是失敗：黑胡椒牛肉改用豬肉＝黑胡椒豬肉', () => {
    const recipe: RecipeDef = {
      id: 'pepper_beef',
      name: '黑胡椒牛肉',
      vessel: 'plate',
      hot: true,
      parSec: 180,
      components: [
        { type: 'beef_slices', alt: ['pork_slices', 'chicken_breast'], qty: 1, method: 'pan', note: '' },
        { type: 'bell_pepper', qty: 1, cut: 'SLICED', method: 'pan', note: '' },
      ],
      seasoning: { pepper: 1, soy: 0.5 },
      steps: [],
    };
    const a = analyzeDish(pan().add(item('pork_slices'), cut('bell_pepper', 'SLICED')).until('pork_slices', 0.2, { flipEvery: 5 }).plate('plate', { pepper: 1, soy: 0.5 }), { recipes: [recipe] });
    expect(a.kind, notesText(a)).toBe('variant');
    expect(a.name).toBe('黑胡椒豬肉');
    expect(a.changes).toContain('豬肉代替牛肉');
    expect(a.key).toBe('v:pepper_beef:pork_slices:');
    const b = analyzeDish(pan().add(item('beef_slices'), cut('bell_pepper', 'SLICED')).until('beef_slices', 0.3, { flipEvery: 5 }).plate('plate', { pepper: 1, soy: 0.5 }), { recipes: [recipe] });
    expect(b.kind, notesText(b)).toBe('known');
  });
});

describe('失敗料理：顯示明確的原因', () => {
  it('燒焦的洋蔥炒蛋', () => {
    const a = analyzeDish(pan(240).add(cut('onion', 'SLICED'), cut('egg', 'BEATEN')).cook(90).plate());
    expect(a.kind).toBe('failed');
    expect(a.name.startsWith('燒焦的'), a.name).toBe(true);
    expect(a.fatal).toContain('燒焦');
  });

  it('生米直接下鍋炒：沒煮熟，原因說要先加水煮', () => {
    const a = analyzeDish(wok().add(item('rice'), cut('egg', 'BEATEN')).until('egg', 0.3).plate('plate', { salt: 0.5 }));
    expect(a.kind).toBe('failed');
    expect(a.name).toBe('沒煮熟的蛋炒飯');
    expect(a.fatal).toContain('水裡');
  });

  it('先煮好飯再炒：蛋炒飯成立', () => {
    const rice = soup().add(item('water', { qty: 2 }), item('rice'));
    rice.until('rice', 0.1);
    const cooked = rice.items.find((x) => x.type === 'rice')!;
    const p = wok().add(cooked, cut('egg', 'BEATEN'), cut('scallion', 'CHOPPED'));
    p.until('egg', 0.2);
    const a = analyzeDish(p.plate('plate', { salt: 0.5, oil: 0.5 }));
    expect(a.kind, notesText(a)).toBe('new');
    expect(a.name).toBe('蔥香蛋炒飯');
  });

  it('過鹹的培根炒飯（培根本身就鹹，又加了很多鹽和醬油）', () => {
    const rice = soup().add(item('water', { qty: 2 }), item('rice'));
    rice.until('rice', 0.1);
    const p = wok().add(rice.items.find((x) => x.type === 'rice')!, cut('bacon', 'CHOPPED', { qty: 2 }));
    p.until('bacon', 0.2);
    const a = analyzeDish(p.plate('plate', { salt: 2, soy: 2 }));
    expect(a.kind).toBe('failed');
    expect(a.name).toBe('過鹹的培根炒飯');
    expect(a.notes.some((n) => !n.ok && n.text.includes('太鹹'))).toBe(true);
  });

  it('過熟的鮭魚：烹調與質地都扣分', () => {
    const ok = analyzeDish(pan(160).add(item('salmon')).until('salmon', 0.3, { flipEvery: 25 }).plate('plate', { salt: 0.5 }));
    const over = analyzeDish(pan(160).add(item('salmon')).until('salmon', 1.8, { flipEvery: 25 }).plate('plate', { salt: 0.5 }));
    expect(ok.quality.cook, notesText(ok)).toBeGreaterThan(over.quality.cook);
    expect(over.quality.texture).toBeLessThan(ok.quality.texture);
    expect(notesText(over)).toContain('鮭魚煮過頭');
    expect(notesText(over)).toContain('鮭魚過熟變硬');
  });

  it('沒煮熟的麵糊（生粉味）', () => {
    const a = analyzeDish(pan(120).add(mixed(item('flour'), item('milk'))).cook(4).plate());
    expect(a.kind).toBe('failed');
    expect(a.fatal).toContain('麵粉');
  });

  it('嚴重失去口感的炒烏龍麵（炒太久糊掉）', () => {
    const a = analyzeDish(wok(140).add(item('udon'), item('pork_slices')).until('udon', 2.2).plate('plate', { soy: 1 }));
    expect(a.kind, notesText(a)).toBe('failed');
    expect(notesText(a)).toContain('烏龍麵煮過頭，糊掉了');
  });

  it('雞胸肉沒熟透：食品安全上限 30 分，算失敗', () => {
    const a = analyzeDish(pan().add(item('chicken_breast')).cook(12).plate('plate', { salt: 0.5 }));
    expect(a.kind).toBe('failed');
    expect(a.cap?.max).toBe(30);
    expect(a.quality.total).toBeLessThanOrEqual(30);
  });

  it('不合理的內容也有明確結果，不會出錯：空盤、只有水、只有調味', () => {
    const empty = analyzeDish({ vessel: 'plate', components: [], seasoning: {} });
    expect(empty.kind).toBe('failed');
    expect(empty.quality.total).toBe(0);
    const water = analyzeDish({ vessel: 'bowl', components: [item('water')], seasoning: { salt: 1 } });
    expect(water.kind).toBe('failed');
    expect(water.fatal).toContain('固體');
  });

  it('檸檬和牛奶一起煮：搭配扣分並說明原因', () => {
    const p = soup().add(item('milk', { qty: 2 }), cut('lemon', 'JUICED'), cut('corn', 'CHOPPED'));
    p.until('corn', 0.2);
    const a = analyzeDish(p.plate('bowl', {}, 1.5));
    expect(a.notes.some((n) => !n.ok && n.text.includes('結塊'))).toBe(true);
  });
});

describe('品質等級（企劃書 7.2）', () => {
  it('0–39 失敗、40–59 勉強、60–74 合格、75–89 優秀、90+ 主廚推薦', () => {
    expect([0, 39, 40, 59, 60, 74, 75, 89, 90, 100].map(gradeOf)).toEqual(['fail', 'fail', 'barely', 'barely', 'pass', 'pass', 'great', 'great', 'chef', 'chef']);
  });
});

describe('出餐：伺服器評分附上自由料理的判定', () => {
  it('出主廚自選單：結果裡有這道菜的名稱、分類與四項品質；試吃會說看起來像什麼', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    const order = b.sim.orders.find((o) => o.status === 'open') ?? (b.run(120), b.sim.orders.find((o) => o.status === 'open'))!;
    expect(order).toBeTruthy();
    b.act('P1', 'pan_a', 'heat', { level: 'MED' });
    for (const [type, c] of [['tomato', 'DICED'], ['egg', 'BEATEN']] as Array<[IngredientId, Cut]>) {
      const it = Object.assign(newItem(`x${type}`, type, b.sim.t), { washed: true, cut: c, cutQuality: 0.9 });
      it.history.push({ t: b.sim.t, op: 'place:pan_a' });
      b.sim.items.set(it.id, it);
      b.sim.stations.get('pan_a')!.items.push(it.id);
    }
    // 一邊翻面一邊看蛋的熟度，剛凝固就起鍋
    const egg = b.sim.items.get('xegg')!;
    for (let i = 0; i < 200 && egg.doneness < 1.3; i++) {
      b.run(0.5);
      if (i % 8 === 7) b.act('P1', 'pan_a', 'flip');
    }
    b.act('P1', 'plating', 'new_plate', { vessel: 'plate' });
    for (let i = 0; i < 2; i++) {
      expect(b.act('P1', 'pan_a', 'pick').ok).toBe(true);
      expect(b.act('P1', 'plating', 'add').ok).toBe(true);
    }
    const taste = b.act('P1', 'plating', 'taste');
    expect(taste.message).toContain('看起來像：番茄炒蛋');
    expect(b.act('P1', 'plating', 'pick').ok).toBe(true);
    const r = b.act('P1', 'pass', 'serve', { orderId: order.id });
    expect(r.ok, r.message).toBe(true);
    expect(r.result?.analysis?.name).toBe('番茄炒蛋');
    expect(r.result?.analysis?.kind).toBe('known');
    expect(r.result?.analysis?.quality.total).toBeGreaterThan(0);
  });
});
