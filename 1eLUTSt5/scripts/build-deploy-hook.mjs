import { spawn } from 'node:child_process';

const root = process.cwd();

function runNpmDeployUp() {
  return new Promise((resolve, reject) => {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCommand, ['run', 'deploy:up'], {
      cwd: root,
      stdio: 'inherit',
      env: process.env
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`npm run deploy:up exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function main() {
  if (process.env.SKIP_BUILD_DEPLOY === '1') {
    console.log('Skipping deploy hook (SKIP_BUILD_DEPLOY=1).');
    return;
  }

  console.log('Build complete. Triggering deploy:up...');
  await runNpmDeployUp();
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
