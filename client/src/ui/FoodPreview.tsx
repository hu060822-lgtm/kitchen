import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { Color, NeutralToneMapping } from 'three';
import { INGREDIENTS, INGREDIENT_IDS, newItem, type Cut, type IngredientId, type ItemPublic } from '@last-table/shared';
import { ItemMesh, ShelfFood } from '../game/food/FoodMesh';
import { nameTexture } from '../game/textures';

/**
 * 食材模型預覽（網址 ?preview=food）。不連伺服器，用遊戲中同一份模型。
 *   &shot=raw     全部食材（整顆、生的）
 *   &shot=shelf   架上的樣子（含包裝）
 *   &shot=cuts    幾種食材的各種切法
 *   &shot=cooked  生 → 熟 → 上色 → 焦
 */
const shot = new URLSearchParams(location.search).get('shot') ?? 'raw';

function Stage({ pos, look }: { pos: [number, number, number]; look: [number, number, number] }): null {
  const { camera, scene, gl } = useThree();
  useEffect(() => {
    camera.position.set(...pos);
    camera.lookAt(...look);
    scene.background = new Color('#2B2F31');
    gl.toneMapping = NeutralToneMapping;
  }, [camera, scene, gl, pos, look]);
  return null;
}

function Label({ text, at }: { text: string; at: [number, number, number] }): JSX.Element {
  const tex = useMemo(() => nameTexture(text), [text]);
  return (
    <sprite position={at} scale={[0.13, 0.03, 1]}>
      <spriteMaterial map={tex} transparent depthWrite={false} />
    </sprite>
  );
}

const item = (type: IngredientId, patch: Partial<ItemPublic> = {}): ItemPublic => ({ ...newItem(`p-${type}-${patch.cut ?? ''}-${patch.doneness ?? 0}`, type, 0), steps: 0, ...patch }) as ItemPublic;

function Grid(): JSX.Element {
  const cols = 8;
  const half = Math.ceil(INGREDIENT_IDS.length / 2);
  const ids = shot.endsWith('2') ? INGREDIENT_IDS.slice(half) : INGREDIENT_IDS.slice(0, half);
  return (
    <group>
      {ids.map((id, i) => {
        const x = (i % cols) * 0.22 - ((cols - 1) * 0.22) / 2;
        const z = Math.floor(i / cols) * 0.24 - 0.24;
        return (
          <group key={id}>
            {shot.startsWith('shelf') ? <ShelfFood type={id} at={[x, 0, z]} fit={0.2} /> : <ItemMesh it={item(id)} at={[x, 0, z]} />}
            <Label text={INGREDIENTS[id].label} at={[x, 0.005, z + 0.1]} />
          </group>
        );
      })}
    </group>
  );
}

const CUT_TYPES: IngredientId[] = ['tomato', 'onion', 'carrot', 'potato', 'pork_slices', 'cabbage', 'garlic', 'lemon'];
const CUTS: Cut[] = ['WHOLE', 'SLICED', 'DICED', 'CHOPPED', 'CHUNK', 'MINCED', 'SHRED', 'MASHED'];

function Cuts(): JSX.Element {
  return (
    <group>
      {CUT_TYPES.map((t, r) =>
        CUTS.map((c, i) => {
          const x = i * 0.26 - ((CUTS.length - 1) * 0.26) / 2;
          const z = r * 0.24 - 0.85;
          return (
            <group key={`${t}${c}`}>
              <ItemMesh it={item(t, { cut: c })} at={[x, 0, z]} />
              {r === 0 && <Label text={c} at={[x, 0.17, z - 0.12]} />}
            </group>
          );
        }),
      )}
    </group>
  );
}

const COOK_TYPES: IngredientId[] = ['egg', 'bread', 'chicken', 'salmon', 'bacon', 'spinach', 'sausage', 'mushroom'];

function Cooked(): JSX.Element {
  const steps = [0, 1, 2];
  return (
    <group>
      {COOK_TYPES.map((t, r) =>
        steps.concat([3, 4]).map((s, i) => {
          const done = INGREDIENTS[t].heat.done;
          const patch: Partial<ItemPublic> =
            s === 0 ? {} : s === 1 ? { doneness: done[0] * 0.5, methods: ['pan'] } : s === 2 ? { doneness: done[0], methods: ['pan'], brownB: 0.6, brownA: 0.6 } : s === 3 ? { doneness: done[1], methods: ['pan'], brownB: 1.3, brownA: 1.3 } : { doneness: done[1] * 1.5, methods: ['pan'], brownB: 2.2, brownA: 2.2 };
          const x = i * 0.3 - 0.6;
          const z = r * 0.24 - 0.85;
          return <ItemMesh key={`${t}${s}`} it={item(t, patch)} at={[x, 0, z]} />;
        }),
      )}
    </group>
  );
}

export default function FoodPreview(): JSX.Element {
  const cam: Record<string, [[number, number, number], [number, number, number]]> = {
    raw: [[0, 0.62, 0.78], [0, 0, 0.02]],
    raw2: [[0, 0.62, 0.78], [0, 0, 0.02]],
    shelf: [[0, 0.62, 0.78], [0, 0, 0.02]],
    shelf2: [[0, 0.62, 0.78], [0, 0, 0.02]],
    cuts: [[0, 1.25, 1.0], [0, 0, -0.1]],
    cooked: [[0, 1.2, 1.0], [0, 0, -0.1]],
  };
  const [pos, look] = cam[shot] ?? cam.raw;
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Canvas camera={{ fov: 50, near: 0.01, far: 50 }} dpr={1}>
        <Stage pos={pos} look={look} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[1.5, 3, 2]} intensity={2.2} />
        <pointLight position={[-1, 1, 1]} intensity={1.5} color="#E6EEF0" />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]}>
          <planeGeometry args={[6, 6]} />
          <meshStandardMaterial color="#6B6F70" roughness={0.6} metalness={0.3} />
        </mesh>
        {shot === 'cuts' ? <Cuts /> : shot === 'cooked' ? <Cooked /> : <Grid />}
      </Canvas>
    </div>
  );
}
