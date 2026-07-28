import { resolveRuntimeLogging } from '../../../src/handlers/shared/launch-params.js';
import type { LoggingConfig } from '../../../src/handlers/shared/runner-set-config.js';

function readLoggingReturning(cfg: LoggingConfig): () => LoggingConfig {
  return () => cfg;
}

describe('resolveRuntimeLogging', () => {
  it('cloudWatch + no execution role -> undefined (RunMicrovm gets no logging field at all, never a bare cloudWatch on a powerless VM)', () => {
    expect(
      resolveRuntimeLogging(
        readLoggingReturning({ kind: 'cloudWatch' }),
        false,
      ),
    ).toBeUndefined();
  });

  it('cloudWatch (default, no logGroupName) + execution role present -> the cloudWatch object', () => {
    expect(
      resolveRuntimeLogging(readLoggingReturning({ kind: 'cloudWatch' }), true),
    ).toEqual({ cloudWatch: { logGroup: undefined } });
  });

  it('cloudWatch + a custom logGroupName + execution role present -> the cloudWatch object carrying that log group', () => {
    expect(
      resolveRuntimeLogging(
        readLoggingReturning({
          kind: 'cloudWatch',
          logGroupName: '/my/custom/group',
        }),
        true,
      ),
    ).toEqual({ cloudWatch: { logGroup: '/my/custom/group' } });
  });

  it('disabled -> { disabled: {} } regardless of execution-role presence (no role)', () => {
    expect(
      resolveRuntimeLogging(readLoggingReturning({ kind: 'disabled' }), false),
    ).toEqual({ disabled: {} });
  });

  it('disabled -> { disabled: {} } regardless of execution-role presence (role present)', () => {
    expect(
      resolveRuntimeLogging(readLoggingReturning({ kind: 'disabled' }), true),
    ).toEqual({ disabled: {} });
  });
});
