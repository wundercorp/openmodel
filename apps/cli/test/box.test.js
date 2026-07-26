import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractBoxId, extractHostedUrl, parseBoxJsonLines } from '../src/lib/box.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const cliDirectory = path.resolve(testDirectory, '..');
const cliExecutablePath = path.join(cliDirectory, 'bin/om.mjs');

function runCli(argumentsList, options = {}) {
  return spawnSync(process.execPath, [cliExecutablePath, ...argumentsList], {
    cwd: options.cwd ?? cliDirectory,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

function writeMockBox(temporaryDirectoryPath, commandLogPath) {
  const executablePath = path.join(temporaryDirectoryPath, 'box');
  fs.writeFileSync(
    executablePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const argumentsList = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify(argumentsList) + '\\n');
const command = argumentsList[0];
if (process.env.MOCK_BOX_JSON_ERROR_COMMAND === command) {
  process.stdout.write(JSON.stringify({ event: 'error', code: 'billing_required', message: 'Plan required' }) + '\\n');
  process.exit(4);
}
if (process.env.MOCK_BOX_FAIL_COMMAND === command) {
  process.stderr.write('Mock failure for ' + command + '\\n');
  process.exit(3);
}
if (command === 'login') {
  process.stdout.write(JSON.stringify({ event: 'login_complete' }) + '\\n');
  process.exit(0);
}
if (command === 'status') {
  process.stdout.write(JSON.stringify({ event: 'status', authenticated: true }) + '\\n');
  process.exit(0);
}
if (command === 'new') {
  process.stdout.write(JSON.stringify({ event: 'created', box: { id: 'bx_openmodel_test' } }) + '\\n');
  process.stdout.write(JSON.stringify({ event: 'ready', id: 'bx_openmodel_test' }) + '\\n');
  process.exit(0);
}
if (command === 'fork') {
  process.stdout.write(JSON.stringify({ event: 'created', id: 'bx_openmodel_fork' }) + '\\n');
  process.stdout.write(JSON.stringify({ event: 'ready', boxId: 'bx_openmodel_fork' }) + '\\n');
  process.exit(0);
}
if (command === 'prompt') {
  process.stdout.write(JSON.stringify({ event: 'agent_message', text: 'Finished' }) + '\\n');
  process.stdout.write(JSON.stringify({ event: 'complete', boxId: argumentsList[1] }) + '\\n');
  process.exit(0);
}
if (command === 'host') {
  process.stdout.write(JSON.stringify({ boxId: argumentsList[1], port: Number(argumentsList[2]), url: 'https://openmodel-test-3000.on.ascii.dev?_token=secret', access: 'private', isProtected: true }) + '\\n');
  process.exit(0);
}
if (['scp', 'ssh', 'stop', 'resume', 'list', 'info', 'delete', 'desktop', 'events', 'interrupt', 'forward', 'snapshots', 'snapshot', 'extend', 'limits', 'dashboard', 'config'].includes(command)) {
  process.exit(0);
}
process.stderr.write('Unexpected command: ' + command + '\\n');
process.exit(2);
`,
    { mode: 0o755 },
  );
}

test('parses Box JSONL and extracts ids and hosted URLs', () => {
  const records = parseBoxJsonLines([
    JSON.stringify({ event: 'created', box: { id: 'bx_created' } }),
    JSON.stringify({ event: 'ready', data: { boxId: 'bx_ready' } }),
    JSON.stringify({ url: 'https://example.on.ascii.dev?_token=value' }),
  ].join('\n'));
  assert.equal(extractBoxId(records), 'bx_ready');
  assert.equal(extractHostedUrl(records), 'https://example.on.ascii.dev?_token=value');
});

test('uses BuilderStudio bs as the primary default agent inside new Boxes', () => {
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-box-bs-primary-'));
  const commandLogPath = path.join(temporaryDirectoryPath, 'commands.jsonl');
  const projectDirectoryPath = path.join(temporaryDirectoryPath, 'sample-project');
  fs.mkdirSync(projectDirectoryPath, { recursive: true });
  fs.writeFileSync(path.join(projectDirectoryPath, 'package.json'), '{"name":"sample-project"}\n');
  writeMockBox(temporaryDirectoryPath, commandLogPath);

  const result = runCli([
    'box',
    'create',
    'Run the tests and fix failures',
    '--project',
    projectDirectoryPath,
    '--env',
    'OPENROUTER_API_KEY',
    '--json',
  ], {
    env: {
      PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}`,
      BOX_API_KEY: 'box-api-key-value',
      OPENROUTER_API_KEY: 'openrouter-secret-value',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /box-api-key-value|openrouter-secret-value/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.agent, 'bs');
  assert.equal(payload.agentLabel, 'BuilderStudio bs');
  assert.equal(payload.primaryAgent, true);
  assert.equal(payload.provider, 'bs');
  assert.equal(payload.agentSetup.package, '@wundercorp/bs');
  assert.deepEqual(payload.copiedEnvironmentVariables, ['OPENROUTER_API_KEY']);
  assert.match(payload.manage.prompt, /--agent bs/);
  assert.match(payload.manage.prompt, /--workdir \/home\/user\/sample-project/);

  const commands = fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const createCommand = commands.find((argumentsList) => argumentsList[0] === 'new');
  assert.ok(createCommand);
  assert.ok(createCommand.includes('--no-env'));
  assert.ok(createCommand.includes('OPENROUTER_API_KEY=openrouter-secret-value'));
  const sshCommands = commands.filter((argumentsList) => argumentsList[0] === 'ssh');
  assert.ok(sshCommands.some((argumentsList) => argumentsList.some((value) => value.includes('npm install --global @wundercorp/bs'))));
  assert.ok(sshCommands.some((argumentsList) => argumentsList.some((value) => value.includes('bs init --workspace'))));
  assert.ok(sshCommands.some((argumentsList) => argumentsList.some((value) => value.includes("bs gain 'Run the tests and fix failures'"))));
  assert.ok(!commands.some((argumentsList) => argumentsList[0] === 'prompt'));
});

test('requires explicit OpenRouter model access before creating a fresh bs agent Box', () => {
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-box-bs-key-'));
  const commandLogPath = path.join(temporaryDirectoryPath, 'commands.jsonl');
  writeMockBox(temporaryDirectoryPath, commandLogPath);

  const result = runCli(['box', 'create', 'Review this repository'], {
    env: {
      PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}`,
      BOX_API_KEY: 'box-api-key-value',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--env OPENROUTER_API_KEY/);
  const commands = fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(commands.some((argumentsList) => argumentsList[0] === 'login'));
  assert.ok(!commands.some((argumentsList) => argumentsList[0] === 'new'));
});

test('prompts existing Boxes with BuilderStudio bs by default', () => {
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-box-bs-prompt-'));
  const commandLogPath = path.join(temporaryDirectoryPath, 'commands.jsonl');
  writeMockBox(temporaryDirectoryPath, commandLogPath);

  const result = runCli([
    'box',
    'prompt',
    'bx_existing',
    'Review the current changes',
    '--workdir',
    '/home/user/sample-project',
    '--bs-mode',
    'ask',
    '--model',
    'openrouter/auto',
    '--json',
  ], {
    env: {
      PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}`,
      BOX_API_KEY: 'box-api-key-value',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const commands = fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const sshCommands = commands.filter((argumentsList) => argumentsList[0] === 'ssh');
  assert.ok(sshCommands.some((argumentsList) => argumentsList.some((value) => value.includes('npm install --global @wundercorp/bs'))));
  assert.ok(sshCommands.some((argumentsList) => argumentsList.some((value) => value.includes("bs ask 'Review the current changes' --model 'openrouter/auto'"))));
  assert.ok(sshCommands.some((argumentsList) => argumentsList.some((value) => value.includes("cd '/home/user/sample-project'"))));
  assert.ok(!commands.some((argumentsList) => argumentsList[0] === 'prompt'));
});

test('creates an isolated Box, uploads a project, and starts the selected agent', () => {
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-box-create-'));
  const commandLogPath = path.join(temporaryDirectoryPath, 'commands.jsonl');
  const projectDirectoryPath = path.join(temporaryDirectoryPath, 'sample-project');
  fs.mkdirSync(projectDirectoryPath, { recursive: true });
  fs.writeFileSync(path.join(projectDirectoryPath, 'package.json'), '{"name":"sample-project"}\n');
  writeMockBox(temporaryDirectoryPath, commandLogPath);

  const result = runCli([
    'box',
    'create',
    'Run the tests',
    '--project',
    projectDirectoryPath,
    '--agent',
    'codex',
    '--env',
    'OPENMODEL_TEST_AGENT_TOKEN',
    '--port',
    '3000',
    '--skip-verify',
    '--json',
  ], {
    env: {
      PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}`,
      BOX_API_KEY: 'box-api-key-value',
      OPENMODEL_TEST_AGENT_TOKEN: 'agent-secret-value',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /box-api-key-value|agent-secret-value/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.boxId, 'bx_openmodel_test');
  assert.equal(payload.provider, 'codex');
  assert.equal(payload.project.remotePath, '/home/user/sample-project');
  assert.deepEqual(payload.copiedEnvironmentVariables, ['OPENMODEL_TEST_AGENT_TOKEN']);
  assert.equal(payload.prompted, true);
  assert.equal(payload.hosted.access, 'private');

  const commands = fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(commands[0].slice(0, 1), ['login']);
  assert.ok(commands.some((argumentsList) => argumentsList[0] === 'new' && argumentsList.includes('--no-env') && argumentsList.includes('--no-auto-stop')));
  assert.ok(commands.some((argumentsList) => argumentsList[0] === 'scp' && argumentsList.includes('--recursive')));
  const hostCommand = commands.find((argumentsList) => argumentsList[0] === 'host');
  assert.ok(hostCommand);
  assert.ok(!hostCommand.includes('--public'));
  assert.ok(!hostCommand.includes('--private'));
  const promptCommand = commands.find((argumentsList) => argumentsList[0] === 'prompt');
  assert.ok(promptCommand);
  assert.ok(promptCommand.includes('--provider'));
  assert.ok(promptCommand.includes('codex'));
  assert.match(promptCommand.find((value) => value.includes('Work in /home/user/sample-project')), /Work in \/home\/user\/sample-project/);
});

test('supports template forks and lifecycle passthrough', () => {
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-box-template-'));
  const commandLogPath = path.join(temporaryDirectoryPath, 'commands.jsonl');
  writeMockBox(temporaryDirectoryPath, commandLogPath);
  const environment = {
    PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}`,
    BOX_API_KEY: 'box-api-key-value',
  };

  const createResult = runCli(['box', 'create', '--template', 'bx_template', '--json'], { env: environment });
  assert.equal(createResult.status, 0, createResult.stderr);
  assert.equal(JSON.parse(createResult.stdout).boxId, 'bx_openmodel_fork');

  const stopResult = runCli(['box', 'stop', 'bx_openmodel_fork', '--json'], { env: environment });
  assert.equal(stopResult.status, 0, stopResult.stderr);

  const statusResult = runCli(['box', 'status', 'bx_openmodel_fork', '--json'], { env: environment });
  assert.equal(statusResult.status, 0, statusResult.stderr);

  const commands = fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(commands.some((argumentsList) => argumentsList[0] === 'fork' && argumentsList.includes('--no-env')));
  assert.ok(commands.some((argumentsList) => argumentsList[0] === 'stop' && argumentsList.includes('bx_openmodel_fork')));
  assert.ok(commands.some((argumentsList) => argumentsList[0] === 'info' && argumentsList.includes('bx_openmodel_fork')));
});


test('stops a newly created Box when configuration fails', () => {
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-box-cleanup-'));
  const commandLogPath = path.join(temporaryDirectoryPath, 'commands.jsonl');
  const projectDirectoryPath = path.join(temporaryDirectoryPath, 'sample-project');
  fs.mkdirSync(projectDirectoryPath, { recursive: true });
  writeMockBox(temporaryDirectoryPath, commandLogPath);

  const result = runCli(['box', 'create', '--project', projectDirectoryPath], {
    env: {
      PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}`,
      BOX_API_KEY: 'box-api-key-value',
      MOCK_BOX_FAIL_COMMAND: 'scp',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OpenModel stopped bx_openmodel_test after the failure/);
  const commands = fs.readFileSync(commandLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(commands.some((argumentsList) => argumentsList[0] === 'stop' && argumentsList[1] === 'bx_openmodel_test'));
});


test('parses Box JSONL errors from nonzero command exits', () => {
  const temporaryDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openmodel-box-json-error-'));
  const commandLogPath = path.join(temporaryDirectoryPath, 'commands.jsonl');
  writeMockBox(temporaryDirectoryPath, commandLogPath);

  const result = runCli(['box', 'create'], {
    env: {
      PATH: `${temporaryDirectoryPath}${path.delimiter}${process.env.PATH ?? ''}`,
      BOX_API_KEY: 'box-api-key-value',
      MOCK_BOX_JSON_ERROR_COMMAND: 'new',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Box billing is not active/);
  assert.doesNotMatch(result.stderr, /box-api-key-value/);
});
