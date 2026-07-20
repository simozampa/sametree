import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { SameTreeError } from './errors.js';

export const CONFIG_DIRECTORY = '.sametree';
export const CONFIG_FILE = path.join(CONFIG_DIRECTORY, 'config.json');
export const POLICY_FILE = path.join(CONFIG_DIRECTORY, 'policy.md');

export const configSchema = z.object({
  schemaVersion: z.literal(1),
  sessionTtlSeconds: z.number().int().min(30).max(3600),
  claimTtlSeconds: z.number().int().min(30).max(86400),
  taskLeaseSeconds: z.number().int().min(30).max(86400),
  handoffTtlSeconds: z.number().int().min(60).max(604800),
  maxStagedLines: z.number().int().min(1).max(100000),
  requireConventionalCommits: z.boolean(),
  forbidCoAuthoredBy: z.boolean(),
});

export type SameTreeConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: SameTreeConfig = {
  schemaVersion: 1,
  sessionTtlSeconds: 90,
  claimTtlSeconds: 900,
  taskLeaseSeconds: 900,
  handoffTtlSeconds: 86_400,
  maxStagedLines: 400,
  requireConventionalCommits: true,
  forbidCoAuthoredBy: true,
};

export function loadConfig(repositoryRoot: string): SameTreeConfig {
  const configPath = path.join(repositoryRoot, CONFIG_FILE);
  try {
    return configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
    if (code === 'ENOENT') {
      throw new SameTreeError(
        'INVALID_INPUT',
        `Missing SameTree configuration at ${configPath}; run 'sametree init' in this repository first.`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    throw new SameTreeError('INVALID_INPUT', `Invalid SameTree configuration at ${configPath}.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
