import { useEffect, useRef, useState } from 'react';
import { desktop, hostBridge, type SaveEntry } from '../platform';
import { useStore } from '../state/store';
import { NullWordmark } from './icons';
import { goPage, savedName } from './Menu';
import { startTutorial } from '../net/socket';
import { tutorialDone } from './TutorialCard';
import { getCampaign } from '../state/campaign';
import { NIGHT_COUNT } from '@last-table/shared';

/**
 * 起始頁面：出餐口剛印出來的一張單，掛在保溫燈下。單上的每一行就是選單。
 *   開始遊戲／繼續遊戲（應用程式）／設定／說明／離開（應用程式）
 */

const PHASE: Record<string, string> = { PREP: '備料中', SERVICE: '營業中', CLOSED: '已打烊' };
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

interface Item {
  id: string;
  label: string;
  note?: string;
  disabled?: boolean;
  run: () => void;
}

export default function Title(): JSX.Element {
  const [latest, setLatest] = useState<SaveEntry | null | undefined>(hostBridge ? undefined : null);
  const [now, setNow] = useState(clock);
  const list = useRef<HTMLUListElement>(null);
  const reconnecting = useStore((s) => s.reconnecting);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    hostBridge
      ?.saves()
      .then((s) => setLatest(s[0] ?? null))
      .catch(() => setLatest(null));
    const t = window.setInterval(() => setNow(clock()), 15_000);
    return () => clearInterval(t);
  }, []);

  const items: Item[] = [{ id: 'play', label: '開始遊戲', note: '開新房間，或輸入代碼加入朋友', run: () => goPage('play') }];
  if (hostBridge) {
    items.push({
      id: 'continue',
      label: '繼續遊戲',
      note: latest ? `${latest.night ? `第 ${latest.night} 晚　` : ''}${latest.endless ? `無盡模式第 ${latest.endless} 天　` : ''}${latest.code}　${PHASE[latest.phase] ?? latest.phase} ${pad(Math.floor(latest.shiftSec / 60))}:${pad(latest.shiftSec % 60)}　${ago(latest.savedAt)}` : latest === null ? '還沒有存檔' : '…',
      disabled: !latest,
      run: () => goPage('continue'),
    });
  }
  items.push({
    id: 'tutorial',
    label: '教學',
    note: tutorialDone() ? '再走一次「第一班」' : '第一次玩？5 分鐘學會基本操作',
    run: () => {
      setBusy('正在準備教學…');
      void startTutorial(savedName() || '見習廚師').then((e) => setBusy(e));
    },
  });
  {
    const c = getCampaign();
    items.push({
      id: 'journal',
      label: '營業日誌',
      note: c.ending === 'served' ? '七個晚上都結束了' : `連續七晚：可以玩到第 ${c.unlocked} 晚，已讀 ${c.fragments.length + c.outros.length}／${NIGHT_COUNT * 2} 張`,
      run: () => goPage('journal'),
    });
  }
  items.push({ id: 'settings', label: '設定', note: '聲音、畫面、按鍵', run: () => goPage('settings') });
  items.push({ id: 'help', label: '說明', note: '怎麼玩、缺陷卡、威脅', run: () => goPage('help') });

  let exit: Item | null = null;
  if (hostBridge) exit = { id: 'quit', label: '離開', run: () => void hostBridge!.quit() };
  else if (desktop) exit = { id: 'home', label: '回到自己的起始頁面', run: () => desktop!.home() };

  // ↑↓ 在單上移動（Tab 也可以），Enter 選
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const btns = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!btns.length) return;
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
    btns[i < 0 ? 0 : next].focus();
    e.preventDefault();
  };

  const row = (it: Item, first = false) => (
    <li key={it.id}>
      <button className="mt-item" disabled={it.disabled} onClick={it.run} autoFocus={first}>
        <span className="ti-label">{it.label}</span>
        {it.note && <span className="ti-note">{it.note}</span>}
      </button>
    </li>
  );

  return (
    <div className="title-screen">
      <div className="title-lamp" aria-hidden />
      <header className="title-brand">
        <NullWordmark height={112} className="title-wordmark" />
        <h1 className="title-name">最後一桌</h1>
        <p className="title-tag">午夜之後的最後一班。1–8 人一起顧店，每個人都帶著一個缺陷。</p>
      </header>

      <div className="mt-rail" aria-hidden />
      <nav className="mt-wrap" aria-label="主選單">
        <div className="mt" onKeyDown={onKey}>
          <div className="mt-head">
            <span>NULL 餐廳</span>
            <span>最後一班 {now}</span>
          </div>
          <ul ref={list} className="mt-list">
            {items.map((it, i) => row(it, i === 0))}
            {exit && <li className="mt-cut" aria-hidden />}
            {exit && row(exit)}
          </ul>
          {(reconnecting || busy) && <p className="mt-foot">{reconnecting ? '正在回到原本的房間…' : busy}</p>}
        </div>
      </nav>

      <footer className="title-foot">
        <span>{desktop ? `Windows 版 ${desktop.version}` : '網頁版'}</span>
        <span>建議戴耳機：怪物在哪裡，要用聽的。</span>
      </footer>
    </div>
  );
}
