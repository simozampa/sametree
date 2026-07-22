import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { installRuntimePath } from '../src/runtime.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('install Node runtime', () => {
  it('selects a different recorded install runtime', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sametree-runtime-'));
    temporaryDirectories.push(directory);
    const metadata = path.join(directory, 'install-runtime.json');
    const runtime = path.join(directory, 'node');
    writeFileSync(runtime, '');
    chmodSync(runtime, 0o755);
    writeFileSync(metadata, JSON.stringify({ runtime }));

    expect(installRuntimePath(metadata, process.execPath, {})).toBe(runtime);
    expect(installRuntimePath(metadata, runtime, {})).toBeNull();
    expect(
      installRuntimePath(metadata, process.execPath, {
        SAMETREE_INSTALL_RUNTIME_RELAUNCHED: '1',
      }),
    ).toBeNull();
  });

  it('ignores missing or invalid install metadata', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sametree-runtime-'));
    temporaryDirectories.push(directory);
    const metadata = path.join(directory, 'install-runtime.json');

    expect(installRuntimePath(metadata, process.execPath, {})).toBeNull();
    writeFileSync(metadata, JSON.stringify({ runtime: 'node' }));
    expect(installRuntimePath(metadata, process.execPath, {})).toBeNull();
  });

  it('relaunches an entrypoint through its recorded install runtime', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sametree-runtime-'));
    temporaryDirectories.push(directory);
    const metadata = path.join(directory, 'install-runtime.json');
    const entrypoint = path.join(directory, 'entrypoint.mjs');
    const runtime = path.join(directory, 'node');
    const runtimeModule = pathToFileURL(path.resolve('dist/runtime.js')).href;
    copyFileSync(process.execPath, runtime);
    chmodSync(runtime, 0o755);
    writeFileSync(metadata, JSON.stringify({ runtime }));
    writeFileSync(
      entrypoint,
      `import { runWithInstallRuntime } from ${JSON.stringify(runtimeModule)};\nconst code = await runWithInstallRuntime({ metadataPath: ${JSON.stringify(metadata)} });\nif (code !== null) process.exit(code);\nprocess.stdout.write(process.execPath + '\\n');\n`,
    );

    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [entrypoint], { stdio: ['ignore', 'pipe', 'inherit'] });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout }));
    });

    expect(result).toEqual({ code: 0, stdout: `${runtime}\n` });
  });
});
