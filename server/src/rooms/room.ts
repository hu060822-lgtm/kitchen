import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Server } from 'socket.io';
import {
  EYE_HEIGHT,
  LEVEL_BOUNDS,
  MAX_SPEED,
  PLAYER_RADIUS,
  DEFAULT_FLAW_CONFIG,
  MAX_PLAYERS,
  SEATS,
  SPAWNS,
  buildColliders,
  flawRadius,
  flawZoneBlocked,
  moveWithCollision,
  zoneAt,
  openDoors,
  type Box,
  type ClientToServerEvents,
  type DebugCommand,
  type DebugState,
  type FlawEffectConfig,
  type FlawId,
  type MarkPublic,
  type SignalToken,
  type FullSync,
  type KitchenActionPayload,
  type KitchenActionResult,
  type KitchenEvent,
  type KitchenPublic,
  type MovePayload,
  type PlayerActivity,
  type PlayerPose,
  type PlayerPublic,
  type PositionsMsg,
  type Seat,
  type RoomPhase,
  type RoomPublic,
  type ServerToClientEvents,
  NIGHT_COUNT,
  nightDef,
  endlessDay,
  type EndlessDay,
} from '@last-table/shared';
import { KitchenSim, type PoseView } from '../kitchen/sim';
import { restore, snapshot } from '../save/snapshot';
import { createThreats } from '../kitchen/threats';
import { Tutorial } from '../kitchen/tutorial';
import type { ThreatDirector } from '../kitchen/threats';

export type IO = Server<ClientToServerEvents, ServerToClientEvents>;

export interface PlayerRec {
  id: string;
  /** 重連憑證。只回給玩家本人，絕不放進任何廣播 */
  token: string;
  name: string;
  /** 席位（加入時自動分配，P1–P8） */
  role: Seat | null;
  /** 選的缺陷卡 */
  flaw: FlawId | null;
  socketId: string | null;
  connected: boolean;
  disconnectedAt: number | null;
  pose: PlayerPose;
  lastMoveAt: number;
  lastMoveRecvAt: number;
  /** 移動預算（公尺）：以 MAX_SPEED 的速率累積，每次移動扣除實際位移，避免用大量小封包加速 */
  moveBudget: number;
  budgetAt: number;
  lastSeq: number;
  lastCorrectAt: number;
  /** 最近一次被伺服器傳送（被抓走、被救出、躲進櫃子）的時間 */
  teleportAt: number;
  /** 由位置變化估計的速度（m/s，平滑），用來判斷跑步的腳步聲 */
  speed: number;
  /** 最近半秒的移動軌跡（缺陷卡用：網路抖動或畫面很慢時，速度也量得準） */
  trail: Array<{ t: number; x: number; z: number }>;
  lastSignalAt: number;
  voiceReady: boolean;
  micEnabled: boolean;
  body: BodyRec;
}

export interface BodyRec {
  crouch: boolean;
  act: PlayerActivity | null;
  hurt: number;
}

const newBody = (): BodyRec => ({ crouch: false, act: null, hurt: 0 });

export interface RoomOptions {
  prepSec: number;
  serviceSec: number;
  threats: boolean;
  /** 僅供測試：班次時鐘由測試手動推進（room.advance） */
  manualClock?: boolean;
  /** 僅供測試：放大伺服器接受的移動速度 */
  moveSpeedMultiplier?: number;
  debugTools?: boolean;
  seed?: number;
  flawConfig?: FlawEffectConfig;
  /** 開班前等每個人讀完操作說明才開始計時（測試可以關掉） */
  readyGate?: boolean;
  /** 房主模式（玩家自己的電腦開的房）：可以存檔、讀檔、暫停、用暱稱回到讀檔的位置 */
  hostMode?: boolean;
  /** 教學關「第一班」：一個人、不能加入、不存檔、沒有備料時間 */
  tutorial?: boolean;
}

/** 存檔裡房間本身的資料（玩家的連線、計時器等執行期資料不保存） */
export interface RoomSaveState {
  code: string;
  phase: RoomPhase;
  hostId: string;
  clockStarted: boolean;
  closedAnnounced: boolean;
  opts: { prepSec: number; serviceSec: number; threats: boolean; seed: number };
  /** 連續七晚的第幾晚（0／省略＝單班） */
  night?: number;
  /** 無盡模式的第幾天（0／省略＝不是無盡模式）與這一輪的種子 */
  endless?: number;
  endlessSeed?: number;
  /** 沒有怪物的模式 */
  noMonster?: boolean;
  players: Array<Pick<PlayerRec, 'id' | 'token' | 'name' | 'role' | 'flaw' | 'pose' | 'body'>>;
}

/** 模擬裡不保存的欄位：指回上層的參照、建構時的設定（讀檔時用同樣的設定重新建立） */
export const SIM_SKIP = new Set(['hooks', 'opts', 'sim', 'cfg', 'def']);

const BUDGET_CAP = 2.5;
const TELEPORT_GRACE_MS = 250;
const STEP_MS = 100;

const rid = (bytes: number) => randomBytes(bytes).toString('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = [...raw]
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      const control = c <= 0x1f || c === 0x7f;
      const invisible = (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || c === 0x2060 || c === 0xfeff;
      return !control && !invisible;
    })
    .join('')
    .trim();
  const chars = [...cleaned];
  if (chars.length < 1) return null;
  return chars.slice(0, 16).join('');
}

export class Room {
  readonly createdAt = Date.now();
  lastActivity = Date.now();
  phase: RoomPhase = 'LOBBY';
  readonly players = new Map<string, PlayerRec>();
  hostId = '';
  sim: KitchenSim | null = null;

  private colliderCache = new Map<string, { key: string; boxes: Box[] }>();
  private zoneNoticeAt = new Map<string, number>();
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private dirtyPositions = false;
  private clockAt = 0;
  private acc = 0;
  private stateEvery = 0;
  private closedAnnounced = false;
  /** 時鐘沒在走的原因：開班前、房主暫停、剛讀檔 */
  private waitWhy: 'start' | 'paused' | 'restored' = 'start';
  /** 這一局是從存檔讀回來的（房主模式） */
  restored = false;
  /** 最近一次存檔的時間 */
  savedAt: number | null = null;

  constructor(
    readonly code: string,
    private readonly io: IO,
    private readonly opts: RoomOptions,
  ) {}

  get channel(): string {
    return `room:${this.code}`;
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  /* ---------------------------- 玩家 ---------------------------- */

  get flawConfig(): FlawEffectConfig {
    return this.opts.flawConfig ?? DEFAULT_FLAW_CONFIG;
  }

  /** 第一個空著的席位 */
  freeSeat(): Seat | null {
    const used = new Set([...this.players.values()].map((p) => p.role));
    return SEATS.find((s) => !used.has(s)) ?? null;
  }

  addPlayer(name: string): PlayerRec {
    const seat = this.freeSeat() ?? 'P1';
    const spawn = SPAWNS[seat];
    const p: PlayerRec = {
      id: rid(4),
      token: rid(24),
      name,
      role: seat,
      flaw: null,
      socketId: null,
      connected: false,
      disconnectedAt: null,
      pose: { x: spawn.pos[0], y: EYE_HEIGHT, z: spawn.pos[2], yaw: spawn.yaw },
      lastMoveAt: Date.now(),
      lastMoveRecvAt: 0,
      moveBudget: BUDGET_CAP,
      budgetAt: Date.now(),
      lastSeq: 0,
      lastCorrectAt: 0,
      teleportAt: 0,
      speed: 0,
      trail: [],
      lastSignalAt: 0,
      voiceReady: false,
      micEnabled: false,
      body: newBody(),
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    return p;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    if (this.hostId === id) this.reassignHost();
  }

  byToken(token: string): PlayerRec | null {
    for (const p of this.players.values()) if (safeEqual(p.token, token)) return p;
    return null;
  }

  byRole(role: Seat): PlayerRec | null {
    for (const p of this.players.values()) if (p.role === role) return p;
    return null;
  }

  connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  reassignHost(): void {
    const connected = [...this.players.values()].find((p) => p.connected);
    const any = connected ?? [...this.players.values()][0];
    this.hostId = any?.id ?? '';
  }

  /* ---------------------------- 公開狀態 ---------------------------- */

  /** 1–8 位在線玩家，每人都選好缺陷卡（卡可以重複） */
  canStart(): boolean {
    if (this.players.size < 1 || this.players.size > MAX_PLAYERS) return false;
    for (const p of this.players.values()) if (!p.role || !p.connected || !p.flaw) return false;
    return true;
  }

  flawOf(seat: Seat): FlawId | null {
    return this.byRole(seat)?.flaw ?? null;
  }

  publicState(): RoomPublic {
    const players: PlayerPublic[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      flaw: p.flaw,
      connected: p.connected,
      isHost: p.id === this.hostId,
    }));
    const out: RoomPublic = { code: this.code, phase: this.phase, players, canStart: this.phase === 'LOBBY' && this.canStart(), waiting: this.waitingInfo() };
    if (this.opts.hostMode) {
      out.savedAt = this.savedAt;
      out.restored = this.restored;
    }
    if (this.opts.tutorial) out.tutorial = true;
    if (this.night) out.night = this.night;
    if (this.endless) out.endless = { day: this.endless, seed: this.endlessSeed };
    if (this.noMonster) out.noMonster = true;
    return out;
  }

  emitRoomState(): void {
    this.io.to(this.channel).emit('room:state', this.publicState());
  }

  /**
   * 廚房快照：共同的部分只算一次，再依每個人的缺陷卡加上個人狀態（self）
   * 與個人版本的訂單（健忘助手想不起來的單只剩桌號）。所以每位玩家收到的快照不同。
   */
  emitKitchen(): void {
    if (!this.sim) return;
    const base = this.sim.publicState();
    for (const p of this.players.values()) if (p.socketId && p.role) this.emitTo(p, 'kitchen:state', this.kitchenFor(p, base));
  }

  kitchenFor(p: PlayerRec, base = this.sim!.publicState()): KitchenPublic {
    if (!this.sim || !p.role) return base;
    return {
      ...base,
      stations: this.sim.flaws.stationsFor(p.role, base.stations),
      orders: this.sim.flaws.ordersFor(p.role, base.orders),
      self: this.sim.flaws.privateFor(p.role),
    };
  }

  fullSync(p: PlayerRec): FullSync {
    return {
      room: this.publicState(),
      kitchen: this.sim ? this.kitchenFor(p) : null,
      me: { id: p.id, role: p.role, isHost: p.id === this.hostId },
      flawConfig: this.flawConfig,
      pos: this.phase === 'LOBBY' ? null : { ...p.pose },
      debug: !!this.opts.debugTools,
      hostMode: !!this.opts.hostMode,
    };
  }

  emitTo<E extends keyof ServerToClientEvents>(p: PlayerRec, event: E, ...args: Parameters<ServerToClientEvents[E]>): void {
    if (!p.socketId) return;
    (this.io.to(p.socketId) as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args);
  }

  /**
   * 送出事件：先交給缺陷卡系統過濾（例如耳背砧板收不到聲音提示，也不會有替代文字），
   * 沒有任何內容可以送時就不送。危險事件（critical）不受過濾。
   */
  private deliver(e: KitchenEvent, to: Seat | 'all'): void {
    for (const p of this.players.values()) {
      if (!p.role || !p.socketId) continue;
      if (to !== 'all' && p.role !== to) continue;
      const out = this.sim ? this.sim.flaws.filterEvent(p.role, e) : e;
      if (!out || (!out.text && !out.sound && !out.visual)) continue;
      this.emitTo(p, 'kitchen:event', out);
    }
  }

  /* ---------------------------- 遊戲流程 ---------------------------- */

  /* ---------------------------- 開班前的準備 ---------------------------- */

  /** 讀完操作說明的人（玩家 id） */
  private readyIds = new Set<string>();
  /** 班次時鐘開始走了沒 */
  clockStarted = true;

  private waitingInfo(): RoomPublic['waiting'] {
    if (this.phase !== 'PLAYING' || this.clockStarted) return null;
    const need = [...this.players.values()].filter((p) => p.role && p.connected).map((p) => p.id);
    return { ready: need.filter((id) => this.readyIds.has(id)), need, why: this.waitWhy };
  }

  /** 玩家讀完操作說明 */
  markReady(p: PlayerRec): void {
    if (this.phase !== 'PLAYING' || this.clockStarted) return;
    this.readyIds.add(p.id);
    this.checkReady();
    this.emitRoomState();
  }

  /** 房主模式：暫停（大家再按一次準備好才繼續；斷線的人不擋） */
  pause(): boolean {
    if (this.phase !== 'PLAYING' || !this.clockStarted || !this.sim || this.sim.phase === 'CLOSED') return false;
    this.clockStarted = false;
    this.waitWhy = 'paused';
    this.readyIds.clear();
    this.sim.emit({ kind: 'phase', text: '房主暫停了班次：大家按「準備好了」就繼續。' }, 'all');
    this.emitRoomState();
    this.emitKitchen();
    return true;
  }

  /** 房主不等了 */
  forceStart(): void {
    if (this.phase !== 'PLAYING' || this.clockStarted) return;
    this.beginClock('房主決定開始。');
  }

  /** 在線的人都準備好了就開始（斷線的人不擋） */
  checkReady(): void {
    if (this.phase !== 'PLAYING' || this.clockStarted) return;
    const need = [...this.players.values()].filter((p) => p.role && p.connected);
    if (need.length && need.every((p) => this.readyIds.has(p.id))) this.beginClock(need.length > 1 ? '全員準備好了。' : '');
  }

  private beginClock(why: string): void {
    this.clockStarted = true;
    this.clockAt = Date.now();
    this.acc = 0;
    const resumed = this.waitWhy !== 'start';
    this.waitWhy = 'start';
    this.sim?.emit({ kind: 'phase', text: resumed ? `${why}繼續營業。`.trim() : `${why}開始計時：先備料。`.trim() }, 'all');
    this.emitRoomState();
    this.emitKitchen();
  }

  start(): void {
    this.disposeShift();
    this.phase = 'PLAYING';
    this.readyIds.clear();
    this.clockStarted = !this.opts.readyGate;
    const seats: Seat[] = [];
    const flaws: Partial<Record<Seat, FlawId>> = {};
    for (const p of this.players.values()) {
      if (!p.role) continue;
      seats.push(p.role);
      if (p.flaw) flaws[p.role] = p.flaw;
      const s = SPAWNS[p.role];
      p.pose = { x: s.pos[0], y: EYE_HEIGHT, z: s.pos[2], yaw: s.yaw };
      p.lastMoveAt = Date.now();
      p.budgetAt = Date.now();
      p.moveBudget = BUDGET_CAP;
      p.lastSeq = 0;
      p.speed = 0;
      p.body = newBody();
    }
    this.colliderCache.clear();
    this.closedAnnounced = false;
    this.waitWhy = 'start';
    this.restored = false;
    this.sim = this.createSim(seats.sort(), flaws);
    if (this.opts.threats) this.sim.threats = createThreats();
    this.applyNight(this.sim);
    if (this.noMonster) this.sim.threats?.disableMonster?.();
    if (this.opts.tutorial) {
      this.sim.tutorial = new Tutorial();
      this.sim.tutorial.begin(this.sim);
    }
    this.startLoop();
    this.emitRoomState();
    this.emitKitchen();
    for (const p of this.players.values()) if (p.role) this.emitTo(p, 'player:correct', { ...p.pose });
    this.broadcastPositions(true);
  }

  get tutorial(): boolean {
    return !!this.opts.tutorial;
  }

  /** 連續七晚的第幾晚（0＝單班）。大廳裡房主可以選；打烊後可以接著下一晚 */
  night = 0;

  setNight(n: number): string | null {
    if (this.tutorial) return '教學關不能選。';
    if (!Number.isInteger(n) || n < 0 || n > NIGHT_COUNT) return '沒有這一晚。';
    this.night = n;
    this.endless = 0;
    this.emitRoomState();
    return null;
  }

  /** 沒有怪物的模式（大廳裡房主選；那位客人照常） */
  noMonster = false;

  setNoMonster(v: boolean): string | null {
    if (this.tutorial) return '教學關不能選。';
    this.noMonster = v;
    this.emitRoomState();
    return null;
  }

  /** 無盡模式的第幾天（0＝不是無盡模式）；每一輪有自己的種子（抽到的考驗不同） */
  endless = 0;
  endlessSeed = 0;

  /** 大廳：選無盡模式（從第 1 天開始） */
  setEndless(): string | null {
    if (this.tutorial) return '教學關不能選。';
    this.night = 0;
    this.endless = 1;
    this.endlessSeed = 1 + randomInt(1_000_000);
    this.emitRoomState();
    return null;
  }

  /** 今天（無盡模式）的設定 */
  endlessToday(seats = this.sim?.seats.length ?? 3): EndlessDay | null {
    return this.endless ? endlessDay(this.endless, this.endlessSeed, seats) : null;
  }

  /** 這一天撐過了沒有（跑單沒有超過上限） */
  endlessPassed(): boolean {
    const today = this.endlessToday();
    return !!today && !!this.sim && this.sim.phase === 'CLOSED' && this.sim.stats.missed <= today.missLimit;
  }

  /** 打烊後（無盡模式）：撐過了 → 下一天；next=false → 從第 1 天重新開始一輪 */
  playEndless(next: boolean): string | null {
    if (!this.sim || this.sim.phase !== 'CLOSED') return '要等這一天打烊。';
    if (!this.endless) return '現在不是無盡模式。';
    if (next) {
      if (!this.endlessPassed()) return '這一天沒有撐過去：只能從第 1 天重新開始。';
      this.endless++;
    } else {
      this.endless = 1;
      this.endlessSeed = 1 + randomInt(1_000_000);
    }
    this.io.to(this.channel).emit('game:restarted');
    this.start();
    return null;
  }

  /** 打烊後：接著玩第 n 晚（下一晚，或重玩這一晚） */
  playNight(n: number): string | null {
    if (!this.sim || this.sim.phase !== 'CLOSED') return '要等這一班打烊。';
    const e = this.setNight(n);
    if (e) return e;
    // 用戶端把上一班的畫面清掉（開班前的說明、紙條），再開新的一班
    this.io.to(this.channel).emit('game:restarted');
    this.start();
    return null;
  }

  /** 每晚的變化：那位客人與後門的東西 */
  private applyNight(sim: KitchenSim): void {
    const def = this.endless ? this.endlessToday(sim.seats.length) : nightDef(this.night);
    const th = sim.threats as unknown as ThreatDirector | null;
    if (!def || !th || !('guest' in th)) return;
    th.guest.tune = { ...def.guest };
    th.monster.tune = { ...def.monster };
  }

  /** 用房間的設定建立廚房模擬（開新的一班、讀檔都用同一個方法，設定一致） */
  private createSim(seats: Seat[], flaws: Partial<Record<Seat, FlawId>>): KitchenSim {
    const today = this.endlessToday(seats.length);
    return new KitchenSim(
      {
        pose: (role) => this.poseView(role),
        name: (role) => this.byRole(role)?.name ?? `${role.slice(1)} 號`,
        teleport: (role, x, z, yaw) => this.teleport(role, x, z, yaw),
        event: (e, to) => {
          if (e.kind === 'monster_grab' && e.role) {
            const p = this.byRole(e.role);
            if (p) {
              p.body.hurt++;
              this.dirtyPositions = true;
            }
          }
          this.deliver(e, to);
        },
      },
      {
        prepMs: this.opts.prepSec * 1000,
        serviceMs: this.opts.serviceSec * 1000,
        // 每一晚的單（特餐、桌號）都不一樣
        seed: today ? (this.opts.seed ?? 1) + this.endlessSeed + today.day * 104_729 : (this.opts.seed ?? 1) + this.night * 7919,
        night: this.night,
        // 無盡模式：今天的考驗
        ...(today
          ? {
              scheduleOpts: { patience: today.patience, extra: today.extra },
              stockMul: today.stockMul,
              dishMul: today.dishMul,
              backLockBroken: today.backLockBroken,
              missLimit: today.missLimit,
            }
          : {}),
        seats,
        flaws,
        flawConfig: this.flawConfig,
        // 教學關：沒有排好的單，由教學導演一張一張出
        ...(this.opts.tutorial ? { schedule: [] } : {}),
      },
    );
  }

  /* ---------------------------- 存檔與讀檔（房主模式） ---------------------------- */

  /** 這個房間的完整狀態（只有遊戲進行中才有意義） */
  exportState(): { room: RoomSaveState; sim: ReturnType<typeof snapshot> } {
    if (this.phase !== 'PLAYING' || !this.sim) throw new Error('遊戲還沒開始，沒有東西可以存。');
    const room: RoomSaveState = {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      clockStarted: this.clockStarted,
      closedAnnounced: this.closedAnnounced,
      opts: { prepSec: this.opts.prepSec, serviceSec: this.opts.serviceSec, threats: this.opts.threats, seed: this.opts.seed ?? 1 },
      night: this.night,
      endless: this.endless,
      endlessSeed: this.endlessSeed,
      noMonster: this.noMonster,
      players: [...this.players.values()].map((p) => ({ id: p.id, token: p.token, name: p.name, role: p.role, flaw: p.flaw, pose: { ...p.pose }, body: { ...p.body } })),
    };
    return { room, sim: snapshot(this.sim, { skip: SIM_SKIP }) };
  }

  /**
   * 讀檔：用存檔裡的玩家與設定重新建立模擬，再把存檔的狀態疊回去。
   * 讀回來的班次先暫停（時鐘不走），等大家回來按「準備好了」（或房主決定不等）才繼續。
   */
  importState(state: { room: RoomSaveState; sim: ReturnType<typeof snapshot> }): void {
    const r = state.room;
    this.disposeShift();
    this.players.clear();
    const now = Date.now();
    for (const sp of r.players) {
      this.players.set(sp.id, {
        ...sp,
        pose: { ...sp.pose },
        body: { ...newBody(), ...sp.body, act: null },
        socketId: null,
        connected: false,
        disconnectedAt: now,
        lastMoveAt: now,
        lastMoveRecvAt: 0,
        moveBudget: BUDGET_CAP,
        budgetAt: now,
        lastSeq: 0,
        lastCorrectAt: 0,
        teleportAt: 0,
        speed: 0,
        trail: [],
        lastSignalAt: 0,
        voiceReady: false,
        micEnabled: false,
      });
    }
    this.hostId = r.hostId;
    this.phase = 'PLAYING';
    const seats: Seat[] = [];
    const flaws: Partial<Record<Seat, FlawId>> = {};
    for (const p of this.players.values()) {
      if (!p.role) continue;
      seats.push(p.role);
      if (p.flaw) flaws[p.role] = p.flaw;
    }
    this.night = Number.isInteger(r.night) && r.night! >= 0 && r.night! <= NIGHT_COUNT ? r.night! : 0;
    this.endless = Number.isInteger(r.endless) && r.endless! > 0 ? r.endless! : 0;
    this.endlessSeed = Number.isInteger(r.endlessSeed) ? r.endlessSeed! : 0;
    this.noMonster = !!r.noMonster;
    const sim = this.createSim(seats.sort(), flaws);
    if (this.opts.threats) sim.threats = createThreats();
    this.applyNight(sim);
    if (this.noMonster) sim.threats?.disableMonster?.();
    restore(sim, state.sim, { skip: SIM_SKIP });
    this.sim = sim;
    this.colliderCache.clear();
    this.closedAnnounced = r.closedAnnounced;
    this.readyIds.clear();
    this.clockStarted = sim.phase === 'CLOSED';
    this.waitWhy = 'restored';
    this.restored = true;
    this.startLoop();
  }

  restart(): void {
    this.disposeShift();
    this.phase = 'LOBBY';
    this.restored = false;
    this.waitWhy = 'start';
    this.io.to(this.channel).emit('game:restarted');
    this.emitRoomState();
  }

  private disposeShift(): void {
    this.sim = null;
    this.stopLoop();
  }

  dispose(): void {
    this.disposeShift();
  }

  private poseView(role: Seat): PoseView | null {
    const p = this.byRole(role);
    if (!p) return null;
    return { x: p.pose.x, z: p.pose.z, yaw: p.pose.yaw, crouch: p.body.crouch, connected: p.connected, speed: p.speed };
  }

  /** 伺服器權威的傳送（被抓進鐵籠、被救出、躲進／離開置物櫃） */
  teleport(role: Seat, x: number, z: number, yaw: number): void {
    const p = this.byRole(role);
    if (!p) return;
    const now = Date.now();
    p.pose = { x, y: EYE_HEIGHT, z, yaw };
    p.trail = [];
    p.moveBudget = BUDGET_CAP;
    p.budgetAt = now;
    p.lastCorrectAt = now;
    p.teleportAt = now;
    p.speed = 0;
    this.emitTo(p, 'player:correct', { ...p.pose, teleport: true });
    this.dirtyPositions = true;
  }

  /* ---------------------------- 班次時鐘 ---------------------------- */

  private startLoop(): void {
    if (this.loopTimer) return;
    this.clockAt = Date.now();
    this.acc = 0;
    this.loopTimer = setInterval(() => {
      if (!this.opts.manualClock) {
        const now = Date.now();
        // 開班前等大家讀完操作說明：時鐘不走（可以先走動熟悉操作）
        if (!this.clockStarted) this.clockAt = now;
        this.acc += Math.min(1000, now - this.clockAt);
        this.clockAt = now;
        while (this.acc >= STEP_MS) {
          this.acc -= STEP_MS;
          this.stepSim();
        }
      }
      this.decaySpeeds();
      this.broadcastPositions(false);
      if (++this.stateEvery >= 2) {
        this.stateEvery = 0;
        this.emitKitchen();
      }
    }, STEP_MS);
    this.loopTimer.unref?.();
  }

  private stopLoop(): void {
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = null;
  }

  private stepSim(): void {
    const sim = this.sim;
    if (!sim) return;
    sim.tick();
    for (const p of this.players.values()) {
      if (!p.role) continue;
      const busy = !!sim.players[p.role].task;
      const act: PlayerActivity | null = busy ? 'interact' : null;
      if (p.body.act !== act) {
        p.body.act = act;
        this.dirtyPositions = true;
      }
    }
    if (sim.threats) this.dirtyPositions = true;
    if (sim.phase === 'CLOSED' && !this.closedAnnounced) {
      this.closedAnnounced = true;
      this.emitKitchen();
    }
  }

  /** 測試用：手動推進班次時鐘 */
  advance(ms: number): void {
    for (let i = 0; i < Math.round(ms / STEP_MS); i++) this.stepSim();
    this.emitKitchen();
  }

  private decaySpeeds(): void {
    const now = Date.now();
    for (const p of this.players.values()) if (now - p.lastMoveAt > 300 && p.speed > 0) p.speed = 0;
  }

  /* ---------------------------- 位置 ---------------------------- */

  /** 碰撞盒（依缺陷卡：小矮人鑽得過窄縫、巨人過不了低門） */
  colliders(flaw: FlawId | null = null): Box[] {
    const doors = this.sim?.doors ?? openDoors();
    const blockers = this.sim?.threats?.blockers() ?? [];
    const key = JSON.stringify(doors) + blockers.map((b) => `${b.id}:${b.x.toFixed(1)},${b.z.toFixed(1)}`).join('|');
    const slot = flaw ?? '-';
    const hit = this.colliderCache.get(slot);
    if (hit?.key === key) return hit.boxes;
    const boxes = buildColliders(doors, blockers, flaw);
    this.colliderCache.set(slot, { key, boxes });
    return boxes;
  }

  /**
   * 驗證並套用玩家移動（伺服器權威）：速度過快、穿牆、超出地圖都會被拉回。
   * 被關在鐵籠或躲在置物櫃裡的人不能移動。
   */
  handleMove(p: PlayerRec, m: MovePayload): void {
    if (this.phase === 'LOBBY' || !p.role) return;
    const nums = [m.x, m.y, m.z, m.yaw, m.seq];
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    const now = Date.now();
    if (now - p.lastMoveRecvAt < 25) return;
    p.lastMoveRecvAt = now;
    if (m.seq <= p.lastSeq) return;
    p.lastSeq = m.seq;
    if (now - p.teleportAt < TELEPORT_GRACE_MS) return;
    const status = this.sim?.status(p.role) ?? 'ok';
    // 滑倒中：伺服器已經把人放到滑到的位置，畫面正在演滑行；這段時間的移動封包只取轉頭
    if (this.sim?.physics.frozen(p.role)) {
      p.pose = { ...p.pose, yaw: m.yaw };
      p.trail = [];
      p.budgetAt = now;
      return;
    }
    if (status !== 'ok' || this.sim?.flaws.frozen(p.role)) {
      // 只允許轉頭
      p.pose = { ...p.pose, yaw: m.yaw };
      if (Math.hypot(m.x - p.pose.x, m.z - p.pose.z) > 0.05 && now - p.lastCorrectAt > 400) {
        p.lastCorrectAt = now;
        this.emitTo(p, 'player:correct', { ...p.pose });
      }
      this.dirtyPositions = true;
      return;
    }

    // 缺陷卡的速度倍率（沉默侍者在餐廳較快）：以目前位置與手上的東西判定，與客戶端用同一個函式
    const flawMult = this.sim ? this.sim.flaws.speedMult(p.role, p.pose.x, p.pose.z, this.sim.players[p.role].held) : 1;
    const mult = (this.opts.moveSpeedMultiplier ?? 1) * flawMult;
    const elapsed = Math.min(2, Math.max(0, (now - p.budgetAt) / 1000));
    p.budgetAt = now;
    p.moveBudget = Math.min(BUDGET_CAP * mult, p.moveBudget + MAX_SPEED * mult * elapsed);

    const dist = Math.hypot(m.x - p.pose.x, m.z - p.pose.z);
    const B = LEVEL_BOUNDS;
    const outOfBounds = m.x < B.minX || m.x > B.maxX || m.z < B.minZ || m.z > B.maxZ;
    const tooFast = dist > p.moveBudget;
    const radius = flawRadius(p.flaw, this.flawConfig, PLAYER_RADIUS);
    const sweep = moveWithCollision(p.pose.x, p.pose.z, m.x, m.z, this.colliders(p.flaw), radius - 0.1);
    const inWall = Math.hypot(sweep.x - m.x, sweep.z - m.z) > 0.02;
    // 區域進入限制（幽閉外場不走進冷藏室）
    const zoneBlocked = flawZoneBlocked(p.flaw, zoneAt(p.pose.x, p.pose.z)?.id ?? null, zoneAt(m.x, m.z)?.id ?? null);
    if (zoneBlocked && this.sim && now - (this.zoneNoticeAt.get(p.id) ?? 0) > 3000) {
      this.zoneNoticeAt.set(p.id, now);
      this.sim.emit({ kind: 'flaw', text: '冷藏室太封閉了，你進不去。請隊友把食材放到冷藏室門口交接架。', visual: 'zone_block', critical: true }, p.role);
    }

    if (outOfBounds || tooFast || inWall || zoneBlocked) {
      if (process.env.MOVE_DEBUG) console.log('[move] reject', p.role, { from: p.pose, to: { x: m.x, z: m.z }, outOfBounds, tooFast, inWall, zoneBlocked, budget: p.moveBudget, dist });
      if (now - p.lastCorrectAt > 250) {
        p.lastCorrectAt = now;
        this.emitTo(p, 'player:correct', { ...p.pose });
      }
      return;
    }
    const dt = Math.max(0.03, (now - p.lastMoveAt) / 1000);
    p.speed = p.speed * 0.5 + (dist / dt) * 0.5;
    p.moveBudget -= dist;
    let dyaw = m.yaw - p.pose.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const turnRate = Math.abs(dyaw) / Math.max(0.05, dt);
    // 最近 0.6 秒內走過的路程 ÷ 經過時間（至少要 0.2 秒的樣本，避免兩個封包擠在一起時誤判）。
    // 畫面很慢、封包間隔超過 0.6 秒時，保留上一個樣本（1.2 秒內），速度一樣量得到
    const prevSample = p.trail[p.trail.length - 1];
    let kept = p.trail.filter((q) => now - q.t <= 600);
    if (!kept.length && prevSample && now - prevSample.t <= 1200) kept = [prevSample];
    p.trail = [...kept, { t: now, x: m.x, z: m.z }];
    let path = 0;
    for (let i = 1; i < p.trail.length; i++) path += Math.hypot(p.trail[i].x - p.trail[i - 1].x, p.trail[i].z - p.trail[i - 1].z);
    const span = (now - p.trail[0].t) / 1000;
    const windowSpeed = span >= 0.2 ? path / span : Math.min(p.speed, path / Math.max(span, 0.2));
    // 物理：擠進別人身體裡 → 拉回去；跑步撞到人 → 把對方推開；跑步踩到積水 → 滑倒
    // 速度：視窗平均或最近幾個封包的速度（剛從站著起跑時，視窗平均會偏低）
    const ph = this.sim?.physics.onMove(p.role, p.pose.x, p.pose.z, m.x, m.z, Math.max(windowSpeed, p.speed));
    if (ph?.block) {
      p.trail = kept;
      if (now - p.lastCorrectAt > 250) {
        p.lastCorrectAt = now;
        this.emitTo(p, 'player:correct', { ...p.pose });
      }
      return;
    }
    if (ph?.slide) {
      p.pose = { x: ph.slide.x, y: EYE_HEIGHT, z: ph.slide.z, yaw: m.yaw };
      p.trail = [];
      p.speed = 0;
      p.teleportAt = now;
      p.lastMoveAt = now;
      this.dirtyPositions = true;
      return;
    }
    p.pose = { x: m.x, y: EYE_HEIGHT, z: m.z, yaw: m.yaw };
    this.sim?.flaws.onMove(p.role, windowSpeed, turnRate);
    p.lastMoveAt = now;
    this.dirtyPositions = true;
  }

  broadcastPositions(force: boolean): void {
    if (!force && !this.dirtyPositions) return;
    this.dirtyPositions = false;
    const msg: PositionsMsg = {};
    for (const p of this.players.values()) {
      if (!p.role) continue;
      const b = p.body;
      msg[p.role] = { ...p.pose, ...(b.crouch ? { crouch: true } : {}), ...(b.act ? { act: b.act } : {}), ...(b.hurt ? { hurt: b.hurt } : {}) };
    }
    this.io.to(this.channel).emit('world:positions', msg);
  }

  setStance(p: PlayerRec, crouch: boolean): void {
    if (p.body.crouch !== crouch) {
      p.body.crouch = crouch;
      this.dirtyPositions = true;
    }
  }

  /* ---------------------------- 廚房 ---------------------------- */

  kitchenAction(p: PlayerRec, payload: KitchenActionPayload): KitchenActionResult {
    if (!this.sim || !p.role) return { ok: false, message: '遊戲還沒開始。', tone: 'warn' };
    return this.sim.handle(p.role, payload);
  }

  /** 標記（manager 已驗證冷卻與格式）：存進互助狀態（重連後仍在），並即時通知其他人 */
  mark(p: PlayerRec, targetId: string, token?: SignalToken): MarkPublic | string {
    if (!this.sim || !p.role) return '遊戲還沒開始。';
    const m = this.sim.flaws.mark(p.role, targetId, token);
    if (typeof m === 'string') return m;
    for (const other of this.players.values()) {
      if (other.id === p.id || !other.connected || !other.role) continue;
      this.emitTo(other, 'signal:marker', { id: m.id, from: m.from, targetId: m.targetId, token: m.token });
    }
    this.emitKitchen();
    return m;
  }

  /* ---------------------------- 開發者工具 ---------------------------- */

  debugState(): DebugState {
    const sim = this.sim;
    const d = sim?.threats?.debug() ?? { monster: null, guest: null };
    const roles: Record<string, Seat | null> = {};
    const flaws: Record<string, FlawId | null> = {};
    for (const p of this.players.values()) {
      roles[p.name] = p.role;
      flaws[p.name] = p.flaw;
    }
    return { phase: sim?.phase ?? 'LOBBY', t: sim?.t ?? 0, monster: d.monster, guest: d.guest, recent: sim ? [...sim.recent] : [], roles, flaws, telemetry: sim?.flaws.telemetrySnapshot() ?? {} };
  }

  debugCommand(cmd: DebugCommand, by: Seat | null = null): string | null {
    if (cmd === 'reinit_room') {
      this.start();
      return null;
    }
    const sim = this.sim;
    if (!sim) return '遊戲還沒開始。';
    switch (cmd) {
      case 'skip_prep':
        sim.skipPrep();
        break;
      case 'end_shift':
        sim.closeShift();
        break;
      case 'restock':
        sim.restockAll();
        break;
      case 'sleepy':
      case 'sneeze_soon':
        sim.flaws.debug(cmd);
        break;
      case 'monster_grab_me': {
        // 開發者工具：怪物出現在自己面前並撲上來（測試被抓的過場）
        if (!sim.threats || !by) return '這個房間沒有開啟恐怖系統。';
        const p = [...this.players.values()].find((q) => q.role === by);
        if (!p) return '找不到玩家。';
        (sim.threats as unknown as { grabTest(role: Seat, x: number, z: number, yaw: number, t: number): void }).grabTest(by, p.pose.x, p.pose.z, p.pose.yaw, sim.t);
        break;
      }
      case 'spill_here': {
        // 開發者工具：在自己面前 1.5 公尺灑一灘水（測試滑倒）
        const p = [...this.players.values()].find((q) => q.role === by);
        if (!p) return '找不到玩家。';
        sim.physics.spill(p.pose.x - Math.sin(p.pose.yaw) * 1.5, p.pose.z - Math.cos(p.pose.yaw) * 1.5, 0.55, 'water');
        break;
      }
      case 'spawn_guest':
      case 'guest_off':
      case 'spawn_monster':
      case 'monster_off':
        if (!sim.threats) return '這個房間沒有開啟恐怖系統。';
        (sim.threats as unknown as { command(c: string, t: number): void }).command(cmd, sim.t);
        break;
    }
    this.emitKitchen();
    return null;
  }

  /* ---------------------------- 語音狀態 ---------------------------- */

  voicePeers(except: PlayerRec): PlayerRec[] {
    return [...this.players.values()].filter((p) => p.id !== except.id && p.voiceReady && p.connected && p.role);
  }

}
