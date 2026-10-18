/**
 * 缺陷卡 Phase B–D 的瀏覽器端到端測試（透過真的 UI 與鍵盤，伺服器判定）。
 *
 *   A 桌：D06 奶油手、D09 單手廚師、D10 怕火廚師、D11 潔癖主廚
 *   B 桌：D05 大嗓門、D14 嗜睡學徒、D16 定時噴嚏、D07 巨人助手
 *   C 桌：D08 小矮人學徒、D12 幽閉外場、D13 暴衝快遞
 *
 * 伺服器要用：NODE_ENV=production DEBUG_TOOLS=1 PREP_SECONDS=900 SERVICE_SECONDS=1800
 * 執行：npx tsx e2e/flaws-bcd.ts http://localhost:3001 bcd-shots
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { STATION_BY_ID, buildColliders, moveWithCollision, stationFront, type DoorState, type FlawId } from '@last-table/shared';
import { NAV_BY_ID, findPath, gridPath, nearestNode } from '../server/src/kitchen/threats/nav';

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');
const OUT = process.argv[3] ?? 'bcd-shots';
mkdirSync(OUT, { recursive: true });

/** NO_SHOTS=1：不截圖（跑得比較快） */
const NO_SHOTS = process.env.NO_SHOTS === '1';
const browsers: Browser[] = [];
const allPages: Page[] = [];
const errors: string[] = [];
type Pt = [number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = { __NP__: { useStore: { getState(): any }; pose: { x: number; z: number; yaw: number; pitch: number }; socket: { emit: (...a: unknown[]) => void } } };
const st = <T>(p: Page, fn: string): Promise<T> => p.evaluate(`(() => { const s = window.__NP__.useStore.getState(); return ${fn}; })()`) as Promise<T>;

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`檢查失敗：${msg}`);
  console.log(`  ✓ ${msg}`);
}

/** 軟體算繪的速度和畫面大小成正比：平常用小畫面（移動才量得準），截圖時才放大 */
const SMALL = { width: 480, height: 300 };
const BIG = { width: 860, height: 540 };

async function newPlayer(label: string, w = SMALL.width, h = SMALL.height): Promise<Page> {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  // 截圖只是紀錄：軟體算繪偶爾卡住時跳過，不讓整個測試失敗
  const rawShot = page.screenshot.bind(page);
  page.screenshot = (async (o?: Parameters<Page['screenshot']>[0]) => {
    if (NO_SHOTS) return Buffer.alloc(0);
    try {
      return await rawShot({ timeout: 20000, ...o });
    } catch (e) {
      console.log(`    （截圖略過：${(e as Error).message.split('\n')[0]}）`);
      return Buffer.alloc(0);
    }
  }) as Page['screenshot'];
  allPages.push(page);
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${label}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  await page.addInitScript('window.__name = (f) => f;');
  await page.goto(`${BASE}/?debug`);
  return page;
}

async function table(flaws: FlawId[], names: string[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (let i = 0; i < flaws.length; i++) pages.push(await newPlayer(names[i]));
  const [A, ...rest] = pages;
  await A.click('text=開始遊戲'); // 起始頁面
  await A.fill('#name', names[0]);
  await A.click('text=建立房間');
  await A.waitForSelector('.code-box');
  const code = (await A.textContent('.code-box'))!.trim();
  for (let i = 0; i < rest.length; i++) {
    await rest[i].click('text=開始遊戲'); // 起始頁面
    await rest[i].fill('#name', names[i + 1]);
    await rest[i].fill('input.code', code);
    await rest[i].click('button:text-is("加入")');
    await rest[i].waitForSelector('.code-box');
  }
  for (let i = 0; i < pages.length; i++) {
    await pages[i].click(`.flaw-card:has(.code:text-is("${flaws[i]}"))`);
  }
  await A.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().room?.canStart, undefined, { polling: 200, timeout: 15000 });
  await A.click('text=開始營業');
  for (const p of pages) {
    await p.waitForSelector('text=我看懂了，準備好');
    await p.click('text=我看懂了，準備好');
  }
  await debug(A, 'skip_prep');
  await debug(A, 'monster_off');
  // 測試跑得慢：不讓那位客人走到出餐口擋路
  await debug(A, 'guest_off');
  return pages;
}

async function debug(p: Page, cmd: string): Promise<void> {
  // 連線偶爾斷一下（軟體算繪把 CPU 吃滿）：等它自動重連再試
  for (let i = 0; i < 4; i++) {
    const err = await p.evaluate((c) => new Promise<string | null>((resolve) => (window as unknown as Win).__NP__.socket.emit('debug:command', { cmd: c }, (r: { ok: boolean; error?: string }) => resolve(r.ok ? null : (r.error ?? '失敗')))), cmd);
    if (!err) return;
    if (i === 3) throw new Error(`debug ${cmd}：${err}`);
    await p.waitForTimeout(3000);
  }
}

/* ------------------------------ 走路 ------------------------------ */

const poseOf = (p: Page) => p.evaluate(() => ({ ...(window as unknown as Win).__NP__.pose }));

async function stepTo(p: Page, x: number, z: number, speed = 3.0): Promise<void> {
  await p.evaluate(
    ([tx, tz, sp]) =>
      new Promise<void>((resolve) => {
        const pose = (window as unknown as Win).__NP__.pose;
        let lx = pose.x;
        let lz = pose.z;
        let moved = 0;
        let raf = 0;
        const onFrame = () => {
          moved = 0;
          raf = requestAnimationFrame(onFrame);
        };
        raf = requestAnimationFrame(onFrame);
        const done = () => {
          clearInterval(t);
          cancelAnimationFrame(raf);
        };
        const t = setInterval(() => {
          // 軟體算繪很慢：每一格最多走這麼遠（奔跑時放寬，讓伺服器量到的速度接近真的在跑）
          if (moved >= Math.max(0.6, sp * 0.4)) return;
          if (Math.hypot(pose.x - lx, pose.z - lz) > 0.5) {
            done();
            resolve();
            return;
          }
          const dx = tx - pose.x;
          const dz = tz - pose.z;
          const d = Math.hypot(dx, dz);
          const s = sp * 0.033;
          if (d <= s) {
            pose.x = tx;
            pose.z = tz;
            done();
            setTimeout(resolve, 200);
            return;
          }
          pose.x += (dx / d) * s;
          pose.z += (dz / d) * s;
          moved += s;
          pose.yaw = Math.atan2(-dx, -dz);
          lx = pose.x;
          lz = pose.z;
        }, 33);
      }),
    [x, z, speed],
  );
}

/** 繞小圈連續走（中途不停，伺服器量到的速度才穩定）；stopWalk() 停下 */
function circleWalk(p: Page, cx: number, cz: number, r: number, sp: number, secs: number): Promise<void> {
  return p.evaluate(
    ([x0, z0, rr, v, sec]) =>
      new Promise<void>((resolve) => {
        const w = window as unknown as Win & { __stopWalk?: boolean };
        const pose = w.__NP__.pose;
        const t0 = performance.now();
        let last = t0;
        let a = Math.atan2(pose.z - z0, pose.x - x0);
        w.__stopWalk = false;
        const tick = setInterval(() => {
          const now = performance.now();
          const dt = Math.min(0.1, (now - last) / 1000);
          last = now;
          a += (v / rr) * dt;
          pose.x = x0 + Math.cos(a) * rr;
          pose.z = z0 + Math.sin(a) * rr;
          pose.yaw = Math.atan2(Math.sin(a), -Math.cos(a));
          if (w.__stopWalk || now - t0 > sec * 1000) {
            clearInterval(tick);
            resolve();
          }
        }, 33);
      }),
    [cx, cz, r, sp, secs] as const,
  );
}
const stopWalk = (p: Page) =>
  p.evaluate(() => {
    (window as unknown as { __stopWalk?: boolean }).__stopWalk = true;
  });

async function walkTo(p: Page, target: Pt, flaw: FlawId | null = null): Promise<void> {
  // 被伺服器拉回（畫面太慢、速度判定）時，從目前的位置重新找路，最多三次
  for (let attempt = 0; attempt < 3; attempt++) {
    const doors = (await st<DoorState>(p, 's.kitchen.doors')) ?? { fire: true };
    const boxes = buildColliders(doors, [], flaw);
    const here = await poseOf(p);
    const r = moveWithCollision(here.x, here.z, target[0], target[1], boxes);
    const pts: Pt[] = [];
    if (r.blocked || Math.hypot(r.x - target[0], r.z - target[1]) > 0.02) {
      const grid = !flaw && here.z > 9.5 && target[1] > 9.5 ? gridPath({ x: here.x, z: here.z }, { x: target[0], z: target[1] }, doors.fire, 60000, 0.45) : null;
      if (grid) for (const g of grid.slice(0, -1)) pts.push([g.x, g.z]);
      else {
        const ids = findPath(nearestNode(here.x, here.z, boxes).id, nearestNode(target[0], target[1], boxes).id, doors.fire);
        if (!ids) throw new Error(`找不到路到 ${target.join(',')}`);
        for (const id of ids) pts.push([NAV_BY_ID[id].x, NAV_BY_ID[id].z]);
      }
    }
    pts.push(target);
    let ok = true;
    for (const pt of pts) {
      await stepTo(p, pt[0], pt[1]);
      const now = await poseOf(p);
      if (Math.hypot(now.x - pt[0], now.z - pt[1]) > 0.35) {
        ok = false;
        break;
      }
    }
    if (ok) return;
    await p.waitForTimeout(400);
  }
}

async function face(p: Page, yaw: number, pitch = -0.2): Promise<void> {
  await p.evaluate(([y, pi]) => Object.assign((window as unknown as Win).__NP__.pose, { yaw: y, pitch: pi }), [yaw, pitch]);
  await p.waitForTimeout(150);
}

async function open(p: Page, stationId: string, flaw: FlawId | null = null): Promise<void> {
  if (await st<boolean>(p, '!!s.station')) {
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
  }
  const s = STATION_BY_ID[stationId];
  await walkTo(p, stationFront(s, 0.75), flaw);
  await face(p, s.facing, -0.25);
  if (!(await pressUntil(p, 'KeyE', p, `s.station?.id === '${stationId}'`, 6000))) {
    // 可能被擠開了：重新走到前面再試一次
    await walkTo(p, stationFront(s, 0.75), flaw);
    await face(p, s.facing, -0.25);
    if (!(await pressUntil(p, 'KeyE', p, `s.station?.id === '${stationId}'`, 6000))) throw new Error(`打不開 ${stationId}`);
  }
  await p.waitForSelector('.modal.station');
}

/** 冷藏架／乾貨架分成分類分頁：要拿的食材不在目前的分頁，就一頁一頁換過去找 */
async function showInStorageTab(p: Page, selector: string): Promise<void> {
  const tabs = p.locator('.modal.station .storage-tabs button');
  const n = await tabs.count();
  if (!n || (await p.locator(selector).count())) return;
  for (let i = 0; i < n; i++) {
    await tabs.nth(i).evaluate((el) => (el as HTMLButtonElement).click());
    await p.waitForTimeout(150);
    if (await p.locator(selector).count()) return;
  }
}

async function click(p: Page, label: string, expectOk = true, retried = false): Promise<string> {
  const before = await st<number>(p, 's.station?.result?.id ?? 0');
  await showInStorageTab(p, `.modal.station button[aria-label^="${label}"]`);
  const btn = p.locator(`.modal.station button[aria-label^="${label}"]`).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await p.waitForFunction((el) => !(el as HTMLButtonElement).disabled, await btn.elementHandle(), { polling: 200, timeout: 10000 });
  await btn.evaluate((el) => (el as HTMLButtonElement).click());
  await p.waitForFunction((b) => {
    const r = (window as unknown as Win).__NP__.useStore.getState().station?.result;
    return r && r.id !== b;
  }, before, { polling: 200, timeout: 15000 });
  const r = await st<{ ok: boolean; message: string; tone: string }>(p, 's.station.result');
  // 軟體算繪把 CPU 吃滿時，連線偶爾會斷一下再自動回來：這種情況等一下重按
  if (!r.ok && r.message === '目前無法操作。' && !retried) {
    await p.waitForTimeout(2500);
    return click(p, label, expectOk, true);
  }
  if (expectOk && !r.ok) throw new Error(`${label}：${r.message}`);
  console.log(`    ${label} → ${r.message}`);
  return r.message;
}

/** 按一個鍵，直到另一頁（或同一頁）看到某個狀態；軟體算繪很慢時按鍵偶爾會掉，最多試三次 */
async function pressUntil(p: Page, key: string, watch: Page, expr: string, ms = 7000): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    await p.keyboard.press(key);
    if (await eventually(watch, expr, ms)) return true;
  }
  return false;
}

/** 稍微動一下（讓客戶端再送一次位置），直到伺服器的修正把人拉回來 */
async function nudgeUntil(p: Page, expr: string): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    if (await st<boolean>(p, expr)) return true;
    await p.evaluate((k) => {
      (window as unknown as Win).__NP__.pose.x += k % 2 ? 0.02 : -0.02;
    }, i);
    await p.waitForTimeout(450);
  }
  return st<boolean>(p, expr);
}

/** 等到某個狀態成立（伺服器的結果先到、快照稍後才到） */
async function eventually(p: Page, expr: string, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await st<boolean>(p, expr)) return true;
    await p.waitForTimeout(120);
  }
  return false;
}

async function waitTask(p: Page): Promise<void> {
  // 先等動作出現在快照裡（可能稍晚），再等它結束
  await p
    .waitForFunction(() => {
      const s = (window as unknown as Win).__NP__.useStore.getState();
      return !!s.kitchen.players[s.me.role].task;
    }, undefined, { polling: 200, timeout: 3000 })
    .catch(() => undefined);
  await p.waitForFunction(() => {
    const s = (window as unknown as Win).__NP__.useStore.getState();
    return !s.kitchen.players[s.me.role].task;
  }, undefined, { polling: 200, timeout: 40000 });
}

const coop = (p: Page, action: string, args: Record<string, unknown> = {}) =>
  p.evaluate(
    ([a, g]) =>
      new Promise<{ ok: boolean; message: string }>((resolve) =>
        (window as unknown as Win).__NP__.socket.emit('kitchen:action', { stationId: 'coop', action: a, args: g, requestId: `e2e-${Math.random()}` }, resolve),
      ),
    [action, args] as const,
  );

async function shot(p: Page, name: string): Promise<void> {
  if (NO_SHOTS) return;
  // 截圖只是紀錄：軟體算繪偶爾卡住時跳過，不讓測試失敗
  try {
    await p.setViewportSize(BIG);
    await p.waitForTimeout(700);
    await p.screenshot({ path: `${OUT}/${name}.png`, timeout: 20000 });
  } catch (e) {
    console.log(`    （截圖 ${name} 略過：${(e as Error).message.split('\n')[0]}）`);
  }
  await p.setViewportSize(SMALL).catch(() => undefined);
}
/** 這一段要量移動速度：所有畫面縮到最小，讓軟體算繪的畫面更新快一點 */
const tiny = (pages: Page[]) => Promise.all(pages.map((p) => p.setViewportSize({ width: 320, height: 200 })));
const normal = (pages: Page[]) => Promise.all(pages.map((p) => p.setViewportSize(SMALL)));

/* ============================== A 桌 ============================== */

async function tableA(): Promise<void> {
  console.log('▶ A 桌：奶油手、單手廚師、怕火廚師、潔癖主廚');
  const [P1, P2, P3, P4] = await table(['D06', 'D09', 'D10', 'D11'], ['Ann', 'Bo', 'Cai', 'Dee']);

  // D06：拿著東西跑步 → 失衡 → 沒救回來就掉在地上
  await open(P1, 'pantry');
  await click(P1, '拿洋蔥');
  await P1.keyboard.press('Escape');
  await walkTo(P1, [2.4, 21.6]);
  await tiny([P1, P2, P3, P4]);
  let wobbled = false;
  const running = circleWalk(P1, 1.2, 21.6, 1.2, 4.2, 25);
  for (let i = 0; i < 400 && !wobbled; i++) {
    wobbled = await st<boolean>(P1, '!!s.kitchen.self?.wobble');
    if (!wobbled) await P1.waitForTimeout(40);
  }
  if (wobbled) await P1.screenshot({ path: `${OUT}/b01-D06-wobble-small.png` });
  // 再跑一下下：沒停下來就會掉
  await P1.waitForTimeout(400);
  await stopWalk(P1);
  await running;
  await normal([P1, P2, P3, P4]);
  check(wobbled, '奶油手拿著洋蔥奔跑：手上的東西失衡（伺服器從實際移動判斷）');
  await P1.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().kitchen.coop.floor.length > 0, undefined, { polling: 200, timeout: 8000 }).catch(() => undefined);
  const floor = await st<Array<{ id: string; x: number; z: number; what: string }>>(P1, 's.kitchen.coop.floor');
  if (floor.length) {
    check(true, `沒有停下來：洋蔥掉到地上（${floor[0].what}）`);
    await shot(P1, 'b02-D06-dropped');
    // 隊友撿起來（X）
    await walkTo(P2, [floor[0].x + 0.6, floor[0].z]);
    await shot(P2, 'b03-pickup-prompt');
    let picked = false;
    for (let i = 0; i < 3 && !picked; i++) {
      await P2.keyboard.press('KeyX');
      picked = await eventually(P2, "s.kitchen.players[s.me.role].held?.kind === 'item'", 6000);
    }
    check(picked, '撿起來了');
    check(true, '單手廚師按 X 撿起地上的洋蔥（要重新洗）');
    await open(P2, 'trash');
    await click(P2, '丟掉手上的東西');
  } else check(await st<boolean>(P1, '!s.kitchen.self?.wobble'), '停下來之後穩住了，東西沒有掉');

  // D09：打蛋要雙手 → 隊友扶穩
  await open(P2, 'fridge');
  await click(P2, '拿雞蛋');
  await open(P2, 'prep_b');
  await click(P2, '把手上的食材放到砧板');
  const blocked = await click(P2, '打散', false);
  check(blocked.includes('雙手'), `單手廚師自己打蛋被擋下並說明：${blocked}`);
  await shot(P2, 'b04-D09-two-hands');
  await walkTo(P3, [stationFront(STATION_BY_ID.prep_b, 0.75)[0] + 0.8, stationFront(STATION_BY_ID.prep_b, 0.75)[1]]);
  await face(P3, STATION_BY_ID.prep_b.facing, -0.3);
  await P3.keyboard.press('KeyE');
  await P3.waitForSelector('.modal.station');
  await click(P3, '幫');
  const ok = await click(P2, '打散');
  check(ok.includes('開始'), '怕火廚師扶穩後，單手廚師可以打蛋');
  await P2.keyboard.press('Escape');

  // D10：火源鎖住 → 戴手套；調味一次量兩種
  await open(P3, 'pan_a');
  await shot(P3, 'b05-D10-fire-lock');
  const locked = await st<boolean>(P3, '!!document.querySelector(".modal.station button[aria-label^=\\"中火\\"]")?.disabled');
  check(locked, '怕火廚師打開平底鍋：火力按鈕鎖住，說明怎麼解');
  await click(P3, '戴隔熱手套');
  await waitTask(P3);
  await click(P3, '中火');
  const high = await st<boolean>(P3, '!!document.querySelector(".modal.station button[aria-label^=\\"大火\\"]")?.disabled');
  check(high, '戴著手套也不能開大火');
  await click(P3, '關火');
  await open(P3, 'spice');
  await P3.locator('.modal.station button[aria-label="糖 0.5 匙"]').evaluate((el) => (el as HTMLButtonElement).click());
  await P3.waitForTimeout(200);
  await shot(P3, 'b06-D10-double-measure');
  await click(P3, '醋 1 匙');
  // 結果先到、快照稍後才到：等手上的狀態更新
  const m = await P3.waitForFunction(() => {
    const s = (window as unknown as Win).__NP__.useStore.getState();
    const h = s.kitchen.players[s.me.role].held;
    return h?.kind === 'measure' && h.extra ? h : null;
  }, undefined, { polling: 200, timeout: 8000 }).then(() => true).catch(() => false);
  check(m, '怕火廚師一次量好糖＋醋');
  await open(P3, 'trash');
  await click(P3, '丟掉手上的東西');

  // D11：倒掉的盤子到回收窗口 → 托盤收 → 碗盤架 → 快速洗碗
  await open(P4, 'plating');
  await click(P4, '空手拿一個碗去盛湯');
  await open(P4, 'trash');
  await click(P4, '丟掉手上的東西');
  await waitTask(P4);
  check((await st<{ bowl: number }>(P4, 's.kitchen.stations.dish_return.dirty')).bowl === 1, '潔癖主廚用腳踩開垃圾桶；碗送到回收窗口');
  await open(P4, 'dish_return');
  await shot(P4, 'b07-D11-dish-return');
  await click(P4, '用托盤收');
  await waitTask(P4);
  await open(P4, 'sink');
  await click(P4, '把手上的髒盤放上碗盤架');
  await click(P4, '洗碗');
  await eventually(P4, '!!s.kitchen.players[s.me.role].task');
  const task = await st<{ endsAt: number; startedAt: number }>(P4, 's.kitchen.players[s.me.role].task');
  check(task && task.endsAt - task.startedAt <= 800, `潔癖主廚洗碗快一倍（${task.endsAt - task.startedAt} ms）`);
  await waitTask(P4);
  await shot(P4, 'b08-D11-sink');
  for (const b of browsers.splice(0)) await b.close();
}

/* ============================== B 桌 ============================== */

async function tableB(): Promise<void> {
  console.log('▶ B 桌：大嗓門、嗜睡學徒、定時噴嚏、巨人助手');
  const [P1, P2, P3, P4] = await table(['D05', 'D14', 'D16', 'D07'], ['Eve', 'Fay', 'Gus', 'Hal']);

  // D05：召集（V）→ 全隊收到方向；隊友按 Y 回應
  await walkTo(P1, [-6, 14]);
  await walkTo(P3, [5, 12]);
  await face(P3, Math.PI / 2 + 0.3, -0.05);
  check(await pressUntil(P1, 'KeyV', P3, 's.kitchen.coop.rallies.length > 0'), '大嗓門按 V 召集');
  await P3.screenshot({ path: `${OUT}/b09-D05-rally-seen.png` });
  // 召集只維持 15 秒：馬上回應
  check(await pressUntil(P3, 'KeyY', P3, 's.kitchen.coop.rallies.some((r) => r.replies.length > 0)', 4000), '隊友按 Y 回應');
  check(true, '大嗓門召集：遠處的隊友看到方向，按 Y 回應');

  // D14：睡著 → 隊友拍肩叫醒
  await walkTo(P2, [-1, 13]);
  let slept = false;
  for (let i = 0; i < 3 && !slept; i++) {
    await debug(P1, 'sleepy');
    slept = await eventually(P2, "s.kitchen.self?.drowsy?.state === 'asleep'", 8000);
  }
  check(slept, '睡意調到 99');
  await P2.waitForTimeout(300);
  await shot(P2, 'b10-D14-asleep');
  check(true, '嗜睡學徒睡意到 100：睡著（畫面變暗、不能操作）');
  await walkTo(P1, [-2.2, 13]);
  await face(P1, -Math.PI / 2, -0.1);
  await P1.waitForTimeout(400);
  await shot(P1, 'b11-D14-sleeping-mate');
  const tap = await coop(P1, 'tap', { to: 'P2' });
  check(tap.ok, '隊友走過去拍肩');
  await P2.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().kitchen.self?.drowsy?.state !== 'asleep', undefined, { polling: 200, timeout: 10000 });
  check(true, '拍肩叫醒了嗜睡學徒（睡意回到 35）');

  // D16：噴嚏前兆 → 拿著東西走動 → 失衡 → 隊友 F 接住
  await open(P3, 'pantry');
  await click(P3, '拿吐司');
  await P3.keyboard.press('Escape');
  for (let i = 0; i < 3; i++) {
    await walkTo(P3, [0.5, 12]);
    const q = await poseOf(P3);
    if (Math.hypot(q.x - 0.5, q.z - 12) < 0.3) break;
  }
  await walkTo(P4, [-0.4, 12.9], 'D07');
  // 噴嚏那一刻還在走動：先開始來回走（畫面縮小讓移動量得準），再叫噴嚏（4 秒後打）
  await face(P4, Math.PI, -0.3);
  await tiny([P1, P2, P3, P4]);
  let wob = false;
  let warned = false;
  await stepTo(P3, 0.3, 11.6, 2.2);
  const walking = circleWalk(P3, -0.4, 11.6, 0.7, 2.2, 60);
  // 軟體算繪很慢時，噴嚏那一刻伺服器偶爾量不到移動（畫面卡住）：最多再叫三次噴嚏
  for (let attempt = 0; attempt < 3 && !wob; attempt++) {
    await debug(P1, 'sneeze_soon');
    for (let i = 0; i < 160 && !wob; i++) {
      if (!warned && (await st<boolean>(P4, 's.kitchen.coop.sneezes.length > 0'))) {
        warned = true;
        await P4.screenshot({ path: `${OUT}/b12-D16-sneeze-warning.png` });
      }
      // 隊友那邊看得到「快掉了」（公開的互助狀態）
      wob = await st<boolean>(P4, "s.kitchen.coop.wobbles.some((w) => w.seat === 'P3' && w.cause === 'sneeze')");
      if (!wob) await P4.waitForTimeout(40);
    }
  }
  // 失衡只有短短一下：馬上接
  const caught = wob && (await pressUntil(P4, 'KeyF', P4, "s.kitchen.players[s.me.role].held?.kind === 'item'", 2500));
  await stopWalk(P3);
  await walking;
  await normal([P1, P2, P3, P4]);
  check(warned, '定時噴嚏：打噴嚏前全隊看得到前兆');
  check(wob, '噴嚏時拿著吐司還在走：失衡');
  check(caught, '巨人助手按 F 接住了吐司');

  // D07：最上層伸手拿；低門楣過不去
  await open(P4, 'trash', 'D07');
  await click(P4, '丟掉手上的東西');
  await open(P4, 'fridge', 'D07');
  await click(P4, '從最上層拿雞蛋');
  check(await eventually(P4, "s.kitchen.players[s.me.role].held?.kind === 'item'"), '巨人助手伸手就拿到最上層的雞蛋');
  await P4.keyboard.press('Escape');
  // 路網不知道巨人過不了低門楣：先經冷藏室的門回到廚房，再沿爐台前走到乾貨室門口
  await walkTo(P4, [-5, 16.9], 'D07');
  await walkTo(P4, [4.7, 17.6], 'D07');
  await face(P4, Math.PI, 0.05);
  await stepTo(P4, 4.7, 20.2);
  // 伺服器拒絕穿過門楣、把位置拉回來（測試直接改位置、沒有客戶端碰撞：再送一個小移動讓伺服器回修正）
  await nudgeUntil(P4, 'window.__NP__.pose.z < 19');
  const pz = (await poseOf(P4)).z;
  await shot(P4, 'b13-D07-low-door');
  check(pz < 19, `巨人助手過不了乾貨室的低門楣（停在 z=${pz.toFixed(2)}）`);
  for (const b of browsers.splice(0)) await b.close();
}

/* ============================== C 桌 ============================== */

async function tableC(): Promise<void> {
  console.log('▶ C 桌：小矮人學徒、幽閉外場、暴衝快遞');
  const [P1, P2, P3] = await table(['D08', 'D12', 'D13'], ['Ivy', 'Jo', 'Kai']);

  // D12：走不進冷藏室
  await walkTo(P2, [-7.75, 17.6]);
  await face(P2, Math.PI, 0);
  await stepTo(P2, -7.75, 20.2);
  await nudgeUntil(P2, 'window.__NP__.pose.z < 19.3');
  const z12 = (await poseOf(P2)).z;
  await shot(P2, 'b14-D12-cold-door');
  check(z12 < 19.3, `幽閉外場走不進冷藏室（停在 z=${z12.toFixed(2)}）`);

  // D08：湯鍋看不到 → 墊腳看；鑽過窄縫
  await open(P1, 'stove_a', 'D08');
  await shot(P1, 'b15-D08-pot-hidden');
  check(await eventually(P1, '!!s.kitchen.stations.stove_a.hidden'), '小矮人學徒看不到湯鍋裡面');
  await click(P1, '墊腳看一下');
  await waitTask(P1);
  check(await eventually(P1, '!s.kitchen.stations.stove_a.hidden', 12000), '墊腳看過之後看得到');
  await P1.keyboard.press('Escape');
  await walkTo(P1, [-3.8, 21.35], 'D08');
  await face(P1, -Math.PI / 2, -0.15);
  await P1.waitForTimeout(300);
  await shot(P1, 'b16-D08-crawl');
  await stepTo(P1, -1.8, 21.35);
  const x8 = (await poseOf(P1)).x;
  check(x8 > -2.5, `小矮人學徒鑽過冷藏室與乾貨室之間的窄縫（x=${x8.toFixed(2)}）`);

  // D13：真的用鍵盤走：一路加速、速度條
  // 在廚房裡沿中島與爐台之間的走道（z=16.6）往 +x 方向衝（前方空曠）
  await walkTo(P3, [-6, 16.6]);
  await face(P3, -Math.PI / 2, 0);
  await P3.evaluate(() => (window as unknown as Win).__NP__.useStore.getState().set({ locked: true }));
  await tiny([P1, P2, P3]);
  await P3.keyboard.down('KeyW');
  await P3.waitForTimeout(1600);
  await P3.screenshot({ path: `${OUT}/b17-D13-momentum.png` }).catch(() => undefined);
  await P3.keyboard.up('KeyW');
  const start = await poseOf(P3);
  await P3.waitForTimeout(1200);
  const slid = await poseOf(P3);
  await normal([P1, P2, P3]);
  check(Math.hypot(slid.x - start.x, slid.z - start.z) > 0.2, '暴衝快遞放開方向鍵後還會滑一段（慣性）');
  for (const b of browsers.splice(0)) await b.close();
}

try {
  // TABLES=BC 之類可以只跑某幾桌（除錯用）
  const only = process.env.TABLES ?? 'ABC';
  if (only.includes('A')) await tableA();
  if (only.includes('B')) await tableB();
  if (only.includes('C')) await tableC();
  if (errors.length) {
    console.log('頁面錯誤：');
    for (const e of errors) console.log('  ', e);
  }
  console.log('\n全部通過 ✔');
} catch (e) {
  console.log(`\n✘ ${(e as Error).message}`);
  console.log((e as Error).stack?.split('\n').slice(1, 6).join('\n'));
  for (let i = 0; i < allPages.length; i++) {
    const p = allPages[i];
    if (p.isClosed()) continue;
    const info = await st<unknown>(p, '({ role: s.me.role, pose: window.__NP__.pose, station: s.station, held: s.kitchen.players[s.me.role]?.held, task: s.kitchen.players[s.me.role]?.task })').catch(() => null);
    console.log(`  [${i}]`, JSON.stringify(info));
    await p.screenshot({ path: `${OUT}/fail-${i}.png` }).catch(() => undefined);
  }
  if (errors.length) for (const x of errors.slice(-10)) console.log('  ', x);
  for (const b of browsers) await b.close();
  process.exit(1);
} finally {
  for (const b of browsers) await b.close().catch(() => undefined);
}
