import { RunnerScope } from '../../src/types/runner-scope.js';

describe('RunnerScope', () => {
  it('org() sets kind org and the org name', () => {
    const scope = RunnerScope.org('my-org');
    expect(scope.kind).toBe('org');
    expect(scope.organization).toBe('my-org');
    expect(scope.repositories).toBeUndefined();
  });

  it('repos() sets kind repos and the repo list', () => {
    const scope = RunnerScope.repos(['owner/repo-a', 'owner/repo-b']);
    expect(scope.kind).toBe('repos');
    expect(scope.repositories).toEqual(['owner/repo-a', 'owner/repo-b']);
    expect(scope.organization).toBeUndefined();
  });

  it('repos() rejects entries that are not owner/repo', () => {
    expect(() => RunnerScope.repos(['bad'])).toThrow(/owner\/repo/);
  });

  it('repos() rejects entries with more than one slash', () => {
    expect(() => RunnerScope.repos(['owner/repo/extra'])).toThrow(
      /owner\/repo/,
    );
  });

  it('repos() rejects entries with an empty owner or repo segment', () => {
    expect(() => RunnerScope.repos(['/repo'])).toThrow(/owner\/repo/);
    expect(() => RunnerScope.repos(['owner/'])).toThrow(/owner\/repo/);
  });

  it('repos() rejects an empty array', () => {
    expect(() => RunnerScope.repos([])).toThrow(/at least one/);
  });

  it('toJson() serializes org scope without repos', () => {
    expect(RunnerScope.org('my-org').toJson()).toBe(
      JSON.stringify({ kind: 'org', org: 'my-org' }),
    );
  });

  it('toJson() serializes repos scope without org', () => {
    expect(RunnerScope.repos(['owner/repo']).toJson()).toBe(
      JSON.stringify({ kind: 'repos', repos: ['owner/repo'] }),
    );
  });
});
