/** 在瀏覽器裡「走」到某個點（沿著導航點，避開家具；與 browser-shift.ts 的做法相同） */
import type { Page } from 'playwright';
import { buildColliders, moveWithCollision, type DoorState } from '@last-table/shared';
import { NAV_BY_ID, findPath, nearestNode } from '../server/src/kitchen/threats/nav';

type Pt = [number, number];
type Win = { __NP__: { useStore: { getState(): { kitchen: { doors: DoorState } } }; pose: { x: number; z: number; yaw: number; pitch: number } } };

export const poseOf = (p: Page) => p.evaluate(() => ({ ...(window as unknown as Win).__NP__.pose }));

export async function stepTo(p: Page, x: number, z: number): Promise<void> {
  await p.evaluate(
    ([tx, tz]) =>
      new Promise<void>((resolve) => {
        const pose = (window as unknown as Win).__NP__.pose;
        let lx = pose.x;
        let lz = pose.z;
        // 畫面更新很慢時（軟體繪圖），每一格最多走 0.6 m，免得伺服器認為移動太快而把人拉回去
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
          if (moved >= 0.6) return;
          if (Math.hypot(pose.x - lx, pose.z - lz) > 0.5) {
            done();
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
            done();
            setTimeout(resolve, 250);
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

export async function walkToPoint(p: Page, target: Pt): Promise<void> {
  const doors = (await p.evaluate(() => (window as unknown as Win).__NP__.useStore.getState().kitchen.doors)) as DoorState;
  const boxes = buildColliders(doors);
  const here = await poseOf(p);
  const r = moveWithCollision(here.x, here.z, target[0], target[1], boxes);
  const pts: Pt[] = [];
  if (r.blocked || Math.hypot(r.x - target[0], r.z - target[1]) > 0.02) {
    const ids = findPath(nearestNode(here.x, here.z, boxes).id, nearestNode(target[0], target[1], boxes).id, doors.fire);
    if (!ids) throw new Error(`找不到路到 ${target.join(',')}`);
    for (const id of ids) pts.push([NAV_BY_ID[id].x, NAV_BY_ID[id].z]);
  }
  pts.push(target);
  for (const pt of pts) await stepTo(p, pt[0], pt[1]);
}
