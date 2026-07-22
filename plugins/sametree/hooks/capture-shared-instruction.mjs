import { spawn } from 'node:child_process';

// Shared-instruction awareness must never prevent Claude from accepting a user prompt.
const executable = process.env.SAMETREE_BIN || 'sametree';
const script = /\.[cm]?js$/iu.test(executable);
const command = script ? process.execPath : executable;
const args = [...(script ? [executable] : []), 'hook', 'claude-instruction'];
const env = {
  ...process.env,
  SAMETREE_CWD: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
};

try {
  const child = spawn(command, args, {
    env,
    shell: process.platform === 'win32' && !script,
    stdio: ['inherit', 'ignore', 'ignore'],
    windowsHide: true,
  });
  const timeout = setTimeout(() => {
    child.kill();
    process.exit(0);
  }, 2_000);
  const finish = () => {
    clearTimeout(timeout);
    process.exitCode = 0;
  };
  child.once('error', finish);
  child.once('close', finish);
} catch {
  process.exitCode = 0;
}
