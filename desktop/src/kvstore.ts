import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';

/**
 * 存在電腦裡的小型 JSON 檔（設定、按鍵、料理圖鑑與委託紀錄、啟動畫面的選項）。
 *
 * - 寫入：先寫暫存檔 → fsync → 改名（中途當機也不會留下寫一半的檔案），舊檔留一份 .bak；
 * - 讀取：主檔壞掉就讀 .bak；
 * - 變更會稍微延遲再一起寫（打字、拖拉滑桿時不會一直寫硬碟），程式關閉前一定寫完。
 */
export class JsonFileStore {
  private data: Record<string, string> = {};
  private timer: NodeJS.Timeout | null = null;
  readonly file: string;

  constructor(file: string, private readonly delayMs = 400) {
    this.file = file;
    this.data = JsonFileStore.readFile(file) ?? JsonFileStore.readFile(file + '.bak') ?? {};
  }

  static readFile(file: string): Record<string, string> | null {
    try {
      if (!existsSync(file)) return null;
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
      return out;
    } catch {
      return null;
    }
  }

  getAll(): Record<string, string> {
    return { ...this.data };
  }

  get(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
  }

  set(key: string, value: string): void {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.schedule();
  }

  remove(key: string): void {
    if (!(key in this.data)) return;
    delete this.data[key];
    this.schedule();
  }

  replaceAll(next: Record<string, string>): void {
    this.data = { ...next };
    this.flush();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** 立刻寫入（關閉程式前呼叫） */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      writeAtomic(this.file, JSON.stringify(this.data, null, 1));
    } catch (e) {
      console.error('[store] 寫入失敗', this.file, e);
    }
  }
}

export function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (existsSync(file)) {
    try {
      copyFileSync(file, file + '.bak');
    } catch {
      /* 備份失敗不影響主檔 */
    }
  }
  renameSync(tmp, file);
}

/**
 * 遊戲的 kv：一般設定與紀錄分成兩個檔案（紀錄比較珍貴，分開放、分開備份）。
 */
export class GameKv {
  private readonly prefs: JsonFileStore;
  private readonly records: JsonFileStore;

  constructor(dir: string) {
    this.prefs = new JsonFileStore(path.join(dir, 'prefs.json'));
    this.records = new JsonFileStore(path.join(dir, 'records.json'));
  }

  private pick(key: string): JsonFileStore {
    return key.startsWith('last-table.records') ? this.records : this.prefs;
  }

  getAll(): Record<string, string> {
    return { ...this.prefs.getAll(), ...this.records.getAll() };
  }

  set(key: string, value: string): void {
    this.pick(key).set(key, value);
  }

  remove(key: string): void {
    this.pick(key).remove(key);
  }

  replaceAll(all: Record<string, string>): void {
    const p: Record<string, string> = {};
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) (k.startsWith('last-table.records') ? r : p)[k] = v;
    this.prefs.replaceAll(p);
    this.records.replaceAll(r);
  }

  flush(): void {
    this.prefs.flush();
    this.records.flush();
  }
}
