// Two hardening edits to the projen-generated release workflow, applied after
// synth because neither is reachable from `.projenrc.ts`.
//
// Runs as part of the `default` task, immediately after `tsx .projenrc.ts`, so
// `just verify`'s projen-check (re-synth, then fail on drift) sees the same
// bytes it would produce itself. This file is the reason release.yml differs
// from stock projen output.
//
// EVERY edit asserts its precondition and throws if the shape it expects is
// gone. A projen upgrade that restructures the release workflow must fail here
// loudly — a patch that silently matches nothing would leave the release
// pipeline unhardened while every gate stayed green, which is the failure mode
// this whole file exists to prevent.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';

const WORKFLOW = '.github/workflows/release.yml';

// Pinned deliberately. `publib@latest` resolves at release time, inside the
// job holding the publishing credentials — so whatever version exists that
// minute runs with the ability to publish as this package. That is the
// textbook supply-chain path, and it matters more under trusted publishing,
// where the OIDC token is minted in that same job.
//
// Bumping this is a deliberate act: read publib's changelog, then change the
// number here.
const PUBLIB_VERSION = '0.2.1056';

export function hardenReleaseWorkflow(): void {
  const raw = readFileSync(WORKFLOW, 'utf8');
  const doc = parse(raw);
  if (!doc?.jobs) {
    throw new Error(`harden-release-workflow: ${WORKFLOW} has no jobs`);
  }

  // --- 1. Pin publib -----------------------------------------------------------
  let pinned = 0;
  for (const [jobId, job] of Object.entries<any>(doc.jobs)) {
    for (const step of (job.steps ?? []) as any[]) {
      if (typeof step.run === 'string' && step.run.includes('publib@latest')) {
        step.run = step.run.replace(
          /publib@latest/g,
          `publib@${PUBLIB_VERSION}`,
        );
        pinned += 1;
        console.log(`  pinned publib in ${jobId}`);
      }
    }
  }
  if (pinned === 0) {
    throw new Error(
      'harden-release-workflow: found no `publib@latest` to pin. Either projen ' +
        'changed how it invokes publib, or someone pinned it upstream. Check ' +
        'the generated workflow before removing this script.',
    );
  }

  // --- 2. Publish to npm with a trusted publisher ------------------------------
// projen surfaces `trustedPublishing` on PyPiPublishOptions (reachable through
// `publishToPypi`) but not on the npm side — NpmPublishOptions carries the
// same flag and no project-level option reaches it. So it is set here.
//
// publib-npm reads NPM_TRUSTED_PUBLISHER and, when it is set, unsets NPM_TOKEN
// itself and lets the npm CLI exchange the job's OIDC token for a short-lived
// publish token. `id-token: write` is already on this job.
//
// This only works once a trusted publisher is registered on npmjs.com against
// this repository and release.yml. npm cannot configure one for a package that
// does not exist, so the first version had to be published with a credential;
// every version after it needs none.
const npmJob = doc.jobs.release_npm;
const npmRelease = (npmJob?.steps ?? []).find(
  (s: any) => typeof s.run === 'string' && s.run.includes('publib-npm'),
);
if (!npmRelease) {
  throw new Error(
    'harden-release-workflow: no publib-npm step found in release_npm — the ' +
      'workflow shape changed and npm trusted publishing has nowhere to go.',
  );
}
npmRelease.env = npmRelease.env ?? {};
if (!('NPM_TOKEN' in npmRelease.env)) {
  throw new Error(
    'harden-release-workflow: release_npm no longer passes NPM_TOKEN. If ' +
      'projen started doing trusted publishing itself, delete this block ' +
      'rather than leaving it to fight the generated output.',
  );
}
delete npmRelease.env.NPM_TOKEN;
npmRelease.env.NPM_TRUSTED_PUBLISHER = 'true';
console.log('  npm publishes with a trusted publisher, no token');

// --- 2. Refuse to release from anything but main -----------------------------
  // `workflow_dispatch` has no branch filter, so without this anyone with write
  // access can dispatch a release from any branch and publish that branch's code
  // as this package.
  //
  // A guard STEP that fails, rather than a job-level `if:` that skips: a
  // workflow whose jobs all skip reports success, and "released nothing, looked
  // fine" is exactly the outcome an operator would not notice.
  const releaseJob = doc.jobs.release;
  if (!releaseJob?.steps?.length) {
    throw new Error(
      'harden-release-workflow: no `release` job with steps — the workflow ' +
        'shape changed and the branch guard has nowhere to go.',
    );
  }
  const GUARD_NAME = 'refuse to release from a non-default branch';
  if (!releaseJob.steps.some((s: any) => s.name === GUARD_NAME)) {
    releaseJob.steps.unshift({
      name: GUARD_NAME,
      run: [
        'if [ "$GITHUB_REF" != "refs/heads/main" ]; then',
        '  echo "::error::release was dispatched from $GITHUB_REF."',
        '  echo "Releases publish from main only. Promote to main first."',
        '  exit 1',
        'fi',
        'echo "releasing from $GITHUB_REF"',
      ].join('\n'),
    });
    console.log('  added the non-main dispatch guard to the release job');
  }

  // projen writes its generated files read-only so hand edits are obvious.
  // Drop that for the write and put it back — this script IS part of
  // generation, and leaving the file writable would quietly invite the very
  // editing the read-only bit exists to discourage.
  //
  // 0o444 rather than the mode read back off disk: that is what projen sets,
  // and restoring a stat'd st_mode would mean masking off the file-type bits.
  const READONLY = 0o444;
  chmodSync(WORKFLOW, 0o644);
  try {
    writeFileSync(WORKFLOW, stringify(doc, { lineWidth: 0 }));
  } finally {
    chmodSync(WORKFLOW, READONLY);
  }
  console.log(`harden-release-workflow: ${WORKFLOW} patched`);
}
