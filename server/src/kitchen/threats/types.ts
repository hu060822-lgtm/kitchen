import type { Blocker, KitchenEvent, PlayerStatus, Seat, ThreatsPublic } from '@last-table/shared';
import type { PoseView } from '../sim';

/**
 * 恐怖系統（ThreatSystem）能看到、能做的事，刻意只有這些：
 * 玩家的位置與狀態、門的狀態、監視器有沒有人看、把玩家關進鐵籠、送出事件。
 * 它拿不到任何食材、鍋具、訂單或評分（型別上就不存在這些欄位），所以不可能改變料理規則。
 */
export interface ThreatWorld {
  readonly t: number;
  readonly doors: { fire: boolean };
  /** 後門鎖著：後門外的東西進不來（不影響已經在裡面的） */
  readonly backClosed: boolean;
  /** 無盡模式「後門鎖壞了」：監視器鎖不了後門（提示文字改說防火門與置物櫃） */
  readonly backLockBroken?: boolean;
  readonly cctvBy: Seat | null;
  pose(role: Seat): PoseView | null;
  /** 玩家的暱稱（事件文字用） */
  name(role: Seat): string;
  status(role: Seat): PlayerStatus;
  trap(role: Seat): void;
  emit(e: KitchenEvent, to: Seat | 'all'): void;
  /** 在地上留一灘水（怪物身上滴下來的）；只影響地面，不碰料理 */
  spill?(x: number, z: number): void;
}

export interface ThreatSystem {
  tick(dtMs: number, w: ThreatWorld): void;
  /** 廚房裡的聲音（切菜、大火、跑步、回聲…）：怪物會去調查 */
  noise(x: number, z: number, radius: number, source: string): void;
  /** 實體碰撞（站在門口的客人、怪物本身） */
  blockers(): Blocker[];
  public(w: ThreatWorld): ThreatsPublic;
  /** 客人目前的位置（帶位用） */
  guestPos(): [number, number] | null;
  canEscort(): boolean;
  escort(by: Seat, w: ThreatWorld): void;
  /** 玩家躲進置物櫃 */
  onHide(role: Seat, w: ThreatWorld): void;
  debug(): { monster: Record<string, unknown> | null; guest: Record<string, unknown> | null };
  /** 開發者工具：立刻召喚／關閉 */
  command(cmd: 'spawn_guest' | 'guest_off' | 'spawn_monster' | 'monster_off', t: number): void;
  /** 反制（入侵後）：丟中牠會愣住、緊急照明把牠逼走 */
  stunMonster?(x: number, z: number, w: ThreatWorld): boolean;
  repelMonster?(w: ThreatWorld, cause?: 'flash' | 'rifle'): boolean;
  /** 這一班沒有怪物 */
  disableMonster?(): void;
}
