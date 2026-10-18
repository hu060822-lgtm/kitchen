import type { NightGuestTune, NightMonsterTune } from './nights';

/**
 * 無盡模式：一天接一天，每天抽幾個隨機的「考驗」，天數越多越難。
 * 一天之內跑單（沒出成的單）超過上限，這一輪就結束；紀錄是撐過的天數。
 *
 * 伺服器依 endlessDay() 調整出單、存貨、碗盤、門禁與威脅；用戶端用同一個函式顯示今天的考驗。
 */

export type EndlessChallengeId =
  | 'rush'
  | 'crowd'
  | 'shortage'
  | 'dishes'
  | 'lock'
  | 'hungry'
  | 'swift'
  | 'keen'
  | 'linger'
  | 'fickle'
  | 'guest';

export interface EndlessChallenge {
  id: EndlessChallengeId;
  title: string;
  text: string;
  /** 從第幾天起才會抽到 */
  from: number;
}

export const ENDLESS_CHALLENGES: readonly EndlessChallenge[] = [
  { id: 'rush', title: '急性子', text: '今天的客人比較沒耐心：每張單的時間少四分之一。', from: 1 },
  { id: 'crowd', title: '客滿', text: '訂位全滿：每一輪多出三張單。', from: 1 },
  { id: 'shortage', title: '缺貨', text: '供應商沒送齊：冷藏架和乾貨架的存貨只有一半（送貨照常）。', from: 1 },
  { id: 'dishes', title: '碗盤不夠', text: '洗碗機壞了：乾淨的碗盤只有一半，記得洗。', from: 2 },
  { id: 'guest', title: '他坐近了', text: '那位客人一開始就坐得比較近，也比較早出現、動得比較快。', from: 1 },
  { id: 'hungry', title: '牠餓了', text: '後門外的東西比較快想進來，離開後也比較快回來。', from: 2 },
  { id: 'keen', title: '牠耳朵很靈', text: '腳步聲、跑步、鍋碗的聲音，牠都聽得更清楚。', from: 2 },
  { id: 'fickle', title: '牠很善變', text: '牠每 10 秒就換追另一個人（平常是 20 秒）。', from: 3 },
  { id: 'linger', title: '牠不想走', text: '牠每次進來會待久一點。', from: 3 },
  { id: 'swift', title: '牠變快了', text: '牠走得更快、追得更緊。', from: 4 },
  { id: 'lock', title: '後門鎖壞了', text: '監視器鎖不了後門：聽到刮門聲，只能靠防火門和置物櫃。', from: 5 },
];

export const ENDLESS_BY_ID = Object.fromEntries(ENDLESS_CHALLENGES.map((c) => [c.id, c])) as Record<EndlessChallengeId, EndlessChallenge>;

export interface EndlessDay {
  day: number;
  challenges: EndlessChallengeId[];
  monster: NightMonsterTune;
  guest: NightGuestTune;
  /** 出單：客人的耐心倍率、每輪多幾張 */
  patience: number;
  extra: number;
  /** 開班時的存貨、乾淨碗盤倍率 */
  stockMul: number;
  dishMul: number;
  /** 監視器不能鎖後門 */
  backLockBroken: boolean;
  /** 這一天最多可以跑幾張單（超過就結束這一輪） */
  missLimit: number;
}

/** 可重現的亂數（同一個種子、同一天，抽到的考驗一樣） */
function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 第 day 天（1 起）抽幾個考驗：1、1、2、2、3、3、4、4… 最多 5 個 */
export const endlessChallengeCount = (day: number): number => Math.min(5, Math.ceil(day / 2));

/** 一天最多可以跑幾張單：人越多單越多，上限也高一點 */
export const endlessMissLimit = (players: number): number => 3 + Math.floor(Math.max(1, players) / 2);

/** 基本難度（還沒加上考驗）：每天一點一點變難，有上限，不會變成不可能 */
export function endlessBase(day: number): { monster: NightMonsterTune; guest: NightGuestTune; patience: number; extra: number } {
  const n = Math.max(1, Math.floor(day)) - 1;
  const monster: NightMonsterTune = {
    hunger: Math.max(0.55, 1.3 - 0.07 * n),
    noise: Math.min(1.6, 0.9 + 0.07 * n),
    stay: Math.min(1.35, 0.9 + 0.05 * n),
    speed: Math.min(1.08, 1 + 0.012 * n),
    loseSight: 1,
    returnHunger: Math.min(35, 5 * n),
  };
  const guest: NightGuestTune = {
    appearMs: Math.max(25_000, 90_000 - 8000 * n),
    stepMs: Math.max(4500, 8000 - 350 * n),
    startIdx: Math.min(3, Math.floor(n / 3)),
    calm: Math.max(0.7, 1.2 - 0.05 * n),
  };
  const patience = Math.max(0.65, 1 - 0.03 * n);
  const extra = Math.min(6, Math.floor(n / 2));
  return { monster, guest, patience, extra };
}

export function endlessDay(day: number, seed: number, players = 3): EndlessDay {
  const d = Math.max(1, Math.floor(day));
  const rand = rng(seed * 31 + d * 7919);
  const pool = ENDLESS_CHALLENGES.filter((c) => c.from <= d).map((c) => c.id);
  const challenges: EndlessChallengeId[] = [];
  const want = Math.min(pool.length, endlessChallengeCount(d));
  while (challenges.length < want) {
    const id = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    challenges.push(id);
  }
  const has = (id: EndlessChallengeId) => challenges.includes(id);
  const { monster, guest, ...base } = endlessBase(d);
  let { patience, extra } = base;
  if (has('rush')) patience *= 0.75;
  if (has('crowd')) extra += 3;
  if (has('hungry')) {
    monster.hunger *= 0.6;
    monster.returnHunger += 25;
  }
  if (has('keen')) monster.noise *= 1.6;
  if (has('fickle')) monster.loseSight = 0.5;
  if (has('linger')) monster.stay *= 1.35;
  // 追人的速度（3.8 × 倍率）要比人跑步（4.4）慢一點，否則逃不掉
  if (has('swift')) monster.speed = Math.min(1.14, monster.speed + 0.08);
  if (has('guest')) {
    guest.startIdx = Math.min(4, guest.startIdx + 1);
    guest.stepMs = Math.round(guest.stepMs * 0.75);
    guest.appearMs = Math.round(guest.appearMs * 0.5);
  }

  return {
    day: d,
    challenges,
    monster,
    guest,
    patience,
    extra,
    stockMul: has('shortage') ? 0.5 : 1,
    dishMul: has('dishes') ? 0.5 : 1,
    backLockBroken: has('lock'),
    missLimit: endlessMissLimit(players),
  };
}
