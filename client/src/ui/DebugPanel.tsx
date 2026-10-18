import { useCallback, useEffect, useState } from 'react';
import { type DebugCommand, type DebugState } from '@last-table/shared';
import { debugCommand, fetchDebugState } from '../net/socket';

/**
 * 開發者工具。
 * 只有伺服器開啟 DEBUG_TOOLS（或非 production）時才會出現；正式環境的玩家既看不到面板，伺服器也會拒絕指令。
 * 按 ` 開關。
 */
const COMMANDS: Array<[DebugCommand, string, string?]> = [
  ['skip_prep', '跳過備料'],
  ['restock', '補滿庫存'],
  ['spawn_guest', '叫出客人'],
  ['spawn_monster', '叫出怪物'],
  ['monster_grab_me', '被怪物抓（過場）'],
  ['guest_off', '關掉客人'],
  ['spill_here', '在面前灑一灘水'],
  ['monster_off', '怪物離開'],
  ['sleepy', '嗜睡學徒快睡著'],
  ['sneeze_soon', '定時噴嚏快打噴嚏'],
  ['end_shift', '直接打烊'],
  ['reinit_room', '重新初始化房間', 'danger'],
];

export default function DebugPanel(): JSX.Element {
  const [state, setState] = useState<DebugState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const r = await fetchDebugState();
    if (typeof r === 'string') setErr(r);
    else {
      setErr(null);
      setState(r);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (cmd: DebugCommand): Promise<void> => {
    setBusy(true);
    const e = await debugCommand(cmd);
    setBusy(false);
    if (e) setErr(e);
    void refresh();
  };

  return (
    <aside className="debug plate interactive" aria-label="開發者工具">
      <header>
        <b>開發者工具</b>
        <span className="xs dim">僅開發環境・按 ` 關閉</span>
      </header>
      {err && <div className="status error">{err}</div>}
      {state && (
        <div className="body">
          <dl>
            <dt>階段</dt>
            <dd className="code">
              {state.phase}　t={(state.t / 1000).toFixed(1)}s
            </dd>
            <dt>玩家</dt>
            <dd>
              {Object.entries(state.roles).map(([name, role]) => (
                <span key={name} className="chip">
                  {name}：{role ?? '—'}・{state.flaws[name] ?? '未選卡'}
                </span>
              ))}
            </dd>
          </dl>
          <div className="lbl">缺陷卡遙測（flawTelemetry）</div>
          <pre>{JSON.stringify(state.telemetry, null, 1)}</pre>
          <div className="lbl">怪物</div>
          <pre>{JSON.stringify(state.monster, null, 1)}</pre>
          <div className="lbl">客人</div>
          <pre>{JSON.stringify(state.guest, null, 1)}</pre>
          <div className="lbl">最近操作</div>
          <ol className="recent">
            {state.recent
              .slice()
              .reverse()
              .map((r, i) => (
                <li key={i} className={r.ok ? '' : 'bad'}>
                  <span className="code">{(r.at / 1000).toFixed(1)}s</span> {r.role} {r.stationId}/{r.action}：{r.message}
                </li>
              ))}
          </ol>
        </div>
      )}
      <div className="actions">
        {COMMANDS.map(([cmd, label, kind]) => (
          <button key={cmd} className={`btn small ${kind ?? ''}`} disabled={busy} onClick={() => void run(cmd)}>
            {label}
          </button>
        ))}
      </div>
    </aside>
  );
}
