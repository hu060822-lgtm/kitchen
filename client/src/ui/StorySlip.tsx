import { useEffect, useState } from 'react';
import { useStore } from '../state/store';

/**
 * 連續七晚：出單機印出的「不是訂單的單」。從畫面右上方印出來，不擋操作；
 * 收起來之後在起始頁面的「營業日誌」裡還讀得到。結尾的那一張比較大，打烊結算也會再印一次。
 */
export default function StorySlip(): JSX.Element | null {
  const slip = useStore((s) => s.storySlip);
  const [shownAt, setShownAt] = useState(0);
  useEffect(() => {
    if (!slip) return;
    setShownAt(Date.now());
    // 一般的碎片 45 秒後自己收起來（結尾的不會）
    if (slip.ending) return;
    const t = window.setTimeout(() => useStore.getState().set({ storySlip: null }), 45_000);
    return () => clearTimeout(t);
  }, [slip]);
  if (!slip) return null;
  return (
    <aside key={shownAt} className={`story-slip interactive ${slip.ending ? 'ending' : ''}`} role="status" aria-live="polite">
      <div className="ss-head">
        <span>{slip.ending ? '最後一桌' : '出單機印出了一張不是訂單的單'}</span>
        <span>第 {slip.night} 晚</span>
      </div>
      <h3>{slip.title}</h3>
      <p>{slip.text}</p>
      <button className="ss-close" onClick={() => useStore.getState().set({ storySlip: null })}>
        收起來（營業日誌裡還讀得到）
      </button>
    </aside>
  );
}
