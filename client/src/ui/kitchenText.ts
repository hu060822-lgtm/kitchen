import {
  CUT_LABEL,
  HAND_LABEL,
  isTwoHanded,
  FREE_REQUESTS,
  INGREDIENTS,
  RECIPES,
  SEASONINGS,
  VESSEL_LABEL,
  cookingState,
  describeItem,
  freshnessState,
  FRESHNESS_LABEL,
  type Held,
  type ItemPublic,
  type KitchenPublic,
  type OrderPublic,
  type PlatePublic,
  type Seat,
  type SeasoningId,
  soakLabel,
  MIX_LABEL,
} from '@last-table/shared';

/**
 * 介面文字：食材的外觀、聲音與觸感描述。
 * 數字（溫度、熟度值）不直接顯示——要知道溫度就用溫度計（味覺失調者另外有伺服器推算的預警）。
 * 參數 role 保留給之後依缺陷卡改變描述（例如 Phase C 的小矮人學徒看不見大鍋內部）。
 */

export function senses(_role: Seat): { sight: boolean; sound: boolean } {
  return { sight: true, sound: true };
}

/** 食材的處理狀態（一律可知：自己做過、或摸得出來的事） */
export function prepTags(it: Pick<ItemPublic, 'type' | 'washed' | 'peeled' | 'cut' | 'contaminated'> & { soaked?: number; mix?: ItemPublic['mix'] }): string[] {
  const def = INGREDIENTS[it.type];
  const out: string[] = [];
  if (it.mix) return it.contaminated ? ['碰過生肉的砧板'] : [];
  if (def.needsWash) out.push(it.washed ? '洗過' : '沒洗');
  if (def.needsPeel) out.push(it.peeled ? '去皮' : '帶皮');
  if (it.cut !== 'WHOLE') out.push(CUT_LABEL[it.cut]);
  const soak = soakLabel(it.soaked);
  if (soak) out.push(soak);
  if (it.contaminated) out.push('碰過生肉的砧板');
  return out;
}

export function itemName(it: Pick<ItemPublic, 'type' | 'qty'> & { mix?: ItemPublic['mix'] }): string {
  const def = INGREDIENTS[it.type];
  if (it.mix) return `${MIX_LABEL[it.mix.kind]}（${[def.label, ...it.mix.parts.map((p) => INGREDIENTS[p.type].label)].join('＋')}）`;
  return it.qty > 1 ? `${def.label} ×${it.qty}` : def.label;
}

/** 一行摘要：名稱、處理、新鮮度（看得見的人才看得出來不新鮮） */
export function itemLine(it: ItemPublic, role: Seat): string {
  const tags = prepTags(it);
  const fresh = freshnessState(it);
  void role;
  if (fresh !== 'FRESH') tags.push(FRESHNESS_LABEL[fresh]);
  return tags.length ? `${itemName(it)}（${tags.join('、')}）` : itemName(it);
}

/** 完整的感知描述（外觀／聲音／觸感） */
export function itemSenses(it: ItemPublic, role: Seat, vessel: { temp: number; liquid: boolean } | null): string[] {
  return describeItem({ ...it, history: [] }, senses(role), vessel);
}

/** 給工作站摘要用：簡單的熟度字眼 */
export function itemState(it: ItemPublic, _role: Seat): string {
  if (!it.methods.length && it.doneness < 0.05) return '生的';
  return { RAW: '生的', COOKING: '正在熟', COOKED: '熟了', OVERCOOKED: '過熟', BURNT: '燒焦' }[cookingState(it)];
}

export function heldText(h: Held | undefined, k: KitchenPublic | null, role: Seat): string {
  if (!h) return '空手';
  if (h.kind === 'measure') return `量匙：${SEASONINGS[h.seasoning].label} ${h.units}${h.extra ? `＋${SEASONINGS[h.extra.seasoning].label} ${h.extra.units}` : ''}`;
  if (h.kind === 'crate') return `一箱${h.storage === 'FRIDGE' ? '冷藏' : '乾貨'}`;
  if (h.kind === 'dirty') return `${h.plate + h.bowl} 個髒盤${h.tray ? '（托盤）' : ''}`;
  if (h.kind === 'plate') {
    const p = k?.plates[h.id];
    return p ? plateLine(p) : '盤子';
  }
  const it = k?.items[h.id];
  return it ? itemLine(it, role) : '食材';
}

export function seasoningText(s: Partial<Record<SeasoningId, number>>): string {
  const parts = (Object.entries(s) as Array<[SeasoningId, number]>).filter(([, v]) => v > 0).map(([id, v]) => `${SEASONINGS[id].label} ${Math.round(v * 10) / 10}`);
  return parts.join('、');
}

export function plateLine(p: PlatePublic): string {
  const v = VESSEL_LABEL[p.vessel];
  if (!p.components.length) return `空的${v}`;
  const names = p.components.map((c) => itemName(c)).join('、');
  const seas = seasoningText(p.seasoning);
  return `${v}：${names}${seas ? `；${seas}` : ''}`;
}

export function orderDish(o: Pick<OrderPublic, 'kind' | 'recipeId' | 'requestId' | 'forgotten'>): string {
  if (o.forgotten) return '（想不起來）';
  if ((o as OrderPublic).story && o.recipeId) return `${RECIPES[o.recipeId]?.name ?? '招牌菜'}（蛋黃要軟的）`;
  if (o.kind === 'signature' && o.recipeId) return RECIPES[o.recipeId]?.name ?? '招牌菜';
  return `委託：${(o.requestId && FREE_REQUESTS[o.requestId]?.title) || '主廚委託'}`;
}

export function orderNeed(o: Pick<OrderPublic, 'kind' | 'recipeId' | 'requestId' | 'forgotten'>): string {
  if (o.forgotten) return '想不起來這張單的內容——到出餐口看單，或請隊友覆誦。';
  if (o.kind === 'free' && o.requestId) return `「${FREE_REQUESTS[o.requestId]?.text ?? ''}」`;
  const r = o.recipeId ? RECIPES[o.recipeId] : null;
  return r ? r.steps.join('；') : '';
}

export const fmtSec = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/* ------------------------------ 物品欄（兩隻手＋菜籃） ------------------------------ */

/** 這位玩家兩隻手上的東西（目前的手排前面） */
export function handsOf(k: KitchenPublic | null, role: Seat): NonNullable<Held>[] {
  const p = k?.players[role];
  return [p?.held, p?.other].filter((h): h is NonNullable<Held> => !!h);
}

/** 有沒有一隻手拿著這種東西（伺服器會自動換到那隻手） */
export function holding(k: KitchenPublic | null, role: Seat, kind: NonNullable<Held>['kind']): boolean {
  return handsOf(k, role).some((h) => h.kind === kind);
}

/** 單手廚師只有一隻手 */
export const oneHanded = (k: KitchenPublic | null): boolean => k?.self?.flaw === 'D09';

/** 再也拿不下新東西（兩隻手都滿、或拿著要用雙手的東西、或單手廚師手上有東西） */
export function handsFull(k: KitchenPublic | null, role: Seat): boolean {
  const p = k?.players[role];
  if (!p?.held) return false;
  if (isTwoHanded(p.held) || oneHanded(k)) return true;
  return !!p.other;
}

/** 兩隻手都空著（貨箱、一疊髒盤要用雙手） */
export const bothFree = (k: KitchenPublic | null, role: Seat): boolean => !k?.players[role]?.held && !k?.players[role]?.other;

/** 兩隻手的文字（面板標題用） */
export function handsText(k: KitchenPublic | null, role: Seat): string {
  const p = k?.players[role];
  if (!p) return '空手';
  if (isTwoHanded(p.held)) return `雙手：${heldText(p.held, k, role)}`;
  const cur = `${HAND_LABEL[p.side]}：${heldText(p.held, k, role)}`;
  if (oneHanded(k)) return cur;
  const other = p.other ? `${HAND_LABEL[p.side === 'R' ? 'L' : 'R']}：${heldText(p.other, k, role)}` : '';
  return other ? `${cur}・${other}` : cur;
}

/** 桌號（第七晚那位客人的桌子叫「最後一桌」） */
export const tableLabel = (o: Pick<OrderPublic, 'table' | 'story'>): string => (o.story ? '最後一桌' : `#${o.table}`);
