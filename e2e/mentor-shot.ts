/**
 * 教學的老周站在場景裡的樣子（歡迎、乾貨架、平底鍋三個位置）。
 * 執行：npx tsx e2e/mentor-shot.ts [網址] [資料夾]
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { walkToPoint } from './walk';

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');
const OUT = process.argv[3] ?? 'mentor-shots';
mkdirSync(OUT, { recursive: true });
type W = { __NP__: { pose: { x: number; z: number; yaw: number; pitch: number }; socket: { emit: (...a: unknown[]) => void } } };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
  await p.addInitScript('window.__name = (f) => f;');
  await p.goto(`${BASE}/?debug`);
  await p.click('.mt-item:has-text("教學")');
  await p.waitForSelector('.tut-card.mentor');
  const lookAt = (x: number, z: number) =>
    p.evaluate(([tx, tz]) => {
      const pose = (window as unknown as W).__NP__.pose;
      Object.assign(pose, { yaw: Math.atan2(-(tx - pose.x), -(tz - pose.z)), pitch: -0.05 });
    }, [x, z] as const);
  await walkToPoint(p, [-0.6, 14.0 - 1.4]);
  await lookAt(-0.6, 11.4);
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${OUT}/m1-welcome.png` });
  await p.keyboard.press('Enter');
  await p.keyboard.press('Enter');
  await walkToPoint(p, [3.0, 12.0]);
  await p.waitForTimeout(500);
  await walkToPoint(p, [0.5, 12.0]);
  await p.keyboard.press('Tab');
  await p.waitForTimeout(500);
  await p.keyboard.press('Tab');
  await p.keyboard.press('KeyR');
  await p.waitForTimeout(800);
  await p.keyboard.press('KeyR');
  // 乾貨架：老周站在旁邊
  await walkToPoint(p, [-1.2, 21.6]);
  await lookAt(1.0, 22.6);
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `${OUT}/m2-pantry.png` });
} finally {
  await browser.close();
}
