#!/usr/bin/env node
// check-doc-examples — type-checks every TypeScript example in the docs
// against the library's own source, with the project's strict settings.
//
// The examples are the part of the documentation a reader copies, so an
// example that no longer compiles is a defect the same way a broken function
// is. Nothing else catches it: prose is not compiled, and a rename that
// sweeps src/ and the generated API.md leaves the hand-written examples in
// docs/ silently stale.
//
// Each fence is extracted, given rosetta/default.ts-fixture for the
// surroundings the prose implies, and compiled by tsc against src/. That is
// the same fixture jsii-rosetta splices the TSDoc @example blocks into, so the
// guide examples and the API examples agree about what a snippet may assume.
//
// Fences are read as one of two shapes:
//
//   ```ts                              statements — wrapped in a function
//   ```ts fragment=RunnerClassProps    properties of a struct literal
//
// The `fragment=` form is for the excerpts that show two or three properties
// of an options object rather than a whole call. Name the struct they belong
// to and they are checked against it, including that no property is misspelled
// — the struct's other required properties are filled in automatically.
// GitHub uses only the first word of an info string for highlighting, so the
// annotation is invisible in the rendered page.
//
// Run: node scripts/check-doc-examples.mjs   (or `just docs-examples`)

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = join(repo, '.doc-examples-check');

/** Each struct the library exports, with the properties it requires. */
function publicSurface() {
  const assembly = JSON.parse(readFileSync(join(repo, '.jsii'), 'utf8'));
  const structs = new Map();
  for (const type of Object.values(assembly.types)) {
    if (type.assembly !== assembly.name || !type.datatype) continue;
    structs.set(
      type.name,
      (type.properties ?? []).filter((p) => !p.optional).map((p) => p.name),
    );
  }
  return { structs };
}

/** Every ```ts fence in the docs, with where it came from. */
function extractExamples() {
  const files = [
    ...readdirSync(join(repo, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => `docs/${f}`),
    'README.md',
  ].sort();
  const found = [];
  for (const file of files) {
    const lines = readFileSync(join(repo, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].trim();
      if (!/^```(ts|typescript)\b/.test(open)) continue;
      let end = i + 1;
      while (end < lines.length && !lines[end].trim().startsWith('```')) end++;
      const fragmentOf = open.match(/\bfragment=(\w+)/)?.[1];
      found.push({
        file,
        line: i + 2, // first line of the example, 1-indexed
        body: lines.slice(i + 1, end),
        fragmentOf,
      });
      i = end;
    }
  }
  return found;
}

const IMPORT = /^import (?:\* as (\w+)|\{([^}]*)\}|(\w+)) from '([^']+)';/;

/** Names an import statement binds, or null if the line is not an import. */
function boundNames(line) {
  const m = line.trim().match(IMPORT);
  if (!m) return null;
  if (m[1]) return [m[1]];
  if (m[3]) return [m[3]];
  return m[2]
    .split(',')
    .map((n) =>
      n
        .trim()
        .split(/\s+as\s+/)
        .pop(),
    )
    .filter(Boolean);
}

const { structs } = publicSurface();

// The same fixture jsii-rosetta uses. Everything above the marker is the
// ambient context; nothing below it is ours to keep.
const MARKER = '/// here';
const fixture = readFileSync(
  join(repo, 'rosetta', 'default.ts-fixture'),
  'utf8',
).replace(/from 'cdk-github-microvm-runners'/g, "from '../src'");
const markerAt = fixture.split('\n').findIndex((l) => l.trim() === MARKER);
if (markerAt < 0) {
  console.error(`\n  rosetta/default.ts-fixture has no "${MARKER}" marker\n`);
  process.exit(1);
}
const preamble = fixture.split('\n').slice(0, markerAt);
const examples = extractExamples();

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const errors = [];
const written = [];

for (const [index, ex] of examples.entries()) {
  const stem = `example-${String(index).padStart(2, '0')}`;
  const own = ex.body.filter((l) => boundNames(l));
  let source;

  if (ex.body.some((l) => l.includes('cdk-github-microvm-runners'))) {
    // A whole program — it carries its own imports; only the module specifier
    // differs from what a consumer writes.
    source = ex.body
      .join('\n')
      .replace(/from 'cdk-github-microvm-runners'/g, "from '../src'");
  } else {
    // An excerpt. Give it the preamble, minus any import the excerpt makes
    // itself, so the excerpt's own imports win.
    const claimed = new Set(own.flatMap((l) => boundNames(l)));
    const head = [
      ...preamble.filter((l) => {
        const names = boundNames(l);
        return !names || !names.some((n) => claimed.has(n));
      }),
      ...own,
    ].join('\n');
    const rest = ex.body.filter((l) => !boundNames(l)).join('\n');

    if (ex.fragmentOf) {
      const required = structs.get(ex.fragmentOf);
      if (!required) {
        errors.push(
          `${ex.file}:${ex.line}  fragment=${ex.fragmentOf} names no struct in the public API`,
        );
        continue;
      }
      // Fill in the struct's other required properties; `undefined!` types as
      // never, so it stands in for any of them without weakening the check on
      // the properties the example actually shows.
      const shown = new Set(
        [...rest.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]),
      );
      const filler = required
        .filter((p) => !shown.has(p))
        .map((p) => `  ${p}: undefined!,`)
        .join('\n');
      source = `${head}\nexport const _fragment: ${ex.fragmentOf} = {\n${filler}\n${rest}\n};\n`;
    } else {
      source = `${head}\nexport function _example() {\n${rest}\n}\n`;
    }
  }

  writeFileSync(join(workDir, `${stem}.ts`), `${source}\n`);
  written.push({ stem, ...ex });
}

writeFileSync(
  join(workDir, 'tsconfig.json'),
  `${JSON.stringify(
    {
      extends: '../tsconfig.json',
      compilerOptions: {
        rootDir: '..',
        noEmit: true,
        noEmitOnError: false,
        // An excerpt does not use everything the preamble hands it.
        noUnusedLocals: false,
        noUnusedParameters: false,
      },
      include: ['*.ts', '../src/**/*.ts'],
      exclude: [],
    },
    null,
    2,
  )}\n`,
);

let output = '';
try {
  execFileSync('npx', ['tsc', '-p', join(workDir, 'tsconfig.json')], {
    cwd: repo,
    encoding: 'utf8',
    stdio: 'pipe',
  });
} catch (err) {
  output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
}

// Report against the doc the example came from, not the generated file.
for (const line of output.split('\n')) {
  const m = line.match(
    /^\.doc-examples-check\/(example-\d+)\.ts\((\d+),\d+\): (.*)$/,
  );
  if (!m) {
    if (line.trim() && !line.startsWith('npm warn')) errors.push(line);
    continue;
  }
  const ex = written.find((w) => w.stem === m[1]);
  errors.push(`${ex.file}:${ex.line}  ${m[3]}`);
}

if (errors.length) {
  console.error(
    `\n  ${errors.length} problem(s) in the documentation examples:\n`,
  );
  for (const e of errors) console.error(`    ${e}`);
  console.error(
    `\n  Generated sources left in ${workDir} for inspection.\n` +
      '  A name the prose establishes but the example does not show belongs in\n' +
      '  rosetta/default.ts-fixture.\n',
  );
  process.exit(1);
}

rmSync(workDir, { recursive: true, force: true });
console.log(
  `  ${written.length} documentation examples type-check against src/`,
);
