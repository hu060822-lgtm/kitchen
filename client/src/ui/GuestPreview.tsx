import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { Color, FogExp2, MeshStandardMaterial, NeutralToneMapping, RepeatWrapping } from 'three';
import { CivilianBody } from '../game/Diners';
import { DINER_MODELS, type CivModel } from '../game/characters/creatures';
import { kitchenWall, nameTexture, quarryTile } from '../game/textures';

/**
 * 客人預覽（網址 ?preview=guests）。不連伺服器，用的是遊戲中同一份模型與動作。
 *   &shot=lineup   四位一般客人＋那位客人並排站著
 *   &shot=table    一張桌子兩位客人（一位在等、一位在吃），後面最暗的桌子坐著那位客人
 */
const shot = new URLSearchParams(location.search).get('shot') ?? 'lineup';

const mats = (() => {
  const floor = quarryTile().clone();
  floor.wrapS = floor.wrapT = RepeatWrapping;
  floor.repeat.set(14, 14);
  floor.needsUpdate = true;
  const wall = kitchenWall().clone();
  wall.wrapS = wall.wrapT = RepeatWrapping;
  wall.repeat.set(8, 1);
  wall.needsUpdate = true;
  return {
    floor: new MeshStandardMaterial({ map: floor, roughness: 0.9 }),
    wall: new MeshStandardMaterial({ map: wall, roughness: 0.8 }),
    cloth: new MeshStandardMaterial({ color: '#B9B2A2', roughness: 1 }),
    wood: new MeshStandardMaterial({ color: '#4A3326', roughness: 0.9 }),
  };
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

function Label({ text, x, y = 2.15 }: { text: string; x: number; y?: number }): JSX.Element {
  const tex = useMemo(() => nameTexture(text), [text]);
  return (
    <sprite position={[x, y, 0]} scale={[1.2, 0.26, 1]}>
      <spriteMaterial map={tex} transparent depthWrite={false} />
    </sprite>
  );
}

function Room(): JSX.Element {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={mats.floor}>
        <planeGeometry args={[20, 20]} />
      </mesh>
      <mesh position={[0, 1.6, -6]} material={mats.wall}>
        <boxGeometry args={[20, 3.2, 0.2]} />
      </mesh>
    </>
  );
}

/** 與遊戲中相同尺寸的桌子與兩張椅子 */
function Table({ x, z }: { x: number; z: number }): JSX.Element {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.74, 0]} material={mats.cloth}>
        <boxGeometry args={[1.2, 0.04, 0.9]} />
      </mesh>
      <mesh position={[0, 0.6, 0]} material={mats.cloth}>
        <boxGeometry args={[1.16, 0.26, 0.86]} />
      </mesh>
      {[-1, 1].map((s) => (
        <group key={s} position={[0, 0, s * 0.77]}>
          <mesh position={[0, 0.45, 0]} material={mats.wood}>
            <boxGeometry args={[0.42, 0.04, 0.4]} />
          </mesh>
          <mesh position={[0, 0.85, s * 0.19]} material={mats.wood}>
            <boxGeometry args={[0.42, 0.75, 0.04]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

const LABEL: Record<CivModel, string> = { diner_a: '客人 A', diner_b: '客人 B', diner_c: '客人 C', diner_d: '客人 D', guest_suit: '那位客人' };

function Lineup(): JSX.Element {
  const all: CivModel[] = [...DINER_MODELS, 'guest_suit'];
  return (
    <>
      <Stage pos={[0, 1.4, 5.2]} look={[0, 1.0, 0]} bg="#1B2022" fog={0.03} />
      <Room />
      <ambientLight intensity={0.5} />
      <directionalLight position={[3, 6, 5]} intensity={1.3} />
      {all.map((m, i) => {
        const x = (i - 2) * 1.15;
        return (
          <group key={m}>
            <CivilianBody model={m} x={x} z={0} yaw={Math.PI - 0.3} clip="StandStiff" seed={i * 131}>
              {null}
            </CivilianBody>
            <Label text={LABEL[m]} x={x} />
          </group>
        );
      })}
    </>
  );
}

function TableShot(): JSX.Element {
  return (
    <>
      <Stage pos={[2.2, 1.65, 2.6]} look={[0, 0.8, -0.4]} bg="#101314" fog={0.08} />
      <Room />
      <ambientLight intensity={0.25} />
      <pointLight position={[0, 1.4, 0]} intensity={4} distance={6} decay={1.4} color="#F2D7A6" />
      <Table x={0} z={0} />
      <CivilianBody model="diner_b" x={0} z={-0.81} yaw={Math.PI} clip="SitWait" seed={3}>
        {null}
      </CivilianBody>
      <CivilianBody model="diner_a" x={0} z={0.81} yaw={0} clip="SitEat" seed={9}>
        {null}
      </CivilianBody>
      {/* 後面最暗的那一張：那位客人 */}
      <Table x={-2.6} z={-3.2} />
      <pointLight position={[-2.6, 1.3, -3.2]} intensity={0.6} distance={3} color="#9DB2C0" />
      <CivilianBody model="guest_suit" x={-2.6} z={-4.01} yaw={Math.PI} clip="SitStill" seed={1}>
        {null}
      </CivilianBody>
    </>
  );
}

export default function GuestPreview(): JSX.Element {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
      <Canvas camera={{ fov: 55, near: 0.05, far: 60 }} dpr={1} gl={{ antialias: false }}>
        {shot === 'table' ? <TableShot /> : <Lineup />}
      </Canvas>
    </div>
  );
}
