import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { MeshStandardMaterial, MeshBasicMaterial, type Group, type PointLight } from 'three';
import type { StationDef } from '@last-table/shared';
import { useStore } from '../state/store';
import { on } from './bus';

/**
 * 後廚的來福槍：槍架（牆上兩根掛鉤＋一盒子彈）、拿在手上時的第一人稱槍身（開槍有後座力）、槍口火光。
 * 只是畫面；有沒有打中由伺服器判定。
 */

const M = {
  wood: new MeshStandardMaterial({ color: '#5A3A24', roughness: 0.75, metalness: 0, flatShading: true }),
  stock: new MeshStandardMaterial({ color: '#6E4729', roughness: 0.7, metalness: 0, flatShading: true }),
  metal: new MeshStandardMaterial({ color: '#2B2F31', roughness: 0.45, metalness: 0.6, flatShading: true }),
  board: new MeshStandardMaterial({ color: '#3B2A20', roughness: 0.9, metalness: 0, flatShading: true }),
  brass: new MeshStandardMaterial({ color: '#B8913E', roughness: 0.4, metalness: 0.7, flatShading: true }),
  label: new MeshBasicMaterial({ color: '#8E3A2A' }),
};

type V3 = [number, number, number];
function B({ p, s, m, r }: { p: V3; s: V3; m: MeshStandardMaterial | MeshBasicMaterial; r?: V3 }): JSX.Element {
  return (
    <mesh position={p} rotation={r} material={m}>
      <boxGeometry args={s} />
    </mesh>
  );
}

/** 槍的模型（沿著 -z 方向；原點在握把附近） */
export function RifleModel(): JSX.Element {
  return (
    <group>
      {/* 槍托 */}
      <B p={[0, -0.02, 0.2]} s={[0.05, 0.1, 0.28]} m={M.stock} />
      <B p={[0, -0.06, 0.32]} s={[0.05, 0.08, 0.08]} m={M.stock} />
      {/* 機匣與扳機護弓 */}
      <B p={[0, 0.02, -0.05]} s={[0.05, 0.07, 0.24]} m={M.metal} />
      <B p={[0, -0.04, 0.0]} s={[0.012, 0.05, 0.06]} m={M.metal} />
      {/* 護木 */}
      <B p={[0, 0.0, -0.32]} s={[0.055, 0.06, 0.32]} m={M.wood} />
      {/* 槍管 */}
      <mesh position={[0, 0.035, -0.5]} rotation={[Math.PI / 2, 0, 0]} material={M.metal}>
        <cylinderGeometry args={[0.012, 0.012, 0.72, 8]} />
      </mesh>
      {/* 準星與照門 */}
      <B p={[0, 0.06, -0.84]} s={[0.008, 0.025, 0.01]} m={M.metal} />
      <B p={[0, 0.065, -0.12]} s={[0.03, 0.02, 0.012]} m={M.metal} />
      {/* 槍機拉柄 */}
      <B p={[0.04, 0.03, -0.02]} s={[0.04, 0.012, 0.012]} m={M.metal} />
    </group>
  );
}

/** 槍架：槍不在誰手上時掛在架上；旁邊一盒子彈顯示剩幾發 */
export function GunRack({ def }: { def: StationDef }): JSX.Element {
  const onRack = useStore((s) => !s.kitchen?.rifle?.holder);
  const ammo = useStore((s) => s.kitchen?.rifle?.ammo ?? 4);
  return (
    <group position={[def.pos[0], 0, def.pos[1]]} rotation={[0, def.facing, 0]}>
      {/* 牆上的木板（靠牆，面向廚房） */}
      <B p={[0, 1.35, -0.32]} s={[1.0, 0.9, 0.04]} m={M.board} />
      {[-0.32, 0.32].map((x) => (
        <B key={x} p={[x, 1.2, -0.26]} s={[0.04, 0.08, 0.1]} m={M.metal} />
      ))}
      {onRack && (
        <group position={[0, 1.26, -0.2]} rotation={[0, Math.PI / 2, 0.08]}>
          <RifleModel />
        </group>
      )}
      {/* 底下的小櫃子與子彈 */}
      <B p={[0, 0.45, -0.1]} s={[0.8, 0.9, 0.45]} m={M.board} />
      <B p={[0.0, 0.905, -0.1]} s={[0.24, 0.02, 0.14]} m={M.label} />
      {Array.from({ length: ammo }, (_, i) => (
        <mesh key={i} position={[-0.09 + i * 0.06, 0.95, -0.1]} material={M.brass}>
          <cylinderGeometry args={[0.012, 0.012, 0.07, 6]} />
        </mesh>
      ))}
    </group>
  );
}

/** 第一人稱：拿著槍時畫面右下角的槍身，開槍時往後一頓、槍口火光 */
export function ViewRifle(): JSX.Element | null {
  const holding = useStore((s) => {
    const r = s.me?.role;
    return !!r && s.kitchen?.players[r]?.held?.kind === 'rifle';
  });
  const { camera } = useThree();
  const root = useRef<Group>(null);
  const gun = useRef<Group>(null);
  const flash = useRef<PointLight>(null);
  const kick = useRef(0);
  useEffect(() => on('recoil', () => (kick.current = 1)), []);
  useFrame((_, dt) => {
    const g = root.current;
    if (!g) return;
    g.position.copy(camera.position);
    g.quaternion.copy(camera.quaternion);
    kick.current = Math.max(0, kick.current - dt * 5);
    const k = kick.current;
    if (gun.current) {
      gun.current.position.set(0.15, -0.16 + k * 0.02, -0.3 + k * 0.05);
      gun.current.rotation.set(k * 0.25, 0.03, 0);
    }
    if (flash.current) flash.current.intensity = k > 0.75 ? 6 : 0;
  });
  if (!holding) return null;
  return (
    <group ref={root}>
      <group ref={gun} scale={0.62}>
        <RifleModel />
        <pointLight ref={flash} position={[0, 0.04, -0.95]} color="#FFD27A" distance={6} intensity={0} />
      </group>
    </group>
  );
}

/** 別人開槍：槍聲的位置亮一下（自己的火光在 ViewRifle） */
export function MuzzleFlashes(): JSX.Element {
  const light = useRef<PointLight>(null);
  const until = useRef(0);
  useEffect(
    () =>
      on('fx', (f) => {
        if (f.visual !== 'muzzle' || !f.at || !light.current) return;
        light.current.position.set(f.at[0], 1.4, f.at[1]);
        until.current = performance.now() + 90;
      }),
    [],
  );
  useFrame(() => {
    if (light.current) light.current.intensity = performance.now() < until.current ? 8 : 0;
  });
  return <pointLight ref={light} color="#FFD27A" distance={8} intensity={0} />;
}

/** 隊友拿著來福槍：在他胸前畫一把槍（槍口朝他面對的方向） */
export function AvatarRifle({ role, size = 1 }: { role: string; size?: number }): JSX.Element | null {
  const holding = useStore((s) => s.kitchen?.rifle?.holder === role);
  if (!holding) return null;
  return (
    <group position={[0.16 * size, 1.12 * size, -0.22 * size]} scale={size * 1.2}>
      <RifleModel />
    </group>
  );
}
