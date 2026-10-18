// 應用程式煙霧測試（Linux 版 Electron＋xvfb）。模擬一整個「房主開店 → 朋友用代碼加入 → 存檔 → 下次繼續」的流程：
//
//   起始頁面 → 開始遊戲 → 和朋友一起（假的 cloudflared 開通道、登記代碼到「線上伺服器」）
//   → 網頁版的朋友在線上伺服器輸入代碼 → 查詢處 → 被帶到房主的通道網址 → 加入同一個房間
//   → 開班 → 關掉程式（自動存檔）→ 重開 → 起始頁面的「繼續遊戲」→ 讀檔，回到原本的位置
//
// 「線上伺服器」用本機另開的一個伺服器（server/dist）代替；通道網址用 Playwright 轉到房主的本機伺服器。
// 用法：npm run build -w server && npm run build -w client && node desktop/build/bundle.mjs
//       xvfb-run -a node desktop/test/smoke.mjs [截圖資料夾]
import { _electron as electron, chromium } from '../../node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repo = path.resolve(appDir, '..');
const shots = path.resolve(process.argv[2] || path.join(tmpdir(), 'lt-desktop-shots'));
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(path.join(tmpdir(), 'lt-desktop-data-'));
// LT_EXE＝打包好的程式（例如 release/linux-unpacked/NullLastTable）；沒給就用開發版
const packaged = process.env.LT_EXE || null;
const exe = packaged || path.join(appDir, 'node_modules', 'electron', 'dist', 'electron');
const TUNNEL = 'https://quiet-oven-night.trycloudflare.com';
const ONLINE_PORT = 3902;
const ONLINE = `http://127.0.0.1:${ONLINE_PORT}`;
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (cond, msg) => {
  if (!cond) throw new Error('✗ ' + msg);
  console.log('✓ ' + msg);
};
async function waitFor(fn, ms = 15000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => false);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + what);
    await sleep(200);
  }
}

// ── 準備：線上伺服器、設定、假的 cloudflared ──
const online = spawn(process.execPath, [path.join(repo, 'server/dist/index.cjs')], {
  env: { ...process.env, PORT: String(ONLINE_PORT), NODE_ENV: 'production', DEBUG_TOOLS: '0', CLIENT_DIST: path.join(repo, 'client/dist') },
  stdio: 'ignore',
});
await waitFor(async () => (await fetch(`${ONLINE}/healthz`)).ok, 15000, 'online server');
process.on('exit', () => online.kill());
writeFileSync(path.join(dataDir, 'app.json'), JSON.stringify({ settings: JSON.stringify({ onlineUrl: ONLINE, lan: false }) }));
mkdirSync(path.join(dataDir, 'bin'), { recursive: true });
const fake = path.join(dataDir, 'bin', 'cloudflared');
writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cloudflared version 2026.9.0"; exit 0; fi\necho "INF |  ${TUNNEL}  |" >&2\nexec sleep 120\n#${'x'.repeat(1_100_000)}\n`);
chmodSync(fake, 0o755);

const launch = () => electron.launch({ executablePath: exe, args: ['--no-sandbox', ...GL, ...(packaged ? [] : [appDir])], env: { ...process.env, LAST_TABLE_DATA_DIR: dataDir } });

let app = await launch();
let browser = null;
let code = '';
try {
  const win = await app.firstWindow();
  await win.waitForSelector('.mt-item', { timeout: 30000 });
  const url = win.url();
  check(/^http:\/\/localhost:\d+\/?$/.test(url), `一打開就是本機伺服器的起始頁面 ${url}`);
  const items = await win.$$eval('.mt-item .ti-label', (els) => els.map((e) => e.textContent));
  check(JSON.stringify(items) === JSON.stringify(['開始遊戲', '繼續遊戲', '教學', '營業日誌', '設定', '說明', '離開']), `起始頁面的選單：${items.join('／')}`);
  check(await win.isDisabled('.mt-item:has-text("繼續遊戲")'), '還沒有存檔時「繼續遊戲」不能按');
  await sleep(900);
  await win.screenshot({ path: path.join(shots, '01-title.png') });

  // 教學：從起始頁面進去，教學卡出現；跳過後回到開始遊戲
  await win.click('.mt-item:has-text("教學")');
  await win.waitForSelector('.tut-card', { timeout: 40000 });
  check((await win.textContent('.tut-card')).includes('第一班') && (await win.textContent('.tut-card')).includes('老周'), '起始頁面的「教學」：直接開始「第一班」，畫面上有老周的教學卡');
  await sleep(2500);
  await win.screenshot({ path: path.join(shots, '01b-tutorial.png') });
  await win.evaluate(() => document.exitPointerLock());
  await win.click('.tut-skip');
  await win.waitForSelector('#name', { timeout: 15000 });
  check(!(await win.isVisible('text=第一次玩？')), '跳過教學後回到開始遊戲（之後不再建議教學）');
  await win.click('text=← 回到起始頁面');

  // 設定頁：有連線與個人資料
  await win.click('.mt-item:has-text("設定")');
  await win.waitForSelector('#online-url');
  check((await win.inputValue('#online-url')) === ONLINE, '設定頁顯示線上伺服器網址');
  await win.screenshot({ path: path.join(shots, '02-settings.png'), fullPage: true });
  await win.click('text=← 回到起始頁面');

  // 開始遊戲 → 和朋友一起
  await win.click('.mt-item:has-text("開始遊戲")');
  await win.fill('#name', 'Luz');
  await win.screenshot({ path: path.join(shots, '03-play.png') });
  await win.click('.choice:has-text("和朋友一起")');
  await win.waitForSelector('.code-box', { timeout: 15000 });
  code = (await win.textContent('.code-box')).trim();
  check(/^[A-Z0-9]{6}$/.test(code), `開好房間 ${code}`);
  await win.waitForSelector('.invite-line.big', { timeout: 30000 });
  check((await win.textContent('.invite-line.big')).includes(code), '大廳的邀請卡：「朋友輸入代碼 … 就能加入」');
  const loc = await (await fetch(`${ONLINE}/api/locate/${code}`)).json();
  check(loc.where === 'host' && loc.url === TUNNEL, '房間代碼已經登記到線上伺服器的查詢處');
  await win.screenshot({ path: path.join(shots, '04-lobby-invite.png') });
  await waitFor(async () => JSON.parse(readFileSync(path.join(dataDir, 'prefs.json'), 'utf8'))['last-table.name'] === 'Luz', 5000, 'prefs name');
  check(true, '暱稱寫進電腦裡的 prefs.json');

  // 網頁版的朋友：打開線上伺服器 → 開始遊戲 → 輸入代碼 → 被帶到房主的通道網址
  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: GL });
  const friend = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const hostLocal = url.replace(/\/$/, '');
  await friend.route(`${TUNNEL}/**`, async (route) => {
    const u = new URL(route.request().url());
    try {
      const res = await route.fetch({ url: hostLocal + u.pathname + u.search });
      await route.fulfill({ response: res });
    } catch {
      await route.abort().catch(() => undefined); // 房主關掉程式之後
    }
  });
  await friend.routeWebSocket(/trycloudflare\.com/, (ws) => ws.close());
  await friend.goto(ONLINE + '/');
  await friend.click('.mt-item:has-text("開始遊戲")');
  await friend.fill('#name', 'Bao');
  await friend.fill('input[aria-label="房間代碼"]', code);
  await friend.click('button:text-is("加入")');
  await friend.waitForURL((u) => u.origin === TUNNEL, { timeout: 30000 });
  check(true, `朋友被帶到房主的網址 ${TUNNEL}`);
  await friend.waitForSelector('.code-box', { timeout: 30000 });
  check((await friend.textContent('.code-box')).trim() === code, '朋友進到同一個房間（網址裡的代碼和暱稱自動帶入）');
  check(!friend.url().includes('name='), '暱稱不會留在網址列');
  await waitFor(async () => (await win.textContent('.players')).includes('Bao'), 10000, 'Bao in host lobby');
  check(true, '房主的大廳看到朋友');

  // 開班：各選一張卡、開始、讀完說明按準備好
  await win.click('.flaw-card:has-text("D03")');
  await friend.click('.flaw-card:has-text("D04")');
  await waitFor(async () => !(await win.isDisabled('button:text-is("開始營業")')), 10000, 'can start');
  await win.click('button:text-is("開始營業")');
  for (const p of [win, friend]) {
    await p.waitForSelector('text=我看懂了，準備好', { timeout: 30000 });
    await p.click('text=我看懂了，準備好');
  }
  await sleep(2500);
  check(true, '兩個人開班');
} finally {
  await app.close().catch(() => undefined); // 關程式：先存檔、刪掉代碼登記
}

// 關掉程式後：有「關閉時存檔」，查詢處的代碼刪掉了
const saves = readdirSync(path.join(dataDir, 'saves')).filter((f) => f.endsWith('.json'));
check(saves.some((f) => f.includes('exit')), `關掉程式時自動存檔（${saves.join(', ')}）`);
check((await fetch(`${ONLINE}/api/locate/${code}`)).status === 404, '關掉程式後代碼從查詢處刪掉');

// 重開：繼續遊戲 → 讀檔
app = await launch();
try {
  const win = await app.firstWindow();
  await win.waitForSelector('.mt-item', { timeout: 30000 });
  await waitFor(async () => !(await win.isDisabled('.mt-item:has-text("繼續遊戲")')), 10000, 'continue enabled');
  const note = await win.textContent('.mt-item:has-text("繼續遊戲") .ti-note');
  check(note.includes(code), `起始頁面的「繼續遊戲」顯示最近的存檔：${note}`);
  await sleep(600);
  await win.screenshot({ path: path.join(shots, '05-title-continue.png') });
  await win.click('.mt-item:has-text("繼續遊戲")');
  await win.waitForSelector('.saves-table tbody tr');
  await win.screenshot({ path: path.join(shots, '06-continue.png') });
  check(await win.isChecked('input[type=checkbox]'), '存檔裡有朋友 → 預設「讀檔後邀請朋友」');
  await win.click('.saves-table tbody tr:first-child button:text-is("讀檔")');
  await win.waitForSelector('text=我看懂了，準備好', { timeout: 40000 });
  check((await win.textContent('body')).includes('從存檔讀回來'), '讀檔後回到班次，說明寫著「從存檔讀回來的班次」');
  const sess = JSON.parse(await win.evaluate(() => sessionStorage.getItem('last-table.session')));
  check(sess.code === code, '讀檔後是同一個房間代碼、房主原本的位置');
  await waitFor(async () => (await (await fetch(`${ONLINE}/api/locate/${code}`)).json()).where === 'host', 30000, 're-registered');
  check(true, '讀檔後自動重新邀請：朋友用同一個代碼就能回來');
  await sleep(1200);
  await win.screenshot({ path: path.join(shots, '07-restored.png') });
} finally {
  await app.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  online.kill();
}
check(existsSync(path.join(dataDir, 'app.json')), '應用程式設定存在 app.json');
console.log('\n全部通過。截圖：' + shots);
