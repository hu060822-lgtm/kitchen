/**
 * 介面截圖（單人、真實解析度 1280×720）：開店後的一般畫面、打開工作站時、隊友面板（需要兩人）。
 * 用來檢查 HUD 佔畫面的比例。執行：npx tsx e2e/ui-shot.ts [網址] [資料夾]
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { poseOf, stepTo } from './walk';

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');
const OUT = process.argv[3] ?? 'ui-shots';
mkdirSync(OUT, { recursive: true });

// 每位玩家一個瀏覽器（同一個瀏覽器裡的第二個分頁會被當成背景分頁，畫面不更新、移動不會送出）
const launch = () =>
  chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
const browsers = [await launch(), await launch()];
let nextBrowser = 0;
const errors: string[] = [];
async function player(name: string): Promise<Page> {
  const ctx = await browsers[nextBrowser++].newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await p.addInitScript('window.__name = (f) => f;');
  await p.goto(`${BASE}/?debug`);
  return p;
}
const st = <T>(p: Page, fn: string): Promise<T> => p.evaluate(`(() => { const s = window.__NP__.useStore.getState(); return ${fn}; })()`) as Promise<T>;
const debug = (p: Page, cmd: string) => p.evaluate((c) => new Promise((r) => (window as unknown as { __NP__: { socket: { emit: (...a: unknown[]) => void } } }).__NP__.socket.emit('debug:command', { cmd: c }, r)), cmd);

try {
  const A = await player('A');
  await A.click('text=開始遊戲'); // 起始頁面
  await A.fill('#name', 'Aki');
  await A.click('text=建立房間');
  await A.waitForSelector('.code-box');
  const code = (await A.textContent('.code-box'))!.trim();
  const B = await player('B');
  await B.click('text=開始遊戲'); // 起始頁面
  await B.fill('#name', 'Bao');
  await B.fill('input.code', code);
  await B.click('button:text-is("加入")');
  await B.waitForSelector('.code-box');
  await A.click('.flaw-card:has-text("健忘助手")');
  await B.click('.flaw-card:has-text("耳背砧板")');
  await A.waitForFunction(() => (window as unknown as { __NP__: { useStore: { getState(): { room: { canStart: boolean } } } } }).__NP__.useStore.getState().room?.canStart);
  await A.click('text=開始營業');
  for (const p of [A, B]) {
    await p.waitForSelector('text=我看懂了，準備好');
    await p.click('text=我看懂了，準備好');
  }
  await debug(A, 'skip_prep');
  await debug(A, 'monster_off');
  await A.evaluate(() => {
    const w = window as unknown as { __NP__: { pose: { x: number; z: number; yaw: number; pitch: number } } };
    w.__NP__.pose.yaw = Math.PI;
    w.__NP__.pose.pitch = -0.12;
  });
  await A.waitForTimeout(Number(process.env.WAIT_MS ?? 40000));
  await A.screenshot({ path: `${OUT}/hud.png` });
  // 餐廳：每張還沒出的單都有客人坐在桌邊
  // 從廚房經過旋轉門走進餐廳
  for (const [x, z] of [[-3.5, 10.6], [3, 10.6], [4.25, 10.4], [4.25, 9.9], [4.25, 9.4], [4.25, 8.9], [4.25, 8.2], [2.2, 8.3]] as const) { await stepTo(A, x, z); if (process.env.TRACE) console.log('  pose', JSON.stringify(await poseOf(A))); }
  await A.evaluate(() => {
    const w = window as unknown as { __NP__: { pose: { x: number; z: number; yaw: number; pitch: number } } };
    Object.assign(w.__NP__.pose, { yaw: 0.3, pitch: -0.14 });
  });
  await debug(A, 'spawn_guest');
  await A.waitForTimeout(2500);
  await A.screenshot({ path: `${OUT}/dining.png` });
  // 往裡面走，看最暗的那一張（那位客人）和旁邊的客人
  for (const [x, z] of [[0.2, 7.9], [0.2, 4.2], [-3.75, 4.2]] as const) await stepTo(A, x, z);
  // 面向那位客人（他在沒人看的時候會換位置）
  await A.evaluate(() => {
    const w = window as unknown as { __NP__: { useStore: { getState(): { kitchen: { threats: { guest?: { x: number; z: number } } } } }; pose: { x: number; z: number; yaw: number; pitch: number } } };
    const g = w.__NP__.useStore.getState().kitchen.threats.guest;
    const p = w.__NP__.pose;
    const yaw = g ? Math.atan2(-(g.x - p.x), -(g.z - p.z)) : 0.45;
    Object.assign(p, { yaw, pitch: -0.2 });
  });
  await A.waitForTimeout(2500);
  await A.screenshot({ path: `${OUT}/dining2.png` });
  console.log('guest', JSON.stringify(await st(A, 's.kitchen.threats.guest')));
  console.log('orders', await st<string>(A, "s.kitchen.orders.map((o) => o.table + ':' + o.status).join(' ')"));
  // 打開面前最近的工作站
  await A.evaluate(() => {
    const w = window as unknown as { __NP__: { pose: { x: number; z: number; yaw: number; pitch: number } } };
    Object.assign(w.__NP__.pose, { x: -4.6, z: 13.8, yaw: Math.PI, pitch: -0.3 });
  });
  await A.waitForTimeout(1500);
  await A.keyboard.press('KeyE');
  await A.waitForTimeout(2500);
  await A.screenshot({ path: `${OUT}/station.png` });
  console.log('station', await st<string | null>(A, 's.station?.id ?? null'));
  console.log(errors.length ? errors.join('\n') : 'no errors');
} finally {
  for (const b of browsers) await b.close();
}
