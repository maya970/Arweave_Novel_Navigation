import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.cwd();
const agentsPath = path.join(root, 'AGENTS.md');
const ackPath = path.join(root, '.agents-ack.json');

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

async function main() {
  const agentsBody = await fs.readFile(agentsPath, 'utf8');
  const payload = {
    agentsPath: 'AGENTS.md',
    sha256: sha256(agentsBody),
    ackedAt: new Date().toISOString()
  };

  await fs.writeFile(ackPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log('Acknowledged AGENTS.md');
  console.log(`Hash: ${payload.sha256}`);
  console.log(`Wrote: ${ackPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
