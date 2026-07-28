import { createHash } from 'node:crypto';
import { DEFAULT_RUNNER_VERSION } from '../../src/image/default-runner-version.js';
import {
  computeContentHash,
  normalizeImageOptions,
  renderDockerfile,
  type RunnerImageOptions,
} from '../../src/image/dockerfile-template.js';
import { RunnerToolchain } from '../../src/image/runner-toolchain.js';
import { RunnerVersion } from '../../src/types/runner-version.js';

/** Normalize + render + hash in one step, for the hash-comparison tests below. */
function hashOf(opts: RunnerImageOptions): string {
  const normalized = normalizeImageOptions(opts);
  return computeContentHash(renderDockerfile(normalized), normalized);
}

describe('renderDockerfile', () => {
  it('renders the base image, package install, runner download, agent COPY, and entrypoint for default options', () => {
    const rendered = renderDockerfile(normalizeImageOptions({}));

    expect(rendered).toContain(
      'FROM public.ecr.aws/lambda/microvms:al2023-minimal',
    );
    expect(rendered).toMatch(
      /^RUN dnf install -y .*\bgit\b.*\bdocker\b.*\bjq\b.*\btar\b.*\bzip\b.*\bunzip\b.*\bnodejs22\b.*\bsudo\b.*\bshadow-utils\b.* && dnf clean all$/m,
    );
    expect(rendered).toContain(
      `https://github.com/actions/runner/releases/download/v${DEFAULT_RUNNER_VERSION}/actions-runner-linux-arm64-${DEFAULT_RUNNER_VERSION}.tar.gz`,
    );
    expect(rendered).toContain(
      'COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs',
    );
    expect(rendered).toContain(
      'COPY microvm-runner/entrypoint.sh /opt/microvm-runner/entrypoint.sh',
    );
    expect(rendered).toContain(
      'ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]',
    );
    expect(rendered).not.toContain('docker.io');
  });

  it('matches the full default-render snapshot', () => {
    expect(renderDockerfile(normalizeImageOptions({}))).toMatchSnapshot();
  });

  it('injects consumer-supplied systemPackages into the dnf install line', () => {
    const rendered = renderDockerfile(
      normalizeImageOptions({ systemPackages: ['golang'] }),
    );
    expect(rendered).toContain('golang');
  });

  it('sorts systemPackages for deterministic output regardless of input order', () => {
    const a = renderDockerfile(
      normalizeImageOptions({ systemPackages: ['zeta', 'alpha'] }),
    );
    const b = renderDockerfile(
      normalizeImageOptions({ systemPackages: ['alpha', 'zeta'] }),
    );
    expect(a).toBe(b);
  });

  it('renders ENV lines for consumer-supplied environment variables, sorted by key', () => {
    const rendered = renderDockerfile(
      normalizeImageOptions({ environment: { ZKEY: 'z', AKEY: 'a' } }),
    );
    const akeyIdx = rendered.indexOf('ENV AKEY="a"');
    const zkeyIdx = rendered.indexOf('ENV ZKEY="z"');
    expect(akeyIdx).toBeGreaterThan(-1);
    expect(zkeyIdx).toBeGreaterThan(-1);
    expect(akeyIdx).toBeLessThan(zkeyIdx);
  });

  it('renders an ENV value containing spaces as a single double-quoted value', () => {
    const rendered = renderDockerfile(
      normalizeImageOptions({ environment: { GREETING: 'hello world' } }),
    );
    expect(rendered).toContain('ENV GREETING="hello world"');
  });

  it('escapes embedded double quotes and backslashes in an ENV value', () => {
    const rendered = renderDockerfile(
      normalizeImageOptions({
        environment: { TRICKY: 'say "hi" \\ bye' },
      }),
    );
    expect(rendered).toContain('ENV TRICKY="say \\"hi\\" \\\\ bye"');
  });

  it('throws at normalize when an environment value contains a newline', () => {
    expect(() =>
      normalizeImageOptions({ environment: { BAD: 'line1\nline2' } }),
    ).toThrow(/newline/);
  });

  it('renders RUN lines for setupCommands, preserving order', () => {
    const rendered = renderDockerfile(
      normalizeImageOptions({
        setupCommands: ['mkdir -p /opt/x', 'touch /opt/x/y'],
      }),
    );
    const mkdirIdx = rendered.indexOf('RUN mkdir -p /opt/x');
    const touchIdx = rendered.indexOf('RUN touch /opt/x/y');
    expect(mkdirIdx).toBeGreaterThan(-1);
    expect(touchIdx).toBeGreaterThan(mkdirIdx);
  });

  it('renders a COPY line per asset, indexed and preserving order', () => {
    const rendered = renderDockerfile(
      normalizeImageOptions({
        assets: [
          { source: '/local/one', target: '/opt/one' },
          { source: '/local/two', target: '/opt/two' },
        ],
      }),
    );
    expect(rendered).toContain('COPY assets/0/ /opt/one');
    expect(rendered).toContain('COPY assets/1/ /opt/two');
  });

  it('never references Docker Hub / docker.io', () => {
    const rendered = renderDockerfile(
      normalizeImageOptions({
        systemPackages: ['foo'],
        setupCommands: ['echo hi'],
        environment: { FOO: 'bar' },
      }),
    );
    expect(rendered).not.toMatch(/docker\.io/);
  });
});

describe('computeContentHash', () => {
  it('is deterministic: identical options produce identical hashes', () => {
    expect(hashOf({ systemPackages: ['golang'] })).toBe(
      hashOf({ systemPackages: ['golang'] }),
    );
  });

  it('is order-insensitive for systemPackages (same set, different order)', () => {
    expect(hashOf({ systemPackages: ['zeta', 'alpha'] })).toBe(
      hashOf({ systemPackages: ['alpha', 'zeta'] }),
    );
  });

  it('changes when options change (systemPackages)', () => {
    expect(hashOf({})).not.toBe(hashOf({ systemPackages: ['golang'] }));
  });

  it('changes when options change (environment)', () => {
    expect(hashOf({})).not.toBe(hashOf({ environment: { FOO: 'bar' } }));
  });

  it('changes when an asset source path changes even if target is identical', () => {
    const a = hashOf({ assets: [{ source: '/local/a', target: '/opt/a' }] });
    const b = hashOf({ assets: [{ source: '/local/b', target: '/opt/a' }] });
    expect(a).not.toBe(b);
  });

  it('changes when options change (setupCommands)', () => {
    expect(hashOf({})).not.toBe(hashOf({ setupCommands: ['echo hi'] }));
  });

  it('changes when options change (runnerVersion)', () => {
    expect(hashOf({})).not.toBe(
      hashOf({ runnerVersion: RunnerVersion.of('2.334.0') }),
    );
  });

  it('changes when an asset target changes even if source is identical', () => {
    const a = hashOf({ assets: [{ source: '/local/a', target: '/opt/a' }] });
    const b = hashOf({ assets: [{ source: '/local/a', target: '/opt/b' }] });
    expect(a).not.toBe(b);
  });

  it('produces a 64-char hex sha256 digest', () => {
    expect(hashOf({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it('empty toolchains: contentHash omits the toolchains manifest key (byte-identical to pre-feature)', () => {
    const n = normalizeImageOptions({}); // no toolchains
    const df = renderDockerfile(n);
    const expected = createHash('sha256')
      .update(df)
      .update('\n')
      .update(JSON.stringify({ runnerVersion: n.runnerVersion, assets: [] }))
      .digest('hex');
    expect(computeContentHash(df, n)).toBe(expected);
    // and {} vs { toolchains: [] } agree
    expect(computeContentHash(df, n)).toBe(
      computeContentHash(
        renderDockerfile(normalizeImageOptions({ toolchains: [] })),
        normalizeImageOptions({ toolchains: [] }),
      ),
    );
  });
});

describe('toolchains', () => {
  const norm = (tc: RunnerToolchain[]) =>
    normalizeImageOptions({ toolchains: tc });

  it('renders a Node toolchain into the exact cache layout with a sibling .complete', () => {
    const df = renderDockerfile(norm([RunnerToolchain.node('22.11.0')]));
    expect(df).toContain('/opt/hostedtoolcache/node/22.11.0/arm64');
    expect(df).toContain(
      'https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-arm64.tar.xz',
    );
    expect(df).toContain('--strip-components=1');
    expect(df).toContain(
      'touch /opt/hostedtoolcache/node/22.11.0/arm64.complete',
    );
  });

  it('renders a Python toolchain: source build at the exact prefix, no PGO, bin/python symlink', () => {
    const df = renderDockerfile(norm([RunnerToolchain.python('3.12.7')]));
    expect(df).toContain(
      '--prefix=/opt/hostedtoolcache/Python/3.12.7/arm64 --enable-shared',
    );
    expect(df).toContain('--with-ensurepip=install');
    expect(df).not.toContain('--enable-optimizations');
    expect(df).toContain('make altinstall');
    expect(df).toContain(
      'ln -sf python3.12 /opt/hostedtoolcache/Python/3.12.7/arm64/bin/python',
    );
    expect(df).toContain(
      'touch /opt/hostedtoolcache/Python/3.12.7/arm64.complete',
    );
    expect(df).toContain(
      'https://www.python.org/ftp/python/3.12.7/Python-3.12.7.tar.xz',
    );
  });

  it('points the runner at the baked cache via /opt/runner/.env exactly once', () => {
    const df = renderDockerfile(
      norm([RunnerToolchain.python('3.12.7'), RunnerToolchain.node('22.11.0')]),
    );
    const envLines = df
      .split('\n')
      .filter((l) => l.includes('/opt/runner/.env'));
    expect(envLines).toHaveLength(1);
    expect(envLines[0]).toContain('RUNNER_TOOL_CACHE=/opt/hostedtoolcache');
  });

  it('is lean by default: empty toolchains render identically to today', () => {
    const withEmpty = renderDockerfile(
      normalizeImageOptions({ toolchains: [] }),
    );
    const withNone = renderDockerfile(normalizeImageOptions({}));
    expect(withEmpty).toBe(withNone);
    expect(withEmpty).not.toContain('/opt/hostedtoolcache');
    expect(withEmpty).not.toContain('/opt/runner/.env');
  });

  it('contentHash changes when toolchains change, and is stable when they do not', () => {
    const hash = (tc: RunnerToolchain[]) => {
      const n = normalizeImageOptions({ toolchains: tc });
      return computeContentHash(renderDockerfile(n), n);
    };
    expect(hash([RunnerToolchain.python('3.12.7')])).not.toBe(hash([]));
    expect(hash([RunnerToolchain.python('3.12.7')])).not.toBe(
      hash([RunnerToolchain.python('3.11.9')]),
    );
    expect(hash([RunnerToolchain.node('22.11.0')])).toBe(
      hash([RunnerToolchain.node('22.11.0')]),
    );
  });
});

describe('warmPaths', () => {
  it('bakes the default hot set into an ENV the in-VM agent reads at /ready', () => {
    const rendered = renderDockerfile(normalizeImageOptions({}));

    expect(rendered).toContain(
      'ENV MICROVM_RUNNER_WARM_PATHS="/opt/runner:/usr/bin/node:/usr/bin/git"',
    );
  });

  it('omits the ENV entirely when warming is turned off with an empty array', () => {
    // `[]` has to survive the `??` that fills in the default — an
    // implementation testing falsiness rather than `undefined` would quietly
    // warm the default set here, which is the opposite of what was asked.
    const rendered = renderDockerfile(normalizeImageOptions({ warmPaths: [] }));

    expect(rendered).not.toContain('MICROVM_RUNNER_WARM_PATHS');
  });

  it('joins consumer paths with the colon separator the agent splits on', () => {
    const rendered = renderDockerfile(
      normalizeImageOptions({ warmPaths: ['/usr/bin/python3', '/opt/tools'] }),
    );

    expect(rendered).toContain(
      'ENV MICROVM_RUNNER_WARM_PATHS="/usr/bin/python3:/opt/tools"',
    );
  });

  it('rejects a path containing the separator instead of splitting it in the VM', () => {
    // A colon would arrive at the agent as two paths, neither of which exists,
    // so warming would silently do nothing. Failing at synth is the only point
    // where that is visible.
    expect(() => normalizeImageOptions({ warmPaths: ['/opt/a:b'] })).toThrow(
      /contains a colon/,
    );
  });

  it('changes the content hash, so a different warm set publishes a new image', () => {
    expect(hashOf({ warmPaths: ['/usr/bin/node'] })).not.toBe(hashOf({}));
    expect(hashOf({ warmPaths: [] })).not.toBe(hashOf({}));
  });

  it('hashes identically when the default set is passed explicitly', () => {
    expect(
      hashOf({ warmPaths: ['/opt/runner', '/usr/bin/node', '/usr/bin/git'] }),
    ).toBe(hashOf({}));
  });
});
