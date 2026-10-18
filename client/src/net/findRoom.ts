import { desktop, hostBridge, type Locate } from '../platform';
import { joinRoomDetailed } from './socket';

/**
 * 用房間代碼找房間並加入：
 *   1. 先問現在連著的伺服器（網頁版＝線上伺服器；應用程式＝這台電腦）；
 *   2. 沒有的話問線上伺服器的「房間代碼查詢處」——朋友用應用程式開的房間會登記在那裡；
 *   3. 找到了就把畫面換到房主的電腦（網址帶著代碼和暱稱，到了自動加入）。
 * 也接受直接輸入網址或區網位址（區網模式、或代碼查詢處暫時不能用時）。
 */

const TUNNEL_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;

export const looksLikeAddress = (s: string): boolean => /[.:/]/.test(s.trim());

export function normalizeAddress(raw: string): string {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) return s;
  return (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s) ? 'http://' : 'https://') + s;
}

function withJoin(base: string, p: { code?: string; name: string }): string {
  const u = new URL(base);
  const q = new URL(u.origin + '/');
  if (p.code) q.searchParams.set('join', p.code);
  q.searchParams.set('name', p.name);
  return q.href;
}

/** 換到別的伺服器（應用程式交給主程式，網頁版直接換網址） */
async function goTo(url: string, p: { code?: string; name: string }): Promise<string | null> {
  if (hostBridge) {
    await hostBridge.go(url, { code: p.code, name: p.name });
    return null;
  }
  location.href = withJoin(url, p);
  return null;
}

async function locate(code: string): Promise<Locate | 'unsupported'> {
  if (hostBridge) return hostBridge.locate(code);
  // 應用程式停在別人的房間：那台伺服器沒有查詢處
  if (desktop && desktop.mode === 'join') return 'unsupported';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 70_000);
  try {
    const res = await fetch(`/api/locate/${encodeURIComponent(code)}`, { signal: ctl.signal, cache: 'no-store' });
    if (res.status === 404) return { where: null };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { where?: string; url?: string };
    // 只會被導到 Cloudflare 快速通道的網址（查詢處也只收這種）
    if (j.where === 'host' && typeof j.url === 'string' && TUNNEL_RE.test(j.url)) return { where: 'host', url: j.url };
    return { where: null };
  } catch (e) {
    throw new Error(ctl.signal.aborted ? '查詢房間逾時，請再試一次。' : '查詢房間失敗，請再試一次。');
  } finally {
    clearTimeout(t);
  }
}

export async function findAndJoin(name: string, input: string, onStatus: (s: string | null) => void): Promise<string | null> {
  const raw = input.trim();
  if (looksLikeAddress(raw)) {
    onStatus('正在前往…');
    try {
      return await goTo(normalizeAddress(raw), { name });
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return '房間代碼是 6 個英文字母或數字。';

  const r = await joinRoomDetailed(name, code);
  if (!r.notFound) return r.error;

  onStatus('正在查詢房間代碼…（線上服務剛醒來時要等一下）');
  let loc: Locate | 'unsupported';
  try {
    loc = await locate(code);
  } catch (e) {
    onStatus(null);
    return e instanceof Error ? e.message : String(e);
  }
  if (loc === 'unsupported') {
    onStatus(null);
    return '這台房主的電腦上沒有這個房間。要加入別的房間，請先回到起始頁面。';
  }
  if (loc.where === null) {
    onStatus(null);
    return '找不到這個房間。請確認代碼；朋友用應用程式開的房間，要等他按了「邀請朋友」才找得到。';
  }
  onStatus(loc.where === 'host' ? '找到了，正在連到房主的電腦…' : '找到了，正在連到線上伺服器…');
  try {
    return await goTo(loc.url, { code, name });
  } catch (e) {
    onStatus(null);
    return e instanceof Error ? e.message : String(e);
  }
}
