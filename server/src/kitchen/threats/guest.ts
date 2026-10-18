import { SEATS, buildColliders, forwardOf, lineOfSight, moveWithCollision, type Blocker, type GuestPublic, type GuestState, type Seat } from '@last-table/shared';
import type { ThreatWorld } from './types';

/**
 * 永遠沒有點餐的人（恐怖客人）。
 *
 * 唯一的規則：**沒有人看著他的時候，他才會動。**
 *   - 「看著」＝看得見的玩家（靜默員、失語員）在 16 m 內、視線沒有被牆擋住、而且他在畫面中央 ±45° 以內；
 *     或者失語員正在看監視器（鏡頭涵蓋餐廳與出餐口）。盲區員看不見，所以「看不住」他，但聽得到他移動的聲音。
 *   - 沒人看著的時間累積滿 7 秒，他就往廚房移近一個位置（座位 → 門口 → 廚房裡 → 出餐口前）；
 *     進到廚房之後，沒人看著時會慢慢走向最近的人，站在旁邊擋路。
 *   - 他不攻擊、不碰任何東西；他的影響只有「人站在那裡」：擋住通道、擋在出餐口前、跟著你。
 *   - 任何人都可以在他旁邊按住 E 兩秒請他回座位（失語員用手勢）。回座後安靜一段時間，
 *     但每請一次，安靜的時間就變短（30 → 22 → 14 → 12 秒）。
 */

export const GUEST = {
  /** 營業開始後多久出現 */
  appearMs: 45_000,
  stepMs: 7000,
  watchRange: 16,
  watchCos: Math.cos(Math.PI / 4),
  followSpeed: 1.0,
  followGap: 1.2,
  sayRange: 2.2,
  sayEveryMs: 9000,
  calmMs: [30_000, 22_000, 14_000, 12_000],
};

interface Spot {
  x: number;
  z: number;
  yaw: number;
  state: GuestState;
}

/** 從最遠的座位一路到出餐口前 */
export const GUEST_SPOTS: readonly Spot[] = [
  { x: -6.6, z: 1.3, yaw: Math.PI, state: 'seated' },
  { x: -1.5, z: 1.3, yaw: Math.PI, state: 'seated' },
  { x: -6.6, z: 7.1, yaw: Math.PI, state: 'seated' },
  { x: -1.5, z: 7.1, yaw: Math.PI, state: 'seated' },
  { x: 3.0, z: 7.1, yaw: Math.PI, state: 'seated' },
  { x: 4.25, z: 9.15, yaw: Math.PI, state: 'doorway' },
  { x: 4.25, z: 10.5, yaw: Math.PI / 2, state: 'kitchen' },
  { x: -1.0, z: 10.3, yaw: 0, state: 'kitchen' },
];

const LINES = ['你們今天還有幾個人上班？', '我在等我的帳單。', '廚房裡面那位，是新來的嗎？', '不用急。我會一直在這裡。', '你剛剛是不是回頭了？'];

/** 每晚的變化：出現時間、沒人看著幾秒移一格、從哪個位子開始、請回座後安靜多久（倍率） */
export interface GuestTune {
  appearMs: number;
  stepMs: number;
  startIdx: number;
  calm: number;
}
export const DEFAULT_GUEST_TUNE: GuestTune = { appearMs: GUEST.appearMs, stepMs: GUEST.stepMs, startIdx: 0, calm: 1 };

export class Guest {
  active = false;
  /** 這一晚的變化（存檔時一起保存） */
  tune: GuestTune = { ...DEFAULT_GUEST_TUNE };
  /** 開發者工具可以關掉（測試時不讓他擋路） */
  enabled = true;
  idx = 0;
  x = GUEST_SPOTS[0].x;
  z = GUEST_SPOTS[0].z;
  yaw = Math.PI;
  moves = 0;
  unobservedMs = 0;
  calmUntil = 0;
  escorts = 0;
  lastSay = -Infinity;
  lineIdx = 0;
  observed = false;
  lastTransition = '';

  get state(): GuestState {
    if (!this.active) return 'gone';
    return GUEST_SPOTS[this.idx].state;
  }

  /** 有沒有人看著他 */
  watchedBy(w: ThreatWorld): Seat | 'cctv' | null {
    if (w.cctvBy) return 'cctv';
    const boxes = buildColliders(w.doors);
    for (const r of SEATS) {
      if (w.status(r) !== 'ok') continue;
      const p = w.pose(r);
      if (!p || !p.connected) continue;
      const dx = this.x - p.x;
      const dz = this.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > GUEST.watchRange) continue;
      const [fx, fz] = forwardOf(p.yaw);
      if (d > 0.3 && (dx * fx + dz * fz) / d < GUEST.watchCos) continue;
      if (!lineOfSight(p.x, p.z, this.x, this.z, boxes)) continue;
      return r;
    }
    return null;
  }

  tick(dtMs: number, w: ThreatWorld, serviceT: number): void {
    if (!this.enabled) return;
    if (!this.active) {
      if (serviceT >= this.tune.appearMs) this.appear(w);
      return;
    }
    const by = this.watchedBy(w);
    this.observed = !!by;
    this.speak(w);
    if (by || w.t < this.calmUntil) return;
    if (this.idx < GUEST_SPOTS.length - 1) {
      this.unobservedMs += dtMs;
      if (this.unobservedMs >= this.tune.stepMs) {
        this.unobservedMs = 0;
        const from: [number, number] = [this.x, this.z];
        this.idx++;
        const s = GUEST_SPOTS[this.idx];
        this.x = s.x;
        this.z = s.z;
        this.yaw = s.yaw;
        this.moves++;
        this.lastTransition = `沒人看著 ${this.tune.stepMs / 1000} 秒，移到 ${this.idx}`;
        w.emit({ kind: 'guest_moved', sense: 'sound', sound: s.state === 'seated' ? 'chair' : 'steps', text: s.state === 'seated' ? '餐廳裡有椅子被拖動。' : '有人慢慢走近廚房。', at: from }, 'all');
      }
      return;
    }
    // 已經在出餐口前：沒人看著時走向最近的人
    this.follow(dtMs, w);
  }

  private follow(dtMs: number, w: ThreatWorld): void {
    let best: { x: number; z: number; d: number } | null = null;
    for (const r of SEATS) {
      if (w.status(r) !== 'ok') continue;
      const p = w.pose(r);
      if (!p || p.z < 9.3) continue;
      const d = Math.hypot(p.x - this.x, p.z - this.z);
      if (!best || d < best.d) best = { x: p.x, z: p.z, d };
    }
    if (!best || best.d <= GUEST.followGap) return;
    const step = Math.min((GUEST.followSpeed * dtMs) / 1000, best.d - GUEST.followGap);
    const nx = this.x + ((best.x - this.x) / best.d) * step;
    const nz = this.z + ((best.z - this.z) / best.d) * step;
    const m = moveWithCollision(this.x, this.z, nx, nz, buildColliders(w.doors), 0.35);
    this.x = m.x;
    this.z = m.z;
    this.yaw = Math.atan2(-(best.x - this.x), -(best.z - this.z));
  }

  private speak(w: ThreatWorld): void {
    if (w.t - this.lastSay < GUEST.sayEveryMs) return;
    for (const r of SEATS) {
      const p = w.pose(r);
      if (!p || w.status(r) !== 'ok') continue;
      if (Math.hypot(p.x - this.x, p.z - this.z) > GUEST.sayRange) continue;
      this.lastSay = w.t;
      const line = LINES[this.lineIdx++ % LINES.length];
      // 說話：只有附近的人收得到（耳背砧板聽不到，也沒有字幕）
      for (const q of SEATS) {
        const qp = w.pose(q);
        if (qp && Math.hypot(qp.x - this.x, qp.z - this.z) <= 5) w.emit({ kind: 'guest_say', text: `穿西裝的客人：「${line}」`, sound: 'murmur', at: [this.x, this.z] }, q);
      }
      return;
    }
  }

  private appear(w: ThreatWorld): void {
    this.active = true;
    this.idx = Math.max(0, Math.min(4, this.tune.startIdx));
    const s = GUEST_SPOTS[this.idx];
    this.x = s.x;
    this.z = s.z;
    this.yaw = s.yaw;
    this.lastTransition = '出現';
    w.emit({ kind: 'guest_moved', sense: 'sight', visual: 'guest', text: this.idx === 0 ? '最遠的那張桌子，坐著一位沒有點餐的客人。' : '那位沒有點餐的客人，今晚坐得更近了。', at: [s.x, s.z] }, 'all');
  }

  canEscort(): boolean {
    return this.active && this.idx > Math.max(0, Math.min(4, this.tune.startIdx));
  }

  escort(w: ThreatWorld): void {
    const calm = Math.round(GUEST.calmMs[Math.min(this.escorts, GUEST.calmMs.length - 1)] * this.tune.calm);
    this.escorts++;
    // 請回座：回到這一晚他一開始坐的位子
    this.idx = Math.max(0, Math.min(4, this.tune.startIdx));
    const s = GUEST_SPOTS[this.idx];
    this.x = s.x;
    this.z = s.z;
    this.yaw = s.yaw;
    this.unobservedMs = 0;
    this.calmUntil = w.t + calm;
    this.lastTransition = `被請回座位（安靜 ${calm / 1000} 秒）`;
  }

  blocker(): Blocker | null {
    if (!this.active || this.idx < 5) return null;
    return { id: 'guest', x: this.x, z: this.z, r: 0.38 };
  }

  public(): GuestPublic | null {
    if (!this.active) return null;
    return { x: Math.round(this.x * 100) / 100, z: Math.round(this.z * 100) / 100, yaw: Math.round(this.yaw * 100) / 100, state: this.state, moves: this.moves };
  }

  debug(): Record<string, unknown> {
    return { active: this.active, idx: this.idx, observed: this.observed, unobservedMs: this.unobservedMs, calmUntil: this.calmUntil, escorts: this.escorts, last: this.lastTransition };
  }
}
