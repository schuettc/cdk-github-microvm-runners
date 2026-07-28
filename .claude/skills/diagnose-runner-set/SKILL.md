---
name: diagnose-runner-set
description: Use when a job is not running on a cdk-github-microvm-runners runner set — queued forever, no runner appears, a VM boots but the job never starts, jobs run one at a time instead of in parallel, or a custom image behaves oddly. Works from the outside in, checking the cheap causes before the expensive ones, because most of these failures produce no error anywhere.
---

# Diagnose a runner set

Almost every failure here is silent. The deploy succeeds, CloudWatch looks
normal, and a job sits queued. So work outward from what GitHub can see toward
what the VM is doing, and stop at the first thing that is wrong.

Ask which symptom it is first — they have almost disjoint causes.

## The job stays queued and no runner ever appears

Nothing launched, or something launched and could not register.

**1. Do the labels match a runner class?** The webhook ignores a
`workflow_job` whose labels contain none of the runner set's class labels.
Compare the job's `runs-on` against the labels passed to `addRunnerClass`.
Extra labels are fine; a missing class label means nothing happens at all.

**2. Is the repository in scope?** `RunnerScope.repos([...])` is enforced, not
descriptive — a repository not on the list is ignored even though the App is
installed on it and the delivery is correctly signed. `RunnerScope.org()`
serves every repository in that organization and nothing outside it. Look for
`launcher: repo is outside this runner set scope` in the launcher's log.

**3. Is the App installed on that repository, and delivering?** Check the App's
recent deliveries on GitHub. No delivery means the App is not installed there,
is not subscribed to `workflow_job`, or its webhook URL is not this runner
set's. `docs/getting-started.md` covers the setup, and the `setup-github-app`
skill's `--doctor` mode reports on an existing installation.

**4. Is it a public repository?** GitHub does not dispatch public-repository
jobs to self-hosted runners in a runner group that disallows them, and this is
silent. See `docs/security.md`.

**5. Did a VM launch anyway?** If one did, the problem is registration, not
launching — go to the next section.

## A VM launches but the job never starts

The VM booted and received its configuration; the runner could not connect out
or could not start.

**The most common cause is egress.** A job's configuration is _pushed to_ the
VM, so it arrives regardless of networking — the runner then connects
**outbound** to GitHub. A VM in a subnet with no route out boots, receives its
config, and never appears as a runner. If `network` is `RunnerNetwork.vpc()`,
confirm the subnets have a NAT route. `docs/security.md` covers this.

**With a custom image, check the contract.** `RunnerImage.fromDockerfile()` and
`fromInline()` replace the default image entirely, and the agent needs more
than the two files it copies in: Node, the Actions runner at `/opt/runner`, a
`runner` user, and `sudo`. Missing Node fails the image build. Missing the
runner, the user, or `sudo` fails **nothing** — the image builds, the VM
launches, the runner registers, and the job never starts.
`docs/images.md` has the full contract.

## Jobs run one at a time instead of in parallel

Capacity, and there are two ceilings.

Check the `capacityRejected` metric for the class. It fires for both causes,
and the launcher's log distinguishes them: `runner set at capacity` is the
runner set's own `maxConcurrentVms`, while a `ServiceQuotaExceededException` is
the account's memory quota.

The memory quota is the one that surprises people. A size preset is a floor,
not an allocation — the platform over-provisions roughly four-fold, so a `GB4`
class consumes about 16 GB of quota per VM. `docs/service-quotas.md` has the
arithmetic and how to raise it.

## A job runs on the wrong image

Two classes share an image when their contents and size are identical, which is
usually what this is. `runners.runnerClasses` gives each class its `label` and
`imageArn` — two classes naming the same ARN are the same image, by design.

To prove which image a VM booted, have the job check for something only that
image has. A class silently falling back to the default image runs the job and
exits 0 either way, so "the job passed" does not establish it.

## The VM is gone before the job finished

`maxJobDuration` bounds a job, and the platform kills the VM at that plus a
grace period — so a job dies somewhat after the value, not at it. The default
is six hours. Read the value out of the CDK app rather than the deployed stack;
the construct does not publish it as a property or an output.

A job killed at that boundary looks like an infrastructure failure and is a
configured limit.

## Where to look

| Signal                    | Where                                                      |
| ------------------------- | ---------------------------------------------------------- |
| Was a launch attempted?   | the launcher Lambda's log group                            |
| Did a VM boot?            | `aws lambda-microvms list-microvms --image-identifier ...` |
| What did the VM print?    | the console log group, if `consoleLogs` is enabled         |
| Did the image build fail? | the image build log group, if `imageLogs` is enabled       |
| Cold, warm, or rejected?  | the `MicrovmRunners` metric namespace                      |

Console and image logs are opt-in. If neither is on, turning them on is often
the fastest next step — `docs/logging.md`.

## Do not conclude from a green job

Several failures here end with a job that passes while proving nothing: a class
that fell back to the default image, a VM that egressed outside its VPC, a
metric asserted on an empty window. When confirming a fix, check the specific
thing that changed rather than that the job succeeded.
