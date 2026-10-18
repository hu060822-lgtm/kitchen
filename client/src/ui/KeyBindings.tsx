import { useEffect, useState } from 'react';
import { KEY_ACTIONS, RESERVED, actionLabel, codeLabel, codesFor, resetKeys, setBinding, useKeymap, type KeyAction } from '../game/keymap';

/**
 * 按鍵設定：點一格 → 按下新的鍵（Esc 取消、Backspace 清除這一格）。
 * 衝突時自動把另一個動作的那一格清掉，並在下面說明。設定存在這台電腦的瀏覽器裡。
 */
export function KeyBindings(): JSX.Element {
  useKeymap();
  const [wait, setWait] = useState<{ a: KeyAction; slot: 0 | 1 } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!wait) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape') {
        setWait(null);
        return;
      }
      if (e.code === 'Backspace' || e.code === 'Delete') {
        setBinding(wait.a, wait.slot, null);
        setNote(`已清除「${actionLabel(wait.a)}」的第 ${wait.slot + 1} 個按鍵。`);
        setWait(null);
        return;
      }
      if (RESERVED.has(e.code)) {
        setNote(`${codeLabel(e.code)} 是固定用途的按鍵（關閉、面板按鈕、快速拿食材），不能設定。`);
        return;
      }
      const cleared = setBinding(wait.a, wait.slot, e.code);
      setNote(cleared ? `${codeLabel(e.code)} 原本是「${actionLabel(cleared)}」，已經改給「${actionLabel(wait.a)}」。記得幫「${actionLabel(cleared)}」換一個鍵。` : `「${actionLabel(wait.a)}」設為 ${codeLabel(e.code)}。`);
      setWait(null);
    };
    // 捕獲階段攔下來，不讓遊戲同時執行這個鍵的動作
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [wait]);

  const groups = [...new Set(KEY_ACTIONS.map((a) => a.group))];
  return (
    <div className="keybinds">
      {groups.map((g) => (
        <div key={g} className="kb-group">
          <div className="xs dim kb-group-name">{g}</div>
          {KEY_ACTIONS.filter((a) => a.group === g).map((a) => {
            const codes = codesFor(a.id);
            return (
              <div key={a.id} className="kb-row">
                <span className="kb-label sm">{a.label}</span>
                {([0, 1] as const).map((slot) => {
                  const waiting = wait?.a === a.id && wait.slot === slot;
                  const code = slot === 0 ? (codes[0] ?? null) : (codes.length > 1 ? codes[1] : null);
                  return (
                    <button
                      key={slot}
                      className={`btn small kb-key ${waiting ? 'primary' : ''} ${!code && !waiting ? 'empty' : ''}`}
                      aria-label={`${a.label}的第 ${slot + 1} 個按鍵：${code ? codeLabel(code) : '未設定'}。按一下後按新的鍵`}
                      onClick={() => {
                        setNote(null);
                        setWait(waiting ? null : { a: a.id, slot });
                      }}
                    >
                      {waiting ? '按下新的鍵…' : codeLabel(code)}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      ))}
      {note && <p className="sm kb-note" role="status">{note}</p>}
      <div className="row">
        <button
          className="btn small"
          onClick={() => {
            resetKeys();
            setNote('已恢復預設按鍵。');
          }}
        >
          恢復預設
        </button>
        <span className="xs dim">Esc、數字鍵（面板按鈕、注視冷藏架／乾貨架時直接拿食材）、Enter 是固定的。</span>
      </div>
    </div>
  );
}
