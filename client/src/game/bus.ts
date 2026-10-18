import type { AcousticMaterial, VisionSolid } from '@last-table/shared';

/** 遊戲迴圈 → 介面 的輕量事件（不經過 React 狀態，避免每幀重繪） */

/**
 * 一次回聲的短暫顯示資料（盲區員的回聲視野）：脈衝的位置、範圍內的結構（只有種類與尺寸）、
 * 每道射線的反射（與聲音的資訊相同），以及視野的時間參數。
 */
export interface EchoDisplay {
  origin: [number, number];
  solids: VisionSolid[];
  hits: Array<{ rel: number; dist: number; hit: boolean; material: AcousticMaterial | null }>;
  range: number;
  waveSpeed: number;
  holdMs: number;
  fadeMs: number;
  cooldownMs: number;
}
/**
 * 畫面效果（只有看得見的角色會收到）：shift＝被拖走／救出來的瞬間、charge／lunge＝怪物衝過來、
 * flicker＝燈閃了一下、guest＝客人出現（畫面上沒有特效，只是記錄）
 */
export type FxVisual = 'shift' | 'charge' | 'lunge' | 'flicker' | 'guest' | 'flash' | 'shake';
type Events = { echo: EchoDisplay; riskTripped: { id: string; jamMs: number }; bump: void; near: void; fault: void; fx: { visual: FxVisual; at?: readonly [number, number] }; abduct: void };
type Handler<K extends keyof Events> = (p: Events[K]) => void;

const handlers = new Map<keyof Events, Set<(p: never) => void>>();

export function on<K extends keyof Events>(k: K, h: Handler<K>): () => void {
  let set = handlers.get(k);
  if (!set) handlers.set(k, (set = new Set()));
  set.add(h as (p: never) => void);
  return () => {
    set.delete(h as (p: never) => void);
  };
}

export function emit<K extends keyof Events>(k: K, p: Events[K]): void {
  handlers.get(k)?.forEach((h) => (h as Handler<K>)(p));
}
