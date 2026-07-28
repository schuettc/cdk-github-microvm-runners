import { awscdk, javascript, JsonFile } from 'projen';
import { ReleaseTrigger } from 'projen/lib/release';
import { hardenReleaseWorkflow } from './projenrc/harden-release-workflow';

const project = new awscdk.AwsCdkConstructLibrary({
  name: 'cdk-github-microvm-runners',
  description:
    'CDK construct for running GitHub Actions jobs on AWS Lambda MicroVMs, with one ephemeral runner per job.',
  author: 'Court Schuett',
  authorAddress: 'https://github.com/schuettc',
  repositoryUrl: 'https://github.com/schuettc/cdk-github-microvm-runners.git',
  // The documentation site. Construct Hub and the registries link to this from
  // the package sidebar, which is the shortest path from a package listing to
  // the guides.
  homepage: 'https://runnerset.dev',
  license: 'Apache-2.0',
  defaultReleaseBranch: 'main',
  keywords: [
    'cdk',
    'awscdk',
    'aws-cdk',
    'aws',
    'github',
    'github-actions',
    'self-hosted-runners',
    'actions-runner',
    'lambda',
    'microvm',
    'ephemeral-runners',
    'ci-cd',
  ],

  packageManager: javascript.NodePackageManager.PNPM,
  projenrcTs: true,
  prettier: true,
  prettierOptions: {
    settings: {
      singleQuote: true,
      trailingComma: javascript.TrailingComma.ALL,
    },
  },

  cdkVersion: '2.261.0',
  jsiiVersion: '~6.0.0',
  typescriptVersion: '~6.0.3',

  // TypeScript and Python. jsii can also project .NET and Java; those are
  // deliberately not enabled — each adds a publishing credential, a toolchain
  // in CI, and a package namespace to maintain, for languages this library has
  // no audience in yet. Adding one later is a projenrc change plus its
  // registry credentials.
  //
  // Go is excluded for a different reason, and the distinction matters if
  // anyone revisits this. npm and PyPI host artifacts, so publishing to them
  // needs only a credential. Go has no artifact registry: `go get` resolves an
  // import path to a VCS repo and fetches source, so a Go target must COMMIT
  // its generated module to some git repo. jsii's Go binding is a shim over
  // the compiled JavaScript, which it carries as an embedded ~1.1 MB gzip
  // tarball — publishing here would add that blob to this repo's history on
  // every release, permanently and publicly, and publib pushes it straight to
  // the branch, around the PRs-only gate. The alternative is a second repo
  // that exists only to receive generated code. Neither was worth a Go
  // audience we don't have. Re-enabling means `publishToGo` plus that repo.
  publishToPypi: {
    distName: 'cdk-github-microvm-runners',
    module: 'cdk_github_microvm_runners',
  },

  // Handlers use @aws-sdk clients and ship PRE-BUNDLED (esbuild, all SDK
  // inlined) — they are not part of the public jsii API and must stay out
  // of jsii's compilation closure.
  excludeTypescript: ['src/handlers/**'],

  // The PR-title gate's allowlist defaulted to feat/fix/chore, which forbids
  // the type this repository uses MOST. Measured across main's history:
  // 42 docs, 41 feat, 28 fix, 14 chore, 13 refactor, 6 test, 5 build, 2 ci,
  // 1 perf — so the default covered 83 of 152 commits and would reject the
  // majority of PR titles. It went unnoticed because the workflow only began
  // running recently; earlier `docs:` PRs merged without it.
  //
  // The list below is the conventional-commits set this repository actually
  // uses. Only feat and fix affect the version; the rest are descriptive.
  githubOptions: {
    pullRequestLintOptions: {
      semanticTitleOptions: {
        types: [
          'feat',
          'fix',
          'chore',
          'docs',
          'refactor',
          'test',
          'build',
          'ci',
          'perf',
        ],
      },
    },
  },

  // vitest is gone — the suite runs on projen's jest.
  devDeps: [
    // Used by projenrc/harden-release-workflow.ts to patch the generated
    // release workflow as part of synthesis.
    'yaml',
    '@aws-sdk/client-cloudformation',
    '@aws-sdk/client-dynamodb',
    '@aws-sdk/client-kms',
    '@aws-sdk/client-lambda-microvms',
    '@aws-sdk/client-secrets-manager',
    '@aws-sdk/client-sqs',
    '@aws-sdk/client-ssm',
    '@aws-sdk/util-dynamodb',
    '@types/aws-lambda',
    'aws-sdk-client-mock',
    'esbuild',
    'undici',
    'tsx',
    // Pinned to a full version rather than left at projen's bare major range.
    // skylos' dependency check cannot resolve `^12` / `^17` for these two
    // specifically (it resolves every other bare major in this file) and
    // reports them as versions that do not exist; they are installed and
    // published. A precise range is true either way.
    'commit-and-tag-version@^12.7.3',
  ],

  // jsii sets `module: node16` and leaves `moduleResolution` unset, which
  // TypeScript infers correctly — but tools that read the field rather than
  // infer it (fallow's dead-code analysis) then cannot resolve this source's
  // NodeNext `.js`-extension imports, and report every file downstream of
  // index.ts as unreachable. Stating the implied value fixes them and changes
  // nothing for tsc.
  tsconfig: {
    compilerOptions: {
      moduleResolution: javascript.TypeScriptModuleResolution.NODE16,
    },
  },

  jestOptions: {
    jestConfig: {
      // Source uses NodeNext `.js`-extension imports; strip the extension so
      // ts-jest's resolver finds the `.ts` next to it.
      moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
    },
  },

  // `just verify` is this repo's single gate — the pre-push hook and CI run
  // the same recipe, which is what keeps them from drifting. It invokes
  // projen's own compile/test tasks, so a second projen-generated build
  // workflow would be a second, differently-shaped gate. The release workflow
  // is self-contained and unaffected.
  buildWorkflow: false,

  // Releases are cut by hand while the package is still being worked through.
  // projen's default fires the release on every push to `main`, which would
  // tag and cut a GitHub Release on the first `dev` → `main` merge — and the
  // publish jobs run in parallel with it rather than gating it, so a missing
  // credential leaves a released tag with nothing published behind it.
  //
  // workflowDispatch keeps the whole release pipeline in CI, credentials and
  // all, and only removes the automatic trigger: a release happens when
  // someone runs the workflow, and merging to `main` does nothing. Switch back
  // to ReleaseTrigger.continuous() when a merge to `main` should mean
  // "ship this".
  releaseTrigger: ReleaseTrigger.workflowDispatch(),
});

// jest-junit's spec is owned by projen's jest feature, so it has to be
// overridden after construction rather than through devDeps. Same reason as
// the pin above: skylos cannot resolve the bare `^17`.
project.addDevDeps('jest-junit@^17.0.0');

// ts-node 10 cannot load TypeScript 6 (ts.sys is undefined under its
// compiler shim); run the projenrc through tsx instead.
project.defaultTask?.reset('tsx .projenrc.ts');

// Keep prettier off projen-generated / machine-written files so
// `prettier --check .` (the justfile format-check gate) sees only authored
// code.
for (const pattern of [
  '.eslintrc.json',
  '.github/',
  '.mergify.yml',
  '.projen/',
  'API.md',
  'pnpm-lock.yaml',
  'tsconfig.json',
  '**/tsconfig.json',
  // The docs site's build output and its own lockfile. Prettier does not read
  // .gitignore, so the generated HTML under site/dist/ would otherwise fail
  // the format gate on the first build.
  'site/dist/',
  'site/.astro/',
  'site/pnpm-lock.yaml',
  // The site's API page: API.md with frontmatter prepended, rewritten on every
  // build by site/scripts/generate-api-page.mjs. API.md is ignored above for
  // the same reason — jsii-docgen writes it, not us.
  'site/src/content/docs/api.md',
  // Per-developer Claude Code settings, never committed. This one is worth
  // spelling out because the usual reasoning does not reach it: the file is
  // git-ignored, but frequently through a developer's GLOBAL gitignore
  // (~/.config/git/ignore), which prettier cannot see even in principle. So it
  // is invisible to git and visible to `prettier --check .`, and an unformatted
  // local file fails the format gate — which, because the gate runs on
  // pre-push, blocks pushes that touch no files at all, branch deletions
  // included. Only the local settings file is ignored; the tracked
  // .claude/skills/** are authored content and stay formatted.
  '.claude/settings.local.json',
]) {
  project.prettier?.addIgnorePattern(pattern);
}

// NOTE: no `type: module`. The package compiles and ships as CommonJS, the
// jsii/CDK ecosystem default — `import.meta` does not exist there, so the two
// module-relative paths resolve through `__dirname`. The source's
// `.js`-extension imports compile to CJS fine.

// Handlers ship pre-bundled at package build time (jsii consumers have no
// esbuild at synth). Bundles land in src/handlers/bundled/ (gitignored),
// then get copied next to the compiled construct in lib/.
project.preCompileTask.exec('node scripts/bundle-handlers.mjs');
project.postCompileTask.exec(
  'mkdir -p lib/image/assets && cp src/image/assets/agent.mjs src/image/assets/entrypoint.sh lib/image/assets/',
);
project.postCompileTask.exec(
  'mkdir -p lib/handlers && cp -R src/handlers/bundled lib/handlers/',
);
project.gitignore.exclude('src/handlers/bundled/');

// The setup CLI ships as this package's `bin`, so a consumer in any of the
// three languages creates their GitHub App with `npx cdk-github-microvm-runners
// setup` and never needs a clone. Same build shape as the handlers: bundled at
// pre-compile into src/cli/bundled/ (gitignored), then copied next to the
// compiled output. The package.json beside it marks that one directory ESM,
// which is what the bundle is; the package as a whole stays CommonJS.
project.postCompileTask.exec(
  'mkdir -p lib/cli && cp src/cli/bundled/setup.js src/cli/bundled/package.json lib/cli/ && chmod +x lib/cli/setup.js',
);
project.package.addField('bin', {
  'cdk-github-microvm-runners': 'lib/cli/setup.js',
});
project.gitignore.exclude('src/cli/bundled/');

// The translation tablet is compiled output too, and the package ships it, so
// it is built by the compile chain rather than by the gate that checks it.
// Without this the tablet only existed as a side effect of `just examples`,
// and `just smoke` on a clean checkout produced a tarball missing it — the
// exact class of "works here, broken when published" the smoke test exists to
// catch. Not --strict here: failing an example is the gate's job, and a
// compile that cannot produce a tablet should still produce a package.
project.postCompileTask.exec(
  'npx jsii-rosetta extract --cache-to .jsii.tabl.json',
);

// Everything else this repo must not track. projen REGENERATES .gitignore on
// every synth, so any entry not declared here disappears — these are declared
// rather than hand-edited for that reason.
project.gitignore.exclude(
  // Internal working docs. The repo goes public and history is forever;
  // these must never be committable (see CLAUDE.md).
  'docs/designs/',
  'docs/blog/',
  '.superpowers/',
  // Local-only deploy rigs (bench, dogfood, smoke tests) that carry account
  // detail and are not part of the published package.
  'examples/',
  // The docs site is a separate pnpm project under site/; its dependency tree
  // and build output are not part of the library.
  'site/node_modules/',
  'site/dist/',
  'site/.astro/',
  // The site's API reference page. site/scripts/generate-api-page.mjs writes it
  // from the repository root's API.md on every build, so the tracked copy of
  // that content stays API.md alone.
  'site/src/content/docs/api.md',
  // Build and tool output.
  'dist/',
  'coverage/',
  'cdk.out/',
  // Anchored at the root AND anywhere below it: the scanner writes its cache
  // next to whichever directory it was invoked from, so running a hook that
  // touches site/ leaves a second one there.
  '.skylos/cache/',
  '**/.skylos/cache/',
  // Where `just docs-examples` stages the doc examples it type-checks. Left
  // behind only when the check fails, so the failure can be inspected.
  '.doc-examples-check/',
  // jsii-rosetta's translation tablet. `extract` writes it next to the
  // assembly whether or not it was asked to, so it turns up after any run of
  // the example gate. Build output: regenerated on demand and shipped in the
  // tarball, never tracked.
  '.jsii.tabl.json',
  // OS noise.
  '.DS_Store',
);

// jsii needs a flat node_modules under pnpm.
project.npmrc.addConfig('node-linker', 'hoisted');

// pnpm's hoisted linker leaves dangling nested `.bin/tsc`/`.bin/tsserver`
// symlinks under jsii/jsii-rosetta; jsii-pacmak's bundle step ENOENTs on
// them. Prune broken symlinks before packaging.
project.packageTask.prependExec(
  "find node_modules -type l ! -exec test -e {} ';' -delete 2>/dev/null || true",
);

// Publish allowlist: the compiled lib (incl. bundled handlers + image assets),
// the jsii assembly, and rosetta's translation tablet — shipping the tablet is
// what makes Construct Hub render the Python samples the example gate
// checked rather than recomputing them. Also keeps `pnpm pack` from traversing
// node_modules, where the hoisted linker leaves dangling nested .bin symlinks
// that break it.
project.package.addField('files', ['lib', '.jsii', '.jsii.tabl.json']);

// The handlers are excluded from the jsii tsconfig (excludeTypescript above),
// so typescript-eslint's project service would find them in no project. Give
// them their own tsconfig (nearest-wins discovery); type-check only, no emit.
new JsonFile(project, 'src/handlers/tsconfig.json', {
  obj: {
    extends: '../../tsconfig.json',
    compilerOptions: { noEmit: true, rootDir: '../..' },
    include: ['**/*.ts'],
    exclude: ['node_modules', 'bundled'],
  },
});

// .projenrc.ts belongs to no tsconfig, so the project service would otherwise
// refuse to parse it. The ambient context for the doc examples now lives in
// rosetta/default.ts-fixture, which eslint never sees — it is not a .ts file.
project
  .tryFindObjectFile('.eslintrc.json')
  ?.addOverride('parserOptions.projectService.allowDefaultProject', [
    '.projenrc.ts',
  ]);

// The @aws-sdk clients are devDependencies BY DESIGN: they are esbuild-inlined
// into the handler bundles, and the published jsii package carries zero
// runtime deps beyond the peers.
project.eslint?.allowDevDeps('src/handlers/**');

// Tests re-create module-level fixtures (`stack`, `runners`, `launcherEnv`)
// inside individual `it` blocks on purpose; shadowing there is idiomatic, not
// a hazard.
project.eslint?.addOverride({
  files: ['test/**'],
  rules: { '@typescript-eslint/no-shadow': 'off' },
});

// The docs site under site/ is a separate pnpm project with its own tsconfig
// and its own module graph — its content config imports Astro's `astro:content`
// virtual module, which this config's resolver cannot see and reports as
// unresolved. `just lint` already scopes eslint to src, test, projenrc, and
// .projenrc.ts; this makes the same scope hold for the pre-commit hook, which
// lints whatever is staged.
project.eslint?.addIgnorePattern('site/');

project.synth();

// Two hardening edits to the generated release workflow that no projen option
// reaches: pinning publib, which runs inside the job holding the publishing
// credentials, and refusing a dispatch from any branch but main.
//
// AFTER synth(), and deliberately here rather than as a task step: the
// `projen-check` gate runs `tsx .projenrc.ts` directly rather than the projen
// task, so a step chained onto that task would never run on the gate's path
// and every check would report the committed workflow as stale. Running it as
// part of synthesis means every route that synthesizes — the task, the gate,
// CI — produces the same bytes.
hardenReleaseWorkflow();
