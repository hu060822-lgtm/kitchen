import { useSyncExternalStore } from 'react';
import { CATEGORY_NAME, CATEGORY_ORDER, INGREDIENTS, INGREDIENT_IDS, type IngredientCategory, type IngredientId, type Storage } from '@last-table/shared';
import { kv } from '../platform';

/**
 * 冷藏架／乾貨架的分類分頁（v3 擴充後兩個架子各有十幾二十種食材）。
 * 目前選的分頁同時決定：面板列出哪些食材、數字鍵 1–9 拿哪一種（面板裡與「看著架子」時都一樣）。
 * 一個分類超過 9 種就分成兩頁（「蔬菜」「蔬菜 2」），每一種都有數字鍵。
 * 數字鍵 0 換到下一個分頁。選擇記在這台電腦的瀏覽器裡（下次打開還是同一頁）。
 */

/** 分頁代號：`veg`、`veg:2` */
export type StorageTab = string;
const PAGE = 9;
const KEY = 'last-table.storageTab';
const listeners = new Set<() => void>();
let version = 0;

function load(): Partial<Record<Storage, StorageTab>> {
  try {
    const raw = kv.get(KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<Storage, StorageTab>>) : {};
  } catch {
    return {};
  }
}
let current = load();

const idsOf = (storage: Storage, c: IngredientCategory): IngredientId[] => INGREDIENT_IDS.filter((id) => INGREDIENTS[id].storage === storage && INGREDIENTS[id].category === c);

/** 這個架子有哪些分頁（照固定的分類順序） */
export function storageTabs(storage: Storage): StorageTab[] {
  const out: StorageTab[] = [];
  for (const c of CATEGORY_ORDER) {
    const n = idsOf(storage, c).length;
    for (let p = 0; p * PAGE < n; p++) out.push(p ? `${c}:${p + 1}` : c);
  }
  return out;
}

export function currentTab(storage: Storage): StorageTab {
  const tabs = storageTabs(storage);
  const c = current[storage];
  return c && tabs.includes(c) ? c : tabs[0];
}

export function setTab(storage: Storage, t: StorageTab): void {
  current = { ...current, [storage]: t };
  try {
    kv.set(KEY, JSON.stringify(current));
  } catch {
    /* 存不了就只在這次有效 */
  }
  version++;
  listeners.forEach((l) => l());
}

/** 下一個分頁（數字鍵 0） */
export function nextTab(storage: Storage): StorageTab {
  const tabs = storageTabs(storage);
  const t = tabs[(tabs.indexOf(currentTab(storage)) + 1) % tabs.length];
  setTab(storage, t);
  return t;
}

/** 某個分頁裡的食材（照資料順序，最多 9 種） */
export function tabIds(storage: Storage, t: StorageTab = currentTab(storage)): IngredientId[] {
  const [c, p] = t.split(':');
  const page = Number(p ?? 1) - 1;
  return idsOf(storage, c as IngredientCategory).slice(page * PAGE, page * PAGE + PAGE);
}

export function tabLabel(t: StorageTab): string {
  const [c, p] = t.split(':');
  return `${CATEGORY_NAME[c as IngredientCategory]}${p ? ` ${p}` : ''}`;
}

export function useStorageTab(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}
