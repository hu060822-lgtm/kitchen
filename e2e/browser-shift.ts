/**
 * 瀏覽器端到端測試（缺陷卡 Phase A）：五個真正的 Chromium（五個獨立的瀏覽器行程，就像五台電腦），
 * 各選一張 Phase A 的缺陷卡，透過實際的前端 UI 開店、備料、出餐，並實際使用每一種互助操作：
 *
 *   P1 耳背砧板 D02：連續備料，刀數真的變少；被拍肩時畫面出現方向提示
 *   P2 味覺失調者 D03：大火上的蛋快燒焦前收到預警、及時關火；收到隊友的試吃回報
 *   P3 幻聽外場 D01：聽到傳聞 → 貼上訂單板 → 隊友到出餐口核對 → 全隊看到準備提示
 *   P4 健忘助手 D15：記不住的單只剩桌號 → 到出餐口看單想起來；接住隊友遞來的東西；重新整理後記憶還在
 *   P5 沉默侍者 D04：沒有麥克風；做吐司、裝盤、出餐；把東西遞給隊友（交接判定）
 *
 * 執行：先 `npm run build`，以下列環境變數啟動伺服器，然後 npx tsx e2e/browser-shift.ts [網址] [截圖資料夾]
 *   NODE_ENV=production DEBUG_TOOLS=1 PREP_SECONDS=900 SERVICE_SECONDS=1800 FLAW_CONFIG='{"D01":{"firstFakeMs":3000,"leakLeadMs":150000}}'
 * （FLAW_CONFIG 只是讓傳聞早一點出現，省下測試時間；開發者工具只用來跳過備料、直接打烊。）
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { STATION_BY_ID, buildColliders, moveWithCollision, stationFront, type DoorState, type Seat } from '@last-table/shared';
import { NAV_BY_ID, findPath, nearestNode } from '../server/src/kitchen/threats/nav';

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');
const OUT = process.argv[3] ?? 'e2e-shots';
mkdirSync(OUT, { recursive: true });

const launch = () =>
  chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
const browsers: Browser[] = [];
const errors: string[] = [];
const pages = {} as Record<Seat, Page>;

async function newPlayer(role: Seat, w = 800, h = 520): Promise<Page> {
  const browser = await launch();
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  // 截圖只是紀錄：軟體算繪偶爾卡住時跳過，不讓整個測試失敗
  const rawShot = page.screenshot.bind(page);
  page.screenshot = (async (o?: Parameters<Page['screenshot']>[0]) => {
    try {
      return await rawShot({ timeout: 20000, ...o });
    } catch (e) {
      console.log(`    （截圖略過：${(e as Error).message.split('\n')[0]}）`);
      return Buffer.alloc(0);
    }
  }) as Page['screenshot'];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${role}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${role}] pageerror: ${e.message}`));
  await page.addInitScript('window.__name = (f) => f;');
  await page.goto(`${BASE}/?debug`);
  return page;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = { __NP__: { useStore: { getState(): any }; pose: { x: number; z: number; yaw: number; pitch: number } } };
const st = <T>(p: Page, fn: string): Promise<T> => p.evaluate(`(() => { const s = window.__NP__.useStore.getState(); return ${fn}; })()`) as Promise<T>;

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`檢查失敗：${msg}`);
  console.log(`  ✓ ${msg}`);
}

/* ------------------------------ 走路 ------------------------------ */

type Pt = [number, number];
const poseOf = (p: Page) => p.evaluate(() => ({ ...(window as unknown as Win).__NP__.pose }));

/** 直線走到 (x,z)：以 3.4 m/s 更新控制器位置；軟體算繪很慢，每一幀最多走 1.5 m（伺服器的防瞬移額度是 2.5 m） */
async function stepTo(p: Page, x: number, z: number): Promise<void> {
  await p.evaluate(
    ([tx, tz]) =>
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
        const t = setInterval(() => {
          if (moved >= 1.5) return;
          if (Math.hypot(pose.x - lx, pose.z - lz) > 0.5) {
            // 伺服器校正或傳送了位置（被抓走、被擋住）：停下來
            clearInterval(t);
            cancelAnimationFrame(raf);
            resolve();
            return;
          }
          const dx = tx - pose.x;
          const dz = tz - pose.z;
          const d = Math.hypot(dx, dz);
          const s = 3.4 * 0.033;
          if (d <= s) {
            pose.x = tx;
            pose.z = tz;
            clearInterval(t);
            cancelAnimationFrame(raf);
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 90)));
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
    [x, z],
  );
}

/** 沿著路網走到某個點（繞過家具；每一步都由伺服器驗證） */
async function walkToPoint(role: Seat, target: Pt): Promise<void> {
  const p = pages[role];
  const doors = await st<DoorState>(p, 's.kitchen.doors');
  const boxes = buildColliders(doors);
  const clear = (a: Pt, b: Pt) => {
    const r = moveWithCollision(a[0], a[1], b[0], b[1], boxes);
    return !r.blocked && Math.hypot(r.x - b[0], r.z - b[1]) < 0.02;
  };
  const here = await poseOf(p);
  const pts: Pt[] = [];
  if (!clear([here.x, here.z], target)) {
    const from = nearestNode(here.x, here.z, boxes);
    const to = nearestNode(target[0], target[1], boxes);
    const ids = findPath(from.id, to.id, doors.fire);
    if (!ids) throw new Error(`[${role}] 找不到路到 ${target.join(',')}`);
    for (const id of ids) pts.push([NAV_BY_ID[id].x, NAV_BY_ID[id].z]);
  }
  pts.push(target);
  for (const pt of pts) {
    await stepTo(p, pt[0], pt[1]);
    if (process.env.E2E_TRACE) console.log(`    trace [${role}] → ${pt.join(',')} at ${JSON.stringify(await poseOf(p))}`);
  }
}

async function walkToStation(role: Seat, stationId: string): Promise<void> {
  const p = pages[role];
  if (process.env.E2E_TRACE) console.log(`    trace [${role}] walk ${stationId} from ${JSON.stringify(await poseOf(p))}`);
  const s = STATION_BY_ID[stationId];
  await walkToPoint(role, stationFront(s, 0.75));
  await p.evaluate((f) => {
    const pose = (window as unknown as Win).__NP__.pose;
    pose.yaw = f;
    pose.pitch = -0.25;
  }, s.facing);
  await p.waitForTimeout(200);
}

/** 走到某位隊友旁邊（他的工作站前方再往旁邊一點），然後面向他 */
async function walkToMate(role: Seat, other: Seat): Promise<void> {
  const o = await poseOf(pages[other]);
  const doors = await st<DoorState>(pages[role], 's.kitchen.doors');
  const boxes = buildColliders(doors);
  // 在隊友周圍找一個沒有家具的點
  for (const [dx, dz] of [[1.1, 0], [-1.1, 0], [0, 1.1], [0, -1.1], [0.8, 0.8], [-0.8, 0.8]]) {
    const t: Pt = [o.x + dx, o.z + dz];
    const r = moveWithCollision(o.x, o.z, t[0], t[1], boxes);
    if (!r.blocked) {
      await walkToPoint(role, t);
      return;
    }
  }
  throw new Error(`[${role}] 找不到隊友旁邊的空位`);
}

/* ------------------------------ 工作站 ------------------------------ */

async function closeStation(p: Page): Promise<void> {
  if (await st<boolean>(p, '!!s.station')) {
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !(window as unknown as Win).__NP__.useStore.getState().station);
  }
}

/** 面對隊友按 E 打開隊友面板（按鍵偶爾會掉：最多按三次） */
async function openMateFacing(p: Page, mate: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await face(p, mate);
    await p.keyboard.press('KeyE');
    if (await p.waitForSelector('.mate-panel', { timeout: 8000 }).then(() => true).catch(() => false)) return;
  }
  await p.waitForSelector('.mate-panel', { timeout: 2000 });
}

async function open(role: Seat, stationId: string): Promise<void> {
  const p = pages[role];
  await closeStation(p);
  await walkToStation(role, stationId);
  await p.keyboard.press('KeyE');
  // 按鍵偶爾會掉：沒打開就再按一次
  const opened = await p.waitForFunction((id) => (window as unknown as Win).__NP__.useStore.getState().station?.id === id, stationId, { polling: 200, timeout: 7000 }).then(() => true).catch(() => false);
  if (!opened) await p.keyboard.press('KeyE');
  try {
    await p.waitForFunction((id) => (window as unknown as Win).__NP__.useStore.getState().station?.id === id, stationId, { polling: 200, timeout: 15000 });
  } catch (e) {
    const info = await p.evaluate(() => {
      const w = window as unknown as Win;
      const s = w.__NP__.useStore.getState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev = ((w.__NP__ as any).events as Array<[number, string]>).filter((e) => e[1] !== 'kitchen:state').slice(-8).map((e) => e[1]);
      return { pose: { ...w.__NP__.pose }, station: s.station?.id ?? null, overlay: s.overlay, locked: s.locked, notices: s.notices.map((n: { text: string }) => n.text), ev };
    });
    console.log(`    [${role}] 開不了 ${stationId}：${JSON.stringify(info)}`);
    throw e;
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

/** 點面板上的按鈕（以按鈕的無障礙名稱找），等伺服器回覆 */
async function click(role: Seat, label: string, expectOk = true, contains?: string): Promise<string> {
  const p = pages[role];
  const before = await st<number>(p, 's.station?.result?.id ?? 0');
  await showInStorageTab(p, `.modal.station button[aria-label^="${label}"]`);
  const btn = p.locator(`.modal.station button[aria-label^="${label}"]${contains ? `[aria-label*="${contains}"]` : ''}`).first();
  await btn.waitFor({ state: 'visible', timeout: 20000 });
  // 按鈕依伺服器的快照啟用（例如削完皮才能切）：等它可以按
  await p.waitForFunction((el) => !(el as HTMLButtonElement).disabled, await btn.elementHandle(), { polling: 200, timeout: 10000 });
  // 軟體算繪很慢：直接在頁面裡點，不等 Playwright 的「位置穩定」
  await btn.evaluate((el) => (el as HTMLButtonElement).click());
  try {
    await p.waitForFunction((b) => {
      const r = (window as unknown as Win).__NP__.useStore.getState().station?.result;
      return r && r.id !== b;
    }, before, { polling: 200, timeout: 15000 });
  } catch (e) {
    console.log(`    [${role}] ${label} 沒有回覆：${JSON.stringify(await st(p, '({ station: s.station, task: s.kitchen.players[s.me.role].task, held: s.kitchen.players[s.me.role].held, notices: s.notices.map((n) => n.text) })'))}`);
    throw e;
  }
  const r = await st<{ ok: boolean; message: string; tone: string }>(p, 's.station.result');
  if (expectOk && r.tone === 'error') throw new Error(`[${role}] ${label}：${r.message}`);
  if (expectOk && !r.ok && r.tone === 'warn') throw new Error(`[${role}] ${label}：${r.message}`);
  console.log(`    [${role}] ${label} → ${r.message}`);
  return r.message;
}

async function waitTask(p: Page): Promise<void> {
  console.log('    （等待動作完成）');
  await p.waitForFunction(() => {
    const s = (window as unknown as Win).__NP__.useStore.getState();
    return !s.kitchen.players[s.me.role].task;
  }, undefined, { polling: 200, timeout: 15000 });
}

const held = (p: Page) => st<{ kind: string } | null>(p, 's.kitchen.players[s.me.role].held');

async function debug(p: Page, cmd: string): Promise<void> {
  const err = await p.evaluate(
    (c) =>
      new Promise<string | null>((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sock = (window as any).__NP__.socket;
        sock.emit('debug:command', { cmd: c }, (r: { ok: boolean; error?: string }) => resolve(r.ok ? null : r.error ?? 'error'));
      }),
    cmd,
  );
  if (err) throw new Error(`開發者指令 ${cmd}：${err}`);
}

/* ------------------------------ 流程 ------------------------------ */

const FLAWS: Array<[Seat, string, string]> = [
  ['P1', 'Aki', '耳背砧板'],
  ['P2', 'Bao', '味覺失調者'],
  ['P3', 'Cleo', '幻聽外場'],
  ['P4', 'Dan', '健忘助手'],
  ['P5', 'Eve', '沉默侍者'],
];
const SEATS5: Seat[] = FLAWS.map(([s]) => s);

/** 面向某位隊友（用來打開隊友面板） */
async function face(p: Page, other: Page): Promise<void> {
  const o = await poseOf(other);
  await p.evaluate(([x, z]) => {
    const pose = (window as unknown as Win).__NP__.pose;
    pose.yaw = Math.atan2(-(x - pose.x), -(z - pose.z));
    pose.pitch = -0.1;
  }, [o.x, o.z]);
  await p.waitForTimeout(300);
}

/** 點一般介面（非工作站面板）上的按鈕，直接在頁面裡點 */
async function press(p: Page, selector: string): Promise<void> {
  const el = p.locator(selector).first();
  try {
    await el.waitFor({ state: 'visible', timeout: 10000 });
  } catch (e) {
    const all = p.locator(selector);
    const n = await all.count();
    const boxes = [];
    for (let i = 0; i < n; i++) boxes.push(await all.nth(i).boundingBox());
    console.log('    press 失敗：', selector, n, JSON.stringify(boxes), await p.locator('.log-entry').count());
    throw e;
  }
  await p.waitForFunction((e) => !(e as HTMLButtonElement).disabled, await el.elementHandle(), { polling: 200, timeout: 10000 });
  await el.evaluate((e) => (e as HTMLButtonElement).click());
}

try {
  console.log('▶ 建立房間、加入、選缺陷卡（1–8 人；這裡 5 人）');
  for (const [r] of FLAWS) pages[r] = await newPlayer(r, 600, 380);
  const [A, B, C, D, E] = SEATS5.map((s) => pages[s]);
  await A.click('text=開始遊戲'); // 起始頁面
  await A.fill('#name', 'Aki');
  await A.click('text=建立房間');
  await A.waitForSelector('.code-box');
  const code = (await A.textContent('.code-box'))!.trim();
  for (const [seat, n] of FLAWS.slice(1)) {
    const p = pages[seat];
    await p.click('text=開始遊戲'); // 起始頁面
    await p.fill('#name', n);
    await p.fill('input.code', code);
    await p.click('button:text-is("加入")');
    await p.waitForSelector('.code-box');
  }
  check((await A.locator('.flaw-card').count()) >= 16 && (await A.locator('.flaw-card.locked').count()) === 0, '大廳列出 16 張卡，全部可選（Phase A–D）');
  for (const [seat, , name] of FLAWS) await press(pages[seat], `.flaw-card:has-text("${name}")`);
  await A.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().room?.canStart === true, undefined, { polling: 200, timeout: 10000 });
  check(true, '每個人都選好卡，可以開始');
  await A.screenshot({ path: `${OUT}/01-lobby.png`, fullPage: true });
  check((await E.locator('text=沉默侍者不使用遊戲內語音').count()) > 0, '沉默侍者沒有麥克風選項');
  await A.click('text=啟用麥克風');
  await A.waitForSelector('text=麥克風已啟用');
  await A.click('text=開始營業');
  for (const p of [A, B, C, D, E]) {
    await p.waitForSelector('text=我看懂了，準備好');
    if (p === A) await A.screenshot({ path: `${OUT}/02-briefing.png` });
    await p.click('text=我看懂了，準備好');
  }
  await B.waitForFunction(() => !!(window as unknown as Win).__NP__.useStore.getState().kitchen?.self);
  for (const p of [A, B, C, D, E]) check((await p.locator('canvas').count()) === 1, `${await st<string>(p, 's.kitchen.self.flaw')}：有 3D 場景與自己的缺陷狀態`);

  await A.waitForTimeout(3500);
  const linksOf = (p: Page) => p.evaluate(() => Object.entries((window as unknown as Win).__NP__.useStore.getState().voiceLinks as Record<string, string>).filter(([, s]) => s === 'connected').map(([k]) => k).sort());
  const la = await linksOf(A);
  const le = await linksOf(E);
  console.log('    語音連線', { P1: la, P5: le });
  check(la.some((k) => k.startsWith('P1>')), '耳背砧板開了麥克風：建立發話連線');
  check(!le.some((k) => k.startsWith('P5>')), '沉默侍者沒有任何發話連線');

  console.log('▶ 備料（開店前）');
  // P1 耳背砧板：削皮 → 切片，刀數因為「連續備料」少一刀
  const prep = (async () => {
    await open('P1', 'pantry');
    await click('P1', '拿洋蔥');
    await open('P1', 'prep_b');
    await click('P1', '把手上的食材放到砧板');
    await click('P1', '削皮');
    await waitTask(A);
    await click('P1', '切片');
    await A.waitForSelector('.chop');
    const need = Number(/／(\d+)/.exec((await A.locator('.chop-head .code').textContent()) ?? '')?.[1]);
    check(need === 4, `耳背砧板削完皮接著切片：只要下 ${need} 刀（一般 5 刀）`);
    for (let i = 0; i < need; i++) {
      await A.keyboard.press('Space');
      await A.waitForTimeout(380);
    }
    await A.waitForFunction(() => /一致性/.test((window as unknown as Win).__NP__.useStore.getState().station?.result?.message ?? ''), undefined, { polling: 200, timeout: 10000 });
    const streak = await A.waitForFunction(() => /連續備料 ×2/.test(document.querySelector('.flaw-status')?.textContent ?? ''), undefined, { polling: 200, timeout: 8000 }).then(() => true).catch(() => false);
    check(streak, `畫面上看得到自己的連續備料狀態（${(await A.locator('.flaw-status').textContent())?.slice(0, 60)}）`);
    await A.screenshot({ path: `${OUT}/03-P1-streak.png` });
  })();
  // P5 沉默侍者：吐司進烤麵包機
  const toast = (async () => {
    await open('P5', 'pantry');
    await click('P5', '拿吐司');
    await open('P5', 'toaster');
    await click('P5', '把吐司放進去');
    await click('P5', '按下，3 段');
  })();
  // P2 味覺失調者：平底鍋 A 中火煎蛋（煎蛋吐司），平底鍋 B 大火再放一顆（等一下測預警）
  const pan = (async () => {
    await open('P2', 'pan_a');
    await click('P2', '中火');
    await open('P2', 'fridge');
    await click('P2', '拿雞蛋');
    await open('P2', 'pan_a');
    await click('P2', '把手上的東西放進平底鍋');
    // 蛋白凝固就關火（伺服器時鐘是真的時間；軟體算繪很慢，後面的流程要好幾分鐘，不關火蛋會燒焦）
    await B.waitForFunction(() => {
      const k = (window as unknown as Win).__NP__.useStore.getState().kitchen;
      const it = k.items[k.stations.pan_a.items[0]];
      return it && it.doneness >= 1.15;
    }, undefined, { polling: 100, timeout: 60000 });
    await click('P2', '關火');
  })();
  await Promise.all([prep, toast, pan]);

  console.log('▶ 開店：幻聽外場的傳聞與核對');
  await debug(B, 'skip_prep');
  await debug(B, 'monster_off'); // 這個測試專注在缺陷卡；威脅系統另有測試
  await C.waitForFunction(() => ((window as unknown as Win).__NP__.useStore.getState().kitchen.self?.rumors ?? []).some((r: { pitch: number }) => r.pitch < 1.03), undefined, { polling: 200, timeout: 15000 });
  const rumor = await st<{ id: string; text: string }>(C, 's.kitchen.self.rumors.filter((r) => r.pitch < 1.03).at(-1)');
  check(!!rumor, `幻聽外場聽到傳聞：「${rumor.text}」（其他人收不到）`);
  for (const p of [A, B, D, E]) check(!(await p.evaluate((t) => JSON.stringify((window as unknown as Win).__NP__.useStore.getState().kitchen).includes(t), rumor.text)), `${await st<string>(p, 's.kitchen.self.flaw')} 的快照裡沒有這則私人傳聞`);
  await C.keyboard.press('Tab');
  await C.waitForSelector('.modal >> text=只有你聽到的傳聞');
  await C.screenshot({ path: `${OUT}/04-P3-rumors.png` });
  await press(C, `.log-entry:has-text("${rumor.text}") button:has-text("貼上訂單板")`);
  await A.waitForFunction((id) => (window as unknown as Win).__NP__.useStore.getState().kitchen.coop.rumors.some((r: { id: string }) => r.id === id), rumor.id, { polling: 200, timeout: 10000 });
  check(true, '貼上訂單板：全隊都看得到這則待核對的傳聞');
  await C.keyboard.press('Escape');
  // 耳背砧板走到出餐口核對（隊友 2 秒）
  await open('P1', 'pass');
  await click('P1', `核對：${rumor.text}`);
  await waitTask(A);
  await D.waitForFunction((id) => (window as unknown as Win).__NP__.useStore.getState().kitchen.coop.rumors.find((r: { id: string }) => r.id === id)?.status === 'confirmed', rumor.id, { polling: 200, timeout: 10000 });
  check(true, '隊友在出餐口核對 2 秒：傳聞是真的');
  await D.waitForSelector('.rail .prep-hint');
  check(true, '全隊的出單軌出現「準備提示」，可以提早備料');
  await D.screenshot({ path: `${OUT}/05-P4-prephint.png` });

  console.log('▶ 味覺失調者：預警、及時關火');
  await open('P2', 'fridge');
  await click('P2', '拿雞蛋');
  await open('P2', 'pan_b');
  await click('P2', '大火');
  await click('P2', '把手上的東西放進平底鍋');
  await B.waitForFunction(() => ((window as unknown as Win).__NP__.useStore.getState().kitchen.self?.thermal ?? []).some((w: { stationId: string }) => w.stationId === 'pan_b'), undefined, { timeout: 40000, polling: 50 });
  // 收到預警就關火（面板本來就開著）；預警文字先從狀態記下（軟體算繪很慢，畫面上的預警只留 9 秒）
  const warnText = await st<string>(B, "s.kitchen.self.thermal.find((w) => w.stationId === 'pan_b').text");
  await click('P2', '關火');
  await B.screenshot({ path: `${OUT}/06-P2-thermal.png` });
  check(/燒焦/.test(warnText), `燒焦之前收到預警：${warnText.trim()}`);
  await B.waitForTimeout(6000);
  const eggState = await B.evaluate(() => {
    const k = (window as unknown as Win).__NP__.useStore.getState().kitchen;
    const id = k.stations.pan_b.items[0];
    const it = k.items[id];
    return Math.max(it.brownA, it.brownB);
  });
  check(eggState < 2.0, `收到預警後關火：蛋沒有燒焦（上色 ${eggState.toFixed(2)}）`);

  console.log('▶ 煎蛋吐司：沉默侍者裝盤、試吃回報給味覺失調者');
  await open('P2', 'pan_a');
  await click('P2', '關火');
  await open('P5', 'plating');
  await click('P5', '拿一個新盤子');
  await open('P2', 'pan_a');
  await click('P2', '拿起：雞蛋');
  await open('P2', 'plating');
  await click('P2', '把手上的食材裝到選中的盤子');
  await E.waitForFunction(() => !(window as unknown as Win).__NP__.useStore.getState().kitchen.stations.toaster.toast, undefined, { polling: 200, timeout: 20000 });
  await open('P5', 'toaster');
  await click('P5', '拿出來');
  await open('P5', 'plating');
  await click('P5', '把手上的食材裝到選中的盤子');
  await open('P5', 'fridge');
  await click('P5', '拿奶油');
  await open('P5', 'plating');
  await click('P5', '把手上的食材裝到選中的盤子');
  for (const sz of ['鹽', '黑胡椒']) {
    await open('P5', 'spice');
    await click('P5', `${sz} 0.5 匙`);
    await open('P5', 'plating');
    await click('P5', '把量好的調味料加到盤子上');
  }
  const mine = await click('P2', '試吃', false);
  check(/嚐不出/.test(mine), `味覺失調者自己試吃：${mine}`);
  const theirs = await click('P5', '試吃', false);
  check(/鹹|胡椒|辣|淡淡/.test(theirs), `沉默侍者試吃：${theirs}`);
  // 沉默侍者面向味覺失調者 → 隊友面板 → 回報試吃
  await closeStation(E);
  await closeStation(B);
  await walkToMate('P5', 'P2');
  await openMateFacing(E, B);
  await press(E, '.mate-panel button:has-text("回報我剛剛試吃的味道")');
  await B.waitForFunction(() => ((window as unknown as Win).__NP__.useStore.getState().kitchen.self?.reports ?? []).length > 0, undefined, { polling: 200, timeout: 10000 });
  check(true, '味覺失調者收到隊友的試吃回報（內容就是隊友實際嚐到的）');
  await E.keyboard.press('Escape');
  await open('P5', 'plating');
  await click('P5', '端起選中的盤子');
  await open('P5', 'pass');
  // 測試跑得慢時，單會多開幾張：出給「煎蛋吐司」那張
  const eggOrder = await E.locator('.modal.station button[aria-label^="出給"][aria-label*="煎蛋吐司"]').count();
  await click('P5', eggOrder ? '出給' : '出給', true, eggOrder ? '煎蛋吐司' : undefined);
  const result = await st<{ total: number; reasons: unknown[] }>(E, 's.lastResult');
  check(result && result.total > 50, `沉默侍者出餐：煎蛋吐司 ${result.total} 分（缺陷卡沒有改變任何料理判定）`);
  await E.screenshot({ path: `${OUT}/07-P5-receipt.png` });
  // 自由料理的判定：出餐結果附上這道菜實際是什麼；第一次做出來的菜記進每個人自己的料理圖鑑（本機）
  const dish = await st<{ name: string; kind: string; quality: { total: number } }>(E, 's.lastResult.analysis');
  check(dish && dish.name.includes('煎蛋吐司') && (await E.locator('.modal.station .dish-card').count()) > 0, `出餐結果附上料理判定：${dish?.name}（${dish?.kind}，品質 ${dish?.quality.total}）`);
  // 軟體算繪很慢，蛋常常在鍋裡放太久而燒焦：失敗料理不進圖鑑，成功的才會記下來
  for (const [role, p] of [['P5', E], ['P1', A]] as const) {
    if (dish.kind === 'failed') {
      await p.waitForTimeout(1000);
      const n = await p.evaluate(() => Object.keys((window as unknown as { __NP__: { records: () => { discoveries: object } } }).__NP__.records().discoveries).length);
      check(n === 0, `${role}：失敗料理（${dish.name}）不記進料理圖鑑`);
    } else {
      await p.waitForFunction(() => Object.keys((window as unknown as { __NP__: { records: () => { discoveries: object } } }).__NP__.records().discoveries).length > 0, undefined, { polling: 200, timeout: 8000 });
      check(true, `${role} 的料理圖鑑記下了這道菜`);
    }
  }

  console.log('▶ 健忘助手：想不起來的單、看單、接住交接、便條');
  await D.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().kitchen.orders.some((o: { status: string; forgotten?: boolean }) => o.status === 'open' && o.forgotten), undefined, { polling: 200, timeout: 60000 });
  check((await D.locator('.rail .ticket.forgotten').count()) > 0, '健忘助手的出單軌：想不起來的單只剩桌號與時間');
  check((await A.locator('.rail .ticket.forgotten').count()) === 0, '其他人看到的是完整的單');
  await D.screenshot({ path: `${OUT}/08-P4-forgot.png` });
  await open('P4', 'pass');
  await click('P4', '看單');
  await D.waitForFunction(() => !(window as unknown as Win).__NP__.useStore.getState().kitchen.orders.some((o: { status: string; forgotten?: boolean }) => o.status === 'open' && o.forgotten), undefined, { polling: 200, timeout: 5000 }).catch(() => undefined);
  check(/想起來了|再看一次/.test(await st<string>(D, 's.station.result.message')), '到出餐口看單就想起來');
  // 便條：貼在出餐口
  await press(D, '.modal.station .notes button[aria-label="貼便條：等待烹飪"]');
  await A.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().kitchen.coop.notes.length > 0, undefined, { polling: 200, timeout: 5000 });
  check(true, '便條貼上了，全隊看得到');
  // 交接：沉默侍者拿麵包走到健忘助手旁邊遞給他（先請耳背砧板離開出餐口，免得面前有兩個隊友）
  await closeStation(A);
  await walkToStation('P1', 'sink');
  await closeStation(D);
  await open('P5', 'pantry');
  await click('P5', '拿吐司');
  await closeStation(E);
  await walkToMate('P5', 'P4');
  await openMateFacing(E, D);
  check((await E.locator('.mate-panel header b').textContent()) === 'Dan', '隊友面板打開的是正對著的隊友（健忘助手）');
  await E.screenshot({ path: `${OUT}/09-P5-matepanel.png` });
  await press(E, '.mate-panel button:has-text("把手上的東西遞給他")');
  await D.waitForSelector('.handoff-prompt', { timeout: 10000 });
  // 接住的時間窗只有 4 秒：先接，再截圖（軟體算繪的截圖很慢）
  await D.keyboard.press('KeyF');
  await D.waitForFunction(() => {
    const s = (window as unknown as Win).__NP__.useStore.getState();
    return s.kitchen.players[s.me.role].held?.kind === 'item';
  }, undefined, { polling: 200, timeout: 10000 });
  check((await held(E)) === null, '交接成功：東西真的從沉默侍者手上到了健忘助手手上');
  await D.screenshot({ path: `${OUT}/10-P4-handoff-done.png` });
  await E.keyboard.press('Escape');

  console.log('▶ 拍肩：耳背砧板聽不到呼叫，但看得到');
  await closeStation(A);
  await walkToMate('P3', 'P1');
  await openMateFacing(C, A);
  await press(C, '.mate-panel button:has-text("危險")');
  await A.waitForSelector('.tap-cue', { timeout: 5000 });
  check(/拍了你的肩膀：危險/.test((await A.locator('.tap-cue').textContent()) ?? ''), '耳背砧板畫面出現拍肩提示與方向');
  await A.screenshot({ path: `${OUT}/11-P1-tap.png` });
  await C.keyboard.press('Escape');

  console.log('▶ 重新連線：健忘助手的記憶、手上的東西都還在');
  const memBefore = await st<Record<string, number>>(D, 's.kitchen.self.memory');
  await D.reload();
  await D.waitForFunction(() => !!(window as unknown as Win).__NP__?.useStore.getState().kitchen?.self, undefined, { polling: 200, timeout: 20000 });
  const after = await st<{ mem: Record<string, number>; held: { kind: string } | null }>(D, '({ mem: s.kitchen.self.memory, held: s.kitchen.players[s.me.role].held })');
  check(JSON.stringify(Object.keys(after.mem).sort()) === JSON.stringify(Object.keys(memBefore).sort()), '重新整理頁面後：記憶的單與到期時間由伺服器恢復');
  check(after.held?.kind === 'item', '重新整理頁面後：手上的東西還在');

  console.log('▶ 打烊結算');
  await debug(B, 'end_shift');
  for (const p of [A, B, C, E]) await p.waitForSelector('.results .slip', { timeout: 15000 });
  check((await B.locator('.results .crew-flaws .chip').count()) === 5, '結算列出每個人的缺陷卡');
  await B.waitForTimeout(1200);
  await B.screenshot({ path: `${OUT}/12-results.png`, fullPage: true });
  await A.click('.results >> text=再開一班');
  for (const p of [A, B, C, E]) await p.waitForSelector('.code-box', { timeout: 15000 });
  check(true, '房主可以帶全隊回到大廳');
  check(errors.length === 0, `瀏覽器主控台沒有錯誤${errors.length ? '：\n' + errors.join('\n') : ''}`);
  console.log('\n全部通過 ✔');
} catch (e) {
  console.error('\n✘', (e as Error).message);
  for (const r of SEATS5) await pages[r]?.screenshot({ path: `${OUT}/error-${r}.png` }).catch(() => undefined);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  for (const b of browsers) await b.close();
}
