import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MeshLambertMaterial, type Group } from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MENTOR, STATION_BY_ID, TUTORIAL_STEP_BY_ID, stationFront, type TutorialStepId } from '@last-table/shared';
import { useStore } from '../state/store';
import { pose } from './controller';
import { contactShadow, nameTexture } from './textures';
import { CharacterAnimator } from './characters/animator';
import { loadCrew, type CrewAsset } from './characters/assets';

/**
 * 教學關的老周：站在這一步要去的地方旁邊，面向你。換到下一步時，他會「已經站在那裡了」
 * （燈閃一下就換位置——這間店的夜班就是這樣）。只是畫面，不擋路、不參與任何規則。
 */

/** 沒有目標工作站的步驟：老周站哪裡 */
const SPOTS: Partial<Record<TutorialStepId, [number, number]>> = {
  welcome: [-0.6, 11.4],
  move: [-0.6, 11.4],
  hands: [-3.2, 16.6],
  crew: [-0.6, 11.4],
  guest_look: [4.25, 10.4],
  guest_escort: [3.2, 11.2],
  done: [-0.6, 11.4],
};

function spotFor(step: TutorialStepId, puddle?: [number, number]): [number, number] {
  if (step === 'puddle' && puddle) return [puddle[0] + 1.1, puddle[1] + 0.6];
  const s = SPOTS[step];
  if (s) return s;
  const target = TUTORIAL_STEP_BY_ID[step].target;
  const def = target ? STATION_BY_ID[target] : null;
  if (!def) return [-0.6, 11.4];
  // 站在工作站前面、偏一邊（不擋住玩家要站的位置）
  const [fx, fz] = stationFront(def, 1.1);
  const nx = Math.sin(def.facing);
  const nz = Math.cos(def.facing);
  return [fx + nz * 0.95, fz - nx * 0.95];
}

const HAT = new MeshLambertMaterial({ color: '#F4F1E8' });
const BAND = new MeshLambertMaterial({ color: '#DCD7CA' });

export function Mentor(): JSX.Element | null {
  const step = useStore((s) => s.kitchen?.tutorial?.step ?? null);
  const puddle = useStore((s) => s.kitchen?.tutorial?.puddle);
  const [asset, setAsset] = useState<CrewAsset | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void loadCrew('DEAF').then((a) => alive && setAsset(a));
    return () => {
      alive = false;
    };
  }, []);
  if (!step || asset === undefined) return null;
  return <MentorBody step={step} puddle={puddle} asset={asset} />;
}

function MentorBody({ step, puddle, asset }: { step: TutorialStepId; puddle?: [number, number]; asset: CrewAsset | null }): JSX.Element {
  const group = useRef<Group>(null);
  const model = useMemo(() => (asset ? cloneSkinned(asset.template) : null), [asset]);
  const anim = useMemo(() => (asset && model ? new CharacterAnimator(model, asset.clips) : null), [asset, model]);
  useEffect(() => () => anim?.dispose(), [anim]);
  const tag = useMemo(() => nameTexture(`${MENTOR.name}・${MENTOR.title}`), []);
  const goal = spotFor(step, puddle);
  const key = `${goal[0].toFixed(2)},${goal[1].toFixed(2)}`;
  const state = useRef({ x: goal[0], z: goal[1], yaw: 0, hiddenUntil: 0, actUntil: 0, key });

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const st = state.current;
    const now = performance.now();
    // 換位置：先消失一下，再出現在新的地方，做一個手勢
    if (st.key !== key) {
      st.key = key;
      st.hiddenUntil = now + 450;
      st.actUntil = now + 2200;
    }
    if (now < st.hiddenUntil) {
      g.visible = false;
      return;
    }
    if (!g.visible) {
      st.x = goal[0];
      st.z = goal[1];
    }
    g.visible = true;
    // 面向玩家（慢慢轉過去）
    const want = Math.atan2(-(pose.x - st.x), -(pose.z - st.z));
    let d = want - st.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    st.yaw += d * Math.min(1, dt * 4);
    g.position.set(st.x, 0, st.z);
    g.rotation.y = st.yaw;
    anim?.update(Math.min(dt, 0.1), { speed: 0, turnRate: d * 2, crouch: false, act: now < st.actUntil ? 'interact' : null, actPose: 'low', hurt: 0 });
  });

  return (
    <group ref={group}>
      <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.9, 0.9]} />
        <meshBasicMaterial map={contactShadow()} transparent depthWrite={false} opacity={0.8} />
      </mesh>
      {asset && model ? (
        <group rotation={[0, Math.PI + asset.yaw, 0]} scale={asset.scale}>
          <primitive object={model} />
        </group>
      ) : (
        <group>
          <mesh position={[0, 0.45, 0]} material={BAND}>
            <boxGeometry args={[0.32, 0.9, 0.22]} />
          </mesh>
          <mesh position={[0, 1.15, 0]} material={HAT}>
            <boxGeometry args={[0.46, 0.55, 0.28]} />
          </mesh>
          <mesh position={[0, 1.63, 0]} material={BAND}>
            <boxGeometry args={[0.24, 0.28, 0.26]} />
          </mesh>
        </group>
      )}
      {/* 高高的廚師帽 */}
      <group position={[0, 1.8, 0.01]} scale={0.85}>
        <mesh position={[0, 0, 0]} material={BAND}>
          <cylinderGeometry args={[0.115, 0.115, 0.07, 14]} />
        </mesh>
        <mesh position={[0, 0.13, 0]} material={HAT}>
          <cylinderGeometry args={[0.15, 0.12, 0.2, 14]} />
        </mesh>
        <mesh position={[0, 0.25, 0]} material={HAT}>
          <sphereGeometry args={[0.16, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        </mesh>
      </group>
      <sprite position={[0, 2.3, 0]} scale={[0.82, 0.17, 1]}>
        <spriteMaterial map={tag} transparent depthWrite={false} />
      </sprite>
    </group>
  );
}
