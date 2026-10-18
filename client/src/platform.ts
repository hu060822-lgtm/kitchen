import type { Session } from './state/store';

/**
 * 執行環境：瀏覽器，或 Windows 應用程式（desktop/ 的 Electron 殼）。
 *
 * 在應用程式裡，preload 會提供 window.lastTableApp：
 *   - kv：設定、按鍵、料理圖鑑與委託紀錄存在電腦的檔案裡（換到哪個伺服器都帶著走）；
 *   - home：回到自己電腦上的起始頁面；
 *   - host：只有在「自己電腦的遊戲伺服器」的頁面才有——存檔、邀請朋友、用代碼找房間、設定。
 * 在瀏覽器裡這些都不存在，改用 localStorage。
 */

export interface SaveEntry {
  file: string;
  savedAt: number;
  kind: 'auto' | 'manual' | 'exit' | 'closed';
  code: string;
  players: Array<{ name: string; role: string; flaw: string; host: boolean }>;
  phase: 'PREP' | 'SERVICE' | 'CLOSED';
  shiftSec: number;
  served: number;
  missed: number;
  night?: number;
  endless?: number;
}

export interface InviteInfo {
  on: boolean;
  tunnel: { state: 'idle' | 'downloading' | 'starting' | 'ready' | 'error'; url: string | null; progress: number; error: string | null };
  relay: 'idle' | 'pending' | 'ok' | 'error';
  relayError: string | null;
  codes: string[];
}

export interface HostInfo {
  invite: InviteInfo;
  lan: boolean;
  lanUrls: string[];
  localUrl: string | null;
  rooms: Array<{ code: string; phase: string; shiftSec: number; players: Array<{ name: string; connected: boolean; host: boolean }>; savedAt: number | null; restored: boolean }>;
  lastSaveError: string | null;
  onlineUrl: string;
  saveDir: string;
  dataDir: string;
}

export type Locate = { where: 'host' | 'online'; url: string } | { where: null };

export interface HostBridge {
  info(): Promise<HostInfo>;
  onChange(fn: (info: HostInfo) => void): () => void;
  invite(): Promise<InviteInfo>;
  stopInvite(): Promise<InviteInfo>;
  retryInvite(): Promise<void>;
  saves(): Promise<SaveEntry[]>;
  load(file: string, withFriends: boolean): Promise<Session>;
  removeSave(file: string): Promise<boolean>;
  importSaves(): Promise<string[]>;
  exportSave(file: string): Promise<string | null>;
  openSaveFolder(): Promise<void>;
  exportData(): Promise<string | null>;
  importData(): Promise<boolean>;
  openDataFolder(): Promise<void>;
  setSettings(p: { onlineUrl?: string; lan?: boolean }): Promise<{ settings: { onlineUrl: string; lan: boolean }; restartNeeded: boolean }>;
  relaunch(): Promise<void>;
  quit(): Promise<void>;
  locate(code: string): Promise<Locate>;
  /** 測試線上伺服器（版本、有沒有房間代碼查詢處） */
  checkOnline(): Promise<{ ok: boolean; message: string }>;
  go(url: string, join?: { code?: string; name?: string; create?: boolean }): Promise<{ relaunching: boolean }>;
  copy(text: string): Promise<void>;
}

export interface DesktopBridge {
  version: string;
  /** host＝自己電腦的伺服器；online＝線上伺服器；join＝別人的房間 */
  mode: 'host' | 'online' | 'join';
  onlineUrl: string;
  kv: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
  home(): void;
  host: HostBridge | null;
}

export const desktop: DesktopBridge | null = (typeof window !== 'undefined' && (window as unknown as { lastTableApp?: DesktopBridge }).lastTableApp) || null;

/** 自己電腦的伺服器頁面（可以存檔、邀請） */
export const hostBridge: HostBridge | null = desktop?.host ?? null;

/** 持久的小型設定（應用程式：電腦裡的檔案；瀏覽器：localStorage）。讀寫失敗一律當作沒有 */
export const kv = {
  get(key: string): string | null {
    try {
      return desktop ? desktop.kv.get(key) : localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      if (desktop) desktop.kv.set(key, value);
      else localStorage.setItem(key, value);
    } catch {
      /* 存不了就只在這次有效 */
    }
  },
  remove(key: string): void {
    try {
      if (desktop) desktop.kv.remove(key);
      else localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/** 邀請連結：朋友點開就進到加入畫面（線上伺服器的網址＋房間代碼） */
export function inviteLink(code: string): string {
  const base = desktop ? desktop.onlineUrl : location.origin;
  return `${base.replace(/\/+$/, '')}/?join=${encodeURIComponent(code)}`;
}
