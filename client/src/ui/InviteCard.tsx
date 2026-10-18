import { useEffect, useState } from 'react';
import { hostBridge, inviteLink, type HostInfo } from '../platform';

/** 應用程式：這台電腦的伺服器狀態（邀請、房間、存檔），變化時主程式會推過來 */
export function useHostInfo(): HostInfo | null {
  const [info, setInfo] = useState<HostInfo | null>(null);
  useEffect(() => {
    if (!hostBridge) return;
    let alive = true;
    hostBridge
      .info()
      .then((i) => alive && setInfo(i))
      .catch(() => undefined);
    const off = hostBridge.onChange((i) => setInfo(i));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return info;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (hostBridge) await hostBridge.copy(text);
    else await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 複製邀請連結（網頁版、應用程式都可以用） */
export function CopyInviteLink({ code, label = '複製邀請連結' }: { code: string; label?: string }): JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn small"
      onClick={() =>
        void copyText(inviteLink(code)).then((ok) => {
          if (!ok) return;
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        })
      }
    >
      {done ? '已複製' : label}
    </button>
  );
}

/**
 * 房主（應用程式）的邀請卡：按一次「邀請朋友」，朋友在任何地方輸入房間代碼就能加入。
 * compact＝遊戲中的說明頁（H）裡的精簡版。
 */
export function InviteCard({ code, compact = false }: { code: string; compact?: boolean }): JSX.Element | null {
  const info = useHostInfo();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!hostBridge || !info) return null;
  const inv = info.invite;
  const t = inv.tunnel;
  const listed = inv.codes.includes(code) && inv.relay === 'ok';

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  let body: JSX.Element;
  if (!inv.on) {
    body = (
      <>
        <p className="invite-line">現在只有這台電腦進得來。</p>
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => void run(() => hostBridge!.invite())}>
            邀請朋友
          </button>
          {!compact && <span className="dim xs">朋友在任何地方輸入房間代碼就能加入。第一次會下載 Cloudflare 的免費通道程式（約 50 MB）。</span>}
        </div>
      </>
    );
  } else if (t.state === 'downloading') {
    const pct = Math.round(t.progress * 100);
    body = (
      <>
        <p className="invite-line">第一次使用：下載通道程式… {pct}%</p>
        <div className="invite-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${pct}%` }} />
        </div>
      </>
    );
  } else if (t.state === 'error') {
    body = (
      <>
        <p className="invite-line warn">{t.error ?? '通道出了問題。'}</p>
        <div className="row">
          <button className="btn small" disabled={busy} onClick={() => void run(() => hostBridge!.retryInvite())}>
            再試一次
          </button>
          <button className="btn small" disabled={busy} onClick={() => void run(() => hostBridge!.stopInvite())}>
            停止邀請
          </button>
        </div>
      </>
    );
  } else if (listed) {
    body = (
      <>
        <p className="invite-line big">
          朋友輸入代碼 <b className="code">{code}</b> 就能加入
        </p>
        {!compact && <p className="dim sm">打開《最後一桌》（應用程式或網頁版）→ 開始遊戲 → 輸入房間代碼。也可以把邀請連結貼給他們，點開就會帶入代碼。</p>}
        <div className="row">
          <CopyInviteLink code={code} />
          <button className="btn small" disabled={busy} onClick={() => void run(() => hostBridge!.stopInvite())}>
            停止邀請
          </button>
        </div>
      </>
    );
  } else if (t.state === 'ready' && inv.relay === 'error') {
    body = (
      <>
        <p className="invite-line warn">房間代碼登記不上：{inv.relayError}</p>
        <p className="dim xs">修好之前會每 45 秒自動再試一次。</p>
        <p className="dim sm">等不及的話，朋友可以直接打開這個網址：</p>
        <div className="row">
          <span className="code invite-url">{t.url}</span>
          <button className="btn small" onClick={() => void copyText(t.url!)}>
            複製網址
          </button>
        </div>
      </>
    );
  } else {
    body = <p className="invite-line">正在開放邀請…（通常 10–30 秒）</p>;
  }

  return (
    <div className={`invite ${compact ? 'compact' : ''}`} aria-live="polite">
      {body}
      {info.lan && info.lanUrls.length > 0 && !compact && (
        <p className="dim xs">
          區網模式：同一個網路的朋友也可以在「加入」輸入 <span className="code">{info.lanUrls[0]}</span>
        </p>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
