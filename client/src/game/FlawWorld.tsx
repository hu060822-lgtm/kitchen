import { useFrame } from '@react-three/fiber';
import { RAW_COLOR } from './itemColors';
import { ShelfFood } from './food/FoodMesh';
import { useMemo, useRef } from 'react';
import { Color, DoubleSide, MeshBasicMaterial, MeshStandardMaterial, Shape, type Group, type Mesh } from 'three';
import {
  CRAWL_GAP,
  LOW_DOOR_BOX,
  LOW_DOOR_HEIGHT,
  OPENINGS,
  STATION_BY_ID,
  WALL_HEIGHT,
  type FlawId,
  type KitchenPublic,
  type PlatePublic,
  type Seat,
  type StationDef,
} from '@last-table/shared';
import { useStore } from '../state/store';
import { remotes } from './remote';
import { C, hazardStripes, nameTexture, stationTag } from './textures';

/**
 * Phase B–D 在 3D 場景裡的東西：回收窗口的髒盤、裝盤區的乾淨碗盤、交接架、最上層的存貨、
 * 地上的東西、低門楣與窄縫的標示、冷藏室（幽閉外場看到的封閉標示）、安靜區、路線箭頭、召集光柱、
 * 隊友頭上的狀態（睡著、快掉了、快打噴嚏）、嗜睡學徒的雙爐。全部只是呈現伺服器的狀態。
 */

type V3 = [number, number, number];

const M = {
  porcelain: new MeshStandardMaterial({ color: '#E8E6DE', roughness: 0.4, flatShading: true }),
  dirty: new MeshStandardMaterial({ color: '#B8AD94', roughness: 0.8, flatShading: true }),
  iron: new MeshStandardMaterial({ color: '#2A2D2E', roughness: 0.8, metalness: 0.2, flatShading: true }),
  steel: new MeshStandardMaterial({ color: '#5B6263', roughness: 0.6, metalness: 0.3, flatShading: true }),
  wall: new MeshStandardMaterial({ color: '#4D5654', roughness: 0.95, flatShading: true }),
  dark: new MeshBasicMaterial({ color: '#0B0D0D' }),
  lamp: new MeshBasicMaterial({ color: '#E4D9A8' }),
  floorRing: new MeshBasicMaterial({ color: C.red, transparent: true, opacity: 0.55, depthWrite: false, side: DoubleSide }),
  route: new MeshBasicMaterial({ color: '#E8D27A', transparent: true, opacity: 0.85, depthWrite: false, side: DoubleSide }),
  rally: new MeshBasicMaterial({ color: '#F2C14E', transparent: true, opacity: 0.22, depthWrite: false }),
  linkRing: new MeshBasicMaterial({ color: '#7FB2C9', transparent: true, opacity: 0.7, depthWrite: false, side: DoubleSide }),
  takenRing: new MeshBasicMaterial({ color: '#C98F4E', transparent: true, opacity: 0.7, depthWrite: false, side: DoubleSide }),
};
const ITEM_COLOR: Record<string, string> = RAW_COLOR;
const matCache = new Map<string, MeshStandardMaterial>();
const matFor = (hex: string): MeshStandardMaterial => {
  let m = matCache.get(hex);
  if (!m) {
    m = new MeshStandardMaterial({ color: new Color(hex), roughness: 0.8, flatShading: true });
    matCache.set(hex, m);
  }
  return m;
};

function B({ p, s, m, r }: { p: V3; s: V3; m: MeshStandardMaterial | MeshBasicMaterial; r?: V3 }): JSX.Element {
  return (
    <mesh position={p} rotation={r} material={m}>
      <boxGeometry args={s} />
    </mesh>
  );
}

/** 工作站正面方向上的一點 */
function front(def: StationDef, along: number, depth: number, y: number): V3 {
  const [fx, fz] = [Math.sin(def.facing), Math.cos(def.facing)];
  return [def.pos[0] - fx * depth + fz * along, y, def.pos[1] - fz * depth - fx * along];
}

function Sign({ text, p, rot = 0, w = 0.9 }: { text: string; p: V3; rot?: number; w?: number }): JSX.Element {
  const tex = stationTag(text);
  return (
    <mesh position={p} rotation={[0, rot, 0]}>
      <planeGeometry args={[w, w / 4]} />
      <meshBasicMaterial map={tex} side={DoubleSide} />
    </mesh>
  );
}

function Stripes({ p, s, red = false, opacity = 1 }: { p: V3; s: V3; red?: boolean; opacity?: number }): JSX.Element {
  const mat = useMemo(() => {
    const t = hazardStripes(red).clone();
    t.repeat.set(Math.max(1, Math.max(s[0], s[2]) * 3), Math.max(1, s[1] * 3));
    t.needsUpdate = true;
    return new MeshBasicMaterial({ map: t, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side: DoubleSide });
    // 依尺寸的「值」快取（每次重繪傳進來的陣列都是新的）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [red, s.join(','), opacity]);
  return (
    <mesh position={p} material={mat}>
      <boxGeometry args={s} />
    </mesh>
  );
}

/* ------------------------------- 碗盤、交接架、最上層 ------------------------------- */

function DishStack({ n, at, dirty, bowl }: { n: number; at: V3; dirty: boolean; bowl: boolean }): JSX.Element | null {
  if (n <= 0) return null;
  const m = dirty ? M.dirty : M.porcelain;
  return (
    <group position={at}>
      {Array.from({ length: Math.min(n, 8) }, (_, i) => (
        <mesh key={i} position={[0, 0.012 + i * (bowl ? 0.05 : 0.022), 0]} material={m}>
          <cylinderGeometry args={bowl ? [0.1, 0.06, 0.05, 12] : [0.13, 0.12, 0.018, 14]} />
        </mesh>
      ))}
    </group>
  );
}

/** 一份原料的低多邊形模型（at＝大約的中心；模型的底部放在中心下面 3 公分） */
function ItemBlob({ type, at, scale = 1 }: { type: string; at: V3; scale?: number }): JSX.Element {
  return <ShelfFood type={type} at={[at[0], at[1] - 0.03 * scale, at[2]]} scale={scale} fit={0.13} />;
}

function PlateBlob({ p, at }: { p: PlatePublic; at: V3 }): JSX.Element {
  const bowl = p.vessel === 'bowl';
  return (
    <group position={at}>
      <mesh position={[0, bowl ? 0.045 : 0.008, 0]} material={M.porcelain}>
        <cylinderGeometry args={bowl ? [0.1, 0.06, 0.09, 12] : [0.14, 0.14, 0.016, 14]} />
      </mesh>
      {p.components.slice(0, 3).map((c, i) => (
        <ItemBlob key={i} type={c.type} at={[(i - 1) * 0.06, bowl ? 0.07 : 0.04, 0]} scale={0.7} />
      ))}
    </group>
  );
}

function ShelfMesh({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element {
  const s = k.stations[def.id];
  const alongX = Math.abs(Math.sin(def.facing)) < 0.5;
  const [w, d] = alongX ? [1.0, 0.5] : [0.5, 1.0];
  const goods = [...(s?.items ?? []).map((id) => ({ id, item: k.items[id] })), ...(s?.plates ?? []).map((id) => ({ id, plate: k.plates[id] }))];
  return (
    <group>
      <group position={[def.pos[0], 0, def.pos[1]]}>
        {[-1, 1].map((sx) => [-1, 1].map((sz) => <B key={`${sx}${sz}`} p={[(sx * (w - 0.05)) / 2, 0.75, (sz * (d - 0.05)) / 2]} s={[0.04, 1.5, 0.04]} m={M.iron} />))}
        {[0.12, 0.95, 1.48].map((y) => (
          <B key={y} p={[0, y, 0]} s={[w, 0.03, d]} m={M.steel} />
        ))}
        <Stripes p={[0, 0.97, 0]} s={[w + 0.01, 0.02, d + 0.01]} />
      </group>
      {goods.slice(0, 4).map((g, i) => {
        const at = front(def, (i - 1.5) * 0.22, 0.05, 0.98);
        if ('item' in g && g.item) return <ItemBlob key={g.id} type={g.item.type} at={[at[0], at[1] + 0.05, at[2]]} />;
        if ('plate' in g && g.plate) return <PlateBlob key={g.id} p={g.plate} at={at} />;
        return null;
      })}
      <Sign text={def.label} p={front(def, 0, -0.27, 1.32)} rot={def.facing} w={0.95} />
    </group>
  );
}

/** 成品架：中島上的兩層金屬架；肉類架是紅色邊條、另一個是綠色邊條（一眼分得出來） */
const RACK_TRIM = { rack_meat: new MeshStandardMaterial({ color: '#9C3B2E', roughness: 0.7, flatShading: true }), rack_veg: new MeshStandardMaterial({ color: '#4E7A3A', roughness: 0.7, flatShading: true }) };
function RackMesh({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element {
  const s = k.stations[def.id];
  const trim = RACK_TRIM[def.id as keyof typeof RACK_TRIM];
  const items = (s?.items ?? []).map((id) => k.items[id]).filter(Boolean);
  const base = 0.95;
  return (
    <group>
      {/* 兩層架：下層放 3 份、上層放 3 份 */}
      {[0, 0.26].map((h) => (
        <group key={h}>
          <B p={front(def, 0, 0.2, base + 0.03 + h)} s={[0.9, 0.02, 0.32]} m={M.steel} />
          <B p={front(def, 0, 0.04, base + 0.05 + h)} s={[0.9, 0.035, 0.02]} m={trim} />
        </group>
      ))}
      {[-0.44, 0.44].map((x) => (
        <B key={x} p={front(def, x, 0.2, base + 0.16)} s={[0.025, 0.32, 0.3]} m={M.iron} />
      ))}
      {items.slice(0, 6).map((it, i) => {
        const at = front(def, ((i % 3) - 1) * 0.27, 0.2, base + 0.09 + (i >= 3 ? 0.26 : 0));
        return <ItemBlob key={it!.id} type={it!.type} at={at} />;
      })}
      <Sign text={def.id === 'rack_meat' ? '成品・肉類' : '成品・蔬菜'} p={front(def, 0, 0.36, base + 0.62)} rot={def.facing} w={0.7} />
    </group>
  );
}

function DishReturn({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element {
  const d = k.stations[def.id]?.dirty ?? { plate: 0, bowl: 0 };
  return (
    <group>
      <DishStack n={d.plate} at={front(def, -0.2, 0.15, 1.05)} dirty bowl={false} />
      <DishStack n={d.bowl} at={front(def, 0.2, 0.15, 1.05)} dirty bowl />
      <Sign text="回收窗口" p={front(def, 0, 0.1, 1.55)} rot={def.facing} w={0.7} />
    </group>
  );
}

function CleanDishes({ k }: { k: KitchenPublic }): JSX.Element {
  const def = STATION_BY_ID.plating;
  const s = k.stations.plating;
  const rack = STATION_BY_ID.sink;
  const dirty = k.stations.sink?.dirty ?? { plate: 0, bowl: 0 };
  return (
    <group>
      <DishStack n={s?.dishes?.plate ?? 0} at={front(def, -1.55, 0.45, 0.95)} dirty={false} bowl={false} />
      <DishStack n={s?.dishes?.bowl ?? 0} at={front(def, 1.55, 0.45, 0.95)} dirty={false} bowl />
      <DishStack n={dirty.plate} at={front(rack, 0.55, 0.3, 0.95)} dirty bowl={false} />
      <DishStack n={dirty.bowl} at={front(rack, -0.55, 0.3, 0.95)} dirty bowl />
    </group>
  );
}

/** 冷藏架、乾貨架最上層的存貨（高 1.95 m） */
function HighStock({ k }: { k: KitchenPublic }): JSX.Element {
  const els: JSX.Element[] = [];
  for (const id of ['fridge', 'pantry']) {
    const def = STATION_BY_ID[id];
    const high = Object.entries(k.stations[id]?.high ?? {}).filter(([, n]) => (n ?? 0) > 0);
    // 放在最上層的層板上（冷藏架 2.15 m、乾貨架 1.95 m），種類多時縮小間距，全部擺在架子寬度裡
    const top = id === 'fridge' ? 2.15 : 1.95;
    const colW = Math.min(0.62, 4.1 / Math.max(1, high.length));
    const per = Math.max(1, Math.min(3, Math.floor(colW / 0.14)));
    high.forEach(([type, n], i) => {
      for (let j = 0; j < Math.min(per, n ?? 0); j++) {
        const at = front(def, -2.05 + i * colW + j * 0.14 + 0.07, 0.4, top + 0.07);
        els.push(<ItemBlob key={`${id}${type}${j}`} type={type} at={at} />);
      }
    });
    els.push(<Sign key={`${id}-sign`} text="最上層（踏凳）" p={front(def, 2.0, 0.05, 2.15)} rot={def.facing} w={0.6} />);
  }
  return <group>{els}</group>;
}

/* ------------------------------- 地上的東西 ------------------------------- */

/** 剛掉到地上的東西彈兩下才停（只在畫面上；位置是伺服器給的） */
function Bounce({ x, z, children }: { x: number; z: number; children: React.ReactNode }): JSX.Element {
  const ref = useRef<Group>(null);
  const born = useRef(performance.now());
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const t = (performance.now() - born.current) / 1000;
    if (t > 1.2) {
      g.position.y = 0;
      g.rotation.z = 0;
      return;
    }
    g.position.y = Math.abs(Math.sin(t * 11)) * 0.16 * Math.exp(-t * 4.5);
    g.rotation.z = Math.sin(t * 9) * 0.25 * Math.exp(-t * 3);
  });
  return (
    <group ref={ref} position={[x, 0, z]}>
      {children}
    </group>
  );
}

function FloorItems({ k }: { k: KitchenPublic }): JSX.Element {
  return (
    <group>
      {k.coop.floor.map((f) => (
        <Bounce key={f.id} x={f.x} z={f.z}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} material={M.floorRing}>
            <ringGeometry args={[0.18, 0.24, 20]} />
          </mesh>
          {f.kind === 'plate' ? (
            <mesh position={[0, 0.01, 0]} rotation={[0.2, 0, 0.15]} material={M.porcelain}>
              <cylinderGeometry args={[0.14, 0.14, 0.016, 14]} />
            </mesh>
          ) : (
            <ItemBlob type={f.type ?? 'egg'} at={[0, 0.05, 0]} />
          )}
          <sprite position={[0, 0.45, 0]} scale={[0.9, 0.19, 1]}>
            <spriteMaterial map={nameTexture(`地上：${f.what}`)} transparent depthWrite={false} />
          </sprite>
        </Bounce>
      ))}
    </group>
  );
}

/* ------------------------------- 地圖標示 ------------------------------- */

function MapMarks({ flaw }: { flaw: FlawId | null }): JSX.Element {
  const cold = OPENINGS.filter((o) => o.id === 'cold_door' || o.id === 'cold_hall');
  const dry = OPENINGS.find((o) => o.id === 'dry_door')!;
  const lw = LOW_DOOR_BOX.maxX - LOW_DOOR_BOX.minX;
  const lx = (LOW_DOOR_BOX.minX + LOW_DOOR_BOX.maxX) / 2;
  const lz = (LOW_DOOR_BOX.minZ + LOW_DOOR_BOX.maxZ) / 2;
  const gz = (CRAWL_GAP.minZ + CRAWL_GAP.maxZ) / 2;
  const gw = CRAWL_GAP.maxZ - CRAWL_GAP.minZ;
  return (
    <group>
      {/* 乾貨室前門的低門楣：所有人都看得到（1.75–2.6 m 之間補上牆面＋斜線） */}
      <B p={[lx, (LOW_DOOR_HEIGHT + 2.6) / 2, lz]} s={[lw, 2.6 - LOW_DOOR_HEIGHT, 0.3]} m={M.wall} />
      <Stripes p={[lx, LOW_DOOR_HEIGHT - 0.06, lz]} s={[lw, 0.12, 0.32]} />
      <Sign text="低門楣 1.75 m" p={[lx, LOW_DOOR_HEIGHT + 0.25, lz - 0.17]} rot={Math.PI} w={0.8} />
      {flaw === 'D07' && (
        <>
          <Stripes p={[lx, 0.9, lz]} s={[lw, 1.8, 0.04]} opacity={0.6} />
          <Sign text="你過不去：繞防火門" p={[lx, 1.25, lz - 0.1]} rot={Math.PI} w={1.0} />
        </>
      )}
      {/* 冷藏室 ↔ 乾貨室的窄縫：0.9 m 以上是牆；不是小矮人的話裡面有欄杆 */}
      <B p={[CRAWL_GAP.x, (CRAWL_GAP.height + WALL_HEIGHT) / 2, gz]} s={[0.3, WALL_HEIGHT - CRAWL_GAP.height, gw]} m={M.wall} />
      <Stripes p={[CRAWL_GAP.x, CRAWL_GAP.height + 0.05, gz]} s={[0.32, 0.1, gw]} />
      {flaw === 'D08' ? (
        <>
          <B p={[CRAWL_GAP.x, CRAWL_GAP.height + 0.2, gz]} s={[0.34, 0.06, 0.1]} m={M.lamp} />
          <Sign text="窄縫（你鑽得過）" p={[CRAWL_GAP.x - 0.17, 1.3, gz]} rot={-Math.PI / 2} w={0.8} />
          <Sign text="窄縫（你鑽得過）" p={[CRAWL_GAP.x + 0.17, 1.3, gz]} rot={Math.PI / 2} w={0.8} />
        </>
      ) : (
        <>
          {[-0.25, -0.08, 0.08, 0.25].map((dz) => (
            <B key={dz} p={[CRAWL_GAP.x, CRAWL_GAP.height / 2, gz + dz]} s={[0.04, CRAWL_GAP.height, 0.03]} m={M.iron} />
          ))}
          <Sign text="窄縫：只有小矮人" p={[CRAWL_GAP.x - 0.17, 1.3, gz]} rot={-Math.PI / 2} w={0.8} />
          <Sign text="窄縫：只有小矮人" p={[CRAWL_GAP.x + 0.17, 1.3, gz]} rot={Math.PI / 2} w={0.8} />
        </>
      )}
      {/* 安靜區（召集的干擾在這裡不算） */}
      <Sign text="安靜區・冷藏室" p={[cold[0].at[0], 2.75, cold[0].at[1] - 0.17]} rot={Math.PI} w={0.8} />
      <Sign text="安靜區・乾貨室" p={[dry.at[0], 2.75, dry.at[1] - 0.17]} rot={Math.PI} w={0.8} />
      {/* 幽閉外場：冷藏室是封閉空間 */}
      {flaw === 'D12' &&
        cold.map((o) => (
          <group key={o.id}>
            <Stripes p={[o.at[0], 1.2, o.at[1]]} s={o.along === 'x' ? [o.width, 2.4, 0.04] : [0.04, 2.4, o.width]} red opacity={0.45} />
            <Sign text="封閉空間：你進不去" p={o.along === 'x' ? [o.at[0], 1.6, o.at[1] - 0.06] : [o.at[0] + 0.06, 1.6, o.at[1]]} rot={o.along === 'x' ? Math.PI : Math.PI / 2} w={1.0} />
          </group>
        ))}
    </group>
  );
}

/* ------------------------------- 互助的標示 ------------------------------- */

function Routes({ k }: { k: KitchenPublic }): JSX.Element {
  return (
    <group>
      {k.coop.routes.map((r) => (
        <group key={r.id} position={[r.x, 0.015, r.z]} rotation={[0, r.yaw + Math.PI, 0]}>
          {[0, 0.35].map((dz) => (
            <mesh key={dz} position={[0, 0, dz - 0.15]} rotation={[-Math.PI / 2, 0, 0]} material={M.route}>
              <shapeGeometry args={[chevron]} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}
const chevron = (() => {
  const s = new Shape();
  s.moveTo(-0.3, -0.1);
  s.lineTo(0, 0.2);
  s.lineTo(0.3, -0.1);
  s.lineTo(0.3, -0.25);
  s.lineTo(0, 0.05);
  s.lineTo(-0.3, -0.25);
  s.closePath();
  return s;
})();

function Rallies({ k }: { k: KitchenPublic }): JSX.Element {
  const ref = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.children.forEach((c) => ((c as Mesh).scale.y = 1 + Math.sin(clock.elapsedTime * 4) * 0.08));
  });
  return (
    <group ref={ref}>
      {k.coop.rallies.map((r) => (
        <mesh key={r.id} position={[r.x, 1.6, r.z]} material={M.rally}>
          <cylinderGeometry args={[0.35, 0.35, 3.2, 16, 1, true]} />
        </mesh>
      ))}
    </group>
  );
}

/** 隊友頭上的狀態：睡著、快睡著、手上東西快掉了、快打噴嚏 */
function StatusSprites({ k, me }: { k: KitchenPublic; me: Seat | null }): JSX.Element {
  const ref = useRef<Group>(null);
  const tags: Array<{ seat: Seat; text: string }> = [];
  for (const d of k.coop.drowsy) if (d.seat !== me) tags.push({ seat: d.seat, text: d.state === 'asleep' ? '💤 睡著了' : '😪 快睡著' });
  for (const w of k.coop.wobbles) if (w.seat !== me) tags.push({ seat: w.seat, text: '⚠ 快掉了！F 接住' });
  for (const s of k.coop.sneezes) if (s.seat !== me) tags.push({ seat: s.seat, text: '👃 快打噴嚏' });
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    g.children.forEach((c, i) => {
      const t = tags[i];
      const rp = t ? remotes[t.seat] : undefined;
      c.visible = !!rp;
      if (rp) c.position.set(rp.x, 2.35 + (tags.slice(0, i).filter((x) => x.seat === t!.seat).length * 0.24), rp.z);
    });
  });
  return (
    <group ref={ref}>
      {tags.map((t, i) => (
        <sprite key={`${t.seat}${t.text}${i}`} scale={[0.95, 0.2, 1]}>
          <spriteMaterial map={nameTexture(t.text)} transparent depthWrite={false} depthTest={false} />
        </sprite>
      ))}
    </group>
  );
}

/** 嗜睡學徒的雙爐（他自己看得到）與被接管的爐子（所有人看得到） */
function DualRings({ k, me }: { k: KitchenPublic; me: Seat | null }): JSX.Element {
  return (
    <group>
      {k.coop.links.map((l) => {
        const def = STATION_BY_ID[l.stationId];
        if (!def || (l.seat !== me && !l.takenBy)) return null;
        const at = front(def, 0, -0.55, 0.012);
        return (
          <mesh key={`${l.seat}${l.stationId}`} position={at} rotation={[-Math.PI / 2, 0, 0]} material={l.takenBy ? M.takenRing : M.linkRing}>
            <ringGeometry args={[0.32, 0.4, 24]} />
          </mesh>
        );
      })}
    </group>
  );
}

export function FlawWorld(): JSX.Element | null {
  const k = useStore((s) => s.kitchen);
  const me = useStore((s) => s.me?.role ?? null);
  const flaw = k?.self?.flaw ?? null;
  if (!k) return null;
  return (
    <group>
      <MapMarks flaw={flaw} />
      <ShelfMesh def={STATION_BY_ID.shelf_cold} k={k} />
      <ShelfMesh def={STATION_BY_ID.shelf_line} k={k} />
      <RackMesh def={STATION_BY_ID.rack_veg} k={k} />
      <RackMesh def={STATION_BY_ID.rack_meat} k={k} />
      <DishReturn def={STATION_BY_ID.dish_return} k={k} />
      <CleanDishes k={k} />
      <HighStock k={k} />
      <FloorItems k={k} />
      <Routes k={k} />
      <Rallies k={k} />
      <StatusSprites k={k} me={me} />
      <DualRings k={k} me={me} />
    </group>
  );
}
