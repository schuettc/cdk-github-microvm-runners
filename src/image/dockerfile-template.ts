import { createHash } from 'node:crypto';
import { DEFAULT_RUNNER_VERSION } from './default-runner-version.js';
import { RunnerToolchain, ToolchainKind } from './runner-toolchain.js';
import type { RunnerVersion } from '../types/runner-version.js';

/**
 * One extra file or directory baked into the image.
 *
 * `source` is a path on the machine running `cdk synth`. The image pipeline
 * reads it off disk when it stages the Docker build context, and the rendered
 * Dockerfile copies it to `target` inside the image.
 */
export interface ImageAsset {
  /** Path (file or directory) on the build machine to copy into the image. */
  readonly source: string;
  /** Absolute path inside the image to copy `source` to. */
  readonly target: string;
}

/** Options for `RunnerImage.fromOptions`. */
export interface RunnerImageOptions {
  /** `actions/runner` release to install. @default RunnerVersion.latest() */
  readonly runnerVersion?: RunnerVersion;
  /** Extra `dnf` packages to install alongside the fixed base set. */
  readonly systemPackages?: string[];
  /** Extra `RUN` commands, executed in order after packages, assets, and environment variables are laid down. */
  readonly setupCommands?: string[];
  /** Extra files and directories to copy into the image. */
  readonly assets?: ImageAsset[];
  /** Extra environment variables baked into the image. */
  readonly environment?: Record<string, string>;
  /** Language runtimes to bake into the hosted tool cache, so `actions/setup-*` finds them without downloading anything. An image with none of these is smaller; one toolchain entry is needed per version your workflows ask for. @default [] */
  readonly toolchains?: RunnerToolchain[];
  /** Extra Linux capabilities granted to the MicroVM's operating system. @default ['ALL'] */
  readonly additionalOsCapabilities?: string[];
  /**
   * Paths the in-VM agent pages into memory during the boot handshake, before
   * any job runs. Directories are walked.
   *
   * A MicroVM's pages fault in on first access, so the first run of a binary
   * costs far more than the second — enough that `actions/checkout` spends most
   * of its time waiting for `node` to page in. Warming moves that cost into the
   * idle window between boot and job assignment.
   *
   * Point this at the interpreters and tools your jobs reach for first. Set it
   * to `[]` to turn warming off entirely.
   *
   * @default ['/usr/bin/node', '/usr/bin/git', '/opt/runner']
   */
  readonly warmPaths?: string[];
}

/**
 * `RunnerImageOptions` with every field present and `runnerVersion`
 * resolved to a plain version string (no `RunnerVersion` wrapper) — the
 * shape {@link renderDockerfile} and {@link computeContentHash} consume.
 */
export interface NormalizedImageOptions {
  readonly runnerVersion: string;
  readonly systemPackages: string[];
  readonly setupCommands: string[];
  readonly assets: ImageAsset[];
  readonly environment: Record<string, string>;
  readonly toolchains: RunnerToolchain[];
  readonly additionalOsCapabilities: string[];
  readonly warmPaths: string[];
}

/**
 * Paths warmed when the consumer names none.
 *
 * `/opt/runner` is the important one, and an earlier version of this dropped it
 * on the reasoning that a job never touches those .NET assemblies. That was
 * wrong about who reads them: decomposing queue latency showed **29 of 41
 * seconds** is `Runner.Listener` starting inside an already-RUNNING VM, paging
 * in exactly those files — before any job exists. It is the largest single term
 * in start-up latency, and unlike job time it is billed while nothing runs.
 *
 * `node` and `git` are cheap by comparison and cover the `actions/checkout`
 * cost, which is what the first version was aimed at.
 */
export const DEFAULT_WARM_PATHS = [
  '/opt/runner',
  '/usr/bin/node',
  '/usr/bin/git',
];

/** True when `warmPaths` is exactly the default set, in order. */
function isDefaultWarmPaths(paths: string[]): boolean {
  return (
    paths.length === DEFAULT_WARM_PATHS.length &&
    paths.every((p, i) => p === DEFAULT_WARM_PATHS[i])
  );
}

/**
 * Fill in defaults and resolve `RunnerVersion` to a concrete version
 * string. Pure — no I/O, no CDK dependency.
 *
 * Rejects any `environment` value containing a newline: `renderDockerfile`
 * emits each `ENV` entry on its own line, and a raw newline in the value
 * would either break out of that line (Dockerfile syntax corruption) or get
 * silently mangled by whatever consumes the rendered text — better to fail
 * loudly here, at the one place that has the full picture of every
 * environment value being baked into the image.
 */
export function normalizeImageOptions(
  opts: RunnerImageOptions,
): NormalizedImageOptions {
  const environment = { ...(opts.environment ?? {}) };
  for (const [k, v] of Object.entries(environment)) {
    if (v.includes('\n') || v.includes('\r')) {
      throw new Error(
        `RunnerImage: environment variable "${k}"'s value contains a newline, which cannot be safely rendered into a Dockerfile ENV line.`,
      );
    }
  }
  for (const p of opts.warmPaths ?? []) {
    if (p.includes(':')) {
      throw new Error(
        `RunnerImage: warmPaths entry "${p}" contains a colon, which is the separator the in-VM agent splits on — it would be read as two paths, neither of which exists.`,
      );
    }
  }
  return {
    runnerVersion: opts.runnerVersion?.version ?? DEFAULT_RUNNER_VERSION,
    systemPackages: [...(opts.systemPackages ?? [])],
    setupCommands: [...(opts.setupCommands ?? [])],
    assets: [...(opts.assets ?? [])],
    environment,
    toolchains: [...(opts.toolchains ?? [])],
    additionalOsCapabilities: [
      ...(opts.additionalOsCapabilities ?? DEFAULT_ADDITIONAL_OS_CAPABILITIES),
    ],
    // `[]` is a real choice (warming off), so it has to survive `??` — which
    // is why this checks for `undefined` rather than falsiness.
    warmPaths: [...(opts.warmPaths ?? DEFAULT_WARM_PATHS)],
  };
}

/**
 * Fixed base dnf package set — `sudo` is required because the in-VM agent
 * spawns the runner via `sudo -u runner`; `bash` is required because
 * `entrypoint.sh` needs it and the `al2023-minimal` base image may not carry
 * it by default.
 */
const BASE_PACKAGES = [
  // .NET prerequisite for GitHub's runner (Runner.Listener FailFasts on
  // missing ICU — found in the first real VM logs, 2026-07-19).
  'libicu',
  'bash',
  'git',
  'docker',
  'jq',
  'tar',
  'zip',
  'unzip',
  'nodejs22',
  'sudo',
  'shadow-utils',
];

/**
 * AL2023 build deps for compiling CPython from source. KEPT in the image (not
 * `dnf remove`d) so `pip` can build C extensions at job time — GitHub's hosted
 * runners keep their build toolchain for the same reason. Verify these names
 * against the live AL2023 repo at bake time. `dnf install` is idempotent, so
 * emitting this per-Python step is a near-noop after the first.
 */
const PYTHON_BUILD_DEPS = [
  'gcc',
  'gcc-c++',
  'make',
  'openssl-devel',
  'bzip2-devel',
  'libffi-devel',
  'zlib-devel',
  'xz-devel',
  'readline-devel',
  'sqlite-devel',
  'ncurses-devel',
  'tk-devel',
  'gdbm-devel',
];

/**
 * Render the `RUN` steps that bake `toolchains` into the hosted tool cache at
 * `/opt/hostedtoolcache/<Tool>/<version>/arm64/` (+ sibling `.complete`), and a
 * single `/opt/runner/.env` pointing the runner's tool cache there. Empty
 * `toolchains` → `[]` (lean image, no change to today's Dockerfile).
 */
function renderToolchainLines(toolchains: RunnerToolchain[]): string[] {
  if (toolchains.length === 0) return [];
  const lines: string[] = [];
  for (const t of toolchains) {
    if (t.kind === ToolchainKind.NODE) {
      const dir = `/opt/hostedtoolcache/node/${t.version}/arm64`;
      lines.push(
        `RUN set -o pipefail; mkdir -p ${dir} ` +
          `&& curl -fsSL https://nodejs.org/dist/v${t.version}/node-v${t.version}-linux-arm64.tar.xz ` +
          `| tar -xJ -C ${dir} --strip-components=1 ` +
          `&& touch /opt/hostedtoolcache/node/${t.version}/arm64.complete`,
      );
    } else {
      const dir = `/opt/hostedtoolcache/Python/${t.version}/arm64`;
      const minor = t.version.split('.').slice(0, 2).join('.'); // e.g. 3.12
      lines.push(
        `RUN set -o pipefail; dnf install -y ${PYTHON_BUILD_DEPS.join(' ')} ` +
          `&& mkdir -p /tmp/py-${t.version} ` +
          `&& curl -fsSL https://www.python.org/ftp/python/${t.version}/Python-${t.version}.tar.xz ` +
          `| tar -xJ -C /tmp/py-${t.version} --strip-components=1 ` +
          `&& cd /tmp/py-${t.version} ` +
          `&& ./configure --prefix=${dir} --enable-shared --with-ensurepip=install ` +
          `&& make -j"$(nproc)" && make altinstall ` +
          `&& ln -sf python${minor} ${dir}/bin/python ` +
          `&& ln -sf python${minor} ${dir}/bin/python3 ` +
          `&& cd / && rm -rf /tmp/py-${t.version} ` +
          `&& touch /opt/hostedtoolcache/Python/${t.version}/arm64.complete`,
      );
    }
  }
  // Hosted-runner parity: GitHub's hosted runners own the tool cache as the
  // runner user; here the RUN steps above execute as root, so without this
  // the non-root `runner` user can't write into it (breaks `npm i -g` and
  // any job that writes to the cache). One chown after all toolchains are
  // installed, not per-toolchain.
  lines.push('RUN chown -R runner:runner /opt/hostedtoolcache');
  // Read once at runner start (Runner.Listener loads /opt/runner/.env), then
  // re-exported to every job as RUNNER_TOOL_CACHE — that's what setup-* read.
  lines.push(
    `RUN printf 'RUNNER_TOOL_CACHE=/opt/hostedtoolcache\\n' > /opt/runner/.env`,
  );
  return lines;
}

/**
 * Escape a value for embedding inside a double-quoted `ENV key="value"`
 * line: backslashes first (so a later-escaped quote's backslash isn't
 * itself re-escaped), then double quotes. Values containing spaces render
 * as a single ENV value instead of splitting into multiple Dockerfile
 * tokens; newlines are rejected up front in `normalizeImageOptions`, so
 * they're never seen here.
 */
function escapeEnvValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Render the Dockerfile for a {@link NormalizedImageOptions}. Pure function:
 * identical input always produces identical output byte-for-byte — no I/O,
 * no clocks, no randomness. Base image is the spike-verified
 * `public.ecr.aws/lambda/microvms:al2023-minimal` (ARM64); zero Docker Hub
 * / `docker.io` references anywhere, and no AWS credentials are baked in.
 */
export function renderDockerfile(o: NormalizedImageOptions): string {
  // systemPackages and environment are sorted before rendering so the
  // output — and therefore contentHash — depends only on the *set* of
  // packages/env vars a consumer supplies, not the order they happened to
  // list them in (JS array/object iteration is insertion-order stable, so
  // without this, two logically-identical option sets built via different
  // code paths, e.g. Object.keys() of an unordered Map, could render
  // differently and silently invalidate a cached image). setupCommands and
  // assets are NOT sorted — their order is semantically meaningful
  // (e.g. `mkdir` before a later command that writes into it), so
  // preserving consumer order there is correct, not an oversight.
  const systemPackages = [...o.systemPackages].sort();
  const envEntries = Object.entries(o.environment).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    [
      'FROM public.ecr.aws/lambda/microvms:al2023-minimal',
      'RUN dnf install -y ' +
        [...BASE_PACKAGES, ...systemPackages].join(' ') +
        ' && dnf clean all',
      'RUN dnf install -y gh --repofrompath gh-cli,https://cli.github.com/packages/rpm || true',
      // AWS CLI v2 (ARM64). Baked in because it's a near-universal CI need —
      // ECR login (`aws ecr get-login-password`), `aws s3`/`sts`, and any job
      // that shells out to `aws` — and GitHub-hosted runners include it, so
      // consumers expect it present. Official installer (not dnf: awscli in
      // AL2023 repos is the deprecated v1). Verified live 2026-07-19.
      'RUN curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o /tmp/awscliv2.zip && unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscliv2.zip',
      'RUN useradd -m runner && usermod -aG docker runner || groupadd docker && usermod -aG docker runner',
      `RUN mkdir -p /opt/runner && cd /opt/runner && curl -fsSLo r.tgz https://github.com/actions/runner/releases/download/v${o.runnerVersion}/actions-runner-linux-arm64-${o.runnerVersion}.tar.gz && tar xzf r.tgz && rm r.tgz && chown -R runner:runner /opt/runner`,
      ...renderToolchainLines(o.toolchains),
      ...o.assets.map((a, i) => `COPY assets/${i}/ ${a.target}`),
      ...envEntries.map(([k, v]) => `ENV ${k}="${escapeEnvValue(v)}"`),
      // Consumed by the in-VM agent at the /ready hook. Colon-separated to
      // match PATH convention; a path containing a colon is rejected in
      // normalize rather than silently split here.
      ...(o.warmPaths.length
        ? [
            `ENV MICROVM_RUNNER_WARM_PATHS="${escapeEnvValue(o.warmPaths.join(':'))}"`,
          ]
        : []),
      ...o.setupCommands.map((c) => `RUN ${c}`),
      'COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs',
      'COPY microvm-runner/entrypoint.sh /opt/microvm-runner/entrypoint.sh',
      'RUN chmod +x /opt/microvm-runner/entrypoint.sh',
      'ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]',
    ].join('\n') + '\n'
  );
}

/** `additionalOsCapabilities`'s default — used by both the normalizer and {@link computeContentHash}'s default-case manifest omission. */
const DEFAULT_ADDITIONAL_OS_CAPABILITIES = ['ALL'];

/** True when `caps` is exactly the default `['ALL']` (order-sensitive: matches how the normalizer stores it, unsorted, same as consumer-supplied order). */
function isDefaultAdditionalOsCapabilities(caps: string[]): boolean {
  return (
    caps.length === DEFAULT_ADDITIONAL_OS_CAPABILITIES.length &&
    caps.every((c, i) => c === DEFAULT_ADDITIONAL_OS_CAPABILITIES[i])
  );
}

/**
 * sha256 over the rendered Dockerfile plus an asset manifest.
 *
 * The manifest currently carries the resolved asset `source`/`target`
 * pairs (and `runnerVersion`, already reflected in the Dockerfile text but
 * included for belt-and-suspenders sensitivity). It intentionally does
 * NOT hash the *bytes* under each asset's `source` path — this module is
 * a pure string transform with no filesystem access. Real byte-level
 * asset content hashing (and `fromDockerfile()` directory hashing) happens
 * at Docker build-context staging time in Task 6's image pipeline, which
 * does have filesystem access to the consumer's paths.
 */
export function computeContentHash(
  dockerfile: string,
  o: NormalizedImageOptions,
): string {
  const manifest = JSON.stringify({
    runnerVersion: o.runnerVersion,
    assets: o.assets.map((a) => ({ source: a.source, target: a.target })),
    ...(o.toolchains.length
      ? {
          toolchains: o.toolchains.map((t) => ({
            kind: t.kind,
            version: t.version,
          })),
        }
      : {}),
    // Only carried in the manifest when it deviates from the default
    // (['ALL']) — matches the `toolchains` conditional-inclusion pattern
    // above, so the default case's manifest — and therefore contentHash —
    // is byte-identical to before this field existed.
    ...(isDefaultAdditionalOsCapabilities(o.additionalOsCapabilities)
      ? {}
      : { additionalOsCapabilities: o.additionalOsCapabilities }),
    ...(isDefaultWarmPaths(o.warmPaths) ? {} : { warmPaths: o.warmPaths }),
  });
  return createHash('sha256')
    .update(dockerfile)
    .update('\n')
    .update(manifest)
    .digest('hex');
}
