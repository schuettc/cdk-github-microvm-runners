# Getting started

A **runner set** is one deployment of this construct: the webhook, queue,
launcher, and janitor that turn GitHub's `workflow_job` events into MicroVMs. A
**runner class** is a label paired with the VM size and image that jobs carrying
that label run on. A runner set serves an organization or a list of
repositories, and defines at least one class.

This guide deploys a runner set, creates the GitHub App it authenticates with,
and moves a job onto it.

## What you need

- An AWS account in a region where AWS Lambda MicroVMs is available —
  `us-east-1`, `us-east-2`, `us-west-2`, `eu-west-1`, or `ap-northeast-1` — and
  credentials that can deploy a CDK stack to it.
- The AWS CDK CLI (v2).
- A GitHub account you can install a GitHub App on. An organization or a
  personal account both work.

Install the library:

```bash
npm install cdk-github-microvm-runners
```

```bash
pip install cdk-github-microvm-runners
```

The examples below are TypeScript. The API is the same in each language, with
names rendered in that language's conventions — [API.md](../API.md) carries
both.

## 1. Define the runner set

The construct takes two required properties: how it authenticates to GitHub,
and which organization or repositories it serves. Everything else has a
default.

```ts
import { App, CfnOutput, Stack } from 'aws-cdk-lib';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import {
  GithubAppId,
  GithubAppKey,
  GithubAuth,
  GithubMicrovmRunners,
  MicrovmSize,
  RunnerScope,
} from 'cdk-github-microvm-runners';

const app = new App();
const stack = new Stack(app, 'Runners', { env: { region: 'us-east-1' } });

const appId = Secret.fromSecretNameV2(
  stack,
  'AppId',
  'microvm-runner/dev/app-id',
);
const privateKey = Secret.fromSecretNameV2(
  stack,
  'AppKey',
  'microvm-runner/dev/app-private-key',
);
const webhookSecret = Secret.fromSecretNameV2(
  stack,
  'WebhookSecret',
  'microvm-runner/dev/webhook-secret',
);

const runners = new GithubMicrovmRunners(stack, 'Runners', {
  github: GithubAuth.app({
    appId: GithubAppId.fromSecret(appId),
    privateKey: GithubAppKey.fromSecret(privateKey),
    webhookSecret,
  }),
  scope: RunnerScope.org('my-org'),
});

// A runner class: the `microvm` label, on 4 GB VMs.
runners.addRunnerClass('microvm', { size: MicrovmSize.GB4 });

new CfnOutput(stack, 'WebhookUrl', { value: runners.webhookUrl });
new CfnOutput(stack, 'SetupCommand', { value: runners.setupCommand });
```

The handlers read all three secrets at run time, which is why the stack can be
deployed before the App exists.

## 2. Deploy

```bash
cdk deploy
```

The stack's `WebhookUrl` output is the address GitHub delivers events to. Its
`SetupCommand` output is the step 3 command with its values already filled in.

## 3. Create the GitHub App

The App is what lets the runner set receive `workflow_job` events and register
runners. A helper creates it through GitHub's App-manifest flow.

The helper reads `WebhookUrl` from the deployed stack, creates the App pointed
at that URL with the permissions the runners need (`actions: read` and
organization `self-hosted runners: write`) and the `workflow_job`
subscription, writes the App ID, private key, and webhook secret to Secrets
Manager under `microvm-runner/dev`, and opens the install page. Install it
there, granting access to the repositories the runner set serves.

It needs three things, which are the same three the stack was built with:

```bash
export GITHUB_ORG=my-org      # the organization the App is installed on
export STACK_NAME=Runners     # the CDK stack deployed above
export AWS_REGION=us-east-1   # the region it was deployed to
```

Then, with AWS credentials available:

```bash
npx cdk-github-microvm-runners setup \
  --org "$GITHUB_ORG" \
  --stack "$STACK_NAME" \
  --region "$AWS_REGION"
```

`npx` fetches the helper from the same package the construct came from, so
this is the same command whether the stack is written in TypeScript or
Python.

`cdk deploy` also prints this line with the values already filled in, as the
stack's `SetupCommand` output — copy that instead if you would rather not set
the variables:

```
Runners.SetupCommand = npx cdk-github-microvm-runners@0.1 setup --org my-org --stack Runners --region us-east-1
```

That is CloudFormation's output format: `Runners` is the stack, `SetupCommand`
is the output name, and everything after `=` is the command.

The command is safe to re-run. Every run reads the stored secrets and the
installation first and then does what is missing, so the same line finishes an
interrupted setup and reports on a finished one. `--doctor` limits a run to that
report, and `--help` lists every flag.

Pass `--profile` to pick a named AWS profile. Pass `--secret-prefix` to write
the secrets under a different prefix, and use the same prefix in the stack.

A runner set scoped to repositories rather than an organization prints
`--account <login>` in place of `--org`. That App asks for repository
`Administration: write`, which is what GitHub requires to register a runner on a
single repository.

From a clone of this repository, `node scripts/setup-github-app.mjs` takes the
same flags.

To create the App by hand instead, give it `actions: read` and organization
`self-hosted runners: write` — or repository `Administration: write` for a
runner set scoped to repositories — subscribe it to `workflow_job`, set its
webhook URL to the stack's `WebhookUrl` and its webhook secret to a value you
choose, then store the App ID, the private-key PEM, and that webhook secret
under the three secret names the stack reads.

## 4. Run a job on it

In a repository the App has access to, point a job at the class label:

```yaml
jobs:
  build:
    runs-on: [self-hosted, microvm]
    steps:
      - uses: actions/checkout@v6
      # ...
```

On push, the App delivers a `workflow_job` event to the webhook, the launcher
starts a MicroVM, a single-use runner registers with GitHub, the job runs, and
the VM is removed. Runner VMs are ARM64, so the tools and container images a job
pulls need arm64 builds.

## Where to go next

- [Toolchains](toolchains.md) — bake the Python and Node versions your
  `setup-*` steps ask for into the image.
- [Runner images](images.md) — what an image contains, and how to supply your
  own Dockerfile.
- [Warm pools](warm-pools.md) — keep VMs booted ahead of time so jobs skip the
  boot wait.
- [Logging](logging.md) — image build output and VM console capture, both
  opt-in.
- [Onboarding a repo](onboarding.md) — the full checklist for moving an
  existing repository's CI over.
- [Security](security.md) — the security model, and how a job obtains AWS
  credentials through GitHub OIDC.
- [Service quotas](service-quotas.md) — sizing a runner set for concurrency.
