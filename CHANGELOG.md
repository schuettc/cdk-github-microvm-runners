# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

Nothing has been published yet, so this section describes the surface the first
release will carry.

### Added

- `GithubMicrovmRunners`, a runner set: a webhook handler behind a Function URL,
  an SQS job queue and dead-letter queue, a launcher, a scheduled janitor, a
  DynamoDB table, and one MicroVM image per runner class. It takes two required
  properties — `github` and `scope`.
- `addRunnerClass(label, props)` registers a runner class, each with its own
  MicroVM size, image, warm pool size, and idle policy. A job reaches a class by
  naming its label in `runs-on`.
- `GithubAuth.app()` and `GithubAuth.pat()` for authenticating to GitHub.
  `GithubAppId` takes the App's ID as a literal or from a Secrets Manager
  secret; `GithubAppKey` takes its private key from a Secrets Manager secret or
  signs with a KMS key. The secret forms are read at run time, so a runner set
  can be deployed before the App exists.
- `RunnerImage.fromOptions()`, `.fromDockerfile()`, and `.fromInline()` for
  describing a class's image, with `RunnerToolchain` baking Python and Node
  versions into the tool cache that `actions/setup-python` and
  `actions/setup-node` resolve from.
- `RunnerNetwork` for egress: direct internet, existing Lambda runtime
  connectors, or a VPC the construct builds a connector from.
- `imageLogs` and `consoleLogs` for CloudWatch logging, off by default and
  turned on independently. `imageLogs` captures the image build; `consoleLogs`
  captures a VM's runtime console and requires `vmExecutionRole`.
- `emitMetrics` for CloudWatch metrics, off by default, with `runners.metrics`
  exposing the janitor's sweep counters per runner set and the launcher and
  warm-pool metrics per runner class. Three methods build a ready-made alarm.
- `vmExecutionRole` attaches an AWS identity to the runner VMs. Runner VMs carry
  none by default; a job that needs AWS obtains its own credentials through
  GitHub OIDC.
- Warm pools, idle auto-suspend and resume, and outage recovery through
  `recoverStuckLaunches`.
- A customer-managed KMS key (`encryptionKey`), a permissions boundary applied
  to every role the construct creates, and control over the removal policy,
  DynamoDB point-in-time recovery, log and dead-letter retention, the
  dead-letter redrive count, Lambda memory, the webhook's reserved concurrency,
  and the janitor and warm-pool schedules.
- Two published packages, compiled by jsii from one source: npm for
  TypeScript and PyPI for Python. The API is the same in each, with names
  rendered in the target language's conventions.
