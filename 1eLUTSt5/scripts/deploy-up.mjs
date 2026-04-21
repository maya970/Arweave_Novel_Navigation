import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const DEFAULT_GATEWAY = 'https://arweave.net';
const DEFAULT_FORKED_FROM = 'bSpWJvwsHtzoFuJY8u8gCbTZVaLhhcq8lZnjwGwv0LQ';
const FORK_ORIGIN_PATH = path.join(root, 'data', 'fork-origin.json');

function parseArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) {
    return '';
  }
  return raw.slice(name.length + 3).trim();
}

function runNodeScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: root,
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Deploy failed with exit code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function resolveForkedFrom(explicitForkedFrom) {
  if (explicitForkedFrom) {
    return explicitForkedFrom;
  }
  if (process.env.FORKED_FROM?.trim()) {
    return process.env.FORKED_FROM.trim();
  }
  if (process.env.ARWEAVE_FORKED_FROM?.trim()) {
    return process.env.ARWEAVE_FORKED_FROM.trim();
  }

  try {
    const current = JSON.parse(await fs.readFile(FORK_ORIGIN_PATH, 'utf8'));
    if (typeof current?.forkedFrom === 'string' && current.forkedFrom.trim()) {
      return current.forkedFrom.trim();
    }
    throw new Error(`Missing non-empty "forkedFrom" in ${FORK_ORIGIN_PATH}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(FORK_ORIGIN_PATH), { recursive: true });
  await fs.writeFile(
    FORK_ORIGIN_PATH,
    `${JSON.stringify({ forkedFrom: DEFAULT_FORKED_FROM }, null, 2)}\n`,
    'utf8'
  );
  console.log(`Created ${FORK_ORIGIN_PATH}`);

  return DEFAULT_FORKED_FROM;
}

async function main() {
  const walletArg = parseArg('wallet');
  const gatewayArg = parseArg('gateway');
  const forkedFromArg = parseArg('forked-from');
  const gateway = gatewayArg || process.env.ARWEAVE_GATEWAY || DEFAULT_GATEWAY;
  const forkedFrom = await resolveForkedFrom(forkedFromArg);
  console.log(`Deploy up gateway: ${gateway}`);
  if (walletArg) {
    console.log(`Deploy up wallet override: ${walletArg}`);
  } else if (process.env.ARWEAVE_WALLET?.trim()) {
    console.log(`Deploy up wallet source: ARWEAVE_WALLET (${process.env.ARWEAVE_WALLET.trim()})`);
  } else {
    console.log('Deploy up wallet source: wallet.json (auto-generated if missing)');
  }
  console.log(`Deploy up forked-from: ${forkedFrom}`);

  await runNodeScript(path.join(root, 'scripts/deploy.mjs'), [
    '--upload-mode=up',
    `--forked-from=${forkedFrom}`,
    ...(walletArg ? [`--wallet=${walletArg}`] : []),
    ...(gatewayArg ? [`--gateway=${gatewayArg}`] : [])
  ]);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
