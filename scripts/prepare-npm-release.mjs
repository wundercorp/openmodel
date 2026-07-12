#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRootDirectory = path.resolve(
  process.env.OPENMODEL_RELEASE_ROOT || path.join(scriptDirectory, ".."),
);
const cliPackagePath = path.join(repositoryRootDirectory, "apps/cli/package.json");
const gatewaySdkPackagePath = path.join(repositoryRootDirectory, "packages/gateway-sdk/package.json");
const versionBumpScriptPath = path.join(repositoryRootDirectory, "scripts/version-bump.mjs");
const compareScriptPath = path.join(
  repositoryRootDirectory,
  "scripts/verify-published-package-contents.mjs",
);
const maximumAutomaticBumps = 50;

function fail(message) {
  process.stderr.write(`Automatic npm version preparation failed: ${message}\n`);
  process.exit(1);
}

function parseArguments(argumentValues) {
  let registryUrl = "https://registry.npmjs.org/";

  for (let argumentIndex = 0; argumentIndex < argumentValues.length; argumentIndex += 1) {
    const argumentValue = argumentValues[argumentIndex];
    if (argumentValue === "--registry") {
      argumentIndex += 1;
      registryUrl = argumentValues[argumentIndex] ?? "";
      continue;
    }
    if (argumentValue === "--help" || argumentValue === "-h") {
      process.stdout.write(
        "Usage: node scripts/prepare-npm-release.mjs [--registry <url>]\n\n" +
          "Checks published package contents and automatically applies patch version bumps only when an existing version differs from the local package.\n",
      );
      process.exit(0);
    }
    fail(`Unknown argument: ${argumentValue}`);
  }

  try {
    new URL(registryUrl);
  } catch {
    fail("The npm registry URL is invalid.");
  }

  return { registryUrl };
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Unable to read ${path.relative(repositoryRootDirectory, filePath)}: ${error.message}`);
  }
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

  const errorOutput = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  if (errorOutput.includes("E404") || errorOutput.includes("404 Not Found")) {
    return false;
  }

  fail(
    `Unable to query ${packageName}@${packageVersion}: ${result.stderr?.trim() || `npm exited with status ${result.status}`}`,
  );
}

function publishedPackageMatchesWorkspace(workspaceName, registryUrl) {
  const result = runCommand(
    process.execPath,
    [compareScriptPath, "--workspace", workspaceName, "--registry", registryUrl],
    { captureOutput: true },
  );

  if (result.status === 0) {
    process.stdout.write(result.stdout);
    return true;
  }

  if (result.status === 3) {
    process.stderr.write(result.stderr);
    return false;
  }

  fail(result.stderr?.trim() || `Unable to compare ${workspaceName} with npm.`);
}

function bumpPackage(packageSelection) {
  const result = runCommand(process.execPath, [
    versionBumpScriptPath,
    "patch",
    "--package",
    packageSelection,
  ]);
  if (result.status !== 0) {
    fail(`Unable to apply an automatic patch bump for ${packageSelection}.`);
  }
}

function main() {
  const configuration = parseArguments(process.argv.slice(2));
  let automaticBumpCount = 0;

  while (automaticBumpCount < maximumAutomaticBumps) {
    const gatewaySdkPackage = readJsonFile(gatewaySdkPackagePath);
    const cliPackage = readJsonFile(cliPackagePath);
    const cliGatewaySdkVersion = cliPackage.dependencies?.["@wundercorp/openmodel-gateway-sdk"];

    if (cliGatewaySdkVersion !== gatewaySdkPackage.version) {
      fail(
        `The CLI requires gateway SDK ${cliGatewaySdkVersion}, but the workspace SDK is ${gatewaySdkPackage.version}.`,
      );
    }

    const gatewaySdkVersionExists = packageVersionExists(
      gatewaySdkPackage.name,
      gatewaySdkPackage.version,
      configuration.registryUrl,
    );

    if (
      gatewaySdkVersionExists &&
      !publishedPackageMatchesWorkspace(
        "@wundercorp/openmodel-gateway-sdk",
        configuration.registryUrl,
      )
    ) {
      process.stdout.write(
        `Automatically incrementing ${gatewaySdkPackage.name} because ${gatewaySdkPackage.version} already exists with different contents.\n`,
      );
      bumpPackage("sdk");
      automaticBumpCount += 1;
      continue;
    }

    const cliVersionExists = packageVersionExists(
      cliPackage.name,
      cliPackage.version,
      configuration.registryUrl,
    );

    if (
      cliVersionExists &&
      !publishedPackageMatchesWorkspace("@wundercorp/openmodel", configuration.registryUrl)
    ) {
      process.stdout.write(
        `Automatically incrementing ${cliPackage.name} because ${cliPackage.version} already exists with different contents.\n`,
      );
      bumpPackage("cli");
      automaticBumpCount += 1;
      continue;
    }

    const finalGatewaySdkPackage = readJsonFile(gatewaySdkPackagePath);
    const finalCliPackage = readJsonFile(cliPackagePath);
    if (automaticBumpCount === 0) {
      process.stdout.write(
        `npm versions are ready: ${finalGatewaySdkPackage.name}@${finalGatewaySdkPackage.version}, ${finalCliPackage.name}@${finalCliPackage.version}.\n`,
      );
    } else {
      process.stdout.write(
        `Automatic npm version preparation completed after ${automaticBumpCount} patch bump${automaticBumpCount === 1 ? "" : "s"}: ${finalGatewaySdkPackage.name}@${finalGatewaySdkPackage.version}, ${finalCliPackage.name}@${finalCliPackage.version}.\n`,
      );
    }
    return;
  }

  fail(`Exceeded ${maximumAutomaticBumps} automatic patch attempts.`);
}

main();
