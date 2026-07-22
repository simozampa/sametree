import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, readFileSync, realpathSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL_RUNTIME_FILE = fileURLToPath(
  new URL('../.sametree-install-runtime.json', import.meta.url),
);
const RELAUNCHED_ENVIRONMENT = 'SAMETREE_INSTALL_RUNTIME_RELAUNCHED';

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

export function installRuntimePath(
  metadataPath = INSTALL_RUNTIME_FILE,
  currentRuntime = process.execPath,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  if (environment[RELAUNCHED_ENVIRONMENT] === '1') return null;
  try {
    const metadata: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      !('runtime' in metadata) ||
      typeof metadata.runtime !== 'string' ||
      !path.isAbsolute(metadata.runtime)
    ) {
      return null;
    }
    accessSync(metadata.runtime, fsConstants.X_OK);
    return sameFile(metadata.runtime, currentRuntime) ? null : metadata.runtime;
  } catch {
    return null;
  }
}

export async function runWithInstallRuntime(
  options: { metadataPath?: string } = {},
): Promise<number | null> {
  const invocation = process.argv[1];
  if (!invocation) return null;
  const runtime = installRuntimePath(options.metadataPath);
  if (!runtime) return null;

  return await new Promise<number>((resolve) => {
    const child = spawn(runtime, [invocation, ...process.argv.slice(2)], {
      detached: process.platform !== 'win32',
      env: { ...process.env, [RELAUNCHED_ENVIRONMENT]: '1' },
      stdio: 'inherit',
    });
    const signals: NodeJS.Signals[] =
      process.platform === 'win32'
        ? ['SIGTERM']
        : ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGCONT', 'SIGWINCH'];
    const forwarding = signals.map((signal) => ({
      signal,
      listener: () => {
        child.kill(signal);
      },
    }));
    if (process.platform !== 'win32') {
      const stopListener = () => {
        child.kill('SIGTSTP');
        process.off('SIGTSTP', stopListener);
        process.kill(process.pid, 'SIGTSTP');
        process.on('SIGTSTP', stopListener);
      };
      forwarding.push({ signal: 'SIGTSTP', listener: stopListener });
    }
    for (const { signal, listener } of forwarding) process.on(signal, listener);

    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      for (const { signal, listener } of forwarding) process.off(signal, listener);
      resolve(code);
    };
    child.once('error', (error) => {
      process.stderr.write(
        `SameTree could not launch its install Node runtime: ${String(error)}\n`,
      );
      finish(1);
    });
    child.once('exit', (code, signal) => {
      const signalCode = signal ? 128 + (osConstants.signals[signal] ?? 0) : 1;
      finish(code ?? signalCode);
    });
  });
}
