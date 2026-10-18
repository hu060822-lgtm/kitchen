import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { STATION_BY_ID, buildColliders, moveWithCollision, stationFront, type DoorState } from '@last-table/shared';
import { gridPath } from '../server/src/kitchen/threats/nav';

const BASE = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '');
const OUT = process.argv[3] ?? 'look-shots';
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


async function main(): Promise<void> {
  const browser = (ref.browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  }));
  const P = await (await browser.newContext({ viewport: SMALL })).newPage();
  await P.addInitScript('window.__name = (f) => f;');
  await P.goto(`${BASE}/?debug`);
  await P.click('text=開始遊戲'); // 起始頁面
  await P.fill('#name', 'Luz');
  await P.click('text=建立房間');
  await P.waitForSelector('.code-box');
  await P.click('.flaw-card:has(.code:text-is("D03"))');
  await P.waitForFunction(() => (window as unknown as Win).__NP__.useStore.getState().room?.canStart, undefined, { polling: 200, timeout: 15000 });
  await P.click('text=開始營業');
  await P.click('text=我看懂了，準備好');
  await debug(P, 'skip_prep');
  await debug(P, 'monster_off');
  await debug(P, 'guest_off');
  for (const [id, d, pitch] of [['oven', 2.0, -0.35], ['mixer', 1.6, -0.5], ['fridge', 2.4, -0.1], ['pantry', 2.4, -0.1]] as Array<[string, number, number]>) {
    const s = STATION_BY_ID[id];
    await walkTo(P, stationFront(s, d));
    await face(P, s.facing, pitch);
    await shot(P, `look-${id}`);
  }
  await browser.close();
}
main().catch(async (e) => {
  console.error(e);
  await ref.browser?.close();
  process.exit(1);
});
