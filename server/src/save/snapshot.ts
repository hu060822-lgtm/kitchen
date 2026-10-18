/**
 * 遊戲狀態的快照與還原（房主模式的存檔）。
 *
 * 做法：把物件圖「走一遍」轉成 JSON 可以表示的資料，讀檔時再「疊回」一份用同樣設定重新建立的物件上。
 *   - 一般物件與陣列照樣保存；Map、Set、Infinity／NaN、亂數產生器的內部狀態用標記保存（JSON 本身表示不了）。
 *   - 函式（方法、回呼）不保存——讀檔時用新建立的物件身上原本的函式；亂數產生器例外（它的 state 會保存並還原）。
 *   - 指回上層的參照（例如缺陷卡系統裡的 sim、模擬裡的 hooks）用 skip 列出，不保存也不覆蓋。
 *   - 疊回時：目標上原本是物件（類別實例、Map 的值）就遞迴疊回，保留它的類別與方法；
 *     資料裡沒有的 Map 鍵會被刪掉；其他值直接取代。
 * 同一個物件被兩個地方參照時，存檔後會變成兩份相同的資料（遊戲狀態只用 id 互相參照，不依賴物件身分）。
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const MAP = '__map';
const SET = '__set';
const NUM = '__num';
const RNG = '__rng';

export interface SnapshotOptions {
  /** 不保存的欄位名稱（指回上層的參照、執行期資料） */
  skip?: ReadonlySet<string>;
}

const isStatefulFn = (v: unknown): v is { state: number } => typeof v === 'function' && typeof (v as { state?: unknown }).state === 'number';

export function snapshot(value: unknown, opts: SnapshotOptions = {}): Json {
  const skip = opts.skip ?? new Set<string>();
  const stack = new Set<object>();
  const walk = (v: unknown, path: string): Json | undefined => {
    if (v === null) return null;
    switch (typeof v) {
      case 'boolean':
      case 'string':
        return v;
      case 'number':
        return Number.isFinite(v) ? v : { [NUM]: String(v) };
      case 'undefined':
        return undefined;
      case 'function':
        return isStatefulFn(v) ? { [RNG]: v.state } : undefined;
      case 'bigint':
      case 'symbol':
        throw new Error(`無法存檔的資料型別（${typeof v}）：${path}`);
    }
    const o = v as object;
    if (stack.has(o)) throw new Error(`循環參照，無法存檔：${path}`);
    stack.add(o);
    try {
      if (Array.isArray(o)) return o.map((x, i) => walk(x, `${path}[${i}]`) ?? null);
      if (o instanceof Map) return { [MAP]: [...o.entries()].map(([k, x]) => [walk(k, `${path}<key>`) ?? null, walk(x, `${path}.${String(k)}`) ?? null]) };
      if (o instanceof Set) return { [SET]: [...o].map((x, i) => walk(x, `${path}{${i}}`) ?? null) };
      if (o instanceof Date) return { [NUM]: String(o.getTime()) };
      const out: { [k: string]: Json } = {};
      for (const [k, x] of Object.entries(o)) {
        if (skip.has(k)) continue;
        const j = walk(x, `${path}.${k}`);
        if (j !== undefined) out[k] = j;
      }
      return out;
    } finally {
      stack.delete(o);
    }
  };
  return walk(value, '$') ?? null;
}

const tagged = (j: Json, tag: string): j is { [k: string]: Json } => !!j && typeof j === 'object' && !Array.isArray(j) && tag in j && Object.keys(j).length === 1;

/** 把快照轉回一般的值（新的物件；Map、Set、特殊數字都還原） */
export function revive(j: Json): unknown {
  if (j === null || typeof j !== 'object') return j;
  if (Array.isArray(j)) return j.map(revive);
  if (tagged(j, NUM)) return Number(j[NUM]);
  if (tagged(j, MAP)) return new Map((j[MAP] as Json[]).map((e) => [revive((e as Json[])[0]), revive((e as Json[])[1])]));
  if (tagged(j, SET)) return new Set((j[SET] as Json[]).map(revive));
  if (tagged(j, RNG)) return { [RNG]: j[RNG] };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(j as { [k: string]: Json })) out[k] = revive(x);
  return out;
}

const isPlainData = (j: Json): j is { [k: string]: Json } => !!j && typeof j === 'object' && !Array.isArray(j) && !tagged(j, NUM) && !tagged(j, MAP) && !tagged(j, SET) && !tagged(j, RNG);

/**
 * 把快照疊回既有的物件（保留它的類別、方法與 skip 的欄位）。
 * 回傳疊回的欄位數（測試用）。
 */
export function restore(target: object, data: Json, opts: SnapshotOptions = {}): void {
  const skip = opts.skip ?? new Set<string>();
  const into = (t: Record<string, unknown>, d: { [k: string]: Json }) => {
    for (const [k, j] of Object.entries(d)) {
      if (skip.has(k)) continue;
      t[k] = merge(t[k], j);
    }
  };
  const merge = (cur: unknown, j: Json): unknown => {
    // 亂數產生器：還原內部狀態，函式本身沿用
    if (tagged(j, RNG)) {
      if (isStatefulFn(cur)) {
        cur.state = j[RNG] as number;
        return cur;
      }
      throw new Error('存檔裡的亂數狀態對不上目前的物件');
    }
    if (tagged(j, MAP)) {
      if (cur instanceof Map) {
        const entries = (j[MAP] as Json[]).map((e) => [revive((e as Json[])[0]), (e as Json[])[1]] as const);
        const keep = new Set(entries.map(([k]) => k));
        for (const k of [...cur.keys()]) if (!keep.has(k)) cur.delete(k);
        for (const [k, x] of entries) cur.set(k, merge(cur.get(k), x));
        return cur;
      }
      return revive(j);
    }
    if (tagged(j, SET)) {
      if (cur instanceof Set) {
        cur.clear();
        for (const x of j[SET] as Json[]) cur.add(revive(x));
        return cur;
      }
      return revive(j);
    }
    if (isPlainData(j) && cur && typeof cur === 'object' && !Array.isArray(cur) && !(cur instanceof Map) && !(cur instanceof Set)) {
      // 類別實例（或 Map 的值）：遞迴疊回，資料裡沒有的欄位（例如 skip 的 def）保留原值
      if (Object.getPrototypeOf(cur) !== Object.prototype) {
        into(cur as Record<string, unknown>, j);
        return cur;
      }
      // 一般物件：保留 skip 的欄位，其餘以資料為準
      const fresh = revive(j) as Record<string, unknown>;
      for (const k of skip) if (k in (cur as object)) fresh[k] = (cur as Record<string, unknown>)[k];
      return fresh;
    }
    return revive(j);
  };
  if (!isPlainData(data)) throw new Error('存檔格式不正確');
  into(target as Record<string, unknown>, data);
}
