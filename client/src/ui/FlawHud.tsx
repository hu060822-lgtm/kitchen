import { useEffect, useState } from 'react';
import {
  FREE_REQUESTS,
  HEAT_LABEL,
  HEAT_LEVELS,
  RECIPES,
  STATION_BY_ID,
  ZONES,
  flawSpeedMultiplier,
  type FlawEffectConfig,
  type KitchenPublic,
  type OrderPublic,
  type PlayerFlawState,
  type Seat,
} from '@last-table/shared';
import { currentZone, momentum, pose } from '../game/controller';
import { nearbyFloor, wobblingMate } from '../game/loop';
import { remotes } from '../game/remote';
import { act } from '../net/socket';
import { myFlaw, shiftNow, useStore } from '../state/store';
import { useSeatName } from './flawUi';

/**
 * Phase B–D 的畫面：缺陷狀態的文字行、身體狀態的大提示（失衡、噴嚏、睡意、聽不清楚、衝勁）、
 * 隊友需要你的提示（接住、撿起、快打噴嚏、睡著了、召集），以及嗜睡學徒的雙爐面板。
 * 全部只顯示伺服器給的狀態（kitchen.self、kitchen.coop），不自己判定任何規則。
 */

function useTick(ms: number): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

const secs = (ms: number): string => `${Math.max(0, Math.ceil(ms / 1000))}s`;

/** 這張單能不能做成冷盤（依配方：不要求熱的） */
export function coldCapable(o: Pick<OrderPublic, 'kind' | 'recipeId' | 'requestId'>): boolean {
  if (o.kind === 'signature') return !!o.recipeId && RECIPES[o.recipeId]?.hot === false;
  return !!o.requestId && FREE_REQUESTS[o.requestId]?.hot !== true;
}

/** FlawStatus 面板的文字行（B–D 的卡） */
export function flawLines(self: PlayerFlawState, k: KitchenPublic, role: Seat, cfg: FlawEffectConfig, now: number): JSX.Element[] {
  const out: JSX.Element[] = [];
  const held = k.players[role]?.held ?? null;
  switch (self.flaw) {
    case 'D05': {
      const cd = (self.cooldowns.rally ?? 0) - now;
      out.push(<div key="d05" className="sm">{cd > 0 ? `召集冷卻中 ${secs(cd)}` : <><kbd>V</kbd> 召集全隊（就緒）</>}</div>);
      break;
    }
    case 'D06':
      out.push(<div key="d06" className="sm">切菜少 ⅓ 刀・削皮快 50%</div>);
      out.push(<div key="d06b" className="xs dim">拿著東西別跑、別急轉；失衡時停下或按 <kbd>X</kbd></div>);
      break;
    case 'D07':
      out.push(<div key="d07" className="sm">{held?.kind === 'crate' ? `搬貨 ×${cfg.D07.crateSpeed}` : '最上層伸手就拿'}</div>);
      out.push(<div key="d07b" className="xs dim">乾貨室前門太低：走防火門繞後走廊</div>);
      break;
    case 'D08': {
      const peeks = Object.entries(self.peeks ?? {}).filter(([, u]) => u > now);
      out.push(<div key="d08" className="sm">窄縫：冷藏室 ↔ 乾貨室（只有你過得去）</div>);
      out.push(<div key="d08b" className="xs dim">{peeks.length ? `看得到：${peeks.map(([id, u]) => `${STATION_BY_ID[id]?.label} ${secs(u - now)}`).join('、')}` : '湯鍋要墊腳看；最上層搆不到'}</div>);
      break;
    }
    case 'D09': {
      const clamps = Object.entries(self.clamps ?? {}).filter(([, u]) => u > now);
      out.push(<div key="d09" className="sm">清洗、擦砧板、量溫度快 30%</div>);
      out.push(<div key="d09b" className="xs dim">{clamps.length ? `夾具：${clamps.map(([id, u]) => `${STATION_BY_ID[id]?.label} ${secs(u - now)}`).join('、')}` : '打蛋、盛湯要雙手：請隊友扶穩，或用夾具'}</div>);
      break;
    }
    case 'D10': {
      const g = (self.gloveUntil ?? 0) - now;
      out.push(<div key="d10" className="sm">{g > 0 ? `🧤 隔熱手套 ${secs(g)}（最多中火）` : '不碰火源・調味一次量兩種'}</div>);
      const cold = k.orders.filter((o) => o.status === 'open' && !o.forgotten && coldCapable(o));
      if (cold.length) out.push(<div key="d10b" className="xs">❄ 可做冷盤：{cold.map((o) => `#${o.table}`).join('、')}</div>);
      break;
    }
    case 'D11':
      out.push(<div key="d11" className="sm">洗碗、擦砧板快一倍・托盤收 6 個</div>);
      for (const h of (self.hints ?? []).filter((x) => x.kind === 'contamination').slice(-2)) out.push(<div key={h.id} className="xs warnline">🧼 {h.text}</div>);
      break;
    case 'D12': {
      const m = flawSpeedMultiplier('D12', currentZone(), held?.kind ?? null, cfg);
      out.push(<div key="d12" className="sm">{m > 1 ? `開放空間 ×${m}・交接 ${cfg.D12.openHandoffRange} m` : '這裡不是開放空間'}</div>);
      out.push(<div key="d12b" className="xs dim">冷藏室進不去：食材請隊友放到門口交接架</div>);
      break;
    }
    case 'D13':
      out.push(<div key="d13" className="sm">直線加速到 ×{cfg.D13.maxMult}・<kbd>Space</kbd> 煞停</div>);
      break;
    case 'D14': {
      const d = self.drowsy;
      const links = (self.links ?? []).map((id) => STATION_BY_ID[id]?.label).filter(Boolean);
      out.push(<div key="d14" className="sm">睡意 {d?.level ?? 0}{d?.state === 'heavy' ? '・眼皮很重' : d?.state === 'warn' ? '・打哈欠' : ''}</div>);
      out.push(<div key="d14b" className="xs dim">{links.length ? <><kbd>V</kbd> 雙爐：{links.join('、')}</> : '碰過兩個爐具後可以用 V 同時顧'}</div>);
      break;
    }
    case 'D16': {
      for (const h of (self.hints ?? []).filter((x) => x.kind === 'smell').slice(-2)) out.push(<div key={h.id} className="xs">👃 {h.text}</div>);
      if ((self.hints ?? []).some((x) => x.kind === 'smell')) out.push(<div key="d16v" className="xs dim"><kbd>V</kbd> 把聞到的味道告訴全隊</div>);
      break;
    }
  }
  return out;
}

/** 身體狀態的大提示：失衡倒數、噴嚏倒數、睡意條、聽不清楚、暴衝的衝勁 */
export function BodyAlerts({ role }: { role: Seat }): JSX.Element | null {
  useTick(100);
  const k = useStore.getState().kitchen;
  const cfg = useStore.getState().flawConfig;
  const self = k?.self;
  if (!k || !self) return null;
  const now = shiftNow();
  const items: JSX.Element[] = [];
  if (self.wobble && self.wobble.until > now) {
    const total = self.wobble.cause === 'sneeze' ? cfg.D16.windowMs : self.wobble.cause === 'bump' ? 1400 : cfg.D06.windowMs;
    const left = self.wobble.until - now;
    items.push(
      <div key="w" className="body-alert danger" role="alert">
        <b>⚠ 手上的東西快掉了</b>
        <span className="sm">{self.wobble.cause === 'sneeze' ? '請隊友按 F 接住' : self.wobble.cause === 'bump' && myFlaw() !== 'D06' ? '馬上停下來穩住，或讓隊友按 F 接住' : <>停下來、按 <kbd>X</kbd> 穩住，或讓隊友接住</>}</span>
        <span className="meter"><i style={{ width: `${(left / total) * 100}%` }} /></span>
      </div>,
    );
  }
  if (self.flaw === 'D16' && self.sneezeAt) {
    const left = self.sneezeAt - now;
    const warn = left <= cfg.D16.warnMs;
    items.push(
      <div key="s" className={`body-chip ${warn ? 'danger pulse' : ''}`}>
        👃 {warn ? `鼻子好癢！${(left / 1000).toFixed(1)} 秒後打噴嚏——站穩、放下量匙` : `下次噴嚏 ${secs(left)}`}
        <span className="meter"><i style={{ width: `${Math.max(0, 1 - left / cfg.D16.periodMs) * 100}%` }} /></span>
      </div>,
    );
  }
  if (self.flaw === 'D14' && self.drowsy) {
    const d = self.drowsy;
    items.push(
      <div key="d" className={`body-chip ${d.state === 'heavy' || d.holding ? 'danger' : d.state === 'warn' ? 'warn' : ''}`}>
        {d.state === 'asleep' ? '💤 睡著了' : d.holding ? '硬撐著不睡——把盤子放下' : `睡意 ${d.level}`}
        <span className="meter drowsy">
          <i style={{ width: `${Math.min(100, d.level)}%` }} />
          <em style={{ left: `${cfg.D14.warnAt}%` }} />
          <em style={{ left: `${cfg.D14.heavyAt}%` }} />
        </span>
      </div>,
    );
  }
  if (self.muffledUntil && self.muffledUntil > now) {
    items.push(<div key="m" className="body-chip warn">📣 耳朵嗡嗡響：{secs(self.muffledUntil - now)} 內聽不清楚其他聲音</div>);
  }
  const mo = momentum();
  if (mo) {
    items.push(
      <div key="mo" className={`body-chip ${mo.wallAhead ? 'danger' : ''}`}>
        衝勁 {mo.speed.toFixed(1)} m/s{mo.wallAhead ? '・前面有牆！' : ''}
        <span className="meter"><i style={{ width: `${(mo.speed / mo.max) * 100}%` }} /></span>
      </div>,
    );
  }
  void role;
  return items.length ? <div className="body-alerts">{items}</div> : null;
}

/** 睡著時整個畫面變暗（仍然看得到發生什麼事） */
export function SleepVeil(): JSX.Element | null {
  useTick(200);
  const self = useStore.getState().kitchen?.self;
  const d = self?.drowsy;
  if (!d || (d.state !== 'asleep' && d.state !== 'heavy')) return null;
  const now = shiftNow();
  return (
    <div className={`sleep-veil ${d.state}`} aria-live="polite">
      {d.state === 'asleep' && (
        <div className="plate">
          💤 你睡著了……{d.sleepUntil ? `（${secs(d.sleepUntil - now)}）` : ''}
          <div className="xs dim">爐子照常在煮。隊友拍肩可以叫醒你。</div>
        </div>
      )}
    </div>
  );
}

/** 隊友需要你：接住、撿起、快打噴嚏、睡著了、召集（方向箭頭） */
export function TeamAlerts({ role }: { role: Seat }): JSX.Element | null {
  useTick(150);
  const k = useStore.getState().kitchen;
  const nameOf = useSeatName();
  if (!k) return null;
  const now = shiftNow();
  const out: JSX.Element[] = [];
  const myHeld = k.players[role]?.held;
  const w = wobblingMate();
  if (w) {
    out.push(
      <div key="w" className="prompt plate handoff-prompt" role="alert">
        <kbd>F</kbd>
        <span>{myHeld ? '先空出手才能' : ''}接住{nameOf(w.seat)}手上快掉的{w.what}（{((w.until - now) / 1000).toFixed(1)}s）</span>
      </div>,
    );
  }
  const f = nearbyFloor();
  if (f && !(k.self?.wobble && k.self.flaw === 'D06')) {
    out.push(
      <div key="f" className="prompt plate">
        <kbd>X</kbd>
        <span>{k.self?.flaw === 'D11' ? `地上的${f.what}（你不碰：請隊友撿）` : `撿起地上的${f.what}`}</span>
      </div>,
    );
  }
  for (const s of k.coop.sneezes) {
    if (s.seat === role) continue;
    const rp = remotes[s.seat];
    if (!rp || Math.hypot(rp.x - pose.x, rp.z - pose.z) > 6) continue;
    out.push(<div key={`s${s.seat}`} className="team-chip">👃 {nameOf(s.seat)} {((s.at - now) / 1000).toFixed(1)} 秒後打噴嚏——準備接住</div>);
  }
  for (const d of k.coop.drowsy) {
    if (d.seat === role) continue;
    out.push(<div key={`d${d.seat}`} className="team-chip">{d.state === 'asleep' ? `💤 ${nameOf(d.seat)}睡著了：走過去 E → 拍一下` : `😪 ${nameOf(d.seat)}快睡著了`}</div>);
  }
  for (const r of k.coop.rallies) {
    if (r.by === role) continue;
    const ang = Math.atan2(-(r.x - pose.x), -(r.z - pose.z)) - pose.yaw;
    const deg = Math.round(((-ang * 180) / Math.PI) % 360);
    const dist = Math.hypot(r.x - pose.x, r.z - pose.z);
    const replied = r.replies.some((x) => x.by === role);
    const where = ZONES.find((z) => r.x >= z.minX && r.x <= z.maxX && r.z >= z.minZ && r.z <= z.maxZ)?.label ?? '';
    out.push(
      <div key={r.id} className="team-chip rally">
        <span className="rally-arrow" style={{ transform: `rotate(${deg}deg)` }}>▲</span>
        📣 {nameOf(r.by)}在{where}召集（{dist.toFixed(0)} m）{replied ? '・已回應' : <>・<kbd>Y</kbd> 收到</>}
      </div>,
    );
  }
  const mineRally = k.coop.rallies.find((r) => r.by === role);
  if (mineRally?.replies.length) out.push(<div key="rr" className="team-chip">已回應：{mineRally.replies.map((x) => nameOf(x.by)).join('、')}</div>);
  return out.length ? <div className="team-alerts">{out}</div> : null;
}

/** 嗜睡學徒的雙爐面板（V）：在 4.2 公尺內同時調整最近碰過的兩個爐具 */
export function DualOverlay({ onClose }: { onClose: () => void }): JSX.Element {
  useTick(250);
  const k = useStore((s) => s.kitchen);
  const cfg = useStore((s) => s.flawConfig);
  const links = k?.self?.links ?? [];
  const asleep = k?.self?.drowsy?.state === 'asleep';
  const heavy = k?.self?.drowsy?.state === 'heavy';
  return (
    <div className="modal-bg station-bg" role="dialog" aria-label="雙爐" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal station dual">
        <header>
          <div>
            <h2>雙爐</h2>
            <div className="sub">站在兩個爐具之間（{cfg.D14.dualRange} 公尺內）同時調整。快睡著時暫停。</div>
          </div>
          <button className="btn small" onClick={onClose}>關閉 <kbd>Esc</kbd></button>
        </header>
        <div className="body">
          {links.length === 0 && <p className="note">先親手操作一個平底鍋或湯鍋，它就會加入雙爐（最多兩個）。</p>}
          {(asleep || heavy) && <p className="warnline">{asleep ? '你睡著了。' : '眼皮太重了：雙爐暫停，先提神（洗把臉、換個工作或請隊友拍你）。'}</p>}
          {links.map((id) => {
            const def = STATION_BY_ID[id];
            const s = k?.stations[id];
            if (!def || !s) return null;
            const dist = Math.hypot(def.pos[0] - pose.x, def.pos[1] - pose.z);
            const far = dist > cfg.D14.dualRange;
            const isPot = def.kind === 'stove';
            return (
              <div key={id} className="ctrl">
                <div className="lbl">
                  {def.label}　<span className="xs dim">{far ? `太遠了（${dist.toFixed(1)} m）` : `${dist.toFixed(1)} m`}・{s.items.length ? `${s.items.length} 樣在鍋裡` : '空的'}</span>
                </div>
                <div className="row">
                  {HEAT_LEVELS.map((h) => (
                    <button key={h} className={`btn small ${s.heat === h ? 'primary' : ''}`} disabled={far || asleep || heavy} onClick={() => void act(id, 'heat', { level: h })}>
                      {HEAT_LABEL[h]}
                    </button>
                  ))}
                  <button className="btn small" disabled={far || asleep || heavy || !s.items.length} onClick={() => void act(id, isPot ? 'stir' : 'flip')}>
                    {isPot ? '攪拌' : '全部翻面'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
