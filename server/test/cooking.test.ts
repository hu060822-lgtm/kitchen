import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BURNER_TARGET,
  INGREDIENTS,
  AVAILABLE_FLAWS,
  SEATS,
  cookingState,
  dishTaste,
  heatItem,
  newItem,
  stepVessel,
  type Seat,
} from '@last-table/shared';
import { cutQuality } from '../src/kitchen/sim';
import { bench, chop, cookEggToast, serveFirst, sloppy, steady, type Bench } from './bench';

const failed = (r: { result?: { reasons: Array<{ ok: boolean; text: string }> } }) => r.result!.reasons.filter((x) => !x.ok).map((x) => x.text);

/** 一份完整的「番茄炒蛋」（兩個人分工），回傳出餐結果 */
function cookTomatoEgg(b: Bench, o: { cut?: string; presses?: number[]; sugar?: number } = {}) {
  const prep: Seat = 'P1';
  const hot: Seat = 'P3';
  b.act(prep, 'fridge', 'take', { type: 'tomato' });
  b.act(prep, 'sink', 'place');
  b.act(prep, 'sink', 'wash');
  b.run(2.1);
  b.act(prep, 'sink', 'pick');
  b.act(prep, 'prep_a', 'place');
  chop(b, prep, 'prep_a', o.cut ?? 'DICED', o.presses ?? steady(8));
  b.act(prep, 'prep_a', 'pick');
  b.act(hot, 'pan_b', 'heat', { level: 'MED' });
  b.act(prep, 'pan_b', 'place');
  for (let i = 0; i < 2; i++) {
    b.act(prep, 'fridge', 'take', { type: 'egg' });
    b.act(prep, 'prep_b', 'place');
    chop(b, prep, 'prep_b', 'BEATEN', steady(6));
    b.act(prep, 'prep_b', 'pick');
    b.act(prep, 'pan_b', 'place');
  }
  b.run(14);
  b.act(hot, 'pan_b', 'heat', { level: 'OFF' });
  b.act(hot, 'plating', 'new_plate', { vessel: 'plate' });
  const plateId = b.sim.publicState().stations.plating.plates.at(-1)!;
  for (let i = 0; i < 3; i++) {
    b.act(hot, 'pan_b', 'pick');
    b.act(hot, 'plating', 'add', { plateId });
  }
  b.act(hot, 'spice', 'measure', { seasoning: 'sugar', units: o.sugar ?? 0.5 });
  b.act(hot, 'plating', 'pour', { plateId });
  b.act(hot, 'spice', 'measure', { seasoning: 'salt', units: 0.5 });
  b.act(hot, 'plating', 'pour', { plateId });
  b.act(hot, 'plating', 'pick', { plateId });
}

function openUntil(b: Bench, recipeId: string): void {
  b.open();
  for (let i = 0; i < 400 && !b.sim.orders.some((o) => o.status === 'open' && o.recipeId === recipeId); i++) b.run(1);
}

describe('料理模型（純函式）', () => {
  it('鍋具有熱慣性：關火後溫度依同一個模型下降，不會瞬間變冷', () => {
    let v = 22;
    for (let i = 0; i < 300; i++) v = stepVessel(v, 'MED', 'pan', false);
    expect(v).toBeGreaterThan(BURNER_TARGET.MED - 5);
    const afterOff: number[] = [];
    for (let i = 0; i < 30; i++) afterOff.push((v = stepVessel(v, 'OFF', 'pan', false)));
    expect(afterOff[0]).toBeGreaterThan(170);
    expect(afterOff.at(-1)).toBeGreaterThan(70);
    expect(afterOff.every((x, i) => i === 0 || x < afterOff[i - 1])).toBe(true);
    // 有液體的湯鍋最高到沸點
    let p = 22;
    for (let i = 0; i < 2000; i++) p = stepVessel(p, 'HIGH', 'pot', true);
    expect(p).toBeLessThanOrEqual(100.0001);
  });

  it('熟度由累積的熱量決定：火越大越快熟、越快上色；小火不上色', () => {
    const cook = (level: 'LOW' | 'MED' | 'HIGH', sec: number) => {
      const it = newItem('x', 'egg', 0);
      let v = 22;
      for (let i = 0; i < sec * 10; i++) {
        v = stepVessel(v, level, 'pan', false);
        heatItem(it, { method: 'pan', vessel: v, mode: 'pan' });
      }
      return it;
    };
    const low = cook('LOW', 20);
    const med = cook('MED', 20);
    const high = cook('HIGH', 20);
    expect(low.doneness).toBeLessThan(med.doneness);
    expect(med.doneness).toBeLessThan(high.doneness);
    expect(low.brownA).toBe(0);
    expect(high.brownA).toBeGreaterThan(med.brownA);
    expect(cookingState(high)).toBe('BURNT');
  });

  it('切得越細熟得越快（同樣的火、同樣的時間）', () => {
    const run = (cut: 'WHOLE' | 'DICED') => {
      const it = newItem('x', 'chicken', 0);
      it.cut = cut;
      let v = 22;
      for (let i = 0; i < 200; i++) {
        v = stepVessel(v, 'MED', 'pan', false);
        heatItem(it, { method: 'pan', vessel: v, mode: 'pan' });
      }
      return it.doneness;
    };
    expect(run('DICED')).toBeGreaterThan(run('WHOLE'));
  });

  it('刀工：穩定的節奏分數高，忽快忽慢分數低；同樣的節奏永遠同樣的分數', () => {
    expect(cutQuality(steady(8))).toBe(1);
    expect(cutQuality(sloppy(8))).toBeLessThan(0.3);
    expect(cutQuality([0, 300, 590, 900, 1180, 1500])).toBeGreaterThan(0.85);
    expect(cutQuality(sloppy(8))).toBe(cutQuality(sloppy(8)));
  });

  it('口味模型是公開的固定表：生洋蔥偏辛辣，炒到上色變甜；燒焦變苦', () => {
    const onion = newItem('o', 'onion', 0);
    expect(dishTaste([onion], {}).spicy).toBeGreaterThan(1);
    onion.doneness = 3;
    onion.brownA = onion.brownB = 1;
    expect(dishTaste([onion], {}).sweet).toBeGreaterThan(1.5);
    onion.brownA = 2.5;
    expect(dishTaste([onion], {}).bitter).toBeGreaterThan(2);
    // 鹽每單位固定的鹹度，被份量稀釋
    const egg = newItem('e', 'egg', 0);
    expect(dishTaste([egg], { salt: 1 }).salty).toBe(2);
  });
});

describe('食材狀態機：只有合法的轉換', () => {
  it('洋蔥沒削皮不能切；切過的不能再切；煮過的不能拿回去洗', () => {
    const b = bench();
    b.open();
    b.act('P1', 'pantry', 'take', { type: 'onion' });
    b.act('P1', 'prep_a', 'place');
    expect(b.act('P1', 'prep_a', 'chop_start', { cut: 'SLICED' }).message).toContain('先削皮');
    b.act('P1', 'prep_a', 'peel');
    b.run(2.6);
    expect(chop(b, 'P1', 'prep_a', 'SLICED', steady(5)).ok).toBe(true);
    expect(b.act('P1', 'prep_a', 'chop_start', { cut: 'DICED' }).ok).toBe(false);
    b.act('P1', 'prep_a', 'pick');
    b.act('P1', 'pan_a', 'heat', { level: 'MED' });
    b.act('P1', 'pan_a', 'place');
    b.run(5);
    b.act('P1', 'pan_a', 'pick');
    expect(b.act('P1', 'sink', 'place').ok).toBe(false);
  });

  it('切法要符合食材：吐司不能切丁、蛋只能整顆或打散', () => {
    const b = bench();
    b.open();
    b.act('P2', 'fridge', 'take', { type: 'egg' });
    b.act('P2', 'prep_b', 'place');
    expect(b.act('P2', 'prep_b', 'chop_start', { cut: 'DICED' }).ok).toBe(false);
    expect(b.act('P2', 'prep_b', 'chop_start', { cut: 'BEATEN' }).ok).toBe(true);
  });

  it('生蛋不會被當成煎好的蛋：直接裝盤出餐，火候判定為「還沒熟」', () => {
    const b = bench();
    openUntil(b, 'egg_toast');
    cookEggToast(b, 'P2', { eggSec: 0 });
    const r = serveFirst(b, 'P2', 'egg_toast');
    expect(failed(r)).toContain('雞蛋還沒熟透');
    expect(r.result!.categories.doneness).toBeLessThan(1);
  });

  it('切過生雞肉的砧板沒擦，接著切蔥：蔥被標記交叉汙染；擦過之後就沒有', () => {
    const b = bench();
    b.open();
    b.act('P3', 'fridge', 'take', { type: 'chicken' });
    b.act('P3', 'prep_a', 'place');
    chop(b, 'P3', 'prep_a', 'DICED', steady(8));
    b.act('P3', 'prep_a', 'pick');
    b.act('P3', 'trash', 'discard');
    expect(b.sim.publicState().stations.prep_a.contaminated).toBe(true);
    b.act('P3', 'fridge', 'take', { type: 'scallion' });
    b.act('P3', 'prep_a', 'place');
    chop(b, 'P3', 'prep_a', 'CHOPPED', steady(6));
    const id = b.sim.publicState().stations.prep_a.items[0];
    expect(b.sim.items.get(id)!.contaminated).toBe(true);
    b.act('P3', 'prep_a', 'pick');
    b.act('P3', 'trash', 'discard');
    b.act('P3', 'prep_a', 'wipe');
    b.run(2.1);
    expect(b.sim.publicState().stations.prep_a.contaminated).toBe(false);
  });
});

describe('驗收 1：相同食材、相同設備、相同操作序列，結果完全一致', () => {
  it('跑兩次同樣的班次，出餐結果與所有食材狀態都相同', () => {
    const play = () => {
      const b = bench();
      openUntil(b, 'egg_toast');
      cookEggToast(b, 'P2');
      const r1 = serveFirst(b, 'P2', 'egg_toast');
      openUntil(b, 'tomato_egg');
      cookTomatoEgg(b);
      const r2 = serveFirst(b, 'P3', 'tomato_egg');
      return { r1: r1.result, r2: r2.result, state: JSON.stringify(b.sim.publicState()) };
    };
    const a = play();
    const c = play();
    expect(a.r1).toEqual(c.r1);
    expect(a.r2).toEqual(c.r2);
    expect(a.state).toBe(c.state);
  });
});

describe('驗收 5：品質紀錄能追查失誤原因', () => {
  it('照食譜做的煎蛋吐司接近滿分；每一項都有原因', () => {
    const b = bench();
    openUntil(b, 'egg_toast');
    cookEggToast(b, 'P2');
    const r = serveFirst(b, 'P2', 'egg_toast');
    expect(r.result!.total).toBeGreaterThanOrEqual(95);
    expect(r.result!.reasons.length).toBeGreaterThan(8);
    expect(r.result!.trail.map((x) => x.label)).toEqual(expect.arrayContaining(['雞蛋', '吐司', '奶油']));
  });

  it('吐司烤過頭、鹽加太多、蛋煎太久：分別回報，各自扣在對應的項目', () => {
    const b = bench();
    openUntil(b, 'egg_toast');
    cookEggToast(b, 'P2', { toastLevel: 5, salt: 2, eggSec: 34 });
    const r = serveFirst(b, 'P2', 'egg_toast');
    const f = failed(r);
    expect(f).toContain('吐司上色過深');
    expect(f.some((t) => t.startsWith('鹽高於配方'))).toBe(true);
    expect(f).toContain('雞蛋煮過頭了');
    expect(r.result!.categories.seasoning).toBeLessThan(1);
    expect(r.result!.categories.prep).toBe(1); // 刀工沒有問題，不會被連帶扣分
  });

  it('切法不對、刀工不穩定：刀工項目扣分並說明', () => {
    const b = bench();
    openUntil(b, 'tomato_egg');
    cookTomatoEgg(b, { cut: 'SLICED', presses: sloppy(6) });
    const r = serveFirst(b, 'P3', 'tomato_egg');
    expect(failed(r)).toContain('番茄要切丁，實際是切片');
    expect(r.result!.categories.prep).toBeLessThan(0.8);
  });

  it('品質與速度分開記錄：慢慢做的高品質料理仍然高分，但效率標示為慢', () => {
    const b = bench();
    openUntil(b, 'egg_toast');
    b.run(150);
    cookEggToast(b, 'P2');
    const r = serveFirst(b, 'P2', 'egg_toast');
    expect(r.result!.total).toBeGreaterThanOrEqual(95);
    expect(r.result!.efficiency).toBe('slow');
  });

  it('食品安全獨立判定：雞肉中心沒到 74°C，其他項目再好也最多 30 分', () => {
    const b = bench({ schedule: [{ at: 0, kind: 'free', requestId: 'meat_savory', table: 1 }] });
    b.open();
    b.run(0.2);
    b.act('P3', 'fridge', 'take', { type: 'chicken' });
    b.act('P3', 'pan_a', 'heat', { level: 'HIGH' });
    b.act('P3', 'pan_a', 'place');
    b.run(9);
    b.act('P3', 'pan_a', 'pick');
    b.act('P3', 'plating', 'new_plate', { vessel: 'plate' });
    const plateId = b.sim.publicState().stations.plating.plates.at(-1)!;
    b.act('P3', 'plating', 'add', { plateId });
    b.act('P3', 'spice', 'measure', { seasoning: 'salt', units: 0.5 });
    b.act('P3', 'plating', 'pour', { plateId });
    b.act('P3', 'plating', 'pick', { plateId });
    const r = serveFirst(b, 'P3');
    expect(r.result!.cap?.max).toBe(30);
    expect(r.result!.total).toBeLessThanOrEqual(30);
    expect(r.result!.reasons.find((x) => x.cat === 'safety' && !x.ok)?.text).toContain('74°C');
  });
});

describe('主廚委託（原本的主廚自選）：自由組合，用公開的口味模型與結構化條件評分', () => {
  it('「酸甜、不要蛋」：番茄＋糖＋醋做出來符合需求；放了蛋就扣需求分', () => {
    const make = (withEgg: boolean) => {
      const b = bench({ schedule: [{ at: 0, kind: 'free', requestId: 'sour_sweet', table: 2 }] });
      b.open();
      b.run(0.2);
      b.act('P2', 'fridge', 'take', { type: 'tomato' });
      b.act('P2', 'sink', 'place');
      b.act('P2', 'sink', 'wash');
      b.run(2.1);
      b.act('P2', 'sink', 'pick');
      b.act('P2', 'prep_a', 'place');
      chop(b, 'P2', 'prep_a', 'DICED', steady(8));
      b.act('P2', 'prep_a', 'pick');
      b.act('P2', 'plating', 'new_plate', { vessel: 'plate' });
      const plateId = b.sim.publicState().stations.plating.plates.at(-1)!;
      b.act('P2', 'plating', 'add', { plateId });
      if (withEgg) {
        b.act('P2', 'fridge', 'take', { type: 'egg' });
        b.act('P2', 'pan_a', 'heat', { level: 'MED' });
        b.act('P2', 'pan_a', 'place');
        b.run(22);
        b.act('P2', 'pan_a', 'pick');
        b.act('P2', 'plating', 'add', { plateId });
      }
      b.act('P2', 'spice', 'measure', { seasoning: 'sugar', units: 0.5 });
      b.act('P2', 'plating', 'pour', { plateId });
      b.act('P2', 'plating', 'pick', { plateId });
      return serveFirst(b, 'P2');
    };
    const good = make(false);
    expect(good.result!.dish).toBe('主廚委託：酸甜開胃');
    expect(good.result!.commission!.passed).toBe(true);
    expect(good.result!.categories.flavor).toBe(1);
    expect(good.result!.taste!.sour).toBeGreaterThanOrEqual(0.8);
    const bad = make(true);
    expect(bad.result!.commission!.passed).toBe(false);
    expect(bad.result!.commission!.violations.join('')).toContain('用了雞蛋（不吃蛋）');
  });

  it('試吃（所有角色都能做）：用同一個口味模型描述，不會透露分數', () => {
    const b = bench();
    b.open();
    b.act('P1', 'plating', 'new_plate', { vessel: 'plate' });
    b.act('P1', 'fridge', 'take', { type: 'tomato' });
    b.act('P1', 'plating', 'add');
    const r = b.act('P1', 'plating', 'taste');
    expect(r.message).toMatch(/^試吃：.*酸/);
    expect(r.message).not.toMatch(/分/);
  });
});

describe('驗收 6：每張已開放的缺陷卡、每個席位都能獨立完成基本料理工作', () => {
  for (const flaw of AVAILABLE_FLAWS) {
    it(`${flaw}（單人）：拿食材、清洗、切、開火、煎、裝盤、調味、出餐`, () => {
      const b = bench({ seats: ['P1'], flaws: { P1: flaw } });
      openUntil(b, 'egg_toast');
      cookEggToast(b, 'P1');
      const r = serveFirst(b, 'P1', 'egg_toast');
      expect(r.ok).toBe(true);
      expect(r.result!.total).toBeGreaterThanOrEqual(90);
    });
  }
  it('八人桌的第 8 席也能完整做菜', () => {
    const b = bench({ seats: [...SEATS] });
    openUntil(b, 'egg_toast');
    cookEggToast(b, 'P8');
    expect(serveFirst(b, 'P8', 'egg_toast').result!.total).toBeGreaterThanOrEqual(90);
  });
});

describe('驗收 8：重複事件不會造成重複轉換或重複計分', () => {
  it('同一個 requestId 送兩次：庫存只扣一次、只出一次餐', () => {
    const b = bench();
    openUntil(b, 'egg_toast');
    const before = b.sim.publicState().stations.fridge.stock!.egg!;
    const a = b.act('P2', 'fridge', 'take', { type: 'egg' }, 'same-1');
    const c = b.act('P2', 'fridge', 'take', { type: 'egg' }, 'same-1');
    expect(c).toBe(a);
    expect(b.sim.publicState().stations.fridge.stock!.egg).toBe(before - 1);
    b.act('P2', 'trash', 'discard');
    cookEggToast(b, 'P2');
    const order = b.sim.publicState().orders.find((o) => o.status === 'open')!;
    const s1 = b.act('P2', 'pass', 'serve', { orderId: order.id }, 'serve-1');
    const s2 = b.act('P2', 'pass', 'serve', { orderId: order.id }, 'serve-1');
    expect(s2).toBe(s1);
    expect(b.sim.stats.served).toBe(1);
    // 不同 requestId 再出同一張單：拒絕（單已經不在）
    expect(b.act('P2', 'pass', 'serve', { orderId: order.id }, 'serve-2').ok).toBe(false);
  });

  it('同一份食材不能被兩個人同時拿走', () => {
    const b = bench();
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'egg' });
    b.act('P1', 'pan_a', 'place');
    expect(b.act('P1', 'pan_a', 'pick').ok).toBe(true);
    expect(b.act('P2', 'pan_a', 'pick').ok).toBe(false);
  });
});

describe('料理系統與恐怖系統的界線', () => {
  it('驗收 2：怪物與客人在場時，同樣的操作得到完全相同的料理結果', () => {
    const play = (threats: boolean) => {
      const b = bench({ threats });
      openUntil(b, 'egg_toast');
      if (threats) {
        b.sim.threats!.command('spawn_monster', b.sim.t);
        b.sim.threats!.command('spawn_guest', b.sim.t);
        // 怪物現在會直接追最近的人：這裡只驗證「牠在場」不影響料理，讓牠留在後場不動
        ((b.sim.threats as unknown as { monster: { tune: { speed: number } } }).monster.tune.speed = 0);
      }
      // 料理的人站在廚房裡，怪物在後場移動
      cookEggToast(b, 'P2');
      return serveFirst(b, 'P2', 'egg_toast').result!;
    };
    const quiet = play(false);
    const scary = play(true);
    const strip = (r: typeof quiet) => ({ ...r, trail: r.trail });
    expect(strip(scary)).toEqual(strip(quiet));
  });

  it('驗收 3：為了躲怪物離開爐台、沒有關火，蛋依照正常規則繼續煎到焦', () => {
    const b = bench();
    b.open();
    b.act('P3', 'fridge', 'take', { type: 'egg' });
    b.act('P3', 'pan_a', 'heat', { level: 'HIGH' });
    b.act('P3', 'pan_a', 'place');
    b.at('P3', 'locker_k'); // 跑去躲
    const id = b.sim.publicState().stations.pan_a.items[0];
    const states: string[] = [];
    for (let i = 0; i < 40; i++) {
      b.run(1);
      states.push(cookingState(b.sim.items.get(id)!));
    }
    expect(states).toContain('COOKED');
    expect(states.at(-1)).toBe('BURNT');
    // 狀態依序推進，沒有跳過
    const order = ['RAW', 'COOKING', 'COOKED', 'OVERCOOKED', 'BURNT'];
    const idx = states.map((s) => order.indexOf(s));
    expect(idx.every((v, i) => i === 0 || v >= idx[i - 1])).toBe(true);
  });

  it('驗收 4：恐怖系統的程式碼沒有任何改變食材狀態或評分的途徑', () => {
    const dir = path.resolve(__dirname, '../src/kitchen/threats');
    const src = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    for (const banned of ['heatItem', 'cookingState', 'doneness', 'brownA', 'items.', 'scorePlate', 'scoring', 'orders', 'BURNT', 'seasoning', 'freshness']) {
      expect(src.includes(banned), `恐怖系統不應該使用 ${banned}`).toBe(false);
    }
    // 評分模組也不知道恐怖系統的存在
    const scoring = readFileSync(path.resolve(__dirname, '../src/kitchen/scoring.ts'), 'utf8');
    for (const banned of ['threat', 'monster', 'guest', 'Monster', 'Guest']) expect(scoring.includes(banned)).toBe(false);
  });

  it('食材資料涵蓋規格要求的每個維度', () => {
    const it = newItem('x', 'onion', 0);
    for (const k of ['type', 'qty', 'cut', 'freshness', 'doneness', 'temp', 'history', 'washed', 'peeled']) expect(it).toHaveProperty(k);
    expect(INGREDIENTS.chicken.heat.safeTemp).toBe(74);
  });
});
