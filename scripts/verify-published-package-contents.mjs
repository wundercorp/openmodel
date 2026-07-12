#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRootDirectory = path.resolve(scriptDirectory, "..");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArguments(argumentValues) {
  let workspaceName = "";
  let registryUrl = "https://registry.npmjs.org/";

  for (let argumentIndex = 0; argumentIndex < argumentValues.length; argumentIndex += 1) {
    const argumentValue = argumentValues[argumentIndex];
    if (argumentValue === "--workspace") {
      argumentIndex += 1;
      workspaceName = argumentValues[argumentIndex] ?? "";
      continue;
    }
    if (argumentValue === "--registry") {
      argumentIndex += 1;
      registryUrl = argumentValues[argumentIndex] ?? "";
      continue;
    }
    if (argumentValue === "--help" || argumentValue === "-h") {
      process.stdout.write("Usage: node scripts/verify-published-package-contents.mjs --workspace <workspace> [--registry <url>]\n");
      process.exit(0);
    }
    fail(`Unknown argument: ${argumentValue}`);
  }

  if (!workspaceName) {
    fail("--workspace is required.");
  }

  return { workspaceName, registryUrl };
}

function runCommand(commandName, commandArguments, options = {}) {
  const commandResult = spawnSync(commandName, commandArguments, {
    cwd: options.cwd ?? repositoryRootDirectory,
    encoding: "utf8",
    stdio: options.captureOutput ? "pipe" : "inherit",
    env: process.env,
  });

  if (commandResult.error) {
    fail(commandResult.error.message);
  }

  if (commandResult.status !== 0) {
    fail(commandResult.stderr?.trim() || `${commandName} exited with status ${commandResult.status}`);
  }

  return commandResult;
}

function resolveWorkspaceManifest(workspaceName) {
  const rootManifest = require(path.join(repositoryRootDirectory, "package.json"));
  const workspacePatterns = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : [];

  for (const workspacePattern of workspacePatterns) {
    const workspaceParentDirectory = workspacePattern.endsWith("/*")
      ? path.join(repositoryRootDirectory, workspacePattern.slice(0, -2))
      : null;
    if (!workspaceParentDirectory) {
      continue;
    }

    for (const entryName of readdirSync(workspaceParentDirectory)) {
      const manifestPath = path.join(workspaceParentDirectory, entryName, "package.json");
      try {
        const manifest = require(manifestPath);
        if (manifest.name === workspaceName) {
          return { manifest, manifestPath };
        }
      } catch {
        continue;
      }
    }
  }

  fail(`Unable to find workspace ${workspaceName}.`);
}

function parsePackedFilename(commandResult) {
  const output = commandResult.stdout.trim();
  try {
    const parsedOutput = JSON.parse(output);
    const packedRecord = Array.isArray(parsedOutput) ? parsedOutput[0] : parsedOutput;
    if (packedRecord?.filename) {
      return packedRecord.filename;
    }
  } catch {
    // Fall back to the final output line for older npm versions.
  }

  const outputLines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const finalLine = outputLines.at(-1);
  if (!finalLine) {
    fail("npm pack did not report a tarball filename.");
  }
  return finalLine;
}

function extractTarball(tarballPath, destinationDirectory) {
  runCommand("tar", ["-xzf", tarballPath, "-C", destinationDirectory]);
}

function hashFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function collectPackageFiles(packageDirectory, currentDirectory = packageDirectory, result = new Map()) {
  const entryNames = readdirSync(currentDirectory).sort();
  for (const entryName of entryNames) {
    const entryPath = path.join(currentDirectory, entryName);
    const entryStat = statSync(entryPath);
    const relativePath = path.relative(packageDirectory, entryPath).replaceAll(path.sep, "/");
    if (entryStat.isDirectory()) {
      collectPackageFiles(packageDirectory, entryPath, result);
      continue;
    }
    result.set(relativePath, {
      hash: hashFile(entryPath),
      executable: Boolean(entryStat.mode & 0o111),
    });
  }
  return result;
}

function compareFileMaps(localFiles, publishedFiles) {
  const allPaths = [...new Set([...localFiles.keys(), ...publishedFiles.keys()])].sort();
  const differences = [];

  for (const relativePath of allPaths) {
    const localFile = localFiles.get(relativePath);
    const publishedFile = publishedFiles.get(relativePath);
    if (!localFile) {
      differences.push(`missing locally: ${relativePath}`);
      continue;
    }
    if (!publishedFile) {
      differences.push(`not published: ${relativePath}`);
      continue;
    }
    if (localFile.hash !== publishedFile.hash) {
      differences.push(`content differs: ${relativePath}`);
      continue;
    }
    if (localFile.executable !== publishedFile.executable) {
      differences.push(`executable mode differs: ${relativePath}`);
    }
  }

  return differences;
}

function main() {
  const configuration = parseArguments(process.argv.slice(2));
  const { manifest } = resolveWorkspaceManifest(configuration.workspaceName);
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "openmodel-npm-compare-"));
  const localPackDirectory = path.join(temporaryDirectory, "local-pack");
  const publishedPackDirectory = path.join(temporaryDirectory, "published-pack");
  const localExtractDirectory = path.join(temporaryDirectory, "local-extract");
  const publishedExtractDirectory = path.join(temporaryDirectory, "published-extract");

  try {
    runCommand("mkdir", ["-p", localPackDirectory, publishedPackDirectory, localExtractDirectory, publishedExtractDirectory]);

    const localPackResult = runCommand(
      "npm",
      [
        "pack",
        "--workspace",
        configuration.workspaceName,
        "--pack-destination",
        localPackDirectory,
        "--json",
        "--registry",
        configuration.registryUrl,
      ],
      { captureOutput: true },
    );
    const localTarballPath = path.join(localPackDirectory, parsePackedFilename(localPackResult));

    const publishedPackResult = runCommand(
      "npm",
      [
        "pack",
        `${manifest.name}@${manifest.version}`,
        "--pack-destination",
        publishedPackDirectory,
        "--json",
        "--registry",
        configuration.registryUrl,
      ],
      { captureOutput: true },
    );
    const publishedTarballPath = path.join(publishedPackDirectory, parsePackedFilename(publishedPackResult));

    extractTarball(localTarballPath, localExtractDirectory);
    extractTarball(publishedTarballPath, publishedExtractDirectory);

    const localFiles = collectPackageFiles(path.join(localExtractDirectory, "package"));
    const publishedFiles = collectPackageFiles(path.join(publishedExtractDirectory, "package"));
    const differences = compareFileMaps(localFiles, publishedFiles);

    if (differences.length > 0) {
      process.stderr.write(`${manifest.name}@${manifest.version} differs from the published package:\n`);
      for (const difference of differences.slice(0, 20)) {
        process.stderr.write(`  - ${difference}\n`);
      }
      if (differences.length > 20) {
        process.stderr.write(`  - ${differences.length - 20} additional differences\n`);
      }
      process.exit(3);
    }

    process.stdout.write(`${manifest.name}@${manifest.version} matches the published package contents.\n`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main();
