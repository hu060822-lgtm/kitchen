import { resolve } from 'node:path';
import { DEFAULT_FLAW_CONFIG, mergeFlawConfig, type FlawEffectConfig, type IceServerInfo } from '@last-table/shared';

export interface ServerConfig {
  port: number;
  /** true 代表允許任何來源（僅開發用）；陣列代表白名單 */
  corsOrigins: string[] | true;
  /** 班次長度：開店備料、營業（秒） */
  prepSec: number;
  serviceSec: number;
  /** 恐怖系統（客人、怪物）；關掉後就是純料理模式 */
  threats: boolean;
  maxRooms: number;
  roomIdleMs: number;
  /** 僅供測試 */
  moveSpeedMultiplier?: number;
  /** 開發者工具（查看怪物狀態、跳過備料、召喚威脅）。正式環境預設關閉 */
  debugTools: boolean;
  /** 僅供測試：班次時鐘改由測試手動推進 */
  manualClock?: boolean;
  clientDist: string | null;
  ice: IceServerInfo[];
  /** 缺陷卡的效果數值（環境變數 FLAW_CONFIG 可以覆寫部分欄位，JSON） */
  flawConfig: FlawEffectConfig;
  /** 開班前等每個人讀完操作說明才開始計時（READY_GATE=0 關掉） */
  readyGate: boolean;
  /** 房主模式（HOST_MODE=1；Windows 應用程式的「自己開房」）：存檔、讀檔、暫停 */
  hostMode: boolean;
  /** 房主模式的存檔資料夾（SAVE_DIR） */
  saveDir: string | null;
  /** 綁定的位址（HOST=0.0.0.0 讓區網的人連得到） */
  host?: string;
  /** 遊戲版本（寫進存檔） */
  gameVersion?: string;
  /** 自動存檔間隔（毫秒） */
  autosaveMs?: number;
  /** 前面有反向代理（Render）：TRUST_PROXY=1 */
  trustProxy?: boolean;
}

const int = (v: string | undefined, def: number): number => {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const origins = list(env.CORS_ORIGIN);
  const stun = list(env.STUN_URLS);
  const turn = list(env.TURN_URLS);

  const ice: IceServerInfo[] = [{ urls: stun.length ? stun : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (turn.length) {
    ice.push({ urls: turn, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }

  return {
    port: int(env.PORT, 3001),
    corsOrigins: origins.length ? origins : env.NODE_ENV === 'production' ? [] : true,
    prepSec: int(env.PREP_SECONDS, 180),
    serviceSec: int(env.SERVICE_SECONDS, 900),
    threats: env.THREATS !== '0',
    debugTools: env.DEBUG_TOOLS === '1' || (env.DEBUG_TOOLS !== '0' && env.NODE_ENV !== 'production'),
    maxRooms: int(env.MAX_ROOMS, 200),
    roomIdleMs: int(env.ROOM_IDLE_MINUTES, 15) * 60_000,
    // 相對路徑以啟動時的工作目錄解析（express 的 sendFile 需要絕對路徑）
    clientDist: env.CLIENT_DIST ? resolve(env.CLIENT_DIST) : null,
    ice,
    flawConfig: parseFlawConfig(env.FLAW_CONFIG),
    readyGate: env.READY_GATE !== '0',
    hostMode: env.HOST_MODE === '1',
    saveDir: env.SAVE_DIR ? resolve(env.SAVE_DIR) : null,
    host: env.HOST || undefined,
    trustProxy: env.TRUST_PROXY === '1',
  };
}

/** FLAW_CONFIG='{"D02":{"maxStrokeCut":3}}'：只覆寫寫到的數字欄位；格式錯誤就用預設值並警告 */
export function parseFlawConfig(raw: string | undefined): FlawEffectConfig {
  if (!raw) return mergeFlawConfig(DEFAULT_FLAW_CONFIG, null);
  try {
    return mergeFlawConfig(DEFAULT_FLAW_CONFIG, JSON.parse(raw));
  } catch {
    console.warn('[config] FLAW_CONFIG 不是有效的 JSON，使用預設值');
    return mergeFlawConfig(DEFAULT_FLAW_CONFIG, null);
  }
}
