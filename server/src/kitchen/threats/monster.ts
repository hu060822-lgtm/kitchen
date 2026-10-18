import { PHYSICS, SEATS, ZONE_BY_ID, buildColliders, forwardOf, lineOfSight, zoneAt, type Blocker, type Box, type MonsterMode, type MonsterPublic, type Seat } from '@last-table/shared';
import { NAV_BY_ID, clearSegment, findPath, gridPath, nearestNode, nearestWalkable } from './nav';
import type { ThreatWorld } from './types';

/**
 * 冷藏室的東西（會進廚房的怪物）。
 *
 * 行為狀態（每一個轉換都有明確條件，測試逐一驗證）：
 *   dormant（在後門外）──飢餓值滿──▶ patrol（巡邏後場，會繞進廚房的爐台一帶）
 *   patrol ──聽到聲音──▶ investigate（走到聲源，停 3 秒張望）──沒發現──▶ patrol
 *   patrol／investigate／search ──看見玩家──▶ chase
 *   chase：鎖定目標。看得到時直接衝過去；短暫看不到（轉角、櫃台後）仍知道目標在哪裡，最多 4 秒
 *   chase ──距離 1.2 m 內──▶ windup（0.9 秒的預備動作，有聲音與畫面預警）
 *   windup ──目標還在 1.5 m 內──▶ 抓走（關進冷藏室的鐵籠）──▶ leave（回後門外，飽足一段時間）
 *   windup ──目標逃開──▶ chase；chase ──看不見 4 秒──▶ search（到最後知道的位置，再往附近幾個點找，共 6 秒）──▶ patrol
 *   擺脫鎖定：躲進置物櫃、跑進餐廳、關上防火門，或拉開距離讓牠 4 秒看不到你。
 *   patrol 太久沒有發現 ──▶ leave ──▶ dormant
 *   在廚房裡最多待 30 秒（只算在廚房區域的時間，後場不算）：剩 5 秒低吼預警，時間到轉身回後門（撲抓中的那一下會先做完）
 *   後場（後走廊、側走廊、冷藏室、乾貨室）最多晃 75 秒（從進門算起），之後也會離開
 *   防火門關著、牠在後走廊或側走廊（防火門外側）──▶ bang（走到門前撞門 2.5 秒）──▶ leave（這次放棄）
 *   後門鎖著：後門外的東西進不來（飢餓值照樣累積，門一開就進來）
 *
 * 察覺方式：
 *   視線：視野 110°，距離依照明（廚房 10 m、餐廳 6 m、後場 4.5 m），蹲下時只有 60%；牆會擋住視線，
 *         櫃台這類矮家具不會；1.5 m 內不論方向都會察覺。躲在置物櫃裡的人看不到。
 *   聽覺：切菜、大火、丟垃圾、跑步、盲區員的回聲……每種聲音有固定的半徑。
 * 飢餓值：在後門外時每秒 +1，廚房裡的聲音也會增加；越吵越快出現。
 * 不會瞬間殺人：一定有 0.9 秒的預警，也一定有逃脫的機會（跑步比牠的追逐速度快）。
 *
 * 移動：用細格子 A*（nav.ts 的 gridPath），起點永遠是牠現在的位置，路徑和家具保持距離並拉直；
 * 每秒檢查一次有沒有在前進，沒有就重新規劃（第二次還卡住就先退到旁邊的空地）。張望是左右擺頭，不會原地轉圈。
 */

export const MONSTER = {
  speed: { patrol: 1.8, investigate: 2.2, chase: 3.1, search: 1.8, leave: 2.2 },
  fovCos: Math.cos((70 * Math.PI) / 180),
  sight: { bright: 12, dim: 8, dark: 6 } as Record<'bright' | 'dim' | 'dark', number>,
  crouch: 0.6,
  notice: 1.8,
  loseSightMs: 4000,
  /** 鎖定後，短暫看不到時仍然知道目標位置的距離上限 */
  lockRange: 40,
  /** 追逐時重新規劃路徑的間隔 */
  repathMs: 300,
  /** 轉身速度（弧度／秒）：畫面上不會瞬間轉向 */
  turnRate: 12,
  /** 張望時左右擺頭的幅度（弧度） */
  lookSweep: 1.0,
  searchMs: 6000,
  investigateWaitMs: 3000,
  windupMs: 1000,
  windupRange: 1.2,
  grabRange: 1.4,
  hungerEnter: 110,
  /** 每個噪音事件讓飢餓值增加：半徑 × 這個係數 */
  hungerPerNoise: 1.2,
  patrolMaxMs: 75_000,
  /** 進廚房前在後門外刮門的時間：這段時間裡鎖上後門（監視器）就進不來 */
  warnMs: 6_000,
  /** 每次進來最多待多久（從進門算起，不分區域），時間到從後門離開 */
  stayMs: 40_000,
  /** 追同一個人最多多久，之後換追另一個（最近的） */
  switchMs: 20_000,
  /** 離開前多久預警 */
  stayWarnMs: 5_000,
  /** 在防火門前撞門多久 */
  bangMs: 2_500,
  /** 被防火門擋回去之後的飢餓值 */
  repelled: -15,
  /** 後門鎖著時，飢餓值最多累積到這裡 */
  hungerCap: 150,
  /** 抓到人之後的飢餓值（負數＝要更久才會再出現） */
  sated: -30,
  hiddenWaitMs: 4000,
  /** 被丟中愣住多久 */
  stunMs: 3000,
  /** 緊急照明把牠逼走後的飢餓值（要更久才會再來） */
  flashed: -40,
} as const;

/** 巡邏路線：後走廊 → 冷藏室 → 廚房的爐台一帶 → 乾貨室 → 側走廊 → 防火門內側 */
export const PATROL = ['BD', 'HN1', 'HN2', 'HN3', 'CH', 'C1', 'C2', 'C3', 'KCD', 'K1', 'K2', 'KDD', 'D3', 'D2', 'D1', 'HN1', 'BD', 'HE1', 'HE2', 'KFD', 'K3', 'KFD', 'HE2', 'HE1'];

interface Noise {
  x: number;
  z: number;
  r: number;
  src: string;
}

const yawToward = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

/**
 * 每晚的變化（連續七晚）：倍率都是 1＝原本的規則。
 *   hunger＜1＝比較快想進來；noise＞1＝對聲音更敏感；stay＞1＝在廚房待比較久；
 *   speed＞1＝走得比較快；loseSight＞1＝追同一個人比較久才換人（原本 20 秒）；
 *   returnHunger：自己待太久離開之後的飢餓值（比 0 高＝比較快回來）。
 */
export interface MonsterTune {
  hunger: number;
  noise: number;
  stay: number;
  speed: number;
  loseSight: number;
  returnHunger: number;
}
export const DEFAULT_MONSTER_TUNE: MonsterTune = { hunger: 1, noise: 1, stay: 1, speed: 1, loseSight: 1, returnHunger: 0 };

export class Monster {
  mode: MonsterMode = 'dormant';
  x = NAV_BY_ID.OUT.x;
  z = NAV_BY_ID.OUT.z;
  yaw = -Math.PI / 2;
  hunger = 0;
  modeSince = 0;
  target: Seat | null = null;
  lastSeen: { x: number; z: number; t: number } | null = null;
  goal: { x: number; z: number } | null = null;
  path: Array<{ x: number; z: number }> = [];
  patrolIdx = 0;
  waitUntil = 0;
  lastRepath = 0;
  /** 目前路徑的終點（卡住時重新規劃用） */
  dest: { x: number; z: number } | null = null;
  /** 卡住偵測 */
  private progress = { x: 0, z: 0, t: 0, stuck: 0 };
  /** 張望的基準方向 */
  private lookBase = 0;
  /** 搜索時要走過的附近幾個點 */
  private searchPts: Array<{ x: number; z: number }> = [];
  /** 目前知道的目標位置（看得到＝實際位置；鎖定中看不到也會更新） */
  known: { x: number; z: number } | null = null;
  private fireOpen = true;
  private pauseUntil = 0;
  /** 牠親眼看到躲進置物櫃的人 */
  sawHide: { role: Seat; x: number; z: number } | null = null;
  enabled = true;
  /** 這一晚的變化（存檔時一起保存） */
  tune: MonsterTune = { ...DEFAULT_MONSTER_TUNE };
  /** 這次在廚房裡還能待多久（毫秒；沒在場＝Infinity） */
  kitchenLeft = Infinity;
  /** 這次進門的時間 */
  enteredAt = 0;
  /** 在後門外刮門：到這個時間就進來 */
  lurkUntil = 0;
  /** 開始追目前這個目標的時間（追滿 20 秒換人） */
  targetSince = 0;
  /** 這次進來抓到過人（離開時飢餓值比較低） */
  grabbed = false;
  /** 上一次滴水的時間 */
  lastDrip = 0;
  /** 被東西砸中：愣住到這個時間 */
  stunUntil = 0;
  /** 最近一次 tick 的時間（快照用） */
  now = 0;
  private stayWarned = false;
  private noises: Noise[] = [];
  /** 最近一次的轉換原因（開發者工具與測試用） */
  lastTransition = '';

  /** 在場（在後門外刮門的時候還不算） */
  get present(): boolean {
    return this.mode !== 'dormant' && this.mode !== 'lurk';
  }

  noise(x: number, z: number, r: number, src: string): void {
    this.noises.push({ x, z, r, src });
    if (this.noises.length > 32) this.noises.shift();
  }

  private colliders(w: ThreatWorld): Box[] {
    return buildColliders(w.doors);
  }

  private setMode(m: MonsterMode, t: number, why: string): void {
    this.mode = m;
    this.modeSince = t;
    this.lastTransition = `${m}：${why}`;
  }

  /* ------------------------------ 移動 ------------------------------ */

  /** 規劃到某一點的路徑（經由路網） */
  private routeTo(x: number, z: number, w: ThreatWorld): void {
    this.fireOpen = w.doors.fire;
    this.dest = { x, z };
    const grid = gridPath({ x: this.x, z: this.z }, { x, z }, w.doors.fire);
    if (grid) {
      this.path = grid;
      return;
    }
    const boxes = this.colliders(w);
    const from = nearestNode(this.x, this.z, boxes);
    const to = nearestNode(x, z, boxes);
    const ids = findPath(from.id, to.id, w.doors.fire);
    if (!ids) {
      this.path = [];
      return;
    }
    this.path = ids.map((id) => ({ x: NAV_BY_ID[id].x, z: NAV_BY_ID[id].z }));
    // 終點不在節點上：最後一段直接走過去（路網保證最後一個節點與終點之間看得到）
    if (Math.hypot(to.x - x, to.z - z) > 0.2) this.path.push({ x, z });
    // 已經在第一個節點附近就跳過
    if (this.path.length > 1 && Math.hypot(this.path[0].x - this.x, this.path[0].z - this.z) < 0.6) this.path.shift();
  }

  private routeToNode(id: string, w: ThreatWorld): void {
    const n = NAV_BY_ID[id];
    this.routeTo(n.x, n.z, w);
  }

  /** 平滑轉向某個方向 */
  private turnToward(yaw: number, dtMs: number): void {
    let d = yaw - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const max = (MONSTER.turnRate * dtMs) / 1000;
    this.yaw += Math.abs(d) <= max ? d : Math.sign(d) * max;
  }

  /** 左右擺頭張望（不會原地轉圈） */
  private lookAround(t: number, dtMs: number): void {
    this.turnToward(this.lookBase + Math.sin(t / 650) * MONSTER.lookSweep, dtMs);
  }

  /**
   * 卡住偵測：有路要走、卻 1 秒內幾乎沒有前進 → 從目前位置重新規劃；
   * 連續兩次 → 先退到附近的空地再走。回傳是否處理了卡住。
   */
  private unstick(t: number, w: ThreatWorld): boolean {
    if (!this.path.length) {
      this.progress = { x: this.x, z: this.z, t, stuck: 0 };
      return false;
    }
    if (t - this.progress.t < 1000) return false;
    const moved = Math.hypot(this.x - this.progress.x, this.z - this.progress.z);
    const stuck = moved < 0.3 ? this.progress.stuck + 1 : 0;
    this.progress = { x: this.x, z: this.z, t, stuck };
    if (!stuck) return false;
    const dest = this.dest ?? this.path[this.path.length - 1];
    if (stuck >= 2) {
      const a = this.yaw + Math.PI + (stuck % 2 ? 0.8 : -0.8);
      const side = nearestWalkable(this.x - Math.sin(a), this.z - Math.cos(a), w.doors.fire, 1.5);
      this.routeTo(dest.x, dest.z, w);
      if (side) this.path.unshift(side);
    } else this.routeTo(dest.x, dest.z, w);
    this.lastTransition = `${this.mode}：卡住了，重新找路（第 ${stuck} 次）`;
    return true;
  }

  /** 沿路徑前進；回傳是否到達終點 */
  private walk(speed: number, dtMs: number): boolean {
    let budget = (speed * dtMs) / 1000;
    let faced = false;
    while (budget > 0 && this.path.length) {
      const p = this.path[0];
      const dx = p.x - this.x;
      const dz = p.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) {
        this.path.shift();
        continue;
      }
      if (!faced) {
        this.turnToward(yawToward(dx, dz), dtMs);
        faced = true;
      }
      if (d <= budget) {
        this.x = p.x;
        this.z = p.z;
        budget -= d;
        this.path.shift();
      } else {
        this.x += (dx / d) * budget;
        this.z += (dz / d) * budget;
        budget = 0;
      }
    }
    return this.path.length === 0;
  }

  /** 目前能不能直接看到（並感覺到）鎖定的目標：鎖定後不需要在視野內，只看牆有沒有擋住 */
  private canTrack(target: Seat, w: ThreatWorld): boolean {
    const p = w.pose(target);
    if (!p || w.status(target) !== 'ok') return false;
    const zone = zoneAt(p.x, p.z);
    if (!zone || zone.id === 'DINING') return false;
    return Math.hypot(p.x - this.x, p.z - this.z) <= MONSTER.lockRange;
  }

  /* ------------------------------ 察覺 ------------------------------ */

  /** 看得見的玩家（最近的一位） */
  private spot(w: ThreatWorld): Seat | null {
    const boxes = this.colliders(w);
    const [fx, fz] = forwardOf(this.yaw);
    let best: Seat | null = null;
    let bd = Infinity;
    for (const r of SEATS) {
      if (w.status(r) !== 'ok') continue;
      const p = w.pose(r);
      if (!p || !p.connected) continue;
      const zone = zoneAt(p.x, p.z);
      if (!zone || zone.id === 'DINING') continue;
      const dx = p.x - this.x;
      const dz = p.z - this.z;
      const d = Math.hypot(dx, dz);
      const range = MONSTER.sight[ZONE_BY_ID[zone.id].light] * (p.crouch ? MONSTER.crouch : 1);
      if (d > Math.max(range, MONSTER.notice)) continue;
      const inFov = d <= MONSTER.notice || (dx * fx + dz * fz) / (d || 1) >= MONSTER.fovCos;
      if (!inFov) continue;
      if (!lineOfSight(this.x, this.z, p.x, p.z, boxes)) continue;
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    return best;
  }

  /** 處理這一步聽到的聲音；回傳最近的一個 */
  private heard(): Noise | null {
    let best: Noise | null = null;
    let bd = Infinity;
    for (const n of this.noises) {
      const d = Math.hypot(n.x - this.x, n.z - this.z);
      if (d <= n.r && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  /* ------------------------------ 主迴圈 ------------------------------ */

  tick(dtMs: number, w: ThreatWorld): void {
    const t = w.t;
    this.now = t;
    const noises = this.noises;
    this.noises = [];
    if (!this.enabled) return;

    if (this.mode === 'dormant') {
      this.hunger += dtMs / 1000;
      for (const n of noises) this.hunger += n.r * MONSTER.hungerPerNoise * this.tune.noise;
      // 後門鎖著：進不來（但越等越餓，門一開就開始刮門）
      if (w.backClosed) {
        this.hunger = Math.min(this.hunger, MONSTER.hungerCap);
        return;
      }
      if (this.hunger >= MONSTER.hungerEnter * this.tune.hunger) this.startLurk(w);
      return;
    }

    // 後門外刮門 6 秒：這段時間鎖上後門就進不來
    if (this.mode === 'lurk') {
      if (w.backClosed) {
        this.setMode('dormant', t, '後門鎖上了');
        this.hunger = MONSTER.repelled;
        w.emit({ kind: 'monster_sound', sense: 'sound', sound: 'door_slam', text: '後門被撞了兩下……鎖住了。門外的東西走開了。', at: [NAV_BY_ID.BD.x, NAV_BY_ID.BD.z] }, 'all');
        return;
      }
      if (t >= this.lurkUntil) this.emerge(w);
      return;
    }

    // 每次最多待 60 秒（從進門算起）：剩 5 秒低吼預警，時間到從後門離開（撲抓那一下先做完；撞門會自己離開）
    if (this.mode !== 'leave' && this.mode !== 'bang' && this.mode !== 'windup') {
      this.kitchenLeft -= dtMs;
      if (!this.stayWarned && this.kitchenLeft <= MONSTER.stayWarnMs) {
        this.stayWarned = true;
        w.emit({ kind: 'monster_sound', sense: 'sound', sound: 'growl', text: '牠低吼了一聲……快要回後門外了。', at: [this.x, this.z] }, 'all');
      }
      if (this.kitchenLeft <= 0) {
        w.emit({ kind: 'monster_sound', text: '牠轉身，拖著腳步往後門走了。', at: [this.x, this.z] }, 'all');
        return this.startLeave(w, '待滿時間', this.grabbed ? MONSTER.sated : this.tune.returnHunger);
      }
    }

    // 被丟中：愣在原地（撲抓也中斷）
    if (t < this.stunUntil) {
      if (this.mode === 'windup') this.setMode('chase', t, '被砸中');
      return;
    }

    // 牠身上是濕的：在廚房、冷藏室、乾貨室裡每隔幾秒滴下一灘水（跑過去會滑倒）
    if (t - this.lastDrip >= PHYSICS.monsterDripMs) {
      this.lastDrip = t;
      const z = zoneAt(this.x, this.z)?.id;
      if (z === 'KITCHEN' || z === 'COLD' || z === 'DRY') w.spill?.(this.x, this.z);
    }

    // 防火門關著、牠在防火門外側（後走廊、側走廊）：去撞門，然後放棄
    if (!w.doors.fire && this.mode !== 'leave' && this.mode !== 'bang' && this.mode !== 'windup' && this.outsideFireDoor()) {
      const tp = this.mode === 'chase' && this.target ? w.pose(this.target) : null;
      const chasingHere = tp && (zoneAt(tp.x, tp.z)?.id === 'HALL_N' || zoneAt(tp.x, tp.z)?.id === 'HALL_E');
      if (!chasingHere) return this.startBang(w);
    }

    switch (this.mode) {
      // 沒有追得到的人（都躲起來、都在餐廳、都被抓了）：在後場與廚房晃，一有人出現就追
      case 'patrol':
      case 'investigate':
      case 'search': {
        const next = this.pickTarget(w, null);
        if (next) return this.startChase(next, w, true);
        if (this.mode !== 'patrol') this.setMode('patrol', t, '沒有目標');
        if (!this.path.length) {
          this.patrolIdx = (this.patrolIdx + 1) % PATROL.length;
          this.routeToNode(PATROL[this.patrolIdx], w);
        }
        if (!this.unstick(t, w)) this.walk(MONSTER.speed.patrol * this.tune.speed, dtMs);
        return;
      }
      case 'chase': {
        let target = this.target;
        // 目標躲起來、跑進餐廳、被抓、斷線 → 換追最近的另一個人
        if (!target || !this.valid(target, w)) {
          const next = this.pickTarget(w, target);
          if (!next) {
            this.target = null;
            this.setMode('patrol', t, '追不到任何人');
            this.path = [];
            return;
          }
          this.startChase(next, w, false);
          target = next;
        } else if (t - this.targetSince >= MONSTER.switchMs * this.tune.loseSight) {
          // 追滿 20 秒：換追另一個最近的人（只剩一個人就繼續追他）
          const next = this.pickTarget(w, target);
          if (next && next !== target) {
            this.startChase(next, w, false);
            target = next;
          } else this.targetSince = t;
        }
        const p = w.pose(target)!;
        this.lastSeen = { x: p.x, z: p.z, t };
        this.known = { x: p.x, z: p.z };
        const d = Math.hypot(p.x - this.x, p.z - this.z);
        if (d <= MONSTER.windupRange && lineOfSight(this.x, this.z, p.x, p.z, this.colliders(w))) {
          this.setMode('windup', t, '撲向目標');
          this.path = [];
          this.yaw = yawToward(p.x - this.x, p.z - this.z);
          w.emit({ kind: 'monster_roar', sense: 'sound', sound: 'screech', at: [this.x, this.z] }, 'all');
          w.emit({ kind: 'monster_roar', sense: 'sight', visual: 'lunge', at: [this.x, this.z] }, 'all');
          return;
        }
        // 牠知道最近的人在哪裡（靠聲音和氣味）：中間沒有東西就直接衝過去，否則找路
        if (clearSegment(this.x, this.z, p.x, p.z, w.doors.fire)) {
          this.path = [{ x: p.x, z: p.z }];
          this.dest = { x: p.x, z: p.z };
        } else if (t - this.lastRepath >= MONSTER.repathMs || !this.path.length || w.doors.fire !== this.fireOpen) {
          this.lastRepath = t;
          this.routeTo(p.x, p.z, w);
        }
        if (!this.unstick(t, w)) this.walk(MONSTER.speed.chase * this.tune.speed, dtMs);
        if (!this.path.length) this.turnToward(yawToward(p.x - this.x, p.z - this.z), dtMs);
        return;
      }
      case 'windup': {
        if (t - this.modeSince < MONSTER.windupMs) return;
        const target = this.target;
        const p = target ? w.pose(target) : null;
        if (target && p && w.status(target) === 'ok' && Math.hypot(p.x - this.x, p.z - this.z) <= MONSTER.grabRange) {
          w.trap(target);
          this.grabbed = true;
          w.emit({ kind: 'monster_grab', role: target, text: `${w.name(target)}被拖進冷藏室了！去鐵籠救人。`, sound: 'drag', visual: 'grab', at: [this.x, this.z], critical: true }, 'all');
          // 時間還沒到：接著追最近的另一個人
          const next = this.pickTarget(w, target);
          if (next) return this.startChase(next, w, false);
          this.target = null;
          this.setMode('patrol', t, `抓走${target}，沒有別人了`);
          this.path = [];
          return;
        }
        this.setMode('chase', t, '目標逃開了');
        return;
      }
      case 'bang': {
        if (this.path.length) {
          if (!this.unstick(t, w)) this.walk(MONSTER.speed.chase * this.tune.speed, dtMs);
          if (!this.path.length) {
            this.waitUntil = t + MONSTER.bangMs;
            this.yaw = Math.PI; // 面向防火門（-z）
          }
          return;
        }
        if (!this.waitUntil) this.waitUntil = t + MONSTER.bangMs;
        // 撞門聲：全隊都聽得到，看得見的人看到防火門在震
        if (Math.floor((t - this.modeSince) / 800) !== Math.floor((t - dtMs - this.modeSince) / 800)) {
          w.emit({ kind: 'monster_sound', sense: 'sound', sound: 'door_slam', at: [7.95, 19.15] }, 'all');
          w.emit({ kind: 'monster_sound', sense: 'sight', visual: 'shake', at: [7.95, 19.15] }, 'all');
        }
        if (t >= this.waitUntil) {
          w.emit({ kind: 'monster_sound', text: '撞門聲停了：牠放棄了，往後門走。', at: [this.x, this.z] }, 'all');
          return this.startLeave(w, '被防火門擋住', MONSTER.repelled);
        }
        return;
      }
      case 'leave': {
        if (this.walk(MONSTER.speed.leave * this.tune.speed, dtMs)) {
          this.setMode('dormant', t, '回到後門外');
          this.kitchenLeft = Infinity;
          this.target = null;
          this.lastSeen = null;
          this.x = NAV_BY_ID.OUT.x;
          this.z = NAV_BY_ID.OUT.z;
        }
        return;
      }
    }
  }

  /** 追得到的人：在場、沒躲起來、沒被抓、不在餐廳（牠不進餐廳） */
  private valid(r: Seat, w: ThreatWorld): boolean {
    if (w.status(r) !== 'ok') return false;
    const p = w.pose(r);
    if (!p || !p.connected) return false;
    const zone = zoneAt(p.x, p.z);
    return !!zone && zone.id !== 'DINING';
  }

  /** 最近的目標（照實際要走的路算）；avoid＝盡量不要再選這個人（有別人可選時） */
  private pickTarget(w: ThreatWorld, avoid: Seat | null): Seat | null {
    const cands: Array<{ r: Seat; d: number }> = [];
    for (const r of SEATS) {
      if (!this.valid(r, w)) continue;
      const p = w.pose(r)!;
      const route = gridPath({ x: this.x, z: this.z }, { x: p.x, z: p.z }, w.doors.fire);
      let d = Math.hypot(p.x - this.x, p.z - this.z);
      if (route && route.length) {
        d = 0;
        let px = this.x;
        let pz = this.z;
        for (const q of route) {
          d += Math.hypot(q.x - px, q.z - pz);
          px = q.x;
          pz = q.z;
        }
      }
      cands.push({ r, d });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.d - b.d);
    const pick = avoid && cands.length > 1 ? cands.find((c) => c.r !== avoid)! : cands[0];
    return pick.r;
  }

  private startChase(target: Seat, w: ThreatWorld, first: boolean): void {
    const prev = this.target;
    this.target = target;
    this.targetSince = w.t;
    this.path = [];
    this.lastRepath = 0;
    this.setMode('chase', w.t, first ? `追最近的${target}` : `換追${target}`);
    if (first) {
      w.emit({ kind: 'monster_roar', sense: 'sound', sound: 'growl', at: [this.x, this.z] }, 'all');
      w.emit({ kind: 'monster_roar', sense: 'sight', visual: 'charge', at: [this.x, this.z] }, 'all');
    }
    if (prev !== target) w.emit({ kind: 'monster_roar', text: '牠盯上你了！快跑，或躲起來。', sound: 'growl', at: [this.x, this.z], critical: true }, target);
  }

  private startLurk(w: ThreatWorld): void {
    this.setMode('lurk', w.t, '飢餓值滿了：在後門外刮門');
    this.lurkUntil = w.t + MONSTER.warnMs;
    this.x = NAV_BY_ID.OUT.x;
    this.z = NAV_BY_ID.OUT.z;
    w.emit(
      {
        kind: 'monster_sound',
        sound: 'scratch',
        visual: 'flicker',
        text: w.backLockBroken
          ? `後門外有東西在刮門！${MONSTER.warnMs / 1000} 秒後牠會進來——後門的鎖壞了：去關防火門，或躲進置物櫃。`
          : `後門外有東西在刮門！${MONSTER.warnMs / 1000} 秒後牠會進來——快去監視器鎖後門，或關上防火門。`,
        at: [NAV_BY_ID.BD.x, NAV_BY_ID.BD.z],
        critical: true,
      },
      'all',
    );
  }

  /** 搜索：最後知道的位置附近、走得到的 3 個點（左前、右前、背後），每個點停下來張望一下 */
  private planSearch(w: ThreatWorld): void {
    this.searchPts = [];
    for (const da of [1.1, -1.1, Math.PI]) {
      const a = this.yaw + da;
      const [fx, fz] = forwardOf(a);
      const p = nearestWalkable(this.x + fx * 2.8, this.z + fz * 2.8, w.doors.fire, 1.2);
      if (!p) continue;
      const route = gridPath({ x: this.x, z: this.z }, p, w.doors.fire);
      if (route && route.length <= 4) this.searchPts.push(p);
    }
  }

  private heardNoise(noises: Noise[]): Noise | null {
    this.noises = noises;
    const n = this.heard();
    this.noises = [];
    return n;
  }

  private emerge(w: ThreatWorld): void {
    this.x = NAV_BY_ID.OUT.x;
    this.z = NAV_BY_ID.OUT.z;
    this.hunger = 0;
    this.patrolIdx = 0;
    this.grabbed = false;
    this.target = null;
    this.setMode('patrol', w.t, '進門');
    this.kitchenLeft = MONSTER.stayMs * this.tune.stay;
    this.enteredAt = w.t;
    this.stayWarned = false;
    this.routeToNode('BD', w);
    w.emit({ kind: 'monster_sound', sense: 'sound', sound: 'backdoor', text: '後門吱的一聲打開了。牠進來了。', at: [NAV_BY_ID.BD.x, NAV_BY_ID.BD.z] }, 'all');
    w.emit({ kind: 'monster_sound', sense: 'sight', visual: 'flicker', text: '後場的燈閃了一下。', at: [NAV_BY_ID.BD.x, NAV_BY_ID.BD.z] }, 'all');
  }

  private startInvestigate(n: Noise, w: ThreatWorld): void {
    this.setMode('investigate', w.t, `聽到${n.src}`);
    this.goal = { x: n.x, z: n.z };
    this.routeTo(n.x, n.z, w);
    this.waitUntil = w.t + MONSTER.investigateWaitMs;
  }

  private startSearch(w: ThreatWorld, why: string): void {
    this.setMode('search', w.t, why);
    this.waitUntil = 0;
    this.pauseUntil = 0;
    this.searchPts = [];
    const at = this.known ?? this.lastSeen;
    if (at) this.routeTo(at.x, at.z, w);
    else this.path = [];
  }

  private resumePatrol(w: ThreatWorld, why: string): void {
    this.setMode('patrol', w.t, why);
    this.waitUntil = 0;
    // 從最近的巡邏點繼續
    let bi = 0;
    let bd = Infinity;
    PATROL.forEach((id, i) => {
      const n = NAV_BY_ID[id];
      const d = Math.hypot(n.x - this.x, n.z - this.z);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    this.patrolIdx = bi;
    this.routeToNode(PATROL[bi], w);
  }

  /** 牠在防火門外側（後走廊、側走廊） */
  private outsideFireDoor(): boolean {
    const z = zoneAt(this.x, this.z)?.id;
    return z === 'HALL_N' || z === 'HALL_E';
  }

  private startBang(w: ThreatWorld): void {
    this.setMode('bang', w.t, '防火門關著：去撞門');
    this.target = null;
    this.waitUntil = 0;
    // 走到防火門外側的門前（側走廊）
    this.path = [];
    this.routeTo(7.95, 19.75, w);
    w.emit({ kind: 'monster_sound', sense: 'sound', sound: 'growl', text: '防火門外傳來沉重的腳步聲，往門這邊來了。', at: [this.x, this.z] }, 'all');
  }

  private startLeave(w: ThreatWorld, why: string, hunger: number): void {
    this.setMode('leave', w.t, why);
    this.hunger = hunger;
    this.target = null;
    this.known = null;
    this.routeToNode('BD', w);
    this.path.push({ x: NAV_BY_ID.OUT.x, z: NAV_BY_ID.OUT.z });
  }

  /** 反制：被丟過來的東西砸中（落點 1.5 公尺內）→ 愣住 3 秒 */
  stun(x: number, z: number, w: ThreatWorld): boolean {
    if (!this.present || this.mode === 'leave' || Math.hypot(x - this.x, z - this.z) > 1.5) return false;
    this.stunUntil = w.t + MONSTER.stunMs;
    w.emit({ kind: 'monster_sound', sound: 'growl', text: '砸中了！牠愣住了幾秒——快跑。', at: [this.x, this.z], critical: true }, 'all');
    return true;
  }

  /** 反制：緊急照明（監視器）——強光把牠逼回後門，要更久才會再來 */
  repel(w: ThreatWorld): boolean {
    if (!this.present || this.mode === 'leave') return false;
    w.emit({ kind: 'monster_sound', sound: 'growl', visual: 'flash', text: '緊急照明全亮——牠尖叫著退回後門了。', at: [this.x, this.z], critical: true }, 'all');
    this.startLeave(w, '緊急照明', MONSTER.flashed);
    return true;
  }

  /** 玩家躲進置物櫃：如果牠正在追這個人而且看得到，就記住是哪個櫃子 */
  onHide(role: Seat, w: ThreatWorld): void {
    if (this.mode !== 'chase' || this.target !== role) return;
    const p = w.pose(role);
    if (!p) return;
    if (Math.hypot(p.x - this.x, p.z - this.z) <= 6 && lineOfSight(this.x, this.z, p.x, p.z, this.colliders(w))) this.sawHide = { role, x: p.x, z: p.z };
  }

  /** 開發者工具：立刻回到後門外並停用（不會再出現，直到再次叫出） */
  banish(): void {
    this.enabled = false;
    this.mode = 'dormant';
    this.x = NAV_BY_ID.OUT.x;
    this.z = NAV_BY_ID.OUT.z;
    this.hunger = 0;
    this.target = null;
    this.path = [];
    this.kitchenLeft = Infinity;
    this.lastTransition = '開發者工具：離開';
  }

  /** 開發者工具：出現在 (x, z) 面前 0.9 m、鎖定這個人（下一步就會開始撲抓） */
  grabTest(role: Seat, x: number, z: number, yaw: number, t: number): void {
    this.enabled = true;
    const [fx, fz] = forwardOf(yaw);
    this.x = x + fx * 0.9;
    this.z = z + fz * 0.9;
    this.yaw = yawToward(x - this.x, z - this.z);
    this.path = [];
    this.target = role;
    this.lastSeen = { x, z, t };
    this.known = { x, z };
    this.setMode('chase', t, '開發者工具：撲向玩家');
    this.kitchenLeft = MONSTER.stayMs * this.tune.stay;
    this.enteredAt = t;
    this.stayWarned = true;
  }

  forceEmerge(w: ThreatWorld): void {
    this.enabled = true;
    if (this.mode === 'dormant') this.emerge(w);
  }

  blocker(): Blocker | null {
    return this.present ? { id: 'monster', x: this.x, z: this.z, r: 0.42 } : null;
  }

  public(): MonsterPublic {
    return {
      x: Math.round(this.x * 100) / 100,
      z: Math.round(this.z * 100) / 100,
      yaw: Math.round(this.yaw * 100) / 100,
      mode: this.mode,
      present: this.present,
      kitchenLeft: this.present && Number.isFinite(this.kitchenLeft) ? Math.max(0, Math.round(this.kitchenLeft)) : null,
      restless: this.present || this.mode === 'lurk' ? 1 : Math.max(0, Math.min(1, this.hunger / (MONSTER.hungerEnter * this.tune.hunger))),
      warnLeft: this.mode === 'lurk' ? Math.max(0, Math.round(this.lurkUntil - this.now)) : null,
      stunLeft: this.stunUntil > this.now ? Math.round(this.stunUntil - this.now) : null,
    };
  }

  debug(): Record<string, unknown> {
    return { mode: this.mode, x: this.x, z: this.z, hunger: Math.round(this.hunger), target: this.target, last: this.lastTransition, path: this.path.length, kitchenLeft: Number.isFinite(this.kitchenLeft) ? this.kitchenLeft : null };
  }
}

