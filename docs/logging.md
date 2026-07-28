# Logging

Three things produce output, and each goes to a different place.

The **build** is CloudFormation building a runner class's image at deploy time.
The **VM** is the machine that boots from that image and runs the runner agent.
The **job** is the workflow run GitHub sends to that VM.

| Level | Covers                                | Goes to        | Turned on by      |
| ----- | ------------------------------------- | -------------- | ----------------- |
| Build | the Docker build and its ready probe  | CloudWatch     | `imageLogs`       |
| VM    | boot, the agent, the runner's session | CloudWatch     | `consoleLogs`     |
| Job   | what the workflow's steps printed     | GitHub Actions | always, by GitHub |

GitHub handles the job level without anything from this construct: step output
goes from the runner to GitHub and appears in the Actions UI, the same as on a
GitHub-hosted runner. The construct handles the build and VM levels. Both are
off until you turn them on, both take their own log group, and neither contains
the job's step output.

## Image build logs

`ImageLogs.enabled()` sends build output to the platform's default group:

```ts
new GithubMicrovmRunners(stack, 'Runners', {
  github,
  scope,
  imageLogs: ImageLogs.enabled(),
});
```

Passing an `ILogGroup` sends it to a group whose retention and encryption you
control, and the construct grants the image build role write access to it:

```ts fragment=GithubMicrovmRunnersProps
imageLogs: ImageLogs.enabled(myBuildLogGroup),
```

A build writes two kinds of stream, told apart by the version in the stream
name. The build itself is version `0.0` and carries the Dockerfile's steps and
their output:

```
#6 [2/9] RUN dnf install -y libicu bash git docker jq tar zip unzip nodejs22 sudo shadow-utils && dnf clean all
#7 [3/9] RUN dnf install -y gh --repofrompath gh-cli,https://cli.github.com/packages/rpm || true
#8 [4/9] RUN curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o /tmp/awscliv2.zip
#14 exporting layers
#14 exporting layers 23.1s done
```

The platform then runs the built image once to confirm it responds to the ready
probe. That run's console goes to a separate stream, at the image's own version.

## Runtime console logs

`ConsoleLogs.enabled()` captures each VM's console. The platform writes it using
the VM's execution role, so this requires `vmExecutionRole` — the construct does
not create a VM identity for you — and you grant that role the two write actions
on the console group:

```ts
const runners = new GithubMicrovmRunners(stack, 'Runners', {
  github,
  scope,
  vmExecutionRole: role,
  consoleLogs: ConsoleLogs.enabled(),
});

runners.vmConsoleLogGroup!.grant(
  role,
  'logs:CreateLogStream',
  'logs:PutLogEvents',
);
```

Called with no argument, `ConsoleLogs.enabled()` has the construct create the
group using the runner set's `logRetention` (two weeks by default), its
`removalPolicy`, and its `encryptionKey` when one is set. Passing an `ILogGroup`
uses that group instead. Either way the resolved group is
`runners.vmConsoleLogGroup`, which is optional on the construct and set only on
a runner set that opted into console capture.

Streams are named `<date>[<imageVersion>]<microvmId>`, one per VM, and warm-pool
VMs stream from boot. A stream covers the runner connecting, the job it picked
up, and teardown:

```
√ Connected to GitHub
Current runner version: '2.335.1'
2026-07-24 19:46:05Z: Listening for Jobs
2026-07-24 19:46:06Z: Running job: probe
2026-07-24 19:46:09Z: Job probe completed with result: Succeeded
√ Removed .credentials
√ Removed .runner
Runner listener exit with 0 return code, stop the service, no retry needed.
Exiting runner...
runner exited 0
```

A stream carries the job's name and result, not what its steps printed. The
`microvmId` in the stream name correlates to the launcher's own logs and to the
runner table.

A VM that never runs a job still gets a stream. A pre-booted warm-pool VM
terminated before any job arrives leaves one line:

```
microvm-runner agent on 8080
```

Those VMs have no record on GitHub: no job, no log. Their console stream is the
only record they ran. A VM that boots but never registers a runner is the same
case — the job stays queued on GitHub with an empty log, and the console stream
shows how far the VM got.

### What the role exposes

A MicroVM's instance metadata service serves the execution role's credentials to
the code running inside the job. Whatever that role can do, job code can do, for
the whole run. [The security guide](security.md#the-vm-and-the-job) covers the
VM's identity in full.

A role carrying the two console-write actions can write to the console log
group, and nothing else.

Enabling or disabling capture each takes a deploy, and a stream holds only what
a VM printed while capture was on.

## Collecting build and VM logs in one group

The two go to separate groups by default. Passing the same `ILogGroup` to both
puts build output and VM consoles together:

```ts
const logs = new LogGroup(stack, 'RunnerLogs');

new GithubMicrovmRunners(stack, 'Runners', {
  github,
  scope,
  vmExecutionRole: role,
  imageLogs: ImageLogs.enabled(logs),
  consoleLogs: ConsoleLogs.enabled(logs),
});
```
