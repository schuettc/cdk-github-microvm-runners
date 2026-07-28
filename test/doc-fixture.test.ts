import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = join(__dirname, '..', 'rosetta', 'default.ts-fixture');

describe('rosetta fixture', () => {
  it('exists and carries exactly one top-level `/// here` marker', () => {
    const lines = readFileSync(FIXTURE, 'utf8').split('\n');
    const markers = lines.filter((l) => l.trim() === '/// here');
    expect(markers).toHaveLength(1);
  });

  it('declares the ambient names the guides and API examples rely on', () => {
    const src = readFileSync(FIXTURE, 'utf8');
    for (const name of [
      'runners',
      'stack',
      'app',
      'role',
      'vpc',
      'logGroup',
      'image',
    ]) {
      expect(src).toMatch(new RegExp(`declare const ${name}\\b`));
    }
  });

  // jsii-rosetta compiles each snippet without node's type definitions, so a
  // node builtin imported here fails every API example at once with TS2580.
  // An example that needs one imports it in its own fence, which also shows
  // the reader the import they need.
  it('imports no node builtins', () => {
    const src = readFileSync(FIXTURE, 'utf8');
    expect(src).not.toMatch(/^import .* from '(path|fs|os|crypto|url)';$/m);
  });
});

describe('README samples', () => {
  // The fixture declares app, stack, and runners for the excerpts. A sample
  // that builds those itself is a complete program, and splicing it into the
  // fixture redeclares them — TS2451. rosetta's `nofixture` opts out.
  it('mark complete programs as nofixture', () => {
    const readme = readFileSync(
      join(__dirname, '..', 'README.md'),
      'utf8',
    ).split('\n');

    for (const [i, line] of readme.entries()) {
      if (!/^```(ts|typescript)\b/.test(line.trim())) continue;
      let end = i + 1;
      while (end < readme.length && !readme[end].trim().startsWith('```')) {
        end++;
      }
      const body = readme.slice(i + 1, end).join('\n');

      const buildsItsOwnStack = /\bconst (app|stack|runners)\s*=/.test(body);
      if (buildsItsOwnStack) {
        expect(line).toContain('nofixture');
      }
    }
  });
});
