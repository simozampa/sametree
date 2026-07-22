#!/usr/bin/env node

import { writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../.sametree-install-runtime.json', import.meta.url),
  `${JSON.stringify({ runtime: process.execPath, abi: process.versions.modules }, null, 2)}\n`,
);
