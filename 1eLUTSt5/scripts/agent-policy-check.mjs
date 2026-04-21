import {
  pathExists,
  agentsPath,
  ackPath,
  lastDeployPath,
  readAgentsHash,
  readAckFile,
  readLastDeployEvidence,
  computeSourceFingerprint
} from './policy-lib.mjs';

function parseArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) return '';
  return raw.slice(name.length + 3).trim();
}

function failWithActions(messages, actions) {
  for (const message of messages) {
    console.error(message);
  }
  console.error('');
  console.error('Remediation:');
  for (const action of actions) {
    console.error(`- ${action}`);
  }
  process.exit(1);
}

async function validateAgentsAck() {
  if (!(await pathExists(agentsPath))) {
    failWithActions(
      ['Policy check failed: AGENTS.md is missing.'],
      ['Restore AGENTS.md from template/repo history.']
    );
  }

  if (!(await pathExists(ackPath))) {
    failWithActions(
      ['Policy check failed: AGENTS.md has not been acknowledged.'],
      ['npm run agents:ack']
    );
  }

  let ack;
  try {
    ack = await readAckFile();
  } catch {
    failWithActions(
      ['Policy check failed: .agents-ack.json is invalid JSON.'],
      ['npm run agents:ack']
    );
  }

  if (!ack || typeof ack.sha256 !== 'string' || !ack.sha256.trim()) {
    failWithActions(
      ['Policy check failed: .agents-ack.json is missing a valid AGENTS.md hash.'],
      ['npm run agents:ack']
    );
  }

  const currentAgentsHash = await readAgentsHash();
  if (ack.sha256 !== currentAgentsHash) {
    failWithActions(
      ['Policy check failed: AGENTS.md changed and has not been re-acknowledged.'],
      ['npm run agents:ack', 'npm run ship']
    );
  }
}

function validateLastDeployShape(payload) {
  const requiredFields = ['timestamp', 'manifestId', 'codeArchiveId', 'gateway', 'forkedFrom', 'sourceHash'];
  const missing = requiredFields.filter((field) => {
    const value = payload?.[field];
    return typeof value !== 'string' || !value.trim();
  });
  return missing;
}

async function validateDeployEvidence({ context }) {
  const allowUndeployedSource = process.env.ALLOW_UNDEPLOYED_SOURCE === '1';
  const fingerprint = await computeSourceFingerprint();

  if (!(await pathExists(lastDeployPath))) {
    if (context === 'predeploy' || allowUndeployedSource) {
      console.log('Policy check: no deploy evidence yet; continuing because deploy is running.');
      return;
    }

    failWithActions(
      [
        'Policy check failed: no deploy evidence found at data/last-deploy.json.',
        'App source cannot be treated as compliant until a deploy records evidence.'
      ],
      ['npm run ship', 'npm run deploy:up']
    );
  }

  let deployEvidence;
  try {
    deployEvidence = await readLastDeployEvidence();
  } catch {
    failWithActions(
      ['Policy check failed: data/last-deploy.json is invalid JSON.'],
      ['npm run ship']
    );
  }

  const missingFields = validateLastDeployShape(deployEvidence);
  if (missingFields.length) {
    failWithActions(
      [
        'Policy check failed: data/last-deploy.json is missing required fields.',
        `Missing: ${missingFields.join(', ')}`
      ],
      ['npm run ship']
    );
  }

  if (deployEvidence.sourceHash !== fingerprint.sourceHash) {
    if (context === 'predeploy' || allowUndeployedSource) {
      console.log('Policy check: source changes detected since last deploy; continuing because deploy is running.');
      return;
    }

    failWithActions(
      [
        'Policy check failed: app source changed after the last recorded deploy.',
        `Last deployed manifest: ${deployEvidence.manifestId}`,
        `Last deployed at: ${deployEvidence.timestamp}`
      ],
      ['npm run ship', 'npm run deploy:up']
    );
  }

  console.log('Policy check passed: source hash matches last deploy evidence.');
}

async function main() {
  const context = parseArg('context') || 'policy-check';

  await validateAgentsAck();
  await validateDeployEvidence({ context });

  if (context === 'predeploy') {
    console.log('Policy check passed for predeploy.');
  } else {
    console.log('Policy check passed.');
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
