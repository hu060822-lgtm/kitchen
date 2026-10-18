/**
 * 料理的公開資料：食材、調味料、口味表、招牌菜與 24 道新食譜（主廚委託在 commissions.ts）。
 *
 * 所有規則都是公開、固定、可學習的：遊戲內的「食譜手冊」直接顯示這份資料。
 * 伺服器的評分只使用這裡的數值，恐怖事件完全不會讀取或修改它們。
 */

export type IngredientId =
  | 'egg' | 'bread' | 'butter' | 'onion' | 'tomato' | 'potato' | 'chicken' | 'mushroom' | 'garlic' | 'scallion' | 'chili' | 'stock'
  // v3 擴充：蔬菜與香辛
  | 'carrot' | 'cabbage' | 'spinach' | 'bell_pepper' | 'eggplant' | 'corn' | 'cauliflower' | 'ginger' | 'bean_sprout'
  // 肉類與植物性蛋白質
  | 'chicken_breast' | 'pork_slices' | 'beef_slices' | 'bacon' | 'sausage' | 'ground_pork' | 'tofu' | 'chickpea'
  // 海鮮
  | 'salmon' | 'white_fish' | 'shrimp' | 'clam'
  // 主食與澱粉
  | 'rice' | 'spaghetti' | 'flour' | 'udon' | 'sweet_potato' | 'rice_noodle'
  // 乳製品與特色食材
  | 'milk' | 'cheese' | 'cream' | 'lemon' | 'water';
export type SeasoningId = 'salt' | 'sugar' | 'soy' | 'vinegar' | 'pepper' | 'oil';
export type Cut = 'WHOLE' | 'SLICED' | 'DICED' | 'CHOPPED' | 'MINCED' | 'BEATEN' | 'CHUNK' | 'SHRED' | 'GRATED' | 'MASHED' | 'JUICED';
export type FlavorDim = 'salty' | 'sweet' | 'sour' | 'umami' | 'spicy' | 'bitter' | 'rich';
export type Flavor = Partial<Record<FlavorDim, number>>;
/** 口味帶：生、熟、上色（焦香）、燒焦 */
export type FlavorBand = 'raw' | 'cooked' | 'browned' | 'burnt';
export type Storage = 'FRIDGE' | 'PANTRY';
export type Method = 'pan' | 'pot' | 'toaster' | 'oven';
export const METHOD_LABEL: Record<Method, string> = { pan: '平底鍋', pot: '湯鍋', toaster: '烤麵包機', oven: '烤箱' };

export const FLAVOR_DIMS: readonly FlavorDim[] = ['salty', 'sweet', 'sour', 'umami', 'spicy', 'bitter', 'rich'];
export const FLAVOR_LABEL: Record<FlavorDim, string> = { salty: '鹹', sweet: '甜', sour: '酸', umami: '鮮', spicy: '辛辣', bitter: '苦', rich: '香濃' };

export const CUT_LABEL: Record<Cut, string> = {
  WHOLE: '整塊',
  SLICED: '切片',
  DICED: '切丁',
  CHOPPED: '切碎',
  MINCED: '剁末',
  BEATEN: '打散',
  CHUNK: '切塊',
  SHRED: '切絲',
  GRATED: '刨碎',
  MASHED: '壓碎',
  JUICED: '擠汁',
};
/** 切得越細，熱傳得越快 */
export const CUT_HEAT_FACTOR: Record<Cut, number> = { WHOLE: 0.55, SLICED: 1, DICED: 1.15, CHOPPED: 1.25, MINCED: 1.45, BEATEN: 1.3, CHUNK: 0.8, SHRED: 1.35, GRATED: 1.5, MASHED: 1.4, JUICED: 1.6 };
/** 每種切法需要的刀數（節奏操作的次數；壓碎、擠汁、刨碎也用同一套節奏） */
export const CUT_STROKES: Record<Cut, number> = { WHOLE: 0, SLICED: 5, DICED: 8, CHOPPED: 6, MINCED: 12, BEATEN: 6, CHUNK: 4, SHRED: 10, GRATED: 8, MASHED: 5, JUICED: 3 };

/** 食材分類（冷藏架／乾貨架的分頁、委託的條件） */
export type IngredientCategory = 'veg' | 'aromatic' | 'meat' | 'seafood' | 'protein' | 'starch' | 'dairy' | 'other';
export const CATEGORY_NAME: Record<IngredientCategory, string> = {
  veg: '蔬菜',
  aromatic: '辛香',
  meat: '肉類',
  seafood: '海鮮',
  protein: '蛋與豆',
  starch: '主食',
  dairy: '乳製品',
  other: '其他',
};
export const CATEGORY_ORDER: readonly IngredientCategory[] = ['veg', 'aromatic', 'meat', 'seafood', 'protein', 'starch', 'dairy', 'other'];

/**
 * 質地（伺服器依熟度計算當下的質地；評分的「質地品質」與委託的「脆口／柔軟」用這份資料）
 *   crisp：生的時候有多脆（0–1）；熟度達到 softAt 時脆度降到 0（變軟）
 *   water：含水量（0–1）：高含水量的蔬菜煮過頭會出水
 *   thickener：在湯鍋裡讓湯變濃稠的能力（麵粉、起司、鮮奶油、壓碎的玉米或豆子）
 *   fragile：容易碎（魚、豆腐）：翻面或攪拌太多次會碎掉
 *   absorbs：會吸收油與醬汁（茄子、豆腐）
 *   fat：加熱會釋出油脂（培根、香腸）
 */
export interface TextureProfile {
  crisp: number;
  softAt: number;
  water: number;
  thickener?: number;
  fragile?: boolean;
  absorbs?: boolean;
  fat?: boolean;
  /** 會融化（起司） */
  melts?: boolean;
}

export interface HeatProfile {
  /** 內部溫度追上鍋溫的速度（每秒比例，整塊時再乘切法係數） */
  k: number;
  /** 開始變熟的溫度（°C） */
  cookStart: number;
  /** 熟度：剛好熟的區間 [最低, 最高]；超過最高＝過熟 */
  done: [number, number];
  /** 熟度達到這個值＝燒焦 */
  burnt: number;
  /** 表面上色速度倍率（0＝不會上色，例如高湯） */
  brown: number;
  /** 食品安全：中心溫度必須曾經達到這個值（°C） */
  safeTemp?: number;
  /** 可以生吃（例如蔥花、番茄） */
  rawOk: boolean;
}

export interface IngredientDef {
  id: IngredientId;
  label: string;
  unit: string;
  storage: Storage;
  /** 離開冷藏後會開始不新鮮（秒數＝從新鮮到過期） */
  shelfSec: number | null;
  needsWash: boolean;
  /** 切之前必須削皮／剝皮 */
  needsPeel: boolean;
  cuts: Cut[];
  /** 液體（倒進湯鍋） */
  liquid?: boolean;
  /** 生的時候會汙染砧板（生肉） */
  contaminates?: boolean;
  /** 口味計算時的份量權重 */
  mass: number;
  heat: HeatProfile;
  flavor: Record<FlavorBand, Flavor>;
  /** 每次從架上拿出來的數量 */
  takeQty: number;
  /** 開店時的庫存 */
  stock: number;
  veg?: boolean;
  meat?: boolean;
  /** 海鮮（委託的「不要肉或海鮮」、生食材的交叉汙染） */
  seafood?: boolean;
  /** 分類（貨架分頁） */
  category: IngredientCategory;
  /** 委託條件用的標籤（例：dairy、noodle、egg、processed、salty、acid） */
  tags: string[];
  texture: TextureProfile;
  /** 一定要在液體裡煮才會熟（生米、乾麵條）；乾鍋只會變硬、焦掉 */
  needsLiquid?: boolean;
  /** 泡過水就可以直接炒（米粉） */
  soakable?: boolean;
  /** 簡短說明（食譜手冊） */
  note?: string;
}

/** 生的蛋白質（肉類與海鮮）：會汙染砧板、放肉類成品架 */
export const isRawProtein = (def: Pick<IngredientDef, 'meat' | 'seafood'>): boolean => !!def.meat || !!def.seafood;

const H = (k: number, cookStart: number, done: [number, number], burnt: number, brown: number, rawOk: boolean, safeTemp?: number): HeatProfile => ({
  k,
  cookStart,
  done,
  burnt,
  brown,
  rawOk,
  safeTemp,
});

export const INGREDIENTS: Record<IngredientId, IngredientDef> = {
  egg: {
    id: 'egg', label: '雞蛋', unit: '顆', storage: 'FRIDGE', shelfSec: 900, needsWash: false, needsPeel: false, cuts: ['WHOLE', 'BEATEN'],
    mass: 0.6, takeQty: 1, stock: 14, heat: H(0.22, 62, [1.0, 2.6], 5.0, 1.0, false),
    flavor: { raw: { umami: 0.3, rich: 0.2 }, cooked: { umami: 0.9, rich: 0.6 }, browned: { umami: 1.0, rich: 0.9, bitter: 0.1 }, burnt: { bitter: 2.5, rich: 0.3 } },
    category: 'protein', tags: ['egg', 'protein'], texture: { crisp: 0, softAt: 99, water: 0.7 },
  },
  bread: {
    id: 'bread', label: '吐司', unit: '片', storage: 'PANTRY', shelfSec: null, needsWash: false, needsPeel: false, cuts: ['WHOLE'],
    mass: 0.5, takeQty: 1, stock: 10, heat: H(0.3, 60, [0.2, 3.0], 6.0, 1.0, true),
    flavor: { raw: { sweet: 0.3, rich: 0.2 }, cooked: { sweet: 0.4, rich: 0.5 }, browned: { sweet: 0.4, rich: 0.8 }, burnt: { bitter: 2.5 } },
    category: 'starch', tags: ['starch', 'bread'], texture: { crisp: 0.2, softAt: 99, water: 0.3 },
  },
  butter: {
    id: 'butter', label: '奶油', unit: '份', storage: 'FRIDGE', shelfSec: 1200, needsWash: false, needsPeel: false, cuts: ['WHOLE'],
    mass: 0.2, takeQty: 1, stock: 12, heat: H(0.5, 35, [0.1, 4.0], 7.0, 1.2, true),
    flavor: { raw: { rich: 2.0, salty: 0.3 }, cooked: { rich: 2.2, sweet: 0.2 }, browned: { rich: 2.4, umami: 0.3 }, burnt: { bitter: 2.0 } },
    category: 'dairy', tags: ['dairy', 'fat'], texture: { crisp: 0, softAt: 99, water: 0.2, melts: true },
  },
  onion: {
    id: 'onion', label: '洋蔥', unit: '顆', storage: 'PANTRY', shelfSec: null, needsWash: false, needsPeel: true, cuts: ['WHOLE', 'SLICED', 'DICED', 'CHOPPED', 'MINCED'],
    mass: 1, takeQty: 1, stock: 10, veg: true, heat: H(0.12, 70, [0.8, 8.0], 11.0, 1.6, true),
    flavor: { raw: { spicy: 1.2, sweet: 0.3 }, cooked: { sweet: 1.0, umami: 0.3 }, browned: { sweet: 1.8, umami: 0.7, rich: 0.4 }, burnt: { bitter: 2.5 } },
    category: 'veg', tags: ['veg', 'aromatic'], texture: { crisp: 0.8, softAt: 2.0, water: 0.8 },
  },
  tomato: {
    id: 'tomato', label: '番茄', unit: '顆', storage: 'FRIDGE', shelfSec: 1200, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'DICED', 'CHOPPED', 'CHUNK'],
    mass: 1, takeQty: 1, stock: 10, veg: true, heat: H(0.15, 65, [0.8, 3.0], 6.0, 0.5, true),
    flavor: { raw: { sour: 1.2, sweet: 0.5, umami: 0.4 }, cooked: { sour: 0.9, sweet: 0.8, umami: 1.0 }, browned: { sweet: 1.0, umami: 1.2, bitter: 0.2 }, burnt: { bitter: 2.2 } },
    category: 'veg', tags: ['veg', 'acid', 'red'], texture: { crisp: 0.3, softAt: 1.0, water: 0.95 },
  },
  potato: {
    id: 'potato', label: '馬鈴薯', unit: '顆', storage: 'PANTRY', shelfSec: null, needsWash: true, needsPeel: true, cuts: ['WHOLE', 'SLICED', 'DICED'],
    mass: 1.2, takeQty: 1, stock: 8, veg: true, heat: H(0.06, 75, [1.0, 3.5], 6.5, 0.9, false),
    flavor: { raw: { bitter: 0.6 }, cooked: { sweet: 0.4, rich: 0.5 }, browned: { sweet: 0.5, rich: 1.0 }, burnt: { bitter: 2.0 } },
    category: 'veg', tags: ['veg', 'starch'], texture: { crisp: 0.9, softAt: 1.2, water: 0.6, thickener: 0.3 },
  },
  chicken: {
    id: 'chicken', label: '雞腿肉', unit: '塊', storage: 'FRIDGE', shelfSec: 300, needsWash: false, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'DICED'], contaminates: true,
    mass: 1.2, takeQty: 1, stock: 8, meat: true, heat: H(0.07, 60, [1.2, 3.2], 6.0, 1.0, false, 74),
    flavor: { raw: { umami: 0.4 }, cooked: { umami: 1.5, rich: 0.8 }, browned: { umami: 1.8, rich: 1.3 }, burnt: { bitter: 2.5, rich: 0.5 } },
    category: 'meat', tags: ['meat', 'chicken'], texture: { crisp: 0, softAt: 99, water: 0.7 },
  },
  mushroom: {
    id: 'mushroom', label: '蘑菇', unit: '份', storage: 'FRIDGE', shelfSec: 900, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'CHOPPED'],
    mass: 0.4, takeQty: 1, stock: 8, veg: true, heat: H(0.2, 60, [0.8, 3.5], 6.0, 1.0, false),
    flavor: { raw: { umami: 0.5 }, cooked: { umami: 1.5 }, browned: { umami: 1.8, rich: 0.5 }, burnt: { bitter: 2.0 } },
    category: 'veg', tags: ['veg', 'mushroom', 'umami'], texture: { crisp: 0.4, softAt: 1.5, water: 0.9 },
  },
  garlic: {
    id: 'garlic', label: '大蒜', unit: '瓣', storage: 'PANTRY', shelfSec: null, needsWash: false, needsPeel: true, cuts: ['WHOLE', 'SLICED', 'MINCED'],
    mass: 0.1, takeQty: 1, stock: 12, veg: true, heat: H(0.3, 60, [0.5, 1.6], 2.4, 1.6, true),
    flavor: { raw: { spicy: 1.6 }, cooked: { rich: 1.0, sweet: 0.4, spicy: 0.3 }, browned: { rich: 1.4, sweet: 0.5 }, burnt: { bitter: 3.0 } },
    category: 'aromatic', tags: ['aromatic'], texture: { crisp: 0.5, softAt: 1.0, water: 0.5 },
  },
  scallion: {
    id: 'scallion', label: '蔥', unit: '根', storage: 'FRIDGE', shelfSec: 900, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'CHOPPED', 'SLICED'],
    mass: 0.1, takeQty: 1, stock: 12, veg: true, heat: H(0.35, 60, [0.3, 1.5], 3.0, 1.2, true),
    flavor: { raw: { spicy: 0.5, rich: 0.2 }, cooked: { sweet: 0.3, rich: 0.4 }, browned: { rich: 0.6 }, burnt: { bitter: 2.0 } },
    category: 'aromatic', tags: ['aromatic', 'green'], texture: { crisp: 0.6, softAt: 0.8, water: 0.8 },
  },
  chili: {
    id: 'chili', label: '辣椒', unit: '根', storage: 'FRIDGE', shelfSec: 1200, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'MINCED'],
    mass: 0.1, takeQty: 1, stock: 10, veg: true, heat: H(0.35, 60, [0.3, 2.0], 3.5, 1.0, true),
    flavor: { raw: { spicy: 2.5 }, cooked: { spicy: 2.0, rich: 0.3 }, browned: { spicy: 2.0, rich: 0.6 }, burnt: { bitter: 2.0, spicy: 1.5 } },
    category: 'aromatic', tags: ['aromatic', 'spicy', 'red'], texture: { crisp: 0.6, softAt: 1.5, water: 0.7 },
  },
  stock: {
    id: 'stock', label: '高湯', unit: '杯', storage: 'PANTRY', shelfSec: null, needsWash: false, needsPeel: false, cuts: ['WHOLE'], liquid: true,
    mass: 0.6, takeQty: 1, stock: 16, heat: H(0.4, 50, [0.3, 99], 99, 0, true),
    flavor: { raw: { umami: 1.0, salty: 0.4 }, cooked: { umami: 1.2, salty: 0.4 }, browned: { umami: 1.2, salty: 0.4 }, burnt: { bitter: 1.5 } },
    category: 'other', tags: ['liquid', 'umami'], texture: { crisp: 0, softAt: 99, water: 1 },
  },

  /* ---------------- v3 擴充：蔬菜與香辛 ---------------- */
  carrot: {
    id: 'carrot', label: '胡蘿蔔', unit: '根', storage: 'FRIDGE', shelfSec: 1800, needsWash: true, needsPeel: true, cuts: ['WHOLE', 'SLICED', 'DICED', 'CHOPPED', 'SHRED', 'CHUNK'],
    mass: 1, takeQty: 1, stock: 8, veg: true, heat: H(0.08, 70, [1.0, 5.0], 9.0, 0.9, true),
    flavor: { raw: { sweet: 0.6, bitter: 0.1 }, cooked: { sweet: 1.2 }, browned: { sweet: 1.4, rich: 0.4 }, burnt: { bitter: 2.4 } },
    category: 'veg', tags: ['veg', 'orange', 'sweet'], texture: { crisp: 0.9, softAt: 3.0, water: 0.5 },
    note: '切得越細越快軟；燉久了甜味更明顯',
  },
  cabbage: {
    id: 'cabbage', label: '高麗菜', unit: '份', storage: 'FRIDGE', shelfSec: 1500, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'CHOPPED', 'SHRED'],
    mass: 1, takeQty: 1, stock: 8, veg: true, heat: H(0.25, 60, [0.6, 3.0], 6.0, 0.8, true),
    flavor: { raw: { sweet: 0.3, bitter: 0.1 }, cooked: { sweet: 0.7, umami: 0.2 }, browned: { sweet: 0.9, rich: 0.5 }, burnt: { bitter: 2.2 } },
    category: 'veg', tags: ['veg', 'leafy', 'green'], texture: { crisp: 0.8, softAt: 2.0, water: 0.9 },
    note: '大火快炒保留脆度；煮久了變軟、出水',
  },
  spinach: {
    id: 'spinach', label: '菠菜', unit: '把', storage: 'FRIDGE', shelfSec: 900, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'CHOPPED'],
    mass: 0.6, takeQty: 1, stock: 8, veg: true, heat: H(0.5, 55, [0.3, 1.2], 3.5, 0.6, true),
    flavor: { raw: { bitter: 0.4, umami: 0.2 }, cooked: { umami: 0.5, sweet: 0.2 }, browned: { rich: 0.4, umami: 0.5 }, burnt: { bitter: 2.5 } },
    category: 'veg', tags: ['veg', 'leafy', 'green'], texture: { crisp: 0.3, softAt: 0.6, water: 0.9 },
    note: '熟得很快；加熱太久會失去顏色和口感',
  },
  bell_pepper: {
    id: 'bell_pepper', label: '青椒', unit: '顆', storage: 'FRIDGE', shelfSec: 1500, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'DICED'],
    mass: 0.8, takeQty: 1, stock: 8, veg: true, heat: H(0.25, 60, [0.5, 2.5], 5.0, 1.0, true),
    flavor: { raw: { bitter: 0.5, sweet: 0.2 }, cooked: { sweet: 0.4, bitter: 0.2 }, browned: { sweet: 0.5, rich: 0.5 }, burnt: { bitter: 2.4 } },
    category: 'veg', tags: ['veg', 'green'], texture: { crisp: 0.9, softAt: 2.0, water: 0.8 },
    note: '快炒保留脆度與青香；久煮生青味變淡',
  },
  eggplant: {
    id: 'eggplant', label: '茄子', unit: '根', storage: 'FRIDGE', shelfSec: 1500, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'CHUNK', 'DICED'],
    mass: 1, takeQty: 1, stock: 6, veg: true, heat: H(0.15, 65, [1.2, 5.0], 8.0, 0.9, false),
    flavor: { raw: { bitter: 0.6 }, cooked: { umami: 0.3, rich: 0.5, sweet: 0.2 }, browned: { rich: 0.9, umami: 0.3 }, burnt: { bitter: 2.4 } },
    category: 'veg', tags: ['veg', 'purple'], texture: { crisp: 0.5, softAt: 1.5, water: 0.7, absorbs: true },
    note: '會吸油、吸醬汁；燉軟後最入味',
  },
  corn: {
    id: 'corn', label: '玉米', unit: '份', storage: 'FRIDGE', shelfSec: 1800, needsWash: false, needsPeel: false, cuts: ['WHOLE', 'CHOPPED', 'MASHED'],
    mass: 0.6, takeQty: 1, stock: 8, veg: true, heat: H(0.25, 60, [0.6, 4.0], 7.0, 0.8, true),
    flavor: { raw: { sweet: 0.8 }, cooked: { sweet: 1.4 }, browned: { sweet: 1.5, rich: 0.5 }, burnt: { bitter: 2.0 } },
    category: 'veg', tags: ['veg', 'sweet', 'yellow'], texture: { crisp: 0.6, softAt: 3.0, water: 0.6, thickener: 0.35 },
    note: '整粒保留顆粒感；壓碎後可以讓湯變濃',
  },
  cauliflower: {
    id: 'cauliflower', label: '花椰菜', unit: '份', storage: 'FRIDGE', shelfSec: 1500, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'CHUNK', 'CHOPPED'],
    mass: 1, takeQty: 1, stock: 6, veg: true, heat: H(0.1, 65, [1.0, 4.0], 8.0, 1.0, true),
    flavor: { raw: { bitter: 0.3, sweet: 0.2 }, cooked: { sweet: 0.5, umami: 0.3 }, browned: { sweet: 0.6, rich: 0.8 }, burnt: { bitter: 2.3 } },
    category: 'veg', tags: ['veg', 'white'], texture: { crisp: 0.8, softAt: 3.0, water: 0.7 },
    note: '煮的時間決定脆度；烤過表面會乾香',
  },
  ginger: {
    id: 'ginger', label: '薑', unit: '塊', storage: 'PANTRY', shelfSec: null, needsWash: true, needsPeel: true, cuts: ['WHOLE', 'SLICED', 'CHOPPED', 'MINCED'],
    mass: 0.1, takeQty: 1, stock: 10, veg: true, heat: H(0.3, 60, [0.4, 3.0], 4.0, 1.2, true),
    flavor: { raw: { spicy: 1.4 }, cooked: { spicy: 0.8, rich: 0.5, sweet: 0.1 }, browned: { spicy: 0.6, rich: 0.8 }, burnt: { bitter: 2.5 } },
    category: 'aromatic', tags: ['aromatic', 'warm'], texture: { crisp: 0.6, softAt: 2.5, water: 0.4 },
    note: '短時間炒香建立香氣；放進湯裡久煮風味更均勻',
  },
  bean_sprout: {
    id: 'bean_sprout', label: '豆芽', unit: '份', storage: 'FRIDGE', shelfSec: 900, needsWash: true, needsPeel: false, cuts: ['WHOLE'],
    mass: 0.5, takeQty: 1, stock: 6, veg: true, heat: H(0.5, 55, [0.3, 1.5], 4.0, 0.4, true),
    flavor: { raw: { sweet: 0.2, bitter: 0.1 }, cooked: { sweet: 0.3, umami: 0.1 }, browned: { rich: 0.3 }, burnt: { bitter: 2.0 } },
    category: 'veg', tags: ['veg', 'crunchy'], texture: { crisp: 1.0, softAt: 1.0, water: 0.9 },
    note: '最後才下鍋，保留脆度（企劃書食譜 20 用到，另外補上）',
  },

  /* ---------------- 肉類與植物性蛋白質 ---------------- */
  chicken_breast: {
    id: 'chicken_breast', label: '雞胸肉', unit: '塊', storage: 'FRIDGE', shelfSec: 300, needsWash: false, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'DICED'], contaminates: true,
    mass: 1.2, takeQty: 1, stock: 6, meat: true, heat: H(0.08, 60, [1.2, 2.6], 6.0, 1.0, false, 74),
    flavor: { raw: { umami: 0.3 }, cooked: { umami: 1.3, rich: 0.4 }, browned: { umami: 1.5, rich: 0.8 }, burnt: { bitter: 2.5 } },
    category: 'meat', tags: ['meat', 'chicken', 'lean'], texture: { crisp: 0, softAt: 99, water: 0.7 },
    note: '低脂；加熱太久容易乾柴',
  },
  pork_slices: {
    id: 'pork_slices', label: '豬肉片', unit: '份', storage: 'FRIDGE', shelfSec: 300, needsWash: false, needsPeel: false, cuts: ['WHOLE', 'CHOPPED'], contaminates: true,
    mass: 1, takeQty: 1, stock: 6, meat: true, heat: H(0.2, 60, [0.9, 3.0], 6.0, 1.1, false, 71),
    flavor: { raw: { umami: 0.3 }, cooked: { umami: 1.3, rich: 1.0 }, browned: { umami: 1.5, rich: 1.4 }, burnt: { bitter: 2.5 } },
    category: 'meat', tags: ['meat', 'pork'], texture: { crisp: 0, softAt: 99, water: 0.6 },
    note: '已經切成片；適合短時間大火，薑、蒜、醬油都很搭',
  },
  beef_slices: {
    id: 'beef_slices', label: '牛肉片', unit: '份', storage: 'FRIDGE', shelfSec: 300, needsWash: false, needsPeel: false, cuts: ['WHOLE', 'CHOPPED'], contaminates: true,
    mass: 1, takeQty: 1, stock: 6, meat: true, heat: H(0.22, 55, [0.6, 2.0], 5.5, 1.2, false, 63),
    flavor: { raw: { umami: 0.5 }, cooked: { umami: 1.6, rich: 1.0 }, browned: { umami: 1.8, rich: 1.4 }, burnt: { bitter: 2.5 } },
    category: 'meat', tags: ['meat', 'beef'], texture: { crisp: 0, softAt: 99, water: 0.6 },
    note: '熟度影響嫩度：薄片很快就過熟',
  },
  bacon: {
    id: 'bacon', label: '培根', unit: '片', storage: 'FRIDGE', shelfSec: 900, needsWash: false, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'CHOPPED'], contaminates: true,
    mass: 0.5, takeQty: 1, stock: 8, meat: true, heat: H(0.25, 60, [0.8, 4.0], 7.0, 1.6, false, 70),
    flavor: { raw: { salty: 1.2, rich: 0.8 }, cooked: { salty: 1.4, rich: 1.6, umami: 0.5 }, browned: { salty: 1.4, rich: 2.0, umami: 0.7 }, burnt: { bitter: 2.8, salty: 1.0 } },
    category: 'meat', tags: ['meat', 'pork', 'processed', 'salty', 'smoky'], texture: { crisp: 0, softAt: 99, water: 0.3, fat: true },
    note: '本身就鹹：先嚐再決定要不要加鹽；煎香會釋出油脂',
  },
  sausage: {
    id: 'sausage', label: '香腸', unit: '條', storage: 'FRIDGE', shelfSec: 1200, needsWash: false, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'DICED'],
    mass: 0.6, takeQty: 1, stock: 8, meat: true, heat: H(0.12, 50, [0.6, 4.0], 7.0, 1.2, true),
    flavor: { raw: { salty: 1.0, sweet: 0.3, rich: 0.8 }, cooked: { salty: 1.1, sweet: 0.4, rich: 1.2, umami: 0.4 }, browned: { salty: 1.1, rich: 1.6, umami: 0.5, sweet: 0.4 }, burnt: { bitter: 2.5 } },
    category: 'meat', tags: ['meat', 'pork', 'processed', 'salty'], texture: { crisp: 0, softAt: 99, water: 0.4, fat: true },
    note: '已經熟了也調過味：再加大量鹽或醬油容易過鹹',
  },
  ground_pork: {
    id: 'ground_pork', label: '豬絞肉', unit: '份', storage: 'FRIDGE', shelfSec: 300, needsWash: false, needsPeel: false, cuts: ['WHOLE'], contaminates: true,
    mass: 1, takeQty: 1, stock: 6, meat: true, heat: H(0.25, 60, [0.9, 3.0], 6.0, 1.2, false, 71),
    flavor: { raw: { umami: 0.3 }, cooked: { umami: 1.4, rich: 1.1 }, browned: { umami: 1.6, rich: 1.5 }, burnt: { bitter: 2.5 } },
    category: 'meat', tags: ['meat', 'pork', 'minced'], texture: { crisp: 0, softAt: 99, water: 0.6 },
    note: '可以做肉餡，也可以炒散在醬汁裡；一定要熟透',
  },
  tofu: {
    id: 'tofu', label: '豆腐', unit: '塊', storage: 'FRIDGE', shelfSec: 1200, needsWash: false, needsPeel: false, cuts: ['WHOLE', 'DICED', 'CHOPPED'],
    mass: 1, takeQty: 1, stock: 6, heat: H(0.15, 55, [0.4, 6.0], 9.0, 0.9, true),
    flavor: { raw: { umami: 0.2, sweet: 0.1 }, cooked: { umami: 0.4, rich: 0.2 }, browned: { umami: 0.5, rich: 0.7 }, burnt: { bitter: 2.2 } },
    category: 'protein', tags: ['protein', 'plant', 'soy'], texture: { crisp: 0, softAt: 99, water: 0.85, fragile: true, absorbs: true },
    note: '煎過外層比較穩；燉煮會吸收湯汁；翻太多次會碎',
  },
  chickpea: {
    id: 'chickpea', label: '鷹嘴豆', unit: '份', storage: 'PANTRY', shelfSec: null, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'MASHED'],
    mass: 0.8, takeQty: 1, stock: 6, heat: H(0.12, 60, [0.5, 6.0], 9.0, 0.8, true),
    flavor: { raw: { umami: 0.2, rich: 0.3 }, cooked: { rich: 0.6, umami: 0.3, sweet: 0.1 }, browned: { rich: 0.9, umami: 0.3 }, burnt: { bitter: 2.3 } },
    category: 'protein', tags: ['protein', 'plant', 'bean'], texture: { crisp: 0.2, softAt: 3.0, water: 0.5, thickener: 0.4 },
    note: '已經煮熟的罐裝豆子（洗掉罐頭水再用）；壓碎可以做豆餅、讓燉菜變濃',
  },

  /* ---------------- 海鮮 ---------------- */
  salmon: {
    id: 'salmon', label: '鮭魚', unit: '片', storage: 'FRIDGE', shelfSec: 300, needsWash: false, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'DICED'], contaminates: true,
    mass: 1, takeQty: 1, stock: 5, seafood: true, heat: H(0.1, 50, [0.8, 2.0], 5.0, 1.1, false, 63),
    flavor: { raw: { umami: 0.6, rich: 0.8 }, cooked: { umami: 1.3, rich: 1.2 }, browned: { umami: 1.4, rich: 1.6 }, burnt: { bitter: 2.5 } },
    category: 'seafood', tags: ['seafood', 'fish', 'oily'], texture: { crisp: 0, softAt: 99, water: 0.7, fragile: true },
    note: '油脂豐富；過熟會乾，煎得好表面焦香',
  },
  white_fish: {
    id: 'white_fish', label: '白肉魚', unit: '片', storage: 'FRIDGE', shelfSec: 300, needsWash: false, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'DICED'], contaminates: true,
    mass: 1, takeQty: 1, stock: 5, seafood: true, heat: H(0.12, 50, [0.7, 1.8], 5.0, 0.9, false, 63),
    flavor: { raw: { umami: 0.5 }, cooked: { umami: 1.2, sweet: 0.2 }, browned: { umami: 1.3, rich: 0.7 }, burnt: { bitter: 2.4 } },
    category: 'seafood', tags: ['seafood', 'fish', 'light'], texture: { crisp: 0, softAt: 99, water: 0.8, fragile: true },
    note: '風味清淡；翻動太多次會碎',
  },
  shrimp: {
    id: 'shrimp', label: '蝦', unit: '份', storage: 'FRIDGE', shelfSec: 300, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'CHOPPED'], contaminates: true,
    mass: 0.8, takeQty: 1, stock: 6, seafood: true, heat: H(0.3, 55, [0.6, 1.6], 4.5, 0.8, false, 63),
    flavor: { raw: { umami: 0.6, sweet: 0.3 }, cooked: { umami: 1.5, sweet: 0.5 }, browned: { umami: 1.6, rich: 0.6, sweet: 0.4 }, burnt: { bitter: 2.5 } },
    category: 'seafood', tags: ['seafood', 'shellfish'], texture: { crisp: 0, softAt: 99, water: 0.7 },
    note: '熟得很快；過熟就變硬',
  },
  clam: {
    id: 'clam', label: '蛤蜊', unit: '份', storage: 'FRIDGE', shelfSec: 300, needsWash: true, needsPeel: false, cuts: ['WHOLE'], contaminates: true, needsLiquid: true,
    mass: 0.8, takeQty: 1, stock: 5, seafood: true, heat: H(0.25, 60, [0.6, 2.5], 6.0, 0.2, false, 70),
    flavor: { raw: { umami: 0.8, salty: 0.8 }, cooked: { umami: 2.0, salty: 1.0 }, browned: { umami: 1.6, salty: 1.0 }, burnt: { bitter: 2.5 } },
    category: 'seafood', tags: ['seafood', 'shellfish', 'salty', 'umami'], texture: { crisp: 0, softAt: 99, water: 0.8 },
    note: '要在湯裡煮開；煮出來的湯汁帶鹹鮮味，加鹽前先嚐',
  },

  /* ---------------- 主食與澱粉 ---------------- */
  rice: {
    id: 'rice', label: '白米', unit: '份', storage: 'PANTRY', shelfSec: null, needsWash: true, needsPeel: false, cuts: ['WHOLE'], needsLiquid: true,
    mass: 1, takeQty: 1, stock: 8, heat: H(0.06, 70, [1.5, 4.5], 9.0, 1.0, false),
    flavor: { raw: { sweet: 0.1 }, cooked: { sweet: 0.5, rich: 0.2 }, browned: { sweet: 0.5, rich: 0.7 }, burnt: { bitter: 2.5 } },
    category: 'starch', tags: ['starch', 'rice'], texture: { crisp: 0, softAt: 99, water: 0.2 },
    note: '先洗米，在湯鍋裡加水煮熟；煮好的飯才能炒飯',
  },
  spaghetti: {
    id: 'spaghetti', label: '義大利麵', unit: '份', storage: 'PANTRY', shelfSec: null, needsWash: false, needsPeel: false, cuts: ['WHOLE'], needsLiquid: true,
    mass: 1, takeQty: 1, stock: 8, heat: H(0.08, 70, [1.0, 2.2], 8.0, 0.8, false),
    flavor: { raw: {}, cooked: { sweet: 0.3, rich: 0.2 }, browned: { rich: 0.5 }, burnt: { bitter: 2.2 } },
    category: 'starch', tags: ['starch', 'noodle', 'pasta'], texture: { crisp: 0, softAt: 99, water: 0.1 },
    note: '在滾水裡煮；煮太久就沒有彈性',
  },
  flour: {
    id: 'flour', label: '麵粉', unit: '份', storage: 'PANTRY', shelfSec: null, needsWash: false, needsPeel: false, cuts: ['WHOLE'],
    mass: 0.5, takeQty: 1, stock: 8, heat: H(0.15, 60, [0.8, 4.0], 7.0, 1.2, false),
    flavor: { raw: { bitter: 0.3 }, cooked: { sweet: 0.2, rich: 0.3 }, browned: { rich: 0.8, sweet: 0.2 }, burnt: { bitter: 2.5 } },
    category: 'starch', tags: ['starch', 'flour', 'thickener'], texture: { crisp: 0, softAt: 99, water: 0, thickener: 1.0 },
    note: '和液體混合成麵糊；在熱牛奶或高湯裡會讓湯汁變濃；生麵粉不能直接吃',
  },
  udon: {
    id: 'udon', label: '烏龍麵', unit: '份', storage: 'PANTRY', shelfSec: null, needsWash: false, needsPeel: false, cuts: ['WHOLE'],
    mass: 1, takeQty: 1, stock: 6, heat: H(0.2, 55, [0.5, 2.0], 7.0, 0.8, false),
    flavor: { raw: {}, cooked: { sweet: 0.2, rich: 0.2 }, browned: { rich: 0.5 }, burnt: { bitter: 2.2 } },
    category: 'starch', tags: ['starch', 'noodle'], texture: { crisp: 0, softAt: 99, water: 0.4 },
    note: '半熟的麵條：湯麵、炒麵都可以；加熱太久就沒彈性',
  },
  sweet_potato: {
    id: 'sweet_potato', label: '地瓜', unit: '條', storage: 'PANTRY', shelfSec: null, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'DICED', 'CHUNK', 'MASHED'],
    mass: 1, takeQty: 1, stock: 6, veg: true, heat: H(0.06, 70, [1.0, 4.0], 7.5, 1.1, false),
    flavor: { raw: { sweet: 0.6, bitter: 0.1 }, cooked: { sweet: 1.6, rich: 0.4 }, browned: { sweet: 1.8, rich: 0.8 }, burnt: { bitter: 2.4 } },
    category: 'starch', tags: ['starch', 'sweet', 'orange'], texture: { crisp: 0.9, softAt: 1.2, water: 0.5, thickener: 0.3 },
    note: '烤或煎外層焦香、裡面綿密；煮熟可以壓成泥',
  },
  rice_noodle: {
    id: 'rice_noodle', label: '米粉', unit: '份', storage: 'PANTRY', shelfSec: null, needsWash: false, needsPeel: false, cuts: ['WHOLE'], needsLiquid: true, soakable: true,
    mass: 0.8, takeQty: 1, stock: 6, heat: H(0.2, 55, [0.5, 1.8], 6.0, 0.6, false),
    flavor: { raw: {}, cooked: { sweet: 0.2 }, browned: { rich: 0.4 }, burnt: { bitter: 2.0 } },
    category: 'starch', tags: ['starch', 'noodle', 'rice'], texture: { crisp: 0, softAt: 99, water: 0.2 },
    note: '先在水槽泡軟才能炒；直接下湯煮也可以；泡太久或煮太久會糊',
  },

  /* ---------------- 乳製品與特色食材 ---------------- */
  milk: {
    id: 'milk', label: '牛奶', unit: '杯', storage: 'FRIDGE', shelfSec: 1500, needsWash: false, needsPeel: false, cuts: ['WHOLE'], liquid: true,
    mass: 0.6, takeQty: 1, stock: 8, heat: H(0.4, 50, [0.3, 99], 99, 0, true),
    flavor: { raw: { sweet: 0.4, rich: 0.8 }, cooked: { sweet: 0.4, rich: 0.9 }, browned: { rich: 1.0, bitter: 0.2 }, burnt: { bitter: 2.0 } },
    category: 'dairy', tags: ['dairy', 'liquid', 'milk'], texture: { crisp: 0, softAt: 99, water: 1 },
    note: '液體基底：和麵粉一起加熱會變成白醬；會讓味道變柔和',
  },
  cheese: {
    id: 'cheese', label: '起司', unit: '片', storage: 'FRIDGE', shelfSec: 1800, needsWash: false, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'GRATED'],
    mass: 0.4, takeQty: 1, stock: 8, heat: H(0.3, 40, [0.3, 3.0], 5.0, 1.4, true),
    flavor: { raw: { salty: 0.8, rich: 1.4, umami: 0.4 }, cooked: { salty: 0.8, rich: 1.6, umami: 0.5 }, browned: { rich: 1.9, umami: 0.6, salty: 0.8 }, burnt: { bitter: 2.5 } },
    category: 'dairy', tags: ['dairy', 'cheese', 'salty'], texture: { crisp: 0, softAt: 99, water: 0.4, thickener: 0.5, melts: true },
    note: '加熱會融化、拉絲；烤過頭會變乾焦黑',
  },
  cream: {
    id: 'cream', label: '鮮奶油', unit: '份', storage: 'FRIDGE', shelfSec: 1200, needsWash: false, needsPeel: false, cuts: ['WHOLE'], liquid: true,
    mass: 0.4, takeQty: 1, stock: 6, heat: H(0.4, 50, [0.3, 99], 99, 0, true),
    flavor: { raw: { rich: 2.0, sweet: 0.3 }, cooked: { rich: 2.1, sweet: 0.3 }, browned: { rich: 2.1 }, burnt: { bitter: 2.0 } },
    category: 'dairy', tags: ['dairy', 'liquid', 'cream'], texture: { crisp: 0, softAt: 99, water: 0.6, thickener: 0.6 },
    note: '讓醬汁濃稠滑順；放太多會膩',
  },
  lemon: {
    id: 'lemon', label: '檸檬', unit: '顆', storage: 'FRIDGE', shelfSec: 1800, needsWash: true, needsPeel: false, cuts: ['WHOLE', 'SLICED', 'JUICED'],
    mass: 0.1, takeQty: 1, stock: 8, heat: H(0.3, 60, [0.3, 3.0], 5.0, 0.5, true),
    flavor: { raw: { sour: 2.2, bitter: 0.2 }, cooked: { sour: 1.6, bitter: 0.3 }, browned: { sour: 1.4, bitter: 0.5 }, burnt: { bitter: 2.0 } },
    category: 'other', tags: ['acid', 'citrus'], texture: { crisp: 0, softAt: 99, water: 0.9 },
    note: '擠汁或切片：酸味可以平衡油脂，放太多就只剩酸',
  },
  water: {
    id: 'water', label: '水', unit: '杯', storage: 'PANTRY', shelfSec: null, needsWash: false, needsPeel: false, cuts: ['WHOLE'], liquid: true,
    mass: 0.6, takeQty: 1, stock: 40, heat: H(0.4, 50, [0.3, 99], 99, 0, true),
    flavor: { raw: {}, cooked: {}, browned: {}, burnt: { bitter: 1.0 } },
    category: 'other', tags: ['liquid', 'water'], texture: { crisp: 0, softAt: 99, water: 1 },
    note: '煮飯、煮麵、調麵糊用；不帶任何味道（湯會被沖淡）',
  },
};
export const INGREDIENT_IDS = Object.keys(INGREDIENTS) as IngredientId[];

export interface SeasoningDef {
  id: SeasoningId;
  label: string;
  flavor: Flavor;
}
export const SEASONINGS: Record<SeasoningId, SeasoningDef> = {
  salt: { id: 'salt', label: '鹽', flavor: { salty: 2 } },
  sugar: { id: 'sugar', label: '糖', flavor: { sweet: 2 } },
  soy: { id: 'soy', label: '醬油', flavor: { salty: 1.2, umami: 0.8 } },
  vinegar: { id: 'vinegar', label: '醋', flavor: { sour: 2 } },
  pepper: { id: 'pepper', label: '黑胡椒', flavor: { spicy: 0.8, rich: 0.2 } },
  oil: { id: 'oil', label: '油', flavor: { rich: 0.8 } },
};
export const SEASONING_IDS = Object.keys(SEASONINGS) as SeasoningId[];
/** 量匙一次可以量的份量（標準單位） */
export const MEASURE_STEPS = [0.5, 1, 1.5, 2] as const;

/* ------------------------------------------------------------------ */
/* 招牌菜                                                              */
/* ------------------------------------------------------------------ */

export type Vessel = 'plate' | 'bowl';
export const VESSEL_LABEL: Record<Vessel, string> = { plate: '盤子', bowl: '碗' };

export interface RecipeComponent {
  type: IngredientId;
  /** 可以替代的食材（用了就算「變體」，不算失敗） */
  alt?: IngredientId[];
  qty: number;
  /** 必須的處理 */
  cut?: Cut;
  washed?: boolean;
  peeled?: boolean;
  /** 烹調方式；raw＝不加熱直接放上盤 */
  method: Method | 'raw';
  /** 也接受的烹調方式（例如快炒用平底鍋或湯鍋乾炒都可以） */
  methodAlt?: Array<Method | 'raw'>;
  /** 熟度區間（省略＝只要不燒焦） */
  doneness?: [number, number];
  /** 上色區間（以上色最深的一面計算） */
  browning?: [number, number];
  /** 可有可無的配料（有做對才加分，沒放不扣分） */
  optional?: boolean;
  note: string;
}

export interface CategoryWeights {
  process: number;
  doneness: number;
  prep: number;
  seasoning: number;
  plating: number;
}
export const DEFAULT_WEIGHTS: CategoryWeights = { process: 30, doneness: 25, prep: 15, seasoning: 20, plating: 10 };
export const CATEGORY_LABEL: Record<keyof CategoryWeights, string> = { process: '製程', doneness: '火候與熟度', prep: '刀工與備料', seasoning: '調味', plating: '裝盤與出餐' };

export interface RecipeDef {
  id: string;
  name: string;
  vessel: Vessel;
  hot: boolean;
  components: RecipeComponent[];
  seasoning: Partial<Record<SeasoningId, number>>;
  /** 標準完成時間（秒）：只用來計算效率，不影響品質分數 */
  parSec: number;
  weights?: Partial<CategoryWeights>;
  steps: string[];
  /** 食譜手冊的分類（招牌菜、快速料理、煎炒、湯品燉煮、麵飯、烘烤煎餅） */
  group?: RecipeGroup;
  /** 品質重點（給玩家看） */
  focus?: string[];
  /** 可能的變化（給玩家看；實際判定看 alt 與多加的食材） */
  variants?: string;
}

export type RecipeGroup = 'signature' | 'quick' | 'fry' | 'soup' | 'noodle' | 'special';
export const RECIPE_GROUP_LABEL: Record<RecipeGroup, string> = { signature: '招牌菜', quick: '快速料理與早餐', fry: '煎炒主菜', soup: '湯品與燉煮', noodle: '麵食與飯食', special: '烘烤、煎餅與特殊料理' };
export const RECIPE_GROUP_ORDER: readonly RecipeGroup[] = ['signature', 'quick', 'fry', 'soup', 'noodle', 'special'];

export const RECIPES: Record<string, RecipeDef> = {
  egg_toast: {
    id: 'egg_toast',
    group: 'signature',
    name: '煎蛋吐司',
    vessel: 'plate',
    hot: true,
    parSec: 90,
    components: [
      { type: 'bread', qty: 1, method: 'toaster', browning: [0.45, 1.0], note: '烤成金黃（烤麵包機 3 段左右）' },
      { type: 'butter', qty: 1, method: 'raw', note: '直接抹在吐司上' },
      { type: 'egg', qty: 1, cut: 'WHOLE', method: 'pan', doneness: [1.0, 2.6], browning: [0, 1.2], note: '整顆下鍋，蛋白凝固、蛋黃還軟' },
    ],
    seasoning: { salt: 0.5, pepper: 0.5 },
    steps: ['吐司放進烤麵包機，選 3 段左右', '平底鍋中火，蛋整顆下鍋；不必翻面', '裝盤：吐司、奶油、煎蛋', '在盤子上撒鹽 0.5、黑胡椒 0.5'],
  },
  onion_soup: {
    id: 'onion_soup',
    group: 'signature',
    name: '洋蔥湯',
    vessel: 'bowl',
    hot: true,
    parSec: 210,
    components: [
      { type: 'onion', qty: 2, cut: 'SLICED', peeled: true, method: 'pot', doneness: [1.0, 8.0], browning: [0.6, 1.8], note: '剝皮切片，先用奶油炒到焦糖色' },
      { type: 'butter', qty: 1, method: 'pot', note: '先下鍋' },
      { type: 'stock', qty: 3, method: 'pot', note: '洋蔥上色後再倒' },
    ],
    seasoning: { salt: 1, pepper: 0.5 },
    steps: ['洋蔥剝皮、切片（兩顆）', '湯鍋中火：奶油、洋蔥，每隔幾秒攪拌，炒到焦糖色', '倒入高湯 3 杯，煮滾後再煮一下', '加鹽 1、黑胡椒 0.5，用碗盛'],
  },
  tomato_egg: {
    id: 'tomato_egg',
    group: 'signature',
    name: '番茄炒蛋',
    vessel: 'plate',
    hot: true,
    parSec: 150,
    components: [
      { type: 'egg', qty: 2, cut: 'BEATEN', method: 'pan', doneness: [0.9, 2.2], browning: [0, 0.8], note: '打散，炒到剛凝固' },
      { type: 'tomato', qty: 1, cut: 'DICED', washed: true, method: 'pan', doneness: [0.8, 3.0], note: '洗過、切丁，炒軟' },
      { type: 'scallion', qty: 1, cut: 'CHOPPED', washed: true, method: 'raw', optional: true, note: '（可選）洗過切碎，最後撒上' },
    ],
    seasoning: { sugar: 0.5, salt: 0.5 },
    steps: ['番茄洗過切丁；兩顆蛋打散', '平底鍋中火，番茄與蛋下鍋，翻炒到蛋剛凝固', '裝盤，加糖 0.5、鹽 0.5', '（可選）撒上切碎的蔥'],
  },
};
/* ------------------------------------------------------------------ */
/* 料理沙盒擴充 v3.0：24 道新增固定食譜（和招牌菜用同一套料理核心）            */
/* ------------------------------------------------------------------ */

/** 這種食材自己的「剛好熟」區間 */
const DONE = (t: IngredientId): [number, number] => INGREDIENTS[t].heat.done;
const FRY: Array<Method | 'raw'> = ['pot'];
const STEW: Array<Method | 'raw'> = ['pan'];

export const NEW_RECIPES: Record<string, RecipeDef> = {
  butter_spinach_egg: {
    id: 'butter_spinach_egg',
    group: 'quick',
    name: '奶油菠菜炒蛋',
    vessel: 'plate',
    hot: true,
    parSec: 140,
    components: [
      { type: 'butter', qty: 1, method: 'pan', methodAlt: FRY, note: '少量奶油先下鍋' },
      { type: 'spinach', qty: 1, cut: 'CHOPPED', washed: true, method: 'pan', methodAlt: FRY, doneness: DONE('spinach'), note: '洗過切碎，短時間翻炒' },
      { type: 'egg', qty: 2, cut: 'BEATEN', method: 'pan', methodAlt: FRY, doneness: [1.0, 2.4], browning: [0, 0.8], note: '打散，炒到凝固就起鍋' },
    ],
    seasoning: { salt: 0.5 },
    steps: ['菠菜洗過切碎；兩顆蛋打散', '平底鍋中火，先放奶油', '下菠菜短時間翻炒，再倒入蛋液一起炒', '蛋凝固但還嫩時起鍋，加鹽 0.5'],
    focus: ['菠菜不能炒太久', '雞蛋不能燒焦', '奶油不要放太多'],
    variants: '加起司、黑胡椒或番茄',
  },
  chicken_toast: {
    id: 'chicken_toast',
    group: 'quick',
    name: '香煎雞胸肉吐司',
    vessel: 'plate',
    hot: true,
    parSec: 170,
    components: [
      { type: 'bread', qty: 1, method: 'toaster', methodAlt: ['oven'], browning: [0.45, 1.0], note: '烤成金黃，不要烤焦' },
      { type: 'chicken_breast', alt: ['chicken'], qty: 1, cut: 'SLICED', method: 'pan', doneness: [1.2, 2.6], browning: [0.3, 1.3], note: '切片煎到熟透（中心 74°C）' },
    ],
    seasoning: { salt: 0.5, pepper: 0.5, oil: 0.5 },
    steps: ['雞胸肉切片', '平底鍋中火加油 0.5，雞肉煎到兩面金黃、熟透', '吐司放進烤麵包機 3 段左右', '雞肉放在吐司上，撒鹽與黑胡椒各 0.5'],
    focus: ['雞肉一定要熟透', '吐司烤過頭會苦', '保留吐司的脆和雞肉的嫩'],
    variants: '加起司、番茄或菠菜；雞腿肉也可以',
  },
  corn_cheese_omelette: {
    id: 'corn_cheese_omelette',
    group: 'quick',
    name: '玉米起司煎蛋',
    vessel: 'plate',
    hot: true,
    parSec: 160,
    components: [
      { type: 'egg', qty: 2, cut: 'BEATEN', method: 'pan', doneness: [1.0, 2.4], browning: [0, 1.0], note: '打散，和玉米、起司在攪拌碗拌好' },
      { type: 'corn', qty: 1, cut: 'CHOPPED', method: 'pan', note: '切碎拌進蛋液，保留一點顆粒' },
      { type: 'cheese', qty: 1, cut: 'GRATED', method: 'pan', note: '刨碎拌進蛋液，煎到融化' },
    ],
    seasoning: { salt: 0.5 },
    steps: ['蛋打散；玉米切碎；起司刨碎', '三樣放進攪拌碗拌在一起', '平底鍋中火，倒進去煎', '底部成形後翻面，凝固就起鍋，加鹽 0.5'],
    focus: ['蛋要凝固', '起司融化但不能焦黑', '玉米保留顆粒口感'],
    variants: '加培根、青椒或辣椒',
  },
  pepper_beef: {
    id: 'pepper_beef',
    group: 'fry',
    name: '黑胡椒牛肉',
    vessel: 'plate',
    hot: true,
    parSec: 180,
    components: [
      { type: 'beef_slices', alt: ['pork_slices', 'chicken_breast'], qty: 1, method: 'pan', methodAlt: FRY, doneness: [0.6, 2.0], note: '先煎炒到剛熟，可以先取出' },
      { type: 'bell_pepper', qty: 1, cut: 'SLICED', washed: true, method: 'pan', methodAlt: FRY, doneness: [0.5, 2.0], note: '洗過切片，快炒保留脆度' },
    ],
    seasoning: { pepper: 1, soy: 0.5, oil: 0.5 },
    steps: ['青椒洗過切片', '平底鍋預熱加油 0.5，先炒牛肉到剛熟、取出', '下青椒快炒，再把牛肉放回去', '加黑胡椒 1、醬油 0.5，拌勻起鍋'],
    focus: ['青椒保留脆度', '牛肉不能過熟', '黑胡椒吃得到但不蓋過肉香'],
    variants: '豬肉或雞胸肉代替牛肉（＝黑胡椒豬肉／雞肉）',
  },
  ginger_pork: {
    id: 'ginger_pork',
    group: 'fry',
    name: '薑炒豬肉',
    vessel: 'plate',
    hot: true,
    parSec: 190,
    components: [
      { type: 'ginger', qty: 1, cut: 'CHOPPED', washed: true, peeled: true, method: 'pan', methodAlt: FRY, note: '切碎，先用油炒香' },
      { type: 'pork_slices', alt: ['beef_slices', 'chicken_breast'], qty: 1, method: 'pan', methodAlt: FRY, doneness: DONE('pork_slices'), note: '薑炒香後下鍋' },
      { type: 'onion', qty: 1, cut: 'SLICED', peeled: true, method: 'pan', methodAlt: FRY, doneness: [0.8, 6], note: '剝皮切片，一起翻炒' },
    ],
    seasoning: { soy: 1, oil: 0.5 },
    steps: ['薑洗過削皮切碎；洋蔥剝皮切片', '平底鍋中火加油 0.5，先炒香薑', '下豬肉片，再下洋蔥一起炒', '加醬油 1，肉熟了就起鍋'],
    focus: ['薑香要清楚', '洋蔥不能炒焦', '醬油的量要配合肉的份量'],
    variants: '牛肉或雞胸肉代替豬肉',
  },
  minced_eggplant: {
    id: 'minced_eggplant',
    group: 'fry',
    name: '肉末茄子',
    vessel: 'plate',
    hot: true,
    parSec: 230,
    components: [
      { type: 'garlic', qty: 1, cut: 'MINCED', peeled: true, method: 'pot', methodAlt: STEW, note: '剁末，先炒香' },
      { type: 'ground_pork', qty: 1, method: 'pot', methodAlt: STEW, doneness: DONE('ground_pork'), note: '炒散、炒到熟透' },
      { type: 'eggplant', qty: 1, cut: 'CHUNK', washed: true, method: 'pot', methodAlt: STEW, doneness: [1.2, 6], note: '切塊，煮到軟、吸飽醬汁' },
      { type: 'stock', alt: ['water'], qty: 1, method: 'pot', optional: true, note: '（可選）加一點高湯或水燜一下' },
    ],
    seasoning: { soy: 1, oil: 0.5 },
    steps: ['茄子洗過切塊；大蒜剝皮剁末', '湯鍋中火加油 0.5，先炒香大蒜，再下絞肉炒熟', '下茄子；可以加一杯高湯或水燜煮', '加醬油 1，煮到茄子軟、醬汁收進去，用碗或盤子盛'],
    focus: ['絞肉一定要熟透', '茄子要吸收醬汁', '油和醬汁不要太多'],
    variants: '不加高湯直接炒乾也可以',
  },
  bacon_cabbage: {
    id: 'bacon_cabbage',
    group: 'fry',
    name: '培根高麗菜',
    vessel: 'plate',
    hot: true,
    parSec: 170,
    components: [
      { type: 'bacon', qty: 1, cut: 'SLICED', method: 'pan', methodAlt: FRY, doneness: DONE('bacon'), browning: [0.3, 1.4], note: '切片，先煎出油' },
      { type: 'garlic', qty: 1, cut: 'SLICED', peeled: true, method: 'pan', methodAlt: FRY, note: '切片，培根出油後下' },
      { type: 'cabbage', qty: 1, cut: 'SLICED', washed: true, method: 'pan', methodAlt: FRY, doneness: [0.6, 2.4], note: '洗過切片，大火快炒' },
    ],
    seasoning: { oil: 0.5 },
    steps: ['培根切片；大蒜剝皮切片；高麗菜洗過切片', '平底鍋中火，先煎培根出油', '下大蒜，再下高麗菜大火快炒', '培根已經很鹹：先試吃再決定要不要加鹽'],
    focus: ['先判斷培根的鹹度，不要直接加很多鹽', '高麗菜保留口感', '培根要香但不能焦'],
    variants: '菠菜代替高麗菜',
  },
  seared_salmon: {
    id: 'seared_salmon',
    group: 'fry',
    name: '香煎鮭魚',
    vessel: 'plate',
    hot: true,
    parSec: 170,
    components: [
      { type: 'salmon', alt: ['white_fish'], qty: 1, method: 'pan', doneness: [0.8, 2.0], browning: [0.4, 1.3], note: '整片下鍋，表面煎香，翻面一次' },
      { type: 'lemon', qty: 1, cut: 'JUICED', washed: true, method: 'raw', note: '擠汁，起鍋後淋上' },
    ],
    seasoning: { salt: 0.5, pepper: 0.5, oil: 0.5 },
    steps: ['檸檬洗過擠汁', '平底鍋預熱，加油 0.5', '鮭魚下鍋煎到金黃，翻面一次，煎到熟', '裝盤，淋檸檬汁，撒鹽與黑胡椒各 0.5'],
    focus: ['魚肉要熟到安全溫度', '表面要煎香', '檸檬不要蓋過魚的味道'],
    variants: '白肉魚也可以',
  },
  garlic_shrimp: {
    id: 'garlic_shrimp',
    group: 'fry',
    name: '蒜香炒蝦',
    vessel: 'plate',
    hot: true,
    parSec: 150,
    components: [
      { type: 'garlic', qty: 1, cut: 'MINCED', peeled: true, method: 'pan', methodAlt: FRY, note: '剁末，先用油炒香' },
      { type: 'shrimp', qty: 1, washed: true, method: 'pan', methodAlt: FRY, doneness: DONE('shrimp'), note: '洗過，炒到剛熟（熟得很快）' },
    ],
    seasoning: { pepper: 0.5, salt: 0.5, oil: 0.5 },
    steps: ['大蒜剝皮剁末；蝦洗過', '平底鍋中火加油 0.5，炒香大蒜', '下蝦翻炒到剛熟', '加黑胡椒與鹽各 0.5，起鍋'],
    focus: ['蝦不能過熟', '大蒜不能炒焦', '保留蝦的鮮味'],
    variants: '加辣椒或蔥',
  },
  corn_chowder: {
    id: 'corn_chowder',
    group: 'soup',
    name: '玉米濃湯',
    vessel: 'bowl',
    hot: true,
    parSec: 220,
    components: [
      { type: 'butter', qty: 1, method: 'pot', note: '先下鍋' },
      { type: 'corn', qty: 2, cut: 'MASHED', method: 'pot', doneness: [0.6, 6], note: '壓碎，短時間炒一下（湯會因此變濃）' },
      { type: 'milk', qty: 1, method: 'pot', note: '玉米炒過後倒入' },
      { type: 'stock', qty: 1, method: 'pot', note: '和牛奶一起倒' },
    ],
    seasoning: { salt: 0.5 },
    steps: ['兩份玉米壓碎', '湯鍋中火放奶油，下玉米炒一下', '倒入牛奶與高湯各 1 杯，攪拌煮滾', '湯變濃就加鹽 0.5，用碗盛'],
    focus: ['湯不能太稀', '奶香和玉米的甜要平衡', '煮越久不會越好'],
    variants: '加起司、培根或花椰菜',
  },
  ginger_chicken_soup: {
    id: 'ginger_chicken_soup',
    group: 'soup',
    name: '薑香雞湯',
    vessel: 'bowl',
    hot: true,
    parSec: 260,
    components: [
      { type: 'chicken', alt: ['chicken_breast'], qty: 1, method: 'pot', doneness: [1.2, 5], note: '和高湯一起下鍋，煮到熟透' },
      { type: 'ginger', qty: 1, cut: 'SLICED', washed: true, peeled: true, method: 'pot', note: '切片' },
      { type: 'carrot', qty: 1, cut: 'SLICED', washed: true, peeled: true, method: 'pot', doneness: [1.0, 7], note: '切片，煮軟但不要爛' },
      { type: 'stock', qty: 3, method: 'pot', note: '三杯' },
    ],
    seasoning: { salt: 1 },
    steps: ['胡蘿蔔與薑洗過削皮切片', '湯鍋放雞肉與高湯 3 杯', '加入胡蘿蔔與薑，中火燉煮', '肉熟透後加鹽 1，用碗盛'],
    focus: ['薑香明顯但不過量', '肉一定要熟透', '胡蘿蔔軟但不散'],
    variants: '雞胸肉也可以',
  },
  clam_veg_soup: {
    id: 'clam_veg_soup',
    group: 'soup',
    name: '蛤蜊蔬菜湯',
    vessel: 'bowl',
    hot: true,
    parSec: 220,
    components: [
      { type: 'stock', qty: 2, method: 'pot', note: '兩杯' },
      { type: 'cabbage', qty: 1, cut: 'SLICED', washed: true, method: 'pot', doneness: [0.6, 4], note: '切片，先下' },
      { type: 'carrot', qty: 1, cut: 'SLICED', washed: true, peeled: true, method: 'pot', doneness: [1.0, 6], note: '切片，先下' },
      { type: 'clam', qty: 1, washed: true, method: 'pot', doneness: DONE('clam'), note: '洗過，蔬菜變軟後才下，煮到開口' },
    ],
    seasoning: {},
    steps: ['高麗菜、胡蘿蔔洗過切片；蛤蜊洗過', '湯鍋放高湯 2 杯與蔬菜，煮到蔬菜開始變軟', '下蛤蜊，煮到熟', '蛤蜊本身就鹹：先試吃，通常不用加鹽，用碗盛'],
    focus: ['蛤蜊的鮮味要融進湯裡', '不要因為多加鹽而過鹹', '蔬菜不要煮爛'],
    variants: '加薑片或蔥',
  },
  tomato_fish_stew: {
    id: 'tomato_fish_stew',
    group: 'soup',
    name: '番茄燉魚',
    vessel: 'bowl',
    hot: true,
    parSec: 280,
    components: [
      { type: 'onion', qty: 1, cut: 'DICED', peeled: true, method: 'pot', doneness: [0.8, 9], note: '切丁，先炒香' },
      { type: 'tomato', qty: 1, cut: 'CHUNK', washed: true, method: 'pot', doneness: [0.8, 5.4], note: '切塊，炒到出汁' },
      { type: 'stock', qty: 1, method: 'pot', note: '一杯就好（湯汁不要太稀）' },
      { type: 'white_fish', alt: ['salmon'], qty: 1, method: 'pot', doneness: [0.7, 3.0], note: '最後放，小火燉到熟，不要攪太多' },
    ],
    seasoning: { salt: 0.5 },
    steps: ['洋蔥剝皮切丁；番茄洗過切塊', '湯鍋中火先炒洋蔥，再下番茄炒到出汁', '加高湯 1 杯，放入白肉魚', '轉小火燉到魚熟，加鹽 0.5，用碗盛'],
    focus: ['魚肉不要翻到碎掉', '番茄的酸和湯的鮮要平衡', '湯汁不要太稀'],
    variants: '鮭魚也可以',
  },
  tofu_veg_pot: {
    id: 'tofu_veg_pot',
    group: 'soup',
    name: '豆腐蔬菜煲',
    vessel: 'bowl',
    hot: true,
    parSec: 260,
    components: [
      { type: 'stock', qty: 2, method: 'pot', note: '兩杯，先煮熱' },
      { type: 'carrot', qty: 1, cut: 'CHUNK', washed: true, peeled: true, method: 'pot', doneness: [1.0, 7], note: '切塊' },
      { type: 'cauliflower', qty: 1, cut: 'CHUNK', washed: true, method: 'pot', doneness: [1.0, 6], note: '切塊' },
      { type: 'tofu', qty: 1, cut: 'DICED', method: 'pot', note: '切丁，最後放' },
    ],
    seasoning: { soy: 1 },
    steps: ['胡蘿蔔、花椰菜洗過切塊；豆腐切丁', '湯鍋放高湯 2 杯加熱', '下胡蘿蔔與花椰菜，再放豆腐', '加醬油 1，燉到蔬菜熟，用碗盛'],
    focus: ['豆腐保持形狀', '蔬菜要熟', '醬油不要蓋過高湯的鮮味'],
    variants: '加辣椒（辣味豆腐煲）或香菇',
  },
  carbonara: {
    id: 'carbonara',
    group: 'noodle',
    name: '培根奶油義大利麵',
    vessel: 'plate',
    hot: true,
    parSec: 270,
    components: [
      { type: 'spaghetti', qty: 1, method: 'pot', doneness: DONE('spaghetti'), note: '另一口湯鍋加水煮熟，撈起來' },
      { type: 'bacon', qty: 1, cut: 'SLICED', method: 'pot', methodAlt: ['pan'], doneness: DONE('bacon'), note: '切片，先煎香' },
      { type: 'butter', qty: 1, method: 'pot', note: '培根出油後加' },
      { type: 'cream', qty: 1, method: 'pot', note: '小火加熱成醬汁' },
    ],
    seasoning: { pepper: 0.5 },
    steps: ['湯鍋 A：水 2 杯煮滾，下義大利麵煮到剛好，撈起來', '湯鍋 B：培根切片乾煎出油，加奶油、鮮奶油', '把麵放進醬汁拌勻，加黑胡椒 0.5', '醬汁裹住麵條時盛到盤子上'],
    focus: ['麵不能煮過頭', '醬汁不能水水的，也不能稠到結塊', '培根的鹹要算進去'],
    variants: '雞肉代替培根（雞肉奶油義大利麵）',
  },
  garlic_shrimp_pasta: {
    id: 'garlic_shrimp_pasta',
    group: 'noodle',
    name: '蒜香蝦仁義大利麵',
    vessel: 'plate',
    hot: true,
    parSec: 260,
    components: [
      { type: 'spaghetti', qty: 1, method: 'pot', doneness: DONE('spaghetti'), note: '加水煮熟，撈起來' },
      { type: 'garlic', qty: 1, cut: 'MINCED', peeled: true, method: 'pan', methodAlt: FRY, note: '剁末，用油炒香' },
      { type: 'shrimp', qty: 1, washed: true, method: 'pan', methodAlt: FRY, doneness: DONE('shrimp'), note: '炒到剛熟' },
      { type: 'lemon', qty: 1, cut: 'JUICED', washed: true, method: 'raw', note: '擠汁，最後淋一點' },
    ],
    seasoning: { oil: 1, salt: 0.5 },
    steps: ['湯鍋加水 2 杯煮義大利麵，撈起來', '平底鍋加油 1，炒香蒜末，下蝦炒到剛熟', '放入麵拌炒，加鹽 0.5', '裝盤，淋檸檬汁'],
    focus: ['麵和蝦的熟度分開判斷', '檸檬的酸和蝦的鮮要平衡', '大蒜不能焦'],
    variants: '加辣椒',
  },
  beef_udon: {
    id: 'beef_udon',
    group: 'noodle',
    name: '牛肉烏龍麵',
    vessel: 'bowl',
    hot: true,
    parSec: 230,
    components: [
      { type: 'beef_slices', alt: ['pork_slices'], qty: 1, method: 'pot', doneness: [0.6, 2.4], note: '先快速炒一下' },
      { type: 'stock', qty: 2, method: 'pot', note: '兩杯' },
      { type: 'onion', qty: 1, cut: 'SLICED', peeled: true, method: 'pot', doneness: [0.8, 9], note: '切片' },
      { type: 'udon', qty: 1, method: 'pot', doneness: DONE('udon'), note: '最後下，煮到有彈性就好' },
    ],
    seasoning: { soy: 1 },
    steps: ['洋蔥剝皮切片', '湯鍋中火，牛肉片快速炒一下', '倒入高湯 2 杯、下洋蔥，再下烏龍麵', '加醬油 1，麵有彈性就用碗盛'],
    focus: ['麵條保留彈性', '牛肉不能過熟', '湯的鹹度配合麵與肉'],
    variants: '豬肉代替牛肉',
  },
  pork_yaki_udon: {
    id: 'pork_yaki_udon',
    group: 'noodle',
    name: '豬肉炒烏龍麵',
    vessel: 'plate',
    hot: true,
    parSec: 210,
    components: [
      { type: 'pork_slices', alt: ['beef_slices', 'chicken_breast'], qty: 1, method: 'pan', methodAlt: FRY, doneness: DONE('pork_slices'), note: '先炒熟' },
      { type: 'cabbage', qty: 1, cut: 'SLICED', washed: true, method: 'pan', methodAlt: FRY, doneness: [0.6, 2.6], note: '洗過切片' },
      { type: 'udon', qty: 1, method: 'pan', methodAlt: FRY, doneness: DONE('udon'), note: '最後下，炒到醬汁均勻' },
    ],
    seasoning: { soy: 1, oil: 0.5 },
    steps: ['高麗菜洗過切片', '平底鍋加油 0.5，炒熟豬肉片', '下高麗菜，再下烏龍麵', '加醬油 1，翻炒均勻就起鍋（炒太久會糊）'],
    focus: ['麵不能糊爛', '高麗菜保留口感', '醬油收乾會變鹹'],
    variants: '牛肉或雞胸肉代替豬肉',
  },
  seafood_fried_rice: {
    id: 'seafood_fried_rice',
    group: 'noodle',
    name: '海鮮炒飯',
    vessel: 'plate',
    hot: true,
    parSec: 270,
    components: [
      { type: 'rice', qty: 1, washed: true, method: 'pot', doneness: DONE('rice'), note: '洗米，加水煮熟後撈起來（不能直接炒生米）' },
      { type: 'egg', qty: 1, cut: 'BEATEN', method: 'pan', methodAlt: FRY, doneness: [1.0, 2.6], note: '打散，先炒到半熟' },
      { type: 'shrimp', qty: 1, washed: true, method: 'pan', methodAlt: FRY, doneness: DONE('shrimp'), note: '炒到剛熟' },
      { type: 'scallion', qty: 1, cut: 'CHOPPED', washed: true, method: 'pan', methodAlt: ['pot', 'raw'], note: '切碎，最後加' },
    ],
    seasoning: { salt: 0.5, oil: 0.5 },
    steps: ['白米洗過，湯鍋加水 2 杯煮熟，撈起來', '平底鍋加油 0.5，蛋液炒到半熟，下蝦', '下白飯快炒，加鹽 0.5', '撒蔥花，起鍋'],
    focus: ['要用熟飯，不能直接炒生米', '飯粒不能濕黏', '蝦和蛋的熟度分開判斷'],
    variants: '豬肉或培根代替蝦（但就不是海鮮了）',
  },
  veg_rice_noodle: {
    id: 'veg_rice_noodle',
    group: 'noodle',
    name: '蔬菜炒米粉',
    vessel: 'plate',
    hot: true,
    parSec: 230,
    components: [
      { type: 'rice_noodle', qty: 1, method: 'pan', methodAlt: FRY, doneness: DONE('rice_noodle'), note: '先在水槽泡軟（約 20 秒）' },
      { type: 'carrot', qty: 1, cut: 'SHRED', washed: true, peeled: true, method: 'pan', methodAlt: FRY, note: '切絲，先炒' },
      { type: 'cabbage', qty: 1, cut: 'SLICED', washed: true, method: 'pan', methodAlt: FRY, doneness: [0.6, 2.6], note: '切片，先炒' },
      { type: 'bean_sprout', qty: 1, washed: true, method: 'pan', methodAlt: FRY, doneness: DONE('bean_sprout'), note: '最後下，保留脆度' },
    ],
    seasoning: { soy: 1, oil: 0.5 },
    steps: ['米粉放水槽泡軟', '胡蘿蔔削皮切絲、高麗菜切片、豆芽洗過', '平底鍋加油 0.5，先炒胡蘿蔔與高麗菜，再下米粉', '最後下豆芽，加醬油 1，拌勻起鍋'],
    focus: ['米粉不能泡爛或吸太多水', '豆芽保留脆度', '蔬菜和米粉分布均勻'],
    variants: '加豬肉片或香菇',
  },
  veg_pancake: {
    id: 'veg_pancake',
    group: 'special',
    name: '蔬菜煎餅',
    vessel: 'plate',
    hot: true,
    parSec: 230,
    components: [
      { type: 'flour', qty: 1, method: 'pan', doneness: DONE('flour'), browning: [0.4, 1.3], note: '和蛋、水在攪拌碗調成麵糊' },
      { type: 'egg', qty: 1, cut: 'BEATEN', method: 'pan', note: '打散，加進麵糊' },
      { type: 'water', qty: 1, method: 'pan', note: '水槽接一杯' },
      { type: 'cabbage', qty: 1, cut: 'CHOPPED', washed: true, method: 'pan', note: '切碎，拌進麵糊' },
      { type: 'carrot', qty: 1, cut: 'CHOPPED', washed: true, peeled: true, method: 'pan', note: '切碎，拌進麵糊' },
    ],
    seasoning: { salt: 0.5, oil: 0.5 },
    steps: ['高麗菜、胡蘿蔔切碎；蛋打散；水槽接一杯水', '麵粉、蛋液、水、蔬菜放進攪拌碗拌成麵糊', '平底鍋中火加油 0.5，倒入麵糊', '底部成形後翻面，裡面熟了就起鍋，加鹽 0.5'],
    focus: ['麵糊不能太稀', '蔬菜分布均勻', '外面上色、裡面不能是生麵糊'],
    variants: '加蝦、豬肉或蔥',
  },
  cauliflower_gratin: {
    id: 'cauliflower_gratin',
    group: 'special',
    name: '起司焗花椰菜',
    vessel: 'plate',
    hot: true,
    parSec: 290,
    components: [
      { type: 'cauliflower', qty: 1, cut: 'CHUNK', washed: true, method: 'oven', doneness: [1.0, 4], note: '切塊，先加水煮一下撈起來' },
      { type: 'milk', qty: 1, method: 'oven', note: '和麵粉調成白醬' },
      { type: 'flour', qty: 1, method: 'oven', doneness: DONE('flour'), note: '和牛奶一起拌' },
      { type: 'cheese', qty: 1, cut: 'GRATED', method: 'oven', browning: [0.2, 1.4], note: '刨碎，放在最上面' },
    ],
    seasoning: { salt: 0.5 },
    steps: ['花椰菜洗過切塊，湯鍋加水煮一下，撈起來', '攪拌碗：花椰菜、麵粉、牛奶、刨碎的起司拌在一起', '烤箱預熱 210°C，放進去烤', '起司融化、表面上色就拿出來，加鹽 0.5'],
    focus: ['白醬不能結塊', '花椰菜不能太爛', '起司融化但不能焦黑'],
    variants: '馬鈴薯或玉米代替花椰菜',
  },
  pan_sweet_potato: {
    id: 'pan_sweet_potato',
    group: 'special',
    name: '香煎地瓜',
    vessel: 'plate',
    hot: true,
    parSec: 170,
    components: [{ type: 'sweet_potato', qty: 1, cut: 'SLICED', washed: true, method: 'pan', doneness: DONE('sweet_potato'), browning: [0.45, 1.4], note: '切片，兩面煎到金黃、裡面軟' }],
    seasoning: { oil: 0.5 },
    steps: ['地瓜洗過切片', '平底鍋中火，加油 0.5', '地瓜下鍋，翻面讓兩面都上色', '裡面熟了就起鍋（油不要放太多）'],
    focus: ['外層適度褐變', '裡面不能還是硬的', '油太多會降低品質'],
    variants: '加奶油或一點糖',
  },
  lemon_butter_fish: {
    id: 'lemon_butter_fish',
    group: 'special',
    name: '檸檬奶油白肉魚',
    vessel: 'plate',
    hot: true,
    parSec: 180,
    components: [
      { type: 'butter', qty: 1, method: 'pan', note: '用奶油煎魚' },
      { type: 'white_fish', alt: ['salmon'], qty: 1, method: 'pan', doneness: [0.7, 1.8], browning: [0.3, 1.2], note: '翻面次數越少越好（會碎）' },
      { type: 'lemon', qty: 1, cut: 'JUICED', washed: true, method: 'raw', note: '擠汁，起鍋後淋一點' },
    ],
    seasoning: { pepper: 0.5, salt: 0.5 },
    steps: ['檸檬洗過擠汁', '平底鍋中火放奶油，白肉魚下鍋', '只翻一次面，熟了就起鍋', '淋檸檬汁，撒黑胡椒與鹽各 0.5'],
    focus: ['魚肉保持完整', '奶油不能燒焦', '檸檬不要放太多'],
    variants: '鮭魚也可以',
  },
};
for (const [id, r] of Object.entries(NEW_RECIPES)) RECIPES[id] = r;
export const RECIPE_IDS = Object.keys(RECIPES);
/** 原本的三道招牌菜 */
export const SIGNATURE_IDS = ['egg_toast', 'onion_soup', 'tomato_egg'] as const;
export const NEW_RECIPE_IDS = Object.keys(NEW_RECIPES);

/* ------------------------------------------------------------------ */
/* 主廚自選：客人只說需求，做法由玩家決定                                  */
/* ------------------------------------------------------------------ */

export interface TasteRange {
  min?: number;
  max?: number;
}

/* 主廚委託（原本的「主廚自選」）在 commissions.ts */
/** 「主廚自選」的口味判定：在區間內＝滿分；每偏離 1 個單位扣一半 */
export const TASTE_FALLOFF = 0.5;
/** 端上桌時要算「熱的」的最低溫度（°C） */
export const HOT_SERVE_TEMP = 55;
