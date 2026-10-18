import { COMMISSIONS, COMMISSION_IDS, NEW_RECIPES, STARTER_COMMISSIONS, STORY_TABLE, RECIPES, type NightDef, type OrderKind, type RecipeGroup } from '@last-table/shared';

/**
 * 訂單排程（固定、可重現）：同一個種子永遠產生同一份排程。
 * 招牌菜照食譜做；主廚委託只給條件，做法由玩家決定。
 */

export interface OrderPlan {
  /** 營業開始後第幾秒出現 */
  at: number;
  kind: OrderKind;
  recipeId?: string;
  requestId?: string;
  table: number;
  /** 耐心倍率（依人數調整；省略＝1） */
  patience?: number;
  /** 第七晚：那位客人（最後一桌）的單 */
  story?: boolean;
}

/**
 * 依人數調整工作量：所有人數都能玩，不假設一定有固定搭檔。
 *   1 人：少幾張單、間隔拉長、客人比較有耐心
 *   2 人：張數不變、稍微放寬
 *   3–4 人：原始設計
 *   5–6、7–8 人：加單（插在原本的單之間），同時開著的單也比較多
 */
export interface CrewScale {
  players: number;
  patience: number;
  stretch: number;
  keep: number;
  extra: number;
  maxOpen: number;
}
export function crewScale(players: number): CrewScale {
  const n = Math.max(1, Math.min(8, Math.round(players)));
  if (n === 1) return { players: n, patience: 1.6, stretch: 1.35, keep: 7, extra: 0, maxOpen: 3 };
  if (n === 2) return { players: n, patience: 1.25, stretch: 1.1, keep: 11, extra: 0, maxOpen: 4 };
  if (n <= 4) return { players: n, patience: 1, stretch: 1, keep: 11, extra: 0, maxOpen: 4 };
  if (n <= 6) return { players: n, patience: 1, stretch: 1, keep: 11, extra: 4, maxOpen: 6 };
  return { players: n, patience: 1, stretch: 1, keep: 11, extra: 8, maxOpen: 8 };
}

/** 可重現的亂數（mulberry32）。狀態放在函式的 state 上，存檔時可以完整保存、讀檔時接著用 */
export interface Rng {
  (): number;
  state: number;
}
export function rng(seed: number): Rng {
  const f = (() => {
    f.state = (f.state + 0x6d2b79f5) >>> 0;
    let t = f.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;
  f.state = seed >>> 0;
  return f;
}

/**
 * 今日特餐：每一班從 24 道新食譜裡挑兩道（不同分類），放在後半段（第 8、10 張；單人第 6 張），前面維持招牌菜。
 * 用獨立的亂數序列，不影響其他訂單的桌號與順序（同一個種子永遠同樣的特餐）。
 */
export function pickSpecials(seed: number): [string, string] {
  const rand = rng((seed ^ 0x5eed5) >>> 0);
  const ids = Object.keys(NEW_RECIPES);
  const first = ids[Math.floor(rand() * ids.length)];
  const g: RecipeGroup | undefined = NEW_RECIPES[first].group;
  const rest = ids.filter((id) => NEW_RECIPES[id].group !== g);
  return [first, rest[Math.floor(rand() * rest.length)]];
}

/** 每一班兩張進階委託（不同的委託，同一個種子永遠一樣） */
export function pickAdvancedCommissions(seed: number): [string, string] {
  const rand = rng((seed ^ 0xc0ffee) >>> 0);
  const ids = COMMISSION_IDS.filter((id) => !STARTER_COMMISSIONS.includes(id));
  const a = ids[Math.floor(rand() * ids.length)];
  const rest = ids.filter((x) => x !== a);
  return [a, rest[Math.floor(rand() * rest.length)]];
}

/** 出單的額外調整（無盡模式的考驗、比較長的班次） */
export interface ScheduleOptions {
  /** 營業時間（秒）：超過 7 分鐘時，訂單一輪一輪接下去，越後面越密 */
  serviceSec?: number;
  /** 客人的耐心倍率 */
  patience?: number;
  /** 每一輪多加幾張單 */
  extra?: number;
}

const BASE_PASS_SEC = 420;

/**
 * 一個班次的訂單：招牌菜、今日特餐與主廚委託交錯，難度逐漸提高。
 * 第一輪約 7 分鐘（和原本一樣）；營業時間更長時接著出下一輪（換一批委託、間隔縮短）。
 */
export function buildSchedule(seed: number, players = 3, night: NightDef | null = null, opts: ScheduleOptions = {}): OrderPlan[] {
  const serviceSec = opts.serviceSec ?? BASE_PASS_SEC;
  const [spA, spB] = pickSpecials(seed);
  const rand = rng(seed);
  const sc = crewScale(players);
  const patience = sc.patience * (opts.patience ?? 1);
  const sig = (recipeId: string, at: number): OrderPlan => ({ at, kind: 'signature', recipeId, table: 1 + Math.floor(rand() * 5) });

  /** 一輪：五種入門委託洗牌，後兩張換成進階委託 */
  const pass = (adv: readonly [string, string] | readonly string[], gap: number, offset: number, first: boolean): OrderPlan[] => {
    const free = [...STARTER_COMMISSIONS];
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    free[3] = adv[0];
    free[4] = adv[1];
    const fr = (k: number, at: number): OrderPlan => ({ at, kind: 'free', requestId: free[k % free.length], table: 1 + Math.floor(rand() * 5) });
    const base = [
      sig('egg_toast', 0),
      fr(0, 25),
      sig('tomato_egg', 70),
      sig('onion_soup', 110),
      fr(1, 150),
      sig('egg_toast', 190),
      fr(2, 225),
      sig(spA, 265),
      fr(3, 300),
      sig(spB, 330),
      fr(4, 360),
    ];
    const out: OrderPlan[] = base.slice(0, sc.keep).map((o) => ({ ...o, at: offset + Math.round(o.at * sc.stretch * gap), patience }));
    // 單人只有前 7 張：第 6 張換成特餐，讓一個人玩也吃得到今日特餐
    if (sc.keep <= 7 && out[5]?.kind === 'signature') out[5] = { ...out[5], recipeId: first ? spA : spB };
    const extra = sc.extra + (opts.extra ?? 0);
    for (let k = 0; k < extra; k++) {
      const src = base[(1 + k * 3) % base.length];
      const at = offset + Math.round(Math.min(380, src.at + 12 + Math.floor(rand() * 10)) * gap);
      out.push(src.kind === 'signature' ? { ...sig(src.recipeId!, at), patience } : { ...fr(k + 1, at), patience });
    }
    return out;
  };

  // 第一輪（連續七晚：每晚指定兩張進階委託）
  const out = pass(night ? night.commissions : pickAdvancedCommissions(seed), 1, 0, true);
  // 營業時間比較長：一輪一輪接下去，間隔越來越短（最短 75%）
  if (serviceSec > BASE_PASS_SEC) {
    let offset = Math.max(...out.map((o) => o.at)) + 40;
    for (let k = 1; offset < serviceSec - 75 && k < 12; k++) {
      const gap = Math.max(0.75, 1 - 0.08 * k);
      const more = pass(pickAdvancedCommissions((seed + 101 * k) >>> 0), gap, offset, false).filter((o) => o.at < serviceSec - 45);
      out.push(...more);
      offset = Math.max(offset, ...more.map((o) => o.at)) + 40;
      if (!more.length) break;
    }
  }
  // 第七晚：那位客人點餐（營業到一半；很有耐心，但只有一張）
  if (night?.storyOrder) out.push({ at: Math.round(serviceSec * night.storyOrder.atFrac), kind: 'signature', recipeId: night.storyOrder.recipeId, table: STORY_TABLE, patience: 2.5, story: true });
  return out.sort((a, b) => a.at - b.at);
}

/** 客人願意等多久（毫秒） */
export function patienceMs(p: Pick<OrderPlan, 'kind' | 'recipeId' | 'requestId' | 'patience'>): number {
  if (p.kind !== 'signature') {
    const c = COMMISSIONS[p.requestId!];
    // 限時委託：客人等的時間就是時限（不因人數放寬）
    if (c.timeLimitSec) return c.timeLimitSec * 1000;
    return Math.round(c.parSec * 2.4 * (p.patience ?? 1)) * 1000;
  }
  return Math.round(RECIPES[p.recipeId!].parSec * 2.4 * (p.patience ?? 1)) * 1000;
}

/** 同時最多幾張單（3–4 人）：超過時下一張延後；其他人數見 crewScale */
export const MAX_OPEN_ORDERS = 4;
export const ORDER_DELAY_MS = 15_000;
