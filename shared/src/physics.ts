/**
 * 簡單的物理（伺服器判定、畫面跟著演）：
 *   積水：跑步踩到會滑一段、手上的東西可能掉、跌倒的聲音會引來怪物；擦乾或放久會乾。
 *   丟東西：沿著固定的拋物線飛過去；隊友面向你、手有空就接住，沒接到掉在地上。
 *   人與人的碰撞：不能穿過隊友；跑步撞到人會把對方推開，對方手上的東西會晃。
 * 數字都在這裡，伺服器與用戶端用同一份。
 */

export const PHYSICS = {
  /** 人的身體（和其他人碰撞用的圓）半徑 */
  bodyRadius: 0.27,
  /** 伺服器允許兩個人重疊到多近（用戶端看到的別人位置會慢一點，留一點寬容） */
  bodyTolerance: 0.2,
  puddle: {
    /** 積水多久會自己乾 */
    dryMs: 150_000,
    /** 同時最多幾灘（太多時最舊的先乾） */
    max: 14,
    /** 擦乾要多久 */
    mopMs: 2200,
    /** 站在積水旁多近可以擦 */
    mopRange: 1.1,
  },
  slip: {
    /** 比走路快（跑步）踩到積水才會滑 */
    minSpeed: 3.0,
    /** 滑多遠 */
    distance: 1.6,
    /** 滑行＋爬起來的時間（這段時間不能動） */
    ms: 1100,
    /** 滑倒後多久之內不會再滑一次 */
    cooldownMs: 3000,
    /** 跌倒的聲音（怪物聽得到）半徑 */
    noise: 7,
  },
  toss: {
    /** 最遠丟多遠 */
    range: 7,
    /** 準心要對得多準（cos；約 ±14°） */
    aim: 0.97,
    /** 落點附近多近算接得到 */
    catchRadius: 1.3,
    /** 接的人要大致面向丟的人（cos；約 ±75°） */
    facing: 0.25,
    /** 飛行時間：基本＋每公尺 */
    baseMs: 260,
    perMeterMs: 90,
    /** 沒有目標時丟多遠（丟到前面的地上） */
    floorDistance: 2.2,
  },
  bump: {
    /** 跑步（比這個快）撞到人才算衝撞 */
    minSpeed: 3.2,
    /** 把對方推開多遠 */
    push: 0.7,
    /** 同一對人多久之內不會再撞一次 */
    cooldownMs: 1500,
    noise: 4,
  },
  boilOver: {
    /** 湯滾著、開大火多久會溢出來 */
    afterMs: 9000,
    /** 溢出來之後多久才會再溢一次 */
    againMs: 25_000,
  },
  /** 怪物在廚房裡每隔多久滴下一灘水 */
  monsterDripMs: 7000,
} as const;

export type PuddleKind = 'water' | 'soup' | 'track';

export interface PuddlePublic {
  id: string;
  x: number;
  z: number;
  r: number;
  kind: PuddleKind;
  /** 會在什麼時候乾（班次時間） */
  until: number;
}

export interface FlightPublic {
  id: string;
  /** 食材種類（畫面用）；盤子沒有 */
  type?: string;
  what: string;
  from: [number, number];
  to: [number, number];
  /** 出手的時間與飛行時間（班次時間） */
  t0: number;
  ms: number;
  by: string;
}

export interface PhysicsPublic {
  puddles: PuddlePublic[];
  flights: FlightPublic[];
}

export interface Body {
  x: number;
  z: number;
  r: number;
}

/**
 * 從 (fx,fz) 走到 (tx,tz)，不穿過別人的身體：碰到時只保留沿著對方切線的那一段（可以擦身而過、可以離開，不能擠進去）。
 * 已經重疊時（傳送、別人走到你身上）可以往外走。
 */
export function avoidBodies(fx: number, fz: number, tx: number, tz: number, bodies: readonly Body[], r: number = PHYSICS.bodyRadius): { x: number; z: number; blocked: boolean } {
  let x = tx;
  let z = tz;
  let blocked = false;
  for (const b of bodies) {
    const min = r + b.r;
    const dx = x - b.x;
    const dz = z - b.z;
    const d = Math.hypot(dx, dz);
    if (d >= min) continue;
    const d0 = Math.hypot(fx - b.x, fz - b.z);
    // 已經重疊而且在遠離：放行
    if (d > d0 - 1e-6) continue;
    blocked = true;
    // 投影到切線上：從起點出發，去掉往對方中心的分量
    const nx = (fx - b.x) / Math.max(1e-6, d0);
    const nz = (fz - b.z) / Math.max(1e-6, d0);
    const mx = tx - fx;
    const mz = tz - fz;
    const into = mx * nx + mz * nz;
    const sx = mx - Math.min(0, into) * nx;
    const sz = mz - Math.min(0, into) * nz;
    x = fx + sx;
    z = fz + sz;
    // 還是太近（正面撞上）：停在原地
    if (Math.hypot(x - b.x, z - b.z) < Math.min(min, d0) - 1e-3) {
      x = fx;
      z = fz;
    }
  }
  return { x, z, blocked };
}

/** 這個位置踩在哪一灘積水上 */
export function puddleAt(puddles: readonly PuddlePublic[], x: number, z: number): PuddlePublic | null {
  for (const p of puddles) if (Math.hypot(p.x - x, p.z - z) <= p.r) return p;
  return null;
}

/** 飛行中的東西現在在哪裡（0–1 的進度，加上拋物線的高度） */
export function flightPos(f: FlightPublic, now: number): { x: number; z: number; y: number; t: number } {
  const t = Math.max(0, Math.min(1, (now - f.t0) / f.ms));
  const dist = Math.hypot(f.to[0] - f.from[0], f.to[1] - f.from[1]);
  const h = 0.25 + dist * 0.12;
  return { x: f.from[0] + (f.to[0] - f.from[0]) * t, z: f.from[1] + (f.to[1] - f.from[1]) * t, y: 1.25 + 4 * h * t * (1 - t) - 0.35 * t, t };
}
