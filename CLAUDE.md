# cdk-github-microvm-runners

A CDK construct library. It deploys **runner sets**: GitHub Actions jobs run on
AWS Lambda MicroVMs, one ephemeral single-use VM per job, in the consumer's own
AWS account.

Published from one source by jsii to npm and PyPI.

## Read the guides before answering from the code

`docs/` is authoritative and current — it is type-checked against `src/` on
every commit, so its TypeScript examples cannot drift from the API. Prefer
reading it over inferring behaviour from the implementation, and cite it when
explaining something.

| Question                                        | Read                      |
| ----------------------------------------------- | ------------------------- |
| What is a runner set, and how does a job run?   | `docs/architecture.md`    |
| How do I deploy one?                            | `docs/getting-started.md` |
| How do I point a repository at it?              | `docs/onboarding.md`      |
| What is in a VM, and can I supply my own image? | `docs/images.md`          |
| Why does `setup-python` fail?                   | `docs/toolchains.md`      |
| How do I keep VMs ready in advance?             | `docs/warm-pools.md`      |
| Where does output go?                           | `docs/logging.md`         |
| What metrics and alarms exist?                  | `docs/monitoring.md`      |
| How many can run at once?                       | `docs/service-quotas.md`  |
| What can reach what, and with whose identity?   | `docs/security.md`        |

`API.md` is generated from the doc comments in `src/`. Do not hand-edit it.

## Layout

```
src/                the construct and its public API
  handlers/         the four Lambdas: webhook, launcher, janitor, warm-pool
  image/            the image pipeline and the in-VM agent
  types/            the public value types (sizes, scopes, auth, logging)
test/               unit and construct tests
docs/               the guides above
site/               the docs site, reading docs/ through a symlink
```

The handlers are bundled with esbuild and ship **inside the package** — a
consumer in Python has no esbuild at synth time, so the published tarball
carries ready-to-deploy code rather than building it. That is why
`src/handlers/bundled/` is generated and gitignored, and why compiling with
`jsii` alone leaves a `lib/` that imports and synthesizes while missing
everything a deploy needs.

## Working in this repo

`just verify` is the gate. It runs on commit, on push, and in CI — the same
recipe in all three, so nothing passes locally and fails in CI.

```
just verify     # the whole gate
just test       # unit tests only
just smoke      # build the real tarball, install it into a throwaway project
```

Never `--no-verify`. A suppression needs an inline reason saying why the rule
is wrong _at that site_; a bare one is indistinguishable from silencing a real
finding.

Branches: `feat/*` → `dev` → `main`, pull requests only.

`package.json`, the tsconfigs, the eslint config, and the workflows are
generated from `.projenrc.ts`. Edit that file and re-synth — the gate reverts
hand edits to generated files.

## Constraints that must hold

These are decisions, not preferences. Changing one is a design change.

**The public API stays jsii-clean.** No unions, generics, or callbacks in
public signatures; enum-like classes and interfaces of `readonly` properties
instead. This holds against every language jsii can project, not only the two
published — it is what keeps adding a language a configuration change rather
than a redesign.

**A runner VM has no AWS identity by default.** A MicroVM's IMDS serves its
execution-role credentials to any code the job runs, for the VM's whole life.
Per-job OIDC is the path that does not; `vmExecutionRole` is the opt-in
exception.

**The control plane is stateless.** The MicroVM service's VM list is the source
of truth for what is running, and concurrency is always counted live from it,
never from the table.

**The runner table has four duties and no more:** runner-to-VM correlation,
janitor strike memory, launch idempotency claims, and warm-VM claims. It has no
GSI and is not a source of truth. A fifth duty is a design change.

**`RunnerScope` is enforced, not descriptive.** The webhook checks a delivery's
repository before anything is enqueued, and the launcher checks again before
any side effect.

## Things that surprised us

Non-obvious platform behaviour, learned by running it. Worth knowing before
debugging something that looks broken.

- Running MicroVMs **cannot be tagged**, so a runner set identifies its own VMs
  by image ARN.
- A size preset is a **floor, not an allocation** — the platform
  over-provisions roughly four-fold, and the memory quota counts the actual
  allocation.
- A job's configuration is **pushed to the VM**; the runner then connects
  **outbound** to GitHub. A VM with no egress route boots, receives its config,
  and then never appears as a runner.
- A job cancelled while queued reports an **empty** runner name, so there is
  nothing to terminate — the launcher asks whether the job is still waiting
  before it launches.
- `ListMicrovms` retains terminated VMs for about a day, and the launcher pages
  the whole account list on every launch.
- A JIT runner is **not bound to the job that launched it**. The launcher
  registers a runner carrying the job's labels, and GitHub then hands it
  whichever queued job it likes among those with matching labels — verified live
  by queueing two jobs and watching them land on each other's VMs, exactly
  swapped. Runners are a **pool**, so per-job reasoning is wrong wherever supply
  is counted: a launch skipped because "its" job is already done removes a runner
  the pool may still owe to a job that is still queued. Terminate is safe here
  because it is keyed by runner name, which follows the runner to the right VM.

## Worktrees

Isolate each line of work in its own worktree at `<repo-root>/.worktrees/<branch>`
— see the `worktree-isolation` skill.
