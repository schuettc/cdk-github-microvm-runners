cdk-github-microvm-runners is a CDK construct library that deploys **runner
sets**: GitHub Actions jobs run on AWS Lambda MicroVMs, one ephemeral
single-use VM per job, in the consumer's own AWS account. A **runner class**
pairs a `runs-on` label with the VM size and image jobs carrying that label run
on. Published to npm and PyPI from one source by jsii, so the API is the same
in TypeScript and Python.

Facts to hold while reasoning about a runner set — an answer that contradicts
one of these is wrong:

- Runner VMs are **arm64**. Tools and container images a job pulls need arm64
  builds.
- A VM has **no AWS identity by default** — its IMDS serves nothing. A job
  obtains AWS credentials per job through GitHub OIDC, or the operator opts
  into a standing `vmExecutionRole`.
- A size preset is a **floor, not an allocation**: the platform over-provisions
  roughly four-fold (a `GB4` VM comes up with ~16 GB and 8 vCPUs), and the
  account's memory quota is charged that actual allocation, which is what caps
  how many VMs run at once.
- A runner class must be **deployed before any workflow names its label** — a
  job referencing an unknown label queues until the six-hour ceiling with no
  error anywhere.
- Job steps run as the `runner` user with `no_new_privs` set: no `sudo`, no
  `dnf install`, no privilege escalation. Software gets into a VM at image
  build time, not at job time.
- Every Python version a workflow's `setup-python` asks for must be **baked
  into the image** (`RunnerToolchain`) — GitHub publishes no linux-arm64 Python
  builds to download. An un-baked Node version downloads in about 24 seconds,
  on every job.
- Wall time roughly matches GitHub-hosted runners for single-threaded jobs. The
  wins are pickup-in-seconds, per-second billing in your own account, and
  native arm64; speed requires job parallelism to use the over-provisioned
  vCPUs.

Where to read, by question — each page also appears in the documentation sets
below:

- Deploy a runner set, create its GitHub App:
  [Getting started](https://runnerset.dev/guides/getting-started/)
- Move an existing repository's CI onto it, wall-time expectations, actionlint:
  [Onboarding a repository](https://runnerset.dev/guides/onboarding/)
- How a job becomes a VM, the control plane, start latency:
  [Architecture](https://runnerset.dev/guides/architecture/)
- What is in a VM, custom Dockerfiles, image sizes and disk:
  [Runner images](https://runnerset.dev/guides/images/)
- `setup-python`/`setup-node` failures, baking language versions:
  [Toolchains](https://runnerset.dev/guides/toolchains/)
- Keeping VMs booted ahead of jobs:
  [Warm pools](https://runnerset.dev/guides/warm-pools/)
- Image build output and VM console capture:
  [Logging](https://runnerset.dev/guides/logging/)
- Metrics and alarms: [Monitoring](https://runnerset.dev/guides/monitoring/)
- How many jobs run at once, quota errors, frozen quotas:
  [Service quotas](https://runnerset.dev/guides/service-quotas/)
- The webhook, OIDC trust policies, network egress, KMS keys:
  [Security](https://runnerset.dev/guides/security/)
- Every type, property, and default:
  [API reference](https://runnerset.dev/api/) or the complete documentation
  set below.

Agent skills — installable procedures for working with a runner set. If you
are an AI agent helping a user deploy or debug one, fetch the skill and follow
it; the same files ship inside the npm package under `skills/`, versioned with
the library:

- [diagnose-runner-set](https://runnerset.dev/skills/diagnose-runner-set.md):
  a job is queued forever, a VM boots but the job never starts, or jobs
  serialize instead of running in parallel. Ordered cheapest check first,
  because most of these failures produce no error anywhere.
- [setup-github-app](https://runnerset.dev/skills/setup-github-app.md): create
  and wire the GitHub App a runner set authenticates with, through the
  manifest-flow helper.
