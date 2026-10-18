/**
 * 席位（Seat）：房間裡的玩家位置，P1–P8。
 *
 * 以前的版本用「盲區員／靜默員／失語員」三個固定角色當作玩家的索引；
 * 改成缺陷卡之後，席位只代表「房間裡的第幾位玩家」，與能力無關。
 * 能力差異全部來自玩家選的缺陷卡（見 flaws.ts），而且同一張卡可以被多人選。
 *
 * 程式裡沿用舊的欄位名稱 `role`（PlayerPublic.role、KitchenEvent.role…），它的值就是席位。
 */

export const SEATS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'] as const;
export type Seat = (typeof SEATS)[number];

export const MAX_PLAYERS = SEATS.length;

export interface SeatInfo {
  role: Seat;
  /** 名牌上的編號 */
  letter: string;
  /** 沒有暱稱時的稱呼 */
  name: string;
  /** 識別色（名牌、標記；介面一律同時顯示編號，不只靠顏色） */
  color: string;
  /** 使用哪一套廚師模型（三套輪流使用） */
  model: 0 | 1 | 2;
}

const COLORS = ['#C5A568', '#A8AAA5', '#E8E5DC', '#8FA7A0', '#C98B6B', '#9C93B5', '#B9B27A', '#7F97B3'];

export const SEAT_INFO = Object.fromEntries(
  SEATS.map((s, i) => [s, { role: s, letter: String(i + 1), name: `${i + 1} 號`, color: COLORS[i], model: (i % 3) as 0 | 1 | 2 } satisfies SeatInfo]),
) as Record<Seat, SeatInfo>;

export const isSeat = (v: unknown): v is Seat => typeof v === 'string' && (SEATS as readonly string[]).includes(v);
