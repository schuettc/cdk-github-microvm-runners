# justfile — the SINGLE SOURCE OF TRUTH for quality checks.
#
# `just verify` is called by BOTH the pre-push git hook (via lefthook) and CI,
# so whatever passes locally passes in CI: same recipes, and the tools resolve
# from the project's own pinned versions (pnpm / npx), not a separate
# hook-managed env. That structural sameness is the whole point — no drift.
#
# Install just:    brew install just   (or cargo install just)
#
# TS-only repo; recipes guard on the root package.json so the gate is live
# (and green) before the package is scaffolded, and real the moment it lands.

set shell := ["bash", "-euo", "pipefail", "-c"]

# Full verification — run by the pre-push hook AND by CI. No auto-fix; any
# failure fails the recipe.
#
# compile is `jsii`, which typechecks AND proves the API still projects into
# every target language, so it replaces a bare `tsc --noEmit`. lint runs inside
# projen's test task alongside jest. docs-examples and examples both come after
# compile because they read the `.jsii` assembly compile produces.
verify: projen-check format-check docs-check compile docs-examples examples lint test

# projen generates package.json, tsconfig, eslint config, and the workflows
# from .projenrc.ts. Re-synth and fail if anything it owns changed, so an
# edit to .projenrc.ts can never be committed without its generated output.
projen-check:
    #!/usr/bin/env bash
    set -euo pipefail
    npx tsx .projenrc.ts >/dev/null
    git diff --exit-code -- package.json tsconfig.json tsconfig.dev.json \
      .eslintrc.json .gitignore .npmignore .npmrc .mergify.yml \
      .github/workflows .projen \
      || { echo "projen output is stale — commit the re-synthesized files above"; exit 1; }

# The full compile chain, not `projen compile` alone. `compile` is jsii only;
# pre-compile bundles the Lambda handlers and post-compile copies those bundles
# and the in-VM agent assets next to the compiled output. Skipping either
# produces a lib/ that compiles but is missing everything a consumer needs at
# synth time — the published tarball would be broken.
compile:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm exec projen pre-compile
    pnpm exec projen compile
    pnpm exec projen post-compile

# Auto-fix formatting + lint. Used by the pre-commit hook (lefthook scopes it
# to staged files there); run bare to fix the whole tree.
fix:
    #!/usr/bin/env bash
    set -euo pipefail
    node scripts/sync-docs.mjs
    npx --yes prettier --write --ignore-unknown .
    ESLINT_USE_FLAT_CONFIG=false NODE_NO_WARNINGS=1 npx --yes eslint --ext .ts,.tsx --fix \
      --no-error-on-unmatched-pattern src test projenrc .projenrc.ts

# Rewrite the doc blocks that are deliberately repeated (see docs/_shared/).
docs-sync:
    #!/usr/bin/env bash
    set -euo pipefail
    node scripts/sync-docs.mjs

# Fail if any repeated doc block has drifted from its source in docs/_shared/.
docs-check:
    #!/usr/bin/env bash
    set -euo pipefail
    node scripts/sync-docs.mjs --check

# Type-check every TypeScript example in the docs against src/. The examples
# are what a reader copies, so one that no longer compiles is a defect —
# nothing else catches it, since a rename that sweeps src/ and the generated
# API.md leaves the hand-written examples in docs/ silently stale.
docs-examples:
    #!/usr/bin/env bash
    set -euo pipefail
    node scripts/check-doc-examples.mjs

# Compile and translate every TSDoc @example into Python. These are what
# Construct Hub renders on the Python page, and a snippet that does not
# compile silently becomes "example not available" there. Writes the tablet the
# package ships so the published translations are the ones we tested.
examples:
    #!/usr/bin/env bash
    set -euo pipefail
    npx jsii-rosetta extract --strict --cache-to .jsii.tabl.json

format-check:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f package.json ]; then npx --yes prettier --check .; fi

# eslint against projen's .eslintrc.json. Deliberately WITHOUT --fix: projen's
# own `test` task runs `eslint --fix`, which would let a gate pass by mutating
# the tree instead of failing. ESLINT_USE_FLAT_CONFIG=false selects the
# eslintrc format projen generates (eslint 9 defaults to flat config).
lint:
    #!/usr/bin/env bash
    set -euo pipefail
    ESLINT_USE_FLAT_CONFIG=false npx --yes eslint --ext .ts,.tsx \
      --no-error-on-unmatched-pattern --max-warnings=0 \
      src test projenrc .projenrc.ts

# Build the publishable tarball, install it into a throwaway project as a
# consumer would, synthesize a runner set from it, and assert the Lambda
# bundles and in-VM agent assets actually staged. Catches the class of break
# where the package compiles and imports fine but is missing the files it
# needs at deploy. Slower than the rest of the gate, so CI runs it rather than
# the pre-push hook.
smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    node scripts/consumer-smoke.mjs

# Standalone typecheck. `verify` uses `compile` (jsii) instead, which does
# this and also validates cross-language projection.
typecheck:
    #!/usr/bin/env bash
    set -euo pipefail
    npx --yes tsc --noEmit

# Coverage thresholds live in the jest config projen generates.
# jest directly rather than projen's `test` task, which also runs
# `eslint --fix`; lint above is the non-mutating check.
test:
    #!/usr/bin/env bash
    set -euo pipefail
    npx jest
