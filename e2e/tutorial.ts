/**
 * 新手教學（老周帶班）完整走一遍：從起始頁面進教學，照著每一步做，到「下班」。
 * 每一章拍一張截圖，檢查老周的對話卡、目標標記與步驟判定。
 * 伺服器要用：NODE_ENV=production DEBUG_TOOLS=1
 * 執行：npx tsx e2e/tutorial.ts [網址] [資料夾]
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { STATION_BY_ID, stationFront, type TutorialStepId } from '@last-table/shared';
import { walkToPoint } from './walk';

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');
const OUT = process.argv[3] ?? 'tutorial-shots';
mkdirSync(OUT, { recursive: true });

type St = {
  kitchen: {
    tutorial: { step: TutorialStepId; index: number; total: number; puddle?: [number, number] };
    players: Record<string, { held: { kind: string } | null; basket: string[]; status: string }>;
    stations: Record<string, { items: string[]; plates: string[]; toast: unknown }>;
    threats: { monster: { present: boolean; x: number; z: number } | null; guest: { x: number; z: number } | null };
  };
  me: { role: string };
};
type W = { __NP__: { pose: { x: number; z: number; yaw: number; pitch: number }; socket: { emit: (...a: unknown[]) => void }; useStore: { getState(): St } } };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];
let n = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  if (!ok) throw new Error(what);
};
const state = (p: Page) => p.evaluate(() => (window as unknown as W).__NP__.useStore.getState());
const stepOf = async (p: Page) => (await state(p)).kitchen.tutorial.step;
const act = (p: Page, stationId: string, action: string, args: Record<string, unknown> = {}) =>
  p.evaluate(([s, a, g]) => new Promise<{ ok: boolean; message: string }>((r) => (window as unknown as W).__NP__.socket.emit('kitchen:action', { stationId: s, action: a, args: g, requestId: `e2e${Math.random()}` }, r)), [stationId, action, args] as const);
const must = async (p: Page, stationId: string, action: string, args: Record<string, unknown> = {}) => {
  const r = await act(p, stationId, action, args);
  if (!r.ok) throw new Error(`${stationId}:${action} 失敗：${r.message}`);
  return r;
};
const look = (p: Page, yaw: number, pitch = -0.2) => p.evaluate(([y, pi]) => Object.assign((window as unknown as W).__NP__.pose, { yaw: y, pitch: pi }), [yaw, pitch] as const);
async function go(p: Page, stationId: string): Promise<void> {
  const s = STATION_BY_ID[stationId];
  await walkToPoint(p, stationFront(s, 0.75));
  await look(p, s.facing, -0.3);
}
async function waitStep(p: Page, id: TutorialStepId, timeout = 60_000): Promise<void> {
  await p.waitForFunction((want) => (window as unknown as W).__NP__.useStore.getState().kitchen?.tutorial?.step === want, id, { polling: 250, timeout });
}
async function shot(p: Page, name: string): Promise<void> {
  // 等老周說完（打字效果）
  await p.waitForTimeout(400);
  await p.click('.mentor-row').catch(() => undefined);
  await p.waitForTimeout(900);
  await p.screenshot({ path: `${OUT}/${String(++n).padStart(2, '0')}-${name}.png` });
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript('window.__name = (f) => f;');
  await p.goto(`${BASE}/?debug`);
  console.log('▶ 起始頁面 → 教學');
  await p.click('.mt-item:has-text("教學")');
  await p.waitForSelector('.tut-card.mentor', { timeout: 30_000 });
  check((await p.textContent('.mentor-name'))?.includes('老周') ?? false, '對話卡上是老周');
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${OUT}/${String(++n).padStart(2, '0')}-welcome-typing.png` });
  check((await p.textContent('.tut-actions button'))?.includes('說快一點') || (await p.textContent('.tut-actions button'))?.includes('開始') || false, '歡迎：按鈕會先讓老周說完');
  await shot(p, 'welcome');
  check((await p.textContent('.tut-actions .btn.primary'))?.includes('開始') ?? false, '老周說完：按鈕變成「開始」');
  await p.click('.tut-actions .btn.primary');
  await waitStep(p, 'move');
  check(true, '開始 → 走動');

  console.log('▶ 一・基本');
  await walkToPoint(p, [-0.5, 12.6]);
  await waitStep(p, 'tickets');
  await p.keyboard.press('Tab');
  await waitStep(p, 'cookbook');
  await p.keyboard.press('Tab');
  await p.keyboard.press('KeyR');
  await waitStep(p, 'pantry');
  await p.keyboard.press('KeyR');
  check(true, '看單、查食譜（伺服器收到確認）');

  console.log('▶ 二・拿食材');
  await go(p, 'pantry');
  await shot(p, 'pantry');
  await must(p, 'pantry', 'take', { type: 'bread' });
  await waitStep(p, 'toaster');
  await go(p, 'toaster');
  await must(p, 'toaster', 'quick', { mode: 'primary' });
  await must(p, 'toaster', 'quick', { mode: 'use' });
  await waitStep(p, 'fridge');
  await go(p, 'fridge');
  await must(p, 'fridge', 'take', { type: 'egg', count: 2 });
  await must(p, 'fridge', 'take', { type: 'butter' });
  await waitStep(p, 'hands');
  check((await state(p)).kitchen.players[(await state(p)).me.role].basket.length === 1, '兩顆蛋在手上、奶油進了菜籃');
  await shot(p, 'hands');
  for (let i = 0; i < 2; i++) {
    await p.keyboard.press('KeyB');
    await p.waitForTimeout(500);
  }
  await waitStep(p, 'pan');
  check(true, '按兩次 B：換手、翻到菜籃');
  // 翻回第一隻手
  for (let i = 0; i < 2; i++) {
    await p.keyboard.press('KeyB');
    await p.waitForTimeout(500);
  }

  console.log('▶ 三・做菜到出餐');
  await go(p, 'pan_a');
  await must(p, 'pan_a', 'quick', { mode: 'use' });
  await must(p, 'pan_a', 'quick', { mode: 'primary' });
  await must(p, 'pan_a', 'quick', { mode: 'primary' });
  await waitStep(p, 'cooked');
  await shot(p, 'cooked');
  await waitStep(p, 'butter', 90_000);
  await must(p, 'pan_a', 'heat', { level: 'OFF' });
  await go(p, 'plating');
  await must(p, 'plating', 'quick', { mode: 'primary' });
  await waitStep(p, 'plate_all');
  await must(p, 'plating', 'quick', { mode: 'primary' });
  await go(p, 'pan_a');
  await shot(p, 'plate-all');
  await must(p, 'pan_a', 'quick', { mode: 'primary' });
  await go(p, 'toaster');
  await must(p, 'toaster', 'quick', { mode: 'primary' });
  await waitStep(p, 'season');
  check(true, '拿著盤子在平底鍋、烤麵包機各按一下左鍵：一次裝盤');
  await go(p, 'plating');
  await must(p, 'plating', 'quick', { mode: 'primary' });
  for (const s of ['salt', 'pepper']) {
    await go(p, 'spice');
    await must(p, 'spice', 'measure', { seasoning: s, units: 0.5 });
    await go(p, 'plating');
    await must(p, 'plating', 'pour', {});
  }
  await waitStep(p, 'serve');
  await must(p, 'plating', 'quick', { mode: 'primary' });
  await go(p, 'pass');
  await must(p, 'pass', 'quick', { mode: 'primary' });
  await waitStep(p, 'puddle');
  check(true, '出餐');

  console.log('▶ 四・地上的水');
  const pud = (await state(p)).kitchen.tutorial.puddle!;
  await shot(p, 'puddle');
  await walkToPoint(p, [pud[0] + 0.7, pud[1]]);
  await p.waitForTimeout(400);
  await p.keyboard.press('KeyX');
  await waitStep(p, 'crew', 20_000);
  check(true, '按 X 擦乾積水');
  await shot(p, 'crew');
  await p.keyboard.press('Enter');
  await waitStep(p, 'guest_look');

  console.log('▶ 六・威脅');
  await walkToPoint(p, [4.25, 8.0]);
  const g = (await state(p)).kitchen.threats.guest!;
  const here = await p.evaluate(() => ({ ...(window as unknown as W).__NP__.pose }));
  await look(p, Math.atan2(-(g.x - here.x), -(g.z - here.z)), -0.1);
  await waitStep(p, 'guest_escort', 20_000);
  const g2 = (await state(p)).kitchen.threats.guest!;
  await walkToPoint(p, [g2.x + 0.9, g2.z]);
  const h2 = await p.evaluate(() => ({ ...(window as unknown as W).__NP__.pose }));
  await look(p, Math.atan2(-(g2.x - h2.x), -(g2.z - h2.z)), -0.1);
  await must(p, 'guest', 'escort');
  await waitStep(p, 'backdoor', 20_000);
  check(true, '看著客人、請他回座位');
  await go(p, 'cctv');
  await shot(p, 'backdoor');
  await must(p, 'cctv', 'quick', { mode: 'use' });
  await waitStep(p, 'rifle');
  await go(p, 'gunrack');
  await must(p, 'gunrack', 'quick', { mode: 'primary' });
  await waitStep(p, 'monster');
  check(true, '鎖後門、拿起來福槍');
  // 站在廚房前段等牠走進來（看得到防火門），對準開槍
  await walkToPoint(p, [-2.5, 11.4]);
  await p.waitForFunction(() => {
    const m = (window as unknown as W).__NP__.useStore.getState().kitchen.threats.monster;
    return !!m?.present && m.z < 17.5 && m.z > 10;
  }, undefined, { polling: 200, timeout: 90_000 });
  const m = (await state(p)).kitchen.threats.monster!;
  const me = await p.evaluate(() => ({ ...(window as unknown as W).__NP__.pose }));
  const yaw = Math.atan2(-(m.x - me.x), -(m.z - me.z));
  await look(p, yaw, 0);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/${String(++n).padStart(2, '0')}-monster-aim.png` });
  const m2 = (await state(p)).kitchen.threats.monster!;
  const yaw2 = Math.atan2(-(m2.x - me.x), -(m2.z - me.z));
  await look(p, yaw2, 0);
  const shotRes = await act(p, 'self', 'fire', { yaw: yaw2 });
  console.log(`  開槍：${shotRes.message}`);
  // 被抓了就自己搖開鐵籠；沒打中就躲進餐廳
  for (let i = 0; i < 120; i++) {
    const s0 = await state(p);
    if (s0.kitchen.tutorial.step === 'done') break;
    const me0 = s0.kitchen.players[s0.me.role];
    if (me0.status === 'trapped') await act(p, 'cage', 'struggle');
    else if (!/打中/.test(shotRes.message) && s0.kitchen.threats.monster?.present) await walkToPoint(p, [-6, 4]).catch(() => undefined);
    await p.waitForTimeout(1500);
  }
  await waitStep(p, 'done', 180_000);
  check(true, '後門的東西離開 → 下班');
  await shot(p, 'done');
  check((await p.textContent('.tut-actions'))?.includes('開始真正的一班') ?? false, '下班：可以開始真正的一班');
  console.log(errors.length ? errors.join('\n') : 'no errors');
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
