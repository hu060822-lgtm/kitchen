import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type Express, type Request } from 'express';
import { TokenBucket } from './rateLimit';

/**
 * 房間代碼查詢處（只在線上伺服器開；房主模式的伺服器不開）。
 *
 * Windows 應用程式「和朋友一起開店」時，房主的電腦用 Cloudflare 的免費通道對外，網址每次都不一樣。
 * 房主的應用程式把「房間代碼 → 這次的通道網址」登記在這裡，朋友只要輸入房間代碼：
 *   GET /api/locate/ABC123 → { where: 'here' }（這台伺服器上的房間）
 *                          → { where: 'host', url }（某位房主電腦上的房間）
 *
 * 這裡只記代碼和網址（幾分鐘沒有更新就忘掉），遊戲本身、存檔都還是在房主的電腦上。
 *
 * 防護：
 *   - 只接受 https://xxxx.trycloudflare.com（不能拿來把人導到任意網站）；
 *   - 第一次登記時給的密語（只存雜湊）才能更新、刪除同一個代碼；
 *   - 每個來源 IP 有頻率限制；最多同時記 MAX_ENTRIES 個。
 */

export const RELAY_TTL_MS = 150_000;
const MAX_ENTRIES = 2000;
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const TUNNEL_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;

interface Entry {
  url: string;
  secret: Buffer;
  expires: number;
}

export type RelayResult = { ok: true } | { ok: false; status: number; error: string };

const hash = (s: string): Buffer => createHash('sha256').update(s).digest();

export class RelayDirectory {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = RELAY_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  static validUrl(url: unknown): url is string {
    return typeof url === 'string' && TUNNEL_RE.test(url);
  }

  private live(code: string): Entry | null {
    const e = this.entries.get(code);
    if (!e) return null;
    if (e.expires <= this.now()) {
      this.entries.delete(code);
      return null;
    }
    return e;
  }

  register(code: unknown, url: unknown, secret: unknown): RelayResult {
    if (typeof code !== 'string' || !CODE_RE.test(code)) return { ok: false, status: 400, error: '房間代碼格式不對。' };
    if (!RelayDirectory.validUrl(url)) return { ok: false, status: 400, error: '只接受 Cloudflare 快速通道的網址。' };
    if (typeof secret !== 'string' || secret.length < 16 || secret.length > 128) return { ok: false, status: 400, error: '缺少密語。' };
    const h = hash(secret);
    const cur = this.live(code);
    if (cur && !timingSafeEqual(cur.secret, h)) return { ok: false, status: 409, error: '這個房間代碼已經被別的房主使用。' };
    if (!cur && this.entries.size >= MAX_ENTRIES) {
      this.sweep();
      if (this.entries.size >= MAX_ENTRIES) return { ok: false, status: 503, error: '查詢處已滿，請稍後再試。' };
    }
    this.entries.set(code, { url, secret: h, expires: this.now() + this.ttlMs });
    return { ok: true };
  }

  remove(code: unknown, secret: unknown): RelayResult {
    if (typeof code !== 'string' || typeof secret !== 'string') return { ok: false, status: 400, error: '參數不對。' };
    const cur = this.live(code);
    if (!cur) return { ok: true };
    if (!timingSafeEqual(cur.secret, hash(secret))) return { ok: false, status: 403, error: '密語不對。' };
    this.entries.delete(code);
    return { ok: true };
  }

  lookup(code: string): string | null {
    return this.live(code)?.url ?? null;
  }

  get size(): number {
    return this.entries.size;
  }

  sweep(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expires <= t) this.entries.delete(k);
  }
}

/** 每個 IP 一個 token bucket（定期清掉閒置的） */
class IpLimiter {
  private readonly buckets = new Map<string, { b: TokenBucket; seen: number }>();
  constructor(
    private readonly capacity: number,
    private readonly perSec: number,
  ) {}
  take(ip: string): boolean {
    const now = Date.now();
    let e = this.buckets.get(ip);
    if (!e) {
      if (this.buckets.size > 5000) for (const [k, v] of this.buckets) if (now - v.seen > 600_000) this.buckets.delete(k);
      e = { b: new TokenBucket(this.capacity, this.perSec), seen: now };
      this.buckets.set(ip, e);
    }
    e.seen = now;
    return e.b.take(now);
  }
}

const ipOf = (req: Request): string => req.ip || req.socket.remoteAddress || '?';

export function mountRelay(app: Express, dir: RelayDirectory, hasRoom: (code: string) => boolean): void {
  const writes = new IpLimiter(20, 20 / 60);
  const reads = new IpLimiter(40, 1);
  const json = express.json({ limit: '2kb' });

  app.post('/api/relay', json, (req, res) => {
    if (!writes.take(ipOf(req))) return void res.status(429).json({ ok: false, error: '太頻繁了，請稍後再試。' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = dir.register(b.code, b.url, b.secret);
    res.status(r.ok ? 200 : r.status).json(r.ok ? { ok: true, ttlMs: RELAY_TTL_MS } : { ok: false, error: r.error });
  });

  app.delete('/api/relay/:code', json, (req, res) => {
    if (!writes.take(ipOf(req))) return void res.status(429).json({ ok: false, error: '太頻繁了，請稍後再試。' });
    const r = dir.remove(req.params.code, (req.body as Record<string, unknown> | undefined)?.secret);
    res.status(r.ok ? 200 : r.status).json(r.ok ? { ok: true } : { ok: false, error: r.error });
  });

  app.get('/api/locate/:code', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!reads.take(ipOf(req))) return void res.status(429).json({ where: null, error: '太頻繁了，請稍後再試。' });
    const code = String(req.params.code ?? '').trim().toUpperCase();
    if (!CODE_RE.test(code)) return void res.status(400).json({ where: null, error: '房間代碼是 6 個英文字母或數字。' });
    if (hasRoom(code)) return void res.json({ where: 'here' });
    const url = dir.lookup(code);
    if (url) return void res.json({ where: 'host', url });
    res.status(404).json({ where: null });
  });

  setInterval(() => dir.sweep(), 60_000).unref();
}
