import {
  AnimationClip,
  DoubleSide,
  LinearMipmapLinearFilter,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  SRGBColorSpace,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { sanitizeClip } from './assets';

/**
 * 怪物與客人的模型（tools/characters/build_creatures.py 產生）。
 *
 *  - monster.glb：自己的骨架與全部動畫在同一個檔案。
 *  - diner_a..d.glb、guest_suit.glb：沿用廚師的骨架；動畫在 civ_anims.glb。
 *
 * 載入失敗時回傳 null，呼叫端退回原本的方塊模型（遊戲照常進行）。
 */

const BASE = `${import.meta.env.BASE_URL ?? '/'}models/`;
const loader = new GLTFLoader();
const gltfCache = new Map<string, Promise<GLTF | null>>();
function loadGlb(file: string): Promise<GLTF | null> {
  let p = gltfCache.get(file);
  if (!p) {
    p = loader.loadAsync(`${BASE}${file}`).catch((e: unknown) => {
      console.warn(`[模型] ${file} 載入失敗，改用備用模型：`, e);
      return null;
    });
    gltfCache.set(file, p);
  }
  return p;
}

const pixelate = (t: Texture | null): Texture | null => {
  if (!t) return null;
  t.magFilter = NearestFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 1;
  t.needsUpdate = true;
  return t;
};

const matCache = new Map<Material, Material>();
/** PS1 方向的材質：不反光的 Lambert、平面著色；眼睛自己發光；破布挖空 */
function convert(m: Material): Material {
  const hit = matCache.get(m);
  if (hit) return hit;
  const src = m as MeshStandardMaterial;
  const map = pixelate(src.map ?? null);
  let out: Material;
  if (/eye/i.test(m.name)) {
    out = new MeshBasicMaterial({ map, color: map ? 0xffffff : src.color, name: m.name });
  } else {
    const cut = /apron/i.test(m.name);
    out = new MeshLambertMaterial({
      map,
      color: map ? 0xffffff : src.color,
      flatShading: true,
      name: m.name,
      ...(cut ? { alphaTest: 0.5, side: DoubleSide, transparent: false } : {}),
    });
  }
  matCache.set(m, out);
  return out;
}

function prepare(scene: Object3D): void {
  scene.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
  });
}

const boneNames = (scene: Object3D): Set<string> => {
  const out = new Set<string>();
  scene.traverse((o) => {
    if ((o as { isBone?: boolean }).isBone) out.add(o.name);
  });
  return out;
};

export interface CreatureAsset {
  template: Object3D;
  clips: Map<string, AnimationClip>;
}

let monsterP: Promise<CreatureAsset | null> | null = null;
export function loadMonster(): Promise<CreatureAsset | null> {
  monsterP ??= loadGlb('monster.glb').then((g) => {
    if (!g) return null;
    prepare(g.scene);
    const bones = boneNames(g.scene);
    const clips = new Map<string, AnimationClip>();
    for (const c of g.animations) {
      const s = sanitizeClip(c, bones);
      if (s) clips.set(s.name, s);
    }
    return { template: g.scene, clips };
  });
  return monsterP;
}

export const DINER_MODELS = ['diner_a', 'diner_b', 'diner_c', 'diner_d'] as const;
export type CivModel = (typeof DINER_MODELS)[number] | 'guest_suit';

let civClipsP: Promise<Map<string, AnimationClip>> | null = null;
function loadCivClips(bones: Set<string>): Promise<Map<string, AnimationClip>> {
  civClipsP ??= loadGlb('civ_anims.glb').then((g) => {
    const out = new Map<string, AnimationClip>();
    for (const c of g?.animations ?? []) {
      const s = sanitizeClip(c, bones);
      if (s) out.set(s.name, s);
    }
    return out;
  });
  return civClipsP;
}

const civP = new Map<CivModel, Promise<CreatureAsset | null>>();
export function loadCivilian(model: CivModel): Promise<CreatureAsset | null> {
  let p = civP.get(model);
  if (!p) {
    p = loadGlb(`${model}.glb`).then(async (g) => {
      if (!g) return null;
      prepare(g.scene);
      const clips = await loadCivClips(boneNames(g.scene));
      return { template: g.scene, clips };
    });
    civP.set(model, p);
  }
  return p;
}

export function preloadCreatures(): void {
  void loadMonster();
  for (const m of DINER_MODELS) void loadCivilian(m);
  void loadCivilian('guest_suit');
}
