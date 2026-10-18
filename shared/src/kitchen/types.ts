import type { PhysicsPublic } from '../physics';
import type { TutorialPublic } from '../tutorial';
import type { NightPublic } from '../nights';
import type { DoorState } from '../level';
import type { Seat } from '../seats';
import type { CoopPublic, PlayerFlawState } from '../flaws';
import type { CategoryWeights, FlavorDim, IngredientId, SeasoningId, Storage, Vessel } from './data';
import type { HeatLevel, HistoryEntry, ItemState } from './model';
import type { DishAnalysis, QualityGrade } from './dish';

/** 玩家手上拿的東西 */
export type Held =
  | { kind: 'item'; id: string }
  | { kind: 'plate'; id: string }
  | { kind: 'measure'; seasoning: SeasoningId; units: number; /** 怕火廚師一次量兩種 */ extra?: { seasoning: SeasoningId; units: number } }
  | { kind: 'crate'; storage: Storage }
  /** 一疊髒盤（徒手最多 4 個；潔癖主廚用托盤最多 6 個） */
  | { kind: 'dirty'; plate: number; bowl: number; tray?: boolean }
  | null;

/** 碗盤數量 */
export interface DishCount {
  plate: number;
  bowl: number;
}

/** 公開的食材狀態（不含完整操作紀錄；紀錄留在伺服器，評分時附在結果裡） */
export type ItemPublic = Omit<ItemState, 'history'> & { steps: number };

export interface PlateComponent extends Omit<ItemState, 'history'> {
  history: HistoryEntry[];
}

export interface PlatePublic {
  id: string;
  vessel: Vessel;
  /** 湯鍋盛起來時一起盛進來的湯量（杯） */
  liquid?: number;
  components: Array<Omit<PlateComponent, 'history'>>;
  seasoning: Partial<Record<SeasoningId, number>>;
}

export interface StationPublic {
  id: string;
  /** 放在工作站上的食材（平底鍋、湯鍋、砧板、水槽、烤麵包機） */
  items: string[];
  /** 裝盤區上的盤子 */
  plates: string[];
  heat?: HeatLevel;
  /** 鍋溫（°C，取整數；畫面不直接顯示，給感知描述與聲音用） */
  vessel?: number;
  liquid?: number;
  scorch?: number;
  sinceStir?: number;
  seasoning?: Partial<Record<SeasoningId, number>>;
  toast?: { level: number; leftMs: number } | null;
  /** 水槽：正在泡水（米粉要先泡軟） */
  soak?: boolean;
  /** 砧板碰過生肉、還沒擦 */
  contaminated?: boolean;
  stock?: Partial<Record<IngredientId, number>>;
  /** 後門送貨區：等著被搬進來的箱子 */
  crate?: Storage | null;
  /** 置物櫃裡躲著的人、鐵籠裡關著的人 */
  occupant?: Seat | null;
  /** 冷藏架／乾貨架最上層的存貨（一般人要踩踏凳，巨人伸手就拿，小矮人拿不到） */
  high?: Partial<Record<IngredientId, number>>;
  /** 裝盤區：乾淨的盤子與碗；水槽：碗盤架上等著洗的髒盤；回收窗口：送回來的髒盤 */
  dishes?: DishCount;
  dirty?: DishCount;
  /** 這位玩家看不到裡面（小矮人看湯鍋）：items／liquid／seasoning 都不送 */
  hidden?: boolean;
}

export type TaskKind = 'wash' | 'peel' | 'wipe' | 'probe' | 'rescue' | 'escort' | 'verify' | 'clamp' | 'glove' | 'tray' | 'pedal' | 'dishes' | 'stool' | 'peek' | 'splash' | 'struggle' | 'mix' | 'mop';
/** 計時動作的名稱（伺服器訊息與介面共用） */
export const TASK_TEXT: Record<TaskKind, string> = {
  wash: '清洗',
  peel: '削皮',
  wipe: '擦砧板',
  probe: '量溫度',
  rescue: '撬開鐵籠',
  struggle: '掙脫鐵籠',
  escort: '請客人回座位',
  verify: '核對傳聞',
  clamp: '用夾具固定',
  glove: '戴隔熱手套',
  tray: '用托盤收髒盤',
  pedal: '用腳踩開垃圾桶',
  dishes: '洗碗',
  stool: '踩上踏凳',
  peek: '墊腳看鍋裡',
  splash: '洗把臉',
  mix: '攪拌',
  mop: '擦乾地上的水',
};

export interface TaskPublic {
  kind: TaskKind;
  stationId: string;
  startedAt: number;
  endsAt: number;
}

export type PlayerStatus = 'ok' | 'trapped' | 'hidden';
/**
 * 物品欄：左手、右手、菜籃（只放還沒處理的原料，2 格）。
 * 「目前的手」拿的東西是 held，另一隻手是 other；side 是目前的手是哪一隻（畫面顯示用）。
 * 貨箱、一疊髒盤要用雙手（另一隻手必須空著）。單手廚師只有一隻手。
 */
export const BASKET_SLOTS = 2;
/** 一次最多帶幾份生食材（兩隻手＋菜籃） */
export const CARRY_MAX = 2 + BASKET_SLOTS;
export type HandSide = 'L' | 'R';
export const HAND_LABEL: Record<HandSide, string> = { L: '左手', R: '右手' };
/** 要用雙手拿的東西 */
export const isTwoHanded = (h: Held): boolean => h?.kind === 'crate' || h?.kind === 'dirty';
/** 成品架（處理好的食材放這裡，肉與其他分開）的容量 */
export const RACK_CAPACITY = 6;

export interface PlayerKitchen {
  held: Held;
  /** 另一隻手（單手廚師永遠是 null） */
  other: Held;
  /** 目前用的是哪一隻手 */
  side: HandSide;
  /** 菜籃裡的生食材（手上空了會自動補上） */
  basket: string[];
  task: TaskPublic | null;
  status: PlayerStatus;
}

export type OrderKind = 'signature' | 'free';
export interface OrderPublic {
  id: string;
  kind: OrderKind;
  recipeId?: string;
  requestId?: string;
  table: number;
  openedAt: number;
  deadline: number;
  status: 'open' | 'served' | 'missed';
  result?: ScoreResult;
  /**
   * 健忘助手（D15）想不起來這張單：伺服器只送桌號、種類與時間（recipeId／requestId 不送）。
   * 只出現在送給該玩家的快照裡；訂單本身完全不受影響。
   */
  forgotten?: boolean;
  /** 第七晚：那位客人（最後一桌）的單 */
  story?: boolean;
}

/** 招牌菜的五項、委託的五項（烹調、風味、搭配、質地、時間）、必要條件、加分、食品安全 */
export type ReasonCat = keyof CategoryWeights | 'safety' | 'cook' | 'flavor' | 'pairing' | 'texture' | 'time' | 'require' | 'bonus';
export type ScoreCats = Record<string, number>;

/** 委託的判定結果（硬性條件和品質分開） */
export interface CommissionResult {
  id: string;
  title: string;
  /** 所有必要條件都做到 */
  passed: boolean;
  violations: string[];
  bonuses: Array<{ text: string; pts: number }>;
  grade: QualityGrade;
  /** 本機紀錄用的獎勵（遊戲幣） */
  coins: number;
}
export interface ScoreReason {
  cat: ReasonCat;
  ok: boolean;
  text: string;
}

export interface ScoreResult {
  orderId: string;
  dish: string;
  /** 0–100 */
  total: number;
  /** 各項 0–1（招牌菜：製程、火候、刀工、調味、裝盤；委託：烹調、風味、搭配、質地、時間） */
  categories: ScoreCats;
  weights: ScoreCats;
  reasons: ScoreReason[];
  /** 食品安全或過期造成的分數上限 */
  cap?: { max: number; why: string };
  /** 口味（主廚自選時顯示） */
  taste?: Partial<Record<FlavorDim, number>>;
  /** 效率另外記錄，不混進品質分數 */
  elapsedSec: number;
  parSec: number;
  efficiency: 'fast' | 'on_time' | 'slow';
  servedBy: Seat;
  /** 每個成分的操作紀錄（追查失誤） */
  trail: Array<{ label: string; steps: string[] }>;
  /** 自由料理的判定：這道菜實際是什麼（名稱、分類、四項品質、原因）。和訂單的分數分開計算 */
  analysis?: DishAnalysis;
  /** 主廚委託的判定 */
  commission?: CommissionResult;
}

export type ShiftPhase = 'PREP' | 'SERVICE' | 'CLOSED';

/* ------------------------------ 威脅 ------------------------------ */

export type GuestState = 'seated' | 'doorway' | 'kitchen' | 'escorted' | 'gone';
export interface GuestPublic {
  x: number;
  z: number;
  yaw: number;
  state: GuestState;
  /** 這次移動的序號（客戶端用它判斷「他剛剛動過」） */
  moves: number;
}

/** bang：被關著的防火門擋住，在門前撞門（之後一定離開） */
/** lurk＝在後門外刮門（進來前 6 秒的預警） */
export type MonsterMode = 'dormant' | 'lurk' | 'patrol' | 'investigate' | 'chase' | 'windup' | 'search' | 'leave' | 'bang';
export interface MonsterPublic {
  x: number;
  z: number;
  yaw: number;
  mode: MonsterMode;
  /** 在場（dormant＝在後門外，看不到也聽不到） */
  present: boolean;
  /** 在場時：還能待幾毫秒（每次最多 60 秒；用完就從後門離開） */
  kitchenLeft: number | null;
  /** 在後門外刮門時：還有幾毫秒就進來（這段時間鎖上後門就進不來） */
  warnLeft?: number | null;
  /** 後門外的動靜（0–1，越接近 1 越快進來；監視器上看得到） */
  restless: number;
}

export interface ThreatsPublic {
  guest: GuestPublic | null;
  monster: MonsterPublic | null;
  /** 監視器正在被觀看 */
  cctv: boolean;
}

export interface ShiftStats {
  served: number;
  missed: number;
  qualitySum: number;
  trapped: number;
  rescued: number;
  /** 自己掙脫鐵籠的次數 */
  escaped: number;
}

export interface KitchenPublic {
  phase: ShiftPhase;
  /** 簡單的物理：積水、飛行中的東西 */
  physics?: PhysicsPublic;
  /** 班次開始後的毫秒數（伺服器時鐘） */
  t: number;
  prepMs: number;
  serviceMs: number;
  stations: Record<string, StationPublic>;
  items: Record<string, ItemPublic>;
  plates: Record<string, PlatePublic>;
  players: Partial<Record<Seat, PlayerKitchen>>;
  orders: OrderPublic[];
  /** 這一班會出現的食譜（招牌菜＋今日特餐）：開班前就可以先看食譜 */
  menu?: string[];
  doors: DoorState;
  /** 防火門：關閉到何時、何時可以再關 */
  /** 門禁（監視器）：防火門與後門共用冷卻 readyAt */
  fireDoor: { closedUntil: number; readyAt: number };
  backDoor: { closedUntil: number };
  threats: ThreatsPublic;
  stats: ShiftStats;
  /** 互助狀態：缺陷卡、交接、便條、標記、傳聞、準備提示（所有人一樣） */
  coop: CoopPublic;
  /** 只給本人的缺陷狀態（每位玩家收到的快照不同） */
  self?: PlayerFlawState;
  /** 教學關：目前的步驟 */
  tutorial?: TutorialPublic;
  /** 連續七晚：第幾晚、故事碎片、那位客人的單 */
  night?: NightPublic;
}

/* ------------------------------ 操作 ------------------------------ */

export interface KitchenActionPayload {
  stationId: string;
  action: string;
  args?: Record<string, unknown>;
  /** 每次操作唯一；網路重送時伺服器會回傳上一次的結果，不會重複執行 */
  requestId: string;
}

export interface KitchenActionResult {
  ok: boolean;
  message: string;
  tone: 'ok' | 'info' | 'warn' | 'error';
  /** 出餐的評分結果 */
  result?: ScoreResult;
  /** 溫度計的讀數 */
  probe?: Array<{ label: string; temp: number }>;
  /** 開始切菜：這次要下幾刀（缺陷卡可能改變） */
  need?: number;
}

/** 依感官過濾後送給個別玩家的事件 */
export type KitchenEventKind =
  | 'order_new'
  | 'order_missed'
  | 'served'
  | 'toast_pop'
  | 'boil_over'
  | 'trapped'
  | 'rescued'
  | 'guest_say'
  | 'guest_moved'
  | 'monster_sound'
  | 'monster_roar'
  | 'monster_grab'
  | 'fire_door'
  | 'phase'
  | 'coop'
  | 'flaw'
  | 'story';

export interface KitchenEvent {
  kind: KitchenEventKind;
  /** 事件的本質：sound＝一個聲音提示（耳背砧板收不到，也不會換成文字）；sight＝畫面上看得到的變化；省略＝一般通知 */
  sense?: 'sound' | 'sight';
  /** 發生位置（空間音效、標記） */
  at?: [number, number];
  /** 文字通知 */
  text?: string;
  /** 聲音（耳背砧板只收到 critical 事件的聲音） */
  sound?: string;
  /** 畫面效果 */
  visual?: string;
  role?: Seat;
  /** 危險事件：不受任何缺陷卡過濾，一定送到（而且一定附畫面提示） */
  critical?: boolean;
  /** 故事（連續七晚）：出單機印出的「不是訂單的單」或結尾 */
  story?: { night: number; title: string; text: string; ending?: 'served' | 'missed' };
}
