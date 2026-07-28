import { DEFAULT_RUNNER_VERSION } from '../../src/image/default-runner-version.js';
import { RunnerImage } from '../../src/image/runner-image.js';
import { RunnerVersion } from '../../src/types/runner-version.js';

describe('RunnerImage.fromOptions', () => {
  it('renders a Dockerfile with the pinned default runner version', () => {
    const image = RunnerImage.fromOptions();
    expect(image.dockerfile).toContain(
      `actions-runner-linux-arm64-${DEFAULT_RUNNER_VERSION}.tar.gz`,
    );
    expect(image.dockerfileDir).toBeUndefined();
  });

  it('honors an explicit RunnerVersion pin', () => {
    const image = RunnerImage.fromOptions({
      runnerVersion: RunnerVersion.of('2.300.0'),
    });
    expect(image.dockerfile).toContain(
      'actions-runner-linux-arm64-2.300.0.tar.gz',
    );
  });

  it('produces a 64-char hex contentHash', () => {
    const image = RunnerImage.fromOptions();
    expect(image.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: same options twice produce the same contentHash', () => {
    const a = RunnerImage.fromOptions({ systemPackages: ['golang'] });
    const b = RunnerImage.fromOptions({ systemPackages: ['golang'] });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('produces different contentHash for different options', () => {
    const a = RunnerImage.fromOptions();
    const b = RunnerImage.fromOptions({ systemPackages: ['golang'] });
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('additionalOsCapabilities defaults to ALL and is carried', () => {
    expect(RunnerImage.fromOptions().additionalOsCapabilities).toEqual(['ALL']);
    expect(
      RunnerImage.fromOptions({ additionalOsCapabilities: ['NET_ADMIN'] })
        .additionalOsCapabilities,
    ).toEqual(['NET_ADMIN']);
  });

  it('additionalOsCapabilities changes the content hash', () => {
    expect(RunnerImage.fromOptions().contentHash).not.toBe(
      RunnerImage.fromOptions({ additionalOsCapabilities: ['NET_ADMIN'] })
        .contentHash,
    );
  });
});

describe('RunnerImage.fromInline', () => {
  const AGENT_LINES = [
    'COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs',
    'COPY microvm-runner/entrypoint.sh /opt/microvm-runner/entrypoint.sh',
    'ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]',
  ];

  function inline(...extra: string[]): string {
    return [
      'FROM public.ecr.aws/lambda/microvms:al2023-minimal',
      ...extra,
      ...AGENT_LINES,
    ].join('\n');
  }

  it('carries the supplied text verbatim and sets no directory or assets', () => {
    const text = inline('RUN dnf install -y git');
    const image = RunnerImage.fromInline(text);
    expect(image.dockerfile).toBe(text);
    expect(image.dockerfileDir).toBeUndefined();
    expect(image.assets).toBeUndefined();
  });

  it('defaults additionalOsCapabilities to ALL', () => {
    expect(RunnerImage.fromInline(inline()).additionalOsCapabilities).toEqual([
      'ALL',
    ]);
  });

  it('produces a 64-char hex contentHash', () => {
    expect(RunnerImage.fromInline(inline()).contentHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('hashes the Dockerfile text itself: identical text matches, different text differs', () => {
    const a = RunnerImage.fromInline(inline('RUN dnf install -y git'));
    const b = RunnerImage.fromInline(inline('RUN dnf install -y git'));
    const c = RunnerImage.fromInline(inline('RUN dnf install -y jq'));
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
  });

  it('is sensitive to whitespace-only text changes (a real content hash, not a summary)', () => {
    expect(RunnerImage.fromInline(inline()).contentHash).not.toBe(
      RunnerImage.fromInline(inline() + '\n').contentHash,
    );
  });

  it('throws when the text does not COPY the in-VM agent', () => {
    expect(() =>
      RunnerImage.fromInline(
        'FROM public.ecr.aws/lambda/microvms:al2023-minimal\n',
      ),
    ).toThrow(/microvm-runner\/agent\.mjs/);
  });

  it('throws when the only agent COPY line is commented out', () => {
    expect(() =>
      RunnerImage.fromInline(
        [
          'FROM public.ecr.aws/lambda/microvms:al2023-minimal',
          '# COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs',
        ].join('\n'),
      ),
    ).toThrow(/microvm-runner\/agent\.mjs/);
  });

  it('accepts an agent COPY line carrying flags (e.g. --chown)', () => {
    expect(() =>
      RunnerImage.fromInline(
        [
          'FROM public.ecr.aws/lambda/microvms:al2023-minimal',
          'COPY --chown=runner:runner microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs',
          'ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]',
        ].join('\n'),
      ),
    ).not.toThrow();
  });
});

describe('RunnerImage.fromDockerfile', () => {
  it('records the consumer directory and leaves dockerfile text unset', () => {
    const image = RunnerImage.fromDockerfile('/some/dir');
    expect(image.dockerfileDir).toBe('/some/dir');
    expect(image.dockerfile).toBeUndefined();
  });

  it('is deterministic and sensitive to the directory path', () => {
    const a = RunnerImage.fromDockerfile('/some/dir');
    const b = RunnerImage.fromDockerfile('/some/dir');
    const c = RunnerImage.fromDockerfile('/other/dir');
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
  });
});
