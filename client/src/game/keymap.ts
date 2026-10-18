import { useSyncExternalStore } from 'react';
import { kv } from '../platform';

/**
 * 自訂按鍵：每個動作最多兩個按鍵（主要／次要），存在這台電腦的瀏覽器裡。
 * 「世界」裡的動作彼此不能重複（設定時會把衝突的那個清掉）；切菜節奏只在面板裡用，可以和煞車共用空白鍵。
 * Esc（關閉）、數字鍵（面板按鈕、快速拿食材）、` （開發者工具）固定不變。
 */

export type KeyAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'run'
  | 'crouch'
  | 'brake'
  | 'interact'
  | 'swap'
  | 'handoff'
  | 'pickup'
  | 'toss'
  | 'ability'
  | 'route'
  | 'reply'
  | 'mark'
  | 'tickets'
  | 'cookbook'
  | 'signals'
  | 'help'
  | 'mute'
  | 'calibrate'
  | 'chop';

export interface KeyActionDef {
  id: KeyAction;
  label: string;
  group: '移動' | '動作' | '畫面' | '面板';
  def: [string, string?];
}

export const KEY_ACTIONS: readonly KeyActionDef[] = [
  { id: 'forward', label: '前進', group: '移動', def: ['KeyW', 'ArrowUp'] },
  { id: 'back', label: '後退', group: '移動', def: ['KeyS', 'ArrowDown'] },
  { id: 'left', label: '左移', group: '移動', def: ['KeyA', 'ArrowLeft'] },
  { id: 'right', label: '右移', group: '移動', def: ['KeyD', 'ArrowRight'] },
  { id: 'run', label: '跑步（按住）', group: '移動', def: ['ShiftLeft', 'ShiftRight'] },
  { id: 'crouch', label: '蹲下／站起', group: '移動', def: ['KeyC'] },
  { id: 'brake', label: '煞車（暴衝快遞）', group: '移動', def: ['Space'] },
  { id: 'interact', label: '打開工作站／隊友面板・掙脫鐵籠', group: '動作', def: ['KeyE'] },
  { id: 'swap', label: '換手（兩隻手都拿著東西時）', group: '動作', def: ['KeyB'] },
  { id: 'handoff', label: '接住（交接、快掉的東西）', group: '動作', def: ['KeyF'] },
  { id: 'pickup', label: '撿起地上的東西・擦乾積水・穩住', group: '動作', def: ['KeyX'] },
  { id: 'toss', label: '把手上的食材丟給隊友（或丟到前面的地上）', group: '動作', def: ['KeyT'] },
  { id: 'ability', label: '缺陷卡技能', group: '動作', def: ['KeyV'] },
  { id: 'route', label: '畫路線箭頭', group: '動作', def: ['KeyZ'] },
  { id: 'reply', label: '回應召集', group: '動作', def: ['KeyY'] },
  { id: 'mark', label: '標記工作站', group: '動作', def: ['KeyG'] },
  { id: 'tickets', label: '訂單板', group: '畫面', def: ['Tab'] },
  { id: 'cookbook', label: '食譜與口味表', group: '畫面', def: ['KeyR'] },
  { id: 'signals', label: '信號器', group: '畫面', def: ['KeyQ'] },
  { id: 'help', label: '說明與設定', group: '畫面', def: ['KeyH'] },
  { id: 'mute', label: '麥克風靜音', group: '畫面', def: ['KeyM'] },
  { id: 'calibrate', label: '音訊校準', group: '畫面', def: ['KeyK'] },
  { id: 'chop', label: '切菜下刀', group: '面板', def: ['Space'] },
];

const DEF_BY_ID = Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, a])) as Record<KeyAction, KeyActionDef>;
/** 不能綁定的按鍵 */
export const RESERVED = new Set(['Escape', 'Backquote', 'Enter', ...Array.from({ length: 10 }, (_, i) => `Digit${i}`)]);

type Map = Record<KeyAction, [string | null, string | null]>;
const STORAGE_KEY = 'last-table.keys';

function defaults(): Map {
  return Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, [a.def[0], a.def[1] ?? null]])) as Map;
}

function load(): Map {
  const m = defaults();
  try {
    const raw = kv.get(STORAGE_KEY);
    if (!raw) return m;
    const saved = JSON.parse(raw) as Partial<Record<KeyAction, [string | null, string | null]>>;
    for (const a of KEY_ACTIONS) {
      const v = saved[a.id];
      if (Array.isArray(v) && v.length === 2) m[a.id] = [typeof v[0] === 'string' ? v[0] : null, typeof v[1] === 'string' ? v[1] : null];
    }
  } catch {
    /* 讀不到就用預設 */
  }
  return m;
}

let map: Map = load();
let byCode = new Map<string, KeyAction>();
let version = 0;
const listeners = new Set<() => void>();

function rebuild(): void {
  byCode = new Map();
  // 面板動作不放進世界的查表（避免空白鍵在世界裡被當成下刀）
  for (const a of KEY_ACTIONS) {
    if (a.group === '面板') continue;
    for (const c of map[a.id]) if (c && !byCode.has(c)) byCode.set(c, a.id);
  }
  version++;
  listeners.forEach((l) => l());
}
rebuild();

function save(): void {
  try {
    kv.set(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 存不了也照樣用（這次開著時有效） */
  }
}

/** 這個按鍵在世界裡對應的動作 */
export function actionOf(code: string): KeyAction | null {
  return byCode.get(code) ?? null;
}

export function codesFor(a: KeyAction): string[] {
  return map[a].filter((c): c is string => !!c);
}

export function isAction(code: string, a: KeyAction): boolean {
  return map[a].includes(code);
}

export function anyDown(a: KeyAction, keys: ReadonlySet<string>): boolean {
  return map[a].some((c) => !!c && keys.has(c));
}

/** 按鍵的顯示名稱 */
export function codeLabel(code: string | null): string {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `數字鍵盤 ${code.slice(6)}`;
  const names: Record<string, string> = {
    Space: '空白鍵',
    ShiftLeft: '左 Shift',
    ShiftRight: '右 Shift',
    ControlLeft: '左 Ctrl',
    ControlRight: '右 Ctrl',
    AltLeft: '左 Alt',
    AltRight: '右 Alt',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Tab: 'Tab',
    CapsLock: 'Caps',
    Backspace: '退格',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
  };
  return names[code] ?? code;
}

/** 動作目前的主要按鍵名稱（介面提示用） */
export function keyLabel(a: KeyAction): string {
  return codeLabel(map[a][0] ?? map[a][1]);
}

/**
 * 設定按鍵；回傳被清掉的衝突（同一組「世界」動作不能共用按鍵）。
 * code＝null 表示清除這一格。
 */
export function setBinding(a: KeyAction, slot: 0 | 1, code: string | null): KeyAction | null {
  if (code && RESERVED.has(code)) return null;
  let cleared: KeyAction | null = null;
  if (code) {
    const panel = DEF_BY_ID[a].group === '面板';
    for (const other of KEY_ACTIONS) {
      if (other.id === a && map[a][slot] === code) continue;
      if ((other.group === '面板') !== panel) continue;
      const pair = map[other.id];
      for (const i of [0, 1] as const) {
        if (pair[i] === code && !(other.id === a && i === slot)) {
          pair[i] = null;
          if (other.id !== a) cleared = other.id;
        }
      }
    }
  }
  map[a][slot] = code;
  save();
  rebuild();
  return cleared;
}

export function resetKeys(): void {
  map = defaults();
  save();
  rebuild();
}

export function actionLabel(a: KeyAction): string {
  return DEF_BY_ID[a].label;
}

/** React：按鍵設定改變時重繪 */
export function useKeymap(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}

/**
 * 伺服器訊息裡寫的是預設按鍵（「按 X 撿起來」）：換成玩家自己設定的鍵。
 * 只替換「按 + 單一字母」與「（X）」這兩種寫法，不會動到一般文字。
 */
const DEFAULT_LETTER: Record<string, KeyAction> = Object.fromEntries(
  KEY_ACTIONS.filter((a) => a.group !== '面板' && a.def[0].startsWith('Key')).map((a) => [a.def[0].slice(3), a.id]),
);
export function localizeKeys(text: string): string {
  return text.replace(/(按\s?)([A-Z])(?![A-Za-z])/g, (m, pre: string, letter: string) => {
    const a = DEFAULT_LETTER[letter];
    return a ? `${pre}${keyLabel(a)}` : m;
  });
}
