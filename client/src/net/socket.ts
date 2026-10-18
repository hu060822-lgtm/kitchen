import { io, type Socket } from 'socket.io-client';
import {
  PHYSICS,
  STATION_BY_ID,
  TOKEN_LABEL,
  type Ack,
  type Blocker,
  type ClientToServerEvents,
  type DebugCommand,
  type DebugState,
  type FlawId,
  type FullSync,
  type KitchenActionResult,
  type KitchenEvent,
  type KitchenPublic,
  type Seat,
  type ServerToClientEvents,
  type SignalToken,
} from '@last-table/shared';
import { audio } from '../audio/engine';
import { setSpeechEnabled, speak, stopSpeech } from '../audio/speech';
import { applyPositions, clearRemotes } from '../game/remote';
import { setBody, setFrozen, setWorld, setYaw, snapTo, spawnFor, startSlide } from '../game/controller';
import { emit, type FxVisual } from '../game/bus';
import { noteLunge, noteTeleport, startAbduct } from '../game/abduct';
import { keyLabel, localizeKeys } from '../game/keymap';
import { myFlaw, nextId, useStore } from '../state/store';
import { voice } from '../voice/voice';
import { clearSession, loadSession, saveSession } from './session';
import { desktop } from '../platform';
import { recordFragment } from '../state/campaign';
import type { Session } from '../state/store';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? undefined;

export const socket: GameSocket = io(SERVER_URL ?? '/', {
  autoConnect: false,
  reconnection: true,
  reconnectionDelay: 600,
  reconnectionDelayMax: 4000,
});

let hadSession = false;

/**
 * 依缺陷卡套用呈現上的效果（實際的判定都在伺服器）：
 *   - 耳背砧板：環境聲與隊友語音又悶又小聲（伺服器本來就不會送聲音提示給他）
 *   - 沉默侍者：不建立發話連線（伺服器也會拒絕）
 * 語音播報是所有人都能開的無障礙選項。
 */
export function applyFlaw(role: Seat | null, flaw: FlawId | null): void {
  audio.setHearing(true);
  audio.setMuffled(flaw === 'D02', useStore.getState().flawConfig.D02.voiceGain);
  setSpeechEnabled(useStore.getState().prefs.speech);
  voice.configure(socket, role, flaw);
}

let appliedFlaw: string | null = null;
function reapplyFlaw(): void {
  const st = useStore.getState();
  const role = st.me?.role ?? null;
  const flaw = myFlaw();
  const key = `${role}|${flaw}`;
  if (key === appliedFlaw) return;
  appliedFlaw = key;
  applyFlaw(role, flaw);
}

/** 廚房狀態：碰撞（門、站在門口的客人、怪物）與自己能不能移動 */
function applyKitchen(k: KitchenPublic): void {
  const st = useStore.getState();
  st.set({ kitchen: k, kitchenAt: performance.now() });
  const b: Blocker[] = [];
  const g = k.threats.guest;
  if (g && (g.state === 'doorway' || g.state === 'kitchen')) b.push({ id: 'guest', x: g.x, z: g.z, r: 0.38 });
  const m = k.threats.monster;
  if (m?.present) b.push({ id: 'monster', x: m.x, z: m.z, r: 0.42 });
  setBody(myFlaw(), st.flawConfig);
  setWorld(k.doors, b);
  const role = st.me?.role;
  setFrozen(!!role && (k.players[role]?.status !== 'ok' || k.self?.drowsy?.state === 'asleep'));
  reapplyFlaw();
}

function applySync(sync: FullSync): void {
  const st = useStore.getState();
  st.set({ room: sync.room, me: sync.me, debug: !!sync.debug, hostMode: !!sync.hostMode, flawConfig: sync.flawConfig });
  if (sync.kitchen) applyKitchen(sync.kitchen);
  else st.set({ kitchen: null });
  appliedFlaw = null;
  reapplyFlaw();
  if (sync.pos) snapTo(sync.pos);
  else if (sync.me.role && sync.room.phase !== 'LOBBY') spawnFor(sync.me.role);
}

function enterSession(r: { roomCode: string; token: string; playerId: string; sync: FullSync }): void {
  const session = { code: r.roomCode, token: r.token, playerId: r.playerId };
  saveSession(session);
  hadSession = true;
  useStore.getState().set({ session, error: null });
  applySync(r.sync);
}

export function connectSocket(): void {
  if (socket.connected || socket.active) return;
  useStore.getState().set({ connecting: true });
  socket.connect();
}

function tryRejoin(): void {
  const s = useStore.getState().session ?? loadSession();
  if (!s) return;
  useStore.getState().set({ reconnecting: true });
  socket.emit('room:rejoin', { code: s.code, token: s.token }, (r) => {
    if (r.ok) {
      useStore.getState().set({ session: s, reconnecting: false, error: null });
      hadSession = true;
      applySync(r.sync);
      if (useStore.getState().room?.phase !== 'LOBBY') void voice.start();
    } else {
      clearSession();
      hadSession = false;
      voice.stop();
      useStore.getState().resetAll();
      useStore.getState().set({ reconnecting: false, error: '無法回到原本的房間（房間已關閉或憑證失效）。' });
    }
  });
}

/** 依事件種類決定通知的語氣 */
const TONE: Partial<Record<KitchenEvent['kind'], 'ok' | 'warn' | 'error' | 'info'>> = {
  order_new: 'info',
  order_missed: 'warn',
  served: 'ok',
  trapped: 'error',
  monster_grab: 'error',
  rescued: 'ok',
  guest_say: 'warn',
  guest_moved: 'warn',
  monster_sound: 'warn',
  fire_door: 'info',
  coop: 'info',
  flaw: 'warn',
};

/** 畫面上要有特別提示的互助／缺陷事件 */
const FLAW_SOUNDS: Record<string, () => void> = {
  tap: () => audio.tone(520, 0.08, { type: 'triangle', gain: 0.25 }),
  handoff: () => audio.tone(660, 0.1, { type: 'sine', gain: 0.22 }),
  handoff_ok: () => audio.uiOk(),
  handoff_fail: () => audio.uiWarn(),
  thermal: () => audio.uiWarn(),
  wobble: () => audio.uiWarn(),
  wobble_near: () => audio.tone(780, 0.12, { type: 'triangle', gain: 0.22 }),
  catch: () => audio.uiOk(),
  steady: () => audio.tone(600, 0.1, { type: 'sine', gain: 0.18 }),
  yawn: () => audio.tone(220, 0.6, { type: 'sine', gain: 0.12, slideTo: 160 }),
  drowsy: () => audio.uiWarn(),
  sleep: () => audio.tone(180, 0.9, { type: 'sine', gain: 0.15, slideTo: 120 }),
  wake: () => audio.uiOk(),
  sneeze_warn: () => audio.uiWarn(),
  zone_block: () => audio.uiWarn(),
  contamination: () => audio.uiWarn(),
  smell: () => audio.tone(880, 0.1, { type: 'sine', gain: 0.15 }),
  takeover: () => audio.tone(540, 0.12, { type: 'triangle', gain: 0.2 }),
};
/** 缺陷卡的視覺事件 → 畫面效果（震動） */
const FLAW_FX: Record<string, 'shake'> = { wobble: 'shake', drop: 'shake', sneeze: 'shake', slip: 'shake', bump: 'shake', catch: 'shake' };

function onKitchenEvent(e: KitchenEvent): void {
  const st = useStore.getState();
  // 連續七晚：出單機印出的故事（紙條），收進營業日誌
  if (e.kind === 'story' && e.story) {
    st.set({ storySlip: e.story });
    if (!e.story.ending) recordFragment(e.story.night);
  }
  if (e.sound?.startsWith('rumor:')) audio.rumor(Number(e.sound.slice(6)) || 1);
  else if (e.sound) audio.kitchenSound(e.sound, e.at ?? null);
  if (e.visual === 'lunge') noteLunge();
  // 滑倒：伺服器已經決定滑到哪裡，這裡演出滑行與跌坐
  if (e.visual === 'slip' && e.at && e.critical) startSlide(e.at[0], e.at[1], PHYSICS.slip.ms);
  if (e.kind === 'monster_grab' && e.role && e.role === st.me?.role) {
    startAbduct(e.at);
    audio.abduct();
  }
  if (e.visual) {
    if (e.kind === 'monster_grab' && e.role === st.me?.role) return void (e.text && st.pushNotice({ tone: 'error', text: `你被拖進冷藏室的鐵籠了。按 ${keyLabel('interact')} 自己搖開鐵籠，或等隊友來撬開。` }, 8000));
    emit('fx', { visual: (FLAW_FX[e.visual] ?? e.visual) as FxVisual, at: e.at });
    FLAW_SOUNDS[e.visual]?.();
  }
  if (e.text) {
    const quiet = e.kind === 'phase' && !e.sound && !e.visual;
    st.pushNotice({ tone: TONE[e.kind] ?? 'info', text: e.text }, quiet ? 3500 : 6000);
    // 語音播報（無障礙選項）；客人說的話打斷其他播報
    speak(e.text, { interrupt: e.kind === 'guest_say' || e.kind === 'monster_grab' });
  }
}

export function initNetwork(): void {
  socket.on('connect', () => {
    resetStance();
    useStore.getState().set({ connected: true, connecting: false });
    if (hadSession || loadSession()) tryRejoin();
  });
  socket.on('disconnect', () => {
    useStore.getState().set({ connected: false, reconnecting: hadSession });
  });
  socket.on('connect_error', () => {
    useStore.getState().set({ connecting: false, connected: false });
  });

  socket.on('room:state', (room) => {
    const st = useStore.getState();
    const mine = room.players.find((p) => p.id === st.session?.playerId || p.id === st.me?.id);
    st.set({ room, me: mine ? { id: mine.id, role: mine.role, isHost: mine.isHost } : st.me });
    const role = mine?.role ?? null;
    reapplyFlaw();
    if (st.room?.phase === 'LOBBY' && room.phase === 'PLAYING' && role) {
      clearRemotes();
      spawnFor(role);
      resetStance();
    }
    if (room.phase === 'LOBBY') stopSpeech();
  });

  socket.on('kitchen:state', (k) => applyKitchen(k));
  socket.on('kitchen:event', (e) => onKitchenEvent(e));

  socket.on('signal:marker', (m) => {
    const st = useStore.getState();
    st.pushMarker({ from: m.from, targetId: m.targetId, token: m.token });
    const s = STATION_BY_ID[m.targetId];
    audio.marker(s ? s.pos : null);
    const who = st.room?.players.find((p) => p.role === m.from)?.name ?? m.from;
    const what = s ? s.label : m.targetId.startsWith('order:') ? '一張單' : m.targetId;
    st.pushNotice({ tone: 'info', text: `${who}標記了${what}${m.token ? `：${TOKEN_LABEL[m.token]}` : ''}` }, 4000);
    speak(`${who}標記了${what}`);
  });

  socket.on('world:positions', (msg) => applyPositions(msg, useStore.getState().me?.role ?? null));
  socket.on('player:correct', (p) => {
    // 被抓走：先記下原本的位置（過場從那裡演），不另外播黑幕
    const grabbed = p.teleport ? noteTeleport() : false;
    snapTo(p);
    if (p.teleport) {
      setYaw(p.yaw);
      if (!grabbed) emit('fx', { visual: 'shift' });
    }
  });

  socket.on('signal:received', (s) => {
    useStore.getState().pushSignal(s);
    audio.signalTokens(s.tokens);
  });

  socket.on('notice', (n) => {
    useStore.getState().pushNotice(n);
    if (n.tone === 'error') audio.uiError();
    else if (n.tone === 'warn') audio.uiWarn();
    else audio.notice();
    speak(n.text);
  });

  socket.on('room:closed', (p) => {
    clearSession();
    hadSession = false;
    voice.stop();
    useStore.getState().resetAll();
    useStore.getState().set({ error: p.reason });
    if (document.pointerLockElement) document.exitPointerLock();
  });

  socket.on('game:restarted', () => {
    clearRemotes();
    voice.stop(true);
    audio.stopAmbient();
    stopSpeech();
    useStore.getState().resetGame();
    if (document.pointerLockElement) document.exitPointerLock();
  });

  socket.on('voice:signal', (m) => void voice.onSignal(m));
  socket.on('voice:peer', (p) => voice.onPeer(p));

  if (loadSession()) {
    useStore.getState().set({ reconnecting: true });
    connectSocket();
  }
}

/* ---------------------------- 請求 ---------------------------- */

const call = <T>(fn: (cb: (r: T) => void) => void, timeoutMs = 8000): Promise<T | { ok: false; error: string }> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: '伺服器沒有回應。' }), timeoutMs);
    fn((r) => {
      clearTimeout(t);
      resolve(r);
    });
  });

async function ensureConnected(): Promise<boolean> {
  if (socket.connected) return true;
  connectSocket();
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 6000);
    socket.once('connect', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

export async function createRoom(name: string): Promise<string | null> {
  if (!(await ensureConnected())) return '無法連上伺服器。';
  const r = await call<Ack<{ roomCode: string; token: string; playerId: string; sync: FullSync }>>((cb) => socket.emit('room:create', { name }, cb));
  if (!r.ok) return r.error;
  enterSession(r);
  return null;
}

/** 連續七晚：大廳裡選第幾晚（0＝單班） */
export async function setNight(night: number): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:night', { night }, cb));
  return r.ok ? null : r.error;
}

/** 連續七晚：打烊後接著玩第 n 晚 */
export async function playNight(night: number): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:night', { night, start: true }, cb));
  return r.ok ? null : r.error;
}

/** 無盡模式：大廳裡選（從第 1 天開始） */
export async function setEndless(): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:night', { night: 0, endless: true }, cb));
  return r.ok ? null : r.error;
}

/** 無盡模式：打烊後 next＝下一天（要撐過今天），否則從第 1 天重新開始一輪 */
export async function playEndless(next: boolean): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:night', { night: 0, endless: true, start: true, next }, cb));
  return r.ok ? null : r.error;
}

/** 教學關「第一班」：一個人開一間教學用的房間，直接開班 */
export async function startTutorial(name: string): Promise<string | null> {
  if (!(await ensureConnected())) return '無法連上伺服器。';
  const r = await call<Ack<{ roomCode: string; token: string; playerId: string; sync: FullSync }>>((cb) => socket.emit('room:tutorial', { name }, cb));
  if (!r.ok) return r.error;
  enterSession(r);
  return null;
}

/** 教學關：確認目前的步驟（讀完說明、打開了訂單板／食譜）。不顯示任何通知 */
export function tutorialAck(step: string): void {
  socket.emit('kitchen:action', { stationId: 'tutorial', action: 'ack', args: { step }, requestId: newRequestId() }, () => undefined);
}

export async function joinRoom(name: string, code: string): Promise<string | null> {
  return (await joinRoomDetailed(name, code)).error;
}

/** 加入這台伺服器上的房間；notFound＝這台伺服器沒有這個房間（可以去房間代碼查詢處找） */
export async function joinRoomDetailed(name: string, code: string): Promise<{ error: string | null; notFound: boolean }> {
  if (!(await ensureConnected())) return { error: '無法連上伺服器。', notFound: false };
  const r = await call<Ack<{ roomCode: string; token: string; playerId: string; sync: FullSync }>>((cb) =>
    socket.emit('room:join', { name, code: code.trim().toUpperCase() }, cb),
  );
  if (!r.ok) return { error: r.error, notFound: 'reason' in r && r.reason === 'not_found' };
  enterSession(r);
  return { error: null, notFound: false };
}

/** 讀檔之後：用存檔裡房主的憑證回到原本的位置 */
export async function resumeSession(s: Session): Promise<void> {
  saveSession(s);
  useStore.getState().set({ session: s });
  if (socket.connected) tryRejoin();
  else {
    useStore.getState().set({ reconnecting: true });
    connectSocket();
  }
}

export function leaveRoom(): void {
  socket.emit('room:leave', () => undefined);
  clearSession();
  hadSession = false;
  voice.stop();
  audio.stopAmbient();
  stopSpeech();
  clearRemotes();
  useStore.getState().resetAll();
  if (document.pointerLockElement) document.exitPointerLock();
  // 應用程式在別人的房間（或線上伺服器）：離開後回到自己電腦上的起始頁面
  if (desktop && desktop.mode !== 'host') desktop.home();
}

export async function selectFlaw(flaw: FlawId | null): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:selectFlaw', { flaw }, cb));
  return r.ok ? null : r.error;
}

/** 互助操作（stationId＝'coop'）：結果用通知顯示 */
export function coop(action: string, args: Record<string, unknown> = {}): Promise<KitchenActionResult | null> {
  return act('coop', action, args);
}
export async function startGame(): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:start', cb));
  return r.ok ? null : r.error;
}
/** 讀完操作說明：準備好了（全員準備好時鐘才開始走） */
export async function readyUp(): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:ready', cb));
  return r.ok ? null : r.error;
}
/** 房主：不等了，直接開始計時 */
export async function forceStart(): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:forceStart', cb));
  return r.ok ? null : r.error;
}
export async function restartGame(): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:restart', cb));
  return r.ok ? null : r.error;
}

/** 房主模式的房主：立刻存檔 */
export async function saveGame(): Promise<string | null> {
  const r = await call<Ack<{ file: string; savedAt: number }>>((cb) => socket.emit('room:save', cb));
  if (!r.ok) return r.error;
  useStore.getState().pushNotice({ tone: 'ok', text: '💾 存檔完成。' }, 3000);
  return null;
}

/** 房主模式的房主：暫停班次 */
export async function pauseGame(): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('room:pause', cb));
  return r.ok ? null : r.error;
}

export async function emitSignal(tokens: SignalToken[]): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('signal:emit', { tokens }, cb));
  return r.ok ? null : r.error;
}

/** 標記工具：指向一個工作站或一張訂單（`order:<id>`） */
export async function emitMark(targetId: string, token?: SignalToken): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('signal:mark', { targetId, token }, cb));
  if (r.ok) audio.marker(STATION_BY_ID[targetId]?.pos ?? null);
  return r.ok ? null : r.error;
}

/** 每一次操作都有唯一的 requestId；逾時重送時沿用同一個，伺服器據此去重 */
function newRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* 非安全環境沒有 randomUUID */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 工作站操作。結果顯示在打開的面板上（沒有面板就用通知），看不見的人以語音播報。
 */
export async function act(stationId: string, action: string, args: Record<string, unknown> = {}, opts: { quiet?: boolean } = {}): Promise<KitchenActionResult | null> {
  const requestId = newRequestId();
  const msg = { stationId, action, args, requestId };
  const once = () => call<KitchenActionResult>((cb) => socket.emit('kitchen:action', msg, cb), 5000);
  let r: KitchenActionResult | { ok: false; error: string } = await once();
  if ('error' in r && socket.connected) r = await once();
  const st = useStore.getState();
  if ('error' in r) {
    st.pushNotice({ tone: 'error', text: r.error });
    return null;
  }
  if (r.result) st.set({ lastResult: r.result });
  const panel = st.station;
  if (panel && (panel.id === stationId || stationId === 'guest' || stationId === 'coop')) {
    st.set({ station: { id: panel.id, result: { ok: r.ok, tone: r.tone, message: localizeKeys(r.message), id: nextId() } } });
  } else if (!opts.quiet || !r.ok) {
    st.pushNotice({ tone: r.tone === 'ok' ? 'info' : r.tone, text: r.message }, 3500);
  }
  if (r.tone === 'ok') audio.uiOk();
  else if (r.tone === 'warn') audio.uiWarn();
  else if (r.tone === 'error') audio.uiError();
  speak(r.message, { interrupt: true });
  return r;
}

/* ---------------------------- 開發者工具（僅開發環境） ---------------------------- */

export async function fetchDebugState(): Promise<DebugState | string> {
  const r = await call<Ack<{ state: DebugState }>>((cb) => socket.emit('debug:state', cb));
  return r.ok ? r.state : r.error;
}
export async function debugCommand(cmd: DebugCommand): Promise<string | null> {
  const r = await call<Ack>((cb) => socket.emit('debug:command', { cmd }, cb));
  return r.ok ? null : r.error;
}

export function sendMove(m: { x: number; y: number; z: number; yaw: number; seq: number }): void {
  if (socket.connected) socket.volatile.emit('player:move', m);
}

let lastStance = '';

export function sendStance(crouch: boolean, panel: boolean): void {
  const key = `${crouch}|${panel}`;
  if (key === lastStance || !socket.connected) return;
  lastStance = key;
  socket.emit('player:stance', { crouch, panel });
}
export function resetStance(): void {
  lastStance = '';
}
