#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRootDirectory = path.resolve(scriptDirectory, '..');
const cliPackagePath = path.join(repositoryRootDirectory, 'apps/cli/package.json');
const cliExecutablePath = path.join(repositoryRootDirectory, 'apps/cli/bin/om.mjs');
const cliPackage = JSON.parse(fs.readFileSync(cliPackagePath, 'utf8'));

function fail(message) {
  process.stderr.write(`CLI release verification failed: ${message}\n`);
  process.exit(1);
}

function runCli(argumentsList, environmentOverrides = {}) {
  const result = spawnSync(process.execPath, [cliExecutablePath, ...argumentsList], {
    cwd: repositoryRootDirectory,
    encoding: 'utf8',
    env: { ...process.env, ...environmentOverrides },
  });

  if (result.error) {
    fail(result.error.message);
  }

  if (result.status !== 0) {
    fail(`om ${argumentsList.join(' ')} exited with status ${result.status}: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

const versionOutput = runCli(['version']).trim();
if (versionOutput !== cliPackage.version) {
  fail(`om version returned ${versionOutput || 'no version'}, expected ${cliPackage.version}.`);
}

const helpOutput = runCli(['help']);
if (!helpOutput.includes('setup <claude-code|codex|openrouter|bs>')) {
  fail('The packaged CLI help does not expose the setup command.');
}

const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-release-bs-'));
const builderStudioArgumentsFilePath = path.join(temporaryDirectoryPath, 'arguments.txt');
const builderStudioExecutablePath = path.join(temporaryDirectoryPath, process.platform === 'win32' ? 'bs.cmd' : 'bs');
if (process.platform === 'win32') {
  fs.writeFileSync(builderStudioExecutablePath, `@echo %*>${builderStudioArgumentsFilePath}\r\n`, 'utf8');
} else {
  fs.writeFileSync(
    builderStudioExecutablePath,
    `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(builderStudioArgumentsFilePath)}, process.argv.slice(2).join(' ') + '\\n');\n`,
    { mode: 0o755 },
  );
}
const builderStudioSetupOutput = runCli(['setup', 'bs'], {
  PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}`,
});
if (!builderStudioSetupOutput.includes('BuilderStudio is configured')) {
  fail('om setup bs did not configure BuilderStudio through its native telemetry command.');
}
const builderStudioCommands = fs.readFileSync(builderStudioArgumentsFilePath, 'utf8').trim().split(/\r?\n/);
if (builderStudioCommands[0] !== 'telemetry enable' || builderStudioCommands[1] !== 'telemetry status') {
  fail(`om setup bs invoked an unexpected BuilderStudio command sequence: ${builderStudioCommands.join(' | ')}`);
}

process.stdout.write(`Verified @wundercorp/openmodel@${cliPackage.version}: version, help, and native BuilderStudio setup commands are available.\n`);
