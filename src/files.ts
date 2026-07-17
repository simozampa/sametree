import { randomUUID } from 'node:crypto';
import { chmodSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Replace a text file atomically so interruption cannot leave a truncated target. */
export function writeTextFileAtomic(target: string, content: string, mode?: number): void {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let targetMode = mode;
  if (targetMode === undefined) {
    try {
      targetMode = statSync(target).mode & 0o777;
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') throw error;
      targetMode = 0o644;
    }
  }
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: targetMode, flag: 'wx' });
    chmodSync(temporary, targetMode);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
