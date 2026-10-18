import type { StationDef } from '../level';
import type { HeatLevel } from './model';
import type { DishCount, Held } from './types';

/**
 * 快速操作（不用打開面板）：注視工作站時
 *   滑鼠左鍵＝拿／放（手上有東西就放上去，空手就拿起來）
 *   滑鼠右鍵＝使用（清洗、開關火、開始烤、攪拌、拿新盤子……）
 * 需要選擇的事（選切法、選調味料、選食材種類、設定烤箱溫度、監視器）會打開面板。
 *
 * 伺服器與用戶端用同一個判斷：伺服器據此真的執行；用戶端只用來在準星旁顯示「左鍵／右鍵會做什麼」。
 */

export type QuickMode = 'primary' | 'use';

/** 判斷需要的工作站狀態（伺服器的執行期資料與用戶端的快照都有這些欄位） */
export interface QuickStation {
  items: readonly string[];
  plates: readonly string[];
  heat?: HeatLevel;
  toast?: unknown;
  dirty?: DishCount;
  liquid?: number;
  crate?: unknown;
}

export interface QuickMe {
  held: Held;
  other: Held;
  basket: readonly string[];
  status: string;
}

export type QuickPlan =
  /** 執行這個動作；first＝先做這一步（裝盤區沒有盤子時先拿一個） */
  | { kind: 'act'; action: string; args?: Record<string, unknown>; label: string; first?: { action: string; args?: Record<string, unknown> } }
  /** 要選擇的事：打開面板 */
  | { kind: 'panel'; label: string }
  /** 現在不能做 */
  | { kind: 'none'; label: string };

const act = (action: string, label: string, args?: Record<string, unknown>, first?: { action: string; args?: Record<string, unknown> }): QuickPlan => ({ kind: 'act', action, label, args, first });
const panel = (label: string): QuickPlan => ({ kind: 'panel', label });
const none = (label: string): QuickPlan => ({ kind: 'none', label });

export function planQuick(mode: QuickMode, def: StationDef, s: QuickStation, me: QuickMe, openOrders: number, ctx: { monsterIn?: boolean } = {}): QuickPlan {
  const h = me.held;
  const item = h?.kind === 'item' || me.other?.kind === 'item' || me.basket.length > 0;
  const plate = h?.kind === 'plate' || me.other?.kind === 'plate';
  const has = s.items.length > 0;
  const k = def.kind;

  if (k === 'locker') return me.status === 'hidden' ? act('leave', '出來') : act('hide', '躲進去');
  if (k === 'cage') return act('rescue', '撬開鐵籠');

  if (mode === 'use') {
    switch (k) {
      case 'sink':
        if (has) return act('wash', '清洗');
        if ((s.dirty?.plate ?? 0) + (s.dirty?.bowl ?? 0) > 0) return act('wash_dishes', '洗碗盤');
        break;
      case 'pan':
        // 開著火、鍋裡有東西：翻面（關火按 1）
        if (has && s.heat && s.heat !== 'OFF') return act('flip', '翻面');
        return s.heat && s.heat !== 'OFF' ? act('heat', '關火', { level: 'OFF' }) : act('heat', '開中火', { level: 'MED' });
      case 'stove':
        if ((has || (s.liquid ?? 0) > 0) && s.heat && s.heat !== 'OFF') return act('stir', '攪拌');
        return s.heat && s.heat !== 'OFF' ? act('heat', '關火', { level: 'OFF' }) : act('heat', '開中火', { level: 'MED' });
      case 'toaster':
        if (has && !s.toast) return act('start', '開始烤（3 段）', { level: 3 });
        break;
      case 'mixer':
        if (has) return act('mix', '攪拌');
        break;
      case 'plating':
        return act('new_plate', '拿一個盤子', { vessel: 'plate' });
      case 'prep':
        if (has) return act('quick_chop', '切（自動）');
        break;
      case 'oven':
        return s.heat && s.heat !== 'OFF' ? act('heat', '關烤箱', { level: 'OFF' }) : act('heat', '預熱 210°C', { level: 'MED' });
      case 'spice':
        return panel('量調味料');
      case 'cctv':
        return ctx.monsterIn ? act('flash', '緊急照明（逼退牠）') : act('back_door', '鎖後門');
      case 'fridge':
      case 'pantry':
        return panel('選食材');
    }
  }

  switch (k) {
    case 'fridge':
    case 'pantry':
      if (h?.kind === 'crate') return act('restock', '補貨');
      if (item) return act('store_all', '放回架上');
      return panel('選食材（或按數字鍵）');
    case 'sink':
      if (h?.kind === 'dirty') return act('load', '放上碗盤架');
      if (item) return act('place', '放進水槽');
      if (has) return act('pick', '拿起來');
      return none('水槽是空的');
    case 'prep':
    case 'pan':
    case 'toaster':
    case 'oven':
    case 'mixer':
      if (item) return act('place', '放上去');
      if (has) return act('pick', '拿起來');
      return none('這裡是空的');
    case 'stove':
      if (item) return act('place', '下鍋');
      if (plate && (has || (s.liquid ?? 0) > 0)) return act('ladle', '盛起來');
      return none(plate ? '鍋裡是空的' : '要用碗盛（右鍵開火）');
    case 'shelf':
      if (item || plate) return act('place', '放上交接架');
      if (has || s.plates.length) return act('pick', '拿起來');
      return none('交接架是空的');
    case 'rack':
      if (item) return act('place', '放上成品架');
      if (has) return act('pick', '拿起來');
      return none('成品架是空的');
    case 'plating':
      if (item) return s.plates.length ? act('add', '裝盤', { plateId: s.plates[0] }) : act('add', '拿盤子並裝盤', undefined, { action: 'new_plate', args: { vessel: 'plate' } });
      if (plate) return act('place', '放下盤子');
      if (s.plates.length) return act('pick', '端起盤子', { plateId: s.plates[0] });
      return act('new_plate', '拿一個盤子', { vessel: 'plate' });
    case 'pass':
      if (plate) return openOrders ? act('serve', '出餐') : none('現在沒有單');
      return panel('看單');
    case 'trash':
      return h ? act('discard', '丟掉') : none('手上沒有東西');
    case 'dishes':
      return act('take', '拿髒盤');
    case 'delivery':
      return s.crate ? act('take_crate', '搬貨') : none('沒有貨');
    case 'spice':
      return panel('量調味料（或按數字鍵）');
    case 'cctv':
      return act('fire_door', '關防火門');
  }
  return panel('打開');
}
