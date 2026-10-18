import { FLAVOR_DIMS, FLAVOR_LABEL, INGREDIENTS, RECIPES, SEASONINGS, isRawProtein, type Cut, type FlavorDim, type IngredientId, type RecipeDef, type SeasoningId, type TasteRange, type Vessel } from './data';
import { BROWN_BURNT, SOAK_MUSHY, cookingState, freshnessState, maxBrown, totalCookSec, type HeatMode, type HistoryEntry, type ItemState, type MixKind } from './model';
import { dishTaste, totalSeasoning } from './taste';

/**
 * 自由料理的判定（料理沙盒擴充 v3.0 第二階段）：純函式、伺服器權威。
 *
 * 輸入只有盤子（碗）裡的東西——每個成分的完整狀態（切法、熟度、上色、受熱秒數、加入的時間）與調味。
 * 不看玩家點了哪張單、也不看料理名稱：同樣的內容永遠得到同樣的名稱、分類與品質。
 *
 *   1. 烹調方式（煎、炒、煮、燉、烤、拌）與成品形式（湯、麵、飯、煎餅、沙拉…）由受熱紀錄推出來。
 *   2. 醬汁狀態（乾、醬汁、奶醬、濃稠、湯、出水）由液體量與增稠食材推出來。
 *   3. 分類：符合某道食譜＝已知；用了替代食材或不同烹調方式＝變體；都不符合＝新創；嚴重失誤＝失敗。
 *   4. 名稱只用實際有的食材、烹調方式與風味特徵組成（名稱不會和內容不符）。
 *   5. 品質四個維度分別計算：烹調、風味平衡、食材搭配、質地；每一項扣分都附上原因。
 */

export type DishComp = Omit<ItemState, 'history'> & { history?: HistoryEntry[] };

export interface DishInput {
  vessel: Vessel;
  components: readonly DishComp[];
  seasoning: Partial<Record<SeasoningId, number>>;
  /** 湯鍋盛起來時鍋裡剩下的湯量（杯）；省略＝用液體成分的份量 */
  liquid?: number;
}

export type CookStyle = 'raw' | 'pan_fry' | 'stir_fry' | 'boil' | 'stew' | 'bake' | 'toast';
export const COOK_STYLE_LABEL: Record<CookStyle, string> = { raw: '生食／拌', pan_fry: '煎', stir_fry: '炒', boil: '煮', stew: '燉', bake: '烤', toast: '烤（烤麵包機）' };

export type DishForm = 'omelette' | 'soup' | 'noodle' | 'rice' | 'porridge' | 'pancake' | 'patty' | 'salad' | 'bake' | 'toast' | 'plate';
export const DISH_FORM_LABEL: Record<DishForm, string> = { omelette: '煎蛋', soup: '湯', noodle: '麵', rice: '飯', porridge: '粥', pancake: '煎餅', patty: '餅', salad: '沙拉', bake: '烤盤', toast: '吐司', plate: '一盤菜' };

export type SauceState = 'dry' | 'saucy' | 'creamy' | 'thick' | 'broth' | 'watery';
export const SAUCE_LABEL: Record<SauceState, string> = { dry: '乾的', saucy: '有醬汁', creamy: '奶醬', thick: '濃稠', broth: '湯', watery: '出水' };

export type DishKind = 'known' | 'variant' | 'new' | 'failed';
export const DISH_KIND_LABEL: Record<DishKind, string> = { known: '已知食譜', variant: '食譜變化', new: '新創料理', failed: '失敗料理' };

export type TextureTag = 'crisp' | 'crust' | 'soft' | 'chewy' | 'creamy';
export const TEXTURE_LABEL: Record<TextureTag, string> = { crisp: '脆', crust: '外酥', soft: '軟嫩', chewy: '彈牙', creamy: '滑順' };

export type QualityDim = 'cook' | 'flavor' | 'pairing' | 'texture';
export const QUALITY_LABEL: Record<QualityDim | 'safety', string> = { cook: '烹調品質', flavor: '風味平衡', pairing: '食材搭配', texture: '質地品質', safety: '食品安全' };
/** 四個維度的權重（企劃書第七章去掉時間後依比例換算） */
export const QUALITY_WEIGHTS: Record<QualityDim, number> = { cook: 33, flavor: 28, pairing: 22, texture: 17 };

export interface DishNote {
  dim: QualityDim | 'safety';
  ok: boolean;
  text: string;
}

/** 料理容器的紀錄（企劃書 5.2）：誰、什麼時候、怎麼處理、加進哪裡 */
export interface DishRecordEntry {
  type: IngredientId;
  qty: number;
  cut: Cut;
  washed: boolean;
  peeled: boolean;
  doneness: number;
  browning: number;
  cookSec: Partial<Record<HeatMode, number>>;
  peakHeat: number;
  /** 最後一次放上熱源（或攪拌碗）的時間與地點 */
  addedAt: number | null;
  addedTo: string | null;
  /** 待過的熱源（一鍋到底的判定） */
  stations: string[];
  mixedWith?: string;
  mixKind?: MixKind;
}

export interface DishAnalysis {
  name: string;
  kind: DishKind;
  /** 已知或變體：對應的食譜 */
  recipeId?: string;
  /** 變體：用了哪些替代、改了什麼 */
  changes?: string[];
  style: CookStyle;
  form: DishForm;
  sauce: SauceState;
  taste: Record<FlavorDim, number>;
  /** 各維度 0–100 與加權總分；有食品安全問題時總分有上限 */
  quality: Record<QualityDim, number> & { total: number };
  cap?: { max: number; why: string };
  notes: DishNote[];
  /** 致命失誤（燒焦、沒熟、生粉…）：有的話一定是失敗料理 */
  fatal?: string;
  /** 圖鑑用的核心特徵：同一道菜（或同一種變化）得到同一個 key */
  key: string;
  /** 吃得出來的口感（脆、外酥、軟嫩、彈牙、滑順） */
  textures: TextureTag[];
  /** 外酥內軟：有成分表面煎烤上色、裡面是軟的 */
  crustSoft: boolean;
  /** 依加入時間排序的成分 */
  order: string[];
  record: DishRecordEntry[];
  seasoning: Partial<Record<SeasoningId, number>>;
}

/* ------------------------------------------------------------------ */
/* 資料：簡稱、搭配                                                       */
/* ------------------------------------------------------------------ */

/** 菜名用的簡稱 */
const SHORT: Partial<Record<IngredientId, string>> = {
  pork_slices: '豬肉',
  beef_slices: '牛肉',
  chicken_breast: '雞肉',
  chicken: '雞腿',
  ground_pork: '肉末',
  white_fish: '魚片',
  shrimp: '蝦仁',
  bean_sprout: '豆芽',
  rice_noodle: '米粉',
  sweet_potato: '地瓜',
  cauliflower: '花椰菜',
  mushroom: '蘑菇',
  egg: '蛋',
  chickpea: '鷹嘴豆',
  scallion: '蔥',
};
export const shortName = (t: IngredientId): string => SHORT[t] ?? INGREDIENTS[t].label;

type PairKey = IngredientId | `#${string}`;
/**
 * 食材搭配（公開資料）：好的組合加分、互相衝突的組合扣分。沒列出來的組合不扣分——罕見組合也能成立。
 * `#標籤` 代表任何帶這個標籤的食材。
 */
export const PAIRINGS: ReadonlyArray<{ a: PairKey; b: PairKey; score: number; why: string }> = [
  { a: 'ginger', b: '#pork', score: 1, why: '薑去腥，配豬肉' },
  { a: 'ginger', b: '#fish', score: 1, why: '薑配魚去腥' },
  { a: 'ginger', b: 'clam', score: 1, why: '薑配蛤蜊' },
  { a: 'garlic', b: 'spinach', score: 1, why: '蒜炒菠菜' },
  { a: 'garlic', b: '#shellfish', score: 1, why: '蒜香海鮮' },
  { a: 'garlic', b: 'eggplant', score: 1, why: '蒜香茄子' },
  { a: 'garlic', b: 'bean_sprout', score: 1, why: '蒜炒豆芽' },
  { a: 'scallion', b: 'egg', score: 1, why: '蔥配蛋' },
  { a: 'scallion', b: 'tofu', score: 1, why: '蔥配豆腐' },
  { a: 'tomato', b: 'egg', score: 1, why: '番茄配蛋' },
  { a: 'onion', b: '#beef', score: 1, why: '洋蔥配牛肉' },
  { a: 'bell_pepper', b: '#beef', score: 1, why: '青椒牛肉' },
  { a: 'bacon', b: 'cabbage', score: 1, why: '培根的油香配高麗菜' },
  { a: 'bacon', b: 'spinach', score: 1, why: '培根菠菜' },
  { a: 'bacon', b: '#pasta', score: 1, why: '培根義大利麵' },
  { a: 'cream', b: '#pasta', score: 1, why: '奶油醬配義大利麵' },
  { a: 'cream', b: 'mushroom', score: 1, why: '奶油蘑菇' },
  { a: 'cheese', b: 'corn', score: 1, why: '起司玉米' },
  { a: 'cheese', b: 'potato', score: 1, why: '起司馬鈴薯' },
  { a: 'cheese', b: 'cauliflower', score: 1, why: '焗烤花椰菜' },
  { a: 'cheese', b: 'bread', score: 1, why: '起司吐司' },
  { a: 'butter', b: 'bread', score: 1, why: '奶油吐司' },
  { a: 'butter', b: 'corn', score: 1, why: '奶油玉米' },
  { a: 'butter', b: 'salmon', score: 1, why: '奶油煎鮭魚' },
  { a: 'butter', b: 'sweet_potato', score: 1, why: '奶油地瓜' },
  { a: 'lemon', b: '#fish', score: 1, why: '檸檬的酸平衡魚的油脂' },
  { a: 'lemon', b: 'shrimp', score: 1, why: '檸檬蝦' },
  { a: 'lemon', b: 'chicken_breast', score: 1, why: '檸檬雞胸' },
  { a: 'egg', b: 'rice', score: 1, why: '蛋炒飯' },
  { a: 'scallion', b: 'rice', score: 1, why: '蔥花配飯' },
  { a: 'tofu', b: 'ground_pork', score: 1, why: '肉末豆腐' },
  { a: 'chili', b: 'tofu', score: 1, why: '辣味豆腐' },
  { a: 'eggplant', b: 'ground_pork', score: 1, why: '肉末茄子' },
  { a: 'carrot', b: 'cabbage', score: 1, why: '高麗菜配胡蘿蔔絲' },
  { a: 'bean_sprout', b: 'rice_noodle', score: 1, why: '豆芽炒米粉' },
  { a: 'cabbage', b: 'rice_noodle', score: 1, why: '高麗菜炒米粉' },
  { a: 'udon', b: '#pork', score: 1, why: '豬肉烏龍麵' },
  { a: 'chickpea', b: 'onion', score: 1, why: '洋蔥配鷹嘴豆' },
  { a: 'milk', b: 'corn', score: 1, why: '玉米濃湯' },
  { a: 'mushroom', b: 'chicken', score: 1, why: '蘑菇雞' },
  { a: 'potato', b: 'onion', score: 1, why: '馬鈴薯洋蔥' },
  { a: 'stock', b: 'onion', score: 1, why: '洋蔥湯' },
  { a: 'spinach', b: 'mushroom', score: 1, why: '菠菜蘑菇' },
  { a: 'shrimp', b: 'egg', score: 1, why: '蝦仁炒蛋' },
  { a: 'clam', b: 'stock', score: 1, why: '蛤蜊高湯' },
  { a: 'pork_slices', b: 'onion', score: 1, why: '洋蔥豬肉' },
  { a: 'lemon', b: 'milk', score: -1, why: '牛奶遇到檸檬酸會結塊' },
  { a: 'lemon', b: 'cream', score: -1, why: '鮮奶油遇到大量檸檬酸會油水分離' },
  { a: 'cheese', b: '#shellfish', score: -1, why: '重口味起司蓋過海鮮的鮮味' },
  { a: 'sweet_potato', b: '#shellfish', score: -1, why: '地瓜的甜和貝類的鹹鮮互搶' },
];

const has = (t: IngredientId, k: PairKey): boolean => (k.startsWith('#') ? INGREDIENTS[t].tags.includes(k.slice(1)) : t === k);

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const r2 = (n: number) => Math.round(n * 100) / 100;
const massOf = (c: DishComp) => INGREDIENTS[c.type].mass * c.qty;
const isLiquid = (c: DishComp) => !!INGREDIENTS[c.type].liquid;
const isMain = (t: IngredientId) => ['meat', 'seafood', 'protein'].includes(INGREDIENTS[t].category) || t === 'egg';
const isStarch = (t: IngredientId) => INGREDIENTS[t].category === 'starch' && t !== 'flour';
const isVeg = (t: IngredientId) => INGREDIENTS[t].category === 'veg';
const isAromatic = (t: IngredientId) => INGREDIENTS[t].category === 'aromatic';
const HEAT_STATION = /^(pan_|stove_|oven|toaster)/;
/** 用來煎炒的油脂（奶油）：只看有沒有燒焦，不看「熟度」 */
export const isCookingFat = (t: IngredientId): boolean => INGREDIENTS[t].tags.includes('fat') && INGREDIENTS[t].category === 'dairy';

/** 最後一次放上熱源（或攪拌碗）的時間與地點 */
function addedOf(c: DishComp): { t: number; at: string } | null {
  const h = c.history ?? [];
  for (let i = h.length - 1; i >= 0; i--) {
    const [op, at] = h[i].op.split(':');
    if (op === 'place' && at && (HEAT_STATION.test(at) || at === 'mixer')) return { t: h[i].t, at };
  }
  return null;
}

/** 待過的熱源 */
function stationsOf(c: DishComp): string[] {
  const out = new Set<string>();
  for (const h of c.history ?? []) {
    const [op, at] = h.op.split(':');
    if (op === 'place' && at && HEAT_STATION.test(at)) out.add(at);
  }
  return [...out];
}

/** 每個成分吃起來的口感 */
export function texturesOf(input: DishInput, sauce: SauceState): { tags: TextureTag[]; crustSoft: boolean } {
  const tags = new Set<TextureTag>();
  let crustSoft = false;
  for (const c of input.components) {
    const d = INGREDIENTS[c.type];
    if (d.liquid) continue;
    const st = cookingState(c);
    if (st === 'BURNT') continue;
    const b = maxBrown(c);
    const crust = st === 'COOKED' && b >= 0.45 && b <= 1.6;
    const crisp = (d.veg && d.texture.crisp >= 0.6 && c.doneness < d.texture.softAt && st !== 'OVERCOOKED') || (c.type === 'bread' && b >= 0.45) || (c.type === 'bacon' && b >= 0.8);
    const softInside = (st === 'COOKED' || st === 'OVERCOOKED') && (d.texture.crisp < 0.6 || c.doneness >= d.texture.softAt) && !d.tags.includes('noodle');
    if (crisp) tags.add('crisp');
    if (crust) tags.add('crust');
    if (crust && softInside && !isRawProtein(d)) crustSoft = true;
    if (crust && softInside && isRawProtein(d) && st === 'COOKED') crustSoft = true;
    if (softInside && (c.type === 'egg' || c.type === 'tofu' || d.texture.fragile || d.category === 'starch' || d.veg || c.mixKind)) tags.add('soft');
    if (d.texture.melts && c.methods.length) tags.add('soft');
    if (st === 'COOKED' && (d.tags.includes('noodle') || c.type === 'shrimp' || (isRawProtein(d) && !d.texture.fragile))) tags.add('chewy');
  }
  if (sauce === 'creamy' || sauce === 'thick') tags.add('creamy');
  return { tags: [...tags], crustSoft };
}

function cookSecSum(comps: readonly DishComp[], mode: HeatMode): number {
  let s = 0;
  let m = 0;
  for (const c of comps) {
    const w = massOf(c);
    s += (c.cookSec?.[mode] ?? 0) * w;
    m += w;
  }
  return m ? s / m : 0;
}

/* ------------------------------------------------------------------ */
/* 烹調方式、形式、醬汁                                                  */
/* ------------------------------------------------------------------ */

const SMALL_CUTS: readonly Cut[] = ['DICED', 'CHOPPED', 'MINCED', 'SHRED', 'GRATED', 'BEATEN', 'MASHED'];

export function cookStyleOf(comps: readonly DishComp[]): CookStyle {
  const solids = comps.filter((c) => !isLiquid(c));
  // 依「最後一次受熱的方式」投票（份量加權）：先煮熟再炒的飯算炒；拌進麵糊的食材跟著主體
  const votes = new Map<HeatMode, number>();
  for (const c of solids) if (c.lastMode && totalCookSec(c) >= 3) votes.set(c.lastMode, (votes.get(c.lastMode) ?? 0) + massOf(c));
  if (!votes.size) return 'raw';
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  if (best === 'toaster') return 'toast';
  if (best === 'oven') return 'bake';
  if (best === 'potDry') return 'stir_fry';
  if (best === 'potLiquid') {
    const inPot = solids.filter((c) => c.lastMode === 'potLiquid');
    return cookSecSum(inPot, 'potLiquid') >= 90 ? 'stew' : 'boil';
  }
  // 平底鍋：小塊、打散、切絲＝炒；整塊或片狀＝煎
  const inPan = solids.filter((c) => c.lastMode === 'pan');
  const total = inPan.reduce((a, c) => a + massOf(c), 0) || 1;
  const small = inPan.filter((c) => SMALL_CUTS.includes(c.cut) || INGREDIENTS[c.type].tags.includes('noodle') || c.type === 'rice').reduce((a, c) => a + massOf(c), 0);
  return small / total >= 0.5 ? 'stir_fry' : 'pan_fry';
}

/** 液體量與增稠：湯、醬汁、奶醬、濃稠、出水 */
export function sauceOf(input: DishInput, style: CookStyle): { state: SauceState; liquid: number; thick: number; released: number } {
  const comps = input.components;
  const free = comps.filter((c) => isLiquid(c) && !c.mixedWith);
  let liquid = input.liquid ?? free.reduce((a, c) => a + c.qty, 0);
  liquid += comps.filter((c) => c.type === 'lemon' && c.cut === 'JUICED').reduce((a, c) => a + 0.2 * c.qty, 0);
  // 含水量高的蔬菜煮過頭會出水
  let released = 0;
  for (const c of comps) {
    const d = INGREDIENTS[c.type];
    if (!d.veg || d.texture.water < 0.8 || !c.methods.length || (c.cookSec?.potLiquid ?? 0) > 0) continue;
    const over = Math.max(0, (c.doneness - d.heat.done[1]) / Math.max(0.5, d.heat.done[1]));
    released += c.qty * d.texture.water * Math.min(1, over) * 0.6;
  }
  liquid += released;
  let thick = 0;
  for (const c of comps) {
    const t = INGREDIENTS[c.type].texture;
    if (!t.thickener) continue;
    const inLiquid = (c.cookSec?.potLiquid ?? 0) > 5;
    const melted = !!t.melts && c.methods.length > 0;
    if (inLiquid || melted || c.cut === 'MASHED' || (isLiquid(c) && !c.mixedWith)) thick += t.thickener * c.qty;
  }
  if (liquid < 0.15) return { state: 'dry', liquid, thick, released };
  const ratio = thick / liquid;
  const dairy = comps.some((c) => INGREDIENTS[c.type].category === 'dairy' && !c.mixedWith);
  let state: SauceState;
  if (ratio >= 0.9) state = 'thick';
  else if (ratio >= 0.35) state = dairy ? 'creamy' : 'saucy';
  else if (liquid >= 1.2 && (input.vessel === 'bowl' || style === 'boil' || style === 'stew')) state = 'broth';
  else if (input.vessel === 'plate' && liquid >= 0.6) state = 'watery';
  else state = 'saucy';
  return { state, liquid: r2(liquid), thick: r2(thick), released: r2(released) };
}

export function dishFormOf(input: DishInput, style: CookStyle, sauce: SauceState): DishForm {
  const comps = input.components;
  const types = new Set(comps.map((c) => c.type));
  if (comps.some((c) => c.mixedWith && c.mixKind === 'batter' && c.type === 'flour') && (style === 'pan_fry' || style === 'stir_fry')) return 'pancake';
  if (comps.some((c) => c.mixKind === 'bound') && (style === 'pan_fry' || style === 'bake')) return 'patty';
  // 蛋液是主體的拌料下鍋煎＝煎蛋（玉米起司煎蛋）
  if (comps.some((c) => c.mixKind === 'tossed' && c.type === 'egg' && c.cut === 'BEATEN' && c.mixedWith === (c as { id?: string }).id) && (style === 'pan_fry' || style === 'stir_fry')) return 'omelette';
  if (types.has('bread') && (style === 'toast' || comps.some((c) => c.type === 'bread' && c.methods.includes('toaster')))) return 'toast';
  if (comps.some((c) => INGREDIENTS[c.type].tags.includes('noodle'))) return 'noodle';
  if (types.has('rice')) return sauce === 'broth' || sauce === 'thick' ? (style === 'stew' || style === 'boil' ? 'porridge' : 'rice') : 'rice';
  if (style === 'raw') return 'salad';
  if (style === 'bake') return 'bake';
  if (sauce === 'broth' || (input.vessel === 'bowl' && (sauce === 'thick' || sauce === 'creamy'))) return 'soup';
  return 'plate';
}

/* ------------------------------------------------------------------ */
/* 食譜比對：已知、變體                                                  */
/* ------------------------------------------------------------------ */

interface Match {
  recipe: RecipeDef;
  exact: number;
  subs: Array<[IngredientId, IngredientId]>;
  methodDiff: string[];
  /** 多出來的食材（不含辛香料） */
  extras: IngredientId[];
  /** 多出來的份量權重：主食材、主食算 2，其他算 1，辛香料不算 */
  extraWeight: number;
}

const isBase = (t: IngredientId) => INGREDIENTS[t].category === 'starch';

const methodOk = (c: DishComp, rc: RecipeDef['components'][number]) => [rc.method, ...(rc.methodAlt ?? [])].some((m) => (m === 'raw' ? c.methods.length === 0 : c.methods.includes(m)));

export function matchRecipe(input: DishInput, recipes: readonly RecipeDef[] = Object.values(RECIPES)): Match | null {
  let best: Match | null = null;
  for (const recipe of recipes) {
    const pool = input.components.filter((c) => !isLiquid(c) || recipe.components.some((rc) => rc.type === c.type || rc.alt?.includes(c.type)));
    const used = new Set<DishComp>();
    let exact = 0;
    const subs: Match['subs'] = [];
    const methodDiff: string[] = [];
    let ok = true;
    for (const rc of recipe.components) {
      let picked = pool.filter((c) => !used.has(c) && c.type === rc.type);
      let sub: IngredientId | null = null;
      if (!picked.length && rc.alt) {
        for (const a of rc.alt) {
          picked = pool.filter((c) => !used.has(c) && c.type === a);
          if (picked.length) {
            sub = a;
            break;
          }
        }
      }
      if (!picked.length) {
        if (rc.optional) continue;
        ok = false;
        break;
      }
      picked.forEach((c) => used.add(c));
      if (sub) subs.push([rc.type, sub]);
      else exact++;
      if (!picked.some((c) => methodOk(c, rc))) {
        const actual = [...new Set(picked.flatMap((c) => c.methods))];
        methodDiff.push(`${shortName(picked[0].type)}${actual.length ? `用${actual.map((m) => ({ pan: '平底鍋', pot: '湯鍋', toaster: '烤麵包機', oven: '烤箱' })[m]).join('、')}` : '沒有加熱'}`);
      }
    }
    if (!ok) continue;
    const extraAll = [...new Set(pool.filter((c) => !used.has(c) && !isLiquid(c)).map((c) => c.type))];
    // 多了主食（飯、麵、麵粉、吐司）而食譜裡沒有：已經是另一種料理（蒜香炒蝦＋義大利麵＝義大利麵）
    const recipeHasBase = recipe.components.some((rc) => isBase(rc.type) || rc.alt?.some(isBase));
    if (!recipeHasBase && extraAll.some(isBase)) continue;
    const extras = extraAll.filter((t) => !isAromatic(t));
    const extraWeight = extras.reduce((a, t) => a + (isMain(t) || isBase(t) ? 2 : 1), 0);
    const core = recipe.components.filter((rc) => !rc.optional).length;
    // 主要特徵要保留：至少一半的必要成分是原本的食材；多出來的份量不超過食譜本身
    if (exact < Math.ceil(core / 2) || extraWeight > core) continue;
    const m: Match = { recipe, exact, subs, methodDiff, extras, extraWeight };
    // 多出來的食材扣得比替代食材多：檸檬奶油白肉魚改用鮭魚，比「香煎鮭魚多加奶油」更接近
    const score = (x: Match) => x.exact * 3 - x.subs.length - x.methodDiff.length - x.extraWeight * 1.5;
    if (!best || score(m) > score(best)) best = m;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 品質                                                                */
/* ------------------------------------------------------------------ */

function cookQuality(comps: readonly DishComp[], style: CookStyle, notes: DishNote[]): { score: number; fatal?: string } {
  let sum = 0;
  let wsum = 0;
  let fatal: string | undefined;
  // 不能生吃又沒熟的食材佔了一大半：整道菜不能吃
  let rawMass = 0;
  let rawName = '';
  let allMass = 0;
  for (const c of comps) {
    const d = INGREDIENTS[c.type];
    if (d.liquid) continue;
    allMass += massOf(c);
    const name = d.label;
    const w = massOf(c) * (isAromatic(c.type) ? 0.5 : 1);
    const st = cookingState(c);
    let s: number;
    if (st === 'BURNT') {
      s = 0;
      notes.push({ dim: 'cook', ok: false, text: c.scorched && maxBrown(c) < BROWN_BURNT && c.doneness < d.heat.burnt ? `鍋底燒焦，${name}帶焦味` : `${name}燒焦了` });
      if (isMain(c.type) || isStarch(c.type) || w >= 1) fatal ??= `${name}燒焦了`;
    } else if (st === 'OVERCOOKED' && isCookingFat(c.type)) {
      s = 1;
    } else if (st === 'OVERCOOKED' && style === 'stew' && c.lastMode === 'potLiquid' && !d.tags.includes('noodle') && c.type !== 'rice') {
      // 燉菜：煮過「剛好熟」是故意的，燉得軟爛入味
      s = 0.95;
    } else if (st === 'OVERCOOKED') {
      s = 0.45;
      notes.push({ dim: 'cook', ok: false, text: `${name}煮過頭了（熟度 ${r2(c.doneness)}，剛好是 ${d.heat.done[0]}–${d.heat.done[1]}）` });
    } else if (st === 'COOKING' || st === 'RAW') {
      const needsWater = d.needsLiquid && (c.cookSec?.potLiquid ?? 0) < 5 && (c.soaked ?? 0) < 1;
      if (d.heat.rawOk && st === 'RAW') {
        s = style === 'raw' ? 1 : 0.9;
      } else if (d.heat.rawOk) {
        s = 0.8;
      } else {
        s = st === 'COOKING' ? 0.25 : 0;
        rawMass += massOf(c);
        rawName ||= name;
        const why = needsWater ? `${name}沒有在水裡煮，所以沒熟（${name}要先用湯鍋加水煮）` : c.type === 'flour' ? '麵粉沒有煮熟，有生粉味' : `${name}還沒熟`;
        notes.push({ dim: 'cook', ok: false, text: why });
        if (isStarch(c.type) || c.type === 'flour' || isMain(c.type)) fatal ??= why;
      }
    } else {
      s = maxBrown(c) > 1.5 ? 0.7 : 1;
      if (s < 1) notes.push({ dim: 'cook', ok: false, text: `${name}表面太焦` });
    }
    if (st === 'COOKED' && maxBrown(c) >= 0.4 && maxBrown(c) <= 1.2 && d.heat.brown >= 0.8 && (style === 'pan_fry' || style === 'bake')) {
      s = Math.min(1, s + 0.05);
      notes.push({ dim: 'cook', ok: true, text: `${name}表面金黃` });
    }
    sum += s * w;
    wsum += w;
  }
  if (allMass && rawMass / allMass >= 0.4) fatal ??= `${rawName}還沒熟`;
  let score = wsum ? sum / wsum : 0;
  // 操作順序：同一個鍋子裡，辛香料比主食材早下鍋（先爆香）
  const placed = comps.map((c) => ({ c, a: addedOf(c) })).filter((x) => x.a && HEAT_STATION.test(x.a.at));
  const arom = placed.filter((x) => isAromatic(x.c.type));
  const mains = placed.filter((x) => !isAromatic(x.c.type) && !isLiquid(x.c));
  const first = arom.find((a) => mains.some((m) => m.a!.at === a.a!.at && m.a!.t - a.a!.t >= 6000 && m.a!.t - a.a!.t <= 120000));
  if (first) {
    const m = mains.find((x) => x.a!.at === first.a!.at && x.a!.t > first.a!.t)!;
    score += 0.06;
    notes.push({ dim: 'cook', ok: true, text: `先爆香${INGREDIENTS[first.c.type].label}，再下${INGREDIENTS[m.c.type].label}` });
  }
  if (notes.every((n) => n.dim !== 'cook' || n.ok) && wsum) notes.push({ dim: 'cook', ok: true, text: '每樣食材的熟度都剛好' });
  return { score: clamp01(score), fatal };
}

/** 風味平衡：有目標（訂單、委託）時看區間；沒有目標時看「好不好吃」的一般規則 */
function flavorQuality(t: Record<FlavorDim, number>, target: Partial<Record<FlavorDim, TasteRange>> | undefined, notes: DishNote[]): { score: number; fatal?: string } {
  let fatal: string | undefined;
  if (target && Object.keys(target).length) {
    const ss: number[] = [];
    for (const [d, r] of Object.entries(target) as Array<[FlavorDim, TasteRange]>) {
      const v = t[d];
      const lo = r.min ?? -Infinity;
      const hi = r.max ?? Infinity;
      const s = v >= lo && v <= hi ? 1 : clamp01(1 - (v < lo ? lo - v : v - hi) * 0.5);
      ss.push(s);
      notes.push({ dim: 'flavor', ok: s === 1, text: `${FLAVOR_LABEL[d]} ${v}（目標 ${r.min ?? 0}–${r.max ?? '∞'}）` });
    }
    if (target.bitter === undefined && t.bitter > 1) {
      ss.push(0.4);
      notes.push({ dim: 'flavor', ok: false, text: `苦味太重（${t.bitter}）` });
    }
    return { score: ss.reduce((a, b) => a + b, 0) / ss.length };
  }
  let s = 1;
  const pen = (amount: number, text: string) => {
    s -= amount;
    notes.push({ dim: 'flavor', ok: false, text });
  };
  const intensity = t.salty + t.sweet + t.sour + t.umami + t.spicy + t.rich;
  if (intensity < 1.0) pen((1.0 - intensity) * 0.6, `味道太淡（整體強度 ${r2(intensity)}）`);
  if (t.salty > 2.4) {
    pen((t.salty - 2.4) * 0.6, `太鹹了（鹹 ${t.salty}）`);
    if (t.salty > 3.2) fatal = `太鹹了（鹹 ${t.salty}）`;
  }
  if (t.sour > 2.2) pen((t.sour - 2.2) * 0.5, `太酸了（酸 ${t.sour}）`);
  if (t.spicy > 2.6) pen((t.spicy - 2.6) * 0.5, `太辣了（辣 ${t.spicy}）`);
  if (t.sweet > 2.6) pen((t.sweet - 2.6) * 0.5, `太甜了（甜 ${t.sweet}）`);
  if (t.rich > 2.6 && t.sour < 0.3) pen((t.rich - 2.6) * 0.5, `太膩了（香濃 ${t.rich}，可以加一點酸平衡）`);
  if (t.bitter > 0.6) {
    pen((t.bitter - 0.6) * 0.8, `有苦味（苦 ${t.bitter}）`);
    if (t.bitter > 2) fatal ??= `苦到不能吃（苦 ${t.bitter}）`;
  }
  if (t.rich >= 1 && t.sour >= 0.3 && t.sour <= 1.6) {
    s += 0.05;
    notes.push({ dim: 'flavor', ok: true, text: '酸味平衡了油脂' });
  }
  if (t.umami >= 0.6 && s >= 0.95) notes.push({ dim: 'flavor', ok: true, text: '鮮味明顯' });
  if (s >= 1 && !notes.some((n) => n.dim === 'flavor' && n.ok)) notes.push({ dim: 'flavor', ok: true, text: '味道平衡' });
  return { score: clamp01(s), fatal };
}

function pairingQuality(comps: readonly DishComp[], form: DishForm, notes: DishNote[]): number {
  const types = [...new Set(comps.map((c) => c.type))];
  const solids = types.filter((t) => !INGREDIENTS[t].liquid);
  if (!solids.length) {
    notes.push({ dim: 'pairing', ok: false, text: '沒有可以吃的固體食材' });
    return 0.1;
  }
  let s = 0.6;
  const mains = solids.filter(isMain);
  const starch = solids.filter(isStarch);
  const veg = solids.filter(isVeg);
  if (mains.length || starch.length || (form === 'salad' && veg.length >= 2) || (form === 'soup' && veg.length)) s += 0.1;
  else {
    s -= 0.25;
    notes.push({ dim: 'pairing', ok: false, text: '沒有主角（肉、海鮮、豆腐、蛋或主食）' });
  }
  if (veg.length || solids.some(isAromatic)) s += 0.1;
  let good = 0;
  for (const p of PAIRINGS) {
    const hitA = types.find((t) => has(t, p.a));
    const hitB = types.find((t) => has(t, p.b) && t !== hitA);
    if (!hitA || !hitB) continue;
    if (p.score > 0) {
      if (good < 3) s += 0.07;
      good++;
      notes.push({ dim: 'pairing', ok: true, text: p.why });
    } else {
      // 檸檬配乳製品：只有一起加熱才會出問題
      if (p.a === 'lemon' && !comps.some((c) => (c.type === p.b) && c.methods.length)) continue;
      s -= 0.15;
      notes.push({ dim: 'pairing', ok: false, text: p.why });
    }
  }
  if (solids.length > 7) {
    s -= 0.1;
    notes.push({ dim: 'pairing', ok: false, text: `食材太雜（${solids.length} 種），吃不出重點` });
  }
  const proteins = solids.filter((t) => isRawProtein(INGREDIENTS[t]));
  if (proteins.length > 2) {
    s -= 0.08;
    notes.push({ dim: 'pairing', ok: false, text: `肉類海鮮放了 ${proteins.length} 種，互相搶味道` });
  }
  if (!notes.some((n) => n.dim === 'pairing')) notes.push({ dim: 'pairing', ok: true, text: '食材組合合理' });
  return clamp01(s);
}

function textureQuality(input: DishInput, form: DishForm, style: CookStyle, sauce: ReturnType<typeof sauceOf>, notes: DishNote[]): { score: number; fatal?: string } {
  let s = 1;
  let fatal: string | undefined;
  const pen = (amount: number, text: string) => {
    s -= amount;
    notes.push({ dim: 'texture', ok: false, text });
  };
  let crisp = 0;
  for (const c of input.components) {
    const d = INGREDIENTS[c.type];
    if (d.liquid) continue;
    const st = cookingState(c);
    const tx = d.texture;
    if (st === 'BURNT') continue; // 已經在烹調品質扣過
    if (d.veg && tx.crisp >= 0.6 && st === 'OVERCOOKED' && style !== 'stew') pen(0.15, `${d.label}${style === 'boil' ? '煮' : '炒'}太久，軟爛沒有口感`);
    if (d.veg && tx.crisp >= 0.6 && (st === 'COOKED' || st === 'RAW' || st === 'COOKING') && c.doneness < tx.softAt) crisp++;
    if (d.tags.includes('noodle') || c.type === 'rice') {
      if (st === 'OVERCOOKED') {
        pen(0.25, `${d.label}煮過頭，糊掉了`);
        if (c.doneness > d.heat.done[1] * 1.5) fatal ??= `${d.label}嚴重糊掉，失去口感`;
      }
      if ((c.soaked ?? 0) > SOAK_MUSHY) pen(0.2, `${d.label}泡太久，爛掉了`);
    }
    if (isRawProtein(d) && st === 'OVERCOOKED') pen(0.12, `${d.label}${d.seafood ? '過熟變硬' : '過熟變得乾柴'}`);
    if (tx.fragile && ((c.flips ?? 0) > 2 || (c.cookSec?.potDry ?? 0) > 25)) pen(0.15, `${d.label}翻動太多，碎掉了`);
    if (tx.melts && c.methods.length && st !== 'OVERCOOKED') notes.push({ dim: 'texture', ok: true, text: `${d.label}融化、牽絲` });
    if (c.mixKind === 'batter' && c.type === 'flour' && st === 'COOKED') notes.push({ dim: 'texture', ok: true, text: '麵糊煎得成形' });
  }
  if (crisp && input.components.some((c) => isMain(c.type) || isStarch(c.type))) {
    s += 0.05;
    notes.push({ dim: 'texture', ok: true, text: '蔬菜保留脆度，口感有層次' });
  }
  if (sauce.state === 'watery') pen(0.2, sauce.released > 0.2 ? '蔬菜出水，盤底都是水' : '湯汁太多，盤底都是水');
  if (form === 'soup' && sauce.liquid < 0.5) pen(0.3, '湯快燒乾了');
  if (input.vessel === 'bowl' && sauce.state === 'dry' && (style === 'boil' || style === 'stew')) pen(0.2, '湯汁幾乎煮乾');
  if ((form === 'noodle' || form === 'rice') && sauce.state === 'thick' && style !== 'stew') pen(0.1, '醬汁太稠，黏成一團');
  if (sauce.state === 'creamy' || (sauce.state === 'thick' && form === 'soup')) notes.push({ dim: 'texture', ok: true, text: sauce.state === 'creamy' ? '醬汁滑順濃郁' : '湯有濃稠度' });
  if (!notes.some((n) => n.dim === 'texture')) notes.push({ dim: 'texture', ok: true, text: '口感正常' });
  return { score: clamp01(s), fatal };
}

/** 食品安全：沒熟的肉、交叉汙染、掉地上、過期——分數上限，也算失敗 */
export function dishSafety(comps: readonly DishComp[], notes: DishNote[]): { max: number; why: string } | undefined {
  let cap: { max: number; why: string } | undefined;
  const lower = (max: number, why: string) => {
    if (!cap || max < cap.max) cap = { max, why };
    notes.push({ dim: 'safety', ok: false, text: why });
  };
  for (const c of comps) {
    const d = INGREDIENTS[c.type];
    if (d.heat.safeTemp && c.maxTemp < d.heat.safeTemp) lower(30, `食品安全：${d.label}中心溫度最高只到 ${Math.round(c.maxTemp)}°C（需要 ${d.heat.safeTemp}°C）`);
    if (c.contaminated && !isRawProtein(d)) lower(40, `交叉汙染：${d.label}在切過生肉、沒擦過的砧板上處理`);
    if (c.floorDirty) lower(30, `${d.label}掉在地上過，沒有重新洗`);
    if (freshnessState(c) === 'EXPIRED') lower(30, `${d.label}已經過期`);
  }
  return cap;
}

/* ------------------------------------------------------------------ */
/* 名稱                                                                */
/* ------------------------------------------------------------------ */

function descriptors(comps: readonly DishComp[], t: Record<FlavorDim, number>, seas: Partial<Record<SeasoningId, number>>): { words: string[]; used: Set<IngredientId> } {
  const types = new Set(comps.map((c) => c.type));
  const words: string[] = [];
  const used = new Set<IngredientId>();
  // 第一組：酸、辛香、調味
  if (types.has('lemon') && t.sour >= 0.5) {
    words.push('檸檬');
    used.add('lemon');
  } else if (t.spicy >= 1.4 || (types.has('chili') && t.spicy >= 0.8)) {
    words.push('辣味');
    used.add('chili');
  } else if (types.has('ginger')) {
    words.push('薑香');
    used.add('ginger');
  } else if (types.has('garlic')) {
    words.push('蒜香');
    used.add('garlic');
  } else if ((seas.pepper ?? 0) >= 0.8) words.push('黑胡椒');
  else if ((seas.soy ?? 0) >= 1 && (seas.sugar ?? 0) >= 0.5) words.push('醬燒');
  else if (types.has('scallion')) {
    words.push('蔥香');
    used.add('scallion');
  }
  // 第二組：乳製品
  if (types.has('cheese')) {
    words.push('起司');
    used.add('cheese');
  } else if (types.has('cream') || (types.has('butter') && types.has('milk'))) {
    words.push('奶油');
    used.add('cream');
    used.add('butter');
  }
  return { words, used };
}

function mainNames(comps: readonly DishComp[], skip: Set<IngredientId>, form: DishForm): string[] {
  const byMass = new Map<IngredientId, number>();
  for (const c of comps) if (!INGREDIENTS[c.type].liquid && !skip.has(c.type)) byMass.set(c.type, (byMass.get(c.type) ?? 0) + massOf(c));
  const sorted = [...byMass.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  const prot = sorted.filter(isMain);
  const veg = sorted.filter((t) => isVeg(t) || (isStarch(t) && !['noodle', 'rice'].includes(form) && !INGREDIENTS[t].tags.includes('noodle') && t !== 'rice' && t !== 'bread'));
  const picked = [...prot.slice(0, 2), ...veg.slice(0, prot.length ? 1 : 2)];
  if (!picked.length) picked.push(...sorted.filter((t) => !isAromatic(t) && t !== 'flour' && t !== 'butter').slice(0, 2));
  return picked.slice(0, 3).map(shortName);
}

const FAIL_PREFIX = (fatal: string | undefined, t: Record<FlavorDim, number>): string => {
  if (!fatal) return '失敗的';
  if (fatal.includes('燒焦')) return '燒焦的';
  if (fatal.includes('太鹹')) return '過鹹的';
  if (fatal.includes('苦')) return '苦掉的';
  if (fatal.includes('糊') || fatal.includes('爛')) return '糊掉的';
  if (fatal.includes('沒熟') || fatal.includes('生粉') || fatal.includes('食品安全') || fatal.includes('中心溫度')) return '沒煮熟的';
  return t.salty > 2.4 ? '過鹹的' : '失敗的';
};

export function nameNewDish(comps: readonly DishComp[], form: DishForm, style: CookStyle, sauce: SauceState, t: Record<FlavorDim, number>, seas: Partial<Record<SeasoningId, number>>): string {
  const { words, used } = descriptors(comps, t, seas);
  const names = mainNames(comps, used, form).join('');
  const d = words.join('');
  const noodle = comps.find((c) => INGREDIENTS[c.type].tags.includes('noodle'));
  switch (form) {
    case 'noodle': {
      const n = shortName(noodle!.type);
      if (sauce === 'broth') return `${d}${names}湯${n}`;
      if (style === 'stir_fry' || style === 'pan_fry') return `${d}${names}炒${n}`;
      return `${d}${names}${n}`;
    }
    case 'rice':
      if (style === 'stir_fry' || style === 'pan_fry') return `${d}${names}炒飯`;
      if (sauce === 'saucy' || sauce === 'creamy' || sauce === 'thick') return `${d}${names}燴飯`;
      return `${d}${names}飯`;
    case 'porridge':
      return `${d}${names}粥`;
    case 'pancake':
      return `${d}${names}煎餅`;
    case 'omelette': {
      const others = mainNames(comps.filter((c) => c.type !== 'egg'), used, form).join('');
      return `${d}${others}煎蛋`;
    }
    case 'patty':
      return `${d}${names}${comps.some((c) => c.mixKind === 'bound' && isRawProtein(INGREDIENTS[c.type])) ? '肉餅' : '餅'}`;
    case 'salad':
      return (seas.soy ?? 0) > 0 || (seas.vinegar ?? 0) > 0 ? `涼拌${d}${names}` : `${d}${names}沙拉`;
    case 'bake':
      return comps.some((c) => c.type === 'cheese' && c.methods.length) ? `焗烤${names}` : `${d}${names}烤盤`;
    case 'toast':
      return `${d}${names}吐司`;
    case 'soup':
      if (style === 'stew') return `${d}${names}煲`;
      if (sauce === 'thick' || sauce === 'creamy') return `${d}${names}濃湯`;
      return `${d}${names}湯`;
    default:
      if (style === 'stir_fry') return `${d}${names}炒`;
      if (style === 'pan_fry') return names.length <= 3 && !d ? `香煎${names}` : `${d}${names}煎盤`;
      if (style === 'boil') return `水煮${d}${names}`;
      if (style === 'stew') return `燉${d}${names}`;
      return `${d}${names}`;
  }
}

/** 變體的名稱：食譜名稱裡出現被替換的食材，就換成實際用的食材；否則加上「（X 版）」；多加的主要食材寫成「（加 X）」 */
function variantName(recipe: RecipeDef, subs: Array<[IngredientId, IngredientId]>, methodDiff: string[], extras: IngredientId[]): string {
  let name = recipe.name;
  const rest: string[] = [];
  for (const [from, to] of subs) {
    const keys = [INGREDIENTS[from].label, shortName(from)];
    const hit = keys.find((k) => name.includes(k));
    if (hit) name = name.replace(hit, shortName(to));
    else rest.push(shortName(to));
  }
  if (rest.length) name += `（${rest.join('、')}版）`;
  if (extras.length) name += `（加${extras.map(shortName).join('、')}）`;
  else if (!subs.length && !rest.length && methodDiff.length) name += '（變化版）';
  return name;
}

/* ------------------------------------------------------------------ */
/* 主程式                                                              */
/* ------------------------------------------------------------------ */

export interface AnalyzeOptions {
  /** 訂單或委託的口味目標（有的話風味平衡改看區間） */
  target?: Partial<Record<FlavorDim, TasteRange>>;
  recipes?: readonly RecipeDef[];
}

export function analyzeDish(input: DishInput, opts: AnalyzeOptions = {}): DishAnalysis {
  const comps = input.components;
  const notes: DishNote[] = [];
  const taste = dishTaste(comps, input.seasoning);
  const seasoning = totalSeasoning(comps, input.seasoning);
  const style = cookStyleOf(comps);
  const sauce = sauceOf(input, style);
  const form = dishFormOf(input, style, sauce.state);

  const cook = cookQuality(comps, style, notes);
  const flavor = flavorQuality(taste, opts.target, notes);
  const pairing = pairingQuality(comps, form, notes);
  const texture = textureQuality(input, form, style, sauce, notes);
  const cap = dishSafety(comps, notes);
  if (!cap) notes.push({ dim: 'safety', ok: true, text: '食品安全沒有問題' });

  const q = { cook: cook.score, flavor: flavor.score, pairing, texture: texture.score };
  const wsum = Object.values(QUALITY_WEIGHTS).reduce((a, b) => a + b, 0);
  let total = (Object.keys(QUALITY_WEIGHTS) as QualityDim[]).reduce((s, k) => s + QUALITY_WEIGHTS[k] * q[k], 0) / wsum * 100;
  if (cap) total = Math.min(total, cap.max);
  if (!comps.length) total = 0;
  const noSolid = comps.length > 0 && comps.every(isLiquid);
  const fatal = !comps.length ? '盤子是空的' : noSolid ? '沒有可以吃的固體食材' : (cap && cap.max <= 30 ? cap.why : undefined) ?? cook.fatal ?? flavor.fatal ?? texture.fatal;

  const match = matchRecipe(input, opts.recipes);
  let kind: DishKind;
  let name: string;
  let changes: string[] | undefined;
  if (match) {
    const isVariant = match.subs.length > 0 || match.methodDiff.length > 0 || match.extraWeight > 1;
    kind = isVariant ? 'variant' : 'known';
    name = isVariant ? variantName(match.recipe, match.subs, match.methodDiff, match.extras) : match.recipe.name;
    changes = [
      ...match.subs.map(([a, b]) => `${shortName(b)}代替${shortName(a)}`),
      ...match.methodDiff,
      ...(match.extras.length ? [`多加了${match.extras.map(shortName).join('、')}`] : []),
    ];
    if (!changes.length) changes = undefined;
  } else {
    kind = 'new';
    name = comps.length ? nameNewDish(comps, form, style, sauce.state, taste, seasoning) : '空盤';
  }
  if (fatal || total < 40) {
    name = `${FAIL_PREFIX(fatal, taste)}${name}`;
    kind = 'failed';
    // 失敗料理的等級一定是「失敗」（0–39）
    total = Math.min(total, 39);
  }

  const record: DishRecordEntry[] = comps.map((c) => {
    const a = addedOf(c);
    return {
      type: c.type,
      qty: c.qty,
      cut: c.cut,
      washed: c.washed,
      peeled: c.peeled,
      doneness: r2(c.doneness),
      browning: r2(maxBrown(c)),
      cookSec: { ...(c.cookSec ?? {}) },
      peakHeat: c.peakHeat ?? 0,
      addedAt: a?.t ?? null,
      addedTo: a?.at ?? null,
      stations: stationsOf(c),
      mixedWith: c.mixedWith,
      mixKind: c.mixKind,
    };
  });
  const order = [...record]
    .map((r, i) => ({ r, i }))
    .sort((x, y) => (x.r.addedAt ?? Infinity) - (y.r.addedAt ?? Infinity) || x.i - y.i)
    .map(({ r }) => INGREDIENTS[r.type].label);

  const coreTypes = [...new Set(comps.filter((c) => !isLiquid(c) && !isAromatic(c.type)).map((c) => c.type))].sort();
  const key = match
    ? kind === 'known' || (kind === 'failed' && !match.subs.length && !match.methodDiff.length)
      ? `r:${match.recipe.id}`
      : `v:${match.recipe.id}:${match.subs.map(([, b]) => b).sort().join('+')}:${match.methodDiff.length ? 'm' : ''}${match.extras.length ? `:+${[...match.extras].sort().join('+')}` : ''}`
    : `n:${form}:${style}:${coreTypes.slice(0, 4).join('+')}`;

  const tx = texturesOf(input, sauce.state);
  return {
    name,
    kind,
    textures: tx.tags,
    crustSoft: tx.crustSoft,
    recipeId: match?.recipe.id,
    changes,
    style,
    form,
    sauce: sauce.state,
    taste,
    quality: {
      cook: Math.round(q.cook * 100),
      flavor: Math.round(q.flavor * 100),
      pairing: Math.round(q.pairing * 100),
      texture: Math.round(q.texture * 100),
      total: Math.round(total),
    },
    cap,
    notes,
    fatal,
    key,
    order,
    record,
    seasoning,
  };
}

/** 品質等級（企劃書 7.2） */
export type QualityGrade = 'fail' | 'barely' | 'pass' | 'great' | 'chef';
export const GRADE_LABEL: Record<QualityGrade, string> = { fail: '失敗', barely: '勉強完成', pass: '合格', great: '優秀', chef: '主廚推薦' };
export function gradeOf(total: number): QualityGrade {
  if (total >= 90) return 'chef';
  if (total >= 75) return 'great';
  if (total >= 60) return 'pass';
  if (total >= 40) return 'barely';
  return 'fail';
}

/** 試吃時的一句話：看起來像什麼（不透露分數） */
export function dishGuess(a: Pick<DishAnalysis, 'name' | 'kind'>): string {
  return a.kind === 'failed' ? `看起來像：${a.name}` : `看起來像：${a.name}（${DISH_KIND_LABEL[a.kind]}）`;
}

export const flavorSummary = (t: Record<FlavorDim, number>): string =>
  FLAVOR_DIMS.filter((d) => t[d] >= 0.4)
    .map((d) => `${FLAVOR_LABEL[d]} ${t[d]}`)
    .join('、') || '幾乎沒有味道';

/** SEASONINGS 只是為了讓這個檔案的依賴清楚（調味的口味已經在 dishTaste 裡） */
void SEASONINGS;
