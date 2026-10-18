import { describe, expect, it } from 'vitest';
import {
  BLIND_LAB,
  RESTAURANT_ACOUSTICS,
  OPENINGS,
  ZONES,
  ECHO_CONFIG,
  LAB_SPAWN,
  STATIONS,
  audibility,
  buildColliders,
  castEcho,
  openDoors,
  forwardOf,
  headingOf,
  labColliders,
  planEcho,
  rayBox,
  relativeAzimuth,
  riskPhase,
  summarizeEcho,
  zoneOfPoint,
  type Box,
  DOOR_HEIGHT,
  visionDurationMs,
  visionSolids,
} from '@last-table/shared';

const deg = (r: number) => (r * 180) / Math.PI;
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

/**
 * Web Audio 規格中 PannerNode 的方位角計算（"Azimuth and Elevation"），照規格逐步實作，
 * 用來確認我們設定聽者的方式（forward＝forwardOf(yaw)、up＝+y）與移動／鏡頭的座標一致。
 */
function webAudioAzimuth(listener: [number, number, number], forward: [number, number, number], source: [number, number, number]): number {
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  const norm = (a: number[]) => {
    const l = Math.hypot(...a) || 1;
    return a.map((v) => v / l);
  };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const up = [0, 1, 0];
  const right = norm(cross(forward, up));
  const sl = norm(sub(source, listener));
  const proj = norm(sub(sl, up.map((u) => u * dot(sl, up))));
  let az = deg(Math.acos(Math.max(-1, Math.min(1, dot(proj, right)))));
  if (dot(proj, forward) < 0) az = 360 - az;
  az = az >= 0 && az <= 270 ? 90 - az : 450 - az;
  return az;
}

describe('A. 方向基準：座標一致', () => {
  it('四個基本朝向的名稱：yaw=π 面向後場（+z）、往右轉 90° 面向右側牆（-x）', () => {
    expect(headingOf(Math.PI).label).toBe('後場');
    expect(headingOf(Math.PI / 2).label).toBe('右側牆');
    expect(headingOf(0).label).toBe('前場');
    expect(headingOf(-Math.PI / 2).label).toBe('左側牆');
    expect(headingOf(Math.PI - Math.PI / 4).label).toBe('後場偏右側');
    // 往右轉＝滑鼠往右＝yaw 減少；右翼就是面向深處時的右手邊
    const [fx, fz] = forwardOf(Math.PI / 2);
    expect(fx).toBeCloseTo(-1);
    expect(fz).toBeCloseTo(0);
  });

  it('玩家面對四個基本方向時，固定聲源的方位與 Web Audio 的計算一致', () => {
    const src: [number, number] = [0, 5]; // 正「後場」5 m
    const expected: Record<string, number> = { 後場: 0, 右側牆: -90, 前場: 180, 左側牆: 90 };
    for (const yaw of [Math.PI, Math.PI / 2, 0, -Math.PI / 2]) {
      const label = headingOf(yaw).label;
      const ours = relativeAzimuth(0, 0, yaw, src[0], src[1]);
      const [fx, fz] = forwardOf(yaw);
      const wa = webAudioAzimuth([0, 1.6, 0], [fx, 0, fz], [src[0], 1.6, src[1]]);
      const want = expected[label];
      expect(near(Math.abs(ours), Math.abs(want), 1e-6) && (want === 180 || near(ours, want, 1e-6))).toBe(true);
      // Web Audio 的 ±180 等價
      expect(near(((wa - ours + 540) % 360) - 180, 0, 1e-6)).toBe(true);
    }
  });

  it('隨機位置與朝向：方位角與 Web Audio 一致（左右不會顛倒）', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 200; i++) {
      const lx = rnd() * 6;
      const lz = rnd() * 50;
      const yaw = rnd() * Math.PI * 3;
      const sx = rnd() * 6;
      const sz = lz + rnd() * 8;
      const [fx, fz] = forwardOf(yaw);
      const wa = webAudioAzimuth([lx, 1.6, lz], [fx, 0, fz], [sx, 1.6, sz]);
      const ours = relativeAzimuth(lx, lz, yaw, sx, sz);
      expect(Math.abs(((wa - ours + 540) % 360) - 180)).toBeLessThan(1e-6);
    }
  });

  it('旋轉鏡頭時，聲源方位跟著連續更新（往右轉，聲源往左移）', () => {
    let prev = relativeAzimuth(0, 0, Math.PI, 0, 5);
    for (let k = 1; k <= 12; k++) {
      const yaw = Math.PI - (k * Math.PI) / 18; // 每次往右轉 10°
      const az = relativeAzimuth(0, 0, yaw, 0, 5);
      expect(az).toBeCloseTo(prev - 10, 6);
      prev = az;
    }
  });
});

describe('A. 參考音（通風口）', () => {
  it('每個區域一個；位置在區域內；離任何門洞至少 2 m（不會變成找門的提示）', () => {
    const ref = RESTAURANT_ACOUSTICS.reference;
    expect(ref).toHaveLength(ZONES.length);
    expect(new Set(ref.map((r) => r.zone)).size).toBe(ZONES.length);
    for (const r of ref) {
      expect(zoneOfPoint(RESTAURANT_ACOUSTICS, r.pos[0], r.pos[1])).toBe(r.zone);
      for (const o of OPENINGS) expect(Math.hypot(r.pos[0] - o.at[0], r.pos[1] - o.at[1])).toBeGreaterThanOrEqual(2);
    }
  });

  it('遮蔽：只有同一個區域聽得到；門開著也不會傳到隔壁（不能隔牆追蹤）', () => {
    const vent = { ...RESTAURANT_ACOUSTICS.reference.find((r) => r.zone === 'KITCHEN')! };
    const open = () => true;
    expect(audibility(RESTAURANT_ACOUSTICS, vent, 'KITCHEN', open).mode).toBe('direct');
    expect(audibility(RESTAURANT_ACOUSTICS, vent, 'DINING', open).mode).toBe('none');
    expect(audibility(RESTAURANT_ACOUSTICS, vent, null, open).mode).toBe('none');
  });
});

describe('B. 主動回聲：反映實際幾何', () => {
  const lab = (open = false) => labColliders(open);

  it('slab 求交：正確的進入距離；平行或背向不相交', () => {
    const b = { minX: 2, maxX: 3, minZ: -1, maxZ: 1 };
    expect(rayBox(0, 0, 1, 0, b, 10)).toBeCloseTo(2);
    expect(rayBox(0, 0, -1, 0, b, 10)).toBeNull();
    expect(rayBox(0, 2, 1, 0, b, 10)).toBeNull();
    expect(rayBox(0, 0, 1, 0, b, 1.5)).toBeNull(); // 超過距離上限
  });

  it('射線數與距離上限來自設定；第 0 道朝正前方、往右遞增', () => {
    const hits = castEcho(LAB_SPAWN.x, LAB_SPAWN.z, LAB_SPAWN.yaw, lab(), BLIND_LAB.materialOf);
    expect(hits).toHaveLength(ECHO_CONFIG.rays);
    expect(hits[0].rel).toBe(0);
    expect(deg(hits[ECHO_CONFIG.rays / 4].rel)).toBeCloseTo(90);
    for (const h of hits) expect(h.dist).toBeLessThanOrEqual(ECHO_CONFIG.range);
  });

  it('起點：前方是走廊（8 m 內沒有反射）、背後 1.5 m、左右各 3 m 的混凝土牆', () => {
    const hits = castEcho(0, 1.5, Math.PI, lab(), BLIND_LAB.materialOf);
    const at = (d: number) => hits.find((h) => near(deg(h.rel), d, 1e-6))!;
    expect(at(0).hit).toBe(false);
    expect(at(0).dist).toBe(ECHO_CONFIG.range);
    expect(at(180).dist).toBeCloseTo(1.5);
    expect(at(90).dist).toBeCloseTo(3);
    expect(at(-90).dist).toBeCloseTo(3);
    for (const d of [90, -90, 180]) expect(at(d).material).toBe('concrete');
    // 扇區摘要（單聲道語音用）：每個 90° 扇區最近的反射
    expect(summarizeEcho(hits).back).toBeCloseTo(1.5);
  });

  it('同樣的位置與朝向永遠得到同樣的結果（不是隨機音效）', () => {
    const a = castEcho(0.3, 10, Math.PI - 0.4, lab(), BLIND_LAB.materialOf);
    const b = castEcho(0.3, 10, Math.PI - 0.4, lab(), BLIND_LAB.materialOf);
    expect(a).toEqual(b);
  });

  it('轉身後，同一面牆出現在另一側（相對方位跟著朝向改變）', () => {
    const facingDeep = summarizeEcho(castEcho(-2, 3, Math.PI, lab(), BLIND_LAB.materialOf));
    const facingRight = summarizeEcho(castEcho(-2, 3, Math.PI / 2, lab(), BLIND_LAB.materialOf));
    // -x 的牆距離 1 m：面向深處時在右邊，面向右翼時在前方
    expect(facingDeep.right).toBeCloseTo(1);
    expect(facingRight.front).toBeCloseTo(1);
  });

  it('走廊盡頭的岔路：斜前方的射線比兩側長（聽得出空間在那裡延伸）', () => {
    const hits = castEcho(0, 13.8, Math.PI, lab(), BLIND_LAB.materialOf);
    const at = (d: number) => hits.find((h) => near(deg(h.rel), d, 1e-6))!;
    expect(at(90).dist).toBeCloseTo(1);
    expect(at(-90).dist).toBeCloseTo(1);
    expect(at(45).dist).toBeGreaterThan(at(90).dist * 1.4);
    expect(at(-45).dist).toBeGreaterThan(at(-90).dist * 1.4);
  });

  it('門與材質：關著的門是金屬；開門後射線穿過門洞，打到後面的目標設備', () => {
    const facingDoor = -Math.PI / 2; // 面向左翼（+x）
    const closed = castEcho(5, 16.25, facingDoor, lab(false), BLIND_LAB.materialOf)[0];
    expect(closed.material).toBe('metal');
    expect(closed.dist).toBeCloseTo(2);
    const opened = castEcho(5, 16.25, facingDoor, lab(true), BLIND_LAB.materialOf)[0];
    expect(opened.dist).toBeGreaterThan(closed.dist + 4);
    expect(opened.material).toBe('machine');
    // 岔路另一頭的死巷是木櫃
    const dead = castEcho(-3, 16.25, Math.PI / 2, lab(), BLIND_LAB.materialOf)[0];
    expect(dead.material).toBe('wood');
  });

  it('不穿牆：每道射線只回報第一個反射，牆後的物體永遠不會出現', () => {
    // 餐廳：在正門前面向前場（-z），前牆擋住；面向後場時，餐廳與廚房之間的牆擋住後面的一切
    const cols = buildColliders({ fire: false });
    const hits = castEcho(-6, 7.5, Math.PI, cols, RESTAURANT_ACOUSTICS.materialOf, { rays: 64, range: 10 });
    for (const h of hits) if (h.hit) expect(h.z).toBeLessThanOrEqual(9 + 1e-6);
    // 防火門關著：正面是金屬門；開著：射線穿過門洞
    const shut = castEcho(7.95, 17, Math.PI, cols, RESTAURANT_ACOUSTICS.materialOf)[0];
    expect(shut.material).toBe('metal');
    const open = castEcho(7.95, 17, Math.PI, buildColliders(openDoors()), RESTAURANT_ACOUSTICS.materialOf)[0];
    expect(open.dist).toBeGreaterThan(shut.dist + 2);
  });

  it('播放規則：近的反射較早、較大聲、較亮；沒有反射的方向只有微弱的空氣聲', () => {
    const plan = planEcho(castEcho(0, 3, Math.PI, lab(), BLIND_LAB.materialOf));
    const returns = plan.voices.filter((v) => v.kind === 'return').sort((a, b) => a.dist - b.dist);
    for (let i = 1; i < returns.length; i++) {
      const [a, b] = [returns[i - 1], returns[i]];
      if (b.dist - a.dist < 0.05 || a.material !== b.material) continue;
      expect(a.at).toBeLessThan(b.at);
      expect(a.gain).toBeGreaterThan(b.gain);
      expect(a.cutoff).toBeGreaterThan(b.cutoff);
    }
    const open = plan.voices.filter((v) => v.kind === 'open');
    expect(open.length).toBeGreaterThan(0);
    for (const v of open) expect(v.gain).toBeLessThan(Math.min(...returns.map((r) => r.gain)));
  });

  it('開放空間的殘響較長：岔路 > 走廊中段', () => {
    const hall = planEcho(castEcho(0, 10, Math.PI, lab(), BLIND_LAB.materialOf));
    const fork = planEcho(castEcho(0, 16.25, Math.PI, lab(), BLIND_LAB.materialOf));
    expect(fork.tail).toBeGreaterThan(hall.tail);
  });

  it('效能：每次脈衝只測試附近的碰撞盒（正式關卡也一樣）', () => {
    const cols = buildColliders(openDoors());
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) castEcho(0, 11 + (i % 10), i, cols, RESTAURANT_ACOUSTICS.materialOf);
    expect((performance.now() - t0) / 200).toBeLessThan(2); // 每次遠低於一幀
  });
});

describe('B2. 回聲視野（按 F 後短暫看到的結構模型）', () => {
  const cols = buildColliders(openDoors(), [{ id: 'monster', x: 0, z: 16.6, r: 0.42 }]);
  const k = { x: 0, z: 12 };

  it('只有幾何：每個立體只有種類與六個邊界，沒有識別碼、工作站名稱或任何其他欄位', () => {
    const solids = visionSolids(cols, k.x, k.z, ECHO_CONFIG.range, RESTAURANT_ACOUSTICS, [[1, 12]]);
    expect(solids.length).toBeGreaterThan(5);
    for (const s of solids) expect(Object.keys(s).sort()).toEqual(['kind', 'maxX', 'maxY', 'maxZ', 'minX', 'minY', 'minZ']);
    expect(JSON.stringify(solids)).not.toMatch(/pan_|fridge|monster|label/);
    // 怪物與隊友都是「身體」，看不出是誰
    expect(solids.filter((s) => s.kind === 'body')).toHaveLength(2);
  });

  it('有距離上限：範圍外的牆、家具、隊友都不會出現（看不到完整地圖）', () => {
    const range = ECHO_CONFIG.range;
    const solids = visionSolids(cols, k.x, k.z, range, RESTAURANT_ACOUSTICS, [[0, 26]]);
    for (const s of solids) {
      const dx = Math.max(s.minX - k.x, 0, k.x - s.maxX);
      const dz = Math.max(s.minZ - k.z, 0, k.z - s.maxZ);
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(range + 0.5);
    }
    expect(solids.filter((s) => s.kind === 'body')).toHaveLength(1);
  });

  it('門洞上方有門楣；出餐窗口上方有牆（看得出那裡是開口）', () => {
    const solids = visionSolids(cols, k.x, k.z, ECHO_CONFIG.range, RESTAURANT_ACOUSTICS);
    expect(solids.some((s) => s.kind === 'wall' && s.minY === DOOR_HEIGHT && Math.abs((s.minX + s.maxX) / 2 - 4.25) < 0.01)).toBe(true);
    expect(solids.some((s) => s.kind === 'wall' && s.minY === 2.1 && s.minX === -3)).toBe(true);
    const props = solids.filter((s) => s.kind === 'prop');
    expect(new Set(props.map((p) => p.maxY)).size).toBeGreaterThan(1);
  });

  it('時間：視野顯示的時間短於冷卻時間（每次之間一定有一段全黑）', () => {
    expect(visionDurationMs()).toBeLessThan(ECHO_CONFIG.cooldownMs);
    expect(visionDurationMs()).toBeGreaterThan(2500);
  });
});

describe('C. 聲學地標', () => {
  it('每個地標都在自己的區域內、識別碼不重複', () => {
    const ids = new Set<string>();
    for (const l of RESTAURANT_ACOUSTICS.landmarks) {
      expect(zoneOfPoint(RESTAURANT_ACOUSTICS, l.pos[0], l.pos[1])).toBe(l.zone);
      expect(ids.has(l.id)).toBe(false);
      ids.add(l.id);
    }
    for (const l of BLIND_LAB.landmarks) expect(zoneOfPoint(BLIND_LAB, l.pos[0], l.pos[1])).toBe(l.zone);
  });

  it('遮蔽規則：冷藏室的壓縮機從門口傳到廚房（悶聲、方位在門口）；餐廳聽不到', () => {
    const comp = RESTAURANT_ACOUSTICS.landmarks.find((l) => l.id === 'compressor')!;
    const open = () => true;
    expect(audibility(RESTAURANT_ACOUSTICS, comp, 'COLD', open).mode).toBe('direct');
    const via = audibility(RESTAURANT_ACOUSTICS, comp, 'KITCHEN', open);
    expect(via.mode).toBe('muffled');
    if (via.mode === 'muffled') expect(via.pos).toEqual(OPENINGS.find((o) => o.id === 'cold_door')!.at);
    expect(audibility(RESTAURANT_ACOUSTICS, comp, 'DINING', open).mode).toBe('none');
  });

  it('開口資料與牆一致：每個開口兩側的區域都存在，工作站都在自己的區域內', () => {
    for (const o of RESTAURANT_ACOUSTICS.openings) {
      expect(ZONES.some((z) => z.id === o.a)).toBe(true);
      expect(ZONES.some((z) => z.id === o.b)).toBe(true);
    }
    for (const s of STATIONS) {
      const [fx, fz] = [s.pos[0] + Math.sin(s.facing) * 0.6, s.pos[1] + Math.cos(s.facing) * 0.6];
      expect(zoneOfPoint(RESTAURANT_ACOUSTICS, fx, fz), s.id).toBe(s.zone);
    }
  });
});

describe('D. 風險週期（通用規則，測試關卡使用）', () => {
  const def = BLIND_LAB.risks[0];
  it('休息 → 預警 → 警戒 → 休息', () => {
    expect(riskPhase(def, 0).state).toBe('idle');
    expect(riskPhase(def, def.idleMs - def.warnMs + 1).state).toBe('warning');
    expect(riskPhase(def, def.idleMs + 1).state).toBe('armed');
    expect(riskPhase(def, def.idleMs + def.armedMs + 1).state).toBe('idle');
  });
});
