import { emit } from './bus';
import { pose } from './controller';

/**
 * 被怪物抓走的過場（只有被抓的人看得到，約 3.6 秒）：
 *   0.00–0.90 秒　視角被扳向怪物，牠撲到臉前（畫面收窄、劇烈晃動、紅色暗角、心跳）
 *   0.90–1.50 秒　被拽倒在地：視角往上翻、歪斜，牠的身影壓在上方
 *   1.50–2.80 秒　黑幕：爪痕、拖行聲、文字
 *   2.80–3.60 秒　在冷藏室的鐵籠裡慢慢亮起來
 * 伺服器在抓到的那一刻就把人移進鐵籠；過場用「被移走之前」的位置演出，所以畫面不會突然跳走。
 */
export const ABDUCT_MS = 3600;
export const ABDUCT_PHASE = { lunge: 900, down: 1500, black: 2800 } as const;

interface Cam {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export const abduct: { active: boolean; t0: number; at: [number, number]; from: Cam } = {
  active: false,
  t0: 0,
  at: [0, 0],
  from: { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 },
};

let preTeleport: (Cam & { t: number }) | null = null;
let lastLunge = -1e9;

/** 怪物撲上來（windup 的畫面事件） */
export function noteLunge(): void {
  lastLunge = performance.now();
}

/** 伺服器把自己移走之前：記下原本的位置；回傳這次移動是不是「被抓走」（是的話不要另外播黑幕） */
export function noteTeleport(): boolean {
  const now = performance.now();
  preTeleport = { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw, pitch: pose.pitch, t: now };
  return now - lastLunge < 2500;
}

/** 開始過場（收到「自己被抓走」的事件） */
export function startAbduct(at: readonly [number, number] | undefined): void {
  const now = performance.now();
  const from = preTeleport && now - preTeleport.t < 2500 ? preTeleport : { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw, pitch: pose.pitch };
  // 演出用的位置：沿著「玩家 → 怪物」的方向，放在 2 公尺外（頭在 1.1 公尺處），鏡頭才有空間被牠撲上來
  let ux = (at?.[0] ?? from.x) - from.x;
  let uz = (at?.[1] ?? from.z) - from.z;
  const ul = Math.hypot(ux, uz);
  if (ul < 0.2) {
    ux = -Math.sin(from.yaw);
    uz = -Math.cos(from.yaw);
  } else {
    ux /= ul;
    uz /= ul;
  }
  const mx = from.x + ux * 2.0;
  const mz = from.z + uz * 2.0;
  abduct.active = true;
  abduct.t0 = now;
  abduct.at = [mx, mz];
  abduct.from = { x: from.x, y: from.y, z: from.z, yaw: from.yaw, pitch: from.pitch };
  emit('abduct', undefined);
}

/** 截圖用（只在 ?debug）：把過場凍結在某個時間點；null＝恢復 */
let frozenAt: number | null = null;
if (typeof window !== 'undefined' && /[?&]debug\b/.test(window.location.search)) {
  (window as unknown as { __abductFreeze: (ms: number | null) => void }).__abductFreeze = (ms) => {
    frozenAt = ms;
    if (ms === null) abduct.t0 = performance.now() - ABDUCT_PHASE.black;
    else abduct.active = true;
    for (const an of document.getAnimations()) {
      const el = (an.effect as KeyframeEffect | null)?.target as Element | null;
      if (!el?.closest('.abduct')) continue;
      if (ms === null) an.play();
      else {
        an.pause();
        an.currentTime = ms;
      }
    }
  };
}

/** 過場進行了幾毫秒；沒有在播就回傳 null */
export function abductElapsed(): number | null {
  if (frozenAt !== null) return frozenAt;
  if (!abduct.active) return null;
  const e = performance.now() - abduct.t0;
  if (e >= ABDUCT_MS) {
    abduct.active = false;
    return null;
  }
  return e;
}
