import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const paths = [
  'node_modules',
  '.artifacts',
  '.wrangler',
  'apps/cli/node_modules',
  'apps/cloud/node_modules',
  'apps/cloud/.wrangler',
  'apps/web/node_modules',
  'apps/web/.vite',
  'packages/gateway-sdk/node_modules',
  'gateways/example-gateway/node_modules',
  'apps/web/dist',
  'apps/cloud/dist',
  'apps/web/tsconfig.tsbuildinfo',
  'apps/cloud/tsconfig.tsbuildinfo',
  'apps/cli/coverage',
  'packages/gateway-sdk/coverage'
];

for (const path of paths) {
  await rm(resolve(projectRoot, path), { recursive: true, force: true });
}
