import { randomBytes } from 'node:crypto';
import type { HostHandle } from '../../server/src/host';
import { Tunnel, type Fetcher, type TunnelInfo } from './tunnel';

/**
 * 邀請朋友：開 Cloudflare 通道，並把「房間代碼 → 通道網址」登記到線上伺服器的查詢處。
 * 朋友只要輸入房間代碼（應用程式或網頁版都可以）。
 *
 *   開通道 ──► 通道好了 ──► 每 45 秒把這台電腦上每個房間的代碼登記一次（查詢處 150 秒沒更新就忘掉）
 *                           房間不見了就刪掉登記；停止邀請、關程式時全部刪掉
 */

export type RelayState = 'idle' | 'pending' | 'ok' | 'error';

export interface InviteInfo {
  on: boolean;
  tunnel: TunnelInfo;
  relay: RelayState;
  relayError: string | null;
  /** 已經登記、朋友可以用代碼找到的房間 */
  codes: string[];
}

const HEARTBEAT_MS = 45_000;

export class Invite {
  private wanted = false;
  private readonly tunnel: Tunnel;
  private readonly secret = randomBytes(24).toString('hex');
  private readonly registered = new Map<string, string>();
  private relay: RelayState = 'idle';
  private relayError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    binDir: string,
    private readonly host: () => HostHandle | null,
    private readonly relayBase: () => string,
    private readonly fetcher: Fetcher,
    private readonly onChange: () => void,
  ) {
    this.tunnel = new Tunnel(binDir, fetcher, () => {
      this.onChange();
      if (this.tunnel.status.state === 'ready') void this.tick();
    });
  }

  get info(): InviteInfo {
    return { on: this.wanted, tunnel: this.tunnel.status, relay: this.relay, relayError: this.relayError, codes: [...this.registered.keys()] };
  }

  start(): void {
    const h = this.host();
    if (!h) throw new Error('伺服器還沒準備好。');
    this.wanted = true;
    const st = this.tunnel.status.state;
    if (st === 'idle' || st === 'error') void this.tunnel.start(h.port);
    this.timer ??= setInterval(() => void this.tick(), HEARTBEAT_MS);
    this.onChange();
    void this.tick();
  }

  retry(): void {
    const h = this.host();
    if (!h) return;
    this.wanted = true;
    void this.tunnel.start(h.port);
  }

  /** 房間有變化（新開房、讀檔）時立刻登記，不用等下一次心跳 */
  poke(): void {
    if (this.wanted) void this.tick();
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tunnel.stop();
    await this.unregisterAll();
    this.relay = 'idle';
    this.relayError = null;
    this.onChange();
  }

  private async call(method: 'POST' | 'DELETE', path: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetcher(this.relayBase() + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal } as RequestInit);
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      return res.ok ? { ok: true } : { ok: false, error: j.error ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: ctl.signal.aborted ? '線上服務沒有回應（可能正在醒來）' : e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(t);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.wanted) return;
    const h = this.host();
    const url = this.tunnel.status.url;
    if (!h || this.tunnel.status.state !== 'ready' || !url) return;
    this.ticking = true;
    try {
      const codes = new Set(h.status().rooms.map((r) => r.code));
      if (this.relay !== 'ok') this.relay = 'pending';
      this.onChange();
      let err: string | null = null;
      for (const code of codes) {
        // 線上服務剛醒來時要等比較久
        const r = await this.call('POST', '/api/relay', { code, url, secret: this.secret }, 70_000);
        if (r.ok) this.registered.set(code, url);
        else err = r.error ?? '登記失敗';
      }
      for (const code of [...this.registered.keys()]) {
        if (codes.has(code)) continue;
        await this.call('DELETE', `/api/relay/${code}`, { secret: this.secret }, 10_000);
        this.registered.delete(code);
      }
      if (!this.wanted) return;
      // 404：線上伺服器沒有查詢處——不是舊版就是網址不對，說清楚該怎麼做
      if (err && /HTTP 404/.test(err)) err = await this.diagnose404();
      this.relay = err ? 'error' : codes.size ? 'ok' : this.relay === 'ok' ? 'ok' : 'pending';
      this.relayError = err;
    } finally {
      this.ticking = false;
      this.onChange();
    }
  }

  /** 登記時收到 404：分辨「線上伺服器是舊版」和「網址不是《最後一桌》」 */
  private async diagnose404(): Promise<string> {
    const base = this.relayBase();
    try {
      const v = await this.fetcher(`${base}/api/version`);
      if (v.ok) {
        const j = (await v.json().catch(() => ({}))) as { game?: string; relay?: boolean };
        if (j.game === 'last-table' && j.relay === false) return `${base} 是房主模式的伺服器，不是線上伺服器。請到「設定 → 連線」改成你的 Render 網址。`;
      }
      const h = await this.fetcher(`${base}/healthz`);
      const j = (await h.json().catch(() => null)) as { ok?: boolean } | null;
      if (h.ok && j?.ok) return `線上伺服器（${base}）還是舊版，沒有「房間代碼查詢處」。請把最新的原始碼推上 GitHub，等 Render 重新部署完成。`;
    } catch {
      /* 連不上：當成網址不對 */
    }
    return `${base} 不是《最後一桌》的線上伺服器（HTTP 404）。請到「設定 → 連線」填入你在 Render 上的網址。`;
  }

  private async unregisterAll(): Promise<void> {
    const codes = [...this.registered.keys()];
    this.registered.clear();
    await Promise.all(codes.map((code) => this.call('DELETE', `/api/relay/${code}`, { secret: this.secret }, 3000)));
  }
}
