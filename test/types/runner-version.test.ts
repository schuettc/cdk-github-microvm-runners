import { DEFAULT_RUNNER_VERSION } from '../../src/image/default-runner-version.js';
import {
  normalizeImageOptions,
  renderDockerfile,
} from '../../src/image/dockerfile-template.js';
import { RunnerVersion } from '../../src/types/runner-version.js';

describe('RunnerVersion', () => {
  it('libraryDefault() carries no explicit version', () => {
    expect(RunnerVersion.libraryDefault().version).toBeUndefined();
  });

  it('latest() behaves identically to libraryDefault()', () => {
    expect(RunnerVersion.latest().version).toBe(
      RunnerVersion.libraryDefault().version,
    );
  });

  it('of() pins an explicit version', () => {
    expect(RunnerVersion.of('2.319.1').version).toBe('2.319.1');
  });

  it('the library default is 2.337.0', () => {
    expect(DEFAULT_RUNNER_VERSION).toBe('2.337.0');
  });

  it.each([
    ['libraryDefault', RunnerVersion.libraryDefault()],
    ['latest', RunnerVersion.latest()],
  ])(
    'a %s() image installs DEFAULT_RUNNER_VERSION in the Dockerfile',
    (_name, runnerVersion) => {
      const dockerfile = renderDockerfile(
        normalizeImageOptions({ runnerVersion }),
      );
      expect(dockerfile).toContain(
        `download/v${DEFAULT_RUNNER_VERSION}/actions-runner-linux-arm64-${DEFAULT_RUNNER_VERSION}.tar.gz`,
      );
    },
  );
});
