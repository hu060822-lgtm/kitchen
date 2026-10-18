import { contextBridge, ipcRenderer } from 'electron';

/**
 * 遊戲視窗的橋接 window.lastTableApp（對應 client/src/platform.ts 的 DesktopBridge）。
 *
 * - 所有頁面：版本、模式、設定檔（kv）、回到起始頁面；
 * - 只有這台電腦的遊戲伺服器的頁面（mode === 'host'）：存檔、邀請朋友、找房間、設定（host）。
 *   主程式也會再檢查一次呼叫的頁面。
 */
interface Init {
  version: string;
  mode: 'host' | 'online' | 'join';
  onlineUrl: string;
  kv: Record<string, string>;
}

const init = ipcRenderer.sendSync('app:init') as Init | null;

if (init) {
  const cache = new Map<string, string>(Object.entries(init.kv ?? {}));

  /** 主程式回傳 { ok, value } 或 { ok:false, error } → 成功給值、失敗丟錯誤 */
  const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const r = (await ipcRenderer.invoke(channel, ...args)) as { ok: boolean; value?: unknown; error?: string };
    if (!r.ok) throw new Error(r.error ?? '失敗');
    return r.value;
  };

  const host =
    init.mode === 'host'
      ? {
          info: () => call('host:info'),
          onChange: (fn: (info: unknown) => void) => {
            const h = (_e: unknown, info: unknown) => fn(info);
            ipcRenderer.on('host:changed', h);
            return () => ipcRenderer.removeListener('host:changed', h);
          },
          invite: () => call('invite:start'),
          stopInvite: () => call('invite:stop'),
          retryInvite: () => call('invite:retry'),
          saves: () => call('saves:list'),
          load: (file: string, withFriends: boolean) => call('saves:load', file, withFriends),
          removeSave: (file: string) => call('saves:delete', file),
          importSaves: () => call('saves:import'),
          exportSave: (file: string) => call('saves:export', file),
          openSaveFolder: () => call('saves:openFolder'),
          exportData: () => call('data:export'),
          importData: () => call('data:import'),
          openDataFolder: () => call('data:openFolder'),
          setSettings: (p: unknown) => call('settings:set', p),
          relaunch: () => call('app:relaunch'),
          quit: () => call('app:quit'),
          locate: (code: string) => call('net:locate', code),
          checkOnline: () => call('net:check'),
          go: (url: string, join?: unknown) => call('net:go', url, join),
          copy: (text: string) => call('clipboard:write', text),
        }
      : null;

  contextBridge.exposeInMainWorld('lastTableApp', {
    version: init.version,
    mode: init.mode,
    onlineUrl: init.onlineUrl,
    kv: {
      get: (key: string): string | null => cache.get(String(key)) ?? null,
      set: (key: string, value: string): void => {
        const k = String(key);
        const v = String(value);
        cache.set(k, v);
        ipcRenderer.send('kv:set', k, v);
      },
      remove: (key: string): void => {
        const k = String(key);
        cache.delete(k);
        ipcRenderer.send('kv:remove', k);
      },
    },
    home: (): void => ipcRenderer.send('app:home'),
    host,
  });
}
