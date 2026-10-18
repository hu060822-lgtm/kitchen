import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  CircleGeometry,
  Color,
  DoubleSide,
  FogExp2,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  RepeatWrapping,
  RingGeometry,
  type PointLight,
} from 'three';
import type { MonsterMode } from '@last-table/shared';
import { MonsterRig } from '../game/MonsterRig';
import { nameTexture, quarryTile, kitchenWall } from '../game/textures';

/**
 * 怪物預覽（網址 ?preview=monster）。不連伺服器，用的是遊戲中同一份模型與動作。
 *
 *   &shot=lineup   四種狀態並排（巡邏／調查／追逐／撲抓預備）
 *   &shot=pov      第一人稱：牠在 1.5 m 處進入撲抓預備的那一瞬間
 *   &shot=vision   俯視圖：視野扇形（依照明 10／6／4.5 m、蹲下 60%）、1.5 m 必定察覺、各種聲音的聽覺半徑
 *   &shot=far      第一人稱：走廊盡頭、燈光不穩時遠遠看到的樣子
 */

const shot = new URLSearchParams(location.search).get('shot') ?? 'lineup';

const floorMat = (() => {
  const t = quarryTile().clone();
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(14, 14);
  t.needsUpdate = true;
  return new MeshStandardMaterial({ map: t, roughness: 0.9 });
})();
const wallMat = (() => {
  const t = kitchenWall().clone();
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(8, 1);
  t.needsUpdate = true;
  return new MeshStandardMaterial({ map: t, roughness: 0.8 });
})();

function Stage({ pos, look, bg, fog }: { pos: [number, number, number]; look: [number, number, number]; bg: string; fog: number }): null {
  const { camera, scene, gl } = useThree();
  useEffect(() => {
    camera.position.set(...pos);
    camera.lookAt(...look);
    scene.background = new Color(bg);
    scene.fog = fog > 0 ? new FogExp2(bg, fog) : null;
    gl.toneMapping = NeutralToneMapping;
  }, [camera, scene, gl, pos, look, bg, fog]);
  return null;
}

function Label({ text, x, y = 2.45, z = 0, k = 1 }: { text: string; x: number; y?: number; z?: number; k?: number }): JSX.Element {
  const tex = useMemo(() => nameTexture(text), [text]);
  return (
    <sprite position={[x, y, z]} scale={[1.7 * k, 0.36 * k, 1]}>
      <spriteMaterial map={tex} transparent depthWrite={false} />
    </sprite>
  );
}

/** 怪物靠近時燈光不穩（與遊戲中同樣的不規則閃爍） */
function FlickerLight({ p, base }: { p: [number, number, number]; base: number }): JSX.Element {
  const ref = useRef<PointLight>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    const n = Math.sin(t * 23) * Math.sin(t * 7.3) * Math.sin(t * 2.1);
    ref.current.intensity = base * (n > 0.35 ? 0.15 : 0.85 + 0.15 * Math.sin(t * 50));
  });
  return <pointLight ref={ref} position={p} intensity={base} distance={14} decay={1.4} color="#E4ECEE" />;
}

function Room({ w = 16, d = 16 }: { w?: number; d?: number }): JSX.Element {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={floorMat} receiveShadow>
        <planeGeometry args={[w, d]} />
      </mesh>
      <mesh position={[0, 1.6, -d / 2]} material={wallMat}>
        <boxGeometry args={[w, 3.2, 0.2]} />
      </mesh>
    </>
  );
}

const fixed = (m: MonsterMode) => () => m;

function Lineup(): JSX.Element {
  const states: Array<[MonsterMode, string, number]> = [
    ['patrol', '巡邏 1.4 m/s', 1.1],
    ['investigate', '調查聲源 2.0 m/s', 2.0],
    ['chase', '追逐 3.3 m/s', 0.9],
    ['windup', '撲抓預備 0.9 秒', 1.3],
  ];
  return (
    <>
      <Stage pos={[0.6, 1.55, 6.6]} look={[0, 1.05, 0]} bg="#1B2022" fog={0.03} />
      <Room />
      <ambientLight intensity={0.35} />
      <directionalLight position={[3, 6, 5]} intensity={1.1} />
      <FlickerLight p={[0, 3, 1]} base={6} />
      {states.map(([m, label, f], i) => {
        const x = (i - 1.5) * 2.4;
        return (
          <group key={m}>
            {/* 臉朝向鏡頭（模型的正面是 -z），稍微側一點看得出駝背 */}
            <group position={[x, 0, 0]} rotation={[0, Math.PI - 0.55, 0]}>
              <MonsterRig getMode={fixed(m)} freeze={f} />
            </group>
            <Label text={label} x={x} />
          </group>
        );
      })}
    </>
  );
}

function Pov(): JSX.Element {
  return (
    <>
      {/* 玩家眼睛高度 1.6 m，牠在 1.5 m 外 */}
      <Stage pos={[0, 1.6, 1.5]} look={[0, 1.62, 0]} bg="#0E1112" fog={0.06} />
      <Room />
      <ambientLight intensity={0.12} />
      <FlickerLight p={[0.6, 2.9, 1.6]} base={4} />
      <group rotation={[0, Math.PI, 0]}>
        <MonsterRig getMode={fixed('windup')} freeze={1.4} />
      </group>
    </>
  );
}

function Far(): JSX.Element {
  return (
    <>
      <Stage pos={[0, 1.6, 6]} look={[0, 1.3, 0]} bg="#0B0D0E" fog={0.07} />
      <Room d={22} />
      <ambientLight intensity={0.2} />
      <FlickerLight p={[0, 2.9, -0.4]} base={7} />
      <group position={[0.3, 0, -1.2]} rotation={[0, Math.PI + 0.3, 0]}>
        <MonsterRig getMode={fixed('patrol')} freeze={1.1} />
      </group>
    </>
  );
}

/** 俯視察覺範圍圖：扇形＝視線，圓＝聽覺半徑 */
function Fan({ r, color, opacity, y }: { r: number; color: string; opacity: number; y: number }): JSX.Element {
  // 視野 110°；模型正面是 -z。CircleGeometry 的角度從 +x 起算、逆時針。
  const geo = useMemo(() => new CircleGeometry(r, 48, Math.PI / 2 - (55 * Math.PI) / 180, (110 * Math.PI) / 180), [r]);
  const mat = useMemo(() => new MeshBasicMaterial({ color, transparent: true, opacity, side: DoubleSide, depthWrite: false }), [color, opacity]);
  return <mesh geometry={geo} material={mat} rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} />;
}
function Ring({ r, color, x = 0, z = 0 }: { r: number; color: string; x?: number; z?: number }): JSX.Element {
  const geo = useMemo(() => new RingGeometry(r - 0.06, r + 0.06, 96), [r]);
  const mat = useMemo(() => new MeshBasicMaterial({ color, side: DoubleSide, transparent: true, opacity: 0.9 }), [color]);
  return <mesh geometry={geo} material={mat} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.03, z]} />;
}

function Vision(): JSX.Element {
  return (
    <>
      <Stage pos={[0, 22, 0.01]} look={[0, 0, -3.2]} bg="#151A1C" fog={0} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={floorMat}>
        <planeGeometry args={[30, 30]} />
      </mesh>
      <ambientLight intensity={0.9} />
      <directionalLight position={[2, 10, 3]} intensity={0.8} />
      <group position={[0, 0, 2]}>
        <Fan r={10} color="#E8E5DC" opacity={0.18} y={0.01} />
        <Fan r={6} color="#E8E5DC" opacity={0.22} y={0.015} />
        <Fan r={4.5} color="#E8E5DC" opacity={0.26} y={0.02} />
        <Ring r={1.5} color="#B5483A" />
        <group rotation={[0, Math.PI, 0]} scale={1.6}>
          <group rotation={[0, Math.PI, 0]}>
            <MonsterRig getMode={fixed('patrol')} freeze={1.1} />
          </group>
        </group>
        <Label text="廚房 10 m" x={0} y={0.4} z={-9.4} k={2.3} />
        <Label text="餐廳 6 m" x={0} y={0.4} z={-5.5} k={2.3} />
        <Label text="後場 4.5 m" x={0} y={0.4} z={-3.9} k={2.3} />
        <Label text="1.5 m 必定察覺" x={2.6} y={0.4} z={0.6} k={2.3} />
      </group>
      {/* 聲音：放在畫面兩側的聲源與牠聽得到的半徑 */}
      <Ring r={5} color="#8E7C50" x={-7.5} z={-6} />
      <Label text="切菜 5 m" x={-7.5} y={0.4} z={-6} k={2.3} />
      <Ring r={4} color="#8E7C50" x={7.5} z={-7} />
      <Label text="大火 4 m" x={7.5} y={0.4} z={-7} k={2.3} />
      <Ring r={6} color="#8E7C50" x={8} z={4.5} />
      <Label text="跑步 6 m" x={8} y={0.4} z={4.5} k={2.3} />
      <Ring r={3.5} color="#8E7C50" x={-8} z={5} />
      <Label text="鍋碗碰撞 3.5 m" x={-8} y={0.4} z={5} k={2.3} />
    </>
  );
}

export default function MonsterPreview(): JSX.Element {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
      <Canvas camera={{ fov: shot === 'vision' ? 50 : 62, near: 0.05, far: 80 }} dpr={1} gl={{ antialias: false }}>
        {shot === 'pov' ? <Pov /> : shot === 'vision' ? <Vision /> : shot === 'far' ? <Far /> : <Lineup />}
      </Canvas>
    </div>
  );
}
