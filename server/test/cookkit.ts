import {
  BOIL,
  DT,
  INGREDIENTS,
  analyzeDish,
  coolItem,
  expandMix,
  flipItem,
  heatItem,
  mixKindOf,
  newItem,
  pickMixLead,
  type Cut,
  type DishInput,
  type HeatContact,
  type IngredientId,
  type ItemState,
} from '@last-table/shared';

/** 測試用的小廚房：處理好的食材、會記下鍋時間的鍋子、攪拌碗（全部走同一套料理模型） */

let seq = 0;
/** 一份食材（已經處理好） */
export function item(type: IngredientId, patch: Partial<ItemState> = {}): ItemState {
  const it = newItem(`c${++seq}`, type, 0);
  return Object.assign(it, { washed: true, peeled: true, cutQuality: patch.cut && patch.cut !== 'WHOLE' ? 0.9 : null }, patch);
}
export const cut = (type: IngredientId, c: Cut, patch: Partial<ItemState> = {}) => item(type, { cut: c, ...patch });

/** 一口鍋：記錄下鍋時間，依固定步長加熱 */
export class Pot {
  t = 0;
  readonly items: ItemState[] = [];
  constructor(
    readonly station: string,
    readonly contact: (sinceStir: number) => HeatContact,
  ) {}
  add(...its: ItemState[]): this {
    for (const it of its) {
      it.history.push({ t: this.t, op: `place:${this.station}` });
      this.items.push(it);
    }
    return this;
  }
  private step(flipEvery: number | undefined, i: number): void {
    this.t += DT * 1000;
    for (const it of this.items) heatItem(it, this.contact(0));
    if (flipEvery && i % Math.round(flipEvery / DT) === 0) this.items.forEach(flipItem);
  }
  cook(sec: number, opts: { flipEvery?: number } = {}): this {
    for (let i = 1; i <= Math.round(sec / DT); i++) this.step(opts.flipEvery, i);
    return this;
  }
  /** 看著某樣食材，煮到「剛好熟」區間的某個位置就出鍋（0＝剛熟，1＝快過熟） */
  until(type: IngredientId, frac = 0.3, opts: { flipEvery?: number; max?: number } = {}): this {
    const it = this.items.find((x) => x.type === type)!;
    const [lo, hi] = INGREDIENTS[it.type].heat.done;
    const goal = lo + (hi - lo) * frac;
    for (let i = 1; it.doneness < goal && i < (opts.max ?? 600) / DT; i++) this.step(opts.flipEvery, i);
    return this;
  }
  /** 盛出來（離火後再放涼幾秒） */
  plate(vessel: 'plate' | 'bowl' = 'plate', seasoning: DishInput['seasoning'] = {}, liquid?: number): DishInput {
    for (const it of this.items) for (let i = 0; i < 20; i++) coolItem(it);
    return { vessel, components: this.items.flatMap((x) => expandMix(x)), seasoning, liquid };
  }
}
export const pan = (v = 170) => new Pot('pan_a', () => ({ method: 'pan', vessel: v, mode: 'pan' }));
export const wok = (v = 175) => new Pot('stove_a', () => ({ method: 'pot', vessel: v, mode: 'potDry', sinceStir: 0 }));
export const soup = () => new Pot('stove_a', () => ({ method: 'pot', vessel: BOIL, mode: 'potLiquid' }));
export const oven = (v = 210) => new Pot('oven', () => ({ method: 'oven', vessel: v, mode: 'oven' }));

/** 攪拌碗：拌成一份 */
export function mixed(...its: ItemState[]): ItemState {
  const kind = mixKindOf(its)!;
  const lead = pickMixLead(its, kind)!;
  const parts = its.filter((x) => x !== lead).map(({ history: _h, mix: _m, ...rest }) => rest);
  return { ...lead, mix: { kind, parts, at: { doneness: lead.doneness, brownA: lead.brownA, brownB: lead.brownB } } };
}

export const notesText = (a: ReturnType<typeof analyzeDish>) => a.notes.map((n) => `${n.ok ? '+' : '-'}${n.text}`).join('｜');
