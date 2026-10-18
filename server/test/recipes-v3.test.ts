import { describe, expect, it } from 'vitest';
import {
  BOIL,
  DT,
  INGREDIENTS,
  NEW_RECIPES,
  NEW_RECIPE_IDS,
  RECIPES,
  TOAST_SEC,
  analyzeDish,
  coolItem,
  flipItem,
  heatItem,
  maxBrown,
  newItem,
  type HeatContact,
  type ItemState,
  type PlateComponent,
  type RecipeComponent,
  type RecipeDef,
} from '@last-table/shared';
import { buildSchedule, pickSpecials } from '../src/kitchen/orders';
import { scoreSignature } from '../src/kitchen/scoring';
import { bench } from './bench';

/**
 * 料理沙盒擴充第三階段：24 道新增固定食譜。
 * 每一道都用同一套料理核心：照食譜資料做（處理、下鍋順序、火候、調味），必須被認出是這道菜、而且合格。
 */

let seq = 0;

/** 照食譜做一份成分：處理好、依烹調方式加熱到「剛好熟」區間裡 */
function cookComponent(rc: RecipeComponent, recipe: RecipeDef, t: number, type = rc.type): ItemState {
  const it = newItem(`r${++seq}`, type, 0);
  it.qty = rc.qty;
  if (rc.cut) {
    it.cut = rc.cut;
    it.cutQuality = rc.cut === 'WHOLE' ? null : 0.9;
  }
  const def = INGREDIENTS[type];
  if (def.needsWash || rc.washed) it.washed = true;
  if (def.needsPeel || rc.peeled) it.peeled = true;
  if (def.soakable) it.soaked = 1.2;
  const station = rc.method === 'pan' ? 'pan_a' : rc.method === 'pot' ? 'stove_a' : rc.method === 'oven' ? 'oven' : rc.method === 'toaster' ? 'toaster' : null;
  if (station) it.history.push({ t, op: `place:${station}` });
  if (rc.method === 'raw') return it;
  // 有湯的食譜、或要用水煮的食材（白米、義大利麵）：在湯裡煮
  const wet = recipe.components.some((c) => INGREDIENTS[c.type].liquid && c.method === 'pot') || !!def.needsLiquid;
  const contact: HeatContact =
    rc.method === 'pan'
      ? { method: 'pan', vessel: 165, mode: 'pan' }
      : rc.method === 'pot'
        ? wet
          ? { method: 'pot', vessel: BOIL, mode: 'potLiquid' }
          : { method: 'pot', vessel: 170, mode: 'potDry', sinceStir: 0 }
        : rc.method === 'oven'
          ? { method: 'oven', vessel: 210, mode: 'oven' }
          : { method: 'toaster', vessel: 0, mode: 'toaster', toastLevel: 3 };
  if (rc.method === 'toaster') {
    for (let i = 0; i < TOAST_SEC / DT; i++) heatItem(it, contact);
    return it;
  }
  const band = rc.doneness ?? def.heat.done;
  const hi = Math.min(band[1], def.heat.done[1] * 3);
  const goal = def.liquid ? 0.4 : band[0] + (hi - band[0]) * 0.25;
  const bLo = rc.browning?.[0] ?? 0;
  // 煎：看熟度出鍋；上色不夠就讓朝下那面多煎一下（每 5 秒翻面一次）
  for (let i = 1; i < 6000 && (it.doneness < goal || (rc.browning && maxBrown(it) < bLo)); i++) {
    heatItem(it, contact);
    if (contact.mode === 'pan' && i % 50 === 0) flipItem(it);
  }
  return it;
}

function makeRecipe(recipe: RecipeDef, swap?: { from: string; to: string }) {
  const comps = recipe.components.map((rc, i) => {
    const type = swap && rc.type === swap.from ? (swap.to as RecipeComponent['type']) : rc.type;
    const it = cookComponent(rc, recipe, i * 8000, type);
    for (let k = 0; k < 20; k++) coolItem(it);
    return it as PlateComponent;
  });
  const liquid = recipe.vessel === 'bowl' ? recipe.components.filter((c) => INGREDIENTS[c.type].liquid).reduce((a, c) => a + c.qty, 0) * 0.8 : undefined;
  return { vessel: recipe.vessel, components: comps, seasoning: { ...recipe.seasoning }, liquid };
}

describe('24 道新增食譜：資料', () => {
  it('總共 27 道（24 道新食譜＋3 道招牌菜），都有步驟、品質重點與分類', () => {
    expect(NEW_RECIPE_IDS.length).toBe(24);
    expect(Object.keys(RECIPES).length).toBe(27);
    for (const r of Object.values(NEW_RECIPES)) {
      expect(r.steps.length, r.id).toBeGreaterThanOrEqual(3);
      expect(r.focus?.length, r.id).toBeGreaterThan(0);
      expect(r.group, r.id).toBeDefined();
    }
  });

  it('食譜要求的切法、處理都是這種食材做得到的；食材都在架上有存貨', () => {
    const b = bench();
    const stock = (t: string) => {
      const s = b.sim.stations.get(INGREDIENTS[t as keyof typeof INGREDIENTS].storage === 'FRIDGE' ? 'fridge' : 'pantry')!;
      return (s.stock[t as keyof typeof s.stock] ?? 0) + (s.high[t as keyof typeof s.high] ?? 0);
    };
    for (const r of Object.values(NEW_RECIPES)) {
      for (const rc of r.components) {
        for (const t of [rc.type, ...(rc.alt ?? [])]) {
          const d = INGREDIENTS[t];
          if (rc.cut) expect(d.cuts, `${r.id}：${d.label}不能${rc.cut}`).toContain(rc.cut);
          if (rc.peeled && t === rc.type) expect(d.needsPeel, `${r.id}：${d.label}不用削皮`).toBe(true);
          if (t !== 'water') expect(stock(t), `${r.id}：架上沒有${d.label}`).toBeGreaterThanOrEqual(rc.qty);
        }
        // 液體不能直接下平底鍋（拌進麵糊裡的除外）
        if (rc.method === 'pan' && !r.components.some((c) => c.type === 'flour')) expect(INGREDIENTS[rc.type].liquid, `${r.id}：液體不能下平底鍋`).toBeFalsy();
      }
    }
  });
});

describe('24 道新增食譜：照著做會被認出來，而且合格', () => {
  for (const id of NEW_RECIPE_IDS) {
    it(`${NEW_RECIPES[id].name}`, () => {
      const recipe = NEW_RECIPES[id];
      const plate = makeRecipe(recipe);
      const a = analyzeDish(plate);
      const why = a.notes.filter((n) => !n.ok).map((n) => n.text).join('｜');
      expect(a.recipeId, `${a.name}：${why}`).toBe(id);
      expect(a.kind, `${a.name}：${why}`).toBe('known');
      expect(a.name).toBe(recipe.name);
      expect(a.quality.total, `${a.name}：${why}`).toBeGreaterThanOrEqual(60);
      const r = scoreSignature(recipe, plate, { id: 'o', kind: 'signature', recipeId: id, openedAt: 0 }, recipe.parSec * 1000, 'P1');
      const bad = r.reasons.filter((x) => !x.ok).map((x) => x.text).join('｜');
      expect(r.total, `${recipe.name} 訂單分數：${bad}`).toBeGreaterThanOrEqual(80);
    });
  }
});

describe('替代食材：變體，不是失敗', () => {
  const withAlt = NEW_RECIPE_IDS.flatMap((id) => NEW_RECIPES[id].components.filter((c) => c.alt?.length).map((c) => [id, c.type, c.alt![0]] as const));
  it('至少 10 道食譜有替代食材', () => {
    expect(new Set(withAlt.map((x) => x[0])).size).toBeGreaterThanOrEqual(10);
  });
  for (const [id, from, to] of withAlt) {
    it(`${NEW_RECIPES[id].name}：用${INGREDIENTS[to].label}代替${INGREDIENTS[from].label}`, () => {
      const plate = makeRecipe(NEW_RECIPES[id], { from, to });
      const a = analyzeDish(plate);
      const why = a.notes.filter((n) => !n.ok).map((n) => n.text).join('｜');
      expect(a.kind, `${a.name}：${why}`).toBe('variant');
      expect(a.recipeId).toBe(id);
      expect(a.quality.total, `${a.name}：${why}`).toBeGreaterThanOrEqual(55);
      // 訂單：做出變體還是有分數，只是製程扣一點
      const r = scoreSignature(NEW_RECIPES[id], plate, { id: 'o', kind: 'signature', recipeId: id, openedAt: 0 }, 0, 'P1');
      expect(r.reasons.some((x) => !x.ok && x.text.includes('代替'))).toBe(true);
      expect(r.total).toBeGreaterThan(50);
    });
  }
});

describe('今日特餐', () => {
  it('每一班從新食譜挑兩道不同分類的特餐，同一個種子永遠一樣', () => {
    for (let seed = 1; seed < 40; seed++) {
      const [a, b] = pickSpecials(seed);
      expect(a).not.toBe(b);
      expect(NEW_RECIPES[a].group).not.toBe(NEW_RECIPES[b].group);
      expect(pickSpecials(seed)).toEqual([a, b]);
      const plan = buildSchedule(seed, 3);
      expect(plan.some((p) => p.recipeId === a)).toBe(true);
      expect(plan.some((p) => p.recipeId === b)).toBe(true);
    }
  });

  it('前三張單維持招牌菜（新手先熟悉），特餐放在後半段；廚房狀態列出這一班的菜單', () => {
    const plan = buildSchedule(7, 3);
    expect(plan.slice(0, 4).map((p) => p.recipeId ?? p.kind)).toEqual(['egg_toast', 'free', 'tomato_egg', 'onion_soup']);
    const b = bench({ seed: 7 });
    const menu = b.sim.publicState().menu!;
    expect(menu).toEqual(expect.arrayContaining(['egg_toast', 'tomato_egg', 'onion_soup', ...pickSpecials(7)]));
  });

  it('一個人玩（只有 7 張單）也會有一道特餐', () => {
    for (let seed = 1; seed < 20; seed++) {
      const plan = buildSchedule(seed, 1);
      expect(plan.some((p) => p.recipeId === pickSpecials(seed)[0]), String(seed)).toBe(true);
    }
  });

  it('不同的種子會輪到不同的特餐（24 道都有機會）', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed < 400; seed++) pickSpecials(seed).forEach((x) => seen.add(x));
    expect(seen.size).toBe(24);
  });
});
