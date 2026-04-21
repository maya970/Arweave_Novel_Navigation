import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import Arweave from 'arweave';
import mime from 'mime-types';
import arbundles from 'warp-arbundles';

const { createData, ArweaveSigner } = arbundles;

const root = process.cwd();
const distDir = path.join(root, 'dist');
const DEFAULT_UPLOAD_MODE = 'arweave';
const UP_UPLOAD_MODE = 'up';
const SUPPORTED_UPLOAD_MODES = new Set([DEFAULT_UPLOAD_MODE, UP_UPLOAD_MODE]);
const DEFAULT_UP_UPLOAD_SERVICE = 'https://up.arweave.net';

function parseArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) {
    return '';
  }
  return raw.slice(name.length + 3).trim();
}

function buildGatewayConfig(gateway) {
  const parsed = new URL(gateway);
  return {
    host: parsed.hostname,
    port: parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === 'https:'
        ? 443
        : 80,
    protocol: parsed.protocol.replace(':', '')
  };
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listFiles(absolutePath);
      }
      return [absolutePath];
    })
  );
  return nested.flat();
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function runBinary(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const stdoutChunks = [];
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`)
        );
        return;
      }

      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr
      });
    });
  });
}

async function createCodeArchiveBuffer() {
  const { stdout } = await runBinary(
    'tar',
    ['--exclude=./node_modules', '--exclude=./wallet.json', '-cf', '-', '.'],
    root
  );
  return gzipSync(stdout);
}

async function loadWallet(arweave, walletArg) {
  const envWallet = process.env.ARWEAVE_WALLET?.trim();

  if (walletArg) {
    const absoluteWalletPath = path.resolve(root, walletArg);
    if (!(await pathExists(absoluteWalletPath))) {
      throw new Error(`Wallet file not found: ${absoluteWalletPath}`);
    }
    const jwkRaw = await fs.readFile(absoluteWalletPath, 'utf8');
    return {
      walletPath: absoluteWalletPath,
      generated: false,
      jwk: JSON.parse(jwkRaw)
    };
  }

  if (envWallet) {
    const absoluteWalletPath = path.resolve(root, envWallet);
    if (!(await pathExists(absoluteWalletPath))) {
      throw new Error(`ARWEAVE_WALLET points to a missing file: ${absoluteWalletPath}`);
    }
    const jwkRaw = await fs.readFile(absoluteWalletPath, 'utf8');
    return {
      walletPath: absoluteWalletPath,
      generated: false,
      jwk: JSON.parse(jwkRaw)
    };
  }

  const defaultWalletPath = path.join(root, 'wallet.json');
  if (!(await pathExists(defaultWalletPath))) {
    const jwk = await arweave.wallets.generate();
    await fs.writeFile(defaultWalletPath, `${JSON.stringify(jwk, null, 2)}\n`, 'utf8');
    return {
      walletPath: defaultWalletPath,
      generated: true,
      jwk
    };
  }

  const jwkRaw = await fs.readFile(defaultWalletPath, 'utf8');
  return {
    walletPath: defaultWalletPath,
    generated: false,
    jwk: JSON.parse(jwkRaw)
  };
}

async function uploadTransaction(arweave, jwk, data, tags) {
  const tx = await arweave.createTransaction({ data }, jwk);
  for (const [key, value] of tags) {
    tx.addTag(key, value);
  }

  await arweave.transactions.sign(tx, jwk);
  const uploader = await arweave.transactions.getUploader(tx);

  while (!uploader.isComplete) {
    await uploader.uploadChunk();
  }

  return tx.id;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableUploadError(message) {
  return (
    message.includes('timeout') ||
    message.includes('504') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('429') ||
    message.includes('EAI_AGAIN') ||
    message.includes('ECONNRESET') ||
    message.includes('failed to fetch')
  );
}

async function uploadWithUpService(serviceUrl, signer, data, tags) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const dataItem = createData(payload, signer, {
    tags: tags.map(([name, value]) => ({ name, value }))
  });
  await dataItem.sign(signer);
  const txId = await dataItem.id;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const startedAt = Date.now();
      const response = await fetch(`${serviceUrl.replace(/\/+$/, '')}/tx`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream'
        },
        body: dataItem.getRaw()
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(
          `up upload failed (${response.status}${bodyText ? `): ${bodyText.slice(0, 220)}` : ')'}`
        );
      }

      const elapsedMs = Date.now() - startedAt;
      let responseTxId = '';

      try {
        const bodyJson = JSON.parse(bodyText);
        if (typeof bodyJson?.id === 'string') {
          responseTxId = bodyJson.id.trim();
        }
      } catch {
        responseTxId = bodyText.trim();
      }

      const finalTxId = responseTxId || txId;
      console.log(`Upload finalized in ${elapsedMs}ms: ${finalTxId}`);
      return finalTxId;
    } catch (error) {
      const message = error?.message || String(error);
      if (!isRetriableUploadError(message) || attempt === 3) {
        throw error;
      }
      const backoffMs = 1500 * attempt;
      await sleep(backoffMs);
    }
  }

  throw new Error('up upload failed unexpectedly.');
}

function resolveUploadMode(uploadModeArg) {
  const mode = (uploadModeArg || process.env.ARWEAVE_UPLOAD_MODE || DEFAULT_UPLOAD_MODE).trim();
  if (!SUPPORTED_UPLOAD_MODES.has(mode)) {
    throw new Error(
      `Unsupported upload mode "${mode}". Supported values: ${[...SUPPORTED_UPLOAD_MODES].join(', ')}`
    );
  }
  return mode;
}

async function createUploader(uploadMode, arweave, jwk) {
  if (uploadMode === DEFAULT_UPLOAD_MODE) {
    return {
      mode: DEFAULT_UPLOAD_MODE,
      serviceUrl: null,
      async beforeUpload() {},
      upload(data, tags) {
        return uploadTransaction(arweave, jwk, data, tags);
      }
    };
  }

  const signer = new ArweaveSigner(jwk);

  return {
    mode: UP_UPLOAD_MODE,
    serviceUrl: DEFAULT_UP_UPLOAD_SERVICE,
    async beforeUpload() {},
    upload(data, tags) {
      return uploadWithUpService(DEFAULT_UP_UPLOAD_SERVICE, signer, data, tags);
    }
  };
}

async function main() {
  const walletArg = parseArg('wallet');
  const gatewayArg = parseArg('gateway');
  const uploadModeArg = parseArg('upload-mode');
  const forkedFromArg = parseArg('forked-from');
  const uploadMode = resolveUploadMode(uploadModeArg);
  const gateway = gatewayArg || process.env.ARWEAVE_GATEWAY || 'https://arweave.net';
  const forkedFrom =
    (forkedFromArg ||
      process.env.FORKED_FROM ||
      process.env.ARWEAVE_FORKED_FROM ||
      'bSpWJvwsHtzoFuJY8u8gCbTZVaLhhcq8lZnjwGwv0LQ').trim();

  await fs.access(distDir);

  const arweave = Arweave.init({
    ...buildGatewayConfig(gateway),
    timeout: 30_000,
    logging: false
  });

  const { walletPath, generated, jwk } = await loadWallet(arweave, walletArg);
  if (generated) {
    console.log(`Generated wallet: ${walletPath}`);
  } else {
    console.log(`Using wallet: ${walletPath}`);
  }
  console.log(`Gateway: ${gateway}`);
  console.log(`Upload mode: ${uploadMode}`);
  console.log(`Forked from: ${forkedFrom}`);

  const filePaths = await listFiles(distDir);
  if (!filePaths.length) {
    throw new Error('dist/ is empty. Run npm run build first.');
  }

  const uploader = await createUploader(uploadMode, arweave, jwk);
  if (uploader.serviceUrl) {
    console.log(`Upload service: ${uploader.serviceUrl}`);
  }
  await uploader.beforeUpload();

  const codeArchiveData = await createCodeArchiveBuffer();
  const codeArchiveId = await uploader.upload(codeArchiveData, [
    ['Content-Type', 'application/gzip'],
    ['Content-Encoding', 'gzip'],
    ['App-Name', 'ChronoWire-Book-Forge'],
    ['App-Version', '1.0.0'],
    ['Type', 'code-archive'],
    ['Archive-Root', '.'],
    ['forked-from', forkedFrom]
  ]);
  console.log(`Uploaded code archive: ${codeArchiveId}`);

  const pathMap = {};

  for (const absolutePath of filePaths) {
    const relativePath = path.relative(distDir, absolutePath).replace(/\\/g, '/');
    const contentType = mime.lookup(relativePath) || 'application/octet-stream';
    const data = await fs.readFile(absolutePath);

    const txId = await uploader.upload(data, [
      ['Content-Type', String(contentType)],
      ['App-Name', 'ChronoWire-Book-Forge'],
      ['App-Version', '1.0.0'],
      ['Type', 'app-asset'],
      ['File-Path', relativePath],
      ['code', codeArchiveId],
      ['forked-from', forkedFrom]
    ]);

    pathMap[relativePath] = { id: txId };
    console.log(`Uploaded ${relativePath}: ${txId}`);
  }

  const manifest = {
    manifest: 'arweave/paths',
    version: '0.2.0',
    index: { path: 'index.html' },
    paths: pathMap
  };

  const manifestId = await uploader.upload(JSON.stringify(manifest), [
    ['Content-Type', 'application/x.arweave-manifest+json'],
    ['App-Name', 'ChronoWire-Book-Forge'],
    ['App-Version', '1.0.0'],
    ['Type', 'manifest'],
    ['code', codeArchiveId],
    ['forked-from', forkedFrom]
  ]);

  const appUrl = `${gateway.replace(/\/+$/, '')}/${manifestId}/`;
  const codeArchiveUrl = `${gateway.replace(/\/+$/, '')}/${codeArchiveId}`;

  console.log('');
  console.log(`Code Archive ID: ${codeArchiveId}`);
  console.log(`Code Archive URL: ${codeArchiveUrl}`);
  console.log(`Manifest ID (AppArweaveID): ${manifestId}`);
  console.log(`App URL: ${appUrl}`);
  console.log(`Route format: /${manifestId}/#MarkdownID/PageID`);
  console.log('');
  console.log('Manifest payload:');
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
