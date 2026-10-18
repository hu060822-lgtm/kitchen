import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startHost, type HostHandle } from '../../server/src/host';
import { SaveStore } from '../../server/src/save/store';
import { GameKv, JsonFileStore } from './kvstore';
import { Invite } from './invite';

/**
 * 《NULL：最後一桌》Windows 應用程式
 *
 * 一打開就在這台電腦上跑一個遊戲伺服器（只聽本機），視窗載入它提供的遊戲畫面：起始頁面 → 開始遊戲／繼續遊戲／設定／說明。
 *   - 自己開房：房間就開在這台電腦上，可以存檔、讀檔、暫停；
 *   - 邀請朋友：開 Cloudflare 免費通道，並把房間代碼登記到線上伺服器的查詢處 → 朋友只要輸入代碼；
 *   - 加入朋友的房間：輸入代碼 → 查詢處告訴我們房主的網址 → 視窗直接換過去；
 *   - 線上伺服器開房：和網頁版一樣（不能存檔）。
 *
 * 設定、按鍵、料理圖鑑與委託紀錄存在電腦裡的檔案（不是瀏覽器的 localStorage），換到哪個伺服器都帶著走。
 */

const DEFAULT_ONLINE_URL = 'https://kitchen-jiaa.onrender.com';
/** 舊版的預設網址（從來沒有這個服務）：存著它的設定自動改成新的預設 */
const OLD_DEFAULT_URLS = new Set(['https://null-last-table.onrender.com']);
const APP_TITLE = 'NULL：最後一桌';

// 資料夾：%APPDATA%\NullLastTable（存檔在 saves 裡）。測試時可以用 LAST_TABLE_DATA_DIR 指定
app.setPath('userData', process.env.LAST_TABLE_DATA_DIR || path.join(app.getPath('appData'), 'NullLastTable'));
if (process.platform === 'win32') app.setAppUserModelId('com.nulllasttable.app');

// 起始頁面一打開就有背景音樂（應用程式裡不需要先點一下）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const DATA_DIR = app.getPath('userData');
const SAVE_DIR = path.join(DATA_DIR, 'saves');
const BIN_DIR = path.join(DATA_DIR, 'bin');
const VERSION = app.getVersion();

const appStore = new JsonFileStore(path.join(DATA_DIR, 'app.json'));
const kv = new GameKv(DATA_DIR);
const saves = new SaveStore(SAVE_DIR, VERSION);

// ───────────────────────────── 設定 ─────────────────────────────

interface AppSettings {
  /** 線上伺服器（也是房間代碼查詢處） */
  onlineUrl: string;
  /** 區網模式：伺服器也讓同一個網路的電腦直接連（沒有網際網路時用；要重開程式） */
  lan: boolean;
}

function settings(): AppSettings {
  let c: Partial<AppSettings> = {};
  try {
    c = JSON.parse(appStore.get('settings') ?? '{}') as Partial<AppSettings>;
  } catch {
    /* 用預設值 */
  }
  return {
    onlineUrl: typeof c.onlineUrl === 'string' && /^https?:\/\//.test(c.onlineUrl) && !OLD_DEFAULT_URLS.has(c.onlineUrl.replace(/\/+$/, '')) ? c.onlineUrl.replace(/\/+$/, '') : DEFAULT_ONLINE_URL,
    lan: c.lan === true,
  };
}

function setSettings(p: Partial<AppSettings>): AppSettings {
  const next = { ...settings(), ...p };
  appStore.set('settings', JSON.stringify(next));
  appStore.flush();
  return next;
}

/** 這次啟動時的區網設定（改了要重開才生效） */
const lanAtStart = settings().lan;

// ───────────────────────────── 區網語音 ─────────────────────────────
// 瀏覽器只在 https 或 localhost 允許麥克風；區網的 http://192.168.x.x 不算。
// 加入過的區網位址記下來，啟動時告訴 Chromium「把它當成安全來源」（只在啟動時讀，所以第一次要重開）。
function insecureOrigins(): string[] {
  try {
    const v = JSON.parse(appStore.get('insecureOrigins') ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(-20) : [];
  } catch {
    return [];
  }
}
{
  const list = insecureOrigins();
  if (list.length) app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', list.join(','));
}
function rememberInsecureOrigin(origin: string): boolean {
  const list = insecureOrigins();
  if (list.includes(origin)) return false;
  list.push(origin);
  appStore.set('insecureOrigins', JSON.stringify(list));
  appStore.flush();
  return true;
}

const isLoopback = (h: string): boolean => h === 'localhost' || h === '[::1]' || /^127\./.test(h);
const isPrivate = (h: string): boolean => isLoopback(h) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);

// ───────────────────────────── 伺服器 ─────────────────────────────

let host: HostHandle | null = null;
let win: BrowserWindow | null = null;
let quitting = false;

function clientDist(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'client') : path.resolve(__dirname, '../../client/dist');
}

const invite = new Invite(
  BIN_DIR,
  () => host,
  () => settings().onlineUrl,
  (url, init) => net.fetch(url, init),
  () => pushHostInfo(),
);

function hostInfo() {
  return {
    invite: invite.info,
    lan: lanAtStart,
    lanUrls: host?.lanUrls() ?? [],
    localUrl: host?.localUrl ?? null,
    rooms: host?.status().rooms ?? [],
    lastSaveError: host?.status().lastSaveError ?? null,
    onlineUrl: settings().onlineUrl,
    saveDir: SAVE_DIR,
    dataDir: DATA_DIR,
  };
}

let lastRoomKey = '';
function pushHostInfo(): void {
  if (!win || win.isDestroyed() || !isLocal(win.webContents)) return;
  win.webContents.send('host:changed', hostInfo());
}

// ───────────────────────────── 視窗 ─────────────────────────────

const localOrigin = (): string | null => (host ? new URL(host.localUrl).origin : null);

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** 這個頁面是不是這台電腦的遊戲伺服器（只有它能用存檔、邀請等管理功能） */
function isLocal(wc: WebContents): boolean {
  const lo = localOrigin();
  return !!lo && originOf(wc.getURL()) === lo;
}

/** 視窗可以停留的網址：本機伺服器、線上伺服器、最近一次「前往」的房主 */
const allowed = new Set<string>();

function createWindow(url: string): void {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: APP_TITLE,
    backgroundColor: '#1f2224',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const w = win;
  w.once('ready-to-show', () => w.show());
  w.on('page-title-updated', (e) => e.preventDefault());
  const wc = w.webContents;
  wc.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) void shell.openExternal(u);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, u) => {
    const o = originOf(u);
    if (o && (o === originOf(wc.getURL()) || allowed.has(o))) return;
    if (u.startsWith('file:')) return;
    e.preventDefault();
    if (/^https?:/i.test(u)) void shell.openExternal(u);
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      w.setFullScreen(!w.isFullScreen());
      e.preventDefault();
    } else if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
      wc.reload();
      e.preventDefault();
    } else if ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
      if (!app.isPackaged || process.env.LAST_TABLE_DEVTOOLS === '1') wc.toggleDevTools();
      e.preventDefault();
    }
  });
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMain) => {
    if (!isMain || code === -3) return; // -3：被新的載入取代
    void w.loadFile(path.join(__dirname, '..', 'pages', 'offline.html'), { query: { url: failedUrl, why: `${desc} (${code})` } });
  });
  wc.on('did-navigate', () => pushHostInfo());
  w.on('close', (e) => {
    if (quitting) return;
    const others = (host?.status().rooms ?? []).reduce((n, r) => n + r.players.filter((p) => p.connected && !p.host).length, 0);
    if (others > 0) {
      const r = dialog.showMessageBoxSync(w, {
        type: 'question',
        buttons: ['存檔並關閉', '取消'],
        defaultId: 0,
        cancelId: 1,
        title: APP_TITLE,
        message: '朋友還在你開的房間裡。',
        detail: '關掉程式會讓大家斷線。進行中的班次會先存檔，下次從「繼續遊戲」接著玩。',
      });
      if (r === 1) {
        e.preventDefault();
        return;
      }
    }
  });
  w.on('closed', () => {
    win = null;
    app.quit();
  });
  void w.loadURL(url);
}

function goHome(): void {
  if (win && !win.isDestroyed() && host) void win.loadURL(host.localUrl);
}

/** 前往別人的房間（或線上伺服器）。join：到了之後自動加入／開房 */
async function go(raw: string, join?: { code?: string; name?: string; create?: boolean }): Promise<{ relaunching: boolean }> {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isPrivate(u.hostname))) throw new Error('只能前往 https 網址，或區網裡的 http 位址。');
  const target = new URL(u.origin + '/');
  if (join?.code) target.searchParams.set('join', join.code);
  if (join?.create) target.searchParams.set('create', '1');
  if (join?.name) target.searchParams.set('name', join.name);
  if (u.protocol === 'http:' && !isLoopback(u.hostname) && rememberInsecureOrigin(u.origin)) {
    const r = dialog.showMessageBoxSync(win!, {
      type: 'question',
      buttons: ['重新開啟並加入', '先不用語音，直接加入'],
      defaultId: 0,
      cancelId: 1,
      title: APP_TITLE,
      message: '第一次連到這個區網位址',
      detail: '區網的 http 網址預設不能用麥克風。程式已經記住這個位址，重新開啟（約 3 秒）後語音就能用，下次不用再重開。',
    });
    if (r === 0) {
      appStore.set('autoGo', target.href);
      appStore.flush();
      void relaunch();
      return { relaunching: true };
    }
  }
  allowed.add(u.origin);
  void win?.loadURL(target.href);
  return { relaunching: false };
}

// ───────────────────────────── IPC ─────────────────────────────

/** 管理功能：只有本機伺服器的頁面能呼叫（視窗也可能停在別人的房間或線上伺服器） */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (e: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!win || e.sender !== win.webContents || !isLocal(e.sender)) return { ok: false, error: '這個頁面不能使用這個功能。' };
    try {
      return { ok: true, value: await fn(...(args as A)) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

const fromWin = (e: IpcMainEvent): boolean => !!win && e.sender === win.webContents;

function registerIpc(): void {
  ipcMain.on('app:init', (e) => {
    if (!fromWin(e)) {
      e.returnValue = null;
      return;
    }
    const o = originOf(e.sender.getURL());
    const mode = o && o === localOrigin() ? 'host' : o && o === originOf(settings().onlineUrl) ? 'online' : 'join';
    e.returnValue = { version: VERSION, mode, onlineUrl: settings().onlineUrl, kv: kv.getAll() };
  });
  ipcMain.on('kv:set', (e, key: unknown, value: unknown) => {
    if (fromWin(e) && typeof key === 'string' && typeof value === 'string' && key.length < 200 && value.length < 2_000_000) kv.set(key, value);
  });
  ipcMain.on('kv:remove', (e, key: unknown) => {
    if (fromWin(e) && typeof key === 'string') kv.remove(key);
  });
  ipcMain.on('app:home', (e) => {
    if (fromWin(e)) goHome();
  });

  handle('host:info', () => hostInfo());
  handle('invite:start', () => {
    invite.start();
    return invite.info;
  });
  handle('invite:stop', async () => {
    await invite.stop();
    return invite.info;
  });
  handle('invite:retry', () => invite.retry());

  handle('saves:list', () => saves.list());
  handle('saves:load', (file: string, withFriends: boolean) => {
    if (!host) throw new Error('伺服器還沒準備好。');
    const s = host.load(String(file));
    if (withFriends) invite.start();
    else invite.poke();
    return s;
  });
  handle('saves:delete', (file: string) => {
    const r = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['刪除', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: APP_TITLE,
      message: '要刪除這個存檔嗎？',
      detail: '刪除後就找不回來了。',
    });
    if (r !== 0) return false;
    saves.remove(String(file));
    return true;
  });
  handle('saves:import', async () => {
    const r = await dialog.showOpenDialog(win!, { title: '匯入存檔', filters: [{ name: '最後一桌存檔', extensions: ['json'] }], properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    return r.filePaths.map((p) => saves.importFrom(p));
  });
  handle('saves:export', async (file: string) => {
    const r = await dialog.showSaveDialog(win!, { title: '匯出存檔', defaultPath: path.join(app.getPath('documents'), path.basename(String(file))), filters: [{ name: '最後一桌存檔', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return null;
    saves.exportTo(String(file), r.filePath);
    return r.filePath;
  });
  handle('saves:openFolder', async () => {
    const err = await shell.openPath(SAVE_DIR);
    if (err) throw new Error(err);
  });

  handle('data:export', async () => {
    const r = await dialog.showSaveDialog(win!, {
      title: '匯出個人資料',
      defaultPath: path.join(app.getPath('documents'), `last-table-profile-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: '個人資料', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    kv.flush();
    writeFileSync(r.filePath, JSON.stringify({ format: 'last-table-profile', version: 1, exportedAt: Date.now(), game: VERSION, data: kv.getAll() }, null, 1));
    return r.filePath;
  });
  handle('data:import', async () => {
    const r = await dialog.showOpenDialog(win!, { title: '匯入個人資料', filters: [{ name: '個人資料', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return false;
    let body: { format?: string; data?: Record<string, unknown> };
    try {
      body = JSON.parse(readFileSync(r.filePaths[0], 'utf8'));
    } catch {
      throw new Error('這個檔案讀不出來。');
    }
    if (body?.format !== 'last-table-profile' || !body.data || typeof body.data !== 'object') throw new Error('這不是「最後一桌」的個人資料檔。');
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.data)) if (k.startsWith('last-table.') && k !== 'last-table.session' && typeof v === 'string') data[k] = v;
    const ok = dialog.showMessageBoxSync(win!, {
      type: 'question',
      buttons: ['匯入並覆蓋', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: APP_TITLE,
      message: '用這個檔案覆蓋目前的設定、按鍵和紀錄？',
      detail: `共 ${Object.keys(data).length} 項。目前的資料會被取代（舊檔留有 .bak 備份）。`,
    });
    if (ok !== 0) return false;
    kv.replaceAll(data);
    setTimeout(() => win?.webContents.reload(), 50);
    return true;
  });
  handle('data:openFolder', async () => {
    const err = await shell.openPath(DATA_DIR);
    if (err) throw new Error(err);
  });

  handle('settings:set', (p: Partial<AppSettings>) => {
    const clean: Partial<AppSettings> = {};
    if (typeof p?.onlineUrl === 'string') {
      const s = p.onlineUrl.trim();
      if (!s) clean.onlineUrl = DEFAULT_ONLINE_URL;
      else {
        const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isPrivate(u.hostname))) throw new Error('線上伺服器要用 https 網址。');
        clean.onlineUrl = u.origin;
      }
    }
    if (typeof p?.lan === 'boolean') clean.lan = p.lan;
    const next = setSettings(clean);
    return { settings: next, restartNeeded: next.lan !== lanAtStart };
  });
  handle('app:relaunch', () => relaunch());
  handle('app:quit', () => {
    win?.close();
  });

  handle('net:locate', async (code: string) => {
    const c = String(code).trim().toUpperCase();
    const base = settings().onlineUrl;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 70_000);
    try {
      const res = await net.fetch(`${base}/api/locate/${encodeURIComponent(c)}`, { signal: ctl.signal });
      if (res.status === 404) return { where: null };
      const j = (await res.json()) as { where?: string; url?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.where === 'here') return { where: 'online', url: base };
      if (j.where === 'host' && typeof j.url === 'string') return { where: 'host', url: j.url };
      return { where: null };
    } catch (e) {
      throw new Error(ctl.signal.aborted ? '線上服務沒有回應，請稍後再試。' : `連不上線上服務：${e instanceof Error ? e.message : e}`);
    } finally {
      clearTimeout(t);
    }
  });
  handle('net:check', async () => {
    const base = settings().onlineUrl;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 70_000);
    try {
      const v = await net.fetch(`${base}/api/version`, { signal: ctl.signal });
      const j = (await v.json().catch(() => null)) as { game?: string; relay?: boolean; version?: string | null } | null;
      if (v.ok && j?.game === 'last-table') {
        if (j.relay === false) return { ok: false, message: `${base} 是房主模式的伺服器，不是線上伺服器。` };
        return { ok: true, message: `連線正常：${base} 是《最後一桌》的線上伺服器，房間代碼查詢處可以用。` };
      }
      const h = await net.fetch(`${base}/healthz`, { signal: ctl.signal });
      const hj = (await h.json().catch(() => null)) as { ok?: boolean } | null;
      if (h.ok && hj?.ok) return { ok: false, message: `${base} 是《最後一桌》，但還是舊版（沒有房間代碼查詢處）。請把最新的原始碼推上 GitHub，等 Render 重新部署。` };
      return { ok: false, message: `${base} 不是《最後一桌》的線上伺服器（HTTP ${v.status}）。請填入你在 Render 上的網址。` };
    } catch (e) {
      return { ok: false, message: ctl.signal.aborted ? '線上伺服器 70 秒沒有回應（免費方案剛醒來時比較慢，可以再試一次）。' : `連不上 ${base}：${e instanceof Error ? e.message : e}` };
    } finally {
      clearTimeout(t);
    }
  });
  handle('net:go', (url: string, join?: { code?: string; name?: string; create?: boolean }) => go(String(url), join));
  handle('clipboard:write', (text: string) => clipboard.writeText(String(text)));
}

// ───────────────────────────── 程式生命週期 ─────────────────────────────

async function shutdown(): Promise<void> {
  try {
    await Promise.race([invite.stop(), new Promise((r) => setTimeout(r, 3000))]);
  } catch {
    /* 登記會自己過期 */
  }
  if (host) {
    const h = host;
    host = null;
    try {
      await h.close();
    } catch (e) {
      console.error('[host] 關閉時存檔失敗', e);
    }
  }
  kv.flush();
  appStore.flush();
}

async function relaunch(): Promise<void> {
  quitting = true;
  await shutdown();
  app.relaunch();
  app.exit(0);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // 麥克風（遊戲內語音）、滑鼠鎖定、全螢幕、複製
    const ok = new Set(['media', 'pointerLock', 'fullscreen', 'clipboard-sanitized-write', 'audioCapture']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(ok.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ok.has(permission));
    registerIpc();
    try {
      host = await startHost({ lan: lanAtStart, saveDir: SAVE_DIR, clientDist: clientDist(), gameVersion: VERSION });
    } catch (e) {
      dialog.showErrorBox(APP_TITLE, `遊戲伺服器開不起來：${e instanceof Error ? e.message : e}\n請關掉其他《最後一桌》視窗後再試。`);
      app.exit(1);
      return;
    }
    allowed.add(new URL(host.localUrl).origin);
    allowed.add(originOf(settings().onlineUrl));
    // 先叫醒線上服務（免費方案閒置後第一次要等約 30 秒），朋友查代碼時通常已經醒了
    void net.fetch(`${settings().onlineUrl}/healthz`).catch(() => undefined);

    const autoGo = appStore.get('autoGo');
    appStore.remove('autoGo');
    createWindow(host.localUrl);
    if (autoGo) {
      allowed.add(originOf(autoGo));
      void win!.loadURL(autoGo);
    }
    // 房間有變化（新開房、有人進出、存檔）時更新畫面上的邀請狀態，並立刻登記新的房間代碼
    setInterval(() => {
      if (!host) return;
      const st = host.status();
      const key = st.rooms.map((r) => `${r.code}:${r.players.map((p) => `${p.name}${p.connected ? 1 : 0}`).join(',')}:${r.savedAt}`).join('|');
      if (key !== lastRoomKey) {
        const newRoom = st.rooms.map((r) => r.code).join() !== lastRoomKey.split('|').map((s) => s.split(':')[0]).join();
        lastRoomKey = key;
        if (newRoom) invite.poke();
        pushHostInfo();
      }
    }, 1500).unref();
  });

  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    void shutdown().finally(() => app.exit(0));
  });

  app.on('window-all-closed', () => app.quit());
}
