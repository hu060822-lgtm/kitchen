// 打包：Electron 主程式（含房主模式伺服器）、preload；--client 會先建置網頁版並複製（--no-client-build：直接用現有的 client/dist）
import { build } from '../../node_modules/esbuild/lib/main.js';
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..');
const prod = process.argv.includes('--client');

if (prod) {
  if (!process.argv.includes('--no-client-build')) execSync('npm run build -w client', { cwd: repo, stdio: 'inherit' });
  rmSync(path.join(root, 'app-client'), { recursive: true, force: true });
  cpSync(path.join(repo, 'client', 'dist'), path.join(root, 'app-client'), { recursive: true });
} else if (!existsSync(path.join(repo, 'client', 'dist', 'index.html'))) {
  console.warn('[bundle] 找不到 client/dist（先執行 npm run build -w client，房主模式才有畫面）');
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: prod ? false : 'inline',
  minify: prod,
  legalComments: 'none',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
};

await build({ ...common, entryPoints: [path.join(root, 'src/main.ts')], outfile: path.join(root, 'dist/main.cjs') });
await build({ ...common, entryPoints: [path.join(root, 'src/preload.ts')], outfile: path.join(root, 'dist/preload.cjs') });
