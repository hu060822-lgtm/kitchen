import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { RAW_COLOR } from './itemColors';
import { BROWN, ItemMesh, ShelfFood } from './food/FoodMesh';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BoxGeometry,
  Color,
  EdgesGeometry,
  FogExp2,
  LineBasicMaterial,
  MathUtils,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  type Group,
  type LineSegments,
  type Mesh,
  type PerspectiveCamera,
  type PointLight,
  type Texture,
} from 'three';
import {
  FIRE_DOOR_BOX,
  FIXED_PROPS,
  INGREDIENTS,
  OPENINGS,
  SEATS,
  STATIONS,
  STATION_BY_ID,
  NOTE_TEXT,
  TOKEN_LABEL,
  TUTORIAL_STEP_BY_ID,
  WALL_BOXES,
  WALL_HEIGHT,
  ZONES,
  maxBrown,
  zoneAt,
  type Box,
  type ItemPublic,
  type KitchenPublic,
  type PlatePublic,
  type SignalToken,
  type Seat,
  type StationDef,
  type ZoneId,
  type IngredientId,
} from '@last-table/shared';
import { useStore } from '../state/store';
import { on } from './bus';
import { ABDUCT_PHASE, abduct, abductElapsed } from './abduct';
import { currentTarget, pose, slideRoll } from './controller';
import { CrewAvatar } from './characters/CrewAvatar';
import { MonsterRig, type MonsterMode } from './MonsterRig';
import { CivilianBody, Diners, nearestChair } from './Diners';
import { FlawWorld } from './FlawWorld';
import { PhysicsWorld } from './PhysicsWorld';
import { orderDish } from '../ui/kitchenText';
import {
  C,
  brushedSteel,
  ceilingTile,
  contactShadow,
  crtScreen,
  diningWall,
  floorTile,
  kitchenWall,
  nameTexture,
  quarryTile,
  stationTag,
  ticketPaper,
  wallPanel,
  woodFloor,
} from './textures';

/** 固定的空陣列（zustand 的 selector 不能每次回傳新陣列，否則會無限重繪） */
const NONE: never[] = [];

/*
 * 美術方向：深夜還沒關的小餐館 × PS1 低多邊形恐怖。
 *  - 廚房是唯一明亮的地方：白磁磚、不鏽鋼、紅褐色防滑磚。出餐口的保溫燈是整個場景唯一的暖橘色。
 *  - 餐廳昏暗：墨綠護牆、深色木地板、每張桌子上方一盞低垂的燈。最遠那張桌子的燈永遠是暗的。
 *  - 後場（冷藏室、乾貨室、走廊）幾乎沒有光：一顆燈泡，看得到輪廓，看不到細節。
 *  - 食材的顏色就是資訊：看得見的人從顏色判斷熟度與上色（同一套伺服器狀態，只是呈現）。
 *  - 威脅只改變「看到什麼」：怪物靠近時燈光不穩；客人只在沒人看的時候移動，所以畫面上他是一格一格地「出現」在新位置。
 */

/* ------------------------------- 共用材質 ------------------------------- */

const M = {
  steel: new MeshStandardMaterial({ color: '#A7AEAE', roughness: 0.55, metalness: 0.35, flatShading: true }),
  steelDark: new MeshStandardMaterial({ color: '#5B6263', roughness: 0.6, metalness: 0.3, flatShading: true }),
  iron: new MeshStandardMaterial({ color: '#2A2D2E', roughness: 0.8, metalness: 0.2, flatShading: true }),
  ink: new MeshStandardMaterial({ color: C.ink, roughness: 0.95, metalness: 0, flatShading: true }),
  wood: new MeshStandardMaterial({ color: '#4A3326', roughness: 0.85, metalness: 0, flatShading: true }),
  woodLight: new MeshStandardMaterial({ color: '#8C6A48', roughness: 0.8, metalness: 0, flatShading: true }),
  cloth: new MeshStandardMaterial({ color: '#C9C5B8', roughness: 0.95, metalness: 0, flatShading: true }),
  board: new MeshStandardMaterial({ color: '#B49A72', roughness: 0.9, metalness: 0, flatShading: true }),
  porcelain: new MeshStandardMaterial({ color: '#E8E6DE', roughness: 0.4, metalness: 0, flatShading: true }),
  plastic: new MeshStandardMaterial({ color: '#3E4A44', roughness: 0.85, metalness: 0, flatShading: true }),
  crate: new MeshStandardMaterial({ color: '#8A7553', roughness: 0.95, metalness: 0, flatShading: true }),
  carton: new MeshStandardMaterial({ color: '#B8A27A', roughness: 0.95, metalness: 0, flatShading: true }),
  locker: new MeshStandardMaterial({ color: '#56636A', roughness: 0.7, metalness: 0.2, flatShading: true }),
  suit: new MeshStandardMaterial({ color: '#15171A', roughness: 0.9, metalness: 0, flatShading: true }),
  skin: new MeshStandardMaterial({ color: '#BDB6A6', roughness: 0.9, metalness: 0, flatShading: true }),
  shirt: new MeshStandardMaterial({ color: '#D8D4C8', roughness: 0.9, metalness: 0, flatShading: true }),
  lampWarm: new MeshBasicMaterial({ color: '#F2B260' }),
  lampHeat: new MeshBasicMaterial({ color: '#FF8A3A' }),
  tube: new MeshBasicMaterial({ color: '#E4ECEE' }),
  bulbOff: new MeshBasicMaterial({ color: '#2A2B28' }),
};
const lineHot = new LineBasicMaterial({ color: '#F1EFE7' });
const lineNo = new LineBasicMaterial({ color: C.red });

type V3 = [number, number, number];

function B({ p, s, m, r }: { p: V3; s: V3; m: MeshStandardMaterial | MeshBasicMaterial; r?: V3 }): JSX.Element {
  return (
    <mesh position={p} rotation={r} material={m}>
      <boxGeometry args={s} />
    </mesh>
  );
}
function Cyl({ p, r, h, m, rot, seg = 12, r2 }: { p: V3; r: number; h: number; m: MeshStandardMaterial | MeshBasicMaterial; rot?: V3; seg?: number; r2?: number }): JSX.Element {
  return (
    <mesh position={p} rotation={rot} material={m}>
      <cylinderGeometry args={[r, r2 ?? r, h, seg]} />
    </mesh>
  );
}

function useRepeat(tex: Texture, rx: number, ry: number): Texture {
  return useMemo(() => {
    const t = tex.clone();
    t.repeat.set(Math.max(0.25, rx), Math.max(0.25, ry));
    t.needsUpdate = true;
    return t;
  }, [tex, rx, ry]);
}

const wallTexFor = (z: ZoneId | null): Texture => (z === 'DINING' ? diningWall() : z === 'KITCHEN' ? kitchenWall() : wallPanel());
const zoneIdAt = (x: number, z: number): ZoneId | null => zoneAt(Math.max(-8.95, Math.min(8.95, x)), Math.max(0.05, Math.min(26.95, z)))?.id ?? null;

/* ------------------------------- 建築 ------------------------------- */

function ZoneShell({ id }: { id: ZoneId }): JSX.Element {
  const z = ZONES.find((q) => q.id === id)!;
  const w = z.maxX - z.minX;
  const d = z.maxZ - z.minZ;
  const cx = (z.minX + z.maxX) / 2;
  const cz = (z.minZ + z.maxZ) / 2;
  const base = id === 'KITCHEN' ? quarryTile() : id === 'DINING' ? woodFloor() : floorTile();
  const floor = useRepeat(base, (w + 0.6) / 1.2, (d + 0.6) / 1.2);
  const ceil = useRepeat(ceilingTile(), (w + 0.6) / 1.2, (d + 0.6) / 1.2);
  return (
    <group>
      <mesh position={[cx, 0, cz]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w + 0.6, d + 0.6]} />
        <meshStandardMaterial map={floor} roughness={id === 'KITCHEN' ? 0.6 : 0.9} metalness={0} />
      </mesh>
      <mesh position={[cx, WALL_HEIGHT, cz]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w + 0.6, d + 0.6]} />
        <meshStandardMaterial map={ceil} roughness={0.95} />
      </mesh>
    </group>
  );
}

/** 一段牆：依它面對的區域換貼圖（廚房磁磚、餐廳護牆、後場水泥板） */
function WallPiece({ b, face }: { b: Box; face: ZoneId | null }): JSX.Element {
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const h = b.height ?? WALL_HEIGHT;
  const tex = useRepeat(wallTexFor(face), Math.max(w, d) / 1.2, 1);
  return (
    <mesh position={[(b.minX + b.maxX) / 2, h / 2, (b.minZ + b.maxZ) / 2]}>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial map={tex} roughness={0.8} metalness={0} />
    </mesh>
  );
}

/** 另一面不同區域時，在那一面貼一層薄板 */
function WallFace({ b, side, face }: { b: Box; side: -1 | 1; face: ZoneId }): JSX.Element {
  const w = b.maxX - b.minX;
  const tex = useRepeat(wallTexFor(face), w / 1.2, 1);
  const z = side < 0 ? b.minZ - 0.004 : b.maxZ + 0.004;
  return (
    <mesh position={[(b.minX + b.maxX) / 2, WALL_HEIGHT / 2, z]} rotation={[0, side < 0 ? Math.PI : 0, 0]}>
      <planeGeometry args={[w, WALL_HEIGHT]} />
      <meshStandardMaterial map={tex} roughness={0.8} />
    </mesh>
  );
}

const Z_CUTS = [9.15, 19.15];

function Walls(): JSX.Element {
  const pieces = useMemo(() => {
    const out: JSX.Element[] = [];
    for (const b of WALL_BOXES) {
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      if (d > w) {
        // 直向的牆：在區域交界切段
        const cuts = [b.minZ, ...Z_CUTS.filter((c) => c > b.minZ + 0.01 && c < b.maxZ - 0.01), b.maxZ];
        for (let i = 0; i < cuts.length - 1; i++) {
          const seg: Box = { ...b, id: `${b.id}_${i}`, minZ: cuts[i], maxZ: cuts[i + 1] };
          const cx = (b.minX + b.maxX) / 2;
          const inward = cx < 0 ? cx + 0.6 : cx - 0.6;
          out.push(<WallPiece key={seg.id} b={seg} face={zoneIdAt(inward, (cuts[i] + cuts[i + 1]) / 2)} />);
        }
      } else {
        const cx = (b.minX + b.maxX) / 2;
        const south = b.minZ > 0 ? zoneIdAt(cx, b.minZ - 0.3) : null;
        const north = b.maxZ < 27 ? zoneIdAt(cx, b.maxZ + 0.3) : null;
        const main = south ?? north;
        out.push(<WallPiece key={b.id} b={b} face={main} />);
        if (north && north !== main) out.push(<WallFace key={`${b.id}_n`} b={b} side={1} face={north} />);
      }
    }
    return out;
  }, []);
  return <group>{pieces}</group>;
}

/** 門洞上方的楣樑，以及出餐窗口的上緣 */
function Lintels(): JSX.Element {
  return (
    <group>
      {OPENINGS.filter((o) => o.id !== 'hall_turn').map((o) => {
        const h = WALL_HEIGHT - 2.6;
        const size: V3 = o.along === 'x' ? [o.width, h, 0.3] : [0.3, h, o.width];
        const face = zoneIdAt(o.at[0], o.at[1] - 0.4);
        return <WallPiece key={o.id} b={{ id: o.id, kind: 'wall', minX: o.at[0] - size[0] / 2, maxX: o.at[0] + size[0] / 2, minZ: o.at[1] - size[2] / 2, maxZ: o.at[1] + size[2] / 2, height: undefined }} face={face} />;
      }).map((el, i) => (
        <group key={i} position={[0, 2.6, 0]} scale={[1, (WALL_HEIGHT - 2.6) / WALL_HEIGHT, 1]}>
          {el}
        </group>
      ))}
      {/* 出餐窗口：上緣 2.1 m 以上是牆 */}
      <group position={[0, 2.1, 0]} scale={[1, (WALL_HEIGHT - 2.1) / WALL_HEIGHT, 1]}>
        <WallPiece b={{ id: 'pass_header', kind: 'wall', minX: -3, maxX: 1, minZ: 9, maxZ: 9.3 }} face="DINING" />
      </group>
    </group>
  );
}

/** 防火門：關上時從上方落下（只有失語員能從監視器關，15 秒後自動打開） */
function FireDoor(): JSX.Element {
  const open = useStore((s) => s.kitchen?.doors.fire ?? true);
  const ref = useRef<Group>(null);
  const y = useRef(open ? 2.55 : 1.3);
  const b = FIRE_DOOR_BOX;
  const w = b.maxX - b.minX;
  useFrame((_, dt) => {
    y.current = MathUtils.damp(y.current, open ? 2.55 + 1.25 : 1.3, open ? 2 : 9, dt);
    if (ref.current) ref.current.position.y = y.current;
  });
  return (
    <group position={[(b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2]}>
      <group ref={ref}>
        <B p={[0, 0, 0]} s={[w, 2.6, 0.12]} m={M.steelDark} />
        {[-0.8, -0.2, 0.4, 1.0].map((yy) => (
          <B key={yy} p={[0, yy, -0.07]} s={[w, 0.05, 0.02]} m={M.iron} />
        ))}
        <B p={[0, -1.15, -0.07]} s={[w, 0.18, 0.03]} m={new MeshStandardMaterial({ color: '#8E3A2A', roughness: 0.8 })} />
      </group>
    </group>
  );
}

/** 旋轉門：兩片半高的門板（純外觀，不擋路） */
function SwingDoors(): JSX.Element {
  const o = OPENINGS.find((x) => x.id === 'swing')!;
  return (
    <group position={[o.at[0], 0, o.at[1]]}>
      {[-1, 1].map((s) => (
        <group key={s} position={[(s * o.width) / 2, 0, 0]} rotation={[0, s * 0.9, 0]}>
          <B p={[(-s * o.width) / 4, 1.1, 0]} s={[o.width / 2 - 0.04, 1.1, 0.04]} m={M.steel} />
          <B p={[(-s * o.width) / 4, 1.3, -0.025]} s={[0.24, 0.18, 0.01]} m={M.ink} />
        </group>
      ))}
    </group>
  );
}

/* ------------------------------- 家具 ------------------------------- */

function Counter({ b, top = M.steel }: { b: Box; top?: MeshStandardMaterial }): JSX.Element {
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const h = b.height ?? 0.95;
  const tex = useRepeat(brushedSteel(), w / 1.2, d / 1.2);
  const mat = useMemo(() => new MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.35, flatShading: true }), [tex]);
  return (
    <group position={[(b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2]}>
      <B p={[0, (h - 0.05) / 2, 0]} s={[w - 0.04, h - 0.05, d - 0.04]} m={M.steelDark} />
      <mesh position={[0, h - 0.025, 0]} material={top === M.steel ? mat : top}>
        <boxGeometry args={[w, 0.05, d]} />
      </mesh>
      <B p={[0, 0.05, 0]} s={[w - 0.1, 0.1, d - 0.1]} m={M.ink} />
    </group>
  );
}

function Shelf({ b }: { b: Box }): JSX.Element {
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const h = b.height ?? 2;
  return (
    <group position={[(b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2]}>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => <B key={`${sx}${sz}`} p={[(sx * (w - 0.05)) / 2, h / 2, (sz * (d - 0.05)) / 2]} s={[0.04, h, 0.04]} m={M.iron} />),
      )}
      {[0.15, 0.75, 1.35, h - 0.05].map((y) => (
        <B key={y} p={[0, y, 0]} s={[w, 0.03, d]} m={M.steelDark} />
      ))}
    </group>
  );
}

function Cage({ b }: { b: Box }): JSX.Element {
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const h = b.height ?? 2.2;
  const bars: JSX.Element[] = [];
  for (let i = 0; i <= 9; i++) bars.push(<B key={`z${i}`} p={[w / 2, h / 2, -d / 2 + (d * i) / 9]} s={[0.025, h, 0.025]} m={M.iron} />);
  for (let i = 0; i <= 6; i++) bars.push(<B key={`x${i}`} p={[-w / 2 + (w * i) / 6, h / 2, d / 2]} s={[0.025, h, 0.025]} m={M.iron} />);
  for (let i = 0; i <= 6; i++) bars.push(<B key={`x2${i}`} p={[-w / 2 + (w * i) / 6, h / 2, -d / 2]} s={[0.025, h, 0.025]} m={M.iron} />);
  return (
    <group position={[(b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2]}>
      {bars}
      <B p={[0, h, 0]} s={[w, 0.04, d]} m={M.iron} />
      <B p={[0, 0.02, 0]} s={[w, 0.04, d]} m={M.iron} />
      <B p={[w / 2, 1.1, 0]} s={[0.08, 0.16, 0.12]} m={M.steelDark} />
    </group>
  );
}

function Table({ b, dark }: { b: Box; dark: boolean }): JSX.Element {
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  return (
    <group position={[cx, 0, cz]}>
      <B p={[0, 0.74, 0]} s={[w, 0.04, d]} m={M.cloth} />
      <B p={[0, 0.6, 0]} s={[w - 0.04, 0.26, d - 0.04]} m={M.cloth} />
      <Cyl p={[0, 0.3, 0]} r={0.05} h={0.6} m={M.iron} />
      {[-1, 1].map((s) => (
        <group key={s} position={[0, 0, s * (d / 2 + 0.32)]}>
          <B p={[0, 0.45, 0]} s={[0.42, 0.04, 0.4]} m={M.wood} />
          <B p={[0, 0.85, s * 0.19]} s={[0.42, 0.75, 0.04]} m={M.wood} />
          {[-1, 1].map((a) => (
            <B key={a} p={[a * 0.18, 0.22, 0]} s={[0.03, 0.44, 0.36]} m={M.iron} />
          ))}
        </group>
      ))}
      {/* 低垂的吊燈：最遠那一張永遠不亮 */}
      <Cyl p={[0, 2.35, 0]} r={0.01} h={1.7} m={M.iron} />
      <Cyl p={[0, 1.42, 0]} r={0.06} r2={0.22} h={0.18} m={M.iron} seg={10} />
      <mesh position={[0, 1.32, 0]} material={dark ? M.bulbOff : M.lampWarm}>
        <sphereGeometry args={[0.05, 8, 6]} />
      </mesh>
    </group>
  );
}

function DoorSlab({ b }: { b: Box }): JSX.Element {
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const h = b.height ?? 2.4;
  return (
    <group position={[(b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2]}>
      <B p={[0, h / 2, 0]} s={[w, h, d]} m={b.id === 'backdoor' ? M.steelDark : M.wood} />
      <B p={[0, h + 0.15, 0]} s={[w + 0.3, 0.3, d + 0.02]} m={M.ink} />
    </group>
  );
}

function Props(): JSX.Element {
  return (
    <group>
      {FIXED_PROPS.map((b) => {
        if (b.id.startsWith('table_')) return <Table key={b.id} b={b} dark={b.id === 'table_0_0'} />;
        if (b.id === 'fridge_shelf' || b.id === 'pantry_shelf') return <Shelf key={b.id} b={b} />;
        if (b.id === 'cage') return <Cage key={b.id} b={b} />;
        if (b.kind === 'door') return <DoorSlab key={b.id} b={b} />;
        return <Counter key={b.id} b={b} />;
      })}
    </group>
  );
}

/* ------------------------------- 燈 ------------------------------- */

const KITCHEN_LIGHTS: V3[] = [
  [-5.5, 3.05, 12.5],
  [0, 3.05, 12.5],
  [5.5, 3.05, 12.5],
  [-3, 3.05, 17],
  [3, 3.05, 17],
];
const DINING_LIGHTS: V3[] = [
  [-6, 1.3, 2.2],
  [-6, 1.3, 6.2],
  [-1.5, 1.3, 2.2],
  [-1.5, 1.3, 6.2],
  [3, 1.3, 6.2],
];
const BACK_LIGHTS: Array<{ p: V3; c: string; i: number }> = [
  { p: [-6, 2.9, 23], c: '#9DB2C0', i: 2.2 },
  { p: [2, 2.9, 21.5], c: '#C7A77A', i: 2 },
  { p: [4.5, 2.9, 25.8], c: '#A9A08A', i: 1.4 },
];

/** 怪物在附近時，燈光會不穩（感知上的壓迫；不影響任何規則） */
function monsterDistance(): number {
  const m = useStore.getState().kitchen?.threats.monster;
  if (!m?.present) return Infinity;
  return Math.hypot(m.x - pose.x, m.z - pose.z);
}

function Lights(): JSX.Element {
  const kitchen = useRef<Array<PointLight | null>>([]);
  const back = useRef<Array<PointLight | null>>([]);
  const dip = useRef(0);
  useEffect(() => on('fx', (f) => {
    if (f.visual === 'flicker') dip.current = 0.9;
  }), []);
  useFrame(({ clock }, dt) => {
    dip.current = Math.max(0, dip.current - dt);
    const d = monsterDistance();
    const near = d < 9 ? 1 - d / 9 : 0;
    const t = clock.elapsedTime;
    // 不規則的閃爍：兩個不同頻率的方波疊加，越近越頻繁
    const flick = near > 0 && Math.sin(t * 23) * Math.sin(t * 7.3) > 1 - near * 0.9 ? 0.15 : 1;
    const dipK = dip.current > 0 && Math.sin(t * 40) > 0 ? 0.2 : 1;
    kitchen.current.forEach((l, i) => {
      if (l) l.intensity = 9 * flick * dipK * (i === 1 && near > 0.5 ? 0.6 : 1);
    });
    back.current.forEach((l, i) => {
      if (l) l.intensity = BACK_LIGHTS[i].i * (near > 0 && Math.sin(t * 17 + i) > 0.3 ? 0.1 : 1) * dipK;
    });
    M.tube.color.set(flick < 1 || dipK < 1 ? '#3A3F40' : '#E4ECEE');
  });
  return (
    <group>
      {KITCHEN_LIGHTS.map((p, i) => (
        <group key={i}>
          <pointLight ref={(el) => (kitchen.current[i] = el)} position={[p[0], p[1] - 0.2, p[2]]} color="#E6EEF0" intensity={9} distance={11} decay={1.4} />
          <B p={p} s={[1.4, 0.05, 0.18]} m={M.tube} />
          <B p={[p[0], p[1] + 0.06, p[2]]} s={[1.5, 0.06, 0.3]} m={M.ink} />
        </group>
      ))}
      {DINING_LIGHTS.map((p, i) => (
        <pointLight key={i} position={p} color="#E9A866" intensity={2.4} distance={5.5} decay={1.6} />
      ))}
      {BACK_LIGHTS.map((l, i) => (
        <group key={i}>
          <pointLight ref={(el) => (back.current[i] = el)} position={l.p} color={l.c} intensity={l.i} distance={7} decay={1.7} />
          <mesh position={[l.p[0], l.p[1] + 0.12, l.p[2]]} material={M.lampWarm}>
            <sphereGeometry args={[0.05, 8, 6]} />
          </mesh>
        </group>
      ))}
      {/* 出餐口的保溫燈 */}
      <pointLight position={[-1, 1.85, 9.25]} color="#FF8C3E" intensity={2.2} distance={3} decay={1.8} />
    </group>
  );
}

/* ------------------------------- 食材 ------------------------------- */

const matCache = new Map<string, MeshStandardMaterial>();
function matFor(c: Color): MeshStandardMaterial {
  const key = c.getHexString();
  let m = matCache.get(key);
  if (!m) {
    m = new MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0, flatShading: true });
    matCache.set(key, m);
  }
  return m;
}

/** 工作站上的食材擺放位置（檯面內側，沿著工作站的橫向排開） */
function slotPos(def: StationDef, i: number, n: number, y: number, depth = 0.35, spread = 0.18): V3 {
  const [fx, fz] = [Math.sin(def.facing), Math.cos(def.facing)];
  const off = (i - (n - 1) / 2) * spread;
  return [def.pos[0] - fx * depth + fz * off, y, def.pos[1] - fz * depth - fx * off];
}

/* ------------------------------- 工作站 ------------------------------- */

const HEAT_GLOW: Record<string, string> = { OFF: '#1B1C1C', LOW: '#5A2410', MED: '#A23A12', HIGH: '#F0561C' };

function Burner({ level }: { level: string }): JSX.Element {
  const mat = useMemo(() => new MeshBasicMaterial({ color: HEAT_GLOW.OFF }), []);
  useEffect(() => {
    mat.color.set(HEAT_GLOW[level] ?? HEAT_GLOW.OFF);
  }, [level, mat]);
  return (
    <group>
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={mat}>
        <ringGeometry args={[0.08, 0.15, 16]} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <B key={i} p={[0, 0.02, 0]} s={[0.4, 0.02, 0.025]} m={M.iron} r={[0, (i * Math.PI) / 4, 0]} />
      ))}
    </group>
  );
}

/** 煙與蒸氣：看得見的人的提示（快焦時冒黑煙、湯滾時冒白氣） */
function Plume({ at, kind }: { at: V3; kind: 'steam' | 'smoke' }): JSX.Element {
  const refs = useRef<Array<Mesh | null>>([]);
  const mat = useMemo(() => new MeshBasicMaterial({ color: kind === 'smoke' ? '#2A2622' : '#E8ECEC', transparent: true, opacity: 0.35, depthWrite: false }), [kind]);
  useFrame(({ clock }) => {
    refs.current.forEach((m, i) => {
      if (!m) return;
      const t = (clock.elapsedTime * 0.45 + i / 6) % 1;
      m.position.set(Math.sin(i * 2.1 + t * 3) * 0.06, t * 0.9, Math.cos(i * 1.7 + t * 2) * 0.06);
      m.scale.setScalar(0.5 + t * 1.6);
    });
    mat.opacity = kind === 'smoke' ? 0.55 : 0.28;
  });
  return (
    <group position={at}>
      {Array.from({ length: 6 }, (_, i) => (
        <mesh key={i} ref={(el) => (refs.current[i] = el)} material={mat}>
          <sphereGeometry args={[0.06, 6, 4]} />
        </mesh>
      ))}
    </group>
  );
}

function HeatStation({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element {
  const s = k.stations[def.id];
  const isPot = def.kind === 'stove';
  const items = (s?.items ?? []).map((id) => k.items[id]).filter(Boolean);
  const [cx, , cz] = slotPos(def, 0, 1, 0.95, 0.42);
  const liquid = (s?.liquid ?? 0) > 0;
  const v = s?.vessel ?? 22;
  const smoking = items.some((it) => maxBrown(it) >= 1.45) || (s?.scorch ?? 0) > 0.6;
  const liquidColor = useMemo(() => {
    const c = new Color(RAW_COLOR.stock);
    const onions = items.filter((it) => it.type === 'onion');
    if (onions.length) c.lerp(BROWN, Math.min(0.7, onions.reduce((a, it) => a + maxBrown(it), 0) / onions.length / 2));
    return c;
  }, [items]);
  return (
    <group>
      <group position={[cx, 0.95, cz]}>
        <Burner level={s?.heat ?? 'OFF'} />
        {isPot ? (
          <group>
            <Cyl p={[0, 0.14, 0]} r={0.2} h={0.24} m={M.steel} seg={16} />
            <Cyl p={[0, 0.03, 0]} r={0.19} h={0.02} m={M.iron} seg={16} />
            {liquid && <Cyl p={[0, 0.03 + Math.min(0.2, (s!.liquid ?? 0) * 0.05), 0]} r={0.185} h={0.01} m={matFor(liquidColor)} seg={16} />}
            {[-1, 1].map((sx) => (
              <B key={sx} p={[sx * 0.23, 0.22, 0]} s={[0.06, 0.02, 0.04]} m={M.iron} />
            ))}
            {items
              .filter((it) => !INGREDIENTS[it.type].liquid)
              .map((it, i, arr) => (
                <ItemMesh key={it.id} it={it} at={[(i - (arr.length - 1) / 2) * 0.05, 0.04 + (liquid ? Math.min(0.2, (s!.liquid ?? 0) * 0.05) : 0), (i % 2) * 0.04]} />
              ))}
          </group>
        ) : (
          <group>
            <Cyl p={[0, 0.03, 0]} r={0.2} h={0.03} m={M.iron} seg={16} />
            <B p={[0, 0.045, 0.32]} s={[0.04, 0.025, 0.26]} m={M.ink} />
            {items.map((it, i) => (
              <ItemMesh key={it.id} it={it} at={[(i - (items.length - 1) / 2) * 0.12, 0.046, 0]} />
            ))}
          </group>
        )}
        {smoking && <Plume at={[0, 0.25, 0]} kind="smoke" />}
        {isPot && liquid && v >= 95 && <Plume at={[0, 0.3, 0]} kind="steam" />}
      </group>
      <Knob def={def} level={s?.heat ?? 'OFF'} />
    </group>
  );
}

/** 爐台正面的火力旋鈕（看得見的人一眼就能看出火力） */
function Knob({ def, level }: { def: StationDef; level: string }): JSX.Element {
  const ang = { OFF: 0, LOW: -0.9, MED: -1.8, HIGH: -2.7 }[level] ?? 0;
  const [x, , z] = slotPos(def, 0, 1, 0, -0.03);
  return (
    <group position={[x, 0.72, z]} rotation={[0, def.facing, 0]}>
      <Cyl p={[0, 0, 0]} r={0.045} h={0.04} m={M.ink} rot={[Math.PI / 2, 0, 0]} />
      <B p={[0, 0, 0.022]} s={[0.012, 0.07, 0.01]} m={M.porcelain} r={[0, 0, ang]} />
    </group>
  );
}

function Toaster({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element {
  const s = k.stations[def.id];
  const items = (s?.items ?? []).map((id) => k.items[id]).filter(Boolean);
  const down = !!s?.toast;
  const [x, , z] = slotPos(def, 0, 1, 0.95, 0.4);
  return (
    <group position={[x, 0.95, z]} rotation={[0, def.facing, 0]}>
      <B p={[0, 0.11, 0]} s={[0.32, 0.22, 0.2]} m={M.steel} />
      <B p={[0, 0.221, -0.04]} s={[0.24, 0.01, 0.03]} m={M.ink} />
      <B p={[0, 0.221, 0.04]} s={[0.24, 0.01, 0.03]} m={M.ink} />
      <B p={[0.17, down ? 0.06 : 0.17, 0]} s={[0.03, 0.02, 0.05]} m={M.ink} />
      {down && <B p={[-0.12, 0.08, 0.101]} s={[0.03, 0.03, 0.005]} m={M.lampHeat} />}
      {!down &&
        items.map((it, i) => (
          <group key={it.id} position={[0, 0.2, i ? 0.04 : -0.04]} rotation={[Math.PI / 2, 0, 0]}>
            <ItemMesh it={it} at={[0, 0, 0]} />
          </group>
        ))}
    </group>
  );
}

const OVEN_GLOW: Record<string, string> = { OFF: '#141618', LOW: '#4A2A12', MED: '#7A3A14', HIGH: '#B24A16' };

/** 烤箱：靠牆的落地烤箱；玻璃門透出火色（看得見的人一眼看出開著），裡面的東西看得到 */
function Oven({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element {
  const s = k.stations[def.id];
  const items = (s?.items ?? []).map((id) => k.items[id]).filter(Boolean);
  const level = s?.heat ?? 'OFF';
  const glass = useMemo(() => new MeshBasicMaterial({ color: OVEN_GLOW.OFF, transparent: true, opacity: 0.45, depthWrite: false }), []);
  const inner = useMemo(() => new MeshBasicMaterial({ color: '#1A1512' }), []);
  useEffect(() => {
    glass.color.set(OVEN_GLOW[level] ?? OVEN_GLOW.OFF);
    inner.color.set(level === 'OFF' ? '#1A1512' : '#3A1E0E');
  }, [level, glass, inner]);
  const smoking = items.some((it) => maxBrown(it) >= 1.45);
  return (
    <group position={[def.pos[0], 0, def.pos[1]]} rotation={[0, def.facing, 0]}>
      <B p={[0, 0.48, -0.02]} s={[1.08, 0.96, 0.66]} m={M.steelDark} />
      <B p={[0, 0.44, 0.1]} s={[0.86, 0.5, 0.4]} m={inner} />
      <B p={[0, 0.44, 0.315]} s={[0.84, 0.5, 0.01]} m={glass} />
      <B p={[0, 0.74, 0.33]} s={[0.7, 0.03, 0.03]} m={M.steel} />
      <B p={[0, 0.88, 0.32]} s={[1.0, 0.12, 0.02]} m={M.ink} />
      {[-0.3, 0, 0.3].map((x, i) => (
        <Cyl key={x} p={[x, 0.88, 0.335]} r={0.03} h={0.03} m={i === 1 && level !== 'OFF' ? M.lampHeat : M.porcelain} rot={[Math.PI / 2, 0, 0]} />
      ))}
      <B p={[0, 0.3, 0.1]} s={[0.8, 0.01, 0.36]} m={M.iron} />
      {items.map((it, i) => (
        <ItemMesh key={it.id} it={it} at={[(i - (items.length - 1) / 2) * 0.18, 0.31, 0.1]} />
      ))}
      {smoking && <Plume at={[0, 1.0, 0.2]} kind="smoke" />}
    </group>
  );
}

/** 攪拌碗：放在中島上的大碗，裡面的東西看得到 */
function Mixer({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element {
  const s = k.stations[def.id];
  const items = (s?.items ?? []).map((id) => k.items[id]).filter(Boolean);
  const [x, , z] = slotPos(def, 0, 1, 0.95, 0.38);
  return (
    <group position={[x, 0.95, z]}>
      <Cyl p={[0, 0.07, 0]} r={0.2} r2={0.12} h={0.14} m={M.steel} seg={16} />
      <Cyl p={[0, 0.005, 0]} r={0.12} h={0.01} m={M.iron} seg={16} />
      <B p={[0.12, 0.17, 0.05]} s={[0.02, 0.22, 0.02]} m={M.steel} r={[0, 0, -0.5]} />
      {items.map((it, i) => (
        <ItemMesh key={it.id} it={it} at={[Math.cos(i * 1.7) * 0.07, 0.03 + (i % 2) * 0.02, Math.sin(i * 1.7) * 0.07]} />
      ))}
    </group>
  );
}

function FlatStation({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element {
  const s = k.stations[def.id];
  const items = (s?.items ?? []).map((id) => k.items[id]).filter(Boolean);
  const [x, , z] = slotPos(def, 0, 1, 0.95, 0.38);
  const isSink = def.kind === 'sink';
  return (
    <group>
      <group position={[x, 0.95, z]} rotation={[0, def.facing, 0]}>
        {isSink ? (
          <group>
            <B p={[0, -0.08, 0]} s={[0.55, 0.16, 0.45]} m={M.steelDark} />
            <B p={[0, 0.001, 0]} s={[0.5, 0.004, 0.4]} m={M.iron} />
            <Cyl p={[0, 0.2, -0.26]} r={0.015} h={0.4} m={M.steel} />
            <B p={[0, 0.38, -0.16]} s={[0.025, 0.025, 0.2]} m={M.steel} />
          </group>
        ) : (
          <group>
            <B p={[0, 0.012, 0]} s={[0.5, 0.025, 0.34]} m={s?.contaminated ? matFor(new Color('#B08A6E')) : M.board} />
            <B p={[0.32, 0.01, 0.05]} s={[0.24, 0.006, 0.04]} m={M.steel} r={[0, 0.3, 0]} />
          </group>
        )}
      </group>
      {items.map((it, i) => (
        <ItemMesh key={it.id} it={it} at={slotPos(def, i, items.length, isSink ? 0.9 : 0.975, 0.38, 0.14)} />
      ))}
    </group>
  );
}

const JAR_COLORS = ['#EDEDE6', '#F2EFE6', '#3B2416', '#C9C7A8', '#262626', '#D7B65C'];
function Spice({ def }: { def: StationDef }): JSX.Element {
  return (
    <group>
      {JAR_COLORS.map((c, i) => {
        const p = slotPos(def, i, 6, 0.95, 0.3, 0.12);
        return (
          <group key={i} position={p}>
            <Cyl p={[0, 0.06, 0]} r={0.04} h={0.12} m={matFor(new Color(c))} seg={8} />
            <Cyl p={[0, 0.13, 0]} r={0.042} h={0.02} m={M.ink} seg={8} />
          </group>
        );
      })}
    </group>
  );
}

function PlateMesh({ p, at }: { p: PlatePublic; at: V3 }): JSX.Element {
  const bowl = p.vessel === 'bowl';
  return (
    <group position={at}>
      {bowl ? <Cyl p={[0, 0.045, 0]} r={0.1} r2={0.06} h={0.09} m={M.porcelain} seg={14} /> : <Cyl p={[0, 0.008, 0]} r={0.14} h={0.016} m={M.porcelain} seg={16} />}
      {p.components.map((c, i) => (
        <ItemMesh key={i} it={{ ...c, steps: 0 }} at={[(i - (p.components.length - 1) / 2) * 0.06, bowl ? 0.06 : 0.018, ((i % 2) - 0.5) * 0.04]} />
      ))}
    </group>
  );
}

function Plating({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element {
  const s = k.stations[def.id];
  const plates = (s?.plates ?? []).map((id) => k.plates[id]).filter(Boolean);
  return (
    <group>
      {plates.map((p, i) => (
        <PlateMesh key={p.id} p={p} at={slotPos(def, i, 3, 0.95, 0.4, 0.38)} />
      ))}
    </group>
  );
}

/** 出餐口：保溫燈與單軌（看得見的人遠遠就能看到現在有幾張單） */
function Pass({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element {
  const open = k.orders.filter((o) => o.status === 'open');
  return (
    <group>
      {[-1.2, 0, 1.2].map((dx) => (
        <group key={dx} position={[def.pos[0] + dx, 1.9, def.pos[1] - 0.15]}>
          <B p={[0, 0, 0]} s={[0.6, 0.06, 0.18]} m={M.iron} />
          <B p={[0, -0.035, 0]} s={[0.5, 0.01, 0.12]} m={M.lampHeat} />
        </group>
      ))}
      <B p={[def.pos[0], 1.68, def.pos[1] + 0.02]} s={[3.6, 0.03, 0.04]} m={M.steel} />
      {open.slice(0, 8).map((o, i) => (
        <mesh key={o.id} position={[def.pos[0] - 1.6 + i * 0.42, 1.55, def.pos[1] + 0.05]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[0.16, 0.26]} />
          <meshBasicMaterial map={ticketPaper(o.table, orderDish(o), (o.deadline - k.t) / (o.deadline - o.openedAt) < 0.25)} />
        </mesh>
      ))}
    </group>
  );
}

function Storage({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element {
  const s = k.stations[def.id];
  const stock = Object.entries(s?.stock ?? {}).filter(([, n]) => (n ?? 0) > 0);
  const [fx, fz] = [Math.sin(def.facing), Math.cos(def.facing)];
  const els: JSX.Element[] = [];
  // 食材變多（v3：冷藏約 20 種、乾貨約 14 種）：三層（對齊層板），欄寬依種類數縮放，全部塞得進架子
  const rows = 3;
  const cols = Math.max(1, Math.ceil(stock.length / rows));
  const colW = Math.min(1.3, 4.3 / cols);
  const per = Math.max(1, Math.min(4, Math.floor(colW / 0.17)));
  stock.forEach(([type, n], i) => {
    const row = i % rows;
    const col = Math.floor(i / rows);
    for (let j = 0; j < Math.min(per, n ?? 0); j++) {
      const off = -2.15 + col * colW + j * 0.17 + 0.09;
      // 貼著層板（0.15／0.75／1.35 m，板厚 3 cm）放
      const y = 0.165 + row * 0.6;
      const p: V3 = [def.pos[0] - fx * 0.4 + fz * off, y, def.pos[1] - fz * 0.4 - fx * off];
      els.push(<ShelfFood key={`${type}${j}`} type={type} at={[p[0], y, p[2]]} rot={def.facing} fit={0.16} scale={1.2} />);
    }
  });
  return <group>{els}</group>;
}

function Locker({ def }: { def: StationDef }): JSX.Element {
  return (
    <group position={[def.pos[0], 0, def.pos[1]]} rotation={[0, def.facing, 0]}>
      <B p={[0, 1.0, 0]} s={[1.0, 2.0, 0.7]} m={M.locker} />
      <B p={[0, 1.0, 0.351]} s={[0.01, 1.9, 0.005]} m={M.ink} />
      {[-0.25, 0.25].map((x) =>
        [1.7, 1.75, 1.8].map((y) => <B key={`${x}${y}`} p={[x, y, 0.352]} s={[0.2, 0.012, 0.004]} m={M.ink} />),
      )}
      <B p={[0.08, 1.0, 0.36]} s={[0.02, 0.12, 0.02]} m={M.steel} />
    </group>
  );
}

function Cctv({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element {
  const watching = k.threats.cctv;
  const tex = crtScreen(7, true);
  return (
    <group position={[def.pos[0], 0, def.pos[1]]} rotation={[0, def.facing, 0]}>
      <B p={[0, 0.55, 0]} s={[0.7, 1.1, 1.0]} m={M.steelDark} />
      <B p={[0, 1.35, -0.05]} s={[0.6, 0.5, 0.5]} m={M.iron} />
      <mesh position={[0, 1.35, 0.205]}>
        <planeGeometry args={[0.48, 0.36]} />
        <meshStandardMaterial map={tex} emissiveMap={tex} emissive="#ffffff" emissiveIntensity={watching ? 1.1 : 0.4} roughness={0.3} />
      </mesh>
      <B p={[0.2, 1.0, 0.5]} s={[0.1, 0.1, 0.02]} m={new MeshBasicMaterial({ color: '#8E3A2A' })} />
    </group>
  );
}

function Delivery({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element | null {
  const crate = k.stations[def.id]?.crate;
  if (!crate) return null;
  const [x, , z] = slotPos(def, 0, 1, 0, 0.3);
  return (
    <group position={[x, 0, z]}>
      <B p={[0, 0.2, 0]} s={[0.6, 0.4, 0.45]} m={M.crate} />
      <B p={[0, 0.41, 0]} s={[0.62, 0.02, 0.1]} m={crate === 'FRIDGE' ? matFor(new Color('#5E7C8C')) : matFor(new Color('#8C7A4E'))} />
    </group>
  );
}

function Trash({ def }: { def: StationDef }): JSX.Element {
  return (
    <group position={[def.pos[0], 0, def.pos[1] + 0.25]}>
      <Cyl p={[0, 0.38, 0]} r={0.24} r2={0.2} h={0.76} m={M.plastic} seg={12} />
      <Cyl p={[0, 0.77, 0]} r={0.25} h={0.03} m={M.ink} seg={12} />
    </group>
  );
}

/** 工作站名牌：貼在檯面正面（看得見的人一眼找到位置） */
function Tag({ def }: { def: StationDef }): JSX.Element | null {
  const [fx, fz] = [Math.sin(def.facing), Math.cos(def.facing)];
  const y = def.kind === 'locker' || def.kind === 'cctv' ? 1.95 : def.kind === 'fridge' || def.kind === 'pantry' ? 2.3 : def.kind === 'trash' || def.kind === 'delivery' || def.kind === 'oven' ? 1.0 : 0.82;
  const off = def.kind === 'locker' || def.kind === 'cctv' ? 0.36 : def.kind === 'trash' ? 0.5 : def.kind === 'oven' ? 0.34 : 0.02;
  const tex = stationTag(def.label);
  return (
    <mesh position={[def.pos[0] + fx * off, y, def.pos[1] + fz * off]} rotation={[0, def.facing, 0]}>
      <planeGeometry args={[0.36, 0.09]} />
      <meshBasicMaterial map={tex} />
    </mesh>
  );
}

/** 注視中的工作站：描出輪廓（白＝可以用，紅＝不是你能用的） */
function Highlight({ role }: { role: Seat }): JSX.Element {
  const ref = useRef<LineSegments>(null);
  const geo = useMemo(() => new EdgesGeometry(new BoxGeometry(1, 1, 1)), []);
  useFrame(() => {
    const l = ref.current;
    if (!l) return;
    const k = useStore.getState().kitchen;
    const g = k?.threats.guest;
    const t = currentTarget(role, g && g.state !== 'gone' && g.state !== 'escorted' ? [g.x, g.z] : null);
    if (!t) {
      l.visible = false;
      return;
    }
    l.visible = true;
    l.material = t.usable ? lineHot : lineNo;
    if (t.guest && g) {
      l.position.set(g.x, 1.0, g.z);
      l.scale.set(0.7, 2.1, 0.7);
      return;
    }
    const d = t.station!;
    if (d.kind === 'oven') {
      l.position.set(d.pos[0], 0.5, d.pos[1]);
      l.scale.set(1.15, 1.02, 1.15);
      l.rotation.y = d.facing;
      return;
    }
    const tall = d.kind === 'locker' || d.kind === 'cctv' || d.kind === 'fridge' || d.kind === 'pantry' || d.kind === 'cage';
    const [x, , z] = slotPos(d, 0, 1, 0, tall ? 0.45 : 0.38);
    l.position.set(x, tall ? 1.05 : 1.12, z);
    l.scale.set(tall ? 1.1 : 0.8, tall ? 2.1 : 0.36, tall ? 1.1 : 0.7);
    l.rotation.y = d.facing;
  });
  return <lineSegments ref={ref} geometry={geo} material={lineHot} visible={false} />;
}

function Stations(): JSX.Element | null {
  const k = useStore((s) => s.kitchen);
  if (!k) return null;
  return (
    <group>
      {STATIONS.map((def) => {
        switch (def.kind) {
          case 'stove':
          case 'pan':
            return <HeatStation key={def.id} def={def} k={k} />;
          case 'toaster':
            return <Toaster key={def.id} def={def} k={k} />;
          case 'sink':
          case 'prep':
            return <FlatStation key={def.id} def={def} k={k} />;
          case 'spice':
            return <Spice key={def.id} def={def} />;
          case 'plating':
            return <Plating key={def.id} def={def} k={k} />;
          case 'pass':
            return <Pass key={def.id} def={def} k={k} />;
          case 'fridge':
          case 'pantry':
            return <Storage key={def.id} def={def} k={k} />;
          case 'locker':
            return <Locker key={def.id} def={def} />;
          case 'cctv':
            return <Cctv key={def.id} def={def} k={k} />;
          case 'delivery':
            return <Delivery key={def.id} def={def} k={k} />;
          case 'trash':
            return <Trash key={def.id} def={def} />;
          case 'oven':
            return <Oven key={def.id} def={def} k={k} />;
          case 'mixer':
            return <Mixer key={def.id} def={def} k={k} />;
          default:
            return null;
        }
      })}
    </group>
  );
}

/* ------------------------------- 客人與怪物 ------------------------------- */

/**
 * 那位從不點餐的客人：黑西裝、蒼白的臉、全黑的眼睛、一直維持著太寬的笑（guest_suit.glb；載入失敗時用方塊）。
 * 位置直接套用伺服器的快照，不做內插——他只在沒人看的時候移動，所以畫面上是「一轉頭就換了位置」。
 */
function Guest(): JSX.Element | null {
  const g = useStore((s) => s.kitchen?.threats.guest ?? null);
  if (!g || g.state === 'gone' || g.state === 'escorted') return null;
  const seated = g.state === 'seated';
  // 坐著時對齊到最近的椅子（純呈現；伺服器的位置照舊用於所有規則）
  const chair = seated ? nearestChair(g.x, g.z) : null;
  const x = chair?.x ?? g.x;
  const z = chair?.z ?? g.z;
  return (
    <CivilianBody model="guest_suit" x={x} z={z} yaw={chair?.yaw ?? g.yaw} clip={seated ? 'SitStill' : 'StandStiff'} seed={7}>
      {seated ? (
        <group>
          {[-1, 1].map((s) => (
            <group key={s}>
              <B p={[s * 0.09, 0.5, -0.2]} s={[0.1, 0.1, 0.45]} m={M.suit} />
              <B p={[s * 0.09, 0.25, -0.4]} s={[0.09, 0.5, 0.09]} m={M.suit} />
            </group>
          ))}
          <group position={[0, 0.5, 0]}>
            <Body />
          </group>
        </group>
      ) : (
        <group>
          {[-1, 1].map((s) => (
            <B key={s} p={[s * 0.09, 0.5, 0]} s={[0.1, 1.0, 0.1]} m={M.suit} />
          ))}
          <group position={[0, 1.0, 0]}>
            <Body />
          </group>
        </group>
      )}
    </CivilianBody>
  );
}

function Body(): JSX.Element {
  return (
    <group>
      <B p={[0, 0.42, 0]} s={[0.36, 0.84, 0.2]} m={M.suit} />
      <B p={[0, 0.6, -0.101]} s={[0.1, 0.4, 0.005]} m={M.shirt} />
      {[-1, 1].map((s) => (
        <B key={s} p={[s * 0.22, 0.32, 0]} s={[0.08, 0.92, 0.09]} m={M.suit} />
      ))}
      <B p={[0, 0.9, 0]} s={[0.08, 0.12, 0.08]} m={M.skin} />
      <mesh position={[0, 1.08, 0]} scale={[0.85, 1.15, 0.9]} material={M.skin}>
        <sphereGeometry args={[0.13, 8, 6]} />
      </mesh>
    </group>
  );
}

/**
 * 後門的東西：駝背、手臂垂到地上。只用伺服器的位置（內插讓移動連續），沒有任何隨機行為。
 * 黑暗中只看得到輪廓與兩點反光。
 */
function Monster(): JSX.Element | null {
  const present0 = useStore((s) => !!s.kitchen?.threats.monster?.present);
  const [abducting, setAbducting] = useState(false);
  useEffect(
    () =>
      on('abduct', () => {
        setAbducting(true);
        const t = window.setInterval(() => {
          const e = abductElapsed();
          if (e === null || e >= ABDUCT_PHASE.black) {
            setAbducting(false);
            clearInterval(t);
          }
        }, 150);
      }),
    [],
  );
  const present = present0 || abducting;
  const ref = useRef<Group>(null);
  const glow = useRef<PointLight>(null);
  const cur = useRef<{ x: number; z: number; yaw: number } | null>(null);
  useFrame((_, dt) => {
    const m = useStore.getState().kitchen?.threats.monster;
    const g = ref.current;
    const e = abductElapsed();
    if (g && e !== null && e < ABDUCT_PHASE.black) {
      // 被抓的過場：牠停在撲抓的位置、面向被抓的人，播抓取動作；臉前有一點暗紅的光
      const [mx, mz] = abduct.at;
      g.visible = true;
      g.position.set(mx, 0, mz);
      g.rotation.y = Math.atan2(-(abduct.from.x - mx), -(abduct.from.z - mz));
      if (glow.current) glow.current.intensity = 2.2 + Math.sin(e / 60) * 0.8;
      cur.current = { x: mx, z: mz, yaw: g.rotation.y };
      return;
    }
    if (glow.current) glow.current.intensity = 0;
    if (!g || !m?.present) return;
    if (!cur.current || Math.hypot(cur.current.x - m.x, cur.current.z - m.z) > 4) cur.current = { x: m.x, z: m.z, yaw: m.yaw };
    const c = cur.current;
    c.x = MathUtils.damp(c.x, m.x, 6, dt);
    c.z = MathUtils.damp(c.z, m.z, 6, dt);
    let dy = m.yaw - c.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    c.yaw += dy * (1 - Math.exp(-dt * 8));
    g.position.set(c.x, 0, c.z);
    g.rotation.y = c.yaw;
  });
  if (!present) return null;
  return (
    <group ref={ref}>
      <MonsterRig getMode={() => (abductElapsed() !== null ? 'grab' : ((useStore.getState().kitchen?.threats.monster?.mode ?? 'patrol') as MonsterMode))} />
      <pointLight ref={glow} position={[0, 1.5, -0.7]} color="#8A1A10" intensity={0} distance={3} decay={2} />
    </group>
  );
}

/* ------------------------------- 標記與便條 ------------------------------- */

/** 標記：工作站上方旋轉的菱形，名牌寫出是誰標的、附帶的符號與回應（存在伺服器的互助狀態裡，重連後還在） */
function MarkerPin({ m, who, replies }: { m: { targetId: string; token?: SignalToken }; who: string; replies: number }): JSX.Element | null {
  const d = STATION_BY_ID[m.targetId];
  const ref = useRef<Group>(null);
  const tag = useMemo(() => nameTexture(`${who}・${m.token ? TOKEN_LABEL[m.token] : d?.label ?? ''}${replies ? `（${replies} 回應）` : ''}`), [m.token, d, who, replies]);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.position.y = 1.8 + Math.sin(clock.elapsedTime * 3) * 0.06;
    ref.current.rotation.y = clock.elapsedTime * 1.2;
  });
  if (!d) return null;
  return (
    <group position={[d.pos[0], 0, d.pos[1]]}>
      <group ref={ref}>
        <mesh material={M.lampHeat} rotation={[0, 0, Math.PI / 4]}>
          <boxGeometry args={[0.2, 0.2, 0.04]} />
        </mesh>
      </group>
      <sprite position={[0, 2.15, 0]} scale={[0.9, 0.19, 1]}>
        <spriteMaterial map={tag} transparent depthWrite={false} />
      </sprite>
    </group>
  );
}

/** 便條：貼在工作站前緣的小紙條（過期的變灰） */
function NotePin({ stationId, text, stale, idx }: { stationId: string; text: string; stale: boolean; idx: number }): JSX.Element | null {
  const d = STATION_BY_ID[stationId];
  const tag = useMemo(() => nameTexture(stale ? `${text}（過期）` : text), [text, stale]);
  if (!d) return null;
  const [fx, fz] = [Math.sin(d.facing) * 0.35, Math.cos(d.facing) * 0.35];
  return (
    <sprite position={[d.pos[0] + fx, 1.25 + idx * 0.16, d.pos[1] + fz]} scale={[0.62, 0.13, 1]}>
      <spriteMaterial map={tag} transparent depthWrite={false} opacity={stale ? 0.45 : 0.95} />
    </sprite>
  );
}

/** 教學關：目前這一步要去的地方（工作站或那位客人），隔著牆也看得到 */
function TutorialPin(): JSX.Element | null {
  const step = useStore((s) => s.kitchen?.tutorial?.step ?? null);
  const guest = useStore((s) => s.kitchen?.threats.guest ?? null);
  const ref = useRef<Group>(null);
  const def = step ? TUTORIAL_STEP_BY_ID[step] : null;
  const onGuest = (step === 'guest_look' || step === 'guest_escort') && guest;
  const station = def?.target ? STATION_BY_ID[def.target] : null;
  const label = onGuest ? '教學：那位客人' : station ? `教學：${station.label}` : '';
  const tag = useMemo(() => (label ? nameTexture(label) : null), [label]);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.position.y = 2.25 + Math.sin(clock.elapsedTime * 2.4) * 0.08;
    ref.current.rotation.y = clock.elapsedTime * 1.6;
  });
  const pos: [number, number] | null = onGuest ? [guest.x, guest.z] : station ? station.pos : null;
  if (!pos || !tag) return null;
  return (
    <group position={[pos[0], 0, pos[1]]}>
      <group ref={ref}>
        <mesh material={M.lampHeat} rotation={[Math.PI, 0, 0]} renderOrder={10}>
          <coneGeometry args={[0.16, 0.34, 4]} />
        </mesh>
      </group>
      <sprite position={[0, 2.7, 0]} scale={[1.2, 0.25, 1]} renderOrder={11}>
        <spriteMaterial map={tag} transparent depthWrite={false} depthTest={false} />
      </sprite>
    </group>
  );
}

function Markers(): JSX.Element {
  const marks = useStore((s) => s.kitchen?.coop.marks ?? NONE);
  const notes = useStore((s) => s.kitchen?.coop.notes ?? NONE);
  const players = useStore((s) => s.room?.players ?? NONE);
  const nameOf = (seat: Seat) => players.find((p) => p.role === seat)?.name ?? seat;
  const perStation = new Map<string, number>();
  return (
    <group>
      {marks
        .filter((m) => STATION_BY_ID[m.targetId])
        .map((m) => (
          <MarkerPin key={m.id} m={m} who={nameOf(m.from)} replies={m.replies.length} />
        ))}
      {notes.map((n) => {
        const idx = perStation.get(n.stationId) ?? 0;
        perStation.set(n.stationId, idx + 1);
        return <NotePin key={n.id} stationId={n.stationId} text={`便條：${NOTE_TEXT[n.label]}`} stale={n.stale} idx={idx} />;
      })}
    </group>
  );
}

/* ------------------------------- 隊友 ------------------------------- */

/** 躲在置物櫃裡的隊友不顯示（只看得到櫃子） */
function Mate({ role }: { role: Seat }): JSX.Element {
  const hidden = useStore((s) => s.kitchen?.players[role]?.status === 'hidden');
  return <group visible={!hidden}>{<CrewAvatar role={role} />}</group>;
}

function Avatars({ me }: { me: Seat | null }): JSX.Element | null {
  const seats = useStore((s) => (s.room?.players ?? []).map((p) => p.role).filter((r): r is Seat => !!r).sort().join(','));
  if (!me) return null;
  return (
    <group>
      {SEATS.filter((r) => r !== me && seats.split(',').includes(r)).map((r) => (
        <Mate key={r} role={r} />
      ))}
    </group>
  );
}

/* ------------------------------- 相機與環境 ------------------------------- */

function Rig(): null {
  const { camera, scene, gl } = useThree();
  const shake = useRef(0);
  const inLocker = useRef(false);
  useEffect(() => {
    camera.rotation.order = 'YXZ';
    scene.background = new Color('#0C0E0E');
    scene.fog = new FogExp2('#0C0E0E', 0.07);
    gl.toneMapping = NeutralToneMapping;
    gl.toneMappingExposure = 1.05;
  }, [camera, scene, gl]);
  // 怪物衝過來、撲上來：視角短暫震動（事件連動）
  useEffect(
    () =>
      on('fx', (f) => {
        if (f.visual === 'lunge') shake.current = 0.6;
        else if (f.visual === 'charge') shake.current = Math.max(shake.current, 0.25);
      }),
    [],
  );
  const baseFov = useRef<number | null>(null);
  useFrame(({ clock }, dt) => {
    shake.current = Math.max(0, shake.current - dt);
    const k = shake.current * 0.05;
    const t = clock.elapsedTime * 60;
    const st = useStore.getState();
    const role = st.me?.role;
    const status = role ? st.kitchen?.players[role]?.status : 'ok';
    inLocker.current = status === 'hidden';
    const cam = camera as PerspectiveCamera;
    baseFov.current ??= cam.fov;
    const e = abductElapsed();
    if (e !== null && e < ABDUCT_PHASE.black) {
      abductCamera(cam, e, clock.elapsedTime);
    } else {
      camera.position.set(pose.x + Math.sin(t) * k, pose.y + Math.cos(t * 1.3) * k * 0.5, pose.z);
      camera.rotation.set(pose.pitch, pose.yaw, slideRoll(), 'YXZ');
    }
    const fov = e !== null && e < ABDUCT_PHASE.black ? cam.fov : baseFov.current;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    const fog = scene.fog as FogExp2;
    fog.density = MathUtils.damp(fog.density, inLocker.current ? 0.5 : 0.07, 4, dt);
  });
  return null;
}

/**
 * 被抓走的鏡頭：視角被扳向怪物的臉、撲到眼前（畫面收窄），接著被拽倒在地往上看。
 * 只用到過場開始時記下的位置與怪物撲抓的位置，和伺服器之後把人移到哪裡無關。
 */
const easeIn = (x: number) => x * x * x;
const CALM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
function abductCamera(cam: PerspectiveCamera, e: number, clock: number): void {
  const { from, at } = abduct;
  const [mx, mz] = at;
  const dx = from.x - mx;
  const dz = from.z - mz;
  const d = Math.hypot(dx, dz) || 1;
  // 牠駝著背、頭往前探（抓取動作時頭在身體前方約 0.9 m、高約 1.3 m）；鏡頭貼到臉前 0.6 m、略低於臉往上看
  const head = { x: mx + (dx / d) * 0.9, y: 1.32, z: mz + (dz / d) * 0.9 };
  const close = { x: mx + (dx / d) * 1.5, y: 1.22, z: mz + (dz / d) * 1.5 };
  const lookAt = (px: number, py: number, pz: number) => ({ yaw: Math.atan2(-(head.x - px), -(head.z - pz)), pitch: Math.atan2(head.y - py, Math.hypot(head.x - px, head.z - pz)) });
  let x: number, y: number, z: number, yaw: number, pitch: number, roll = 0, fov: number, shake: number;
  if (e < ABDUCT_PHASE.lunge) {
    const k = e / ABDUCT_PHASE.lunge;
    // 前 0.25 秒：頭被扳過去；接著牠撲到臉前
    const turn = easeOut(Math.min(1, e / 250));
    const pull = easeIn(Math.max(0, (e - 200) / (ABDUCT_PHASE.lunge - 200)));
    x = from.x + (close.x - from.x) * pull;
    y = from.y + (close.y - from.y) * pull;
    z = from.z + (close.z - from.z) * pull;
    const want = lookAt(x, y, z);
    let dy = want.yaw - from.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    yaw = from.yaw + dy * turn;
    pitch = from.pitch + (want.pitch - from.pitch) * turn;
    fov = 70 - 28 * pull;
    shake = 0.015 + 0.09 * k;
    roll = Math.sin(e / 40) * 0.05 * k;
  } else {
    // 被拽倒：鏡頭摔到地上、往上翻、歪一邊，怪物壓在上方
    const k = Math.min(1, (e - ABDUCT_PHASE.lunge) / (ABDUCT_PHASE.down - ABDUCT_PHASE.lunge));
    const f = easeOut(Math.min(1, k * 2.2));
    x = close.x + (dx / d) * 0.3 * f;
    z = close.z + (dz / d) * 0.3 * f;
    y = close.y + (0.3 - close.y) * f;
    const want = lookAt(x, y, z);
    yaw = want.yaw + 0.18 * f;
    pitch = Math.min(1.0, want.pitch + 0.08 * f);
    roll = 0.65 * f;
    fov = 42 + 18 * f;
    shake = 0.11 * (1 - k * 0.6);
  }
  if (CALM) shake = 0;
  const t = clock * 55;
  cam.position.set(x + Math.sin(t) * shake, y + Math.cos(t * 1.37) * shake * 0.7, z + Math.sin(t * 0.83) * shake * 0.5);
  cam.rotation.set(pitch + Math.sin(t * 1.9) * shake * 0.4, yaw + Math.cos(t * 1.4) * shake * 0.4, roll, 'YXZ');
  cam.fov = fov;
  cam.updateProjectionMatrix();
}

/** 等字型載入後再產生名牌貼圖，避免第一次畫出來是後備字型 */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        setReady(true);
      }
    };
    const t = window.setTimeout(finish, 2500);
    const text = STATIONS.map((d) => d.label).join('') + '標記煎蛋吐司洋蔥湯番茄炒主廚自選委託';
    const fonts = document.fonts;
    if (!fonts?.load) finish();
    else {
      Promise.all([fonts.load('700 46px "Noto Sans TC"', text), fonts.load('600 30px "IBM Plex Mono"', '#0123456789')])
        .then(finish)
        .catch(finish);
    }
    return () => clearTimeout(t);
  }, []);
  return ready;
}

export default function Scene(): JSX.Element {
  const role = useStore((s) => s.me?.role ?? null);
  const retro = useStore((s) => s.prefs.retro) || new URLSearchParams(location.search).get('retro') === '1';
  const fontsReady = useFontsReady();
  return (
    <Canvas
      key={retro ? 'retro' : 'normal'}
      dpr={retro ? 0.5 : [1, 1.5]}
      className={retro ? 'retro' : undefined}
      camera={{ fov: 72, near: 0.05, far: 50, position: [0, 1.6, 0] }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <Rig />
      <hemisphereLight args={['#76838A', '#1A1512', 0.55]} />
      <ambientLight intensity={0.05} color="#9AA8AC" />
      <Lights />
      {ZONES.map((z) => (
        <ZoneShell key={z.id} id={z.id} />
      ))}
      <Walls />
      <Lintels />
      <FireDoor />
      <SwingDoors />
      <Props />
      <Stations />
      {fontsReady && STATIONS.map((d) => <Tag key={d.id} def={d} />)}
      {role && <Highlight role={role} />}
      <Guest />
      <Diners />
      <FlawWorld />
      <PhysicsWorld />
      <Monster />
      <Markers />
      <TutorialPin />
      <Avatars me={role} />
    </Canvas>
  );
}
