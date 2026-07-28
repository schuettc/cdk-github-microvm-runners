import { runnerSetConfigFor } from '../../src/handlers/shared/runner-set-config.js';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (
      [
        'SCOPE_JSON',
        'SIZE_CLASSES_JSON',
        'IMAGE_ARN',
        'SOME_NUM',
        'LOGGING_JSON',
        'WARM_POOL_JSON',
        'IDLE_POLICY_JSON',
      ].includes(key)
    ) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

beforeEach(() => {
  resetEnv();
});

describe('runnerSetConfigFor: requireEnv', () => {
  it('throws a module-prefixed error when the var is missing', () => {
    const { requireEnv } = runnerSetConfigFor('testmod');
    expect(() => requireEnv('SOME_VAR')).toThrow(
      'testmod: missing required environment variable SOME_VAR',
    );
  });

  it('returns the value when present', () => {
    process.env.SOME_VAR = 'hello';
    const { requireEnv } = runnerSetConfigFor('testmod');
    expect(requireEnv('SOME_VAR')).toBe('hello');
    delete process.env.SOME_VAR;
  });
});

describe('runnerSetConfigFor: numEnv', () => {
  it('rejects a non-numeric value ("abc") with a clear config error', () => {
    process.env.SOME_NUM = 'abc';
    const { numEnv } = runnerSetConfigFor('testmod');
    expect(() => numEnv('SOME_NUM')).toThrow(
      'testmod: invalid numeric env var SOME_NUM: "abc"',
    );
  });

  it('throws missing-required when unset and no default is given', () => {
    const { numEnv } = runnerSetConfigFor('testmod');
    expect(() => numEnv('SOME_NUM')).toThrow(
      'testmod: missing required environment variable SOME_NUM',
    );
  });

  it('falls back to defaultValue when unset and a default is given', () => {
    const { numEnv } = runnerSetConfigFor('testmod');
    expect(numEnv('SOME_NUM', 42)).toBe(42);
  });

  it('parses a present, finite numeric string', () => {
    process.env.SOME_NUM = '17';
    const { numEnv } = runnerSetConfigFor('testmod');
    expect(numEnv('SOME_NUM')).toBe(17);
  });
});

describe('runnerSetConfigFor: readScope / readSizeClasses', () => {
  it('parses SCOPE_JSON', () => {
    process.env.SCOPE_JSON = JSON.stringify({ kind: 'org', org: 'acme' });
    const { readScope } = runnerSetConfigFor('testmod');
    expect(readScope()).toEqual({ kind: 'org', org: 'acme' });
  });

  it('parses SIZE_CLASSES_JSON', () => {
    process.env.SIZE_CLASSES_JSON = JSON.stringify({
      microvm: { imageArn: 'arn:aws:lambda:us-east-1:1:microvm-image:x' },
    });
    const { readSizeClasses } = runnerSetConfigFor('testmod');
    expect(readSizeClasses()).toEqual({
      microvm: { imageArn: 'arn:aws:lambda:us-east-1:1:microvm-image:x' },
    });
  });
});

describe('runnerSetConfigFor: readLogging', () => {
  it('parses a cloudWatch LOGGING_JSON with no logGroupName', () => {
    process.env.LOGGING_JSON = JSON.stringify({ kind: 'cloudWatch' });
    const { readLogging } = runnerSetConfigFor('testmod');
    expect(readLogging()).toEqual({ kind: 'cloudWatch' });
  });

  it('parses a cloudWatch LOGGING_JSON carrying a logGroupName', () => {
    process.env.LOGGING_JSON = JSON.stringify({
      kind: 'cloudWatch',
      logGroupName: '/my/custom/group',
    });
    const { readLogging } = runnerSetConfigFor('testmod');
    expect(readLogging()).toEqual({
      kind: 'cloudWatch',
      logGroupName: '/my/custom/group',
    });
  });

  it('parses a disabled LOGGING_JSON', () => {
    process.env.LOGGING_JSON = JSON.stringify({ kind: 'disabled' });
    const { readLogging } = runnerSetConfigFor('testmod');
    expect(readLogging()).toEqual({ kind: 'disabled' });
  });

  it('throws a module-prefixed error when LOGGING_JSON is missing', () => {
    const { readLogging } = runnerSetConfigFor('testmod');
    expect(() => readLogging()).toThrow(
      'testmod: missing required environment variable LOGGING_JSON',
    );
  });
});

describe('runnerSetConfigFor: readWarmPool', () => {
  it('returns {} when WARM_POOL_JSON is unset (no registered class is warm)', () => {
    const { readWarmPool } = runnerSetConfigFor('testmod');
    expect(readWarmPool()).toEqual({});
  });

  it('returns {} when WARM_POOL_JSON is the empty-object string', () => {
    process.env.WARM_POOL_JSON = '{}';
    const { readWarmPool } = runnerSetConfigFor('testmod');
    expect(readWarmPool()).toEqual({});
  });

  it('parses a populated WARM_POOL_JSON', () => {
    process.env.WARM_POOL_JSON = JSON.stringify({ microvm: 2, large: 1 });
    const { readWarmPool } = runnerSetConfigFor('testmod');
    expect(readWarmPool()).toEqual({ microvm: 2, large: 1 });
  });
});

describe('runnerSetConfigFor: readIdlePolicies', () => {
  it('returns {} when IDLE_POLICY_JSON is unset (no registered class has an idlePolicy)', () => {
    const { readIdlePolicies } = runnerSetConfigFor('testmod');
    expect(readIdlePolicies()).toEqual({});
  });

  it('returns {} when IDLE_POLICY_JSON is the empty-object string', () => {
    process.env.IDLE_POLICY_JSON = '{}';
    const { readIdlePolicies } = runnerSetConfigFor('testmod');
    expect(readIdlePolicies()).toEqual({});
  });

  it('parses a populated IDLE_POLICY_JSON — suspendedDurationSeconds is always present (service-required, see types/idle-policy.ts), autoResumeEnabled only when the caller set it', () => {
    process.env.IDLE_POLICY_JSON = JSON.stringify({
      microvm: {
        maxIdleDurationSeconds: 300,
        suspendedDurationSeconds: 1800,
        autoResumeEnabled: true,
      },
      large: {
        maxIdleDurationSeconds: 600,
        suspendedDurationSeconds: 3600,
        autoResumeEnabled: false,
      },
    });
    const { readIdlePolicies } = runnerSetConfigFor('testmod');
    expect(readIdlePolicies()).toEqual({
      microvm: {
        maxIdleDurationSeconds: 300,
        suspendedDurationSeconds: 1800,
        autoResumeEnabled: true,
      },
      large: {
        maxIdleDurationSeconds: 600,
        suspendedDurationSeconds: 3600,
        autoResumeEnabled: false,
      },
    });
  });
});

describe('runnerSetConfigFor: runnerSetImageArns', () => {
  it('unions SIZE_CLASSES_JSON image ARNs with the IMAGE_ARN fallback, deduplicated', () => {
    process.env.SIZE_CLASSES_JSON = JSON.stringify({
      microvm: { imageArn: 'arn:a' },
      large: { imageArn: 'arn:b' },
    });
    process.env.IMAGE_ARN = 'arn:a';
    const { runnerSetImageArns } = runnerSetConfigFor('testmod');
    expect(runnerSetImageArns().sort()).toEqual(['arn:a', 'arn:b']);
  });
});

describe('runnerSetConfigFor: resolveTarget', () => {
  it('org scope resolves to { org }', () => {
    const { resolveTarget } = runnerSetConfigFor('testmod');
    expect(resolveTarget({ kind: 'org', org: 'acme' })).toEqual({
      org: 'acme',
    });
  });

  it('repos scope resolves owner/name from the given repo', () => {
    const { resolveTarget } = runnerSetConfigFor('testmod');
    expect(
      resolveTarget({ kind: 'repos', repos: ['acme/widgets'] }, 'acme/widgets'),
    ).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it('org scope with a missing org throws a module-prefixed error', () => {
    const { resolveTarget } = runnerSetConfigFor('testmod');
    expect(() => resolveTarget({ kind: 'org' })).toThrow(
      'testmod: SCOPE_JSON kind=org but org is missing',
    );
  });

  it('repos scope with no repo argument throws a missing-repo-field error', () => {
    const { resolveTarget } = runnerSetConfigFor('testmod');
    expect(() =>
      resolveTarget({ kind: 'repos', repos: ['acme/widgets'] }),
    ).toThrow('testmod: repos-scoped row is missing its repo field');
  });

  it('repos scope with a malformed repo (no slash) throws', () => {
    const { resolveTarget } = runnerSetConfigFor('testmod');
    expect(() =>
      resolveTarget({ kind: 'repos', repos: ['widgets'] }, 'widgets'),
    ).toThrow('testmod: malformed repo "widgets", expected owner/name');
  });
});
