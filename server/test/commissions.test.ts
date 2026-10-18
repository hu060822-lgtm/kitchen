import { describe, expect, it } from 'vitest';
import { COMMISSIONS, COMMISSION_FAIL_CAP, COMMISSION_IDS, STARTER_COMMISSIONS, condLabel, type DishInput, type ScoreResult } from '@last-table/shared';
import { buildSchedule, patienceMs, pickAdvancedCommissions } from '../src/kitchen/orders';
import { scoreCommission } from '../src/kitchen/scoring';
import { bench } from './bench';
import { cut, item, mixed, pan, soup, wok } from './cookkit';

/**
 * 料理沙盒擴充第四階段：20 種主廚委託。
 * 每一種都有：一道合格的料理（必要條件全部通過、拿到合格以上），和至少一道不合格的料理（列出正確的違規原因）。
 * 硬性條件和品質分數分開：很好吃但違反條件，委託還是失敗。
 */

function serve(id: string, plate: DishInput, elapsedSec = 60): ScoreResult {
  return scoreCommission(COMMISSIONS[id], plate as never, { id: 'o1', kind: 'free', requestId: id, openedAt: 0 }, elapsedSec * 1000, 'P1');
}
const why = (r: ScoreResult) => `${r.commission!.violations.join('｜')}｜品質 ${r.analysis!.name} ${JSON.stringify(r.analysis!.quality)} 味道 ${JSON.stringify(r.analysis!.taste)} 口感 ${r.analysis!.textures}`;
function pass(r: ScoreResult): void {
  expect(r.commission!.passed, why(r)).toBe(true);
  expect(r.total, why(r)).toBeGreaterThanOrEqual(60);
  expect(['pass', 'great', 'chef']).toContain(r.commission!.grade);
  expect(r.commission!.coins).toBeGreaterThan(0);
}
function fail(r: ScoreResult, text: string | RegExp): void {
  expect(r.commission!.passed, why(r)).toBe(false);
  expect(r.total).toBeLessThanOrEqual(COMMISSION_FAIL_CAP);
  expect(r.commission!.grade).toBe('fail');
  expect(r.commission!.coins).toBe(0);
  expect(r.commission!.violations.join('｜')).toMatch(text);
}

/* ------------------------------ 料理 ------------------------------ */

const gingerPork = (meat: 'pork_slices' | 'tofu' = 'pork_slices') => {
  const p = wok().add(cut('ginger', 'MINCED'));
  p.cook(7);
  p.add(item(meat), cut('onion', 'SLICED'));
  return p.until(meat, 0.2).plate('plate', { soy: 2, oil: 1 });
};
const tomatoLemon = (egg = false) => {
  const p = pan().add(cut('tomato', 'DICED'), ...(egg ? [cut('egg', 'BEATEN')] : []));
  p.until('tomato', 0.1, { flipEvery: 5 });
  const d = p.plate('plate', { sugar: 1.5 });
  return { ...d, components: [...d.components, cut('lemon', 'JUICED')] };
};
const clearSoup = () => {
  const p = soup().add(item('stock', { qty: 2 }), cut('cabbage', 'SLICED'), cut('tofu', 'DICED'));
  return p.until('cabbage', 0.3).plate('bowl', { salt: 0.5 }, 2);
};
const veggieStirFry = (bacon = false) => wok().add(cut('cabbage', 'SLICED'), cut('carrot', 'SHRED'), ...(bacon ? [cut('bacon', 'SLICED')] : [])).until('cabbage', 0.2).plate('plate', { soy: 1, oil: 0.5 });
const cornChowder = (cream = true) => {
  const p = soup().add(item('butter'), cut('corn', 'MASHED', { qty: 2 }), item('milk'), ...(cream ? [item('cream')] : []), item('stock'));
  p.until('corn', 0.2);
  return p.plate('bowl', { salt: 0.5 }, cream ? 2.2 : 1.8);
};
const tofuVegStew = (egg = false) => {
  const p = soup().add(item('stock', { qty: 2 }), cut('carrot', 'CHUNK'), cut('cauliflower', 'CHUNK'), cut('tofu', 'DICED'), ...(egg ? [cut('egg', 'BEATEN')] : []));
  p.cook(100);
  return p.plate('bowl', { soy: 1 }, 1.6);
};
const searedSalmon = (frac = 0.3) => {
  const d = pan(160).add(item('salmon'), item('butter')).until('salmon', frac, { flipEvery: 25 }).plate('plate', { salt: 0.5, pepper: 0.5 });
  return { ...d, components: [...d.components, cut('lemon', 'JUICED')] };
};
const garlicSpinachMushroom = () => {
  const p = wok().add(cut('garlic', 'MINCED'));
  p.cook(6);
  p.add(cut('mushroom', 'SLICED'), item('tofu', { cut: 'DICED' }));
  p.cook(12);
  p.add(cut('spinach', 'CHOPPED'));
  return p.until('spinach', 0.3).plate('plate', { soy: 1, oil: 0.5 });
};
const sweetPotato = (how: 'pan' | 'boil' = 'pan') =>
  how === 'pan'
    ? pan(170).add(cut('sweet_potato', 'SLICED')).until('sweet_potato', 0.15, { flipEvery: 20 }).plate('plate', { oil: 0.5, salt: 0.5 })
    : soup().add(item('water', { qty: 2 }), cut('sweet_potato', 'SLICED')).until('sweet_potato', 0.15).plate('plate', { salt: 0.5 }, 0);

/* ------------------------------ 20 種委託 ------------------------------ */

describe('20 種主廚委託：合格與不合格的料理', () => {
  it('01 熱騰騰的肉香：薑炒豬肉合格；豆腐代替肉＝沒有肉類', () => {
    pass(serve('meat_savory', gingerPork()));
    fail(serve('meat_savory', gingerPork('tofu')), /沒有肉類/);
  });

  it('02 酸甜開胃：番茄檸檬（糖）合格；加了蛋＝違規', () => {
    pass(serve('sour_sweet', tomatoLemon()));
    fail(serve('sour_sweet', tomatoLemon(true)), /用了雞蛋（不吃蛋）/);
  });

  it('03 清淡熱湯：高麗菜豆腐湯合格；做成一盤炒菜＝不是湯', () => {
    pass(serve('light_soup', clearSoup()));
    fail(serve('light_soup', veggieStirFry()), /做出來的是/);
  });

  it('04 辣味與菇類：辣炒蘑菇豬肉合格；沒有菇＝違規', () => {
    // 先下豬肉，快熟了再下辣椒和菇（辣椒太早下會燒焦）
    const make = (mush: boolean) => wok().add(item('pork_slices')).cook(10).add(cut('chili', 'MINCED', { qty: 3 }), ...(mush ? [cut('mushroom', 'SLICED')] : [cut('cabbage', 'SLICED')])).until('pork_slices', 0.2).plate('plate', { soy: 1 });
    pass(serve('spicy_mushroom', make(true)));
    fail(serve('spicy_mushroom', make(false)), /沒有蘑菇/);
  });

  it('05 蔬菜主義：高麗菜胡蘿蔔炒合格；加了培根＝違規', () => {
    pass(serve('veggie', veggieStirFry()));
    fail(serve('veggie', veggieStirFry(true)), /用了培根/);
  });

  it('06 脆口與柔軟：煎豆腐配快炒高麗菜合格；全部燉軟＝口感不夠', () => {
    const p = wok(170).add(cut('tofu', 'DICED'));
    p.cook(20);
    p.add(cut('cabbage', 'SLICED'), cut('carrot', 'SHRED'));
    p.until('cabbage', 0.15);
    pass(serve('crisp_and_soft', p.plate('plate', { soy: 1, oil: 0.5 })));
    const mush = soup().add(item('stock', { qty: 2 }), cut('tofu', 'DICED'), cut('potato', 'DICED'));
    mush.cook(150);
    fail(serve('crisp_and_soft', mush.plate('bowl', { salt: 0.5 }, 1.5)), /口感/);
  });

  it('07 奶香料理：玉米濃湯合格；沒有任何乳製品＝違規', () => {
    pass(serve('creamy', cornChowder()));
    fail(serve('creamy', gingerPork()), /沒有牛奶、鮮奶油、奶油或起司/);
  });

  it('08 三種食材的限制：鮭魚、奶油、檸檬合格；五種主要食材＝違規', () => {
    pass(serve('three_items', searedSalmon()));
    fail(serve('three_items', tofuVegStew(true)), /主要食材有 4 種/);
  });

  it('09 指定食材挑戰：玉米起司煎蛋合格；只有玉米＝少了起司', () => {
    const make = (cheese: boolean) => pan(160).add(mixed(cut('egg', 'BEATEN', { qty: 2 }), cut('corn', 'CHOPPED'), ...(cheese ? [cut('cheese', 'GRATED')] : []))).until('egg', 0.2, { flipEvery: 12 }).plate('plate', { salt: 0.5 });
    pass(serve('corn_cheese', make(true)));
    fail(serve('corn_cheese', make(false)), /少了起司/);
  });

  it('10 不能使用油：清湯合格；加了油＝違規', () => {
    pass(serve('no_oil', clearSoup()));
    fail(serve('no_oil', veggieStirFry()), /加了油/);
  });

  it('11 限時出餐：100 秒內出餐合格；超過 150 秒＝違規', () => {
    pass(serve('rush', gingerPork(), 100));
    fail(serve('rush', gingerPork(), 170), /花了 170 秒/);
  });

  it('12 麵食專家：炒烏龍麵（麵有彈性）合格；炒到糊掉＝麵條熟度不對', () => {
    const make = (frac: number) => wok(165).add(item('pork_slices')).cook(8).add(cut('cabbage', 'SLICED'), item('udon')).until('udon', frac).plate('plate', { soy: 1, oil: 0.5 });
    pass(serve('noodle_pro', make(0.3)));
    fail(serve('noodle_pro', make(1.6)), /烏龍麵熟度不對/);
  });

  it('13 一鍋完成：只用湯鍋的豆腐蔬菜煲合格；平底鍋＋湯鍋＝用了 2 個鍋具', () => {
    pass(serve('one_pot', tofuVegStew()));
    const salmon = pan(160).add(item('salmon')).until('salmon', 0.3, { flipEvery: 25 }).plate();
    const veg = soup().add(item('stock', { qty: 1 }), cut('carrot', 'SLICED')).until('carrot', 0.2).plate('plate', {}, 0.5);
    fail(serve('one_pot', { vessel: 'plate', components: [...salmon.components, ...veg.components], seasoning: { salt: 0.5 }, liquid: 0.5 }), /用了 2 個鍋具/);
  });

  it('14 鮮味大師：蛤蜊高湯合格；靠加鹽＝鹹度超過', () => {
    const make = (salt: number) => soup().add(item('stock', { qty: 2 }), cut('cabbage', 'SLICED'), item('clam', { qty: 2 }), cut('mushroom', 'SLICED')).until('clam', 0.3).plate('bowl', { salt }, 1.8);
    pass(serve('umami', make(0)));
    fail(serve('umami', make(3)), /鹹/);
  });

  it('15 食材替代：牛肉缺貨，黑胡椒豬肉合格；還是用了牛肉＝違規', () => {
    const make = (meat: 'pork_slices' | 'beef_slices') => pan(170).add(item(meat), cut('bell_pepper', 'SLICED')).until(meat, 0.2, { flipEvery: 5 }).plate('plate', { pepper: 1, soy: 0.5, oil: 0.5 });
    pass(serve('substitute', make('pork_slices')));
    fail(serve('substitute', make('beef_slices')), /用了牛肉片（牛肉缺貨）/);
  });

  it('16 外酥內軟：香煎地瓜合格；水煮地瓜＝沒有外層煎香', () => {
    pass(serve('crispy_outside', sweetPotato('pan')));
    fail(serve('crispy_outside', sweetPotato('boil')), /沒有外層煎香/);
  });

  it('17 濃湯挑戰：玉米濃湯合格；清湯＝醬汁不夠濃', () => {
    pass(serve('thick_soup', cornChowder()));
    fail(serve('thick_soup', clearSoup()), /醬汁/);
  });

  it('18 雙重限制：豆腐蔬菜煲合格；加了蛋＝違規', () => {
    pass(serve('no_meat_no_egg', tofuVegStew()));
    fail(serve('no_meat_no_egg', tofuVegStew(true)), /用了雞蛋（不要蛋）/);
  });

  it('19 異常廚房：鮭魚煎得剛好合格；煎過頭＝熟度不對', () => {
    pass(serve('timer_broken', searedSalmon(0.3)));
    fail(serve('timer_broken', searedSalmon(1.6)), /鮭魚.*熟度不對/);
  });

  it('20 主廚的自由命題：自己發想的料理合格而且有加分；燒焦的料理＝不能吃', () => {
    const r = serve('chef_choice', garlicSpinachMushroom());
    pass(r);
    expect(r.commission!.bonuses.some((b) => b.text.includes('自己發想'))).toBe(true);
    const burnt = pan(240).add(cut('onion', 'SLICED'), cut('egg', 'BEATEN')).cook(90).plate();
    fail(serve('chef_choice', burnt), /燒焦/);
  });
});

/* ------------------------------ 規則 ------------------------------ */

describe('委託的規則', () => {
  it('資料：20 種，每一種都有必要條件、加分條件、說明文字與獎勵；每個條件都有玩家看得懂的說明', () => {
    expect(COMMISSION_IDS.length).toBe(20);
    expect(new Set(Object.values(COMMISSIONS).map((c) => c.no)).size).toBe(20);
    for (const c of Object.values(COMMISSIONS)) {
      expect(c.require.length, c.id).toBeGreaterThan(0);
      expect(c.bonus.length, c.id).toBeGreaterThan(0);
      expect(c.reward.coins, c.id).toBeGreaterThan(0);
      for (const x of [...c.require, ...c.bonus.map((b) => b.cond)]) expect(condLabel(x).length, `${c.id} ${x.k}`).toBeGreaterThan(1);
    }
  });

  it('硬性條件與品質獨立：很好吃的蛋料理，違反「不吃蛋」還是失敗；料理品質照樣顯示', () => {
    const r = serve('sour_sweet', tomatoLemon(true));
    expect(r.commission!.passed).toBe(false);
    expect(r.analysis!.quality.total).toBeGreaterThan(COMMISSION_FAIL_CAP);
    expect(r.total).toBeLessThanOrEqual(COMMISSION_FAIL_CAP);
  });

  it('分數結構：烹調 30、風味 25、搭配 20、質地 15、時間 10，加分最多到 100；越慢時間分越低', () => {
    const fast = serve('meat_savory', gingerPork(), 60);
    const slow = serve('meat_savory', gingerPork(), 500);
    expect(fast.weights).toEqual({ cook: 30, flavor: 25, pairing: 20, texture: 15, time: 10 });
    expect(fast.categories.time).toBe(1);
    expect(slow.categories.time).toBeLessThan(0.5);
    expect(slow.total).toBeLessThan(fast.total);
    expect(fast.total).toBeLessThanOrEqual(100);
  });

  it('獎勵：等級越高越多；新創或變體料理多 20%；沒達成沒有獎勵', () => {
    const r = serve('chef_choice', garlicSpinachMushroom());
    expect(r.analysis!.kind).toBe('new');
    expect(r.commission!.coins).toBe(Math.round(30 * { fail: 0, barely: 0.5, pass: 1, great: 1.3, chef: 1.6 }[r.commission!.grade] * 1.2));
  });

  it('排程：前半段是入門委託，後兩張是進階委託；限時委託的等待時間就是時限', () => {
    for (let seed = 1; seed < 30; seed++) {
      const [a, b] = pickAdvancedCommissions(seed);
      expect(a).not.toBe(b);
      expect(STARTER_COMMISSIONS).not.toContain(a);
      const plan = buildSchedule(seed, 3).filter((p) => p.kind === 'free');
      expect(plan.map((p) => p.requestId)).toEqual(expect.arrayContaining([a, b]));
    }
    expect(patienceMs({ kind: 'free', requestId: 'rush', patience: 1.6 })).toBe(150_000);
  });

  it('異常廚房：這張單開著的時候溫度計失靈（只改變資訊，不改料理規則）', () => {
    const b = bench({ schedule: [{ at: 0, kind: 'free', requestId: 'timer_broken', table: 1 }] });
    b.open();
    b.run(0.5);
    b.act('P1', 'fridge', 'take', { type: 'egg' });
    b.act('P1', 'pan_a', 'place');
    const r = b.act('P1', 'pan_a', 'probe');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('溫度計失靈');
    const ctrl = bench();
    ctrl.open();
    ctrl.act('P1', 'fridge', 'take', { type: 'egg' });
    ctrl.act('P1', 'pan_a', 'place');
    expect(ctrl.act('P1', 'pan_a', 'probe').ok).toBe(true);
  });

  it('同一張單只結算一次（重送同一個 requestId 不會重複計分、重複給獎勵）', () => {
    const b = bench({ seats: ['P1'], schedule: [{ at: 0, kind: 'free', requestId: 'chef_choice', table: 1 }] });
    b.open();
    b.run(0.5);
    b.act('P1', 'fridge', 'take', { type: 'tomato' });
    b.act('P1', 'plating', 'new_plate', { vessel: 'plate' });
    b.act('P1', 'plating', 'add');
    b.act('P1', 'plating', 'pick');
    const id = b.sim.orders[0].id;
    const r1 = b.act('P1', 'pass', 'serve', { orderId: id }, 'same');
    const r2 = b.act('P1', 'pass', 'serve', { orderId: id }, 'same');
    expect(r2).toBe(r1);
    expect(b.sim.stats.served).toBe(1);
    expect(r1.result?.commission).toBeDefined();
  });
});

