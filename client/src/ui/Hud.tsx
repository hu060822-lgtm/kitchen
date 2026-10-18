import { useEffect, useState } from 'react';
import { BASKET_SLOTS, CUT_LABEL, MIX_LABEL, INGREDIENTS, SEASONINGS, TASK_TEXT, isTwoHanded, type Held, TOKEN_COLOR, TOKEN_LABEL, ZONES, flawSpeedMultiplier, type KitchenPublic, type Seat, type SignalToken, type StationDef } from '@last-table/shared';
import { currentTarget, currentZone, pose } from '../game/controller';
import { mateTarget, nearbyFloor, nearbyPuddle, preferMate, quickPlanFor, requestLock, storageIds, tossTarget } from '../game/loop';
import { currentTab, tabLabel, useStorageTab } from '../game/storageTabs';
import { keyLabel, useKeymap } from '../game/keymap';
import { forceStart, readyUp } from '../net/socket';
import { myFlaw, shiftNow, useStore } from '../state/store';
import { FlawBadge, useSeatName } from './flawUi';
import { Icon, RoleGlyph, TokenGlyph } from './icons';
import { fmtSec, heldText, orderDish, orderNeed, tableLabel } from './kitchenText';
import { BodyAlerts, SleepVeil, TeamAlerts, flawLines } from './FlawHud';
import { useEndlessToday } from './EndlessUi';

/** 固定的空陣列（zustand 的 selector 不能每次回傳新陣列，否則會無限重繪） */
const NONE: never[] = [];

export function TokenChip({ t, size = 18 }: { t: SignalToken; size?: number }): JSX.Element {
  const color = TOKEN_COLOR[t];
  if (color) {
    return <span className="tok lamp-tok" style={{ background: color }} title={TOKEN_LABEL[t]} aria-label={TOKEN_LABEL[t]} />;
  }
  const labeled = t.startsWith('GEST_') || t.startsWith('TAP_');
  return (
    <span className={`tok ${labeled ? 'tap' : ''}`} title={TOKEN_LABEL[t]} aria-label={TOKEN_LABEL[t]}>
      <TokenGlyph t={t} size={size} />
      {labeled && <span className="xs">{TOKEN_LABEL[t]}</span>}
    </span>
  );
}

/** 每 100–250ms 重繪一次（不需要每一幀重繪 React） */
function useTick(ms: number): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

const guestPos = (k: KitchenPublic | null): [number, number] | null => {
  const g = k?.threats.guest;
  return g && g.state !== 'gone' && g.state !== 'escorted' ? [g.x, g.z] : null;
};

/** 準星與互動提示 */
function Aim({ role }: { role: Seat }): JSX.Element {
  useTick(100);
  useKeymap();
  const k = useStore.getState().kitchen;
  const status = k?.players[role]?.status ?? 'ok';
  const t = status === 'ok' ? currentTarget(role, guestPos(k)) : null;
  const mateHit = status === 'ok' ? mateTarget() : null;
  const showMate = preferMate(t, mateHit);
  const mate = mateHit?.seat ?? null;
  const nameOf = useSeatName();
  const incoming = k?.coop.handoffs.find((h) => h.to === role);
  const zone = ZONES.find((z) => pose.x >= z.minX && pose.x <= z.maxX && pose.z >= z.minZ && pose.z <= z.maxZ);
  return (
    <>
      <div className={`crosshair ${t || showMate ? 'hot' : ''}`} aria-hidden>
        <i />
      </div>
      {status === 'hidden' && (
        <div className="prompt plate">
          <kbd>{keyLabel('interact')}</kbd>
          <span>離開置物櫃</span>
        </div>
      )}
      {status === 'trapped' && <CagePrompt k={k!} role={role} />}
      {showMate && mate ? (
        <div className="prompt plate">
          <kbd>{keyLabel('interact')}</kbd>
          <span>隊友：{nameOf(mate)}</span>
          <FlawBadge flaw={k?.coop.flaws[mate]} short />
        </div>
      ) : (
        t && (
          <div className="prompt plate">
            <kbd>{keyLabel('interact')}</kbd>
            <span>{t.guest ? '請客人回座位' : t.station!.label}</span>
            {t.station && <MouseHints role={role} def={t.station} />}
            {(t.station?.kind === 'fridge' || t.station?.kind === 'pantry') && (
              <span className="xs dim quick-take">
                <QuickTake kind={t.station.kind} />
              </span>
            )}
          </div>
        )
      )}
      {incoming && k && (
        <div className="prompt plate handoff-prompt" role="alert">
          <kbd>{keyLabel('handoff')}</kbd>
          <span>
            接住{nameOf(incoming.from)}遞來的{incoming.what}（{Math.max(0, Math.ceil((incoming.expiresAt - shiftNow()) / 1000))} 秒）
          </span>
        </div>
      )}
      <PhysicsPrompts k={k} role={role} />
      {zone && <div className="zone-tag plate">{zone.label}</div>}
    </>
  );
}

/** 物理的提示：丟給準心對著的隊友、腳下的積水（擦乾） */
function PhysicsPrompts({ k, role }: { k: KitchenPublic | null; role: Seat }): JSX.Element | null {
  const nameOf = useSeatName();
  if (!k || (k.players[role]?.status ?? 'ok') !== 'ok') return null;
  const held = k.players[role]?.held;
  const toss = held?.kind === 'item' ? tossTarget() : null;
  const pud = nearbyFloor() ? null : nearbyPuddle();
  if (!toss && !pud) return null;
  return (
    <div className="physics-prompts">
      {toss && (
        <div className="prompt plate">
          <kbd>{keyLabel('toss')}</kbd>
          <span>
            丟給{nameOf(toss.seat)}（{toss.dist.toFixed(1)} 公尺）
          </span>
        </div>
      )}
      {pud && (
        <div className={`prompt plate ${pud.inside ? 'wet' : ''}`}>
          <kbd>{keyLabel('pickup')}</kbd>
          <span>擦乾地上的水{pud.inside ? '・腳下很滑，別用跑的' : ''}</span>
        </div>
      )}
    </div>
  );
}

/** 準星旁的滑鼠提示：左鍵會做什麼、右鍵會做什麼（不能做的不顯示） */
function MouseHints({ role, def }: { role: Seat; def: StationDef }): JSX.Element | null {
  const a = quickPlanFor('primary', role, def);
  const b = quickPlanFor('use', role, def);
  const show = (p: typeof a): string | null => (p && p.kind !== 'none' ? p.label : null);
  const l = show(a);
  const r = show(b);
  if (!l && !r) return null;
  return (
    <span className="xs mouse-hints">
      {l && (
        <span>
          <kbd className="mouse">左鍵</kbd>
          {l}
        </span>
      )}
      {r && r !== l && !(a?.kind === 'panel' && b?.kind === 'panel') && (
        <span>
          <kbd className="mouse">右鍵</kbd>
          {r}
        </span>
      )}
    </span>
  );
}

/** 出單軌最多顯示幾張（其餘以 +N 表示，Tab 看全部） */
const MAX_TICKETS = 5;
/** 主廚委託的需求在出單軌上只留前 14 個字 */
const shortNeed = (t: string): string => (t.length > 16 ? `${t.slice(0, 15)}…」` : t);

/** 出單軌：每一張單是一張熱感紙條，底部印著剩餘時間 */
function Rail(): JSX.Element | null {
  useTick(250);
  const k = useStore((s) => s.kitchen);
  const today = useEndlessToday();
  if (!k) return null;
  const now = shiftNow();
  const open = k.orders.filter((o) => o.status === 'open');
  const clock =
    k.phase === 'PREP' ? { label: '備料', left: k.prepMs - now } : k.phase === 'SERVICE' ? { label: '營業中', left: k.prepMs + k.serviceMs - now } : { label: '打烊', left: 0 };
  return (
    <div className="rail">
      <div className="clock plate">
        <span>{k.tutorial ? '教學' : clock.label}</span>
        <b className="code">{k.tutorial ? '不計時' : fmtSec(clock.left)}</b>
        <span className="xs dim">
          {today ? `第 ${today.day} 天・` : ''}出餐 {k.stats.served}・跑單 {k.stats.missed}
          {today ? `／${today.missLimit}` : ''}
        </span>
      </div>
      {k.phase === 'PREP' && open.length === 0 && <div className="ticket hint">開店前先備料：洗、削、切。<br />Tab 看單、R 看食譜。</div>}
      {k.coop.prepHints
        .filter((h) => !h.orderId)
        .map((h) => (
          <div key={h.id} className="ticket hint prep-hint">
            <span className="xs">準備提示（已核對）</span>
            <b className="sm">{h.text}</b>
          </div>
        ))}
      {open.slice(0, MAX_TICKETS).map((o) => {
        const total = o.deadline - o.openedAt;
        const left = o.deadline - now;
        const frac = Math.max(0, Math.min(1, left / total));
        return (
          <div key={o.id} className={`ticket ${o.kind} ${o.story ? 'story' : ''} ${frac < 0.25 ? 'late' : ''} ${o.forgotten ? 'forgotten' : ''} ${k.self?.focus === o.id ? 'focus' : ''}`}>
            <div className="t-head">
              <span className="code">{tableLabel(o)}{k.self?.focus === o.id ? ' ★' : ''}</span>
              <span className="code">{fmtSec(left)}</span>
            </div>
            <b>{orderDish(o)}</b>
            {o.kind === 'free' && !o.forgotten && <p className="need">{shortNeed(orderNeed(o))}</p>}
            <span className="burn" style={{ width: `${frac * 100}%` }} />
          </div>
        );
      })}
      {open.length > MAX_TICKETS && <div className="ticket more">+{open.length - MAX_TICKETS}<span className="xs">Tab</span></div>}
    </div>
  );
}

/** 手上的東西與進行中的動作 */
function Hands({ role }: { role: Seat }): JSX.Element | null {
  useTick(150);
  const k = useStore((s) => s.kitchen);
  if (!k) return null;
  const me = k.players[role];
  const task = me?.task;
  const now = shiftNow();
  return (
    <div className="hands">
      {task && (
        <div className="taskbar plate">
          <span>{TASK_TEXT[task.kind]}</span>
          <span className="bar">
            <i style={{ width: `${Math.min(100, ((now - task.startedAt) / (task.endsAt - task.startedAt)) * 100)}%` }} />
          </span>
        </div>
      )}
      <Hotbar k={k} role={role} />
    </div>
  );
}

/** 物品欄的一格：短名稱＋詳細（滑鼠移上去看全文） */
function Slot({ label, h, k, role, active, wide, none }: { label: string; h: Held | null; k: KitchenPublic; role: Seat; active?: boolean; wide?: boolean; none?: boolean }): JSX.Element {
  const full = h ? heldText(h, k, role) : none ? '沒有這隻手' : '空';
  return (
    <div className={`slot ${active ? 'active' : ''} ${h ? '' : 'empty'} ${wide ? 'wide' : ''} ${none ? 'none' : ''}`} title={full} aria-label={`${label}：${full}`}>
      <span className="slot-label xs">{label}{active && !wide ? '・使用中' : ''}</span>
      <span className="slot-name">{h ? shortHeld(h, k) : none ? '—' : '空'}</span>
    </div>
  );
}

/** 物品欄：左手、右手、菜籃 2 格。目前的手會亮起來；大東西佔兩隻手 */
function Hotbar({ k, role }: { k: KitchenPublic; role: Seat }): JSX.Element {
  useKeymap();
  const me = k.players[role];
  const side = me?.side ?? 'R';
  const one = k.self?.flaw === 'D09';
  const L = side === 'L' ? me?.held ?? null : me?.other ?? null;
  const R = side === 'R' ? me?.held ?? null : me?.other ?? null;
  const basket = me?.basket ?? [];
  const two = isTwoHanded(me?.held ?? null);
  return (
    <div className="hotbar plate" role="group" aria-label="物品欄">
      {two ? (
        <Slot label="雙手" h={me!.held} k={k} role={role} active wide />
      ) : (
        <>
          <Slot label="左手" h={one ? null : L} k={k} role={role} active={!one && side === 'L'} none={one} />
          <Slot label="右手" h={one ? (me?.held ?? null) : R} k={k} role={role} active={one || side === 'R'} />
        </>
      )}
      <span className="slot-sep" aria-hidden />
      {Array.from({ length: BASKET_SLOTS }, (_, i) => {
        const id = basket[i];
        return <Slot key={i} label="菜籃" h={id ? { kind: 'item', id } : null} k={k} role={role} />;
      })}
      {!one && !two && me?.held && me?.other && (
        <span className="slot-hint xs">
          <kbd>{keyLabel('swap')}</kbd> 換手
        </span>
      )}
    </div>
  );
}

function shortHeld(h: NonNullable<Held>, k: KitchenPublic): string {
  if (h.kind === 'item') {
    const it = k.items[h.id];
    if (!it) return '食材';
    if (it.mix) return `${MIX_LABEL[it.mix.kind]}・${INGREDIENTS[it.type].label}等 ${it.mix.parts.length + 1} 樣`;
    const cut = it.cut !== 'WHOLE' ? `・${CUT_LABEL[it.cut]}` : (it.soaked ?? 0) >= 1 ? '・泡軟' : it.peeled ? '・削好' : it.washed ? '・洗好' : '';
    return `${INGREDIENTS[it.type].label}${cut}`;
  }
  if (h.kind === 'plate') {
    const p = k.plates[h.id];
    const v = p?.vessel === 'bowl' ? '碗' : '盤子';
    return p?.components.length ? `${v}（${p.components.length} 樣）` : `空${v}`;
  }
  if (h.kind === 'measure') return `量匙・${SEASONINGS[h.seasoning].label}${h.extra ? `＋${SEASONINGS[h.extra.seasoning].label}` : ''}`;
  if (h.kind === 'crate') return h.storage === 'FRIDGE' ? '冷藏貨箱' : '乾貨箱';
  return `髒盤 ×${h.plate + h.bowl}`;
}

function Mates({ me }: { me: Seat }): JSX.Element {
  const players = useStore((s) => s.room?.players ?? NONE);
  const talking = useStore((s) => s.talking);
  const k = useStore((s) => s.kitchen);
  return (
    <div className="mates">
      {players
        .filter((p) => p.role && p.role !== me)
        .map((p) => {
          const st = k?.players[p.role!]?.status ?? 'ok';
          return (
            <div key={p.id} className={`mate plate ${p.connected ? '' : 'off'} ${st}`}>
              <RoleGlyph role={p.role!} size={18} />
              <span>{p.name}</span>
              <FlawBadge flaw={k?.coop.flaws[p.role!] ?? p.flaw} short />
              {st === 'trapped' && <span className="xs st">被關在鐵籠</span>}
              {st === 'hidden' && <span className="xs st">躲在櫃子裡</span>}
              {talking[p.role!] && (
                <span className="talkbars" aria-label="說話中">
                  <i />
                  <i />
                  <i />
                </span>
              )}
              {!p.connected && <span className="xs">離線</span>}
            </div>
          );
        })}
    </div>
  );
}

function Signals(): JSX.Element | null {
  const signals = useStore((s) => s.signals);
  const nameOf = useSeatName();
  return (
    <div className="signals" aria-live="polite">
      {signals.map((s) => (
        <div key={s.id} className="sigcard plate">
          <span className="who">
            <RoleGlyph role={s.from} size={18} />
            {nameOf(s.from)}
          </span>
          {s.tokens.map((t, i) => (
            <TokenChip key={i} t={t} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Toasts(): JSX.Element | null {
  const notices = useStore((s) => s.notices);
  return (
    <div className="toasts" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`toast plate ${n.tone}`}>
          <span>{n.text}</span>
        </div>
      ))}
    </div>
  );
}

function MicChip({ role }: { role: Seat }): JSX.Element {
  const micState = useStore((s) => s.micState);
  const muted = useStore((s) => s.micMuted);
  const level = useStore((s) => s.micLevel);
  void role;
  if (myFlaw() === 'D04') {
    return (
      <div className="mic plate">
        <Icon name="micOff" size={16} /> 不使用語音・<kbd>G</kbd> 標記・<kbd>Q</kbd> 信號器
      </div>
    );
  }
  if (micState !== 'on') {
    return (
      <div className="mic plate">
        <Icon name="micOff" size={16} /> 麥克風未啟用・<kbd>H</kbd> 設定
      </div>
    );
  }
  return (
    <div className="mic plate">
      <Icon name={muted ? 'micOff' : 'mic'} size={16} />
      {muted ? (
        '已靜音'
      ) : (
        <span className="meter">
          <i style={{ width: `${Math.min(100, level * 260)}%` }} />
        </span>
      )}
      <kbd>M</kbd>
    </div>
  );
}

export default function Hud(): JSX.Element | null {
  const role = useStore((s) => s.me?.role ?? null);
  const locked = useStore((s) => s.locked);
  const station = useStore((s) => s.station);
  const overlay = useStore((s) => s.overlay);
  const briefed = useStore((s) => s.briefed);
  const closed = useStore((s) => s.kitchen?.phase === 'CLOSED');
  const mate = useStore((s) => s.mate);
  if (!role) return null;
  const showResume = briefed && !locked && !station && !mate && overlay === 'none' && !closed;

  return (
    <div className="hud">
      <WaitingBanner />
      <ThreatStatus />
      <SleepVeil />
      <Aim role={role} />
      <BodyAlerts role={role} />
      <TeamAlerts role={role} />
      <Rail />
      <Mates me={role} />
      <Hands role={role} />
      <FlawStatus role={role} />
      <TapCue role={role} />
      <Toasts />
      <Signals />
      <div className="bottombar">
        <MicChip role={role} />
        <div className="keys plate"><span><kbd>H</kbd>操作說明</span></div>
      </div>
      {showResume && (
        <div className="resume interactive" onClick={() => requestLock()}>
          <div className="box plate">
            <b>點一下畫面繼續</b>
            <span className="sm dim">廚房沒有暫停：爐子上的東西還在煮。<kbd>H</kbd> 說明</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ 缺陷卡狀態 ------------------------------ */

/**
 * 自己的缺陷卡與它現在的狀態（全部來自伺服器的個人狀態 kitchen.self）。
 * 規格要求：玩家必須能從介面辨認自己正在受到什麼限制、優勢什麼時候在作用。
 */
function FlawStatus({ role }: { role: Seat }): JSX.Element | null {
  useTick(250);
  const k = useStore((s) => s.kitchen);
  const cfg = useStore((s) => s.flawConfig);
  const nameOf = useSeatName();
  const self = k?.self;
  if (!k || !self) return null;
  const now = shiftNow();
  const lines: JSX.Element[] = [];
  if (self.flaw === 'D01') {
    const fresh = (self.rumors ?? []).filter((r) => !r.posted && r.expiresAt > now);
    lines.push(
      <div key="r" className="sm">
        {fresh.length ? `聽到 ${fresh.length} 則傳聞（Tab → 貼上訂單板）` : '目前沒有傳聞'}
      </div>,
    );
    for (const r of fresh.slice(-2)) lines.push(<div key={r.id} className="xs rumor-line">「{r.text}」<span className="dim">{Math.ceil((r.expiresAt - now) / 1000)}s</span></div>);
  }
  if (self.flaw === 'D02') {
    const lv = self.streak && self.streak.until > now ? self.streak.level : 0;
    const cut = Math.min(cfg.D02.maxStrokeCut, lv * cfg.D02.strokesPerStreak);
    const sp = Math.round(Math.min(cfg.D02.maxTaskSpeed, lv * cfg.D02.taskSpeedPerStreak) * 100);
    lines.push(
      <div key="s" className="sm">
        {lv ? `連續備料 ×${lv}：−${cut} 刀、快 ${sp}%（${Math.ceil((self.streak!.until - now) / 1000)}s）` : '連續備料 ×0'}
      </div>,
    );
  }
  if (self.flaw === 'D03') {
    for (const w of (self.thermal ?? []).slice(-2)) lines.push(<div key={w.id} className="sm warnline">🌡 {w.text}</div>);
  }
  if (self.flaw === 'D04') {
    const m = flawSpeedMultiplier('D04', currentZone(), k.players[role]?.held?.kind === 'plate', cfg);
    if (m > 1) lines.push(<div key="v" className="sm">移動 ×{m}</div>);
  }
  if (self.flaw === 'D15') {
    const mem = Object.entries(self.memory ?? {}).filter(([, until]) => until > now);
    const byId = new Map(k.orders.map((o) => [o.id, o]));
    lines.push(<div key="m" className="sm">記得 {mem.length} 張單{self.focus ? '・★ 專注中（動作加速）' : ''}</div>);
    for (const [id, until] of mem.slice(0, 2)) {
      const o = byId.get(id);
      if (o) lines.push(<div key={id} className="xs">#{o.table} {orderDish(o)}<span className="dim">　{self.focus === id ? '專注' : `${Math.ceil((until - now) / 1000)}s`}</span></div>);
    }
  }
  lines.push(...flawLines(self, k, role, cfg, now));
  for (const rep of self.reports.slice(-1)) {
    lines.push(
      <div key={rep.id} className={`xs report ${rep.stale ? 'stale' : ''}`}>
        {nameOf(rep.by)}試吃{rep.target}：{rep.words.length ? rep.words.join('、') : '幾乎沒有味道'}{rep.stale ? '（之後又調過味，已過期）' : ''}
      </div>,
    );
  }
  return (
    <div className="flaw-status plate" aria-live="polite">
      <div className="row" style={{ gap: 6 }}>
        <FlawBadge flaw={self.flaw} />
        {lines[0]}
      </div>
      {lines.slice(1, 4)}
    </div>
  );
}

/** 被拍肩：畫面邊緣亮起，箭頭指向拍你的人（形狀＋位置＋文字，不只靠顏色） */
function TapCue({ role }: { role: Seat }): JSX.Element | null {
  useTick(100);
  const tapped = useStore((s) => s.kitchen?.self?.tapped ?? null);
  const nameOf = useSeatName();
  void role;
  if (!tapped) return null;
  const ang = Math.atan2(-(tapped.x - pose.x), -(tapped.z - pose.z)) - pose.yaw;
  const deg = Math.round(((-ang * 180) / Math.PI) % 360);
  return (
    <div className="tap-cue" role="alert">
      <div className="tap-arrow" style={{ transform: `rotate(${deg}deg)` }}>
        ▲
      </div>
      <div className="plate sm">
        {nameOf(tapped.from)}拍了你的肩膀{tapped.token ? `：${TOKEN_LABEL[tapped.token]}` : ''}
      </div>
    </div>
  );
}

/** 被關在鐵籠裡：隊友能來救就提示等人或自己掙脫（慢）；沒人能救（單人、其他人也被抓）就直接提示自己掙脫 */
function CagePrompt({ k, role }: { k: KitchenPublic; role: Seat }): JSX.Element {
  const struggling = k.players[role]?.task?.kind === 'struggle';
  const helpers = (useStore.getState().room?.players ?? []).filter((p) => p.role && p.role !== role && p.connected && k.players[p.role]?.status !== 'trapped').length;
  if (struggling) {
    return (
      <div className="prompt plate cage-prompt">
        <span>正在搖晃鐵籠的門……很吵，怪物可能會聽到。{helpers ? '隊友來撬開會更快。' : ''}</span>
      </div>
    );
  }
  return (
    <div className="prompt plate cage-prompt" role="alert">
      <span>{helpers ? '你被關在鐵籠裡。等隊友來撬開（2.5 秒），或' : '你被關在鐵籠裡，沒有人能來救你。'}</span>
      <kbd>{keyLabel('interact')}</kbd>
      <span>{helpers ? '自己掙脫（18 秒，很吵）' : '自己掙脫（7 秒，很吵）'}</span>
    </div>
  );
}

/** 開班前：等隊友讀完操作說明（時鐘還沒走）；房主可以決定不等 */
function WaitingBanner(): JSX.Element | null {
  const waiting = useStore((s) => s.room?.waiting ?? null);
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me);
  const briefed = useStore((s) => s.briefed);
  if (!waiting) return null;
  const names = (ids: string[]) => ids.map((id) => room?.players.find((p) => p.id === id)?.name ?? '').filter(Boolean);
  const notYet = names(waiting.need.filter((id) => !waiting.ready.includes(id)));
  const mineReady = !!me && waiting.ready.includes(me.id);
  const away = (room?.players ?? []).filter((p) => p.role && !p.connected).map((p) => p.name);
  const title = waiting.why === 'paused' ? '房主暫停了班次' : waiting.why === 'restored' ? '從存檔讀回來的班次' : '時鐘還沒開始';
  const tail = waiting.why === 'start' ? '現在可以先走動熟悉操作。' : `時鐘停著；大家按「準備好了」就繼續。${away.length ? `還沒回來：${away.join('、')}（用同樣的暱稱加入就會回到原本的位置）` : ''}`;
  return (
    <div className="waiting-banner plate" role="status">
      <b>{title}</b>
      <span className="sm">
        {waiting.ready.length}／{waiting.need.length} 人準備好了{notYet.length ? `・還沒準備好：${notYet.join('、')}` : ''}。{tail}
      </span>
      {briefed && !mineReady && (
        <button className="btn small primary" onClick={() => void readyUp()}>
          我準備好了
        </button>
      )}
      {me?.isHost && notYet.length > 0 && (
        <button className="btn small" onClick={() => void forceStart()}>
          {waiting.why === 'start' ? '不等了，開始計時' : '不等了，繼續'}
        </button>
      )}
    </div>
  );
}

/**
 * 後門的東西與門禁的狀態（所有人都看得到，規則要讀得懂）：
 * 牠在後門外刮門（幾秒後進來）、還會待幾秒、正在離開、在防火門外撞門；防火門、後門鎖著還剩幾秒。
 */
function ThreatStatus(): JSX.Element | null {
  useTick(250);
  const today = useEndlessToday();
  const k = useStore.getState().kitchen;
  if (!k) return null;
  const m = k.threats.monster;
  const lines: Array<{ key: string; text: string; tone: string }> = [];
  if (m && m.mode === 'lurk') {
    const w = Math.max(0, Math.ceil((m.warnLeft ?? 0) / 1000));
    const locked = k.backDoor && k.t < k.backDoor.closedUntil;
    lines.push({ key: 'm', text: locked ? '後門鎖住了：牠進不來' : `後門外有東西在刮門！${w} 秒後進來——${today?.backLockBroken ? '後門鎖壞了：關防火門或躲起來' : '去監視器鎖後門'}`, tone: locked ? 'calm' : 'danger' });
  } else if (m?.present) {
    const left = m.kitchenLeft !== null ? Math.ceil(m.kitchenLeft / 1000) : null;
    if (m.mode === 'leave') lines.push({ key: 'm', text: '後門的東西正在離開', tone: 'calm' });
    else if (m.mode === 'bang') lines.push({ key: 'm', text: '牠在防火門外撞門：撞完就會放棄', tone: 'warn' });
    else lines.push({ key: 'm', text: `後門的東西在追最近的人：再 ${left ?? 60} 秒離開`, tone: (left ?? 60) <= 5 ? 'calm' : 'danger' });
  }
  if (!k.doors.fire) lines.push({ key: 'f', text: `防火門關著：${Math.max(0, Math.ceil((k.fireDoor.closedUntil - k.t) / 1000))} 秒`, tone: 'info' });
  if (k.backDoor && k.t < k.backDoor.closedUntil) lines.push({ key: 'b', text: `後門鎖著：${Math.ceil((k.backDoor.closedUntil - k.t) / 1000)} 秒`, tone: 'info' });
  if (!lines.length) return null;
  return (
    <div className="threat-status" aria-live="polite">
      {lines.map((l) => (
        <div key={l.key} className={`plate threat-line ${l.tone}`}>
          {l.text}
        </div>
      ))}
    </div>
  );
}

/** 看著冷藏架／乾貨架：目前分類裡數字鍵對應的食材 */
function QuickTake({ kind }: { kind: 'fridge' | 'pantry' | string }): JSX.Element {
  useStorageTab();
  const storage = kind === 'fridge' ? 'FRIDGE' : 'PANTRY';
  const ids = storageIds(kind as 'fridge').slice(0, 9);
  return (
    <>
      數字鍵直接拿・<b>{tabLabel(currentTab(storage))}</b>：
      {ids.map((id, i) => (
        <span key={id} className="qt-item">
          <kbd>{i + 1}</kbd>
          {INGREDIENTS[id].label}
        </span>
      ))}
      ・<kbd>0</kbd> 換分類・<kbd>Shift</kbd>＋數字 拿滿
    </>
  );
}
