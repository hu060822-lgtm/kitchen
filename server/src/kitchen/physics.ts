import {
  INGREDIENTS,
  PHYSICS,
  SEATS,
  avoidBodies,
  buildColliders,
  forwardOf,
  lineOfSight,
  moveWithCollision,
  puddleAt,
  zoneAt,
  type Body,
  type FlightPublic,
  type Held,
  type KitchenActionResult,
  type PhysicsPublic,
  type PuddleKind,
  type PuddlePublic,
  type Seat,
} from '@last-table/shared';
import type { KitchenSim } from './sim';

/**
 * 簡單的物理（伺服器權威、可重現、會存進存檔）：積水與滑倒、丟東西、人與人的碰撞與衝撞、湯滾出來。
 *
 * 它只碰「位置、手上的東西、地上的東西」——不改任何火候、熟度或評分的規則。
 * 欄位 sim 是指回模擬的參照：存檔時跳過（SIM_SKIP），讀檔時由新的模擬重新指定。
 */

interface Flight extends FlightPublic {
  held: NonNullable<Held>;
  target: Seat | null;
  byRole: Seat;
}

const ok = (message: string): KitchenActionResult => ({ ok: true, message, tone: 'ok' });
const warn = (message: string): KitchenActionResult => ({ ok: false, message, tone: 'warn' });
const r2 = (n: number) => Math.round(n * 100) / 100;

export class Physics {
  puddles: PuddlePublic[] = [];
  flights: Flight[] = [];
  /** 滑倒：到什麼時候之前不能動；多久之內不會再滑 */
  slipUntil: Partial<Record<Seat, number>> = {};
  slipCd: Partial<Record<Seat, number>> = {};
  /** 衝撞的冷卻（「P1>P2」） */
  bumpCd: Record<string, number> = {};
  /** 湯鍋：開大火、滾了多久；上一次溢出來的時間 */
  boilSince: Record<string, number> = {};
  boilLast: Record<string, number> = {};
  private seq = 0;

  constructor(readonly sim: KitchenSim) {}

  /* ------------------------------ 積水 ------------------------------ */

  spill(x: number, z: number, r: number, kind: PuddleKind): PuddlePublic | null {
    const zone = zoneAt(x, z)?.id;
    if (!zone) return null;
    // 跟附近的積水合併（變大一點、重新算乾的時間）
    const near = this.puddles.find((p) => Math.hypot(p.x - x, p.z - z) < p.r + r * 0.5);
    const until = this.sim.t + PHYSICS.puddle.dryMs;
    if (near) {
      near.r = r2(Math.min(1.1, Math.max(near.r, r) + 0.08));
      near.until = until;
      return near;
    }
    const p: PuddlePublic = { id: `w${++this.seq}`, x: r2(x), z: r2(z), r: r2(r), kind, until };
    this.puddles.push(p);
    if (this.puddles.length > PHYSICS.puddle.max) this.puddles.shift();
    return p;
  }

  puddleNear(x: number, z: number, range: number = PHYSICS.puddle.mopRange): PuddlePublic | null {
    let best: PuddlePublic | null = null;
    let bd = Infinity;
    for (const p of this.puddles) {
      const d = Math.hypot(p.x - x, p.z - z) - p.r;
      if (d <= range && d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  /** 擦地的計時動作用：還在這灘水旁邊嗎 */
  nearPuddle(role: Seat, id: string): boolean {
    const pose = this.sim.pose(role);
    const p = this.puddles.find((x) => x.id === id);
    return !!pose && !!p && Math.hypot(p.x - pose.x, p.z - pose.z) - p.r <= PHYSICS.puddle.mopRange + 0.3;
  }

  removePuddle(id: string): boolean {
    const n = this.puddles.length;
    this.puddles = this.puddles.filter((p) => p.id !== id);
    return this.puddles.length < n;
  }

  /* ------------------------------ 每一步 ------------------------------ */

  tick(): void {
    const t = this.sim.t;
    if (this.puddles.some((p) => t >= p.until)) this.puddles = this.puddles.filter((p) => t < p.until);
    // 丟出去的東西落地
    if (this.flights.length) {
      const landed = this.flights.filter((f) => t >= f.t0 + f.ms);
      if (landed.length) {
        this.flights = this.flights.filter((f) => t < f.t0 + f.ms);
        for (const f of landed) this.land(f);
      }
    }
    // 湯滾得太大：溢出來，爐子前面的地上濕了
    for (const s of this.sim.stations.values()) {
      if (s.def.kind !== 'stove') continue;
      const id = s.def.id;
      if (s.heat === 'HIGH' && s.liquid > 0 && s.vessel > 99) {
        this.boilSince[id] ??= t;
        if (t - this.boilSince[id] >= PHYSICS.boilOver.afterMs && t - (this.boilLast[id] ?? -1e9) >= PHYSICS.boilOver.againMs) {
          this.boilLast[id] = t;
          const [fx, fz] = [Math.sin(s.def.facing), Math.cos(s.def.facing)];
          const p = this.spill(s.def.pos[0] + fx * 0.75, s.def.pos[1] + fz * 0.75, 0.6, 'soup');
          if (p) this.sim.emit({ kind: 'boil_over', text: `${s.def.label}滾得太大，湯溢出來了：爐子前面的地上很滑（轉小火；跑過去會滑倒）。`, sound: 'boil', at: [p.x, p.z] }, 'all');
        }
      } else delete this.boilSince[id];
    }
  }

  /* ------------------------------ 移動（房間每收到一次移動就問一次） ------------------------------ */

  /** 滑倒中不能動 */
  frozen(role: Seat): boolean {
    return this.sim.t < (this.slipUntil[role] ?? 0);
  }

  /** 別人的身體（碰撞用） */
  bodies(except: Seat): Body[] {
    const out: Body[] = [];
    for (const s of this.sim.seats) {
      if (s === except || this.sim.players[s].status !== 'ok') continue;
      const p = this.sim.pose(s);
      if (p?.connected) out.push({ x: p.x, z: p.z, r: PHYSICS.bodyRadius });
    }
    return out;
  }

  /**
   * 玩家要從 from 走到 to（速度 speed m/s）：
   *   擠進別人的身體裡（超過寬容）→ block（房間把他拉回去）；
   *   跑步撞到人 → 把對方推開、對方手上的東西晃；
   *   跑步踩到積水 → 滑倒（slide＝滑到的位置；房間直接把他放過去）。
   */
  onMove(role: Seat, fx: number, fz: number, tx: number, tz: number, speed: number): { block?: boolean; slide?: { x: number; z: number; yaw: number } } {
    // 人與人
    for (const other of this.sim.seats) {
      if (other === role || this.sim.players[other].status !== 'ok') continue;
      const op = this.sim.pose(other);
      if (!op?.connected) continue;
      const d0 = Math.hypot(fx - op.x, fz - op.z);
      const d1 = Math.hypot(tx - op.x, tz - op.z);
      const contact = PHYSICS.bodyRadius * 2;
      if (d1 < contact + 0.12 && d1 < d0 && speed > PHYSICS.bump.minSpeed) this.bump(role, other, tx - fx, tz - fz);
      else if (d1 < contact - PHYSICS.bodyTolerance && d1 < d0 - 1e-3) return { block: true };
    }
    // 那位客人：跑步撞上他會被彈回來（他一動也不動）
    const g = this.sim.threats?.guestPos();
    if (g && speed > PHYSICS.bump.minSpeed && Math.hypot(tx - g[0], tz - g[1]) < 0.75 && this.sim.t >= (this.bumpCd[`${role}>guest`] ?? 0)) {
      this.bumpCd[`${role}>guest`] = this.sim.t + PHYSICS.bump.cooldownMs * 2;
      const len = Math.hypot(tx - fx, tz - fz) || 1;
      const back = moveWithCollision(fx, fz, fx - ((tx - fx) / len) * 0.5, fz - ((tz - fz) / len) * 0.5, buildColliders(this.sim.doors));
      this.sim.teleport(role, back.x, back.z, this.sim.pose(role)?.yaw ?? 0);
      this.sim.noise(g[0], g[1], PHYSICS.bump.noise, `bump:${role}`);
      this.sim.flaws.bumpWobble(role);
      this.sim.emit({ kind: 'guest_say', text: '你撞上了那位客人。他冷得像冷藏室的門，一動也不動。', visual: 'bump', sound: 'bump', at: [r2(g[0]), r2(g[1])], critical: true }, role);
      return { block: true };
    }
    // 積水
    const p = puddleAt(this.puddles, tx, tz);
    if (p && speed > PHYSICS.slip.minSpeed && this.sim.t >= (this.slipCd[role] ?? 0) && this.sim.players[role].status === 'ok') {
      return { slide: this.slip(role, tx, tz, tx - fx, tz - fz) };
    }
    return {};
  }

  private slip(role: Seat, x: number, z: number, dx: number, dz: number): { x: number; z: number; yaw: number } {
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const boxes = buildColliders(this.sim.doors);
    const to = moveWithCollision(x, z, x + ux * PHYSICS.slip.distance, z + uz * PHYSICS.slip.distance, boxes);
    const end = avoidBodies(x, z, to.x, to.z, this.bodies(role));
    this.slipUntil[role] = this.sim.t + PHYSICS.slip.ms;
    this.slipCd[role] = this.sim.t + PHYSICS.slip.cooldownMs;
    this.sim.players[role].task = null;
    this.sim.noise(end.x, end.z, PHYSICS.slip.noise, `slip:${role}`);
    const yaw = Math.atan2(-ux, -uz);
    const name = this.sim.name(role);
    // 手上拿的東西（目前用的那隻手）飛出去，落在滑到的地方前面一點
    const held = this.sim.players[role].held;
    if (held && (held.kind === 'item' || held.kind === 'plate')) {
      this.sim.flaws.dropAt(role, end.x + ux * 0.5, end.z + uz * 0.5, `${name}滑倒了`);
    }
    this.sim.emit({ kind: 'phase', text: '你踩到積水，滑倒了！（1 秒後爬起來）', sound: 'slip', visual: 'slip', at: [r2(end.x), r2(end.z)], critical: true }, role);
    for (const s of this.sim.seats) if (s !== role) this.sim.emit({ kind: 'coop', text: `${name}踩到積水滑倒了。`, sound: 'slip', at: [r2(end.x), r2(end.z)], sense: 'sound' }, s);
    return { x: end.x, z: end.z, yaw };
  }

  private bump(role: Seat, other: Seat, dx: number, dz: number): void {
    const key = `${role}>${other}`;
    if (this.sim.t < (this.bumpCd[key] ?? 0)) return;
    this.bumpCd[key] = this.sim.t + PHYSICS.bump.cooldownMs;
    const op = this.sim.pose(other);
    if (!op) return;
    const len = Math.hypot(dx, dz) || 1;
    const boxes = buildColliders(this.sim.doors);
    const to = moveWithCollision(op.x, op.z, op.x + (dx / len) * PHYSICS.bump.push, op.z + (dz / len) * PHYSICS.bump.push, boxes);
    this.sim.teleport(other, to.x, to.z, op.yaw);
    this.sim.noise(op.x, op.z, PHYSICS.bump.noise, `bump:${role}`);
    this.sim.flaws.bumpWobble(other);
    const name = this.sim.name(role);
    this.sim.emit({ kind: 'coop', text: `${name}撞到你了！`, visual: 'bump', sound: 'bump', at: [r2(to.x), r2(to.z)], critical: true }, other);
    this.sim.emit({ kind: 'coop', text: `你撞到了${this.sim.name(other)}。廚房裡別用跑的。`, sound: 'bump', at: [r2(op.x), r2(op.z)] }, role);
  }

  /* ------------------------------ 丟東西 ------------------------------ */

  /** 丟手上的東西：to＝丟給誰（省略＝丟到前面的地上） */
  toss(role: Seat, to: Seat | null): KitchenActionResult {
    const pl = this.sim.players[role];
    const held = pl.held;
    if (!held) return warn('手上沒有東西可以丟。');
    if (held.kind !== 'item') return warn(held.kind === 'plate' ? '盤子不能用丟的：端過去，或放上交接架。' : '這個不能用丟的。');
    const pose = this.sim.pose(role);
    if (!pose) return warn('找不到你的位置。');
    const it = this.sim.items.get(held.id);
    if (!it) return warn('手上沒有東西可以丟。');
    let target: Seat | null = null;
    let land: [number, number];
    if (to && to !== role && SEATS.includes(to)) {
      const tp = this.sim.pose(to);
      if (!tp?.connected || this.sim.players[to].status !== 'ok') return warn('他現在接不了。');
      const d = Math.hypot(tp.x - pose.x, tp.z - pose.z);
      if (d > PHYSICS.toss.range) return warn(`太遠了（最遠 ${PHYSICS.toss.range} 公尺）。`);
      if (!lineOfSight(pose.x, pose.z, tp.x, tp.z, buildColliders(this.sim.doors), 1.6)) return warn('中間有牆，丟不過去。');
      target = to;
      land = [tp.x, tp.z];
    } else {
      const [fx, fz] = forwardOf(pose.yaw);
      const r = moveWithCollision(pose.x, pose.z, pose.x + fx * PHYSICS.toss.floorDistance, pose.z + fz * PHYSICS.toss.floorDistance, buildColliders(this.sim.doors), 0.1);
      land = [r.x, r.z];
    }
    const dist = Math.hypot(land[0] - pose.x, land[1] - pose.z);
    const what = this.sim.describeHeld(held);
    pl.held = null;
    const f: Flight = {
      id: `t${++this.seq}`,
      type: it.type,
      what,
      from: [r2(pose.x), r2(pose.z)],
      to: [r2(land[0]), r2(land[1])],
      t0: this.sim.t,
      ms: Math.round(PHYSICS.toss.baseMs + dist * PHYSICS.toss.perMeterMs),
      by: role,
      byRole: role,
      held,
      target,
    };
    this.flights.push(f);
    if (target) this.sim.emit({ kind: 'coop', text: `${this.sim.name(role)}把${what}丟給你——面向他、空出一隻手就接得住！`, sound: 'toss', at: f.from, critical: true }, target);
    return ok(target ? `把${what}丟給${this.sim.name(target)}。` : `把${what}丟到前面的地上。`);
  }

  private land(f: Flight): void {
    const t = f.target;
    if (t) {
      const tp = this.sim.pose(t);
      const pl = this.sim.players[t];
      if (tp && pl.status === 'ok' && !pl.task && Math.hypot(tp.x - f.to[0], tp.z - f.to[1]) <= PHYSICS.toss.catchRadius) {
        const [fx, fz] = forwardOf(tp.yaw);
        const vx = f.from[0] - tp.x;
        const vz = f.from[1] - tp.z;
        const facing = (vx * fx + vz * fz) / Math.max(1e-6, Math.hypot(vx, vz));
        if (facing >= PHYSICS.toss.facing && this.sim.canReceive(t, f.held)) {
          this.sim.receive(t, f.held);
          this.sim.emit({ kind: 'coop', text: `接住了${f.what}。`, sound: 'catch', visual: 'catch' }, t);
          this.sim.emit({ kind: 'coop', text: `${this.sim.name(t)}接住了。` }, f.byRole);
          return;
        }
      }
      // 沒接到：掉在他腳邊（他移動了就掉在原本瞄準的地方）
      const at = tp && Math.hypot(tp.x - f.to[0], tp.z - f.to[1]) <= PHYSICS.toss.catchRadius ? [tp.x + 0.3, tp.z] : f.to;
      this.sim.flaws.floorPut(f.held, at[0], at[1], f.byRole, f.what, `${this.sim.name(t)}沒接到`);
      return;
    }
    const it = f.held.kind === 'item' ? this.sim.items.get(f.held.id) : undefined;
    this.sim.flaws.floorPut(f.held, f.to[0], f.to[1], f.byRole, f.what, it && INGREDIENTS[it.type] ? '丟到地上' : '掉了');
  }

  /* ------------------------------ 公開狀態 ------------------------------ */

  public(): PhysicsPublic {
    return {
      puddles: this.puddles.map((p) => ({ ...p })),
      flights: this.flights.map(({ held: _h, target: _t, byRole: _b, ...f }) => f),
    };
  }
}
