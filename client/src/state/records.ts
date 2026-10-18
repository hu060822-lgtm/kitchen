import { useSyncExternalStore } from 'react';
import { GRADE_LABEL, INGREDIENTS, gradeOf, type CommissionResult, type DishAnalysis, type DishKind, type KitchenPublic, type QualityGrade } from '@last-table/shared';
import { useStore } from './store';
import { keyLabel } from '../game/keymap';
import { kv } from '../platform';

/**
 * 本機紀錄（存檔評估的方案 A）：料理圖鑑與每一班的成績，存在這台電腦的瀏覽器裡。
 *
 * - 判定都由伺服器做（名稱、分類、品質都在出餐結果裡）；這裡只負責「記下來」，不會影響任何分數。
 * - 團隊做出的每一道菜都算進每個人自己的圖鑑（同一道菜只記一筆，保留最好的一次）。
 * - 換電腦、清除瀏覽器資料就會不見；之後要跨裝置再改成伺服器帳號（方案 D）。
 */

const KEY = 'last-table.records';
const VERSION = 1;

export interface Discovery {
  key: string;
  name: string;
  kind: DishKind;
  recipeId?: string;
  firstAt: number;
  lastAt: number;
  count: number;
  best: number;
  bestGrade: QualityGrade;
  /** 最好的那一次怎麼做的 */
  how: {
    order: string[];
    cuts: string[];
    style: DishAnalysis['style'];
    sauce: DishAnalysis['sauce'];
    seasoning: DishAnalysis['seasoning'];
    quality: DishAnalysis['quality'];
    changes?: string[];
  };
}

export interface ShiftRecord {
  at: number;
  served: number;
  missed: number;
  avg: number;
  players: number;
}

export interface CommissionLog {
  count: number;
  passed: number;
  best: number;
  bestGrade: QualityGrade;
  /** 用過哪些料理完成（換一道菜完成同一個委託有額外獎勵） */
  dishes: string[];
}

export interface Records {
  v: number;
  discoveries: Record<string, Discovery>;
  shifts: ShiftRecord[];
  /** 委託獎勵累積的遊戲幣 */
  coins: number;
  commissions: Record<string, CommissionLog>;
}

const empty = (): Records => ({ v: VERSION, discoveries: {}, shifts: [], coins: 0, commissions: {} });

/** 用不同的料理完成同一個委託：額外的遊戲幣（鼓勵嘗試，不是重複最簡單的那道） */
export const NEW_DISH_BONUS = 10;

/** 稱號：依紀錄解鎖（只是紀錄，不影響遊戲） */
export const TITLES: Array<{ id: string; name: string; desc: string; test: (r: Records) => boolean }> = [
  { id: 'first', name: '見習主廚', desc: '完成第一個主廚委託', test: (r) => Object.values(r.commissions).some((c) => c.passed > 0) },
  { id: 'five', name: '委託熟手', desc: '完成 5 次委託', test: (r) => Object.values(r.commissions).reduce((a, c) => a + c.passed, 0) >= 5 },
  { id: 'wide', name: '全能主廚', desc: '完成 10 種不同的委託', test: (r) => Object.values(r.commissions).filter((c) => c.passed > 0).length >= 10 },
  { id: 'free', name: '自由發揮', desc: '圖鑑裡有 5 道新創料理', test: (r) => Object.values(r.discoveries).filter((d) => d.kind === 'new').length >= 5 },
  { id: 'book', name: '食譜收藏家', desc: '做出 12 道不同的食譜', test: (r) => Object.values(r.discoveries).filter((d) => d.kind === 'known').length >= 12 },
  { id: 'chef', name: '主廚推薦', desc: '任何一道委託拿到「主廚推薦」', test: (r) => Object.values(r.commissions).some((c) => c.bestGrade === 'chef') },
];

function load(): Records {
  try {
    const raw = kv.get(KEY);
    if (!raw) return empty();
    const r = JSON.parse(raw) as Records;
    if (r?.v !== VERSION || typeof r.discoveries !== 'object') return empty();
    return {
      v: VERSION,
      discoveries: r.discoveries ?? {},
      shifts: Array.isArray(r.shifts) ? r.shifts : [],
      coins: typeof r.coins === 'number' ? r.coins : 0,
      commissions: typeof r.commissions === 'object' && r.commissions ? r.commissions : {},
    };
  } catch {
    return empty();
  }
}

let records = load();
let version = 0;
const listeners = new Set<() => void>();

function save(): void {
  try {
    kv.set(KEY, JSON.stringify(records));
  } catch {
    /* 存不了（私密視窗、空間滿）：這次開著時仍然有效 */
  }
  version++;
  listeners.forEach((l) => l());
}

export function getRecords(): Records {
  return records;
}

export function useRecords(): Records {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
  return records;
}

export function clearRecords(): void {
  records = empty();
  save();
}

/** 記下一道出餐的菜；回傳是不是第一次做出來 */
export function recordDish(a: DishAnalysis, now = Date.now()): boolean {
  // 失敗料理不進圖鑑（但還是可以在結果裡看到原因）
  if (a.kind === 'failed') return false;
  const prev = records.discoveries[a.key];
  const how: Discovery['how'] = {
    order: a.order,
    cuts: a.record.filter((r) => r.cut !== 'WHOLE').map((r) => `${INGREDIENTS[r.type].label}`),
    style: a.style,
    sauce: a.sauce,
    seasoning: a.seasoning,
    quality: a.quality,
    changes: a.changes,
  };
  if (!prev) {
    records = {
      ...records,
      discoveries: {
        ...records.discoveries,
        [a.key]: { key: a.key, name: a.name, kind: a.kind, recipeId: a.recipeId, firstAt: now, lastAt: now, count: 1, best: a.quality.total, bestGrade: gradeOf(a.quality.total), how },
      },
    };
    save();
    return true;
  }
  const better = a.quality.total > prev.best;
  records = {
    ...records,
    discoveries: {
      ...records.discoveries,
      [a.key]: {
        ...prev,
        lastAt: now,
        count: prev.count + 1,
        ...(better ? { best: a.quality.total, bestGrade: gradeOf(a.quality.total), how, name: a.name } : {}),
      },
    },
  };
  save();
  return false;
}

/** 記下一張委託的結果；回傳這次拿到的遊戲幣（含換菜獎勵） */
export function recordCommission(c: CommissionResult, dishName: string | undefined, total: number): number {
  const prev = records.commissions[c.id] ?? { count: 0, passed: 0, best: 0, bestGrade: 'fail' as QualityGrade, dishes: [] };
  const fresh = c.passed && !!dishName && !prev.dishes.includes(dishName);
  const coins = c.passed ? c.coins + (fresh && prev.passed > 0 ? NEW_DISH_BONUS : 0) : 0;
  const better = c.passed && total > prev.best;
  records = {
    ...records,
    coins: records.coins + coins,
    commissions: {
      ...records.commissions,
      [c.id]: {
        count: prev.count + 1,
        passed: prev.passed + (c.passed ? 1 : 0),
        best: better ? total : prev.best,
        bestGrade: better ? c.grade : prev.bestGrade,
        dishes: fresh ? [...prev.dishes, dishName!].slice(-10) : prev.dishes,
      },
    },
  };
  save();
  return coins;
}

export function recordShift(s: ShiftRecord): void {
  records = { ...records, shifts: [s, ...records.shifts].slice(0, 30) };
  save();
}

/* ------------------------------ 從伺服器的狀態自動記錄 ------------------------------ */

const seenOrders = new Set<string>();
let seenRoom = '';
let shiftLogged = false;

function onKitchen(k: KitchenPublic | null): void {
  const st = useStore.getState();
  const room = st.room?.code ?? '';
  if (room !== seenRoom) {
    seenRoom = room;
    seenOrders.clear();
    shiftLogged = false;
    // 重新連線、重新整理：已經出過的菜不重複記錄
    for (const o of k?.orders ?? []) if (o.result) seenOrders.add(o.id);
    return;
  }
  if (!k) return;
  if (k.phase !== 'CLOSED') shiftLogged = false;
  for (const o of k.orders) {
    if (!o.result?.analysis || seenOrders.has(o.id)) continue;
    seenOrders.add(o.id);
    const a = o.result.analysis;
    const c = o.result.commission;
    const before = TITLES.filter((t) => t.test(records)).map((t) => t.id);
    if (recordDish(a)) st.pushNotice({ tone: 'info', text: `📖 新發現：${a.name}（已記進料理圖鑑：按 ${keyLabel('cookbook')} 打開食譜）` }, 7000);
    if (c) {
      const coins = recordCommission(c, a.kind === 'failed' ? undefined : a.name, o.result.total);
      if (coins) st.pushNotice({ tone: 'info', text: `🪙 委託「${c.title}」達成（${GRADE_LABEL[c.grade]}）：＋${coins} 枚${coins > c.coins ? '（用了新的料理）' : ''}` }, 6000);
    }
    for (const t of TITLES) if (!before.includes(t.id) && t.test(records)) st.pushNotice({ tone: 'info', text: `🏅 解鎖稱號：${t.name}（${t.desc}）` }, 7000);
  }
  if (k.phase === 'CLOSED' && !shiftLogged) {
    shiftLogged = true;
    const served = k.orders.filter((o) => o.result);
    recordShift({
      at: Date.now(),
      served: k.stats.served,
      missed: k.stats.missed,
      avg: served.length ? Math.round(served.reduce((a, o) => a + (o.result?.total ?? 0), 0) / served.length) : 0,
      players: Object.keys(k.players).length,
    });
  }
}

let started = false;
/** 開始監聽（App 啟動時呼叫一次） */
export function startRecords(): void {
  if (started) return;
  started = true;
  let last: KitchenPublic | null = null;
  useStore.subscribe((s) => {
    if (s.kitchen === last) return;
    last = s.kitchen;
    onKitchen(s.kitchen);
  });
}
