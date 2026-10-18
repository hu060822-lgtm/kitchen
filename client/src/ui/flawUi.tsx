import { FLAW_CARDS, FLAW_IDS, SEAT_INFO, type FlawId, type Seat } from '@last-table/shared';
import { useStore } from '../state/store';

/**
 * 席位與缺陷卡的共用介面元件。
 * 席位用「編號＋識別色」，缺陷卡用「卡號＋名稱」——一律有文字，不只靠顏色或圖示。
 */

export function SeatBadge({ seat, size = 20 }: { seat: Seat; size?: number }): JSX.Element {
  const info = SEAT_INFO[seat];
  return (
    <span className="seat-badge" style={{ width: size, height: size, fontSize: Math.round(size * 0.58), background: info.color }} title={`${info.letter} 號位`} aria-label={`${info.letter} 號位`}>
      {info.letter}
    </span>
  );
}

export function FlawBadge({ flaw, short = false }: { flaw: FlawId | null | undefined; short?: boolean }): JSX.Element {
  if (!flaw) return <span className="flaw-badge none">未選卡</span>;
  const c = FLAW_CARDS[flaw];
  return (
    <span className="flaw-badge" title={`${c.id} ${c.name}：${c.tagline}`}>
      <span className="code">{c.id}</span>
      {!short && <span>{c.name}</span>}
    </span>
  );
}

/** 某個席位的玩家名稱（沒有就用編號） */
export function useSeatName(): (s: Seat) => string {
  const players = useStore((s) => s.room?.players);
  return (s: Seat) => players?.find((p) => p.role === s)?.name ?? SEAT_INFO[s].name;
}

/** 卡片完整內容：缺口、補償、互助、高光 */
export function FlawDetail({ flaw, compact = false }: { flaw: FlawId; compact?: boolean }): JSX.Element {
  const c = FLAW_CARDS[flaw];
  return (
    <div className={`flaw-detail ${compact ? 'compact' : ''}`}>
      <dl>
        <dt>能力缺口</dt>
        <dd>
          <ul>{c.limitation.map((x) => <li key={x}>{x}</li>)}</ul>
        </dd>
        <dt>補償優勢</dt>
        <dd>
          <ul>{c.compensation.map((x) => <li key={x}>{x}</li>)}</ul>
        </dd>
        <dt>隊友怎麼幫你</dt>
        <dd>
          <ul>{c.cooperationHooks.map((x) => <li key={x}>{x}</li>)}</ul>
        </dd>
        {!compact && (
          <>
            <dt>高光時刻</dt>
            <dd>{c.heroMoment}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** 首頁的卡片總表（16 張；未開放的標出預計階段） */
export function FlawTable(): JSX.Element {
  return (
    <table className="roster">
      <thead>
        <tr>
          <th>卡</th>
          <th>定位</th>
          <th>一句話</th>
          <th>狀態</th>
        </tr>
      </thead>
      <tbody>
        {FLAW_IDS.map((id) => {
          const c = FLAW_CARDS[id];
          return (
            <tr key={id} className={c.available ? '' : 'dim'}>
              <td>
                <FlawBadge flaw={id} />
              </td>
              <td className="sm">{c.role}</td>
              <td className="sm">{c.tagline}</td>
              <td className="sm">{c.available ? '可選' : `Phase ${c.phase}`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
