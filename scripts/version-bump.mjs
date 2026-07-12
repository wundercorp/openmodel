#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRootDirectory = path.resolve(scriptDirectory, "..");
const cliPackagePath = path.join(repositoryRootDirectory, "apps/cli/package.json");
const gatewaySdkPackagePath = path.join(repositoryRootDirectory, "packages/gateway-sdk/package.json");
const packageLockPath = path.join(repositoryRootDirectory, "package-lock.json");

function fail(message) {
  process.stderr.write(`Version bump failed: ${message}\n`);
  process.exit(1);
}

function printUsage() {
  process.stdout.write(`Usage: node scripts/version-bump.mjs [patch|minor|major|prerelease] [options]\n\nOptions:\n  --package cli|sdk|all  Package selection. Default: cli.\n  --preid NAME           Prerelease identifier. Default: beta.\n  --dry-run              Print the changes without writing files.\n  --json                 Print the result as JSON.\n  --help                 Show this help text.\n\nExamples:\n  npm run version:bump\n  npm run version:bump -- minor\n  npm run version:bump -- patch --package sdk\n  npm run version:bump -- prerelease --preid beta --package all\n`);
}

function parseArguments(argumentValues) {
  let bumpType = "patch";
  let packageSelection = "cli";
  let prereleaseIdentifier = "beta";
  let dryRun = false;
  let jsonOutput = false;
  let positionalBumpTypeWasSet = false;

  for (let argumentIndex = 0; argumentIndex < argumentValues.length; argumentIndex += 1) {
    const argumentValue = argumentValues[argumentIndex];

    if (["patch", "minor", "major", "prerelease"].includes(argumentValue) && !positionalBumpTypeWasSet) {
      bumpType = argumentValue;
      positionalBumpTypeWasSet = true;
      continue;
    }

    if (argumentValue === "--package") {
      argumentIndex += 1;
      packageSelection = argumentValues[argumentIndex] ?? "";
      continue;
    }

    if (argumentValue === "--preid") {
      argumentIndex += 1;
      prereleaseIdentifier = argumentValues[argumentIndex] ?? "";
      continue;
    }

    if (argumentValue === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (argumentValue === "--json") {
      jsonOutput = true;
      continue;
    }

    if (argumentValue === "--help" || argumentValue === "-h") {
      printUsage();
      process.exit(0);
    }

    fail(`Unknown argument: ${argumentValue}`);
  }

  if (!["cli", "sdk", "all"].includes(packageSelection)) {
    fail("--package must be cli, sdk, or all.");
  }

  if (!/^[0-9A-Za-z-]+$/.test(prereleaseIdentifier)) {
    fail("--preid must contain only letters, numbers, or hyphens.");
  }

  return {
    bumpType,
    packageSelection,
    prereleaseIdentifier,
    dryRun,
    jsonOutput,
  };
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Unable to read ${path.relative(repositoryRootDirectory, filePath)}: ${error.message}`);
  }
}

function parseVersion(versionValue) {
  const versionMatch = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(versionValue);

  if (!versionMatch) {
    fail(`Unsupported semantic version: ${versionValue}`);
  }

  return {
    major: Number(versionMatch[1]),
    minor: Number(versionMatch[2]),
    patch: Number(versionMatch[3]),
    prereleaseParts: versionMatch[4] ? versionMatch[4].split(".") : [],
  };
}

function incrementVersion(versionValue, bumpType, prereleaseIdentifier) {
  const parsedVersion = parseVersion(versionValue);

  if (bumpType === "major") {
    return `${parsedVersion.major + 1}.0.0`;
  }

  if (bumpType === "minor") {
    return `${parsedVersion.major}.${parsedVersion.minor + 1}.0`;
  }

  if (bumpType === "patch") {
    return `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch + 1}`;
  }

  if (parsedVersion.prereleaseParts.length === 0) {
    return `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch + 1}-${prereleaseIdentifier}.0`;
  }

  if (parsedVersion.prereleaseParts[0] !== prereleaseIdentifier) {
    return `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}-${prereleaseIdentifier}.0`;
  }

  const updatedPrereleaseParts = [...parsedVersion.prereleaseParts];
  const lastPrereleasePartIndex = updatedPrereleaseParts.length - 1;
  const lastPrereleasePart = updatedPrereleaseParts[lastPrereleasePartIndex];

  if (/^\d+$/.test(lastPrereleasePart)) {
    updatedPrereleaseParts[lastPrereleasePartIndex] = String(Number(lastPrereleasePart) + 1);
  } else {
    updatedPrereleaseParts.push("0");
  }

  return `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}-${updatedPrereleaseParts.join(".")}`;
}

function serializeJson(jsonValue) {
  return `${JSON.stringify(jsonValue, null, 2)}\n`;
}

function writeFileAtomically(filePath, fileContents) {
  const temporaryFilePath = `${filePath}.openmodel-version-bump-${process.pid}`;
  const existingFileMode = fs.statSync(filePath).mode;
  fs.writeFileSync(temporaryFilePath, fileContents, { mode: existingFileMode });
  fs.chmodSync(temporaryFilePath, existingFileMode);
  fs.renameSync(temporaryFilePath, filePath);
}

function main() {
  const configuration = parseArguments(process.argv.slice(2));
  const cliPackage = readJsonFile(cliPackagePath);
  const gatewaySdkPackage = readJsonFile(gatewaySdkPackagePath);
  const packageLock = readJsonFile(packageLockPath);

  if (packageLock.lockfileVersion !== 3 || !packageLock.packages) {
    fail("package-lock.json must use lockfileVersion 3 and contain a packages map.");
  }

  if (!packageLock.packages["apps/cli"] || !packageLock.packages["packages/gateway-sdk"]) {
    fail("package-lock.json is missing the CLI or gateway SDK workspace entry.");
  }

  const previousCliVersion = cliPackage.version;
  const previousGatewaySdkVersion = gatewaySdkPackage.version;
  let nextCliVersion = previousCliVersion;
  let nextGatewaySdkVersion = previousGatewaySdkVersion;

  if (configuration.packageSelection === "cli") {
    nextCliVersion = incrementVersion(previousCliVersion, configuration.bumpType, configuration.prereleaseIdentifier);
  }

  if (configuration.packageSelection === "sdk") {
    nextGatewaySdkVersion = incrementVersion(previousGatewaySdkVersion, configuration.bumpType, configuration.prereleaseIdentifier);
    const cliBumpType = configuration.bumpType === "prerelease" ? "prerelease" : "patch";
    nextCliVersion = incrementVersion(previousCliVersion, cliBumpType, configuration.prereleaseIdentifier);
  }

  if (configuration.packageSelection === "all") {
    nextGatewaySdkVersion = incrementVersion(previousGatewaySdkVersion, configuration.bumpType, configuration.prereleaseIdentifier);
    nextCliVersion = incrementVersion(previousCliVersion, configuration.bumpType, configuration.prereleaseIdentifier);
  }

  cliPackage.version = nextCliVersion;
  gatewaySdkPackage.version = nextGatewaySdkVersion;
  cliPackage.dependencies["@wundercorp/openmodel-gateway-sdk"] = nextGatewaySdkVersion;

  packageLock.packages["apps/cli"].version = nextCliVersion;
  packageLock.packages["apps/cli"].dependencies["@wundercorp/openmodel-gateway-sdk"] = nextGatewaySdkVersion;
  packageLock.packages["packages/gateway-sdk"].version = nextGatewaySdkVersion;

  const result = {
    bumpType: configuration.bumpType,
    packageSelection: configuration.packageSelection,
    dryRun: configuration.dryRun,
    packages: {
      "@wundercorp/openmodel": {
        previousVersion: previousCliVersion,
        nextVersion: nextCliVersion,
      },
      "@wundercorp/openmodel-gateway-sdk": {
        previousVersion: previousGatewaySdkVersion,
        nextVersion: nextGatewaySdkVersion,
      },
    },
  };

  if (!configuration.dryRun) {
    writeFileAtomically(cliPackagePath, serializeJson(cliPackage));
    writeFileAtomically(gatewaySdkPackagePath, serializeJson(gatewaySdkPackage));
    writeFileAtomically(packageLockPath, serializeJson(packageLock));
  }

  if (configuration.jsonOutput) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${configuration.dryRun ? "Would update" : "Updated"} npm package versions:\n`);
  process.stdout.write(`  @wundercorp/openmodel: ${previousCliVersion} -> ${nextCliVersion}\n`);
  process.stdout.write(`  @wundercorp/openmodel-gateway-sdk: ${previousGatewaySdkVersion} -> ${nextGatewaySdkVersion}\n`);
  if (configuration.packageSelection === "sdk") {
    process.stdout.write("  The CLI received an automatic release bump because its exact SDK dependency changed.\n");
  }
}

main();
