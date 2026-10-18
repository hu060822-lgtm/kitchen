import { CATEGORY_NAME, FLAVOR_LABEL, INGREDIENTS, SEASONINGS, type FlavorDim, type IngredientCategory, type IngredientId, type SeasoningId, type TasteRange, type Vessel } from './data';
import { COOK_STYLE_LABEL, DISH_FORM_LABEL, isCookingFat, SAUCE_LABEL, TEXTURE_LABEL, type CookStyle, type DishAnalysis, type DishForm, type DishKind, type QualityGrade, type SauceState, type TextureTag } from './dish';
import { cookingState } from './model';

/**
 * 主廚委託（料理沙盒擴充 v3.0 第四章、第六章、第七章）。
 *
 * 委託不指定食譜，只提出條件；任何符合條件的料理都可以完成。
 * 文字只是給玩家看的，伺服器只依照結構化條件（Cond）判定：
 *   - 必要條件（require）：硬性門檻，和品質分數分開。違反任何一條＝委託沒有達成（分數最多 35），並列出違規原因。
 *   - 加分條件（bonus）：做到了加分（總分最多 100）。
 *   - 品質：烹調 30、風味 25、搭配 20、質地與完成度 15、時間 10（企劃書 7.1）。
 */

export type Cond =
  /** 端上桌時是熱的 */
  | { k: 'hot' }
  /** 至少有 min 種（預設 1）符合的食材 */
  | { k: 'has'; ids?: IngredientId[]; cats?: IngredientCategory[]; tags?: string[]; min?: number; label: string }
  /** 這幾樣都要有 */
  | { k: 'hasAll'; ids: IngredientId[] }
  /** 不能有 */
  | { k: 'forbid'; ids?: IngredientId[]; cats?: IngredientCategory[]; label: string }
  /** 食材種類數：veg＝蔬菜；main＝不算辛香料與液體的固體食材；solid＝所有固體食材 */
  | { k: 'distinct'; of: 'veg' | 'main' | 'solid'; min?: number; max?: number }
  | { k: 'taste'; dim: FlavorDim; min?: number; max?: number }
  /** 兩種味道的差距不超過 max（酸甜平衡） */
  | { k: 'tasteDiff'; a: FlavorDim; b: FlavorDim; max: number }
  /** 至少 n 種味道吃得出來（≥ 0.4） */
  | { k: 'flavorVariety'; n: number }
  | { k: 'form'; forms: DishForm[] }
  | { k: 'sauce'; states: SauceState[] }
  | { k: 'style'; styles: CookStyle[] }
  /** 可以吃：沒有致命失誤、沒有食品安全問題 */
  | { k: 'edible' }
  | { k: 'notBurnt' }
  /** 不能加這些調味料 */
  | { k: 'noSeasoning'; ids: SeasoningId[] }
  | { k: 'seasoningMin'; id: SeasoningId; n: number }
  /** 這些口感都要有 */
  | { k: 'textures'; all?: TextureTag[]; min?: number }
  | { k: 'crustSoft' }
  /** 所有加熱都在同一個鍋具完成 */
  | { k: 'onePot' }
  /** 從出單到出餐的秒數 */
  | { k: 'withinSec'; sec: number }
  | { k: 'quality'; dim: 'total' | 'cook' | 'flavor' | 'pairing' | 'texture'; min: number }
  /** 指定的食材（省略＝全部）熟度都在「剛好熟」區間 */
  | { k: 'inBand'; ids?: IngredientId[]; tags?: string[]; cats?: IngredientCategory[] }
  /** 這些食材有上色（煎香、炒香） */
  | { k: 'browned'; min?: number; max?: number }
  /** 起司之類的融化了 */
  | { k: 'melted'; id: IngredientId }
  | { k: 'kind'; kinds: DishKind[] }
  /** 同一口鍋先爆香辛香料 */
  | { k: 'aromaticFirst' };

export interface Bonus {
  cond: Cond;
  pts: number;
  text: string;
}

export interface CommissionDef {
  id: string;
  /** 企劃書的編號 1–20 */
  no: number;
  title: string;
  /** 主廚的原話（給玩家看） */
  text: string;
  difficulty: 1 | 2 | 3;
  require: Cond[];
  bonus: Bonus[];
  /** 風味目標（品質的「風味平衡」看這個區間） */
  taste: Partial<Record<FlavorDim, TasteRange>>;
  vessel?: Vessel;
  hot?: boolean;
  parSec: number;
  /** 限時委託：客人等的時間就是時限 */
  timeLimitSec?: number;
  /** 委託期間的特殊狀況（只改變取得資訊的方式，不改料理規則） */
  effects?: { probeBroken?: boolean };
  /** 缺貨的食材（只在判定與說明裡出現） */
  outOfStock?: IngredientId[];
  /** 謠言（傳聞卡）用的關鍵食材 */
  include?: IngredientId[];
  /** 可能的解法（給玩家看） */
  solutions: string;
  reward: { coins: number };
}

const MEAT: IngredientCategory[] = ['meat'];
const MAIN_CATS: IngredientCategory[] = ['meat', 'seafood', 'protein'];

export const COMMISSIONS: Record<string, CommissionDef> = {
  meat_savory: {
    id: 'meat_savory',
    no: 1,
    title: '熱騰騰的肉香',
    text: '我想吃熱的、有肉香，鹹香一點的料理。',
    difficulty: 1,
    hot: true,
    parSec: 200,
    require: [{ k: 'hot' }, { k: 'has', cats: MEAT, label: '肉類' }, { k: 'taste', dim: 'salty', min: 0.8, max: 2.2 }, { k: 'taste', dim: 'rich', min: 0.8 }],
    bonus: [
      { cond: { k: 'inBand', cats: MEAT }, pts: 4, text: '肉的熟度剛好' },
      { cond: { k: 'browned', min: 0.4, max: 1.4 }, pts: 3, text: '有煎香或炒香' },
      { cond: { k: 'taste', dim: 'rich', max: 2.4 }, pts: 3, text: '不會太油膩' },
    ],
    taste: { salty: { min: 0.8, max: 2.2 }, rich: { min: 0.8, max: 2.4 } },
    solutions: '黑胡椒牛肉、薑炒豬肉、培根高麗菜',
    reward: { coins: 30 },
  },
  sour_sweet: {
    id: 'sour_sweet',
    no: 2,
    title: '酸甜開胃',
    text: '來一道酸酸甜甜的料理，但我不吃蛋。',
    difficulty: 1,
    parSec: 150,
    require: [{ k: 'forbid', ids: ['egg'], label: '不吃蛋' }, { k: 'taste', dim: 'sour', min: 0.8 }, { k: 'taste', dim: 'sweet', min: 0.8 }, { k: 'edible' }],
    bonus: [
      { cond: { k: 'tasteDiff', a: 'sour', b: 'sweet', max: 0.6 }, pts: 4, text: '酸甜平衡' },
      { cond: { k: 'taste', dim: 'rich', max: 1.6 }, pts: 3, text: '不油膩' },
      { cond: { k: 'has', ids: ['lemon', 'tomato', 'scallion', 'ginger'], label: '清新的香氣' }, pts: 3, text: '有清新的香氣（檸檬、番茄、蔥、薑）' },
    ],
    taste: { sour: { min: 0.8, max: 2.2 }, sweet: { min: 0.8, max: 2.4 } },
    include: ['tomato'],
    solutions: '檸檬風味蔬菜、番茄燉魚、檸檬煎魚',
    reward: { coins: 30 },
  },
  light_soup: {
    id: 'light_soup',
    no: 3,
    title: '清淡熱湯',
    text: '一碗清淡的熱湯就好。',
    difficulty: 1,
    vessel: 'bowl',
    hot: true,
    parSec: 200,
    require: [{ k: 'form', forms: ['soup'] }, { k: 'hot' }, { k: 'taste', dim: 'rich', max: 1.2 }],
    bonus: [
      { cond: { k: 'sauce', states: ['broth'] }, pts: 3, text: '湯底清澈' },
      { cond: { k: 'taste', dim: 'salty', min: 0.3, max: 1.0 }, pts: 3, text: '鹹度適中' },
      { cond: { k: 'inBand' }, pts: 4, text: '食材熟度合理' },
    ],
    taste: { salty: { max: 1.2 }, umami: { min: 0.6 }, rich: { max: 1.2 }, bitter: { max: 0.3 } },
    solutions: '蛤蜊蔬菜湯、薑香雞湯、豆腐蔬菜煲',
    reward: { coins: 30 },
  },
  spicy_mushroom: {
    id: 'spicy_mushroom',
    no: 4,
    title: '辣味與菇類',
    text: '我要辣的，而且一定要有菇。',
    difficulty: 1,
    hot: true,
    parSec: 160,
    require: [{ k: 'has', ids: ['mushroom'], label: '蘑菇' }, { k: 'taste', dim: 'spicy', min: 1.2 }, { k: 'notBurnt' }],
    bonus: [
      { cond: { k: 'inBand', ids: ['mushroom'] }, pts: 4, text: '菇保留口感' },
      { cond: { k: 'taste', dim: 'umami', min: 0.6 }, pts: 3, text: '辣味和鮮味平衡' },
    ],
    taste: { spicy: { min: 1.2, max: 3.2 } },
    include: ['mushroom'],
    solutions: '辣味蘑菇豆腐煲、辣味菇類炒肉',
    reward: { coins: 30 },
  },
  veggie: {
    id: 'veggie',
    no: 5,
    title: '蔬菜主義',
    text: '不要肉，至少兩種蔬菜，味道你決定。',
    difficulty: 1,
    parSec: 150,
    require: [{ k: 'forbid', cats: ['meat', 'seafood'], label: '不要肉和海鮮' }, { k: 'distinct', of: 'veg', min: 2 }, { k: 'edible' }],
    bonus: [
      { cond: { k: 'distinct', of: 'veg', min: 3 }, pts: 3, text: '蔬菜種類更多' },
      { cond: { k: 'textures', min: 2 }, pts: 3, text: '有不同口感' },
      { cond: { k: 'flavorVariety', n: 2 }, pts: 3, text: '風味不單調' },
    ],
    taste: { bitter: { max: 0.4 } },
    solutions: '花椰菜高麗菜煎盤、蔬菜炒米粉、豆腐蔬菜煲',
    reward: { coins: 30 },
  },
  crisp_and_soft: {
    id: 'crisp_and_soft',
    no: 6,
    title: '脆口與柔軟',
    text: '我想要同一道料理裡有脆口和柔軟的部分。',
    difficulty: 2,
    parSec: 200,
    require: [{ k: 'textures', all: ['soft'] }, { k: 'textures', min: 2 }, { k: 'edible' }],
    bonus: [
      { cond: { k: 'textures', all: ['crisp', 'soft'] }, pts: 4, text: '脆和軟的對比明顯' },
      { cond: { k: 'quality', dim: 'flavor', min: 80 }, pts: 3, text: '調味均勻' },
    ],
    taste: {},
    solutions: '香煎雞胸搭配炒高麗菜、煎豆腐搭配蔬菜',
    reward: { coins: 50 },
  },
  creamy: {
    id: 'creamy',
    no: 7,
    title: '奶香料理',
    text: '做一道奶香明顯，但不能膩的料理。',
    difficulty: 2,
    parSec: 220,
    require: [{ k: 'has', ids: ['milk', 'cream', 'butter', 'cheese'], label: '牛奶、鮮奶油、奶油或起司' }, { k: 'taste', dim: 'rich', min: 1.2, max: 2.6 }],
    bonus: [
      { cond: { k: 'quality', dim: 'flavor', min: 80 }, pts: 3, text: '奶香和其他風味平衡' },
      { cond: { k: 'sauce', states: ['creamy', 'thick'] }, pts: 4, text: '醬汁質地滑順' },
    ],
    taste: { rich: { min: 1.2, max: 2.6 } },
    include: ['cream'],
    solutions: '玉米濃湯、奶油菠菜炒蛋、奶油義大利麵',
    reward: { coins: 50 },
  },
  three_items: {
    id: 'three_items',
    no: 8,
    title: '三種食材的限制',
    text: '只能使用三種主要食材，做出一道完整的料理。',
    difficulty: 2,
    parSec: 180,
    require: [{ k: 'distinct', of: 'main', max: 3 }, { k: 'edible' }, { k: 'quality', dim: 'total', min: 40 }],
    bonus: [
      { cond: { k: 'quality', dim: 'flavor', min: 80 }, pts: 4, text: '風味平衡' },
      { cond: { k: 'quality', dim: 'pairing', min: 70 }, pts: 3, text: '食材搭配得好' },
    ],
    taste: {},
    solutions: '香煎鮭魚、奶油菠菜炒蛋、香煎豆腐',
    reward: { coins: 50 },
  },
  corn_cheese: {
    id: 'corn_cheese',
    no: 9,
    title: '指定食材挑戰',
    text: '這道料理一定要有玉米與起司。',
    difficulty: 1,
    parSec: 180,
    require: [{ k: 'hasAll', ids: ['corn', 'cheese'] }, { k: 'edible' }],
    bonus: [
      { cond: { k: 'melted', id: 'cheese' }, pts: 4, text: '起司融化得剛好' },
      { cond: { k: 'inBand', ids: ['corn'] }, pts: 3, text: '玉米保留口感' },
      { cond: { k: 'quality', dim: 'pairing', min: 70 }, pts: 3, text: '風味協調' },
    ],
    taste: {},
    include: ['corn'],
    solutions: '玉米起司煎蛋、起司玉米烤盤',
    reward: { coins: 30 },
  },
  no_oil: {
    id: 'no_oil',
    no: 10,
    title: '不能使用油',
    text: '今天不能用油，做一道好吃的熱食。',
    difficulty: 2,
    hot: true,
    parSec: 200,
    require: [{ k: 'noSeasoning', ids: ['oil'] }, { k: 'hot' }, { k: 'edible' }],
    bonus: [
      { cond: { k: 'notBurnt' }, pts: 3, text: '沒有因為沒油而燒焦' },
      { cond: { k: 'quality', dim: 'cook', min: 80 }, pts: 4, text: '熟度掌握得好' },
    ],
    taste: {},
    solutions: '水煮料理、湯品，或用食材本身的油脂（培根）',
    reward: { coins: 50 },
  },
  rush: {
    id: 'rush',
    no: 11,
    title: '限時出餐',
    text: '在時間結束前，交出一份完整的熱食。',
    difficulty: 2,
    hot: true,
    parSec: 90,
    timeLimitSec: 150,
    require: [{ k: 'withinSec', sec: 150 }, { k: 'hot' }, { k: 'edible' }, { k: 'quality', dim: 'total', min: 40 }],
    bonus: [{ cond: { k: 'withinSec', sec: 90 }, pts: 5, text: '提前完成（90 秒內）' }],
    taste: {},
    solutions: '蒜香炒蝦、培根高麗菜、香煎雞胸肉吐司',
    reward: { coins: 50 },
  },
  noodle_pro: {
    id: 'noodle_pro',
    no: 12,
    title: '麵食專家',
    text: '我要一道麵食，麵條必須有口感。',
    difficulty: 2,
    parSec: 240,
    require: [{ k: 'has', tags: ['noodle'], label: '麵條（義大利麵、烏龍麵或米粉）' }, { k: 'inBand', tags: ['noodle'] }, { k: 'sauce', states: ['dry', 'saucy', 'creamy', 'broth'] }],
    bonus: [
      { cond: { k: 'sauce', states: ['saucy', 'creamy'] }, pts: 3, text: '醬汁附著在麵上' },
      { cond: { k: 'inBand' }, pts: 4, text: '配料熟度合理' },
    ],
    taste: {},
    include: ['udon'],
    solutions: '牛肉烏龍麵、蒜香蝦仁義大利麵、蔬菜炒米粉',
    reward: { coins: 50 },
  },
  one_pot: {
    id: 'one_pot',
    no: 13,
    title: '一鍋完成',
    text: '不要弄得太複雜，用一個鍋具完成整道料理。',
    difficulty: 2,
    hot: true,
    parSec: 240,
    require: [{ k: 'onePot' }, { k: 'style', styles: ['pan_fry', 'stir_fry', 'boil', 'stew', 'bake'] }, { k: 'edible' }],
    bonus: [
      { cond: { k: 'aromaticFirst' }, pts: 3, text: '操作順序合理（先爆香）' },
      { cond: { k: 'inBand' }, pts: 4, text: '沒有食材因為下鍋時間不對而過熟' },
    ],
    taste: {},
    solutions: '肉末茄子、豆腐蔬菜煲、番茄燉魚',
    reward: { coins: 50 },
  },
  umami: {
    id: 'umami',
    no: 14,
    title: '鮮味大師',
    text: '我要鮮味明顯，但不能只靠加鹽。',
    difficulty: 2,
    parSec: 220,
    require: [{ k: 'taste', dim: 'umami', min: 1.0 }, { k: 'taste', dim: 'salty', max: 1.8 }],
    bonus: [
      { cond: { k: 'has', cats: ['seafood'], ids: ['mushroom', 'stock', 'tomato'], label: '鮮味的來源' }, pts: 4, text: '用海鮮、菇類、高湯等食材帶出鮮味' },
      { cond: { k: 'flavorVariety', n: 3 }, pts: 3, text: '風味有層次' },
    ],
    taste: { umami: { min: 1.0 }, salty: { max: 1.8 } },
    include: ['clam'],
    solutions: '蛤蜊蔬菜湯、蝦仁炒飯、海鮮炒麵',
    reward: { coins: 50 },
  },
  substitute: {
    id: 'substitute',
    no: 15,
    title: '食材替代',
    text: '原本要做黑胡椒牛肉，但牛肉缺貨了。請用現有食材完成一道合理的替代主菜。',
    difficulty: 2,
    vessel: 'plate',
    parSec: 200,
    outOfStock: ['beef_slices'],
    require: [{ k: 'forbid', ids: ['beef_slices'], label: '牛肉缺貨' }, { k: 'has', cats: MAIN_CATS, ids: ['egg'], label: '代替的主食材（肉、海鮮、豆腐、鷹嘴豆或蛋）' }, { k: 'edible' }],
    bonus: [
      { cond: { k: 'seasoningMin', id: 'pepper', n: 0.8 }, pts: 4, text: '保留黑胡椒的風味方向' },
      { cond: { k: 'has', cats: ['protein'], label: '植物性蛋白' }, pts: 3, text: '用豆腐或鷹嘴豆做出主菜' },
    ],
    taste: {},
    solutions: '黑胡椒豬肉、黑胡椒豆腐、鷹嘴豆煎餅',
    reward: { coins: 50 },
  },
  crispy_outside: {
    id: 'crispy_outside',
    no: 16,
    title: '外酥內軟',
    text: '我想要外層有香脆感，裡面則柔軟。',
    difficulty: 3,
    parSec: 200,
    require: [{ k: 'crustSoft' }, { k: 'notBurnt' }],
    bonus: [
      { cond: { k: 'browned', min: 0.45, max: 1.2 }, pts: 3, text: '外層褐變適當' },
      { cond: { k: 'inBand' }, pts: 4, text: '裡面熟度合理' },
    ],
    taste: {},
    include: ['sweet_potato'],
    solutions: '香煎地瓜、蔬菜煎餅、香煎豆腐',
    reward: { coins: 80 },
  },
  thick_soup: {
    id: 'thick_soup',
    no: 17,
    title: '濃湯挑戰',
    text: '做一道濃湯，不能只是把水煮得很鹹。',
    difficulty: 3,
    vessel: 'bowl',
    hot: true,
    parSec: 240,
    require: [{ k: 'form', forms: ['soup'] }, { k: 'sauce', states: ['thick', 'creamy'] }, { k: 'taste', dim: 'salty', max: 1.6 }],
    bonus: [
      { cond: { k: 'has', ids: ['flour', 'potato', 'corn', 'chickpea', 'cream', 'cheese', 'sweet_potato'], label: '濃稠的來源' }, pts: 3, text: '有合理的濃稠來源' },
      { cond: { k: 'quality', dim: 'flavor', min: 80 }, pts: 3, text: '風味平衡' },
      { cond: { k: 'notBurnt' }, pts: 3, text: '沒有結塊或燒焦' },
    ],
    taste: { salty: { max: 1.6 } },
    include: ['corn'],
    solutions: '玉米濃湯、花椰菜奶油濃湯',
    reward: { coins: 80 },
  },
  no_meat_no_egg: {
    id: 'no_meat_no_egg',
    no: 18,
    title: '雙重限制',
    text: '不要肉、不要蛋，而且至少要有三種不同食材。',
    difficulty: 2,
    parSec: 220,
    require: [{ k: 'forbid', cats: MEAT, label: '不要肉' }, { k: 'forbid', ids: ['egg'], label: '不要蛋' }, { k: 'distinct', of: 'solid', min: 3 }, { k: 'edible' }],
    bonus: [
      { cond: { k: 'textures', min: 2 }, pts: 3, text: '質地多樣' },
      { cond: { k: 'quality', dim: 'flavor', min: 80 }, pts: 3, text: '風味平衡' },
      { cond: { k: 'has', cats: ['protein', 'starch', 'seafood'], label: '蛋白質或澱粉' }, pts: 3, text: '有蛋白質或澱粉來源' },
    ],
    taste: {},
    solutions: '豆腐蔬菜煲、鷹嘴豆蔬菜燉菜',
    reward: { coins: 50 },
  },
  timer_broken: {
    id: 'timer_broken',
    no: 19,
    title: '異常廚房',
    text: '廚房的溫度計失靈了。做一道需要精確掌握火候的煎炒料理——靠眼睛、耳朵、手感或隊友。',
    difficulty: 3,
    hot: true,
    parSec: 200,
    effects: { probeBroken: true },
    require: [{ k: 'style', styles: ['pan_fry', 'stir_fry'] }, { k: 'inBand' }, { k: 'edible' }],
    bonus: [{ cond: { k: 'quality', dim: 'cook', min: 85 }, pts: 5, text: '火候精準' }],
    taste: {},
    solutions: '香煎鮭魚、蒜香炒蝦、奶油菠菜炒蛋',
    reward: { coins: 80 },
  },
  chef_choice: {
    id: 'chef_choice',
    no: 20,
    title: '主廚的自由命題',
    text: '今天由你決定菜色。請用現有食材做出一道讓人願意再吃一次的料理。',
    difficulty: 1,
    parSec: 240,
    require: [{ k: 'edible' }, { k: 'quality', dim: 'total', min: 40 }],
    bonus: [
      { cond: { k: 'kind', kinds: ['new', 'variant'] }, pts: 5, text: '自己發想的料理或食譜變化' },
      { cond: { k: 'quality', dim: 'flavor', min: 80 }, pts: 3, text: '風味平衡' },
      { cond: { k: 'quality', dim: 'cook', min: 80 }, pts: 3, text: '烹調品質好' },
    ],
    taste: {},
    solutions: '任何你想做的料理',
    reward: { coins: 30 },
  },
};
export const COMMISSION_IDS = Object.keys(COMMISSIONS);
/** 舊名稱（主廚自選）：訂單的 requestId 指向委託 */
export const FREE_REQUESTS = COMMISSIONS;
export const FREE_REQUEST_IDS = COMMISSION_IDS;
export type FreeRequest = CommissionDef;
/** 開班先出的入門委託（前半段） */
export const STARTER_COMMISSIONS = ['meat_savory', 'sour_sweet', 'light_soup', 'spicy_mushroom', 'veggie'];

/* ------------------------------------------------------------------ */
/* 條件的說明文字與判定                                                  */
/* ------------------------------------------------------------------ */

const names = (ids: readonly IngredientId[]) => ids.map((t) => INGREDIENTS[t].label).join('、');
const range = (min?: number, max?: number) => (min !== undefined && max !== undefined ? `${min}–${max}` : min !== undefined ? `至少 ${min}` : `最多 ${max}`);

/** 給玩家看的條件說明（和判定用同一份資料，不會不一致） */
export function condLabel(c: Cond): string {
  switch (c.k) {
    case 'hot':
      return '端上桌時是熱的';
    case 'has':
      return c.min === 0 ? c.label : `要有${c.label}${c.min && c.min > 1 ? `（至少 ${c.min} 種）` : ''}`;
    case 'hasAll':
      return `一定要有${names(c.ids)}`;
    case 'forbid':
      return c.label;
    case 'distinct':
      return `${c.of === 'veg' ? '蔬菜' : c.of === 'main' ? '主要食材（不算辛香料）' : '食材'}${range(c.min, c.max)} 種`;
    case 'taste':
      return `${FLAVOR_LABEL[c.dim]}${range(c.min, c.max)}`;
    case 'tasteDiff':
      return `${FLAVOR_LABEL[c.a]}和${FLAVOR_LABEL[c.b]}差不多`;
    case 'flavorVariety':
      return `至少吃得出 ${c.n} 種味道`;
    case 'form':
      return `要做成${c.forms.map((f) => DISH_FORM_LABEL[f]).join('或')}`;
    case 'sauce':
      return `醬汁：${c.states.map((x) => SAUCE_LABEL[x]).join('或')}`;
    case 'style':
      return `烹調方式：${c.styles.map((x) => COOK_STYLE_LABEL[x]).join('、')}`;
    case 'edible':
      return '可以吃（沒有燒焦、沒熟或食品安全問題）';
    case 'notBurnt':
      return '不能燒焦';
    case 'noSeasoning':
      return `不能加${c.ids.map((x) => SEASONINGS[x].label).join('、')}`;
    case 'seasoningMin':
      return `${SEASONINGS[c.id].label}至少 ${c.n}`;
    case 'textures':
      return c.all ? `要有${c.all.map((x) => TEXTURE_LABEL[x]).join('和')}的口感` : `至少 ${c.min} 種口感`;
    case 'crustSoft':
      return '外層煎烤上色、裡面柔軟';
    case 'onePot':
      return '只用一個鍋具（平底鍋、湯鍋或烤箱其中一個）';
    case 'withinSec':
      return `${c.sec} 秒內出餐`;
    case 'quality':
      return `${c.dim === 'total' ? '料理品質' : { cook: '烹調品質', flavor: '風味平衡', pairing: '食材搭配', texture: '質地品質' }[c.dim]}至少 ${c.min}`;
    case 'inBand':
      return c.ids ? `${names(c.ids)}熟度剛好` : c.tags?.includes('noodle') ? '麵條熟度剛好（有口感）' : c.cats ? `${c.cats.map((x) => CATEGORY_NAME[x]).join('、')}熟度剛好` : '每樣食材熟度都剛好';
    case 'browned':
      return '有煎香或炒香（表面上色）';
    case 'melted':
      return `${INGREDIENTS[c.id].label}融化`;
    case 'kind':
      return '自己發想的料理';
    case 'aromaticFirst':
      return '先爆香辛香料';
  }
}

export interface JudgeContext {
  analysis: DishAnalysis;
  vessel: Vessel;
  /** 端上桌時的溫度 */
  temp: number;
  /** 從出單到出餐的秒數 */
  elapsedSec: number;
  hotTemp: number;
}

const matches = (t: IngredientId, ids?: readonly IngredientId[], cats?: readonly IngredientCategory[], tags?: readonly string[]) =>
  !!ids?.includes(t) || !!cats?.includes(INGREDIENTS[t].category) || !!tags?.some((g) => INGREDIENTS[t].tags.includes(g));

/** 判定一個條件；回傳是否通過與說明（不通過時說明為什麼） */
export function judge(c: Cond, ctx: JudgeContext): { ok: boolean; text: string } {
  const a = ctx.analysis;
  const types = [...new Set(a.record.map((r) => r.type))];
  const solids = types.filter((t) => !INGREDIENTS[t].liquid);
  const label = condLabel(c);
  const res = (ok: boolean, why?: string) => ({ ok, text: ok ? label : why ?? `沒有做到：${label}` });
  switch (c.k) {
    case 'hot':
      return res(ctx.temp >= ctx.hotTemp, `已經涼了（${Math.round(ctx.temp)}°C）`);
    case 'has': {
      const hit = types.filter((t) => matches(t, c.ids, c.cats, c.tags));
      return res(hit.length >= (c.min ?? 1), `沒有${c.label}`);
    }
    case 'hasAll': {
      const miss = c.ids.filter((t) => !types.includes(t));
      return res(!miss.length, `少了${names(miss)}`);
    }
    case 'forbid': {
      const hit = types.filter((t) => matches(t, c.ids, c.cats));
      return res(!hit.length, `用了${names(hit)}（${c.label}）`);
    }
    case 'distinct': {
      const list = c.of === 'veg' ? solids.filter((t) => INGREDIENTS[t].category === 'veg') : c.of === 'main' ? solids.filter((t) => INGREDIENTS[t].category !== 'aromatic') : solids;
      const n = list.length;
      const ok = (c.min === undefined || n >= c.min) && (c.max === undefined || n <= c.max);
      return res(ok, `${c.of === 'veg' ? '蔬菜' : c.of === 'main' ? '主要食材' : '食材'}有 ${n} 種（要${range(c.min, c.max)} 種）`);
    }
    case 'taste': {
      const v = a.taste[c.dim];
      const ok = (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
      return res(ok, `${FLAVOR_LABEL[c.dim]} ${v}（要${range(c.min, c.max)}）`);
    }
    case 'tasteDiff':
      return res(Math.abs(a.taste[c.a] - a.taste[c.b]) <= c.max, `${FLAVOR_LABEL[c.a]} ${a.taste[c.a]}、${FLAVOR_LABEL[c.b]} ${a.taste[c.b]}，差太多`);
    case 'flavorVariety': {
      const n = (Object.keys(a.taste) as FlavorDim[]).filter((d) => d !== 'bitter' && a.taste[d] >= 0.4).length;
      return res(n >= c.n, `只吃得出 ${n} 種味道`);
    }
    case 'form':
      return res(c.forms.includes(a.form), `做出來的是${DISH_FORM_LABEL[a.form]}`);
    case 'sauce':
      return res(c.states.includes(a.sauce), `醬汁是「${SAUCE_LABEL[a.sauce]}」`);
    case 'style':
      return res(c.styles.includes(a.style), `烹調方式是「${COOK_STYLE_LABEL[a.style]}」`);
    case 'edible':
      return res(!a.fatal && !a.cap, a.fatal ?? a.cap?.why ?? '不能吃');
    case 'notBurnt': {
      const burnt = a.record.filter((r) => cookingState({ type: r.type, doneness: r.doneness, brownA: r.browning, brownB: r.browning, scorched: false }) === 'BURNT');
      return res(!burnt.length && !(a.fatal ?? '').includes('燒焦'), `${names(burnt.map((r) => r.type)) || '料理'}燒焦了`);
    }
    case 'noSeasoning': {
      const used = c.ids.filter((x) => (a.seasoning[x] ?? 0) > 0);
      return res(!used.length, `加了${used.map((x) => SEASONINGS[x].label).join('、')}`);
    }
    case 'seasoningMin':
      return res((a.seasoning[c.id] ?? 0) >= c.n, `${SEASONINGS[c.id].label}只有 ${Math.round((a.seasoning[c.id] ?? 0) * 10) / 10}`);
    case 'textures': {
      const ok = (!c.all || c.all.every((x) => a.textures.includes(x))) && (c.min === undefined || a.textures.length >= c.min);
      return res(ok, `吃得出的口感：${a.textures.map((x) => TEXTURE_LABEL[x]).join('、') || '沒有特別的口感'}`);
    }
    case 'crustSoft':
      return res(a.crustSoft, '沒有外層煎香、裡面柔軟的部分');
    case 'onePot': {
      const st = new Set(a.record.flatMap((r) => r.stations));
      return res(st.size <= 1 && st.size > 0, st.size ? `用了 ${st.size} 個鍋具` : '沒有加熱');
    }
    case 'withinSec':
      return res(ctx.elapsedSec <= c.sec, `花了 ${Math.round(ctx.elapsedSec)} 秒（要 ${c.sec} 秒內）`);
    case 'quality': {
      const v = a.quality[c.dim];
      return res(v >= c.min, `${label.replace(/至少.*/, '')} ${v}（要至少 ${c.min}）`);
    }
    case 'inBand': {
      const list = a.record.filter((r) => !INGREDIENTS[r.type].liquid && !isCookingFat(r.type) && (!c.ids && !c.tags && !c.cats ? true : matches(r.type, c.ids, c.cats, c.tags)));
      const off = list.filter((r) => {
        const h = INGREDIENTS[r.type].heat;
        const st = cookingState({ type: r.type, doneness: r.doneness, brownA: r.browning, brownB: r.browning, scorched: false });
        if (st === 'BURNT' || st === 'OVERCOOKED') return a.style !== 'stew' || !!INGREDIENTS[r.type].tags.includes('noodle') || st === 'BURNT';
        if (st === 'RAW' || st === 'COOKING') return !h.rawOk;
        return false;
      });
      return res(list.length > 0 && !off.length, list.length ? `${names(off.map((r) => r.type))}熟度不對` : '沒有這樣的食材');
    }
    case 'browned': {
      const hit = a.record.filter((r) => r.browning >= (c.min ?? 0.4) && r.browning <= (c.max ?? 1.6) && r.cookSec && (r.cookSec.pan || r.cookSec.potDry || r.cookSec.oven));
      return res(hit.length > 0, '沒有煎香或炒香（表面沒有上色）');
    }
    case 'melted': {
      const r = a.record.find((x) => x.type === c.id);
      return res(!!r && Object.values(r.cookSec).some((v) => (v ?? 0) >= 3), `${INGREDIENTS[c.id].label}沒有加熱融化`);
    }
    case 'kind':
      return res(c.kinds.includes(a.kind), '照著現成食譜做的');
    case 'aromaticFirst':
      return res(a.notes.some((n) => n.ok && n.text.startsWith('先爆香')), '沒有先爆香');
  }
}

/* ------------------------------------------------------------------ */
/* 委託評分（企劃書第七章）                                               */
/* ------------------------------------------------------------------ */

export const COMMISSION_WEIGHTS = { cook: 30, flavor: 25, pairing: 20, texture: 15, time: 10 } as const;
/** 違反必要條件時，委託分數的上限 */
export const COMMISSION_FAIL_CAP = 35;
/** 等級的獎勵倍率 */
export const GRADE_REWARD: Record<QualityGrade, number> = { fail: 0, barely: 0.5, pass: 1, great: 1.3, chef: 1.6 };

/** 時間分數（10 分）：標準時間內滿分，之後遞減 */
export function timeScore(elapsedSec: number, parSec: number): number {
  if (elapsedSec <= parSec) return 1;
  if (elapsedSec <= parSec * 2) return 1 - ((elapsedSec - parSec) / parSec) * 0.7;
  return Math.max(0, 0.3 - ((elapsedSec - parSec * 2) / parSec) * 0.3);
}

