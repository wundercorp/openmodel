import { appendFile, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getPaths } from './paths.js';

function ledgerPath() {
  const root = getPaths().root;
  return join(root, 'usage', 'events.jsonl');
}

export async function appendUsageEvent(event) {
  const path = ledgerPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify({ schemaVersion: 1, ...event })}\n`, { mode: 0o600 });
}

export async function readUsageEvents() {
  try {
    const value = await readFile(ledgerPath(), 'utf8');
    return value.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function clearUsageEvents() {
  const path = ledgerPath();
  try { await rename(path, `${path}.synced-${Date.now()}`); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
