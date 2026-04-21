import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const distDir = path.join(root, 'dist');
const envFile = path.join(root, '.env');

function applyDotEnv(raw) {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

try {
  const rawEnv = await fs.readFile(envFile, 'utf8');
  applyDotEnv(rawEnv);
} catch (error) {
  if (error && error.code !== 'ENOENT') {
    throw error;
  }
}

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });

await Promise.all([
  fs.copyFile(path.join(root, 'index.html'), path.join(distDir, 'index.html')),
  fs.copyFile(path.join(root, 'styles.css'), path.join(distDir, 'styles.css')),
  fs.cp(path.join(root, 'public'), path.join(distDir, 'public'), { recursive: true })
]);

await build({
  entryPoints: [path.join(root, 'src', 'main.js')],
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  define: {
    'process.env.ARWEAVE_GATEWAY': JSON.stringify(process.env.ARWEAVE_GATEWAY || '')
  },
  outdir: distDir,
  entryNames: 'app',
  chunkNames: 'chunks/[name]-[hash]'
});

console.log('Built files in dist/.');
