import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const packageDirectory = path.resolve(process.argv[2] ?? '.');
const packageJsonPath = path.join(packageDirectory, 'package.json');
const readmePath = path.join(packageDirectory, 'README.md');

const packageData = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const readme = await readFile(readmePath, 'utf8');

const failures = [];

if (!packageData.description || packageData.description.trim().length < 40) {
  failures.push('package.json must contain a meaningful description.');
}

if (!Array.isArray(packageData.keywords) || packageData.keywords.length < 5) {
  failures.push('package.json must contain at least five relevant keywords.');
}

if (!packageData.repository?.url) {
  failures.push('package.json must contain repository.url.');
}

if (!packageData.homepage) {
  failures.push('package.json must contain homepage.');
}

if (!packageData.bugs?.url) {
  failures.push('package.json must contain bugs.url.');
}

if (!packageData.license) {
  failures.push('package.json must contain a license.');
}

if (readme.trim().length < 1000) {
  failures.push('README.md must contain complete package documentation.');
}

if (!readme.includes('npm install --global @wundercorp/openmodel')) {
  failures.push('README.md must contain the global installation command.');
}

if (!readme.includes('om help')) {
  failures.push('README.md must document the CLI help command.');
}

if (Array.isArray(packageData.files) && !packageData.files.includes('README.md')) {
  failures.push('package.json files must include README.md.');
}

const readmeStats = await stat(readmePath);
if (!readmeStats.isFile()) {
  failures.push('README.md must be a regular file.');
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`Package metadata validation failed: ${failure}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Package metadata validated for ${packageData.name}@${packageData.version}.\n`);
}
