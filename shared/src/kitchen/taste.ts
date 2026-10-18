import { FLAVOR_DIMS, INGREDIENTS, SEASONINGS, type Flavor, type FlavorDim, type SeasoningId } from './data';
import { flavorBand, type ItemState } from './model';

type Comp = Pick<ItemState, 'type' | 'qty' | 'doneness' | 'brownA' | 'brownB' | 'scorched' | 'seasoning'>;

/** 湯鍋焦底時，每份成分額外的苦味 */
export const SCORCH_BITTER = 1.5;

/** 一道菜的總調味量（盤子上的＋各成分在鍋裡加的） */
export function totalSeasoning(components: readonly Comp[], plate: Partial<Record<SeasoningId, number>>): Partial<Record<SeasoningId, number>> {
  const out: Partial<Record<SeasoningId, number>> = { ...plate };
  for (const c of components) for (const [k, v] of Object.entries(c.seasoning) as Array<[SeasoningId, number]>) out[k] = (out[k] ?? 0) + v;
  return out;
}

/**
 * 口味模型（公開、固定）：每份成分依「口味帶」（生／熟／上色／燒焦）貢獻固定的口味，調味料每單位貢獻固定的口味，
 * 總量除以這道菜的份量（至少 1），得到 0–3 左右的強度。食譜手冊的口味表就是這份資料。
 */
export function dishTaste(components: readonly Comp[], plate: Partial<Record<SeasoningId, number>>): Record<FlavorDim, number> {
  const sum: Record<FlavorDim, number> = { salty: 0, sweet: 0, sour: 0, umami: 0, spicy: 0, bitter: 0, rich: 0 };
  let mass = 0;
  const add = (f: Flavor, k: number) => {
    for (const d of FLAVOR_DIMS) sum[d] += (f[d] ?? 0) * k;
  };
  for (const c of components) {
    const def = INGREDIENTS[c.type];
    add(def.flavor[flavorBand(c)], c.qty);
    if (c.scorched) sum.bitter += SCORCH_BITTER * c.qty;
    mass += def.mass * c.qty;
  }
  for (const [s, units] of Object.entries(totalSeasoning(components, plate)) as Array<[SeasoningId, number]>) add(SEASONINGS[s].flavor, units);
  const m = Math.max(1, mass);
  for (const d of FLAVOR_DIMS) sum[d] = Math.round((sum[d] / m) * 100) / 100;
  return sum;
}

/** 試吃時的形容（所有角色都能試吃；資訊量相同） */
export function tasteWord(v: number): string {
  if (v < 0.4) return '幾乎沒有';
  if (v < 1.0) return '淡淡的';
  if (v < 1.8) return '明顯';
  if (v < 2.6) return '很重';
  return '太重了';
}
