/**
 * 體型差異截圖（三個人：巨人、小矮人、一般人）：每個人從自己的眼睛高度看另外兩個人。
 * 伺服器要用：NODE_ENV=production DEBUG_TOOLS=1
 * 執行：npx tsx e2e/body-shots.ts [網址] [資料夾]
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { poseOf, stepTo } from './walk';

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');
const OUT = process.argv[3] ?? 'body-shots';
mkdirSync(OUT, { recursive: true });

const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const browsers = [await launch(), await launch(), await launch()];
let next = 0;
const errors: string[] = [];
async function player(name: string): Promise<Page> {
  const ctx = await browsers[next++].newContext({ viewport: { width: 960, height: 600 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await p.addInitScript('window.__name = (f) => f;');
  await p.goto(`${BASE}/?debug`);
  return p;
}
type W = { __NP__: { pose: { x: number; z: number; yaw: number; pitch: number; y: number }; socket: { emit: (...a: unknown[]) => void } } };
const debug = (p: Page, cmd: string) => p.evaluate((c) => new Promise((r) => (window as unknown as W).__NP__.socket.emit('debug:command', { cmd: c }, r)), cmd);
const lookAt = (p: Page, x: number, z: number, pitch: number) =>
  p.evaluate(([tx, tz, pi]) => {
    const pose = (window as unknown as W).__NP__.pose;
    Object.assign(pose, { yaw: Math.atan2(-(tx - pose.x), -(tz - pose.z)), pitch: pi });
  }, [x, z, pitch] as const);

try {
  const A = await player('巨人');
  await A.click('text=開始遊戲');
  await A.fill('#name', '巨人');
  await A.click('text=建立房間');
  await A.waitForSelector('.code-box');
  const code = (await A.textContent('.code-box'))!.trim();
  const join = async (name: string) => {
    const p = await player(name);
    await p.click('text=開始遊戲');
    await p.fill('#name', name);
    await p.fill('input.code', code);
    await p.click('button:text-is("加入")');
    await p.waitForSelector('.code-box');
    return p;
  };
  const B = await join('小矮人');
  const C = await join('一般人');
  await A.click('.flaw-card:has(.code:text-is("D07"))');
  await B.click('.flaw-card:has(.code:text-is("D08"))');
  await C.click('.flaw-card:has(.code:text-is("D03"))');
  await A.waitForFunction(() => (window as unknown as { __NP__: { useStore: { getState(): { room: { canStart: boolean } } } } }).__NP__.useStore.getState().room?.canStart);
  await A.click('text=開始營業');
  for (const p of [A, B, C]) {
    await p.waitForSelector('text=我看懂了，準備好');
    await p.click('text=我看懂了，準備好');
  }
  await debug(A, 'skip_prep');
  await debug(A, 'monster_off');
  await debug(A, 'guest_off');
  // 三個人在中島和出餐口之間排成一個三角形
  await stepTo(A, -1.5, 11.6);
  await stepTo(B, 0.6, 11.2);
  await stepTo(C, 1.2, 12.4);
  await A.waitForTimeout(1500);
  const pa = await poseOf(A);
  const pb = await poseOf(B);
  const pc = await poseOf(C);
  const eye = (p: Page) => p.evaluate(() => (window as unknown as W).__NP__.pose.y.toFixed(2));
  console.log('眼睛高度', await eye(A), await eye(B), await eye(C));
  await lookAt(A, (pb.x + pc.x) / 2, (pb.z + pc.z) / 2, -0.28);
  await lookAt(B, (pa.x + pc.x) / 2, (pa.z + pc.z) / 2, 0.12);
  await lookAt(C, (pa.x + pb.x) / 2, (pa.z + pb.z) / 2, -0.05);
  await A.waitForTimeout(3000);
  await A.screenshot({ path: `${OUT}/b1-giant-view.png` });
  await B.screenshot({ path: `${OUT}/b2-small-view.png` });
  await C.screenshot({ path: `${OUT}/b3-normal-view.png` });
  console.log(errors.length ? errors.join('\n') : 'no errors');
} finally {
  for (const b of browsers) await b.close();
}
