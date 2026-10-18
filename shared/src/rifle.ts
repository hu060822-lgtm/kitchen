/**
 * 後廚的來福槍：槍架上一把，整班只有 4 發子彈。
 *   拿著（要用雙手）時按滑鼠左鍵開槍；準心對準怪物、中間沒有牆擋住、在射程內就算打中。
 *   打中一次就把怪物打退（退回後門，要更久才會再來）。
 *   槍聲很大，怪物以外的東西（客人、睡著的人）也聽得到。
 * 伺服器判定是否打中；用戶端只顯示準心是否對到。
 */
export const RIFLE = {
  /** 一班幾發 */
  ammo: 4,
  /** 射程（公尺） */
  range: 14,
  /** 子彈路線離怪物中心多近算打中（公尺；怪物身體約 0.42 加一點寬容） */
  hitRadius: 0.75,
  /** 兩發之間最短間隔 */
  cooldownMs: 900,
  /** 用戶端送來的朝向和伺服器記錄的朝向最多差多少（弧度），超過就用伺服器的 */
  yawTolerance: 0.6,
  /** 槍聲（怪物聽得到）半徑 */
  noise: 14,
} as const;

/** 子彈從 (px,pz) 沿著朝向 (fx,fz) 射出，會不會打中 (mx,mz) 的東西 */
export function rifleHits(px: number, pz: number, fx: number, fz: number, mx: number, mz: number, range: number = RIFLE.range, radius: number = RIFLE.hitRadius): boolean {
  const dx = mx - px;
  const dz = mz - pz;
  const along = dx * fx + dz * fz;
  if (along <= 0 || along > range) return false;
  const perp = Math.abs(dx * fz - dz * fx);
  return perp <= radius;
}

export interface RiflePublic {
  /** 剩幾發 */
  ammo: number;
  /** 誰拿著（沒人拿就在槍架上） */
  holder: string | null;
  /** 上一發的時間（班次時間；畫面用來播槍口火光） */
  lastShotAt: number;
}
