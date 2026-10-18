import { randomInt } from 'node:crypto';
import type { Socket } from 'socket.io';
import {
  FLAW_CARDS,
  MAX_PLAYERS,
  MAX_SIGNAL_LEN,
  SIGNAL_COOLDOWN_MS,
  filterForFlaw,
  isFlawId,
  isSeat,
  isSignalToken,
  voiceEdgeAllowed,
  type Ack,
  type FlawEffectConfig,
  type FlawId,
  type ClientToServerEvents,
  type DebugCommand,
  type KitchenActionPayload,
  type KitchenActionResult,
  type FullSync,
  type MovePayload,
  type Seat,
  type ServerToClientEvents,
  type SignalToken,
  type VoiceSignalPayload,
} from '@last-table/shared';
import { FailureLimiter, TokenBucket } from '../rateLimit';
import { validateAudioSdp, validateCandidate } from '../voice/sdp';
import { Room, sanitizeName, type IO, type PlayerRec, type RoomOptions } from './room';
import { SaveError, type SaveKind, type SaveStore } from '../save/store';

export interface ManagerConfig {
  prepSec: number;
  serviceSec: number;
  threats: boolean;
  /** 僅供測試：班次時鐘由測試推進 */
  manualClock?: boolean;
  /** 僅供測試 */
  moveSpeedMultiplier?: number;
  /** 開發者工具 */
  debugTools?: boolean;
  /** 訂單排程的種子 */
  seed?: number;
  /** 缺陷卡的效果數值 */
  flawConfig?: FlawEffectConfig;
  /** 開班前等每個人讀完操作說明才開始計時 */
  readyGate?: boolean;
  maxRooms: number;
  /** 房間內無人連線超過這段時間就回收 */
  roomIdleMs: number;
  /** 大廳中玩家斷線後保留位置的時間 */
  lobbyGraceMs: number;
  /** 房主離線超過這段時間，房主身分轉移給仍在線的玩家 */
  hostGraceMs: number;
  /** 房主模式（玩家自己的電腦開的房）：存檔、讀檔、暫停、用暱稱回到讀檔的位置 */
  hostMode?: boolean;
  /** 房主模式的存檔資料夾 */
  saveStore?: SaveStore;
  /** 自動存檔的間隔（毫秒；預設 30 秒） */
  autosaveMs?: number;
}

export const DEFAULT_CONFIG: ManagerConfig = {
  prepSec: 60,
  serviceSec: 420,
  threats: true,
  maxRooms: 200,
  roomIdleMs: 15 * 60_000,
  lobbyGraceMs: 20_000,
  hostGraceMs: 30_000,
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除容易混淆的 I O 0 1

interface SocketData {
  session?: { code: string; playerId: string };
  bucketGeneric: TokenBucket;
  bucketMove: TokenBucket;
  bucketVoice: TokenBucket;
  bucketCreate: TokenBucket;
  joinFailures: FailureLimiter;
}

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

function reply<T>(ack: unknown, payload: T): void {
  if (typeof ack === 'function') (ack as (p: T) => void)(payload);
}
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  /** 每個房間上次存檔時的班次時間（沒變就不重複存） */
  private readonly savedT = new Map<string, number>();
  /** 已經存過打烊存檔的房間 */
  private readonly closedSaved = new Set<string>();
  /** 存檔失敗的訊息（給啟動器顯示） */
  lastSaveError: string | null = null;

  constructor(
    private readonly io: IO,
    private readonly cfg: ManagerConfig = DEFAULT_CONFIG,
  ) {}

  attach(): void {
    this.io.on('connection', (raw) => this.onConnection(raw as unknown as GameSocket));
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
    if (this.cfg.saveStore) {
      this.autosaveTimer = setInterval(() => this.autosave(), this.cfg.autosaveMs ?? 30_000);
      this.autosaveTimer.unref?.();
    }
  }

  /* ---------------------------- 存檔（房主模式） ---------------------------- */

  /** 可以存檔的房間（遊戲進行中） */
  private savable(): Room[] {
    return [...this.rooms.values()].filter((r) => r.phase === 'PLAYING' && !!r.sim && !r.tutorial);
  }

  /** 存一個房間；失敗時記下原因，不讓遊戲當掉 */
  saveRoom(room: Room, kind: SaveKind): { file: string; savedAt: number } | null {
    const store = this.cfg.saveStore;
    if (!store || room.phase !== 'PLAYING' || !room.sim || room.tutorial) return null;
    try {
      const { file, meta } = store.write(room, kind);
      this.savedT.set(room.code, room.sim.t);
      room.savedAt = meta.savedAt;
      this.lastSaveError = null;
      room.emitRoomState();
      return { file, savedAt: meta.savedAt };
    } catch (e) {
      this.lastSaveError = (e as Error).message;
      console.error('[save]', e);
      return null;
    }
  }

  /** 自動存檔：班次時間有前進才存；打烊時另外存一份 */
  autosave(): void {
    for (const room of this.savable()) {
      const sim = room.sim!;
      if (sim.phase === 'CLOSED') {
        if (!this.closedSaved.has(room.code)) {
          this.closedSaved.add(room.code);
          this.saveRoom(room, 'closed');
        }
        continue;
      }
      this.closedSaved.delete(room.code);
      if (this.savedT.get(room.code) === sim.t) continue;
      this.saveRoom(room, 'auto');
    }
  }

  /** 所有進行中的房間都存一份（關閉程式時） */
  saveAll(kind: SaveKind = 'exit'): string[] {
    return this.savable()
      .map((r) => this.saveRoom(r, kind)?.file)
      .filter((f): f is string => !!f);
  }

  /**
   * 讀檔開房：用存檔建立房間（同樣的房間代碼與重連憑證）。
   * 回傳房主的重連資料，讓房主的視窗直接回到自己的位置。
   */
  loadSave(file: string): { code: string; token: string; playerId: string } {
    const store = this.cfg.saveStore;
    if (!store) throw new SaveError('這個伺服器沒有開啟存檔功能。');
    const save = store.read(file);
    const code = save.state.room.code;
    const old = this.rooms.get(code);
    if (old) {
      if (old.connectedCount() > 0) throw new SaveError(`房間 ${code} 正在進行中，不能讀檔覆蓋。`);
      old.dispose();
      this.rooms.delete(code);
    }
    const room = new Room(code, this.io, this.roomOptions());
    room.importState(save.state);
    room.savedAt = save.meta.savedAt;
    this.rooms.set(code, room);
    this.savedT.set(code, room.sim!.t);
    const host = room.players.get(room.hostId)!;
    return { code, token: host.token, playerId: host.id };
  }

  private roomOptions(): RoomOptions {
    return {
      prepSec: this.cfg.prepSec,
      serviceSec: this.cfg.serviceSec,
      threats: this.cfg.threats,
      manualClock: this.cfg.manualClock,
      seed: this.cfg.seed,
      moveSpeedMultiplier: this.cfg.moveSpeedMultiplier,
      debugTools: this.cfg.debugTools,
      flawConfig: this.cfg.flawConfig,
      readyGate: this.cfg.readyGate ?? true,
      hostMode: this.cfg.hostMode,
    };
  }

  close(): void {
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const r of this.rooms.values()) r.dispose();
    this.rooms.clear();
  }

  /* ---------------------------- 連線 ---------------------------- */

  private onConnection(socket: GameSocket): void {
    socket.data.bucketGeneric = new TokenBucket(30, 15);
    socket.data.bucketMove = new TokenBucket(60, 40);
    socket.data.bucketVoice = new TokenBucket(200, 100);
    socket.data.bucketCreate = new TokenBucket(5, 5 / 60);
    socket.data.joinFailures = new FailureLimiter(8, 60_000, 60_000);

    const guard = <A extends unknown[]>(fn: (...a: A) => void) => {
      return (...args: A) => {
        try {
          fn(...args);
        } catch (err) {
          console.error('[socket handler error]', err);
        }
      };
    };

    socket.on('room:create', guard((p, ack) => typeof p === 'function' ? this.onCreate(socket, undefined as never, p) : this.onCreate(socket, p, ack)));
    socket.on('room:night', guard((p, ack) => {
      const c = this.ctx(socket);
      if (!c) return reply(ack, fail('你不在房間裡。'));
      if (c.room.hostId !== c.player.id) return reply(ack, fail('只有房主可以選。'));
      const n = Number((p as { night?: unknown } | undefined)?.night);
      const start = !!(p as { start?: unknown } | undefined)?.start;
      // 無盡模式：大廳裡選（從第 1 天開始）；打烊後 next＝下一天，否則重新開始一輪
      if ((p as { endless?: unknown } | undefined)?.endless) {
        if (start) {
          const e = c.room.playEndless(!!(p as { next?: unknown }).next);
          return reply(ack, e ? fail(e) : { ok: true });
        }
        if (c.room.phase !== 'LOBBY') return reply(ack, fail('開班之後不能換。'));
        const e = c.room.setEndless();
        return reply(ack, e ? fail(e) : { ok: true });
      }
      if (start) {
        const e = c.room.playNight(n);
        return reply(ack, e ? fail(e) : { ok: true });
      }
      if (c.room.phase !== 'LOBBY') return reply(ack, fail('開班之後不能換。'));
      const e = c.room.setNight(n);
      reply(ack, e ? fail(e) : { ok: true });
    }));
    socket.on('room:options', guard((p, ack) => {
      const c = this.ctx(socket);
      if (!c) return reply(ack, fail('你不在房間裡。'));
      if (c.room.hostId !== c.player.id) return reply(ack, fail('只有房主可以選。'));
      if (c.room.phase !== 'LOBBY') return reply(ack, fail('開班之後不能換。'));
      const e = c.room.setNoMonster(!!(p as { noMonster?: unknown } | undefined)?.noMonster);
      reply(ack, e ? fail(e) : { ok: true });
    }));
    socket.on('room:tutorial', guard((p, ack) => typeof p === 'function' ? this.onTutorial(socket, { name: '' }, p) : this.onTutorial(socket, p, ack)));
    socket.on('room:join', guard((p, ack) => typeof p === 'function' ? this.onJoin(socket, undefined as never, p) : this.onJoin(socket, p, ack)));
    socket.on('room:rejoin', guard((p, ack) => typeof p === 'function' ? this.onRejoin(socket, undefined as never, p) : this.onRejoin(socket, p, ack)));
    socket.on('room:leave', guard((ack) => this.onLeave(socket, ack)));
    socket.on('room:selectFlaw', guard((p, ack) => typeof p === 'function' ? this.onSelectFlaw(socket, undefined as never, p) : this.onSelectFlaw(socket, p, ack)));
    socket.on('room:start', guard((ack) => this.onStart(socket, ack)));
    socket.on('room:restart', guard((ack) => this.onRestart(socket, ack)));
    socket.on('room:ready', guard((ack) => {
      const c = this.ctx(socket);
      if (!c || c.room.phase !== 'PLAYING') return reply(ack, fail('遊戲還沒開始。'));
      c.room.markReady(c.player);
      reply(ack, { ok: true });
    }));
    socket.on('room:forceStart', guard((ack) => {
      const c = this.ctx(socket);
      if (!c || c.room.phase !== 'PLAYING') return reply(ack, fail('遊戲還沒開始。'));
      if (c.room.hostId !== c.player.id) return reply(ack, fail('只有房主可以決定不等。'));
      c.room.forceStart();
      reply(ack, { ok: true });
    }));
    socket.on('room:pause', guard((ack) => {
      const c = this.ctx(socket);
      if (!this.cfg.hostMode) return reply(ack, fail('只有房主模式可以暫停。'));
      if (!c || c.room.phase !== 'PLAYING') return reply(ack, fail('遊戲還沒開始。'));
      if (c.room.hostId !== c.player.id) return reply(ack, fail('只有房主可以暫停。'));
      reply(ack, c.room.pause() ? { ok: true } : fail('現在不能暫停。'));
    }));
    socket.on('room:save', guard((ack) => {
      const c = this.ctx(socket);
      if (!this.cfg.saveStore) return reply(ack, fail('只有房主模式可以存檔。'));
      if (!c || c.room.phase !== 'PLAYING') return reply(ack, fail('遊戲還沒開始，沒有東西可以存。'));
      if (c.room.hostId !== c.player.id) return reply(ack, fail('只有房主可以存檔。'));
      const r = this.saveRoom(c.room, 'manual');
      reply(ack, r ? { ok: true, ...r } : fail(`存檔失敗：${this.lastSaveError ?? '未知的錯誤'}`));
    }));
    socket.on('player:move', guard((p) => this.onMove(socket, p)));
    socket.on('player:stance', guard((p) => this.onStance(socket, p)));
    socket.on('kitchen:action', guard((p, ack) => typeof p === 'function' ? this.onKitchenAction(socket, undefined as never, p) : this.onKitchenAction(socket, p, ack)));
    socket.on('signal:mark', guard((p, ack) => typeof p === 'function' ? this.onMark(socket, undefined as never, p) : this.onMark(socket, p, ack)));
    socket.on('debug:state', guard((ack) => this.onDebugState(socket, ack)));
    socket.on('debug:command', guard((p, ack) => typeof p === 'function' ? this.onDebugCommand(socket, undefined as never, p) : this.onDebugCommand(socket, p, ack)));
    socket.on('signal:emit', guard((p, ack) => typeof p === 'function' ? this.onSignal(socket, undefined as never, p) : this.onSignal(socket, p, ack)));
    socket.on('voice:ready', guard((p) => this.onVoiceReady(socket, p)));
    socket.on('voice:signal', guard((p) => this.onVoiceSignal(socket, p)));
    socket.on('disconnect', guard(() => this.onDisconnect(socket)));
  }

  /** 取得 socket 對應的房間與玩家（並確認這個 socket 仍是該玩家目前的連線） */
  private ctx(socket: GameSocket): { room: Room; player: PlayerRec } | null {
    const s = socket.data.session;
    if (!s) return null;
    const room = this.rooms.get(s.code);
    const player = room?.players.get(s.playerId);
    if (!room || !player || player.socketId !== socket.id) return null;
    room.touch();
    return { room, player };
  }

  private allow(socket: GameSocket): boolean {
    return socket.data.bucketGeneric.take();
  }

  private newCode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('無法產生房間代碼');
  }

  private bind(socket: GameSocket, room: Room, player: PlayerRec): void {
    const timer = this.graceTimers.get(player.id);
    if (timer) clearTimeout(timer);
    this.graceTimers.delete(player.id);

    player.socketId = socket.id;
    player.connected = true;
    player.disconnectedAt = null;
    void socket.join(room.channel);
    socket.data.session = { code: room.code, playerId: player.id };
    room.touch();
  }

  /** 這個 socket 目前如果綁著別的玩家，先放掉 */
  private unbind(socket: GameSocket): void {
    const s = socket.data.session;
    if (!s) return;
    const room = this.rooms.get(s.code);
    const player = room?.players.get(s.playerId);
    socket.data.session = undefined;
    if (!room || !player || player.socketId !== socket.id) return;
    void socket.leave(room.channel);
    if (room.phase === 'LOBBY') {
      this.removeFromLobby(room, player);
    } else {
      this.markDisconnected(room, player);
    }
  }

  /* ---------------------------- 房間 ---------------------------- */

  private onCreate(socket: GameSocket, p: { name: string }, ack: unknown): void {
    if (!socket.data.bucketCreate.take()) return reply(ack, fail('建立房間太頻繁，請稍後再試。'));
    const name = sanitizeName(p?.name);
    if (!name) return reply(ack, fail('請輸入暱稱（1–16 字）。'));
    if (this.rooms.size >= this.cfg.maxRooms) return reply(ack, fail('伺服器上的房間已滿，請稍後再試。'));

    this.unbind(socket);
    const room = new Room(this.newCode(), this.io, this.roomOptions());
    this.rooms.set(room.code, room);
    const player = room.addPlayer(name);
    this.bind(socket, room, player);
    reply(ack, {
      ok: true,
      roomCode: room.code,
      token: player.token,
      playerId: player.id,
      sync: room.fullSync(player),
    });
    room.emitRoomState();
  }

  /** 教學關：一個人開一間教學用的房間，直接開班（沒有缺陷卡、不能加入、不存檔） */
  private onTutorial(socket: GameSocket, p: { name: string }, ack: unknown): void {
    if (!socket.data.bucketCreate.take()) return reply(ack, fail('建立房間太頻繁，請稍後再試。'));
    const name = sanitizeName(p?.name) ?? '新來的廚師';
    if (this.rooms.size >= this.cfg.maxRooms) return reply(ack, fail('伺服器上的房間已滿，請稍後再試。'));
    this.unbind(socket);
    const room = new Room(this.newCode(), this.io, { ...this.roomOptions(), tutorial: true, threats: true, readyGate: false, prepSec: 5, serviceSec: 3600 });
    this.rooms.set(room.code, room);
    const player = room.addPlayer(name);
    this.bind(socket, room, player);
    room.start();
    reply(ack, { ok: true, roomCode: room.code, token: player.token, playerId: player.id, sync: room.fullSync(player) });
    room.emitRoomState();
  }

  private onJoin(socket: GameSocket, p: { name: string; code: string }, ack: unknown): void {
    if (socket.data.joinFailures.isBlocked()) return reply(ack, fail('嘗試次數過多，請稍後再試。'));
    const name = sanitizeName(p?.name);
    if (!name) return reply(ack, fail('請輸入暱稱（1–16 字）。'));
    const code = typeof p?.code === 'string' ? p.code.trim().toUpperCase() : '';
    const room = this.rooms.get(code);
    if (!room) {
      socket.data.joinFailures.fail();
      return reply(ack, { ok: false, error: '找不到這個房間。', reason: 'not_found' });
    }
    if (room.tutorial) {
      socket.data.joinFailures.fail();
      return reply(ack, fail('這是別人的教學關，不能加入。'));
    }
    if (room.phase !== 'LOBBY') {
      // 房主模式：用同樣的暱稱回到原本的位置（讀檔後、或換了網址之後重新加入）
      if (this.cfg.hostMode) {
        const seat = [...room.players.values()].find((x) => x.name === name && !x.connected);
        if (seat) {
          this.unbind(socket);
          socket.data.joinFailures.reset();
          this.bind(socket, room, seat);
          reply(ack, { ok: true, roomCode: room.code, token: seat.token, playerId: seat.id, sync: room.fullSync(seat) });
          room.emitRoomState();
          return;
        }
        const open = [...room.players.values()].filter((x) => !x.connected).map((x) => x.name);
        socket.data.joinFailures.fail();
        return reply(ack, fail(open.length ? `這一局已經開始。要回到原本的位置，請用同樣的暱稱加入（還沒回來的人：${open.join('、')}）。` : '這一局已經開始，而且每個位置都有人了。'));
      }
      socket.data.joinFailures.fail();
      return reply(ack, fail('遊戲已經開始。若你是房內的玩家，請從原本的瀏覽器重新連線。'));
    }
    if (room.players.size >= MAX_PLAYERS) return reply(ack, fail(`房間已滿（最多 ${MAX_PLAYERS} 人）。`));

    this.unbind(socket);
    socket.data.joinFailures.reset();
    const player = room.addPlayer(name);
    this.bind(socket, room, player);
    reply(ack, {
      ok: true,
      roomCode: room.code,
      token: player.token,
      playerId: player.id,
      sync: room.fullSync(player),
    });
    room.emitRoomState();
  }

  private onRejoin(socket: GameSocket, p: { code: string; token: string }, ack: unknown): void {
    if (socket.data.joinFailures.isBlocked()) return reply(ack, fail('嘗試次數過多，請稍後再試。'));
    const code = typeof p?.code === 'string' ? p.code.trim().toUpperCase() : '';
    const token = typeof p?.token === 'string' ? p.token : '';
    const room = this.rooms.get(code);
    const player = room && token ? room.byToken(token) : null;
    if (!room || !player) {
      socket.data.joinFailures.fail();
      return reply(ack, fail('房間已失效或憑證不正確。'));
    }
    socket.data.joinFailures.reset();

    const previous = player.socketId;
    this.unbind(socket);
    this.bind(socket, room, player);
    if (previous && previous !== socket.id) {
      const old = this.io.sockets.sockets.get(previous);
      if (old) {
        (old as unknown as GameSocket).data.session = undefined;
        old.disconnect(true);
      }
    }
    reply(ack, { ok: true, playerId: player.id, sync: room.fullSync(player) });
    room.emitRoomState();
  }

  private onLeave(socket: GameSocket, ack: unknown): void {
    this.unbind(socket);
    reply(ack, { ok: true });
  }

  private removeFromLobby(room: Room, player: PlayerRec): void {
    this.announceVoice(room, player, false);
    room.removePlayer(player.id);
    if (room.players.size === 0) {
      room.dispose();
      this.rooms.delete(room.code);
      return;
    }
    room.emitRoomState();
  }

  private markDisconnected(room: Room, player: PlayerRec): void {
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();
    player.voiceReady = false;
    player.micEnabled = false;
    this.announceVoice(room, player, false);
    // 開班前：斷線的人不擋，其他人都準備好就開始
    room.checkReady();
    room.emitRoomState();

    // 房主離線太久就轉移房主
    if (room.hostId === player.id) {
      const t = setTimeout(() => {
        if (!player.connected && room.hostId === player.id) {
          room.reassignHost();
          room.emitRoomState();
        }
      }, this.cfg.hostGraceMs);
      t.unref?.();
    }
  }

  private onDisconnect(socket: GameSocket): void {
    const s = socket.data.session;
    if (!s) return;
    const room = this.rooms.get(s.code);
    const player = room?.players.get(s.playerId);
    if (!room || !player || player.socketId !== socket.id) return;

    this.markDisconnected(room, player);
    if (room.phase === 'LOBBY') {
      // 大廳：寬限時間內沒回來就釋放位置
      const t = setTimeout(() => {
        this.graceTimers.delete(player.id);
        if (!player.connected && room.players.has(player.id) && room.phase === 'LOBBY') {
          this.removeFromLobby(room, player);
        }
      }, this.cfg.lobbyGraceMs);
      t.unref?.();
      this.graceTimers.set(player.id, t);
    }
  }

  /** 選缺陷卡：可以和別人重複；只能選這一版已經實作的卡 */
  private onSelectFlaw(socket: GameSocket, p: { flaw: FlawId | null }, ack: unknown): void {
    if (!this.allow(socket)) return reply(ack, fail('操作太頻繁。'));
    const c = this.ctx(socket);
    if (!c) return reply(ack, fail('尚未加入房間。'));
    const { room, player } = c;
    if (room.phase !== 'LOBBY') return reply(ack, fail('遊戲開始後不能更換缺陷卡。'));
    const flaw = p?.flaw ?? null;
    if (flaw !== null && !isFlawId(flaw)) return reply(ack, fail('無效的缺陷卡。'));
    if (flaw !== null && !FLAW_CARDS[flaw].available) return reply(ack, fail('這張卡還沒開放。'));
    if (player.flaw !== flaw) {
      const voiceChanged = (player.flaw === 'D04') !== (flaw === 'D04');
      player.flaw = flaw;
      if (voiceChanged) {
        this.announceVoice(room, player, false); // 能不能發話變了，語音連線要重新建立
        player.voiceReady = false;
      }
    }
    reply(ack, { ok: true });
    room.emitRoomState();
  }

  private onStart(socket: GameSocket, ack: unknown): void {
    const c = this.ctx(socket);
    if (!c) return reply(ack, fail('尚未加入房間。'));
    const { room, player } = c;
    if (room.hostId !== player.id) return reply(ack, fail('只有房主可以開始遊戲。'));
    if (room.phase !== 'LOBBY') return reply(ack, fail('遊戲已經開始。'));
    if (!room.canStart()) return reply(ack, fail(`需要 1–${MAX_PLAYERS} 位在線玩家，而且每個人都選好缺陷卡，才能開始。`));
    room.start();
    reply(ack, { ok: true });
  }

  private onRestart(socket: GameSocket, ack: unknown): void {
    const c = this.ctx(socket);
    if (!c) return reply(ack, fail('尚未加入房間。'));
    const { room, player } = c;
    if (room.hostId !== player.id) return reply(ack, fail('只有房主可以重新開始。'));
    if (room.phase === 'LOBBY') return reply(ack, fail('已經在大廳。'));
    room.restart();
    reply(ack, { ok: true });
  }

  /* ---------------------------- 遊玩 ---------------------------- */

  private onMove(socket: GameSocket, p: MovePayload): void {
    if (!socket.data.bucketMove.take()) return;
    const c = this.ctx(socket);
    if (!c || !p || typeof p !== 'object') return;
    c.room.handleMove(c.player, p);
  }

  /** 身體姿態：只接受兩個布林值；頻率限制與移動共用 */
  private onStance(socket: GameSocket, p: { crouch: boolean; panel: boolean }): void {
    if (!socket.data.bucketMove.take()) return;
    const c = this.ctx(socket);
    if (!c || !this.playing(c) || !p || typeof p !== 'object') return;
    c.room.setStance(c.player, p.crouch === true);
  }

  private playing(c: { room: Room; player: PlayerRec }): c is { room: Room & { sim: NonNullable<Room['sim']> }; player: PlayerRec & { role: Seat } } {
    return c.room.phase === 'PLAYING' && !!c.room.sim && !!c.player.role;
  }

  /** 工作站操作：驗證房間與身分後交給廚房模擬（再驗證距離、權限、狀態與 requestId 去重） */
  private onKitchenAction(socket: GameSocket, p: KitchenActionPayload, ack: unknown): void {
    const bad = (message: string): KitchenActionResult => ({ ok: false, tone: 'error', message });
    if (!this.allow(socket)) return reply(ack, bad('操作太頻繁。'));
    const c = this.ctx(socket);
    if (!c || !this.playing(c)) return reply(ack, bad('目前無法操作。'));
    if (!c.room.clockStarted) return reply(ack, { ok: false, tone: 'info', message: '等大家讀完操作說明、時鐘開始走之後才能操作（現在可以先走動熟悉一下）。' });
    if (!p || typeof p !== 'object' || typeof p.stationId !== 'string' || typeof p.action !== 'string' || typeof p.requestId !== 'string' || p.requestId.length > 64) {
      return reply(ack, bad('無效的操作。'));
    }
    const args = p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? p.args : {};
    reply(ack, c.room.kitchenAction(c.player, { stationId: p.stationId, action: p.action, args, requestId: p.requestId }));
  }

  /** 標記工具（所有人都能用）：指向一個工作站或一張訂單（`order:<id>`），可附一個符號 */
  private onMark(socket: GameSocket, p: { targetId: string; token?: SignalToken }, ack: unknown): void {
    const c = this.ctx(socket);
    if (!c || !this.playing(c)) return reply(ack, fail('目前無法使用標記工具。'));
    const targetId = typeof p?.targetId === 'string' && p.targetId.length <= 64 ? p.targetId : '';
    if (!targetId) return reply(ack, fail('無效的標記目標。'));
    if (p.token !== undefined && !isSignalToken(p.token)) return reply(ack, fail('無效的符號。'));
    const now = Date.now();
    if (now - c.player.lastSignalAt < SIGNAL_COOLDOWN_MS) return reply(ack, fail('信號器冷卻中。'));
    const m = c.room.mark(c.player, targetId, p.token);
    if (typeof m === 'string') return reply(ack, fail(m));
    c.player.lastSignalAt = now;
    reply(ack, { ok: true });
  }

  private debugAllowed(socket: GameSocket): ReturnType<RoomManager['ctx']> {
    if (!this.cfg.debugTools) return null;
    const c = this.ctx(socket);
    return c && this.playing(c) ? c : null;
  }

  private onDebugState(socket: GameSocket, ack: unknown): void {
    const c = this.debugAllowed(socket);
    if (!c) return reply(ack, fail('開發者工具未啟用。'));
    reply(ack, { ok: true, state: c.room.debugState() });
  }

  private onDebugCommand(socket: GameSocket, p: { cmd: DebugCommand }, ack: unknown): void {
    const c = this.debugAllowed(socket);
    if (!c) return reply(ack, fail('開發者工具未啟用。'));
    const cmds: DebugCommand[] = ['skip_prep', 'end_shift', 'spawn_guest', 'spawn_monster', 'monster_off', 'restock', 'reinit_room', 'sleepy', 'sneeze_soon', 'monster_grab_me', 'guest_off', 'spill_here'];
    if (!cmds.includes(p?.cmd)) return reply(ack, fail('未知的指令。'));
    const err = c.room.debugCommand(p.cmd, c.player.role ?? null);
    reply(ack, err ? fail(err) : { ok: true });
  }

  private onSignal(socket: GameSocket, p: { tokens: SignalToken[] }, ack: unknown): void {
    const c = this.ctx(socket);
    if (!c || !this.playing(c)) return reply(ack, fail('目前無法使用信號器。'));
    const raw = p?.tokens;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SIGNAL_LEN || !raw.every(isSignalToken)) {
      return reply(ack, fail('無效的訊號。'));
    }
    const now = Date.now();
    if (now - c.player.lastSignalAt < SIGNAL_COOLDOWN_MS) return reply(ack, fail('信號器冷卻中。'));
    c.player.lastSignalAt = now;

    const tokens = raw as SignalToken[];
    for (const other of c.room.players.values()) {
      if (other.id === c.player.id || !other.connected || !other.role) continue;
      // 依接收者的缺陷卡過濾（耳背砧板收不到敲擊）；完全感知不到就不送（避免洩漏「有人發了你感知不到的訊號」）
      const filtered = filterForFlaw(other.flaw, tokens);
      if (filtered.length === 0) continue;
      c.room.emitTo(other, 'signal:received', {
        from: c.player.role,
        tokens: filtered,
        originalLength: filtered.length,
        at: now,
      });
    }
    reply(ack, { ok: true });
  }

  /* ---------------------------- 語音 signaling ---------------------------- */

  /** 通知房內其他人：某位玩家的語音上線／離線 */
  private announceVoice(room: Room, player: PlayerRec, connected: boolean): void {
    if (!player.role) return;
    for (const other of room.players.values()) {
      if (other.id === player.id || !other.connected) continue;
      room.emitTo(other, 'voice:peer', { role: player.role, connected, micEnabled: connected && player.micEnabled });
    }
  }

  private onVoiceReady(socket: GameSocket, p: { micEnabled: boolean }): void {
    if (!socket.data.bucketVoice.take()) return;
    const c = this.ctx(socket);
    if (!c || !c.player.role) return;
    const { room, player } = c;
    player.voiceReady = true;
    player.micEnabled = !!p?.micEnabled;
    // 告訴別人我上線了；也告訴我誰已經在線
    this.announceVoice(room, player, true);
    for (const other of room.voicePeers(player)) {
      if (!other.role) continue;
      room.emitTo(player, 'voice:peer', { role: other.role, connected: true, micEnabled: other.micEnabled });
    }
  }

  /**
   * 語音 signaling 由伺服器驗證：
   *   - 雙方必須在同一房間、都有角色
   *   - 這條邊（發話者→接收者）必須符合語音規則（沉默侍者不能發話），否則直接丟棄
   *   - SDP 必須是單向、純音訊，方向正確
   */
  private onVoiceSignal(socket: GameSocket, p: VoiceSignalPayload): void {
    if (!socket.data.bucketVoice.take()) return;
    const c = this.ctx(socket);
    if (!c || !c.player.role) return;
    const me = c.player.role;
    if (!p || typeof p !== 'object' || !p.edge || !isSeat(p.to) || !isSeat(p.edge.from) || !isSeat(p.edge.to)) return;
    const { from, to } = p.edge;
    if (!voiceEdgeAllowed(from, to, (s) => c.room.flawOf(s))) return;

    let target: Seat;
    if (p.kind === 'offer') {
      if (me !== from || p.to !== to) return;
      if (!validateAudioSdp(p.sdp, 'offer').ok) return;
      target = to;
    } else if (p.kind === 'answer') {
      if (me !== to || p.to !== from) return;
      if (!validateAudioSdp(p.sdp, 'answer').ok) return;
      target = from;
    } else if (p.kind === 'ice') {
      if (me !== from && me !== to) return;
      const other = me === from ? to : from;
      if (p.to !== other) return;
      if (!validateCandidate(p.candidate)) return;
      target = other;
    } else {
      return;
    }

    const peer = c.room.byRole(target);
    if (!peer || !peer.connected) return;
    c.room.emitTo(peer, 'voice:signal', {
      from: me,
      to: target,
      edge: { from, to },
      kind: p.kind,
      sdp: p.kind === 'ice' ? undefined : p.sdp,
      candidate: p.kind === 'ice' ? p.candidate : undefined,
    });
  }

  /* ---------------------------- 回收 ---------------------------- */

  sweep(now: number = Date.now()): void {
    // 房主模式：房間就在房主自己的電腦上（有自動存檔），不回收進行中的房間
    if (this.cfg.hostMode) return;
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastActivity;
      if (room.connectedCount() === 0 && idle > this.cfg.roomIdleMs) {
        room.dispose();
        this.rooms.delete(code);
      } else if (now - room.createdAt > 8 * 3600_000) {
        this.io.to(room.channel).emit('room:closed', { reason: '房間已超過使用時限。' });
        room.dispose();
        this.rooms.delete(code);
      }
    }
  }

  /** 供測試取得完整同步資料 */
  syncFor(code: string, playerId: string): FullSync | null {
    const room = this.rooms.get(code);
    const p = room?.players.get(playerId);
    return room && p ? room.fullSync(p) : null;
  }
}

export type { Ack };
