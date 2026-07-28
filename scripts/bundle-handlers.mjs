#!/usr/bin/env node
// Pre-bundle the four Lambda handlers and the setup CLI at PACKAGE BUILD time.
//
// The handlers replace the
// old synth-time NodejsFunction/esbuild path. Why: a jsii-published library
// is consumed from Python where the consumer has no esbuild (or Docker)
// at synth — the shipped package must carry ready-to-deploy code. Bundles
// land in src/handlers/bundled/<name>/index.js (gitignored; the `build`
// script copies them into dist/handlers/bundled/ next to the compiled
// construct, mirroring the agent-assets copy).
//
// Bundling semantics preserved from the NodejsFunction setup they replace:
//   - externalModules: [] — the AWS SDK is BUNDLED IN deliberately. The
//     NODEJS_22_X runtime's ambient SDK version drifts; ours is pinned by
//     the lockfile, and the handlers' required-member behavior
//     (idlePolicy et al.) was validated against the pinned version
//     (Runtime.ImportModuleError at first live launch, 2026-07-19, is the
//     other half of the rationale).
//   - CJS output (NodejsFunction's default for this setup; no handler uses
//     import.meta), target node22, platform node, ARM-safe (no native deps).
//
// The setup CLI is bundled for the same reason the handlers are: it imports
// @aws-sdk/client-cloudformation and @aws-sdk/client-secrets-manager, both
// devDependencies, and the published package carries no runtime dependencies
// beyond its peers. Unbundled it would install cleanly and fail on first use.
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HANDLERS = ['webhook', 'launcher', 'janitor', 'warm-pool'];

for (const name of HANDLERS) {
  const outdir = join(ROOT, 'src', 'handlers', 'bundled', name);
  mkdirSync(outdir, { recursive: true });
  buildSync({
    entryPoints: [join(ROOT, 'src', 'handlers', `${name}.ts`)],
    outfile: join(outdir, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: [],
    minify: false,
    sourcemap: false,
    logLevel: 'error',
  });
}
console.log(`bundled ${HANDLERS.length} handlers -> src/handlers/bundled/`);

// The setup CLI, shipped as the package's `bin`. ESM output because the source
// is ESM and reads import.meta.url to tell "run as a program" from "imported by
// a test"; esbuild carries the source's own shebang through, so no banner here
// (a banner would emit a second one).
const cliDir = join(ROOT, 'src', 'cli', 'bundled');
mkdirSync(cliDir, { recursive: true });
buildSync({
  entryPoints: [join(ROOT, 'scripts', 'setup-github-app.mjs')],
  outfile: join(cliDir, 'setup.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: [],
  minify: false,
  sourcemap: false,
  logLevel: 'error',
});

// The package as a whole is CommonJS (no `type` field — the jsii/CDK default),
// so node would read an ESM lib/cli/setup.js as CJS. It survives on node 22 by
// re-parsing when it sees module syntax, but warns about it on every run. This
// one-line package.json scopes just this directory to ESM, which is what the
// bundle is. Written beside the bundle so the post-compile copy takes it along.
writeFileSync(
  join(cliDir, 'package.json'),
  `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
);
console.log('bundled the setup CLI -> src/cli/bundled/setup.js');
