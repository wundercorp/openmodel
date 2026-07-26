import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { getFlag, getFlags } from './args.js';
import { commandExists, runProcess } from './process.js';

const boxInstallCommand = 'curl -fsSL https://box.ascii.dev/install | sh';
const builderStudioPackageName = '@wundercorp/bs';
const builderStudioInstallCommand = `npm install --global ${builderStudioPackageName}`;
const supportedAgents = new Map([
  ['bs', { id: 'bs', label: 'BuilderStudio bs', cliName: 'bs', boxProvider: undefined, primary: true }],
  ['builderstudio', { id: 'bs', label: 'BuilderStudio bs', cliName: 'bs', boxProvider: undefined, primary: true }],
  ['builderstudio-bs', { id: 'bs', label: 'BuilderStudio bs', cliName: 'bs', boxProvider: undefined, primary: true }],
  ['claude', { id: 'claude-code', label: 'Claude Code', cliName: 'claude-code', boxProvider: 'claude', primary: false }],
  ['claude-code', { id: 'claude-code', label: 'Claude Code', cliName: 'claude-code', boxProvider: 'claude', primary: false }],
  ['codex', { id: 'codex', label: 'Codex', cliName: 'codex', boxProvider: 'codex', primary: false }]
]);

export function boxHelpText() {
  return `om box <command> [options]

Commands:
  setup [--install]
  create [prompt] [--project path] [--agent bs|claude-code|codex]
         [--template box-id] [--env NAME] [--setup-command command]
         [--start-command command] [--port N] [--public] [--json]
         [--bs-mode gain|ask|plan|agent|swarm] [--skip-agent-install]
  prompt <box-id> <prompt> [--agent bs|claude-code|codex] [--model name]
         [--workdir path] [--bs-mode gain|ask|plan|agent|swarm]
         [--skip-agent-install] [--json]
  list|status|info|stop|resume|fork|delete|desktop|ssh|scp|host [...box arguments]
  events|interrupt|forward|snapshots|snapshot|extend|limits|dashboard [...box arguments]

Examples:
  export BOX_API_KEY=your_box_api_key
  export OPENROUTER_API_KEY=your_openrouter_api_key
  om box setup
  om box create "Run the tests and fix failures" --project . --env OPENROUTER_API_KEY
  om box create "Review the repository" --project . --agent claude-code
  om box create "Review the repository" --project . --agent codex
  om box prompt bx_example "Review the current changes" --agent bs --workdir /home/user/project
  om box stop bx_example
  om box resume bx_example

Agent priority:
  BuilderStudio bs is the default and is installed inside the VM from
  @wundercorp/bs. Claude Code and Codex remain optional secondary agents.

Secrets:
  Use --env NAME to copy an existing environment variable into a newly created
  no-env Box. OpenModel never prints the value. BuilderStudio bs normally needs
  OPENROUTER_API_KEY in a fresh VM, so pass --env OPENROUTER_API_KEY explicitly.
`;
}

export function parseBoxJsonLines(output) {
  const records = [];
  for (const rawLine of String(output ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      records.push({ event: 'text', text: line });
    }
  }
  return records;
}

function findNestedValue(value, keys, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return undefined;
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const nestedValue of Object.values(value)) {
    const found = findNestedValue(nestedValue, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function extractBoxId(records) {
  const orderedRecords = [
    ...records.filter((record) => ['ready', 'idle'].includes(String(record?.event ?? '').toLowerCase())),
    ...records.filter((record) => String(record?.event ?? '').toLowerCase() === 'created'),
    ...records
  ];
  for (const record of orderedRecords) {
    const id = findNestedValue(record, ['boxId', 'box_id', 'id']);
    if (id && /^bx[_-]/i.test(id)) return id;
  }
  return undefined;
}

export function extractHostedUrl(records) {
  for (const record of [...records].reverse()) {
    const url = findNestedValue(record, ['url', 'publicUrl', 'public_url']);
    if (url && /^https:\/\//i.test(url)) return url;
  }
  return undefined;
}

function boxErrorFromRecords(records) {
  const errorRecord = records.find((record) => String(record?.event ?? '').toLowerCase() === 'error');
  if (!errorRecord) return undefined;
  const code = findNestedValue(errorRecord, ['code', 'errorCode', 'error_code']);
  const message = findNestedValue(errorRecord, ['message', 'error', 'detail']) ?? 'Box command failed.';
  if (code === 'billing_required') {
    return new Error('Box billing is not active. Choose a plan in the Box dashboard, then retry.');
  }
  if (code === 'provider_not_configured') {
    return new Error('The selected secondary Box agent provider is not configured. Configure Claude Code or Codex in the Box dashboard, then retry.');
  }
  if (code && /rate|limit/i.test(code)) {
    return new Error(`Box temporarily rejected the request (${code}). Wait briefly and retry.`);
  }
  return new Error(code ? `${message} (${code})` : message);
}

function assertNoBoxError(records) {
  const error = boxErrorFromRecords(records);
  if (error) throw error;
}

function normalizeAgent(value) {
  const normalized = String(value ?? 'bs').toLowerCase();
  const agent = supportedAgents.get(normalized);
  if (!agent) throw new Error('Agent must be bs, builderstudio, claude-code, claude, or codex.');
  return agent;
}

function normalizeBuilderStudioMode(value) {
  const normalized = String(value ?? 'gain').toLowerCase();
  if (!['gain', 'ask', 'plan', 'agent', 'swarm'].includes(normalized)) {
    throw new Error('--bs-mode must be gain, ask, plan, agent, or swarm.');
  }
  return normalized;
}

function progress(message, asJson) {
  if (!asJson) process.stdout.write(`${message}\n`);
}

function appendJsonFlag(argumentsList) {
  return argumentsList.includes('--json') ? argumentsList : [...argumentsList, '--json'];
}

async function runCapturedBox(argumentsList) {
  const result = await runProcess('box', appendJsonFlag(argumentsList), { capture: true, allowFailure: true });
  const records = parseBoxJsonLines(result.stdout);
  assertNoBoxError(records);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`Box command failed: ${detail}`);
  }
  return { ...result, records };
}

async function ensureBoxCliInstalled({ install = false } = {}) {
  if (await commandExists('box')) return;
  if (!install) {
    throw new Error(`Box CLI is not installed. Run: ${boxInstallCommand}, or run om box setup --install.`);
  }
  if (process.platform === 'win32') {
    throw new Error('Install Box in PowerShell with: irm https://box.ascii.dev/install.ps1 | iex');
  }
  await runProcess('/bin/sh', ['-c', boxInstallCommand]);
  if (!(await commandExists('box'))) {
    throw new Error('Box CLI installation completed, but box is not available on PATH. Open a new terminal and run om box setup.');
  }
}

async function authenticateBox() {
  const apiKey = process.env.BOX_API_KEY?.trim();
  if (apiKey) {
    const result = await runCapturedBox(['login', apiKey]);
    const completed = result.records.some((record) => String(record?.event ?? '').toLowerCase() === 'login_complete');
    if (!completed && result.records.length === 0) {
      throw new Error('Box login did not return a completion event.');
    }
    return { method: 'api-key' };
  }

  try {
    await runCapturedBox(['status']);
    return { method: 'existing-session' };
  } catch {
    throw new Error('Set BOX_API_KEY to a Box API key, or authenticate with box login, then retry. OpenModel never prints the key.');
  }
}

async function prepareBox({ install = false } = {}) {
  await ensureBoxCliInstalled({ install });
  return authenticateBox();
}

function environmentArguments(flags) {
  const requestedValues = getFlags(flags, 'env');
  const argumentsList = [];
  const names = [];

  for (const requestedValue of requestedValues) {
    if (requestedValue === true || requestedValue === '') {
      throw new Error('--env requires NAME or NAME=VALUE.');
    }
    const rawValue = String(requestedValue);
    const separatorIndex = rawValue.indexOf('=');
    const name = separatorIndex === -1 ? rawValue : rawValue.slice(0, separatorIndex);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid Box environment variable name "${name}".`);
    }
    const value = separatorIndex === -1 ? process.env[name] : rawValue.slice(separatorIndex + 1);
    if (value === undefined) {
      throw new Error(`Environment variable ${name} is not set in the current shell.`);
    }
    argumentsList.push('--env', `${name}=${value}`);
    names.push(name);
  }

  return { argumentsList, names };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function builderStudioCommand(mode, prompt, model) {
  const commandParts = mode === 'agent'
    ? ['bs', 'agent', 'run']
    : mode === 'swarm'
      ? ['bs', 'swarm', 'run']
      : ['bs', mode];
  commandParts.push(shellQuote(prompt));
  if (model) commandParts.push('--model', shellQuote(String(model)));
  return commandParts.join(' ');
}

function builderStudioInstallScript() {
  return [
    'if ! command -v bs >/dev/null 2>&1; then',
    '  command -v npm >/dev/null 2>&1 || { echo "BuilderStudio bs requires Node.js and npm inside the Box." >&2; exit 127; }',
    `  if ! ${builderStudioInstallCommand}; then`,
    '    command -v sudo >/dev/null 2>&1 || { echo "Unable to install BuilderStudio bs globally. Re-run with a writable npm prefix or install it manually." >&2; exit 126; }',
    `    sudo ${builderStudioInstallCommand}`,
    '  fi',
    'fi',
    'command -v bs >/dev/null 2>&1 || { echo "BuilderStudio bs installation completed but the bs executable is not available on PATH." >&2; exit 127; }'
  ].join('\n');
}

async function ensureBuilderStudioAgent(boxId, asJson, skipInstall = false) {
  if (skipInstall) return { package: builderStudioPackageName, installed: false, skipped: true };
  await runRemoteCommand(
    boxId,
    builderStudioInstallScript(),
    asJson,
    `Installing ${builderStudioPackageName} inside the Box when needed...`
  );
  return { package: builderStudioPackageName, installed: true, skipped: false };
}

async function runBuilderStudioAgent(boxId, prompt, workdir, flags, asJson) {
  const mode = normalizeBuilderStudioMode(getFlag(flags, 'bs-mode', 'gain'));
  const model = getFlag(flags, 'model');
  const remoteCommand = [
    `cd ${shellQuote(workdir)}`,
    `bs init --workspace ${shellQuote(workdir)}`,
    builderStudioCommand(mode, prompt, model)
  ].join(' && ');
  progress(`Running the BuilderStudio bs ${mode} agent...`, asJson);
  if (asJson) return runCapturedBox(['ssh', boxId, remoteCommand]);
  return runProcess('box', ['ssh', boxId, remoteCommand], { capture: false });
}

function sanitizeServiceName(value) {
  const sanitized = String(value ?? 'openmodel-agent-app')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) throw new Error('Service name must contain a letter or number.');
  return sanitized;
}

async function resolveProject(projectValue) {
  if (projectValue === undefined || projectValue === false) return undefined;
  if (projectValue === true) throw new Error('--project requires a directory path.');
  const projectPath = path.resolve(String(projectValue));
  const projectStat = await stat(projectPath).catch(() => undefined);
  if (!projectStat?.isDirectory()) throw new Error(`Project directory does not exist: ${projectPath}`);
  await access(projectPath);
  const projectName = path.basename(projectPath);
  if (!projectName || projectName === path.parse(projectPath).root) {
    throw new Error('Choose a project directory instead of a filesystem root.');
  }
  return {
    localPath: projectPath,
    name: projectName,
    remotePath: `/home/user/${projectName}`
  };
}

async function uploadProject(boxId, project, asJson) {
  if (!project) return;
  progress(`Uploading ${project.localPath} to ${boxId}:${project.remotePath}...`, asJson);
  await runCapturedBox(['scp', '--recursive', project.localPath, `${boxId}:/home/user/`]);
}

async function runRemoteCommand(boxId, command, asJson, label) {
  if (!command) return;
  progress(label, asJson);
  await runCapturedBox(['ssh', boxId, command]);
}

async function installSystemdService(boxId, project, startCommand, flags, asJson) {
  if (!startCommand) return undefined;
  if (!project) throw new Error('--start-command requires --project.');
  const serviceName = sanitizeServiceName(getFlag(flags, 'service-name', 'openmodel-agent-app'));
  const scriptPath = `/home/user/.openmodel/services/${serviceName}.sh`;
  const unitPath = `/etc/systemd/system/${serviceName}.service`;
  const scriptContents = `#!/usr/bin/env bash\nset -euo pipefail\ncd ${shellQuote(project.remotePath)}\nexec /bin/bash -lc ${shellQuote(startCommand)}\n`;
  const unitContents = `[Unit]\nDescription=OpenModel Box service ${serviceName}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nUser=user\nWorkingDirectory=${project.remotePath}\nExecStart=${scriptPath}\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=multi-user.target\n`;
  const scriptBase64 = Buffer.from(scriptContents).toString('base64');
  const unitBase64 = Buffer.from(unitContents).toString('base64');
  const remoteCommand = [
    'mkdir -p /home/user/.openmodel/services',
    `printf %s ${shellQuote(scriptBase64)} | base64 -d > ${shellQuote(scriptPath)}`,
    `chmod 700 ${shellQuote(scriptPath)}`,
    `printf %s ${shellQuote(unitBase64)} | base64 -d | sudo tee ${shellQuote(unitPath)} >/dev/null`,
    'sudo systemctl daemon-reload',
    `sudo systemctl enable --now ${shellQuote(serviceName)}`
  ].join(' && ');
  await runRemoteCommand(boxId, remoteCommand, asJson, `Installing always-on service ${serviceName}...`);
  return { serviceName, scriptPath, unitPath };
}

async function hostPort(boxId, port, isPublic, asJson) {
  if (port === undefined) return undefined;
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    throw new Error('--port must be an integer from 1 to 65535.');
  }
  progress(`Exposing port ${normalizedPort} through Box HTTPS hosting...`, asJson);
  const hostArguments = ['host', boxId, String(normalizedPort)];
  if (isPublic) hostArguments.push('--public');
  const result = await runCapturedBox(hostArguments);
  const url = extractHostedUrl(result.records);
  if (!url) throw new Error('Box hosting succeeded but did not return an HTTPS URL.');
  return { port: normalizedPort, url, access: isPublic ? 'public' : 'private' };
}

async function verifyHostedUrl(url) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 10000);
  timeout.unref?.();
  try {
    let response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: abortController.signal });
    if (response.status === 405) {
      response = await fetch(url, { method: 'GET', redirect: 'manual', signal: abortController.signal });
    }
    return { reachable: response.status >= 200 && response.status < 500, status: response.status };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function createBox(positionals, flags) {
  const asJson = getFlag(flags, 'json', false) === true;
  await prepareBox();
  const project = await resolveProject(getFlag(flags, 'project'));
  const agent = normalizeAgent(getFlag(flags, 'agent', getFlag(flags, 'provider', 'bs')));
  const templateId = getFlag(flags, 'template');
  const { argumentsList: boxEnvironmentArguments, names: environmentNames } = environmentArguments(flags);
  if (templateId && boxEnvironmentArguments.length > 0) {
    throw new Error('The Box CLI cannot apply per-fork environment values. Create a no-env box or configure per-fork env through the Box API/SDK.');
  }

  const positionalPrompt = positionals.join(' ').trim();
  const requestedPrompt = String(getFlag(flags, 'prompt', positionalPrompt) ?? '').trim();
  if (agent.id === 'bs' && requestedPrompt && !templateId && !environmentNames.includes('OPENROUTER_API_KEY')) {
    throw new Error('BuilderStudio bs is the default agent and needs model access in a fresh no-env Box. Export OPENROUTER_API_KEY and add --env OPENROUTER_API_KEY, or select --agent claude-code or --agent codex.');
  }

  progress(templateId ? `Forking Box template ${templateId}...` : 'Creating an isolated Box VM...', asJson);
  const creationArguments = templateId
    ? ['fork', String(templateId), '--no-env']
    : ['new', '--no-env', '--no-auto-stop', ...boxEnvironmentArguments];
  const creationResult = await runCapturedBox(creationArguments);
  const boxId = extractBoxId(creationResult.records);
  if (!boxId) throw new Error('Box creation did not return a box id.');

  let agentSetup;
  let service;
  let hosted;
  let verification;

  try {
    await uploadProject(boxId, project, asJson);

    const setupCommand = getFlag(flags, 'setup-command');
    if (setupCommand) {
      if (!project) throw new Error('--setup-command requires --project.');
      await runRemoteCommand(
        boxId,
        `cd ${shellQuote(project.remotePath)} && /bin/bash -lc ${shellQuote(String(setupCommand))}`,
        asJson,
        'Running project setup inside the Box...'
      );
    }

    if (agent.id === 'bs') {
      agentSetup = await ensureBuilderStudioAgent(
        boxId,
        asJson,
        getFlag(flags, 'skip-agent-install', false) === true
      );
    }

    service = await installSystemdService(boxId, project, getFlag(flags, 'start-command'), flags, asJson);
    hosted = await hostPort(boxId, getFlag(flags, 'port'), getFlag(flags, 'public', false) === true, asJson);
    verification = hosted && getFlag(flags, 'skip-verify', false) !== true
      ? await verifyHostedUrl(hosted.url)
      : undefined;

    if (requestedPrompt) {
      if (agent.id === 'bs') {
        await runBuilderStudioAgent(boxId, requestedPrompt, project?.remotePath ?? '/home/user', flags, asJson);
      } else {
        const projectInstruction = project ? `Work in ${project.remotePath}.\n\n` : '';
        const promptArguments = ['prompt', boxId, '--provider', agent.boxProvider];
        const model = getFlag(flags, 'model');
        if (model) promptArguments.push('--model', String(model));
        promptArguments.push(`${projectInstruction}${requestedPrompt}`);
        progress(`Running the ${agent.label} agent...`, asJson);
        const promptResult = await runCapturedBox(promptArguments);
        if (!asJson && promptResult.stdout.trim()) process.stdout.write(`${promptResult.stdout.trim()}\n`);
      }
    }
  } catch (error) {
    let stopped = false;
    try {
      await runCapturedBox(['stop', boxId]);
      stopped = true;
    } catch {
      stopped = false;
    }
    const message = error instanceof Error ? error.message : String(error);
    const cleanupMessage = stopped
      ? `OpenModel stopped ${boxId} after the failure.`
      : `OpenModel could not stop ${boxId}; run om box stop ${boxId}.`;
    throw new Error(`${message} ${cleanupMessage}`);
  }

  const result = {
    boxId,
    agent: agent.id,
    agentLabel: agent.label,
    primaryAgent: agent.primary,
    provider: agent.boxProvider ?? 'bs',
    agentSetup,
    project: project ? { localPath: project.localPath, remotePath: project.remotePath } : undefined,
    copiedEnvironmentVariables: environmentNames,
    templateId: templateId ? String(templateId) : undefined,
    service,
    hosted,
    verification,
    prompted: Boolean(requestedPrompt),
    manage: {
      prompt: `om box prompt ${boxId} "Describe the next task" --agent ${agent.cliName}${agent.id === 'bs' && project ? ` --workdir ${project.remotePath}` : ''}`,
      ssh: `om box ssh ${boxId}`,
      stop: `om box stop ${boxId}`,
      resume: `om box resume ${boxId}`,
      fork: `om box fork ${boxId} --no-env`
    }
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\nBox ready: ${boxId}\n`);
  if (project) process.stdout.write(`Project: ${project.remotePath}\n`);
  if (hosted) process.stdout.write(`HTTPS: ${hosted.url}\n`);
  process.stdout.write(`Agent: ${agent.label}${agent.primary ? ' (primary)' : ' (secondary)'}\n`);
  process.stdout.write(`Next: ${result.manage.prompt}\n`);
  process.stdout.write(`Pause billing: ${result.manage.stop}\n`);
}

async function promptBox(positionals, flags) {
  const boxId = positionals[0];
  const prompt = String(getFlag(flags, 'prompt', positionals.slice(1).join(' ')) ?? '').trim();
  if (!boxId || !prompt) throw new Error('Usage: om box prompt <box-id> <prompt> [--agent bs|claude-code|codex] [--workdir path] [--model name] [--json]');
  await prepareBox();
  const agent = normalizeAgent(getFlag(flags, 'agent', getFlag(flags, 'provider', 'bs')));
  const asJson = getFlag(flags, 'json', false) === true;

  if (agent.id === 'bs') {
    await ensureBuilderStudioAgent(boxId, asJson, getFlag(flags, 'skip-agent-install', false) === true);
    const workdir = String(getFlag(flags, 'workdir', '/home/user'));
    const result = await runBuilderStudioAgent(boxId, prompt, workdir, flags, asJson);
    if (asJson) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    return;
  }

  const argumentsList = ['prompt', boxId, '--provider', agent.boxProvider];
  const model = getFlag(flags, 'model');
  if (model) argumentsList.push('--model', String(model));
  argumentsList.push(prompt);
  if (asJson) {
    const result = await runCapturedBox(argumentsList);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }
  const result = await runProcess('box', argumentsList, { capture: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function passthroughBox(action, positionals, flags) {
  await prepareBox();
  const forwardedAction = action === 'status' && positionals.length > 0 ? 'info' : action;
  const argumentsList = [forwardedAction, ...positionals];
  for (const [name, rawValue] of Object.entries(flags)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      argumentsList.push(`--${name}`);
      if (value !== true) argumentsList.push(String(value));
    }
  }
  const interactive = ['ssh', 'desktop'].includes(action) && getFlag(flags, 'json', false) !== true;
  const result = await runProcess('box', argumentsList, { capture: !interactive });
  if (!interactive) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

export async function boxCommand(positionals, flags) {
  const action = String(positionals[0] ?? 'help').toLowerCase();
  if (action === 'help' || action === '--help' || action === '-h') {
    process.stdout.write(boxHelpText());
    return;
  }
  if (action === 'setup') {
    const authentication = await prepareBox({ install: getFlag(flags, 'install', false) === true });
    process.stdout.write(`Box is ready for OpenModel (${authentication.method}).\nBuilderStudio bs is the primary agent and will be installed inside new VMs. Export OPENROUTER_API_KEY and pass --env OPENROUTER_API_KEY for a fresh no-env Box. Claude Code and Codex remain secondary choices.\n`);
    return;
  }
  if (action === 'create' || action === 'new') {
    await createBox(positionals.slice(1), flags);
    return;
  }
  if (action === 'prompt' || action === 'agent') {
    await promptBox(positionals.slice(1), flags);
    return;
  }
  const passthroughActions = new Set(['list', 'status', 'info', 'stop', 'resume', 'fork', 'delete', 'desktop', 'ssh', 'scp', 'host', 'events', 'interrupt', 'forward', 'snapshots', 'snapshot', 'extend', 'limits', 'dashboard', 'config']);
  if (passthroughActions.has(action)) {
    await passthroughBox(action, positionals.slice(1), flags);
    return;
  }
  throw new Error('Usage: om box setup|create|prompt|list|status|info|stop|resume|fork|delete|desktop|ssh|scp|host|events|interrupt|forward|snapshots|snapshot');
}
