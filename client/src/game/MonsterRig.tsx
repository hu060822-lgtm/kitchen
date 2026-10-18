import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { loadMonster } from './characters/creatures';
import { useCreature } from './characters/useCreature';
import { MeshBasicMaterial, MeshStandardMaterial, type Group } from 'three';
import type { MonsterMode } from '@last-table/shared';

/**
 * 「後門的東西」的身體。遊戲場景與 ?preview=monster 共用同一份模型與動作，
 * 所以預覽頁看到的就是遊戲裡的樣子。
 *
 *  - 駝背的軀幹往前傾、小小的頭往前探、兩條垂到地面的長手臂。
 *  - patrol／investigate／search／leave：慢步，手臂小幅擺動。
 *  - chase：身體更前傾、步伐加快、手臂大幅甩動。
 *  - windup（撲抓前 0.9 秒）：身體往後仰、雙臂舉高 —— 這是玩家唯一的「還來得及躲」的提示。
 */

export type { MonsterMode };

export const MONSTER_MAT = {
  beast: new MeshStandardMaterial({ color: '#141413', roughness: 1, metalness: 0, flatShading: true }),
  eye: new MeshBasicMaterial({ color: '#CFC9B4' }),
};

type V3 = [number, number, number];

function Box({ p, s, r }: { p: V3; s: V3; r?: V3 }): JSX.Element {
  return (
    <mesh position={p} rotation={r} material={MONSTER_MAT.beast} castShadow>
      <boxGeometry args={s} />
    </mesh>
  );
}

/** 狀態 → 動畫 */
const CLIP: Record<MonsterMode | 'grab', string> = {
  grab: 'Grab',
  dormant: 'Idle',
  lurk: 'Idle',
  patrol: 'Walk',
  investigate: 'Investigate',
  chase: 'Chase',
  windup: 'Windup',
  search: 'Search',
  leave: 'Walk',
  bang: 'Windup',
};

/**
 * 低多邊形的怪物模型（monster.glb）。載入中或載入失敗時用下面的方塊備用模型，所以永遠看得到牠。
 * freeze：固定在動畫的某個時間點（秒，截圖用）；不給就隨時間播放。
 */
export function MonsterRig({ getMode, freeze }: { getMode: () => MonsterMode | 'grab'; freeze?: number }): JSX.Element {
  const player = useCreature(loadMonster, ['Windup', 'Grab']);
  useFrame((_, dt) => {
    if (!player) return;
    const clip = CLIP[getMode()] ?? 'Walk';
    if (freeze !== undefined) {
      if (player.current !== clip) player.pose(clip, freeze);
      return;
    }
    player.play(clip, clip === 'Windup' || clip === 'Grab' ? 0.08 : 0.3);
    player.mixer.update(Math.min(dt, 0.1));
  });
  if (!player) return <MonsterFallback getMode={getMode} freeze={freeze} />;
  // 模型檔的正面是 +Z；遊戲裡怪物的正面是 -Z（與備用模型一致）
  return (
    <group rotation={[0, Math.PI, 0]}>
      <primitive object={player.root} />
    </group>
  );
}

/** 方塊組成的備用模型（模型檔載入失敗時） */
export function MonsterFallback({ getMode, freeze }: { getMode: () => MonsterMode | 'grab'; freeze?: number }): JSX.Element {
  const body = useRef<Group>(null);
  const arms = useRef<Group>(null);
  useFrame(({ clock }) => {
    const mode = getMode();
    const fast = mode === 'chase' || mode === 'windup';
    const t = freeze ?? clock.elapsedTime * (fast ? 9 : 4);
    if (body.current) {
      body.current.position.y = Math.abs(Math.sin(t)) * (fast ? 0.08 : 0.04);
      body.current.rotation.x = mode === 'windup' ? -0.15 : fast ? 0.35 : 0.2;
    }
    if (arms.current) arms.current.rotation.x = Math.sin(t) * (fast ? 0.5 : 0.25) + (mode === 'windup' ? -1.2 : 0);
  });
  return (
    <group ref={body}>
      {[-1, 1].map((s) => (
        <Box key={s} p={[s * 0.18, 0.45, 0.1]} s={[0.14, 0.9, 0.16]} r={[0.2, 0, 0]} />
      ))}
      <Box p={[0, 1.3, 0]} s={[0.62, 0.85, 0.42]} r={[0.5, 0, 0]} />
      <Box p={[0, 1.55, -0.38]} s={[0.24, 0.26, 0.3]} />
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 0.06, 1.58, -0.535]} material={MONSTER_MAT.eye}>
          <boxGeometry args={[0.025, 0.012, 0.01]} />
        </mesh>
      ))}
      <group ref={arms} position={[0, 1.6, -0.15]}>
        {[-1, 1].map((s) => (
          <Box key={s} p={[s * 0.38, -0.7, -0.1]} s={[0.1, 1.5, 0.1]} />
        ))}
      </group>
    </group>
  );
}
