import {
  BASKET_SLOTS,
  CARRY_MAX,
  HAND_LABEL,
  isTwoHanded,
  type HandSide,
  RACK_CAPACITY,
  CUT_LABEL,
  CUT_STROKES,
  DT,
  FREE_REQUESTS,
  HEAT_LABEL,
  HEAT_LEVELS,
  INGREDIENTS,
  INGREDIENT_IDS,
  MEASURE_STEPS,
  RECIPES,
  FRAGMENT_AT,
  nightDef,
  planQuick,
  type QuickMode,
  PHYSICS,
  SEATS,
  SEASONINGS,
  SERVER_INTERACT_RANGE,
  STATIONS,
  STATION_BY_ID,
  STIR_GRACE,
  TOAST_SEC,
  TASK_TEXT,
  ageItem,
  coolItem,
  dishTaste,
  flipItem,
  heatItem,
  newItem,
  openDoors,
  roleCanUseStation,
  stationFront,
  stepVessel,
  soakItem,
  soakLabel,
  expandMix,
  mixKindOf,
  pickMixLead,
  MIX_LABEL,
  OVEN_TARGET,
  SOAK_SEC,
  ROOM_TEMP,
  analyzeDish,
  dishGuess,
  tasteWord,
  type Cut,
  type DoorState,
  type DishCount,
  type FlavorDim,
  type Held,
  type HeatLevel,
  type IngredientId,
  type ItemPublic,
  type ItemState,
  type KitchenActionPayload,
  type KitchenActionResult,
  type KitchenEvent,
  type KitchenPublic,
  type OrderPublic,
  type PlateComponent,
  type PlatePublic,
  type PlayerKitchen,
  type FlawEffectConfig,
  type FlawId,
  type Seat,
  type SeasoningId,
  type ShiftPhase,
  type ShiftStats,
  type StationDef,
  type StationPublic,
  type Storage,
  type TaskKind,
  type TaskPublic,
  type Vessel,
  FLAVOR_DIMS,
  FLAVOR_LABEL,
  isRawProtein,
} from '@last-table/shared';
import { buildSchedule, crewScale, MAX_OPEN_ORDERS, ORDER_DELAY_MS, patienceMs, type OrderPlan, type ScheduleOptions } from './orders';
import { FlawSystem } from '../flaws';
import { scorePlate } from './scoring';
import { Physics } from './physics';
import type { ThreatSystem } from './threats/types';
import type { Tutorial } from './tutorial';

/**
 * 廚房模擬（CookingSystem＋KitchenStationSystem＋OrderSystem）。伺服器權威、固定步長。
 *
 * - 時間只由 tick() 推進（每步 100 ms），所有狀態轉換都在這裡或在玩家操作時發生，
 *   同一個初始狀態＋同一個操作序列＝同一個結果（測試以手動推進的時鐘驗證）。
 * - 玩家操作以 requestId 去重：網路重送或重連後重送，同一個操作只會執行一次。
 * - 恐怖系統（ThreatSystem）透過介面掛在這裡，只能影響玩家的位置與狀態（被抓走、躲起來），
 *   不能碰任何食材、鍋具或評分；料理規則在有沒有怪物時完全相同。
 */

export interface PoseView {
  x: number;
  z: number;
  yaw: number;
  crouch: boolean;
  connected: boolean;
  /** 最近的移動速度（m/s），用來判斷跑步的腳步聲 */
  speed: number;
}

export interface SimHooks {
  pose(role: Seat): PoseView | null;
  teleport(role: Seat, x: number, z: number, yaw: number): void;
  /** 事件：房間依接收者的缺陷卡過濾後送出 */
  event(e: KitchenEvent, to: Seat | 'all'): void;
  /** 玩家的暱稱（事件文字用） */
  name?(role: Seat): string;
}

export interface SimOptions {
  prepMs: number;
  serviceMs: number;
  seed: number;
  schedule?: OrderPlan[];
  /** 這一班有哪些席位（省略＝P1–P3，舊測試用） */
  seats?: Seat[];
  /** 每個席位的缺陷卡 */
  flaws?: Partial<Record<Seat, FlawId>>;
  flawConfig?: FlawEffectConfig;
  /** 開班時乾淨的碗盤數（省略＝依人數） */
  dishes?: DishCount;
  /** 連續七晚的第幾晚（0／省略＝單班） */
  night?: number;
  /** 出單的額外調整（無盡模式） */
  scheduleOpts?: ScheduleOptions;
  /** 無盡模式：開班時的存貨、乾淨碗盤倍率；監視器鎖不了後門；一天最多跑幾張單（超過就提早打烊） */
  stockMul?: number;
  dishMul?: number;
  backLockBroken?: boolean;
  missLimit?: number;
}

export const DEFAULT_SIM: SimOptions = { prepMs: 60_000, serviceMs: 420_000, seed: 1 };

export type { StationRT, Plate };

interface StationRT {
  def: StationDef;
  items: string[];
  plates: string[];
  heat: HeatLevel;
  vessel: number;
  liquid: number;
  lastStir: number;
  scorch: number;
  seasoning: Partial<Record<SeasoningId, number>>;
  toast: { level: number; endsAt: number } | null;
  contaminated: boolean;
  stock: Partial<Record<IngredientId, number>>;
  /** 冷藏架／乾貨架最上層的存貨 */
  high: Partial<Record<IngredientId, number>>;
  /** 裝盤區的乾淨碗盤；水槽碗盤架／回收窗口的髒盤 */
  dishes: DishCount;
  dirty: DishCount;
  crate: Storage | null;
  occupant: Seat | null;
  chop: { role: Seat; cut: Cut; startedAt: number; need: number } | null;
  /** 水槽：放了水在泡（米粉） */
  soak: boolean;
  /** 烤箱：這次設定的溫度是否已經提示過「預熱完成」 */
  preheatNoted: boolean;
}

interface Plate {
  id: string;
  vessel: Vessel;
  components: PlateComponent[];
  seasoning: Partial<Record<SeasoningId, number>>;
  /** 湯鍋盛起來的湯量（杯；蒸發後剩下的） */
  liquid?: number;
}

interface Task {
  kind: TaskKind;
  stationId: string;
  startedAt: number;
  endsAt: number;
  arg?: string;
}

interface PlayerRT {
  held: Held;
  /** 另一隻手 */
  other: Held;
  /** 目前用的是哪一隻手（顯示用） */
  side: HandSide;
  /** 菜籃裡的生食材 */
  basket: string[];
  task: Task | null;
  status: 'ok' | 'trapped' | 'hidden';
  cache: Map<string, KitchenActionResult>;
  lastNoiseAt: number;
}

interface Order extends OrderPublic {
  plan: OrderPlan;
}

/**
 * 自己掙脫鐵籠：沒有隊友能來救（單人遊戲、其他人都被抓或斷線）時 7 秒；有隊友時 18 秒（還是可以自己來，只是比等人救慢）。
 * 搖鐵籠很吵：開始時與每 3 秒都會發出聲音（怪物聽得到，可能回來看）。
 */
export const STRUGGLE = { soloMs: 7000, teamMs: 18000, noiseRadius: 7, rattleMs: 3000 } as const;
const STEP_FOR_RATTLE = DT * 1000;

type HeldKind = NonNullable<Held>['kind'];
/** 動作 → 要用手上的哪一種東西（另一隻手有的話自動換過去） */
const HAND_NEED: Record<string, readonly HeldKind[]> = {
  '*:place': ['item'],
  'shelf:place': ['item', 'plate'],
  'plating:place': ['plate'],
  'plating:add': ['item'],
  '*:pour': ['measure'],
  'stove:ladle': ['plate'],
  'pass:serve': ['plate'],
  'sink:load': ['dirty'],
  '*:restock': ['crate'],
  '*:store': ['item'],
};
const cagePos = (): [number, number] => [STATION_BY_ID.cage.pos[0], STATION_BY_ID.cage.pos[1]];

const CAPACITY: Partial<Record<StationDef['kind'], number>> = { sink: 2, prep: 1, pan: 3, stove: 8, toaster: 2, shelf: 4, oven: 4, mixer: 6 };
const TASK_MS: Record<TaskKind, number> = {
  wash: 2000,
  peel: 2500,
  wipe: 2000,
  probe: 1200,
  rescue: 2500,
  struggle: 18000,
  escort: 2000,
  verify: 2000,
  clamp: 4000,
  glove: 3000,
  tray: 2500,
  pedal: 1200,
  dishes: 1500,
  stool: 1500,
  peek: 1000,
  splash: 2000,
  mix: 2500,
  mop: 2200,
};
export const TASK_LABEL = TASK_TEXT;
/** 客人吃完、髒盤送回回收窗口要多久（與餐廳裡客人吃飯的時間一致） */
export const DISH_RETURN_MS = 25_000;
/** 洗一個碗盤要多久（一次洗完碗盤架上全部） */
export const DISH_WASH_MS_EACH = 700;
/** 徒手一次最多拿幾個髒盤 */
export const DIRTY_HAND_CAPACITY = 4;

/** 開班的乾淨碗盤（依人數）：大約夠出一半的單，中途要洗一次碗 */
export function dishStock(players: number): DishCount {
  if (players <= 1) return { plate: 4, bowl: 3 };
  if (players <= 4) return { plate: 6, bowl: 4 };
  if (players <= 6) return { plate: 8, bowl: 5 };
  return { plate: 10, bowl: 6 };
}
/** 噪音半徑（公尺）：怪物會被吸引過去調查 */
export const NOISE = { chop: 5, clang: 3.5, sizzleHigh: 4, toastPop: 5, trash: 4, run: 6, echo: 7, boil: 3 } as const;
const PLATING_SLOTS = 3;
const PROBE_BROKEN = '溫度計失靈了（主廚委託「異常廚房」）：用外觀、聲音、觸感，或請隊友回報熟度。';

const ok = (message: string, extra: Partial<KitchenActionResult> = {}): KitchenActionResult => ({ ok: true, message, tone: 'ok', ...extra });
const info = (message: string, extra: Partial<KitchenActionResult> = {}): KitchenActionResult => ({ ok: true, message, tone: 'info', ...extra });
const warn = (message: string): KitchenActionResult => ({ ok: false, message, tone: 'warn' });
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export class KitchenSim {
  t = 0;
  phase: ShiftPhase = 'PREP';
  readonly items = new Map<string, ItemState>();
  readonly plates = new Map<string, Plate>();
  readonly stations = new Map<string, StationRT>();
  readonly players = {} as Record<Seat, PlayerRT>;
  readonly orders: Order[] = [];
  readonly stats: ShiftStats = { served: 0, missed: 0, qualitySum: 0, trapped: 0, rescued: 0, escaped: 0 };
  doors: DoorState = openDoors();
  fireDoor = { closedUntil: 0, readyAt: 0 };
  /** 後門的鎖（監視器）：鎖著時後門外的東西進不來；和防火門共用冷卻 */
  backDoor = { closedUntil: 0 };
  get backClosed(): boolean {
    return this.t < this.backDoor.closedUntil;
  }
  get backLockBroken(): boolean {
    return !!this.opts.backLockBroken;
  }
  cctvBy: Seat | null = null;
  threats: ThreatSystem | null = null;
  /** 教學關的導演（一般的班次沒有） */
  tutorial: Tutorial | null = null;
  /** 連續七晚：故事碎片印出來了沒有、那位客人的單、提早打烊的時間 */
  storyShown = false;
  storyState: 'open' | 'served' | 'missed' | null = null;
  endAt: number | null = null;
  /** 缺陷卡（唯一的判定者；見 server/src/flaws） */
  readonly flaws: FlawSystem;
  /** 簡單的物理：積水與滑倒、丟東西、人與人的碰撞、湯滾出來 */
  readonly physics: Physics;
  /** 這一班的席位 */
  readonly seats: readonly Seat[];
  readonly recent: Array<{ at: number; role: Seat; stationId: string; action: string; ok: boolean; message: string }> = [];

  private seq = 0;
  private plan: OrderPlan[];
  /** 這一班會出現的食譜 */
  private menu: string[] = [];
  private nextPlan = 0;
  private delayUntil = 0;
  /** 出餐後等著送回回收窗口的髒盤 */
  private dishReturns: Array<{ at: number; vessel: Vessel }> = [];
  private nextCrateAt = 0;
  private crateKind: Storage = 'FRIDGE';
  private readonly maxOpen: number;

  constructor(
    private readonly hooks: SimHooks,
    readonly opts: SimOptions = DEFAULT_SIM,
  ) {
    const seatCount = (opts.seats ?? ['P1', 'P2', 'P3']).length;
    const baseDishes = opts.dishes ?? dishStock(seatCount);
    const dm = opts.dishMul ?? 1;
    const startDishes: DishCount = dm === 1 ? baseDishes : { plate: Math.max(2, Math.round(baseDishes.plate * dm)), bowl: Math.max(1, Math.round(baseDishes.bowl * dm)) };
    const sm = opts.stockMul ?? 1;
    for (const def of STATIONS) {
      const stock: Partial<Record<IngredientId, number>> = {};
      const high: Partial<Record<IngredientId, number>> = {};
      if (def.kind === 'fridge' || def.kind === 'pantry') {
        for (const id of INGREDIENT_IDS) {
          const ing = INGREDIENTS[id];
          if ((def.kind === 'fridge') !== (ing.storage === 'FRIDGE')) continue;
          // 大約三成的存貨放在最上層
          const total = sm === 1 ? ing.stock : Math.max(1, Math.round(ing.stock * sm));
          high[id] = Math.round(total * 0.3);
          stock[id] = total - high[id]!;
        }
      }
      this.stations.set(def.id, {
        def,
        items: [],
        plates: [],
        heat: 'OFF',
        vessel: 22,
        liquid: 0,
        lastStir: 0,
        scorch: 0,
        seasoning: {},
        toast: null,
        contaminated: false,
        stock,
        high,
        dishes: def.kind === 'plating' ? { ...startDishes } : { plate: 0, bowl: 0 },
        dirty: { plate: 0, bowl: 0 },
        crate: null,
        occupant: null,
        chop: null,
        soak: false,
        preheatNoted: false,
      });
    }
    for (const r of SEATS) this.players[r] = { held: null, other: null, side: 'R', basket: [], task: null, status: 'ok', cache: new Map(), lastNoiseAt: 0 };
    this.seats = opts.seats ?? ['P1', 'P2', 'P3'];
    this.plan = opts.schedule ?? buildSchedule(opts.seed, this.seats.length, nightDef(opts.night ?? 0), { serviceSec: opts.serviceMs / 1000, ...opts.scheduleOpts });
    this.menu = [...new Set(this.plan.filter((p) => p.kind === 'signature' && p.recipeId).map((p) => p.recipeId!))];
    this.maxOpen = opts.schedule ? MAX_OPEN_ORDERS : crewScale(this.seats.length).maxOpen;
    this.flaws = new FlawSystem(this, opts.flaws ?? {}, opts.flawConfig, opts.seed);
    this.physics = new Physics(this);
  }

  /** 委託「異常廚房」開著的時候溫度計失靈（只改變取得資訊的方式，不改任何料理規則） */
  get probeBroken(): boolean {
    return this.orders.some((o) => o.status === 'open' && o.kind === 'free' && !!FREE_REQUESTS[o.requestId ?? '']?.effects?.probeBroken);
  }

  private id(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  get serviceStart(): number {
    return this.opts.prepMs;
  }
  get serviceEnd(): number {
    return this.opts.prepMs + this.opts.serviceMs;
  }

  /* ============================== 時間 ============================== */

  /** 推進一個固定步長（100 ms） */
  tick(): void {
    if (this.phase === 'CLOSED') return;
    this.t += DT * 1000;
    if (this.phase === 'PREP' && this.t >= this.serviceStart) {
      this.phase = 'SERVICE';
      this.nextCrateAt = this.t + 90_000;
      this.hooks.event({ kind: 'phase', text: '開始營業。' }, 'all');
    }
    if (this.phase === 'SERVICE' && (this.t >= this.serviceEnd || (this.endAt !== null && this.t >= this.endAt))) {
      this.closeShift();
      return;
    }
    this.tickStory();
    this.tickStations();
    this.physics.tick();
    this.tickTasks();
    this.refillHands();
    this.tickOrders();
    this.flaws.tick();
    this.tickDoors();
    this.tickNoise();
    if (this.phase === 'SERVICE') this.threats?.tick(DT * 1000, this);
    this.tutorial?.tick(this, DT * 1000);
  }

  closeShift(): void {
    this.phase = 'CLOSED';
    for (const o of this.orders) if (o.status === 'open') this.missOrder(o, false);
    this.hooks.event({ kind: 'phase', text: '打烊。' }, 'all');
  }

  private tickStations(): void {
    const onHeat = new Set<string>();
    for (const s of this.stations.values()) {
      const k = s.def.kind;
      if (k === 'pan' || k === 'stove') {
        const liquid = k === 'stove' && s.liquid > 0.01;
        s.vessel = stepVessel(s.vessel, s.heat, k === 'pan' ? 'pan' : 'pot', liquid);
        const sinceStir = (this.t - s.lastStir) / 1000;
        for (const id of s.items) {
          const it = this.items.get(id);
          if (!it) continue;
          onHeat.add(id);
          heatItem(it, { method: k === 'pan' ? 'pan' : 'pot', vessel: s.vessel, mode: k === 'pan' ? 'pan' : liquid ? 'potLiquid' : 'potDry', sinceStir });
        }
        if (k === 'stove') {
          if (!liquid && s.items.length && s.vessel > 150 && sinceStir > STIR_GRACE) s.scorch += ((s.vessel - 150) / 400) * DT;
          if (s.scorch >= 1) for (const id of s.items) {
            const it = this.items.get(id);
            if (it) it.scorched = true;
          }
          if (liquid && s.vessel > 99) {
            s.liquid = Math.max(0, s.liquid - (s.heat === 'HIGH' ? 0.03 : s.heat === 'MED' ? 0.015 : 0.006) * DT);
          }
        }
      } else if (k === 'oven') {
        s.vessel = stepVessel(s.vessel, s.heat, 'oven', false);
        if (s.heat !== 'OFF' && !s.preheatNoted && s.vessel >= OVEN_TARGET[s.heat] - 5) {
          s.preheatNoted = true;
          this.hooks.event({ kind: 'phase', text: `烤箱預熱好了（${OVEN_TARGET[s.heat]}°C）。`, at: s.def.pos }, 'all');
        }
        for (const id of s.items) {
          const it = this.items.get(id);
          if (!it) continue;
          onHeat.add(id);
          heatItem(it, { method: 'oven', vessel: s.vessel, mode: 'oven' });
        }
      } else if (k === 'sink' && s.soak) {
        for (const id of s.items) {
          const it = this.items.get(id);
          if (it && INGREDIENTS[it.type].soakable) soakItem(it);
        }
      } else if (k === 'toaster' && s.toast) {
        for (const id of s.items) {
          const it = this.items.get(id);
          if (!it) continue;
          onHeat.add(id);
          heatItem(it, { method: 'toaster', vessel: 0, mode: 'toaster', toastLevel: s.toast.level });
        }
        if (this.t >= s.toast.endsAt) {
          s.toast = null;
          this.hooks.event({ kind: 'toast_pop', at: s.def.pos, sound: 'toast_pop', text: '吐司跳起來了' }, 'all');
          this.noise(s.def.pos[0], s.def.pos[1], NOISE.toastPop, 'toaster');
        }
      }
    }
    for (const it of this.items.values()) {
      if (!onHeat.has(it.id)) coolItem(it);
      ageItem(it);
    }
    // 盤子上的成分也會變涼
    for (const p of this.plates.values()) for (const c of p.components) coolItem(c as ItemState);
  }

  private tickTasks(): void {
    for (const role of SEATS) {
      const p = this.players[role];
      const task = p.task;
      if (!task) continue;
      if (task.kind === 'struggle') {
        // 被關著的人搖鐵籠：只要還在籠子裡就會繼續（不用檢查距離）
        if (p.status !== 'trapped') {
          p.task = null;
          continue;
        }
        const k0 = Math.floor((this.t - STEP_FOR_RATTLE - task.startedAt) / STRUGGLE.rattleMs);
        const k1 = Math.floor((this.t - task.startedAt) / STRUGGLE.rattleMs);
        if (k1 > k0 && this.t < task.endsAt) this.rattle();
      } else if (p.status !== 'ok' || this.flaws.asleep(role) || !this.inReach(role, task.stationId, task.kind === 'escort' ? 3.2 : undefined)) {
        p.task = null;
        if (task.kind === 'verify' && task.arg) this.flaws.cancelVerify(task.arg);
        this.hooks.event({ kind: 'phase', text: '動作中斷了。' }, role);
        continue;
      }
      if (this.t < task.endsAt) continue;
      p.task = null;
      const msg = this.completeTask(role, task);
      if (msg) this.hooks.event({ kind: 'phase', text: msg }, role);
    }
    // 監視器：離開就停止觀看
    if (this.cctvBy && !this.inRange(this.cctvBy, 'cctv')) this.cctvBy = null;
  }

  private tickOrders(): void {
    if (this.phase !== 'SERVICE') return;
    const rel = (this.t - this.serviceStart) / 1000;
    const open = this.orders.filter((o) => o.status === 'open').length;
    // 那位客人的單不排隊（只有一張，而且是這一晚的重點）：時間到了就移到最前面
    const si = this.plan.findIndex((p, i) => i >= this.nextPlan && p.story && rel >= p.at);
    if (si > this.nextPlan) {
      const [sp] = this.plan.splice(si, 1);
      this.plan.splice(this.nextPlan, 0, sp);
    }
    const next = this.plan[this.nextPlan];
    if (next && rel >= next.at && (this.t >= this.delayUntil || next.story)) {
      if (open >= this.maxOpen && !next.story) this.delayUntil = this.t + ORDER_DELAY_MS;
      else {
        this.nextPlan++;
        const o: Order = {
          id: this.id('o'),
          kind: next.kind,
          recipeId: next.recipeId,
          requestId: next.requestId,
          table: next.table,
          openedAt: this.t,
          deadline: this.t + patienceMs(next),
          status: 'open',
          plan: next,
        };
        this.orders.push(o);
        this.flaws.onOrderOpened(o, this.nextPlan - 1);
        const what = o.kind === 'signature' ? RECIPES[o.recipeId!].name : `主廚委託「${FREE_REQUESTS[o.requestId!].title}」：「${FREE_REQUESTS[o.requestId!].text}」`;
        if (next.story) this.onStoryOrder();
        else this.hooks.event({ kind: 'order_new', text: `${o.table} 號桌點了 ${what}`, sound: 'ticket', at: STATION_BY_ID.pass.pos }, 'all');
      }
    }
    for (const o of this.orders) if (o.status === 'open' && this.t >= o.deadline) this.missOrder(o, true);
    // 客人吃完：髒盤送回回收窗口
    if (this.dishReturns.length) {
      const back = this.stations.get('dish_return')!;
      const due = this.dishReturns.filter((r) => this.t >= r.at);
      if (due.length) {
        this.dishReturns = this.dishReturns.filter((r) => this.t < r.at);
        for (const r of due) back.dirty[r.vessel]++;
        this.hooks.event({ kind: 'phase', sense: 'sight', text: `回收窗口送回了 ${due.length} 個髒盤。`, at: back.def.pos }, 'all');
      }
    }
    // 後門送貨
    const d = this.stations.get('delivery')!;
    if (!d.crate && this.t >= this.nextCrateAt) {
      d.crate = this.crateKind;
      this.crateKind = this.crateKind === 'FRIDGE' ? 'PANTRY' : 'FRIDGE';
      this.nextCrateAt = this.t + 90_000;
      this.hooks.event({ kind: 'phase', text: '後門有人敲了三下：送貨到了。', sound: 'knock', at: d.def.pos }, 'all');
    }
  }

  private missOrder(o: Order, announce: boolean): void {
    o.status = 'missed';
    this.stats.missed++;
    this.flaws.onOrderClosed(o.id);
    // 無盡模式：跑單超過今天的上限 → 撐不下去了，提早打烊
    const limit = this.opts.missLimit;
    if (limit !== undefined && this.stats.missed > limit && this.endAt === null && this.phase === 'SERVICE') {
      this.endAt = this.t + 8000;
      this.hooks.event({ kind: 'phase', text: `跑了 ${this.stats.missed} 張單，超過今天的上限（${limit} 張）：撐不下去了，8 秒後打烊。`, sound: 'chair' }, 'all');
    }
    if (o.plan.story) {
      this.storyState = 'missed';
      const def = nightDef(this.opts.night ?? 0);
      if (def?.outroMissed) this.hooks.event({ kind: 'story', text: '最後一桌的單燒掉了。', sound: 'chair', story: { night: def.night, title: '最後一桌', text: def.outroMissed, ending: 'missed' } }, 'all');
      return;
    }
    if (announce) this.hooks.event({ kind: 'order_missed', text: `${o.table} 號桌等太久，離開了。`, sound: 'chair' }, 'all');
  }

  /* ---------------------------- 快速操作 ---------------------------- */

  private quick(role: Seat, def: StationDef, s: StationRT, p: KitchenActionPayload, mode: QuickMode): KitchenActionResult {
    const pl = this.players[role];
    const open = this.orders.filter((o) => o.status === 'open');
    const plan = planQuick(mode, def, s, { held: pl.held, other: pl.other, basket: pl.basket, status: pl.status }, open.length);
    if (plan.kind === 'none') return warn(`${plan.label}。`);
    if (plan.kind === 'panel') return info(`${plan.label}：按 E 打開${def.label}。`);
    let args = plan.args ?? {};
    if (plan.action === 'serve') {
      // 出餐：選最適合這盤菜的單（分數最高的那張）
      const held = pl.held?.kind === 'plate' ? pl.held : pl.other?.kind === 'plate' ? pl.other : null;
      const plate = held ? this.plates.get(held.id) : undefined;
      if (!plate) return warn('手上沒有盤子。');
      let best = open[0];
      let bestScore = -Infinity;
      for (const o of open) {
        const sc = scorePlate(plate, o, this.t, role).total;
        if (sc > bestScore) {
          bestScore = sc;
          best = o;
        }
      }
      args = { orderId: best.id };
    }
    if (plan.first) {
      const r = this.dispatch(role, { ...p, action: plan.first.action, args: plan.first.args ?? {} });
      if (!r.ok) return r;
      if (plan.action === 'add') args = { plateId: s.plates[s.plates.length - 1] };
    }
    return this.dispatch(role, { ...p, action: plan.action, args });
  }

  /* ---------------------------- 連續七晚：故事 ---------------------------- */

  /** 營業到一半：出單機印出一張「不是訂單的單」（第七晚是那位客人點餐的時候） */
  private tickStory(): void {
    const def = nightDef(this.opts.night ?? 0);
    if (!def || this.storyShown || this.phase !== 'SERVICE' || def.storyOrder) return;
    if (this.t - this.serviceStart < this.opts.serviceMs * FRAGMENT_AT) return;
    this.storyShown = true;
    this.hooks.event({ kind: 'story', text: `出單機印出了一張不是訂單的單：「${def.fragment.title}」`, sound: 'ticket', at: STATION_BY_ID.pass.pos, story: { night: def.night, ...def.fragment } }, 'all');
  }

  /** 第七晚：那位客人點餐了；點完之後他安靜地坐著等 */
  private onStoryOrder(): void {
    const def = nightDef(this.opts.night ?? 0);
    if (!def?.storyOrder) return;
    this.storyShown = true;
    this.storyState = 'open';
    const g = (this.threats as unknown as { guest?: { active: boolean; enabled: boolean; idx: number; x: number; z: number; yaw: number; calmUntil: number; tune: { startIdx: number } } } | null)?.guest;
    if (g) {
      g.enabled = true;
      g.active = true;
      g.calmUntil = Number.POSITIVE_INFINITY;
    }
    this.hooks.event({ kind: 'story', text: def.storyOrder.text, sound: 'ticket', at: STATION_BY_ID.pass.pos, story: { night: def.night, ...def.fragment } }, 'all');
  }

  /** 第七晚：那位客人的菜送到了。後門的東西離開，他也離開，提早打烊 */
  private onStoryServed(): void {
    const def = nightDef(this.opts.night ?? 0);
    if (!def) return;
    this.storyState = 'served';
    const th = this.threats as unknown as { guest?: { active: boolean; enabled: boolean }; monster?: { banish(): void } } | null;
    th?.monster?.banish();
    if (th?.guest) {
      th.guest.active = false;
      th.guest.enabled = false;
    }
    this.endAt = this.t + 12_000;
    this.hooks.event({ kind: 'story', text: '後門外的敲門聲停了。', sound: 'bell', story: { night: def.night, title: '最後一桌，已結帳', text: def.outro, ending: 'served' } }, 'all');
  }

  private backWasClosed = false;
  private tickDoors(): void {
    if (this.backWasClosed && !this.backClosed) this.hooks.event({ kind: 'fire_door', text: '後門的鎖打開了。', sound: 'door_open', at: [8.9, 25.7] }, 'all');
    this.backWasClosed = this.backClosed;
    if (!this.doors.fire && this.t >= this.fireDoor.closedUntil) {
      this.doors = { ...this.doors, fire: true };
      this.hooks.event({ kind: 'fire_door', text: '防火門打開了。', sound: 'door_open', at: [7.95, 19.15] }, 'all');
    }
  }

  /** 持續性的噪音：大火上的鍋子、滾沸的湯、跑步的腳步 */
  private tickNoise(): void {
    if (Math.round(this.t) % 1000 !== 0) return;
    for (const s of this.stations.values()) {
      if (s.def.kind === 'pan' && s.heat === 'HIGH' && s.items.length) this.noise(s.def.pos[0], s.def.pos[1], NOISE.sizzleHigh, 'sizzle');
      if (s.def.kind === 'stove' && s.liquid > 0 && s.vessel > 99) this.noise(s.def.pos[0], s.def.pos[1], NOISE.boil, 'boil');
    }
    for (const role of SEATS) {
      const pose = this.hooks.pose(role);
      if (pose && pose.speed > 3.2 && this.players[role].status === 'ok') this.noise(pose.x, pose.z, NOISE.run, `run:${role}`);
    }
  }

  noise(x: number, z: number, radius: number, source: string): void {
    if (this.phase === 'SERVICE') this.threats?.noise(x, z, radius, source);
  }

  /* ============================== 工具 ============================== */

  /** 玩家離工作站多遠（從站立點量起） */
  inRange(role: Seat, stationId: string, range = SERVER_INTERACT_RANGE): boolean {
    const pose = this.hooks.pose(role);
    if (!pose) return false;
    if (stationId.startsWith('puddle:')) return this.physics.nearPuddle(role, stationId.slice(7));
    if (stationId === 'guest') {
      const g = this.threats?.guestPos();
      return !!g && Math.hypot(pose.x - g[0], pose.z - g[1]) <= range;
    }
    const s = STATION_BY_ID[stationId];
    if (!s) return false;
    const [fx, fz] = stationFront(s, 0.5);
    return Math.hypot(pose.x - fx, pose.z - fz) <= range;
  }

  /** 能不能操作這個工作站：在正前方的互動距離內，或是缺陷卡允許的遠端操作（嗜睡學徒的雙爐） */
  inReach(role: Seat, stationId: string, range?: number): boolean {
    return this.inRange(role, stationId, range) || this.flaws.remoteReach(role, stationId);
  }

  private snapshot(it: ItemState): PlateComponent {
    return { ...it, seasoning: { ...it.seasoning }, methods: [...it.methods], history: [...it.history] };
  }

  /** 裝盤：拌料展開成每一種食材各自一個成分（記得原本屬於哪一份） */
  private snapshots(it: ItemState): PlateComponent[] {
    return expandMix(it).map((x) => this.snapshot(x));
  }

  private log(it: ItemState, op: string, by: Seat, at?: string, note?: string): void {
    it.history.push({ t: Math.round(this.t), op, by, at, note });
  }

  private heldItem(role: Seat): ItemState | null {
    const h = this.players[role].held;
    return h?.kind === 'item' ? (this.items.get(h.id) ?? null) : null;
  }

  /**
   * 手上空了：菜籃裡有原料就補到手上；菜籃空了、另一隻手有東西，就換成用另一隻手。
   * （所以「放下」之後永遠是拿著下一樣東西的那隻手在用，不用自己切換）
   */
  refillHands(): void {
    for (const r of this.seats) {
      const p = this.players[r];
      while (!p.held && p.basket.length) {
        const id = p.basket.shift()!;
        if (this.items.has(id)) p.held = { kind: 'item', id };
      }
      if (!p.held && p.other) this.swapHands(r);
    }
  }

  /** 單手廚師只有一隻手 */
  hasTwoHands(role: Seat): boolean {
    return this.flaws.flawOf(role) !== 'D09';
  }

  /** 換手：目前的手與另一隻手對調（拿著要用雙手的東西時不能換） */
  swapHands(role: Seat): boolean {
    const p = this.players[role];
    if (!this.hasTwoHands(role) || isTwoHanded(p.held)) return false;
    [p.held, p.other] = [p.other, p.held];
    p.side = p.side === 'R' ? 'L' : 'R';
    return true;
  }

  /** 要拿新的東西：目前的手空著就好；不然把目前的手換成空著的另一隻手。做不到就回傳 false */
  freeHand(role: Seat): boolean {
    const p = this.players[role];
    if (!p.held) return true;
    if (p.other || !this.hasTwoHands(role) || isTwoHanded(p.held)) return false;
    return this.swapHands(role);
  }

  /** 這樣東西接不接得下（要用雙手的東西要兩隻手都空著） */
  canReceive(role: Seat, h: Held): boolean {
    return isTwoHanded(h) ? this.bothHandsFree(role) : this.canFreeHand(role);
  }

  /** 接下一樣東西（先確認 canReceive） */
  receive(role: Seat, h: Held): void {
    if (!isTwoHanded(h)) this.freeHand(role);
    this.players[role].held = h;
  }

  /** 手上（任一隻手）有沒有這樣東西（用序列化比對）；有就拿掉並回傳 */
  takeFromHands(role: Seat, json: string): Held {
    const p = this.players[role];
    if (JSON.stringify(p.held) === json) {
      const h = p.held;
      p.held = null;
      return h;
    }
    if (JSON.stringify(p.other) === json) {
      const h = p.other;
      p.other = null;
      return h;
    }
    return null;
  }

  inHands(role: Seat, json: string): boolean {
    const p = this.players[role];
    return JSON.stringify(p.held) === json || JSON.stringify(p.other) === json;
  }

  /** 不改變狀態地問：能不能空出一隻手 */
  canFreeHand(role: Seat): boolean {
    const p = this.players[role];
    return !p.held || (!p.other && this.hasTwoHands(role) && !isTwoHanded(p.held));
  }

  /** 要用雙手拿（貨箱、一疊髒盤）：兩隻手都要空著 */
  bothHandsFree(role: Seat): boolean {
    const p = this.players[role];
    return !p.held && !p.other;
  }

  /** 這個動作要用手上的某種東西：目前的手不是、另一隻手是，就自動換手 */
  private useHandWith(role: Seat, kinds: ReadonlyArray<NonNullable<Held>['kind']>): void {
    const p = this.players[role];
    if (p.held && kinds.includes(p.held.kind)) return;
    if (p.other && kinds.includes(p.other.kind)) this.swapHands(role);
  }

  /** 手上兩樣、菜籃裡的全部（放回架上、全部放上成品架用）；目前的手排第一 */
  private carriedIds(role: Seat): string[] {
    const p = this.players[role];
    return [...(p.held?.kind === 'item' ? [p.held.id] : []), ...(p.other?.kind === 'item' ? [p.other.id] : []), ...p.basket];
  }

  /** 把某一份從手上或菜籃裡拿掉 */
  private removeCarried(role: Seat, id: string): void {
    const p = this.players[role];
    if (p.held?.kind === 'item' && p.held.id === id) p.held = null;
    else if (p.other?.kind === 'item' && p.other.id === id) p.other = null;
    else p.basket = p.basket.filter((x) => x !== id);
  }

  /** 還放得下幾份新拿的原料 */
  private takeRoom(role: Seat): number {
    const p = this.players[role];
    if (isTwoHanded(p.held) || isTwoHanded(p.other)) return 0;
    const hands = (p.held ? 0 : 1) + (this.hasTwoHands(role) && !p.other ? 1 : 0);
    return hands + Math.max(0, BASKET_SLOTS - p.basket.length);
  }

  /** 把一份新拿的原料放到：目前的手 → 另一隻手 → 菜籃 */
  private stow(role: Seat, id: string): 'hand' | 'other' | 'basket' {
    const p = this.players[role];
    if (!p.held) {
      p.held = { kind: 'item', id };
      return 'hand';
    }
    if (!p.other && this.hasTwoHands(role)) {
      p.other = { kind: 'item', id };
      return 'other';
    }
    p.basket.push(id);
    return 'basket';
  }

  /** 還沒處理過的原料（可以放進菜籃、放回架上） */
  private untouched(it: ItemState): boolean {
    return it.cut === 'WHOLE' && !it.washed && !it.peeled && it.doneness <= 0.05 && !it.methods.length && !it.floorDirty && !it.mix && !it.soaked;
  }

  /** 這位玩家帶著幾樣（兩隻手＋菜籃） */
  carried(role: Seat): number {
    const p = this.players[role];
    return (p.held ? 1 : 0) + (p.other ? 1 : 0) + p.basket.length;
  }

  private removeFromStations(itemId: string): void {
    for (const s of this.stations.values()) {
      const i = s.items.indexOf(itemId);
      if (i >= 0) s.items.splice(i, 1);
    }
  }

  /* ============================== 操作 ============================== */

  handle(role: Seat, p: KitchenActionPayload): KitchenActionResult {
    const pl = this.players[role];
    const cached = pl.cache.get(p.requestId);
    if (cached) return cached;
    this.flaws.touched(role);
    const res = this.dispatch(role, p);
    this.refillHands();
    pl.cache.set(p.requestId, res);
    if (pl.cache.size > 64) pl.cache.delete(pl.cache.keys().next().value!);
    this.recent.push({ at: this.t, role, stationId: p.stationId, action: p.action, ok: res.ok, message: res.message });
    if (this.recent.length > 40) this.recent.shift();
    return res;
  }

  private dispatch(role: Seat, p: KitchenActionPayload): KitchenActionResult {
    if (this.phase === 'CLOSED') return warn('已經打烊了。');
    const pl = this.players[role];
    const args = p.args ?? {};
    // 教學關：玩家確認（讀完說明、打開了訂單板／食譜）
    if (p.stationId === 'tutorial') return this.tutorial ? this.tutorial.ack(this, p) : warn('沒有這個動作。');
    // 互助操作：由缺陷卡系統判定（它自己檢查距離、狀態與冷卻）
    if (p.stationId === 'coop' && (p.action === 'toss' || p.action === 'mop')) {
      if (pl.status !== 'ok') return warn('現在不行。');
      if (pl.task) return warn('你正在忙。');
      if (this.physics.frozen(role)) return warn('你還沒爬起來。');
      if (p.action === 'toss') return this.physics.toss(role, typeof args.to === 'string' ? (args.to as Seat) : null);
      const pose = this.hooks.pose(role);
      const pud = pose ? this.physics.puddleNear(pose.x, pose.z) : null;
      if (!pud) return warn('附近地上沒有積水。');
      return this.startTask(role, 'mop', `puddle:${pud.id}`, pud.id, PHYSICS.puddle.mopMs);
    }
    if (p.stationId === 'coop') return this.flaws.handle(role, p.action, args);
    if (pl.status === 'trapped') {
      if (p.stationId === 'cage' && p.action === 'struggle') return this.struggle(role);
      if (p.stationId === 'cage' && p.action === 'cancel' && pl.task?.kind === 'struggle') {
        pl.task = null;
        return info('停下來，不搖了。');
      }
      return warn(this.canBeRescued(role) ? '你被關在鐵籠裡：等隊友來撬開，或按 E 自己掙脫（比較慢、很吵）。' : '你被關在鐵籠裡，沒有隊友能來救：按 E 自己掙脫。');
    }
    if (pl.status === 'hidden' && !(p.action === 'leave')) return warn('你躲在置物櫃裡。');
    if (this.flaws.asleep(role)) return warn('你睡著了……（隊友拍肩可以叫醒你）');
    if (pl.task && p.action !== 'cancel') return warn('你正在忙。');
    if (p.action === 'cancel') {
      pl.task = null;
      return info('停下手邊的動作。');
    }
    if (p.stationId === 'guest') {
      if (p.action !== 'escort' || !this.threats) return warn('沒有這個動作。');
      if (!this.inRange(role, 'guest', 1.9)) return warn('離他太遠了。');
      if (!this.threats.canEscort()) return warn('他沒有在等你帶位。');
      return this.startTask(role, 'escort', 'guest');
    }
    if (p.stationId === 'self') {
      if (p.action !== 'swap') return warn('沒有這個動作。');
      if (!this.hasTwoHands(role)) return info('你只有一隻手。');
      if (isTwoHanded(pl.held)) return warn('你雙手拿著東西，不能換手。');
      if (!pl.held && !pl.other) return info('兩隻手都是空的。');
      if (!pl.held || !pl.other) return info('另一隻手是空的（放下手上的東西後，會自動改用拿著東西的那隻手）。');
      this.swapHands(role);
      return ok(`換成${HAND_LABEL[pl.side]}：${pl.held ? this.describeHeld(pl.held) : '空著'}。`);
    }
    const def = STATION_BY_ID[p.stationId];
    if (!def) return warn('找不到這個工作站。');
    if (!roleCanUseStation(role, def)) return warn('這不是你能操作的設備。');
    if (!this.inReach(role, def.id)) return warn('離工作站太遠了。');
    const s = this.stations.get(def.id)!;
    // 快速操作（滑鼠左鍵＝拿／放，右鍵＝使用）：判斷要做什麼，再照一般的動作執行
    if (p.action === 'quick') return this.quick(role, def, s, p, args.mode === 'use' ? 'use' : 'primary');
    // 這個動作要用的東西在另一隻手：自動換手（例如左手拿盤子、右手拿洋蔥，按「放上砧板」就用右手）
    const want = HAND_NEED[`${def.kind}:${p.action}`] ?? HAND_NEED[`*:${p.action}`];
    if (want) this.useHandWith(role, want);
    // 缺陷卡的限制（怕火、潔癖、幽閉…）：由 FlawSystem 判定；可能擋下，或改成一個計時動作
    const gate = this.flaws.gate(role, def, p.action, args, s);
    if (gate) {
      if ('task' in gate) return this.startTask(role, gate.task, def.id, gate.arg, gate.ms);
      return gate;
    }
    this.flaws.onWork(role, def, p.action);

    switch (def.kind) {
      case 'fridge':
      case 'pantry':
        return this.actStorage(role, s, p.action, args);
      case 'sink':
        return this.actSink(role, s, p.action, args);
      case 'prep':
        return this.actPrep(role, s, p.action, args);
      case 'pan':
      case 'stove':
        return this.actHeat(role, s, p.action, args);
      case 'toaster':
        return this.actToaster(role, s, p.action, args);
      case 'spice':
        return this.actSpice(role, p.action, args);
      case 'plating':
        return this.actPlating(role, s, p.action, args);
      case 'pass':
        return this.actPass(role, p.action, args);
      case 'trash':
        return this.actTrash(role, p.action);
      case 'cctv':
        return this.actCctv(role, p.action, args);
      case 'locker':
        return this.actLocker(role, s, p.action);
      case 'cage':
        return this.actCage(role, s, p.action, args);
      case 'delivery':
        return this.actDelivery(role, s, p.action);
      case 'dishes':
        return this.actDishes(role, s, p.action);
      case 'shelf':
        return this.actShelf(role, s, p.action, args);
      case 'rack':
        return this.actRack(role, s, p.action, args);
      case 'oven':
        return this.actOven(role, s, p.action, args);
      case 'mixer':
        return this.actMixer(role, s, p.action, args);
    }
  }

  private startTask(role: Seat, kind: TaskKind, stationId: string, arg?: string, baseMs?: number): KitchenActionResult {
    const ms = this.flaws.taskMs(role, kind, baseMs ?? TASK_MS[kind]);
    this.players[role].task = { kind, stationId, startedAt: this.t, endsAt: this.t + ms, arg };
    return info(`${TASK_LABEL[kind]}中…（${Math.round(ms / 100) / 10} 秒，離開就會中斷）`);
  }

  private completeTask(role: Seat, task: Task): string | null {
    const s = this.stations.get(task.stationId);
    const item = s && task.arg ? this.items.get(task.arg) : s?.items[0] ? this.items.get(s.items[0]) : undefined;
    switch (task.kind) {
      case 'wash':
        if (!item || !s?.items.includes(item.id)) return null;
        item.washed = true;
        if (item.floorDirty) {
          item.floorDirty = false;
          this.log(item, 'wash', role, s.def.id, '掉在地上過，重新洗乾淨');
        } else this.log(item, 'wash', role, s.def.id);
        this.flaws.onPrepWork(role);
        return `${INGREDIENTS[item.type].label}洗好了。`;
      case 'peel':
        if (!item || !s?.items.includes(item.id)) return null;
        item.peeled = true;
        this.log(item, 'peel', role, s.def.id);
        this.flaws.onPrepWork(role);
        return `${INGREDIENTS[item.type].label}削好皮了。`;
      case 'wipe':
        if (!s) return null;
        s.contaminated = false;
        this.flaws.onPrepWork(role);
        return '砧板擦乾淨了。';
      case 'probe': {
        if (!s) return null;
        const list = s.items.map((id) => this.items.get(id)).filter((x): x is ItemState => !!x);
        const text = list.length ? list.map((x) => `${INGREDIENTS[x.type].label} ${Math.round(x.temp)}°C`).join('、') : '鍋裡沒有東西';
        this.hooks.event({ kind: 'phase', text: `溫度計：${text}` }, role);
        return null;
      }
      case 'struggle': {
        if (this.players[role].status !== 'trapped') return null;
        this.release(role);
        this.stats.escaped++;
        this.noise(...cagePos(), STRUGGLE.noiseRadius, 'cage');
        this.hooks.event({ kind: 'rescued', text: `${this.name(role)}自己掙脫了鐵籠。`, sound: 'cage_open', at: STATION_BY_ID.cage.pos }, 'all');
        return '你扯開了鐵籠的門。快離開冷藏室。';
      }
      case 'rescue': {
        const who = task.arg as Seat | undefined;
        if (!who || this.players[who].status !== 'trapped') return null;
        this.release(who);
        this.stats.rescued++;
        this.hooks.event({ kind: 'rescued', text: `${this.name(who)}被救出來了。`, sound: 'cage_open', at: STATION_BY_ID.cage.pos }, 'all');
        return null;
      }
      case 'escort':
        this.threats?.escort(role, this);
        return '他站起來，安靜地走回最遠的座位。';
      case 'verify':
        return task.arg ? this.flaws.completeVerify(role, task.arg) : null;
      case 'clamp':
        return this.flaws.setClamp(role, task.stationId);
      case 'glove':
        return this.flaws.setGlove(role);
      case 'peek':
        return this.flaws.setPeek(role, task.stationId);
      case 'splash':
        return this.flaws.splash(role);
      case 'pedal':
        return this.discardHeld(role).message;
      case 'tray':
        return this.takeDirty(role, true).message;
      case 'stool':
        return s && task.arg ? this.takeHigh(role, s, task.arg as IngredientId).message : null;
      case 'mix':
        return s ? this.finishMix(role, s) : null;
      case 'mop':
        return task.arg && this.physics.removePuddle(task.arg) ? '地上擦乾了。' : null;
      case 'dishes': {
        if (!s) return null;
        const n = s.dirty.plate + s.dirty.bowl;
        if (!n) return null;
        const plating = this.stations.get('plating')!;
        plating.dishes.plate += s.dirty.plate;
        plating.dishes.bowl += s.dirty.bowl;
        s.dirty = { plate: 0, bowl: 0 };
        this.flaws.onCleaned(role, n);
        return `洗好 ${n} 個碗盤，放回裝盤區的架上。`;
      }
    }
  }

  /* ---------------------------- 冷藏架／乾貨架 ---------------------------- */

  private actStorage(role: Seat, s: StationRT, action: string, args: Record<string, unknown>): KitchenActionResult {
    const pl = this.players[role];
    const storage: Storage = s.def.kind === 'fridge' ? 'FRIDGE' : 'PANTRY';
    if (action === 'take') {
      const type = args.type as IngredientId;
      const def = INGREDIENTS[type];
      if (!def || def.storage !== storage) return warn('這裡沒有這種食材。');
      // 一次可以拿好幾份：先放空著的手，再放另一隻手，其他放菜籃（菜籃只放原料，2 格）
      const room = this.takeRoom(role);
      if (room <= 0) return warn(isTwoHanded(pl.held) ? '你雙手拿著東西，先放下。' : `手和菜籃都滿了（兩隻手＋菜籃 ${BASKET_SLOTS} 格）。先放到備料台或成品架。`);
      const stock = s.stock[type] ?? 0;
      if (stock <= 0) return warn(`${def.label}沒有了。等後門送貨，或改做別的。`);
      const want = Math.max(1, Math.min(CARRY_MAX, Math.floor(Number(args.count) || 1)));
      const n = Math.min(want, room, stock);
      s.stock[type] = stock - n;
      const where: string[] = [];
      for (let i = 0; i < n; i++) {
        const it = newItem(this.id('i'), type, this.t);
        it.history[0].by = role;
        it.history[0].at = s.def.id;
        this.items.set(it.id, it);
        where.push(this.stow(role, it.id));
      }
      const short = n < want ? (stock < want ? `（架上只剩 ${stock} ${def.unit}）` : '（手和菜籃放不下更多）') : '';
      const count = (w: string) => where.filter((x) => x === w).length;
      const parts = [count('hand') ? `${HAND_LABEL[pl.side]}` : '', count('other') ? HAND_LABEL[pl.side === 'R' ? 'L' : 'R'] : '', count('basket') ? `菜籃 ${count('basket')}` : ''].filter(Boolean);
      return ok(`拿了 ${n} ${def.unit}${def.label}${short}${n > 1 || where[0] !== 'hand' ? `：${parts.join('、')}` : ''}。`);
    }
    if (action === 'store_all') {
      // 手上與菜籃裡、屬於這個架子的原料全部放回去
      const ids = this.carriedIds(role);
      let n = 0;
      for (const id of ids) {
        const it = this.items.get(id);
        if (!it || INGREDIENTS[it.type].storage !== storage || !this.untouched(it)) continue;
        s.stock[it.type] = (s.stock[it.type] ?? 0) + 1;
        this.items.delete(id);
        this.removeCarried(role, id);
        n++;
      }
      return n ? ok(`放回 ${n} 份食材。`) : warn('沒有可以放回這裡的原料。');
    }
    if (action === 'take_high') {
      const type = args.type as IngredientId;
      const def = INGREDIENTS[type];
      if (!def || def.storage !== storage) return warn('這裡沒有這種食材。');
      if (!this.canFreeHand(role)) return warn('兩隻手都拿著東西，先放下一樣。');
      if ((s.high[type] ?? 0) <= 0) return warn(`最上層沒有${def.label}了。`);
      // 一般人要踩踏凳（計時動作）；巨人與小矮人由 gate 處理
      return this.startTask(role, 'stool', s.def.id, type, this.flaws.cfg.common.stoolMs);
    }
    if (action === 'restock') {
      if (pl.held?.kind !== 'crate' || pl.held.storage !== storage) return warn('手上沒有這裡的貨。');
      for (const id of INGREDIENT_IDS) if (INGREDIENTS[id].storage === storage) s.stock[id] = (s.stock[id] ?? 0) + 4;
      pl.held = null;
      return ok('補好貨了。');
    }
    if (action === 'store') {
      const it = this.heldItem(role);
      if (!it) return warn('手上沒有食材。');
      if (INGREDIENTS[it.type].storage !== storage || it.cut !== 'WHOLE' || it.doneness > 0.05 || it.methods.length || it.mix) {
        return warn('只能放回還沒處理過的原料。');
      }
      s.stock[it.type] = (s.stock[it.type] ?? 0) + 1;
      this.items.delete(it.id);
      pl.held = null;
      return ok(`把${INGREDIENTS[it.type].label}放回去。`);
    }
    return warn('沒有這個動作。');
  }

  /* ---------------------------- 放下／拿起（共用） ---------------------------- */

  private place(role: Seat, s: StationRT, allow?: (it: ItemState) => string | null): KitchenActionResult {
    const it = this.heldItem(role);
    if (!it) return warn('手上沒有食材。');
    const cap = CAPACITY[s.def.kind] ?? 1;
    if (s.items.length >= cap) return warn('這裡放不下了。');
    const bad = allow?.(it);
    if (bad) return warn(bad);
    s.items.push(it.id);
    this.players[role].held = null;
    this.log(it, `place:${s.def.id}`, role, s.def.id, s.def.label);
    this.noise(s.def.pos[0], s.def.pos[1], NOISE.clang, 'clang');
    return ok(`把${INGREDIENTS[it.type].label}放到${s.def.label}。`);
  }

  private pick(role: Seat, s: StationRT, args: Record<string, unknown>): KitchenActionResult {
    const pl = this.players[role];
    if (!this.freeHand(role)) return warn('兩隻手都拿著東西，先放下一樣。');
    const id = typeof args.itemId === 'string' && s.items.includes(args.itemId) ? args.itemId : s.items[s.items.length - 1];
    if (!id) return warn('這裡沒有東西。');
    s.items.splice(s.items.indexOf(id), 1);
    pl.held = { kind: 'item', id };
    const it = this.items.get(id)!;
    return ok(`拿起${INGREDIENTS[it.type].label}。`);
  }

  /* ---------------------------- 清洗區 ---------------------------- */

  private actSink(role: Seat, s: StationRT, action: string, args: Record<string, unknown>): KitchenActionResult {
    if (action === 'place') return this.place(role, s, (it) => (it.methods.length ? '煮過的東西不能拿來洗。' : it.mix ? '拌好的東西不能拿來洗。' : null));
    if (action === 'pick') {
      const r = this.pick(role, s, args);
      if (r.ok && !s.items.some((id) => INGREDIENTS[this.items.get(id)?.type ?? 'egg'].soakable)) s.soak = false;
      return r;
    }
    if (action === 'wash') {
      const pickId = typeof args.itemId === 'string' && s.items.includes(args.itemId) ? args.itemId : undefined;
      const list = s.items.map((id) => this.items.get(id)).filter((x): x is ItemState => !!x);
      const it = pickId ? this.items.get(pickId)! : (list.find((x) => !x.washed || x.floorDirty) ?? list[0]);
      if (!it) return warn('水槽裡沒有東西。');
      if (it.washed && !it.floorDirty) return info('已經洗過了。');
      return this.startTask(role, 'wash', s.def.id, it.id);
    }
    if (action === 'soak') {
      const target = s.items.map((id) => this.items.get(id)).find((x) => x && INGREDIENTS[x.type].soakable);
      if (!target) return warn('水槽裡沒有需要泡水的東西（米粉要先泡軟才能炒）。');
      if (s.soak) return info(`正在泡：${soakLabel(target.soaked) ?? '剛放水'}。`);
      s.soak = true;
      this.log(target, 'soak', role, s.def.id);
      return ok(`放水泡${INGREDIENTS[target.type].label}：大約 ${SOAK_SEC} 秒泡軟，泡太久會爛。`);
    }
    if (action === 'water') {
      // 接一杯水（煮飯、煮麵、調麵糊）
      if (!this.freeHand(role)) return warn('兩隻手都拿著東西，先放下一樣。');
      const it = newItem(this.id('i'), 'water', this.t);
      it.temp = ROOM_TEMP;
      it.maxTemp = ROOM_TEMP;
      it.history[0].by = role;
      it.history[0].at = s.def.id;
      this.items.set(it.id, it);
      this.players[role].held = { kind: 'item', id: it.id };
      return ok('接了一杯水。');
    }
    if (action === 'load') {
      const pl = this.players[role];
      if (pl.held?.kind !== 'dirty') return warn('手上沒有髒盤。');
      s.dirty.plate += pl.held.plate;
      s.dirty.bowl += pl.held.bowl;
      const n = pl.held.plate + pl.held.bowl;
      pl.held = null;
      this.noise(s.def.pos[0], s.def.pos[1], NOISE.clang, 'clang');
      return ok(`把 ${n} 個髒盤放上碗盤架。`);
    }
    if (action === 'wash_dishes') {
      const n = s.dirty.plate + s.dirty.bowl;
      if (!n) return warn('碗盤架上沒有髒盤（先把回收窗口的髒盤拿過來）。');
      return this.startTask(role, 'dishes', s.def.id, undefined, Math.max(TASK_MS.dishes, n * DISH_WASH_MS_EACH));
    }
    return warn('沒有這個動作。');
  }

  /* ---------------------------- 備料台 ---------------------------- */

  private actPrep(role: Seat, s: StationRT, action: string, args: Record<string, unknown>): KitchenActionResult {
    const it = s.items[0] ? this.items.get(s.items[0]) : null;
    switch (action) {
      case 'place':
        return this.place(role, s, (x) => (x.methods.length ? '煮過的東西不在這裡處理。' : x.mix ? '拌好的東西不能再切。' : INGREDIENTS[x.type].liquid ? '液體不用放砧板。' : null));
      case 'pick':
        s.chop = null;
        return this.pick(role, s, args);
      case 'peel':
        if (!it) return warn('砧板上沒有東西。');
        if (!INGREDIENTS[it.type].needsPeel) return warn(`${INGREDIENTS[it.type].label}不用削皮。`);
        if (it.peeled) return info('已經削好皮了。');
        return this.startTask(role, 'peel', s.def.id, it.id);
      case 'wipe':
        return this.startTask(role, 'wipe', s.def.id);
      case 'clamp':
        return this.startTask(role, 'clamp', s.def.id, undefined, this.flaws.cfg.D09.clampMs);
      case 'chop_start': {
        if (!it) return warn('砧板上沒有東西。');
        const cut = args.cut as Cut;
        const def = INGREDIENTS[it.type];
        if (!def.cuts.includes(cut) || cut === 'WHOLE') return warn(`${def.label}不能${CUT_LABEL[cut] ?? '這樣切'}。`);
        if (it.cut !== 'WHOLE') return warn(`已經${CUT_LABEL[it.cut]}過了。`);
        if (def.needsPeel && !it.peeled) return warn(`${def.label}要先削皮。`);
        if (cut === 'BEATEN') {
          const hands = this.flaws.twoHanded(role, s.def.id, '打蛋');
          if (hands) return hands;
        }
        const need = this.flaws.chopStrokes(role, cut, CUT_STROKES[cut]);
        s.chop = { role, cut, startedAt: this.t, need };
        return info(`開始${CUT_LABEL[cut]}：照著節奏下刀 ${need} 次。`, { need });
      }
      case 'chop': {
        if (!it || !s.chop || s.chop.role !== role) return warn('先選切法。');
        const presses = Array.isArray(args.presses) ? (args.presses as unknown[]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : [];
        const need = s.chop.need;
        if (presses.length < need) return warn(`還差 ${need - presses.length} 刀。`);
        const span = presses[presses.length - 1] - presses[0];
        if (span > this.t - s.chop.startedAt + 400) return warn('節奏紀錄不正確，請重新切。');
        const q = cutQuality(presses.slice(0, need + 2));
        const cut = s.chop.cut;
        s.chop = null;
        it.cut = cut;
        it.cutQuality = q;
        this.log(it, `chop:${cut}`, role, s.def.id, `一致性 ${Math.round(q * 100)}%`);
        const def = INGREDIENTS[it.type];
        if (def.contaminates && it.doneness < 0.05) s.contaminated = true;
        else if (s.contaminated && !isRawProtein(def)) {
          it.contaminated = true;
          this.log(it, 'contaminated', role, s.def.id);
        }
        this.noise(s.def.pos[0], s.def.pos[1], NOISE.chop, 'chop');
        this.flaws.onPrepWork(role);
        return ok(`${def.label}${CUT_LABEL[cut]}完成（一致性 ${Math.round(q * 100)}%）。`);
      }
    }
    return warn('沒有這個動作。');
  }

  /* ---------------------------- 爐台（平底鍋、湯鍋） ---------------------------- */

  private actHeat(role: Seat, s: StationRT, action: string, args: Record<string, unknown>): KitchenActionResult {
    const isPot = s.def.kind === 'stove';
    switch (action) {
      case 'heat': {
        const level = args.level as HeatLevel;
        if (!HEAT_LEVELS.includes(level)) return warn('沒有這個火力。');
        s.heat = level;
        return ok(`${s.def.label}：${HEAT_LABEL[level]}。`);
      }
      case 'place':
        return this.place(role, s, (it) => {
          if (it.type === 'bread' && !it.mix) return '吐司請用烤麵包機（或烤箱）。';
          if (!isPot && INGREDIENTS[it.type].liquid) return `${INGREDIENTS[it.type].label}要倒進湯鍋。`;
          if (isPot && INGREDIENTS[it.type].liquid) {
            // 倒入冷的液體會讓鍋溫下降（同一個混合模型）
            s.vessel = (s.vessel + it.temp * 0.5 * it.qty) / (1 + 0.5 * it.qty);
            s.liquid += it.qty;
          }
          return null;
        });
      case 'pick': {
        if (isPot) {
          // 撈起來：煮好的麵、飯、燙過的菜可以撈出來（湯留在鍋裡；整鍋要用碗盛）
          const solids = s.items.filter((id) => {
            const it = this.items.get(id);
            return it && !INGREDIENTS[it.type].liquid;
          });
          const id = typeof args.itemId === 'string' && solids.includes(args.itemId) ? args.itemId : solids[solids.length - 1];
          if (!id) return warn('湯鍋裡沒有可以撈的東西（湯要用碗盛：拿著碗按「盛起來」）。');
          if (!this.freeHand(role)) return warn('兩隻手都拿著東西，先放下一樣。');
          s.items.splice(s.items.indexOf(id), 1);
          this.players[role].held = { kind: 'item', id };
          const it = this.items.get(id)!;
          this.log(it, 'scoop', role, s.def.id);
          return ok(`把${INGREDIENTS[it.type].label}撈起來。`);
        }
        return this.pick(role, s, args);
      }
      case 'flip': {
        if (isPot) return warn('湯鍋用攪拌。');
        const ids = typeof args.itemId === 'string' ? [args.itemId] : s.items;
        let n = 0;
        for (const id of ids) {
          const it = this.items.get(id);
          if (!it || !s.items.includes(id)) continue;
          flipItem(it);
          this.log(it, 'flip', role, s.def.id);
          n++;
        }
        return n ? ok('翻面。') : warn('鍋裡沒有東西。');
      }
      case 'stir': {
        if (!isPot) return warn('平底鍋用翻面。');
        s.lastStir = this.t;
        return ok('攪拌。');
      }
      case 'pour':
        return this.pourInto(role, (seasoning, units) => {
          if (isPot) {
            if (!s.items.length) return '鍋裡還沒有東西。';
            s.seasoning[seasoning] = (s.seasoning[seasoning] ?? 0) + units;
            return null;
          }
          const list = s.items.map((id) => this.items.get(id)).filter((x): x is ItemState => !!x);
          if (!list.length) return '鍋裡沒有東西。';
          for (const it of list) {
            it.seasoning[seasoning] = (it.seasoning[seasoning] ?? 0) + units / list.length;
            this.log(it, `season:${seasoning}`, role, s.def.id, r2(units / list.length).toString());
          }
          return null;
        });
      case 'clamp':
        return this.startTask(role, 'clamp', s.def.id, undefined, this.flaws.cfg.D09.clampMs);
      case 'glove':
        return this.startTask(role, 'glove', s.def.id, undefined, this.flaws.cfg.D10.gloveMs);
      case 'peek':
        if (!isPot) return warn('平底鍋看得到。');
        return this.startTask(role, 'peek', s.def.id, undefined, this.flaws.cfg.D08.peekMs);
      case 'ladle': {
        if (!isPot) return warn('只有湯鍋可以盛。');
        const pl = this.players[role];
        if (pl.held?.kind !== 'plate') return warn('先拿一個碗。');
        const plate = this.plates.get(pl.held.id)!;
        if (!s.items.length) return warn('鍋裡沒有東西。');
        const hands = this.flaws.twoHanded(role, s.def.id, '盛湯');
        if (hands) return hands;
        for (const id of s.items) {
          const it = this.items.get(id);
          if (!it) continue;
          this.log(it, 'ladle', role, s.def.id);
          plate.components.push(...this.snapshots(it));
          this.items.delete(id);
        }
        for (const [k, v] of Object.entries(s.seasoning) as Array<[SeasoningId, number]>) plate.seasoning[k] = (plate.seasoning[k] ?? 0) + v;
        plate.liquid = r1((plate.liquid ?? 0) + s.liquid);
        const scorched = s.scorch >= 1;
        s.items = [];
        s.seasoning = {};
        s.liquid = 0;
        s.scorch = 0;
        return ok(scorched ? '盛起來了（鍋底有焦味）。' : '盛起來了。');
      }
      case 'probe':
        if (!s.items.length) return warn('鍋裡沒有東西。');
        if (this.probeBroken) return warn(PROBE_BROKEN);
        return this.startTask(role, 'probe', s.def.id);
      case 'taste': {
        if (!isPot) return warn('平底鍋的東西裝盤後再試吃。');
        const list = s.items.map((id) => this.items.get(id)).filter((x): x is ItemState => !!x).flatMap((x) => expandMix(x));
        if (!list.length) return warn('鍋裡沒有東西。');
        const t = dishTaste(list, s.seasoning);
        const words = FLAVOR_DIMS.filter((d) => t[d] >= 0.4).map((d: FlavorDim) => `${FLAVOR_LABEL[d]}${tasteWord(t[d])}`);
        const seasoned = Object.values(s.seasoning).some((v) => (v ?? 0) > 0) || list.some((it) => Object.values(it.seasoning).some((v) => (v ?? 0) > 0));
        const guess = dishGuess(analyzeDish({ vessel: 'bowl', components: list, seasoning: s.seasoning, liquid: s.liquid }));
        return info(`${this.flaws.onTaste(role, s.def.id, this.tasteFingerprint(s.def.id), s.def.label, words, seasoned)}　${guess}`);
      }
    }
    return warn('沒有這個動作。');
  }

  /* ---------------------------- 烤箱 ---------------------------- */

  private actOven(role: Seat, s: StationRT, action: string, args: Record<string, unknown>): KitchenActionResult {
    switch (action) {
      case 'heat': {
        const level = args.level as HeatLevel;
        if (!HEAT_LEVELS.includes(level)) return warn('沒有這個溫度。');
        if (s.heat !== level) s.preheatNoted = false;
        s.heat = level;
        if (level === 'OFF') return ok('烤箱關掉了（裡面還熱，會慢慢降溫）。');
        const ready = s.vessel >= OVEN_TARGET[level] - 5;
        if (ready) s.preheatNoted = true;
        return ok(`烤箱設定 ${OVEN_TARGET[level]}°C${ready ? '。' : `：預熱中（現在大約 ${Math.round(s.vessel)}°C）。預熱好了會通知。`}`);
      }
      case 'place':
        return this.place(role, s, (it) => (INGREDIENTS[it.type].liquid ? `${INGREDIENTS[it.type].label}不能直接放進烤箱。` : null));
      case 'pick':
        return this.pick(role, s, args);
      case 'probe':
        if (!s.items.length) return warn('烤箱裡沒有東西。');
        if (this.probeBroken) return warn(PROBE_BROKEN);
        return this.startTask(role, 'probe', s.def.id);
      case 'glove':
        return this.startTask(role, 'glove', s.def.id, undefined, this.flaws.cfg.D10.gloveMs);
    }
    return warn('沒有這個動作。');
  }

  /* ---------------------------- 攪拌碗 ---------------------------- */

  private actMixer(role: Seat, s: StationRT, action: string, args: Record<string, unknown>): KitchenActionResult {
    switch (action) {
      case 'place':
        return this.place(role, s, (it) => (it.floorDirty ? '掉在地上過，先去洗。' : null));
      case 'pick':
        return this.pick(role, s, args);
      case 'mix': {
        const list = s.items.map((id) => this.items.get(id)).filter((x): x is ItemState => !!x);
        if (list.length < 2) return warn('碗裡至少要有兩樣東西才能拌。');
        const flat = list.flatMap((x) => (x.mix ? [x, ...x.mix.parts] : [x]));
        const kind = mixKindOf(flat);
        if (!kind) return warn('碗裡全是液體：直接倒進湯鍋就好。');
        return this.startTask(role, 'mix', s.def.id);
      }
    }
    return warn('沒有這個動作。');
  }

  /** 攪拌完成：碗裡的東西合成一份（主體＋拌進去的食材） */
  private finishMix(role: Seat, s: StationRT): string | null {
    const list = s.items.map((id) => this.items.get(id)).filter((x): x is ItemState => !!x);
    if (list.length < 2) return null;
    // 已經拌過的拌料再拌：先攤平
    const flat: ItemState[] = [];
    for (const it of list) {
      if (it.mix) {
        const { mix, ...lead } = it;
        flat.push(lead as ItemState, ...mix.parts.map((p) => ({ ...p, history: [] }) as ItemState));
      } else flat.push(it);
    }
    const kind = mixKindOf(flat);
    const lead = kind ? pickMixLead(flat, kind) : null;
    if (!kind || !lead) return null;
    const parts = flat.filter((x) => x !== lead).map(({ history: _h, mix: _m, ...rest }) => ({ ...rest, seasoning: { ...rest.seasoning }, methods: [...rest.methods] }));
    const merged: ItemState = { ...lead, history: [...(this.items.get(lead.id)?.history ?? lead.history)] };
    merged.mix = { kind, parts, at: { doneness: lead.doneness, brownA: lead.brownA, brownB: lead.brownB, cookSec: lead.cookSec ? { ...lead.cookSec } : undefined } };
    for (const it of list) this.items.delete(it.id);
    this.items.set(merged.id, merged);
    s.items = [merged.id];
    const names = flat.map((x) => INGREDIENTS[x.type].label);
    this.log(merged, `mix:${kind}`, role, s.def.id, names.join('＋'));
    return `拌好了：${MIX_LABEL[kind]}（${names.join('、')}）。`;
  }

  /* ---------------------------- 烤麵包機 ---------------------------- */

  private actToaster(role: Seat, s: StationRT, action: string, args: Record<string, unknown>): KitchenActionResult {
    switch (action) {
      case 'glove':
        return this.startTask(role, 'glove', s.def.id, undefined, this.flaws.cfg.D10.gloveMs);
      case 'place':
        if (s.toast) return warn('正在烤。');
        return this.place(role, s, (it) => (it.type !== 'bread' ? '烤麵包機只能放吐司。' : null));
      case 'pick':
        if (s.toast) return warn('還在烤，等它跳起來。');
        return this.pick(role, s, args);
      case 'start': {
        const level = Math.round(Number(args.level));
        if (!(level >= 1 && level <= 5)) return warn('段數是 1 到 5。');
        if (!s.items.length) return warn('裡面沒有吐司。');
        if (s.toast) return warn('正在烤。');
        s.toast = { level, endsAt: this.t + TOAST_SEC * 1000 };
        for (const id of s.items) {
          const it = this.items.get(id);
          if (it) this.log(it, `toast:${level}`, role, s.def.id);
        }
        return ok(`烤麵包機 ${level} 段，${TOAST_SEC} 秒後跳起來。`);
      }
    }
    return warn('沒有這個動作。');
  }

  /* ---------------------------- 調味區 ---------------------------- */

  private actSpice(role: Seat, action: string, args: Record<string, unknown>): KitchenActionResult {
    if (action !== 'measure') return warn('沒有這個動作。');
    const pl = this.players[role];
    const seasoning = args.seasoning as SeasoningId;
    const units = Number(args.units);
    if (!SEASONINGS[seasoning]) return warn('沒有這種調味料。');
    if (!(MEASURE_STEPS as readonly number[]).includes(units)) return warn('量匙只有 0.5、1、1.5、2。');
    if (!this.freeHand(role)) return warn('兩隻手都拿著東西，先放下一樣。');
    // 怕火廚師：一次量兩種（冷盤組合）
    if (args.seasoning2 !== undefined) {
      if (!this.flaws.has(role, 'D10')) return warn('一次只能量一種。');
      const s2 = args.seasoning2 as SeasoningId;
      const u2 = Number(args.units2);
      if (!SEASONINGS[s2] || s2 === seasoning) return warn('第二種調味料不對。');
      if (!(MEASURE_STEPS as readonly number[]).includes(u2)) return warn('量匙只有 0.5、1、1.5、2。');
      pl.held = { kind: 'measure', seasoning, units, extra: { seasoning: s2, units: u2 } };
      this.flaws.advantage(role, '一次量兩種調味料');
      return ok(`量了${SEASONINGS[seasoning].label} ${units}＋${SEASONINGS[s2].label} ${u2}。一次倒完。`);
    }
    pl.held = { kind: 'measure', seasoning, units };
    return ok(`量了${SEASONINGS[seasoning].label} ${units}。拿去倒進鍋裡或盤子上。`);
  }

  private pourInto(role: Seat, apply: (s: SeasoningId, units: number) => string | null): KitchenActionResult {
    const pl = this.players[role];
    if (pl.held?.kind !== 'measure') return warn('手上沒有量好的調味料（去調味區量）。');
    const { seasoning, units, extra } = pl.held;
    const bad = apply(seasoning, units);
    if (bad) return warn(bad);
    if (extra) apply(extra.seasoning, extra.units);
    pl.held = null;
    return ok(`加了${SEASONINGS[seasoning].label} ${units}${extra ? `、${SEASONINGS[extra.seasoning].label} ${extra.units}` : ''}。`);
  }

  /* ---------------------------- 裝盤區 ---------------------------- */

  private actPlating(role: Seat, s: StationRT, action: string, args: Record<string, unknown>): KitchenActionResult {
    const pl = this.players[role];
    const plateId = typeof args.plateId === 'string' && s.plates.includes(args.plateId) ? args.plateId : s.plates[0];
    const plate = plateId ? this.plates.get(plateId) : undefined;
    switch (action) {
      case 'new_plate': {
        const vessel = args.vessel === 'bowl' ? 'bowl' : 'plate';
        if (s.plates.length >= PLATING_SLOTS && !(!pl.held && args.hold)) return warn('裝盤區放滿了。');
        if (s.dishes[vessel] <= 0) return warn(`沒有乾淨的${vessel === 'bowl' ? '碗' : '盤子'}了：把回收窗口的髒盤拿到水槽洗。`);
        s.dishes[vessel]--;
        const p: Plate = { id: this.id('p'), vessel, components: [], seasoning: {} };
        this.plates.set(p.id, p);
        if (args.hold && this.freeHand(role)) pl.held = { kind: 'plate', id: p.id };
        else s.plates.push(p.id);
        return ok(`拿了一個${vessel === 'bowl' ? '碗' : '盤子'}。`);
      }
      case 'place': {
        if (pl.held?.kind !== 'plate') return warn('手上沒有盤子。');
        if (s.plates.length >= PLATING_SLOTS) return warn('裝盤區放滿了。');
        s.plates.push(pl.held.id);
        pl.held = null;
        return ok('盤子放下了。');
      }
      case 'pick': {
        if (!plate) return warn('裝盤區沒有盤子。');
        if (!this.freeHand(role)) return warn('兩隻手都拿著東西，先放下一樣。');
        s.plates.splice(s.plates.indexOf(plate.id), 1);
        pl.held = { kind: 'plate', id: plate.id };
        return ok('端起盤子。');
      }
      case 'add': {
        if (!plate) return warn('先在裝盤區放一個盤子。');
        const it = this.heldItem(role);
        if (!it) return warn('手上沒有食材。');
        if (INGREDIENTS[it.type].liquid) return warn(`${INGREDIENTS[it.type].label}要先倒進湯鍋（或放進攪拌碗拌進別的東西）。`);
        this.log(it, 'plate', role, s.def.id);
        plate.components.push(...this.snapshots(it));
        this.items.delete(it.id);
        pl.held = null;
        return ok(`${INGREDIENTS[it.type].label}裝盤。`);
      }
      case 'pour':
        return this.pourInto(role, (seasoning, units) => {
          if (!plate) return '先在裝盤區放一個盤子。';
          plate.seasoning[seasoning] = (plate.seasoning[seasoning] ?? 0) + units;
          return null;
        });
      case 'taste': {
        if (!plate) return warn('裝盤區沒有盤子。');
        if (!plate.components.length) return warn('盤子是空的。');
        const t = dishTaste(plate.components, plate.seasoning);
        const parts = FLAVOR_DIMS.filter((d) => t[d] >= 0.4).map((d: FlavorDim) => `${FLAVOR_LABEL[d]}${tasteWord(t[d])}`);
        const seasoned = Object.values(plate.seasoning).some((v) => (v ?? 0) > 0) || plate.components.some((c) => Object.values(c.seasoning).some((v) => (v ?? 0) > 0));
        const guess = dishGuess(analyzeDish({ vessel: plate.vessel, components: plate.components, seasoning: plate.seasoning, liquid: plate.liquid }));
        return info(`${this.flaws.onTaste(role, plate.id, this.tasteFingerprint(plate.id), `${plate.vessel === 'bowl' ? '碗' : '盤子'}（裝盤區）`, parts, seasoned)}　${guess}`);
      }
    }
    return warn('沒有這個動作。');
  }

  /* ---------------------------- 出餐口 ---------------------------- */

  private actPass(role: Seat, action: string, args: Record<string, unknown>): KitchenActionResult {
    if (action === 'read') return this.flaws.readOrder(role, String(args.orderId ?? ''));
    if (action === 'verify') {
      const r = this.flaws.startVerify(role, String(args.rumorId ?? ''));
      if (!('ms' in r)) return r;
      return this.startTask(role, 'verify', 'pass', String(args.rumorId), r.ms);
    }
    if (action !== 'serve') return warn('沒有這個動作。');
    if (this.phase !== 'SERVICE') return warn('還沒開始營業。');
    const pl = this.players[role];
    if (pl.held?.kind !== 'plate') return warn('手上沒有盤子。');
    const order = this.orders.find((o) => o.id === args.orderId && o.status === 'open');
    if (!order) return warn('這張單已經不在了。');
    const plate = this.plates.get(pl.held.id)!;
    const result = scorePlate(plate, order, this.t, role);
    order.status = 'served';
    order.result = result;
    this.flaws.onOrderClosed(order.id);
    this.plates.delete(plate.id);
    this.dishReturns.push({ at: this.t + DISH_RETURN_MS, vessel: plate.vessel });
    pl.held = null;
    this.stats.served++;
    this.stats.qualitySum += result.total;
    this.tutorial?.onServed(result.total);
    if (order.plan.story) this.onStoryServed();
    this.hooks.event({ kind: 'served', text: `${order.table} 號桌：${result.dish} ${result.total} 分`, sound: 'bell', at: STATION_BY_ID.pass.pos }, 'all');
    return ok(`出餐：${result.dish}，${result.total} 分。`, { result });
  }

  private actTrash(role: Seat, action: string): KitchenActionResult {
    if (action !== 'discard') return warn('沒有這個動作。');
    return this.discardHeld(role);
  }

  /** 丟掉手上的東西：食材丟掉；盤子裡的菜倒掉、盤子送到回收窗口（之後要洗） */
  discardHeld(role: Seat): KitchenActionResult {
    const pl = this.players[role];
    const h = pl.held;
    if (!h) return warn('手上沒有東西。');
    if (h.kind === 'crate') return warn('貨不能丟。');
    if (h.kind === 'dirty') return warn('髒盤要拿去水槽洗，不能丟。');
    if (h.kind === 'item') this.items.delete(h.id);
    if (h.kind === 'plate') {
      const plate = this.plates.get(h.id);
      if (plate) this.stations.get('dish_return')!.dirty[plate.vessel]++;
      this.plates.delete(h.id);
    }
    pl.held = null;
    this.noise(STATION_BY_ID.trash.pos[0], STATION_BY_ID.trash.pos[1], NOISE.trash, 'trash');
    return ok(h.kind === 'plate' ? '倒掉了（盤子放到回收窗口）。' : '丟掉了。');
  }

  /* ---------------------------- 回收窗口、交接架 ---------------------------- */

  private actDishes(role: Seat, s: StationRT, action: string): KitchenActionResult {
    if (action === 'take') return this.takeDirty(role, false);
    if (action === 'tray') return this.startTask(role, 'tray', s.def.id, undefined, this.flaws.cfg.D11.trayMs);
    return warn('沒有這個動作。');
  }

  /** 從回收窗口拿一疊髒盤（徒手 4 個；托盤 6 個） */
  takeDirty(role: Seat, tray: boolean): KitchenActionResult {
    const pl = this.players[role];
    const s = this.stations.get('dish_return')!;
    if (!this.bothHandsFree(role)) return warn('一疊髒盤要用雙手拿：先把手上的東西放下。');
    const total = s.dirty.plate + s.dirty.bowl;
    if (!total) return warn('回收窗口沒有髒盤。');
    let room = tray ? this.flaws.cfg.D11.trayCapacity : DIRTY_HAND_CAPACITY;
    const plate = Math.min(s.dirty.plate, room);
    room -= plate;
    const bowl = Math.min(s.dirty.bowl, room);
    s.dirty.plate -= plate;
    s.dirty.bowl -= bowl;
    pl.held = { kind: 'dirty', plate, bowl, ...(tray ? { tray: true } : {}) };
    return ok(`${tray ? '用托盤收了' : '拿了'} ${plate + bowl} 個髒盤，拿到水槽的碗盤架。`);
  }

  private actShelf(role: Seat, s: StationRT, action: string, args: Record<string, unknown>): KitchenActionResult {
    const pl = this.players[role];
    const used = s.items.length + s.plates.length;
    if (action === 'place') {
      if (used >= (CAPACITY.shelf ?? 4)) return warn('交接架放滿了。');
      if (pl.held?.kind === 'item') {
        const it = this.items.get(pl.held.id)!;
        s.items.push(it.id);
        pl.held = null;
        this.log(it, `place:${s.def.id}`, role, s.def.id, s.def.label);
        return ok(`把${INGREDIENTS[it.type].label}放上${s.def.label}。`);
      }
      if (pl.held?.kind === 'plate') {
        s.plates.push(pl.held.id);
        pl.held = null;
        return ok(`把盤子放上${s.def.label}。`);
      }
      return warn('交接架只放食材和盤子。');
    }
    if (action === 'pick') {
      if (!this.freeHand(role)) return warn('兩隻手都拿著東西，先放下一樣。');
      const id = typeof args.id === 'string' ? args.id : (s.items[0] ?? s.plates[0]);
      if (id && s.items.includes(id)) {
        s.items.splice(s.items.indexOf(id), 1);
        pl.held = { kind: 'item', id };
        return ok(`拿起${INGREDIENTS[this.items.get(id)!.type].label}。`);
      }
      if (id && s.plates.includes(id)) {
        s.plates.splice(s.plates.indexOf(id), 1);
        pl.held = { kind: 'plate', id };
        return ok('端起盤子。');
      }
      return warn('交接架上沒有東西。');
    }
    return warn('沒有這個動作。');
  }

  /**
   * 成品架：處理好的食材暫放，肉類一個架、其他一個架（生肉不會碰到要生吃的菜）。
   * place：放手上那份；place_all：手上＋菜籃裡適合這個架的全部放上去；pick：拿起指定的一份。
   */
  private actRack(role: Seat, s: StationRT, action: string, args: Record<string, unknown>): KitchenActionResult {
    const pl = this.players[role];
    const meatRack = s.def.id === 'rack_meat';
    const fits = (it: ItemState) => isRawProtein(INGREDIENTS[it.type]) === meatRack;
    const wrong = meatRack ? '這是肉類的架子：蔬菜和其他食材放隔壁的架子。' : '生肉、熟肉都放隔壁的肉類架子（避免交叉污染）。';
    if (action === 'place' || action === 'place_all') {
      const ids = action === 'place' ? (pl.held?.kind === 'item' ? [pl.held.id] : []) : this.carriedIds(role);
      if (!ids.length) return warn('手上沒有食材。');
      let n = 0;
      let skipped = 0;
      for (const id of ids) {
        const it = this.items.get(id);
        if (!it) continue;
        if (!fits(it)) {
          skipped++;
          continue;
        }
        if (s.items.length >= RACK_CAPACITY) break;
        s.items.push(id);
        this.removeCarried(role, id);
        this.log(it, `place:${s.def.id}`, role, s.def.id, s.def.label);
        n++;
      }
      if (!n) return warn(skipped ? wrong : `${s.def.label}放滿了（${RACK_CAPACITY} 份）。`);
      return ok(`放了 ${n} 份到${s.def.label}${skipped ? `（${skipped} 份不屬於這個架子，留在手上）` : ''}。`);
    }
    if (action === 'pick') {
      if (!this.freeHand(role)) return warn('兩隻手都拿著東西，先放下一樣。');
      const id = typeof args.id === 'string' && s.items.includes(args.id) ? args.id : s.items[0];
      if (!id) return warn(`${s.def.label}是空的。`);
      s.items.splice(s.items.indexOf(id), 1);
      pl.held = { kind: 'item', id };
      return ok(`拿起${INGREDIENTS[this.items.get(id)!.type].label}。`);
    }
    return warn('沒有這個動作。');
  }

  /** 從最上層拿一份存貨（踩踏凳之後，或巨人直接拿） */
  takeHigh(role: Seat, s: StationRT, type: IngredientId): KitchenActionResult {
    const pl = this.players[role];
    const def = INGREDIENTS[type];
    if (!def) return warn('這裡沒有這種食材。');
    if (!this.freeHand(role)) return warn('兩隻手都拿著東西，先放下一樣。');
    if ((s.high[type] ?? 0) <= 0) return warn(`最上層沒有${def.label}了。`);
    s.high[type] = (s.high[type] ?? 0) - 1;
    const it = newItem(this.id('i'), type, this.t);
    it.history[0].by = role;
    it.history[0].at = s.def.id;
    this.items.set(it.id, it);
    pl.held = { kind: 'item', id: it.id };
    return ok(`從最上層拿了${def.label}。`);
  }

  /**
   * 手上的東西掉到地上（失衡沒救回來）：生的食材要重新洗，煮過的食材與盤子裡的菜不能再用。
   * 量匙會直接灑掉。回傳掉在地上的東西（給 FlawSystem 建立地上的物件）。
   */
  dropHeld(role: Seat): Held {
    const pl = this.players[role];
    const h = pl.held;
    if (!h) return null;
    pl.held = null;
    if (h.kind === 'item') {
      const it = this.items.get(h.id);
      if (it) {
        it.floorDirty = true;
        it.washed = false;
        this.log(it, 'dropped', role, undefined, '掉在地上');
      }
    } else if (h.kind === 'plate') {
      const plate = this.plates.get(h.id);
      if (plate) for (const c of plate.components) c.floorDirty = true;
    } else if (h.kind === 'measure') return null;
    const pose = this.hooks.pose(role);
    if (pose) this.noise(pose.x, pose.z, NOISE.clang, 'drop');
    return h;
  }

  /* ---------------------------- 監視器與門禁（失語員） ---------------------------- */

  private actCctv(role: Seat, action: string, args: Record<string, unknown>): KitchenActionResult {
    if (action === 'watch') {
      this.cctvBy = args.on === false ? null : role;
      return info(this.cctvBy ? '監視器：餐廳與後走廊。' : '離開監視器。');
    }
    if (action === 'fire_door') {
      if (!this.doors.fire) return info('防火門已經關著。');
      if (this.t < this.fireDoor.readyAt) return warn(`防火門還要 ${Math.ceil((this.fireDoor.readyAt - this.t) / 1000)} 秒才能再關。`);
      this.doors = { ...this.doors, fire: false };
      this.fireDoor = { closedUntil: this.t + 15_000, readyAt: this.t + 45_000 };
      this.hooks.event({ kind: 'fire_door', text: '防火門關上了（15 秒）：牠在後走廊、側走廊的話，會被擋回去。', sound: 'door_slam', at: [7.95, 19.15] }, 'all');
      return ok('關上防火門（15 秒）。');
    }
    if (action === 'back_door') {
      if (this.opts.backLockBroken) return warn('後門的鎖今天壞了：只能用防火門擋，或躲進置物櫃。');
      const m = this.threats?.public(this).monster;
      if (m?.present) return warn('牠已經在裡面了：鎖後門擋不住，改用防火門把牠擋回去。');
      if (this.backClosed) return info('後門已經鎖著。');
      if (this.t < this.fireDoor.readyAt) return warn(`門禁還要 ${Math.ceil((this.fireDoor.readyAt - this.t) / 1000)} 秒才能再用。`);
      this.backDoor = { closedUntil: this.t + 20_000 };
      this.fireDoor = { ...this.fireDoor, readyAt: this.t + 45_000 };
      this.hooks.event({ kind: 'fire_door', text: '後門鎖上了（20 秒）：後門外的東西進不來——但牠會越等越餓，門一開就進來。', sound: 'door_slam', at: [8.9, 25.7] }, 'all');
      return ok('鎖上後門（20 秒）。');
    }
    return warn('沒有這個動作。');
  }

  /* ---------------------------- 置物櫃、鐵籠、後門 ---------------------------- */

  private actLocker(role: Seat, s: StationRT, action: string): KitchenActionResult {
    const pl = this.players[role];
    if (action === 'hide') {
      if (s.occupant) return warn('裡面已經有人了。');
      s.occupant = role;
      pl.status = 'hidden';
      const [x, z] = s.def.pos;
      this.hooks.teleport(role, x - Math.sin(s.def.facing) * 0.0, z, s.def.facing + Math.PI);
      this.threats?.onHide(role, this);
      return ok('躲進置物櫃。');
    }
    if (action === 'leave') {
      if (s.occupant !== role) return warn('你不在這個置物櫃裡。');
      s.occupant = null;
      pl.status = 'ok';
      const [fx, fz] = stationFront(s.def, 0.8);
      this.hooks.teleport(role, fx, fz, s.def.facing + Math.PI);
      return ok('離開置物櫃。');
    }
    return warn('沒有這個動作。');
  }

  private actCage(role: Seat, s: StationRT, action: string, args: Record<string, unknown>): KitchenActionResult {
    if (action !== 'rescue') return warn('沒有這個動作。');
    const who = (args.role as Seat) ?? SEATS.find((r) => this.players[r].status === 'trapped');
    if (!who || this.players[who]?.status !== 'trapped') return info('鐵籠裡沒有人。');
    return this.startTask(role, 'rescue', s.def.id, who);
  }

  private actDelivery(role: Seat, s: StationRT, action: string): KitchenActionResult {
    if (action !== 'take_crate') return warn('沒有這個動作。');
    const pl = this.players[role];
    if (!s.crate) return warn('現在沒有貨。');
    if (!this.bothHandsFree(role)) return warn('貨箱要用雙手搬：先把手上的東西放下。');
    pl.held = { kind: 'crate', storage: s.crate };
    s.crate = null;
    return ok(`搬起一箱${pl.held.storage === 'FRIDGE' ? '冷藏' : '乾貨'}。搬到${pl.held.storage === 'FRIDGE' ? '冷藏架' : '乾貨架'}。`);
  }

  /* ============================== 恐怖系統的介面 ============================== */

  /** 怪物抓住玩家：關進冷藏室的鐵籠（手上的東西保留），等隊友救 */
  trap(role: Seat): void {
    const pl = this.players[role];
    if (pl.status === 'trapped') return;
    pl.status = 'trapped';
    pl.task = null;
    if (this.cctvBy === role) this.cctvBy = null;
    this.stats.trapped++;
    const cage = this.stations.get('cage')!;
    cage.occupant = role;
    // 面向籠門（+x），看得到冷藏室與門口
    this.hooks.teleport(role, -8.3, 21.5, -Math.PI / 2);
  }

  /** 有沒有隊友能來救（在線、沒被抓、沒睡著） */
  canBeRescued(role: Seat): boolean {
    return this.seats.some((r) => r !== role && this.players[r].status !== 'trapped' && !!this.hooks.pose(r)?.connected);
  }

  /** 自己掙脫：開始搖鐵籠 */
  private struggle(role: Seat): KitchenActionResult {
    const pl = this.players[role];
    if (pl.task?.kind === 'struggle') return info('正在掙脫中……');
    const ms = this.canBeRescued(role) ? STRUGGLE.teamMs : STRUGGLE.soloMs;
    pl.task = { kind: 'struggle', stationId: 'cage', startedAt: this.t, endsAt: this.t + ms };
    this.rattle();
    return info(`用力搖晃鐵籠的門……（${Math.round(ms / 1000)} 秒，很吵，怪物可能會聽到）`);
  }

  private rattle(): void {
    this.noise(...cagePos(), STRUGGLE.noiseRadius, 'cage');
    this.hooks.event({ kind: 'phase', sound: 'cage_rattle', at: STATION_BY_ID.cage.pos }, 'all');
  }

  private release(role: Seat): void {
    const pl = this.players[role];
    pl.status = 'ok';
    const cage = this.stations.get('cage')!;
    if (cage.occupant === role) cage.occupant = null;
    const [fx, fz] = stationFront(cage.def, 1.0);
    this.hooks.teleport(role, fx, fz, Math.PI / 2 + Math.PI);
  }

  status(role: Seat): PlayerKitchen['status'] {
    return this.players[role].status;
  }

  pose(role: Seat): PoseView | null {
    return this.hooks.pose(role);
  }

  emit(e: KitchenEvent, to: Seat | 'all'): void {
    this.hooks.event(e, to);
  }

  /** 伺服器權威的傳送（被撞開、滑倒） */
  teleport(role: Seat, x: number, z: number, yaw: number): void {
    this.hooks.teleport(role, x, z, yaw);
  }

  /** 恐怖系統：怪物身上滴下來的水（只在地上留一灘水，不碰料理） */
  spill(x: number, z: number): void {
    this.physics.spill(x, z, 0.45, 'track');
  }

  /* ============================== 公開狀態 ============================== */

  publicState(): KitchenPublic {
    const stations: Record<string, StationPublic> = {};
    for (const s of this.stations.values()) {
      const k = s.def.kind;
      const out: StationPublic = { id: s.def.id, items: [...s.items], plates: [...s.plates] };
      if (k === 'pan' || k === 'stove') {
        out.heat = s.heat;
        out.vessel = Math.round(s.vessel);
        if (k === 'stove') {
          out.liquid = r1(s.liquid);
          out.scorch = r2(s.scorch);
          out.sinceStir = Math.round((this.t - s.lastStir) / 1000);
          out.seasoning = { ...s.seasoning };
        }
      }
      if (k === 'oven') {
        out.heat = s.heat;
        out.vessel = Math.round(s.vessel);
      }
      if (k === 'sink') out.soak = s.soak;
      if (k === 'toaster') out.toast = s.toast ? { level: s.toast.level, leftMs: Math.max(0, s.toast.endsAt - this.t) } : null;
      if (k === 'prep') out.contaminated = s.contaminated;
      if (k === 'fridge' || k === 'pantry') {
        out.stock = { ...s.stock };
        out.high = { ...s.high };
      }
      if (k === 'plating') out.dishes = { ...s.dishes };
      if (k === 'sink' || k === 'dishes') out.dirty = { ...s.dirty };
      if (k === 'delivery') out.crate = s.crate;
      if (k === 'locker' || k === 'cage') out.occupant = s.occupant;
      stations[s.def.id] = out;
    }
    const items: Record<string, ItemPublic> = {};
    for (const it of this.items.values()) {
      const { history, ...rest } = it;
      items[it.id] = { ...rest, temp: r1(it.temp), maxTemp: r1(it.maxTemp), doneness: r2(it.doneness), brownA: r2(it.brownA), brownB: r2(it.brownB), freshness: r2(it.freshness), steps: history.length };
    }
    const plates: Record<string, PlatePublic> = {};
    for (const p of this.plates.values()) {
      plates[p.id] = { id: p.id, vessel: p.vessel, liquid: p.liquid, seasoning: { ...p.seasoning }, components: p.components.map(({ history: _h, ...c }) => ({ ...c, temp: r1(c.temp) })) };
    }
    const players: KitchenPublic['players'] = {};
    for (const r of this.seats) {
      const p = this.players[r];
      const task: TaskPublic | null = p.task ? { kind: p.task.kind, stationId: p.task.stationId, startedAt: p.task.startedAt, endsAt: p.task.endsAt } : null;
      players[r] = { held: p.held, other: p.other, side: p.side, basket: [...p.basket], task, status: p.status };
    }
    return {
      phase: this.phase,
      t: Math.round(this.t),
      prepMs: this.opts.prepMs,
      serviceMs: this.opts.serviceMs,
      stations,
      items,
      plates,
      players,
      orders: this.orders.map(({ plan: p, ...o }) => (p.story ? { ...o, story: true } : o)),
      menu: this.menu,
      doors: { ...this.doors },
      physics: this.physics.public(),
      fireDoor: { ...this.fireDoor },
      backDoor: { ...this.backDoor },
      threats: this.threats?.public(this) ?? { guest: null, monster: null, cctv: !!this.cctvBy },
      stats: { ...this.stats },
      coop: this.flaws.public(),
      ...(this.tutorial ? { tutorial: this.tutorial.public() } : {}),
      ...(this.opts.night ? { night: { night: this.opts.night, fragment: this.storyShown, story: this.storyState } } : {}),
    };
  }

  /* ============================== 教學關與每晚的變化用 ============================== */

  /** 玩家目前的位置 */
  poseOf(role: Seat): PoseView | null {
    return this.hooks.pose(role);
  }

  /** 送一則事件給所有人 */
  emitAll(e: KitchenEvent): void {
    this.hooks.event(e, 'all');
  }

  /** 插入一張單（at＝營業開始後第幾秒；比現在早就立刻出單） */
  addPlannedOrder(plan: OrderPlan): void {
    const rest = this.plan.slice(this.nextPlan);
    rest.push(plan);
    rest.sort((a, b) => a.at - b.at);
    this.plan = [...this.plan.slice(0, this.nextPlan), ...rest];
    if (plan.kind === 'signature' && plan.recipeId && !this.menu.includes(plan.recipeId)) this.menu.push(plan.recipeId);
  }

  /* ============================== 給缺陷卡系統的唯讀查詢 ============================== */

  name(role: Seat): string {
    return this.hooks.name?.(role) ?? `${role.slice(1)} 號`;
  }

  /** 訂單排程（唯讀） */
  schedule(): readonly OrderPlan[] {
    return this.plan;
  }

  /** 已經出現過幾張單 */
  openedCount(): number {
    return this.nextPlan;
  }

  /** 手上東西的簡短描述 */
  describeHeld(h: Held): string {
    if (!h) return '空手';
    if (h.kind === 'item') {
      const it = this.items.get(h.id);
      return it ? `${INGREDIENTS[it.type].label}${it.cut !== 'WHOLE' ? `（${CUT_LABEL[it.cut]}）` : ''}` : '食材';
    }
    if (h.kind === 'plate') return this.plates.get(h.id)?.vessel === 'bowl' ? '一碗菜' : '一盤菜';
    if (h.kind === 'measure') return `${SEASONINGS[h.seasoning].label} ${h.units}${h.extra ? `＋${SEASONINGS[h.extra.seasoning].label} ${h.extra.units}` : ''}`;
    if (h.kind === 'dirty') return `${h.plate + h.bowl} 個髒盤`;
    return h.storage === 'FRIDGE' ? '一箱冷藏貨' : '一箱乾貨';
  }

  /** 工作站內容的指紋（便條：內容一變就過期） */
  stationFingerprint(stationId: string): string {
    const s = this.stations.get(stationId);
    if (!s) return '';
    return `${s.items.join(',')}|${s.plates.join(',')}|${s.toast ? 1 : 0}|${s.crate ?? ''}`;
  }

  /** 被試吃的東西目前的調味指紋（盤子 id 或湯鍋的工作站 id）；不存在＝空字串 */
  tasteFingerprint(key: string): string {
    const p = this.plates.get(key);
    if (p) return `${p.components.length}|${JSON.stringify(p.seasoning)}`;
    const s = this.stations.get(key);
    if (s && s.items.length) return `${s.items.join(',')}|${JSON.stringify(s.seasoning)}`;
    return '';
  }

  /* ============================== 開發者工具 ============================== */

  skipPrep(): void {
    if (this.phase === 'PREP') {
      this.t = this.serviceStart - 100;
      this.tick();
    }
  }

  /** 測試與開發者工具：目前的碗盤數 */
  dishState(): { clean: DishCount; rack: DishCount; back: DishCount; pending: number } {
    return {
      clean: { ...this.stations.get('plating')!.dishes },
      rack: { ...this.stations.get('sink')!.dirty },
      back: { ...this.stations.get('dish_return')!.dirty },
      pending: this.dishReturns.length,
    };
  }

  restockAll(): void {
    for (const s of this.stations.values()) for (const k of Object.keys(s.stock) as IngredientId[]) s.stock[k] = (s.stock[k] ?? 0) + 5;
  }
}

/**
 * 刀工：下刀節奏的一致性。間隔越穩定越高；太急（間隔小於 110 ms）的刀會被視為失手。
 * 純函式，只看玩家實際的下刀時間——練習能穩定提高，沒有隨機判定。
 */
export function cutQuality(presses: number[]): number {
  if (presses.length < 2) return 0;
  const iv: number[] = [];
  for (let i = 1; i < presses.length; i++) iv.push(presses[i] - presses[i - 1]);
  const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
  const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length);
  const cv = mean > 0 ? sd / mean : 1;
  const rushed = iv.filter((x) => x < 110).length / iv.length;
  return Math.max(0, Math.min(1, Math.round((1 - cv * 2.2 - rushed * 0.6) * 100) / 100));
}
