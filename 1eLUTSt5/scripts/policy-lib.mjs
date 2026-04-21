import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const root = process.cwd();
export const agentsPath = path.join(root, 'AGENTS.md');
export const ackPath = path.join(root, '.agents-ack.json');
export const lastDeployPath = path.join(root, 'data', 'last-deploy.json');

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git']);
const EXCLUDED_FILES = new Set(['wallet.json', '.agents-ack.json', 'data/last-deploy.json']);

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function shouldInclude(relativePath) {
  if (!relativePath) return false;

  const normalized = relativePath.replace(/\\/g, '/');

  if (EXCLUDED_FILES.has(normalized)) {
    return false;
  }

  const parts = normalized.split('/');
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) {
    return false;
  }

  return true;
}

async function listFilesRecursive(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(root, absolutePath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      files.push(...(await listFilesRecursive(absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!shouldInclude(relativePath)) {
      continue;
    }

    files.push({ absolutePath, relativePath });
  }

  return files;
}

export async function computeSourceFingerprint() {
  const files = (await listFilesRecursive(root)).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );

  const digest = createHash('sha256');
  let latestMtimeMs = 0;

  for (const file of files) {
    const [content, stats] = await Promise.all([
      fs.readFile(file.absolutePath),
      fs.stat(file.absolutePath)
    ]);

    const fileHash = sha256(content);
    digest.update(file.relativePath);
    digest.update('\n');
    digest.update(fileHash);
    digest.update('\n');

    if (stats.mtimeMs > latestMtimeMs) {
      latestMtimeMs = stats.mtimeMs;
    }
  }

  return {
    sourceHash: digest.digest('hex'),
    fileCount: files.length,
    latestMtimeMs
  };
}

export async function readAgentsHash() {
  const body = await fs.readFile(agentsPath, 'utf8');
  return sha256(body);
}

export async function readAckFile() {
  const raw = await fs.readFile(ackPath, 'utf8');
  return JSON.parse(raw);
}

export async function readLastDeployEvidence() {
  const raw = await fs.readFile(lastDeployPath, 'utf8');
  return JSON.parse(raw);
}
