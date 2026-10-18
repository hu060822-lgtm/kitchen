import {
  CUT_LABEL,
  DEFAULT_FLAW_CONFIG,
  FREE_REQUESTS,
  INGREDIENTS,
  NOTE_LABELS,
  NOTE_TEXT,
  RECIPES,
  SEATS,
  STATION_BY_ID,
  STIR_GRACE,
  TOKEN_LABEL,
  cookingState,
  flawSpeedMultiplier,
  heatItem,
  isSeat,
  isSignalToken,
  stationFront,
  stepVessel,
  zoneAt,
  type CoopPublic,
  type Cut,
  type FlawEffectConfig,
  type FlawEvent,
  type FlawId,
  type FlawTelemetry,
  type FlawTelemetryCard,
  isTwoHanded,
  type Held,
  type ItemState,
  type KitchenActionResult,
  type KitchenEvent,
  type MarkPublic,
  type NoteLabel,
  type NotePublic,
  type OrderPublic,
  type PlayerFlawState,
  type PrepHintPublic,
  type PrivateRumor,
  type RumorPublic,
  type Seat,
  type SignalToken,
  type TaskKind,
  type TasteReport,
  type ThermalWarning,
  type HandoffPublic,
  type FloorItemPublic,
  type WobblePublic,
  type SteadyPublic,
  type RallyPublic,
  type InterferencePublic,
  type RoutePublic,
  type FlawHint,
  type StationDef,
  type StationPublic,
  QUIET_ZONES,
  freshnessState,
  isRawProtein,
} from '@last-table/shared';
import { rng, type OrderPlan, type Rng } from '../kitchen/orders';
import type { KitchenSim, StationRT } from '../kitchen/sim';

/**
 * FlawSystem：缺陷卡的唯一判定者（伺服器權威）。
 *
 * 它掛在 KitchenSim 上，只透過幾個固定的接點介入，不改寫任何料理規則：
 *   - taskMs / chopStrokes          動作要花多久、要切幾刀（倍率來自設定，有上限）
 *   - onPrepWork / onTaste          連續備料、試吃結果
 *   - filterEvent                   事件送給某人之前的過濾（耳背砧板）
 *   - ordersFor / privateFor        每位玩家收到的快照（健忘助手的訂單、個人狀態）
 *   - speedMult                     移動速度倍率（伺服器移動驗證與客戶端共用同一個函式）
 *   - handle                        互助操作（stationId＝'coop'）
 *   - tick                          傳聞、記憶、預警、便條過期、交接逾時、遙測
 *
 * 食材、鍋具、訂單與評分的真實狀態只在 KitchenSim 裡；這裡最多「讀」它們，
 * 唯一會改變的實體狀態是手對手交接（把 held 從一個人移到另一個人，同樣經過距離與狀態驗證）。
 * 所有時間都用班次時鐘（sim.t），重新連線不會重置任何計時器。
 */

const ok = (message: string): KitchenActionResult => ({ ok: true, message, tone: 'ok' });
const info = (message: string): KitchenActionResult => ({ ok: true, message, tone: 'info' });
const warn = (message: string): KitchenActionResult => ({ ok: false, message, tone: 'warn' });

/** 耳背砧板：這些事件的「文字」本身就是在轉述一個聲音，所以不給 */
const SOUND_TEXT_KINDS = new Set<KitchenEvent['kind']>(['order_new', 'order_missed', 'toast_pop', 'fire_door', 'guest_say', 'guest_moved', 'monster_sound', 'boil_over', 'phase']);

/** 假傳聞的素材：不存在的菜、錯的數量、錯的要求 */
const FAKE_DISHES = ['焗烤龍蝦', '炸豬排飯', '奶油蘑菇濃湯', '麻婆豆腐', '藍莓鬆餅', '牛肉麵'];
const FAKE_REQUESTS = ['要辣的，裡面要有雞肉，不要湯。', '來點甜的，要有洋蔥。', '我想吃冷的、有蛋的。', '不要鹽，要很酸的湯。', '兩種肉，越鹹越好。'];
const COUNT_WORD = ['', '', '兩', '三', '四'];

interface Rumor {
  id: string;
  owner: Seat;
  text: string;
  truth: boolean;
  /** 真傳聞對應的排程（plan 的索引） */
  planIdx?: number;
  pitch: number;
  at: number;
  expiresAt: number;
  posted: boolean;
}

interface SeatState {
  flaw: FlawId;
  cooldowns: { tap: number; recite: number; focus: number };
  rumors: Rumor[];
  streak: { level: number; lastAt: number };
  thermal: ThermalWarning[];
  thermalLast: Map<string, number>;
  /** D15：訂單 id → 記到什麼時候（依加入順序，最舊的在前面） */
  memory: Map<string, number>;
  recited: Map<string, number>;
  focus: string | null;
  reports: Array<TasteReport & { key: string; fp: string }>;
  tapped: PlayerFlawState['tapped'];
  lastTaste: { key: string; fp: string; target: string; words: string[] | null; at: number } | null;
  lastActionAt: number;
  /** D06／D16：手上的東西正在失衡 */
  wobble: { until: number; cause: WobblePublic['cause']; held: string; slowSince: number | null } | null;
  wobbleCd: number;
  turn: number;
  /** 最近一次被接受的移動：速度（半秒視窗）與時間（班次時鐘） */
  moveSpeed: number;
  moveAt: number;
  gripCd: number;
  /** D09 */
  clamps: Map<string, number>;
  /** D10 */
  gloveUntil: number;
  /** D08 */
  peeks: Map<string, number>;
  /** D14 */
  drowsy: number;
  sleepUntil: number;
  holdSince: number | null;
  lastWorkKind: string | null;
  reliefs: number[];
  splashCd: number;
  links: string[];
  warned: 0 | 1 | 2;
  /** D16 */
  sneezeAt: number;
  sneezeWarned: boolean;
  smellCd: number;
  /** D05 */
  rallyCd: number;
  /** D11／D16 的提示，與每個目標上次提示的時間 */
  hints: FlawHint[];
  hintLast: Map<string, number>;
}

interface FloorItem extends FloorItemPublic {
  held: NonNullable<Held>;
}

interface Note extends NotePublic {
  fp: string;
  staleAt: number;
}

interface Handoff extends HandoffPublic {
  held: string;
}

export class FlawSystem {
  readonly cfg: FlawEffectConfig;
  private readonly seats = new Map<Seat, SeatState>();
  private handoffs: Handoff[] = [];
  private notes: Note[] = [];
  private marks: MarkPublic[] = [];
  private rumorsPub: RumorPublic[] = [];
  private prepHints: Array<PrepHintPublic & { planIdx?: number }> = [];
  private floor: FloorItem[] = [];
  private steadies: SteadyPublic[] = [];
  private rallies: RallyPublic[] = [];
  private interference: InterferencePublic[] = [];
  private routes: RoutePublic[] = [];
  /** D14 的爐具被誰接管（工作站 id → 席位） */
  private takenBy = new Map<string, Seat>();
  private readonly allRumors = new Map<string, Rumor>();
  private readonly telemetry: FlawTelemetry = {};
  readonly events: FlawEvent[] = [];
  private seq = 0;
  private readonly rand: Rng;
  private nextFakeAt = 0;
  private readonly usedFakes = new Set<string>();
  private readonly leaked = new Set<number>();
  private lastSecond = -1;

  constructor(
    private readonly sim: KitchenSim,
    flaws: Partial<Record<Seat, FlawId>>,
    cfg: FlawEffectConfig = DEFAULT_FLAW_CONFIG,
    seed = 1,
  ) {
    this.cfg = cfg;
    this.rand = rng(seed * 7919 + 13);
    for (const s of SEATS) {
      const f = flaws[s];
      if (!f) continue;
      this.seats.set(s, {
        flaw: f,
        cooldowns: { tap: 0, recite: 0, focus: 0 },
        rumors: [],
        streak: { level: 0, lastAt: -1e9 },
        thermal: [],
        thermalLast: new Map(),
        memory: new Map(),
        recited: new Map(),
        focus: null,
        reports: [],
        tapped: null,
        lastTaste: null,
        lastActionAt: 0,
        wobble: null,
        wobbleCd: 0,
        turn: 0,
        moveSpeed: 0,
        moveAt: -1e9,
        gripCd: 0,
        clamps: new Map(),
        gloveUntil: 0,
        peeks: new Map(),
        drowsy: 0,
        sleepUntil: 0,
        holdSince: null,
        lastWorkKind: null,
        reliefs: [],
        splashCd: 0,
        links: [],
        warned: 0,
        sneezeAt: cfg.D16.periodMs,
        sneezeWarned: false,
        smellCd: 0,
        rallyCd: 0,
        hints: [],
        hintLast: new Map(),
      });
      const tel = this.tel(f);
      tel.players++;
    }
    this.nextFakeAt = sim.serviceStart + cfg.D01.firstFakeMs;
  }

  /* ============================== 查詢 ============================== */

  flawOf(seat: Seat): FlawId | null {
    return this.seats.get(seat)?.flaw ?? null;
  }

  has(seat: Seat, flaw: FlawId): boolean {
    return this.seats.get(seat)?.flaw === flaw;
  }

  private anyWith(flaw: FlawId): Seat[] {
    return [...this.seats.entries()].filter(([, s]) => s.flaw === flaw).map(([seat]) => seat);
  }

  private id(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  private tel(f: FlawId): FlawTelemetryCard {
    return (this.telemetry[f] ??= { players: 0, triggers: 0, coopOk: 0, coopFail: 0, blocked: 0, advantage: 0, idleSec: 0 });
  }

  /** 記一筆 flawEvent，同時更新遙測 */
  private log(seat: Seat, kind: FlawEvent['kind'], what: string, field?: keyof FlawTelemetryCard): void {
    const flaw = this.flawOf(seat);
    this.events.push({ at: Math.round(this.sim.t), seat, flaw, kind, what });
    if (this.events.length > 200) this.events.shift();
    if (!flaw) return;
    const t = this.tel(flaw);
    const f = field ?? (kind === 'trigger' ? 'triggers' : kind === 'coop_ok' ? 'coopOk' : kind === 'coop_fail' ? 'coopFail' : undefined);
    if (f) (t[f] as number)++;
  }

  telemetrySnapshot(): FlawTelemetry {
    return JSON.parse(JSON.stringify(this.telemetry)) as FlawTelemetry;
  }

  private name(seat: Seat): string {
    return this.sim.name(seat);
  }

  private dist(a: Seat, b: Seat): number {
    const pa = this.sim.pose(a);
    const pb = this.sim.pose(b);
    if (!pa || !pb) return Infinity;
    return Math.hypot(pa.x - pb.x, pa.z - pb.z);
  }

  /* ============================== 動作接點 ============================== */

  /** 計時動作的長度（毫秒） */
  taskMs(seat: Seat, kind: TaskKind, base: number): number {
    const st = this.seats.get(seat);
    if (!st) return base;
    let speed = 0;
    if (st.flaw === 'D02' && (kind === 'wash' || kind === 'peel' || kind === 'wipe')) {
      speed = Math.min(this.cfg.D02.maxTaskSpeed, this.streakLevel(st) * this.cfg.D02.taskSpeedPerStreak);
    }
    if (st.flaw === 'D15' && this.focusActive(st) && (kind === 'wash' || kind === 'peel' || kind === 'wipe' || kind === 'probe')) {
      speed = this.cfg.D15.focusTaskSpeed;
    }
    if (st.flaw === 'D04' && kind === 'escort') return this.cfg.D04.escortMs;
    if (st.flaw === 'D06' && kind === 'peel') speed = this.cfg.D06.peelSpeed;
    if (st.flaw === 'D09' && (kind === 'wash' || kind === 'wipe' || kind === 'probe' || kind === 'rescue')) speed = this.cfg.D09.taskSpeed;
    if (st.flaw === 'D10' && (kind === 'wash' || kind === 'peel')) speed = this.cfg.D10.prepSpeed;
    if (st.flaw === 'D11' && (kind === 'dishes' || kind === 'wipe')) speed = this.cfg.D11.cleanSpeed;
    if (speed > 0) {
      this.log(seat, 'trigger', `${kind} 加速 ${Math.round(speed * 100)}%`, 'advantage');
      return Math.round(base * (1 - speed));
    }
    return base;
  }

  /** 切法需要下幾刀 */
  chopStrokes(seat: Seat, cut: Cut, base: number): number {
    const st = this.seats.get(seat);
    if (!st) return base;
    let cutBy = 0;
    if (st.flaw === 'D02') cutBy = Math.min(this.cfg.D02.maxStrokeCut, this.streakLevel(st) * this.cfg.D02.strokesPerStreak);
    if (st.flaw === 'D15' && this.focusActive(st)) cutBy = this.cfg.D15.focusStrokeCut;
    if (st.flaw === 'D06') cutBy = base - Math.ceil(base / Math.max(1, this.cfg.D06.chopSpeed));
    if (st.flaw === 'D10') cutBy = this.cfg.D10.strokeCut;
    const need = Math.max(3, base - cutBy);
    if (need < base) this.log(seat, 'trigger', `${CUT_LABEL[cut]}少 ${base - need} 刀`, 'advantage');
    return need;
  }

  private streakLevel(st: SeatState): number {
    return this.sim.t - st.streak.lastAt <= this.cfg.D02.streakWindowMs ? st.streak.level : 0;
  }

  /** 完成一次備料（切菜、清洗、削皮、擦砧板） */
  onPrepWork(seat: Seat): void {
    const st = this.seats.get(seat);
    if (!st || st.flaw !== 'D02') return;
    st.streak = { level: this.streakLevel(st) + 1, lastAt: this.sim.t };
  }

  /**
   * 試吃。回傳要給玩家看的訊息；同時記下這次試吃（試吃回報只能回報實際嚐到的結果）。
   * key：被試吃的東西（盤子 id 或工作站 id）；fp：它目前的調味指紋（之後再調味，回報就會過期）。
   */
  onTaste(seat: Seat, key: string, fp: string, target: string, words: string[], seasoned: boolean): string {
    const st = this.seats.get(seat);
    const normal = `試吃：${words.length ? words.join('、') : '幾乎沒有味道'}。`;
    if (!st) return normal;
    if (st.flaw === 'D03') {
      st.lastTaste = { key, fp, target, words: null, at: this.sim.t };
      this.log(seat, 'trigger', '嚐不出味道', 'blocked');
      return `試吃：嚐不出明確的味道——只知道${seasoned ? '有調過味' : '幾乎沒有調味'}。照食譜刻度調味，或請隊友試吃後回報給你。`;
    }
    st.lastTaste = { key, fp, target, words, at: this.sim.t };
    return normal;
  }

  /** 移動速度倍率（伺服器移動驗證用；客戶端用同一個共用函式） */
  speedMult(seat: Seat, x: number, z: number, held: Held): number {
    return flawSpeedMultiplier(this.flawOf(seat), zoneAt(x, z)?.id ?? null, held?.kind ?? null, this.cfg);
  }

  /** 送出事件之前的過濾。回傳 null＝這個人收不到 */
  filterEvent(seat: Seat, e: KitchenEvent): KitchenEvent | null {
    const flaw = this.flawOf(seat);
    if (e.critical) return e;
    if (flaw !== 'D02' && !this.muffled(seat)) return e;
    if (e.sense === 'sound') return null;
    if (!e.sound) return e;
    const out: KitchenEvent = { ...e, sound: undefined };
    if (SOUND_TEXT_KINDS.has(e.kind)) out.text = undefined;
    if (!out.text && !out.visual) return null;
    return out;
  }

  /** 使用者做了任何操作（遙測：閒置時間） */
  touched(seat: Seat): void {
    const st = this.seats.get(seat);
    if (st) st.lastActionAt = this.sim.t;
  }

  /* ============================== 訂單 ============================== */

  /** 新訂單出現：健忘助手記得最新的單；連結準備提示 */
  onOrderOpened(o: OrderPublic, planIdx: number): void {
    for (const seat of this.anyWith('D15')) this.remember(this.seats.get(seat)!, o.id, this.cfg.D15.memoryMs);
    for (const h of this.prepHints) {
      if (h.planIdx === planIdx && !h.orderId) {
        h.orderId = o.id;
        h.expiresAt = Math.min(h.expiresAt, o.deadline);
      }
    }
  }

  onOrderClosed(orderId: string): void {
    for (const st of this.seats.values()) {
      st.memory.delete(orderId);
      st.recited.delete(orderId);
      if (st.focus === orderId) st.focus = null;
    }
    this.prepHints = this.prepHints.filter((h) => h.orderId !== orderId);
    this.marks = this.marks.filter((m) => m.targetId !== `order:${orderId}`);
  }

  private remember(st: SeatState, orderId: string, ms: number): void {
    st.memory.delete(orderId);
    st.memory.set(orderId, this.sim.t + ms);
    // 名額：專注單不佔名額
    const counted = [...st.memory.keys()].filter((id) => id !== st.focus);
    while (counted.length > this.cfg.D15.capacity) {
      const oldest = counted.shift()!;
      st.memory.delete(oldest);
    }
  }

  private remembers(st: SeatState, orderId: string): boolean {
    if (st.focus === orderId) return true;
    if ((st.recited.get(orderId) ?? 0) > this.sim.t) return true;
    return (st.memory.get(orderId) ?? 0) > this.sim.t;
  }

  private focusActive(st: SeatState): boolean {
    return !!st.focus && this.sim.orders.some((o) => o.id === st.focus && o.status === 'open');
  }

  /** 送給這位玩家的訂單列表：健忘助手想不起來的單只留桌號、種類與時間 */
  ordersFor(seat: Seat, orders: OrderPublic[]): OrderPublic[] {
    const st = this.seats.get(seat);
    if (!st || st.flaw !== 'D15') return orders;
    return orders.map((o) => {
      if (o.status !== 'open' || this.remembers(st, o.id)) return o;
      const { recipeId: _r, requestId: _q, ...rest } = o;
      return { ...rest, forgotten: true };
    });
  }

  /** 出餐口「看單」 */
  readOrder(seat: Seat, orderId: string): KitchenActionResult {
    const o = this.sim.orders.find((x) => x.id === orderId && x.status === 'open');
    if (!o) return warn('這張單已經不在了。');
    const st = this.seats.get(seat);
    const what = describeOrder(o);
    if (st?.flaw === 'D15') {
      const had = this.remembers(st, o.id);
      this.remember(st, o.id, this.cfg.D15.memoryMs);
      this.log(seat, 'resolve', `看單想起 ${o.table} 號桌`);
      return ok(`${had ? '再看一次' : '想起來了'}：${o.table} 號桌，${what}。`);
    }
    return info(`${o.table} 號桌：${what}。`);
  }

  /* ============================== 傳聞（D01） ============================== */

  private tickRumors(): void {
    const holders = this.anyWith('D01');
    if (!holders.length) return;
    const t = this.sim.t;
    const plan = this.sim.schedule();
    const rel = t - this.sim.serviceStart;
    // 真訂單提前洩漏（每 leakEvery 張一次）
    for (let i = 0; i < plan.length; i++) {
      if (this.leaked.has(i) || i % this.cfg.D01.leakEvery !== 0) continue;
      const atMs = plan[i].at * 1000;
      if (rel >= atMs - this.cfg.D01.leakLeadMs && rel < atMs - 2000 && i >= this.sim.openedCount()) {
        this.leaked.add(i);
        for (const seat of holders) this.addRumor(seat, leakText(plan[i], i), true, i);
      }
    }
    // 假傳聞：只在營業中、間隔固定範圍、同時不超過上限、同一句不重複
    if (this.sim.phase === 'SERVICE' && t >= this.nextFakeAt) {
      const g = this.cfg.D01;
      this.nextFakeAt = t + g.fakeGapMinMs + this.rand() * Math.max(0, g.fakeGapMaxMs - g.fakeGapMinMs);
      const text = this.fakeText(plan);
      if (text) for (const seat of holders) {
        const st = this.seats.get(seat)!;
        if (st.rumors.filter((r) => r.expiresAt > t && !r.posted).length >= g.maxActive) continue;
        this.addRumor(seat, text, false);
      }
    }
    for (const st of this.seats.values()) st.rumors = st.rumors.filter((r) => r.expiresAt > t || (r.posted && this.rumorsPub.some((p) => p.id === r.id)));
    // 貼出去 60 秒還沒核對就撤下；已核對的結果保留 25 秒作為紀錄
    this.rumorsPub = this.rumorsPub.filter((r) => (r.status === 'posted' || r.status === 'verifying' ? t - r.at < 60_000 : t - r.at < 25_000));
    this.prepHints = this.prepHints.filter((h) => h.expiresAt > t);
  }

  private fakeText(plan: readonly OrderPlan[]): string | null {
    for (let tries = 0; tries < 12; tries++) {
      const kind = Math.floor(this.rand() * 3);
      const table = 1 + Math.floor(this.rand() * 5);
      let text: string;
      if (kind === 0) text = `${table} 號桌好像點了「${FAKE_DISHES[Math.floor(this.rand() * FAKE_DISHES.length)]}」`;
      else if (kind === 1) {
        const p = plan.find((x) => x.kind === 'signature') ?? plan[0];
        const n = 2 + Math.floor(this.rand() * 3);
        text = `${table} 號桌要${COUNT_WORD[n]}份「${RECIPES[p.recipeId ?? 'egg_toast'].name}」`;
      } else text = `${table} 號桌主廚委託：「${FAKE_REQUESTS[Math.floor(this.rand() * FAKE_REQUESTS.length)]}」`;
      if (!this.usedFakes.has(text)) {
        this.usedFakes.add(text);
        return text;
      }
    }
    return null;
  }

  private addRumor(seat: Seat, text: string, truth: boolean, planIdx?: number): void {
    const st = this.seats.get(seat)!;
    const t = this.sim.t;
    // 提示音：真傳聞音高 ≈ 1.00，假傳聞 ≈ 1.055（固定的細微差異，可以學）
    const pitch = Math.round(((truth ? 1.0 : 1.055) + (this.rand() - 0.5) * 0.02) * 1000) / 1000;
    const r: Rumor = { id: this.id('r'), owner: seat, text, truth, planIdx, pitch, at: t, expiresAt: t + this.cfg.D01.rumorTtlMs, posted: false };
    st.rumors.push(r);
    this.allRumors.set(r.id, r);
    this.log(seat, 'trigger', truth ? '聽到提前的訂單' : '聽到假訂單');
    this.sim.emit({ kind: 'flaw', text: `（只有你聽到）${text}…`, visual: 'rumor', sound: `rumor:${pitch}`, critical: true }, seat);
  }

  private rumorPost(seat: Seat, rumorId: string): KitchenActionResult {
    const st = this.seats.get(seat);
    const r = st?.rumors.find((x) => x.id === rumorId);
    if (!st || !r) return warn('沒有這則傳聞。');
    if (r.posted) return info('已經貼上訂單板了。');
    if (r.expiresAt <= this.sim.t) return warn('記不清楚了（傳聞已過期）。');
    r.posted = true;
    this.rumorsPub.push({ id: r.id, by: seat, text: r.text, status: 'posted', at: this.sim.t });
    this.sim.emit({ kind: 'coop', text: `${this.name(seat)}聽到：「${r.text}」——待核對（到出餐口核對）`, visual: 'rumor_post' }, 'all');
    return ok('貼上訂單板了：等人到出餐口核對。');
  }

  private rumorDismiss(seat: Seat, rumorId: string): KitchenActionResult {
    const pub = this.rumorsPub.find((x) => x.id === rumorId);
    if (pub) {
      if (pub.status === 'confirmed' || pub.status === 'rejected') return info('這則已經處理過了。');
      if (pub.status === 'verifying') return warn('有人正在核對這則。');
      pub.status = 'rejected';
      pub.verifier = seat;
      pub.at = this.sim.t;
      this.log(seat, 'resolve', '駁回傳聞');
      return ok('駁回：移到已排除的資訊。');
    }
    const st = this.seats.get(seat);
    const r = st?.rumors.find((x) => x.id === rumorId && !x.posted);
    if (!st || !r) return warn('沒有這則傳聞。');
    st.rumors = st.rumors.filter((x) => x !== r);
    return ok('不理它。');
  }

  /** 出餐口：開始核對一則已貼出的傳聞（回傳要花多久；null＝不能核對） */
  startVerify(seat: Seat, rumorId: string): { ms: number } | KitchenActionResult {
    const pub = this.rumorsPub.find((x) => x.id === rumorId);
    if (!pub) return warn('訂單板上沒有這則傳聞。');
    if (pub.status === 'verifying') return warn('有人正在核對。');
    if (pub.status !== 'posted') return info('這則已經處理過了。');
    pub.status = 'verifying';
    pub.verifier = seat;
    return { ms: pub.by === seat ? this.cfg.D01.verifySelfMs : this.cfg.D01.verifyMs };
  }

  cancelVerify(rumorId: string): void {
    const pub = this.rumorsPub.find((x) => x.id === rumorId);
    if (pub?.status === 'verifying') {
      pub.status = 'posted';
      pub.verifier = undefined;
    }
  }

  completeVerify(seat: Seat, rumorId: string): string | null {
    const pub = this.rumorsPub.find((x) => x.id === rumorId);
    const r = this.allRumors.get(rumorId);
    if (!pub || !r || pub.status !== 'verifying') return null;
    pub.at = this.sim.t;
    const helper = seat !== r.owner;
    if (r.truth) {
      pub.status = 'confirmed';
      const already = r.planIdx !== undefined && r.planIdx < this.sim.openedCount();
      if (!already && r.planIdx !== undefined) {
        const p = this.sim.schedule()[r.planIdx];
        const atAbs = this.sim.serviceStart + p.at * 1000;
        this.prepHints.push({ id: this.id('h'), text: prepHintText(p), planIdx: r.planIdx, at: this.sim.t, expiresAt: atAbs + 120_000 });
      }
      this.log(r.owner, helper ? 'coop_ok' : 'resolve', helper ? `${this.name(seat)}核對為真` : '自己核對為真');
      if (helper) this.log(seat, 'coop_ok', '幫忙核對傳聞');
      this.sim.emit({ kind: 'coop', text: `核對結果：「${r.text}」是真的${already ? '（單已經出現了）' : '——準備提示已貼上，可以先備料'}。`, visual: 'rumor_ok' }, 'all');
      return '票機上的預備單對得上：是真的。';
    }
    pub.status = 'rejected';
    this.log(r.owner, helper ? 'coop_ok' : 'resolve', '核對為假');
    if (helper) this.log(seat, 'coop_ok', '幫忙核對傳聞');
    this.sim.emit({ kind: 'coop', text: `核對結果：「${r.text}」是假的，已排除。`, visual: 'rumor_no' }, 'all');
    return '票機上沒有這張單：是假的。';
  }

  /* ============================== 預警（D03） ============================== */

  private tickThermal(): void {
    const holders = this.anyWith('D03');
    if (!holders.length) return;
    const t = this.sim.t;
    for (const seat of holders) {
      const st = this.seats.get(seat)!;
      st.thermal = st.thermal.filter((w) => t - w.at < 9000);
      const pose = this.sim.pose(seat);
      if (!pose || this.sim.status(seat) !== 'ok') continue;
      for (const s of this.sim.stations.values()) {
        const k = s.def.kind;
        if (k !== 'pan' && k !== 'stove') continue;
        if (Math.hypot(pose.x - s.def.pos[0], pose.z - s.def.pos[1]) > this.cfg.D03.range) continue;
        if (t - (st.thermalLast.get(s.def.id) ?? -1e9) < this.cfg.D03.repeatMs) continue;
        const w = this.predict(s.def.id);
        if (!w) continue;
        st.thermalLast.set(s.def.id, t);
        const warning: ThermalWarning = { id: this.id('w'), stationId: s.def.id, text: w.text, inSec: w.inSec, at: t };
        st.thermal.push(warning);
        this.log(seat, 'trigger', `預警：${w.text}`, 'advantage');
        this.sim.emit({ kind: 'flaw', text: `🌡 ${s.def.label}：${w.text}`, visual: 'thermal', at: s.def.pos, critical: true }, seat);
      }
    }
  }

  /**
   * 用真實狀態往前推算 leadSec 秒（同一套加熱模型、同樣的步長），看會不會燒焦／焦底／燒乾。
   * 只推算，不修改任何東西；推算用的是複製品。
   */
  predict(stationId: string): { text: string; inSec: number } | null {
    const s = this.sim.stations.get(stationId);
    if (!s || !s.items.length) return null;
    const isPan = s.def.kind === 'pan';
    const items = s.items.map((id) => this.sim.items.get(id)).filter((x): x is ItemState => !!x).map((x) => structuredClone(x));
    if (!items.length) return null;
    if (items.every((it) => cookingState(it) === 'BURNT')) return null;
    const before = new Set(items.filter((it) => cookingState(it) === 'BURNT').map((it) => it.id));
    let vessel = s.vessel;
    let liquid = s.liquid;
    let scorch = s.scorch;
    let sinceStir = (this.sim.t - s.lastStir) / 1000;
    const steps = Math.round(this.cfg.D03.leadSec * 10);
    for (let i = 1; i <= steps; i++) {
      const hasLiquid = !isPan && liquid > 0.01;
      vessel = stepVessel(vessel, s.heat, isPan ? 'pan' : 'pot', hasLiquid);
      sinceStir += 0.1;
      for (const it of items) heatItem(it, { method: isPan ? 'pan' : 'pot', vessel, mode: isPan ? 'pan' : hasLiquid ? 'potLiquid' : 'potDry', sinceStir });
      const sec = Math.max(1, Math.round(i / 10));
      const burnt = items.find((it) => !before.has(it.id) && cookingState(it) === 'BURNT');
      if (burnt) return { text: `${INGREDIENTS[burnt.type].label}大約 ${sec} 秒後會燒焦——關小火或起鍋`, inSec: sec };
      if (!isPan) {
        if (!hasLiquid && vessel > 150 && sinceStir > STIR_GRACE) scorch += ((vessel - 150) / 400) * 0.1;
        if (scorch >= 1 && s.scorch < 1) return { text: `大約 ${sec} 秒後會焦底——攪拌或關小火`, inSec: sec };
        if (hasLiquid && vessel > 99) {
          liquid = Math.max(0, liquid - (s.heat === 'HIGH' ? 0.03 : s.heat === 'MED' ? 0.015 : 0.006) * 0.1);
          if (liquid <= 0.01 && s.liquid > 0.01) return { text: `湯大約 ${sec} 秒後會燒乾`, inSec: sec };
        }
      }
    }
    return null;
  }

  /* ============================== 個人與公開狀態 ============================== */

  privateFor(seat: Seat): PlayerFlawState | undefined {
    const st = this.seats.get(seat);
    if (!st) return undefined;
    const t = this.sim.t;
    const out: PlayerFlawState = {
      flaw: st.flaw,
      cooldowns: { ...st.cooldowns },
      reports: st.reports.map(({ key: _k, fp: _f, ...r }) => r),
      tapped: st.tapped && t - st.tapped.at < 4000 ? { ...st.tapped } : null,
    };
    if (st.flaw === 'D01') {
      out.rumors = st.rumors
        .filter((r) => r.expiresAt > t || r.posted)
        .map((r): PrivateRumor => ({ id: r.id, text: r.text, pitch: r.pitch, at: r.at, expiresAt: r.expiresAt, posted: r.posted }));
    }
    if (st.flaw === 'D02') out.streak = { level: this.streakLevel(st), until: st.streak.lastAt + this.cfg.D02.streakWindowMs };
    if (st.flaw === 'D03') out.thermal = st.thermal.map((w) => ({ ...w }));
    if (st.wobble) out.wobble = { until: st.wobble.until, cause: st.wobble.cause };
    if (st.flaw === 'D06') out.cooldowns.grip = st.gripCd;
    if (st.flaw === 'D09') out.clamps = Object.fromEntries([...st.clamps].filter(([, u]) => u > t));
    if (st.flaw === 'D10') out.gloveUntil = st.gloveUntil;
    if (st.flaw === 'D08') out.peeks = Object.fromEntries([...st.peeks].filter(([, u]) => u > t));
    if (st.flaw === 'D14') {
      out.drowsy = { level: Math.round(st.drowsy), state: this.drowsyState(st), ...(st.sleepUntil > t ? { sleepUntil: st.sleepUntil } : {}), ...(st.holdSince !== null ? { holding: true } : {}) };
      out.links = st.links.filter((id) => !this.takenBy.has(id));
      out.cooldowns.splash = st.splashCd;
    }
    if (st.flaw === 'D16') {
      out.sneezeAt = st.sneezeAt;
      out.cooldowns.smell = st.smellCd;
    }
    if (st.flaw === 'D05') out.cooldowns.rally = st.rallyCd;
    if (st.hints.length) out.hints = st.hints.map((h) => ({ ...h }));
    if (this.muffled(seat)) out.muffledUntil = Math.max(...this.interference.map((z) => z.until));
    if (st.flaw === 'D15') {
      const mem: Record<string, number> = {};
      for (const [id, until] of st.memory) if (until > t) mem[id] = until;
      for (const [id, until] of st.recited) if (until > t) mem[id] = Math.max(mem[id] ?? 0, until);
      out.memory = mem;
      out.focus = this.focusActive(st) ? st.focus : null;
    }
    return out;
  }

  public(): CoopPublic {
    const flaws: CoopPublic['flaws'] = {};
    for (const [seat, st] of this.seats) flaws[seat] = st.flaw;
    return {
      flaws,
      handoffs: this.handoffs.map(({ held: _h, ...h }) => h),
      notes: this.notes.map(({ fp: _f, staleAt: _s, ...n }) => n),
      marks: this.marks.map((m) => ({ ...m, replies: [...m.replies] })),
      rumors: this.rumorsPub.map((r) => ({ ...r })),
      prepHints: this.prepHints.map(({ planIdx: _p, ...h }) => h),
      floor: this.floor.map(({ held: _h, ...f }) => f),
      wobbles: [...this.seats.entries()].filter(([, st]) => st.wobble).map(([seat, st]) => ({ seat, what: this.sim.describeHeld(this.sim.players[seat].held), cause: st.wobble!.cause, until: st.wobble!.until })),
      steadies: this.steadies.map((x) => ({ ...x })),
      rallies: this.rallies.map((r) => ({ ...r, replies: [...r.replies] })),
      interference: this.interference.map((z) => ({ ...z })),
      routes: this.routes.map((r) => ({ ...r })),
      drowsy: [...this.seats.entries()]
        .filter(([, st]) => st.flaw === 'D14' && (st.sleepUntil > this.sim.t || st.drowsy >= this.cfg.D14.heavyAt))
        .map(([seat, st]) => (st.sleepUntil > this.sim.t ? { seat, state: 'asleep' as const, until: st.sleepUntil } : { seat, state: 'heavy' as const })),
      links: [...this.seats.entries()].filter(([, st]) => st.flaw === 'D14').flatMap(([seat, st]) => st.links.map((stationId) => ({ seat, stationId, ...(this.takenBy.has(stationId) ? { takenBy: this.takenBy.get(stationId) } : {}) }))),
      sneezes: [...this.seats.entries()].filter(([, st]) => st.flaw === 'D16' && st.sneezeWarned).map(([seat, st]) => ({ seat, at: st.sneezeAt })),
    };
  }

  /* ============================== 標記 ============================== */

  /** 標記（manager 已經驗證過冷卻與格式）：指向工作站或 `order:<id>` */
  mark(seat: Seat, targetId: string, token?: SignalToken): MarkPublic | string {
    if (targetId.startsWith('order:')) {
      const oid = targetId.slice(6);
      if (!this.sim.orders.some((o) => o.id === oid && o.status === 'open')) return '這張單已經不在了。';
    } else if (!STATION_BY_ID[targetId]) return '無效的標記目標。';
    const t = this.sim.t;
    this.marks = this.marks.filter((m) => !(m.from === seat && m.targetId === targetId) && m.expiresAt > t).slice(-11);
    const m: MarkPublic = { id: this.id('m'), from: seat, targetId, token, replies: [], at: t, expiresAt: t + this.cfg.common.markTtlMs };
    this.marks.push(m);
    this.touched(seat);
    return m;
  }

  /* ============================== 互助操作 ============================== */

  handle(seat: Seat, action: string, args: Record<string, unknown>): KitchenActionResult {
    const st = this.seats.get(seat);
    if (!st) return warn('你沒有選缺陷卡。');
    this.touched(seat);
    const status = this.sim.status(seat);
    const physical = !['mark_reply', 'rumor_dismiss', 'focus', 'taste_report', 'handoff_decline', 'handoff_cancel', 'rally_reply', 'route_clear'].includes(action);
    if (physical && status === 'trapped') return warn('你被關在鐵籠裡。');
    if (physical && status === 'hidden') return warn('你躲在置物櫃裡。');
    if (physical && this.asleep(seat)) return warn('你睡著了……');
    const to = isSeat(args.to) ? args.to : null;
    switch (action) {
      case 'tap':
        return this.tap(seat, st, to, isSignalToken(args.token) ? args.token : undefined);
      case 'handoff':
        return this.offer(seat, to);
      case 'handoff_accept':
        return this.accept(seat, String(args.offerId ?? ''));
      case 'handoff_decline':
      case 'handoff_cancel':
        return this.dropOffer(seat, String(args.offerId ?? ''), action === 'handoff_decline');
      case 'note':
        return this.note(seat, String(args.stationId ?? ''), args.label, typeof args.orderId === 'string' ? args.orderId : undefined);
      case 'note_clear': {
        const n = this.notes.find((x) => x.id === args.noteId);
        if (!n) return warn('便條已經不在了。');
        this.notes = this.notes.filter((x) => x !== n);
        return ok('撕掉便條。');
      }
      case 'recite':
        return this.recite(seat, st, to, String(args.orderId ?? ''));
      case 'taste_report':
        return this.tasteReport(seat, st, to);
      case 'mark_reply': {
        const m = this.marks.find((x) => x.id === args.markId && x.expiresAt > this.sim.t);
        if (!m) return warn('這個標記已經過期了。');
        if (!isSignalToken(args.token)) return warn('無效的符號。');
        if (m.from === seat) return warn('不能回應自己的標記。');
        m.replies = [...m.replies.filter((r) => r.by !== seat), { by: seat, token: args.token }];
        m.expiresAt = Math.max(m.expiresAt, this.sim.t + 6000);
        this.log(seat, 'coop_ok', '回應標記');
        this.sim.emit({ kind: 'coop', text: `${this.name(seat)}回應了你的標記：${TOKEN_LABEL[args.token]}`, visual: 'mark_reply' }, m.from);
        return ok(`回應：${TOKEN_LABEL[args.token]}`);
      }
      case 'rumor_post':
        if (st.flaw !== 'D01') return warn('你沒有聽到傳聞。');
        return this.rumorPost(seat, String(args.rumorId ?? ''));
      case 'rumor_dismiss':
        return this.rumorDismiss(seat, String(args.rumorId ?? ''));
      case 'focus':
        return this.focus(seat, st, typeof args.orderId === 'string' ? args.orderId : null);
      case 'catch':
        return this.catchFor(seat, to);
      case 'grip':
        return this.grip(seat, st);
      case 'pickup':
        return this.pickup(seat, String(args.floorId ?? ''));
      case 'steady':
        return this.steady(seat, String(args.stationId ?? ''));
      case 'rally':
        return this.rally(seat, st, isSignalToken(args.token) ? args.token : undefined);
      case 'rally_reply':
        return this.rallyReply(seat, String(args.rallyId ?? ''), args.token);
      case 'takeover':
        return this.takeover(seat, String(args.stationId ?? ''));
      case 'smell':
        return this.smellAlert(seat, st, String(args.hintId ?? ''));
      case 'route':
        return this.route(seat, args);
      case 'route_clear':
        this.routes = this.routes.filter((r) => r.by !== seat);
        return info('擦掉你畫的箭頭。');
    }
    return warn('沒有這個動作。');
  }

  private tap(seat: Seat, st: SeatState, to: Seat | null, token?: SignalToken): KitchenActionResult {
    if (!to || to === seat || !this.seats.has(to)) return warn('要拍誰的肩膀？');
    const t = this.sim.t;
    if (t < st.cooldowns.tap) return warn(`還要 ${Math.ceil((st.cooldowns.tap - t) / 1000)} 秒才能再拍。`);
    if (this.dist(seat, to) > this.cfg.common.tapRange) {
      this.log(seat, 'coop_fail', '拍肩：太遠');
      return warn('太遠了，走到他旁邊再拍。');
    }
    const target = this.seats.get(to)!;
    const p = this.sim.pose(seat)!;
    st.cooldowns.tap = t + this.cfg.common.tapCooldownMs;
    target.tapped = { from: seat, token, at: t, x: p.x, z: p.z };
    if (target.flaw === 'D14' && target.sleepUntil > t) this.wake(to, target, seat);
    else if (target.flaw === 'D14' && target.drowsy >= this.cfg.D14.heavyAt) {
      // 快睡著時被拍一下：提神一點（不能無限重置）
      target.drowsy = Math.max(this.cfg.D14.warnAt, target.drowsy - 10);
    }
    this.log(seat, 'coop_ok', `拍 ${to} 的肩`);
    this.log(to, 'coop_ok', `被 ${seat} 拍肩`);
    this.sim.emit({ kind: 'coop', text: `${this.name(seat)}拍了拍你的肩膀${token ? `：${TOKEN_LABEL[token]}` : ''}`, visual: 'tap', at: [p.x, p.z], critical: true }, to);
    return ok(`拍了拍${this.name(to)}${token ? `（${TOKEN_LABEL[token]}）` : ''}。`);
  }

  /* ---------------------------- 手對手交接 ---------------------------- */

  private offer(seat: Seat, to: Seat | null): KitchenActionResult {
    if (!to || to === seat || !this.seats.has(to)) return warn('要交給誰？');
    const held = this.sim.players[seat].held;
    if (!held) return warn('手上沒有東西。');
    if (this.sim.players[seat].task) return warn('你正在忙。');
    if (this.dist(seat, to) > this.handoffRange(seat, to)) return warn('太遠了，走近一點再遞。');
    this.handoffs = this.handoffs.filter((h) => h.from !== seat);
    const h: Handoff = { id: this.id('x'), from: seat, to, what: this.sim.describeHeld(held), held: JSON.stringify(held), expiresAt: this.sim.t + this.cfg.common.handoffWindowMs };
    this.handoffs.push(h);
    this.sim.emit({ kind: 'coop', text: `${this.name(seat)}把${h.what}遞給你——按「接住」（${Math.round(this.cfg.common.handoffWindowMs / 1000)} 秒內）`, visual: 'handoff', critical: true }, to);
    return info(`遞出${h.what}：等${this.name(to)}接住。`);
  }

  private accept(seat: Seat, offerId: string): KitchenActionResult {
    const h = this.handoffs.find((x) => x.id === offerId);
    if (!h || h.to !== seat) return warn('沒有人在遞東西給你。');
    const fail = (why: string): KitchenActionResult => {
      this.handoffs = this.handoffs.filter((x) => x !== h);
      this.log(h.from, 'coop_fail', `交接失敗：${why}`);
      this.log(seat, 'coop_fail', `交接失敗：${why}`);
      this.sim.emit({ kind: 'coop', text: `交接失敗：${why}`, visual: 'handoff_fail' }, h.from);
      return warn(`沒接到：${why}`);
    };
    if (this.sim.t > h.expiresAt) return fail('太慢了');
    const giver = this.sim.players[h.from];
    const me = this.sim.players[seat];
    if (!this.sim.inHands(h.from, h.held)) return fail('東西已經不在他手上');
    if (!this.sim.canReceive(seat, JSON.parse(h.held) as Held)) return fail(isTwoHanded(JSON.parse(h.held) as Held) ? '那要用雙手接：你手上還有東西' : '你兩隻手都拿著東西');
    if (me.task) return fail('你正在忙');
    if (this.sim.status(h.from) !== 'ok') return fail('他現在沒辦法遞');
    if (this.dist(seat, h.from) > this.handoffRange(seat, h.from)) return fail('距離太遠');
    const given = JSON.parse(h.held) as Held;
    if (this.has(seat, 'D11') && given?.kind === 'dirty' && !given.tray) return fail('潔癖主廚不肯徒手接髒盤（放到水槽的碗盤架上）');
    if (this.asleep(seat)) return fail('你睡著了');
    this.sim.receive(seat, this.sim.takeFromHands(h.from, h.held));
    this.handoffs = this.handoffs.filter((x) => x !== h);
    this.log(h.from, 'coop_ok', `交出 ${h.what}`);
    this.log(seat, 'coop_ok', `接住 ${h.what}`);
    this.sim.emit({ kind: 'coop', text: `${this.name(seat)}接住了${h.what}。`, visual: 'handoff_ok' }, h.from);
    return ok(`接住${h.what}。`);
  }

  private dropOffer(seat: Seat, offerId: string, decline: boolean): KitchenActionResult {
    const h = this.handoffs.find((x) => x.id === offerId && (decline ? x.to === seat : x.from === seat));
    if (!h) return warn('沒有這個交接。');
    this.handoffs = this.handoffs.filter((x) => x !== h);
    if (decline) this.sim.emit({ kind: 'coop', text: `${this.name(seat)}沒有接（手上有事）。`, visual: 'handoff_fail' }, h.from);
    return info(decline ? '不接。' : '收回。');
  }

  /* ---------------------------- 便條 ---------------------------- */

  private note(seat: Seat, stationId: string, label: unknown, orderId?: string): KitchenActionResult {
    const def = STATION_BY_ID[stationId];
    if (!def) return warn('找不到這個工作站。');
    if (!(NOTE_LABELS as readonly unknown[]).includes(label)) return warn('便條只有：待處理、已備料、等待烹飪、完成。');
    if (!this.sim.inRange(seat, stationId)) return warn('走到工作站旁邊再貼。');
    if (orderId && !this.sim.orders.some((o) => o.id === orderId && o.status === 'open')) return warn('這張單已經不在了。');
    const t = this.sim.t;
    this.notes = this.notes.filter((n) => !(n.by === seat && n.stationId === stationId));
    const mine = this.notes.filter((n) => n.by === seat);
    if (mine.length >= this.cfg.common.notesPerPlayer) this.notes = this.notes.filter((n) => n !== mine[0]);
    this.notes.push({ id: this.id('n'), by: seat, stationId, label: label as NoteLabel, orderId, stale: false, at: t, fp: this.sim.stationFingerprint(stationId), staleAt: 0 });
    this.log(seat, 'coop_ok', `便條 ${def.label}：${NOTE_TEXT[label as NoteLabel]}`);
    return ok(`在${def.label}貼了便條：${NOTE_TEXT[label as NoteLabel]}。`);
  }

  private tickNotes(): void {
    const t = this.sim.t;
    for (const n of this.notes) {
      if (n.stale) continue;
      const orderGone = n.orderId && !this.sim.orders.some((o) => o.id === n.orderId && o.status === 'open');
      if (orderGone || this.sim.stationFingerprint(n.stationId) !== n.fp || t - n.at > this.cfg.common.noteTtlMs) {
        n.stale = true;
        n.staleAt = t;
      }
    }
    this.notes = this.notes.filter((n) => !n.stale || t - n.staleAt < this.cfg.common.noteStaleShowMs);
  }

  /* ---------------------------- 覆誦 ---------------------------- */

  private recite(seat: Seat, st: SeatState, to: Seat | null, orderId: string): KitchenActionResult {
    if (!to || to === seat || !this.seats.has(to)) return warn('要覆誦給誰？');
    const t = this.sim.t;
    if (t < st.cooldowns.recite) return warn('慢一點，一次一張。');
    const o = this.sim.orders.find((x) => x.id === orderId && x.status === 'open');
    if (!o) return warn('這張單已經不在了。');
    if (st.flaw === 'D15' && !this.remembers(st, o.id)) return warn('你自己也想不起這張單。先去出餐口看單。');
    if (this.dist(seat, to) > this.cfg.common.reciteRange) return warn('太遠了，走近一點再說。');
    st.cooldowns.recite = t + this.cfg.common.reciteCooldownMs;
    const target = this.seats.get(to)!;
    if (target.flaw === 'D15') target.recited.set(o.id, t + this.cfg.D15.recitedMs);
    this.log(seat, 'coop_ok', `覆誦 ${o.table} 號桌給 ${to}`);
    this.log(to, 'coop_ok', `聽 ${seat} 覆誦 ${o.table} 號桌`);
    this.sim.emit({ kind: 'coop', text: `${this.name(seat)}覆誦：${o.table} 號桌，${describeOrder(o)}。`, visual: 'recite' }, to);
    return ok(`覆誦給${this.name(to)}：${o.table} 號桌。`);
  }

  /* ---------------------------- 試吃回報 ---------------------------- */

  private tasteReport(seat: Seat, st: SeatState, to: Seat | null): KitchenActionResult {
    if (!to || to === seat || !this.seats.has(to)) return warn('要回報給誰？');
    const lt = st.lastTaste;
    if (!lt || this.sim.t - lt.at > this.cfg.common.tasteReportWindowMs) return warn('先試吃（裝盤區或湯鍋），再回報。');
    if (!lt.words) return warn('你嚐不出味道，沒辦法回報。');
    const target = this.seats.get(to)!;
    const t = this.sim.t;
    const r = { id: this.id('t'), by: seat, target: lt.target, words: [...lt.words], stale: this.sim.tasteFingerprint(lt.key) !== lt.fp, at: t, expiresAt: t + this.cfg.common.tasteReportTtlMs, key: lt.key, fp: lt.fp };
    target.reports = [...target.reports.filter((x) => x.key !== lt.key), r].slice(-4);
    this.log(seat, 'coop_ok', `試吃回報給 ${to}`);
    this.log(to, 'coop_ok', `收到 ${seat} 的試吃回報`);
    this.sim.emit({ kind: 'coop', text: `${this.name(seat)}試吃了${lt.target}：${lt.words.length ? lt.words.join('、') : '幾乎沒有味道'}`, visual: 'report' }, to);
    return ok(`回報給${this.name(to)}。`);
  }

  /* ---------------------------- 專注單（D15） ---------------------------- */

  private focus(seat: Seat, st: SeatState, orderId: string | null): KitchenActionResult {
    if (st.flaw !== 'D15') return warn('只有健忘助手需要專注單。');
    const t = this.sim.t;
    if (orderId === null) {
      st.focus = null;
      return info('取消專注單。');
    }
    if (t < st.cooldowns.focus) return warn(`還要 ${Math.ceil((st.cooldowns.focus - t) / 1000)} 秒才能換專注單。`);
    const o = this.sim.orders.find((x) => x.id === orderId && x.status === 'open');
    if (!o) return warn('這張單已經不在了。');
    if (!this.remembers(st, o.id)) return warn('你想不起這張單的內容——先去出餐口看單。');
    st.focus = o.id;
    st.memory.delete(o.id);
    st.cooldowns.focus = t + this.cfg.D15.focusCooldownMs;
    this.log(seat, 'trigger', `專注 ${o.table} 號桌`);
    return ok(`專注：${o.table} 號桌，${describeOrder(o)}。`);
  }

  /* ============================== Phase B–D：共用查詢 ============================== */

  private seat(seat: Seat): SeatState | undefined {
    return this.seats.get(seat);
  }

  /** 能力實際用上了（遙測） */
  advantage(seat: Seat, what: string): void {
    this.log(seat, 'trigger', what, 'advantage');
  }

  /** 嗜睡學徒睡著了：不能動、不能操作 */
  asleep(seat: Seat): boolean {
    const st = this.seats.get(seat);
    return !!st && st.flaw === 'D14' && st.sleepUntil > this.sim.t;
  }

  /** 伺服器的移動驗證：這個人現在完全不能移動（睡著） */
  frozen(seat: Seat): boolean {
    return this.asleep(seat);
  }

  /** 這位玩家現在聽不到一般聲音提示（在召集的干擾範圍內、而且不在安靜區） */
  muffled(seat: Seat): boolean {
    if (!this.interference.length) return false;
    const pose = this.sim.pose(seat);
    if (!pose) return false;
    const zone = zoneAt(pose.x, pose.z)?.id ?? null;
    if (zone && QUIET_ZONES.includes(zone)) return false;
    const t = this.sim.t;
    return this.interference.some((z) => z.until > t && Math.hypot(pose.x - z.x, pose.z - z.z) <= z.r);
  }

  /** 交接距離：幽閉外場在開放區域（餐廳、廚房）可以遠一點 */
  private handoffRange(a: Seat, b: Seat): number {
    const base = this.cfg.common.handoffRange;
    if (!this.has(a, 'D12') && !this.has(b, 'D12')) return base;
    const open = (s: Seat): boolean => {
      const p = this.sim.pose(s);
      const z = p ? zoneAt(p.x, p.z)?.id : null;
      return z === 'DINING' || z === 'KITCHEN';
    };
    return open(a) && open(b) ? Math.max(base, this.cfg.D12.openHandoffRange) : base;
  }

  /* ============================== 工作站的限制（gate） ============================== */

  /**
   * 操作工作站之前的判定。回傳 null＝照常；回傳結果＝擋下（附說明）；回傳 task＝改成一個計時動作
   * （潔癖主廚用托盤、用腳踩開垃圾桶；嗜睡學徒洗把臉）。
   */
  gate(seat: Seat, def: StationDef, action: string, args: Record<string, unknown>, s: StationRT): KitchenActionResult | { task: TaskKind; ms?: number; arg?: string } | null {
    const st = this.seats.get(seat);
    const flaw = st?.flaw ?? null;
    const t = this.sim.t;
    const k = def.kind;
    const blocked = (msg: string): KitchenActionResult => {
      this.log(seat, 'trigger', msg, 'blocked');
      return warn(msg);
    };

    // D10 怕火廚師：火源工作站
    if (k === 'pan' || k === 'stove' || k === 'toaster' || k === 'oven') {
      if (action === 'glove') {
        if (flaw !== 'D10') return info('你不需要隔熱手套。');
        if (st!.gloveUntil > t + 5000) return info(`手套還有 ${Math.ceil((st!.gloveUntil - t) / 1000)} 秒。`);
        return null;
      }
      if (flaw === 'D10' && action !== 'taste') {
        if (st!.gloveUntil <= t) return blocked(`你怕火，不能直接操作${def.label}。把料放到爐台旁交接架讓隊友接手，或先戴隔熱手套（3 秒，之後 30 秒）。`);
        if (action === 'heat' && args.level === 'HIGH') return blocked('戴著手套也不敢開大火：最多開到中火。');
      }
    }
    // D11 潔癖主廚
    if (flaw === 'D11') {
      if (k === 'dishes' && action === 'take') return { task: 'tray', ms: this.cfg.D11.trayMs };
      if (k === 'trash' && action === 'discard') {
        const h = this.sim.players[seat].held;
        if (!h) return warn('手上沒有東西。');
        if (h.kind === 'crate' || h.kind === 'dirty') return null;
        return { task: 'pedal', ms: this.cfg.D11.pedalMs };
      }
      if (k === 'prep' && s.contaminated && (action === 'place' || action === 'chop_start' || action === 'peel')) {
        return blocked('這塊砧板碰過生肉還沒擦——你不在上面做事。先擦乾淨（你擦得很快）。');
      }
    } else if (k === 'dishes' && action === 'tray') return warn('托盤是潔癖主廚的工具；你直接拿就好。');
    // D12 幽閉外場：不躲進置物櫃
    if (flaw === 'D12' && k === 'locker' && action === 'hide') return blocked('置物櫃太窄了，你進不去。');
    // D07／D08：最上層的存貨
    if ((k === 'fridge' || k === 'pantry') && action === 'take_high') {
      if (flaw === 'D08') return blocked('最上層太高了，你搆不到。請隊友幫你拿，或等送貨補到下層。');
      if (flaw === 'D07') {
        const r = this.sim.takeHigh(seat, s, args.type as never);
        if (r.ok) this.advantage(seat, '伸手拿到最上層');
        return r;
      }
    }
    // D08 小矮人：墊腳看湯鍋
    if (action === 'peek' && flaw !== 'D08') return info('你站著就看得到鍋裡。');
    // D14 嗜睡學徒：洗把臉
    if (k === 'sink' && action === 'splash') {
      if (flaw !== 'D14') return info('你不睏。');
      if (t < st!.splashCd) return warn(`剛洗過臉，還要 ${Math.ceil((st!.splashCd - t) / 1000)} 秒才有用。`);
      return { task: 'splash', ms: this.cfg.D14.splashMs };
    }
    if (action === 'clamp' && flaw !== 'D09') return info('你兩隻手都能用，不需要夾具。');
    return null;
  }

  /** 工作站操作照常執行之前（gate 通過）：睡意、雙爐、汙染警告 */
  onWork(seat: Seat, def: StationDef, action: string): void {
    const st = this.seats.get(seat);
    if (st?.flaw === 'D14') this.workDrowsy(seat, st, def, action);
    // 有人把生菜放上沒擦的砧板：潔癖主廚提早收到警告
    if (def.kind === 'prep' && (action === 'place' || action === 'chop_start')) {
      const s = this.sim.stations.get(def.id);
      if (s?.contaminated) {
        const h = this.sim.players[seat].held;
        const it = h?.kind === 'item' ? this.sim.items.get(h.id) : s.items[0] ? this.sim.items.get(s.items[0]) : undefined;
        if (it && !isRawProtein(INGREDIENTS[it.type])) {
          for (const d11 of this.anyWith('D11')) {
            if (d11 === seat) continue;
            this.hint(d11, 'contamination', `${def.id}:${it.id}`, `${this.name(seat)}要在沒擦的${def.label}上處理${INGREDIENTS[it.type].label}——會被生肉汙染`, def.id, def.pos, true);
          }
        }
      }
    }
  }

  /* ============================== D09 單手廚師 ============================== */

  /** 雙手工序：沒有扶穩、沒有夾具就擋下；有的話照常（並用掉這次的扶穩） */
  twoHanded(seat: Seat, stationId: string, what: string): KitchenActionResult | null {
    const st = this.seats.get(seat);
    if (st?.flaw !== 'D09') return null;
    const t = this.sim.t;
    if ((st.clamps.get(stationId) ?? 0) > t) {
      this.log(seat, 'resolve', `${what}：用夾具固定`);
      return null;
    }
    const sd = this.steadies.find((x) => x.stationId === stationId && x.until > t && x.by !== seat && this.sim.inRange(x.by, stationId, this.cfg.D09.steadyRange + 1));
    if (sd) {
      this.steadies = this.steadies.filter((x) => x !== sd);
      this.log(seat, 'coop_ok', `${this.name(sd.by)}扶穩，完成${what}`);
      this.log(sd.by, 'coop_ok', `扶穩讓${this.name(seat)}${what}`);
      this.sim.emit({ kind: 'coop', text: `${this.name(seat)}趁你扶穩完成了${what}，謝謝。`, visual: 'steady_ok' }, sd.by);
      return null;
    }
    this.log(seat, 'trigger', `${what}需要雙手`, 'blocked');
    return warn(`${what}需要雙手：請隊友站在旁邊「幫忙扶穩」，或先用夾具固定（4 秒）。`);
  }

  setClamp(seat: Seat, stationId: string): string | null {
    const st = this.seats.get(seat);
    if (!st) return null;
    st.clamps.set(stationId, this.sim.t + this.cfg.D09.clampHoldMs);
    this.log(seat, 'resolve', `夾具固定 ${stationId}`);
    return `固定好了：${Math.round(this.cfg.D09.clampHoldMs / 1000)} 秒內可以在這裡做雙手工序。`;
  }

  private steady(seat: Seat, stationId: string): KitchenActionResult {
    const def = STATION_BY_ID[stationId];
    if (!def || (def.kind !== 'prep' && def.kind !== 'stove')) return warn('這裡沒有需要扶的東西。');
    if (!this.sim.inRange(seat, stationId, this.cfg.D09.steadyRange + 1)) return warn('站到工作站旁邊再扶。');
    const t = this.sim.t;
    const mine = this.steadies.find((x) => x.by === seat);
    if (mine && mine.stationId === stationId) {
      this.steadies = this.steadies.filter((x) => x !== mine);
      return info('放手。');
    }
    this.steadies = [...this.steadies.filter((x) => x.by !== seat), { by: seat, stationId, until: t + this.cfg.D09.steadyMs }];
    for (const d of this.anyWith('D09')) {
      if (d === seat) continue;
      this.sim.emit({ kind: 'coop', text: `${this.name(seat)}幫你扶穩了${def.label}（${Math.round(this.cfg.D09.steadyMs / 1000)} 秒）：現在可以做雙手工序。`, visual: 'steady', at: def.pos, critical: true }, d);
    }
    return ok(`扶穩${def.label}（${Math.round(this.cfg.D09.steadyMs / 1000)} 秒，走開就放手）。`);
  }

  /* ============================== D10 怕火廚師 ============================== */

  setGlove(seat: Seat): string | null {
    const st = this.seats.get(seat);
    if (!st) return null;
    st.gloveUntil = this.sim.t + this.cfg.D10.gloveHoldMs;
    this.log(seat, 'resolve', '戴上隔熱手套');
    return `戴好隔熱手套：${Math.round(this.cfg.D10.gloveHoldMs / 1000)} 秒內可以操作火源（最多中火）。`;
  }

  /* ============================== D08 小矮人 ============================== */

  setPeek(seat: Seat, stationId: string): string | null {
    const st = this.seats.get(seat);
    if (!st) return null;
    st.peeks.set(stationId, this.sim.t + this.cfg.D08.peekHoldMs);
    return `墊腳看到鍋裡了（${Math.round(this.cfg.D08.peekHoldMs / 1000)} 秒）。`;
  }

  /** 送給這位玩家的工作站狀態：小矮人看不到湯鍋裡面（除非剛墊腳看過） */
  stationsFor(seat: Seat, stations: Record<string, StationPublic>): Record<string, StationPublic> {
    const st = this.seats.get(seat);
    if (st?.flaw !== 'D08') return stations;
    const out = { ...stations };
    const t = this.sim.t;
    for (const [id, s] of Object.entries(stations)) {
      if (STATION_BY_ID[id]?.kind !== 'stove') continue;
      if ((st.peeks.get(id) ?? 0) > t) continue;
      out[id] = { id, items: [], plates: [], heat: s.heat, hidden: true };
    }
    return out;
  }

  /* ============================== D11 潔癖主廚 ============================== */

  onCleaned(seat: Seat, n: number): void {
    if (this.has(seat, 'D11')) this.advantage(seat, `洗了 ${n} 個碗盤`);
  }

  private hint(seat: Seat, kind: FlawHint['kind'], key: string, text: string, stationId: string | undefined, at: [number, number] | null, force = false): void {
    const st = this.seats.get(seat);
    if (!st) return;
    const t = this.sim.t;
    const repeat = kind === 'smell' ? this.cfg.D16.smellRepeatMs : this.cfg.D11.warnRepeatMs;
    if (!force && t - (st.hintLast.get(key) ?? -1e9) < repeat) return;
    st.hintLast.set(key, t);
    const h: FlawHint = { id: this.id('k'), kind, text, stationId, at, t };
    st.hints = [...st.hints, h].slice(-6);
    this.log(seat, 'trigger', text, 'advantage');
    this.sim.emit({ kind: 'flaw', text: `${kind === 'smell' ? '👃 ' : '🧼 '}${text}`, visual: kind, at: at ?? undefined, critical: true }, seat);
  }

  private tickCleanWarnings(): void {
    for (const seat of this.anyWith('D11')) {
      const pose = this.sim.pose(seat);
      if (!pose || this.sim.status(seat) !== 'ok') continue;
      const near = (p: [number, number]) => Math.hypot(pose.x - p[0], pose.z - p[1]) <= this.cfg.D11.warnRange;
      for (const s of this.sim.stations.values()) {
        if (!near(s.def.pos)) continue;
        if (s.def.kind === 'prep' && s.contaminated) this.hint(seat, 'contamination', `board:${s.def.id}`, `${s.def.label}碰過生肉還沒擦`, s.def.id, s.def.pos);
        for (const id of s.items) {
          const it = this.sim.items.get(id);
          if (!it) continue;
          if (it.contaminated && !isRawProtein(INGREDIENTS[it.type])) this.hint(seat, 'contamination', `item:${id}`, `${s.def.label}上的${INGREDIENTS[it.type].label}被生肉汙染了`, s.def.id, s.def.pos);
          if (it.floorDirty) this.hint(seat, 'contamination', `floor:${id}`, `${s.def.label}上的${INGREDIENTS[it.type].label}掉在地上過，還沒洗`, s.def.id, s.def.pos);
        }
      }
      for (const f of this.floor) if (near([f.x, f.z])) this.hint(seat, 'contamination', `fl:${f.id}`, `地上有${f.what}`, undefined, [f.x, f.z]);
    }
  }

  /* ============================== D06／D16：失衡、接住、掉落、撿起 ============================== */

  /** 伺服器接受了一次移動（速度、轉向角速度）：奶油手的失衡觸發 */
  onMove(seat: Seat, speed: number, turnRate: number): void {
    const st = this.seats.get(seat);
    if (!st) return;
    st.moveSpeed = speed;
    st.moveAt = this.sim.t;
    if (st.flaw !== 'D06') return;
    st.turn = st.turn * 0.5 + turnRate * 0.5;
    const c = this.cfg.D06;
    if (speed > c.runSpeed) this.startWobble(seat, st, 'run', c.windowMs);
    else if (st.turn > c.turnRate && speed > c.turnMinSpeed) this.startWobble(seat, st, 'turn', c.windowMs);
  }

  private startWobble(seat: Seat, st: SeatState, cause: WobblePublic['cause'], windowMs: number): void {
    const t = this.sim.t;
    const p = this.sim.players[seat];
    if (st.wobble || (cause !== 'sneeze' && t < st.wobbleCd) || p.task || this.sim.status(seat) !== 'ok') return;
    if (p.held?.kind !== 'item' && p.held?.kind !== 'plate') return;
    st.wobble = { until: t + windowMs, cause, held: JSON.stringify(p.held), slowSince: null };
    const why = { run: '跑太快', turn: '轉太急', lunge: '被怪物嚇到', sneeze: '打噴嚏', bump: '被撞到' }[cause];
    this.log(seat, 'trigger', `失衡（${why}）`);
    const what = this.sim.describeHeld(p.held);
    const how = cause === 'sneeze' ? '隊友可以接住' : cause === 'bump' && st.flaw !== 'D06' ? '馬上停下來穩住，或讓隊友接住' : '停下來、按 X 穩住，或讓隊友接住';
    this.sim.emit({ kind: 'flaw', text: `⚠ ${why}，手上的${what}快掉了！${how}（${(windowMs / 1000).toFixed(1)} 秒）`, visual: 'wobble', critical: true }, seat);
    const pose = this.sim.pose(seat);
    for (const other of this.seats.keys()) {
      if (other === seat || this.dist(seat, other) > 4) continue;
      this.sim.emit({ kind: 'coop', text: `${this.name(seat)}手上的${what}快掉了——靠近按 F 接住！`, visual: 'wobble_near', at: pose ? [pose.x, pose.z] : undefined, critical: true }, other);
    }
  }

  /**
   * 現在的移動速度：用最近一次被接受的移動（半秒視窗的平均），0.3 秒沒有移動＝靜止。
   * 沒有任何移動封包時（測試台）用位置提供的速度。
   */
  private speedNow(seat: Seat, st: SeatState): number {
    if (st.moveAt < 0) return this.sim.pose(seat)?.speed ?? 0;
    return this.sim.t - st.moveAt > 450 ? 0 : st.moveSpeed;
  }

  private endWobble(seat: Seat, st: SeatState, how: string, kind: FlawEvent['kind'] = 'resolve'): void {
    st.wobble = null;
    st.wobbleCd = this.sim.t + this.cfg.D06.cooldownMs;
    this.log(seat, kind, how);
  }

  private tickWobbles(): void {
    const t = this.sim.t;
    for (const [seat, st] of this.seats) {
      const w = st.wobble;
      if (!w) continue;
      const p = this.sim.players[seat];
      // 換手不算放下：東西還在任一隻手上就繼續晃
      if (!this.sim.inHands(seat, w.held)) {
        this.endWobble(seat, st, '手上的東西交出去或放下了');
        continue;
      }
      if (w.cause !== 'sneeze') {
        if (this.speedNow(seat, st) < this.cfg.D06.settleSpeed) {
          w.slowSince ??= t;
          if (t - w.slowSince >= this.cfg.D06.settleMs) {
            this.endWobble(seat, st, '停下來穩住了');
            this.sim.emit({ kind: 'flaw', text: '穩住了。', visual: 'wobble_ok' }, seat);
            continue;
          }
        } else w.slowSince = null;
      }
      if (t >= w.until) this.drop(seat, st);
    }
    // 怪物撲過來：奶油手嚇一跳
    const m = this.sim.threats?.public(this.sim).monster;
    if (m?.present && m.mode === 'windup') {
      for (const seat of this.anyWith('D06')) {
        const pose = this.sim.pose(seat);
        if (pose && Math.hypot(pose.x - m.x, pose.z - m.z) <= this.cfg.D06.lungeRange) this.startWobble(seat, this.seats.get(seat)!, 'lunge', this.cfg.D06.windowMs);
      }
    }
  }

  /** 被跑步的人撞到（任何人都會）：手上的東西晃一下，停下來就穩住 */
  bumpWobble(seat: Seat, windowMs = 1400): void {
    const st = this.seats.get(seat);
    if (st) this.startWobble(seat, st, 'bump', windowMs);
  }

  /** 物理系統：把手上的東西掉到地上（滑倒時）；at＝落點 */
  dropAt(seat: Seat, x: number, z: number, why: string): void {
    const p = this.sim.players[seat];
    const what = this.sim.describeHeld(p.held);
    const h = this.sim.dropHeld(seat);
    if (!h || (h.kind !== 'item' && h.kind !== 'plate')) return;
    this.floorPut(h, x, z, seat, what, why);
  }

  /** 物理系統：一樣東西落在地上（丟東西沒接到、滑倒時手上的東西）。蛋會破、液體與盤子裡的湯會灑成一灘水 */
  floorPut(h: NonNullable<Held>, x: number, z: number, by: Seat, what: string, why: string): void {
    if (h.kind !== 'item' && h.kind !== 'plate') return;
    const it = h.kind === 'item' ? this.sim.items.get(h.id) : undefined;
    if (it) {
      it.floorDirty = true;
      it.washed = false;
    }
    const at: [number, number] = [Math.round(x * 100) / 100, Math.round(z * 100) / 100];
    if (it && (it.type === 'egg' && it.cut === 'WHOLE')) {
      this.sim.items.delete(it.id);
      this.sim.physics.spill(at[0], at[1], 0.35, 'water');
      this.sim.emit({ kind: 'coop', text: `${why}：蛋摔破了。`, visual: 'drop', sound: 'drop', at }, 'all');
      return;
    }
    if (it && INGREDIENTS[it.type].liquid) {
      this.sim.items.delete(it.id);
      this.sim.physics.spill(at[0], at[1], 0.55, it.type === 'stock' ? 'soup' : 'water');
      this.sim.emit({ kind: 'coop', text: `${why}：${what}灑了一地，地上很滑。`, visual: 'drop', sound: 'drop', at }, 'all');
      return;
    }
    if (h.kind === 'plate') {
      const plate = this.sim.plates.get(h.id);
      if (plate) for (const c of plate.components) c.floorDirty = true;
      if (plate && (plate.liquid ?? 0) > 0) this.sim.physics.spill(at[0], at[1], 0.5, 'soup');
    }
    const f: FloorItem = { id: this.id('f'), kind: h.kind, ...(it ? { type: it.type } : {}), what, x: at[0], z: at[1], by, at: this.sim.t, held: h };
    this.floor.push(f);
    this.sim.emit({ kind: 'coop', text: `${why}：${what}掉在地上（按 X 撿起來；生的重新洗，煮過的只能丟）。`, visual: 'drop', sound: 'drop', at }, 'all');
  }

  /** 附近地上有沒有東西（物理系統判斷 X 是撿東西還是擦地） */
  floorNear(x: number, z: number): boolean {
    return this.floor.some((f) => Math.hypot(f.x - x, f.z - z) <= this.cfg.common.pickupRange);
  }

  private drop(seat: Seat, st: SeatState): void {
    // 晃的東西在另一隻手：掉的是那一樣
    const p0 = this.sim.players[seat];
    if (st.wobble && JSON.stringify(p0.held) !== st.wobble.held && JSON.stringify(p0.other) === st.wobble.held) this.sim.swapHands(seat);
    st.wobble = null;
    st.wobbleCd = this.sim.t + this.cfg.D06.cooldownMs;
    const p = this.sim.players[seat];
    const what = this.sim.describeHeld(p.held);
    const h = this.sim.dropHeld(seat);
    const pose = this.sim.pose(seat);
    this.log(seat, 'trigger', `掉了：${what}`, 'blocked');
    if (!h || (h.kind !== 'item' && h.kind !== 'plate') || !pose) return;
    const [fx, fz] = [-Math.sin(pose.yaw) * 0.45, -Math.cos(pose.yaw) * 0.45];
    const type = h.kind === 'item' ? this.sim.items.get(h.id)?.type : undefined;
    const f: FloorItem = { id: this.id('f'), kind: h.kind, ...(type ? { type } : {}), what, x: Math.round((pose.x + fx) * 100) / 100, z: Math.round((pose.z + fz) * 100) / 100, by: seat, at: this.sim.t, held: h };
    this.floor.push(f);
    this.sim.emit({ kind: 'flaw', text: `${what}掉到地上了。${h.kind === 'item' ? '生的撿起來重新洗就好；煮過的只能丟。' : '盤子裡的菜不能用了，倒掉後盤子拿去洗。'}（按 X 撿起來）`, visual: 'drop', sound: 'drop', at: [f.x, f.z], critical: true }, seat);
    for (const other of this.seats.keys()) if (other !== seat) this.sim.emit({ kind: 'coop', text: `${this.name(seat)}的${what}掉到地上了。`, visual: 'drop', sound: 'drop', at: [f.x, f.z], sense: 'sight' }, other);
  }

  private catchFor(seat: Seat, to: Seat | null): KitchenActionResult {
    if (!to || to === seat) return warn('要接誰的東西？');
    const st = this.seats.get(to);
    if (!st?.wobble) return warn('他手上的東西沒有在晃。');
    const me = this.sim.players[seat];
    const falling = JSON.parse(st.wobble.held) as Held;
    if (!this.sim.canReceive(seat, falling)) return warn('你兩隻手都拿著東西，接不住。');
    if (me.task) return warn('你正在忙。');
    if (this.dist(seat, to) > this.handoffRange(seat, to)) {
      this.log(seat, 'coop_fail', '接住：太遠');
      return warn('太遠了，接不到。');
    }
    const what = this.sim.describeHeld(falling);
    this.sim.receive(seat, this.sim.takeFromHands(to, st.wobble.held));
    st.wobble = null;
    st.wobbleCd = this.sim.t + this.cfg.D06.cooldownMs;
    this.log(seat, 'coop_ok', `接住${this.name(to)}的${what}`);
    this.log(to, 'coop_ok', `${this.name(seat)}接住了${what}`);
    this.sim.emit({ kind: 'coop', text: `${this.name(seat)}接住了你手上的${what}！`, visual: 'catch', critical: true }, to);
    return ok(`接住了${what}。`);
  }

  private grip(seat: Seat, st: SeatState): KitchenActionResult {
    if (st.flaw !== 'D06') return warn('你的手很穩。');
    const w = st.wobble;
    if (!w) return info('手上的東西很穩。');
    if (w.cause === 'sneeze') return warn('打噴嚏的時候穩不住。');
    const t = this.sim.t;
    if (t < st.gripCd) return warn(`還要 ${Math.ceil((st.gripCd - t) / 1000)} 秒才能再這樣穩住。`);
    if (this.speedNow(seat, st) > this.cfg.D06.gripMaxSpeed) return warn('跑這麼快穩不住：先放慢。');
    st.gripCd = t + this.cfg.D06.gripCooldownMs;
    this.endWobble(seat, st, '按 X 穩住');
    return ok('穩住了。');
  }

  private pickup(seat: Seat, floorId: string): KitchenActionResult {
    const f = this.floor.find((x) => x.id === floorId);
    if (!f) return warn('地上已經沒有這個東西了。');
    if (this.has(seat, 'D11')) return warn('地上的東西你不碰：請隊友撿。');
    if (!this.sim.canReceive(seat, f.held)) return warn('兩隻手都拿著東西，先放下一樣。');
    const pose = this.sim.pose(seat);
    if (!pose || Math.hypot(pose.x - f.x, pose.z - f.z) > this.cfg.common.pickupRange) return warn('走近一點再撿。');
    this.sim.receive(seat, f.held);
    this.floor = this.floor.filter((x) => x !== f);
    if (f.by !== seat) {
      this.log(seat, 'coop_ok', `幫忙撿起${f.what}`);
      this.log(f.by, 'coop_ok', `${this.name(seat)}撿起了${f.what}`);
    }
    return ok(`撿起${f.what}${f.kind === 'item' ? '（生的拿去水槽重新洗；煮過的只能丟）' : '（菜不能用了：倒掉後盤子會送去回收窗口）'}。`);
  }

  /* ============================== D16 定時噴嚏 ============================== */

  private tickSneeze(): void {
    const t = this.sim.t;
    const c = this.cfg.D16;
    for (const seat of this.anyWith('D16')) {
      const st = this.seats.get(seat)!;
      if (!st.sneezeWarned && t >= st.sneezeAt - c.warnMs) {
        st.sneezeWarned = true;
        this.sim.emit({ kind: 'flaw', text: `👃 鼻子好癢……${Math.round(c.warnMs / 1000)} 秒後會打噴嚏：先站好、放下量匙，或把東西交給隊友。`, visual: 'sneeze_warn', sound: 'sniff', critical: true }, seat);
      }
      if (t < st.sneezeAt) continue;
      st.sneezeWarned = false;
      // 時間跳過一大段（開發者工具跳過備料）時不要連打好幾個噴嚏：直接排到下一輪
      st.sneezeAt = t - st.sneezeAt > c.periodMs ? t + c.periodMs : st.sneezeAt + c.periodMs;
      const pose = this.sim.pose(seat);
      const p = this.sim.players[seat];
      this.log(seat, 'trigger', '打噴嚏');
      if (pose) this.sim.noise(pose.x, pose.z, 4, `sneeze:${seat}`);
      for (const other of this.seats.keys()) if (other !== seat) this.sim.emit({ kind: 'coop', sense: 'sound', text: `${this.name(seat)}打了個噴嚏。`, sound: 'sneeze', at: pose ? [pose.x, pose.z] : undefined }, other);
      if (p.held?.kind === 'measure') {
        const what = this.sim.describeHeld(p.held);
        p.held = null;
        this.log(seat, 'trigger', `噴嚏吹掉了${what}`, 'blocked');
        this.sim.emit({ kind: 'flaw', text: `哈啾！量匙裡的${what}全灑了。`, visual: 'sneeze', sound: 'sneeze', critical: true }, seat);
        continue;
      }
      if ((p.held?.kind === 'item' || p.held?.kind === 'plate') && this.speedNow(seat, st) > c.moveSpeed) {
        this.sim.emit({ kind: 'flaw', text: '哈啾！', visual: 'sneeze', sound: 'sneeze', critical: true }, seat);
        this.startWobble(seat, st, 'sneeze', c.windowMs);
        continue;
      }
      this.sim.emit({ kind: 'flaw', text: p.held ? '哈啾！——你站穩了，手上的東西沒事。' : '哈啾！', visual: 'sneeze', sound: 'sneeze', critical: true }, seat);
    }
  }

  /** 嗅覺：只來自真實存在的狀態（過熟、焦底、不新鮮、生肉味），只給提示、不給數值 */
  private tickSmell(): void {
    for (const seat of this.anyWith('D16')) {
      const pose = this.sim.pose(seat);
      if (!pose || this.sim.status(seat) !== 'ok') continue;
      const range = this.cfg.D16.smellRange;
      for (const s of this.sim.stations.values()) {
        if (Math.hypot(pose.x - s.def.pos[0], pose.z - s.def.pos[1]) > range) continue;
        const k = s.def.kind;
        if (k === 'pan' || k === 'stove' || k === 'toaster' || k === 'oven') {
          for (const id of s.items) {
            const it = this.sim.items.get(id);
            if (!it) continue;
            const cs = cookingState(it);
            if (cs === 'OVERCOOKED' || cs === 'BURNT') this.hint(seat, 'smell', `cook:${id}`, `${s.def.label}傳來焦味：${INGREDIENTS[it.type].label}可能${cs === 'BURNT' ? '已經燒焦' : '快燒焦了'}`, s.def.id, s.def.pos);
          }
          if (k === 'stove' && s.scorch > 0.5) this.hint(seat, 'smell', `scorch:${s.def.id}`, `${s.def.label}的鍋底有焦味`, s.def.id, s.def.pos);
        }
        if (k === 'prep' && s.contaminated) this.hint(seat, 'smell', `raw:${s.def.id}`, `${s.def.label}有生肉的味道（可能還沒擦）`, s.def.id, s.def.pos);
        for (const id of s.items) {
          const it = this.sim.items.get(id);
          if (it && freshnessState(it) !== 'FRESH') this.hint(seat, 'smell', `fresh:${id}`, `${s.def.label}上的${INGREDIENTS[it.type].label}聞起來可能不新鮮`, s.def.id, s.def.pos);
        }
      }
      const h = this.sim.players[seat].held;
      const it = h?.kind === 'item' ? this.sim.items.get(h.id) : undefined;
      if (it && freshnessState(it) !== 'FRESH') this.hint(seat, 'smell', `fresh:${it.id}`, `手上的${INGREDIENTS[it.type].label}聞起來可能不新鮮`, undefined, null);
    }
  }

  private smellAlert(seat: Seat, st: SeatState, hintId: string): KitchenActionResult {
    if (st.flaw !== 'D16') return warn('你沒有聞到什麼。');
    const t = this.sim.t;
    if (t < st.smellCd) return warn('慢一點，一次一個。');
    const h = st.hints.find((x) => x.id === hintId && x.kind === 'smell');
    if (!h) return warn('那個味道已經散了。');
    st.smellCd = t + this.cfg.D16.alertCooldownMs;
    if (h.stationId) this.mark(seat, h.stationId, 'GEST_DANGER');
    this.log(seat, 'trigger', '送出氣味警告', 'advantage');
    this.sim.emit({ kind: 'coop', text: `${this.name(seat)}聞到：${h.text}——去確認一下`, visual: 'smell', at: h.at ?? undefined, critical: true }, 'all');
    return ok('把氣味警告送給全隊。');
  }

  /* ============================== D05 大嗓門 ============================== */

  private rally(seat: Seat, st: SeatState, token?: SignalToken): KitchenActionResult {
    if (st.flaw !== 'D05') return warn('你的聲音沒那麼大。');
    const t = this.sim.t;
    if (t < st.rallyCd) return warn(`喉嚨還要 ${Math.ceil((st.rallyCd - t) / 1000)} 秒才能再喊。`);
    const pose = this.sim.pose(seat);
    if (!pose) return warn('你不在場上。');
    st.rallyCd = t + this.cfg.D05.rallyCooldownMs;
    const x = Math.round(pose.x * 10) / 10;
    const z = Math.round(pose.z * 10) / 10;
    this.rallies = [...this.rallies.filter((r) => r.by !== seat), { id: this.id('y'), by: seat, x, z, token, replies: [], at: t, expiresAt: t + this.cfg.D05.rallyMarkMs }];
    this.interference.push({ by: seat, x, z, r: this.cfg.D05.interfereRange, until: t + this.cfg.D05.interfereMs });
    this.sim.noise(x, z, 8, `rally:${seat}`);
    const where = zoneAt(x, z)?.label ?? '';
    this.log(seat, 'trigger', '召集', 'advantage');
    for (const other of this.seats.keys()) {
      if (other === seat) continue;
      this.sim.emit({ kind: 'coop', text: `📣 ${this.name(seat)}在${where}召集大家${token ? `：${TOKEN_LABEL[token]}` : '！'}`, visual: 'rally', at: [x, z], sound: 'rally', critical: true }, other);
    }
    return ok(`召集！全隊都收到了。接下來 ${Math.round(this.cfg.D05.interfereMs / 1000)} 秒，你身邊的人聽不清楚其他聲音。`);
  }

  private rallyReply(seat: Seat, rallyId: string, token: unknown): KitchenActionResult {
    const r = this.rallies.find((x) => x.id === rallyId && x.expiresAt > this.sim.t);
    if (!r) return warn('召集已經結束了。');
    if (!isSignalToken(token)) return warn('無效的符號。');
    if (r.by === seat) return warn('不能回應自己的召集。');
    r.replies = [...r.replies.filter((x) => x.by !== seat), { by: seat, token }];
    this.log(seat, 'coop_ok', '回應召集');
    this.log(r.by, 'coop_ok', `${this.name(seat)}回應召集`);
    this.sim.emit({ kind: 'coop', text: `${this.name(seat)}回應你的召集：${TOKEN_LABEL[token]}`, visual: 'mark_reply' }, r.by);
    return ok(`回應：${TOKEN_LABEL[token]}`);
  }

  /* ============================== D13：路線箭頭（任何人都能畫） ============================== */

  private route(seat: Seat, args: Record<string, unknown>): KitchenActionResult {
    const [x, z, yaw] = [Number(args.x), Number(args.z), Number(args.yaw)];
    if (![x, z, yaw].every(Number.isFinite)) return warn('位置不正確。');
    const pose = this.sim.pose(seat);
    if (!pose || Math.hypot(pose.x - x, pose.z - z) > 3) return warn('只能畫在你身邊。');
    const t = this.sim.t;
    const mine = this.routes.filter((r) => r.by === seat);
    if (mine.length >= this.cfg.common.routePerPlayer) this.routes = this.routes.filter((r) => r !== mine[0]);
    this.routes.push({ id: this.id('a'), by: seat, x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, yaw: Math.round(yaw * 100) / 100, expiresAt: t + this.cfg.common.routeTtlMs });
    if (this.anyWith('D13').some((d) => d !== seat)) this.log(seat, 'coop_ok', '畫路線箭頭');
    return ok('在地上畫了路線箭頭（30 秒）。');
  }

  /* ============================== D14 嗜睡學徒 ============================== */

  private drowsyState(st: SeatState): 'awake' | 'warn' | 'heavy' | 'asleep' {
    if (st.sleepUntil > this.sim.t) return 'asleep';
    if (st.drowsy >= this.cfg.D14.heavyAt) return 'heavy';
    if (st.drowsy >= this.cfg.D14.warnAt) return 'warn';
    return 'awake';
  }

  private workDrowsy(seat: Seat, st: SeatState, def: StationDef, action: string): void {
    const c = this.cfg.D14;
    const t = this.sim.t;
    const kind = def.kind;
    if (kind === 'pan' || kind === 'stove') {
      // 記住最近碰過的兩個爐具（雙爐）；親自操作會把被接管的爐子拿回來
      st.links = [def.id, ...st.links.filter((x) => x !== def.id)].slice(0, 2);
      const taker = this.takenBy.get(def.id);
      if (taker && this.sim.inRange(seat, def.id)) {
        this.takenBy.delete(def.id);
        this.sim.emit({ kind: 'coop', text: `${this.name(seat)}回來顧${def.label}了。`, visual: 'takeover_end' }, taker);
      }
    }
    if (action === 'taste' || action === 'probe') return;
    if (st.lastWorkKind === kind) this.addDrowsy(seat, st, c.sameWork);
    else {
      st.reliefs = st.reliefs.filter((x) => t - x < 30_000);
      if (st.lastWorkKind && st.reliefs.length < c.switchReliefPer30s) {
        st.reliefs.push(t);
        st.drowsy = Math.max(0, st.drowsy - c.switchRelief);
      }
      st.lastWorkKind = kind;
    }
  }

  private addDrowsy(seat: Seat, st: SeatState, n: number): void {
    const c = this.cfg.D14;
    const before = st.drowsy;
    st.drowsy = Math.min(c.sleepAt, st.drowsy + n);
    if (before < c.warnAt && st.drowsy >= c.warnAt && st.warned < 1) {
      st.warned = 1;
      this.log(seat, 'trigger', '打哈欠');
      this.sim.emit({ kind: 'flaw', text: '🥱 打了個大哈欠（睡意 60）：換個工作、去水槽洗把臉，或請隊友注意你。', visual: 'yawn', critical: true }, seat);
    }
    if (before < c.heavyAt && st.drowsy >= c.heavyAt && st.warned < 2) {
      st.warned = 2;
      this.log(seat, 'trigger', '眼皮很重');
      this.sim.emit({ kind: 'flaw', text: '😪 眼皮好重……（睡意 85）雙爐暫時不能用；再撐一下就會睡著。', visual: 'drowsy', critical: true }, seat);
      for (const other of this.seats.keys()) if (other !== seat) this.sim.emit({ kind: 'coop', text: `${this.name(seat)}快睡著了——拍拍他的肩膀。`, visual: 'drowsy_near', sense: 'sight' }, other);
    }
  }

  private fallAsleep(seat: Seat, st: SeatState): void {
    const t = this.sim.t;
    st.sleepUntil = t + this.cfg.D14.sleepMs;
    st.holdSince = null;
    this.sim.players[seat].task = null;
    this.log(seat, 'trigger', '睡著了', 'blocked');
    this.sim.emit({ kind: 'flaw', text: `💤 你睡著了（${Math.round(this.cfg.D14.sleepMs / 1000)} 秒）。爐子照常在煮——隊友可以拍肩叫醒你。`, visual: 'sleep', critical: true }, seat);
    for (const other of this.seats.keys()) if (other !== seat) this.sim.emit({ kind: 'coop', text: `💤 ${this.name(seat)}站著睡著了——走過去拍肩叫醒他，或接管他的爐子。`, visual: 'sleep_near', sense: 'sight' }, other);
  }

  private wake(seat: Seat, st: SeatState, by: Seat | null): void {
    st.sleepUntil = 0;
    st.drowsy = this.cfg.D14.wakeTo;
    st.warned = 0;
    if (by) {
      this.log(seat, 'coop_ok', `被${this.name(by)}叫醒`);
      this.log(by, 'coop_ok', `叫醒${this.name(seat)}`);
    } else this.log(seat, 'resolve', '自己醒來');
    this.sim.emit({ kind: 'flaw', text: by ? `${this.name(by)}把你拍醒了。` : '你醒過來了。', visual: 'wake', critical: true }, seat);
  }

  splash(seat: Seat): string | null {
    const st = this.seats.get(seat);
    if (!st || st.flaw !== 'D14') return null;
    st.drowsy = Math.max(0, st.drowsy - this.cfg.D14.splashRelief);
    st.splashCd = this.sim.t + this.cfg.D14.splashCooldownMs;
    st.warned = st.drowsy >= this.cfg.D14.warnAt ? st.warned : 0;
    this.log(seat, 'resolve', '洗把臉');
    return `冷水潑在臉上，清醒多了（睡意 ${Math.round(st.drowsy)}）。`;
  }

  private tickDrowsy(perSecond: boolean): void {
    const t = this.sim.t;
    const c = this.cfg.D14;
    for (const seat of this.anyWith('D14')) {
      const st = this.seats.get(seat)!;
      const status = this.sim.status(seat);
      if (st.sleepUntil > 0 && (t >= st.sleepUntil || status === 'trapped')) {
        this.wake(seat, st, null);
        continue;
      }
      if (st.sleepUntil > t || status !== 'ok' || this.sim.phase === 'CLOSED') continue;
      if (perSecond) this.addDrowsy(seat, st, c.perSecond);
      if (st.drowsy < c.sleepAt) {
        st.holdSince = null;
        continue;
      }
      // 端著盤子或怪物在追：撐一下（有上限）
      const held = this.sim.players[seat].held;
      const m = this.sim.threats?.public(this.sim).monster;
      const pose = this.sim.pose(seat);
      const danger = !!m?.present && (m.mode === 'chase' || m.mode === 'windup') && !!pose && Math.hypot(pose.x - m.x, pose.z - m.z) < 8;
      if ((held?.kind === 'plate' || danger) && (st.holdSince === null || t - st.holdSince < c.postponeMaxMs)) {
        if (st.holdSince === null) {
          st.holdSince = t;
          this.sim.emit({ kind: 'flaw', text: `你硬撐著不睡（最多 ${Math.round(c.postponeMaxMs / 1000)} 秒）——把盤子放下或交給隊友。`, visual: 'drowsy', critical: true }, seat);
        }
        continue;
      }
      this.fallAsleep(seat, st);
    }
  }

  /** 嗜睡學徒的遠端操作：清醒、在範圍內、是最近碰過的兩個爐具之一、沒有被接管 */
  remoteReach(seat: Seat, stationId: string): boolean {
    const st = this.seats.get(seat);
    if (st?.flaw !== 'D14' || !st.links.includes(stationId)) return false;
    if (st.sleepUntil > this.sim.t || st.drowsy >= this.cfg.D14.heavyAt) return false;
    if (this.takenBy.has(stationId)) return false;
    const def = STATION_BY_ID[stationId];
    const pose = this.sim.pose(seat);
    return !!def && !!pose && Math.hypot(pose.x - def.pos[0], pose.z - def.pos[1]) <= this.cfg.D14.dualRange;
  }

  private takeover(seat: Seat, stationId: string): KitchenActionResult {
    const def = STATION_BY_ID[stationId];
    if (!def || (def.kind !== 'pan' && def.kind !== 'stove')) return warn('只有爐具可以接管。');
    if (!this.sim.inRange(seat, stationId)) return warn('站到爐子前面再接管。');
    const owner = this.anyWith('D14').find((d) => d !== seat && this.seats.get(d)!.links.includes(stationId));
    if (!owner) return info('這個爐子沒有人在遠端照看，直接操作就好。');
    if (this.takenBy.get(stationId) === seat) {
      this.takenBy.delete(stationId);
      this.sim.emit({ kind: 'coop', text: `${this.name(seat)}把${def.label}交還給你。`, visual: 'takeover_end' }, owner);
      return info(`把${def.label}交還給${this.name(owner)}。`);
    }
    this.takenBy.set(stationId, seat);
    this.log(seat, 'coop_ok', `接管${this.name(owner)}的${def.label}`);
    this.log(owner, 'coop_ok', `${this.name(seat)}接管${def.label}`);
    this.sim.emit({ kind: 'coop', text: `${this.name(seat)}接管了你的${def.label}。`, visual: 'takeover', critical: true }, owner);
    return ok(`接管${def.label}：現在由你顧（${this.name(owner)}不能再遠端操作它，直到他親自回來）。`);
  }

  /** 開發者工具：讓嗜睡學徒快睡著、讓定時噴嚏快打噴嚏 */
  debug(cmd: 'sleepy' | 'sneeze_soon'): void {
    for (const st of this.seats.values()) {
      if (cmd === 'sleepy' && st.flaw === 'D14') st.drowsy = Math.max(st.drowsy, this.cfg.D14.sleepAt - 1);
      if (cmd === 'sneeze_soon' && st.flaw === 'D16') {
        st.sneezeAt = this.sim.t + this.cfg.D16.warnMs + 1000;
        st.sneezeWarned = false;
      }
    }
  }

  /* ============================== Phase B–D 的時間 ============================== */

  private tickBody(perSecond: boolean): void {
    const t = this.sim.t;
    this.tickWobbles();
    this.tickSneeze();
    this.tickDrowsy(perSecond);
    this.steadies = this.steadies.filter((x) => x.until > t && this.sim.inRange(x.by, x.stationId, this.cfg.D09.steadyRange + 1) && this.sim.status(x.by) === 'ok');
    this.rallies = this.rallies.filter((r) => r.expiresAt > t);
    this.interference = this.interference.filter((z) => z.until > t);
    this.routes = this.routes.filter((r) => r.expiresAt > t);
    if (!perSecond) return;
    this.tickCleanWarnings();
    this.tickSmell();
    for (const st of this.seats.values()) {
      for (const [id, until] of st.clamps) if (until <= t) st.clamps.delete(id);
      for (const [id, until] of st.peeks) if (until <= t) st.peeks.delete(id);
      st.hints = st.hints.filter((h) => t - h.t < 20_000);
    }
  }

  /* ============================== 時間 ============================== */

  tick(): void {
    const t = this.sim.t;
    // 交接逾時
    for (const h of this.handoffs) {
      if (t > h.expiresAt) {
        this.log(h.from, 'coop_fail', '交接逾時');
        this.log(h.to, 'coop_fail', '交接逾時');
      }
    }
    this.handoffs = this.handoffs.filter((h) => t <= h.expiresAt);
    this.marks = this.marks.filter((m) => m.expiresAt > t);
    this.tickRumors();
    const sec = Math.floor(t / 1000);
    const perSecond = sec !== this.lastSecond;
    this.tickBody(perSecond);
    if (!perSecond) return;
    this.lastSecond = sec;
    this.tickNotes();
    this.tickThermal();
    for (const [seat, st] of this.seats) {
      // 記憶淡掉（只影響這個人看到的資訊）
      for (const [id, until] of st.memory) {
        if (until <= t) {
          st.memory.delete(id);
          this.log(seat, 'trigger', '忘了一張單');
        }
      }
      for (const [id, until] of st.recited) if (until <= t) st.recited.delete(id);
      // 試吃回報過期與調味改變
      st.reports = st.reports.filter((r) => r.expiresAt > t);
      for (const r of st.reports) if (!r.stale && this.sim.tasteFingerprint(r.key) !== r.fp) r.stale = true;
      // 閒置時間（連線、可以行動、超過 10 秒沒有操作）
      const pose = this.sim.pose(seat);
      if (pose?.connected && this.sim.status(seat) === 'ok' && t - st.lastActionAt > 10_000) this.tel(st.flaw).idleSec++;
    }
  }
}

/* ============================== 文字 ============================== */

export function describeOrder(o: Pick<OrderPublic, 'kind' | 'recipeId' | 'requestId'>): string {
  if (o.kind === 'signature' && o.recipeId) return RECIPES[o.recipeId]?.name ?? '招牌菜';
  if (o.requestId) return `主廚委託「${FREE_REQUESTS[o.requestId]?.text ?? ''}」`;
  return '（不明）';
}

/** 真訂單洩漏的片段：只有菜名或關鍵食材其中之一，不含數量與特殊要求 */
function leakText(p: OrderPlan, idx: number): string {
  if (p.kind === 'signature' && p.recipeId) {
    const r = RECIPES[p.recipeId];
    if (idx % 4 === 0) return `好像有人點了「${r.name}」`;
    const main = r.components.find((c) => !c.optional && !INGREDIENTS[c.type].liquid) ?? r.components[0];
    return `聽到有人說「${INGREDIENTS[main.type].label}」`;
  }
  const q = FREE_REQUESTS[p.requestId ?? ''];
  if (q?.include?.length) return `好像有人想吃有「${INGREDIENTS[q.include[0]].label}」的`;
  const kw: Record<string, string> = { sour_sweet: '酸酸甜甜', light_soup: '清淡的湯', veggie: '不要肉' };
  return `聽到「${kw[p.requestId ?? ''] ?? q?.title ?? '主廚委託'}」`;
}

/** 核對為真之後的準備提示（全隊看得到） */
function prepHintText(p: OrderPlan): string {
  if (p.kind === 'signature' && p.recipeId) {
    const r = RECIPES[p.recipeId];
    const parts = r.components.filter((c) => !c.optional).map((c) => INGREDIENTS[c.type].label);
    return `即將有人點「${r.name}」：可以先準備 ${[...new Set(parts)].join('、')}`;
  }
  const q = FREE_REQUESTS[p.requestId ?? ''];
  return `即將有主廚委託：「${q?.text ?? ''}」`;
}

export { stationFront };
