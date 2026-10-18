import compression from 'compression';
import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@last-table/shared';
import { loadConfig, type ServerConfig } from './config';
import { RoomManager } from './rooms/manager';
import { SaveStore } from './save/store';
import { mountRelay, RelayDirectory } from './relay';

export interface GameServer {
  http: HttpServer;
  manager: RoomManager;
  config: ServerConfig;
  /** 房間代碼查詢處（線上伺服器才有） */
  relay: RelayDirectory | null;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export function createGameServer(overrides: Partial<ServerConfig> = {}): GameServer {
  const config: ServerConfig = { ...loadConfig(), ...overrides };
  const app = express();
  app.disable('x-powered-by');
  // Render 等平台在前面有一層代理：用 X-Forwarded-For 的第一跳當來源 IP（頻率限制用）
  if (config.trustProxy) app.set('trust proxy', 1);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, rooms: manager.rooms.size });
  });

  // 給應用程式確認「這是《最後一桌》的伺服器、有沒有房間代碼查詢處」
  app.get('/api/version', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ game: 'last-table', version: config.gameVersion ?? null, relay: !config.hostMode, hostMode: config.hostMode });
  });

  // 語音用的 ICE 伺服器設定。TURN 憑證只放在伺服器環境變數，不寫進前端程式碼。
  app.get('/api/ice-servers', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ iceServers: config.ice });
  });

  // 房間代碼查詢處：Windows 應用程式的房主登記「代碼 → 通道網址」，朋友只要輸入代碼
  const relay = config.hostMode ? null : new RelayDirectory();
  if (relay) mountRelay(app, relay, (code) => manager.rooms.has(code));

  // 同源部署時，由伺服器一併提供前端靜態檔
  const candidates = [
    config.clientDist,
    path.resolve(process.cwd(), '../client/dist'),
    path.resolve(process.cwd(), 'client/dist'),
  ].filter((p): p is string => !!p);
  const dist = candidates.find((p) => existsSync(path.join(p, 'index.html')));
  if (dist) {
    // gzip：角色模型（GLB）與 JS 套件壓縮後約只剩 1/4；Socket.IO 不經過這裡
    app.use(compression({ filter: (req, res) => /\.(glb|js|css|json|html|svg)$/.test(req.path) || compression.filter(req, res) }));
    // 角色模型：檔名固定，快取 1 天；更新模型後重新部署即可（Render 每次部署都是新的程序）
    app.use(
      '/models',
      express.static(path.join(dist, 'models'), {
        maxAge: '1d',
        index: false,
        fallthrough: false, // 找不到模型就回 404，不要回傳網頁（前端會改用備用模型）
        // manifest 決定要載入哪個模型（含正式模型的替換設定），每次都向伺服器確認
        setHeaders: (res, file) => {
          if (file.endsWith('manifest.json')) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    app.get(/^(?!\/(socket\.io|api|healthz)).*/, (_req, res) => {
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  const http = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(http, {
    cors: { origin: config.corsOrigins === true ? true : config.corsOrigins },
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 10_000,
    pingTimeout: 15_000,
  });

  const manager = new RoomManager(io, {
    prepSec: config.prepSec,
    serviceSec: config.serviceSec,
    threats: config.threats,
    manualClock: config.manualClock,
    moveSpeedMultiplier: config.moveSpeedMultiplier,
    debugTools: config.debugTools,
    flawConfig: config.flawConfig,
    readyGate: config.readyGate,
    maxRooms: config.maxRooms,
    roomIdleMs: config.roomIdleMs,
    lobbyGraceMs: 20_000,
    hostGraceMs: 30_000,
    hostMode: config.hostMode,
    saveStore: config.hostMode && config.saveDir ? new SaveStore(config.saveDir, config.gameVersion ?? '0.1.0') : undefined,
    autosaveMs: config.autosaveMs,
  });
  manager.attach();

  return {
    http,
    manager,
    config,
    relay,
    listen: (port = config.port) =>
      new Promise<number>((resolve) => {
        const done = () => {
          const addr = http.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        };
        if (config.host) http.listen(port, config.host, done);
        else http.listen(port, done);
      }),
    close: () =>
      new Promise<void>((resolve) => {
        manager.close();
        void io.close(() => resolve());
      }),
  };
}
