// 網路通道：下載（進度、壞檔重下）、啟動、抓網址、中斷回報。用假的 cloudflared（shell 腳本）測試。
// 用法：npx tsx desktop/test/tunnel.test.mts
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Tunnel, type TunnelInfo } from '../src/tunnel.ts';

const check = (cond: unknown, msg: string) => {
  if (!cond) throw new Error('✗ ' + msg);
  console.log('✓ ' + msg);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeBinary(mode: 'ok' | 'die'): Buffer {
  const body =
    mode === 'ok'
      ? `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cloudflared version 2026.9.0"; exit 0; fi\necho "INF Requesting new quick Tunnel on trycloudflare.com..." >&2\nsleep 0.3\necho "INF |  https://brave-lemon-kitchen.trycloudflare.com  |" >&2\nexec sleep 30\n`
      : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cloudflared version 2026.9.0"; exit 0; fi\necho "INF |  https://short-lived.trycloudflare.com  |" >&2\nsleep 0.5\nexit 3\n`;
  return Buffer.concat([Buffer.from(body), Buffer.from('#' + 'x'.repeat(1_200_000) + '\n')]);
}

let serve = fakeBinary('ok');
let requests = 0;
const srv = createServer((_q, s) => {
  requests++;
  s.writeHead(200, { 'content-length': serve.length });
  s.end(serve);
}).listen(0);
await new Promise((r) => srv.once('listening', r));
const port = (srv.address() as { port: number }).port;
const fetcher = () => fetch(`http://127.0.0.1:${port}/`);

try {
  const dir = mkdtempSync(path.join(tmpdir(), 'lt-tunnel-'));
  const seen: TunnelInfo[] = [];
  const t = new Tunnel(dir, fetcher, (i) => seen.push(i));
  await t.start(38401);
  check(t.status.state === 'ready' && t.status.url === 'https://brave-lemon-kitchen.trycloudflare.com', `抓到通道網址 ${t.status.url}`);
  check(seen.some((s) => s.state === 'downloading') && seen.some((s) => s.state === 'downloading' && s.progress > 0.5), '第一次使用會下載並回報進度');
  check(existsSync(t.binary) && statSync(t.binary).size === serve.length, '下載的程式放在應用程式資料夾');
  t.stop();
  check(t.status.state === 'idle' && t.status.url === null, '停止通道');

  // 第二次：不用再下載
  const before = requests;
  await t.start(38402);
  check(requests === before && t.status.state === 'ready', '已經下載過就不再下載');
  t.stop();

  // 下載下來的檔案壞掉（不能執行）→ 重新下載
  const dir2 = mkdtempSync(path.join(tmpdir(), 'lt-tunnel-'));
  serve = Buffer.alloc(2_000_000, 0);
  const t2 = new Tunnel(dir2, fetcher);
  await t2.start(38401);
  check(t2.status.state === 'error' && /無法執行/.test(t2.status.error ?? ''), `壞掉的下載會回報：${t2.status.error}`);

  // cloudflared 中途結束 → 回報中斷，網址清掉
  serve = fakeBinary('die');
  const dir3 = mkdtempSync(path.join(tmpdir(), 'lt-tunnel-'));
  const t3 = new Tunnel(dir3, fetcher);
  await t3.start(38401);
  check(t3.status.state === 'ready', '通道開好');
  await sleep(1200);
  check(t3.status.state === 'error' && t3.status.url === null && /中斷/.test(t3.status.error ?? ''), `通道中斷會回報：${t3.status.error}`);
  t3.stop();
  void readFileSync;
  console.log('\n通道測試全部通過。');
} finally {
  srv.close();
}
