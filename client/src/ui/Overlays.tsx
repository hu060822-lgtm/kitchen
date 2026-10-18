import { KeyBindings } from './KeyBindings';
import { keyLabel as K, useKeymap } from '../game/keymap';
import { useCallback, useEffect, useState } from 'react';
import {
  CATEGORY_LABEL,
  DEFAULT_WEIGHTS,
  FLAVOR_DIMS,
  FLAVOR_LABEL,
  FREE_REQUESTS,
  INGREDIENTS,
  INGREDIENT_IDS,
  CATEGORY_NAME,
  CATEGORY_ORDER,
  COOK_STYLE_LABEL,
  RECIPE_GROUP_LABEL,
  condLabel,
  COMMISSIONS,
  type CommissionDef,
  RECIPE_GROUP_ORDER,
  type RecipeGroup,
  DISH_KIND_LABEL,
  GRADE_LABEL,
  SAUCE_LABEL,
  MAX_SIGNAL_LEN,
  FLAW_CARDS,
  RECIPES,
  SEATS,
  SEASONINGS,
  SEASONING_IDS,
  TOKEN_CLASS,
  TOKEN_COLOR,
  TOKEN_LABEL,
  canPerceive,
  type Flavor,
  type SignalToken,
} from '@last-table/shared';
import { audio } from '../audio/engine';
import { setSpeechEnabled, speak } from '../audio/speech';
import { requestLock, toggleOverlay } from '../game/loop';
import { coop, emitMark, emitSignal, leaveRoom, pauseGame, restartGame, saveGame } from '../net/socket';
import { hostBridge } from '../platform';
import { InviteCard } from './InviteCard';
import { flawOfSeat, myFlaw, shiftNow, useStore } from '../state/store';
import { TokenChip } from './Hud';
import MicSetup from './MicSetup';
import { Icon, RoleGlyph, TokenGlyph, type IconName } from './icons';
import { fmtSec, orderDish, orderNeed } from './kitchenText';
import { ResultCard } from './StationPanel';
import { TITLES, clearRecords, useRecords } from '../state/records';
import { FlawDetail, useSeatName } from './flawUi';
import { DualOverlay, coldCapable } from './FlawHud';

const NO_MENU: string[] = [];

function Shell({ title, sub, icon, onClose, children }: { title: string; sub?: string; icon: IconName; onClose: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="modal-bg" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <Icon name={icon} size={22} />
          <div>
            <h2>{title}</h2>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <button className="btn small icon" onClick={onClose} aria-label="關閉（Esc）" title="關閉（Esc）">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="body">{children}</div>
      </div>
    </div>
  );
}

const close = (): void => {
  useStore.getState().set({ overlay: 'none' });
  requestLock();
};

/* ------------------------------ 出單 ------------------------------ */

export function TicketsOverlay(): JSX.Element | null {
  const k = useStore((s) => s.kitchen);
  const nameOf = useSeatName();
  const open = k?.orders.filter((o) => o.status === 'open') ?? [];
  const done = k?.orders.filter((o) => o.status !== 'open') ?? [];
  useEffect(() => {
    if (!k) return;
    const now = shiftNow();
    speak(open.length ? open.map((o) => `${o.table} 號桌，${orderDish(o)}${o.kind === 'free' && !o.forgotten ? `，${orderNeed(o)}` : ''}，剩 ${Math.ceil((o.deadline - now) / 1000)} 秒`).join('。') : '現在沒有單', { interrupt: true });
    // 只在打開時念一次（語音播報是無障礙選項）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!k) return null;
  const now = shiftNow();
  const self = k.self;
  const myRumors = (self?.rumors ?? []).filter((r) => !r.posted && r.expiresAt > now);
  const focusReady = !self || self.cooldowns.focus <= k.t;
  const markOrder = (id: string): void => {
    void emitMark(`order:${id}`, 'GEST_HELP').then((e) => useStore.getState().pushNotice({ tone: e ? 'warn' : 'info', text: e ?? '已標記這張單（隊友會看到是你標的）' }, 2500));
  };
  return (
    <Shell icon="ticket" title="訂單板" sub="品質分數只看料理本身；出餐速度另外記錄。傳聞要到出餐口核對才算數。" onClose={close}>
      {self?.flaw === 'D01' && (
        <>
          <div className="blk-heading">只有你聽到的傳聞</div>
          {myRumors.length === 0 && <p className="note">現在沒有。真的訂單出現前，你偶爾會先聽到一部分；也會聽到根本不存在的單。</p>}
          {myRumors.map((r) => (
            <div key={r.id} className="row log-entry">
              <span className="grow">「{r.text}」<span className="xs dim">　{Math.ceil((r.expiresAt - now) / 1000)} 秒後記不清楚</span></span>
              <button className="btn small primary" onClick={() => void coop('rumor_post', { rumorId: r.id })}>貼上訂單板</button>
              <button className="btn small" onClick={() => void coop('rumor_dismiss', { rumorId: r.id })}>不理它</button>
            </div>
          ))}
        </>
      )}
      {k.coop.rumors.length > 0 && (
        <>
          <div className="blk-heading">待核對的傳聞</div>
          {k.coop.rumors.map((r) => (
            <div key={r.id} className={`row log-entry rumor ${r.status}`}>
              <span className="grow">
                {nameOf(r.by)}聽到：「{r.text}」
                <span className="xs dim">
                  　{r.status === 'posted' ? '到出餐口按「核對」（隊友 2 秒、本人 6 秒）' : r.status === 'verifying' ? `${r.verifier ? nameOf(r.verifier) : ''}正在核對…` : r.status === 'confirmed' ? '✓ 核對為真' : '✕ 已排除'}
                </span>
              </span>
              {r.status === 'posted' && (
                <button className="btn small" onClick={() => void coop('rumor_dismiss', { rumorId: r.id })}>駁回</button>
              )}
            </div>
          ))}
        </>
      )}
      {k.coop.prepHints.length > 0 && (
        <>
          <div className="blk-heading">準備提示（已核對）</div>
          {k.coop.prepHints.map((h) => (
            <p key={h.id} className="note">{h.text}{h.orderId ? '（單已出現）' : ''}</p>
          ))}
        </>
      )}
      <div className="blk-heading">現在的單</div>
      {open.length === 0 && <p className="note">{k.phase === 'PREP' ? '還沒開店。先把常用的食材洗好、切好。' : '現在沒有單。'}</p>}
      {open.map((o) => {
        const r = o.recipeId ? RECIPES[o.recipeId] : null;
        const q = o.requestId ? FREE_REQUESTS[o.requestId] : null;
        const isFocus = self?.focus === o.id;
        return (
          <div key={o.id} className={`log-entry ${o.forgotten ? 'forgotten' : ''}`}>
            <h4>
              <span className="code">#{o.table}</span>
              {orderDish(o)}
              {isFocus && <span className="tag">★ 專注單</span>}
              {self?.flaw === 'D10' && !o.forgotten && coldCapable(o) && <span className="tag">❄ 可做冷盤</span>}
              <span className="where code">剩 {fmtSec(o.deadline - now)}</span>
            </h4>
            {o.forgotten && <p className="note">{orderNeed(o)}</p>}
            {r && (
              <ol className="blk-list">
                {r.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            )}
            {q && <CommissionBrief q={q} need={orderNeed(o)} />}
            <div className="row wrap">
              <button className="btn small" onClick={() => markOrder(o.id)}>標記這張單</button>
              {self?.flaw === 'D15' && !o.forgotten && !isFocus && (
                <button className="btn small" disabled={!focusReady} onClick={() => void coop('focus', { orderId: o.id })}>
                  ★ 設為專注單{!focusReady && `（${Math.ceil((self.cooldowns.focus - k.t) / 1000)} 秒）`}
                </button>
              )}
              {isFocus && <button className="btn small" onClick={() => void coop('focus', { orderId: null })}>取消專注</button>}
            </div>
          </div>
        );
      })}
      {done.length > 0 && <div className="blk-heading">已結束</div>}
      {[...done].reverse().map((o) =>
        o.result ? (
          <ResultCard key={o.id} r={o.result} />
        ) : (
          <p key={o.id} className="note">
            #{o.table} {orderDish(o)}：客人等太久離開了。
          </p>
        ),
      )}
    </Shell>
  );
}

/* ------------------------------ 食譜與口味表 ------------------------------ */

function flavorText(f: Flavor): string {
  const parts = FLAVOR_DIMS.filter((d) => (f[d] ?? 0) > 0).map((d) => `${FLAVOR_LABEL[d]} ${f[d]}`);
  return parts.length ? parts.join('、') : '—';
}

/** 委託：主廚的原話＋結構化條件（和伺服器判定用同一份資料） */
export function CommissionBrief({ q, need }: { q: CommissionDef; need: string }): JSX.Element {
  return (
    <div className="commission-brief">
      <p className="blk-text">{need}</p>
      <p className="xs">
        <span className="chip xs">難度 {'★'.repeat(q.difficulty)}</span> 做法自由・必要條件（沒做到＝委託失敗）：
      </p>
      <ul className="reasons">
        {q.require.map((c, i) => (
          <li key={i} className="req">
            {condLabel(c)}
          </li>
        ))}
      </ul>
      <p className="xs dim">
        加分：{q.bonus.map((b) => `${b.text}（＋${b.pts}）`).join('、')}
        {q.timeLimitSec ? `・時限 ${q.timeLimitSec} 秒` : ''}
        {q.effects?.probeBroken ? '・這張單在的時候溫度計失靈' : ''}
      </p>
      <p className="xs dim">可能的解法：{q.solutions}</p>
    </div>
  );
}

/** 食譜：依分類瀏覽；「本班菜單」只列這一班會出現的（招牌菜＋今日特餐） */
function RecipeBook(): JSX.Element {
  const menu = useStore((s) => s.kitchen?.menu) ?? NO_MENU;
  const [group, setGroup] = useState<RecipeGroup | 'menu'>(menu.length ? 'menu' : 'signature');
  const specials = new Set(menu.filter((id) => RECIPES[id]?.group !== 'signature'));
  const list = Object.values(RECIPES).filter((r) => (group === 'menu' ? menu.includes(r.id) : (r.group ?? 'signature') === group));
  return (
    <>
      <div className="row tabs recipe-groups" role="tablist" aria-label="食譜分類">
        {menu.length > 0 && (
          <button className={`btn small ${group === 'menu' ? 'primary' : ''}`} role="tab" aria-selected={group === 'menu'} onClick={() => setGroup('menu')}>
            本班菜單
          </button>
        )}
        {RECIPE_GROUP_ORDER.map((g) => (
          <button key={g} className={`btn small ${group === g ? 'primary' : ''}`} role="tab" aria-selected={group === g} onClick={() => setGroup(g)}>
            {RECIPE_GROUP_LABEL[g]}
          </button>
        ))}
      </div>
      {list.map((r) => (
        <div key={r.id} className="log-entry">
          <h4>
            {r.name}
            {specials.has(r.id) && <span className="chip xs special">今日特餐</span>}
            <span className="where">
              {r.vessel === 'bowl' ? '碗' : '盤子'}・標準 {r.parSec} 秒
            </span>
          </h4>
          <table className="tbl">
            <tbody>
              {r.components.map((c, i) => (
                <tr key={i}>
                  <td>
                    {INGREDIENTS[c.type].label}
                    {c.qty > 1 ? ` ×${c.qty}` : ''}
                    {c.alt?.length ? <div className="xs dim">或 {c.alt.map((a) => INGREDIENTS[a].label).join('、')}</div> : null}
                  </td>
                  <td>{c.note}</td>
                </tr>
              ))}
              <tr>
                <td>調味</td>
                <td>{Object.entries(r.seasoning).map(([id, v]) => `${SEASONINGS[id as keyof typeof SEASONINGS].label} ${v}`).join('、') || '不另外調味（先試吃）'}</td>
              </tr>
            </tbody>
          </table>
          <ol className="blk-list">
            {r.steps.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ol>
          {r.focus && <p className="xs">品質重點：{r.focus.join('；')}</p>}
          {r.variants && <p className="xs dim">可以變化：{r.variants}（用替代食材或多加一點東西也會被認出來，算食譜變化）</p>}
        </div>
      ))}
    </>
  );
}

/** 料理圖鑑：這台電腦上做出過的每一道菜（伺服器判定的名稱與品質，存在本機） */
function Dex(): JSX.Element {
  const rec = useRecords();
  const [confirm, setConfirm] = useState(false);
  const list = Object.values(rec.discoveries).sort((a, b) => b.firstAt - a.firstAt);
  const known = new Set(list.filter((d) => d.kind === 'known').map((d) => d.recipeId));
  return (
    <>
      <p className="note">
        不用照食譜：任何合理的做法都會被認出來、取名字、評分。第一次做出來的菜會記在這裡（存在這台電腦的瀏覽器）；同一道菜保留最好的一次。
      </p>
      <div className="lbl">
        主廚委託・遊戲幣 <span className="code">{rec.coins}</span> 枚
      </div>
      <div className="dex-recipes">
        {TITLES.map((t) => (
          <span key={t.id} className={`chip xs ${t.test(rec) ? 'done' : ''}`} title={t.desc}>
            {t.test(rec) ? '🏅 ' : ''}
            {t.name}
          </span>
        ))}
      </div>
      <table className="tbl">
        <tbody>
          {Object.values(COMMISSIONS).map((c) => {
            const log = rec.commissions[c.id];
            return (
              <tr key={c.id}>
                <td className="xs">
                  {c.no}. {c.title} <span className="dim">{'★'.repeat(c.difficulty)}</span>
                </td>
                <td className="xs">{log ? `達成 ${log.passed}／${log.count} 次` : '—'}</td>
                <td className="xs">{log?.passed ? `最好 ${GRADE_LABEL[log.bestGrade]} ${log.best}` : ''}</td>
                <td className="xs dim">{log?.dishes.join('、')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="lbl">食譜（做出過的會亮起來）</div>
      <div className="dex-recipes">
        {Object.values(RECIPES).map((r) => (
          <span key={r.id} className={`chip xs ${known.has(r.id) ? 'done' : ''}`}>
            {known.has(r.id) ? '✓ ' : ''}
            {r.name}
          </span>
        ))}
      </div>
      <div className="lbl">發現的料理（{list.length}）</div>
      {list.length === 0 && <p className="dim">還沒有紀錄。出一道菜試試看。</p>}
      <div className="dex-list">
        {list.map((d) => (
          <div key={d.key} className="dex-entry">
            <h4>
              {d.name}
              <span className="chip xs">{DISH_KIND_LABEL[d.kind]}</span>
              <span className="chip xs">
                最好 {GRADE_LABEL[d.bestGrade]} <span className="code">{d.best}</span>
              </span>
              <span className="xs dim">做過 {d.count} 次</span>
            </h4>
            <p className="xs how">
              {COOK_STYLE_LABEL[d.how.style]}・{SAUCE_LABEL[d.how.sauce]}・下鍋順序：{d.how.order.join(' → ')}
              {Object.keys(d.how.seasoning).length ? `・調味：${Object.entries(d.how.seasoning).map(([k, v]) => `${SEASONINGS[k as keyof typeof SEASONINGS].label} ${Math.round((v ?? 0) * 10) / 10}`).join('、')}` : ''}
              {d.how.changes?.length ? `・${d.how.changes.join('、')}` : ''}
            </p>
          </div>
        ))}
      </div>
      {rec.shifts.length > 0 && (
        <>
          <div className="lbl">最近的班次</div>
          <table className="tbl">
            <tbody>
              {rec.shifts.slice(0, 8).map((x) => (
                <tr key={x.at}>
                  <td className="xs">{new Date(x.at).toLocaleString()}</td>
                  <td className="xs">{x.players} 人</td>
                  <td className="xs">出餐 {x.served}・跑單 {x.missed}</td>
                  <td className="code">平均 {x.avg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="actions">
        {confirm ? (
          <>
            <span className="xs">確定清除這台電腦上的所有紀錄？</span>
            <button className="btn small" onClick={() => (clearRecords(), setConfirm(false))}>清除</button>
            <button className="btn small" onClick={() => setConfirm(false)}>取消</button>
          </>
        ) : (
          <button className="btn small" disabled={!list.length && !rec.shifts.length} onClick={() => setConfirm(true)}>清除紀錄</button>
        )}
      </div>
    </>
  );
}

export function CookbookOverlay(): JSX.Element {
  const [tab, setTab] = useState<'recipes' | 'flavor' | 'score' | 'dex'>('recipes');
  return (
    <Shell icon="book" title="食譜與口味表" sub="招牌菜照標準做；也可以不照食譜自由發揮——系統會認出你做的是什麼、取名字、記進圖鑑。" onClose={close}>
      <div className="row tabs" role="tablist">
        <button className={`btn small ${tab === 'recipes' ? 'primary' : ''}`} role="tab" aria-selected={tab === 'recipes'} onClick={() => setTab('recipes')}>招牌菜</button>
        <button className={`btn small ${tab === 'flavor' ? 'primary' : ''}`} role="tab" aria-selected={tab === 'flavor'} onClick={() => setTab('flavor')}>口味表</button>
        <button className={`btn small ${tab === 'dex' ? 'primary' : ''}`} role="tab" aria-selected={tab === 'dex'} onClick={() => setTab('dex')}>料理圖鑑</button>
        <button className={`btn small ${tab === 'score' ? 'primary' : ''}`} role="tab" aria-selected={tab === 'score'} onClick={() => setTab('score')}>評分方式</button>
      </div>
      {tab === 'recipes' && <RecipeBook />}
      {tab === 'dex' && <Dex />}
      {tab === 'flavor' && (
        <>
          <p className="note">
            每份食材的味道會隨熟度改變：生的、熟的、上色（焦香）、燒焦。整道菜的口味＝所有食材的味道加上調味，再除以份量（份量越多，同樣的鹽越不鹹）。
            自選單的口味落在客人要的區間內就是滿分，每偏離 1 扣一半。
          </p>
          <table className="tbl flavor">
            <thead>
              <tr>
                <th>食材</th>
                <th>生</th>
                <th>熟</th>
                <th>上色</th>
                <th>份量</th>
              </tr>
            </thead>
            <tbody>
              {CATEGORY_ORDER.flatMap((cat) => [
                <tr key={`h-${cat}`} className="cat-row">
                  <th colSpan={5}>{CATEGORY_NAME[cat]}</th>
                </tr>,
                ...INGREDIENT_IDS.filter((id) => INGREDIENTS[id].category === cat).map((id) => {
                const d = INGREDIENTS[id];
                return (
                  <tr key={id} title={d.note}>
                    <td>
                      {d.label}
                      {d.note && <div className="xs dim">{d.note}</div>}
                    </td>
                    <td>{d.heat.rawOk || d.liquid ? flavorText(d.flavor.raw) : '不能生吃'}</td>
                    <td>{flavorText(d.flavor.cooked)}</td>
                    <td>{d.heat.brown > 0 ? flavorText(d.flavor.browned) : '—'}</td>
                    <td className="code">{d.mass}</td>
                  </tr>
                );
              }),
              ])}
            </tbody>
          </table>
          <table className="tbl">
            <thead>
              <tr>
                <th>調味料（每 1 匙）</th>
                <th>味道</th>
              </tr>
            </thead>
            <tbody>
              {SEASONING_IDS.map((id) => (
                <tr key={id}>
                  <td>{SEASONINGS[id].label}</td>
                  <td>{flavorText(SEASONINGS[id].flavor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="legend">燒焦的食材一律帶苦味；湯鍋焦底會讓整碗湯變苦。</p>
        </>
      )}
      {tab === 'score' && (
        <>
          <table className="tbl">
            <tbody>
              {(Object.keys(DEFAULT_WEIGHTS) as Array<keyof typeof DEFAULT_WEIGHTS>).map((c) => (
                <tr key={c}>
                  <td>{CATEGORY_LABEL[c]}</td>
                  <td className="code">{DEFAULT_WEIGHTS[c]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="blk-list">
            <li>食品安全是門檻，不是加分：雞肉中心溫度沒到 74°C，整道菜最多 30 分；碰過生肉砧板的生菜最多 40 分；過期食材最多 30 分。</li>
            <li>每一個扣分都會寫出原因，並附上那份食材的操作紀錄。</li>
            <li>出餐速度另外記錄（快、準時、慢），不會影響品質分數。</li>
            <li>怪物與客人不會改變任何料理規則：躲起來的時候，爐子上的東西照樣在煮。</li>
          </ul>
        </>
      )}
    </Shell>
  );
}

/* ------------------------------ 信號器 ------------------------------ */

const GROUPS: Array<{ title: string; tokens: SignalToken[] }> = [
  { title: '敲擊（聽覺）', tokens: ['TAP_S', 'TAP_L'] },
  { title: '燈號（視覺）', tokens: ['LIGHT_R', 'LIGHT_B', 'LIGHT_G', 'LIGHT_W'] },
  { title: '符號（視覺）', tokens: ['SYM_TRI', 'SYM_CIR', 'SYM_SQR', 'SYM_DIA', 'SYM_H', 'SYM_V'] },
  { title: '手勢（視覺）', tokens: ['GEST_HELP', 'GEST_DANGER', 'GEST_TAKE', 'GEST_WAIT', 'GEST_YES', 'GEST_NO', 'GEST_GO', 'GEST_LEFT', 'GEST_CENTER', 'GEST_RIGHT', 'GEST_AGAIN'] },
];

export function SignalOverlay(): JSX.Element | null {
  const me = useStore((s) => s.me?.role ?? null);
  const signals = useStore((s) => s.signals);
  const [queue, setQueue] = useState<SignalToken[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = useCallback((t: SignalToken) => {
    setQueue((q) => (q.length >= MAX_SIGNAL_LEN ? q : [...q, t]));
    audio.uiKey();
    speak(TOKEN_LABEL[t], { interrupt: true });
  }, []);

  const send = useCallback(async () => {
    if (!queue.length || busy) return;
    setBusy(true);
    const e = await emitSignal(queue);
    setBusy(false);
    if (e) {
      setMsg(e);
      speak(e);
    } else {
      setMsg(`已送出 ${queue.length} 個訊號。`);
      speak('已送出');
      audio.signalTokens(queue);
      setQueue([]);
    }
  }, [queue, busy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.matches?.('input,select,textarea')) return;
      if (e.code === 'KeyT') add('TAP_S');
      else if (e.code === 'KeyY') add('TAP_L');
      else if (e.code === 'Enter') {
        e.preventDefault();
        void send();
      } else if (e.code === 'Backspace') setQueue((q) => q.slice(0, -1));
      else if (e.code === 'Delete') setQueue([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [add, send]);

  if (!me) return null;
  const others = SEATS.filter((r) => r !== me && useStore.getState().room?.players.some((p) => p.role === r));
  const who = (t: SignalToken): string => {
    const deaf = others.filter((r) => !canPerceive(flawOfSeat(r), t));
    return deaf.length ? `${deaf.map((r) => `${r.slice(1)} 號`).join('、')}（耳背砧板）收不到` : '所有隊友都收得到';
  };

  return (
    <Shell icon="signal" title="信號器" sub="沒有自由文字。耳背砧板收不到敲擊；燈號、符號、手勢所有人都收得到。" onClose={close}>
      {GROUPS.map((g) => (
        <div key={g.title} className="ctrl">
          <div className="lbl">
            {g.title}　<span className="legend">{who(g.tokens[0])}</span>
          </div>
          <div className="palette">
            {g.tokens.map((t) =>
              TOKEN_COLOR[t] ? (
                <button key={t} className="tok lamp-tok" style={{ background: TOKEN_COLOR[t] }} onClick={() => add(t)} aria-label={TOKEN_LABEL[t]} title={TOKEN_LABEL[t]} />
              ) : (
                <button key={t} className={`tok ${TOKEN_CLASS[t] === 'audio' || g.title.startsWith('手勢') ? 'tap' : ''}`} onClick={() => add(t)} aria-label={TOKEN_LABEL[t]} title={TOKEN_LABEL[t]}>
                  <TokenGlyph t={t} size={20} />
                  {(TOKEN_CLASS[t] === 'audio' || g.title.startsWith('手勢')) && <span className="sm">{TOKEN_LABEL[t]}</span>}
                </button>
              ),
            )}
          </div>
        </div>
      ))}
      <div className="ctrl">
        <div className="lbl">
          待送出（最多 {MAX_SIGNAL_LEN} 個）
        </div>
        <div className="queue">
          {queue.length === 0 && <span className="sm dim">點選上方的訊號加入序列</span>}
          {queue.map((t, i) => (
            <TokenChip key={i} t={t} />
          ))}
        </div>
      </div>
      {msg && (
        <div className="result info">
          <Icon name="signal" size={18} />
          <span>{msg}</span>
        </div>
      )}
      <div className="actions">
        <button className="btn primary" disabled={!queue.length || busy} onClick={() => void send()}>
          送出（Enter）
        </button>
        <button className="btn" disabled={!queue.length} onClick={() => setQueue((q) => q.slice(0, -1))}>
          刪除最後一個（Backspace）
        </button>
        <button className="btn" disabled={!queue.length} onClick={() => setQueue([])}>
          清空（Delete）
        </button>
      </div>
      <p className="legend">快速鍵：<kbd>T</kbd> 短敲、<kbd>Y</kbd> 長敲。</p>
      {signals.length > 0 && (
        <div className="ctrl">
          <div className="lbl">最近收到</div>
          {signals.map((s) => (
            <div key={s.id} className="recv">
              <RoleGlyph role={s.from} size={18} />
              <span className="sm" style={{ minWidth: 56 }}>{useStore.getState().room?.players.find((p) => p.role === s.from)?.name ?? s.from}</span>
              {s.tokens.map((t, i) => (
                <TokenChip key={i} t={t} />
              ))}
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

/* ------------------------------ 說明／提示／設定 ------------------------------ */

function VolumeSlider({ label, k, max = 1 }: { label: string; k: 'volume' | 'envVolume' | 'echoVolume' | 'navVolume' | 'voiceVolume' | 'musicVolume'; max?: number }): JSX.Element {
  const v = useStore((s) => s.prefs[k]);
  return (
    <label className="slider">
      {label}
      <input type="range" min={0} max={max} step={0.05} value={v} onChange={(e) => {
        const n = Number(e.target.value);
        useStore.getState().setPrefs({ [k]: n });
        if (k === 'volume') audio.setVolume(n);
      }} />
      <span>{Math.round(v * 100)}</span>
    </label>
  );
}

/** 音訊設定與校準。環境音、指引音與隊友語音的音量分開調整 */
export function AudioSettings({ blind }: { blind: boolean }): JSX.Element {
  const prefs = useStore((s) => s.prefs);
  return (
    <>
      <VolumeSlider label="總音量" k="volume" />
      <VolumeSlider label="背景音樂" k="musicVolume" />
      <VolumeSlider label="環境音與地標" k="envVolume" max={1.5} />
      {blind && <VolumeSlider label="設備指引音" k="navVolume" max={1.5} />}
      <VolumeSlider label="隊友語音" k="voiceVolume" max={1.5} />
      <div className="row sm calibrate">
        <span>音訊校準：</span>
        <button className="btn small" onClick={() => void audio.init().then(() => audio.testChannel('left'))}>左聲道</button>
        <button className="btn small" onClick={() => void audio.init().then(() => audio.testChannel('right'))}>右聲道</button>
        <button className="btn small" onClick={() => void audio.init().then(() => audio.testChannel('both'))}>兩邊（音量）</button>
      </div>
      <label className="row sm">
        <input type="checkbox" checked={prefs.mono} onChange={(e) => useStore.getState().setPrefs({ mono: e.target.checked })} />
        單聲道模式（只有一個喇叭、或左右聲道聽起來一樣時使用）
      </label>
      <label className="row sm">
        <input type="checkbox" checked={prefs.beacon} onChange={(e) => useStore.getState().setPrefs({ beacon: e.target.checked })} />
        工作站指引音（無障礙：附近工作站的「滴」聲，音高代表種類）
      </label>
    </>
  );
}

function useTick(ms: number): void {
  const [, set] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** 房主模式：存檔、暫停、上次存檔的時間；應用程式的房主還有邀請朋友 */
function HostControls(): JSX.Element | null {
  const hostMode = useStore((s) => s.hostMode);
  const me = useStore((s) => s.me);
  const room = useStore((s) => s.room);
  const [msg, setMsg] = useState<string | null>(null);
  useTick(1000);
  if (!hostMode) return null;
  const savedAt = room?.savedAt ?? null;
  const ago = savedAt ? Math.max(0, Math.round((Date.now() - savedAt) / 1000)) : null;
  const isHost = !!me?.isHost;
  return (
    <>
      <div className="blk-heading">房主模式</div>
      <p className="note">
        這一局開在{isHost ? '你的' : '房主的'}電腦上，每 30 秒自動存檔一次{ago !== null ? `（上次存檔：${ago < 60 ? `${ago} 秒前` : `${Math.round(ago / 60)} 分鐘前`}）` : ''}。
        {isHost ? '你可以隨時手動存檔或暫停；關閉程式時也會自動存一份。下次在起始頁面按「繼續遊戲」，大家用同樣的暱稱加入就能接著玩。' : '只有房主可以存檔與暫停。'}
      </p>
      {isHost && (
        <div className="row wrap">
          <button className="btn small primary" onClick={() => void saveGame().then((e) => setMsg(e ?? '存檔完成。'))}>
            💾 立刻存檔
          </button>
          <button className="btn small" disabled={!!room?.waiting} onClick={() => void pauseGame().then((e) => setMsg(e ?? '已暫停：大家按「準備好了」就繼續。'))}>
            ⏸ 暫停班次
          </button>
        </div>
      )}
      {msg && <p className="xs">{msg}</p>}
      {isHost && hostBridge && room && <InviteCard code={room.code} compact />}
    </>
  );
}

export function CoopList(): JSX.Element {
  return (
    <ul className="blk-list">
      <li>交接：面對隊友按 <kbd>E</kbd> →「遞給他」；他在 4 秒內按 <kbd>F</kbd> 接住，兩人都要在 1.8 公尺內、他要空手。</li>
      <li>拍肩：1.8 公尺內，可以附一個符號；被拍的人畫面邊緣會出現指向你的箭頭。</li>
      <li>便條：在工作站面板貼「待處理／已備料／等待烹飪／完成」；工作站內容一變，便條會自動標成過期。</li>
      <li>覆誦：3 公尺內把一張單念給隊友（健忘助手會因此記住它）。</li>
      <li>試吃回報：自己試吃之後，把嚐到的味道回報給隊友（內容就是你實際嚐到的，不能改）。</li>
      <li>標記：<kbd>G</kbd> 標記工作站、訂單板裡標記訂單；隊友看得到是誰標的，可以回應。</li>
      <li>接住：隊友手上的東西快掉了（頭上出現「快掉了」），在 1.8 公尺內按 <kbd>F</kbd>。</li>
      <li>扶穩：單手廚師要打蛋、盛湯時，站在工作站旁按「幫忙扶穩」（8 秒內有效，走開就放手）。</li>
      <li>接管爐子：嗜睡學徒遠端照看的爐子，你站在前面按「接管」就換你顧。</li>
      <li>交接架：冷藏室門口、爐台旁各一個，任何人都能放、拿（給進不去或不方便拿的人接手）。</li>
      <li>碗盤：客人吃完約 25 秒，髒盤送回「回收窗口」；拿到水槽碗盤架洗好，就回到裝盤區。</li>
    </ul>
  );
}

/** 威脅一覽 */
export function ThreatList(): JSX.Element {
  return (
    <ul className="blk-list">
      <li>那位沒有點餐的客人：有人看著他時，他不會動。他靠近廚房時，站到他面前按 <kbd>E</kbd> 請他回座位。監視器也算「看著」。</li>
      <li>後門的東西：廚房越吵（切菜、鍋鏟碰撞、跑步、回聲），牠越快來。進來前會在後門外<b>刮門 6 秒</b>——這時到監視器<b>鎖上後門</b>，牠就進不來。</li>
      <li>進來之後，牠追<b>最近的人</b>（隔著牆也知道你在哪），每 20 秒換追另一個人。躲進置物櫃、跑進餐廳（牠不進餐廳）可以甩掉牠；跑步比牠快。</li>
      <li>被抓到會被拖進冷藏室的鐵籠（手上的東西還在）：隊友撬開 2.5 秒；也可以自己按 <kbd>{K('interact')}</kbd> 搖開鐵籠——沒有隊友能救時 7 秒、有隊友時 18 秒，而且很吵，怪物可能會回來。</li>
      <li>牠每次最多待 <b>40 秒</b>，畫面上方看得到還剩幾秒；快到時會低吼，然後從後門離開。</li>
      <li><b>反制</b>：看著牠按 <kbd>T</kbd> 把手上的食材丟過去，砸中會讓牠愣住 3 秒；到監視器按 <kbd>3</kbd>（或右鍵）打開緊急照明，強光把牠逼回後門（90 秒充電）。不想要怪物，可以在大廳勾「沒有怪物」。</li>
      <li>監視器的門禁（兩個共用 45 秒冷卻）：<b>鎖後門</b>＝牠還沒進來（包括刮門的 6 秒）時擋 20 秒；<b>關防火門</b>＝牠在後走廊或側走廊時關，牠撞門 2.5 秒後放棄離開。</li>
      <li>躲進置物櫃也能擋住牠；牠不會進餐廳。</li>
      <li>它們只會打斷你的工作，不會改變料理的規則。</li>
    </ul>
  );
}

/** 畫面與操作的設定（起始頁面的設定頁與遊戲中的說明共用） */
export function DisplaySettings(): JSX.Element {
  const prefs = useStore((s) => s.prefs);
  return (
    <>
      <label className="slider">
        介面大小
        <input type="range" min={0.8} max={1.6} step={0.05} value={prefs.uiScale ?? 1.1} onChange={(e) => useStore.getState().setPrefs({ uiScale: Number(e.target.value) })} />
        <span>{Math.round((prefs.uiScale ?? 1.1) * 100)}%</span>
      </label>
      <label className="slider">
        畫面亮度
        <input type="range" min={0.8} max={1.8} step={0.05} value={prefs.brightness ?? 1.2} onChange={(e) => useStore.getState().setPrefs({ brightness: Number(e.target.value) })} />
        <span>{Math.round((prefs.brightness ?? 1.2) * 100)}%</span>
      </label>
      <label className="row sm">
        <input type="checkbox" checked={prefs.flicker ?? true} onChange={(e) => useStore.getState().setPrefs({ flicker: e.target.checked })} />
        燈光閃爍（怪物靠近、停電時；關掉後改用畫面上方的文字提示）
      </label>
      <label className="slider">
        滑鼠靈敏度
        <input type="range" min={0.3} max={2.5} step={0.05} value={prefs.sensitivity} onChange={(e) => useStore.getState().setPrefs({ sensitivity: Number(e.target.value) })} />
        <span>{prefs.sensitivity.toFixed(2)}</span>
      </label>
      <label className="row sm">
        <input type="checkbox" checked={prefs.retro} onChange={(e) => useStore.getState().setPrefs({ retro: e.target.checked })} />
        復古低解析度畫面（PS1 風格）
      </label>
      <label className="row sm">
        <input type="checkbox" checked={prefs.speech} onChange={(e) => {
          useStore.getState().setPrefs({ speech: e.target.checked });
          setSpeechEnabled(e.target.checked);
        }} />
        語音播報（無障礙：工作站名稱、面板文字、通知）
      </label>
    </>
  );
}

export function HelpOverlay(): JSX.Element | null {
  useKeymap();
  const me = useStore((s) => s.me);
  const prefs = useStore((s) => s.prefs);
  const flaw = useStore(() => myFlaw());
  if (!me?.role || !flaw) return null;
  const card = FLAW_CARDS[flaw];

  return (
    <Shell icon="help" title="說明與設定" sub={`你是${card.name}：${card.tagline}`} onClose={close}>
      <HostControls />
      <div className="blk-heading">你的缺陷卡</div>
      <FlawDetail flaw={flaw} />

      <div className="blk-heading">操作</div>
      <div className="note">
        <kbd>{K('forward')}{K('left')}{K('back')}{K('right')}</kbd> 移動、<kbd>{K('run')}</kbd> 跑（很吵）、<kbd>{K('crouch')}</kbd> 蹲下（安靜、怪物比較難看到你）、滑鼠轉向、
        <b>滑鼠左鍵</b> 看著工作站「拿／放」、<b>右鍵</b>「使用」（開關火、開始烤、清洗、攪拌、拿盤子；準星旁會提示），
        <kbd>{K('interact')}</kbd> 面對工作站打開它（再按一次或直接走開就關閉）／面對隊友打開隊友面板（拍肩、遞東西、覆誦、試吃回報）・被關進鐵籠時自己掙脫、
        <kbd>{K('handoff')}</kbd> 接住隊友遞來的東西（或隊友手上快掉的東西）、<kbd>{K('pickup')}</kbd> 撿起地上的東西（奶油手：穩住手上的東西）、
        <kbd>{K('ability')}</kbd> 缺陷卡的技能（召集、氣味警告、雙爐面板）、<kbd>{K('route')}</kbd> 在地上畫路線箭頭、<kbd>{K('reply')}</kbd> 回應召集、<kbd>{K('mark')}</kbd> 標記注視中的工作站、
        <kbd>{K('tickets')}</kbd> 訂單板（傳聞、準備提示、標記訂單）、<kbd>{K('cookbook')}</kbd> 食譜與口味表、<kbd>{K('signals')}</kbd> 信號器、<kbd>{K('help')}</kbd> 本頁、<kbd>{K('calibrate')}</kbd> 音訊校準
        {flaw !== 'D04' && <>、<kbd>{K('mute')}</kbd> 麥克風靜音</>}。
        物品欄在畫面下方：<b>左手、右手、菜籃 2 格</b>（菜籃只放還沒處理的原料）。亮起來的是目前用的手；兩隻手都拿著東西時按 <kbd>{K('swap')}</kbd> 或滾動滑鼠滾輪換手。
        動作要用的東西在另一隻手時會自動換過去；放下目前的手之後，菜籃先補、再改用另一隻手。貨箱、一疊髒盤要用雙手。單手廚師只有一隻手。
        注視冷藏架／乾貨架時按 <kbd>1</kbd>–<kbd>7</kbd> 直接拿（<kbd>Shift</kbd>＋數字一次拿滿）。
        面板裡用滑鼠點按鈕、按數字鍵，或用 <kbd>Tab</kbd> 移動、<kbd>空白鍵</kbd> 按下。
      </div>
      <details className="kb-details">
        <summary>自訂按鍵</summary>
        <KeyBindings />
      </details>

      <div className="blk-heading">互助（所有人都能用；伺服器實際判定）</div>
      <CoopList />

      <div className="blk-heading">廚房裡的威脅</div>
      <ThreatList />

      <div className="blk-heading">語音</div>
      <MicSetup flaw={flaw} />

      <div className="blk-heading">設定</div>
      <AudioSettings blind />
      <DisplaySettings />

      <div className="blk-heading">房間</div>
      <div className="row">
        {me.isHost && (
          <button className="btn" onClick={() => { if (confirm('確定要讓全隊回到大廳、重新開一班嗎？')) void restartGame(); }}>
            重新開始（全隊）
          </button>
        )}
        <button className="btn danger" onClick={() => { if (confirm('確定要離開房間嗎？隊友將無法繼續。')) leaveRoom(); }}>
          離開房間
        </button>
      </div>
    </Shell>
  );
}

export function Overlays(): JSX.Element | null {
  const overlay = useStore((s) => s.overlay);
  const station = useStore((s) => s.station);
  if (station) return null;
  if (overlay === 'tickets') return <TicketsOverlay />;
  if (overlay === 'cookbook') return <CookbookOverlay />;
  if (overlay === 'signals') return <SignalOverlay />;
  if (overlay === 'help') return <HelpOverlay />;
  if (overlay === 'dual') return <DualOverlay onClose={close} />;
  return null;
}

export { toggleOverlay };
