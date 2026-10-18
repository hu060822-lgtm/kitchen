import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BASKET_SLOTS,
  CARRY_MAX,
  isTwoHanded,
  RACK_CAPACITY,
  CUT_LABEL,
  CUT_STROKES,
  HEAT_LABEL,
  HEAT_LEVELS,
  INGREDIENTS,
  INGREDIENT_IDS,
  MEASURE_STEPS,
  NOTE_LABELS,
  NOTE_TEXT,
  SEASONINGS,
  SEASONING_IDS,
  STATION_BY_ID,
  TASK_TEXT,
  ZONES,
  ZONE_BY_ID,
  lookOfVessel,
  soundOfVessel,
  type Cut,
  type HeatLevel,
  type IngredientId,
  type ItemPublic,
  type KitchenPublic,
  type Seat,
  type SeasoningId,
  type FlawId,
  type StationDef,
  type StationPublic,
  isRawProtein,
  OVEN_TARGET,
  MIX_LABEL,
  mixKindOf,
  COOK_STYLE_LABEL,
  DISH_KIND_LABEL,
  GRADE_LABEL,
  QUALITY_LABEL,
  SAUCE_LABEL,
  gradeOf,
  type DishAnalysis,
  type QualityDim,
} from '@last-table/shared';
import { audio } from '../audio/engine';
import { speak } from '../audio/speech';
import { closeStation } from '../game/loop';
import { isAction } from '../game/keymap';
import { currentTab, nextTab, setTab, storageTabs, tabIds, tabLabel, useStorageTab } from '../game/storageTabs';
import { act, coop } from '../net/socket';
import { useStore } from '../state/store';
import { useSeatName } from './flawUi';
import { Icon } from './icons';
import { bothFree, fmtSec, handsFull, handsText, heldText, holding, oneHanded, itemLine, itemSenses, itemState, orderDish, orderNeed, plateLine, seasoningText } from './kitchenText';

/**
 * 工作站面板：每一種工作站的操作。所有規則都在伺服器；這裡只送出操作、顯示伺服器給的狀態。
 * 開啟語音播報（無障礙選項）時，用 Tab 在按鈕之間移動，焦點移到哪裡就念出哪裡。
 */

type Run = (action: string, args?: Record<string, unknown>) => void;

function useBlind(): boolean {
  return useStore((s) => s.prefs.speech);
}

function Btn({ children, label, onClick, disabled, kind = '', title }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; kind?: string; title?: string }): JSX.Element {
  const blind = useBlind();
  return (
    <button
      className={`btn ${kind}`}
      disabled={disabled}
      aria-label={label}
      title={title}
      onClick={onClick}
      onFocus={() => blind && speak(disabled ? `${label}，目前不能用` : label, { interrupt: true })}
    >
      {children}
    </button>
  );
}

/** 可以聚焦的描述行（看不見的人用 Tab 停在上面時念出來） */
function Say({ text, className = '' }: { text: string; className?: string }): JSX.Element {
  const blind = useBlind();
  return (
    <p className={`say ${className}`} tabIndex={blind ? 0 : -1} onFocus={() => blind && speak(text, { interrupt: true })}>
      {text}
    </p>
  );
}

function ItemCard({ it, role, vessel, actions }: { it: ItemPublic; role: Seat; vessel: { temp: number; liquid: boolean } | null; actions?: React.ReactNode }): JSX.Element {
  const lines = itemSenses(it, role, vessel);
  return (
    <div className="item-card">
      <div className="item-head">
        <b>{itemLine(it, role)}</b>
        <span className="xs dim">{itemState(it, role)}</span>
      </div>
      {lines.map((l) => (
        <Say key={l} text={l} className="sm" />
      ))}
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

/** 我的缺陷卡（伺服器給的個人狀態） */
const flawOf = (k: KitchenPublic): FlawId | null => k.self?.flaw ?? null;
/** 隊伍裡有沒有某張卡（不含自己） */
const teamHas = (k: KitchenPublic, role: Seat, f: FlawId): Seat[] =>
  (Object.entries(k.coop.flaws) as Array<[Seat, FlawId]>).filter(([s, x]) => x === f && s !== role).map(([s]) => s);

/** 單手廚師的雙手工序：扶穩（隊友）或夾具（自己）的狀態與按鈕 */
function TwoHands({ def, k, role, what }: { def: StationDef; k: KitchenPublic; role: Seat; what: string }): JSX.Element | null {
  const nameOf = useSeatName();
  const mine = flawOf(k) === 'D09';
  const helpers = teamHas(k, role, 'D09');
  const steady = k.coop.steadies.find((x) => x.stationId === def.id);
  if (!mine && !helpers.length) return null;
  if (mine) {
    const clamp = (k.self?.clamps ?? {})[def.id] ?? 0;
    return (
      <div className="ctrl">
        <div className="lbl">雙手工序（{what}）</div>
        <Say className="sm" text={clamp > k.t ? `夾具固定中：還有 ${Math.ceil((clamp - k.t) / 1000)} 秒。` : steady ? `${nameOf(steady.by)}正在幫你扶穩（${Math.ceil((steady.until - k.t) / 1000)} 秒）。` : `${what}需要雙手：請隊友站在旁邊按「幫忙扶穩」，或自己先固定。`} />
        <div className="row">
          <Btn label="用夾具固定，四秒" disabled={clamp > k.t} onClick={() => void act(def.id, 'clamp')}>用夾具固定（4 秒）</Btn>
        </div>
      </div>
    );
  }
  const mineSteady = steady?.by === role;
  return (
    <div className="actions">
      <Btn label={`幫${helpers.map(nameOf).join('、')}扶穩`} kind={mineSteady ? 'primary' : ''} onClick={() => void coop('steady', { stationId: def.id })}>
        {mineSteady ? `扶著（${Math.ceil((steady!.until - k.t) / 1000)} 秒）・放手` : `幫忙扶穩（給${helpers.map(nameOf).join('、')}${what}）`}
      </Btn>
    </div>
  );
}

/* ------------------------------ 冷藏架／乾貨架 ------------------------------ */

/** 還沒處理過的原料（可以一起帶、放回架上） */
const untouched = (it: ItemPublic | undefined | null): boolean => !!it && it.cut === 'WHOLE' && !it.washed && !it.peeled && it.doneness <= 0.05 && !it.methods.length && !it.floorDirty;

function Storage({ def, s, k, role, run }: Ctx): JSX.Element {
  const storage = def.kind === 'fridge' ? 'FRIDGE' : 'PANTRY';
  const me = k.players[role];
  const held = me?.held ?? null;
  const basket = me?.basket ?? [];
  useStorageTab();
  const tabs = storageTabs(storage);
  const tab = currentTab(storage);
  const ids = tabIds(storage, tab);
  const heldItem = held?.kind === 'item' ? k.items[held.id] : null;
  const other = me?.other ?? null;
  const carried = (held ? 1 : 0) + (other ? 1 : 0) + basket.length;
  // 還放得下幾份：空著的手＋菜籃的空格（拿著要用雙手的東西就不行）
  const twoHandBusy = isTwoHanded(held) || isTwoHanded(other);
  const room = twoHandBusy ? 0 : (held ? 0 : 1) + (!oneHanded(k) && !other ? 1 : 0) + Math.max(0, BASKET_SLOTS - basket.length);
  const canTake = room > 0;
  const [qty, setQty] = useState(1);
  const take = useCallback(
    (id: IngredientId, n: number) => {
      if ((s.stock?.[id] ?? 0) <= 0 || !canTake) return;
      run('take', { type: id, count: n });
    },
    [s.stock, canTake, run],
  );
  // 數字鍵 1–9：拿目前分頁的第幾種（數量照上面選的；Shift＋數字＝拿到滿）；0：下一個分頁
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Digit0' && !e.repeat) {
        e.preventDefault();
        nextTab(storage);
        return;
      }
      const m = /^Digit([1-9])$/.exec(e.code);
      if (!m || e.repeat) return;
      const id = ids[Number(m[1]) - 1];
      if (!id) return;
      e.preventDefault();
      take(id, e.shiftKey ? CARRY_MAX : qty);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ids, qty, take, storage]);
  const storable = [...(heldItem ? [heldItem] : []), ...(other?.kind === 'item' ? [k.items[other.id]] : []), ...basket.map((id) => k.items[id])].filter((it) => untouched(it) && INGREDIENTS[it!.type].storage === storage);
  return (
    <>
      <div className="row qty-row">
        <span className="xs dim">一次拿</span>
        {[1, 2, 3, 4].map((n) => (
          <Btn key={n} kind={`small ${qty === n ? 'primary' : ''}`} label={`一次拿 ${n} 份`} onClick={() => setQty(n)}>
            ×{n}
          </Btn>
        ))}
        <span className="xs dim">帶著 {carried}／{oneHanded(k) ? CARRY_MAX - 1 : CARRY_MAX}（{oneHanded(k) ? '一隻手' : '兩隻手'}＋菜籃 {BASKET_SLOTS} 格）・數字鍵直接拿，Shift＋數字拿到滿</span>
      </div>
      <div className="row storage-tabs" role="tablist" aria-label="食材分類">
        {tabs.map((c, i) => {
          const left = tabIds(storage, c).reduce((a, id) => a + (s.stock?.[id] ?? 0), 0);
          return (
            <Btn key={c} kind={`small tab ${c === tab ? 'primary' : ''}`} label={`${tabLabel(c)}分類，${left} 份${c === tab ? '，目前' : ''}`} onClick={() => setTab(storage, c)}>
              {tabLabel(c)} <span className="xs dim">{left}</span>
            </Btn>
          );
        })}
        <span className="xs dim">
          <kbd className="hot-key">0</kbd> 換分類
        </span>
      </div>
      <div className="stock">
        {ids.map((id: IngredientId, i) => {
          const n = s.stock?.[id] ?? 0;
          return (
            <Btn key={id} kind="stock-btn" title={INGREDIENTS[id].note} label={`拿${INGREDIENTS[id].label}，剩 ${n} ${INGREDIENTS[id].unit}${i < 9 ? `，快捷鍵 ${i + 1}` : ''}`} disabled={n <= 0 || !canTake} onClick={() => take(id, qty)}>
              {i < 9 && <kbd className="hot-key">{i + 1}</kbd>}
              <span>{INGREDIENTS[id].label}</span>
              <span className="code xs">{n}</span>
            </Btn>
          );
        })}
      </div>
      <div className="lbl high-lbl">
        最上層{flawOf(k) === 'D07' ? '（伸手就拿）' : flawOf(k) === 'D08' ? '（你搆不到：請隊友幫忙）' : '（踩踏凳 1.5 秒）'}
      </div>
      <div className="stock high">
        {ids.map((id: IngredientId) => {
          const n = s.high?.[id] ?? 0;
          return (
            <Btn key={id} kind="stock-btn" label={`從最上層拿${INGREDIENTS[id].label}，剩 ${n}`} disabled={n <= 0 || handsFull(k, role) || flawOf(k) === 'D08'} onClick={() => run('take_high', { type: id })}>
              <span>{INGREDIENTS[id].label}</span>
              <span className="code xs">{n}</span>
            </Btn>
          );
        })}
      </div>
      <div className="actions">
        {held?.kind === 'crate' && held.storage === storage && (
          <Btn kind="primary" label="把整箱貨補上架" onClick={() => run('restock')}>補貨</Btn>
        )}
        {heldItem && INGREDIENTS[heldItem.type].storage === storage && (
          <Btn label={`把${INGREDIENTS[heldItem.type].label}放回去`} onClick={() => run('store')}>放回架上</Btn>
        )}
        {storable.length > 1 && (
          <Btn label={`把手上和菜籃裡的 ${storable.length} 份原料全部放回去`} onClick={() => run('store_all')}>全部放回（{storable.length}）</Btn>
        )}
      </div>
      {storage === 'FRIDGE' && <p className="legend">離開冷藏後，食材會慢慢不新鮮。過期的食材會讓整道菜的分數上限降到 30。</p>}
    </>
  );
}

/* ------------------------------ 清洗區 ------------------------------ */

function Sink({ s, k, role, run }: Ctx): JSX.Element {
  const items = s.items.map((id) => k.items[id]).filter(Boolean);
  const soakable = items.find((it) => INGREDIENTS[it.type].soakable);
  const full = items.length >= 2;
  return (
    <>
      {items.length === 0 && <Say text="水槽是空的（可以放兩樣）。" className="dim" />}
      {items.map((it) => (
        <ItemCard
          key={it.id}
          it={it}
          role={role}
          vessel={null}
          actions={
            <>
              {INGREDIENTS[it.type].needsWash && (
                <Btn kind="small primary" label={`清洗${INGREDIENTS[it.type].label}，兩秒`} disabled={it.washed && !it.floorDirty} onClick={() => run('wash', { itemId: it.id })}>
                  清洗（2 秒）
                </Btn>
              )}
              <Btn kind="small" label={`拿起${INGREDIENTS[it.type].label}`} disabled={handsFull(k, role)} onClick={() => run('pick', { itemId: it.id })}>拿起來</Btn>
            </>
          }
        />
      ))}
      <div className="actions">
        <Btn label="把手上的食材放進水槽" disabled={!holding(k, role, 'item') || full} onClick={() => run('place')}>放進水槽（{items.length}／2）</Btn>
        <Btn label="接一杯水" disabled={handsFull(k, role)} onClick={() => run('water')}>接一杯水</Btn>
        {soakable && (
          <Btn kind={s.soak ? '' : 'primary'} label={s.soak ? '正在泡水' : `放水泡${INGREDIENTS[soakable.type].label}`} disabled={!!s.soak} onClick={() => run('soak')}>
            {s.soak ? '泡水中' : `放水泡${INGREDIENTS[soakable.type].label}`}
          </Btn>
        )}
      </div>
      {soakable && <p className="legend">米粉泡大約 20 秒會軟，才適合下平底鍋炒；泡太久會爛。直接丟進湯鍋煮也可以。</p>}
      <div className="ctrl">
        <div className="lbl">碗盤架</div>
        <Say className="sm" text={`等著洗的髒盤：盤子 ${s.dirty?.plate ?? 0}、碗 ${s.dirty?.bowl ?? 0}。洗好會自動放回裝盤區。`} />
        <div className="row">
          <Btn label="把手上的髒盤放上碗盤架" disabled={!holding(k, role, 'dirty')} onClick={() => run('load')}>放上碗盤架</Btn>
          <Btn kind="primary" label="洗碗" disabled={!((s.dirty?.plate ?? 0) + (s.dirty?.bowl ?? 0))} onClick={() => run('wash_dishes')}>
            洗碗{flawOf(k) === 'D11' ? '（你洗得快一倍）' : ''}
          </Btn>
        </div>
      </div>
      {flawOf(k) === 'D14' && (
        <div className="actions">
          <Btn label="洗把臉" disabled={(k.self?.cooldowns.splash ?? 0) > k.t} onClick={() => run('splash')}>
            洗把臉（睡意 −40）{(k.self?.cooldowns.splash ?? 0) > k.t ? `・${Math.ceil(((k.self?.cooldowns.splash ?? 0) - k.t) / 1000)} 秒` : ''}
          </Btn>
        </div>
      )}
    </>
  );
}

/* ------------------------------ 備料台：刀工節奏 ------------------------------ */

const BEAT_MS = 420;

/**
 * 切菜：照著節奏下刀（空白鍵或按鈕）。分數只看下刀間隔的穩定度——練習就會進步，沒有隨機。
 * 引導節拍：看得見的人看閃動的刻度，聽得見的人聽滴答聲。不一定要跟著它，只要自己的節奏穩定。
 */
function ChopRhythm({ cut, need, label, onDone, onCancel }: { cut: Cut; need: number; label: string; onDone: (presses: number[]) => void; onCancel: () => void }): JSX.Element {
  const [presses, setPresses] = useState<number[]>([]);
  const [beat, setBeat] = useState(0);
  const sent = useRef(false);
  const start = useRef(performance.now());

  useEffect(() => {
    const t = window.setInterval(() => {
      setBeat((b) => b + 1);
      audio.tone(1500, 0.03, { type: 'square', gain: 0.05, filter: 3000 });
    }, BEAT_MS);
    return () => clearInterval(t);
  }, []);

  const press = useCallback(() => {
    setPresses((p) => {
      if (p.length >= need) return p;
      const next = [...p, Math.round(performance.now() - start.current)];
      audio.noise(0.04, { freq: 2600, q: 1.4, gain: 0.25 });
      audio.tone(180, 0.05, { type: 'sine', gain: 0.18 });
      return next;
    });
  }, [need]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isAction(e.code, 'chop')) {
        e.preventDefault();
        if (!e.repeat) press();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  useEffect(() => {
    if (presses.length >= need && !sent.current) {
      sent.current = true;
      onDone(presses);
    }
  }, [presses, need, onDone]);

  // 即時顯示間隔的穩定度（讓玩家知道自己哪一刀亂了）
  const iv = presses.slice(1).map((t, i) => t - presses[i]);
  const mean = iv.length ? iv.reduce((a, b) => a + b, 0) / iv.length : 0;

  return (
    <div className="chop">
      <div className="chop-head">
        <b>{label}：{CUT_LABEL[cut]}</b>
        <span className="code">{presses.length}／{need}</span>
      </div>
      <div className="beat" aria-hidden>
        {Array.from({ length: 8 }, (_, i) => (
          <i key={i} className={i === beat % 8 ? 'on' : ''} />
        ))}
      </div>
      <div className="strokes" aria-hidden>
        {iv.map((d, i) => {
          const dev = mean ? Math.min(1, Math.abs(d - mean) / mean / 0.35) : 0;
          return <i key={i} style={{ height: `${Math.max(12, Math.min(100, (d / (BEAT_MS * 2)) * 100))}%`, opacity: 1 - dev * 0.6 }} className={d < 110 ? 'rush' : dev > 0.6 ? 'off' : ''} />;
        })}
      </div>
      <div className="actions">
        <Btn kind="primary chop-key" label={`下刀，空白鍵。還差 ${need - presses.length} 刀`} onClick={press} disabled={presses.length >= need}>
          下刀 <kbd>空白鍵</kbd>
        </Btn>
        <Btn label="放棄這次切法" onClick={onCancel}>放棄</Btn>
      </div>
      <p className="legend">節奏越穩定，刀工越好；太急（間隔不到 0.11 秒）的刀算失手。</p>
    </div>
  );
}

function Prep({ def, s, k, role, run }: Ctx): JSX.Element {
  const it = s.items[0] ? k.items[s.items[0]] : null;
  const held = k.players[role]?.held;
  const [chopping, setChopping] = useState<{ cut: Cut; need: number } | null>(null);
  const blind = useBlind();
  useEffect(() => {
    if (!it) setChopping(null);
  }, [it]);

  const startCut = async (cut: Cut): Promise<void> => {
    const r = await act(def.id, 'chop_start', { cut });
    if (r?.ok) {
      // 要下幾刀以伺服器為準（缺陷卡可能讓它變少）
      const need = r.need ?? CUT_STROKES[cut];
      setChopping({ cut, need });
      if (blind) speak(`開始${CUT_LABEL[cut]}，照著滴答聲按空白鍵 ${need} 次`, { interrupt: true });
    }
  };

  if (it && chopping) {
    return (
      <ChopRhythm
        cut={chopping.cut}
        need={chopping.need}
        label={INGREDIENTS[it.type].label}
        onCancel={() => setChopping(null)}
        onDone={(presses) => {
          setChopping(null);
          run('chop', { presses });
        }}
      />
    );
  }
  const def2 = it ? INGREDIENTS[it.type] : null;
  return (
    <>
      {s.contaminated && <Say text={flawOf(k) === 'D11' ? '砧板碰過生肉，還沒擦——你不在上面做事。先擦乾淨（你擦只要一秒）。' : '砧板碰過生肉，還沒擦。接下來切的生菜會被汙染。'} className="warnline" />}
      {it ? <ItemCard it={it} role={role} vessel={null} /> : <Say text="砧板是空的。" className="dim" />}
      {it && def2 && it.cut === 'WHOLE' && (
        <div className="ctrl">
          <div className="lbl">切法</div>
          <div className="row">
            {def2.cuts
              .filter((c) => c !== 'WHOLE')
              .map((c) => (
                <Btn key={c} label={`${CUT_LABEL[c]}，${CUT_STROKES[c]} 刀${c === 'BEATEN' && flawOf(k) === 'D09' ? '，雙手' : ''}`} disabled={def2.needsPeel && !it.peeled} onClick={() => void startCut(c)}>
                  {CUT_LABEL[c]} <span className="xs dim">{CUT_STROKES[c]} 刀{c === 'BEATEN' && flawOf(k) === 'D09' ? '・雙手' : ''}</span>
                </Btn>
              ))}
            {def2.cuts.length <= 1 && <span className="sm dim">{def2.label}不用切。</span>}
          </div>
        </div>
      )}
      <div className="actions">
        <Btn label="把手上的食材放到砧板" disabled={!holding(k, role, 'item') || !!it} onClick={() => run('place')}>放上砧板</Btn>
        {def2?.needsPeel && !it?.peeled && <Btn label="削皮，兩秒半" onClick={() => run('peel')}>削皮／剝皮（2.5 秒）</Btn>}
        <Btn label="拿起來" disabled={!it || handsFull(k, role)} onClick={() => run('pick')}>拿起來</Btn>
        <Btn label="擦砧板，兩秒" onClick={() => run('wipe')}>擦砧板（{flawOf(k) === 'D11' ? '1' : flawOf(k) === 'D09' ? '1.4' : '2'} 秒）</Btn>
      </div>
      {it?.type === 'egg' && <TwoHands def={def} k={k} role={role} what="打蛋" />}
    </>
  );
}

/* ------------------------------ 爐台 ------------------------------ */

function Heat({ def, s, k, role, run }: Ctx): JSX.Element {
  const isPot = def.kind === 'stove';
  const held = k.players[role]?.held;
  const liquid = (s.liquid ?? 0) > 0;
  const v = s.vessel ?? 22;
  const items = s.items.map((id) => k.items[id]).filter(Boolean);
  const vesselLines: string[] = [`${isPot ? '湯鍋' : '鍋面'}：${lookOfVessel(v, liquid)}`, `聽起來：${soundOfVessel(v, liquid)}`];
  if (isPot && (s.scorch ?? 0) > 0.2) vesselLines.push('鍋底開始黏、冒出焦色');
  // 味覺失調者：伺服器依真實狀態推算的預警（只有本人收到）
  const thermal = (k.self?.thermal ?? []).filter((w) => w.stationId === def.id && k.t - w.at < 9000);
  const hand = { temp: v, liquid };
  const fire = <FireLock def={def} k={k} />;
  if (s.hidden) {
    return (
      <>
        {fire}
        <Say text="湯鍋太高了，你看不到裡面（只聽得到聲音）。墊腳看一下，或請隊友試吃後回報給你。" className="warnline" />
        <Say text={`聽起來：${soundOfVessel(v, liquid)}`} />
        <div className="actions">
          <Btn kind="primary" label="墊腳看一下，一秒" onClick={() => run('peek')}>墊腳看一下（1 秒，之後 12 秒看得到）</Btn>
          <Btn label="倒入量好的調味料" disabled={!holding(k, role, 'measure')} onClick={() => run('pour')}>加調味</Btn>
          <Btn label="攪拌" onClick={() => run('stir')}>攪拌</Btn>
        </div>
        <Reports k={k} target={def.label} />
      </>
    );
  }
  const d10 = flawOf(k) === 'D10' && (k.self?.gloveUntil ?? 0) <= k.t;
  return (
    <>
      {fire}
      <Takeover def={def} k={k} role={role} />
      <div className="ctrl">
        <div className="lbl">火力</div>
        <div className="knob" role="radiogroup" aria-label="火力">
          {HEAT_LEVELS.map((h: HeatLevel) => (
            <Btn key={h} kind={s.heat === h ? 'primary' : ''} disabled={d10 || (flawOf(k) === 'D10' && h === 'HIGH')} label={`${HEAT_LABEL[h]}${s.heat === h ? '，目前' : ''}`} onClick={() => run('heat', { level: h })}>
              {HEAT_LABEL[h]}
            </Btn>
          ))}
        </div>
        <p className="legend">鍋子有熱慣性：轉小火之後還會熱一陣子，關火後的餘溫也會繼續煮。</p>
      </div>
      {thermal.map((w) => (
        <Say key={w.id} text={`🌡 預警：${w.text}`} className="warnline" />
      ))}
      {vesselLines.map((l) => (
        <Say key={l} text={l} />
      ))}
      <Reports k={k} target={def.label} />
      {isPot && liquid && <Say text={`湯量：${s.liquid} 杯${seasoningText(s.seasoning ?? {}) ? `；已加 ${seasoningText(s.seasoning ?? {})}` : ''}`} className="sm" />}
      {isPot && items.length > 0 && !liquid && <Say text={`上次攪拌：${s.sinceStir ?? 0} 秒前（乾炒時超過 6 秒會開始黏鍋）`} className="sm" />}
      {items.length === 0 && <Say text="鍋裡沒有東西。" className="dim" />}
      {items.map((it) => (
        <ItemCard
          key={it.id}
          it={it}
          role={role}
          vessel={hand}
          actions={
            !isPot ? (
              <>
                <Btn kind="small" label={`翻面：${INGREDIENTS[it.type].label}`} onClick={() => run('flip', { itemId: it.id })}>翻面</Btn>
                <Btn kind="small" label={`拿起：${INGREDIENTS[it.type].label}`} disabled={handsFull(k, role)} onClick={() => run('pick', { itemId: it.id })}>拿起</Btn>
              </>
            ) : !INGREDIENTS[it.type].liquid ? (
              <Btn kind="small" label={`撈起來：${INGREDIENTS[it.type].label}`} disabled={handsFull(k, role)} onClick={() => run('pick', { itemId: it.id })}>撈起來</Btn>
            ) : undefined
          }
        />
      ))}
      <div className="actions">
        <Btn label={`把手上的東西放進${isPot ? '湯鍋' : '平底鍋'}`} disabled={!holding(k, role, 'item')} onClick={() => run('place')}>下鍋</Btn>
        {isPot ? <Btn kind="primary" label="攪拌" disabled={!items.length} onClick={() => run('stir')}>攪拌</Btn> : <Btn label="全部翻面" disabled={!items.length} onClick={() => run('flip')}>全部翻面</Btn>}
        <Btn label="倒入量好的調味料" disabled={!holding(k, role, 'measure')} onClick={() => run('pour')}>加調味</Btn>
        {isPot && <Btn label={`拿著碗盛起來${flawOf(k) === 'D09' ? '，雙手' : ''}`} disabled={!holding(k, role, 'plate') || !items.length} onClick={() => run('ladle')}>盛起來{flawOf(k) === 'D09' ? '・雙手' : ''}</Btn>}
        {isPot && <Btn label="試吃湯鍋" disabled={!items.length} onClick={() => run('taste')}>試吃</Btn>}
        <Btn label="溫度計，一秒" disabled={!items.length} onClick={() => run('probe')}>
          <Icon name="probe" size={16} /> 溫度計
        </Btn>
      </div>
      {isPot && <TwoHands def={def} k={k} role={role} what="盛湯" />}
    </>
  );
}

/** 怕火廚師：火源的限制與隔熱手套 */
function FireLock({ def, k }: { def: StationDef; k: KitchenPublic }): JSX.Element | null {
  if (flawOf(k) !== 'D10') return null;
  const g = (k.self?.gloveUntil ?? 0) - k.t;
  return (
    <div className="ctrl fire-lock">
      <Say className={g > 0 ? 'sm' : 'warnline'} text={g > 0 ? `🧤 隔熱手套：還有 ${Math.ceil(g / 1000)} 秒（最多中火）。` : `你怕火，不能直接操作${def.label}。把料放到「爐台旁交接架」讓隊友接手，或戴上隔熱手套。`} />
      <div className="row">
        <Btn label="戴隔熱手套，三秒" disabled={g > 5000} onClick={() => void act(def.id, 'glove')}>戴隔熱手套（3 秒，之後 30 秒）</Btn>
      </div>
    </div>
  );
}

/** 嗜睡學徒的爐具：別人可以接管；他自己看得到是不是在雙爐清單裡 */
function Takeover({ def, k, role }: { def: StationDef; k: KitchenPublic; role: Seat }): JSX.Element | null {
  const nameOf = useSeatName();
  const link = k.coop.links.find((l) => l.stationId === def.id && l.seat !== role);
  const mineLinked = (k.self?.links ?? []).includes(def.id);
  if (flawOf(k) === 'D14') {
    const taken = k.coop.links.find((l) => l.stationId === def.id && l.seat === role)?.takenBy;
    return <Say className="sm" text={taken ? `${nameOf(taken)}接管了這個爐子；你親自操作就會拿回來。` : mineLinked ? '這個爐子在你的雙爐清單裡（V 打開雙爐面板）。' : '操作它就會加入雙爐（最多兩個）。'} />;
  }
  if (!link) return null;
  const mine = link.takenBy === role;
  const asleep = k.coop.drowsy.some((d) => d.seat === link.seat && d.state === 'asleep');
  return (
    <div className="actions">
      <Say className="sm" text={`${nameOf(link.seat)}正在遠端照看這個爐子${asleep ? '（他睡著了！）' : ''}。`} />
      <Btn kind={asleep && !mine ? 'primary' : ''} label={mine ? '交還' : '接管'} onClick={() => void coop('takeover', { stationId: def.id })}>
        {mine ? '交還給他' : '接管這個爐子'}
      </Btn>
    </div>
  );
}

/* ------------------------------ 烤麵包機 ------------------------------ */

function Toaster({ s, k, role, run }: Ctx): JSX.Element {
  const [level, setLevel] = useState(3);
  const held = k.players[role]?.held;
  const items = s.items.map((id) => k.items[id]).filter(Boolean);
  const busy = !!s.toast;
  return (
    <>
      <FireLock def={STATION_BY_ID.toaster} k={k} />
      {items.length === 0 && <Say text="烤麵包機是空的。" className="dim" />}
      {items.map((it) => (
        <ItemCard key={it.id} it={it} role={role} vessel={null} />
      ))}
      {busy && <Say text={`正在烤（${s.toast!.level} 段），${Math.ceil(s.toast!.leftMs / 1000)} 秒後跳起來。`} />}
      <div className="ctrl">
        <div className="lbl">段數</div>
        <div className="row">
          {[1, 2, 3, 4, 5].map((n) => (
            <Btn key={n} kind={n === level ? 'primary' : ''} label={`${n} 段`} disabled={busy} onClick={() => setLevel(n)}>
              {n}
            </Btn>
          ))}
        </div>
      </div>
      <div className="actions">
        <Btn label="把吐司放進去" disabled={!holding(k, role, 'item') || busy} onClick={() => run('place')}>放進去</Btn>
        <Btn kind="primary" label={`按下，${level} 段，八秒`} disabled={busy || !items.length} onClick={() => run('start', { level })}>按下（8 秒）</Btn>
        <Btn label="拿出來" disabled={busy || !items.length || handsFull(k, role)} onClick={() => run('pick')}>拿出來</Btn>
      </div>
    </>
  );
}

/* ------------------------------ 調味區 ------------------------------ */

function Spice({ k, role, run }: Ctx): JSX.Element {
  const held = k.players[role]?.held;
  const [first, setFirst] = useState<{ seasoning: SeasoningId; units: number } | null>(null);
  if (flawOf(k) === 'D10') {
    const pick = (id: SeasoningId, u: number): void => {
      if (!first) setFirst({ seasoning: id, units: u });
      else if (first.seasoning === id) setFirst({ seasoning: id, units: u });
      else {
        run('measure', { seasoning: first.seasoning, units: first.units, seasoning2: id, units2: u });
        setFirst(null);
      }
    };
    return (
      <>
        <p className="legend">冷盤組合：你可以一次量兩種調味料（先點第一種、再點第二種），一次倒完。只要一種就按「只量這一種」。</p>
        {first && (
          <div className="row">
            <Say className="sm" text={`第一種：${SEASONINGS[first.seasoning].label} ${first.units}。再點第二種。`} />
            <Btn kind="primary" label="只量這一種" disabled={handsFull(k, role)} onClick={() => { run('measure', first); setFirst(null); }}>只量這一種</Btn>
            <Btn label="重選" onClick={() => setFirst(null)}>重選</Btn>
          </div>
        )}
        <table className="tbl spice">
          <tbody>
            {SEASONING_IDS.map((id: SeasoningId) => (
              <tr key={id}>
                <th scope="row">{SEASONINGS[id].label}</th>
                {MEASURE_STEPS.map((u) => (
                  <td key={u}>
                    <Btn kind={`small ${first?.seasoning === id && first.units === u ? 'primary' : ''}`} label={`${SEASONINGS[id].label} ${u} 匙`} disabled={handsFull(k, role)} onClick={() => pick(id, u)}>
                      {u}
                    </Btn>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }
  return (
    <>
      <p className="legend">用量匙量好，拿去倒進鍋裡或盤子上。每一匙的份量都是固定的，不會手抖。</p>
      <table className="tbl spice">
        <tbody>
          {SEASONING_IDS.map((id: SeasoningId) => (
            <tr key={id}>
              <th scope="row">{SEASONINGS[id].label}</th>
              {MEASURE_STEPS.map((u) => (
                <td key={u}>
                  <Btn kind="small" label={`${SEASONINGS[id].label} ${u} 匙`} disabled={handsFull(k, role)} onClick={() => run('measure', { seasoning: id, units: u })}>
                    {u}
                  </Btn>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/* ------------------------------ 裝盤區 ------------------------------ */

function Plating({ s, k, role, run }: Ctx): JSX.Element {
  const held = k.players[role]?.held;
  const [sel, setSel] = useState<string | null>(null);
  const plateId = sel && s.plates.includes(sel) ? sel : (s.plates[0] ?? null);
  const dishes = s.dishes ?? { plate: 0, bowl: 0 };
  return (
    <>
      <Say className={dishes.plate + dishes.bowl <= 2 ? 'warnline sm' : 'sm'} text={`架上乾淨的：盤子 ${dishes.plate}、碗 ${dishes.bowl}。${dishes.plate + dishes.bowl <= 2 ? '快沒了——回收窗口的髒盤要拿去水槽洗。' : ''}`} />
      {s.plates.length === 0 && <Say text="裝盤區沒有盤子。" className="dim" />}
      <div className="opts">
        {s.plates.map((id) => {
          const p = k.plates[id];
          if (!p) return null;
          const text = plateLine(p);
          return (
            <label key={id} className={`opt ${id === plateId ? 'sel' : ''}`}>
              <input type="radio" name="plate" checked={id === plateId} onChange={() => setSel(id)} onFocus={() => speak(text, { interrupt: true })} />
              <span>{text}</span>
            </label>
          );
        })}
      </div>
      <div className="actions">
        <Btn label="拿一個新盤子放在檯面上" disabled={s.plates.length >= 3 || dishes.plate <= 0} onClick={() => run('new_plate', { vessel: 'plate' })}>新盤子</Btn>
        <Btn label="拿一個新碗放在檯面上" disabled={s.plates.length >= 3 || dishes.bowl <= 0} onClick={() => run('new_plate', { vessel: 'bowl' })}>新碗</Btn>
        <Btn label="空手拿一個碗去盛湯" disabled={handsFull(k, role) || dishes.bowl <= 0} onClick={() => run('new_plate', { vessel: 'bowl', hold: true })}>拿碗去盛湯</Btn>
      </div>
      <div className="actions">
        <Btn kind="primary" label="把手上的食材裝到選中的盤子" disabled={!holding(k, role, 'item') || !plateId} onClick={() => run('add', { plateId })}>裝盤</Btn>
        <Btn label="把量好的調味料加到盤子上" disabled={!holding(k, role, 'measure') || !plateId} onClick={() => run('pour', { plateId })}>加調味</Btn>
        <Btn label="試吃選中的盤子" disabled={!plateId} onClick={() => run('taste', { plateId })}>試吃</Btn>
        <Btn label="端起選中的盤子" disabled={!plateId || handsFull(k, role)} onClick={() => run('pick', { plateId })}>端起來</Btn>
        <Btn label="把手上的盤子放下" disabled={!holding(k, role, 'plate')} onClick={() => run('place')}>放下盤子</Btn>
      </div>
      <Reports k={k} target="裝盤區" />
    </>
  );
}

/** 收到的試吃回報（對味覺失調者最有用）：回報綁定那一盤／那一鍋，之後再調味就標成過期 */
function Reports({ k, target }: { k: KitchenPublic; target: string }): JSX.Element | null {
  const nameOf = useSeatName();
  const list = (k.self?.reports ?? []).filter((r) => r.target.includes(target));
  if (!list.length) return null;
  return (
    <>
      {list.map((r) => (
        <Say key={r.id} className={`sm report ${r.stale ? 'stale' : ''}`} text={`${nameOf(r.by)}試吃回報：${r.words.length ? r.words.join('、') : '幾乎沒有味道'}${r.stale ? '（之後又調過味，已過期）' : ''}`} />
      ))}
    </>
  );
}

/* ------------------------------ 出餐口 ------------------------------ */

function Pass({ k, role, run }: Ctx): JSX.Element {
  const held = k.players[role]?.held;
  const open = k.orders.filter((o) => o.status === 'open');
  const last = useStore((s) => s.lastResult);
  const nameOf = useSeatName();
  const rumors = k.coop.rumors.filter((r) => r.status === 'posted' || r.status === 'verifying');
  const forgetful = k.self?.flaw === 'D15';
  return (
    <>
      {rumors.length > 0 && (
        <div className="ctrl">
          <div className="lbl">待核對的傳聞（票機的預備單對得上才是真的）</div>
          {rumors.map((r) => (
            <div key={r.id} className="opt pass-row">
              <span className="xs">{nameOf(r.by)}</span>
              <span>「{r.text}」</span>
              <Btn kind="small" label={`核對：${r.text}`} disabled={r.status === 'verifying'} onClick={() => run('verify', { rumorId: r.id })}>
                {r.status === 'verifying' ? '核對中…' : r.by === role ? '核對（6 秒）' : '核對（2 秒）'}
              </Btn>
            </div>
          ))}
        </div>
      )}
      {k.phase !== 'SERVICE' && <Say text={k.phase === 'PREP' ? '還沒開始營業。先備料。' : '已經打烊了。'} className="dim" />}
      {open.length === 0 && k.phase === 'SERVICE' && <Say text="現在沒有單。" className="dim" />}
      <div className="opts">
        {open.map((o) => {
          const left = o.deadline - k.t;
          const text = `${o.table} 號桌，${orderDish(o)}，剩 ${fmtSec(left)}`;
          return (
            <div key={o.id} className="opt pass-row">
              <span className="code">{o.table}</span>
              <span>
                <b>{orderDish(o)}</b>
                <span className="hint"> {orderNeed(o)}</span>
              </span>
              {forgetful && (
                <Btn kind="small" label={`看單：${o.table} 號桌`} onClick={() => run('read', { orderId: o.id })}>
                  {o.forgotten ? '看單（想起來）' : '再看一次'}
                </Btn>
              )}
              <Btn kind="primary small" label={`出給 ${text}`} disabled={!holding(k, role, 'plate')} onClick={() => run('serve', { orderId: o.id })}>
                出餐
              </Btn>
            </div>
          );
        })}
      </div>
      {last && <ResultCard r={last} compact />}
    </>
  );
}

/* ------------------------------ 監視器 ------------------------------ */

const CAM_ZONES = new Set(['DINING', 'HALL_N', 'HALL_E']);

function Cctv({ k, run }: Ctx): JSX.Element {
  const watching = k.threats.cctv;
  useEffect(() => {
    if (!watching) run('watch', { on: true });
    // 只在打開面板時開始觀看；關面板時 closeStation 會送出結束
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const g = k.threats.guest;
  const m = k.threats.monster;
  const ready = k.t >= k.fireDoor.readyAt;
  const closed = !k.doors.fire;
  const backLocked = !!k.backDoor && k.t < k.backDoor.closedUntil;
  const inCam = (x: number, z: number): boolean => {
    const zone = ZONES.find((q) => x >= q.minX && x <= q.maxX && z >= q.minZ && z <= q.maxZ);
    return !!zone && CAM_ZONES.has(zone.id);
  };
  const W = 18;
  const H = 27;
  return (
    <>
      <p className="legend">畫面只拍得到餐廳與後走廊。你盯著監視器時，那位客人不會移動。</p>
      <svg className="cctv" viewBox={`-9.5 -0.5 ${W + 1} ${H + 1}`} role="img" aria-label="監視器畫面">
        {ZONES.map((z) => (
          <rect key={z.id} x={z.minX} y={z.minZ} width={z.maxX - z.minX} height={z.maxZ - z.minZ} className={CAM_ZONES.has(z.id) ? 'cam' : 'blind'} />
        ))}
        {ZONES.filter((z) => CAM_ZONES.has(z.id)).map((z) => (
          <text key={z.id} x={z.minX + 0.3} y={z.minZ + 0.9} className="lbl">
            {ZONE_BY_ID[z.id].label}
          </text>
        ))}
        <line x1={7.95} y1={18.6} x2={7.95} y2={19.7} className={closed ? 'door shut' : 'door'} />
        {g && g.state !== 'gone' && inCam(g.x, g.z) && <circle cx={g.x} cy={g.z} r={0.45} className="guest" />}
        {m?.present && inCam(m.x, m.z) && <rect x={m.x - 0.5} y={m.z - 0.5} width={1} height={1} className="monster" />}
      </svg>
      <div className="ctrl">
        <div className="lbl">後門外的動靜</div>
        <span className="bar restless" aria-label={`後門外的動靜：${Math.round((m?.restless ?? 0) * 100)}%`}>
          <i style={{ width: `${Math.round((m?.present ? 1 : (m?.restless ?? 0)) * 100)}%` }} />
        </span>
        <Say className="sm" text={m?.present ? '牠已經在裡面了。' : (m?.restless ?? 0) > 0.75 ? '後門外越來越躁動：牠快進來了。' : '後門外還算安靜。廚房越吵，牠越快進來。'} />
      </div>
      <div className="actions">
        <Btn kind={backLocked || m?.present ? '' : 'danger'} label="鎖上後門，二十秒" disabled={backLocked || !ready || !!m?.present} onClick={() => run('back_door')}>
          {backLocked ? `後門鎖著（${Math.ceil((k.backDoor.closedUntil - k.t) / 1000)} 秒）` : m?.present ? '鎖後門（牠已經在裡面）' : ready ? '鎖上後門（20 秒）' : `門禁冷卻中（${Math.ceil((k.fireDoor.readyAt - k.t) / 1000)} 秒）`}
        </Btn>
        <Btn kind={closed ? '' : 'danger'} label="關上防火門，十五秒" disabled={closed || !ready} onClick={() => run('fire_door')}>
          {closed ? `防火門關著（${Math.ceil((k.fireDoor.closedUntil - k.t) / 1000)} 秒）` : ready ? '關上防火門（15 秒）' : `門禁冷卻中（${Math.ceil((k.fireDoor.readyAt - k.t) / 1000)} 秒）`}
        </Btn>
        <Btn kind={m?.present && k.t >= (k.flashReadyAt ?? 0) ? 'danger' : ''} label="緊急照明：把牠逼回後門" disabled={!m?.present || k.t < (k.flashReadyAt ?? 0)} onClick={() => run('flash')}>
          {k.t < (k.flashReadyAt ?? 0) ? `緊急照明充電中（${Math.ceil(((k.flashReadyAt ?? 0) - k.t) / 1000)} 秒）` : m?.present ? '緊急照明（逼退牠）' : '緊急照明（牠進來才有用）'}
        </Btn>
      </div>
      <p className="legend">
        門禁兩個按鈕共用 45 秒冷卻。<b>鎖後門</b>：牠還沒進來時用，20 秒內進不來（但會越等越餓，門一開就進來）。
        <b>關防火門</b>：牠在後走廊或側走廊（畫面上看得到）時關門，牠會去撞門 2.5 秒然後放棄、這次就離開；牠已經在廚房裡時，關門只是擋住一條路。
        牠進來前會在後門外刮門 6 秒，這時鎖後門就進不來；進來之後每次最多待 40 秒。<b>緊急照明</b>：牠已經在裡面時打開，強光把牠逼回後門（90 秒充電）。也可以看著牠按 T 把手上的食材丟過去，砸中會讓牠愣住 3 秒。
      </p>
    </>
  );
}

/* ------------------------------ 置物櫃、鐵籠、後門、垃圾桶 ------------------------------ */

function Locker({ def, s, k }: Ctx): JSX.Element {
  if (flawOf(k) === 'D12') return <Say text="置物櫃太窄了，你進不去。找別的地方躲，或繞開怪物。" className="warnline" />;
  return (
    <>
      <Say text={s.occupant ? '裡面有人。' : '可以躲進去。躲著的時候不能移動，但爐子上的東西會繼續煮。'} />
      <div className="actions">
        <Btn kind="primary" label="躲進置物櫃" disabled={!!s.occupant} onClick={() => void act(def.id, 'hide').then((r) => r?.ok && closeStation())}>躲進去</Btn>
      </div>
    </>
  );
}

function Cage({ s, run }: Ctx): JSX.Element {
  const nameOf = useSeatName();
  return (
    <>
      <Say text={s.occupant ? `${nameOf(s.occupant)}被關在裡面。` : '鐵籠是空的。'} />
      <div className="actions">
        <Btn kind="primary" label="撬開鐵籠，兩秒半" disabled={!s.occupant} onClick={() => run('rescue', { role: s.occupant })}>撬開（2.5 秒）</Btn>
      </div>
    </>
  );
}

function Delivery({ s, k, role, run }: Ctx): JSX.Element {
  const held = k.players[role]?.held;
  return (
    <>
      <Say text={s.crate ? `門口有一箱${s.crate === 'FRIDGE' ? '冷藏' : '乾貨'}。` : '現在沒有貨。大約每一分半送一次。'} />
      <div className="actions">
        <Btn kind="primary" label="搬起來（雙手）" disabled={!s.crate || !bothFree(k, role)} onClick={() => run('take_crate')}>搬起來（雙手）</Btn>
      </div>
    </>
  );
}

function Trash({ k, role, run }: Ctx): JSX.Element {
  const held = k.players[role]?.held;
  return (
    <>
      <Say text={handsText(k, role)} />
      <div className="actions">
        <Btn kind="danger" label="丟掉手上的東西" disabled={!held || held.kind === 'crate' || held.kind === 'dirty'} onClick={() => run('discard')}>
          丟掉{flawOf(k) === 'D11' ? '（用腳踩開蓋子，1.2 秒）' : ''}
        </Btn>
      </div>
      {held?.kind === 'plate' && <p className="legend">盤子裡的菜會倒掉，盤子放到回收窗口（之後要洗）。</p>}
    </>
  );
}

/* ------------------------------ 回收窗口、交接架 ------------------------------ */

function Dishes({ s, k, role, run }: Ctx): JSX.Element {
  const held = k.players[role]?.held;
  const n = (s.dirty?.plate ?? 0) + (s.dirty?.bowl ?? 0);
  const d11 = flawOf(k) === 'D11';
  return (
    <>
      <Say text={n ? `客人吃完送回來的髒盤：盤子 ${s.dirty?.plate ?? 0}、碗 ${s.dirty?.bowl ?? 0}。拿到水槽的碗盤架洗。` : '現在沒有髒盤。'} />
      <div className="actions">
        <Btn kind="primary" label={d11 ? '用托盤收，兩秒半' : '拿起來（雙手）'} disabled={!n || !bothFree(k, role)} onClick={() => run('take')}>
          {d11 ? '用托盤收（2.5 秒，一次 6 個）' : '拿起來（一次 4 個）'}
        </Btn>
      </div>
      {d11 && <p className="legend">你不肯徒手碰髒盤；隊友也可以幫你把髒盤送到水槽的碗盤架，你直接洗。</p>}
    </>
  );
}

/** 成品架：處理好的食材暫放；肉類一個架、其他一個架 */
function Rack({ def, s, k, role, run }: Ctx): JSX.Element {
  const me = k.players[role];
  const held = me?.held;
  const meat = def.id === 'rack_meat';
  const fits = (id: string) => !!k.items[id] && isRawProtein(INGREDIENTS[k.items[id].type]) === meat;
  const mine = [...(held?.kind === 'item' ? [held.id] : []), ...(me?.other?.kind === 'item' ? [me.other.id] : []), ...(me?.basket ?? [])].filter(fits);
  const full = s.items.length >= RACK_CAPACITY;
  return (
    <>
      <p className="legend">{meat ? '生肉、熟肉都放這裡：和蔬菜分開，不會交叉污染。' : '洗好、削好、切好的蔬菜和其他食材放這裡（肉放隔壁的肉類架）。'}</p>
      {s.items.length === 0 && <Say text={`${def.label}是空的。`} className="dim" />}
      {s.items.map((id) => {
        const it = k.items[id];
        return it ? <ItemCard key={id} it={it} role={role} vessel={null} actions={<Btn kind="small" label="拿起來" disabled={handsFull(k, role)} onClick={() => run('pick', { id })}>拿起來</Btn>} /> : null;
      })}
      <div className="actions">
        <Btn kind="primary" label="把手上的食材放上架" disabled={!(held?.kind === 'item' && fits(held.id)) || full} onClick={() => run('place')}>
          放上去（{s.items.length}／{RACK_CAPACITY}）
        </Btn>
        {mine.length > 1 && (
          <Btn label={`手上和菜籃裡的 ${mine.length} 份全部放上架`} disabled={full} onClick={() => run('place_all')}>全部放上去（{mine.length}）</Btn>
        )}
      </div>
      {held?.kind === 'item' && !fits(held.id) && <p className="legend warn-text">{meat ? '手上的不是肉：放隔壁的「成品架・蔬菜與其他」。' : '手上的是肉：放隔壁的「成品架・肉類」。'}</p>}
    </>
  );
}

/* ------------------------------ 烤箱 ------------------------------ */

function Oven({ def, s, k, role, run }: Ctx): JSX.Element {
  const items = s.items.map((id) => k.items[id]).filter(Boolean);
  const v = s.vessel ?? 22;
  const target = OVEN_TARGET[(s.heat ?? 'OFF') as HeatLevel];
  const d10 = flawOf(k) === 'D10' && (k.self?.gloveUntil ?? 0) <= k.t;
  const ready = s.heat && s.heat !== 'OFF' && v >= target - 5;
  return (
    <>
      <FireLock def={def} k={k} />
      <div className="ctrl">
        <div className="lbl">溫度</div>
        <div className="knob" role="radiogroup" aria-label="烤箱溫度">
          {HEAT_LEVELS.map((h: HeatLevel) => (
            <Btn key={h} kind={s.heat === h ? 'primary' : ''} disabled={d10 || (flawOf(k) === 'D10' && h === 'HIGH')} label={`${h === 'OFF' ? '關掉' : `${OVEN_TARGET[h]} 度`}${s.heat === h ? '，目前' : ''}`} onClick={() => run('heat', { level: h })}>
              {h === 'OFF' ? '關' : `${OVEN_TARGET[h]}°C`}
            </Btn>
          ))}
        </div>
        <Say className="sm" text={s.heat === 'OFF' || !s.heat ? `關著（裡面大約 ${Math.round(v)}°C）。` : ready ? `預熱完成：${target}°C。` : `預熱中：大約 ${Math.round(v)}°C／${target}°C。`} />
        <p className="legend">烤箱兩面一起上色、不用翻面，比平底鍋慢但均勻；預熱要一點時間，可以先開著去做別的事。</p>
      </div>
      {items.length === 0 && <Say text="烤箱裡是空的（最多四份）。" className="dim" />}
      {items.map((it) => (
        <ItemCard key={it.id} it={it} role={role} vessel={null} actions={<Btn kind="small" label={`拿出${INGREDIENTS[it.type].label}`} disabled={handsFull(k, role)} onClick={() => run('pick', { itemId: it.id })}>拿出來</Btn>} />
      ))}
      <div className="actions">
        <Btn kind="primary" label="把手上的東西放進烤箱" disabled={!holding(k, role, 'item') || items.length >= 4} onClick={() => run('place')}>放進去（{items.length}／4）</Btn>
        <Btn label="溫度計，一秒" disabled={!items.length} onClick={() => run('probe')}>
          <Icon name="probe" size={16} /> 溫度計
        </Btn>
      </div>
    </>
  );
}

/* ------------------------------ 攪拌碗 ------------------------------ */

function Mixer({ s, k, role, run }: Ctx): JSX.Element {
  const items = s.items.map((id) => k.items[id]).filter(Boolean);
  const flat = items.flatMap((it) => (it.mix ? [it, ...it.mix.parts] : [it]));
  const kind = mixKindOf(flat);
  return (
    <>
      <p className="legend">把要拌在一起的東西放進碗裡再按「攪拌」：麵粉＋液體＝麵糊；絞肉或壓碎的食材＋蛋液／麵粉＝餡料；其他＝拌料。拌好後變成一份，一起下鍋、進烤箱或裝盤。</p>
      {items.length === 0 && <Say text="碗是空的（最多六樣）。" className="dim" />}
      {items.map((it) => (
        <ItemCard key={it.id} it={it} role={role} vessel={null} actions={<Btn kind="small" label={`拿起${INGREDIENTS[it.type].label}`} disabled={handsFull(k, role)} onClick={() => run('pick', { itemId: it.id })}>拿起來</Btn>} />
      ))}
      {items.length >= 2 && <Say className="sm" text={kind ? `拌起來會是：${MIX_LABEL[kind]}。` : '全是液體：直接倒進湯鍋就好。'} />}
      <div className="actions">
        <Btn label="把手上的東西放進碗裡" disabled={!holding(k, role, 'item') || items.length >= 6} onClick={() => run('place')}>放進碗裡（{items.length}／6）</Btn>
        <Btn kind="primary" label="攪拌，兩秒半" disabled={items.length < 2 || !kind || (items.length === 1 && !!items[0].mix)} onClick={() => run('mix')}>攪拌（2.5 秒）</Btn>
      </div>
    </>
  );
}

function Shelf({ def, s, k, role, run }: Ctx): JSX.Element {
  const held = k.players[role]?.held;
  const used = s.items.length + s.plates.length;
  return (
    <>
      <p className="legend">
        {def.id === 'shelf_cold' ? '冷藏室門口：進不去冷藏室、或搆不到最上層的人，從這裡接手。' : '爐台旁：怕火的人把備好的料放這裡，由別人下鍋；煮好的也可以放回來。'}
      </p>
      {used === 0 && <Say text="交接架是空的。" className="dim" />}
      {s.items.map((id) => {
        const it = k.items[id];
        return it ? <ItemCard key={id} it={it} role={role} vessel={null} actions={<Btn kind="small" label="拿起來" disabled={handsFull(k, role)} onClick={() => run('pick', { id })}>拿起來</Btn>} /> : null;
      })}
      {s.plates.map((id) => {
        const p = k.plates[id];
        return p ? (
          <div key={id} className="row">
            <Say className="grow sm" text={plateLine(p)} />
            <Btn kind="small" label="端起來" disabled={handsFull(k, role)} onClick={() => run('pick', { id })}>端起來</Btn>
          </div>
        ) : null;
      })}
      <div className="actions">
        <Btn kind="primary" label="把手上的東西放上交接架" disabled={!(holding(k, role, 'item') || holding(k, role, 'plate')) || used >= 4} onClick={() => run('place')}>放上去（{used}／4）</Btn>
      </div>
    </>
  );
}

/* ------------------------------ 評分結果 ------------------------------ */

/** 這道菜實際是什麼：名稱、分類、四項品質與原因（和訂單分數分開） */
export function DishCard({ a, compact = false }: { a: DishAnalysis; compact?: boolean }): JSX.Element {
  const dims: QualityDim[] = ['cook', 'flavor', 'pairing', 'texture'];
  const grade = gradeOf(a.quality.total);
  return (
    <div className={`dish-card kind-${a.kind}`}>
      <div className="dish-head">
        <span className="dish-name">{a.name}</span>
        <span className={`chip xs kind ${a.kind}`}>{DISH_KIND_LABEL[a.kind]}</span>
        <span className={`chip xs grade ${grade}`}>
          {GRADE_LABEL[grade]} <span className="code">{a.quality.total}</span>
        </span>
      </div>
      <p className="xs dim">
        {COOK_STYLE_LABEL[a.style]}・{SAUCE_LABEL[a.sauce]}
        {a.changes?.length ? `・${a.changes.join('、')}` : ''}
        {a.fatal ? `・失敗原因：${a.fatal}` : ''}
      </p>
      <table className="r-cats dish-q">
        <tbody>
          {dims.map((d) => (
            <tr key={d}>
              <th scope="row">{QUALITY_LABEL[d]}</th>
              <td className="bar">
                <i style={{ width: `${a.quality[d]}%` }} />
              </td>
              <td className="code">{a.quality[d]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!compact && (
        <ul className="reasons">
          {a.notes.map((n, i) => (
            <li key={i} className={n.ok ? 'ok' : 'bad'}>
              <span className="cat">{QUALITY_LABEL[n.dim]}</span>
              {n.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ResultCard({ r, compact = false }: { r: import('@last-table/shared').ScoreResult; compact?: boolean }): JSX.Element {
  const cats = Object.keys(r.weights) as Array<keyof typeof r.weights>;
  const LABEL: Record<string, string> = {
    process: '製程',
    doneness: '火候與熟度',
    prep: '刀工與備料',
    seasoning: '調味',
    plating: '裝盤與出餐',
    safety: '食品安全',
    cook: '烹調品質',
    flavor: '風味平衡',
    pairing: '食材搭配',
    texture: '質地與完成度',
    time: '時間與效率',
    require: '必要條件',
    bonus: '加分條件',
  };
  const c = r.commission;
  const EFF = { fast: '比標準快', on_time: '準時', slow: '比標準慢' } as const;
  return (
    <div className="receipt">
      <div className="r-head">
        <b>{r.dish}</b>
        <span className="score code">{r.total}</span>
      </div>
      {c && (
        <div className={`commission-verdict ${c.passed ? 'ok' : 'bad'}`}>
          <b>{c.passed ? `委託達成・${GRADE_LABEL[c.grade]}` : '委託沒有達成'}</b>
          {c.passed ? <span className="code">＋{c.coins} 枚</span> : null}
          {!c.passed && (
            <ul className="xs">
              {c.violations.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          )}
          {c.bonuses.length > 0 && <p className="xs">加分：{c.bonuses.map((b) => `${b.text} ＋${b.pts}`).join('、')}</p>}
        </div>
      )}
      {r.analysis && <DishCard a={r.analysis} compact={compact} />}
      {r.cap && <p className="cap">分數上限 {r.cap.max}：{r.cap.why}</p>}
      <table className="r-cats">
        <tbody>
          {cats.map((c) => (
            <tr key={c}>
              <th scope="row">{LABEL[c]}</th>
              <td className="bar">
                <i style={{ width: `${Math.round(r.categories[c] * 100)}%` }} />
              </td>
              <td className="code">{Math.round(r.categories[c] * r.weights[c])}／{r.weights[c]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="reasons">
        {r.reasons.slice(0, compact ? 4 : 99).map((x, i) => (
          <li key={i} className={x.ok ? 'ok' : 'bad'}>
            <span className="cat">{LABEL[x.cat]}</span>
            {x.text}
          </li>
        ))}
      </ul>
      <p className="eff xs">
        效率另外記錄：{Math.round(r.elapsedSec)} 秒（標準 {r.parSec} 秒，{EFF[r.efficiency]}）・{useStore.getState().room?.players.find((p) => p.role === r.servedBy)?.name ?? r.servedBy}出餐
      </p>
      {!compact && r.trail.length > 0 && (
        <details className="trail">
          <summary>每個食材的操作紀錄</summary>
          {r.trail.map((t, i) => (
            <div key={i}>
              <b className="sm">{t.label}</b>
              <ol className="xs">
                {t.steps.map((s, j) => (
                  <li key={j}>{s}</li>
                ))}
              </ol>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/* ------------------------------ 面板外框 ------------------------------ */

interface Ctx {
  def: StationDef;
  s: StationPublic;
  k: KitchenPublic;
  role: Seat;
  run: Run;
}

const BODY: Partial<Record<StationDef['kind'], (c: Ctx) => JSX.Element>> = {
  fridge: Storage,
  pantry: Storage,
  sink: Sink,
  prep: Prep,
  pan: Heat,
  stove: Heat,
  toaster: Toaster,
  spice: Spice,
  plating: Plating,
  pass: Pass,
  cctv: Cctv,
  locker: Locker,
  cage: Cage,
  delivery: Delivery,
  trash: Trash,
  dishes: Dishes,
  shelf: Shelf,
  rack: Rack,
  oven: Oven,
  mixer: Mixer,
  gunrack: GunRack,
};

/** 拿著盤子（或碗）站在平底鍋、烤箱、烤麵包機、成品架、砧板前：裡面的東西一次全部裝盤 */
const PLATE_ALL = new Set(['pan', 'oven', 'toaster', 'rack', 'prep']);
function PlateAll({ def, s, k, role, run }: Ctx): JSX.Element | null {
  const me = k.players[role];
  const plate = me?.held?.kind === 'plate' ? me.held : me?.other?.kind === 'plate' ? me.other : null;
  if (!plate || !PLATE_ALL.has(def.kind)) return null;
  const n = s.items.filter((id) => k.items[id] && !INGREDIENTS[k.items[id].type].liquid).length;
  if (!n) return null;
  const v = k.plates[plate.id]?.vessel === 'bowl' ? '碗' : '盤子';
  return (
    <div className="actions">
      <Btn kind="primary" label={`${def.label}裡的 ${n} 樣全部裝進手上的${v}`} onClick={() => run('plate_all')}>
        全部裝進{v}（{n} 樣）
      </Btn>
    </div>
  );
}

/** 來福槍架：一把槍、整班 4 發；打中怪物一次就把牠打退 */
function GunRack({ k, role, run }: Ctx): JSX.Element {
  const rifle = k.rifle ?? { ammo: 4, holder: null, lastShotAt: 0 };
  const mine = k.players[role]?.held?.kind === 'rifle';
  const nameOf = useSeatName();
  return (
    <>
      <p className="legend">牠進到裡面時，拿起來福槍、把準心對準牠（十字準心變紅）按滑鼠左鍵開槍。打中一次就能把牠打退回後門。整班只有 4 發，槍聲很大（牠以外的東西也會聽到）。</p>
      <Say text={`剩 ${rifle.ammo} 發子彈。${rifle.holder ? (mine ? '槍在你手上。' : `槍在${nameOf(rifle.holder as Seat)}手上。`) : '槍掛在架上。'}`} />
      <div className="actions">
        {mine ? (
          <Btn kind="primary" label="把來福槍放回槍架" onClick={() => run('return')}>放回槍架</Btn>
        ) : (
          <Btn kind="primary" label="拿起來福槍（雙手）" disabled={!!rifle.holder || rifle.ammo <= 0 || !bothFree(k, role)} onClick={() => run('take')}>
            拿起來福槍（雙手）
          </Btn>
        )}
      </div>
      {!mine && !rifle.holder && !bothFree(k, role) && <p className="legend warn-text">要空出雙手才能拿槍。</p>}
    </>
  );
}

function TaskBar({ k, role }: { k: KitchenPublic; role: Seat }): JSX.Element | null {
  const task = k.players[role]?.task;
  if (!task) return null;
  const p = Math.min(1, Math.max(0, (k.t - task.startedAt) / (task.endsAt - task.startedAt)));
  const what = TASK_TEXT[task.kind];
  return (
    <div className="taskbar" role="progressbar" aria-valuenow={Math.round(p * 100)} aria-label={what}>
      <span>{what}</span>
      <span className="bar">
        <i style={{ width: `${p * 100}%` }} />
      </span>
      <button className="btn small" onClick={() => void act(task.stationId, 'cancel')}>停下</button>
    </div>
  );
}

/** 要從很多項目裡挑的面板（食材、調味料、出餐選單、監視器）放在畫面正中間，比較好看、好點 */
const CENTERED = new Set<string>(['fridge', 'pantry', 'spice', 'pass', 'cctv']);

export default function StationPanel(): JSX.Element | null {
  const station = useStore((s) => s.station);
  const k = useStore((s) => s.kitchen);
  const role = useStore((s) => s.me?.role ?? null);
  const run = useCallback<Run>((action, args = {}) => {
    const id = useStore.getState().station?.id;
    if (id) void act(id, action, args);
  }, []);
  const bodyRef = useRef<HTMLDivElement>(null);
  const kind = station ? STATION_BY_ID[station.id]?.kind : undefined;
  const digits = kind !== 'fridge' && kind !== 'pantry';
  // 面板裡的按鈕依序標上 1–9：按數字鍵就等於點那個按鈕（冷藏架／乾貨架的數字鍵是拿食材）
  const hotButtons = (): HTMLButtonElement[] =>
    bodyRef.current ? Array.from(bodyRef.current.querySelectorAll<HTMLButtonElement>('button.btn:not(:disabled)')).slice(0, 9) : [];
  useEffect(() => {
    if (!bodyRef.current) return;
    bodyRef.current.querySelectorAll('button[data-key]').forEach((b) => b.removeAttribute('data-key'));
    if (digits) hotButtons().forEach((b, i) => b.setAttribute('data-key', String(i + 1)));
  });
  useEffect(() => {
    if (!digits || !station) return;
    const onKey = (e: KeyboardEvent): void => {
      const m = /^Digit([1-9])$/.exec(e.code);
      if (!m || e.repeat || e.shiftKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const b = hotButtons()[Number(m[1]) - 1];
      if (!b) return;
      e.preventDefault();
      b.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits, station?.id]);
  if (!station || !k || !role) return null;
  const def = STATION_BY_ID[station.id];
  const s = k.stations[station.id];
  if (!def || !s) return null;
  const Body = BODY[def.kind];
  const held = k.players[role]?.held ?? null;
  const res = station.result;

  return (
    <div className={`modal-bg station-bg ${CENTERED.has(def.kind) ? 'center' : ''}`} role="dialog" aria-modal="true" aria-label={def.label} onMouseDown={(e) => e.target === e.currentTarget && closeStation()}>
      <div className={`modal station k-${def.kind}`}>
        <header>
          <span className="plateno">{ZONE_BY_ID[def.zone].label}</span>
          <div>
            <h2>{def.label}</h2>
            <div className="sub">{handsText(k, role)}</div>
          </div>
          <button className="btn small icon" onClick={() => closeStation()} aria-label="關閉（Esc 或移動）" title="關閉（Esc，或直接走開）">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="body" ref={bodyRef}>
          <TaskBar k={k} role={role} />
          {Body && <Body def={def} s={s} k={k} role={role} run={run} />}
          <PlateAll def={def} s={s} k={k} role={role} run={run} />
          <Notes stationId={def.id} k={k} />
          {res && (
            <div className={`result ${res.tone}`} key={res.id} role="status">
              <Icon name={res.tone === 'error' ? 'close' : res.tone === 'ok' ? 'check' : 'info'} size={18} />
              <span>{res.message}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 便條 ------------------------------ */

/**
 * 工作站上的便條：固定詞彙（待處理／已備料／等待烹飪／完成），可以連結專注單或第一張單。
 * 伺服器記下貼便條時的工作站內容；內容一變就標成「已過期」，幾秒後自動移除——不會留著錯誤資訊。
 */
function Notes({ stationId, k }: { stationId: string; k: KitchenPublic }): JSX.Element {
  const nameOf = useSeatName();
  const notes = k.coop.notes.filter((n) => n.stationId === stationId);
  const focus = k.self?.focus ?? null;
  const byId = new Map(k.orders.map((o) => [o.id, o]));
  return (
    <div className="ctrl notes">
      <div className="lbl">便條</div>
      {notes.map((n) => {
        const o = n.orderId ? byId.get(n.orderId) : undefined;
        return (
          <div key={n.id} className={`row note-row ${n.stale ? 'stale' : ''}`}>
            <span className="grow sm">
              <b>{NOTE_TEXT[n.label]}</b>
              {o ? `・#${o.table}` : ''}　<span className="xs dim">{nameOf(n.by)}{n.stale ? '・已過期（工作站的內容變了）' : ''}</span>
            </span>
            <Btn kind="small" label="撕掉便條" onClick={() => void coop('note_clear', { noteId: n.id })}>撕掉</Btn>
          </div>
        );
      })}
      <div className="row wrap">
        {NOTE_LABELS.map((l) => (
          <Btn key={l} kind="small" label={`貼便條：${NOTE_TEXT[l]}`} onClick={() => void coop('note', { stationId, label: l, ...(focus ? { orderId: focus } : {}) })}>
            {NOTE_TEXT[l]}
          </Btn>
        ))}
        {focus && <span className="xs dim">（會連結到你的專注單）</span>}
      </div>
    </div>
  );
}
