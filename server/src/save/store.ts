import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { isFlawId, isSeat, type FlawId, type Seat, type ShiftPhase } from '@last-table/shared';
import type { Room, RoomSaveState } from '../rooms/room';
import type { Json } from './snapshot';

/**
 * 房主模式的存檔檔案。
 *
 * 健全性：
 *   - 原子寫入：先寫暫存檔、fsync，再改名取代；寫到一半當機也不會留下壞掉的存檔。
 *   - 自動存檔輪替三格（每個房間），上一份保留成 .bak；手動存檔、離開時的存檔、打烊時的存檔各自獨立，不會被輪替掉。
 *   - 校驗碼（SHA-256）：讀檔時檢查內容沒有被截斷或改壞；壞掉就自動改讀 .bak。
 *   - 格式與版本：檔頭標明格式與版本，舊版存檔讀取時先升級（migrate），比遊戲新的版本拒絕讀取並說明原因。
 *   - 結構檢查：玩家、席位、缺陷卡、模擬資料都要存在且合法，才會交給房間讀檔。
 *   - 檔名只能是存檔資料夾裡的檔案（不接受路徑），避免讀寫到資料夾以外的地方。
 */

export const SAVE_FORMAT = 'last-table-save';
export const SAVE_VERSION = 1;
export const AUTO_SLOTS = 3;

export type SaveKind = 'auto' | 'manual' | 'exit' | 'closed';
export const SAVE_KIND_LABEL: Record<SaveKind, string> = { auto: '自動存檔', manual: '手動存檔', exit: '關閉時存檔', closed: '打烊時存檔' };

export interface SaveMeta {
  format: typeof SAVE_FORMAT;
  version: number;
  /** 存檔時的遊戲版本 */
  game: string;
  savedAt: number;
  kind: SaveKind;
  code: string;
  players: Array<{ name: string; role: Seat | null; flaw: FlawId | null; host: boolean }>;
  /** 班次階段與進度 */
  phase: ShiftPhase;
  shiftSec: number;
  served: number;
  missed: number;
  /** 連續七晚的第幾晚 */
  night?: number;
  /** 無盡模式的第幾天 */
  endless?: number;
}

export interface SaveFile {
  meta: SaveMeta;
  checksum: string;
  state: { room: RoomSaveState; sim: Json };
}

export interface SaveEntry extends SaveMeta {
  file: string;
  size: number;
}

export class SaveError extends Error {}

const checksumOf = (meta: SaveMeta, state: SaveFile['state']): string => createHash('sha256').update(JSON.stringify({ meta, state })).digest('hex');

/** 舊版存檔升級到目前的版本（目前只有第 1 版） */
function migrate(raw: SaveFile): SaveFile {
  if (raw.meta.version > SAVE_VERSION) throw new SaveError(`這個存檔來自比較新的遊戲版本（存檔格式 ${raw.meta.version}，這個版本只讀得懂 ${SAVE_VERSION}），請先更新遊戲。`);
  return raw;
}

/** 檢查存檔的結構；有問題就丟出看得懂的錯誤 */
export function validateSave(raw: unknown): SaveFile {
  const f = raw as SaveFile;
  if (!f || typeof f !== 'object' || !f.meta || f.meta.format !== SAVE_FORMAT) throw new SaveError('這不是《最後一桌》的存檔。');
  if (typeof f.meta.version !== 'number') throw new SaveError('存檔缺少版本資訊。');
  if (typeof f.checksum !== 'string' || checksumOf(f.meta, f.state) !== f.checksum) throw new SaveError('存檔內容不完整或被改動過（校驗碼不符）。');
  const m = migrate(f);
  const r = m.state?.room;
  if (!r || typeof r.code !== 'string' || !/^[A-Z0-9]{4,8}$/.test(r.code)) throw new SaveError('存檔裡的房間資料不正確。');
  if (r.phase !== 'PLAYING') throw new SaveError('存檔不是進行中的班次。');
  if (!Array.isArray(r.players) || r.players.length < 1 || r.players.length > 8) throw new SaveError('存檔裡的玩家資料不正確。');
  const seats = new Set<string>();
  for (const p of r.players) {
    if (typeof p.id !== 'string' || typeof p.token !== 'string' || p.token.length < 16 || typeof p.name !== 'string' || !p.name) throw new SaveError('存檔裡有不完整的玩家資料。');
    if (p.role !== null && !isSeat(p.role)) throw new SaveError(`存檔裡有不認得的席位：${String(p.role)}`);
    if (p.flaw !== null && !isFlawId(p.flaw)) throw new SaveError(`存檔裡有不認得的缺陷卡：${String(p.flaw)}`);
    if (p.role) {
      if (seats.has(p.role)) throw new SaveError('存檔裡有兩個人坐同一個席位。');
      seats.add(p.role);
    }
    if (!p.pose || !Number.isFinite(p.pose.x) || !Number.isFinite(p.pose.z)) throw new SaveError('存檔裡的玩家位置不正確。');
  }
  if (!r.players.some((p) => p.id === r.hostId)) throw new SaveError('存檔裡找不到房主。');
  const sim = m.state.sim as Record<string, unknown> | null;
  if (!sim || typeof sim !== 'object' || typeof sim.t !== 'number' || !sim.items || !sim.stations || !sim.players) throw new SaveError('存檔裡的廚房資料不完整。');
  return m;
}

/** 從房間產生存檔內容 */
export function buildSave(room: Room, kind: SaveKind, game: string): SaveFile {
  const state = room.exportState();
  const sim = room.sim!;
  const meta: SaveMeta = {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    game,
    savedAt: Date.now(),
    kind,
    code: room.code,
    players: state.room.players.map((p) => ({ name: p.name, role: p.role, flaw: p.flaw, host: p.id === state.room.hostId })),
    phase: sim.phase,
    shiftSec: Math.round(sim.t / 1000),
    served: sim.stats.served,
    missed: sim.stats.missed,
    ...(room.night ? { night: room.night } : {}),
    ...(room.endless ? { endless: room.endless } : {}),
  };
  return { meta, checksum: checksumOf(meta, state), state };
}

const stamp = (t: number): string => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export class SaveStore {
  constructor(
    readonly dir: string,
    readonly game = '0.1.0',
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /** 只接受存檔資料夾裡的檔名 */
  private pathOf(file: string): string {
    const base = path.basename(file);
    if (base !== file || !base.endsWith('.json') || base.startsWith('.')) throw new SaveError('存檔檔名不正確。');
    return path.join(this.dir, base);
  }

  private atomicWrite(target: string, text: string, keepBak: boolean): void {
    const tmp = `${target}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (keepBak && existsSync(target)) {
      try {
        copyFileSync(target, `${target}.bak`);
      } catch {
        /* 備份失敗不影響存檔 */
      }
    }
    renameSync(tmp, target);
  }

  /** 存檔；自動存檔輪替 AUTO_SLOTS 格 */
  write(room: Room, kind: SaveKind): { file: string; meta: SaveMeta } {
    const save = buildSave(room, kind, this.game);
    let file: string;
    if (kind === 'auto') {
      const slots = Array.from({ length: AUTO_SLOTS }, (_, i) => `auto-${room.code}-${i + 1}.json`);
      // 寫進最舊的那一格（沒有的格子優先）
      const age = (f: string) => (existsSync(path.join(this.dir, f)) ? statSync(path.join(this.dir, f)).mtimeMs : -1);
      file = slots.reduce((a, b) => (age(b) < age(a) ? b : a));
    } else {
      file = `${room.code}-${stamp(save.meta.savedAt)}-${kind}.json`;
    }
    this.atomicWrite(this.pathOf(file), JSON.stringify(save), kind === 'auto');
    return { file, meta: save.meta };
  }

  /** 讀檔；內容壞掉時改讀 .bak */
  read(file: string): SaveFile {
    const p = this.pathOf(file);
    const tryRead = (q: string): SaveFile => {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(q, 'utf8'));
      } catch {
        throw new SaveError('存檔讀不出來（檔案不存在或內容壞掉）。');
      }
      return validateSave(raw);
    };
    try {
      return tryRead(p);
    } catch (e) {
      if (existsSync(`${p}.bak`)) {
        try {
          return tryRead(`${p}.bak`);
        } catch {
          /* 備份也壞了：回報原本的錯誤 */
        }
      }
      throw e;
    }
  }

  /** 所有存檔（新的在前）；壞掉的存檔不會出現在清單裡 */
  list(): SaveEntry[] {
    const out: SaveEntry[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const s = this.read(f);
        out.push({ ...s.meta, file: f, size: statSync(path.join(this.dir, f)).size });
      } catch {
        /* 跳過壞掉的檔案 */
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  remove(file: string): void {
    const p = this.pathOf(file);
    for (const q of [p, `${p}.bak`]) if (existsSync(q)) unlinkSync(q);
  }

  /** 匯入外部的存檔檔案（先檢查，合格才複製進存檔資料夾） */
  importFrom(src: string): string {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(src, 'utf8'));
    } catch {
      throw new SaveError('這個檔案讀不出來。');
    }
    const s = validateSave(raw);
    const file = `${s.meta.code}-${stamp(s.meta.savedAt)}-imported.json`;
    this.atomicWrite(this.pathOf(file), JSON.stringify(s), false);
    return file;
  }

  /** 匯出到外部路徑 */
  exportTo(file: string, dest: string): void {
    const s = this.read(file);
    writeFileAtomic(dest, JSON.stringify(s, null, 1));
  }
}

function writeFileAtomic(dest: string, text: string): void {
  const tmp = `${dest}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);
}
