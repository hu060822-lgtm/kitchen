import {
  CUT_LABEL,
  DEFAULT_WEIGHTS,
  FLAVOR_LABEL,
  COMMISSIONS,
  COMMISSION_FAIL_CAP,
  COMMISSION_WEIGHTS,
  GRADE_REWARD,
  gradeOf,
  judge,
  timeScore,
  type CommissionDef,
  type QualityGrade,
  HOT_SERVE_TEMP,
  INGREDIENTS,
  RECIPES,
  SEASONINGS,
  TASTE_FALLOFF,
  VESSEL_LABEL,
  cookingState,
  dishTaste,
  freshnessState,
  maxBrown,
  totalSeasoning,
  type CategoryWeights,
  type FlavorDim,
  type IngredientId,
  type PlateComponent,
  type RecipeDef,
  type Seat,
  type ScoreReason,
  type ScoreResult,
  type SeasoningId,
  type Vessel,
  isRawProtein,
  METHOD_LABEL,
  analyzeDish,
  type Method,
} from '@last-table/shared';

/**
 * 出餐評分（伺服器權威，純函式）。
 *
 * 只看盤子上的東西：每個成分的狀態快照（切法、熟度、上色、溫度、操作紀錄）與調味量。
 * 不讀取任何恐怖系統的狀態——怪物、客人、燈光都不會出現在這個檔案裡（測試會檢查）。
 * 每一項扣分都附上原因，玩家可以從結果追查自己哪一步做錯。
 */

export interface PlateForScore {
  vessel: Vessel;
  components: PlateComponent[];
  seasoning: Partial<Record<SeasoningId, number>>;
  liquid?: number;
}

export interface OrderForScore {
  id: string;
  kind: 'signature' | 'free';
  recipeId?: string;
  requestId?: string;
  openedAt: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const avg = (xs: number[], empty = 1) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : empty);
const label = (t: IngredientId) => INGREDIENTS[t].label;

/** 區間評分：在區間內＝1；超出時依超出量線性下降 */
function bandScore(v: number, [lo, hi]: [number, number], soft = 1): number {
  if (v >= lo && v <= hi) return 1;
  const d = v < lo ? lo - v : v - hi;
  return clamp01(1 - d / soft);
}

/** 成分的平均溫度（不含奶油與生的配料），用來判斷「端上桌時是不是熱的」 */
function serveTemp(comps: PlateComponent[]): number {
  const hot = comps.filter((c) => c.methods.length > 0);
  if (!hot.length) return comps.length ? avg(comps.map((c) => c.temp)) : 0;
  return avg(hot.map((c) => c.temp));
}

const STEP_TEXT: Record<string, string> = {
  take: '拿出來',
  wash: '清洗',
  peel: '削皮',
  wipe: '擦砧板',
  contaminated: '碰到切過生肉的砧板',
  dropped: '掉到地上',
  plate: '裝盤',
  ladle: '盛進碗裡',
  scoop: '撈起來',
  soak: '泡水',
  mix: '攪拌',
  flip: '翻面',
  stir: '攪拌',
};

function stepText(op: string, note?: string): string {
  const [head, arg] = op.split(':');
  if (head === 'chop') return `${CUT_LABEL[arg as keyof typeof CUT_LABEL] ?? arg}${note ? `（${note}）` : ''}`;
  if (head === 'place') return `放到${note ?? arg}`;
  if (head === 'season') return `加${SEASONINGS[arg as SeasoningId]?.label ?? arg} ${note ?? ''}`.trim();
  if (head === 'toast') return `烤麵包機 ${arg} 段`;
  return (STEP_TEXT[head] ?? op) + (note ? `（${note}）` : '');
}

function trailOf(comps: PlateComponent[]): ScoreResult['trail'] {
  return comps.map((c) => ({
    label: `${label(c.type)}${c.cut !== 'WHOLE' ? `（${CUT_LABEL[c.cut]}）` : ''}`,
    steps: c.history.map((h) => {
      const s = Math.floor(h.t / 1000);
      return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')} ${stepText(h.op, h.note)}`;
    }),
  }));
}

/** 招牌菜：必要成分燒焦時的分數上限 */
export const BURNT_MAIN_CAP = 45;

/** 食品安全與新鮮度：不能因為其他項目分數高就拿高分 */
function safetyCap(comps: PlateComponent[], reasons: ScoreReason[]): ScoreResult['cap'] {
  let cap: ScoreResult['cap'];
  const lower = (max: number, why: string) => {
    if (!cap || max < cap.max) cap = { max, why };
    reasons.push({ cat: 'safety', ok: false, text: why });
  };
  for (const c of comps) {
    const def = INGREDIENTS[c.type];
    if (def.heat.safeTemp && c.maxTemp < def.heat.safeTemp) {
      lower(30, `食品安全：${def.label}中心溫度最高只到 ${Math.round(c.maxTemp)}°C（需要 ${def.heat.safeTemp}°C）`);
    }
    if (c.contaminated && !isRawProtein(def)) lower(40, `交叉汙染：${def.label}在切過生肉、沒擦過的砧板上處理`);
    if (c.floorDirty) lower(30, `${def.label}掉在地上過，沒有重新洗`);
    if (freshnessState(c) === 'EXPIRED') lower(30, `${def.label}已經過期`);
  }
  if (!reasons.some((r) => r.cat === 'safety')) reasons.push({ cat: 'safety', ok: true, text: '食品安全沒有問題' });
  return cap;
}

function efficiencyOf(elapsedSec: number, parSec: number): ScoreResult['efficiency'] {
  if (elapsedSec <= parSec * 0.8) return 'fast';
  if (elapsedSec <= parSec * 1.3) return 'on_time';
  return 'slow';
}

function finish(
  order: OrderForScore,
  dish: string,
  cats: CategoryWeights,
  weights: CategoryWeights,
  reasons: ScoreReason[],
  cap: ScoreResult['cap'],
  plate: PlateForScore,
  servedAt: number,
  parSec: number,
  servedBy: Seat,
  taste?: Partial<Record<FlavorDim, number>>,
): ScoreResult {
  const wsum = Object.values(weights).reduce((a, b) => a + b, 0);
  let total = (Object.keys(weights) as Array<keyof CategoryWeights>).reduce((s, k) => s + weights[k] * cats[k], 0) / wsum * 100;
  if (cap) total = Math.min(total, cap.max);
  const elapsedSec = Math.round((servedAt - order.openedAt) / 100) / 10;
  const categories: Record<string, number> = Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, r2(v)]));
  return {
    orderId: order.id,
    dish,
    total: Math.round(total),
    categories,
    weights: { ...weights },
    reasons,
    cap,
    taste,
    elapsedSec,
    parSec,
    efficiency: efficiencyOf(elapsedSec, parSec),
    servedBy,
    trail: trailOf(plate.components),
  };
}

/* ------------------------------ 招牌菜 ------------------------------ */

export function scoreSignature(recipe: RecipeDef, plate: PlateForScore, order: OrderForScore, servedAt: number, servedBy: Seat): ScoreResult {
  const reasons: ScoreReason[] = [];
  const weights = { ...DEFAULT_WEIGHTS, ...recipe.weights };
  const pool = [...plate.components];
  const proc: number[] = [];
  const done: number[] = [];
  const prep: number[] = [];
  let missing = 0;
  let burntMain: string | undefined;

  for (const rc of recipe.components) {
    const picked: PlateComponent[] = [];
    let qty = 0;
    const take = (t: IngredientId) => {
      for (let i = 0; i < pool.length && qty < rc.qty; ) {
        if (pool[i].type === t) {
          qty += pool[i].qty;
          picked.push(pool.splice(i, 1)[0]);
        } else i++;
      }
    };
    take(rc.type);
    // 沒有指定的食材：用食譜允許的替代食材（算對一部分）
    let subbed: IngredientId | null = null;
    for (const a of rc.alt ?? []) {
      if (picked.length) break;
      take(a);
      if (picked.length) subbed = a;
    }
    const name = label(rc.type);
    if (!picked.length) {
      if (rc.optional) continue;
      missing++;
      proc.push(0);
      done.push(0);
      reasons.push({ cat: 'process', ok: false, text: `缺少：${name}` });
      continue;
    }
    // 製程：份量、處理、烹調方式
    const checks: Array<[boolean, string, string]> = [];
    checks.push([qty >= rc.qty, `${name}份量正確`, `${name}份量不足（${qty}／${rc.qty}）`]);
    if (subbed) checks.push([false, '', `用${label(subbed)}代替${name}（客人點的是${name}）`]);
    if (rc.washed) checks.push([picked.every((c) => c.washed), `${name}有洗`, `${name}沒有洗`]);
    if (rc.peeled) checks.push([picked.every((c) => c.peeled), `${name}有削皮`, `${name}沒有削皮`]);
    const okMethods = [rc.method, ...(rc.methodAlt ?? [])];
    const methodOk = (c: PlateComponent) => okMethods.some((m) => (m === 'raw' ? c.methods.length === 0 : c.methods.includes(m)));
    const methodText = okMethods.map((m) => (m === 'raw' ? '直接上盤' : METHOD_LABEL[m as Method])).join('或');
    checks.push([picked.every(methodOk), `${name}烹調方式正確`, rc.method === 'raw' && okMethods.length === 1 ? `${name}不該加熱` : `${name}要用${methodText}`]);
    const passed = checks.filter((c) => c[0]).length;
    proc.push(passed / checks.length);
    for (const [ok, good, bad] of checks) reasons.push({ cat: 'process', ok, text: ok ? good : bad });
    if (rc.optional) reasons.push({ cat: 'process', ok: true, text: `加了可選的${name}` });

    // 火候：熟度與上色區間
    for (const c of picked) {
      const st = cookingState(c);
      if (st === 'BURNT') {
        done.push(0);
        reasons.push({ cat: 'doneness', ok: false, text: `${name}燒焦了` });
        if (!rc.optional && !INGREDIENTS[c.type].tags.includes('fat')) burntMain ??= name;
        continue;
      }
      const parts: number[] = [];
      if (rc.doneness) {
        const s = bandScore(c.doneness, rc.doneness, Math.max(0.6, (rc.doneness[1] - rc.doneness[0]) / 2));
        parts.push(s);
        const text = s === 1 ? `${name}熟度剛好` : c.doneness < rc.doneness[0] ? `${name}還沒熟透` : `${name}煮過頭了`;
        reasons.push({ cat: 'doneness', ok: s === 1, text });
      }
      if (rc.browning) {
        const b = maxBrown(c);
        const s = bandScore(b, rc.browning, 0.6);
        parts.push(s);
        const text = s === 1 ? `${name}上色剛好` : b < rc.browning[0] ? `${name}上色不夠` : `${name}上色過深`;
        reasons.push({ cat: 'doneness', ok: s === 1, text });
      }
      done.push(avg(parts));
    }

    // 刀工
    if (rc.cut && rc.cut !== 'WHOLE') {
      for (const c of picked) {
        if (c.cut !== rc.cut) {
          prep.push(0.4 * (c.cutQuality ?? 0.5));
          reasons.push({ cat: 'prep', ok: false, text: `${name}要${CUT_LABEL[rc.cut]}，實際是${CUT_LABEL[c.cut]}` });
        } else {
          const q = c.cutQuality ?? 0;
          prep.push(q);
          reasons.push({ cat: 'prep', ok: q >= 0.75, text: q >= 0.75 ? `${name}${CUT_LABEL[c.cut]}整齊（${Math.round(q * 100)}%）` : `${name}${CUT_LABEL[c.cut]}大小不一致（${Math.round(q * 100)}%）` });
        }
      }
    } else if (rc.cut === 'WHOLE') {
      for (const c of picked) if (c.cut !== 'WHOLE') {
        prep.push(0.5);
        reasons.push({ cat: 'prep', ok: false, text: `${name}應該整顆使用` });
      }
    }
  }
  // 多出來的成分
  for (const extra of pool) reasons.push({ cat: 'process', ok: false, text: `多了：${label(extra.type)}` });
  const processScore = avg(proc, 0) * Math.max(0, 1 - 0.12 * pool.length);

  // 調味：與食譜的比例偏差
  const total = totalSeasoning(plate.components, plate.seasoning);
  const seas: number[] = [];
  for (const [s, target] of Object.entries(recipe.seasoning) as Array<[SeasoningId, number]>) {
    const a = total[s] ?? 0;
    const lbl = SEASONINGS[s].label;
    const sc = clamp01(1 - Math.abs(a - target) / Math.max(target, 0.5));
    seas.push(sc);
    if (a === 0) reasons.push({ cat: 'seasoning', ok: false, text: `沒有加${lbl}` });
    else if (sc === 1) reasons.push({ cat: 'seasoning', ok: true, text: `${lbl}的份量正確` });
    else reasons.push({ cat: 'seasoning', ok: false, text: `${lbl}${a > target ? '高於' : '低於'}配方（${r2(a)}／${target}）` });
  }
  let seasonScore = avg(seas);
  for (const [s, a] of Object.entries(total) as Array<[SeasoningId, number]>) {
    if (recipe.seasoning[s] === undefined && a >= 0.5) {
      seasonScore = Math.max(0, seasonScore - 0.25);
      reasons.push({ cat: 'seasoning', ok: false, text: `多加了${SEASONINGS[s].label}（${r2(a)}）` });
    }
  }

  // 裝盤與出餐
  const temp = serveTemp(plate.components);
  const vesselOk = plate.vessel === recipe.vessel;
  const hotOk = !recipe.hot || temp >= HOT_SERVE_TEMP;
  const plating = (vesselOk ? 0.4 : 0) + (missing === 0 ? 0.3 : 0) + (hotOk ? 0.3 : 0);
  reasons.push({ cat: 'plating', ok: vesselOk, text: vesselOk ? `用${VESSEL_LABEL[recipe.vessel]}盛裝` : `應該用${VESSEL_LABEL[recipe.vessel]}` });
  reasons.push({ cat: 'plating', ok: missing === 0, text: missing === 0 ? '成分齊全' : `少了 ${missing} 樣成分` });
  if (recipe.hot) reasons.push({ cat: 'plating', ok: hotOk, text: hotOk ? `端上桌時是熱的（${Math.round(temp)}°C）` : `已經涼了（${Math.round(temp)}°C）` });

  let cap = safetyCap(plate.components, reasons);
  // 主要食材燒焦：其他項目再好也最多 45 分（燒焦的蛋不能算一份好的煎蛋吐司）
  if (burntMain && (!cap || cap.max > BURNT_MAIN_CAP)) {
    cap = { max: BURNT_MAIN_CAP, why: `${burntMain}燒焦了` };
    reasons.push({ cat: 'doneness', ok: false, text: `主要食材燒焦（${burntMain}）：最多 ${BURNT_MAIN_CAP} 分` });
  }
  const cats: CategoryWeights = { process: processScore, doneness: avg(done, 0), prep: avg(prep), seasoning: seasonScore, plating };
  return finish(order, recipe.name, cats, weights, reasons, cap, plate, servedAt, recipe.parSec, servedBy);
}

/* ------------------------------ 主廚委託 ------------------------------ */

/**
 * 委託：伺服器只看結構化條件（不看文字）。
 *   必要條件 → 違反任何一條＝委託沒有達成（分數最多 35），另外列出違規原因；
 *   品質 → 烹調 30、風味 25、搭配 20、質地與完成度 15、時間 10（品質來自自由料理的判定）；
 *   加分條件 → 每做到一條加分，總分最多 100；食品安全的上限照樣適用。
 */
export function scoreCommission(c: CommissionDef, plate: PlateForScore, order: OrderForScore, servedAt: number, servedBy: Seat): ScoreResult {
  const reasons: ScoreReason[] = [];
  const a = analyzeDish(plate, { target: Object.keys(c.taste).length ? c.taste : undefined });
  const elapsedSec = Math.round((servedAt - order.openedAt) / 100) / 10;
  const ctx = { analysis: a, vessel: plate.vessel, temp: serveTemp(plate.components), elapsedSec, hotTemp: HOT_SERVE_TEMP };
  const violations: string[] = [];
  for (const cond of c.require) {
    const j = judge(cond, ctx);
    reasons.push({ cat: 'require', ok: j.ok, text: j.text });
    if (!j.ok) violations.push(j.text);
  }
  const bonuses: Array<{ text: string; pts: number }> = [];
  for (const b of c.bonus) {
    const j = judge(b.cond, ctx);
    if (j.ok) bonuses.push({ text: b.text, pts: b.pts });
    reasons.push({ cat: 'bonus', ok: j.ok, text: j.ok ? `${b.text}（＋${b.pts}）` : `${b.text}：${j.text}` });
  }
  const time = timeScore(elapsedSec, c.parSec);
  const cats: Record<string, number> = { cook: a.quality.cook / 100, flavor: a.quality.flavor / 100, pairing: a.quality.pairing / 100, texture: a.quality.texture / 100, time };
  for (const n of a.notes) reasons.push({ cat: n.dim, ok: n.ok, text: n.text });
  reasons.push({ cat: 'time', ok: time >= 1, text: time >= 1 ? `標準時間內出餐（${Math.round(elapsedSec)} 秒）` : `比標準時間慢（${Math.round(elapsedSec)}／${c.parSec} 秒）` });
  let total = (Object.keys(COMMISSION_WEIGHTS) as Array<keyof typeof COMMISSION_WEIGHTS>).reduce((s, k) => s + COMMISSION_WEIGHTS[k] * cats[k], 0);
  total += bonuses.reduce((s, b) => s + b.pts, 0);
  total = Math.min(100, total);
  if (a.cap) total = Math.min(total, a.cap.max);
  const passed = violations.length === 0;
  if (!passed) total = Math.min(total, COMMISSION_FAIL_CAP);
  if (!plate.components.length) total = 0;
  const grade: QualityGrade = passed ? gradeOf(Math.round(total)) : 'fail';
  const coins = Math.round(c.reward.coins * GRADE_REWARD[grade] * (passed && (a.kind === 'new' || a.kind === 'variant') ? 1.2 : 1));
  const categories = Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, r2(v)]));
  return {
    orderId: order.id,
    dish: `主廚委託：${c.title}`,
    total: Math.round(total),
    categories,
    weights: { ...COMMISSION_WEIGHTS },
    reasons,
    cap: a.cap,
    taste: a.taste,
    elapsedSec,
    parSec: c.parSec,
    efficiency: efficiencyOf(elapsedSec, c.parSec),
    servedBy,
    trail: trailOf(plate.components),
    analysis: a,
    commission: { id: c.id, title: c.title, passed, violations, bonuses, grade, coins },
  };
}

export function scorePlate(plate: PlateForScore, order: OrderForScore, servedAt: number, servedBy: Seat): ScoreResult {
  if (order.kind !== 'signature') return scoreCommission(COMMISSIONS[order.requestId!], plate, order, servedAt, servedBy);
  const r = scoreSignature(RECIPES[order.recipeId!], plate, order, servedAt, servedBy);
  // 這道菜實際是什麼（和訂單分數分開）：名稱、分類、四項品質
  r.analysis = analyzeDish(plate);
  return r;
}
