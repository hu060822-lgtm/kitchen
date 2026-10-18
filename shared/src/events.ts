import type { KitchenActionPayload, KitchenActionResult, KitchenEvent, KitchenPublic } from './kitchen/types';
import type { Seat } from './seats';
import type { FlawEffectConfig, FlawId, FlawTelemetry } from './flaws';
import type { SignalToken } from './signals';
import type { IceServerInfo, Notice, PositionsMsg, RoomPublic, SignalReceived } from './types';

/** 通用 ack 回應 */
/** reason：讓用戶端分辨可以自動處理的失敗（not_found＝這台伺服器沒有這個房間，可以去查房間代碼查詢處） */
export type Ack<T = object> = ({ ok: true } & T) | { ok: false; error: string; reason?: 'not_found' };

export interface SessionInfo {
  roomCode: string;
  /** 重連憑證：只回給該玩家本人，不得公開 */
  token: string;
  playerId: string;
}

export interface JoinPayload {
  name: string;
  code: string;
}
export interface RejoinPayload {
  code: string;
  token: string;
}

export interface MovePayload {
  x: number;
  y: number;
  z: number;
  yaw: number;
  seq: number;
}

/** sleepy：嗜睡學徒的睡意設成 99；sneeze_soon：定時噴嚏 4 秒後打噴嚏（測試與截圖用） */
export type DebugCommand = 'skip_prep' | 'end_shift' | 'spawn_guest' | 'spawn_monster' | 'monster_off' | 'restock' | 'reinit_room' | 'sleepy' | 'sneeze_soon' | 'monster_grab_me' | 'guest_off' | 'spill_here' | 'monster_front';

/** 開發者工具看到的內部狀態（只在開發環境） */
export interface DebugState {
  phase: string;
  t: number;
  monster: Record<string, unknown> | null;
  guest: Record<string, unknown> | null;
  recent: Array<{ at: number; role: Seat; stationId: string; action: string; ok: boolean; message: string }>;
  roles: Record<string, Seat | null>;
  flaws: Record<string, FlawId | null>;
  telemetry: FlawTelemetry;
}

export type VoiceSignalKind = 'offer' | 'answer' | 'ice';

export interface VoiceSignalPayload {
  /** 對方角色 */
  to: Seat;
  /** 這條語音邊的方向：sender → receiver */
  edge: { from: Seat; to: Seat };
  kind: VoiceSignalKind;
  sdp?: string;
  candidate?: unknown;
}

export interface VoiceSignalRelay extends VoiceSignalPayload {
  from: Seat;
}

export interface FullSync {
  room: RoomPublic;
  kitchen: KitchenPublic | null;
  me: { id: string; role: Seat | null; isHost: boolean };
  /** 伺服器實際使用的缺陷效果設定（客戶端的移動速度要和伺服器一致） */
  flawConfig: FlawEffectConfig;
  pos: { x: number; y: number; z: number; yaw: number } | null;
  /** 伺服器是否開放開發者工具 */
  debug: boolean;
  /** 房主模式（玩家自己的電腦開的房）：可以存檔、讀檔、暫停 */
  hostMode?: boolean;
}

/** 客戶端 → 伺服器 */
export interface ClientToServerEvents {
  'room:create': (p: { name: string }, ack: (r: Ack<SessionInfo & { sync: FullSync }>) => void) => void;
  /** 教學關：一個人開一間教學用的房間，直接開班 */
  /** 連續七晚：大廳裡選第幾晚（0＝單班）；start＝打烊後直接開始那一晚（只有房主） */
  /** 選今晚（night），或無盡模式（endless；打烊後 start＋next＝下一天，start 不帶 next＝重新開始一輪） */
  'room:night': (p: { night: number; start?: boolean; endless?: boolean; next?: boolean }, ack: (r: Ack) => void) => void;
  /** 房主在大廳切換「沒有怪物」 */
  'room:options': (p: { noMonster: boolean }, ack: (r: Ack) => void) => void;
  'room:tutorial': (p: { name: string }, ack: (r: Ack<SessionInfo & { sync: FullSync }>) => void) => void;
  'room:join': (p: JoinPayload, ack: (r: Ack<SessionInfo & { sync: FullSync }>) => void) => void;
  'room:rejoin': (p: RejoinPayload, ack: (r: Ack<{ sync: FullSync; playerId: string }>) => void) => void;
  'room:leave': (ack?: (r: Ack) => void) => void;
  /** 選一張缺陷卡（可以和別人重複）；null＝取消 */
  'room:selectFlaw': (p: { flaw: FlawId | null }, ack: (r: Ack) => void) => void;
  'room:start': (ack: (r: Ack) => void) => void;
  'room:restart': (ack: (r: Ack) => void) => void;
  /** 讀完操作說明：準備好了 */
  'room:ready': (ack: (r: Ack) => void) => void;
  /** 房主：不等了，直接開始計時 */
  'room:forceStart': (ack: (r: Ack) => void) => void;
  /** 房主模式的房主：暫停班次（大家再按一次準備好才繼續） */
  'room:pause': (ack: (r: Ack) => void) => void;
  /** 房主模式的房主：立刻存檔 */
  'room:save': (ack: (r: Ack<{ file: string; savedAt: number }>) => void) => void;

  'player:move': (p: MovePayload) => void;
  /** 身體姿態：蹲下、面板是否開著（關掉面板時結束「操作／觀察」動作） */
  'player:stance': (p: { crouch: boolean; panel: boolean }) => void;

  /** 工作站操作與互助操作（stationId＝'coop'）；requestId 去重 */
  'kitchen:action': (p: KitchenActionPayload, ack: (r: KitchenActionResult) => void) => void;

  'signal:emit': (p: { tokens: SignalToken[] }, ack: (r: Ack) => void) => void;
  /** 標記工具：指向一個工作站或一張訂單（`order:<id>`），可附一個符號。所有人都能用 */
  'signal:mark': (p: { targetId: string; token?: SignalToken }, ack: (r: Ack) => void) => void;
  'debug:state': (ack: (r: Ack<{ state: DebugState }>) => void) => void;
  'debug:command': (p: { cmd: DebugCommand }, ack: (r: Ack) => void) => void;

  'voice:signal': (p: VoiceSignalPayload) => void;
  'voice:ready': (p: { micEnabled: boolean }) => void;
}

/** 伺服器 → 客戶端 */
export interface ServerToClientEvents {
  'room:state': (room: RoomPublic) => void;
  /** 廚房的公開狀態（約 5 Hz） */
  'kitchen:state': (k: KitchenPublic) => void;
  /** 已依接收者的缺陷卡過濾的事件 */
  'kitchen:event': (e: KitchenEvent) => void;
  'signal:marker': (p: { id: string; from: Seat; targetId: string; token?: SignalToken }) => void;
  'world:positions': (p: PositionsMsg) => void;
  /** 伺服器校正位置；teleport＝被怪物抓走、被救出來等（客戶端同時套用朝向） */
  'player:correct': (p: { x: number; y: number; z: number; yaw: number; teleport?: boolean }) => void;
  'signal:received': (s: SignalReceived) => void;
  'notice': (n: Notice) => void;
  'room:closed': (p: { reason: string }) => void;
  'game:restarted': () => void;

  'voice:signal': (p: VoiceSignalRelay) => void;
  /** 某位隊友的語音狀態改變（上線／離線／麥克風）— 發話端據此（重新）建立連線 */
  'voice:peer': (p: { role: Seat; connected: boolean; micEnabled: boolean }) => void;
}

export const VOICE_LIMITS = {
  /** SDP 最大長度 */
  maxSdpLength: 20_000,
} as const;

export type { IceServerInfo };
