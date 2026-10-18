import { useState } from 'react';
import { FLAW_CARDS, FLAW_IDS, MAX_PLAYERS, type FlawId } from '@last-table/shared';
import { audio } from '../audio/engine';
import { leaveRoom, selectFlaw, setEndless, setNight, setNoMonster, startGame } from '../net/socket';
import { NIGHT_COUNT, nightDef } from '@last-table/shared';
import { useCampaign } from '../state/campaign';
import { useStore } from '../state/store';
import { FlawBadge, FlawDetail, SeatBadge } from './flawUi';
import { SheetHead } from './Menu';
import MicSetup from './MicSetup';
import { hostBridge } from '../platform';
import { CopyInviteLink, InviteCard } from './InviteCard';

export default function Lobby(): JSX.Element | null {
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [peek, setPeek] = useState<FlawId | null>(null);
  if (!room || !me) return null;

  const mine = room.players.find((p) => p.id === me.id)?.flaw ?? null;
  const pick = async (f: FlawId): Promise<void> => {
    setErr(null);
    const e = await selectFlaw(mine === f ? null : f);
    if (e) setErr(e);
    void audio.init();
  };
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 不支援剪貼簿 */
    }
  };
  const unpicked = room.players.filter((p) => !p.flaw).length;
  const shown = peek ?? mine;

  return (
    <div className="screen">
      <div className="sheet">
        <SheetHead
          right={
            <div className="stack" style={{ alignItems: 'flex-end', gap: 6 }}>
              <span className="code-box" aria-label="房間代碼">{room.code}</span>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn small" onClick={() => void copy()}>
                  {copied ? '已複製代碼' : '複製代碼'}
                </button>
                {!hostBridge && <CopyInviteLink code={room.code} />}
              </div>
            </div>
          }
        />

        <NightPicker />

        {hostBridge && me.isHost && (
          <section className="sec">
            <div className="sec-label">
              <h3>邀請朋友</h3>
              <p>房間開在你的電腦上。</p>
            </div>
            <div className="sec-body">
              <InviteCard code={room.code} />
            </div>
          </section>
        )}

        <section className="sec">
          <div className="sec-label">
            <div className="no">1</div>
            <h3>成員</h3>
            <p>
              {room.players.length}／{MAX_PLAYERS} 人。一個人也能開店；人越多，單越多。
            </p>
          </div>
          <div className="sec-body">
            <div className="players">
              {room.players.map((p) => (
                <div key={p.id} className="player">
                  <span className={`dot ${p.connected ? '' : 'off'}`} title={p.connected ? '在線' : '離線'} />
                  <span className="row" style={{ gap: 8 }}>
                    {p.role && <SeatBadge seat={p.role} />}
                    <b>{p.name}</b>
                    {p.id === me.id && <span className="tag">你</span>}
                    {p.isHost && <span className="tag">房主</span>}
                  </span>
                  <FlawBadge flaw={p.flaw} />
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="sec" style={{ display: 'block' }}>
          <div className="sec-label" style={{ borderRight: 0, paddingBottom: 14 }}>
            <div className="no">2</div>
            <h3>選一張缺陷卡</h3>
            <p>每張卡都有做不好的事、比別人強的地方，以及隊友能實際幫你的操作。可以和別人選同一張；再按一次取消。</p>
          </div>
          <div className="flaw-grid">
            {FLAW_IDS.map((id) => {
              const c = FLAW_CARDS[id];
              const holders = room.players.filter((p) => p.flaw === id);
              const isMine = mine === id;
              return (
                <button
                  key={id}
                  className={`flaw-card ${isMine ? 'mine' : ''} ${c.available ? '' : 'locked'}`}
                  disabled={!c.available}
                  aria-pressed={isMine}
                  onClick={() => void pick(id)}
                  onMouseEnter={() => c.available && setPeek(id)}
                  onMouseLeave={() => setPeek(null)}
                  onFocus={() => c.available && setPeek(id)}
                  onBlur={() => setPeek(null)}
                >
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="code">{c.id}</span>
                    <span className="xs dim">{c.available ? c.role.split('／')[0] : `Phase ${c.phase}・即將推出`}</span>
                  </div>
                  <h3>{c.name}</h3>
                  <div className="sm dim">{c.tagline}</div>
                  {holders.length > 0 && <div className="xs held">{holders.map((h) => (h.id === me.id ? '你' : h.name)).join('、')}</div>}
                </button>
              );
            })}
          </div>
          {shown && (
            <div className="flaw-preview">
              <h4>
                <FlawBadge flaw={shown} /> <span className="dim sm">{FLAW_CARDS[shown].role}</span>
              </h4>
              <FlawDetail flaw={shown} />
            </div>
          )}
          <div className="err" role="alert" style={{ padding: '0 32px' }}>{err}</div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <div className="no">3</div>
            <h3>語音</h3>
            <p>遊戲內語音所有人互通；沉默侍者不能發話。</p>
          </div>
          <div className="sec-body">
            <MicSetup flaw={mine} />
          </div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <div className="no">4</div>
            <h3>開始</h3>
          </div>
          <div className="sec-body row">
            <p className="note grow">
              {room.canStart ? '每個人都選好卡了。' : unpicked ? `還有 ${unpicked} 人沒選卡。` : '等待玩家上線。'}
              {me.isHost ? '' : '由房主按下開始。'}
            </p>
            {me.isHost && (
              <button
                className="btn primary"
                disabled={!room.canStart}
                onClick={async () => {
                  void audio.init();
                  const e = await startGame();
                  if (e) setErr(e);
                }}
              >
                開始營業
              </button>
            )}
            <button className="btn danger" onClick={leaveRoom}>
              離開房間
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

/** 這一班要玩什麼：單班，或連續七晚的第幾晚（房主選；其他人看得到） */
function NightPicker(): JSX.Element | null {
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me);
  const camp = useCampaign();
  const [err, setErr] = useState<string | null>(null);
  if (!room || !me) return null;
  const endless = !!room.endless;
  const cur = endless ? -1 : (room.night ?? 0);
  const pick = async (n: number) => {
    setErr(null);
    const e = n < 0 ? await setEndless() : await setNight(n);
    if (e) setErr(e);
  };
  const def = nightDef(cur);
  return (
    <section className="sec">
      <div className="sec-label">
        <h3>今晚</h3>
        <p>連續七晚：每晚多一點變化，中間會讀到這間店的故事。無盡模式：每天隨機的考驗，看你們能撐幾天。</p>
      </div>
      <div className="sec-body">
        {me.isHost ? (
          <div className="night-pick" role="radiogroup" aria-label="今晚">
            <button role="radio" aria-checked={cur === 0} className={`night-opt ${cur === 0 ? 'on' : ''}`} onClick={() => void pick(0)}>
              <b>單班</b>
              <span>一般的一班，不接故事</span>
            </button>
            <button role="radio" aria-checked={endless} className={`night-opt endless-opt ${endless ? 'on' : ''}`} onClick={() => void pick(-1)}>
              <b>無盡模式</b>
              <span>{camp.endlessBest ? `每天隨機的考驗・紀錄 ${camp.endlessBest} 天` : '每天隨機的考驗，越來越難'}</span>
            </button>
            {Array.from({ length: NIGHT_COUNT }, (_, i) => i + 1).map((n) => {
              const locked = n > Math.max(camp.unlocked, cur);
              return (
                <button key={n} role="radio" aria-checked={cur === n} disabled={locked} className={`night-opt ${cur === n ? 'on' : ''}`} onClick={() => void pick(n)}>
                  <b>第 {n} 晚</b>
                  <span>{locked ? '還沒到' : nightDef(n)?.title}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="note">{endless ? '房主選了無盡模式。' : cur ? `房主選了第 ${cur} 晚「${def?.title}」。` : '房主選了單班。'}</p>
        )}
        <label className="row sm monster-toggle">
          <input type="checkbox" checked={!!room.noMonster} disabled={!me.isHost} onChange={(e) => void setNoMonster(e.target.checked).then((x) => x && setErr(x))} />
          沒有怪物（後門外的東西不會出現；那位客人照常）{!me.isHost && '・房主決定'}
        </label>
        {err && <p className="err">{err}</p>}
      </div>
    </section>
  );
}
