#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs/demo.svg');
const result = spawnSync(
  'npx',
  [
    '--yes',
    'svg-term-cli@2.1.1',
    '--command',
    './scripts/demo.sh',
    '--out',
    'docs/demo.svg',
    '--window',
    '--width',
    '100',
    '--height',
    '20',
  ],
  { cwd: root, stdio: 'inherit' },
);

if (result.status !== 0) process.exit(result.status ?? 1);

const svg = readFileSync(output, 'utf8');
const loop = 'animation-iteration-count:infinite';
if (svg.split(loop).length !== 2) {
  throw new Error('Expected one looping demo animation.');
}

writeFileSync(
  output,
  svg.replace(loop, 'animation-fill-mode:forwards;animation-iteration-count:1'),
);
