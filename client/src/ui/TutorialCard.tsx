import { useEffect } from 'react';
import { STATION_BY_ID, TUTORIAL_STEP_BY_ID, type TutorialStepId } from '@last-table/shared';
import { audio } from '../audio/engine';
import { keyLabel, type KeyAction } from '../game/keymap';
import { requestLock } from '../game/loop';
import { leaveRoom, tutorialAck } from '../net/socket';
import { kv } from '../platform';
import { useStore } from '../state/store';

/**
 * 教學關的說明卡（畫面左側）。步驟由伺服器依廚房的實際狀態判定；
 * 「打開訂單板／食譜」這種伺服器看不到的事，由這裡偵測到之後回報。
 */

export const TUTORIAL_DONE_KEY = 'last-table.tutorialDone';
export const markTutorialDone = (): void => kv.set(TUTORIAL_DONE_KEY, '1');
export const tutorialDone = (): boolean => kv.get(TUTORIAL_DONE_KEY) === '1';

/** 把 {interact} 之類換成目前的按鍵 */
function renderText(text: string): Array<string | JSX.Element> {
  const out: Array<string | JSX.Element> = [];
  let last = 0;
  const re = /\{([a-z]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<kbd key={m.index}>{keyLabel(m[1] as KeyAction)}</kbd>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 教學結束：離開教學房間，到開始遊戲或起始頁面 */
export function exitTutorial(to: 'play' | 'title'): void {
  markTutorialDone();
  leaveRoom();
  useStore.getState().set({ page: to });
}

export default function TutorialCard(): JSX.Element | null {
  const tut = useStore((s) => s.kitchen?.tutorial);
  const overlay = useStore((s) => s.overlay);
  const role = useStore((s) => s.me?.role ?? null);
  const trapped = useStore((s) => (role ? s.kitchen?.players[role]?.status === 'trapped' : false));
  const step: TutorialStepId | null = tut?.step ?? null;
  const def = step ? TUTORIAL_STEP_BY_ID[step] : null;

  // 打開訂單板／食譜：回報伺服器
  useEffect(() => {
    if (!def?.ack) return;
    if ((def.ack === 'tickets' && overlay === 'tickets') || (def.ack === 'cookbook' && overlay === 'cookbook')) tutorialAck(def.id);
  }, [def, overlay]);

  // 「開始」也可以按 Enter
  useEffect(() => {
    if (def?.ack !== 'button') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        begin(def.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [def]);

  useEffect(() => {
    if (step === 'done') markTutorialDone();
  }, [step]);

  if (!tut || !def) return null;
  const done = def.id === 'done';
  const target = def.target ? STATION_BY_ID[def.target]?.label : null;

  return (
    <aside className="tut-card interactive" aria-live="polite">
      <div className="tut-head">
        <span>教學・第一班</span>
        <span>
          {tut.index + 1}／{tut.total}
        </span>
      </div>
      <h3 className="tut-title">{def.title}</h3>
      <p className="tut-text">{renderText(def.text)}</p>
      {target && !done && <p className="tut-target">目標：{target}（跟著廚房裡的標記走）</p>}
      {trapped && <p className="tut-warn">你被關進鐵籠了：按 {renderText('{interact}')} 自己搖開。</p>}
      {tut.score !== undefined && (step === 'guest_look' || done) && <p className="tut-score">剛剛那份煎蛋吐司：{tut.score} 分</p>}
      <div className="tut-actions">
        {def.ack === 'button' && (
          <button className="btn small primary" onClick={() => begin(def.id)}>
            {def.button ?? '下一步'}（Enter）
          </button>
        )}
        {done ? (
          <>
            <button className="btn small primary" onClick={() => exitTutorial('play')}>
              開始真正的一班
            </button>
            <button className="btn small" onClick={() => exitTutorial('title')}>
              回到起始頁面
            </button>
          </>
        ) : (
          <button className="tut-skip" onClick={() => exitTutorial('play')}>
            跳過教學
          </button>
        )}
      </div>
      {!done && <p className="tut-foot">按 Esc 放開滑鼠才能點按鈕。</p>}
    </aside>
  );
}

function begin(step: TutorialStepId): void {
  void audio.init().then(() => audio.startAmbient());
  tutorialAck(step);
  requestLock();
}
