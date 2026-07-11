import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const cliDirectory = path.resolve(testDirectory, '..');
const cliExecutablePath = path.join(cliDirectory, 'bin/om.mjs');
const cliPackage = JSON.parse(fs.readFileSync(path.join(cliDirectory, 'package.json'), 'utf8'));

function runCli(argumentsList, options = {}) {
  return spawnSync(process.execPath, [cliExecutablePath, ...argumentsList], {
    cwd: cliDirectory,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

test('reports the package version from the CLI', () => {
  const result = runCli(['version']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), cliPackage.version);
});

test('configures BuilderStudio through its native telemetry command', () => {
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-bs-setup-'));
  const argumentsFilePath = path.join(temporaryDirectoryPath, 'arguments.txt');
  const mockExecutablePath = path.join(temporaryDirectoryPath, 'bs');
  fs.writeFileSync(
    mockExecutablePath,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(argumentsFilePath)}, process.argv.slice(2).join(' '));\n`,
    { mode: 0o755 },
  );
  const result = runCli(['setup', 'bs'], {
    env: { PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(argumentsFilePath, 'utf8'), 'telemetry enable');
  assert.match(result.stdout, /BuilderStudio is configured/);
});


test('passes a custom collector endpoint to BuilderStudio only when the OpenModel port is overridden', () => {
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-bs-setup-port-'));
  const argumentsFilePath = path.join(temporaryDirectoryPath, 'arguments.txt');
  const mockExecutablePath = path.join(temporaryDirectoryPath, 'bs');
  fs.writeFileSync(
    mockExecutablePath,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(argumentsFilePath)}, process.argv.slice(2).join(' '));\n`,
    { mode: 0o755 },
  );
  const result = runCli(['setup', 'bs', '--port', '12000'], {
    env: { PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(argumentsFilePath, 'utf8'),
    'telemetry enable --endpoint http://127.0.0.1:12000/v1/telemetry/events',
  );
  assert.match(result.stdout, /om serve --port 12000/);
});


test('publishes a new CLI while reusing an existing gateway SDK version', () => {
  const repositoryRootDirectory = path.resolve(cliDirectory, '../..');
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-publish-plan-'));
  const commandLogPath = path.join(temporaryDirectoryPath, 'commands.jsonl');
  const mockNpmExecutablePath = path.join(temporaryDirectoryPath, 'npm');
  fs.writeFileSync(
    mockNpmExecutablePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const argumentsList = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify(argumentsList) + '\\n');
if (argumentsList[0] === 'view' && argumentsList[1].startsWith('@wundercorp/openmodel-gateway-sdk@')) {
  process.stdout.write('0.1.1\\n');
  process.exit(0);
}
if (argumentsList[0] === 'view' && argumentsList[1].startsWith('@wundercorp/openmodel@')) {
  process.stderr.write('npm error code E404\\n');
  process.exit(1);
}
if (argumentsList[0] === 'publish') {
  process.exit(0);
}
process.exit(2);
`,
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, [path.join(repositoryRootDirectory, 'scripts/publish-npm.mjs')], {
    cwd: repositoryRootDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reusing published dependency @wundercorp\/openmodel-gateway-sdk@0\.1\.1/);
  const commands = fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const publishCommands = commands.filter((argumentsList) => argumentsList[0] === 'publish');
  assert.equal(publishCommands.length, 1);
  assert.ok(publishCommands[0].includes('@wundercorp/openmodel'));
  assert.ok(!publishCommands[0].includes('@wundercorp/openmodel-gateway-sdk'));
});
