import { networkInterfaces } from 'node:os';
import { createGameServer, type GameServer } from './app';
import type { SaveEntry, SaveStore } from './save/store';

/**
 * 房主模式的伺服器（給 Windows 應用程式在自己電腦上開房用）。
 * 和線上版是同一個伺服器，另外打開：存檔／讀檔／暫停、用暱稱回到讀檔的位置、不回收進行中的房間。
 */

export interface HostOptions {
  /** 想用的通訊埠（被占用時往後找） */
  port?: number;
  /** true＝區網的人也連得到（綁 0.0.0.0）；false＝只有這台電腦（網路通道也是從這台電腦連） */
  lan: boolean;
  saveDir: string;
  clientDist: string;
  gameVersion: string;
  /** 測試用：自動存檔間隔 */
  autosaveMs?: number;
  threats?: boolean;
  prepSec?: number;
  serviceSec?: number;
}

export interface RoomStatus {
  code: string;
  phase: string;
  shiftSec: number;
  players: Array<{ name: string; connected: boolean; host: boolean }>;
  savedAt: number | null;
  restored: boolean;
}

export interface HostHandle {
  port: number;
  localUrl: string;
  /** 區網裡其他電腦可以用的網址 */
  lanUrls(): string[];
  saves(): SaveEntry[];
  load(file: string): { code: string; token: string; playerId: string };
  remove(file: string): void;
  importFrom(src: string): string;
  exportTo(file: string, dest: string): void;
  saveAll(kind?: 'manual' | 'exit'): string[];
  status(): { rooms: RoomStatus[]; lastSaveError: string | null };
  /** 關閉前先把進行中的房間都存一份 */
  close(): Promise<string[]>;
}

export const DEFAULT_HOST_PORT = 38401;

function listenWithFallback(server: GameServer, first: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = first;
    const tryPort = () => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.http.off('listening', onListening);
        if (e.code === 'EADDRINUSE' && port < first + 20) {
          port++;
          tryPort();
        } else reject(e);
      };
      const onListening = () => {
        server.http.off('error', onError);
        const addr = server.http.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      };
      server.http.once('error', onError);
      server.http.once('listening', onListening);
      if (server.config.host) server.http.listen(port, server.config.host);
      else server.http.listen(port);
    };
    tryPort();
  });
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

export async function startHost(o: HostOptions): Promise<HostHandle> {
  const server = createGameServer({
    hostMode: true,
    saveDir: o.saveDir,
    clientDist: o.clientDist,
    gameVersion: o.gameVersion,
    host: o.lan ? '0.0.0.0' : '127.0.0.1',
    // 同源連線（網頁就是這個伺服器提供的）；正式設定：關閉開發者工具
    corsOrigins: [],
    debugTools: false,
    threats: o.threats ?? true,
    prepSec: o.prepSec ?? 180,
    serviceSec: o.serviceSec ?? 900,
    autosaveMs: o.autosaveMs,
  });
  const port = await listenWithFallback(server, o.port ?? DEFAULT_HOST_PORT);
  const m = server.manager;
  const store = (m as unknown as { cfg: { saveStore: SaveStore } }).cfg.saveStore;
  return {
    port,
    localUrl: `http://localhost:${port}`,
    lanUrls: () => (o.lan ? lanAddresses().map((a) => `http://${a}:${port}`) : []),
    saves: () => store.list(),
    load: (file) => m.loadSave(file),
    remove: (file) => store.remove(file),
    importFrom: (src) => store.importFrom(src),
    exportTo: (file, dest) => store.exportTo(file, dest),
    saveAll: (kind = 'manual') => m.saveAll(kind),
    status: () => ({
      rooms: [...m.rooms.values()].map((r) => ({
        code: r.code,
        phase: r.sim?.phase ?? r.phase,
        shiftSec: Math.round((r.sim?.t ?? 0) / 1000),
        players: [...r.players.values()].map((p) => ({ name: p.name, connected: p.connected, host: p.id === r.hostId })),
        savedAt: r.savedAt,
        restored: r.restored,
      })),
      lastSaveError: m.lastSaveError,
    }),
    close: async () => {
      const files = m.saveAll('exit');
      await server.close();
      await new Promise<void>((r) => server.http.close(() => r()));
      return files;
    },
  };
}
