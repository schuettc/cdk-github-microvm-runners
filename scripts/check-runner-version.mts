#!/usr/bin/env -S npx tsx
// check-runner-version — keeps DEFAULT_RUNNER_VERSION current with actions/runner.
//
// GitHub enforces a 30-day floor on self-hosted runners: an `actions/runner`
// release must be installed within 30 days of publication or GitHub stops
// queuing jobs to runners still on the older build
// (https://github.blog/changelog/2026-06-12-github-actions-minimum-version-enforcement-timeline-for-self-hosted-runners/).
// The library pins one release in src/image/default-runner-version.ts and bakes
// it into every image that doesn't ask for a specific version, so that pin has
// to keep moving as releases ship.
//
// This script reads the pin, asks the GitHub API for the latest published
// `actions/runner` release, and compares the two by semver. It NEVER lowers the
// pin: it only reports "behind" when the published release is STRICTLY greater
// than the pin, so a yanked/re-tagged lower release can't walk the default
// backwards. The release tag from the API is validated against a strict
// `X.Y.Z` shape before anything downstream (branch name, file rewrite, PR body)
// uses it, so an unexpected tag payload can't be interpolated anywhere.
//
// Exit codes:
//   0   the pin is current (or ahead) — nothing to do.
//   10  a newer release exists — the pin is behind. The new version and its
//       publish date are printed, and (when $GITHUB_OUTPUT is set) written as
//       step outputs for the workflow to open a bump PR.
//   1   the check itself failed (network, API error, malformed payload) — this
//       is NOT a "behind" verdict; fix the check.
//
// Auth is optional: an unauthenticated call works but is rate-limited, so a
// GITHUB_TOKEN / GH_TOKEN in the environment is used as a bearer token when
// present (read-only; the releases endpoint needs no scope on a public repo).
//
// Run locally:  npx tsx scripts/check-runner-version.mts
// In CI:        see .github/workflows/runner-version-watch.yml
import { appendFileSync } from 'node:fs';
import { DEFAULT_RUNNER_VERSION } from '../src/image/default-runner-version';

const RELEASES_LATEST =
  'https://api.github.com/repos/actions/runner/releases/latest';

/** A `X.Y.Z` semver with no pre-release/build metadata — the shape a runner
 * release tag always takes, and the only shape we let flow downstream. */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

interface LatestRelease {
  version: string;
  publishedAt: string; // ISO date from the API (published_at)
  url: string; // html_url of the release
}

/** Parse and validate a tag as strict `X.Y.Z`; returns the normalized version
 * (leading `v` stripped) or throws — refusing anything we won't put in a shell
 * command, branch name, or source file. */
function parseVersion(raw: string, source: string): string {
  const m = SEMVER.exec(raw.trim());
  if (!m) {
    throw new Error(`${source} is not a strict X.Y.Z version: ${r(raw)}`);
  }
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
}

// Quote a value for an error message safely (no raw payload into the terminal).
function r(v: string): string {
  return JSON.stringify(v);
}

/** Compare two validated `X.Y.Z` versions numerically. >0 if a>b, <0 if a<b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

async function fetchLatest(): Promise<LatestRelease> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'cdk-github-microvm-runners-version-watch',
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(RELEASES_LATEST, { headers });
  if (!res.ok) {
    throw new Error(
      `GitHub API ${res.status} ${res.statusText} for ${RELEASES_LATEST}`,
    );
  }
  const body = (await res.json()) as {
    tag_name?: unknown;
    published_at?: unknown;
    html_url?: unknown;
  };
  if (typeof body.tag_name !== 'string') {
    throw new Error('release payload has no string tag_name');
  }
  const version = parseVersion(body.tag_name, 'the latest release tag');
  const publishedAt =
    typeof body.published_at === 'string' ? body.published_at : '';
  if (!/^\d{4}-\d{2}-\d{2}T/.test(publishedAt)) {
    throw new Error(
      `release payload has no ISO published_at: ${r(publishedAt)}`,
    );
  }
  const url =
    typeof body.html_url === 'string' &&
    body.html_url.startsWith('https://github.com/actions/runner/')
      ? body.html_url
      : `https://github.com/actions/runner/releases/tag/v${version}`;
  return { version, publishedAt, url };
}

/** Add 30 days to an ISO instant, returning a `YYYY-MM-DD` date (UTC). */
function deadlineFrom(publishedAt: string): string {
  const d = new Date(publishedAt);
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}

/** Emit a step output when running under Actions ($GITHUB_OUTPUT set). */
function emitOutputs(outputs: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(outputs)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  appendFileSync(file, `${lines}\n`);
}

async function main(): Promise<number> {
  const current = parseVersion(
    DEFAULT_RUNNER_VERSION,
    'DEFAULT_RUNNER_VERSION',
  );
  console.log(`Pinned DEFAULT_RUNNER_VERSION: ${current}`);

  const latest = await fetchLatest();
  const publishDate = latest.publishedAt.slice(0, 10);
  console.log(
    `Latest actions/runner release: ${latest.version} (published ${publishDate})`,
  );

  if (compareVersions(latest.version, current) <= 0) {
    console.log('✓ The default is current — nothing to do.');
    emitOutputs({ behind: 'false' });
    return 0;
  }

  const deadline = deadlineFrom(latest.publishedAt);
  console.log(
    `\n✗ The default is behind. actions/runner ${latest.version} shipped on ` +
      `${publishDate}; GitHub stops queuing jobs to runners still on an older ` +
      `release 30 days after publication (by ${deadline}).`,
  );
  console.log(`  Release: ${latest.url}`);
  emitOutputs({
    behind: 'true',
    current,
    latest: latest.version,
    publish_date: publishDate,
    deadline,
    release_url: latest.url,
  });
  return 10;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`\n✗ runner version check failed to run: ${e?.message ?? e}`);
    process.exit(1);
  });
