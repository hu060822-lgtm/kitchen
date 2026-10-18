import { keyLabel } from '../game/keymap';
import { useEffect } from 'react';
import { FLAW_CARDS, TOKEN_LABEL, type SignalToken } from '@last-table/shared';
import { coop } from '../net/socket';
import { closeMate } from '../game/loop';
import { remotes } from '../game/remote';
import { pose } from '../game/controller';
import { useStore } from '../state/store';
import { FlawBadge, SeatBadge, useSeatName } from './flawUi';
import { orderDish } from './kitchenText';

const TAP_TOKENS: Array<SignalToken | null> = [null, 'GEST_DANGER', 'GEST_HELP', 'GEST_TAKE', 'GEST_WAIT'];

/**
 * 隊友面板：面對隊友按 E。所有互助都是伺服器判定的實際操作（距離、冷卻、手上的東西都會檢查）。
 * 走開或按 E／Esc 就關閉。
 */
export default function MatePanel(): JSX.Element | null {
  const seat = useStore((s) => s.mate);
  const k = useStore((s) => s.kitchen);
  const me = useStore((s) => s.me?.role ?? null);
  const nameOf = useSeatName();

  // 走遠就關閉（與工作站面板一樣）
  useEffect(() => {
    if (!seat) return;
    const t = window.setInterval(() => {
      const rp = remotes[seat];
      if (!rp || Math.hypot(rp.x - pose.x, rp.z - pose.z) > 3.2) closeMate(false);
    }, 250);
    return () => clearInterval(t);
  }, [seat]);

  // 數字鍵：1–5 拍肩（附符號）、6 遞給他
  useEffect(() => {
    if (!seat) return;
    const onKey = (e: KeyboardEvent): void => {
      const m = /^Digit(\d)$/.exec(e.code);
      if (!m) return;
      const n = Number(m[1]);
      if (n >= 1 && n <= TAP_TOKENS.length) void coop('tap', { to: seat, ...(TAP_TOKENS[n - 1] ? { token: TAP_TOKENS[n - 1] } : {}) });
      if (n === 6) void coop('handoff', { to: seat });
      if (n === 7) void coop('taste_report', { to: seat });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [seat]);

  if (!seat || !k || !me) return null;
  const flaw = k.coop.flaws[seat] ?? null;
  const card = flaw ? FLAW_CARDS[flaw] : null;
  const myHeld = k.players[me]?.held;
  const theirHeld = k.players[seat]?.held;
  const pending = k.coop.handoffs.find((h) => h.from === me && h.to === seat);
  const incoming = k.coop.handoffs.find((h) => h.from === seat && h.to === me);
  const cd = k.self?.cooldowns;
  const tapReady = !cd || cd.tap <= k.t;
  const open = k.orders.filter((o) => o.status === 'open' && !o.forgotten);

  return (
    <div className="panel mate-panel" role="dialog" aria-label={`隊友：${nameOf(seat)}`}>
      <header className="row" style={{ gap: 10 }}>
        <SeatBadge seat={seat} size={26} />
        <div className="grow">
          <b>{nameOf(seat)}</b> <FlawBadge flaw={flaw} />
          <div className="xs dim">{theirHeld || k.players[seat]?.other ? `手上：${[theirHeld, k.players[seat]?.other].filter(Boolean).map((h) => (h!.kind === 'plate' ? '盤子' : h!.kind === 'item' ? '食材' : h!.kind === 'measure' ? '量好的調味料' : h!.kind === 'dirty' ? '髒盤' : '貨箱')).join('、')}` : '空手'}</div>
        </div>
        <button className="btn small" onClick={() => closeMate()}>
          關閉 <kbd>{keyLabel('interact')}</kbd>
        </button>
      </header>
      {card && (
        <p className="sm note">
          怎麼幫{card.name}：{card.cooperationHooks[0]}
        </p>
      )}
      {k.coop.wobbles.some((w) => w.seat === seat) && (
        <div className="row">
          <span className="grow warnline">他手上的東西快掉了！</span>
          <button className="btn primary" disabled={!!myHeld} onClick={() => void coop('catch', { to: seat })}>
            接住 <kbd>F</kbd>
          </button>
        </div>
      )}
      {k.coop.drowsy.some((d) => d.seat === seat && d.state === 'asleep') && <p className="warnline sm">他睡著了：拍一下就會醒。</p>}
      {incoming && (
        <div className="row">
          <span className="grow">他要把{incoming.what}遞給你</span>
          <button className="btn primary" onClick={() => void coop('handoff_accept', { offerId: incoming.id })}>
            接住 <kbd>F</kbd>
          </button>
        </div>
      )}
      <div className="blk-heading">拍肩{!tapReady && '（冷卻中）'}</div>
      <div className="row wrap">
        {TAP_TOKENS.map((t, i) => (
          <button key={t ?? 'none'} className="btn small" disabled={!tapReady} onClick={() => void coop('tap', { to: seat, ...(t ? { token: t } : {}) })}>
            <kbd>{i + 1}</kbd> {t ? TOKEN_LABEL[t] : '拍一下'}
          </button>
        ))}
      </div>
      <div className="blk-heading">交接</div>
      <div className="row wrap">
        {pending ? (
          <>
            <span className="grow sm">等他接住{pending.what}…</span>
            <button className="btn small" onClick={() => void coop('handoff_cancel', { offerId: pending.id })}>
              收回
            </button>
          </>
        ) : (
          <button className="btn" disabled={!myHeld} onClick={() => void coop('handoff', { to: seat })}>
            <kbd>6</kbd> 把手上的東西遞給他
          </button>
        )}
        <button className="btn" onClick={() => void coop('taste_report', { to: seat })} title="先在裝盤區或湯鍋試吃，再回報">
          <kbd>7</kbd> 回報我剛剛試吃的味道
        </button>
      </div>
      {open.length > 0 && (
        <>
          <div className="blk-heading">覆誦一張單{flaw === 'D15' && '（他是健忘助手：覆誦會幫他記住 45 秒）'}</div>
          <div className="row wrap">
            {open.map((o) => (
              <button key={o.id} className="btn small" onClick={() => void coop('recite', { to: seat, orderId: o.id })}>
                {o.table} 號桌・{orderDish(o)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
