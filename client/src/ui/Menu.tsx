import { useEffect, useRef, useState } from 'react';
import { MAX_PLAYERS } from '@last-table/shared';
import { createRoom, startTutorial } from '../net/socket';
import { markTutorialDone, tutorialDone } from './TutorialCard';
import { findAndJoin, looksLikeAddress } from '../net/findRoom';
import { useStore, type Page } from '../state/store';
import { desktop, hostBridge, kv } from '../platform';
import { NullMark, NullWordmark } from './icons';

const NAME_KEY = 'last-table.name';
export const savedName = (): string => kv.get(NAME_KEY) ?? '';

export function SheetHead({ right }: { right?: React.ReactNode }): JSX.Element {
  return (
    <div className="sheet-head">
      <div>
        <div className="mark">
          <NullMark size={44} />
          <NullWordmark height={40} />
        </div>
        <div className="title">最後一桌・合作烹飪與恐怖</div>
        <div className="sub">1–8 人一起顧一間深夜的餐廳。每個人都有一張缺陷卡：做不好的事、比別人強的地方，以及隊友能實際幫你的操作。</div>
      </div>
      {right}
    </div>
  );
}

export const goPage = (page: Page): void => useStore.getState().set({ page, error: null });

/** 起始頁面以外的頁面右上角：回到起始頁面 */
export function BackToTitle(): JSX.Element {
  return (
    <button className="btn small" onClick={() => goPage('title')}>
      ← 回到起始頁面
    </button>
  );
}

/** 開始遊戲：開新房間（和朋友一起／自己一個人）或用代碼加入 */
export default function Menu(): JSX.Element {
  const pending = useStore((s) => s.pendingJoin);
  const [name, setName] = useState(() => pending?.name ?? savedName());
  const [code, setCode] = useState(pending?.code ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const error = useStore((s) => s.error);
  const reconnecting = useStore((s) => s.reconnecting);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const auto = useRef(false);
  // 沒玩過教學、也不是被邀請來的：先建議走一遍教學
  const [showIntro, setShowIntro] = useState(() => !tutorialDone() && !pending);

  const go = async (fn: (n: string) => Promise<string | null>): Promise<void> => {
    const n = name.trim();
    if (!n) {
      setErr('請先填寫暱稱。');
      nameRef.current?.focus();
      return;
    }
    kv.set(NAME_KEY, n);
    setBusy(true);
    setErr(null);
    useStore.getState().set({ error: null });
    const e = await fn(n);
    setBusy(false);
    setStatus(null);
    if (e) setErr(e);
  };

  const join = () => void go((n) => findAndJoin(n, code, setStatus));
  const withFriends = () =>
    void go(async (n) => {
      const e = await createRoom(n);
      if (e) return e;
      await hostBridge?.invite().catch(() => undefined);
      return null;
    });
  const alone = () => void go((n) => createRoom(n));
  const online = () => void go(async (n) => (await hostBridge!.go(desktop!.onlineUrl, { create: true, name: n }), null));

  // 邀請連結（?join=）或從別的伺服器轉過來：有暱稱就直接加入，沒有就停在暱稱欄
  useEffect(() => {
    if (auto.current || !pending) return;
    auto.current = true;
    useStore.getState().set({ pendingJoin: null });
    if (!pending.name) {
      nameRef.current?.focus();
      return;
    }
    if (pending.create) void go((n) => createRoom(n));
    else if (pending.code) void go((n) => findAndJoin(n, pending.code!, setStatus));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canJoin = code.length === 6 || looksLikeAddress(code);
  const remote = desktop && desktop.mode !== 'host';

  return (
    <div className="screen">
      <div className="sheet">
        <SheetHead
          right={
            <div className="docmeta">
              <div>
                人數 <b>1–{MAX_PLAYERS}</b> 人（單人也能玩）
              </div>
              <div>建議 耳機＋麥克風</div>
              <div style={{ marginTop: 8 }}>
                <BackToTitle />
              </div>
            </div>
          }
        />

        {showIntro && (
          <section className="sec intro-sec">
            <div className="sec-label">
              <h3>第一次玩？</h3>
            </div>
            <div className="sec-body">
              <p className="note">先走一遍「第一班」：一個人、沒有時間壓力，做一道煎蛋吐司，最後認識店裡的兩個威脅。大約 5 分鐘，中途隨時可以跳過。</p>
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const e = await startTutorial(name.trim() || '見習廚師');
                    setBusy(false);
                    if (e) setErr(e);
                  }}
                >
                  開始教學
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    markTutorialDone();
                    setShowIntro(false);
                  }}
                >
                  不用，我會玩
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="sec">
          <div className="sec-label">
            <h3>暱稱</h3>
            <p>隊友看到的名字。讀檔接著玩時，用同樣的暱稱回到原本的位置。</p>
          </div>
          <div className="sec-body">
            <div className="field" style={{ maxWidth: 360 }}>
              <label htmlFor="name">暱稱（1–16 字）</label>
              <input id="name" ref={nameRef} type="text" maxLength={16} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：Luz" autoFocus={!pending?.code} />
            </div>
          </div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <h3>開新房間</h3>
            <p>{hostBridge ? '房間開在這台電腦上，可以存檔，下次從「繼續遊戲」接著玩。' : '開好之後，把房間代碼告訴朋友。'}</p>
          </div>
          <div className="sec-body">
            {hostBridge ? (
              <>
                <div className="choice-row">
                  <button className="choice primary" disabled={busy} onClick={withFriends}>
                    <b>和朋友一起</b>
                    <span>開房後把房間代碼告訴朋友，他們在任何地方輸入代碼就能加入。</span>
                  </button>
                  <button className="choice" disabled={busy} onClick={alone}>
                    <b>自己一個人</b>
                    <span>只有這台電腦。之後想找朋友，在大廳按「邀請朋友」也可以。</span>
                  </button>
                </div>
                <button className="linkish" disabled={busy} onClick={online}>
                  改用線上伺服器開房（不能存檔；你的電腦連不上通道時用）
                </button>
              </>
            ) : (
              <div className="row">
                <button className="btn primary" disabled={busy || !!remote} onClick={alone}>
                  建立房間
                </button>
                {remote && <span className="dim sm">你現在在朋友的伺服器上。要自己開房，請先回到起始頁面。</span>}
              </div>
            )}
          </div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <h3>加入朋友的房間</h3>
            <p>輸入朋友給你的 6 碼房間代碼。朋友用網頁版或應用程式開的房間都可以。</p>
          </div>
          <div className="sec-body stack">
            <div className="row">
              <input
                ref={codeRef}
                className={looksLikeAddress(code) ? 'addr' : 'code'}
                type="text"
                maxLength={64}
                placeholder="______"
                aria-label="房間代碼"
                autoFocus={!!pending?.code && !pending.name}
                value={code}
                onChange={(e) => {
                  const v = e.target.value;
                  setCode(looksLikeAddress(v) ? v.trim() : v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
                }}
                onKeyDown={(e) => e.key === 'Enter' && canJoin && join()}
              />
              <button className="btn primary" disabled={busy || !canJoin} onClick={join}>
                加入
              </button>
            </div>
            <p className="dim xs">區網模式或代碼找不到時，也可以直接輸入房主給的網址（例如 http://192.168.1.5:38401）。</p>
            <div className="err" role="alert">
              {reconnecting ? '正在回到原本的房間…' : status ? <span className="dim">{status}</span> : (err ?? error ?? '')}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
