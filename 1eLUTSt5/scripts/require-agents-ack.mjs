import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.cwd();
const agentsPath = path.join(root, 'AGENTS.md');
const ackPath = path.join(root, '.agents-ack.json');

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await fileExists(agentsPath))) {
    fail('AGENTS.md is missing. Restore it before build.');
  }

  const agentsBody = await fs.readFile(agentsPath, 'utf8');
  const currentHash = sha256(agentsBody);

  if (!(await fileExists(ackPath))) {
    fail('AGENTS.md must be acknowledged before build. Run: npm run agents:ack');
  }

  let ack;
  try {
    ack = JSON.parse(await fs.readFile(ackPath, 'utf8'));
  } catch {
    fail('Invalid .agents-ack.json. Re-run: npm run agents:ack');
  }

  if (!ack || typeof ack.sha256 !== 'string' || !ack.sha256) {
    fail('Missing AGENTS hash in .agents-ack.json. Re-run: npm run agents:ack');
  }

  if (ack.sha256 !== currentHash) {
    fail('AGENTS.md changed since last acknowledgment. Run: npm run agents:ack');
  }
}

main().catch((error) => {
  fail(error.message || String(error));
});
