# Runner images

A runner VM boots from a MicroVM image, and an image is an
`AWS::Lambda::MicrovmImage` resource in your own AWS account. Every image is
built from a Dockerfile on an Amazon Linux 2023 base, and CloudFormation creates
it when you deploy the stack — so images are built at deploy time rather than
when a job arrives, and a launch boots an image that already exists.

Everything a job finds on the machine comes from that image: the operating
system, the GitHub Actions runner, Docker, the AWS CLI, and the language
versions available to `setup-*` steps. Each image is named for the runner set
that owns it, `<runnerSetId><index>` plus a short hash of its contents.

## What an image contains

Every image starts from the same base: the GitHub Actions runner, Docker, the
AWS CLI, and the packages the runner itself needs. A runner class that adds
nothing to that base gets an image with exactly those tools, which is enough
for a job that uses only them.

An image can carry more — extra system packages, setup commands, files,
environment variables, and the [toolchains](toolchains.md) that `setup-python`
and `setup-node` resolve. The next section covers how a runner class asks for
those, and how to supply a Dockerfile of your own instead.

## Containers in a job

A job can build and run containers. The base image carries the Docker engine,
and the VM's agent starts `dockerd` at boot, as root, before any job arrives.
Job steps reach it through `/var/run/docker.sock`, which the `runner` user
holds through the `docker` group — no `sudo` involved, which matters because
job steps cannot escalate privileges
([Security](security.md#what-job-code-can-and-cannot-do-on-the-vm)). Do not
try to start or restart the daemon from a job; it is already running, and the
job cannot.

The daemon runs with two MicroVM-specific settings, and both are visible from
a job:

- **`--storage-driver=vfs`.** vfs copies layers in full rather than overlaying
  them, so building or pulling a large image is slower here than on a machine
  with overlay2.
- **`--iptables=false`.** The daemon sets up no NAT, so a container on the
  default bridge network has **no outbound path**. Run containers that need
  the network with `--network=host`, and pass `--network=host` to
  `docker build` when a build step fetches from the network. `docker pull`
  itself is unaffected — the daemon fetches from the host side.

The daemon's boot log is written to `/var/log/microvm-runner-dockerd.log`,
readable from any job step. When a `docker` command cannot reach the daemon,
that file says why.

## One image per runner class

A runner class's size is part of its image. The size is written onto the image
resource when the image is built, rather than chosen when a VM launches, so
each runner class builds an image of its own — two classes running identical
software at different sizes are still two images.

When a job arrives, the launcher matches its `runs-on` labels to a runner class
and boots a VM from that class's image. Those image ARNs are also how a runner
set recognizes its own VMs: running MicroVMs carry no tags, so the launcher and
janitor filter the account's VM list down to the ARNs they built.

## Describing an image

Every image comes from a Dockerfile, and there are three ways to arrive at one,
differing in who writes it. `RunnerImage.fromOptions()` renders one for you,
from the base plus any options you declare. `RunnerImage.fromDockerfile()` reads
one you wrote from a directory on disk, and `RunnerImage.fromInline()` takes one
you wrote as text in your CDK code.

`RunnerImage.fromOptions()` takes what to add to the base as options:

```ts
RunnerImage.fromOptions({
  systemPackages: ['jq', 'ripgrep'],
  setupCommands: ['npm install -g pnpm@10'],
  environment: { LANG: 'C.UTF-8' },
  toolchains: [RunnerToolchain.python('3.12.7')],
});
```

- `systemPackages` — extra `dnf` packages alongside the base set.
- `setupCommands` — extra `RUN` commands, in order, after packages, assets, and
  environment are laid down.
- `assets` — files and directories copied into the image.
- `environment` — environment variables baked into the image.
- `toolchains` — language versions placed in the hosted tool cache for
  `setup-python` and `setup-node`. See [Toolchains](toolchains.md).
- `runnerVersion` — which `actions/runner` release to install.
- `additionalOsCapabilities` — the Linux capabilities the VM's operating system
  runs with, as a list of capability names. Defaults to `['ALL']`; pass a
  narrower list to run with fewer.

### Building from your own Dockerfile

`RunnerImage.fromDockerfile(dir)` uses the Dockerfile at `dir/Dockerfile` and
takes that whole directory as the build context, so anything beside the
Dockerfile is available to `COPY`. The options above belong to
`RunnerImage.fromOptions()`; here the Dockerfile decides everything.

Your Dockerfile takes on everything `RunnerImage.fromOptions()` was doing,
which is more than copying the agent in. [What a custom image must
provide](#what-a-custom-image-must-provide) below states the whole contract.
This is a Dockerfile that meets it:

```dockerfile
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# The agent is a Node program, and it starts the runner as the `runner` user.
RUN dnf install -y nodejs22 sudo shadow-utils tar git && dnf clean all
RUN useradd -m runner

# The GitHub Actions runner, where the agent looks for it.
RUN mkdir -p /opt/runner && cd /opt/runner \
  && curl -fsSLo r.tgz https://github.com/actions/runner/releases/download/v2.335.1/actions-runner-linux-arm64-2.335.1.tar.gz \
  && tar xzf r.tgz && rm r.tgz && chown -R runner:runner /opt/runner

# Staged into the build context by the construct.
COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs
COPY microvm-runner/entrypoint.sh /opt/microvm-runner/entrypoint.sh
ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]
```

```ts
import * as path from 'path';

runners.addRunnerClass('custom', {
  size: MicrovmSize.GB4,
  image: RunnerImage.fromDockerfile(path.join(__dirname, 'runner-image')),
});
```

Editing that Dockerfile ships on the next `cdk deploy` as a new image version,
which the next launch picks up.

### Writing the Dockerfile inline

`RunnerImage.fromInline(dockerfile)` takes the Dockerfile as text, so a short
one lives in the CDK code beside the runner class it belongs to rather than in a
file of its own:

```ts
runners.addRunnerClass('custom', {
  size: MicrovmSize.GB4,
  image: RunnerImage.fromInline(`
FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y nodejs22 sudo shadow-utils tar git jq && dnf clean all
RUN useradd -m runner
RUN mkdir -p /opt/runner && cd /opt/runner \\
 && curl -fsSLo r.tgz https://github.com/actions/runner/releases/download/v2.335.1/actions-runner-linux-arm64-2.335.1.tar.gz \\
 && tar xzf r.tgz && rm r.tgz && chown -R runner:runner /opt/runner

COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs
COPY microvm-runner/entrypoint.sh /opt/microvm-runner/entrypoint.sh
ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]
`),
});
```

The same contract applies — an inline Dockerfile is only a different way to
supply the text. The construct checks for the agent `COPY` line as it reads
it, and says so if that line is missing; the rest of the contract is not
something it can check.

The build context holds the Dockerfile you supplied and the `microvm-runner/`
directory the construct stages, and nothing else — an inline Dockerfile brings
no files of its own, so those two agent files are what a `COPY` can name. A
Dockerfile that needs to copy your own files in belongs with
`RunnerImage.fromDockerfile(dir)`, which stages a whole directory as the build
context.

### What a custom image must provide

`RunnerImage.fromOptions()` builds an image that already satisfies all of
this. A Dockerfile of your own replaces that image rather than adding to it,
so it has to satisfy the contract itself.

The construct stages two files into the build context under
`microvm-runner/`: `agent.mjs`, and the `entrypoint.sh` that runs it. The
agent serves the lifecycle hooks the MicroVM service calls, and starts the
GitHub Actions runner when a job arrives. What it needs to do that:

| The image must have                                                     | Because                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Node** on `PATH`                                                      | `entrypoint.sh` is `exec node /opt/microvm-runner/agent.mjs` |
| **The Actions runner at `/opt/runner`**                                 | the agent runs `./run.sh --jitconfig …` from that directory  |
| **A user named `runner`**                                               | the agent starts the runner as that user, not as root        |
| **`sudo`**                                                              | which is how it does so                                      |
| **Both agent files copied in, and `entrypoint.sh` as the `ENTRYPOINT`** | nothing starts the agent otherwise                           |

The base image is `al2023-minimal`, and it is genuinely minimal. Two absences
catch people out: **`find` and `xargs` are not installed** — `findutils` is not
part of the base package set — and neither is anything else you might assume
from a fuller distribution. A script that shells out to `find` gets
"command not found", which with `2>/dev/null` is indistinguishable from finding
nothing. Node is the one interpreter the contract guarantees, so prefer it for
anything that walks the filesystem, or install what you need explicitly through
`systemPackages`.

Only the last of those is checked for you, and only partly: the construct
looks for a line referencing `microvm-runner/agent.mjs` and refuses a
Dockerfile without one. It cannot check the rest, because there is no reliable
way to tell from Dockerfile text whether a package manager invocation put Node
on the path.

The two ways this goes wrong fail very differently, which is worth knowing
before you debug one.

**Without Node, the deploy fails.** The Docker build itself succeeds —
nothing in it runs Node — and then the platform boots the image and waits for
the agent to answer its ready hook. Nothing answers, and CloudFormation gives
up on the image:

```
Resource of type 'AWS::Lambda::MicrovmImage' with identifier
'...:microvm-image:<name>' did not stabilize. (HandlerErrorCode: NotStabilized)
```

That message names neither the hook nor the missing interpreter, so it is
worth recognizing: an image that builds and then fails to stabilize is an
image whose agent never started. The build log ends with the last successful
Docker step and says nothing more. At least the failure arrives at
`cdk deploy`, before any job is at stake.

**Without the runner, the user, or `sudo`, nothing fails.** The agent starts,
answers the ready hook, and the image builds. The VM launches and registers a
runner with GitHub. Then a job arrives, the agent tries to start the runner,
and cannot — so the job sits queued against a runner that will never take it,
until the janitor reaps the VM. Everything is green except the job.

If a custom image takes jobs but never runs them, that is where to look
first.

## Sharing an image across runner classes

Classes whose jobs need the same contents can share one `RunnerImage` — hoist it
to a `const` and pass it to each call:

```ts
const image = RunnerImage.fromOptions({
  toolchains: [RunnerToolchain.python('3.12.7')],
});

runners.addRunnerClass('microvm', { size: MicrovmSize.GB4, image });
runners.addRunnerClass('microvm-8gb', { size: MicrovmSize.GB8, image });
```

Both classes bake in Python 3.12.7, and each still builds its own MicroVM image
because size is written into the image at build time.

Classes whose jobs need different contents each take their own image:

```ts
runners.addRunnerClass('lint', { size: MicrovmSize.GB1, image: leanImage });
runners.addRunnerClass('test', { size: MicrovmSize.GB4, image: heavyImage });
```

## How an image changes

An image's identity is a content hash. For `RunnerImage.fromOptions()` it covers
the rendered Dockerfile and a manifest of its assets, so editing any option above
produces a different hash on the next deploy; for `RunnerImage.fromInline()` it
covers the Dockerfile text you supplied, so editing a single line of it does the
same.

What that means at deploy time depends on what changed:

- A change to the image's **assets alone** updates the image in place and adds a
  version. The next launch picks up the newest version, while VMs already
  running keep the version they booted from.
- A change to the image's **specification** — packages, setup commands,
  environment, toolchains, runner version — changes the hash, and with it the
  image's name, so CloudFormation replaces the resource.

Either way the change arrives through a normal `cdk deploy`, and the janitor
prunes old image versions as it sweeps.

Let that deploy finish. Interrupting the CLI — Ctrl-C, a dropped connection —
stops the local process, while CloudFormation carries on server-side with the
stack in `UPDATE_IN_PROGRESS`, and a job that runs before the image resource
settles boots the previous image, which looks like the change silently not
arriving. Wait for the stack to reach `UPDATE_COMPLETE` before re-running the
jobs that need the new image.

Image builds are silent by default. To see one — why an image failed to build,
or what a setup command did — turn on `imageLogs: ImageLogs.enabled()`, which
streams the build output to CloudWatch. See [Logging](logging.md).

## What a size gives you

A size preset is a floor rather than an allocation. The number names the
minimum the image is built with, and the platform provisions above it — on the
accounts this has been measured on, at roughly four times the requested memory
and vCPU:

| `MicrovmSize` | Floor          | Measured       |
| ------------- | -------------- | -------------- |
| `GB1`         | 1 GB, 0.5 vCPU | ~4 GB, 2 vCPU  |
| `GB2`         | 2 GB, 1 vCPU   | ~8 GB, 4 vCPU  |
| `GB4`         | 4 GB, 2 vCPU   | ~16 GB, 8 vCPU |

Two things follow from that. A job usually fits a smaller preset than its
memory figure suggests — a build that peaks at 3 GB runs on `GB1`. And the
account's memory quota is charged the measured allocation rather than the
floor, which is what decides how many VMs run at once;
[Service quotas](service-quotas.md) covers the arithmetic.

The multiplier is the platform's behaviour, not something this construct sets,
so it is an observation rather than a guarantee. Measure the workload where the
margin matters.

## Disk budget

Disk comes with the size, and unlike memory it is the figure you get. Each
[MicroVM size](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
the construct exposes carries a fixed allowance:

| `MicrovmSize`         | Disk  |
| --------------------- | ----- |
| `GB0_5`, `GB1`, `GB2` | 8 GB  |
| `GB4`                 | 16 GB |
| `GB8`                 | 32 GB |

That disk holds the whole image — the base OS, the fixed package set, the AWS
CLI, the runner binary, and everything added through the options above — along
with what the job writes at run time: its checkout, dependency installs, build
artifacts, and Docker layers if the job uses containers. A Python toolchain
keeps its build dependencies in the image so `pip` can compile C extensions at
job time, so several baked versions add up.
