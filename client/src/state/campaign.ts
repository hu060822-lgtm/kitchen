import { useSyncExternalStore } from 'react';
import { NIGHT_COUNT } from '@last-table/shared';
import { kv } from '../platform';

/**
 * 連續七晚的進度（每個人自己的；應用程式存在電腦的檔案裡，網頁版在瀏覽器裡）：
 *   unlocked：可以選到第幾晚（打烊過第 n 晚 → 第 n+1 晚）
 *   fragments／outros：營業日誌裡已經讀過的故事碎片與結尾
 *   ending：第七晚的結局
 */
export interface Campaign {
  unlocked: number;
  fragments: number[];
  outros: number[];
  ending: 'served' | null;
  /** 無盡模式撐過最多幾天 */
  endlessBest: number;
}

const KEY = 'last-table.campaign';
const EMPTY: Campaign = { unlocked: 1, fragments: [], outros: [], ending: null, endlessBest: 0 };

function read(): Campaign {
  try {
    const raw = JSON.parse(kv.get(KEY) ?? 'null') as Partial<Campaign> | null;
    if (!raw) return EMPTY;
    const nums = (a: unknown) => (Array.isArray(a) ? [...new Set(a.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= NIGHT_COUNT))].sort((x, y) => x - y) : []);
    return {
      unlocked: Math.max(1, Math.min(NIGHT_COUNT, Number(raw.unlocked) || 1)),
      fragments: nums(raw.fragments),
      outros: nums(raw.outros),
      ending: raw.ending === 'served' ? 'served' : null,
      endlessBest: Math.max(0, Math.floor(Number(raw.endlessBest) || 0)),
    };
  } catch {
    return EMPTY;
  }
}

let cache = read();
const subs = new Set<() => void>();

function write(next: Campaign): void {
  cache = next;
  kv.set(KEY, JSON.stringify(next));
  subs.forEach((f) => f());
}

export const getCampaign = (): Campaign => cache;

export function useCampaign(): Campaign {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => cache,
  );
}

export function recordFragment(night: number): void {
  if (cache.fragments.includes(night)) return;
  write({ ...cache, fragments: [...cache.fragments, night].sort((a, b) => a - b) });
}

/** 打烊：這一晚的結尾讀過了，下一晚解鎖（第七晚只有送出那位客人的菜才算結局） */
export function recordNightEnd(night: number, ending: 'served' | 'missed' | null): void {
  const outros = cache.outros.includes(night) || (night === NIGHT_COUNT && ending !== 'served') ? cache.outros : [...cache.outros, night].sort((a, b) => a - b);
  const unlocked = Math.min(NIGHT_COUNT, Math.max(cache.unlocked, night + 1));
  const done = night === NIGHT_COUNT && ending === 'served' ? 'served' : cache.ending;
  if (outros === cache.outros && unlocked === cache.unlocked && done === cache.ending) return;
  write({ ...cache, outros, unlocked, ending: done });
}

/** 無盡模式：撐過了第 day 天 */
export function recordEndless(day: number): void {
  if (day <= cache.endlessBest) return;
  write({ ...cache, endlessBest: day });
}
