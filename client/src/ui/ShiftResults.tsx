import { useEffect } from 'react';
import { FLAW_CARDS, NIGHT_COUNT, nightDef } from '@last-table/shared';
import { speak } from '../audio/speech';
import { leaveRoom, playEndless, playNight, restartGame } from '../net/socket';
import { recordEndless, recordNightEnd, useCampaign } from '../state/campaign';
import { EndlessChallenges, useEndlessToday } from './EndlessUi';
import { useStore } from '../state/store';
import { orderDish } from './kitchenText';
import { ResultCard } from './StationPanel';

/**
 * 打烊：整班的結算。品質分數與效率分開列，每一道菜附上原因與操作紀錄。
 * 恐怖事件（被抓、被救）只是統計，不影響任何分數。
 */
export default function ShiftResults(): JSX.Element | null {
  const k = useStore((s) => s.kitchen);
  const me = useStore((s) => s.me);
  const closed = k?.phase === 'CLOSED';
  const served = k?.orders.filter((o) => o.status === 'served' && o.result) ?? [];
  const avg = served.length ? Math.round(served.reduce((a, o) => a + (o.result?.total ?? 0), 0) / served.length) : 0;

  useEffect(() => {
    if (!closed || !me?.role || !k) return;
    speak(`打烊了。出了 ${k.stats.served} 道菜，平均 ${avg} 分，跑了 ${k.stats.missed} 張單。`, { interrupt: true });
    if (document.pointerLockElement) document.exitPointerLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed]);

  useEffect(() => {
    if (closed && document.pointerLockElement) document.exitPointerLock();
  }, [closed]);

  // 連續七晚：打烊＝這一晚的結尾讀過了，下一晚解鎖
  const nightN = k?.night?.night ?? 0;
  const storyEnd = k?.night?.story === 'served' ? 'served' : k?.night?.story === 'missed' ? 'missed' : null;
  useEffect(() => {
    if (closed && nightN) recordNightEnd(nightN, storyEnd);
  }, [closed, nightN, storyEnd]);

  // 無盡模式：跑單沒超過上限＝撐過了這一天
  const today = useEndlessToday();
  const camp = useCampaign();
  const survived = !!today && !!k && k.stats.missed <= today.missLimit;
  useEffect(() => {
    if (closed && today && survived) recordEndless(today.day);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed, today?.day, survived]);

  if (!k || !closed) return null;
  const fast = served.filter((o) => o.result?.efficiency === 'fast').length;
  const slow = served.filter((o) => o.result?.efficiency === 'slow').length;

  return (
    <div className="results">
      <div className="slip">
        <header>
          <div className="xs">NULL・最後一桌</div>
          <h1>打烊</h1>
          <div className="xs dim">本班結算</div>
        </header>
        <dl className="totals">
          <dt>出餐</dt>
          <dd className="code">{k.stats.served}</dd>
          <dt>平均品質</dt>
          <dd className="code">{avg}</dd>
          <dt>跑單</dt>
          <dd className="code">{k.stats.missed}</dd>
          <dt>效率（另計）</dt>
          <dd className="code">
            快 {fast}・準時 {served.length - fast - slow}・慢 {slow}
          </dd>
          <dt>被拖走／救回／自己掙脫</dt>
          <dd className="code">
            {k.stats.trapped}／{k.stats.rescued}／{k.stats.escaped ?? 0}
          </dd>
        </dl>
        <div className="crew-flaws">
          {useStore.getState().room?.players.map((p) => (
            <span key={p.id} className="chip xs">
              {p.name}：{p.flaw ? `${p.flaw} ${FLAW_CARDS[p.flaw].name}` : '—'}
            </span>
          ))}
        </div>
        <div className="orders">
          {k.orders.map((o) =>
            o.result ? (
              <ResultCard key={o.id} r={o.result} />
            ) : o.status === 'missed' ? (
              <p key={o.id} className="missed">
                #{o.table} {orderDish(o)}：客人等太久離開了。
              </p>
            ) : null,
          )}
        </div>
        {nightN > 0 && <NightOutro night={nightN} ending={storyEnd} />}
        {today && (
          <div className="night-outro endless-outro">
            <div className="xs dim">無盡模式・第 {today.day} 天</div>
            <p>
              {survived
                ? `撐過了第 ${today.day} 天（跑單 ${k.stats.missed}／${today.missLimit}）。明天會更難。`
                : `跑了 ${k.stats.missed} 張單，超過上限 ${today.missLimit} 張：這一輪在第 ${today.day} 天結束。`}
              {camp.endlessBest ? ` 紀錄：撐過 ${camp.endlessBest} 天。` : ''}
            </p>
            <EndlessChallenges today={today} />
          </div>
        )}
        <div className="actions">
          {me?.isHost && today && survived && (
            <button className="btn primary" onClick={() => void playEndless(true)}>
              第 {today.day + 1} 天
            </button>
          )}
          {me?.isHost && today && (
            <button className={`btn ${survived ? '' : 'primary'}`} onClick={() => void playEndless(false)}>
              從第 1 天重新開始
            </button>
          )}
          {me?.isHost && nightN > 0 && nightN < NIGHT_COUNT && (
            <>
              <button className="btn primary" onClick={() => void playNight(nightN + 1)}>
                第 {nightN + 1} 晚：{nightDef(nightN + 1)?.title}
              </button>
              <button className="btn" onClick={() => void playNight(nightN)}>
                再玩一次第 {nightN} 晚
              </button>
            </>
          )}
          {me?.isHost && nightN === NIGHT_COUNT && storyEnd !== 'served' && (
            <button className="btn primary" onClick={() => void playNight(nightN)}>
              再試一次第 {nightN} 晚
            </button>
          )}
          {me?.isHost && (
            <button className={`btn ${nightN || today ? '' : 'primary'}`} onClick={() => void restartGame()}>
              {nightN || today ? '回到大廳' : '再開一班（回到大廳）'}
            </button>
          )}
          {!me?.isHost && <span className="sm dim">等房主決定要不要再開一班。</span>}
          <button className="btn" onClick={() => leaveRoom()}>
            離開房間
          </button>
        </div>
      </div>
    </div>
  );
}

/** 連續七晚：打烊後的一段（第七晚依那位客人的菜有沒有送到，結尾不同） */
function NightOutro({ night, ending }: { night: number; ending: 'served' | 'missed' | null }): JSX.Element | null {
  const def = nightDef(night);
  if (!def) return null;
  const text = night === NIGHT_COUNT && ending !== 'served' ? (def.outroMissed ?? def.outro) : def.outro;
  return (
    <div className="night-outro">
      <div className="xs dim">
        第 {night} 晚・{def.title}
      </div>
      <p>{text}</p>
      {night === NIGHT_COUNT && ending === 'served' && <p className="xs dim">七個晚上結束了。營業日誌已經完整。</p>}
    </div>
  );
}
