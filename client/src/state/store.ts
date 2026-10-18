import { localizeKeys } from '../game/keymap';
import { create } from 'zustand';
import { DEFAULT_FLAW_CONFIG, type FlawEffectConfig, type FlawId, type KitchenActionResult, type KitchenPublic, type Notice, type Seat, type RoomPublic, type ScoreResult, type SignalReceived, type SignalToken } from '@last-table/shared';
import { kv } from '../platform';

export interface Session {
  code: string;
  token: string;
  playerId: string;
}

/** 沒有在房間裡時的頁面：起始頁面、開店（開始遊戲）、繼續遊戲（讀檔）、設定、說明 */
export type Page = 'title' | 'play' | 'continue' | 'settings' | 'help' | 'journal';

/** 網址帶來的動作：?join=CODE（邀請連結、從查詢處轉過來）、?create=1（應用程式改用線上伺服器開房）；name＝暱稱 */
export interface PendingJoin {
  code: string | null;
  create: boolean;
  name: string | null;
}

function readPendingJoin(): PendingJoin | null {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search);
  const raw = q.get('join');
  const code = raw ? raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) : null;
  const create = q.get('create') === '1';
  if (!code && !create) return null;
  const name = (q.get('name') ?? '').trim().slice(0, 16) || null;
  // 用過就從網址拿掉（重新整理時不會再加入一次，暱稱也不會留在網址列）
  for (const k of ['join', 'create', 'name']) q.delete(k);
  const rest = q.toString();
  try {
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  } catch {
    /* ignore */
  }
  return { code: code && code.length === 6 ? code : null, create, name };
}
const initialPending = readPendingJoin();

export type Overlay = 'none' | 'tickets' | 'signals' | 'help' | 'cookbook' | 'dual';
export type MicState = 'off' | 'requesting' | 'on' | 'denied' | 'unavailable' | 'forbidden';

export interface ToastNotice extends Notice {
  id: number;
}
export interface ReceivedSignal extends SignalReceived {
  id: number;
}
/** 標記的即時提示（實際的標記存在 kitchen.coop.marks；這裡只負責「剛剛有人標記」的閃動） */
export interface Marker {
  id: number;
  from: Seat;
  targetId: string;
  token?: SignalToken;
  at: number;
}

/** 目前打開的工作站面板 */
export interface OpenStation {
  id: string;
  /** 最近一次操作的回饋 */
  result: (Pick<KitchenActionResult, 'message' | 'tone' | 'ok'> & { id: number }) | null;
}

export interface Prefs {
  volume: number;
  sensitivity: number;
  /** 語音播報（無障礙選項：把通知念出來） */
  speech: boolean;
  /** PS1 風格的低解析度算繪 */
  retro: boolean;
  /** 介面大小（0.7–1.2）：遊戲畫面為主，預設偏小 */
  uiScale: number;
  /** 單聲道模式 */
  mono: boolean;
  envVolume: number;
  echoVolume: number;
  navVolume: number;
  voiceVolume: number;
  /** 附近工作站的指引音（無障礙選項） */
  beacon: boolean;
  /** 背景音樂音量（0–1） */
  musicVolume: number;
}

const PREFS_KEY = 'last-table.prefs';
function loadPrefs(): Prefs {
  const def: Prefs = { volume: 0.8, sensitivity: 1, speech: false, retro: false, uiScale: 0.85, mono: false, envVolume: 1, echoVolume: 1, navVolume: 1, voiceVolume: 1, beacon: false, musicVolume: 0.5 };
  try {
    const raw = kv.get(PREFS_KEY);
    if (raw) return { ...def, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* 瀏覽器可能封鎖儲存空間 */
  }
  return def;
}

let uid = 1;
export const nextId = (): number => uid++;

export interface Store {
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  session: Session | null;
  room: RoomPublic | null;
  kitchen: KitchenPublic | null;
  /** 收到最近一次廚房快照的本機時間（performance.now），用來在快照之間推算班次時間 */
  kitchenAt: number;
  debug: boolean;
  /** 房主模式（自己電腦開的房）：可以存檔、暫停 */
  hostMode: boolean;
  debugOpen: boolean;
  markers: Marker[];
  me: { id: string; role: Seat | null; isHost: boolean } | null;
  notices: ToastNotice[];
  signals: ReceivedSignal[];
  /** 最近一次出餐的評分（顯示在出餐口） */
  lastResult: ScoreResult | null;
  station: OpenStation | null;
  /** 打開的隊友面板（面對隊友按 E） */
  mate: Seat | null;
  /** 伺服器實際使用的缺陷效果設定 */
  flawConfig: FlawEffectConfig;
  overlay: Overlay;
  briefed: boolean;
  locked: boolean;
  micState: MicState;
  micMuted: boolean;
  micLevel: number;
  speaking: boolean;
  talking: Partial<Record<Seat, boolean>>;
  voiceLinks: Partial<Record<string, 'connecting' | 'connected' | 'failed'>>;
  prefs: Prefs;
  error: string | null;
  page: Page;
  pendingJoin: PendingJoin | null;
  /** 連續七晚：出單機印出的故事（畫面上的紙條） */
  storySlip: { night: number; title: string; text: string; ending?: 'served' | 'missed' } | null;

  set: (p: Partial<Store>) => void;
  pushNotice: (n: Notice, ttl?: number) => void;
  dismissNotice: (id: number) => void;
  pushSignal: (s: SignalReceived) => void;
  pushMarker: (m: Omit<Marker, 'id' | 'at'>) => void;
  setPrefs: (p: Partial<Prefs>) => void;
  resetGame: () => void;
  resetAll: () => void;
}

export const useStore = create<Store>((set, get) => ({
  connected: false,
  connecting: false,
  reconnecting: false,
  session: null,
  room: null,
  kitchen: null,
  kitchenAt: 0,
  debug: false,
  hostMode: false,
  page: initialPending ? 'play' : 'title',
  pendingJoin: initialPending,
  storySlip: null,
  debugOpen: false,
  markers: [],
  me: null,
  notices: [],
  signals: [],
  lastResult: null,
  station: null,
  mate: null,
  flawConfig: DEFAULT_FLAW_CONFIG,
  overlay: 'none',
  briefed: false,
  locked: false,
  micState: 'off',
  micMuted: false,
  micLevel: 0,
  speaking: false,
  talking: {},
  voiceLinks: {},
  prefs: loadPrefs(),
  error: null,

  set: (p) => set(p),

  pushNotice: (n, ttl = 6000) => {
    const id = nextId();
    set((s) => ({ notices: [...s.notices.slice(-4), { ...n, text: localizeKeys(n.text), id }] }));
    setTimeout(() => get().dismissNotice(id), ttl);
  },
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),

  pushSignal: (sig) => {
    const id = nextId();
    set((s) => ({ signals: [...s.signals.slice(-7), { ...sig, id }] }));
    setTimeout(() => set((s) => ({ signals: s.signals.filter((x) => x.id !== id) })), 9000);
  },

  pushMarker: (m) => {
    const id = nextId();
    set((s) => ({ markers: [...s.markers.filter((x) => x.from !== m.from || x.targetId !== m.targetId).slice(-5), { ...m, id, at: Date.now() }] }));
    setTimeout(() => set((s) => ({ markers: s.markers.filter((x) => x.id !== id) })), 12000);
  },

  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p };
    set({ prefs });
    try {
      kv.set(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  },

  resetGame: () => set({ kitchen: null, markers: [], debugOpen: false, signals: [], lastResult: null, station: null, mate: null, overlay: 'none', briefed: false, storySlip: null }),

  resetAll: () =>
    set({
      session: null,
      room: null,
      kitchen: null,
      markers: [],
      debug: false,
      debugOpen: false,
      me: null,
      signals: [],
      lastResult: null,
      station: null,
      mate: null,
      overlay: 'none',
      briefed: false,
      reconnecting: false,
      talking: {},
      voiceLinks: {},
    }),
}));

/** 推算目前的班次時間（毫秒）：快照時間＋收到之後經過的時間（最多推 1 秒，斷線時不會一直往前跑） */
export function shiftNow(): number {
  const st = useStore.getState();
  if (!st.kitchen) return 0;
  if (st.kitchen.phase === 'CLOSED') return st.kitchen.t;
  // 開班前（等大家讀完操作說明）時鐘不走
  if (st.room?.waiting) return st.kitchen.t;
  return st.kitchen.t + Math.min(1000, performance.now() - st.kitchenAt);
}

export const myRole = (): Seat | null => useStore.getState().me?.role ?? null;

/** 我選的缺陷卡（遊戲中以伺服器給的個人狀態為準，大廳裡看房間資料） */
export function myFlaw(): FlawId | null {
  const st = useStore.getState();
  return st.kitchen?.self?.flaw ?? st.room?.players.find((p) => p.id === st.me?.id)?.flaw ?? null;
}

/** 某個席位的缺陷卡 */
export function flawOfSeat(s: Seat): FlawId | null {
  const st = useStore.getState();
  return st.kitchen?.coop.flaws[s] ?? st.room?.players.find((p) => p.role === s)?.flaw ?? null;
}
