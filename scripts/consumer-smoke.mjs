#!/usr/bin/env node
// Builds the publishable npm tarball, installs it into a throwaway project the
// way a consumer would, synthesizes a runner set from it, and asserts the
// result is deployable.
//
// This exists because compiling is not the same as publishing. `jsii` alone
// produces a lib/ that type-checks and imports cleanly while missing the Lambda
// bundles and the in-VM agent assets — the copy steps live in post-compile. A
// package in that state installs, imports, and synthesizes a template whose
// assets are empty, and only fails at deploy. Nothing else in the gate catches
// that, because everything else runs against the source tree, where those files
// are present regardless.
//
// Run: node scripts/consumer-smoke.mjs   (or `just smoke`)

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.cwd();
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });

function fail(msg) {
  console.error(`\n  FAIL: ${msg}\n`);
  process.exit(1);
}

console.log('  building the publishable tarball...');
// The full chain. `compile` alone is jsii; pre-compile bundles the handlers and
// post-compile copies them and the agent assets next to the compiled output.
for (const task of ['pre-compile', 'compile', 'post-compile', 'package:js']) {
  try {
    run('pnpm', ['exec', 'projen', task], { cwd: repo });
  } catch (err) {
    fail(`projen ${task} failed:\n${err.stdout ?? ''}${err.stderr ?? ''}`);
  }
}

const distJs = join(repo, 'dist', 'js');
const tarball = (await readdir(distJs)).find((f) => f.endsWith('.tgz'));
if (!tarball) fail(`no tarball produced in ${distJs}`);
const tarballPath = join(distJs, tarball);

// The tarball must carry the runtime pieces, not just compiled JS.
const entries = run('tar', ['tzf', tarballPath]).split('\n');
const required = [
  'package/lib/index.js',
  'package/lib/handlers/bundled/launcher/index.js',
  'package/lib/handlers/bundled/janitor/index.js',
  'package/lib/handlers/bundled/webhook/index.js',
  'package/lib/handlers/bundled/warm-pool/index.js',
  'package/lib/image/assets/agent.mjs',
  'package/lib/image/assets/entrypoint.sh',
  'package/.jsii',
  // Rosetta's translation tablet, written by `just examples`. Construct Hub
  // renders the Python samples from it, so shipping it is what makes the
  // published translations the ones the example gate compiled.
  'package/.jsii.tabl.json',
  // The setup CLI, shipped as the package's `bin`. The package.json beside it
  // marks that directory ESM, which is what the bundle is — without it node
  // reads the file as CommonJS.
  'package/lib/cli/setup.js',
  'package/lib/cli/package.json',
];
const missing = required.filter((r) => !entries.includes(r));
if (missing.length) fail(`tarball is missing:\n    ${missing.join('\n    ')}`);
console.log(`  tarball carries all ${required.length} required paths`);

const work = mkdtempSync(join(tmpdir(), 'ghmr-consumer-'));
try {
  console.log('  installing into a clean project...');
  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify(
      { name: 'consumer-smoke', version: '1.0.0', private: true },
      null,
      2,
    ),
  );
  const peers = JSON.parse(
    readFileSync(join(repo, 'package.json'), 'utf8'),
  ).peerDependencies;
  try {
    run(
      'npm',
      [
        'install',
        '--silent',
        '--no-audit',
        '--no-fund',
        tarballPath,
        `aws-cdk-lib@${peers['aws-cdk-lib'].replace(/^\^/, '')}`,
        'constructs@10.5.1',
        'tsx@4',
      ],
      { cwd: work },
    );
  } catch (err) {
    fail(
      `npm install of the tarball failed:\n${err.stdout ?? ''}${err.stderr ?? ''}`,
    );
  }

  // Being in the tarball is not the same as running. The CLI imports two AWS
  // SDK clients that are devDependencies here and absent from a consumer's
  // install, so an unbundled copy would sit in lib/ and throw on first use.
  console.log('  running the setup CLI from the installed package...');
  try {
    const help = run('npx', ['cdk-github-microvm-runners', 'setup', '--help'], {
      cwd: work,
    });
    if (!/--org/.test(help) || !/--account/.test(help)) {
      fail('the installed setup CLI does not document --org and --account');
    }
  } catch (err) {
    fail(
      `the installed setup CLI failed to run:\n${err.stdout ?? ''}${err.stderr ?? ''}`,
    );
  }
  console.log('  setup CLI runs from the installed package');

  // A consumer's stack, written against the public API only.
  writeFileSync(
    join(work, 'app.ts'),
    `import { App, CfnOutput, Stack } from 'aws-cdk-lib';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import {
  GithubMicrovmRunners, GithubAppId, GithubAppKey, GithubAuth,
  RunnerScope, MicrovmSize,
} from 'cdk-github-microvm-runners';

const app = new App({ outdir: 'cdk.out' });
const stack = new Stack(app, 'Runners', { env: { region: 'us-east-1' } });
const sec = (id: string, name: string) => Secret.fromSecretNameV2(stack, id, name);

const runners = new GithubMicrovmRunners(stack, 'Runners', {
  github: GithubAuth.app({
    appId: GithubAppId.fromSecret(sec('AppId', 'p/app-id')),
    privateKey: GithubAppKey.fromSecret(sec('AppKey', 'p/app-private-key')),
    webhookSecret: sec('WebhookSecret', 'p/webhook-secret'),
  }),
  scope: RunnerScope.org('my-org'),
});
runners.addRunnerClass('microvm', { size: MicrovmSize.GB4 });
new CfnOutput(stack, 'WebhookUrl', { value: runners.webhookUrl });
app.synth();
`,
  );

  console.log('  synthesizing a runner set from the installed package...');
  try {
    run('npx', ['tsx', 'app.ts'], { cwd: work });
  } catch (err) {
    fail(`consumer synth failed:\n${err.stdout ?? ''}${err.stderr ?? ''}`);
  }

  const out = join(work, 'cdk.out');
  const template = JSON.parse(
    readFileSync(join(out, 'Runners.template.json'), 'utf8'),
  );
  const types = Object.values(template.Resources).map((r) => r.Type);
  for (const t of [
    'AWS::Lambda::Function',
    'AWS::Lambda::MicrovmImage',
    'AWS::SQS::Queue',
    'AWS::DynamoDB::Table',
    'AWS::Lambda::Url',
  ]) {
    if (!types.includes(t)) fail(`synthesized template has no ${t}`);
  }
  console.log(
    `  template has ${types.length} resources, all expected types present`,
  );

  // The assets are the part that silently breaks: a template can reference an
  // asset directory that was staged empty.
  const assets = (await readdir(out)).filter((d) => d.startsWith('asset.'));
  const handlerBundles = assets.filter((a) =>
    existsSync(join(out, a, 'index.js')),
  );
  if (handlerBundles.length < 3) {
    fail(
      `expected at least 3 staged handler bundles, found ${handlerBundles.length}`,
    );
  }
  for (const b of handlerBundles) {
    const bytes = readFileSync(join(out, b, 'index.js')).length;
    if (bytes < 100_000)
      fail(`handler bundle ${b} is only ${bytes} bytes — not a real bundle`);
  }

  const imageCtx = assets.find((a) => existsSync(join(out, a, 'Dockerfile')));
  if (!imageCtx) fail('no image build context was staged');
  for (const f of [
    'microvm-runner/agent.mjs',
    'microvm-runner/entrypoint.sh',
  ]) {
    if (!existsSync(join(out, imageCtx, f))) {
      fail(
        `image build context is missing ${f} — the image would build without an agent`,
      );
    }
  }
  console.log(
    `  ${handlerBundles.length} handler bundles staged, image context carries the agent`,
  );
  console.log('\n  consumer smoke test PASSED\n');
} finally {
  rmSync(work, { recursive: true, force: true });
}
