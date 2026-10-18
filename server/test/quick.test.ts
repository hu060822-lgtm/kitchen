import { describe, expect, it } from 'vitest';
import { bench } from './bench';

/** 快速操作：滑鼠左鍵＝拿／放，右鍵＝使用（不用打開面板） */
const quick = (b: ReturnType<typeof bench>, station: string, mode: 'primary' | 'use' = 'primary') => b.act('P1', station, 'quick', { mode });

describe('快速操作', () => {
  it('左鍵放上平底鍋、右鍵開火、開著火時右鍵翻面、左鍵拿起來；空鍋右鍵關火', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    expect(b.act('P1', 'fridge', 'take', { type: 'egg' }).ok).toBe(true);
    const put = quick(b, 'pan_a');
    expect(put.ok).toBe(true);
    expect(b.sim.players.P1.held).toBeNull();
    const on = quick(b, 'pan_a', 'use');
    expect(on.ok).toBe(true);
    expect(b.sim.publicState().stations.pan_a.heat).toBe('MED');
    // 開著火、鍋裡有東西：右鍵翻面（火不變）
    expect(quick(b, 'pan_a', 'use').ok).toBe(true);
    expect(b.sim.publicState().stations.pan_a.heat).toBe('MED');
    expect(quick(b, 'pan_a').ok).toBe(true);
    expect(b.sim.players.P1.held?.kind).toBe('item');
    // 空鍋：右鍵關火
    quick(b, 'pan_a', 'use');
    expect(b.sim.publicState().stations.pan_a.heat).toBe('OFF');
  });

  it('裝盤區：手上有食材、沒有盤子 → 自動拿盤子再裝盤；空手再按一次就端起盤子；在出餐口按左鍵出餐', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'egg' });
    const r = quick(b, 'plating');
    expect(r.ok).toBe(true);
    expect(b.sim.publicState().stations.plating.plates.length).toBe(1);
    expect(quick(b, 'plating').ok).toBe(true);
    expect(b.sim.players.P1.held?.kind).toBe('plate');
    b.run(30);
    const open = b.sim.publicState().orders.filter((o) => o.status === 'open');
    const served = quick(b, 'pass');
    if (open.length) {
      expect(served.ok).toBe(true);
      expect(b.sim.players.P1.held).toBeNull();
    } else expect(served.ok).toBe(false);
  });

  it('要選擇的事（切法、調味料）不會亂做：回覆要打開面板', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    expect(b.act('P1', 'pantry', 'take', { type: 'onion' }).ok).toBe(true);
    expect(quick(b, 'prep_a').ok).toBe(true);
    const r = quick(b, 'prep_a', 'use');
    expect(r.message).toContain('打開');
    expect(quick(b, 'spice').message).toContain('打開');
  });

  it('垃圾桶：空手按左鍵只會提示', () => {
    const b = bench({ seats: ['P1'] });
    b.open();
    expect(quick(b, 'trash').ok).toBe(false);
  });
});
