import { RunnerVersion } from '../../src/types/runner-version.js';

describe('RunnerVersion', () => {
  it('latest() carries no explicit version', () => {
    expect(RunnerVersion.latest().version).toBeUndefined();
  });

  it('of() pins an explicit version', () => {
    expect(RunnerVersion.of('2.319.1').version).toBe('2.319.1');
  });
});
