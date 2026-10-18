import type { Blocker, Seat, ThreatsPublic } from '@last-table/shared';
import { Guest } from './guest';
import { Monster } from './monster';
import type { ThreatSystem, ThreatWorld } from './types';

export { Guest, GUEST, GUEST_SPOTS } from './guest';
export { Monster, MONSTER, PATROL } from './monster';
export type { ThreatSystem, ThreatWorld } from './types';

/** 營業開始的時間（模擬時鐘）由 sim 傳入：sim.serviceStart */
interface ServiceClock {
  serviceStart: number;
}

/**
 * ThreatSystem：一位恐怖客人＋一隻會進廚房的怪物。
 * 兩者各自有清楚的行為規則；這裡只負責把它們接到廚房模擬的介面上。
 */
export class ThreatDirector implements ThreatSystem {
  readonly guest = new Guest();
  readonly monster = new Monster();

  tick(dtMs: number, w: ThreatWorld): void {
    const serviceT = w.t - (w as unknown as ServiceClock).serviceStart;
    this.guest.tick(dtMs, w, serviceT);
    this.monster.tick(dtMs, w);
  }

  noise(x: number, z: number, radius: number, source: string): void {
    this.monster.noise(x, z, radius, source);
  }

  blockers(): Blocker[] {
    return [this.guest.blocker(), this.monster.blocker()].filter((b): b is Blocker => !!b);
  }

  public(w: ThreatWorld): ThreatsPublic {
    return { guest: this.guest.public(), monster: this.monster.present ? this.monster.public() : { ...this.monster.public(), present: false }, cctv: !!w.cctvBy };
  }

  guestPos(): [number, number] | null {
    return this.guest.active ? [this.guest.x, this.guest.z] : null;
  }

  canEscort(): boolean {
    return this.guest.canEscort();
  }

  escort(_by: Seat, w: ThreatWorld): void {
    this.guest.escort(w);
  }

  onHide(role: Seat, w: ThreatWorld): void {
    this.monster.onHide(role, w);
  }

  debug() {
    return { monster: this.monster.debug(), guest: this.guest.debug() };
  }

  /** 開發者工具：怪物出現在某人面前並撲上來 */
  grabTest(role: Seat, x: number, z: number, yaw: number, t: number): void {
    this.monster.grabTest(role, x, z, yaw, t);
  }

  command(cmd: 'spawn_guest' | 'guest_off' | 'spawn_monster' | 'monster_off', t: number): void {
    void t;
    if (cmd === 'guest_off') {
      this.guest.enabled = false;
      this.guest.active = false;
    } else if (cmd === 'spawn_guest') {
      this.guest.enabled = true;
      this.guest.active = true;
    } else if (cmd === 'spawn_monster') {
      this.monster.enabled = true;
      this.monster.hunger = 1e6;
    } else {
      this.monster.banish();
    }
  }
}

export const createThreats = (): ThreatSystem => new ThreatDirector();
