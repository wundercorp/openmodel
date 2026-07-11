import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRootDirectory = path.resolve(scriptDirectory, "..");
const packageLockPath = path.join(repositoryRootDirectory, "package-lock.json");
const npmConfigurationPath = path.join(repositoryRootDirectory, ".npmrc");
const allowedRegistryHost = "registry.npmjs.org";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (!fs.existsSync(packageLockPath)) {
  fail("package-lock.json is missing.");
} else {
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
  const invalidResolvedEntries = [];

  for (const [packagePath, packageMetadata] of Object.entries(packageLock.packages ?? {})) {
    const resolved = packageMetadata?.resolved;
    if (typeof resolved !== "string" || !/^https?:\/\//u.test(resolved)) {
      continue;
    }

    const resolvedUrl = new URL(resolved);
    if (resolvedUrl.hostname !== allowedRegistryHost) {
      invalidResolvedEntries.push({ packagePath, resolved });
    }
  }

  if (invalidResolvedEntries.length > 0) {
    const formattedEntries = invalidResolvedEntries
      .map(({ packagePath, resolved }) => `  ${packagePath || "<root>"}: ${resolved}`)
      .join("\n");
    fail(`package-lock.json contains non-public registry URLs:\n${formattedEntries}`);
  }
}

if (!fs.existsSync(npmConfigurationPath)) {
  fail(".npmrc is missing. The repository must pin registry=https://registry.npmjs.org/.");
} else {
  const npmConfiguration = fs.readFileSync(npmConfigurationPath, "utf8");
  if (!/^registry=https:\/\/registry\.npmjs\.org\/$/mu.test(npmConfiguration)) {
    fail(".npmrc must contain registry=https://registry.npmjs.org/.");
  }
}

if (process.exitCode) {
  process.stderr.write("Run npm run lockfile:refresh, review package-lock.json, and commit the result.\n");
} else {
  process.stdout.write("package-lock.json uses only the public npm registry.\n");
}
