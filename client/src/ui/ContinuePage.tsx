import { useCallback, useEffect, useState } from 'react';
import { resumeSession } from '../net/socket';
import { hostBridge, type SaveEntry } from '../platform';
import { BackToTitle, SheetHead } from './Menu';

/** 繼續遊戲（應用程式）：讀檔，房間代碼不變，大家用同樣的暱稱回到原本的位置 */

const KIND: Record<SaveEntry['kind'], string> = { auto: '自動', manual: '手動', exit: '關閉時', closed: '打烊時' };
const PHASE: Record<string, string> = { PREP: '備料中', SERVICE: '營業中', CLOSED: '已打烊' };
const pad = (n: number) => String(n).padStart(2, '0');
const when = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function ContinuePage(): JSX.Element | null {
  const [list, setList] = useState<SaveEntry[] | null>(null);
  const [friends, setFriends] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const refresh = useCallback(async () => {
    if (!hostBridge) return;
    const s = await hostBridge.saves().catch(() => []);
    setList(s);
    // 預設：存檔裡不只一個人 → 讀檔後邀請朋友
    setFriends((f) => (f === null ? (s[0]?.players.length ?? 1) > 1 : f));
  }, []);
  useEffect(() => void refresh(), [refresh]);

  if (!hostBridge) return null;

  const act = async (fn: () => Promise<unknown>, ok?: (v: unknown) => string | null): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const v = await fn();
      const t = ok?.(v);
      if (t) setMsg({ text: t });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const load = (s: SaveEntry) =>
    act(async () => {
      const session = await hostBridge!.load(s.file, !!friends);
      await resumeSession(session);
    });

  return (
    <div className="screen">
      <div className="sheet">
        <SheetHead right={<BackToTitle />} />
        <section className="sec">
          <div className="sec-label">
            <h3>繼續遊戲</h3>
            <p>讀檔後班次停在存檔的那一刻，大家按「準備好了」才繼續。朋友用原本的暱稱加入，就會回到原本的位置（手上的東西、缺陷卡都在）。</p>
          </div>
          <div className="sec-body">
            <label className="row sm" style={{ marginBottom: 12 }}>
              <input type="checkbox" checked={!!friends} onChange={(e) => setFriends(e.target.checked)} />
              讀檔後邀請朋友（朋友輸入同一個房間代碼就能回來）
            </label>
            {list === null ? (
              <p className="dim sm">讀取中…</p>
            ) : list.length === 0 ? (
              <p className="dim sm">還沒有存檔。開一間房間玩一班，班次進行中每 30 秒會自動存檔。</p>
            ) : (
              <table className="roster saves-table">
                <thead>
                  <tr>
                    <th>存檔時間</th>
                    <th>房間</th>
                    <th>班次</th>
                    <th>成績</th>
                    <th>成員</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((s, i) => (
                    <tr key={s.file}>
                      <td className="code nowrap">
                        {when(s.savedAt)}
                        <div className="dim xs">{KIND[s.kind]}存檔</div>
                      </td>
                      <td className="code">{s.code}</td>
                      <td className="nowrap">
                        {s.night ? <div className="xs">第 {s.night} 晚</div> : null}
                        {PHASE[s.phase] ?? s.phase} {pad(Math.floor(s.shiftSec / 60))}:{pad(s.shiftSec % 60)}
                      </td>
                      <td className="nowrap">
                        出餐 {s.served}，漏單 {s.missed}
                      </td>
                      <td>{s.players.map((p) => p.name + (p.host ? '（房主）' : '')).join('、')}</td>
                      <td className="nowrap actions">
                        <button className={`btn small ${i === 0 ? 'primary' : ''}`} disabled={busy} onClick={() => void load(s)}>
                          讀檔
                        </button>
                        <button className="btn small" disabled={busy} onClick={() => void act(() => hostBridge!.exportSave(s.file), (p) => (p ? `已匯出到 ${p}` : null))}>
                          匯出
                        </button>
                        <button className="btn small danger" disabled={busy} onClick={() => void act(() => hostBridge!.removeSave(s.file), (d) => (d ? '已刪除存檔。' : null))}>
                          刪除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn small" disabled={busy} onClick={() => void act(() => hostBridge!.importSaves(), (f) => ((f as string[]).length ? `已匯入 ${(f as string[]).length} 個存檔。` : null))}>
                匯入存檔…
              </button>
              <button className="btn small" onClick={() => void act(() => hostBridge!.openSaveFolder())}>
                打開存檔資料夾
              </button>
            </div>
            {msg && (
              <p className={msg.bad ? 'err' : 'dim sm'} role="status" style={{ marginTop: 10 }}>
                {msg.text}
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
