import { ENDLESS_BY_ID, endlessDay, type EndlessDay } from '@last-table/shared';
import { useStore } from '../state/store';

/** 無盡模式：今天的設定（房間裡記著第幾天與這一輪的種子；考驗由同一個函式算出來） */
export function useEndlessToday(): EndlessDay | null {
  const room = useStore((s) => s.room);
  if (!room?.endless) return null;
  const seats = room.players.filter((p) => p.role).length || 1;
  return endlessDay(room.endless.day, room.endless.seed, seats);
}

/** 今天的考驗（開班前的說明、打烊的結算都用） */
export function EndlessChallenges({ today }: { today: EndlessDay }): JSX.Element {
  return (
    <ul className="blk-list endless-list">
      {today.challenges.map((id) => (
        <li key={id}>
          <b>{ENDLESS_BY_ID[id].title}</b>：{ENDLESS_BY_ID[id].text}
        </li>
      ))}
      <li className="dim">跑單超過 {today.missLimit} 張，這一輪就結束。</li>
    </ul>
  );
}

/** 開班前：無盡模式的第幾天與今天的考驗 */
export function EndlessIntro({ today, best }: { today: EndlessDay; best: number }): JSX.Element {
  return (
    <div className="night-intro endless-intro">
      <div className="night-no">
        無盡模式・第 {today.day} 天{best ? `（紀錄：撐過 ${best} 天）` : ''}
      </div>
      <h3>今天的考驗</h3>
      <p className="night-text">每天抽幾個隨機的考驗，天數越多，考驗越多、越難；後門外的東西和那位客人也一天比一天難纏。</p>
      <EndlessChallenges today={today} />
    </div>
  );
}
