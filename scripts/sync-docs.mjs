#!/usr/bin/env node
// sync-docs — single-source the doc fragments that must stay byte-identical.
//
// Some content is deliberately repeated across docs: the lifecycle diagram
// appears in both the README and the architecture guide, because seeing it in
// both places reinforces the model rather than forcing a click. Repetition is
// fine; silent divergence is not. Each shared block lives once under
// `docs/_shared/`, and every copy is rewritten from it.
//
// A consumer marks where a fragment goes:
//
//   <!-- sync:begin lifecycle-diagram -->
//   ...rewritten from docs/_shared/lifecycle-diagram.md...
//   <!-- sync:end lifecycle-diagram -->
//
//   node scripts/sync-docs.mjs           rewrite every marked region
//   node scripts/sync-docs.mjs --check   exit 1 if any copy has drifted
//
// `just fix` runs the rewrite and `just verify` runs the check, so a stale copy
// fails the same gate as a lint error rather than reaching a reader.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sharedDir = join(root, 'docs', '_shared');
const check = process.argv.includes('--check');

const fragments = new Map();
for (const name of readdirSync(sharedDir)) {
  if (name.endsWith('.md')) {
    fragments.set(
      name.replace(/\.md$/, ''),
      readFileSync(join(sharedDir, name), 'utf8').trim(),
    );
  }
}

// Every file that may carry a marked region.
const targets = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];
for (const name of readdirSync(join(root, 'docs'))) {
  if (name.endsWith('.md')) targets.push(join('docs', name));
}

const stale = [];
let rewrote = 0;

for (const rel of targets) {
  const path = join(root, rel);
  if (!existsSync(path)) continue;
  const before = readFileSync(path, 'utf8');
  let after = before;

  after = after.replace(
    /(<!-- sync:begin ([a-z0-9-]+) -->\n)[\s\S]*?(<!-- sync:end \2 -->)/g,
    (whole, open, name, close) => {
      const body = fragments.get(name);
      if (body === undefined) {
        console.error(
          `${rel}: unknown fragment "${name}" (no docs/_shared/${name}.md)`,
        );
        process.exitCode = 1;
        return whole;
      }
      return `${open}\n${body}\n\n${close}`;
    },
  );

  if (after !== before) {
    if (check) {
      stale.push(rel);
    } else {
      writeFileSync(path, after);
      rewrote++;
      console.log(`  synced ${rel}`);
    }
  }
}

if (check) {
  if (stale.length) {
    console.error(
      `Shared doc fragments have drifted in:\n${stale.map((f) => `  ${f}`).join('\n')}\n` +
        `Run \`just docs-sync\` (or \`just fix\`) to rewrite them from docs/_shared/.`,
    );
    process.exit(1);
  }
  console.log('shared doc fragments are in sync');
} else if (rewrote === 0) {
  console.log('shared doc fragments already in sync');
}
