#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRootDirectory = path.resolve(scriptDirectory, "..");
const cliPackagePath = path.join(repositoryRootDirectory, "apps/cli/package.json");
const gatewaySdkPackagePath = path.join(repositoryRootDirectory, "packages/gateway-sdk/package.json");
const cliPackage = require(cliPackagePath);
const gatewaySdkPackage = require(gatewaySdkPackagePath);

function fail(message) {
  process.stderr.write(`npm publication failed: ${message}\n`);
  process.exit(1);
}

function printUsage() {
  process.stdout.write(`Usage: node scripts/publish-npm.mjs [options]\n\nOptions:\n  --tag NAME             npm distribution tag. Default: latest.\n  --registry URL         npm registry. Default: https://registry.npmjs.org/.\n  --provenance           Request npm provenance generation in supported CI only.\n  --dry-run              Run npm publish in dry-run mode.\n  --require-tag-match    Require GITHUB_REF_NAME to equal v<CLI version>.\n  --help                 Show this help text.\n`);
}

function parseArguments(argumentValues) {
  let distributionTag = "latest";
  let registryUrl = "https://registry.npmjs.org/";
  let provenance = false;
  let dryRun = false;
  let requireTagMatch = false;

  for (let argumentIndex = 0; argumentIndex < argumentValues.length; argumentIndex += 1) {
    const argumentValue = argumentValues[argumentIndex];

    if (argumentValue === "--tag") {
      argumentIndex += 1;
      distributionTag = argumentValues[argumentIndex] ?? "";
      continue;
    }

    if (argumentValue === "--registry") {
      argumentIndex += 1;
      registryUrl = argumentValues[argumentIndex] ?? "";
      continue;
    }

    if (argumentValue === "--provenance") {
      provenance = true;
      continue;
    }

    if (argumentValue === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (argumentValue === "--require-tag-match") {
      requireTagMatch = true;
      continue;
    }

    if (argumentValue === "--help" || argumentValue === "-h") {
      printUsage();
      process.exit(0);
    }

    fail(`Unknown argument: ${argumentValue}`);
  }

  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(distributionTag)) {
    fail("The npm distribution tag is invalid.");
  }

  try {
    new URL(registryUrl);
  } catch {
    fail("The npm registry URL is invalid.");
  }

  return {
    distributionTag,
    registryUrl,
    provenance,
    dryRun,
    requireTagMatch,
  };
}

function runCommand(commandName, commandArguments, options = {}) {
  const commandResult = spawnSync(commandName, commandArguments, {
    cwd: repositoryRootDirectory,
    encoding: "utf8",
    stdio: options.captureOutput ? "pipe" : "inherit",
    env: process.env,
  });

  if (commandResult.error) {
    fail(commandResult.error.message);
  }

  return commandResult;
}

function packageVersionExists(packageName, packageVersion, registryUrl) {
  const result = runCommand(
    "npm",
    ["view", `${packageName}@${packageVersion}`, "version", "--registry", registryUrl],
    { captureOutput: true },
  );

  if (result.status === 0) {
    return result.stdout.trim() === packageVersion;
  }

  if (result.stderr.includes("E404") || result.stderr.includes("404 Not Found")) {
    return false;
  }

  fail(`Unable to query ${packageName}@${packageVersion} from ${registryUrl}: ${result.stderr.trim() || `npm exited with status ${result.status}`}`);
}

function publishPackage(workspaceName, packageManifest, configuration) {
  const publishArguments = [
    "publish",
    "--workspace",
    workspaceName,
    "--access",
    "public",
    "--tag",
    configuration.distributionTag,
    "--registry",
    configuration.registryUrl,
  ];

  publishArguments.push(`--provenance=${configuration.provenance ? "true" : "false"}`);

  if (configuration.dryRun) {
    publishArguments.push("--dry-run");
  }

  const publishResult = runCommand("npm", publishArguments);
  if (publishResult.status !== 0) {
    fail(`npm publish failed for ${packageManifest.name}@${packageManifest.version}.`);
  }
}

function main() {
  const configuration = parseArguments(process.argv.slice(2));
  const cliGatewaySdkDependencyVersion = cliPackage.dependencies?.["@wundercorp/openmodel-gateway-sdk"];

  if (cliGatewaySdkDependencyVersion !== gatewaySdkPackage.version) {
    fail(`The CLI requires gateway SDK ${cliGatewaySdkDependencyVersion}, but the workspace SDK is ${gatewaySdkPackage.version}.`);
  }

  if (configuration.provenance && process.env.GITHUB_ACTIONS !== "true" && process.env.GITLAB_CI !== "true") {
    fail("npm provenance requires a supported cloud CI environment. Publish locally without --provenance.");
  }

  if (configuration.requireTagMatch) {
    const expectedTagName = `v${cliPackage.version}`;
    const actualTagName = process.env.GITHUB_REF_NAME ?? "";
    if (actualTagName !== expectedTagName) {
      fail(`The release tag must be ${expectedTagName}; received ${actualTagName || "no tag"}.`);
    }
  }

  if (configuration.dryRun) {
    publishPackage("@wundercorp/openmodel-gateway-sdk", gatewaySdkPackage, configuration);
    publishPackage("@wundercorp/openmodel", cliPackage, configuration);
    return;
  }

  const gatewaySdkVersionExists = packageVersionExists(
    gatewaySdkPackage.name,
    gatewaySdkPackage.version,
    configuration.registryUrl,
  );
  const cliVersionExists = packageVersionExists(
    cliPackage.name,
    cliPackage.version,
    configuration.registryUrl,
  );

  if (gatewaySdkVersionExists && cliVersionExists) {
    fail("All selected npm package versions already exist. Bump the package that changed, or skip npm publication.");
  }

  if (gatewaySdkVersionExists) {
    process.stdout.write(`Reusing published dependency ${gatewaySdkPackage.name}@${gatewaySdkPackage.version}\n`);
  } else {
    publishPackage("@wundercorp/openmodel-gateway-sdk", gatewaySdkPackage, configuration);
  }

  if (cliVersionExists) {
    process.stdout.write(`Reusing published package ${cliPackage.name}@${cliPackage.version}\n`);
  } else {
    publishPackage("@wundercorp/openmodel", cliPackage, configuration);
  }
}

main();
