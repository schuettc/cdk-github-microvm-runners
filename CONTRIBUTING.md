# Contributing

## Branch model

<!-- sync:begin branch-model -->

Feature pull requests target `dev`, which is promoted to `main` by pull
request.

<!-- sync:end branch-model -->

CI runs on pull requests into either branch and on pushes to them. It runs
`just verify` — the same recipe the local git hooks run, so a passing local
check matches CI — and then builds the npm tarball.

## Local setup

Checks are driven by `just`, git hooks by `lefthook`, and dependencies by
`pnpm`.

```bash
brew install just lefthook
pnpm install
lefthook install
just verify
```

`lefthook install` writes the pre-commit and pre-push hooks into the clone, and
`just verify` runs six checks in order: a drift check on the files
`.projenrc.ts` generates, format-check, a drift check on the doc blocks that
are repeated across files (see `docs/_shared/`), the jsii compile, lint, and
the test suite with coverage. The jsii compile typechecks the source and also
proves the public API still projects into every language the package publishes
to, so it covers what a bare `tsc --noEmit` would.

To build outside the gate, `npx projen compile` compiles the package to `lib/`.
`npx projen build` runs the whole pipeline — compile, then `API.md` regenerated
from the doc comments, then the tests, then packaging for every target
language, which needs a Python toolchain on the machine.

`just verify` is the single source of truth for whether a change is green. The
pre-commit hook runs the auto-fixers and the fast static scans on staged
files, and the pre-push hook runs the full `just verify`. When a check fires,
fix the issue or write a per-finding suppression with an inline rationale. The
hooks run on every commit and push — `--no-verify` and `LEFTHOOK=0` are not
part of the workflow.

## Generated files

`.projenrc.ts` is where `package.json`, `tsconfig.json`, `.eslintrc.json`, and
the GitHub Actions workflows come from. Change one of those by editing
`.projenrc.ts` and running `npx projen`, which rewrites them from it. An edit
made straight to a generated file is undone by the next synth, and the projen
check in `just verify` fails on a tree whose generated files no longer match
`.projenrc.ts`.

## Tests

The test suite runs on Jest and lives under `test/`; `just test` runs it.
Construct tests assert on the synthesized CloudFormation template — resources,
environment variables, and IAM — while handler tests use
`aws-sdk-client-mock`. New behavior needs a test, and a correctness fix needs a
regression test that fails before the fix is applied.

## Style

Match the naming, comment density, and idioms of the surrounding code. The
package publishes to TypeScript and Python, but the public API is jsii-clean
against everything jsii can project, not just those two — the constraint is
what keeps adding a language a configuration change rather than a redesign.
Public signatures stay within what jsii can project into any target
language, using enum-like classes and interfaces of `readonly` properties in
place of union types, generics, and callbacks. An instance property also
cannot share a name with a static factory on the same class, which is why
`RunnerScope.org()` returns an instance carrying `organization`. Every
public member carries a doc comment with `@default` where relevant, and a new
knob is expressed as an optional property with a conservative default rather
than a separate variant.

## Documentation

`docs/` and the doc comments in `src/` are held to the same standard, since
both are read by consumers — the doc comments become `API.md`, the generated
API reference, in every language the package publishes to.

- Start high level and work down to the details, either further down a page or
  in a separate doc.
- Define a term before anything leans on it, and link a doc on first mention
  only. Do not link backwards: a page should stand on its own rather than send
  a reader elsewhere for its own central point.
- Show it. A code example carries more than a paragraph describing one, and
  examples are checked against the real API before they land.
- State what something does and what the options are. Documenting a default
  does not require arguing for it, and a reader does not need the failure mode
  a design avoids.
- Write plainly and in connected prose. Avoid coined vocabulary where an
  ordinary word works, and refer to the platform as AWS Lambda MicroVMs.

## Pull requests

Keep pull requests small and focused, with a clear description of what changed
and why. CI must be green before a pull request is merged.
