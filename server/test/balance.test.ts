import { describe, expect, it } from 'vitest';
import {
  COMMISSIONS,
  INGREDIENTS,
  INGREDIENT_IDS,
  PAIRINGS,
  RECIPES,
  SEASONING_IDS,
  analyzeDish,
  type Cond,
  type Cut,
  type DishInput,
  type FlavorDim,
  type IngredientId,
} from '@last-table/shared';
import { rng } from '../src/kitchen/orders';
import { cut, item, oven, pan, soup, wok, type Pot } from './cookkit';

/**
 * 料理沙盒擴充第六階段：平衡與內容測試（企劃書第十一章）。
 *   - 有沒有某種組合能無條件拿最高分？
 *   - 有沒有某種調味方式可以繞過風味模型？
 *   - 固定食譜是不是遠比其他料理容易高分？
 *   - 委託的限制有沒有互相矛盾？
 *   - 有沒有幾乎沒有使用價值的食材？
 */

const solids = INGREDIENT_IDS.filter((t) => !INGREDIENTS[t].liquid);

/** 隨機的一道菜：隨機食材、隨機切法、隨機烹調方式與時間、隨機調味（可重現） */
function randomDish(seed: number): DishInput {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const n = 1 + Math.floor(r() * 5);
  const items = Array.from({ length: n }, () => {
    const t = pick(solids);
    const c = pick(INGREDIENTS[t].cuts) as Cut;
    return cut(t, c);
  });
  const how = pick(['raw', 'pan', 'wok', 'soup', 'oven'] as const);
  const seasoning = Object.fromEntries(SEASONING_IDS.filter(() => r() < 0.3).map((s) => [s, pick([0.5, 1, 1.5, 2])]));
  if (how === 'raw') return { vessel: 'plate', components: items, seasoning };
  const p: Pot = how === 'pan' ? pan(130 + r() * 110) : how === 'wok' ? wok(130 + r() * 110) : how === 'soup' ? soup() : oven(170 + r() * 80);
  if (how === 'soup') p.add(item('stock', { qty: 2 }));
  p.add(...items);
  p.cook(5 + r() * 200, { flipEvery: how === 'pan' ? 10 : undefined });
  return p.plate(how === 'soup' ? 'bowl' : 'plate', seasoning, how === 'soup' ? 1.5 : undefined);
}

describe('平衡：隨機料理', () => {
  const dishes = Array.from({ length: 300 }, (_, i) => ({ seed: i + 1, a: analyzeDish(randomDish(i + 1)) }));

  it('300 道隨機料理：判定不會出錯，分數在 0–100，名稱不是空的，結果可重現', () => {
    for (const { seed, a } of dishes) {
      expect(a.quality.total, String(seed)).toBeGreaterThanOrEqual(0);
      expect(a.quality.total).toBeLessThanOrEqual(100);
      expect(a.name.length).toBeGreaterThan(0);
    }
    expect(analyzeDish(randomDish(42))).toEqual(analyzeDish(randomDish(42)));
  });

  it('沒有無條件的高分：亂做的料理很少到 90 分；到 90 分的一定熟度對、沒有致命失誤', () => {
    const top = dishes.filter((d) => d.a.quality.total >= 90);
    expect(top.length / dishes.length).toBeLessThan(0.1);
    for (const { a } of top) {
      expect(a.fatal).toBeUndefined();
      expect(a.quality.cook).toBeGreaterThanOrEqual(80);
    }
  });

  it('沒有某一種食材能「保證」高分：拿到 80 分以上的料理裡，沒有一種食材出現在超過一半', () => {
    const good = dishes.filter((d) => d.a.quality.total >= 80);
    const count = new Map<IngredientId, number>();
    // 高湯是隨機湯品固定加的，不算
    for (const { a } of good) for (const t of new Set(a.record.map((r) => r.type))) if (t !== 'stock') count.set(t, (count.get(t) ?? 0) + 1);
    for (const [t, n] of count) expect(n / Math.max(1, good.length), t).toBeLessThanOrEqual(0.5);
  });

  it('生吃不能生吃的東西（肉、海鮮、米、麵粉）永遠不及格', () => {
    for (const t of solids.filter((x) => !INGREDIENTS[x].heat.rawOk)) {
      const a = analyzeDish({ vessel: 'plate', components: [item(t)], seasoning: { salt: 0.5 } });
      expect(a.kind, t).toBe('failed');
      expect(a.quality.total, t).toBeLessThan(40);
    }
  });
});

describe('平衡：調味不能繞過風味模型', () => {
  const base = () => {
    const p = wok().add(cut('ginger', 'MINCED'));
    p.cook(7);
    p.add(item('pork_slices'), cut('onion', 'SLICED'));
    return p.until('pork_slices', 0.2);
  };

  it('一直加調味料不會一直加分：超過剛好的量就開始扣', () => {
    const totals = [1, 2, 4, 6].map((soy) => analyzeDish(base().plate('plate', { soy, oil: 0.5 })).quality.flavor);
    const best = Math.max(...totals);
    expect(totals.at(-1)!).toBeLessThan(best);
  });

  it('什麼調味料都加一大堆：風味分數比正常調味低', () => {
    const normal = analyzeDish(base().plate('plate', { soy: 2, oil: 0.5 })).quality.flavor;
    const all = analyzeDish(base().plate('plate', Object.fromEntries(SEASONING_IDS.map((s) => [s, 2])))).quality.flavor;
    expect(all).toBeLessThan(normal);
  });

  it('沒有調味只有食材的味道：會被說太淡，而不是滿分', () => {
    const a = analyzeDish(soup().add(item('water', { qty: 3 }), cut('cabbage', 'SLICED')).until('cabbage', 0.3).plate('bowl', {}, 3));
    expect(a.notes.some((n) => !n.ok && n.text.includes('太淡'))).toBe(true);
    expect(a.quality.flavor).toBeLessThan(90);
  });
});

describe('平衡：固定食譜不是唯一的高分答案', () => {
  it('不照食譜的好料理也能到「優秀」，而且和食譜料理差不多', () => {
    const free = [
      (() => {
        const p = wok().add(cut('garlic', 'MINCED'));
        p.cook(6);
        p.add(cut('mushroom', 'SLICED'), cut('tofu', 'DICED'));
        p.cook(12);
        p.add(cut('spinach', 'CHOPPED'));
        return analyzeDish(p.until('spinach', 0.3).plate('plate', { soy: 1, oil: 0.5 }));
      })(),
      (() => {
        const p = wok().add(item('pork_slices'));
        p.cook(8);
        p.add(cut('carrot', 'SHRED'), cut('mushroom', 'SLICED'));
        return analyzeDish(p.until('pork_slices', 0.2).plate('plate', { soy: 1.5, oil: 0.5 }));
      })(),
      (() => {
        const o = oven(210).add(cut('cauliflower', 'CHUNK'), cut('carrot', 'CHUNK', { peeled: true }));
        o.until('cauliflower', 0.2);
        return analyzeDish(o.plate('plate', { salt: 0.5, oil: 0.5 }));
      })(),
    ];
    for (const a of free) {
      expect(a.kind).toBe('new');
      expect(a.quality.total, `${a.name} ${JSON.stringify(a.quality)} ${a.notes.filter((n) => !n.ok).map((n) => n.text)}`).toBeGreaterThanOrEqual(75);
    }
    const tomatoEgg = analyzeDish(pan().add(cut('egg', 'BEATEN', { qty: 2 }), cut('tomato', 'DICED')).until('egg', 0.2, { flipEvery: 5 }).plate('plate', { sugar: 0.5, salt: 0.5 }));
    const avgFree = free.reduce((s, a) => s + a.quality.total, 0) / free.length;
    expect(Math.abs(avgFree - tomatoEgg.quality.total)).toBeLessThanOrEqual(15);
  });
});

describe('平衡：委託的限制不互相矛盾', () => {
  it('同一份委託裡：要有的食材沒有被禁止；口味區間的下限不大於上限；做成湯的委託不會要求用盤子', () => {
    for (const c of Object.values(COMMISSIONS)) {
      const forbids = c.require.filter((x): x is Extract<Cond, { k: 'forbid' }> => x.k === 'forbid');
      const banned = (t: IngredientId) => forbids.some((f) => f.ids?.includes(t) || f.cats?.includes(INGREDIENTS[t].category));
      for (const x of c.require) {
        if (x.k === 'hasAll') for (const t of x.ids) expect(banned(t), `${c.id}：${t}`).toBe(false);
        if (x.k === 'has' && x.ids?.length && !x.cats?.length && !x.tags?.length) expect(x.ids.some((t) => !banned(t)), c.id).toBe(true);
      }
      const lo: Partial<Record<FlavorDim, number>> = {};
      const hi: Partial<Record<FlavorDim, number>> = {};
      for (const x of c.require) {
        if (x.k !== 'taste') continue;
        if (x.min !== undefined) lo[x.dim] = Math.max(lo[x.dim] ?? -Infinity, x.min);
        if (x.max !== undefined) hi[x.dim] = Math.min(hi[x.dim] ?? Infinity, x.max);
      }
      for (const d of Object.keys(lo) as FlavorDim[]) expect(lo[d]!, `${c.id} ${d}`).toBeLessThanOrEqual(hi[d] ?? Infinity);
      if (c.require.some((x) => x.k === 'form' && x.forms.every((f) => f === 'soup'))) expect(c.vessel ?? 'bowl', c.id).toBe('bowl');
    }
  });
});

describe('平衡：每一種食材都有用處', () => {
  it('44 種食材都至少出現在一道食譜、一組公開的搭配或一份委託裡', () => {
    const inRecipe = new Set(Object.values(RECIPES).flatMap((r) => r.components.flatMap((c) => [c.type, ...(c.alt ?? [])])));
    const inPair = (t: IngredientId) => PAIRINGS.some((p) => [p.a, p.b].some((k) => (k.startsWith('#') ? INGREDIENTS[t].tags.includes(k.slice(1)) : k === t)));
    const inComm = (t: IngredientId) =>
      Object.values(COMMISSIONS).some((c) => JSON.stringify([...c.require, ...c.bonus.map((b) => b.cond)]).includes(`"${t}"`));
    const unused = INGREDIENT_IDS.filter((t) => !inRecipe.has(t) && !inPair(t) && !inComm(t));
    expect(unused).toEqual([]);
  });
});
