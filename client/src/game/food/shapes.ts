import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  Shape,
  SphereGeometry,
  TetrahedronGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { IngredientId } from '@last-table/shared';
import { RAW_COLOR } from '../itemColors';

/**
 * 食材的低多邊形模型（程式產生，PS1 風格：少量多邊形、平面著色）。
 *
 * 每種食材由幾個「部件」組成，每個部件有一種顏色角色：
 *   body：食材本身（顏色跟著熟度、上色變）；top：朝上的那一面（平底鍋上看得到的那面）；
 *   #RRGGBB：固定顏色的配件（蒂頭、葉子、外皮、吐司邊…，焦的時候一起變暗）；
 *   pack:#RRGGBB：包裝（米袋、麵粉袋、牛奶盒…），只在冷藏架／乾貨架上顯示。
 * 模型的長邊沿著 x 軸、底部貼著 y=0。單位是公尺（一顆番茄約 9 公分寬）。
 */

export type Tone = 'body' | 'top' | string;
export interface Part {
  g: BufferGeometry;
  tone: Tone;
  /** item＝只在檯面上顯示（架上被包裝蓋住的內容物） */
  only?: 'item';
}

type V3 = [number, number, number];

/* ------------------------------- 幾何工具 ------------------------------- */

/** 統一屬性（只留 position、normal；非索引）：才能合併 */
function prep(g: BufferGeometry): BufferGeometry {
  const x = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(x.attributes)) if (k !== 'position') x.deleteAttribute(k);
  x.computeVertexNormals();
  return x;
}

function tf(g: BufferGeometry, p: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: V3 | number = 1): BufferGeometry {
  const sc = typeof s === 'number' ? new Vector3(s, s, s) : new Vector3(...s);
  g.applyMatrix4(new Matrix4().compose(new Vector3(...p), new Quaternion().setFromEuler(new Euler(...r)), sc));
  return g;
}

/** 由頂點位置決定的亂數（同一個位置永遠得到同一個值：重複的頂點一起移動，不會裂開） */
function hash(x: number, y: number, z: number, seed: number): number {
  const q = (v: number) => Math.round(v * 1e4) / 1e4;
  const s = Math.sin(q(x) * 127.1 + q(y) * 311.7 + q(z) * 74.7 + seed * 19.19) * 43758.5453;
  return s - Math.floor(s);
}

/** 讓表面凹凸不平（沿著離中心的方向推拉頂點）；only＝只推 x、z（攤平的東西保持平底） */
function lumpy(g: BufferGeometry, amt: number, seed = 1, only: 'xyz' | 'xz' = 'xyz'): BufferGeometry {
  const base = g.index ? g : g;
  for (const k of Object.keys(base.attributes)) if (k !== 'position') base.deleteAttribute(k);
  const m = mergeVertices(base);
  m.computeBoundingBox();
  const c = m.boundingBox!.getCenter(new Vector3());
  const pos = m.attributes.position;
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const d = v.clone().sub(c);
    if (only === 'xz') d.y = 0;
    if (d.lengthSq() < 1e-10) continue;
    d.normalize().multiplyScalar((hash(v.x, v.y, v.z, seed) - 0.5) * 2 * amt);
    pos.setXYZ(i, v.x + d.x, v.y + d.y, v.z + d.z);
  }
  return m;
}

/** 繞 y 軸的模型：依角度、高度調整半徑（瓣、稜、顆粒） */
function radial(g: BufferGeometry, fn: (theta: number, y: number) => number): BufferGeometry {
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const k = fn(Math.atan2(z, x), pos.getY(i));
    pos.setX(i, x * k);
    pos.setZ(i, z * k);
  }
  return g;
}

/** 沿 x 軸彎曲（y 隨 x² 上升）：香腸、茄子、辣椒 */
function bend(g: BufferGeometry, k: number): BufferGeometry {
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + k * pos.getX(i) ** 2);
  return g;
}

/** 沿 x 軸起伏（肉片、培根） */
function wave(g: BufferGeometry, amp: number, freq: number, phase = 0): BufferGeometry {
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + amp * Math.sin(pos.getX(i) * freq + phase));
  return g;
}

/** 一端變窄（x 越大，z 越窄）：雞胸、魚片 */
function taper(g: BufferGeometry, k: number): BufferGeometry {
  g.computeBoundingBox();
  const { min, max } = g.boundingBox!;
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getX(i) - min.x) / Math.max(1e-6, max.x - min.x);
    pos.setZ(i, pos.getZ(i) * (1 - k * t));
  }
  return g;
}

/** 輪廓（半徑, 高度）繞 y 軸轉一圈 */
function lathe(pts: number[][], seg = 9): BufferGeometry {
  return new LatheGeometry(
    pts.map(([r, y]) => new Vector2(Math.max(0, r), y)),
    seg,
  );
}

/** 把立著（沿 y）的模型放倒成沿 x */
const LAY: V3 = [0, 0, -Math.PI / 2];

/** 倒角的方塊（豆腐、奶油、紙盒） */
function chamferBox(w: number, h: number, d: number, b: number): BufferGeometry {
  const s = new Shape();
  const hw = w / 2 - b;
  const hd = d / 2 - b;
  s.moveTo(-hw, -hd);
  s.lineTo(hw, -hd);
  s.lineTo(hw, hd);
  s.lineTo(-hw, hd);
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: h - 2 * b, bevelEnabled: true, bevelSize: b, bevelThickness: b, bevelSegments: 1, curveSegments: 1 });
  return tf(g, [0, b, 0], [Math.PI / 2, 0, 0]).translate(0, h - b * 2, 0);
}

/** 平面輪廓擠出成平放的一片（厚度 h、底在 y=0） */
function slab(shape: Shape, h: number, bevel = 0.002, curve = 4): BufferGeometry {
  const g = new ExtrudeGeometry(shape, { depth: Math.max(0.0005, h - 2 * bevel), bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, curveSegments: curve });
  g.rotateX(Math.PI / 2);
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox!.min.y, 0);
  return g;
}

/** 一個紙盒（屋頂型的蓋子）：牛奶、鮮奶油、高湯 */
function carton(w: number, h: number, d: number, body: string, label: string): Part[] {
  const roof = new CylinderGeometry(0.001, w * 0.72, w * 0.32, 4, 1);
  return [
    { g: chamferBox(w, h, d, 0.003), tone: body },
    { g: tf(roof, [0, h + w * 0.16, 0], [0, Math.PI / 4, 0], [1, 1, d / w]), tone: body },
    { g: tf(new BoxGeometry(w * 1.02, h * 0.32, d * 1.02), [0, h * 0.45, 0]), tone: label },
  ];
}

/* ------------------------------- 整顆（原料）的樣子 ------------------------------- */

const P = (g: BufferGeometry, tone: Tone): Part => ({ g, tone });

function build(type: IngredientId): Part[] {
  switch (type) {
    case 'egg':
      return [P(lathe([[0, 0], [0.016, 0.004], [0.026, 0.016], [0.029, 0.032], [0.026, 0.05], [0.017, 0.064], [0.007, 0.071], [0, 0.072]], 9), 'body')];
    case 'tomato': {
      const fruit = radial(lathe([[0, 0.004], [0.026, 0], [0.042, 0.012], [0.047, 0.028], [0.043, 0.044], [0.029, 0.054], [0.01, 0.053], [0, 0.049]], 10), (t) => 1 + 0.035 * Math.cos(5 * t));
      const sepals = Array.from({ length: 5 }, (_, i) => {
        const a = (i / 5) * Math.PI * 2;
        return tf(new ConeGeometry(0.006, 0.026, 3), [Math.cos(a) * 0.011, 0.054, Math.sin(a) * 0.011], [0, -a, Math.PI / 2 - 0.25], [1, 1, 0.35]);
      });
      return [P(fruit, 'body'), P(mergeGeometries(sepals.map(prep))!, '#3E6B2A'), P(tf(new CylinderGeometry(0.0025, 0.003, 0.014, 5), [0, 0.06, 0]), '#3E6B2A')];
    }
    case 'onion':
      return [
        P(radial(lathe([[0, 0], [0.02, 0.002], [0.038, 0.014], [0.044, 0.032], [0.037, 0.052], [0.019, 0.067], [0.006, 0.08], [0, 0.088]], 9), (t) => 1 + 0.025 * Math.cos(7 * t)), 'body'),
        P(tf(new CylinderGeometry(0.009, 0.006, 0.006, 6), [0, 0.001, 0]), '#8A6A4A'),
      ];
    case 'potato':
      return [P(tf(lumpy(new IcosahedronGeometry(0.04, 1), 0.006, 3), [0, 0, 0], [0, 0.4, 0], [1.35, 0.72, 1]), 'body')];
    case 'garlic':
      return [P(radial(lathe([[0, 0], [0.015, 0.002], [0.03, 0.014], [0.033, 0.026], [0.024, 0.04], [0.01, 0.05], [0.004, 0.062], [0, 0.064]], 12), (t) => 0.92 + 0.12 * Math.abs(Math.cos(3 * t))), 'body')];
    case 'ginger': {
      const knobs = [
        [0, 0, 0, 0.026],
        [0.034, 0.004, 0.012, 0.02],
        [-0.03, 0.002, -0.01, 0.022],
        [0.012, 0.012, -0.022, 0.016],
        [0.058, 0.01, 0.02, 0.012],
      ].map(([x, y, z, r], i) => tf(lumpy(new IcosahedronGeometry(r, 0), r * 0.25, i + 7), [x, y, z], [0, i, 0], [1.2, 0.72, 1]));
      return [P(mergeGeometries(knobs.map(prep))!, 'body')];
    }
    case 'lemon':
      return [P(tf(lathe([[0, 0], [0.006, 0.005], [0.02, 0.014], [0.03, 0.03], [0.032, 0.045], [0.03, 0.06], [0.02, 0.076], [0.006, 0.085], [0, 0.09]], 9), [0, 0, 0], LAY), 'body')];
    case 'carrot': {
      const root = radial(lathe([[0, 0], [0.006, 0.02], [0.012, 0.05], [0.017, 0.09], [0.021, 0.122], [0.019, 0.136], [0, 0.14]], 8), (t) => 1 + 0.04 * Math.cos(6 * t));
      const greens = [-0.35, 0, 0.35].map((a) => tf(new ConeGeometry(0.004, 0.06, 3), [0, 0.165, 0], [a, 0, a * 0.5]));
      return [P(tf(root, [0, 0, 0], LAY), 'body'), P(tf(mergeGeometries(greens.map(prep))!, [0, 0, 0], LAY), '#4F8A35')];
    }
    case 'eggplant': {
      const fruit = bend(tf(lathe([[0, 0], [0.012, 0.004], [0.024, 0.02], [0.03, 0.05], [0.028, 0.08], [0.02, 0.11], [0.012, 0.13], [0.008, 0.142], [0, 0.144]], 9), [0, 0, 0], LAY), 1.6);
      const cap = tf(new ConeGeometry(0.014, 0.018, 6), [0.152, 0, 0], [0, 0, Math.PI / 2]);
      const stem = tf(new CylinderGeometry(0.003, 0.003, 0.025, 5), [0.17, 0, 0], [0, 0, Math.PI / 2]);
      return [P(fruit, 'body'), P(bend(mergeGeometries([cap, stem].map(prep))!, 1.6), '#3D5A2A')];
    }
    case 'sweet_potato':
      return [P(bend(tf(lumpy(lathe([[0, 0], [0.01, 0.01], [0.022, 0.035], [0.027, 0.065], [0.024, 0.095], [0.012, 0.125], [0, 0.135]], 8), 0.003, 5), [-0.0675, 0, 0], LAY), 1.2), 'body')];
    case 'corn': {
      const cob = radial(lathe([[0, 0], [0.016, 0.004], [0.022, 0.02], [0.024, 0.06], [0.022, 0.11], [0.014, 0.136], [0, 0.142]], 12), (t, y) => (Math.cos(12 * t) > 0 ? 1.05 : 0.97) * (Math.sin(y * 260) > 0 ? 1.02 : 0.98));
      const husk = [0, 2.1, 4.2].map((a) => tf(new CylinderGeometry(0.027, 0.02, 0.08, 6, 1, true, a, 1.4), [0, 0.035, 0]));
      return [P(tf(cob, [0, 0, 0], LAY), 'body'), P(tf(mergeGeometries(husk.map(prep))!, [0, 0, 0], LAY), '#B8C47E')];
    }
    case 'chili': {
      const pod = bend(tf(lathe([[0, 0], [0.004, 0.01], [0.008, 0.03], [0.011, 0.055], [0.012, 0.07], [0.01, 0.078], [0, 0.08]], 7), [-0.04, 0, 0], LAY), 6);
      return [P(pod, 'body'), P(bend(tf(new CylinderGeometry(0.0025, 0.004, 0.018, 5), [0.046, 0, 0], [0, 0, Math.PI / 2]), 6), '#3E6B2A')];
    }
    case 'scallion': {
      const white = tf(new CylinderGeometry(0.008, 0.007, 0.06, 6), [0.03, 0, 0], [0, 0, Math.PI / 2]);
      const greens = [-0.1, 0.02, 0.12].map((a, i) => tf(new CylinderGeometry(0.0045, 0.003, 0.15 - i * 0.015, 5), [0.06 + (0.075 - i * 0.008) * Math.cos(a), 0, (0.075 - i * 0.008) * Math.sin(a)], [0, -a, Math.PI / 2]));
      const root = tf(new ConeGeometry(0.008, 0.01, 5), [-0.004, 0, 0], [0, 0, -Math.PI / 2]);
      return [P(mergeGeometries(greens.map(prep))!, 'body'), P(white, '#E8EDD3'), P(root, '#C9B99A')];
    }
    case 'mushroom':
      return [
        P(lathe([[0, 0.028], [0.02, 0.026], [0.034, 0.031], [0.037, 0.04], [0.03, 0.053], [0.016, 0.059], [0, 0.061]], 10), 'body'),
        P(lathe([[0, 0], [0.01, 0], [0.012, 0.016], [0.01, 0.03], [0, 0.03]], 7), '#D8CDB8'),
      ];
    case 'cabbage': {
      const core = lumpy(new IcosahedronGeometry(0.05, 1), 0.004, 11);
      const leaves = [0, 2.1, 4.2].map((a, i) => tf(new SphereGeometry(0.056, 8, 6, 0, 2.3, 0.35, 1.9), [0, 0, 0], [0.12 * (i - 1), a, 0.1]));
      return [P(tf(core, [0, 0.05, 0], [0, 0, 0], [1, 0.9, 1]), 'body'), P(tf(mergeGeometries(leaves.map(prep))!, [0, 0.05, 0], [0, 0, 0], [1, 0.92, 1]), '#8DB56C')];
    }
    case 'spinach': {
      const leaves = [-0.6, -0.3, 0, 0.3, 0.6].map((a, i) => tf(new SphereGeometry(0.036, 6, 4), [0.05 * Math.cos(a), 0.008 + (i % 2) * 0.006, 0.05 * Math.sin(a)], [0.15 * (i - 2), -a, 0], [1.2, 0.14, 0.5]));
      const stems = [-0.6, -0.3, 0, 0.3, 0.6].map((a) => tf(new CylinderGeometry(0.0025, 0.002, 0.05, 4), [0.012 * Math.cos(a), 0.006, 0.012 * Math.sin(a)], [0, -a, Math.PI / 2]));
      return [P(mergeGeometries(leaves.map(prep))!, 'body'), P(mergeGeometries(stems.map(prep))!, '#9CC07A')];
    }
    case 'bell_pepper':
      return [
        P(radial(lathe([[0, 0.006], [0.022, 0], [0.036, 0.012], [0.041, 0.035], [0.039, 0.058], [0.031, 0.07], [0.012, 0.073], [0, 0.066]], 12), (t) => 1 + 0.09 * Math.cos(4 * t)), 'body'),
        P(mergeGeometries([tf(new CylinderGeometry(0.004, 0.005, 0.018, 5), [0, 0.078, 0]), tf(new CylinderGeometry(0.01, 0.012, 0.004, 6), [0, 0.068, 0])].map(prep))!, '#2F5A22'),
      ];
    case 'cauliflower': {
      const florets = [
        [0, 0.05, 0, 0.026],
        [0.03, 0.04, 0, 0.022],
        [-0.03, 0.04, 0.005, 0.022],
        [0.01, 0.04, 0.03, 0.021],
        [-0.008, 0.04, -0.03, 0.021],
        [0.024, 0.032, 0.026, 0.018],
        [-0.024, 0.032, -0.024, 0.018],
      ].map(([x, y, z, r], i) => tf(lumpy(new IcosahedronGeometry(r, 0), r * 0.2, i + 21), [x, y, z]));
      const leaves = [0, 1.57, 3.14, 4.71].map((a) => tf(new ConeGeometry(0.022, 0.05, 4, 1, true), [Math.cos(a) * 0.035, 0.022, Math.sin(a) * 0.035], [0, -a, -0.9], [1, 1, 0.4]));
      return [P(mergeGeometries(florets.map(prep))!, 'body'), P(mergeGeometries(leaves.map(prep))!, '#5E8C45')];
    }
    case 'bean_sprout': {
      const stems: BufferGeometry[] = [];
      const heads: BufferGeometry[] = [];
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const ox = Math.cos(a) * 0.012;
        const oz = Math.sin(a) * 0.016;
        const curve = new CatmullRomCurve3([new Vector3(-0.03 + ox, 0.004, oz), new Vector3(ox, 0.006 + (i % 3) * 0.003, oz + 0.006 * Math.sin(i)), new Vector3(0.028 + ox, 0.004, oz - 0.004)]);
        stems.push(new TubeGeometry(curve, 4, 0.0022, 3));
        heads.push(tf(new IcosahedronGeometry(0.0045, 0), [0.03 + ox, 0.005, oz - 0.004]));
      }
      return [P(mergeGeometries(stems.map(prep))!, 'body'), P(mergeGeometries(heads.map(prep))!, '#E2CF62')];
    }
    case 'chicken':
      return [P(tf(lumpy(new IcosahedronGeometry(0.045, 1), 0.007, 31), [0, 0, 0], [0, 0.3, 0], [1.5, 0.36, 1.1]), 'top')];
    case 'chicken_breast':
      return [P(taper(tf(lumpy(new SphereGeometry(0.045, 9, 6), 0.003, 33), [0, 0, 0], [0, 0, 0], [1.55, 0.38, 0.95]), 0.5), 'top')];
    case 'ground_pork':
      return [P(tf(lumpy(new IcosahedronGeometry(0.042, 1), 0.01, 37), [0, 0, 0], [0, 0, 0], [1.25, 0.55, 1.1]), 'body'), P(chamferBox(0.13, 0.008, 0.11, 0.002).translate(0, -0.024, 0), 'pack:#E8E4DA')];
    case 'pork_slices':
    case 'beef_slices': {
      const fat = type === 'pork_slices' ? '#F3E6DC' : '#E9CBC4';
      const meat: BufferGeometry[] = [];
      const rim: BufferGeometry[] = [];
      for (let i = 0; i < 3; i++) {
        const y = 0.003 + i * 0.006;
        const r: V3 = [0, (i - 1) * 0.25, 0];
        meat.push(wave(tf(new BoxGeometry(0.11, 0.005, 0.06, 8, 1, 2), [i * 0.008, y, i * 0.004], r), 0.003, 70, i));
        rim.push(wave(tf(new BoxGeometry(0.11, 0.0055, 0.008, 8, 1, 1), [i * 0.008, y, i * 0.004], r).translate(...rot2((i - 1) * 0.25, 0, 0.033)), 0.003, 70, i));
      }
      return [P(mergeGeometries(meat.map(prep))!, 'top'), P(mergeGeometries(rim.map(prep))!, fat)];
    }
    case 'bacon': {
      const strips: BufferGeometry[] = [];
      const fat: BufferGeometry[] = [];
      for (let i = 0; i < 2; i++) {
        const z = (i - 0.5) * 0.04;
        const y = 0.003 + i * 0.005;
        strips.push(wave(tf(new BoxGeometry(0.15, 0.005, 0.034, 12, 1, 1), [0, y, z]), 0.004, 60, i * 2));
        for (const dz of [-0.008, 0.009]) fat.push(wave(tf(new BoxGeometry(0.15, 0.0056, 0.006, 12, 1, 1), [0, y, z + dz]), 0.004, 60, i * 2));
      }
      return [P(mergeGeometries(strips.map(prep))!, 'top'), P(mergeGeometries(fat.map(prep))!, '#F4DDD5')];
    }
    case 'sausage':
      return [P(bend(tf(new CapsuleGeometry(0.015, 0.085, 3, 7), [0, 0, 0], [0, 0, Math.PI / 2]), 6), 'body')];
    case 'tofu':
      return [P(chamferBox(0.07, 0.045, 0.07, 0.004), 'body'), P(chamferBox(0.085, 0.012, 0.085, 0.002).translate(0, -0.006, 0), 'pack:#DCE6EA')];
    case 'chickpea': {
      const beans: BufferGeometry[] = [];
      for (let i = 0; i < 11; i++) {
        const a = i * 2.4;
        const r = i < 7 ? 0.018 : 0.007;
        beans.push(tf(lumpy(new IcosahedronGeometry(0.0085, 0), 0.0015, i + 41), [Math.cos(a) * r, i < 7 ? 0.008 : 0.02, Math.sin(a) * r]));
      }
      return [P(mergeGeometries(beans.map(prep))!, 'body'), P(lathe([[0.028, -0.002], [0.04, 0.012], [0.042, 0.016], [0.026, 0.002]], 9).translate(0, -0.004, 0), 'pack:#A88A5C')];
    }
    case 'salmon':
    case 'white_fish': {
      const s = new Shape();
      s.moveTo(-0.07, -0.03);
      s.quadraticCurveTo(-0.075, 0, -0.07, 0.032);
      s.quadraticCurveTo(0.0, 0.04, 0.07, 0.012);
      s.quadraticCurveTo(0.08, 0.0, 0.07, -0.012);
      s.quadraticCurveTo(0.0, -0.036, -0.07, -0.03);
      const flesh = slab(s, 0.024, 0.003, 3);
      const skin = slab(s, 0.004, 0, 3).translate(0, -0.002, 0);
      const parts: Part[] = [P(flesh, 'top'), P(skin, type === 'salmon' ? '#77838A' : '#A3A49C')];
      const lines = [-0.045, -0.02, 0.005, 0.03].map((x) => tf(new BoxGeometry(0.0035, 0.002, 0.05), [x, 0.0245, 0], [0, 0.5, 0]));
      parts.push(P(mergeGeometries(lines.map(prep))!, type === 'salmon' ? '#F9CDB4' : '#E2DCCF'));
      return parts;
    }
    case 'shrimp': {
      const segs: BufferGeometry[] = [];
      for (let i = 0; i < 6; i++) {
        const a = Math.PI * 0.15 + (i / 5) * Math.PI * 1.15;
        const r = 0.016 - i * 0.0017;
        segs.push(tf(new SphereGeometry(r, 6, 4), [Math.cos(a) * 0.032, r * 0.85, Math.sin(a) * 0.032], [0, -a, 0], [0.9, 0.85, 1.3]));
      }
      const ta = Math.PI * 0.15 + Math.PI * 1.15 + 0.3;
      const tail = [0.45, -0.45].map((d) => tf(new ConeGeometry(0.011, 0.026, 3), [Math.cos(ta) * 0.034, 0.005, Math.sin(ta) * 0.034], [Math.PI / 2, 0, -ta + d], [1, 1, 0.3]));
      return [P(mergeGeometries(segs.map(prep))!, 'body'), P(mergeGeometries(tail.map(prep))!, '#8E6F62')];
    }
    case 'clam': {
      const half = () => radial(new SphereGeometry(0.03, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2), (t) => 1 + 0.035 * Math.cos(14 * t));
      const top = tf(half(), [0, 0.008, 0], [0.22, 0, 0], [1, 0.6, 0.82]);
      const bottom = tf(half(), [0, 0.008, 0], [Math.PI, 0, 0], [1, 0.5, 0.82]);
      return [P(mergeGeometries([top, bottom].map(prep))!, 'body'), P(tf(new BoxGeometry(0.012, 0.006, 0.006), [0, 0.006, -0.024]), '#6E6458')];
    }
    case 'rice':
    case 'flour': {
      const mound = tf(lumpy(new SphereGeometry(0.045, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2), 0.003, type === 'rice' ? 51 : 52, 'xz'), [0, 0, 0], [0, 0, 0], [1, 0.42, 1]);
      if (type === 'rice') {
        const sack = lathe([[0.042, 0], [0.052, 0.02], [0.054, 0.06], [0.046, 0.088], [0.043, 0.092]], 9);
        const tie = tf(new TorusGeometry(0.045, 0.003, 3, 9), [0, 0.086, 0], [Math.PI / 2, 0, 0]);
        return [P(mound.translate(0, 0.07, 0), 'body'), P(sack, 'pack:#CBB48A'), P(tie, 'pack:#7A5A3A')];
      }
      const bag = chamferBox(0.085, 0.12, 0.06, 0.003);
      const fold = tf(new CylinderGeometry(0.001, 0.06, 0.03, 4, 1), [0, 0.135, 0], [0, Math.PI / 4, 0], [1, 1, 0.7]);
      const band = tf(new BoxGeometry(0.087, 0.03, 0.062), [0, 0.06, 0]);
      return [{ g: mound, tone: 'body', only: 'item' }, P(mergeGeometries([bag, fold].map(prep))!, 'pack:#E8E0CC'), P(band, 'pack:#B0473A')];
    }
    case 'spaghetti': {
      const sticks: BufferGeometry[] = [];
      for (let i = 0; i < 14; i++) {
        const a = i * 2.4;
        const r = 0.0035 * Math.sqrt(i);
        sticks.push(tf(new CylinderGeometry(0.0018, 0.0018, 0.2, 3), [0, 0.012 + Math.sin(a) * r, Math.cos(a) * r], [0, 0, Math.PI / 2]));
      }
      return [P(mergeGeometries(sticks.map(prep))!, 'body'), P(tf(new CylinderGeometry(0.0145, 0.0145, 0.05, 8, 1, true), [0, 0.012, 0], [0, 0, Math.PI / 2]), 'pack:#3B5B8C')];
    }
    case 'udon':
    case 'rice_noodle': {
      const thin = type === 'rice_noodle';
      const rings = Array.from({ length: thin ? 5 : 3 }, (_, i) => tf(new TorusGeometry(0.03 - i * 0.002, thin ? 0.0025 : 0.006, 3, 12), [0.003 * Math.sin(i * 2), 0.007 + i * (thin ? 0.004 : 0.008), 0.003 * Math.cos(i * 2)], [Math.PI / 2 + 0.1 * Math.sin(i * 3), 0, i * 0.7]));
      return [P(mergeGeometries(rings.map(prep))!, 'body')];
    }
    case 'cheese': {
      const s = new Shape();
      s.moveTo(-0.045, -0.03);
      s.lineTo(0.045, -0.03);
      s.lineTo(-0.045, 0.035);
      s.closePath();
      const wedge = slab(s, 0.035, 0.002, 1);
      const holes = [
        [-0.02, 0.012, -0.0305],
        [0.01, 0.022, -0.0305],
        [-0.03, 0.024, -0.0305],
      ].map(([x, y, z]) => tf(new CylinderGeometry(0.005, 0.005, 0.002, 6), [x, y, z], [Math.PI / 2, 0, 0]));
      return [P(wedge, 'body'), P(mergeGeometries(holes.map(prep))!, '#C99A2E')];
    }
    case 'butter':
      return [P(chamferBox(0.07, 0.03, 0.045, 0.003), 'body'), P(chamferBox(0.075, 0.016, 0.05, 0.001).translate(0.012, -0.001, 0), 'pack:#F3EEE0')];
    case 'bread': {
      const outline = (k: number) => {
        const s = new Shape();
        s.moveTo(-0.05 * k, -0.05 * k);
        s.lineTo(0.05 * k, -0.05 * k);
        s.lineTo(0.05 * k, 0.025 * k);
        s.quadraticCurveTo(0.06 * k, 0.055 * k, 0.025 * k, 0.056 * k);
        s.quadraticCurveTo(0, 0.068 * k, -0.025 * k, 0.056 * k);
        s.quadraticCurveTo(-0.06 * k, 0.055 * k, -0.05 * k, 0.025 * k);
        s.closePath();
        return s;
      };
      const crust = slab(outline(1), 0.018, 0.002, 3);
      const crumb = slab(outline(0.86), 0.002, 0, 3).translate(0, 0.0178, 0);
      return [P(crust, '#A9763C'), P(crumb, 'top')];
    }
    case 'stock':
      return carton(0.07, 0.13, 0.05, '#C49B4E', '#EFE7D2');
    case 'milk':
      return carton(0.065, 0.12, 0.065, 'pack:#F4F3EC', 'pack:#3F6EA8');
    case 'cream':
      return carton(0.05, 0.08, 0.05, 'pack:#FBF6E6', 'pack:#C98B3A');
    case 'water':
      return [P(lathe([[0, 0], [0.028, 0], [0.032, 0.09], [0.029, 0.09], [0.025, 0.004], [0, 0.004]], 9), 'pack:#C9DCE4')];
  }
  // 沒有特別做模型的：一顆不規則的圓
  return [P(lumpy(new IcosahedronGeometry(0.04, 1), 0.004, 99), 'body')];
}

/** 繞 y 軸轉 a 之後的位移（肉片的肥邊跟著那一片轉） */
function rot2(a: number, x: number, z: number): V3 {
  return [x * Math.cos(a) + z * Math.sin(a), 0, -x * Math.sin(a) + z * Math.cos(a)];
}

/* ------------------------------- 快取與分組 ------------------------------- */

const isPack = (t: Tone) => t.startsWith('pack:');
const packColor = (t: Tone) => (isPack(t) ? t.slice(5) : t);

/** 把一組部件移到「長邊沿 x、中心在原點、底部貼 y=0」 */
function ground(parts: Part[]): Part[] {
  const box = new Box3();
  for (const p of parts) {
    p.g.computeBoundingBox();
    box.union(p.g.boundingBox!);
  }
  const c = box.getCenter(new Vector3());
  return parts.map((p) => ({ ...p, g: p.g.clone().translate(-c.x, -box.min.y, -c.z) }));
}

const raw = new Map<IngredientId, Part[]>();
function partsOf(type: IngredientId): Part[] {
  let p = raw.get(type);
  if (!p) {
    p = build(type).map((x) => ({ ...x, g: prep(x.g) }));
    raw.set(type, p);
  }
  return p;
}

export interface FoodGroups {
  /** 依顏色角色合併好的幾何（一個角色一個 mesh） */
  groups: Array<{ tone: Tone; g: BufferGeometry }>;
  /** 大小（公尺） */
  size: Vector3;
}

function groupBy(parts: Part[]): FoodGroups {
  const by = new Map<Tone, BufferGeometry[]>();
  for (const p of parts) by.set(p.tone, [...(by.get(p.tone) ?? []), p.g]);
  const groups = [...by.entries()].map(([tone, gs]) => ({ tone, g: gs.length === 1 ? gs[0] : mergeGeometries(gs)! }));
  const box = new Box3();
  for (const g of groups) {
    g.g.computeBoundingBox();
    box.union(g.g.boundingBox!);
  }
  return { groups, size: box.getSize(new Vector3()) };
}

const itemCache = new Map<IngredientId, FoodGroups>();
/** 檯面上、手上、鍋裡的一份（不含包裝） */
export function foodItem(type: IngredientId): FoodGroups {
  let f = itemCache.get(type);
  if (!f) {
    const parts = partsOf(type).filter((p) => !isPack(p.tone));
    f = groupBy(ground(parts.length ? parts : partsOf(type).map((p) => ({ ...p, tone: packColor(p.tone) }))));
    itemCache.set(type, f);
  }
  return f;
}

const shelfCache = new Map<IngredientId, { g: BufferGeometry; size: Vector3 }>();
/**
 * 架上的原料（含包裝）：所有部件合併成一個幾何，顏色寫在頂點上（一個 mesh 一次繪製）。
 */
export function foodShelf(type: IngredientId): { g: BufferGeometry; size: Vector3 } {
  let f = shelfCache.get(type);
  if (!f) {
    const parts = ground(partsOf(type).filter((p) => p.only !== 'item'));
    const colored = parts.map((p) => {
      const c = new Color(p.tone === 'body' || p.tone === 'top' ? RAW_COLOR[type] : packColor(p.tone));
      const n = p.g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
      const g = p.g.clone();
      g.setAttribute('color', new Float32BufferAttribute(arr, 3));
      return g;
    });
    const g = mergeGeometries(colored)!;
    g.computeBoundingBox();
    f = { g, size: g.boundingBox!.getSize(new Vector3()) };
    shelfCache.set(type, f);
  }
  return f;
}

/* ------------------------------- 切過的樣子 ------------------------------- */

const pieceCache = new Map<string, BufferGeometry>();
function cachedPiece(key: string, make: () => BufferGeometry): BufferGeometry {
  let g = pieceCache.get(key);
  if (!g) {
    g = prep(make());
    pieceCache.set(key, g);
  }
  return g;
}

/** 塊（不規則的多面體，三種變化） */
export const chunkGeo = (v: number, r = 0.022): BufferGeometry => cachedPiece(`chunk${v % 3}${r}`, () => tf(lumpy(new IcosahedronGeometry(r, 0), r * 0.3, 60 + (v % 3)), [0, 0, 0], [0, 0, 0], [1, 0.8, 1]));
/** 丁（歪一點的小方塊） */
export const diceGeo = (v: number, s = 0.017): BufferGeometry => cachedPiece(`dice${v % 3}${s}`, () => lumpy(new BoxGeometry(s, s, s), s * 0.12, 70 + (v % 3)));
/** 末（小碎粒） */
export const minceGeo = (v: number): BufferGeometry => cachedPiece(`mince${v % 2}`, () => tf(new TetrahedronGeometry(0.0065), [0, 0, 0], [v, v * 2, 0]));
/** 絲（細條，微彎） */
export const shredGeo = (v: number, len = 0.07): BufferGeometry => cachedPiece(`shred${v % 3}${len}`, () => bend(new BoxGeometry(len, 0.005, 0.005, 4, 1, 1), ((v % 3) - 1) * 6));
/** 圓片（外圈＝食材的顏色，中間另外一層淺色的切面） */
export const discGeo = (r: number): BufferGeometry => cachedPiece(`disc${r.toFixed(3)}`, () => new CylinderGeometry(r, r, 0.008, 9));
export const discCoreGeo = (r: number): BufferGeometry => cachedPiece(`core${r.toFixed(3)}`, () => new CylinderGeometry(r * 0.72, r * 0.72, 0.0084, 9));
/** 圈（洋蔥、青椒、辣椒、蔥） */
export const ringGeo = (r: number): BufferGeometry => cachedPiece(`ring${r.toFixed(3)}`, () => tf(new TorusGeometry(r, Math.max(0.0025, r * 0.16), 3, 10), [0, 0.003, 0], [Math.PI / 2, 0, 0]));
/** 長條片（肉切片、葉菜切段） */
export const stripGeo = (v: number, leafy: boolean): BufferGeometry =>
  cachedPiece(`strip${v % 3}${leafy}`, () => wave(new BoxGeometry(leafy ? 0.05 : 0.075, leafy ? 0.003 : 0.006, leafy ? 0.03 : 0.022, 5, 1, 1), leafy ? 0.004 : 0.002, 90, v));
/** 一灘（打散的蛋、麵糊） */
export const puddleGeo = (r: number, h: number, v = 0): BufferGeometry => cachedPiece(`puddle${r}${h}${v}`, () => lumpy(new CylinderGeometry(r, r, h, 12), r * 0.14, 80 + v, 'xz').translate(0, h / 2, 0));
/** 一團（泥、絞肉餡） */
export const moundGeo = (r: number, v = 0): BufferGeometry => cachedPiece(`mound${r}${v}`, () => tf(lumpy(new SphereGeometry(r, 9, 6, 0, Math.PI * 2, 0, Math.PI / 2), r * 0.15, 90 + v), [0, 0, 0], [0, 0, 0], [1.25, 0.55, 1.25]));
/** 圓餅（肉餡壓成的餅） */
export const pattyGeo = (): BufferGeometry => cachedPiece('patty', () => lumpy(new CylinderGeometry(0.05, 0.052, 0.026, 10), 0.004, 95).translate(0, 0.013, 0));
/** 半球（荷包蛋的蛋黃） */
export const domeGeo = (r: number): BufferGeometry => cachedPiece(`dome${r}`, () => tf(new SphereGeometry(r, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), [0, 0, 0], [0, 0, 0], [1, 0.7, 1]));
/** 杯子（液體、果汁） */
export const cupGeo = (r: number, h: number): BufferGeometry => cachedPiece(`cup${r}${h}`, () => lathe([[0, 0], [r * 0.85, 0], [r, h], [r * 0.9, h], [r * 0.78, 0.004], [0, 0.004]], 10));
export const cupFillGeo = (r: number, h: number): BufferGeometry => cachedPiece(`fill${r}${h}`, () => new CylinderGeometry(r * 0.88, r * 0.8, 0.003, 10).translate(0, h * 0.85, 0));

/** 切圓片時是「圈」的食材 */
export const RING_TYPES = new Set<IngredientId>(['onion', 'bell_pepper', 'chili', 'scallion']);
/** 切片時是「長條片」的食材（肉、魚、葉菜、吐司） */
export const STRIP_TYPES = new Set<IngredientId>(['chicken', 'chicken_breast', 'pork_slices', 'beef_slices', 'bacon', 'salmon', 'white_fish', 'tofu', 'cheese', 'bread', 'butter', 'ground_pork']);
export const LEAFY_TYPES = new Set<IngredientId>(['cabbage', 'spinach', 'bean_sprout', 'scallion']);

/** 圓片的半徑：取整顆模型短邊的一半 */
export function sliceRadius(type: IngredientId): number {
  const s = foodItem(type).size;
  const dims = [s.x, s.y, s.z].sort((a, b) => a - b);
  return Math.min(0.034, Math.max(0.008, dims[1] / 2));
}
