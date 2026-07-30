# Onboarding a repository onto a runner set

A runner set is one `GithubMicrovmRunners` deployment: the construct in an AWS
account, together with the GitHub App installed on the account and granted
access to the repositories the runner set serves.
[Getting started](getting-started.md) covers deploying one; what follows moves
an existing repository's CI onto a runner set that already exists.

## 1. Point a job at the runner set

Each runner class the runner set declares carries a label, which is the first
argument of that class's `addRunnerClass` call:

```ts
runners.addRunnerClass('microvm', { size: MicrovmSize.GB4, image });
```

The class has to be deployed on the runner set before a workflow names its
label, so a class added for this migration ships — and runs a job — ahead of
the pull request that switches `runs-on`.

A job runs on the runner set when its `runs-on` names that label alongside
`self-hosted`:

```yaml
jobs:
  gate:
    runs-on: [self-hosted, microvm]
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-python@v7
        with:
          python-version: '3.12'
```

The VMs are ARM64, so the tools and container images a job pulls need arm64
builds.

Routing is decided per job, so you can migrate one job at a time and let hosted
and MicroVM jobs share a workflow; jobs you have not moved keep running on
GitHub-hosted runners. Each job gets its own MicroVM, which is removed once the
job finishes, so every job starts from the image as built.

If the runner set declares several classes, such as a lean `microvm-lint`
alongside a larger `microvm`, use the label whose VM size fits the job's memory
profile. [Service quotas](service-quotas.md) covers how classes trade size
against concurrency.

The runner set's GitHub App also needs access to this repository, which is what
puts its `workflow_job` events on the webhook. Add the repository under
**Repository access** on the App's installation, alongside the ones the runner
set already serves.

## 2. Declare the labels to actionlint

If the repository lints its workflows with
[actionlint](https://github.com/rhysd/actionlint), give it the runner set's
labels so it recognizes them. actionlint validates `runs-on` against a known
set of labels, and a custom label needs an entry in a `.github/actionlint.yaml`
at the root of the repository being migrated:

```yaml
# .github/actionlint.yaml
self-hosted-runner:
  labels:
    - microvm
    - microvm-lint
```

List one entry per runner class your workflows target, which are the labels the
runner set passed to `addRunnerClass`. The entry tells actionlint the label is
valid, so it affects linting only, not where a job runs.

## 3. Set up AWS access for jobs that need it

A job that needs AWS obtains credentials for that run through GitHub OIDC:

```yaml
permissions:
  id-token: write # required for OIDC
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@v6
    with:
      role-to-assume: ${{ vars.DEPLOY_ROLE_ARN }}
      aws-region: us-east-1
```

The role's trust policy must permit the repository's OIDC subject. The
[security guide](security.md#aws-access-for-jobs) covers finding the exact `sub`
claim your repository's tokens carry and writing the trust policy against it.

## 4. Bake in the toolchains the job's `setup-*` steps need

`actions/setup-python` and `actions/setup-node` resolve versions from the
image's tool cache. Bake in every Python version your workflows request:
`actions/python-versions` publishes no linux-arm64 build, so the tool cache is
where a job finds one. Node versions are worth baking for speed —
`actions/node-versions` does publish linux-arm64, so `setup-node` downloads an
un-baked version and the job runs on it, at about 24 seconds per job.

Either is a change on the runner set rather than in the migrating repository:
the operator adds the toolchain to the image
(`RunnerImage.fromOptions({ toolchains: [...] })`) and redeploys, as
[Toolchains](toolchains.md) describes. The workflow itself stays as written.

## 5. The concurrency ceiling

Whether coinciding runs — a pull-request gate and a push gate on the same
commit, for example — run in parallel or serialize is set by two ceilings:

```
usable concurrency = min( maxConcurrentVms , what the memory quota admits )
```

`maxConcurrentVms` is a prop on the construct. The memory term is **Max
allocated memory**, an AWS service quota held per account and per region, which
every running VM draws against according to its class's size. A launch that
arrives at the ceiling is re-queued and retried until a slot frees.

[Service quotas](service-quotas.md) covers how the ceiling is sized, how to
raise it, what to do when it is frozen, and what happens to a launch that waits
through sustained saturation.

## What to expect on wall time

Moving a job onto a runner set does not, by itself, make it faster. Measured
across nine production jobs — pytest suites, jest, lint, type-checking — wall
time was a wash against GitHub-hosted runners: within a minute either way on
runs of ten to twenty minutes, and marginally slower for short single-threaded
jobs on the smallest class. A single-threaded step runs on one core wherever it
runs, and a MicroVM's single-core speed is close to a hosted runner's.

What does change: a job is picked up in seconds rather than waiting on hosted
queue depth, the VM is billed per second in your own account with no
hosted-minute metering, and the job runs natively on arm64, which matters when
its artifacts target arm64.

Speed comes from parallelism. A size preset's vCPUs are over-provisioned
roughly four-fold — a `GB4` VM comes up with 8 — and a single-process suite
leaves them idle. A job that splits its work across processes, with
`pytest -n`, jest workers, or a parallel build, is where those cores pay.
