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

function createPackageFixture(temporaryDirectoryPath) {
  const fixtureDirectoryPath = path.join(temporaryDirectoryPath, 'fixture');
  const fixturePackageDirectoryPath = path.join(fixtureDirectoryPath, 'package');
  const fixtureTarballPath = path.join(temporaryDirectoryPath, 'fixture.tgz');
  fs.mkdirSync(fixturePackageDirectoryPath, { recursive: true });
  fs.writeFileSync(path.join(fixturePackageDirectoryPath, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(fixturePackageDirectoryPath, 'index.js'), 'export const value = true;\n');
  const tarResult = spawnSync('tar', ['-czf', fixtureTarballPath, '-C', fixtureDirectoryPath, 'package'], { encoding: 'utf8' });
  assert.equal(tarResult.status, 0, tarResult.stderr);
  return fixtureTarballPath;
}

function writeMockNpm({ temporaryDirectoryPath, commandLogPath, fixtureTarballPath, cliExists }) {
  const mockNpmExecutablePath = path.join(temporaryDirectoryPath, 'npm');
  fs.writeFileSync(
    mockNpmExecutablePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argumentsList = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify(argumentsList) + '\\n');
if (argumentsList[0] === 'view' && argumentsList[1].startsWith('@wundercorp/openmodel-gateway-sdk@')) {
  process.stdout.write('0.1.1\\n');
  process.exit(0);
}
if (argumentsList[0] === 'view' && argumentsList[1].startsWith('@wundercorp/openmodel@')) {
  if (${JSON.stringify(cliExists)}) {
    process.stdout.write(${JSON.stringify(cliPackage.version)} + '\\n');
    process.exit(0);
  }
  process.stderr.write('npm error code E404\\n');
  process.exit(1);
}
if (argumentsList[0] === 'pack') {
  const destinationIndex = argumentsList.indexOf('--pack-destination');
  const destinationPath = argumentsList[destinationIndex + 1];
  const filename = 'fixture.tgz';
  fs.mkdirSync(destinationPath, { recursive: true });
  fs.copyFileSync(${JSON.stringify(fixtureTarballPath)}, path.join(destinationPath, filename));
  process.stdout.write(JSON.stringify([{ filename }]) + '\\n');
  process.exit(0);
}
if (argumentsList[0] === 'publish') {
  process.exit(0);
}
process.exit(2);
`,
    { mode: 0o755 },
  );
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
    `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(argumentsFilePath)}, process.argv.slice(2).join(' ') + '\\n');\n`,
    { mode: 0o755 },
  );
  const result = runCli(['setup', 'bs'], {
    env: { PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(argumentsFilePath, 'utf8').trim().split('\n'), ['telemetry enable', 'telemetry status']);
  assert.match(result.stdout, /BuilderStudio is configured/);
});

test('passes a custom collector endpoint to BuilderStudio only when the OpenModel port is overridden', () => {
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-bs-setup-port-'));
  const argumentsFilePath = path.join(temporaryDirectoryPath, 'arguments.txt');
  const mockExecutablePath = path.join(temporaryDirectoryPath, 'bs');
  fs.writeFileSync(
    mockExecutablePath,
    `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(argumentsFilePath)}, process.argv.slice(2).join(' ') + '\\n');\n`,
    { mode: 0o755 },
  );
  const result = runCli(['setup', 'bs', '--port', '12000'], {
    env: { PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    fs.readFileSync(argumentsFilePath, 'utf8').trim().split('\n'),
    ['telemetry enable --endpoint http://127.0.0.1:12000/v1/telemetry/events', 'telemetry status'],
  );
  assert.match(result.stdout, /om serve --port 12000/);
});

test('publishes a new CLI while reusing an existing matching gateway SDK version', () => {
  const repositoryRootDirectory = path.resolve(cliDirectory, '../..');
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-publish-plan-'));
  const commandLogPath = path.join(temporaryDirectoryPath, 'commands.jsonl');
  const fixtureTarballPath = createPackageFixture(temporaryDirectoryPath);
  writeMockNpm({ temporaryDirectoryPath, commandLogPath, fixtureTarballPath, cliExists: false });
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

test('continues when all selected npm versions already exist and match local package contents', () => {
  const repositoryRootDirectory = path.resolve(cliDirectory, '../..');
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-publish-existing-'));
  const commandLogPath = path.join(temporaryDirectoryPath, 'commands.jsonl');
  const fixtureTarballPath = createPackageFixture(temporaryDirectoryPath);
  writeMockNpm({ temporaryDirectoryPath, commandLogPath, fixtureTarballPath, cliExists: true });
  const result = spawnSync(process.execPath, [path.join(repositoryRootDirectory, 'scripts/publish-npm.mjs')], {
    cwd: repositoryRootDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /All selected npm package versions already exist and match/);
  const commands = fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(commands.filter((argumentsList) => argumentsList[0] === 'publish').length, 0);
});

test('automatically patch-bumps a changed CLI when its current npm version already exists', () => {
  const repositoryRootDirectory = path.resolve(cliDirectory, '../..');
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-auto-version-'));
  const fixtureRootDirectoryPath = path.join(temporaryDirectoryPath, 'repository');
  const mockBinDirectoryPath = path.join(temporaryDirectoryPath, 'bin');
  const publishedDirectoryPath = path.join(temporaryDirectoryPath, 'published');
  const publishedCliPackageDirectoryPath = path.join(publishedDirectoryPath, 'cli', 'package');
  const publishedSdkPackageDirectoryPath = path.join(publishedDirectoryPath, 'sdk', 'package');
  const publishedCliTarballPath = path.join(temporaryDirectoryPath, 'published-cli.tgz');
  const publishedSdkTarballPath = path.join(temporaryDirectoryPath, 'published-sdk.tgz');

  fs.mkdirSync(path.join(fixtureRootDirectoryPath, 'apps/cli/src'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRootDirectoryPath, 'packages/gateway-sdk/src'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRootDirectoryPath, 'scripts'), { recursive: true });
  fs.mkdirSync(mockBinDirectoryPath, { recursive: true });
  fs.mkdirSync(publishedCliPackageDirectoryPath, { recursive: true });
  fs.mkdirSync(publishedSdkPackageDirectoryPath, { recursive: true });

  fs.writeFileSync(
    path.join(fixtureRootDirectoryPath, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(fixtureRootDirectoryPath, 'apps/cli/package.json'),
    JSON.stringify({
      name: '@wundercorp/openmodel',
      version: '0.1.14',
      files: ['src'],
      dependencies: { '@wundercorp/openmodel-gateway-sdk': '0.1.1' },
    }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(fixtureRootDirectoryPath, 'packages/gateway-sdk/package.json'),
    JSON.stringify({
      name: '@wundercorp/openmodel-gateway-sdk',
      version: '0.1.1',
      files: ['src'],
    }, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(fixtureRootDirectoryPath, 'apps/cli/src/index.js'), 'export const release = "local-new";\n');
  fs.writeFileSync(path.join(fixtureRootDirectoryPath, 'packages/gateway-sdk/src/index.js'), 'export const sdk = true;\n');
  fs.writeFileSync(
    path.join(fixtureRootDirectoryPath, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'fixture', workspaces: ['apps/*', 'packages/*'] },
        'apps/cli': {
          name: '@wundercorp/openmodel',
          version: '0.1.14',
          dependencies: { '@wundercorp/openmodel-gateway-sdk': '0.1.1' },
        },
        'packages/gateway-sdk': {
          name: '@wundercorp/openmodel-gateway-sdk',
          version: '0.1.1',
        },
      },
    }, null, 2) + '\n',
  );

  for (const scriptName of ['prepare-npm-release.mjs', 'verify-published-package-contents.mjs', 'version-bump.mjs']) {
    fs.copyFileSync(
      path.join(repositoryRootDirectory, 'scripts', scriptName),
      path.join(fixtureRootDirectoryPath, 'scripts', scriptName),
    );
  }

  fs.writeFileSync(
    path.join(publishedCliPackageDirectoryPath, 'package.json'),
    JSON.stringify({
      name: '@wundercorp/openmodel',
      version: '0.1.14',
      files: ['src'],
      dependencies: { '@wundercorp/openmodel-gateway-sdk': '0.1.1' },
    }, null, 2) + '\n',
  );
  fs.mkdirSync(path.join(publishedCliPackageDirectoryPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(publishedCliPackageDirectoryPath, 'src/index.js'), 'export const release = "published-old";\n');

  fs.writeFileSync(
    path.join(publishedSdkPackageDirectoryPath, 'package.json'),
    JSON.stringify({
      name: '@wundercorp/openmodel-gateway-sdk',
      version: '0.1.1',
      files: ['src'],
    }, null, 2) + '\n',
  );
  fs.mkdirSync(path.join(publishedSdkPackageDirectoryPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(publishedSdkPackageDirectoryPath, 'src/index.js'), 'export const sdk = true;\n');

  assert.equal(
    spawnSync('tar', ['-czf', publishedCliTarballPath, '-C', path.join(publishedDirectoryPath, 'cli'), 'package'], { encoding: 'utf8' }).status,
    0,
  );
  assert.equal(
    spawnSync('tar', ['-czf', publishedSdkTarballPath, '-C', path.join(publishedDirectoryPath, 'sdk'), 'package'], { encoding: 'utf8' }).status,
    0,
  );

  const mockNpmExecutablePath = path.join(mockBinDirectoryPath, 'npm');
  fs.writeFileSync(
    mockNpmExecutablePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const argumentsList = process.argv.slice(2);
if (argumentsList[0] === 'view') {
  const packageSpecifier = argumentsList[1];
  if (packageSpecifier === '@wundercorp/openmodel-gateway-sdk@0.1.1') {
    process.stdout.write('0.1.1\\n');
    process.exit(0);
  }
  if (packageSpecifier === '@wundercorp/openmodel@0.1.14') {
    process.stdout.write('0.1.14\\n');
    process.exit(0);
  }
  process.stderr.write('npm error code E404\\n');
  process.exit(1);
}
if (argumentsList[0] === 'pack') {
  const destinationIndex = argumentsList.indexOf('--pack-destination');
  const destinationPath = argumentsList[destinationIndex + 1];
  fs.mkdirSync(destinationPath, { recursive: true });
  let tarballPath;
  let filename;
  if (argumentsList[1] === '--workspace') {
    const workspaceName = argumentsList[2];
    const workspaceDirectory = workspaceName === '@wundercorp/openmodel'
      ? path.join(${JSON.stringify(fixtureRootDirectoryPath)}, 'apps/cli')
      : path.join(${JSON.stringify(fixtureRootDirectoryPath)}, 'packages/gateway-sdk');
    const stagingDirectory = fs.mkdtempSync(path.join(${JSON.stringify(temporaryDirectoryPath)}, 'local-pack-'));
    const packageDirectory = path.join(stagingDirectory, 'package');
    fs.cpSync(workspaceDirectory, packageDirectory, { recursive: true });
    filename = workspaceName === '@wundercorp/openmodel' ? 'local-cli.tgz' : 'local-sdk.tgz';
    tarballPath = path.join(destinationPath, filename);
    const tarResult = spawnSync('tar', ['-czf', tarballPath, '-C', stagingDirectory, 'package']);
    process.exitCode = tarResult.status || 0;
  } else {
    const packageSpecifier = argumentsList[1];
    filename = packageSpecifier.startsWith('@wundercorp/openmodel-gateway-sdk@') ? 'published-sdk.tgz' : 'published-cli.tgz';
    const sourcePath = packageSpecifier.startsWith('@wundercorp/openmodel-gateway-sdk@')
      ? ${JSON.stringify(publishedSdkTarballPath)}
      : ${JSON.stringify(publishedCliTarballPath)};
    tarballPath = path.join(destinationPath, filename);
    fs.copyFileSync(sourcePath, tarballPath);
  }
  process.stdout.write(JSON.stringify([{ filename }]) + '\\n');
  process.exit(process.exitCode || 0);
}
process.exit(2);
`,
    { mode: 0o755 },
  );

  const result = spawnSync(
    process.execPath,
    [path.join(fixtureRootDirectoryPath, 'scripts/prepare-npm-release.mjs')],
    {
      cwd: fixtureRootDirectoryPath,
      encoding: 'utf8',
      env: {
        ...process.env,
        OPENMODEL_RELEASE_ROOT: fixtureRootDirectoryPath,
        PATH: `${mockBinDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Automatically incrementing @wundercorp\/openmodel/);
  const updatedCliPackage = JSON.parse(fs.readFileSync(path.join(fixtureRootDirectoryPath, 'apps/cli/package.json'), 'utf8'));
  const updatedSdkPackage = JSON.parse(fs.readFileSync(path.join(fixtureRootDirectoryPath, 'packages/gateway-sdk/package.json'), 'utf8'));
  const updatedLockfile = JSON.parse(fs.readFileSync(path.join(fixtureRootDirectoryPath, 'package-lock.json'), 'utf8'));
  assert.equal(updatedCliPackage.version, '0.1.15');
  assert.equal(updatedSdkPackage.version, '0.1.1');
  assert.equal(updatedLockfile.packages['apps/cli'].version, '0.1.15');
});
