#!/usr/bin/env node
import { main } from '../src/index.js';

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`om: ${message}\n`);
  if (process.env.OPENMODEL_DEBUG === '1' && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
