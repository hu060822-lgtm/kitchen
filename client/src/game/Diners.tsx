import { useFrame } from '@react-three/fiber';
import { useRef, type ReactNode } from 'react';
import type { Group } from 'three';
import { FIXED_PROPS, type OrderPublic } from '@last-table/shared';
import { useStore } from '../state/store';
import { DINER_MODELS, loadCivilian, type CivModel } from './characters/creatures';
import { useCreature } from './characters/useCreature';
import { contactShadow } from './textures';

/**
 * 餐廳裡的客人（純呈現，不影響任何規則）。
 *
 *  - 每張還沒出的單，在它的桌號坐一位客人（同一桌最多兩位，坐對面）；模型由單號決定，重連後也一樣。
 *  - 出餐後吃一陣子（遊戲時間 25 秒）再離開；逾時的單客人直接離開。
 *  - 最暗的那一張（table_0_0）是「那位客人」的位置，一般客人不坐那裡。
 */

interface Chair {
  x: number;
  z: number;
  /** 遊戲的朝向（0＝面向 -Z） */
  yaw: number;
}

const TABLES = FIXED_PROPS.filter((b) => b.id.startsWith('table_'));
const chairsOf = (id: string): Chair[] => {
  const b = TABLES.find((t) => t.id === id)!;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const off = (b.maxZ - b.minZ) / 2 + 0.32;
  // 椅子在桌子的 -Z 側時客人面向 +Z（yaw＝π）
  return [
    { x: cx, z: cz - off - 0.04, yaw: Math.PI },
    { x: cx, z: cz + off + 0.04, yaw: 0 },
  ];
};

/** 桌號 1–5 → 實際的桌子（略過最暗的那一張） */
const DINER_TABLES = TABLES.map((t) => t.id).filter((id) => id !== 'table_0_0').sort();
export const ALL_CHAIRS: Chair[] = TABLES.flatMap((t) => chairsOf(t.id));

/** 離 (x, z) 最近的椅子（0.9 m 內），用來讓坐著的神秘客人真的坐在椅子上 */
export function nearestChair(x: number, z: number): Chair | null {
  let best: Chair | null = null;
  let bd = 0.9;
  for (const c of ALL_CHAIRS) {
    const d = Math.hypot(c.x - x, c.z - z);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const EAT_MS = 25_000;
/** 第一次看到「已出餐」的遊戲時間（只在本機記錄，純呈現） */
const servedSeen = new Map<string, number>();

interface Seated {
  id: string;
  model: CivModel;
  chair: Chair;
  eating: boolean;
}

function seating(orders: OrderPublic[], t: number, blocked: Chair | null): Seated[] {
  const out: Seated[] = [];
  const used = new Map<string, number>();
  const sorted = [...orders].sort((a, b) => a.openedAt - b.openedAt);
  for (const o of sorted) {
    if (o.status === 'missed') continue;
    if (o.status === 'served') {
      if (!servedSeen.has(o.id)) servedSeen.set(o.id, t);
      if (t - servedSeen.get(o.id)! > EAT_MS) continue;
    }
    const table = DINER_TABLES[(o.table - 1) % DINER_TABLES.length];
    if (!table) continue;
    const n = used.get(table) ?? 0;
    if (n >= 2) continue;
    used.set(table, n + 1);
    const h = hash(o.id);
    out.push({ id: o.id, model: DINER_MODELS[h % DINER_MODELS.length], chair: chairsOf(table)[(n + h) % 2 === 0 ? 0 : 1], eating: o.status === 'served' });
  }
  // 同一張椅子只坐一個人；那位客人坐著的椅子也不能用
  const key = (c: Chair) => `${c.x},${c.z}`;
  const taken = new Set<string>(blocked ? [key(blocked)] : []);
  return out.filter((s) => {
    if (taken.has(key(s.chair))) {
      const alt = ALL_CHAIRS.find((c) => c.x === s.chair.x && c.z !== s.chair.z && Math.abs(c.z - s.chair.z) < 2 && !taken.has(key(c)));
      if (!alt) return false;
      s.chair = alt;
    }
    taken.add(key(s.chair));
    return true;
  });
}

export function Diners(): JSX.Element | null {
  // 只在單的組成或狀態改變時重算（每 0.1 秒的快照不會讓整排客人重新渲染）
  const sig = useStore((s) => {
    const k = s.kitchen;
    if (!k) return '';
    const g = k.threats.guest;
    const gs = g && g.state === 'seated' ? `${g.x},${g.z}` : '';
    return k.orders.map((o) => `${o.id}:${o.status}:${o.table}`).join('|') + `#${Math.floor(k.t / 5000)}#${gs}`;
  });
  if (!sig) return null;
  const k = useStore.getState().kitchen!;
  const g = k.threats.guest;
  const list = seating(k.orders, k.t, g && g.state === 'seated' ? nearestChair(g.x, g.z) : null);
  return (
    <group>
      {list.map((s) => (
        <Diner key={s.id} seed={hash(s.id)} model={s.model} chair={s.chair} clip={s.eating ? 'SitEat' : 'SitWait'} />
      ))}
    </group>
  );
}

function Diner({ model, chair, clip, seed }: { model: CivModel; chair: Chair; clip: string; seed: number }): JSX.Element | null {
  return (
    <CivilianBody model={model} x={chair.x} z={chair.z} yaw={chair.yaw} clip={clip} seed={seed} shadow={false}>
      {null}
    </CivilianBody>
  );
}

/**
 * 一個便服的人（客人模型＋客人動畫）。fallback：模型載入中或失敗時畫的東西。
 */
export function CivilianBody({
  model,
  x,
  z,
  yaw,
  clip,
  seed = 0,
  shadow = true,
  children,
}: {
  model: CivModel;
  x: number;
  z: number;
  yaw: number;
  clip: string;
  seed?: number;
  shadow?: boolean;
  children: ReactNode;
}): JSX.Element {
  const player = useCreature(() => loadCivilian(model), [], model);
  const started = useRef(false);
  const g = useRef<Group>(null);
  useFrame((_, dt) => {
    if (!player) return;
    player.play(clip, started.current ? 0.4 : 0);
    if (!started.current) {
      player.desync(seed);
      started.current = true;
    }
    player.mixer.update(Math.min(dt, 0.1));
  });
  return (
    <group ref={g} position={[x, 0, z]} rotation={[0, yaw, 0]}>
      {shadow && (
        <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.8, 0.8]} />
          <meshBasicMaterial map={contactShadow()} transparent depthWrite={false} />
        </mesh>
      )}
      {player ? (
        // 模型正面是 +Z；遊戲的 yaw＝0 是面向 -Z
        <group rotation={[0, Math.PI, 0]}>
          <primitive object={player.root} />
        </group>
      ) : (
        player === null && children
      )}
    </group>
  );
}
