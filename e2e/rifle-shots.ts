/**
 * 來福槍截圖與流程：走到槍架、拿槍（十字準心）、怪物在前面（準心變紅）、開槍打退牠；另外拍拿著盤子一次裝盤。
 * 伺服器要用：NODE_ENV=production DEBUG_TOOLS=1
 * 執行：npx tsx e2e/rifle-shots.ts [網址] [資料夾]
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { walkToPoint } from './walk';
const stepTo = (p: Page, x: number, z: number) => walkToPoint(p, [x, z]);

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');
const OUT = process.argv[3] ?? 'rifle-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];
type St = { kitchen: { players: Record<string, { held: { kind: string } | null; side: string; basket: string[] }>; rifle: { ammo: number; holder: string | null }; threats: { monster: { present: boolean; x: number; z: number } | null }; stations: Record<string, { items: string[] }> }; me: { role: string } };
type W = { __NP__: { pose: { x: number; z: number; yaw: number; pitch: number }; socket: { emit: (...a: unknown[]) => void }; useStore: { getState(): St } } };
const debug = (p: Page, cmd: string) => p.evaluate((c) => new Promise((r) => (window as unknown as W).__NP__.socket.emit('debug:command', { cmd: c }, r)), cmd);
const act = (p: Page, stationId: string, action: string, args: Record<string, unknown> = {}) =>
  p.evaluate(([s, a, g]) => new Promise<{ ok: boolean; message: string }>((r) => (window as unknown as W).__NP__.socket.emit('kitchen:action', { stationId: s, action: a, args: g, requestId: `e2e${Math.random()}` }, r)), [stationId, action, args] as const);
const state = (p: Page) => p.evaluate(() => (window as unknown as W).__NP__.useStore.getState());
const look = (p: Page, yaw: number, pitch = 0) => p.evaluate(([y, pi]) => Object.assign((window as unknown as W).__NP__.pose, { yaw: y, pitch: pi }), [yaw, pitch] as const);
const must = (r: { ok: boolean; message: string }, what: string) => {
  console.log(`${what}：${r.message}`);
  if (!r.ok) throw new Error(`${what} 失敗：${r.message}`);
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 680 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript('window.__name = (f) => f;');
  await p.goto(`${BASE}/?debug`);
  await p.click('text=開始遊戲');
  await p.fill('#name', '試槍');
  await p.click('text=建立房間');
  await p.waitForSelector('.code-box');
  await p.click('.flaw-card:has(.code:text-is("D03"))');
  await p.click('text=開始營業');
  await p.waitForSelector('text=我看懂了，準備好');
  await p.click('text=我看懂了，準備好');
  await debug(p, 'skip_prep');
  await debug(p, 'monster_off');
  await debug(p, 'guest_off');

  // 1. 換手：空手按 B 也會換
  const side0 = (await state(p)).kitchen.players[(await state(p)).me.role].side;
  await p.keyboard.press('KeyB');
  await p.waitForTimeout(400);
  const side1 = (await state(p)).kitchen.players[(await state(p)).me.role].side;
  console.log(`空手換手：${side0} → ${side1}`);
  if (side0 === side1) throw new Error('空手按 B 沒有換手');

  // 2. 一次裝盤：兩顆蛋放進平底鍋，拿盤子按左鍵（伺服器的 quick）
  await stepTo(p, -6.1, 25.3);
  must(await act(p, 'fridge', 'take', { type: 'egg', count: 2 }), '拿蛋');
  await stepTo(p, -1.2, 17.4);
  must(await act(p, 'pan_a', 'place'), '下鍋');
  must(await act(p, 'pan_a', 'place'), '下鍋');
  must(await act(p, 'pan_a', 'heat', { level: 'MED' }), '開火');
  await p.waitForTimeout(2500);
  await stepTo(p, -6, 11);
  must(await act(p, 'plating', 'new_plate', { vessel: 'plate', hold: true }), '拿盤子');
  await stepTo(p, -1.2, 17.3);
  await look(p, Math.PI, -0.55);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/r1-plate-all-hint.png` });
  must(await act(p, 'pan_a', 'quick', { mode: 'primary' }), '一次裝盤');
  must(await act(p, 'pan_a', 'heat', { level: 'OFF' }), '關火');
  await stepTo(p, 2.2, 10.5);
  must(await act(p, 'trash', 'discard'), '倒掉');

  // 3. 槍架
  await stepTo(p, 7.6, 10.3);
  await look(p, -Math.PI / 2, -0.12);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/r2-gunrack.png` });
  must(await act(p, 'gunrack', 'quick', { mode: 'primary' }), '拿槍');
  // 4. 轉身面向廚房，怪物出現在前面 5 公尺
  await stepTo(p, 5.5, 13.5);
  await look(p, Math.PI / 2, 0);
  await p.waitForTimeout(600);
  await debug(p, 'monster_front');
  await p.waitForTimeout(1500);
  const st = await state(p);
  console.log('怪物', JSON.stringify(st.kitchen.threats.monster), '槍', JSON.stringify(st.kitchen.rifle));
  await p.screenshot({ path: `${OUT}/r3-aimed.png` });
  // 5. 轉向牠（準心變紅）再開槍
  const m = st.kitchen.threats.monster!;
  const me = await p.evaluate(() => ({ ...(window as unknown as W).__NP__.pose }));
  const yaw = Math.atan2(-(m.x - me.x), -(m.z - me.z));
  await look(p, yaw, 0);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/r3-aimed.png` });
  must(await act(p, 'self', 'fire', { yaw }), '開槍');
  await p.waitForTimeout(150);
  await p.screenshot({ path: `${OUT}/r4-fired.png` });
  await p.waitForTimeout(1500);
  const after = await state(p);
  console.log('開槍後 子彈', after.kitchen.rifle.ammo);
  if (after.kitchen.rifle.ammo !== 3) throw new Error('子彈數不對');
  console.log(errors.length ? errors.join('\n') : 'no errors');
} finally {
  await browser.close();
}
