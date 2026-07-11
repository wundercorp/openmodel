import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs, getFlag } from './lib/args.js';
import { getPaths } from './lib/paths.js';
import { readConfig, writeConfig } from './lib/config.js';
import { installModel } from './lib/install-model.js';
import { findManifest, listManifests, removeManifest } from './lib/model-store.js';
import { loadGateways, resolveReference } from './gateways/registry.js';
import { getRuntimeInstallCommand, selectRuntime, runtimes } from './runtimes/index.js';
import { startLocalServer } from './server/http.js';
import { login, logout, whoami } from './lib/auth.js';
import { commandExists, runProcess } from './lib/process.js';
import { printOpenModelBanner } from './ui/banner.mjs';
import { estimateCloudCost, fetchUsageSummary, submitUsageEvents } from './lib/wundership-pricing.js';
import { clearUsageEvents, readUsageEvents } from './lib/usage-ledger.js';
import {
  appendTelemetryEvents,
  markTelemetryEventsSynced,
  readTelemetryEvents,
  readTelemetrySummary,
  readUnsyncedTelemetryEvents,
  toWundershipUsageEvent
} from './lib/telemetry.js';

const helpText = `om <command> [options]

Commands:
  pull <reference> [--alias name]
  run <model> [prompt] [--runtime auto|llama.cpp|ollama]
  serve [model] [--host 127.0.0.1] [--port 11435]
  list
  remove <model>
  gateways
  gateway add <package>
  gateway remove <package>
  login
  logout
  whoami
  doctor
  pricing <provider> <model> --input-tokens N --output-tokens N
  usage summary|sync
  setup <claude-code|codex|openrouter|bs> [--launch] [--port 11435]
  telemetry setup <claude-code|codex|openrouter|bs> [--launch] [--port 11435]
  telemetry summary|events|sync|emit
  version
  help

References:
  hf://owner/repository/path/model.gguf?revision=main
  https://example.com/model.gguf
  ollama://model:tag
`;

async function versionCommand() {
  const packageManifestUrl = new URL('../package.json', import.meta.url);
  const packageManifest = JSON.parse(await readFile(packageManifestUrl, 'utf8'));
  process.stdout.write(`${packageManifest.version}\n`);
}

export async function main(argv) {
  const [command = 'help', ...rest] = argv;
  const { positionals, flags } = parseArgs(rest);
  if (command === 'help' || command === '--help' || command === '-h' || command === 'doctor') printOpenModelBanner();
  if (command === 'help' || command === '--help' || command === '-h') return process.stdout.write(helpText);
  if (command === 'version' || command === '--version' || command === '-v') return versionCommand();
  if (command === 'pull') return pullCommand(positionals, flags);
  if (command === 'run') return runCommand(positionals, flags);
  if (command === 'serve') return serveCommand(positionals, flags);
  if (command === 'list' || command === 'ls') return listCommand();
  if (command === 'remove' || command === 'rm') return removeCommand(positionals);
  if (command === 'gateways') return gatewaysCommand();
  if (command === 'gateway') return gatewayCommand(positionals);
  if (command === 'login') return login();
  if (command === 'logout') return logout();
  if (command === 'whoami') return process.stdout.write(`${JSON.stringify(await whoami(), null, 2)}\n`);
  if (command === 'doctor') return doctorCommand();
  if (command === 'pricing') return pricingCommand(positionals, flags);
  if (command === 'usage') return usageCommand(positionals, flags);
  if (command === 'setup') return telemetrySetupCommand(positionals, flags);
  if (command === 'telemetry') return telemetryCommand(positionals, flags);
  throw new Error(`Unknown command "${command}". Run om help.`);
}

async function pullCommand(positionals, flags) {
  const reference = positionals[0];
  if (!reference) throw new Error('Usage: om pull <reference> [--alias name]');
  const alias = getFlag(flags, 'alias');
  const manifest = await installModel(reference, {
    alias: alias ? String(alias) : undefined
  });
  process.stdout.write(`Installed ${manifest.storedId}${alias ? ` as ${alias}` : ''}.\n`);
}

async function runCommand(positionals, flags) {
  const reference = positionals[0];
  if (!reference) throw new Error('Usage: om run <model> [prompt]');
  const manifest = await findManifest(reference);
  if (!manifest) throw new Error(`Model "${reference}" is not installed. Run om pull first.`);
  const prompt = positionals.slice(1).join(' ') || 'Hello';
  const runtime = await selectRuntime(manifest, String(getFlag(flags, 'runtime', 'auto')));
  await runtime.run(manifest, prompt, { maxTokens: Number(getFlag(flags, 'max-tokens', 512)) });
}

async function serveCommand(positionals, flags) {
  await startLocalServer({
    model: positionals[0],
    host: String(getFlag(flags, 'host', '127.0.0.1')),
    port: Number(getFlag(flags, 'port', 11435)),
    runtime: String(getFlag(flags, 'runtime', 'auto'))
  });
}

async function listCommand() {
  const manifests = await listManifests();
  if (manifests.length === 0) return process.stdout.write('No models installed.\n');
  for (const manifest of manifests) process.stdout.write(`${manifest.storedId}\t${manifest.model.format}\t${manifest.gatewayId}\t${manifest.model.source}\n`);
}

async function removeCommand(positionals) {
  if (!positionals[0]) throw new Error('Usage: om remove <model>');
  const manifest = await removeManifest(positionals[0]);
  process.stdout.write(`Removed ${manifest.storedId}.\n`);
}

async function gatewaysCommand() {
  for (const gateway of await loadGateways()) process.stdout.write(`${gateway.id}\t${gateway.schemes.join(',')}\t${gateway.capabilities.join(',')}\n`);
}

async function gatewayCommand(positionals) {
  const [action, packageSpec] = positionals;
  if (!['add', 'remove'].includes(action) || !packageSpec) throw new Error('Usage: om gateway add|remove <package>');
  const config = await readConfig();
  const gateways = new Set(config.gateways ?? []);
  const pluginDirectory = getPaths().plugins;
  await mkdir(pluginDirectory, { recursive: true });
  const pluginPackagePath = path.join(pluginDirectory, 'package.json');
  try {
    await readFile(pluginPackagePath, 'utf8');
  } catch {
    await writeFile(pluginPackagePath, '{"private":true,"type":"module"}\n', { mode: 0o600 });
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let registeredPackageName = packageSpec;
  if (action === 'add') {
    const dependenciesBefore = await readPluginDependencies(pluginPackagePath);
    await runProcess(npmCommand, ['install', '--prefix', pluginDirectory, '--ignore-scripts', '--no-audit', '--no-fund', packageSpec]);
    const dependenciesAfter = await readPluginDependencies(pluginPackagePath);
    registeredPackageName = resolveInstalledPackageName(packageSpec, dependenciesBefore, dependenciesAfter);
    gateways.add(registeredPackageName);
  } else {
    await runProcess(npmCommand, ['uninstall', '--prefix', pluginDirectory, '--ignore-scripts', '--no-audit', '--no-fund', packageSpec]);
    gateways.delete(packageSpec);
  }
  config.gateways = [...gateways].sort();
  await writeConfig(config);
  process.stdout.write(`${action === 'add' ? 'Registered' : 'Removed'} ${registeredPackageName}.\n`);
}

async function readPluginDependencies(pluginPackagePath) {
  const packageData = JSON.parse(await readFile(pluginPackagePath, 'utf8'));
  return packageData.dependencies ?? {};
}

function resolveInstalledPackageName(packageSpec, dependenciesBefore, dependenciesAfter) {
  const requestedPackageName = parseRequestedPackageName(packageSpec);
  if (requestedPackageName && dependenciesAfter[requestedPackageName]) return requestedPackageName;
  const changedPackageNames = Object.keys(dependenciesAfter).filter((packageName) => dependenciesBefore[packageName] !== dependenciesAfter[packageName]);
  if (changedPackageNames.length === 1) return changedPackageNames[0];
  throw new Error(`Could not determine the installed gateway package name for "${packageSpec}".`);
}

function parseRequestedPackageName(packageSpec) {
  const scopedMatch = packageSpec.match(/^(@[^/]+\/[^@/]+)(?:@.+)?$/);
  if (scopedMatch) return scopedMatch[1];
  const unscopedMatch = packageSpec.match(/^([^@./][^@/]*)(?:@.+)?$/);
  return unscopedMatch?.[1];
}

async function doctorCommand() {
  process.stdout.write(`Node ${process.version}\n`);
  process.stdout.write(`Data ${getPaths().home}\n`);
  for (const runtime of runtimes) {
    const available = await runtime.available();
    process.stdout.write(`${runtime.id}: ${available ? 'available' : 'not found'}\n`);
    if (!available) {
      const installCommand = getRuntimeInstallCommand(runtime.id);
      if (installCommand) process.stdout.write(`  install: ${installCommand}\n`);
    }
  }
  process.stdout.write(`Gateways: ${(await loadGateways()).map((gateway) => gateway.id).join(', ')}\n`);
}

export { loadGateways, resolveReference, startLocalServer };


async function pricingCommand(positionals, flags) {
  const [provider, model] = positionals;
  if (!provider || !model) throw new Error('Usage: om pricing <provider> <model> --input-tokens N --output-tokens N');
  const result = await estimateCloudCost({
    provider,
    model,
    region: getFlag(flags, 'region'),
    serviceTier: getFlag(flags, 'service-tier'),
    usage: {
      inputTokens: Number(getFlag(flags, 'input-tokens') ?? 0),
      outputTokens: Number(getFlag(flags, 'output-tokens') ?? 0),
      cachedInputTokens: Number(getFlag(flags, 'cached-input-tokens') ?? 0),
      cacheWriteTokens: Number(getFlag(flags, 'cache-write-tokens') ?? 0),
      reasoningTokens: Number(getFlag(flags, 'reasoning-tokens') ?? 0)
    }
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function usageCommand(positionals) {
  const action = positionals[0] ?? 'summary';
  if (action === 'summary') {
    process.stdout.write(`${JSON.stringify(await fetchUsageSummary(), null, 2)}\n`);
    return;
  }
  if (action === 'sync') {
    const events = await readUsageEvents();
    if (events.length === 0) {
      process.stdout.write('No local usage events are waiting to sync.\n');
      return;
    }
    const result = await submitUsageEvents(events);
    await clearUsageEvents();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error('Usage: om usage summary|sync');
}


async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function claudeCodeTelemetryEnvironment(port) {
  const endpoint = `http://127.0.0.1:${port}/v1/telemetry/otlp/v1/logs`;
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
    OTEL_LOG_USER_PROMPTS: '0',
    OTEL_LOG_ASSISTANT_RESPONSES: '0'
  };
}

export function telemetrySetupGuide(port = 11435) {
  return [
    'OpenModel external usage setup',
    '',
    '1. Start the local collector and keep it running:',
    `   om serve --port ${port}`,
    '',
    '2. Connect one tool:',
    '   Claude Code: om setup claude-code --launch',
    '   Codex:       om setup codex',
    '   OpenRouter:  om setup openrouter',
    '   BS:          om setup bs',
    '',
    '3. Run a request, then verify capture:',
    '   om telemetry summary',
    '',
    '4. Optional: publish normalized usage metadata:',
    '   om telemetry sync'
  ].join('\n');
}

export function telemetrySetupText(integration, port = 11435) {
  const endpoint = `http://127.0.0.1:${port}/v1/telemetry/otlp/v1/logs`;
  if (integration === 'claude-code') {
    const environment = claudeCodeTelemetryEnvironment(port);
    return [
      `export CLAUDE_CODE_ENABLE_TELEMETRY=${environment.CLAUDE_CODE_ENABLE_TELEMETRY}`,
      `export OTEL_LOGS_EXPORTER=${environment.OTEL_LOGS_EXPORTER}`,
      `export OTEL_METRICS_EXPORTER=${environment.OTEL_METRICS_EXPORTER}`,
      `export OTEL_EXPORTER_OTLP_PROTOCOL=${environment.OTEL_EXPORTER_OTLP_PROTOCOL}`,
      `export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=${environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT}`,
      `export OTEL_LOG_USER_PROMPTS=${environment.OTEL_LOG_USER_PROMPTS}`,
      `export OTEL_LOG_ASSISTANT_RESPONSES=${environment.OTEL_LOG_ASSISTANT_RESPONSES}`,
      '',
      'claude'
    ].join('\n');
  }
  if (integration === 'codex') {
    return [
      '# Add this block to ~/.codex/config.toml, save the file, and restart Codex.',
      '[otel]',
      'environment = "local"',
      'log_user_prompt = false',
      `exporter = { otlp-http = { endpoint = "${endpoint}", protocol = "binary" } }`
    ].join('\n');
  }
  if (integration === 'openrouter') {
    return JSON.stringify({
      instructions: 'Report the exact usage object after each completed OpenRouter response.',
      endpoint: `http://127.0.0.1:${port}/v1/telemetry/events`,
      method: 'POST',
      body: {
        source: 'openrouter',
        sessionId: 'your-session-id',
        requestId: 'response-id',
        provider: 'openai',
        model: 'gpt-4o-mini',
        usage: {
          inputTokens: 194,
          outputTokens: 2,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0
        },
        cost: {
          amount: 0.00014,
          currency: 'USD',
          source: 'openrouter-response'
        }
      }
    }, null, 2);
  }
  if (integration === 'bs') {
    const endpoint = `http://127.0.0.1:${port}/v1/telemetry/events`;
    return [
      'BuilderStudio native telemetry setup',
      '',
      'OpenModel configures BuilderStudio globally. No project code changes are required.',
      port === 11435 ? 'Run: bs telemetry enable' : `Run: bs telemetry enable --endpoint ${endpoint}`,
      '',
      'Verify: bs telemetry status',
      'Then run a normal bs ask, gain, repair, or model-backed command.'
    ].join('\n');
  }
  throw new Error('Usage: om setup <claude-code|codex|openrouter|bs> [--launch] [--port 11435]');
}

async function telemetrySetupCommand(positionals, flags) {
  const integration = String(positionals[0] ?? '').toLowerCase();
  const port = Number(getFlag(flags, 'port', 11435));
  if (!integration) {
    process.stdout.write(`${telemetrySetupGuide(port)}\n`);
    return;
  }
  if (integration === 'bs') {
    if (!(await commandExists('bs'))) {
      throw new Error('BuilderStudio is not installed. Run: npm install --global @wundercorp/bs@latest');
    }
    const builderStudioArguments = ['telemetry', 'enable'];
    if (port !== 11435) {
      builderStudioArguments.push('--endpoint', `http://127.0.0.1:${port}/v1/telemetry/events`);
    }
    try {
      await runProcess('bs', builderStudioArguments);
    } catch (error) {
      throw new Error(`BuilderStudio native telemetry requires @wundercorp/bs 0.3.15 or newer. Upgrade with: npm install --global @wundercorp/bs@latest. ${error instanceof Error ? error.message : String(error)}`);
    }
    process.stdout.write(`BuilderStudio is configured. Start OpenModel with om serve --port ${port}, then run a normal bs model-backed command.\n`);
    return;
  }
  if (getFlag(flags, 'launch', false)) {
    if (integration !== 'claude-code') {
      throw new Error('--launch is currently supported for claude-code only. Run om setup codex, openrouter, or bs for guided configuration.');
    }
    await runProcess('claude', [], {
      env: claudeCodeTelemetryEnvironment(port)
    });
    return;
  }
  process.stdout.write(`${telemetrySetupText(integration, port)}\n`);
}

async function telemetryCommand(positionals, flags) {
  const action = positionals[0] ?? 'summary';
  if (action === 'setup') {
    return telemetrySetupCommand(positionals.slice(1), flags);
  }
  if (action === 'summary') {
    const summary = await readTelemetrySummary({
      since: getFlag(flags, 'since'),
      source: getFlag(flags, 'source'),
      sessionId: getFlag(flags, 'session-id'),
      limit: Number(getFlag(flags, 'limit', 10000))
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  if (action === 'events') {
    const events = await readTelemetryEvents({
      since: getFlag(flags, 'since'),
      source: getFlag(flags, 'source'),
      sessionId: getFlag(flags, 'session-id'),
      limit: Number(getFlag(flags, 'limit', 100))
    });
    process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
    return;
  }
  if (action === 'emit') {
    const input = await readStandardInput();
    if (!input) {
      throw new Error('Pipe a JSON telemetry event or {"events": [...]} payload to om telemetry emit.');
    }
    const payload = JSON.parse(input);
    const result = await appendTelemetryEvents(payload.events ?? payload.event ?? payload);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (action === 'sync') {
    const unsyncedEvents = await readUnsyncedTelemetryEvents({
      since: getFlag(flags, 'since'),
      source: getFlag(flags, 'source'),
      limit: Number(getFlag(flags, 'limit', 10000))
    });
    const syncablePairs = unsyncedEvents
      .map((event) => ({ event, usageEvent: toWundershipUsageEvent(event) }))
      .filter((pair) => pair.usageEvent);
    if (syncablePairs.length === 0) {
      process.stdout.write(`${JSON.stringify({ synced: 0, skipped: unsyncedEvents.length }, null, 2)}\n`);
      return;
    }
    const batchSize = 100;
    for (let index = 0; index < syncablePairs.length; index += batchSize) {
      const batch = syncablePairs.slice(index, index + batchSize);
      await submitUsageEvents(batch.map((pair) => pair.usageEvent));
      await markTelemetryEventsSynced(batch.map((pair) => pair.event));
    }
    process.stdout.write(`${JSON.stringify({
      synced: syncablePairs.length,
      skipped: unsyncedEvents.length - syncablePairs.length
    }, null, 2)}\n`);
    return;
  }
  throw new Error('Usage: om telemetry setup|summary|events|sync|emit');
}
