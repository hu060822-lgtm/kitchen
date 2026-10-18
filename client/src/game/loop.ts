import { handsFull } from '../ui/kitchenText';
import { nextTab, tabIds } from './storageTabs';
import { actionOf, isAction } from './keymap';
import { CARRY_MAX, INGREDIENTS, INGREDIENT_IDS, SEASONING_IDS, RESTAURANT_ACOUSTICS, SEATS, STATIONS, ZONES, flawBodyScale, flawSpeedMultiplier, forwardOf, planQuick, PHYSICS, type Body, type IngredientId, type KitchenPublic, type QuickMode, type QuickPlan, type Seat, type StationDef, type StationKind } from '@last-table/shared';
import { audio, type LoopSpec } from '../audio/engine';
import { speak } from '../audio/speech';
import { act, coop, emitMark, sendMove, sendStance } from '../net/socket';
import { myFlaw, useStore, type Overlay } from '../state/store';
import { voice } from '../voice/voice';
import {
  blockedZone,
  body,
  clearKeys,
  currentTarget,
  currentZone,
  eyeScale,
  getColliders,
  look,
  nearestStation,
  nextMove,
  pose,
  setBodies,
  setCrouch,
  setKey,
  setSpeedMultiplier,
  step,
} from './controller';
import { remotes, smooth } from './remote';
import { emit, on } from './bus';
import { BlindAudioSystem } from './blind';

/** 指引聲（無障礙選項）：不同工作站用不同音高（火源最低、出餐口最高） */
const KIND_PITCH: Partial<Record<StationKind, number>> = {
  stove: 262,
  pan: 294,
  toaster: 330,
  prep: 392,
  sink: 349,
  spice: 440,
  plating: 494,
  pass: 587,
  fridge: 220,
  pantry: 247,
  trash: 196,
  locker: 175,
  cage: 165,
  delivery: 185,
  cctv: 523,
};

const isMoveKey = (code: string): boolean => ['forward', 'back', 'left', 'right'].includes(actionOf(code) ?? '');

let surface: HTMLElement | null = null;

export function requestLock(): void {
  const el = surface ?? document.body;
  try {
    const p = el.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => undefined);
  } catch {
    /* 瀏覽器不支援或剛按過 Esc */
  }
  void audio.init().then(() => audio.startAmbient());
}

const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

function role(): Seat | null {
  return useStore.getState().me?.role ?? null;
}

export function toggleOverlay(o: Exclude<Overlay, 'none'>): void {
  const st = useStore.getState();
  if (st.station) closeStation();
  const next = st.overlay === o ? 'none' : o;
  st.set({ overlay: next });
  if (next !== 'none' && document.pointerLockElement) document.exitPointerLock();
  if (next === 'none') requestLock();
}

/** 打開工作站面板（滑鼠解鎖，可以點按鈕；也可以用數字鍵） */
export function openStation(id: string): void {
  const st = useStore.getState();
  st.set({ station: { id, result: null }, overlay: 'none', mate: null });
  audio.uiOpen();
  if (document.pointerLockElement) document.exitPointerLock();
  const def = STATIONS.find((s) => s.id === id);
  if (def) speak(`${def.label}。用 Tab 鍵切換按鈕，空白鍵按下`, { interrupt: true });
}

/** 打開隊友面板（拍肩、遞東西、覆誦、試吃回報） */
export function openMate(seat: Seat): void {
  const st = useStore.getState();
  st.set({ mate: seat, station: null, overlay: 'none' });
  audio.uiOpen();
  if (document.pointerLockElement) document.exitPointerLock();
}

export function closeMate(relock = true): void {
  if (!useStore.getState().mate) return;
  useStore.getState().set({ mate: null });
  audio.uiClose();
  if (relock) requestLock();
}

/**
 * 面前（±25°、2 公尺內）最近的隊友。
 * 和工作站同時在面前時：正對著隊友（工作站偏在一旁）或隊友比工作站近（擋在前面），就是隊友；
 * 否則是工作站（站在工作站前的隊友不會擋住你開工作站）。
 */
export function preferMate(t: { dist: number; align: number } | null, mate: { dist: number } | null): boolean {
  return !!mate && (!t || mate.dist < t.dist || t.align < 0.9);
}

export function mateTarget(): { seat: Seat; dist: number } | null {
  const [fx, fz] = forwardOf(pose.yaw);
  let best: Seat | null = null;
  let bd = Infinity;
  for (const s of SEATS) {
    const rp = remotes[s];
    if (!rp) continue;
    const vx = rp.x - pose.x;
    const vz = rp.z - pose.z;
    const d = Math.hypot(vx, vz);
    if (d > 2.0 || d < 0.05) continue;
    if ((vx * fx + vz * fz) / d < 0.9) continue;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best ? { seat: best, dist: bd } : null;
}

/** 身邊（2.2 公尺內）手上東西正在失衡的隊友 */
export function wobblingMate(): { seat: Seat; what: string; until: number } | null {
  const k = useStore.getState().kitchen;
  const me = role();
  if (!k || !me) return null;
  let best: { seat: Seat; what: string; until: number; d: number } | null = null;
  for (const w of k.coop.wobbles) {
    if (w.seat === me) continue;
    const rp = remotes[w.seat];
    if (!rp) continue;
    const d = Math.hypot(rp.x - pose.x, rp.z - pose.z);
    if (d <= 2.2 && (!best || d < best.d)) best = { ...w, d };
  }
  return best;
}

/** 身邊撿得到的地上的東西 */
export function nearbyFloor(): { id: string; what: string; d: number } | null {
  const k = useStore.getState().kitchen;
  if (!k) return null;
  const range = useStore.getState().flawConfig.common.pickupRange;
  let best: { id: string; what: string; d: number } | null = null;
  for (const f of k.coop.floor) {
    const d = Math.hypot(f.x - pose.x, f.z - pose.z);
    if (d <= range && (!best || d < best.d)) best = { id: f.id, what: f.what, d };
  }
  return best;
}

/** X：奶油手穩住手上的東西；否則撿起身邊地上的東西 */
function pressX(): void {
  const st = useStore.getState();
  const self = st.kitchen?.self;
  if (self?.wobble && self.flaw === 'D06') {
    void coop('grip');
    return;
  }
  const f = nearbyFloor();
  if (f) {
    void coop('pickup', { floorId: f.id });
    return;
  }
  // 附近有積水：擦乾
  if (nearbyPuddle()) {
    void coop('mop');
    return;
  }
  st.pushNotice({ tone: 'info', text: '附近地上沒有東西。' }, 1800);
}

/** 身邊可以擦的積水 */
export function nearbyPuddle(): { id: string; inside: boolean } | null {
  const k = useStore.getState().kitchen;
  let best: { id: string; inside: boolean; d: number } | null = null;
  for (const p of k?.physics?.puddles ?? []) {
    const d = Math.hypot(p.x - pose.x, p.z - pose.z) - p.r;
    if (d <= PHYSICS.puddle.mopRange && (!best || d < best.d)) best = { id: p.id, inside: d <= 0, d };
  }
  return best;
}

/** 準心對著的隊友（丟東西的目標）：7 公尺內、準心 ±14° */
export function tossTarget(): { seat: Seat; dist: number } | null {
  const r = role();
  const k = useStore.getState().kitchen;
  if (!r || !k) return null;
  const [fx, fz] = forwardOf(pose.yaw);
  let best: { seat: Seat; dist: number; align: number } | null = null;
  for (const s of SEATS) {
    if (s === r) continue;
    const rp = remotes[s];
    if (!rp || (k.players[s]?.status ?? 'ok') !== 'ok') continue;
    const vx = rp.x - pose.x;
    const vz = rp.z - pose.z;
    const d = Math.hypot(vx, vz);
    if (d < 0.3 || d > PHYSICS.toss.range) continue;
    const align = (vx * fx + vz * fz) / d;
    if (align >= PHYSICS.toss.aim && (!best || align > best.align)) best = { seat: s, dist: d, align };
  }
  return best ? { seat: best.seat, dist: best.dist } : null;
}

/** T：把手上的食材丟給準心對著的隊友；沒有對著人就丟到前面的地上 */
function pressT(): void {
  const r = role();
  const st = useStore.getState();
  const held = r ? st.kitchen?.players[r]?.held : null;
  if (!held) {
    st.pushNotice({ tone: 'info', text: '手上沒有東西可以丟。' }, 1800);
    return;
  }
  const t = tossTarget();
  void coop('toss', t ? { to: t.seat } : monsterAimed() ? { to: 'monster' } : {});
}

/** 準心對著後門的東西（丟東西砸牠：愣住 3 秒） */
export function monsterAimed(): number | null {
  const m = useStore.getState().kitchen?.threats.monster;
  if (!m?.present) return null;
  const [fx, fz] = forwardOf(pose.yaw);
  const vx = m.x - pose.x;
  const vz = m.z - pose.z;
  const d = Math.hypot(vx, vz);
  if (d > PHYSICS.toss.range || d < 0.3) return null;
  return (vx * fx + vz * fz) / d >= 0.94 ? d : null;
}

/** V：缺陷卡的技能（大嗓門召集、定時噴嚏送出氣味警告、嗜睡學徒的雙爐面板） */
function pressV(): void {
  const st = useStore.getState();
  const self = st.kitchen?.self;
  switch (self?.flaw) {
    case 'D05':
      void coop('rally');
      return;
    case 'D16': {
      const h = [...(self.hints ?? [])].reverse().find((x) => x.kind === 'smell');
      if (!h) st.pushNotice({ tone: 'info', text: '現在沒有聞到什麼。' }, 1800);
      else void coop('smell', { hintId: h.id });
      return;
    }
    case 'D14':
      toggleOverlay('dual');
      return;
  }
  st.pushNotice({ tone: 'info', text: '你的卡沒有 V 技能。' }, 1800);
}

/** Z：在腳前畫一個路線箭頭（給暴衝快遞看，30 秒） */
function pressZ(): void {
  const [fx, fz] = forwardOf(pose.yaw);
  void coop('route', { x: pose.x + fx * 0.8, z: pose.z + fz * 0.8, yaw: pose.yaw });
}

/** Y：回應最近的召集（收到） */
function pressY(): void {
  const st = useStore.getState();
  const me = role();
  const r = [...(st.kitchen?.coop.rallies ?? [])].reverse().find((x) => x.by !== me);
  if (!r) {
    st.pushNotice({ tone: 'info', text: '現在沒有召集。' }, 1800);
    return;
  }
  void coop('rally_reply', { rallyId: r.id, token: 'GEST_YES' });
}

/** 接住隊友遞給我的東西（F）；身邊有人手上的東西快掉了，就先接住那個 */
function acceptHandoff(): void {
  const st = useStore.getState();
  const me = role();
  const w = wobblingMate();
  if (w && !handsFull(st.kitchen ?? null, me!)) {
    void coop('catch', { to: w.seat });
    return;
  }
  const offer = st.kitchen?.coop.handoffs.find((h) => h.to === me);
  if (!offer) {
    st.pushNotice({ tone: 'info', text: '現在沒有人遞東西給你。' }, 2000);
    return;
  }
  void coop('handoff_accept', { offerId: offer.id });
}

/** 關閉面板：離開監視器、放棄切到一半的節奏（伺服器不會留下半成品） */
export function closeStation(relock = true): void {
  const st = useStore.getState();
  const s = st.station;
  if (!s) return;
  st.set({ station: null });
  audio.uiClose();
  const def = STATIONS.find((x) => x.id === s.id);
  if (def?.kind === 'cctv' && st.kitchen?.threats.cctv) void act('cctv', 'watch', { on: false }, { quiet: true });
  if (relock) requestLock();
}

function myStatus(k: KitchenPublic | null, r: Seat): 'ok' | 'trapped' | 'hidden' {
  return k?.players[r]?.status ?? 'ok';
}

function guestAt(k: KitchenPublic | null): [number, number] | null {
  const g = k?.threats.guest;
  return g && g.state !== 'gone' && g.state !== 'escorted' ? [g.x, g.z] : null;
}

function interact(): void {
  const r = role();
  if (!r) return;
  const st = useStore.getState();
  if (st.station) return;
  const k = st.kitchen;
  if (!k) return;
  const status = myStatus(k, r);
  if (status === 'hidden') {
    const locker = STATIONS.find((s) => s.kind === 'locker' && k.stations[s.id]?.occupant === r);
    if (locker) void act(locker.id, 'leave');
    return;
  }
  if (status === 'trapped') {
    // 自己掙脫（伺服器決定要多久：沒有隊友能救時比較快）
    if (k.players[r]?.task?.kind !== 'struggle') void act('cage', 'struggle');
    return;
  }
  const t = currentTarget(r, guestAt(k));
  const mate = mateTarget();
  if (mate && preferMate(t, mate)) {
    openMate(mate.seat);
    return;
  }
  if (!t) {
    audio.uiKey();
    return;
  }
  if (t.guest) {
    void act('guest', 'escort');
    return;
  }
  openStation(t.station!.id);
}

/** 注視這個工作站時，左鍵（拿／放）或右鍵（使用）會做什麼（伺服器用同一個判斷真的執行） */
export function quickPlanFor(mode: QuickMode, r: Seat, def: StationDef): QuickPlan | null {
  const k = useStore.getState().kitchen;
  const me = k?.players[r];
  const s = k?.stations[def.id];
  if (!k || !me || !s) return null;
  return planQuick(mode, def, s, me, k.orders.filter((o) => o.status === 'open').length, { monsterIn: !!k.threats.monster?.present });
}

/** 滑鼠點擊（鎖定滑鼠、沒有面板時）：左鍵＝拿／放，右鍵＝使用；要選擇的事才打開面板 */
function clickStation(mode: QuickMode): void {
  const r = role();
  const st = useStore.getState();
  const k = st.kitchen;
  if (!r || !k || st.station || st.mate) return;
  const status = myStatus(k, r);
  if (status !== 'ok') {
    interact();
    return;
  }
  const t = currentTarget(r, guestAt(k));
  const mate = mateTarget();
  if (mate && preferMate(t, mate)) {
    openMate(mate.seat);
    return;
  }
  if (!t) return;
  if (t.guest) {
    void act('guest', 'escort');
    return;
  }
  const def = t.station!;
  const plan = quickPlanFor(mode, r, def);
  if (!plan || plan.kind === 'panel') {
    openStation(def.id);
    return;
  }
  if (plan.kind === 'none') {
    st.pushNotice({ tone: 'info', text: `${plan.label}。` }, 1800);
    audio.uiWarn();
    return;
  }
  void act(def.id, 'quick', { mode });
}

/** 換手（伺服器判定：兩隻手都拿著東西才有意義；拿著要用雙手的東西不能換） */
export function swapHands(): void {
  const r = role();
  if (!r) return;
  void act('self', 'swap', {}, { quiet: true });
  audio.uiKey();
}

/** 冷藏架／乾貨架上第 n 種食材（面板裡的順序，數字鍵 1–9） */
/** 看著架子時數字鍵拿的食材：目前分頁裡的那幾種 */
export function storageIds(kind: StationKind): IngredientId[] {
  return tabIds(kind === 'fridge' ? 'FRIDGE' : 'PANTRY');
}

/** 注視冷藏架／乾貨架時按數字鍵：直接拿第 n 種（Shift：一次拿到 4 份） */
function quickTake(n: number, max: boolean): boolean {
  const r = role();
  const st = useStore.getState();
  const k = st.kitchen;
  if (!r || !k || myStatus(k, r) !== 'ok') return false;
  const def = currentTarget(r, guestAt(k))?.station;
  if (!def || (def.kind !== 'fridge' && def.kind !== 'pantry')) return false;
  const type = storageIds(def.kind)[n - 1];
  if (!type) return false;
  void act(def.id, 'take', { type, count: max ? CARRY_MAX : 1 });
  return true;
}

/** 數字鍵一鍵操作（不用打開面板）：看著爐子／烤箱設火力、看著烤麵包機選段數、看著調味區量調味料、看著監視器用門禁 */
export const HEAT_KEYS = ['OFF', 'LOW', 'MED', 'HIGH'] as const;
function quickDigit(n: number, shift: boolean): boolean {
  const r = role();
  const k = useStore.getState().kitchen;
  if (!r || !k || myStatus(k, r) !== 'ok') return false;
  const def = currentTarget(r, guestAt(k))?.station;
  if (!def) return false;
  switch (def.kind) {
    case 'pan':
    case 'stove':
    case 'oven':
      if (n > 4) return false;
      void act(def.id, 'heat', { level: HEAT_KEYS[n - 1] });
      return true;
    case 'toaster':
      if (n > 5) return false;
      void act(def.id, 'start', { level: n });
      return true;
    case 'spice': {
      const id = SEASONING_IDS[n - 1];
      if (!id) return false;
      void act(def.id, 'measure', { seasoning: id, units: shift ? 1 : 0.5 });
      return true;
    }
    case 'cctv': {
      const a = ['fire_door', 'back_door', 'flash'][n - 1];
      if (!a) return false;
      void act(def.id, a);
      return true;
    }
  }
  return false;
}

/** 注視冷藏架／乾貨架時按 0：換到下一個分類 */
function quickTab(): boolean {
  const r = role();
  const k = useStore.getState().kitchen;
  if (!r || !k) return false;
  const def = currentTarget(r, guestAt(k))?.station;
  if (!def || (def.kind !== 'fridge' && def.kind !== 'pantry')) return false;
  nextTab(def.kind === 'fridge' ? 'FRIDGE' : 'PANTRY');
  return true;
}

/** 標記工具（所有人）：指向注視中的工作站；隊友看到標記與來源，可以回應 */
function mark(): void {
  const r = role();
  if (!r) return;
  const st = useStore.getState();
  if (st.station) return;
  const t = currentTarget(r);
  if (!t?.station) {
    st.pushNotice({ tone: 'warn', text: '先注視一個工作站，再按 G 標記。' }, 2500);
    return;
  }
  const s = t.station;
  void emitMark(s.id).then((err) => {
    if (err) st.pushNotice({ tone: 'warn', text: err }, 2500);
    else st.pushNotice({ tone: 'info', text: `已標記：${s.label}` }, 2000);
  });
}

/**
 * 環境聲學（聲學地標：抽油煙機、壓縮機、漏水、燈管、時鐘）。所有人都有；遊戲畫面卸載時整個移除。
 * （回聲與轉向提示是舊版盲區員的功能，缺陷卡版本不使用。）
 */
let blindSys: BlindAudioSystem | null = null;
let blindSysRole: Seat | null = null;

const doorOpen = (door: string): boolean => {
  const d = useStore.getState().kitchen?.doors as Record<string, boolean> | undefined;
  return d ? d[door] !== false : true;
};

function systemFor(r: Seat | null): BlindAudioSystem | null {
  if (r === blindSysRole) return blindSys;
  blindSys?.dispose();
  blindSys = null;
  blindSysRole = r;
  if (r) blindSys = new BlindAudioSystem({ level: RESTAURANT_ACOUSTICS, blind: false, isOpen: doorOpen, speak: (t) => speak(t, { interrupt: true }) });
  return blindSys;
}

/** 測試與開發者工具用（?debug 時掛在 window.__NP__ 上） */
export const blindDebug = { system: (): BlindAudioSystem | null => blindSys };

/** 音訊校準：左聲道、右聲道、兩邊同時（確認音量），每一段都有語音說明 */
export function calibrateAudio(): void {
  void audio.init().then(() => {
    speak('左聲道', { interrupt: true });
    audio.testChannel('left');
    window.setTimeout(() => {
      speak('右聲道');
      audio.testChannel('right');
    }, 1400);
    window.setTimeout(() => {
      speak('兩邊同時');
      audio.testChannel('both');
    }, 2800);
  });
}

/** 廚房持續的聲音：爐上的油爆、湯滾、乾鍋，以及怪物的呼吸（都只是感知，不影響規則） */
export function kitchenLoops(k: KitchenPublic): LoopSpec[] {
  const out: LoopSpec[] = [];
  for (const def of STATIONS) {
    const s = k.stations[def.id];
    if (!s) continue;
    const v = s.vessel ?? 22;
    if (def.kind === 'pan' && s.items.length && v > 105) {
      out.push({ id: def.id, kind: 'sizzle', pos: def.pos, level: Math.min(1, (v - 100) / 150) });
    } else if (def.kind === 'stove') {
      if ((s.liquid ?? 0) > 0 && v >= 92) out.push({ id: def.id, kind: 'boil', pos: def.pos, level: Math.min(1, 0.4 + (v - 92) / 12) });
      else if (s.items.length && v > 120) out.push({ id: def.id, kind: (s.scorch ?? 0) > 0 ? 'dry' : 'sizzle', pos: def.pos, level: Math.min(1, (v - 100) / 150) });
    }
  }
  const m = k.threats.monster;
  if (m?.present) out.push({ id: 'monster', kind: 'breath', pos: [m.x, m.z], level: m.mode === 'chase' || m.mode === 'windup' ? 1 : 0.55 });
  return out;
}

export function bindInput(el: HTMLElement): () => void {
  surface = el;
  const onKeyDown = (e: KeyboardEvent): void => {
    const st = useStore.getState();
    if (typing(e.target)) {
      if (e.code === 'Escape') {
        (e.target as HTMLElement).blur();
        if (st.station) closeStation();
        else if (st.overlay !== 'none') st.set({ overlay: 'none' });
      }
      return;
    }
    if (isAction(e.code, 'tickets') && !st.station) {
      e.preventDefault();
      toggleOverlay('tickets');
      return;
    }
    if (e.repeat) return;
    // 面板開著時按移動鍵：關面板、直接開始走（不必先按 Esc；在按鍵事件裡才能重新鎖定滑鼠）
    if ((st.station || st.mate) && isMoveKey(e.code)) {
      closeStation();
      closeMate();
      setKey(e.code, true);
      return;
    }
    // 隊友面板開著時，數字鍵交給面板
    if (st.mate && /^Digit\d$/.test(e.code)) return;
    // 面板開著時，空白鍵與數字鍵交給面板（切菜節奏、按鈕）
    if (st.station && (e.code === 'Space' || isAction(e.code, 'chop') || /^Digit\d$/.test(e.code) || e.code === 'Tab' || e.code === 'Enter')) return;
    // 注視冷藏架／乾貨架時按數字鍵：不用打開面板就直接拿（Shift＋數字＝一次拿到滿）
    if (!st.station && !st.mate && /^Digit[1-9]$/.test(e.code) && (quickTake(Number(e.code.slice(5)), e.shiftKey) || quickDigit(Number(e.code.slice(5)), e.shiftKey))) return;
    if (!st.station && !st.mate && e.code === 'Digit0' && quickTab()) return;
    if (e.code === 'Backquote') {
      if (st.debug) st.set({ debugOpen: !st.debugOpen });
      if (st.debug && document.pointerLockElement) document.exitPointerLock();
      return;
    }
    if (e.code === 'Escape') {
      if (st.station) closeStation();
      else if (st.mate) closeMate();
      else if (st.overlay !== 'none') st.set({ overlay: 'none' });
      return;
    }
    switch (actionOf(e.code)) {
      case 'interact':
        if (st.station) closeStation();
        else if (st.mate) closeMate();
        else interact();
        return;
      case 'signals':
        toggleOverlay('signals');
        return;
      case 'cookbook':
        toggleOverlay('cookbook');
        return;
      case 'help':
        toggleOverlay('help');
        return;
      case 'mute':
        if (st.micState === 'on') voice.setMuted(!st.micMuted);
        return;
      case 'handoff':
        acceptHandoff();
        return;
      case 'pickup':
        pressX();
        return;
      case 'toss':
        pressT();
        return;
      case 'swap':
        swapHands();
        return;
      case 'ability':
        pressV();
        return;
      case 'route':
        pressZ();
        return;
      case 'reply':
        pressY();
        return;
      case 'calibrate':
        calibrateAudio();
        return;
      case 'mark':
        mark();
        return;
      case 'crouch':
        setCrouch(!body.crouch);
        speak(body.crouch ? '蹲下' : '站起');
        return;
      default:
        setKey(e.code, true);
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => setKey(e.code, false);
  const onMouse = (e: MouseEvent): void => {
    if (document.pointerLockElement) look(e.movementX, e.movementY, useStore.getState().prefs.sensitivity);
  };
  const onMouseDown = (e: MouseEvent): void => {
    const st = useStore.getState();
    if (!document.pointerLockElement || st.station || st.mate || st.overlay !== 'none') return;
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    clickStation(e.button === 2 ? 'use' : 'primary');
  };
  // 遊戲畫面上不跳出右鍵選單（右鍵＝使用）
  const onContext = (e: MouseEvent): void => {
    if (document.pointerLockElement || (surface && e.target instanceof Node && surface.contains(e.target))) e.preventDefault();
  };
  const onLockChange = (): void => {
    const locked = !!document.pointerLockElement;
    useStore.getState().set({ locked });
    if (!locked && !useStore.getState().station) clearKeys();
  };
  const onBlur = (): void => clearKeys();
  // 滑鼠滾輪也能換手（只在鎖定滑鼠、沒有面板時；避免捲動面板時誤觸）
  let lastWheel = 0;
  const onWheel = (e: WheelEvent): void => {
    const st = useStore.getState();
    if (!document.pointerLockElement || st.station || st.mate || st.overlay !== 'none') return;
    const now = performance.now();
    if (Math.abs(e.deltaY) < 1 || now - lastWheel < 250) return;
    lastWheel = now;
    swapHands();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouse);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('contextmenu', onContext);
  window.addEventListener('wheel', onWheel, { passive: true });
  window.addEventListener('blur', onBlur);
  document.addEventListener('pointerlockchange', onLockChange);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('mousemove', onMouse);
    window.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('contextmenu', onContext);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('pointerlockchange', onLockChange);
    clearKeys();
    surface = null;
  };
}

export function startGameLoop(): () => void {
  let raf = 0;
  let last = performance.now();
  let lastBump = 0;
  let nextBeacon = 0;
  let lastZone = currentZone();
  let announced = '';
  let lastTalk = 0;
  let kitchenSeen: KitchenPublic | null = null;
  let monsterLast: { x: number; z: number } | null = null;
  let monsterStride = 0;
  let statusSeen = '';
  let lastZoneNotice = 0;

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const st = useStore.getState();
    const r = st.me?.role ?? null;
    if (!r) return;
    const k = st.kitchen;

    // 缺陷卡的速度倍率（與伺服器同一個函式、同一份設定）
    setSpeedMultiplier(flawSpeedMultiplier(myFlaw(), currentZone(), k?.players[r]?.held?.kind ?? null, st.flawConfig));
    if (blockedZone.at > lastZoneNotice + 3000) {
      lastZoneNotice = blockedZone.at;
      st.pushNotice({ tone: 'warn', text: '冷藏室太封閉了，你進不去。請隊友把食材放到冷藏室門口交接架。' }, 3500);
    }
    // 隊友的身體：不能穿過去（被關著、躲著的人不算）
    const others: Body[] = [];
    for (const s2 of SEATS) {
      if (s2 === r) continue;
      const rp = remotes[s2];
      if (rp && (k?.players[s2]?.status ?? 'ok') === 'ok') others.push({ x: rp.x, z: rp.z, r: PHYSICS.bodyRadius * flawBodyScale(k?.coop.flaws[s2], st.flawConfig) });
    }
    setBodies(others);
    const enabled = st.locked && !st.station && !st.mate && st.overlay === 'none' && !!k;
    const res = step(dt, enabled);
    if (res.footstep) audio.footstep(null, res.running, 0, eyeScale());
    if (res.blocked && now - lastBump > 450) {
      lastBump = now;
      audio.bump();
    }
    const m = nextMove(now);
    if (m) sendMove(m);
    sendStance(body.crouch, !!st.station);

    audio.setListener(pose.x, pose.z, pose.yaw);

    if (k && k !== kitchenSeen) {
      kitchenSeen = k;
      audio.setLoops(kitchenLoops(k));
      // 怪物的腳步：依快照之間走過的距離
      const mo = k.threats.monster;
      if (mo?.present) {
        if (monsterLast) {
          const d = Math.hypot(mo.x - monsterLast.x, mo.z - monsterLast.z);
          monsterStride += d < 4 ? d : 0;
          if (monsterStride >= 1.1) {
            monsterStride = 0;
            audio.heavyStep([mo.x, mo.z], mo.mode === 'chase');
          }
        }
        monsterLast = { x: mo.x, z: mo.z };
      } else monsterLast = null;
      const status = myStatus(k, r);
      if (status !== statusSeen) {
        if (statusSeen && status === 'hidden') speak('你躲在置物櫃裡。按 E 出來', { interrupt: true });
        statusSeen = status;
      }
    }

    systemFor(r)?.update(pose.x, pose.z, pose.yaw, now);

    smooth(dt, (who, x, z) => audio.footstep([x, z], false, 0, flawBodyScale(k?.coop.flaws[who], st.flawConfig)));
    for (const who of SEATS) {
      const rp = remotes[who];
      if (rp) audio.updateVoicePos(who, rp.x, rp.z);
      // 大嗓門的語音：比較大聲、傳得比較遠（呈現；遊戲機制不依賴語音）
      if (k?.coop.flaws[who] === 'D05') audio.setVoiceProfile(who, st.flawConfig.D05.voiceGain, st.flawConfig.D05.voiceRolloff);
    }

    // 隊友說話中（只有「我真的收得到的語音」才會顯示）
    if (now - lastTalk > 150) {
      lastTalk = now;
      const talking: Partial<Record<Seat, boolean>> = {};
      let changed = false;
      for (const who of SEATS) {
        if (who === r || !audio.hasVoice(who)) continue;
        talking[who] = audio.voiceLevel(who) > 0.06;
      }
      const prev = st.talking;
      for (const q of new Set([...Object.keys(prev), ...Object.keys(talking)]) as Set<Seat>) {
        if (!!prev[q] !== !!talking[q]) changed = true;
      }
      if (changed) st.set({ talking });
      audio.setEnvDuck(Object.values(talking).some(Boolean));
    }

    if (k && (st.prefs.beacon || st.prefs.speech)) {
      // 無障礙選項：最近的工作站發出「滴」聲（音高代表種類）；面對它時用語音報出名稱
      const zone = currentZone();
      if (zone !== lastZone) {
        lastZone = zone;
        const z = ZONES.find((q) => q.id === zone);
        if (z) speak(z.label);
      }
      const near = st.prefs.beacon ? nearestStation(r, 7) : null;
      if (near && now >= nextBeacon && !st.station && myStatus(k, r) === 'ok') {
        nextBeacon = now + Math.max(320, Math.min(1500, near.dist * 160));
        audio.beacon(near.dx, near.dz, pose.yaw, near.dist, KIND_PITCH[near.station.kind] ?? 400);
      }
      const t = currentTarget(r, guestAt(k));
      const id = t ? (t.guest ? 'guest' : t.station!.id) : '';
      if (id !== announced) {
        announced = id;
        if (t?.guest) speak('面前站著客人。按 E 請他回座位');
        else if (t?.station) speak(`${t.station.label}，按 E`);
      }
    }
  };
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    audio.stopLoops();
    systemFor(null);
  };
}
