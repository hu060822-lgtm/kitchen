/**
 * 第一版試玩回饋的瀏覽器端到端測試（一個人玩）：
 *   開始頁的人數、自訂按鍵（把「互動」改成 T）、注視冷藏架按數字直接拿（Shift 拿 4 份）、菜籃、
 *   成品架（肉菜分開）、被怪物抓走的過場、單人在鐵籠裡自己掙脫。
 *
 * 伺服器要用：NODE_ENV=production DEBUG_TOOLS=1 PREP_SECONDS=900 SERVICE_SECONDS=1800
 * 執行：npx tsx e2e/playtest.ts http://localhost:3001 playtest-shots
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { STATION_BY_ID, buildColliders, moveWithCollision, stationFront, type DoorState } from '@last-table/shared';
import { gridPath } from '../server/src/kitchen/threats/nav';

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');
const OUT = process.argv[3] ?? 'playtest-shots';
mkdirSync(OUT, { recursive: true });

type Pt = [number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = { __NP__: { useStore: { getState(): any }; pose: { x: number; z: number; yaw: number; pitch: number }; socket: { emit: (...a: unknown[]) => void } } };
const st = <T>(p: Page, fn: string): Promise<T> => p.evaluate(`(() => { const s = window.__NP__.useStore.getState(); return ${fn}; })()`) as Promise<T>;
const errors: string[] = [];
const ref: { browser: Browser | null } = { browser: null };

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`檢查失敗：${msg}`);
  console.log(`  ✓ ${msg}`);
}

const SMALL = { width: 640, height: 400 };
const BIG = { width: 1100, height: 680 };
async function shot(p: Page, name: string, big = true): Promise<void> {
  if (big) {
    await p.setViewportSize(BIG);
    await p.waitForTimeout(600);
  }
  await p.screenshot({ path: `${OUT}/${name}.png` });
  if (big) await p.setViewportSize(SMALL);
}

async function debug(p: Page, cmd: string): Promise<void> {
  const err = await p.evaluate((c) => new Promise<string | null>((resolve) => (window as unknown as Win).__NP__.socket.emit('debug:command', { cmd: c }, (r: { ok: boolean; error?: string }) => resolve(r.ok ? null : (r.error ?? '失敗')))), cmd);
  if (err) throw new Error(`debug ${cmd}：${err}`);
}

async function stepTo(p: Page, x: number, z: number, speed = 3.0): Promise<void> {
  await p.evaluate(
    ([tx, tz, sp]) =>
      new Promise<void>((resolve) => {
        const pose = (window as unknown as Win).__NP__.pose;
        const t = setInterval(() => {
          const dx = tx - pose.x;
          const dz = tz - pose.z;
          const d = Math.hypot(dx, dz);
          const s = sp * 0.033;
          if (d <= s) {
            pose.x = tx;
            pose.z = tz;
            clearInterval(t);
            setTimeout(resolve, 250);
            return;
          }
          pose.x += (dx / d) * s;
          pose.z += (dz / d) * s;
          pose.yaw = Math.atan2(-dx, -dz);
        }, 33);
      }),
    [x, z, speed],
  );
}

async function walkTo(p: Page, target: Pt): Promise<void> {
  const doors = (await st<DoorState>(p, 's.kitchen.doors')) ?? { fire: true };
  const here = await p.evaluate(() => ({ ...(window as unknown as Win).__NP__.pose }));
  const r = moveWithCollision(here.x, here.z, target[0], target[1], buildColliders(doors));
  const pts: Pt[] = [];
  if (r.blocked || Math.hypot(r.x - target[0], r.z - target[1]) > 0.02) {
    const g = gridPath({ x: here.x, z: here.z }, { x: target[0], z: target[1] }, doors.fire, 60000, 0.45);
    if (!g) throw new Error(`找不到路到 ${target.join(',')}`);
    for (const q of g.slice(0, -1)) pts.push([q.x, q.z]);
  }
  pts.push(target);
  for (const pt of pts) await stepTo(p, pt[0], pt[1]);
}

async function face(p: Page, yaw: number, pitch = -0.25): Promise<void> {
  await p.evaluate(([y, pi]) => Object.assign((window as unknown as Win).__NP__.pose, { yaw: y, pitch: pi }), [yaw, pitch]);
  await p.waitForTimeout(200);
}

async function goFace(p: Page, stationId: string): Promise<void> {
  const s = STATION_BY_ID[stationId];
  await walkTo(p, stationFront(s, 0.75));
  await face(p, s.facing, -0.25);
}

/** 按互動鍵打開面前的工作站（軟體算繪很慢，按鍵偶爾會掉：沒打開就再按） */
async function openHere(p: Page): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await p.keyboard.press('KeyT');
    try {
      await p.waitForSelector('.modal.station', { timeout: 4000 });
      return;
    } catch {
      /* 再按一次 */
    }
  }
  throw new Error('打不開面前的工作站');
}

const held = (p: Page) => st<{ held: unknown; basket: string[] }>(p, '({ held: s.kitchen.players[s.me.role].held, basket: s.kitchen.players[s.me.role].basket })');

async function main(): Promise<void> {
  const browser = (ref.browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  }));
  const ctx = await browser.newContext({ viewport: SMALL, permissions: ['microphone'] });
  const P = await ctx.newPage();
  P.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  P.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await P.addInitScript('window.__name = (f) => f;');
  await P.goto(`${BASE}/?debug`);

  console.log('▶ 起始頁面 → 開始遊戲');
  await P.click('.mt-item:has-text("開始遊戲")');
  const meta = (await P.textContent('.docmeta')) ?? '';
  check(meta.includes('1–8') && !meta.includes('固定'), `開始頁的人數改成「${meta.match(/人數[^建]*/)?.[0]?.trim()}」`);

  // 自訂按鍵（起始頁面 → 設定）：把「打開工作站」改成 T
  await P.click('text=← 回到起始頁面');
  await P.click('.mt-item:has-text("設定")');
  await P.click('.kb-row:has(.kb-label:text-is("打開工作站／隊友面板・掙脫鐵籠")) .kb-key >> nth=0');
  await P.keyboard.press('KeyT');
  await P.waitForTimeout(200);
  const label = await P.textContent('.kb-row:has(.kb-label:text-is("打開工作站／隊友面板・掙脫鐵籠")) .kb-key >> nth=0');
  check(label?.trim() === 'T', '在開始頁把「互動」改成 T');
  // 衝突：把 T 改給「標記」→ 互動被清掉；再改回來
  await P.locator('.kb-row').first().scrollIntoViewIfNeeded();
  await shot(P, 'p01-keybinds');

  console.log('▶ 一個人開店');
  await P.click('text=← 回到起始頁面');
  await P.click('.mt-item:has-text("開始遊戲")');
  await P.fill('#name', 'Luz');
  await P.click('text=建立房間');
  await P.waitForSelector('.code-box');
  await P.click('.flaw-card:has(.code:text-is("D03"))');
  await P.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().room?.canStart, undefined, { polling: 200, timeout: 15000 });
  await P.click('text=開始營業');
  await P.waitForSelector('text=我看懂了，準備好');
  await shot(P, 'p01b-briefing');
  check(/時鐘還沒開始/.test((await P.textContent('.modal')) ?? '') && /T/.test((await P.textContent('.modal .kv')) ?? ''), '開班前的操作說明：時鐘還沒開始，按鍵顯示自訂的 T');
  await P.click('text=我看懂了，準備好');
  await P.waitForFunction(() => !(window as unknown as Win).__NP__.useStore.getState().room?.waiting, undefined, { polling: 200, timeout: 8000 });
  check(true, '一個人玩：按下準備好，時鐘就開始走');
  await debug(P, 'skip_prep');
  await debug(P, 'monster_off');
  await debug(P, 'guest_off');

  console.log('▶ 食譜手冊：本班菜單（招牌菜＋今日特餐）、料理圖鑑');
  await P.keyboard.press('KeyR');
  await P.waitForSelector('.recipe-groups', { timeout: 8000 });
  const book = (await P.textContent('.modal')) ?? '';
  check(/本班菜單/.test(book) && /今日特餐/.test(book), '按 R：食譜手冊預設顯示本班菜單，標出今日特餐');
  check((await P.locator('.recipe-groups button').count()) >= 7, '食譜依分類瀏覽（本班菜單＋六個分類）');
  await P.click('.modal button[role="tab"]:text-is("料理圖鑑")');
  check(/還沒有紀錄|發現的料理/.test((await P.textContent('.modal')) ?? ''), '料理圖鑑分頁（本機紀錄）');
  await shot(P, 'p01c-cookbook');
  await P.keyboard.press('Escape');

  console.log('▶ 拿食材：數字鍵直接拿、一次拿多個');
  await goFace(P, 'fridge');
  await shot(P, 'p02-quick-take-prompt');
  const prompt = await P.textContent('.prompt');
  check(prompt?.includes('T') && prompt.includes('直接拿'), `注視冷藏架：提示顯示自訂的 T 鍵與數字快捷鍵（${prompt?.replace(/\s+/g, ' ').trim()}）`);
  check(/換分類/.test(prompt ?? ''), '注視冷藏架：提示列出目前分類的數字鍵，0 換分類');
  // 0：換分類（看著架子就能換）
  const tab0 = await P.evaluate(() => localStorage.getItem('last-table.storageTab'));
  await P.keyboard.press('Digit0');
  await P.waitForFunction((t0) => localStorage.getItem('last-table.storageTab') !== t0, tab0, { polling: 200, timeout: 8000 });
  check(true, '看著冷藏架按 0：換到下一個分類');
  await P.keyboard.press('Digit1'); // 目前分類的第一種
  await P.waitForFunction(() => {
    const s = (window as unknown as Win).__NP__.useStore.getState();
    return !!s.kitchen.players[s.me.role].held;
  }, undefined, { polling: 200, timeout: 8000 });
  await P.keyboard.down('Shift');
  await P.keyboard.press('Digit1');
  await P.keyboard.up('Shift');
  await P.waitForFunction(() => {
    const s = (window as unknown as Win).__NP__.useStore.getState();
    const me = s.kitchen.players[s.me.role];
    return me.basket.length === 2 && !!me.other;
  }, undefined, { polling: 200, timeout: 8000 });
  check(true, '按 1 拿一份、Shift＋1 拿到滿：左手、右手、菜籃 2 格都滿了');
  await shot(P, 'p03-hotbar');
  check((await P.locator('.hotbar .slot').count()) === 4 && (await P.locator('.hotbar .slot.active').count()) === 1, '畫面下方的物品欄：左手、右手、菜籃 2 格，目前的手亮起來');
  // 換手（B）
  const side0 = await st<string>(P, 's.kitchen.players[s.me.role].side');
  await P.keyboard.press('KeyB');
  await P.waitForFunction((s0) => (window as unknown as Win).__NP__.useStore.getState().kitchen.players[(window as unknown as Win).__NP__.useStore.getState().me.role].side !== s0, side0, { polling: 200, timeout: 8000 });
  check(true, `按 B 換手（${side0 === 'R' ? '右手 → 左手' : '左手 → 右手'}）`);
  // 用 T 打開面板（自訂按鍵生效）
  await P.keyboard.press('KeyT');
  await P.waitForSelector('.modal.station', { timeout: 8000 });
  check(true, '按 T（自訂的互動鍵）打開冷藏架');
  await P.click('.modal.station button[aria-label="一次拿 2 份"]');
  await shot(P, 'p04-storage-panel');
  await P.click('.modal.station button[aria-label^="把手上和菜籃裡"]');
  await P.waitForFunction(() => {
    const s = (window as unknown as Win).__NP__.useStore.getState();
    return !s.kitchen.players[s.me.role].held;
  }, undefined, { polling: 200, timeout: 8000 });
  check(true, '全部放回架上');
  // 面板裡按數字鍵：照選的數量（2 份）拿雞腿肉（肉類分頁）與番茄（蔬菜分頁）
  const keyOf = async (name: string): Promise<number> => {
    const order = await P.$$eval('.modal.station .stock:not(.high) .stock-btn span:nth-child(2)', (els) => els.map((e) => e.textContent));
    return order.indexOf(name) + 1;
  };
  await P.click('.modal.station .storage-tabs button[aria-label^="肉類"]');
  const chickenKey = await keyOf('雞腿肉');
  await P.keyboard.press(`Digit${chickenKey}`);
  await P.waitForTimeout(600);
  await P.click('.modal.station .storage-tabs button[aria-label^="蔬菜"]');
  const tomatoKey = await keyOf('番茄');
  await P.keyboard.press(`Digit${tomatoKey}`);
  await P.waitForFunction(() => {
    const s = (window as unknown as Win).__NP__.useStore.getState();
    const me = s.kitchen.players[s.me.role];
    return me.basket.length === 2 && !!me.other;
  }, undefined, { polling: 200, timeout: 8000 });
  check(chickenKey > 0 && tomatoKey > 0, `面板裡切換分頁、按 ${chickenKey}、${tomatoKey}：各拿 2 份（雞腿肉在兩隻手、番茄在菜籃）`);
  await P.keyboard.press('Escape');

  console.log('▶ 成品架：肉菜分開');
  await goFace(P, 'rack_meat');
  await P.keyboard.press('KeyT');
  await P.waitForSelector('.modal.station');
  await P.click('.modal.station button[aria-label^="手上和菜籃裡"]');
  await P.waitForTimeout(800);
  let h = await held(P);
  check(h.basket.length === 1 && !!h.held, `肉類架只收肉：放上 2 份雞腿肉，番茄留在手上（剩 ${h.basket.length + 1} 份）`);
  await P.keyboard.press('Escape');
  await goFace(P, 'rack_veg');
  await P.keyboard.press('KeyT');
  await P.waitForSelector('.modal.station');
  await P.click('.modal.station button[aria-label^="手上和菜籃裡"]');
  await P.waitForTimeout(800);
  h = await held(P);
  check(!h.held && h.basket.length === 0, '番茄放到蔬菜架');
  await shot(P, 'p05-rack-panel');
  await P.keyboard.press('Escape');
  await walkTo(P, [-1.4, 16.6]);
  await face(P, 0, -0.55);
  await shot(P, 'p06-racks-3d');

  console.log('▶ 新設備：攪拌碗、烤箱、水槽接水');
  await goFace(P, 'mixer');
  await openHere(P);
  check(/麵糊/.test((await P.textContent('.modal.station')) ?? ''), '攪拌碗面板：說明麵糊／餡料／拌料');
  await P.keyboard.press('Escape');
  await goFace(P, 'oven');
  await openHere(P);
  await P.click('.modal.station button[aria-label^="210 度"]');
  await P.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().kitchen.stations.oven.heat === 'MED', undefined, { polling: 200, timeout: 8000 });
  check(true, '烤箱：設定 210°C，開始預熱');
  await shot(P, 'p06b-oven-panel');
  await P.keyboard.press('Escape');
  await goFace(P, 'sink');
  await openHere(P);
  await P.click('.modal.station button[aria-label="接一杯水"]');
  await P.waitForFunction(() => {
    const s = (window as unknown as Win).__NP__.useStore.getState();
    const h = s.kitchen.players[s.me.role].held;
    return h?.kind === 'item' && s.kitchen.items[h.id]?.type === 'water';
  }, undefined, { polling: 200, timeout: 8000 });
  check(true, '水槽：接一杯水');
  await P.click('.modal.station button[aria-label="把手上的食材放進水槽"]');
  await P.waitForTimeout(500);
  await P.keyboard.press('Escape');

  console.log('▶ 滑鼠快速操作：左鍵拿／放、右鍵使用');
  // 無頭瀏覽器沒有真的鎖定滑鼠：假裝鎖定，讓點擊照遊戲中的方式處理
  await P.evaluate(() => Object.defineProperty(document, 'pointerLockElement', { get: () => document.body, configurable: true }));
  const pan = () => st<{ heat: string; items: string[] }>(P, 's.kitchen.stations.pan_a');
  await goFace(P, 'rack_veg');
  await P.mouse.down({ button: 'left' });
  await P.mouse.up({ button: 'left' });
  await P.waitForFunction(() => {
    const s = (window as unknown as Win).__NP__.useStore.getState();
    return s.kitchen.players[s.me.role].held?.kind === 'item';
  }, undefined, { polling: 200, timeout: 8000 });
  check(true, '看著成品架按左鍵：拿起番茄');
  await goFace(P, 'pan_a');
  const hint = (await P.textContent('.prompt .mouse-hints')) ?? '';
  check(/左鍵.*放上去/.test(hint) && /右鍵.*開中火/.test(hint), `準星旁提示左鍵、右鍵會做什麼（${hint}）`);
  await shot(P, 'p06c-mouse-hints');
  await P.mouse.down({ button: 'right' });
  await P.mouse.up({ button: 'right' });
  await P.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().kitchen.stations.pan_a.heat === 'MED', undefined, { polling: 200, timeout: 8000 });
  check(true, '看著平底鍋按右鍵：開中火（不用打開面板）');
  await P.mouse.down({ button: 'left' });
  await P.mouse.up({ button: 'left' });
  await P.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().kitchen.stations.pan_a.items.length === 1, undefined, { polling: 200, timeout: 8000 });
  check(!(await P.$('.modal.station')), '按左鍵：番茄下鍋，沒有打開面板');
  // 開著火、鍋裡有東西：右鍵翻面；數字鍵 1 關火
  await P.mouse.down({ button: 'right' });
  await P.mouse.up({ button: 'right' });
  await P.waitForTimeout(500);
  check((await pan()).heat === 'MED', '開著火時右鍵是翻面（火力不變）');
  await P.keyboard.press('Digit1');
  await P.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().kitchen.stations.pan_a.heat === 'OFF', undefined, { polling: 200, timeout: 8000 });
  await P.mouse.down({ button: 'left' });
  await P.mouse.up({ button: 'left' });
  await P.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().kitchen.stations.pan_a.items.length === 0, undefined, { polling: 200, timeout: 8000 }).catch(() => undefined);
  check((await pan()).items.length === 0 && (await pan()).heat === 'OFF', '看著平底鍋按 1 關火（不用開面板）、左鍵拿起來');
  // 面板裡的按鈕標上數字鍵
  await openHere(P);
  const keys = await P.$$eval('.modal.station .body button[data-key]', (bs) => bs.length);
  check(keys > 0, `面板裡的按鈕標上數字鍵（${keys} 個）`);
  await shot(P, 'p06d-panel-digits');
  await P.keyboard.press('Escape');
  await P.evaluate(() => delete (document as unknown as { pointerLockElement?: unknown }).pointerLockElement);

  console.log('▶ 被抓走的過場');
  await walkTo(P, [0.5, 16.8]);
  await face(P, Math.PI / 2, 0);
  await debug(P, 'monster_grab_me');
  // 過場開始後的幾個時間點
  await P.setViewportSize(BIG);
  // 過場的時間軸是用瀏覽器的時鐘：把它凍結在幾個時間點截圖（軟體算繪太慢，即時截不到）
  await P.waitForSelector('.abduct', { timeout: 15000, state: 'attached' });
  check(true, '被抓：播放過場');
  for (const [ms, name] of [
    [350, 'p07-grab-lunge'],
    [800, 'p07b-grab-face'],
    [1250, 'p08-grab-down'],
    [2100, 'p09-grab-black'],
  ] as const) {
    await P.evaluate((t) => (window as unknown as { __abductFreeze?: (ms: number) => void }).__abductFreeze?.(t), ms);
    await P.waitForTimeout(900);
    await P.screenshot({ path: `${OUT}/${name}.png` });
  }
  await P.evaluate(() => (window as unknown as { __abductFreeze?: (ms: number | null) => void }).__abductFreeze?.(null));
  await P.waitForTimeout(2500);
  await P.setViewportSize(SMALL);
  await shot(P, 'p10-cage-prompt');
  const cage = await P.textContent('.cage-prompt');
  check(cage?.includes('沒有人能來救') && cage.includes('T'), `一個人被關：提示自己掙脫（${cage?.replace(/\s+/g, ' ').trim()}）`);

  console.log('▶ 單人自己掙脫');
  await P.keyboard.press('KeyT');
  await P.waitForFunction(() => {
    const s = (window as unknown as Win).__NP__.useStore.getState();
    return s.kitchen.players[s.me.role].task?.kind === 'struggle';
  }, undefined, { polling: 200, timeout: 8000 });
  await shot(P, 'p11-struggling');
  await P.waitForFunction(() => {
    const s = (window as unknown as Win).__NP__.useStore.getState();
    return s.kitchen.players[s.me.role].status === 'ok';
  }, undefined, { polling: 200, timeout: 20000 });
  check(true, '按 T 搖鐵籠，7 秒後自己出來');
  await shot(P, 'p12-escaped');

  console.log('▶ 主廚委託：訂單板列出結構化的必要條件');
  await P.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().kitchen.orders.some((o: { kind: string; status: string }) => o.kind === 'free' && o.status === 'open'), undefined, { polling: 200, timeout: 60000 });
  await P.keyboard.press('Tab');
  await P.waitForSelector('.commission-brief', { timeout: 8000 });
  const brief = (await P.textContent('.commission-brief')) ?? '';
  check(/必要條件/.test(brief) && (await P.locator('.commission-brief li.req').count()) > 0, `訂單板上的委託：主廚的話＋必要條件清單（${brief.replace(/\s+/g, ' ').slice(0, 60)}…）`);
  await shot(P, 'p13-commission');
  await P.keyboard.press('Escape');
}

try {
  await main();
  if (errors.length) {
    console.log('頁面錯誤：');
    for (const e of errors) console.log('  ', e);
  }
  console.log('\n全部通過 ✔');
} catch (e) {
  console.log(`\n✘ ${(e as Error).message}`);
  console.log((e as Error).stack?.split('\n').slice(1, 5).join('\n'));
  if (errors.length) for (const x of errors.slice(-10)) console.log('  ', x);
  process.exitCode = 1;
} finally {
  await ref.browser?.close();
}
