import { useEffect, useMemo, useState } from 'react';
import { AnimationMixer, LoopOnce, LoopRepeat, type AnimationAction, type Object3D } from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CreatureAsset } from './creatures';

/** 一個怪物／客人實例：複製範本（骨架各自獨立）、建立動畫混合器；淡入淡出切換動畫 */
export class CreaturePlayer {
  readonly root: Object3D;
  readonly mixer: AnimationMixer;
  private readonly actions = new Map<string, AnimationAction>();
  current: string | null = null;

  constructor(asset: CreatureAsset, once: string[] = []) {
    this.root = cloneSkinned(asset.template);
    this.mixer = new AnimationMixer(this.root);
    for (const [name, clip] of asset.clips) {
      const a = this.mixer.clipAction(clip);
      if (once.includes(name)) {
        a.setLoop(LoopOnce, 1);
        a.clampWhenFinished = true;
      } else a.setLoop(LoopRepeat, Infinity);
      this.actions.set(name, a);
    }
  }

  has(name: string): boolean {
    return this.actions.has(name);
  }

  play(name: string, fade = 0.25, timeScale = 1): void {
    const next = this.actions.get(name);
    if (!next) return;
    next.timeScale = timeScale;
    if (this.current === name) return;
    const prev = this.current ? this.actions.get(this.current) : undefined;
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();
    if (prev && fade > 0) prev.crossFadeTo(next, fade, false);
    else if (prev) prev.stop();
    this.current = name;
  }

  /** 固定在某個時間點（預覽、截圖） */
  pose(name: string, t: number): void {
    this.play(name, 0);
    const a = this.actions.get(name);
    if (!a) return;
    const d = a.getClip().duration;
    a.time = a.loop === LoopOnce ? Math.min(t, d - 1e-3) : t % d;
    a.paused = true;
    this.mixer.update(0);
  }

  /** 隨機起始時間（同一種模型的多個實例不會同步動作） */
  desync(seed: number): void {
    const a = this.current ? this.actions.get(this.current) : undefined;
    if (a) a.time = (seed % 997) / 997 * a.getClip().duration;
  }
}

export function useCreature(load: () => Promise<CreatureAsset | null>, once: string[] = [], key = ''): CreaturePlayer | null | undefined {
  // undefined＝載入中；null＝載入失敗（用備用模型）
  const [asset, setAsset] = useState<CreatureAsset | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void load().then((a) => alive && setAsset(a));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(() => (asset ? new CreaturePlayer(asset, once) : asset), [asset]); // eslint-disable-line react-hooks/exhaustive-deps
}
