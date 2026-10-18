/**
 * 預覽頁截圖（不連伺服器的 ?preview=… 頁面）。
 *   npx tsx e2e/preview-shot.ts [網址] [資料夾] monster:lineup monster:pov guests:table …
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');
const OUT = process.argv[3] ?? 'preview-shots';
const shots = process.argv.slice(4);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors: string[] = [];
try {
  for (const s of shots) {
    const [preview, shot] = s.split(':');
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => errors.push(`${s}: ${e.message}`));
    page.on('console', (m) => m.type() === 'warning' && /模型|角色/.test(m.text()) && errors.push(`${s}: ${m.text()}`));
    await page.goto(`${BASE}/?preview=${preview}&shot=${shot}`);
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${OUT}/${preview}-${shot}.png` });
    await page.close();
  }
  console.log(errors.length ? errors.join('\n') : 'no errors');
} finally {
  await browser.close();
}
