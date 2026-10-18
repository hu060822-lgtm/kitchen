import { flawHearsTaps, type FlawId } from './flaws';

/**
 * 信號器（受限通訊）。
 *
 * 固定詞彙的替代通道（敲擊、燈號、符號、手勢），沒有任何自由文字。
 * 沉默侍者（D04）靠它溝通；伺服器依接收者的缺陷卡過濾：
 *   - 敲擊（audio）：耳背砧板（D02）收不到
 *   - 燈號／符號／手勢（visual）：所有人都收得到
 */

export const SIGNAL_TOKENS = [
  'TAP_S',
  'TAP_L',
  'LIGHT_R',
  'LIGHT_B',
  'LIGHT_G',
  'LIGHT_W',
  'SYM_TRI',
  'SYM_CIR',
  'SYM_SQR',
  'SYM_DIA',
  'GEST_WAIT',
  'GEST_YES',
  'GEST_NO',
  'GEST_GO',
  'GEST_LEFT',
  'GEST_CENTER',
  'GEST_RIGHT',
  'GEST_AGAIN',
  'SYM_H',
  'SYM_V',
  'GEST_HELP',
  'GEST_DANGER',
  'GEST_TAKE',
] as const;
export type SignalToken = (typeof SIGNAL_TOKENS)[number];

export type SignalClass = 'audio' | 'visual';

export const TOKEN_CLASS: Record<SignalToken, SignalClass> = {
  TAP_S: 'audio',
  TAP_L: 'audio',
  LIGHT_R: 'visual',
  LIGHT_B: 'visual',
  LIGHT_G: 'visual',
  LIGHT_W: 'visual',
  SYM_TRI: 'visual',
  SYM_CIR: 'visual',
  SYM_SQR: 'visual',
  SYM_DIA: 'visual',
  GEST_WAIT: 'visual',
  GEST_YES: 'visual',
  GEST_NO: 'visual',
  GEST_GO: 'visual',
  GEST_LEFT: 'visual',
  GEST_CENTER: 'visual',
  GEST_RIGHT: 'visual',
  GEST_AGAIN: 'visual',
  SYM_H: 'visual',
  SYM_V: 'visual',
  GEST_HELP: 'visual',
  GEST_DANGER: 'visual',
  GEST_TAKE: 'visual',
};

export const TOKEN_LABEL: Record<SignalToken, string> = {
  TAP_S: '短敲',
  TAP_L: '長敲',
  LIGHT_R: '紅燈',
  LIGHT_B: '藍燈',
  LIGHT_G: '綠燈',
  LIGHT_W: '白燈',
  SYM_TRI: '△',
  SYM_CIR: '○',
  SYM_SQR: '□',
  SYM_DIA: '◇',
  GEST_WAIT: '等待',
  GEST_YES: '是',
  GEST_NO: '否',
  GEST_GO: '開始',
  GEST_LEFT: '左',
  GEST_CENTER: '中',
  GEST_RIGHT: '右',
  GEST_AGAIN: '請重複',
  SYM_H: '━',
  SYM_V: '┃',
  GEST_HELP: '救我',
  GEST_DANGER: '危險',
  GEST_TAKE: '幫我顧爐子',
};

export const TOKEN_COLOR: Partial<Record<SignalToken, string>> = {
  LIGHT_R: '#C64B3C',
  LIGHT_B: '#4F7A99',
  LIGHT_G: '#6E9466',
  LIGHT_W: '#E8E5DC',
};

export const MAX_SIGNAL_LEN = 6;
export const SIGNAL_COOLDOWN_MS = 1200;

export const isSignalToken = (v: unknown): v is SignalToken =>
  typeof v === 'string' && (SIGNAL_TOKENS as readonly string[]).includes(v);

/** 持有這張缺陷卡的人能否感知這個 token（耳背砧板聽不到敲擊；其他都看得到、聽得到） */
export function canPerceive(flaw: FlawId | null, token: SignalToken): boolean {
  return TOKEN_CLASS[token] === 'audio' ? flawHearsTaps(flaw) : true;
}

/** 依接收者的缺陷卡過濾 token 序列 */
export function filterForFlaw(flaw: FlawId | null, tokens: readonly SignalToken[]): SignalToken[] {
  return tokens.filter((t) => canPerceive(flaw, t));
}
