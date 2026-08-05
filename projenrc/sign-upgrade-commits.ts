// Make the dependency-upgrade workflow commit with a signature, applied after
// synth because projen has no option for it.
//
// `dev` and `main` both set branch protection's `required_signatures`, so an
// unsigned commit cannot be merged into either. projen configures
// `peter-evans/create-pull-request` with `signoff: true` — the DCO trailer,
// which is a line of commit *text* and has nothing to do with signing — and
// leaves `sign-commits` at its default of false. The action then pushes an
// ordinary unsigned git commit, and the pull request it opens is unmergeable
// by anyone, forever:
//
//   every required check green, 0 reviews required, mergeable: MERGEABLE,
//   mergeStateStatus: BLOCKED
//
// with nothing in the GitHub UI naming the signature as the cause. That is a
// nastier failure than a red check, because it looks like the PR is ready.
//
// `sign-commits: true` makes the action create the commit through GitHub's
// Contents API instead of pushing it, and commits created that way are signed
// by GitHub's own key. It needs no key material of ours — only the
// `contents: write` the app token already carries.
//
// Runs from the `default` task right after `tsx .projenrc.ts`, alongside
// `harden-release-workflow`, so `just verify`'s projen-check sees exactly the
// bytes a fresh synth produces. Same contract as that file: assert the shape
// this patch depends on and throw if it is gone, so a projen upgrade that
// restructures the workflow fails loudly here rather than silently reverting
// the fix while every gate stays green.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';

const WORKFLOW = '.github/workflows/upgrade-dev.yml';
const ACTION = 'peter-evans/create-pull-request';

export function signUpgradeCommits(): void {
  const raw = readFileSync(WORKFLOW, 'utf8');
  const doc = parse(raw);
  if (!doc?.jobs) {
    throw new Error(`sign-upgrade-commits: ${WORKFLOW} has no jobs`);
  }

  let patched = 0;
  for (const job of Object.values<any>(doc.jobs)) {
    for (const step of (job.steps ?? []) as any[]) {
      if (typeof step.uses !== 'string' || !step.uses.startsWith(ACTION)) {
        continue;
      }
      if (!step.with) {
        throw new Error(
          `sign-upgrade-commits: the ${ACTION} step in ${WORKFLOW} has no \`with\` block`,
        );
      }
      step.with['sign-commits'] = true;
      patched += 1;
    }
  }

  if (patched !== 1) {
    throw new Error(
      `sign-upgrade-commits: expected exactly 1 ${ACTION} step in ${WORKFLOW}, found ${patched}. ` +
        'The workflow projen generates has changed shape — re-check that upgrade PRs still commit ' +
        'with a signature before removing this assertion, because `dev` and `main` both require one.',
    );
  }

  // projen writes its generated files read-only so hand edits are obvious.
  // Same dance as harden-release-workflow: this script IS part of generation.
  const READONLY = 0o444;
  chmodSync(WORKFLOW, 0o644);
  try {
    writeFileSync(WORKFLOW, stringify(doc, { lineWidth: 0 }));
  } finally {
    chmodSync(WORKFLOW, READONLY);
  }
  console.log(`sign-upgrade-commits: ${WORKFLOW} patched`);
}
