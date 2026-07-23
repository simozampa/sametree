import { describe, expect, it } from 'vitest';

import { errorResult } from '../src/errors.js';

describe('error results', () => {
  it.each(['SQLITE_BUSY', 'SQLITE_BUSY_TIMEOUT', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE'])(
    'classifies %s as database contention',
    (code) => {
      const error = Object.assign(new Error('database is locked'), { code });

      expect(errorResult(error)).toEqual({
        ok: false,
        error: {
          code: 'DATABASE_ERROR',
          message: 'SameTree database remained locked while waiting for another writer.',
          details: { cause: 'database is locked' },
        },
      });
    },
  );
});
