import { describe, expect, it } from 'vitest';
import {
  CUT_STROKES,
  DEFAULT_FLAW_CONFIG,
  FLAW_CARDS,
  FLAW_IDS,
  PLAYER_RADIUS,
  SPAWNS,
  SEATS,
  buildColliders,
  cookingState,
  flawSpeedMultiplier,
  mergeFlawConfig,
  openDoors,
  type KitchenEvent,
  type Seat,
} from '@last-table/shared';
import { parseFlawConfig } from '../src/config';
import { buildSchedule, crewScale } from '../src/kitchen/orders';
import { cutQuality } from '../src/kitchen/sim';
import { bench, steady, type Bench } from './bench';

/* ------------------------------ 共用 ------------------------------ */

const near = (b: Bench, a: Seat, other: Seat, d = 1.0): void => {
  Object.assign(b.poses[other], { x: b.poses[a].x + d, z: b.poses[a].z, yaw: 0 });
};
const privateOf = (b: Bench, s: Seat) => b.sim.flaws.privateFor(s)!;
const eventsTo = (b: Bench, s: Seat) => b.events.filter((x) => x.to === s || x.to === 'all').map((x) => x.e);
/** 經過缺陷卡過濾之後，這個人實際收到的事件 */
const deliveredTo = (b: Bench, s: Seat): KitchenEvent[] =>
  eventsTo(b, s)
    .map((e) => b.sim.flaws.filterEvent(s, e))
    .filter((e): e is KitchenEvent => !!e && !!(e.text || e.sound || e.visual));

function openUntilOrders(b: Bench, n: number): void {
  b.open();
  for (let i = 0; i < 600 && b.sim.orders.filter((o) => o.status === 'open').length < n; i++) b.run(1);
}

/* ============================== 卡片資料 ============================== */

describe('缺陷卡資料', () => {
  it('16 張卡都有固定 ID、四個部分（缺口、補償、互助、高光）；全部開放，分屬四個階段', () => {
    expect(FLAW_IDS).toHaveLength(16);
    for (const id of FLAW_IDS) {
      const c = FLAW_CARDS[id];
      expect(c.id).toBe(id);
      expect(c.limitation.length).toBeGreaterThan(0);
      expect(c.compensation.length).toBeGreaterThan(0);
      expect(c.cooperationHooks.length).toBeGreaterThan(0);
      expect(c.heroMoment.length).toBeGreaterThan(0);
    }
    expect(FLAW_IDS.filter((id) => FLAW_CARDS[id].available)).toEqual([...FLAW_IDS]);
    expect(FLAW_IDS.filter((id) => FLAW_CARDS[id].phase === 'A').sort()).toEqual(['D01', 'D02', 'D03', 'D04', 'D15']);
    expect(FLAW_IDS.filter((id) => FLAW_CARDS[id].phase === 'B').sort()).toEqual(['D06', 'D09', 'D10', 'D11']);
    expect(FLAW_IDS.filter((id) => FLAW_CARDS[id].phase === 'C').sort()).toEqual(['D07', 'D08', 'D12', 'D13']);
    expect(FLAW_IDS.filter((id) => FLAW_CARDS[id].phase === 'D').sort()).toEqual(['D05', 'D14', 'D16']);
  });

  it('效果可調：只覆寫寫到的數字欄位，非數字、負數、未知欄位一律忽略；FLAW_CONFIG 壞掉時用預設值', () => {
    const c = mergeFlawConfig(DEFAULT_FLAW_CONFIG, { D02: { maxStrokeCut: 3, voiceGain: 'loud', nope: 1 }, D04: { diningSpeed: -1 }, evil: { x: 1 } });
    expect(c.D02.maxStrokeCut).toBe(3);
    expect(c.D02.voiceGain).toBe(DEFAULT_FLAW_CONFIG.D02.voiceGain);
    expect((c.D02 as unknown as Record<string, unknown>).nope).toBeUndefined();
    expect(c.D04.diningSpeed).toBe(DEFAULT_FLAW_CONFIG.D04.diningSpeed);
    expect(DEFAULT_FLAW_CONFIG.D02.maxStrokeCut).toBe(2); // 預設值本身沒有被改到
    expect(parseFlawConfig('{"D15":{"capacity":3}}').D15.capacity).toBe(3);
    expect(parseFlawConfig('not json').D15.capacity).toBe(DEFAULT_FLAW_CONFIG.D15.capacity);
  });

  it('改設定就改變行為，不必改程式（耳背砧板最多少 3 刀）', () => {
    const cfg = mergeFlawConfig(DEFAULT_FLAW_CONFIG, { D02: { maxStrokeCut: 3, streakWindowMs: 60_000 } });
    const b = bench({ seats: ['P1'], flaws: { P1: 'D02' }, flawConfig: cfg });
    b.open();
    const needs = chopSeries(b, 'P1', 5);
    expect(needs).toEqual([8, 7, 6, 5, 5]);
  });
});

/* ============================== 人數適配 ============================== */

describe('人數適配：1、2、3–4、5–6、7–8 人', () => {
  it('依人數調整工作量：1 人少單而且客人有耐心；5 人以上加單、同時開著的單更多', () => {
    expect(buildSchedule(1, 1)).toHaveLength(7);
    expect(buildSchedule(1, 2)).toHaveLength(11);
    expect(buildSchedule(1, 3)).toHaveLength(11);
    expect(buildSchedule(1, 4)).toHaveLength(11);
    expect(buildSchedule(1, 6)).toHaveLength(15);
    expect(buildSchedule(1, 8)).toHaveLength(19);
    expect(crewScale(1).patience).toBeGreaterThan(crewScale(3).patience);
    expect(crewScale(8).maxOpen).toBeGreaterThan(crewScale(3).maxOpen);
    // 同一個種子、同一個人數 → 同一份排程（可重現）
    expect(buildSchedule(7, 6)).toEqual(buildSchedule(7, 6));
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const s = buildSchedule(3, n);
      expect(s.every((o, i) => i === 0 || o.at >= s[i - 1].at)).toBe(true);
      expect(s.at(-1)!.at).toBeLessThan(420);
    }
  });

  it('八個出生點都不在牆或家具裡、彼此不重疊', () => {
    const boxes = buildColliders(openDoors());
    for (const s of SEATS) {
      const [x, , z] = SPAWNS[s].pos;
      for (const b of boxes) {
        const cx = Math.max(b.minX, Math.min(x, b.maxX));
        const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
        expect(Math.hypot(x - cx, z - cz), `${s} 撞到 ${b.id}`).toBeGreaterThan(PLAYER_RADIUS);
      }
      for (const o of SEATS) if (o !== s) expect(Math.hypot(x - SPAWNS[o].pos[0], z - SPAWNS[o].pos[2])).toBeGreaterThan(1);
    }
  });
});

/* ============================== D01 幻聽外場 ============================== */

describe('D01 幻聽外場', () => {
  it('只有他聽得到傳聞；真訂單提前洩漏的只有片段（沒有桌號、數量與特殊要求）', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D01', P2: 'D04' } });
    b.run(0.2);
    const r = privateOf(b, 'P1').rumors!;
    expect(r).toHaveLength(1);
    expect(r[0].text).toContain('煎蛋吐司');
    expect(r[0].text).not.toMatch(/號桌|份|鹽|胡椒/);
    expect(privateOf(b, 'P2').rumors).toBeUndefined();
    const rumorEvents = b.events.filter((x) => x.e.kind === 'flaw');
    expect(rumorEvents.length).toBe(1);
    expect(rumorEvents.every((x) => x.to === 'P1')).toBe(true);
    // 公開狀態看不到私人傳聞，也看不到真假
    expect(JSON.stringify(b.sim.publicState())).not.toContain(r[0].text);
  });

  it('假傳聞：不會變成訂單、不扣資源、同一句不重複、同時不超過上限；真假的提示音有固定差異', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D01' } });
    const stock = JSON.stringify(b.sim.publicState().stations.fridge.stock);
    b.open();
    const texts: string[] = [];
    let maxActive = 0;
    for (let s = 0; s < 400; s += 5) {
      b.run(5);
      const r = privateOf(b, 'P1').rumors!;
      maxActive = Math.max(maxActive, r.filter((x) => !x.posted && x.pitch > 1.03).length);
      for (const x of r) if (!texts.includes(x.text)) texts.push(x.text);
    }
    const fakes = b.sim.flaws.events.filter((e) => e.what === '聽到假訂單');
    expect(fakes.length).toBeGreaterThanOrEqual(4);
    expect(maxActive).toBeLessThanOrEqual(DEFAULT_FLAW_CONFIG.D01.maxActive);
    expect(new Set(texts).size).toBe(texts.length);
    // 訂單只來自排程
    expect(b.sim.orders.length).toBeLessThanOrEqual(buildSchedule(1, 1).length);
    expect(JSON.stringify(b.sim.publicState().stations.fridge.stock)).toBe(stock);
  });

  it('貼上訂單板 → 隊友到出餐口核對（2 秒）→ 真的變成全隊的準備提示，訂單出現後連上', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D01', P2: 'D04' } });
    b.run(0.2);
    const rumor = privateOf(b, 'P1').rumors![0];
    expect(b.coop('P2', 'rumor_post', { rumorId: rumor.id }).ok).toBe(false); // 只有聽到的人能貼
    expect(b.coop('P1', 'rumor_post', { rumorId: rumor.id }).ok).toBe(true);
    expect(b.sim.publicState().coop.rumors[0]).toMatchObject({ id: rumor.id, status: 'posted', by: 'P1' });
    expect(b.act('P2', 'pass', 'verify', { rumorId: rumor.id }).ok).toBe(true);
    const task = b.sim.players.P2.task!;
    expect(task.endsAt - task.startedAt).toBe(DEFAULT_FLAW_CONFIG.D01.verifyMs);
    b.run(2.1);
    const pub = b.sim.publicState().coop;
    expect(pub.rumors[0].status).toBe('confirmed');
    expect(pub.prepHints).toHaveLength(1);
    expect(pub.prepHints[0].text).toContain('煎蛋吐司');
    b.open();
    b.run(0.2);
    const order = b.sim.orders[0];
    expect(b.sim.publicState().coop.prepHints[0].orderId).toBe(order.id);
    expect(b.sim.flaws.telemetrySnapshot().D01!.coopOk).toBeGreaterThan(0);
  });

  it('單人也能自己核對，但要 6 秒；走開會中斷、傳聞回到待核對', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D01' } });
    b.run(0.2);
    const rumor = privateOf(b, 'P1').rumors![0];
    b.coop('P1', 'rumor_post', { rumorId: rumor.id });
    b.act('P1', 'pass', 'verify', { rumorId: rumor.id });
    const task = b.sim.players.P1.task!;
    expect(task.endsAt - task.startedAt).toBe(DEFAULT_FLAW_CONFIG.D01.verifySelfMs);
    Object.assign(b.poses.P1, { x: 0, z: 16 });
    b.run(0.2);
    expect(b.sim.players.P1.task).toBeNull();
    expect(b.sim.publicState().coop.rumors[0].status).toBe('posted');
    b.act('P1', 'pass', 'verify', { rumorId: rumor.id });
    b.run(6.1);
    expect(b.sim.publicState().coop.rumors[0].status).toBe('confirmed');
  });

  it('假傳聞核對後被排除（沒有準備提示）；任何人都可以直接駁回', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D01', P2: 'D04' } });
    b.open();
    b.run(25);
    const fake = privateOf(b, 'P1').rumors!.find((r) => r.pitch > 1.03)!;
    expect(fake).toBeTruthy();
    b.coop('P1', 'rumor_post', { rumorId: fake.id });
    b.act('P2', 'pass', 'verify', { rumorId: fake.id });
    b.run(2.1);
    const pub = b.sim.publicState().coop;
    expect(pub.rumors.find((r) => r.id === fake.id)!.status).toBe('rejected');
    expect(pub.prepHints).toHaveLength(0);
    // 駁回
    const b2 = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D01', P2: 'D04' } });
    b2.run(0.2);
    const r = privateOf(b2, 'P1').rumors![0];
    b2.coop('P1', 'rumor_post', { rumorId: r.id });
    expect(b2.coop('P2', 'rumor_dismiss', { rumorId: r.id }).ok).toBe(true);
    expect(b2.sim.publicState().coop.rumors[0].status).toBe('rejected');
  });
});

/* ============================== D02 耳背砧板 ============================== */

function chopSeries(b: Bench, who: Seat, n: number, gapSec = 0): number[] {
  const needs: number[] = [];
  for (let i = 0; i < n; i++) {
    b.act(who, 'fridge', 'take', { type: 'tomato' });
    b.act(who, 'prep_a', 'place');
    const r = b.act(who, 'prep_a', 'chop_start', { cut: 'DICED' });
    needs.push(r.need!);
    b.run(2);
    const done = b.act(who, 'prep_a', 'chop', { presses: steady(r.need!) });
    if (!done.ok) throw new Error(done.message);
    b.act(who, 'prep_a', 'pick');
    b.act(who, 'trash', 'discard');
    if (gapSec) b.run(gapSec);
  }
  return needs;
}

describe('D02 耳背砧板', () => {
  it('收不到聲音提示（也沒有替代文字）；看得到畫面提示；危險事件一定收到；其他人不受影響', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D02', P2: 'D04' } });
    const f = (e: KitchenEvent, s: Seat = 'P1') => b.sim.flaws.filterEvent(s, e);
    expect(f({ kind: 'order_new', text: '3 號桌點了番茄炒蛋', sound: 'ticket' })).toBeNull();
    expect(f({ kind: 'toast_pop', text: '吐司跳起來了', sound: 'toast_pop' })).toBeNull();
    expect(f({ kind: 'monster_sound', sense: 'sound', sound: 'backdoor', text: '後門吱的一聲打開了。' })).toBeNull();
    expect(f({ kind: 'monster_sound', sense: 'sight', visual: 'flicker', text: '後場的燈閃了一下。' })).toMatchObject({ visual: 'flicker' });
    expect(f({ kind: 'monster_grab', text: '被拖走了', sound: 'drag', visual: 'grab', critical: true })).toMatchObject({ sound: 'drag', visual: 'grab' });
    expect(f({ kind: 'served', text: '3 號桌：90 分', sound: 'bell' })).toEqual({ kind: 'served', text: '3 號桌：90 分', sound: undefined });
    expect(f({ kind: 'phase', text: '番茄洗好了。' })).toMatchObject({ text: '番茄洗好了。' });
    expect(f({ kind: 'order_new', text: 'x', sound: 'ticket' }, 'P2')).toMatchObject({ text: 'x', sound: 'ticket' });
  });

  it('連續切菜越切越少刀（上限 2 刀）；中斷超過 9 秒就重來；刀工品質只看節奏，不因加速而改變', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D02' } });
    b.open();
    expect(chopSeries(b, 'P1', 4)).toEqual([8, 7, 6, 6]);
    b.run(10);
    expect(chopSeries(b, 'P1', 1)).toEqual([8]);
    const it = [...b.sim.items.values()];
    expect(it.length).toBe(0);
    // 品質：同樣的節奏、不同的刀數 → 用同一個公式
    expect(cutQuality(steady(6))).toBe(cutQuality(steady(8)));
    // 其他卡沒有這個效果
    const o = bench({ seats: ['P1'], flaws: { P1: 'D04' } });
    o.open();
    expect(chopSeries(o, 'P1', 3)).toEqual([8, 8, 8]);
  });

  it('連續備料時清洗也變快（每層 12%）', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D02' } });
    b.open();
    chopSeries(b, 'P1', 2);
    b.act('P1', 'fridge', 'take', { type: 'tomato' });
    b.act('P1', 'sink', 'place');
    b.act('P1', 'sink', 'wash');
    const t = b.sim.players.P1.task!;
    expect(t.endsAt - t.startedAt).toBe(Math.round(2000 * (1 - 0.24)));
  });

  it('拍肩：要走到旁邊（1.8 m）、有冷卻；被拍的人收到方向與符號（危險等級，耳背砧板也收得到）', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D02', P2: 'D04' } });
    b.open();
    Object.assign(b.poses.P2, { x: b.poses.P1.x + 3, z: b.poses.P1.z });
    expect(b.coop('P2', 'tap', { to: 'P1' }).ok).toBe(false);
    near(b, 'P1', 'P2', 1.2);
    expect(b.coop('P2', 'tap', { to: 'P1', token: 'GEST_DANGER' }).ok).toBe(true);
    expect(privateOf(b, 'P1').tapped).toMatchObject({ from: 'P2', token: 'GEST_DANGER' });
    expect(deliveredTo(b, 'P1').some((e) => e.visual === 'tap')).toBe(true);
    expect(b.coop('P2', 'tap', { to: 'P1' }).ok).toBe(false);
    expect(privateOf(b, 'P2').cooldowns.tap).toBeGreaterThan(b.sim.t);
    b.run(4.1);
    expect(b.coop('P2', 'tap', { to: 'P1' }).ok).toBe(true);
    expect(b.coop('P2', 'tap', { to: 'P2' }).ok).toBe(false);
  });
});

/* ============================== D03 味覺失調者 ============================== */

function tomatoPlate(b: Bench, who: Seat): string {
  b.act(who, 'plating', 'new_plate', { vessel: 'plate' });
  const plateId = b.sim.publicState().stations.plating.plates.at(-1)!;
  b.act(who, 'fridge', 'take', { type: 'tomato' });
  b.act(who, 'plating', 'add', { plateId });
  b.act(who, 'spice', 'measure', { seasoning: 'salt', units: 1 });
  b.act(who, 'plating', 'pour', { plateId });
  return plateId;
}

describe('D03 味覺失調者', () => {
  it('自己試吃嚐不出鹹淡酸甜（只知道有沒有調味）；隊友嚐得出來；兩人的資訊都來自同一盤', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D03', P2: 'D04' } });
    b.open();
    tomatoPlate(b, 'P1');
    const mine = b.act('P1', 'plating', 'taste');
    expect(mine.ok).toBe(true);
    expect(mine.message).toContain('嚐不出');
    expect(mine.message).toContain('有調過味');
    expect(mine.message).not.toMatch(/鹹|酸|甜/);
    const theirs = b.act('P2', 'plating', 'taste');
    expect(theirs.message).toMatch(/鹹/);
  });

  it('試吃回報：隊友嚐過才能回報，內容就是他嚐到的；味覺失調者自己不能回報；之後再調味，回報標成過期', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D03', P2: 'D04' } });
    b.open();
    const plateId = tomatoPlate(b, 'P1');
    expect(b.coop('P2', 'taste_report', { to: 'P1' }).ok).toBe(false);
    const tasted = b.act('P2', 'plating', 'taste', { plateId });
    expect(b.coop('P2', 'taste_report', { to: 'P1' }).ok).toBe(true);
    const rep = privateOf(b, 'P1').reports[0];
    expect(rep.by).toBe('P2');
    expect(tasted.message).toContain(rep.words[0]);
    expect(rep.stale).toBe(false);
    b.act('P1', 'plating', 'taste', { plateId });
    expect(b.coop('P1', 'taste_report', { to: 'P2' }).ok).toBe(false);
    b.act('P1', 'spice', 'measure', { seasoning: 'sugar', units: 1 });
    b.act('P1', 'plating', 'pour', { plateId });
    b.run(1.1);
    expect(privateOf(b, 'P1').reports[0].stale).toBe(true);
  });

  it('預警：附近的平底鍋快燒焦時提早收到（推算來自真實狀態），而且推算不會改變任何東西', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D03', P2: 'D04' } });
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'egg' });
    b.act('P1', 'pan_a', 'heat', { level: 'HIGH' });
    b.act('P1', 'pan_a', 'place');
    Object.assign(b.poses.P2, { x: -8, z: 3 }); // 隊友在餐廳
    const eggId = b.sim.stations.get('pan_a')!.items[0];
    const egg = () => b.sim.items.get(eggId)!;
    const snap = JSON.stringify(egg());
    b.sim.flaws.predict('pan_a');
    expect(JSON.stringify(egg())).toBe(snap);
    let warnedAt = -1;
    let inSec = 0;
    let burntAt = -1;
    for (let i = 0; i < 1500 && burntAt < 0; i++) {
      b.run(0.1);
      const w = privateOf(b, 'P1').thermal!.find((x) => x.stationId === 'pan_a');
      if (w && warnedAt < 0) {
        warnedAt = b.sim.t;
        inSec = w.inSec;
        expect(cookingState(egg())).not.toBe('BURNT');
      }
      if (cookingState(egg()) === 'BURNT') burntAt = b.sim.t;
    }
    expect(warnedAt).toBeGreaterThan(0);
    expect(burntAt).toBeGreaterThan(warnedAt);
    expect(Math.abs((burntAt - warnedAt) / 1000 - inSec)).toBeLessThan(1.6);
    // 只有味覺失調者收到
    expect(b.events.filter((x) => x.e.visual === 'thermal').every((x) => x.to === 'P1')).toBe(true);
  });

  it('距離太遠（超過 4.5 m）就不會預警；沒有危險也不會預警', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D03' } });
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'egg' });
    b.act('P1', 'pan_a', 'heat', { level: 'HIGH' });
    b.act('P1', 'pan_a', 'place');
    Object.assign(b.poses.P1, { x: -8, z: 3 });
    b.run(120);
    expect(b.events.some((x) => x.e.visual === 'thermal')).toBe(false);
    const quiet = bench({ seats: ['P1'], flaws: { P1: 'D03' } });
    quiet.open();
    quiet.act('P1', 'fridge', 'take', { type: 'egg' });
    quiet.act('P1', 'pan_a', 'heat', { level: 'LOW' });
    quiet.act('P1', 'pan_a', 'place');
    quiet.at('P1', 'pan_a');
    quiet.run(20);
    expect(quiet.events.some((x) => x.e.visual === 'thermal')).toBe(false);
  });
});

/* ============================== D04 沉默侍者 ============================== */

describe('D04 沉默侍者', () => {
  it('移動倍率：餐廳 1.3、端盤 1.15（取較大者，不相乘）、其他地方 1；其他卡都是 1', () => {
    const c = DEFAULT_FLAW_CONFIG;
    expect(flawSpeedMultiplier('D04', 'DINING', false, c)).toBe(1.3);
    expect(flawSpeedMultiplier('D04', 'DINING', true, c)).toBe(1.3);
    expect(flawSpeedMultiplier('D04', 'KITCHEN', true, c)).toBe(1.15);
    expect(flawSpeedMultiplier('D04', 'KITCHEN', false, c)).toBe(1);
    for (const f of ['D01', 'D02', 'D03', 'D15'] as const) expect(flawSpeedMultiplier(f, 'DINING', true, c)).toBe(1);
  });

  it('帶位異常客人只要 1.2 秒（一般 2 秒）', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D04', P2: 'D02' } });
    expect(b.sim.flaws.taskMs('P1', 'escort', 2000)).toBe(1200);
    expect(b.sim.flaws.taskMs('P2', 'escort', 2000)).toBe(2000);
  });
});

/* ============================== D15 健忘助手 ============================== */

describe('D15 健忘助手', () => {
  it('同時只記得 2 張單；其他單只剩桌號與時間；真實的訂單完全不受影響；其他人看到完整內容', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D15', P2: 'D04' } });
    openUntilOrders(b, 3);
    const open = b.sim.orders.filter((o) => o.status === 'open');
    expect(open.length).toBeGreaterThanOrEqual(3);
    const mine = b.sim.flaws.ordersFor('P1', b.sim.publicState().orders).filter((o) => o.status === 'open');
    const forgotten = mine.filter((o) => o.forgotten);
    expect(mine.length - forgotten.length).toBeLessThanOrEqual(2);
    for (const o of forgotten) {
      expect(o.recipeId).toBeUndefined();
      expect(o.requestId).toBeUndefined();
      expect(o.table).toBeGreaterThan(0);
      expect(o.deadline).toBeGreaterThan(0);
    }
    expect(b.sim.flaws.ordersFor('P2', b.sim.publicState().orders).some((o) => o.forgotten)).toBe(false);
    expect(b.sim.orders.every((o) => o.recipeId || o.requestId)).toBe(true);
  });

  it('記憶 35 秒後淡掉；到出餐口看單就想起來（超過名額時忘掉最舊的）', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D15' } });
    b.open();
    b.run(1);
    const first = b.sim.orders[0];
    const view = () => b.sim.flaws.ordersFor('P1', b.sim.publicState().orders).find((o) => o.id === first.id)!;
    expect(view().forgotten).toBeUndefined();
    b.run(36);
    expect(view().forgotten).toBe(true);
    const r = b.act('P1', 'pass', 'read', { orderId: first.id });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('想起來了');
    expect(view().forgotten).toBeUndefined();
  });

  it('隊友在 3 公尺內覆誦：額外記得 45 秒、不佔名額；太遠不行', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D15', P2: 'D04' } });
    openUntilOrders(b, 3);
    const view0 = b.sim.flaws.ordersFor('P1', b.sim.publicState().orders).filter((o) => o.status === 'open');
    const remembered0 = view0.filter((o) => !o.forgotten).length;
    const forgotten = view0.find((o) => o.forgotten)!;
    Object.assign(b.poses.P2, { x: b.poses.P1.x + 5, z: b.poses.P1.z });
    expect(b.coop('P2', 'recite', { to: 'P1', orderId: forgotten.id }).ok).toBe(false);
    near(b, 'P1', 'P2', 2);
    expect(b.coop('P2', 'recite', { to: 'P1', orderId: forgotten.id }).ok).toBe(true);
    const mine = b.sim.flaws.ordersFor('P1', b.sim.publicState().orders).filter((o) => o.status === 'open');
    expect(mine.find((o) => o.id === forgotten.id)!.forgotten).toBeUndefined();
    expect(mine.filter((o) => !o.forgotten).length).toBe(remembered0 + 1); // 覆誦不佔名額
    expect(b.events.some((x) => x.to === 'P1' && x.e.visual === 'recite')).toBe(true);
  });

  it('專注單：記得的單才能釘；釘了之後動作加速、少切 1 刀；換單有 20 秒冷卻', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D15' } });
    b.open();
    b.run(1);
    const o = b.sim.orders[0];
    expect(b.coop('P1', 'focus', { orderId: o.id }).ok).toBe(true);
    expect(privateOf(b, 'P1').focus).toBe(o.id);
    b.act('P1', 'fridge', 'take', { type: 'tomato' });
    b.act('P1', 'prep_a', 'place');
    expect(b.act('P1', 'prep_a', 'chop_start', { cut: 'DICED' }).need).toBe(CUT_STROKES.DICED - 1);
    b.act('P1', 'prep_a', 'pick');
    b.act('P1', 'sink', 'place');
    b.act('P1', 'sink', 'wash');
    const t = b.sim.players.P1.task!;
    expect(t.endsAt - t.startedAt).toBe(1600);
    b.run(40);
    // 記憶淡掉也不會忘記專注單
    expect(b.sim.flaws.ordersFor('P1', b.sim.publicState().orders).find((x) => x.id === o.id)!.forgotten).toBeUndefined();
    const other = b.sim.orders.find((x) => x.id !== o.id && x.status === 'open');
    if (other) {
      const before = b.coop('P1', 'focus', { orderId: other.id });
      expect(before.ok || before.message.includes('想不起來')).toBe(true);
    }
    const c = bench({ seats: ['P1'], flaws: { P1: 'D15' } });
    c.open();
    c.run(36);
    const [a1, a2] = c.sim.orders;
    expect(c.coop('P1', 'focus', { orderId: a1.id }).ok).toBe(false); // 已經忘了
    c.act('P1', 'pass', 'read', { orderId: a1.id });
    expect(c.coop('P1', 'focus', { orderId: a1.id }).ok).toBe(true);
    expect(c.coop('P1', 'focus', { orderId: a2.id }).ok).toBe(false);
    c.run(20.1);
    c.act('P1', 'pass', 'read', { orderId: a2.id });
    expect(c.coop('P1', 'focus', { orderId: a2.id }).ok).toBe(true);
  });
});

/* ============================== 共通互助：交接 ============================== */

describe('手對手交接（真的進入交接判定）', () => {
  const setup = () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D02', P2: 'D04' } });
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'tomato' });
    near(b, 'P1', 'P2', 1.2);
    return b;
  };

  it('遞出 → 對方在 4 秒內接住：東西真的換手；重送同一個請求不會重複', () => {
    const b = setup();
    const held = b.sim.players.P1.held;
    expect(b.coop('P1', 'handoff', { to: 'P2' }).ok).toBe(true);
    const offer = b.sim.publicState().coop.handoffs[0];
    expect(offer).toMatchObject({ from: 'P1', to: 'P2', what: '番茄' });
    const r1 = b.coop('P2', 'handoff_accept', { offerId: offer.id }, 'acc-1');
    const r2 = b.coop('P2', 'handoff_accept', { offerId: offer.id }, 'acc-1');
    expect(r1.ok).toBe(true);
    expect(r2).toEqual(r1);
    expect(b.sim.players.P2.held).toEqual(held);
    expect(b.sim.players.P1.held).toBeNull();
    expect(b.sim.publicState().coop.handoffs).toHaveLength(0);
    const tel = b.sim.flaws.telemetrySnapshot();
    expect(tel.D02!.coopOk).toBeGreaterThan(0);
    expect(tel.D04!.coopOk).toBeGreaterThan(0);
  });

  it('太慢、走太遠、對方手上有東西、東西已經不在遞的人手上：交接失敗，東西留在原處', () => {
    const late = setup();
    late.coop('P1', 'handoff', { to: 'P2' });
    const id1 = late.sim.publicState().coop.handoffs[0].id;
    late.run(4.1);
    expect(late.coop('P2', 'handoff_accept', { offerId: id1 }).ok).toBe(false);
    expect(late.sim.players.P1.held?.kind).toBe('item');

    const far = setup();
    far.coop('P1', 'handoff', { to: 'P2' });
    const id2 = far.sim.publicState().coop.handoffs[0].id;
    Object.assign(far.poses.P2, { x: far.poses.P1.x + 4 });
    expect(far.coop('P2', 'handoff_accept', { offerId: id2 }).message).toContain('距離');
    expect(far.sim.players.P1.held?.kind).toBe('item');

    const full = setup();
    // 兩隻手都拿著東西才接不下（一隻手空著就能接）
    full.act('P2', 'fridge', 'take', { type: 'egg', count: 2 });
    near(full, 'P1', 'P2', 1.2);
    full.coop('P1', 'handoff', { to: 'P2' });
    const id3 = full.sim.publicState().coop.handoffs[0].id;
    expect(full.coop('P2', 'handoff_accept', { offerId: id3 }).message).toMatch(/拿著東西|手上還有東西/);

    const gone = setup();
    gone.coop('P1', 'handoff', { to: 'P2' });
    const id4 = gone.sim.publicState().coop.handoffs[0].id;
    gone.act('P1', 'trash', 'discard');
    near(gone, 'P1', 'P2', 1.2);
    expect(gone.coop('P2', 'handoff_accept', { offerId: id4 }).message).toContain('不在他手上');
    expect(gone.sim.players.P2.held).toBeNull();

    expect(setup().coop('P1', 'handoff', { to: 'P1' }).ok).toBe(false);
    const empty = setup();
    empty.act('P1', 'trash', 'discard');
    near(empty, 'P1', 'P2', 1.2);
    expect(empty.coop('P1', 'handoff', { to: 'P2' }).ok).toBe(false);
  });
});

/* ============================== 共通互助：便條 ============================== */

describe('便條（與伺服器狀態連動）', () => {
  it('貼在工作站上；工作站內容一變就標成過期，幾秒後移除；要站在旁邊才能貼；只有固定詞彙', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D15', P2: 'D04' } });
    b.open();
    b.act('P1', 'fridge', 'take', { type: 'tomato' });
    b.act('P1', 'prep_a', 'place');
    b.at('P1', 'prep_a');
    expect(b.coop('P1', 'note', { stationId: 'prep_a', label: 'free text' }).ok).toBe(false);
    expect(b.coop('P1', 'note', { stationId: 'prep_a', label: 'prepped' }).ok).toBe(true);
    Object.assign(b.poses.P2, { x: -8, z: 3 });
    expect(b.coop('P2', 'note', { stationId: 'prep_a', label: 'todo' }).ok).toBe(false);
    b.run(1.1);
    expect(b.sim.publicState().coop.notes[0]).toMatchObject({ stationId: 'prep_a', label: 'prepped', stale: false });
    b.act('P2', 'prep_a', 'pick');
    b.run(1.1);
    expect(b.sim.publicState().coop.notes[0].stale).toBe(true);
    b.run(5.5);
    expect(b.sim.publicState().coop.notes).toHaveLength(0);
  });

  it('連結的訂單結束時，便條也過期', () => {
    const b = bench({ seats: ['P1'], flaws: { P1: 'D15' } });
    b.open();
    b.run(1);
    const o = b.sim.orders[0];
    b.at('P1', 'plating');
    expect(b.coop('P1', 'note', { stationId: 'plating', label: 'waiting', orderId: o.id }).ok).toBe(true);
    b.sim.closeShift();
    b.sim.flaws.tick();
    b.sim.t += 1000;
    b.sim.flaws.tick();
    expect(b.sim.publicState().coop.notes[0]?.stale ?? true).toBe(true);
  });
});

/* ============================== 遙測 ============================== */

describe('flawTelemetry', () => {
  it('記錄每張卡的人數、觸發、互助成功／失敗、被擋下、能力使用與閒置秒數', () => {
    const b = bench({ seats: ['P1', 'P2'], flaws: { P1: 'D02', P2: 'D03' } });
    b.open();
    chopSeries(b, 'P1', 3);
    b.coop('P1', 'tap', { to: 'P2' }); // 太遠 → 失敗
    near(b, 'P1', 'P2', 1);
    b.coop('P1', 'tap', { to: 'P2' });
    tomatoPlate(b, 'P2');
    b.act('P2', 'plating', 'taste');
    b.run(30);
    const t = b.sim.flaws.telemetrySnapshot();
    expect(t.D02).toMatchObject({ players: 1 });
    expect(t.D02!.advantage).toBeGreaterThanOrEqual(2);
    expect(t.D02!.coopOk).toBeGreaterThanOrEqual(1);
    expect(t.D02!.coopFail).toBeGreaterThanOrEqual(1);
    expect(t.D03!.blocked).toBeGreaterThanOrEqual(1);
    expect(t.D02!.idleSec).toBeGreaterThan(0);
    expect(b.sim.flaws.events.length).toBeGreaterThan(0);
  });
});
