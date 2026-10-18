import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { MeshStandardMaterial, Shape, ShapeGeometry, type Group } from 'three';
import { flightPos, type FlightPublic, type PuddlePublic } from '@last-table/shared';
import { shiftNow, useStore } from '../state/store';
import { ShelfFood } from './food/FoodMesh';

/**
 * 物理的畫面：地上的積水（反光的一灘，快乾時變淡）、飛在空中的食材（沿著伺服器給的拋物線）。
 * 位置與時間都來自伺服器的狀態；這裡只負責畫出來。
 */

const PUDDLE_COLOR: Record<PuddlePublic['kind'], string> = { water: '#7d98a2', soup: '#8a6a3a', track: '#5f7378' };

/** 一灘水的形狀：依 id 固定的不規則圓 */
function puddleGeo(id: string, r: number): ShapeGeometry {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 9973;
  const s = new Shape();
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 0.78 + 0.22 * Math.abs(Math.sin(a * 2.3 + h) * Math.cos(a * 1.7 + h * 0.37));
    const x = Math.cos(a) * r * k;
    const y = Math.sin(a) * r * k * 0.85;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  return new ShapeGeometry(s);
}

function Puddle({ p }: { p: PuddlePublic }): JSX.Element {
  const geo = useMemo(() => puddleGeo(p.id, p.r), [p.id, p.r]);
  const mat = useMemo(() => new MeshStandardMaterial({ color: PUDDLE_COLOR[p.kind], roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.62, depthWrite: false }), [p.kind]);
  useFrame(() => {
    const left = p.until - shiftNow();
    mat.opacity = 0.62 * Math.max(0.15, Math.min(1, left / 20_000));
  });
  return <mesh geometry={geo} material={mat} position={[p.x, 0.008, p.z]} rotation={[-Math.PI / 2, 0, 0]} />;
}

function Flight({ f }: { f: FlightPublic }): JSX.Element {
  const ref = useRef<Group>(null);
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const q = flightPos(f, shiftNow());
    g.position.set(q.x, q.y, q.z);
    g.rotation.set(q.t * 7, q.t * 5, 0);
    g.visible = q.t < 1;
  });
  return (
    <group ref={ref}>
      <ShelfFood type={f.type ?? 'egg'} at={[0, -0.03, 0]} fit={0.12} />
    </group>
  );
}

export function PhysicsWorld(): JSX.Element | null {
  const ph = useStore((s) => s.kitchen?.physics);
  if (!ph) return null;
  return (
    <group>
      {ph.puddles.map((p) => (
        <Puddle key={p.id} p={p} />
      ))}
      {ph.flights.map((f) => (
        <Flight key={f.id} f={f} />
      ))}
    </group>
  );
}
