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
import { runProcess } from './lib/process.js';
import { printOpenModelBanner } from './ui/banner.mjs';

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
  help

References:
  hf://owner/repository/path/model.gguf?revision=main
  https://example.com/model.gguf
  ollama://model:tag
`;

export async function main(argv) {
  const [command = 'help', ...rest] = argv;
  const { positionals, flags } = parseArgs(rest);
  if (command === 'help' || command === '--help' || command === '-h' || command === 'doctor') printOpenModelBanner();
  if (command === 'help' || command === '--help' || command === '-h') return process.stdout.write(helpText);
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
