import { useMemo } from 'react';
import { Color, DoubleSide, MeshStandardMaterial, type BufferGeometry } from 'three';
import { INGREDIENTS, maxBrown, type IngredientId, type ItemPublic } from '@last-table/shared';
import { COOKED_COLOR, RAW_COLOR } from '../itemColors';
import {
  LEAFY_TYPES,
  RING_TYPES,
  STRIP_TYPES,
  chunkGeo,
  cupFillGeo,
  cupGeo,
  diceGeo,
  discCoreGeo,
  discGeo,
  domeGeo,
  foodItem,
  foodShelf,
  minceGeo,
  moundGeo,
  pattyGeo,
  puddleGeo,
  ringGeo,
  shredGeo,
  sliceRadius,
  stripGeo,
  type Tone,
} from './shapes';

type V3 = [number, number, number];

export const BROWN = new Color('#6E3F1C');
const BURNT = new Color('#1C1612');
const WHITE = new Color('#FFFFFF');

type Browning = Pick<ItemPublic, 'type' | 'doneness' | 'brownA' | 'brownB' | 'scorched'>;

/** 看得見的資訊：顏色＝熟度＋上色（同一份伺服器狀態，沒有額外資料） */
export function itemColor(it: Browning, side: 'top' | 'bottom' | 'max' = 'max'): Color {
  const h = INGREDIENTS[it.type].heat;
  const c = new Color(RAW_COLOR[it.type]).lerp(new Color(COOKED_COLOR[it.type]), Math.min(1, it.doneness / Math.max(0.1, h.done[0])));
  return browned(c, side === 'top' ? it.brownB : side === 'bottom' ? it.brownA : maxBrown(it), it.scorched);
}

function browned(c: Color, b: number, scorched: boolean): Color {
  if (b >= 2 || scorched) return c.copy(BURNT);
  c.lerp(BROWN, Math.min(0.85, b / 1.7));
  if (b > 1.5) c.lerp(BURNT, (b - 1.5) / 0.5);
  return c;
}

const mats = new Map<string, MeshStandardMaterial>();
/** 食材的材質（平面著色、雙面：葉子、外殼是單面的幾何） */
export function foodMat(c: Color | string): MeshStandardMaterial {
  const color = typeof c === 'string' ? new Color(c) : c;
  const key = color.getHexString();
  let m = mats.get(key);
  if (!m) {
    m = new MeshStandardMaterial({ color, roughness: 0.78, metalness: 0, flatShading: true, side: DoubleSide });
    mats.set(key, m);
  }
  return m;
}

/** 架上的原料：顏色寫在頂點上 */
const SHELF_MAT = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, flatShading: true, side: DoubleSide });

/**
 * 架上、地上的一份原料（含包裝）。fit＝最多佔多寬（公尺）：長的東西轉成前後方向，還放不下就縮小；scale＝放大（架子離得遠，稍微放大比較看得清楚）。
 */
export function ShelfFood({ type, at, rot = 0, fit = 0.14, scale = 1 }: { type: string; at: V3; rot?: number; fit?: number; scale?: number }): JSX.Element | null {
  const id = (type in RAW_COLOR ? type : 'egg') as IngredientId;
  const { g, size } = foodShelf(id);
  const turn = size.x > fit && size.z < size.x ? Math.PI / 2 : 0;
  const wide = turn ? size.z : size.x;
  const k = Math.min(scale, fit / Math.max(1e-3, wide));
  return <mesh geometry={g} material={SHELF_MAT} position={at} rotation={[0, rot + turn, 0]} scale={k} />;
}

/** 依顏色角色畫一份整顆的食材 */
function Whole({ it, body, top }: { it: ItemPublic; body: MeshStandardMaterial; top: MeshStandardMaterial }): JSX.Element {
  const f = foodItem(it.type);
  const b = maxBrown(it);
  const tone = (t: Tone): MeshStandardMaterial => {
    if (t === 'body') return body;
    if (t === 'top') return top;
    return foodMat(browned(new Color(t.startsWith('pack:') ? t.slice(5) : t), b, it.scorched));
  };
  return (
    <group>
      {f.groups.map((x) => (
        <mesh key={x.tone} geometry={x.g} material={tone(x.tone)} />
      ))}
    </group>
  );
}

/** 一堆碎塊（位置依食材 id 固定：每一幀都一樣，不會跳） */
function Scatter({ n, geo, mats: ms, r0 = 0.03, r1 = 0.03, seed, lift = 0.008 }: { n: number; geo: (i: number) => BufferGeometry; mats: MeshStandardMaterial[]; r0?: number; r1?: number; seed: number; lift?: number }): JSX.Element {
  return (
    <group>
      {Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 + seed;
        const r = r0 + ((i * 7 + seed) % 3) * (r1 / 2);
        return <mesh key={i} geometry={geo(i)} material={ms[i % ms.length]} position={[Math.cos(a) * r, lift + (i % 3) * 0.004, Math.sin(a) * r]} rotation={[(i * 1.3) % 3, a * 2.1, (i * 0.7) % 2]} />;
      })}
    </group>
  );
}

const seedOf = (id: string): number => {
  let h = 0;
  for (let i = 0; i < (id ?? "").length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
  return h / 97;
};

/** 切面比外皮淺一點 */
const coreColor = (c: Color): Color => c.clone().lerp(WHITE, 0.32);

/**
 * 一份食材的外觀：整顆是低多邊形的模型（番茄有蒂、紅蘿蔔有葉子、吐司有邊），
 * 切過依切法變成圓片／圈／條／丁／塊／末／絲；顏色反映熟度與上色（同一份伺服器狀態）。
 */
export function ItemMesh({ it, at }: { it: ItemPublic; at: V3 }): JSX.Element {
  const topC = itemColor(it, 'top');
  const bodyC = itemColor(it, 'max');
  const top = foodMat(topC);
  const body = foodMat(bodyC);
  const seed = seedOf(it.id);
  const ing = INGREDIENTS[it.type];
  const cooked = it.doneness >= ing.heat.done[0] * 0.6;
  // 葉菜煮過會塌下去，肉煮過會縮一點
  const wilt = cooked && LEAFY_TYPES.has(it.type) ? 0.55 : 1;
  const shrink = cooked && ing.category === 'protein' && it.type !== 'egg' && it.type !== 'tofu' ? 0.88 : 1;
  const mixParts = useMemo(() => (it.mix?.kind === 'tossed' ? it.mix.parts.slice(0, 4).map((p) => foodMat(itemColor(p))) : []), [it.mix]);

  let shape: JSX.Element;
  if (it.mix) {
    // 拌料：麵糊攤成一灘、餡料是一塊厚餅、拌料是各種食材的碎塊混在一起
    shape =
      it.mix.kind === 'batter' ? (
        <mesh geometry={puddleGeo(0.085, 0.014, 1)} material={top} />
      ) : it.mix.kind === 'bound' ? (
        <mesh geometry={pattyGeo()} material={top} />
      ) : (
        <Scatter n={10} geo={(i) => chunkGeo(i, 0.016)} mats={[body, ...mixParts]} seed={seed} r0={0.02} r1={0.04} />
      );
  } else if (ing.liquid && it.type !== 'stock') {
    shape = (
      <group>
        <mesh geometry={cupGeo(0.034, 0.09)} material={foodMat('#E9EEF0')} />
        <mesh geometry={cupFillGeo(0.034, 0.09)} material={body} />
      </group>
    );
  } else if (it.cut === 'SHRED') {
    shape = <Scatter n={10} geo={(i) => shredGeo(i, 0.07)} mats={[body]} seed={seed} r0={0.01} r1={0.025} lift={0.004} />;
  } else if (it.cut === 'CHUNK') {
    shape = <Scatter n={5} geo={(i) => chunkGeo(i)} mats={[body, top]} seed={seed} r0={0.025} r1={0.03} lift={0.016} />;
  } else if (it.cut === 'GRATED') {
    shape = <Scatter n={14} geo={(i) => shredGeo(i, 0.022)} mats={[body]} seed={seed} r0={0.004} r1={0.025} lift={0.004} />;
  } else if (it.cut === 'MASHED') {
    shape = <mesh geometry={moundGeo(0.05, 1)} material={body} />;
  } else if (it.cut === 'JUICED') {
    shape = (
      <group>
        <mesh geometry={cupGeo(0.026, 0.05)} material={foodMat('#E9EEF0')} />
        <mesh geometry={cupFillGeo(0.026, 0.05)} material={body} />
      </group>
    );
  } else if (it.cut === 'BEATEN') {
    shape = it.methods.length ? (
      <Scatter n={7} geo={(i) => chunkGeo(i, 0.018)} mats={[body]} seed={seed} r0={0.015} r1={0.035} lift={0.01} />
    ) : (
      <mesh geometry={puddleGeo(0.08, 0.012, 2)} material={foodMat('#E9B93E')} />
    );
  } else if (it.cut === 'SLICED') {
    if (STRIP_TYPES.has(it.type) || LEAFY_TYPES.has(it.type)) {
      const leafy = LEAFY_TYPES.has(it.type);
      shape = (
        <group>
          {[0, 1, 2, 3].map((i) => (
            <mesh key={i} geometry={stripGeo(i, leafy)} material={i % 2 ? top : body} position={[0, 0.004 + i * 0.004, (i - 1.5) * 0.022]} rotation={[0, (i - 1.5) * 0.18, 0]} />
          ))}
        </group>
      );
    } else if (RING_TYPES.has(it.type)) {
      const r = sliceRadius(it.type);
      shape = (
        <group>
          {[0, 1, 2, 3, 4].map((i) => (
            <mesh key={i} geometry={ringGeo(r * (1 - (i % 2) * 0.12))} material={body} position={[(i - 2) * r * 1.1, i * 0.002, ((i % 2) - 0.5) * r * 0.6]} />
          ))}
        </group>
      );
    } else {
      const r = sliceRadius(it.type);
      const core = foodMat(coreColor(bodyC));
      shape = (
        <group>
          {[0, 1, 2, 3, 4].map((i) => (
            <group key={i} position={[(i - 2) * r * 1.15, 0.006 + i * 0.002, 0]} rotation={[0, 0, -0.18]}>
              <mesh geometry={discGeo(r)} material={i % 2 ? top : body} />
              <mesh geometry={discCoreGeo(r)} material={core} />
            </group>
          ))}
        </group>
      );
    }
  } else if (it.cut === 'DICED' || it.cut === 'CHOPPED') {
    const core = foodMat(coreColor(bodyC));
    shape = <Scatter n={it.cut === 'DICED' ? 9 : 8} geo={(i) => (it.cut === 'DICED' ? diceGeo(i) : chunkGeo(i, 0.014))} mats={[body, core, top]} seed={seed} r0={0.012} r1={0.03} lift={0.009} />;
  } else if (it.cut === 'MINCED') {
    shape = <Scatter n={14} geo={minceGeo} mats={[body, foodMat(coreColor(bodyC))]} seed={seed} r0={0.004} r1={0.025} lift={0.004} />;
  } else if (it.type === 'egg' && it.methods.includes('pan')) {
    // 荷包蛋：不規則的蛋白＋半球蛋黃
    shape = (
      <group>
        <mesh geometry={puddleGeo(0.07, 0.008, 3)} material={top} />
        <mesh geometry={domeGeo(0.024)} material={foodMat(it.doneness > 2.2 ? '#E4BE58' : '#F0A820')} position={[0.01, 0.008, 0.004]} />
      </group>
    );
  } else {
    shape = <Whole it={it} body={body} top={top} />;
  }
  const k: V3 = [shrink, shrink * wilt, shrink];
  return (
    <group position={at} scale={k}>
      {shape}
    </group>
  );
}
