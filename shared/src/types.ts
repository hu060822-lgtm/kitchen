import type { FlawId } from './flaws';
import type { Seat } from './seats';
import type { SignalToken } from './signals';

export type RoomPhase = 'LOBBY' | 'PLAYING' | 'COMPLETE';

/** 大廳／房間中對所有玩家公開的玩家資訊（絕不包含 token） */
export interface PlayerPublic {
  /** 房內短 ID（不是 socket.id，重連後不變） */
  id: string;
  name: string;
  /** 席位（P1–P8），加入房間時自動分配 */
  role: Seat | null;
  /** 選的缺陷卡（公開；還沒選＝null） */
  flaw: FlawId | null;
  connected: boolean;
  isHost: boolean;
}

export interface RoomPublic {
  code: string;
  phase: RoomPhase;
  players: PlayerPublic[];
  /** 可以開始遊戲：1–8 位在線玩家，每人都選好缺陷卡 */
  canStart: boolean;
  /**
   * 開班前的準備：每個人讀完操作說明按「準備好了」，全員準備好（或房主決定不等）時鐘才開始走。
   * 時鐘已經在走時是 null。
   */
  waiting: { ready: string[]; need: string[]; why?: 'start' | 'paused' | 'restored' } | null;
  /** 房主模式：最近一次存檔的時間（伺服器時間，毫秒） */
  savedAt?: number | null;
  /** 房主模式：這一局是從存檔讀回來的 */
  restored?: boolean;
  /** 教學關（一個人，不能加入） */
  tutorial?: boolean;
  /** 連續七晚的第幾晚（省略＝單班） */
  night?: number;
  /** 無盡模式：第幾天、這一輪的種子（用戶端用 endlessDay() 算出今天的考驗） */
  endless?: { day: number; seed: number };
}

export interface PlayerPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** 隊友正在做的事（由伺服器依「開啟了哪一類設備」判定，不含設備名稱或內容） */
export type PlayerActivity = 'interact' | 'inspect';

/**
 * 角色身體的外觀姿態（只影響隊友看到的動畫；不影響碰撞、權限或料理）。
 * crouch：蹲下（玩家按 C）；act：在工作站操作／觀察；hurt：被怪物抓住的累計次數。
 */
export interface BodyState {
  crouch?: boolean;
  act?: PlayerActivity;
  hurt?: number;
}

export type PositionsMsg = Partial<Record<Seat, PlayerPose & BodyState>>;

export interface SignalReceived {
  from: Seat;
  /** 已依接收者感官過濾的 token */
  tokens: SignalToken[];
  /**
   * 接收者實際收到的 token 數。
   * 刻意「不」回傳原始長度：否則接收者會知道「有自己感知不到的訊號」，
   * 等於多了一個繞過感官限制的旁路（例如靜默員可藉此得知有人敲擊）。
   */
  originalLength: number;
  at: number;
}

export interface Notice {
  tone: 'ok' | 'warn' | 'error' | 'info';
  text: string;
}

export interface IceServerInfo {
  urls: string | string[];
  username?: string;
  credential?: string;
}

