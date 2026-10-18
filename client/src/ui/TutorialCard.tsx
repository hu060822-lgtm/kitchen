import { useEffect, useMemo, useRef, useState } from 'react';
import { MENTOR, STATION_BY_ID, TUTORIAL_CHAPTER_LABEL, TUTORIAL_STEPS, TUTORIAL_STEP_BY_ID, type TutorialStepId } from '@last-table/shared';
import { audio } from '../audio/engine';
import { speak } from '../audio/speech';
import { keyLabel, type KeyAction } from '../game/keymap';
import { requestLock } from '../game/loop';
import { leaveRoom, tutorialAck } from '../net/socket';
import { kv } from '../platform';
import { useStore } from '../state/store';
import { MentorPortrait } from './MentorPortrait';

/**
 * 教學關：帶班的老廚師「老周」的對話卡（畫面左側）。
 *   上半是老周說的話（一句一句打出來），下半是「要做的事」（帶按鍵）。
 * 步驟由伺服器依廚房的實際狀態判定；「打開訂單板／食譜」這種伺服器看不到的事，由這裡偵測到之後回報。
 */

export const TUTORIAL_DONE_KEY = 'last-table.tutorialDone';
export const markTutorialDone = (): void => kv.set(TUTORIAL_DONE_KEY, '1');
export const tutorialDone = (): boolean => kv.get(TUTORIAL_DONE_KEY) === '1';

const MOUSE = new Set(['左鍵', '右鍵', '滾輪']);

/** 把 {interact} 換成目前的按鍵、[左鍵] 換成滑鼠鍵帽 */
export function renderText(text: string): Array<string | JSX.Element> {
  const out: Array<string | JSX.Element> = [];
  let last = 0;
  const re = /\{([a-z]+)\}|\[(左鍵|右鍵|滾輪)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<kbd key={m.index}>{keyLabel(m[1] as KeyAction)}</kbd>);
    else if (MOUSE.has(m[2])) out.push(<kbd key={m.index} className="mouse">{m[2]}</kbd>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 純文字（語音播報、打字效果計算長度用） */
const plain = (text: string): string => text.replace(/\{([a-z]+)\}/g, (_, k: string) => keyLabel(k as KeyAction)).replace(/\[(左鍵|右鍵|滾輪)\]/g, '$1');

/** 教學結束：離開教學房間，到開始遊戲或起始頁面 */
export function exitTutorial(to: 'play' | 'title'): void {
  markTutorialDone();
  leaveRoom();
  useStore.getState().set({ page: to });
}

const CHARS_PER_SEC = 38;

/** 老周的話一個字一個字打出來；回傳目前顯示到第幾個字、是否打完、立刻打完的函式 */
function useTypewriter(lines: readonly string[], key: string): { shown: number; done: boolean; finish: () => void } {
  const total = useMemo(() => lines.reduce((n, l) => n + plain(l).length, 0), [lines]);
  const [shown, setShown] = useState(0);
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    setShown(calm ? total : 0);
    if (calm) return;
    const t0 = performance.now();
    let last = 0;
    const id = window.setInterval(() => {
      const n = Math.min(total, Math.floor(((performance.now() - t0) / 1000) * CHARS_PER_SEC));
      // 說話的「嗯嗯」聲：每幾個字一下，很輕
      if (Math.floor(n / 5) > Math.floor(last / 5)) audio.tone(150 + (n % 3) * 18, 0.05, { type: 'triangle', gain: 0.025 });
      last = n;
      setShown(n);
      if (n >= total) clearInterval(id);
    }, 33);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, total]);
  return { shown, done: shown >= total, finish: () => setShown(total) };
}

/** 一句話只顯示前 n 個「純文字」字：按鍵標記算一個字 */
function partial(text: string, n: number): Array<string | JSX.Element> {
  if (n >= plain(text).length) return renderText(text);
  return [plain(text).slice(0, Math.max(0, n))];
}

export default function TutorialCard(): JSX.Element | null {
  const tut = useStore((s) => s.kitchen?.tutorial);
  const overlay = useStore((s) => s.overlay);
  const role = useStore((s) => s.me?.role ?? null);
  const trapped = useStore((s) => (role ? s.kitchen?.players[role]?.status === 'trapped' : false));
  const step: TutorialStepId | null = tut?.step ?? null;
  const def = step ? TUTORIAL_STEP_BY_ID[step] : null;
  const say = def?.say ?? [];
  const tw = useTypewriter(say, step ?? '');
  const twRef = useRef(tw);
  twRef.current = tw;

  // 打開訂單板／食譜：回報伺服器
  useEffect(() => {
    if (!def?.ack) return;
    if ((def.ack === 'tickets' && overlay === 'tickets') || (def.ack === 'cookbook' && overlay === 'cookbook')) tutorialAck(def.id);
  }, [def, overlay]);

  // 換到新的一步：語音播報（無障礙選項打開時）
  useEffect(() => {
    if (!def) return;
    speak(`${MENTOR.name}：${def.say.map(plain).join('')}　${plain(def.text)}`, { interrupt: true });
  }, [def]);

  // Enter：話還沒說完就先說完；說完了才按下按鈕
  useEffect(() => {
    if (!def) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || useStore.getState().station || useStore.getState().overlay !== 'none') return;
      if (!twRef.current.done) {
        e.preventDefault();
        twRef.current.finish();
        return;
      }
      if (def.ack === 'button') {
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
  // 每一句話的開始位置
  let acc = 0;
  const starts = say.map((l) => {
    const s0 = acc;
    acc += plain(l).length;
    return s0;
  });
  const chapter = def.chapter;
  const chapterSteps = TUTORIAL_STEPS.filter((s) => s.chapter === chapter);
  const inChapter = chapterSteps.findIndex((s) => s.id === def.id);

  return (
    <aside className="tut-card mentor interactive" aria-live="polite">
      <div className="tut-head">
        <span>第一班・{TUTORIAL_CHAPTER_LABEL[chapter]}</span>
        <span>
          {tut.index + 1}／{tut.total}
        </span>
      </div>
      <div className="tut-progress" aria-hidden>
        <i style={{ width: `${((tut.index + 1) / tut.total) * 100}%` }} />
      </div>
      <div className="mentor-row" onClick={() => tw.finish()}>
        <div className="mentor-face">
          <MentorPortrait talking={!tw.done} size={64} />
          <span className="mentor-name">
            {MENTOR.name}
            <small>{MENTOR.title}</small>
          </span>
        </div>
        <div className="mentor-say">
          <h3 className="tut-title">{def.title}</h3>
          {say.map((line, i) =>
            tw.shown > starts[i] ? (
              <p key={`${def.id}-${i}`} className="say-line">
                {partial(line, tw.shown - starts[i])}
                {!tw.done && tw.shown - starts[i] < plain(line).length && <span className="caret" />}
              </p>
            ) : null,
          )}
        </div>
      </div>
      <div className={`tut-task ${tw.done ? 'in' : ''}`}>
        <span className="task-tag">{done ? '下班' : '要做的事'}</span>
        <p className="tut-text">{renderText(def.text)}</p>
        {target && !done && <p className="tut-target">目標：{target}（跟著廚房裡的標記走，老周會在那裡等你）</p>}
        {chapterSteps.length > 1 && !done && (
          <p className="tut-dots" aria-hidden>
            {chapterSteps.map((s, i) => (
              <i key={s.id} className={i < inChapter ? 'done' : i === inChapter ? 'now' : ''} />
            ))}
          </p>
        )}
      </div>
      {trapped && <p className="tut-warn">你被關進鐵籠了：按 {renderText('{interact}')} 自己搖開。</p>}
      {tut.score !== undefined && (step === 'puddle' || step === 'crew' || done) && <p className="tut-score">剛剛那份煎蛋吐司：{tut.score} 分</p>}
      <div className="tut-actions">
        {def.ack === 'button' && (
          <button className="btn small primary" onClick={() => (tw.done ? begin(def.id) : tw.finish())}>
            {tw.done ? `${def.button ?? '下一步'}（Enter）` : '說快一點（Enter）'}
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
      {!done && <p className="tut-foot">按 Esc 放開滑鼠才能點按鈕；點對話框可以讓老周說快一點。</p>}
    </aside>
  );
}

function begin(step: TutorialStepId): void {
  void audio.init().then(() => audio.startAmbient());
  tutorialAck(step);
  requestLock();
}
