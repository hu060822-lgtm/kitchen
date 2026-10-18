import type { Seat } from '../seats';
import { CUT_HEAT_FACTOR, INGREDIENTS, type Cut, type FlavorBand, type IngredientId, type Method, type SeasoningId } from './data';

/**
 * 料理模型（純函式、固定時間步長）：鍋具溫度、食材中心溫度、熟度、表面上色、焦底、新鮮度。
 *
 * 規則：
 *   - 熟度、上色、燒焦只由「累積的熱量與時間」決定，不看玩家按了幾秒，也不受任何恐怖事件影響。
 *   - 關火後鍋具依同一個模型慢慢降溫，食材在餘熱中繼續變熟（離開爐台去躲怪物，蛋還是會繼續煎）。
 *   - 同樣的初始狀態＋同樣的操作序列＝同樣的結果（伺服器以 0.1 秒的固定步長推進）。
 */

export const DT = 0.1;
export const ROOM_TEMP = 22;
export const FRIDGE_TEMP = 5;
export const BOIL = 100;

export type HeatLevel = 'OFF' | 'LOW' | 'MED' | 'HIGH';
export const HEAT_LEVELS: readonly HeatLevel[] = ['OFF', 'LOW', 'MED', 'HIGH'];
export const HEAT_LABEL: Record<HeatLevel, string> = { OFF: '關火', LOW: '小火', MED: '中火', HIGH: '大火' };
/** 爐火的目標鍋溫（°C） */
export const BURNER_TARGET: Record<HeatLevel, number> = { OFF: ROOM_TEMP, LOW: 130, MED: 180, HIGH: 240 };
/** 鍋具的熱慣性：每秒向目標溫度靠近的比例（平底鍋快、湯鍋慢） */
export const VESSEL_K = { pan: 0.35, pot: 0.12 } as const;
/** 離火的食物每秒向室溫靠近的比例 */
export const COOL_K = 0.012;
/** 表面開始上色的鍋溫 */
export const BROWN_START = 150;
/** 上色速度：每超過起始溫度 1°C，每秒增加的上色值 */
export const BROWN_RATE = 1 / 600;
/** 熟度速度：中心溫度每超過「開始變熟的溫度」1°C，每秒增加的熟度 */
export const DONE_RATE = 1 / 300;
/** 任何一面上色達到這個值＝燒焦 */
export const BROWN_BURNT = 2.0;
/** 湯鍋沒有液體時，多久沒攪拌就開始焦底（秒） */
export const STIR_GRACE = 6;
/** 烤麵包機：固定 8 秒，每一段火力每秒上色 0.03 */
export const TOAST_SEC = 8;
export const TOAST_RATE = 0.03;
/** 烤箱：三段溫度（°C）；預熱慢（熱慣性比湯鍋還大），兩面同時、比較慢地上色 */
export const OVEN_TARGET: Record<HeatLevel, number> = { OFF: ROOM_TEMP, LOW: 170, MED: 210, HIGH: 250 };
export const OVEN_K = 0.06;
/** 烤箱的熱空氣傳熱比鍋面慢 */
export const OVEN_HEAT_FACTOR = 0.55;
/** 烤箱上色（每一面）是平底鍋朝下那面的幾倍 */
export const OVEN_BROWN_FACTOR = 0.18;
/** 需要水才煮得熟的食材（米、乾麵、蛤蜊）不在湯裡時的熟化速度倍率；泡軟的米粉可以炒 */
export const DRY_COOK_FACTOR = 0.15;
export const SOAKED_DRY_COOK_FACTOR = 0.7;
/** 水槽浸泡：幾秒泡軟（soaked＝1）；超過 SOAK_MUSHY 就泡爛了 */
export const SOAK_SEC = 20;
export const SOAK_MUSHY = 2.5;
/** 拌在一起的一份（肉餡、麵糊）比單一食材厚，熱傳得慢一點 */
export const MIX_HEAT_FACTOR = 0.75;
/** 在湯裡最多煮到燒焦值的幾成（煮爛、不會燒焦） */
export const LIQUID_DONENESS_CAP = 0.9;

export interface HistoryEntry {
  /** 班次開始後的毫秒數 */
  t: number;
  op: string;
  by?: Seat;
  at?: string;
  note?: string;
}

/** 一份食材的完整狀態（多個維度並存，例如「切片＋新鮮＋正在煮」） */
export interface ItemState {
  id: string;
  type: IngredientId;
  qty: number;
  washed: boolean;
  peeled: boolean;
  cut: Cut;
  /** 刀工一致性 0–1；整塊時為 null */
  cutQuality: number | null;
  /** 新鮮度 1→0；小於等於 0＝過期 */
  freshness: number;
  /** 中心溫度與曾經到達的最高溫度（食品安全） */
  temp: number;
  maxTemp: number;
  /** 累積熟度 */
  doneness: number;
  /** 兩面的上色（A＝目前朝下的一面） */
  brownA: number;
  brownB: number;
  /** 碰過切過生肉、還沒擦的砧板 */
  contaminated: boolean;
  /** 掉在地上過、還沒重新洗（生的可以洗掉；煮過的只能丟） */
  floorDirty?: boolean;
  /** 經歷過的加熱方式 */
  methods: Method[];
  /** 湯鍋焦底時一起被盛出來 */
  scorched: boolean;
  seasoning: Partial<Record<SeasoningId, number>>;
  history: HistoryEntry[];
  /** 浸泡程度（米粉）：1＝泡軟，超過 SOAK_MUSHY＝泡爛 */
  soaked?: number;
  /** 攪拌碗拌成的一份（麵糊、肉餡、拌料）：這份食材是主體，parts 是拌進去的其他食材 */
  mix?: MixInfo;
  /** 在各種熱源上實際受熱的秒數（煎、乾炒、湯裡、烤箱、烤麵包機）：判斷「煎／炒／煮／燉／烤」與出水、糊掉 */
  cookSec?: Partial<Record<HeatMode, number>>;
  /** 受熱時碰過的最高鍋溫／烤箱溫度（火候紀錄） */
  peakHeat?: number;
  /** 最後一次受熱的方式（先煮後炒的飯＝炒） */
  lastMode?: HeatMode;
  /** 翻面次數（豆腐、魚翻太多次會碎） */
  flips?: number;
  /** 裝盤後：這個成分原本屬於哪一份拌料（主體的 id） */
  mixedWith?: string;
  mixKind?: MixKind;
}

/** batter＝麵粉＋液體（麵糊）；bound＝絞肉／壓碎的食材＋蛋或麵粉（肉餡、豆餅）；tossed＝其他拌在一起 */
export type MixKind = 'batter' | 'bound' | 'tossed';
export const MIX_LABEL: Record<MixKind, string> = { batter: '麵糊', bound: '餡料', tossed: '拌料' };
export interface MixInfo {
  kind: MixKind;
  parts: Array<Omit<ItemState, 'history' | 'mix'>>;
  /** 拌好那一刻主體的熟度、上色與受熱秒數（之後增加的部分，拌進去的食材也一起經歷） */
  at: { doneness: number; brownA: number; brownB: number; cookSec?: Partial<Record<HeatMode, number>> };
}

export type CookingState = 'RAW' | 'COOKING' | 'COOKED' | 'OVERCOOKED' | 'BURNT';
export type FreshnessState = 'FRESH' | 'AGING' | 'EXPIRED';

export function newItem(id: string, type: IngredientId, t: number): ItemState {
  const def = INGREDIENTS[type];
  const temp = def.storage === 'FRIDGE' ? FRIDGE_TEMP : ROOM_TEMP;
  return {
    id,
    type,
    qty: def.takeQty,
    washed: false,
    peeled: false,
    cut: 'WHOLE',
    cutQuality: null,
    freshness: 1,
    temp,
    maxTemp: temp,
    doneness: 0,
    brownA: 0,
    brownB: 0,
    contaminated: false,
    methods: [],
    scorched: false,
    seasoning: {},
    history: [{ t, op: 'take' }],
  };
}

/* ------------------------------------------------------------------ */
/* 鍋具                                                                */
/* ------------------------------------------------------------------ */

/** 鍋溫向目標靠近；有液體的湯鍋最高只到沸點 */
export function stepVessel(temp: number, level: HeatLevel, kind: 'pan' | 'pot' | 'oven', hasLiquid: boolean, dt = DT): number {
  if (kind === 'oven') return temp + (OVEN_TARGET[level] - temp) * (1 - Math.exp(-OVEN_K * dt));
  const target = hasLiquid ? Math.min(BURNER_TARGET[level], BOIL) : BURNER_TARGET[level];
  const k = VESSEL_K[kind] * (hasLiquid ? 0.7 : 1);
  return temp + (target - temp) * (1 - Math.exp(-k * dt));
}

/** 食物中心能達到的有效溫度：水分讓中心停在 100°C 附近，鍋越燙只多一點 */
export const effectiveTemp = (vessel: number): number => (vessel <= BOIL ? vessel : BOIL + (vessel - BOIL) * 0.25);

export type HeatMode = 'pan' | 'potDry' | 'potLiquid' | 'toaster' | 'oven';
/** 算「真的在受熱」的最低鍋溫（低於這個只是溫溫的） */
export const COOK_SEC_MIN_VESSEL = 60;

export interface HeatContact {
  method: Method;
  vessel: number;
  /** pan：A 面朝下；potDry：乾炒（攪拌過兩面平均上色）；potLiquid：在湯裡（不上色）；toaster：兩面；oven：熱空氣，兩面慢慢上色 */
  mode: HeatMode;
  /** 乾炒時距離上次攪拌的秒數 */
  sinceStir?: number;
  /** 烤麵包機段數 1–5 */
  toastLevel?: number;
}

/** 在熱源上推進一步 */
export function heatItem(it: ItemState, c: HeatContact, dt = DT): void {
  const def = INGREDIENTS[it.type];
  const k = def.heat.k * CUT_HEAT_FACTOR[it.cut] * (c.mode === 'oven' ? OVEN_HEAT_FACTOR : 1) * (it.mix ? MIX_HEAT_FACTOR : 1);
  const te = c.mode === 'toaster' ? 120 : effectiveTemp(c.vessel);
  it.temp += (te - it.temp) * (1 - Math.exp(-k * dt));
  it.maxTemp = Math.max(it.maxTemp, it.temp);
  const before = it.doneness + it.brownA + it.brownB;
  // 米、乾麵、蛤蜊要在水裡才煮得熟；乾鍋裡只會慢慢變熟（泡軟的米粉例外）
  const dry = def.needsLiquid && c.mode !== 'potLiquid' ? ((it.soaked ?? 0) >= 1 ? SOAKED_DRY_COOK_FACTOR : DRY_COOK_FACTOR) : 1;
  const prevDone = it.doneness;
  if (it.temp > def.heat.cookStart) it.doneness += (it.temp - def.heat.cookStart) * DONE_RATE * dry * dt;
  // 泡在湯裡不會「燒焦」：只會越煮越爛（停在燒焦之前）
  const cap = def.heat.burnt * LIQUID_DONENESS_CAP;
  if (c.mode === 'potLiquid' && it.doneness > cap) it.doneness = Math.max(prevDone, cap);
  if (c.mode === 'oven') {
    if (c.vessel > BROWN_START) {
      const b = (c.vessel - BROWN_START) * BROWN_RATE * def.heat.brown * OVEN_BROWN_FACTOR * dt;
      it.brownA += b;
      it.brownB += b;
    }
  } else if (c.mode === 'toaster') {
    const b = (c.toastLevel ?? 3) * TOAST_RATE * def.heat.brown * dt;
    it.brownA += b;
    it.brownB += b;
  } else if (c.mode !== 'potLiquid' && c.vessel > BROWN_START) {
    const b = (c.vessel - BROWN_START) * BROWN_RATE * def.heat.brown * dt;
    if (c.mode === 'pan') it.brownA += b;
    else {
      // 乾炒：有攪拌時兩面平均；太久沒攪拌，貼鍋的一面上色加快
      const stirred = (c.sinceStir ?? 0) <= STIR_GRACE;
      it.brownA += b * (stirred ? 0.55 : 1.3);
      it.brownB += b * (stirred ? 0.55 : 0.1);
    }
  }
  if (it.doneness + it.brownA + it.brownB > before && !it.methods.includes(c.method)) it.methods.push(c.method);
  if (c.mode === 'toaster' || c.vessel >= COOK_SEC_MIN_VESSEL) {
    it.lastMode = c.mode;
    const cs = (it.cookSec ??= {});
    cs[c.mode] = Math.round(((cs[c.mode] ?? 0) + dt) * 10) / 10;
    const peak = c.mode === 'toaster' ? 120 + (c.toastLevel ?? 3) * 20 : c.vessel;
    if (peak > (it.peakHeat ?? 0)) it.peakHeat = Math.round(peak);
  }
}

/** 離開熱源：慢慢回到室溫（或冷藏溫度）；中心溫度還高時熟度繼續增加（餘熱） */
export function coolItem(it: ItemState, ambient = ROOM_TEMP, dt = DT): void {
  const def = INGREDIENTS[it.type];
  it.temp += (ambient - it.temp) * (1 - Math.exp(-COOL_K * dt));
  if (it.temp > def.heat.cookStart) it.doneness += (it.temp - def.heat.cookStart) * DONE_RATE * dt;
}

/** 水槽浸泡一步 */
export function soakItem(it: ItemState, dt = DT): void {
  it.soaked = (it.soaked ?? 0) + dt / SOAK_SEC;
}

/** 浸泡狀態的文字 */
export function soakLabel(s: number | undefined): string | null {
  if (!s || s < 0.05) return null;
  if (s < 1) return `泡水中（${Math.round(s * 100)}%）`;
  if (s < SOAK_MUSHY) return '泡軟了';
  return '泡爛了';
}

/** 新鮮度：只有會壞的食材、而且不在冷藏架上時才會下降 */
export function ageItem(it: ItemState, dt = DT): void {
  const shelf = INGREDIENTS[it.type].shelfSec;
  if (shelf) it.freshness -= dt / shelf;
}

/** 翻面：交換朝下的一面 */
export function flipItem(it: ItemState): void {
  [it.brownA, it.brownB] = [it.brownB, it.brownA];
  it.flips = (it.flips ?? 0) + 1;
}

/* ------------------------------------------------------------------ */
/* 衍生狀態                                                            */
/* ------------------------------------------------------------------ */

export const maxBrown = (it: Pick<ItemState, 'brownA' | 'brownB'>): number => Math.max(it.brownA, it.brownB);

export function cookingState(it: Pick<ItemState, 'type' | 'doneness' | 'brownA' | 'brownB' | 'scorched'>): CookingState {
  const h = INGREDIENTS[it.type].heat;
  if (it.doneness >= h.burnt || maxBrown(it) >= BROWN_BURNT || it.scorched) return 'BURNT';
  if (it.doneness > h.done[1]) return 'OVERCOOKED';
  if (it.doneness >= h.done[0]) return 'COOKED';
  if (it.doneness > 0.05) return 'COOKING';
  return 'RAW';
}

export function freshnessState(it: Pick<ItemState, 'type' | 'freshness'>): FreshnessState {
  if (it.freshness <= 0) return 'EXPIRED';
  if (INGREDIENTS[it.type].shelfSec && it.freshness < 0.35) return 'AGING';
  return 'FRESH';
}

/** 口味帶：決定這份食材貢獻哪一組口味（見食譜手冊的口味表） */
export function flavorBand(it: Pick<ItemState, 'type' | 'doneness' | 'brownA' | 'brownB' | 'scorched'>): FlavorBand {
  const s = cookingState(it);
  if (s === 'BURNT') return 'burnt';
  if (maxBrown(it) >= 0.6) return 'browned';
  if (it.doneness >= INGREDIENTS[it.type].heat.done[0] * 0.5) return 'cooked';
  return 'raw';
}

export const COOKING_STATE_LABEL: Record<CookingState, string> = { RAW: '生的', COOKING: '加熱中', COOKED: '熟了', OVERCOOKED: '過熟', BURNT: '燒焦' };
export const FRESHNESS_LABEL: Record<FreshnessState, string> = { FRESH: '新鮮', AGING: '開始不新鮮', EXPIRED: '過期' };

/* ------------------------------------------------------------------ */
/* 感知：同一份狀態，依角色的感官給出不同、但資訊量相同的描述               */
/* ------------------------------------------------------------------ */

export type Sense = 'sight' | 'sound' | 'touch';

/** 外觀（看得見的人）：上色程度 */
export function lookOfBrown(b: number): string {
  if (b < 0.15) return '沒有上色';
  if (b < 0.45) return '淺金色';
  if (b < 1.0) return '金黃';
  if (b < 1.5) return '深褐';
  if (b < BROWN_BURNT) return '邊緣發黑';
  return '焦黑';
}

/** 聲音（聽得見的人）：上色程度對應的滋滋聲變化 */
export function soundOfBrown(b: number, vessel: number): string {
  if (vessel < 100) return '幾乎沒有聲音';
  if (b < 0.45) return vessel < 150 ? '輕微的滋滋聲' : '穩定的滋滋聲';
  if (b < 1.0) return '滋滋聲變得清脆';
  if (b < 1.5) return '滋滋聲變乾、變尖';
  if (b < BROWN_BURNT) return '開始有劈啪聲（快焦了）';
  return '刺耳的焦裂聲';
}

/** 觸感（鍋鏟按壓／筷子戳，任何人都能做）：熟度 */
export function touchOfDoneness(it: Pick<ItemState, 'type' | 'doneness' | 'brownA' | 'brownB' | 'scorched'>): string {
  const h = INGREDIENTS[it.type].heat;
  const s = cookingState(it);
  if (s === 'BURNT') return '又乾又脆，碎掉了';
  if (s === 'OVERCOOKED') return '很硬、乾掉了';
  if (s === 'COOKED') return it.doneness < (h.done[0] + h.done[1]) / 2 ? '剛好有彈性' : '變得結實';
  if (s === 'COOKING') return it.doneness < h.done[0] * 0.5 ? '還很軟、會流動' : '開始變硬';
  return '軟的、冰的';
}

/** 外觀：熟度（只描述看得到的變化） */
export function lookOfDoneness(it: Pick<ItemState, 'type' | 'doneness' | 'brownA' | 'brownB' | 'scorched'>): string {
  const h = INGREDIENTS[it.type].heat;
  const s = cookingState(it);
  if (s === 'BURNT') return '燒焦了';
  if (s === 'OVERCOOKED') return '縮水、乾掉了';
  if (s === 'COOKED') return it.doneness < (h.done[0] + h.done[1]) / 2 ? '剛熟' : '熟透';
  if (s === 'COOKING') return it.doneness < h.done[0] * 0.5 ? '開始變色' : '大部分變色了';
  return '生的';
}

/** 鍋溫的外觀與聲音 */
export function lookOfVessel(v: number, liquid: boolean): string {
  if (liquid) return v >= BOIL - 0.5 ? '大滾' : v > 85 ? '冒小泡' : v > 50 ? '冒熱氣' : '平靜';
  if (v < 60) return '冷的';
  if (v < 140) return '溫熱';
  if (v < 200) return '油面發亮';
  return '開始冒煙';
}
export function soundOfVessel(v: number, liquid: boolean): string {
  if (liquid) return v >= BOIL - 0.5 ? '咕嘟咕嘟的滾聲' : v > 85 ? '細小的冒泡聲' : '安靜';
  if (v < 100) return '安靜';
  if (v < 160) return '低低的嘶聲';
  if (v < 210) return '響亮的嘶聲';
  return '尖銳的嘶聲';
}

/** 依角色感官描述一份食材（看得見＝外觀；聽得見＝聲音；所有人都有觸感） */
export function describeItem(
  it: ItemState,
  senses: { sight: boolean; sound: boolean },
  vessel: { temp: number; liquid: boolean } | null,
): string[] {
  const out: string[] = [];
  if (senses.sight) {
    out.push(`外觀：${lookOfDoneness(it)}，${lookOfBrown(maxBrown(it))}`);
    if (it.brownA !== it.brownB && vessel) out.push(`朝下的一面：${lookOfBrown(it.brownA)}；朝上的一面：${lookOfBrown(it.brownB)}`);
  }
  if (senses.sound && vessel) out.push(`聲音：${soundOfBrown(it.brownA, vessel.temp)}`);
  out.push(`觸感：${touchOfDoneness(it)}`);
  return out;
}

/* ------------------------------------------------------------------ */
/* 攪拌碗：把幾份食材拌成一份                                              */
/* ------------------------------------------------------------------ */

const isBinder = (it: Pick<ItemState, 'type' | 'cut'>): boolean => it.type === 'flour' || (it.type === 'egg' && it.cut === 'BEATEN');
const isWet = (it: Pick<ItemState, 'type' | 'cut'>): boolean => !!INGREDIENTS[it.type].liquid || (it.type === 'egg' && it.cut === 'BEATEN');

/** 判斷拌出來的是什麼（不含主體的選擇）；回傳 null＝不能拌（全部都是液體、或少於兩份） */
export function mixKindOf(list: ReadonlyArray<Pick<ItemState, 'type' | 'cut'>>): MixKind | null {
  if (list.length < 2) return null;
  if (list.every((it) => INGREDIENTS[it.type].liquid)) return null;
  const solids = list.filter((it) => !isWet(it) && it.type !== 'flour');
  if (list.some((it) => it.type === 'flour') && list.some(isWet) && solids.every((it) => it.cut !== 'WHOLE' && it.cut !== 'CHUNK' && it.cut !== 'SLICED')) return 'batter';
  const base = list.filter((it) => (it.cut === 'MINCED' || it.cut === 'MASHED' || it.type === 'ground_pork') && !isBinder(it));
  if (base.length && list.some(isBinder)) return 'bound';
  return 'tossed';
}

/**
 * 選主體（決定這一份用誰的加熱曲線）：生的蛋白質（要熟透）＞麵糊的麵粉＞最難熟的固體。
 * 液體永遠不會是主體。
 */
export function pickMixLead<T extends Pick<ItemState, 'type' | 'cut' | 'doneness'>>(list: readonly T[], kind: MixKind): T | null {
  const solids = list.filter((it) => !INGREDIENTS[it.type].liquid);
  if (!solids.length) return null;
  const raw = solids.filter((it) => (INGREDIENTS[it.type].meat || INGREDIENTS[it.type].seafood) && it.doneness < INGREDIENTS[it.type].heat.done[0]);
  if (raw.length) return raw.reduce((a, b) => (INGREDIENTS[b.type].mass > INGREDIENTS[a.type].mass ? b : a));
  if (kind === 'batter') return solids.find((it) => it.type === 'flour') ?? solids[0];
  return solids.reduce((a, b) => (INGREDIENTS[b.type].heat.done[0] * INGREDIENTS[b.type].mass > INGREDIENTS[a.type].heat.done[0] * INGREDIENTS[a.type].mass ? b : a));
}

/**
 * 展開一份拌料：主體＋每個拌進去的食材，各自成為一個成分。
 * 拌進去的食材跟著主體一起受熱：溫度、上色、經歷的加熱方式相同；熟度依主體「熟了幾成」換算到自己的曲線上。
 */
export function expandMix<T extends ItemState>(it: T): T[] {
  if (!it.mix) return [it];
  const leadDef = INGREDIENTS[it.type].heat;
  const { mix, ...lead } = it;
  // 拌好之後主體「多熟了幾成」：拌進去的食材依自己的曲線多熟同樣的幾成
  const gain = Math.max(0, it.doneness - mix.at.doneness) / Math.max(0.1, leadDef.done[0]);
  const out: T[] = [{ ...(lead as T), mixedWith: it.id, mixKind: mix.kind }];
  for (const p of mix.parts) {
    const h = INGREDIENTS[p.type].heat;
    out.push({
      ...(p as T),
      history: it.history,
      temp: it.temp,
      maxTemp: Math.max(p.maxTemp, it.maxTemp),
      doneness: p.doneness + gain * h.done[0],
      brownA: p.brownA + Math.max(0, it.brownA - mix.at.brownA),
      brownB: p.brownB + Math.max(0, it.brownB - mix.at.brownB),
      methods: [...new Set([...p.methods, ...it.methods])],
      cookSec: addCookSec(p.cookSec, subCookSec(it.cookSec, mix.at.cookSec)),
      peakHeat: Math.max(p.peakHeat ?? 0, it.peakHeat ?? 0) || undefined,
      flips: it.flips,
      lastMode: it.lastMode ?? p.lastMode,
      scorched: p.scorched || it.scorched,
      mixedWith: it.id,
      mixKind: mix.kind,
    });
  }
  return out;
}

function subCookSec(a: Partial<Record<HeatMode, number>> | undefined, b: Partial<Record<HeatMode, number>> | undefined): Partial<Record<HeatMode, number>> {
  const out: Partial<Record<HeatMode, number>> = {};
  for (const [k, v] of Object.entries(a ?? {}) as Array<[HeatMode, number]>) {
    const d = v - (b?.[k] ?? 0);
    if (d > 0) out[k] = Math.round(d * 10) / 10;
  }
  return out;
}
function addCookSec(a: Partial<Record<HeatMode, number>> | undefined, b: Partial<Record<HeatMode, number>>): Partial<Record<HeatMode, number>> | undefined {
  const out: Partial<Record<HeatMode, number>> = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b) as Array<[HeatMode, number]>) out[k] = Math.round(((out[k] ?? 0) + v) * 10) / 10;
  return Object.keys(out).length ? out : undefined;
}

/** 總受熱秒數 */
export const totalCookSec = (it: Pick<ItemState, 'cookSec'>): number => Object.values(it.cookSec ?? {}).reduce((a, b) => a + (b ?? 0), 0);
