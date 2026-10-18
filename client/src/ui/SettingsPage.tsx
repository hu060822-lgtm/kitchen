import { useEffect, useState } from 'react';
import { desktop, hostBridge } from '../platform';
import { KeyBindings } from './KeyBindings';
import { BackToTitle, SheetHead } from './Menu';
import { AudioSettings, DisplaySettings } from './Overlays';
import { useHostInfo } from './InviteCard';

/** 設定（起始頁面）：聲音、畫面與操作、按鍵；應用程式另外有連線與個人資料 */
export default function SettingsPage(): JSX.Element {
  return (
    <div className="screen">
      <div className="sheet">
        <SheetHead right={<BackToTitle />} />
        <section className="sec">
          <div className="sec-label">
            <h3>聲音</h3>
            <p>怪物和客人的方位靠聲音判斷，建議戴耳機先校準左右聲道。</p>
          </div>
          <div className="sec-body stack settings-body">
            <AudioSettings blind />
          </div>
        </section>
        <section className="sec">
          <div className="sec-label">
            <h3>畫面與操作</h3>
          </div>
          <div className="sec-body stack settings-body">
            <DisplaySettings />
            {desktop && <p className="dim xs">F11 切換全螢幕。</p>}
          </div>
        </section>
        <section className="sec">
          <div className="sec-label">
            <h3>按鍵</h3>
            <p>每個動作可以設兩個鍵。遊戲中按 H 也能改。</p>
          </div>
          <div className="sec-body">
            <KeyBindings />
          </div>
        </section>
        {hostBridge && <DesktopSettings />}
      </div>
    </div>
  );
}

function DesktopSettings(): JSX.Element {
  const info = useHostInfo();
  const [url, setUrl] = useState('');
  const [lan, setLan] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [restart, setRestart] = useState(false);
  useEffect(() => {
    if (!info) return;
    setUrl((u) => u || info.onlineUrl);
    setLan(info.lan);
    // 只在第一次拿到資料時填入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.onlineUrl]);

  const run = async (fn: () => Promise<unknown>, ok?: (v: unknown) => string | null) => {
    setMsg(null);
    try {
      const v = await fn();
      const t = ok?.(v);
      if (t) setMsg({ text: t });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    }
  };

  const saveConn = (p: { onlineUrl?: string; lan?: boolean }) =>
    run(
      () => hostBridge!.setSettings(p),
      (v) => {
        const r = v as { settings: { onlineUrl: string }; restartNeeded: boolean };
        setUrl(r.settings.onlineUrl);
        setRestart(r.restartNeeded);
        return r.restartNeeded ? '區網模式要重新開啟程式後才會生效。' : '已儲存。';
      },
    );

  return (
    <>
      <section className="sec">
        <div className="sec-label">
          <h3>連線</h3>
          <p>一般不用改。</p>
        </div>
        <div className="sec-body stack settings-body">
          <div className="field" style={{ maxWidth: 520 }}>
            <label htmlFor="online-url">線上伺服器（網頁版、房間代碼查詢處）</label>
            <div className="row">
              <input id="online-url" type="text" className="mono-input" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
              <button className="btn small" onClick={() => void saveConn({ onlineUrl: url })}>
                儲存
              </button>
              <button
                className="btn small"
                onClick={() => {
                  setMsg({ text: '檢查中…（線上伺服器剛醒來時要等一下）' });
                  void hostBridge!.checkOnline().then((r) => setMsg({ text: r.message, bad: !r.ok }));
                }}
              >
                測試連線
              </button>
            </div>
            <p className="dim xs">要和朋友用房間代碼一起玩，這裡要填你在 Render 上的網址（而且要是最新版）。</p>
          </div>
          <label className="row sm">
            <input
              type="checkbox"
              checked={lan}
              onChange={(e) => {
                setLan(e.target.checked);
                void saveConn({ lan: e.target.checked });
              }}
            />
            區網模式：同一個網路的電腦可以直接連到你開的房間（沒有網際網路時用；Windows 防火牆會詢問一次）
          </label>
          {restart && (
            <div className="row">
              <button className="btn small primary" onClick={() => void run(() => hostBridge!.relaunch())}>
                重新開啟程式
              </button>
            </div>
          )}
        </div>
      </section>
      <section className="sec">
        <div className="sec-label">
          <h3>個人資料</h3>
          <p>設定、按鍵、料理圖鑑與委託紀錄存在這台電腦裡。換電腦時匯出再匯入。</p>
        </div>
        <div className="sec-body stack">
          <div className="row">
            <button className="btn small" onClick={() => void run(() => hostBridge!.exportData(), (p) => (p ? `已匯出到 ${p}` : null))}>
              匯出個人資料…
            </button>
            <button className="btn small" onClick={() => void run(() => hostBridge!.importData(), (ok) => (ok ? '已匯入。' : null))}>
              匯入個人資料…
            </button>
            <button className="btn small" onClick={() => void run(() => hostBridge!.openDataFolder())}>
              打開資料夾
            </button>
          </div>
          {info && <p className="dim xs code">{info.dataDir}</p>}
        </div>
      </section>
      {msg && (
        <p className={msg.bad ? 'err settings-msg' : 'dim sm settings-msg'} role="status">
          {msg.text}
        </p>
      )}
    </>
  );
}
