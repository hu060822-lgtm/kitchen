import { TUTORIAL_STEPS, TUTORIAL_STEP_BY_ID, type KitchenActionPayload, type KitchenActionResult, type Seat, type TutorialPublic, type TutorialStepId } from '@last-table/shared';
import { GUEST_SPOTS, type ThreatDirector } from './threats';
import type { KitchenSim } from './sim';

/**
 * 教學關「第一班」的導演：依廚房的實際狀態判定每一步完成了沒有，並在進入某些步驟時安排事件
 * （出一張單、讓那位客人出現、叫後門的東西進來）。
 *
 * 判定都是「做到了沒有」（例如「世界上有一顆被拿出來的蛋」「有一個盤子上有吐司和蛋」），
 * 玩家順序不同、先做了後面的事，前面的步驟會一起過；只有 ack 步驟要玩家確認。
 */

const MONSTER_TIMEOUT_MS = 150_000;
const GUEST_LOOK_MS = 1500;

export class Tutorial {
  idx = 0;
  enteredAt = 0;
  score: number | undefined;
  /** 看著客人的累積時間 */
  watchedMs = 0;
  escortsAtStart = 0;
  sawMonster = false;
  /** 出生點（判斷「走了幾步」） */
  private readonly start: Partial<Record<Seat, [number, number]>> = {};

  get step(): TutorialStepId {
    return TUTORIAL_STEPS[this.idx].id;
  }

  /** 開班時呼叫：直接營業（沒有備料時間）、先關掉威脅 */
  begin(sim: KitchenSim): void {
    sim.skipPrep();
    const th = threatsOf(sim);
    if (th) {
      th.guest.enabled = false;
      th.guest.active = false;
      th.monster.enabled = false;
    }
    for (const r of sim.seats) {
      const p = sim.poseOf(r);
      if (p) this.start[r] = [p.x, p.z];
    }
    this.enteredAt = sim.t;
  }

  public(): TutorialPublic {
    return { step: this.step, index: this.idx, total: TUTORIAL_STEPS.length, ...(this.score !== undefined ? { score: this.score } : {}) };
  }

  /** 玩家確認（讀完說明、打開了訂單板／食譜） */
  ack(sim: KitchenSim, p: KitchenActionPayload): KitchenActionResult {
    const want = String(p.args?.step ?? '');
    const def = TUTORIAL_STEPS[this.idx];
    if (p.action !== 'ack' || def.id !== want || !def.ack) return { ok: false, message: '', tone: 'info' };
    this.advance(sim);
    return { ok: true, message: '', tone: 'info' };
  }

  /** 出餐之後記下分數（教學卡片上顯示） */
  onServed(total: number): void {
    this.score ??= total;
  }

  tick(sim: KitchenSim, dtMs: number): void {
    // 一次可以過好幾步（玩家先做了後面的事）
    for (let guard = 0; guard < TUTORIAL_STEPS.length; guard++) {
      const def = TUTORIAL_STEPS[this.idx];
      if (def.ack || def.id === 'done') break;
      if (!this.check(sim, def.id, dtMs)) break;
      this.advance(sim);
    }
  }

  private advance(sim: KitchenSim): void {
    if (this.idx >= TUTORIAL_STEPS.length - 1) return;
    this.leave(sim, this.step);
    this.idx++;
    this.enteredAt = sim.t;
    this.enter(sim, this.step);
  }

  /** 進入步驟時安排的事件 */
  private enter(sim: KitchenSim, id: TutorialStepId): void {
    const th = threatsOf(sim);
    switch (id) {
      case 'tickets':
        // 第一張單：煎蛋吐司（很有耐心的客人）
        sim.addPlannedOrder({ at: 0, kind: 'signature', recipeId: 'egg_toast', table: 3, patience: 40 });
        break;
      case 'guest_look':
        if (th) {
          // 坐在離旋轉門最近的位子，安靜一陣子（讓玩家走過去看他）
          const s = GUEST_SPOTS[4];
          Object.assign(th.guest, { enabled: true, active: true, idx: 4, x: s.x, z: s.z, yaw: s.yaw, unobservedMs: 0, calmUntil: sim.t + 25_000 });
          sim.emitAll({ kind: 'guest_moved', sense: 'sight', visual: 'guest', text: '餐廳靠門的那張桌子，坐著一位沒有點餐的客人。', at: [s.x, s.z] });
        }
        this.watchedMs = 0;
        break;
      case 'guest_escort':
        if (th) {
          // 示範「沒人看著時他會靠近」：他已經走進廚房了
          const s = GUEST_SPOTS[6];
          Object.assign(th.guest, { enabled: true, active: true, idx: 6, x: s.x, z: s.z, yaw: s.yaw, unobservedMs: 0, calmUntil: 0 });
          this.escortsAtStart = th.guest.escorts;
          sim.emitAll({ kind: 'guest_moved', sense: 'sound', sound: 'steps', text: '有人慢慢走進了廚房。', at: [s.x, s.z] });
        }
        break;
      case 'monster':
        if (th) {
          th.monster.forceEmerge(sim);
          this.sawMonster = false;
        }
        break;
      default:
        break;
    }
  }

  private leave(sim: KitchenSim, id: TutorialStepId): void {
    const th = threatsOf(sim);
    if (!th) return;
    if (id === 'guest_escort') {
      // 他回到座位上，教學接下來不再動
      th.guest.calmUntil = sim.t + 1e9;
    }
    if (id === 'monster') th.monster.banish();
  }

  /** 這一步做到了沒有 */
  private check(sim: KitchenSim, id: TutorialStepId, dtMs: number): boolean {
    const items = [...sim.items.values()];
    const plates = [...sim.plates.values()];
    const has = (type: string) => items.some((i) => i.type === type) || plates.some((p) => p.components.some((c) => c.type === type));
    const th = threatsOf(sim);
    switch (id) {
      case 'move':
        return sim.seats.some((r) => {
          const p = sim.poseOf(r);
          const s = this.start[r];
          return !!p && !!s && Math.hypot(p.x - s[0], p.z - s[1]) >= 2.5;
        });
      case 'fridge':
        return has('egg');
      case 'pantry':
        return has('bread');
      case 'toaster':
        return sim.stations.get('toaster')!.toast !== null || items.some((i) => i.type === 'bread' && Math.max(i.brownA, i.brownB) > 0.05) || plates.some((p) => p.components.some((c) => c.type === 'bread' && Math.max(c.brownA, c.brownB) > 0.05));
      case 'pan':
        return items.some((i) => i.type === 'egg' && i.doneness > 0.05) || plates.some((p) => p.components.some((c) => c.type === 'egg' && c.doneness > 0.05)) || [...sim.stations.values()].some((s) => s.def.kind === 'pan' && s.heat !== 'OFF' && s.items.some((id) => sim.items.get(id)?.type === 'egg'));
      case 'cooked': {
        const toast = (c: { type: string; brownA: number; brownB: number }) => c.type === 'bread' && Math.max(c.brownA, c.brownB) >= 0.45;
        const egg = (c: { type: string; doneness: number }) => c.type === 'egg' && c.doneness >= 1.0;
        const all = [...items, ...plates.flatMap((p) => p.components)];
        return all.some(toast) && all.some(egg);
      }
      case 'plate':
        return plates.some((p) => p.components.some((c) => c.type === 'bread') && p.components.some((c) => c.type === 'egg')) || sim.stats.served > 0;
      case 'season':
        return plates.some((p) => (p.seasoning.salt ?? 0) > 0 && (p.seasoning.pepper ?? 0) > 0) || sim.stats.served > 0;
      case 'serve':
        return sim.stats.served > 0;
      case 'guest_look':
        if (!th) return true;
        if (th.guest.observed) this.watchedMs += dtMs;
        return this.watchedMs >= GUEST_LOOK_MS;
      case 'guest_escort':
        return !th || th.guest.escorts > this.escortsAtStart;
      case 'monster': {
        if (!th) return true;
        if (th.monster.present) this.sawMonster = true;
        const trapped = sim.seats.some((r) => sim.players[r].status === 'trapped');
        if (this.sawMonster && !th.monster.present && !trapped) return true;
        return sim.t - this.enteredAt >= MONSTER_TIMEOUT_MS && !trapped;
      }
      default:
        return false;
    }
  }
}

function threatsOf(sim: KitchenSim): ThreatDirector | null {
  const t = sim.threats as unknown as ThreatDirector | null;
  return t && 'guest' in t && 'monster' in t ? t : null;
}

export const TUTORIAL_IDS = TUTORIAL_STEP_BY_ID;
