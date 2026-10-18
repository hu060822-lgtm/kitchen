import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * 網際網路模式：Cloudflare 的免費快速通道（trycloudflare.com）。
 *
 * - 不用註冊帳號、不用設定路由器；第一次使用時下載 cloudflared（約 50 MB），放在應用程式的資料夾；
 * - 每次開通道都會拿到一個新的 https://xxxx.trycloudflare.com 網址（重開就換網址）；
 * - 通道只是把外面的連線轉到這台電腦的遊戲伺服器，遊戲資料仍然只在這台電腦。
 */

export type TunnelState = 'idle' | 'downloading' | 'starting' | 'ready' | 'error';

export interface TunnelInfo {
  state: TunnelState;
  url: string | null;
  /** 下載進度 0–1 */
  progress: number;
  error: string | null;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

export function binaryName(): string {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

function assetName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64';
  if (process.platform === 'win32') return `cloudflared-windows-${arch}.exe`;
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`;
  throw new Error('網路通道只支援 Windows。');
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class Tunnel {
  private info: TunnelInfo = { state: 'idle', url: null, progress: 0, error: null };
  private proc: ChildProcess | null = null;
  private wanted = false;
  private gen = 0;

  constructor(
    private readonly binDir: string,
    private readonly fetcher: Fetcher,
    private readonly onChange: (i: TunnelInfo) => void = () => undefined,
  ) {}

  get status(): TunnelInfo {
    return { ...this.info };
  }

  get binary(): string {
    return path.join(this.binDir, binaryName());
  }

  private set(p: Partial<TunnelInfo>): void {
    this.info = { ...this.info, ...p };
    this.onChange(this.status);
  }

  async start(port: number): Promise<void> {
    this.stop();
    this.wanted = true;
    const gen = ++this.gen;
    try {
      if (!(await this.binaryOk())) await this.download(gen);
      if (gen !== this.gen) return;
      await this.spawn(port, gen);
    } catch (e) {
      if (gen !== this.gen) return;
      this.set({ state: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  stop(): void {
    this.wanted = false;
    this.gen++;
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try {
        p.kill();
      } catch {
        /* 已經結束 */
      }
    }
    this.set({ state: 'idle', url: null, progress: 0, error: null });
  }

  /** 檔案在、而且真的能執行（下載到一半、被防毒軟體隔離時重新下載） */
  private binaryOk(): Promise<boolean> {
    const bin = this.binary;
    if (!existsSync(bin) || statSync(bin).size < 1_000_000) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        execFile(bin, ['--version'], { timeout: 15_000, windowsHide: true }, (err, stdout) => resolve(!err && /cloudflared/i.test(String(stdout))));
      } catch {
        resolve(false);
      }
    });
  }

  private async download(gen: number): Promise<void> {
    this.set({ state: 'downloading', progress: 0, error: null, url: null });
    mkdirSync(this.binDir, { recursive: true });
    let res: Response;
    try {
      res = await this.fetcher(RELEASE + assetName());
    } catch (e) {
      throw new Error(`下載 cloudflared 失敗（請確認這台電腦連得上網路）：${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok || !res.body) throw new Error(`下載 cloudflared 失敗（HTTP ${res.status}）。`);
    const total = Number(res.headers.get('content-length')) || 0;
    const tmp = `${this.binary}.download`;
    const out = createWriteStream(tmp);
    let got = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (gen !== this.gen) throw new Error('取消');
        got += value.byteLength;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        if (total) this.set({ progress: Math.min(1, got / total) });
      }
      // 等檔案真的關閉（還開著就執行會失敗：Windows 的共用違規、Linux 的 ETXTBSY）
      await new Promise<void>((resolve, reject) => {
        out.once('close', () => resolve());
        out.once('error', reject);
        out.end();
      });
    } catch (e) {
      out.destroy();
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
    if (got < 1_000_000) throw new Error('下載的 cloudflared 不完整，請再試一次。');
    if (existsSync(this.binary)) unlinkSync(this.binary);
    renameSync(tmp, this.binary);
    if (process.platform !== 'win32') chmodSync(this.binary, 0o755);
    if (!(await this.binaryOk())) throw new Error('cloudflared 無法執行（可能被防毒軟體擋住了）。');
  }

  private spawn(port: number, gen: number): Promise<void> {
    this.set({ state: 'starting', progress: 1, error: null, url: null });
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = proc;
      let log = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (this.proc === proc) this.proc = null;
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        reject(new Error('通道 60 秒內沒有開好。可能是網路擋住了 Cloudflare，請改用區網，或稍後再試。'));
      }, 60_000);
      const onData = (buf: Buffer) => {
        log = (log + buf.toString()).slice(-4000);
        const m = URL_RE.exec(log);
        if (m && !settled && gen === this.gen) {
          settled = true;
          clearTimeout(timer);
          this.set({ state: 'ready', url: m[0] });
          resolve();
        }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared 無法啟動：${e.message}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (this.proc !== proc) return;
        this.proc = null;
        const why = `通道中斷了（cloudflared 結束，代碼 ${code}）。可以按「重新開通道」再試；新的網址要重新告訴朋友。`;
        if (!settled) {
          settled = true;
          reject(new Error(why));
        } else if (this.wanted && gen === this.gen) {
          this.set({ state: 'error', url: null, error: why });
        }
      });
    });
  }
}
