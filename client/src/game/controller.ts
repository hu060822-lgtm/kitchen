import { anyDown } from './keymap';
import {
  EYE_HEIGHT,
  INTERACT_RANGE,
  PLAYER_RADIUS,
  SPAWNS,
  STATIONS,
  WALK_SPEED,
  PHYSICS,
  avoidBodies,
  DEFAULT_FLAW_CONFIG,
  buildColliders,
  flawBodyScale,
  flawRadius,
  flawZoneBlocked,
  forwardOf,
  moveWithCollision,
  openDoors,
  roleCanUseStation,
  stationFront,
  zoneAt,
  type Blocker,
  type Body,
  type Box,
  type DoorState,
  type FlawEffectConfig,
  type FlawId,
  type PlayerPose,
  type Seat,
  type StationDef,
  type ZoneId,
} from '@last-table/shared';

/**
 * 第一人稱控制器（與渲染無關）。
 * 盲區員沒有 3D 場景，但同樣使用這份移動／碰撞邏輯；伺服器用同一份碰撞資料再驗證一次。
 */

export const RUN_SPEED = 4.4;
export const CROUCH_SPEED = 0.45;

/** 缺陷卡的速度倍率（沉默侍者在餐廳較快）；由遊戲迴圈依伺服器給的設定每幀更新，與伺服器用同一個函式計算 */
let speedMult = 1;
export function setSpeedMultiplier(m: number): void {
  speedMult = Number.isFinite(m) && m > 0 ? m : 1;
}
export const CROUCH_EYE = 1.08;

export const pose = { x: 0, y: EYE_HEIGHT, z: 0, yaw: 0, pitch: 0 };

const keys = new Set<string>();
let doors: DoorState = openDoors();
let blockers: Blocker[] = [];
let colliders: Box[] = buildColliders(doors);
let colliderKey = '';
/** 這位玩家的缺陷卡（碰撞半徑、窄縫與低門、冷藏室、暴衝的慣性） */
let bodyFlaw: FlawId | null = null;
let bodyCfg: FlawEffectConfig = DEFAULT_FLAW_CONFIG;
let radius = PLAYER_RADIUS;
/** 體型（巨人 1.25、小矮人 0.62）：眼睛高度與步伐 */
let bodyScale = 1;
export function eyeScale(): number {
  return bodyScale;
}
/** 暴衝快遞的速度向量（m/s） */
const vel = { x: 0, z: 0 };
/** 上一次被冷藏室擋下的時間（提示用） */
export const blockedZone = { at: 0 };

/** 其他人的身體（隊友；遊戲迴圈每幀更新）：不能穿過去 */
let bodies: Body[] = [];
export function setBodies(b: Body[]): void {
  bodies = b;
}

/** 滑倒：伺服器決定滑到哪裡，這裡把畫面演出來（滑行 0.45 秒，爬起來之前不能動） */
const slide = { active: false, fx: 0, fz: 0, tx: 0, tz: 0, t0: 0, ms: 450, until: 0 };
export function startSlide(x: number, z: number, freezeMs = 1100): void {
  const now = performance.now();
  Object.assign(slide, { active: true, fx: pose.x, fz: pose.z, tx: x, tz: z, t0: now, until: now + freezeMs });
  vel.x = vel.z = 0;
}
/** 滑倒時鏡頭的傾斜（弧度） */
export function slideRoll(): number {
  if (!slide.active) return 0;
  const t = (performance.now() - slide.t0) / (slide.until - slide.t0);
  return t >= 1 ? 0 : Math.sin(Math.min(1, t * 2.2) * Math.PI) * 0.22 * (1 - t);
}
/** 滑倒時眼睛的高度（跌坐下去再爬起來） */
function slideEye(): number {
  const t = (performance.now() - slide.t0) / (slide.until - slide.t0);
  return t < 0.35 ? 1 - t / 0.35 : t < 0.7 ? 0 : (t - 0.7) / 0.3;
}

export function setBody(flaw: FlawId | null, cfg: FlawEffectConfig): void {
  if (flaw === bodyFlaw && cfg === bodyCfg) return;
  bodyFlaw = flaw;
  bodyCfg = cfg;
  radius = flawRadius(flaw, cfg, PLAYER_RADIUS);
  bodyScale = flawBodyScale(flaw, cfg);
  pose.y = EYE_HEIGHT * bodyScale;
  colliderKey = '';
  colliders = buildColliders(doors, blockers, flaw);
  vel.x = vel.z = 0;
}

/** 暴衝快遞的衝勁（給畫面上的速度條）：目前速度、上限、前方 1.6 公尺內有沒有牆 */
export function momentum(): { speed: number; max: number; wallAhead: boolean } | null {
  if (bodyFlaw !== 'D13') return null;
  const speed = Math.hypot(vel.x, vel.z);
  const max = WALK_SPEED * bodyCfg.D13.maxMult;
  let wallAhead = false;
  if (speed > 0.5) {
    const look = Math.min(1.6, speed * 0.5);
    const r = moveWithCollision(pose.x, pose.z, pose.x + (vel.x / speed) * look, pose.z + (vel.z / speed) * look, colliders, radius);
    wallAhead = r.blocked;
  }
  return { speed, max, wallAhead };
}
let seq = 0;
let lastSentAt = 0;
let lastSent = { x: NaN, z: NaN, yaw: NaN };
let stride = 0;
/** 被關在鐵籠、躲在置物櫃裡：只能轉頭 */
let frozen = false;

export interface StepResult {
  moved: boolean;
  blocked: boolean;
  speed: number;
  footstep: boolean;
  running: boolean;
}

/** 門的狀態與實體（客人、怪物）都會影響碰撞 */
export function setWorld(d: DoorState, b: Blocker[]): void {
  const key = JSON.stringify(d) + b.map((x) => `${x.id}${x.x.toFixed(1)}${x.z.toFixed(1)}`).join();
  if (key === colliderKey) return;
  colliderKey = key;
  doors = d;
  blockers = b;
  colliders = buildColliders(doors, blockers, bodyFlaw);
}

/** 測試關卡用：直接指定碰撞盒 */
export function setColliders(boxes: Box[]): void {
  colliders = boxes;
  colliderKey = '';
}

export function getColliders(): readonly Box[] {
  return colliders;
}

export function setFrozen(v: boolean): void {
  frozen = v;
}

export function spawnFor(role: Seat): void {
  const s = SPAWNS[role];
  pose.x = s.pos[0];
  pose.z = s.pos[2];
  pose.y = EYE_HEIGHT * bodyScale;
  body.crouch = false;
  pose.yaw = s.yaw;
  pose.pitch = 0;
  lastSent = { x: NaN, z: NaN, yaw: NaN };
}

export function snapTo(p: PlayerPose): void {
  pose.x = p.x;
  pose.z = p.z;
}

export function setYaw(yaw: number): void {
  pose.yaw = yaw;
  pose.pitch = 0;
}

export function setKey(code: string, down: boolean): void {
  if (down) keys.add(code);
  else keys.delete(code);
}
export function clearKeys(): void {
  keys.clear();
}
export function anyMoveKey(): boolean {
  return anyDown('forward', keys) || anyDown('back', keys) || anyDown('left', keys) || anyDown('right', keys);
}

export function look(dx: number, dy: number, sensitivity: number): void {
  const k = 0.0022 * sensitivity;
  pose.yaw -= dx * k;
  pose.pitch = Math.max(-1.25, Math.min(1.25, pose.pitch - dy * k));
}

export const body = { crouch: false };

export function setCrouch(on: boolean): void {
  body.crouch = on;
}

export function step(dt: number, enabled: boolean): StepResult {
  const none: StepResult = { moved: false, blocked: false, speed: 0, footstep: false, running: false };
  if (slide.active) {
    const now = performance.now();
    const k = Math.min(1, (now - slide.t0) / slide.ms);
    const e = 1 - (1 - k) ** 3;
    pose.x = slide.fx + (slide.tx - slide.fx) * e;
    pose.z = slide.fz + (slide.tz - slide.fz) * e;
    const low = (0.55 + (EYE_HEIGHT - 0.55) * slideEye()) * bodyScale;
    pose.y += (low - pose.y) * (1 - Math.exp(-Math.min(dt, 0.1) * 14));
    if (now >= slide.until) slide.active = false;
    return none;
  }
  const eye = (body.crouch ? CROUCH_EYE : EYE_HEIGHT) * bodyScale;
  pose.y += (eye - pose.y) * (1 - Math.exp(-Math.min(dt, 0.1) * 9));
  if (!enabled || frozen) {
    vel.x = vel.z = 0;
    return none;
  }
  const f = (anyDown('forward', keys) ? 1 : 0) - (anyDown('back', keys) ? 1 : 0);
  const r = (anyDown('right', keys) ? 1 : 0) - (anyDown('left', keys) ? 1 : 0);
  if (bodyFlaw === 'D13') return stepMomentum(dt, f, r);
  if (f === 0 && r === 0) return none;

  const [fx, fz] = forwardOf(pose.yaw);
  const rx = -fz;
  const rz = fx;
  let dx = fx * f + rx * r;
  let dz = fz * f + rz * r;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;

  const running = !body.crouch && anyDown('run', keys);
  const speed = (body.crouch ? WALK_SPEED * CROUCH_SPEED : running ? RUN_SPEED : WALK_SPEED) * speedMult;
  const dist = Math.min(dt, 0.1) * speed;
  const wall = moveWithCollision(pose.x, pose.z, pose.x + dx * dist, pose.z + dz * dist, colliders, radius);
  const av = avoidBodies(pose.x, pose.z, wall.x, wall.z, bodies, PHYSICS.bodyRadius * bodyScale);
  const res = av.blocked ? { ...moveWithCollision(pose.x, pose.z, av.x, av.z, colliders, radius), blocked: true } : wall;
  if (zoneGate(res.x, res.z)) return { ...none, blocked: true };
  const actual = Math.hypot(res.x - pose.x, res.z - pose.z);
  pose.x = res.x;
  pose.z = res.z;

  stride += actual;
  let footstep = false;
  const strideLen = (running ? 1.35 : body.crouch ? 0.7 : 1.0) * bodyScale;
  if (stride >= strideLen) {
    stride = 0;
    footstep = true;
  }
  return { moved: actual > 1e-4, blocked: res.blocked && actual < dist * 0.5, speed: actual / Math.max(dt, 1e-3), footstep, running };
}

/** 幽閉外場不能走進冷藏室：擋下這一步（伺服器用同一個規則） */
function zoneGate(x: number, z: number): boolean {
  if (!flawZoneBlocked(bodyFlaw, zoneAt(pose.x, pose.z)?.id ?? null, zoneAt(x, z)?.id ?? null)) return false;
  blockedZone.at = performance.now();
  return true;
}

const wrap = (a: number): number => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/**
 * 暴衝快遞的慣性：一按方向就加速（很難慢慢走）、跑得越快越難轉向、放開會滑一段；
 * 反方向或空白鍵是煞停。速度上限與伺服器允許的倍率相同（flawSpeedMultiplier）。
 */
function stepMomentum(dt: number, f: number, r: number): StepResult {
  const c = bodyCfg.D13;
  const h = Math.min(dt, 0.1);
  const max = WALK_SPEED * c.maxMult;
  let speed = Math.hypot(vel.x, vel.z);
  let dir = speed > 0.05 ? Math.atan2(vel.x, vel.z) : 0;
  const brake = anyDown('brake', keys);
  if (f !== 0 || r !== 0) {
    const [fx, fz] = forwardOf(pose.yaw);
    const ix = fx * f + -fz * r;
    const iz = fz * f + fx * r;
    const want = Math.atan2(ix, iz);
    if (speed <= 0.05) dir = want;
    const diff = wrap(want - dir);
    if (Math.abs(diff) > Math.PI * 0.6) {
      // 反方向：當成煞車
      speed = Math.max(0, speed - c.brakeDecel * h);
      if (speed === 0) dir = want;
    } else {
      const turn = c.turnSlow + (c.turnFast - c.turnSlow) * Math.min(1, speed / max);
      dir = wrap(dir + Math.max(-turn * h, Math.min(turn * h, diff)));
      // 轉得急時會掉一點速度；直線時一路加速
      const target = Math.abs(diff) > 0.35 ? Math.max(c.minFrac * max, speed - c.decel * h) : Math.min(max, Math.max(c.minFrac * max, speed + c.accel * h));
      speed = target;
    }
  } else speed = Math.max(0, speed - c.decel * h);
  if (brake) speed = Math.max(0, speed - c.brakeDecel * h);
  vel.x = Math.sin(dir) * speed;
  vel.z = Math.cos(dir) * speed;
  if (speed < 0.01) return { moved: false, blocked: false, speed: 0, footstep: false, running: false };
  const wall = moveWithCollision(pose.x, pose.z, pose.x + vel.x * h, pose.z + vel.z * h, colliders, radius);
  const av = avoidBodies(pose.x, pose.z, wall.x, wall.z, bodies, PHYSICS.bodyRadius * bodyScale);
  const res = av.blocked ? { ...moveWithCollision(pose.x, pose.z, av.x, av.z, colliders, radius), blocked: true } : wall;
  if (zoneGate(res.x, res.z)) {
    vel.x = vel.z = 0;
    return { moved: false, blocked: true, speed: 0, footstep: false, running: false };
  }
  const actual = Math.hypot(res.x - pose.x, res.z - pose.z);
  pose.x = res.x;
  pose.z = res.z;
  if (res.blocked) {
    // 撞到牆：速度降到實際走得動的那部分
    const k = actual / Math.max(1e-4, speed * h);
    vel.x *= k;
    vel.z *= k;
  }
  stride += actual;
  let footstep = false;
  if (stride >= 1.35 * bodyScale) {
    stride = 0;
    footstep = true;
  }
  return { moved: actual > 1e-4, blocked: res.blocked && actual < speed * h * 0.5, speed: actual / Math.max(dt, 1e-3), footstep, running: speed > 3.2 };
}

/** 是否需要送出位置（約 15 Hz；有變化才送） */
export function nextMove(now: number): { x: number; y: number; z: number; yaw: number; seq: number } | null {
  if (now - lastSentAt < 66) return null;
  const changed =
    Math.abs(pose.x - lastSent.x) > 0.005 || Math.abs(pose.z - lastSent.z) > 0.005 || Math.abs(pose.yaw - lastSent.yaw) > 0.01 || Number.isNaN(lastSent.x);
  if (!changed) return null;
  lastSentAt = now;
  lastSent = { x: pose.x, z: pose.z, yaw: pose.yaw };
  return { x: pose.x, y: EYE_HEIGHT, z: pose.z, yaw: pose.yaw, seq: ++seq };
}

export interface Target {
  station: StationDef | null;
  /** 面前的客人（帶位） */
  guest: boolean;
  dist: number;
  usable: boolean;
  /** 和視線方向的對準程度（cos；1＝正前方） */
  align: number;
}

/** 面前（約 ±60°）互動距離內最近的工作站，或面前的客人 */
export function currentTarget(role: Seat, guestAt: [number, number] | null = null): Target | null {
  const [fx, fz] = forwardOf(pose.yaw);
  let best: Target | null = null;
  let bestScore = -Infinity;
  for (const s of STATIONS) {
    const [sx, sz] = stationFront(s, 0.5);
    const dist = Math.hypot(sx - pose.x, sz - pose.z);
    if (dist > INTERACT_RANGE) continue;
    const vx = s.pos[0] - pose.x;
    const vz = s.pos[1] - pose.z;
    const dot = (vx * fx + vz * fz) / (Math.hypot(vx, vz) || 1);
    if (dot < 0.5) continue;
    // 準心對著的優先（兩個工作站並排時，選你看著的那一個），太遠的扣分
    const score = dot * 2 - dist * 0.45;
    if (score > bestScore) {
      bestScore = score;
      best = { station: s, guest: false, dist, usable: roleCanUseStation(role, s), align: dot };
    }
  }
  if (guestAt) {
    const vx = guestAt[0] - pose.x;
    const vz = guestAt[1] - pose.z;
    const d = Math.hypot(vx, vz);
    if (d <= 1.8 && (vx * fx + vz * fz) / (d || 1) > 0.6 && (!best || d < best.dist)) best = { station: null, guest: true, dist: d, usable: true, align: (vx * fx + vz * fz) / (d || 1) };
  }
  return best;
}

/** 最近的工作站（盲區員的指引音） */
export function nearestStation(role: Seat, maxDist: number): { station: StationDef; dist: number; dx: number; dz: number } | null {
  let best: { station: StationDef; dist: number; dx: number; dz: number } | null = null;
  for (const s of STATIONS) {
    if (!roleCanUseStation(role, s)) continue;
    const dx = s.pos[0] - pose.x;
    const dz = s.pos[1] - pose.z;
    const dist = Math.hypot(dx, dz);
    if (dist > maxDist) continue;
    if (!best || dist < best.dist) best = { station: s, dist, dx, dz };
  }
  return best;
}

export function currentZone(): ZoneId | null {
  return zoneAt(pose.x, pose.z)?.id ?? null;
}
