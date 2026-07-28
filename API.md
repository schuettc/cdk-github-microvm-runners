# API Reference <a name="API Reference" id="api-reference"></a>

## Constructs <a name="Constructs" id="Constructs"></a>

### GithubMicrovmRunners <a name="GithubMicrovmRunners" id="cdk-github-microvm-runners.GithubMicrovmRunners"></a>

A runner set: one deployment of GitHub Actions runners that run on AWS Lambda MicroVMs, with a fresh VM per job that is thrown away when the job ends.

The construct deploys a webhook handler for GitHub's `workflow_job`
deliveries, a queue those deliveries become launch and terminate intents on,
a launcher that starts a VM and registers it with GitHub for each queued
job, and a janitor that sweeps on a schedule for VMs and runners that
outlived their job. Every runner class registered through
`addRunnerClass` adds an image build of its own, and a runner set needs
at least one class to synthesize.

Deploying it takes two props: how to authenticate to GitHub, and which
GitHub scope the runners register into. The VMs themselves carry no AWS
identity unless `GithubMicrovmRunnersProps.vmExecutionRole` gives them
one.

*Example*

```typescript
const runnerSet = new GithubMicrovmRunners(stack, 'Runners', {
  github: GithubAuth.app({
    appId: GithubAppId.fromSecret(
      Secret.fromSecretNameV2(stack, 'AppId', 'microvm-runner/dev/app-id'),
    ),
    privateKey: GithubAppKey.fromSecret(
      Secret.fromSecretNameV2(stack, 'AppKey', 'microvm-runner/dev/app-private-key'),
    ),
    webhookSecret: Secret.fromSecretNameV2(
      stack, 'WebhookSecret', 'microvm-runner/dev/webhook-secret',
    ),
  }),
  scope: RunnerScope.org('my-org'),
});

runnerSet.addRunnerClass('microvm', { size: MicrovmSize.GB4 });
```


#### Initializers <a name="Initializers" id="cdk-github-microvm-runners.GithubMicrovmRunners.Initializer"></a>

```typescript
import { GithubMicrovmRunners } from 'cdk-github-microvm-runners'

new GithubMicrovmRunners(scope: Construct, id: string, props: GithubMicrovmRunnersProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps">GithubMicrovmRunnersProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-github-microvm-runners.GithubMicrovmRunners.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-github-microvm-runners.GithubMicrovmRunners.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-github-microvm-runners.GithubMicrovmRunners.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps">GithubMicrovmRunnersProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.toString">toString</a></code> | Returns a string representation of this construct. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.with">with</a></code> | Applies one or more mixins to this construct. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.addRunnerClass">addRunnerClass</a></code> | Register a runner class: the `runs-on` label a workflow targets, paired with the VM size, and optionally the image, that jobs carrying that label run on. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.runnerClass">runnerClass</a></code> | The registered `RunnerClass` carrying `label`. |

---

##### `toString` <a name="toString" id="cdk-github-microvm-runners.GithubMicrovmRunners.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

##### `with` <a name="with" id="cdk-github-microvm-runners.GithubMicrovmRunners.with"></a>

```typescript
public with(mixins: ...IMixin[]): IConstruct
```

Applies one or more mixins to this construct.

Mixins are applied in order. The list of constructs is captured at the
start of the call, so constructs added by a mixin will not be visited.
Use multiple `with()` calls if subsequent mixins should apply to added
constructs.

###### `mixins`<sup>Required</sup> <a name="mixins" id="cdk-github-microvm-runners.GithubMicrovmRunners.with.parameter.mixins"></a>

- *Type:* ...constructs.IMixin[]

The mixins to apply.

---

##### `addRunnerClass` <a name="addRunnerClass" id="cdk-github-microvm-runners.GithubMicrovmRunners.addRunnerClass"></a>

```typescript
public addRunnerClass(label: string, props: RunnerClassProps): RunnerClass
```

Register a runner class: the `runs-on` label a workflow targets, paired with the VM size, and optionally the image, that jobs carrying that label run on.

Each class builds its own image. A runner set needs at least one
class, and one that reaches synth with none fails.

Classes can be registered at any point before synth. Everything that
depends on the full set of them — which labels the webhook accepts, which
image each label launches, and the janitor's access to each class's image
— is resolved once, after the last call.

Setting `warmPoolSize` on a class keeps that many pre-booted VMs ready for
it. The first class to do so creates the warm-pool handler and its
schedule, which every later warm class then shares.

###### `label`<sup>Required</sup> <a name="label" id="cdk-github-microvm-runners.GithubMicrovmRunners.addRunnerClass.parameter.label"></a>

- *Type:* string

the `runs-on` label workflows use to target this class.

---

###### `props`<sup>Required</sup> <a name="props" id="cdk-github-microvm-runners.GithubMicrovmRunners.addRunnerClass.parameter.props"></a>

- *Type:* <a href="#cdk-github-microvm-runners.RunnerClassProps">RunnerClassProps</a>

the VM size, and optionally the image, warm pool size, and idle policy for this class.

---

##### `runnerClass` <a name="runnerClass" id="cdk-github-microvm-runners.GithubMicrovmRunners.runnerClass"></a>

```typescript
public runnerClass(label: string): RunnerClass
```

The registered `RunnerClass` carrying `label`.

Throws when no class
with that label has been registered.

###### `label`<sup>Required</sup> <a name="label" id="cdk-github-microvm-runners.GithubMicrovmRunners.runnerClass.parameter.label"></a>

- *Type:* string

the `runs-on` label the class was registered under.

---

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### `isConstruct` <a name="isConstruct" id="cdk-github-microvm-runners.GithubMicrovmRunners.isConstruct"></a>

```typescript
import { GithubMicrovmRunners } from 'cdk-github-microvm-runners'

GithubMicrovmRunners.isConstruct(x: any)
```

Checks if `x` is a construct.

Use this method instead of `instanceof` to properly detect `Construct`
instances, even when the construct library is symlinked.

Explanation: in JavaScript, multiple copies of the `constructs` library on
disk are seen as independent, completely different libraries. As a
consequence, the class `Construct` in each copy of the `constructs` library
is seen as a different class, and an instance of one class will not test as
`instanceof` the other class. `npm install` will not create installations
like this, but users may manually symlink construct libraries together or
use a monorepo tool: in those cases, multiple copies of the `constructs`
library can be accidentally installed, and `instanceof` will behave
unpredictably. It is safest to avoid using `instanceof`, and using
this type-testing method instead.

###### `x`<sup>Required</sup> <a name="x" id="cdk-github-microvm-runners.GithubMicrovmRunners.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.deadLetterQueue">deadLetterQueue</a></code> | <code>aws-cdk-lib.aws_sqs.IQueue</code> | Dead-letter queue holding job-queue messages that ran out of redrives. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.defaultImageArn">defaultImageArn</a></code> | <code>string</code> | The image a job whose labels match no registered runner class launches on: the class labelled `microvm` if one is registered, otherwise the first class registered. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.janitorFunction">janitorFunction</a></code> | <code>aws-cdk-lib.aws_lambda.IFunction</code> | The janitor Lambda, which runs the scheduled sweep. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.jobQueue">jobQueue</a></code> | <code>aws-cdk-lib.aws_sqs.IQueue</code> | Queue carrying launch and terminate intents from the webhook handler to the launcher. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.launcherFunction">launcherFunction</a></code> | <code>aws-cdk-lib.aws_lambda.IFunction</code> | The launcher Lambda, which reads the job queue and starts and terminates MicroVMs. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.metrics">metrics</a></code> | <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics">GithubMicrovmRunnersMetrics</a></code> | This runner set's CloudWatch metrics and the ready-made alarms over them. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.runnerClasses">runnerClasses</a></code> | <code><a href="#cdk-github-microvm-runners.RunnerClass">RunnerClass</a>[]</code> | Every runner class registered through `addRunnerClass`, in the order they were registered. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.runnerTable">runnerTable</a></code> | <code>aws-cdk-lib.aws_dynamodb.ITable</code> | DynamoDB table mapping each runner's name to its MicroVM, and holding the janitor's record of which VMs it already suspects. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.setupCommand">setupCommand</a></code> | <code>string</code> | The command that creates this runner set's GitHub App and writes its three secrets. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.webhookFunction">webhookFunction</a></code> | <code>aws-cdk-lib.aws_lambda.IFunction</code> | The webhook Lambda, which GitHub's deliveries reach through `webhookUrl`. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.webhookUrl">webhookUrl</a></code> | <code>string</code> | The webhook handler's public Function URL, which is the payload URL to configure on the GitHub App or webhook. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.vmConsoleLogGroup">vmConsoleLogGroup</a></code> | <code>aws-cdk-lib.aws_logs.ILogGroup</code> | Where a VM's runtime console goes when console capture is on: the group the construct created, or the one you supplied. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.vmExecutionRole">vmExecutionRole</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | The AWS identity launched MicroVMs run with, passed in as `GithubMicrovmRunnersProps.vmExecutionRole`, or `undefined` when the VMs carry no AWS identity. Console capture runs on this role and requires it. A runner set identifies its own VMs by the image they booted from, not by this role. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunners.property.warmPoolFunction">warmPoolFunction</a></code> | <code>aws-cdk-lib.aws_lambda.IFunction</code> | The Lambda that refills the warm pool, or `undefined` when no registered runner class sets `RunnerClassProps.warmPoolSize`. It is created by the first class that does, so a runner set with no warm class deploys neither this function nor its schedule. |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `deadLetterQueue`<sup>Required</sup> <a name="deadLetterQueue" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.deadLetterQueue"></a>

```typescript
public readonly deadLetterQueue: IQueue;
```

- *Type:* aws-cdk-lib.aws_sqs.IQueue

Dead-letter queue holding job-queue messages that ran out of redrives.

---

##### `defaultImageArn`<sup>Required</sup> <a name="defaultImageArn" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.defaultImageArn"></a>

```typescript
public readonly defaultImageArn: string;
```

- *Type:* string

The image a job whose labels match no registered runner class launches on: the class labelled `microvm` if one is registered, otherwise the first class registered.

Runner classes can be added right up until synth, so this
is a token that resolves once the set of them is final.

---

##### `janitorFunction`<sup>Required</sup> <a name="janitorFunction" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.janitorFunction"></a>

```typescript
public readonly janitorFunction: IFunction;
```

- *Type:* aws-cdk-lib.aws_lambda.IFunction

The janitor Lambda, which runs the scheduled sweep.

---

##### `jobQueue`<sup>Required</sup> <a name="jobQueue" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.jobQueue"></a>

```typescript
public readonly jobQueue: IQueue;
```

- *Type:* aws-cdk-lib.aws_sqs.IQueue

Queue carrying launch and terminate intents from the webhook handler to the launcher.

---

##### `launcherFunction`<sup>Required</sup> <a name="launcherFunction" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.launcherFunction"></a>

```typescript
public readonly launcherFunction: IFunction;
```

- *Type:* aws-cdk-lib.aws_lambda.IFunction

The launcher Lambda, which reads the job queue and starts and terminates MicroVMs.

---

##### `metrics`<sup>Required</sup> <a name="metrics" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.metrics"></a>

```typescript
public readonly metrics: GithubMicrovmRunnersMetrics;
```

- *Type:* <a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics">GithubMicrovmRunnersMetrics</a>

This runner set's CloudWatch metrics and the ready-made alarms over them.

---

##### `runnerClasses`<sup>Required</sup> <a name="runnerClasses" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.runnerClasses"></a>

```typescript
public readonly runnerClasses: RunnerClass[];
```

- *Type:* <a href="#cdk-github-microvm-runners.RunnerClass">RunnerClass</a>[]

Every runner class registered through `addRunnerClass`, in the order they were registered.

It is empty until the first class is added, and a
runner set that reaches synth with none fails. Each call returns a copy, so
changing the returned array does not change the runner set.

---

##### `runnerTable`<sup>Required</sup> <a name="runnerTable" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.runnerTable"></a>

```typescript
public readonly runnerTable: ITable;
```

- *Type:* aws-cdk-lib.aws_dynamodb.ITable

DynamoDB table mapping each runner's name to its MicroVM, and holding the janitor's record of which VMs it already suspects.

---

##### `setupCommand`<sup>Required</sup> <a name="setupCommand" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.setupCommand"></a>

```typescript
public readonly setupCommand: string;
```

- *Type:* string

The command that creates this runner set's GitHub App and writes its three secrets.

It carries the scope, the stack name, and the region this runner
set was built with, and is pinned to the version of this library that
produced it, so the helper and the construct agree about secret names and
stack outputs.

Surface it as a stack output and the deploy ends by printing the line to
paste. On a stack built without an explicit `env`, the region is a token
that reads as `${Token[AWS.Region.N]}` here and resolves to the real region
in the deployed output.

---

*Example*

```typescript
new cdk.CfnOutput(stack, 'SetupCommand', { value: runners.setupCommand });
```


##### `webhookFunction`<sup>Required</sup> <a name="webhookFunction" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.webhookFunction"></a>

```typescript
public readonly webhookFunction: IFunction;
```

- *Type:* aws-cdk-lib.aws_lambda.IFunction

The webhook Lambda, which GitHub's deliveries reach through `webhookUrl`.

---

##### `webhookUrl`<sup>Required</sup> <a name="webhookUrl" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.webhookUrl"></a>

```typescript
public readonly webhookUrl: string;
```

- *Type:* string

The webhook handler's public Function URL, which is the payload URL to configure on the GitHub App or webhook.

---

##### `vmConsoleLogGroup`<sup>Optional</sup> <a name="vmConsoleLogGroup" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.vmConsoleLogGroup"></a>

```typescript
public readonly vmConsoleLogGroup: ILogGroup;
```

- *Type:* aws-cdk-lib.aws_logs.ILogGroup

Where a VM's runtime console goes when console capture is on: the group the construct created, or the one you supplied.

`undefined` when console capture is off.

---

##### `vmExecutionRole`<sup>Optional</sup> <a name="vmExecutionRole" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.vmExecutionRole"></a>

```typescript
public readonly vmExecutionRole: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole

The AWS identity launched MicroVMs run with, passed in as `GithubMicrovmRunnersProps.vmExecutionRole`, or `undefined` when the VMs carry no AWS identity. Console capture runs on this role and requires it. A runner set identifies its own VMs by the image they booted from, not by this role.

---

##### `warmPoolFunction`<sup>Optional</sup> <a name="warmPoolFunction" id="cdk-github-microvm-runners.GithubMicrovmRunners.property.warmPoolFunction"></a>

```typescript
public readonly warmPoolFunction: IFunction;
```

- *Type:* aws-cdk-lib.aws_lambda.IFunction

The Lambda that refills the warm pool, or `undefined` when no registered runner class sets `RunnerClassProps.warmPoolSize`. It is created by the first class that does, so a runner set with no warm class deploys neither this function nor its schedule.

---


### ImagePipeline <a name="ImagePipeline" id="cdk-github-microvm-runners.ImagePipeline"></a>

The build behind one runner class's MicroVM image.

`addRunnerClass` creates
one for each class it registers and returns it as
`RunnerClass.imagePipeline`, so this is a handle you read rather than a
construct you instantiate.

It stages the class's Dockerfile and build context as a CDK asset, declares
the `AWS::Lambda::MicrovmImage` resource that CloudFormation builds from it,
and creates the IAM role that build runs as. Reading it is how you reach the
built image's name and ARN, and the role the build runs as.

*Example*

```typescript
const buildClass = runners.addRunnerClass('build', {
  size: MicrovmSize.GB4,
  image: RunnerImage.fromOptions({ systemPackages: ['jq'] }),
});

new cdk.CfnOutput(stack, 'BuildImageName', {
  value: buildClass.imagePipeline.imageName,
});
```


#### Initializers <a name="Initializers" id="cdk-github-microvm-runners.ImagePipeline.Initializer"></a>

```typescript
import { ImagePipeline } from 'cdk-github-microvm-runners'

new ImagePipeline(scope: Construct, id: string, props: ImagePipelineProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.ImagePipeline.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#cdk-github-microvm-runners.ImagePipeline.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-github-microvm-runners.ImagePipeline.Initializer.parameter.props">props</a></code> | <code><a href="#cdk-github-microvm-runners.ImagePipelineProps">ImagePipelineProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-github-microvm-runners.ImagePipeline.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="cdk-github-microvm-runners.ImagePipeline.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="cdk-github-microvm-runners.ImagePipeline.Initializer.parameter.props"></a>

- *Type:* <a href="#cdk-github-microvm-runners.ImagePipelineProps">ImagePipelineProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.ImagePipeline.toString">toString</a></code> | Returns a string representation of this construct. |
| <code><a href="#cdk-github-microvm-runners.ImagePipeline.with">with</a></code> | Applies one or more mixins to this construct. |

---

##### `toString` <a name="toString" id="cdk-github-microvm-runners.ImagePipeline.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

##### `with` <a name="with" id="cdk-github-microvm-runners.ImagePipeline.with"></a>

```typescript
public with(mixins: ...IMixin[]): IConstruct
```

Applies one or more mixins to this construct.

Mixins are applied in order. The list of constructs is captured at the
start of the call, so constructs added by a mixin will not be visited.
Use multiple `with()` calls if subsequent mixins should apply to added
constructs.

###### `mixins`<sup>Required</sup> <a name="mixins" id="cdk-github-microvm-runners.ImagePipeline.with.parameter.mixins"></a>

- *Type:* ...constructs.IMixin[]

The mixins to apply.

---

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.ImagePipeline.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### `isConstruct` <a name="isConstruct" id="cdk-github-microvm-runners.ImagePipeline.isConstruct"></a>

```typescript
import { ImagePipeline } from 'cdk-github-microvm-runners'

ImagePipeline.isConstruct(x: any)
```

Checks if `x` is a construct.

Use this method instead of `instanceof` to properly detect `Construct`
instances, even when the construct library is symlinked.

Explanation: in JavaScript, multiple copies of the `constructs` library on
disk are seen as independent, completely different libraries. As a
consequence, the class `Construct` in each copy of the `constructs` library
is seen as a different class, and an instance of one class will not test as
`instanceof` the other class. `npm install` will not create installations
like this, but users may manually symlink construct libraries together or
use a monorepo tool: in those cases, multiple copies of the `constructs`
library can be accidentally installed, and `instanceof` will behave
unpredictably. It is safest to avoid using `instanceof`, and using
this type-testing method instead.

###### `x`<sup>Required</sup> <a name="x" id="cdk-github-microvm-runners.ImagePipeline.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.ImagePipeline.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |
| <code><a href="#cdk-github-microvm-runners.ImagePipeline.property.buildRole">buildRole</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | IAM role the image build runs as, able to read the staged build context and pull any private container base image. |
| <code><a href="#cdk-github-microvm-runners.ImagePipeline.property.imageArn">imageArn</a></code> | <code>string</code> | ARN of the built MicroVM image. |
| <code><a href="#cdk-github-microvm-runners.ImagePipeline.property.imageName">imageName</a></code> | <code>string</code> | Name of the built MicroVM image, `<runnerSetId>-<8 hex characters of the content hash>`. |
| <code><a href="#cdk-github-microvm-runners.ImagePipeline.property.imageResource">imageResource</a></code> | <code>aws-cdk-lib.aws_lambda.CfnMicrovmImage</code> | The underlying `AWS::Lambda::MicrovmImage` resource. |

---

##### `node`<sup>Required</sup> <a name="node" id="cdk-github-microvm-runners.ImagePipeline.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---

##### `buildRole`<sup>Required</sup> <a name="buildRole" id="cdk-github-microvm-runners.ImagePipeline.property.buildRole"></a>

```typescript
public readonly buildRole: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole

IAM role the image build runs as, able to read the staged build context and pull any private container base image.

---

##### `imageArn`<sup>Required</sup> <a name="imageArn" id="cdk-github-microvm-runners.ImagePipeline.property.imageArn"></a>

```typescript
public readonly imageArn: string;
```

- *Type:* string

ARN of the built MicroVM image.

---

##### `imageName`<sup>Required</sup> <a name="imageName" id="cdk-github-microvm-runners.ImagePipeline.property.imageName"></a>

```typescript
public readonly imageName: string;
```

- *Type:* string

Name of the built MicroVM image, `<runnerSetId>-<8 hex characters of the content hash>`.

---

##### `imageResource`<sup>Required</sup> <a name="imageResource" id="cdk-github-microvm-runners.ImagePipeline.property.imageResource"></a>

```typescript
public readonly imageResource: CfnMicrovmImage;
```

- *Type:* aws-cdk-lib.aws_lambda.CfnMicrovmImage

The underlying `AWS::Lambda::MicrovmImage` resource.

---


## Structs <a name="Structs" id="Structs"></a>

### GithubAppAuthProps <a name="GithubAppAuthProps" id="cdk-github-microvm-runners.GithubAppAuthProps"></a>

Props for `GithubAuth.app`.

#### Initializer <a name="Initializer" id="cdk-github-microvm-runners.GithubAppAuthProps.Initializer"></a>

```typescript
import { GithubAppAuthProps } from 'cdk-github-microvm-runners'

const githubAppAuthProps: GithubAppAuthProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubAppAuthProps.property.appId">appId</a></code> | <code><a href="#cdk-github-microvm-runners.GithubAppId">GithubAppId</a></code> | The GitHub App's numeric ID, as a literal or a Secrets Manager reference. |
| <code><a href="#cdk-github-microvm-runners.GithubAppAuthProps.property.privateKey">privateKey</a></code> | <code><a href="#cdk-github-microvm-runners.GithubAppKey">GithubAppKey</a></code> | The App's private key, backed by a secret or a KMS key. |
| <code><a href="#cdk-github-microvm-runners.GithubAppAuthProps.property.webhookSecret">webhookSecret</a></code> | <code>aws-cdk-lib.aws_secretsmanager.ISecret</code> | Secret holding the webhook secret used to validate inbound deliveries. |

---

##### `appId`<sup>Required</sup> <a name="appId" id="cdk-github-microvm-runners.GithubAppAuthProps.property.appId"></a>

```typescript
public readonly appId: GithubAppId;
```

- *Type:* <a href="#cdk-github-microvm-runners.GithubAppId">GithubAppId</a>

The GitHub App's numeric ID, as a literal or a Secrets Manager reference.

---

##### `privateKey`<sup>Required</sup> <a name="privateKey" id="cdk-github-microvm-runners.GithubAppAuthProps.property.privateKey"></a>

```typescript
public readonly privateKey: GithubAppKey;
```

- *Type:* <a href="#cdk-github-microvm-runners.GithubAppKey">GithubAppKey</a>

The App's private key, backed by a secret or a KMS key.

---

##### `webhookSecret`<sup>Required</sup> <a name="webhookSecret" id="cdk-github-microvm-runners.GithubAppAuthProps.property.webhookSecret"></a>

```typescript
public readonly webhookSecret: ISecret;
```

- *Type:* aws-cdk-lib.aws_secretsmanager.ISecret

Secret holding the webhook secret used to validate inbound deliveries.

---

### GithubMicrovmRunnersProps <a name="GithubMicrovmRunnersProps" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps"></a>

Props for `GithubMicrovmRunners`.

#### Initializer <a name="Initializer" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.Initializer"></a>

```typescript
import { GithubMicrovmRunnersProps } from 'cdk-github-microvm-runners'

const githubMicrovmRunnersProps: GithubMicrovmRunnersProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.github">github</a></code> | <code><a href="#cdk-github-microvm-runners.GithubAuth">GithubAuth</a></code> | How the runner set authenticates to GitHub, as an App or with a personal access token. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.scope">scope</a></code> | <code><a href="#cdk-github-microvm-runners.RunnerScope">RunnerScope</a></code> | Which GitHub scope, an organization or a list of repositories, registered runners are visible to. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.additionalRegions">additionalRegions</a></code> | <code>string[]</code> | Additional regions to accept as Lambda MicroVMs regions, beyond the ones this library already knows about. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.consoleLogs">consoleLogs</a></code> | <code><a href="#cdk-github-microvm-runners.ConsoleLogs">ConsoleLogs</a></code> | Where a VM's runtime console goes: everything it prints while it boots, runs the runner agent, and runs the job. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.deadLetterRetention">deadLetterRetention</a></code> | <code>aws-cdk-lib.Duration</code> | How long the dead-letter queue retains a failed launch or terminate intent. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.emitMetrics">emitMetrics</a></code> | <code>boolean</code> | Report this runner set's CloudWatch custom metrics. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.encryptionKey">encryptionKey</a></code> | <code>aws-cdk-lib.aws_kms.IKey</code> | Customer-managed KMS key for this runner set's data at rest: the DynamoDB runner table, the SQS job queue and dead-letter queue, and any log group this construct creates. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.idleRunnerGraceSeconds">idleRunnerGraceSeconds</a></code> | <code>number</code> | How many seconds a registered runner may sit idle before the janitor's two-strike sweep treats it as stuck. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.imageLogs">imageLogs</a></code> | <code><a href="#cdk-github-microvm-runners.ImageLogs">ImageLogs</a></code> | Where build-time image logs go: the Docker build layers and the ready-probe banner from each image build. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.janitorInterval">janitorInterval</a></code> | <code>aws-cdk-lib.Duration</code> | How often the janitor sweep runs. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.keepImageVersions">keepImageVersions</a></code> | <code>number</code> | How many MicroVM image versions to keep per runner class. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.lambdaMemorySize">lambdaMemorySize</a></code> | <code>number</code> | Memory, in MiB, for the handler Lambdas: the webhook, the launcher, the janitor, and the warm pool. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.logRetention">logRetention</a></code> | <code>aws-cdk-lib.aws_logs.RetentionDays</code> | Retention for the CloudWatch log groups this construct creates: the handler Lambda log groups and, when console capture is on, the VM console group. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.maxConcurrentVms">maxConcurrentVms</a></code> | <code>number</code> | Maximum number of MicroVMs this runner set runs at once. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.maxJobDuration">maxJobDuration</a></code> | <code>aws-cdk-lib.Duration</code> | How long a job may run before its MicroVM is terminated. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.maxReceiveCount">maxReceiveCount</a></code> | <code>number</code> | How many times a launch intent is redriven before it dead-letters. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.network">network</a></code> | <code><a href="#cdk-github-microvm-runners.RunnerNetwork">RunnerNetwork</a></code> | How launched MicroVMs and image builds reach the network. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.permissionsBoundary">permissionsBoundary</a></code> | <code>aws-cdk-lib.aws_iam.IManagedPolicy</code> | Permissions boundary applied to every IAM role this construct creates: the handler execution roles, the per-class image build roles, and the network-connector operator role. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.pointInTimeRecovery">pointInTimeRecovery</a></code> | <code>boolean</code> | Turn on DynamoDB point-in-time recovery for the runner table. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.recoverStuckLaunches">recoverStuckLaunches</a></code> | <code>boolean</code> | Recover launches that dead-lettered while GitHub Actions was down. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.removalPolicy">removalPolicy</a></code> | <code>aws-cdk-lib.RemovalPolicy</code> | Removal policy for this runner set's stateful resources: the runner table and any log group the construct creates. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.vmExecutionRole">vmExecutionRole</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | An AWS identity for this runner set's runner VMs. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.warmPoolInterval">warmPoolInterval</a></code> | <code>aws-cdk-lib.Duration</code> | How often the warm-pool sweep refills pre-booted VMs. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.webhook">webhook</a></code> | <code><a href="#cdk-github-microvm-runners.WebhookEndpoint">WebhookEndpoint</a></code> | How the webhook handler is exposed to GitHub. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.webhookReservedConcurrency">webhookReservedConcurrency</a></code> | <code>number</code> | Reserved concurrency for the webhook Lambda, which caps how many webhook deliveries the runner set processes at once. |

---

##### `github`<sup>Required</sup> <a name="github" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.github"></a>

```typescript
public readonly github: GithubAuth;
```

- *Type:* <a href="#cdk-github-microvm-runners.GithubAuth">GithubAuth</a>

How the runner set authenticates to GitHub, as an App or with a personal access token.

This also carries the webhook secret.

---

##### `scope`<sup>Required</sup> <a name="scope" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.scope"></a>

```typescript
public readonly scope: RunnerScope;
```

- *Type:* <a href="#cdk-github-microvm-runners.RunnerScope">RunnerScope</a>

Which GitHub scope, an organization or a list of repositories, registered runners are visible to.

---

##### `additionalRegions`<sup>Optional</sup> <a name="additionalRegions" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.additionalRegions"></a>

```typescript
public readonly additionalRegions: string[];
```

- *Type:* string[]
- *Default:* [] (only the regions this library knows about)

Additional regions to accept as Lambda MicroVMs regions, beyond the ones this library already knows about.

Deploying into a region on neither list
fails at synth.

---

##### `consoleLogs`<sup>Optional</sup> <a name="consoleLogs" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.consoleLogs"></a>

```typescript
public readonly consoleLogs: ConsoleLogs;
```

- *Type:* <a href="#cdk-github-microvm-runners.ConsoleLogs">ConsoleLogs</a>
- *Default:* undefined (no runtime console capture)

Where a VM's runtime console goes: everything it prints while it boots, runs the runner agent, and runs the job.

`ConsoleLogs.enabled()` has the
construct create the group and expose it as `vmConsoleLogGroup`, and
`ConsoleLogs.enabled(logGroup)` uses one you control. The platform writes
these logs with the VM's own role, so this requires `vmExecutionRole`; see
`ConsoleLogs` for what that role means for job code. Independent of
`imageLogs`.

---

##### `deadLetterRetention`<sup>Optional</sup> <a name="deadLetterRetention" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.deadLetterRetention"></a>

```typescript
public readonly deadLetterRetention: Duration;
```

- *Type:* aws-cdk-lib.Duration
- *Default:* Duration.days(4) (SQS default)

How long the dead-letter queue retains a failed launch or terminate intent.

SQS allows up to 14 days, which is also how long
`recoverStuckLaunches` has to re-drive a message before SQS drops it.

---

##### `emitMetrics`<sup>Optional</sup> <a name="emitMetrics" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.emitMetrics"></a>

```typescript
public readonly emitMetrics: boolean;
```

- *Type:* boolean
- *Default:* false (no metrics emitted)

Report this runner set's CloudWatch custom metrics.

Those are the
janitor's per-sweep counters, the launcher's per-launch outcomes and
spin-up timings, and the warm pool's fill numbers — everything
`GithubMicrovmRunnersMetrics` names. With this off the handlers report
none of them.

CloudWatch bills custom metrics per metric per month, and this runner set's
bill is not a fixed number: the launcher and warm-pool metrics carry a
runner-class dimension, so each one becomes a separate billable metric per
registered runner class.

The two alarms backed by these metrics, `sweepErrorsAlarm` and
`stuckLaunchesRecoveredAlarm`, throw at synth unless this is on, since the
metric they watch would never report. `deadLetterQueueNotEmptyAlarm`
watches an SQS metric and works either way. The metric accessors on
`GithubMicrovmRunnersMetrics` return a `Metric` regardless, so a
dashboard can be built ahead of turning metrics on.

---

##### `encryptionKey`<sup>Optional</sup> <a name="encryptionKey" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.encryptionKey"></a>

```typescript
public readonly encryptionKey: IKey;
```

- *Type:* aws-cdk-lib.aws_kms.IKey
- *Default:* undefined (AWS-managed keys)

Customer-managed KMS key for this runner set's data at rest: the DynamoDB runner table, the SQS job queue and dead-letter queue, and any log group this construct creates.

Log groups you bring yourself, and the GitHub
secrets you pass in, keep their own keys.

---

##### `idleRunnerGraceSeconds`<sup>Optional</sup> <a name="idleRunnerGraceSeconds" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.idleRunnerGraceSeconds"></a>

```typescript
public readonly idleRunnerGraceSeconds: number;
```

- *Type:* number
- *Default:* 600

How many seconds a registered runner may sit idle before the janitor's two-strike sweep treats it as stuck.

---

##### `imageLogs`<sup>Optional</sup> <a name="imageLogs" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.imageLogs"></a>

```typescript
public readonly imageLogs: ImageLogs;
```

- *Type:* <a href="#cdk-github-microvm-runners.ImageLogs">ImageLogs</a>
- *Default:* undefined (no image logs)

Where build-time image logs go: the Docker build layers and the ready-probe banner from each image build.

`ImageLogs.enabled()` sends them
to the platform's own CloudWatch group, and `ImageLogs.enabled(logGroup)`
to a group whose retention and KMS key you control. These are written by
the image build role rather than by a VM, so they need no VM execution
role. Independent of `consoleLogs`.

---

##### `janitorInterval`<sup>Optional</sup> <a name="janitorInterval" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.janitorInterval"></a>

```typescript
public readonly janitorInterval: Duration;
```

- *Type:* aws-cdk-lib.Duration
- *Default:* Duration.minutes(5)

How often the janitor sweep runs.

---

##### `keepImageVersions`<sup>Optional</sup> <a name="keepImageVersions" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.keepImageVersions"></a>

```typescript
public readonly keepImageVersions: number;
```

- *Type:* number
- *Default:* 5

How many MicroVM image versions to keep per runner class.

The janitor prunes inactive versions past this count.

---

##### `lambdaMemorySize`<sup>Optional</sup> <a name="lambdaMemorySize" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.lambdaMemorySize"></a>

```typescript
public readonly lambdaMemorySize: number;
```

- *Type:* number
- *Default:* 128

Memory, in MiB, for the handler Lambdas: the webhook, the launcher, the janitor, and the warm pool.

The janitor's sweep scans the runner table and
reconciles every running VM, so it is the handler most sensitive to this
on a busy runner set.

---

##### `logRetention`<sup>Optional</sup> <a name="logRetention" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.logRetention"></a>

```typescript
public readonly logRetention: RetentionDays;
```

- *Type:* aws-cdk-lib.aws_logs.RetentionDays
- *Default:* logs.RetentionDays.TWO_WEEKS

Retention for the CloudWatch log groups this construct creates: the handler Lambda log groups and, when console capture is on, the VM console group.

---

##### `maxConcurrentVms`<sup>Optional</sup> <a name="maxConcurrentVms" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.maxConcurrentVms"></a>

```typescript
public readonly maxConcurrentVms: number;
```

- *Type:* number
- *Default:* 10

Maximum number of MicroVMs this runner set runs at once.

---

##### `maxJobDuration`<sup>Optional</sup> <a name="maxJobDuration" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.maxJobDuration"></a>

```typescript
public readonly maxJobDuration: Duration;
```

- *Type:* aws-cdk-lib.Duration
- *Default:* Duration.hours(6)

How long a job may run before its MicroVM is terminated.

The VM is killed five minutes after this value, not at it. The runner set
asks the platform for `maxJobDuration + 5 minutes`, so that a job which
reaches its own limit is stopped by the runner — which reports the timeout
to GitHub and lets the VM come down cleanly — rather than by the platform
removing the machine underneath it. Treat the five minutes as headroom for
that shutdown rather than as extra running time.

---

##### `maxReceiveCount`<sup>Optional</sup> <a name="maxReceiveCount" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.maxReceiveCount"></a>

```typescript
public readonly maxReceiveCount: number;
```

- *Type:* number
- *Default:* 20

How many times a launch intent is redriven before it dead-letters.

A
runner set already at `maxConcurrentVms` redrives capacity-rejected
launches through this same budget, so on a runner set that regularly runs
at capacity this count is how long a queued job waits before its launch is
dropped. See docs/service-quotas.md.

---

##### `network`<sup>Optional</sup> <a name="network" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.network"></a>

```typescript
public readonly network: RunnerNetwork;
```

- *Type:* <a href="#cdk-github-microvm-runners.RunnerNetwork">RunnerNetwork</a>
- *Default:* RunnerNetwork.internetEgress()

How launched MicroVMs and image builds reach the network.

---

##### `permissionsBoundary`<sup>Optional</sup> <a name="permissionsBoundary" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.permissionsBoundary"></a>

```typescript
public readonly permissionsBoundary: IManagedPolicy;
```

- *Type:* aws-cdk-lib.aws_iam.IManagedPolicy
- *Default:* undefined (no boundary)

Permissions boundary applied to every IAM role this construct creates: the handler execution roles, the per-class image build roles, and the network-connector operator role.

It is applied once at construct scope, so
roles created later also carry it — the warm-pool handler's role, and the
build role of any runner class registered after construction.

---

##### `pointInTimeRecovery`<sup>Optional</sup> <a name="pointInTimeRecovery" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.pointInTimeRecovery"></a>

```typescript
public readonly pointInTimeRecovery: boolean;
```

- *Type:* boolean
- *Default:* false

Turn on DynamoDB point-in-time recovery for the runner table.

---

##### `recoverStuckLaunches`<sup>Optional</sup> <a name="recoverStuckLaunches" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.recoverStuckLaunches"></a>

```typescript
public readonly recoverStuckLaunches: boolean;
```

- *Type:* boolean
- *Default:* false

Recover launches that dead-lettered while GitHub Actions was down.

Each
janitor sweep re-drives dead-lettered launch messages back onto the job
queue, but only for jobs GitHub still reports as queued; a launch whose job
has since completed or been cancelled is discarded rather than booting a
VM for work nobody is waiting on. Recovery happens once an outage ends,
since GitHub dispatches no jobs while it is down. The janitor counts each
recovered launch under the `stuckLaunchesRecovered` metric, which reports
when `emitMetrics` is on.

---

##### `removalPolicy`<sup>Optional</sup> <a name="removalPolicy" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.removalPolicy"></a>

```typescript
public readonly removalPolicy: RemovalPolicy;
```

- *Type:* aws-cdk-lib.RemovalPolicy
- *Default:* RemovalPolicy.DESTROY

Removal policy for this runner set's stateful resources: the runner table and any log group the construct creates.

The table holds correlation data
for VMs that are currently running, all of which the janitor can rebuild
from the MicroVM and GitHub APIs.

---

##### `vmExecutionRole`<sup>Optional</sup> <a name="vmExecutionRole" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.vmExecutionRole"></a>

```typescript
public readonly vmExecutionRole: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole
- *Default:* undefined (the VMs carry no AWS identity)

An AWS identity for this runner set's runner VMs.

By default the VMs carry
no AWS identity at all: the runner agent talks outbound to GitHub, the
just-in-time registration is pushed to the VM over a platform-authenticated
channel, and a job that needs AWS assumes its own role through GitHub OIDC.

With a role attached, the MicroVM's instance metadata service serves that
role's credentials to arbitrary job code, so every job running on this
runner set can do whatever the role can do. `consoleLogs` requires a role,
because the platform writes a VM's console output using it.

---

##### `warmPoolInterval`<sup>Optional</sup> <a name="warmPoolInterval" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.warmPoolInterval"></a>

```typescript
public readonly warmPoolInterval: Duration;
```

- *Type:* aws-cdk-lib.Duration
- *Default:* Duration.minutes(2)

How often the warm-pool sweep refills pre-booted VMs.

It applies only to
runner classes that set `RunnerClassProps.warmPoolSize`, and the warm-pool
handler and its schedule are only created once such a class is registered.
A runner set with no warm class never runs this sweep, and never reads
this value.

---

##### `webhook`<sup>Optional</sup> <a name="webhook" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.webhook"></a>

```typescript
public readonly webhook: WebhookEndpoint;
```

- *Type:* <a href="#cdk-github-microvm-runners.WebhookEndpoint">WebhookEndpoint</a>
- *Default:* WebhookEndpoint.functionUrl()

How the webhook handler is exposed to GitHub.

---

##### `webhookReservedConcurrency`<sup>Optional</sup> <a name="webhookReservedConcurrency" id="cdk-github-microvm-runners.GithubMicrovmRunnersProps.property.webhookReservedConcurrency"></a>

```typescript
public readonly webhookReservedConcurrency: number;
```

- *Type:* number
- *Default:* undefined (no reservation; the webhook draws from the shared pool)

Reserved concurrency for the webhook Lambda, which caps how many webhook deliveries the runner set processes at once.

Reserved concurrency is
carved out of the account's shared pool of unreserved concurrency, so a
runner set that sets it takes that capacity away from every other function
in the account. Must be a positive integer when set, since `0` would
disable the webhook entirely.

---

### GithubPatAuthProps <a name="GithubPatAuthProps" id="cdk-github-microvm-runners.GithubPatAuthProps"></a>

Props for `GithubAuth.pat`.

#### Initializer <a name="Initializer" id="cdk-github-microvm-runners.GithubPatAuthProps.Initializer"></a>

```typescript
import { GithubPatAuthProps } from 'cdk-github-microvm-runners'

const githubPatAuthProps: GithubPatAuthProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubPatAuthProps.property.token">token</a></code> | <code>aws-cdk-lib.aws_secretsmanager.ISecret</code> | Secret holding a GitHub personal access token. |
| <code><a href="#cdk-github-microvm-runners.GithubPatAuthProps.property.webhookSecret">webhookSecret</a></code> | <code>aws-cdk-lib.aws_secretsmanager.ISecret</code> | Secret holding the webhook secret used to validate inbound deliveries. |

---

##### `token`<sup>Required</sup> <a name="token" id="cdk-github-microvm-runners.GithubPatAuthProps.property.token"></a>

```typescript
public readonly token: ISecret;
```

- *Type:* aws-cdk-lib.aws_secretsmanager.ISecret

Secret holding a GitHub personal access token.

---

##### `webhookSecret`<sup>Required</sup> <a name="webhookSecret" id="cdk-github-microvm-runners.GithubPatAuthProps.property.webhookSecret"></a>

```typescript
public readonly webhookSecret: ISecret;
```

- *Type:* aws-cdk-lib.aws_secretsmanager.ISecret

Secret holding the webhook secret used to validate inbound deliveries.

---

### ImageAsset <a name="ImageAsset" id="cdk-github-microvm-runners.ImageAsset"></a>

One extra file or directory baked into the image.

`source` is a path on the machine running `cdk synth`. The image pipeline
reads it off disk when it stages the Docker build context, and the rendered
Dockerfile copies it to `target` inside the image.

#### Initializer <a name="Initializer" id="cdk-github-microvm-runners.ImageAsset.Initializer"></a>

```typescript
import { ImageAsset } from 'cdk-github-microvm-runners'

const imageAsset: ImageAsset = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.ImageAsset.property.source">source</a></code> | <code>string</code> | Path (file or directory) on the build machine to copy into the image. |
| <code><a href="#cdk-github-microvm-runners.ImageAsset.property.target">target</a></code> | <code>string</code> | Absolute path inside the image to copy `source` to. |

---

##### `source`<sup>Required</sup> <a name="source" id="cdk-github-microvm-runners.ImageAsset.property.source"></a>

```typescript
public readonly source: string;
```

- *Type:* string

Path (file or directory) on the build machine to copy into the image.

---

##### `target`<sup>Required</sup> <a name="target" id="cdk-github-microvm-runners.ImageAsset.property.target"></a>

```typescript
public readonly target: string;
```

- *Type:* string

Absolute path inside the image to copy `source` to.

---

### ImagePipelineProps <a name="ImagePipelineProps" id="cdk-github-microvm-runners.ImagePipelineProps"></a>

Props for `ImagePipeline`.

#### Initializer <a name="Initializer" id="cdk-github-microvm-runners.ImagePipelineProps.Initializer"></a>

```typescript
import { ImagePipelineProps } from 'cdk-github-microvm-runners'

const imagePipelineProps: ImagePipelineProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.ImagePipelineProps.property.image">image</a></code> | <code><a href="#cdk-github-microvm-runners.RunnerImage">RunnerImage</a></code> | The runner image to build: `RunnerImage.fromOptions()` for a synthesized Dockerfile, `RunnerImage.fromInline(text)` for Dockerfile text, or `RunnerImage.fromDockerfile(dir)` for a Dockerfile and build context on disk. |
| <code><a href="#cdk-github-microvm-runners.ImagePipelineProps.property.network">network</a></code> | <code><a href="#cdk-github-microvm-runners.RunnerNetwork">RunnerNetwork</a></code> | How the build and the VMs reach the network. |
| <code><a href="#cdk-github-microvm-runners.ImagePipelineProps.property.runnerSetId">runnerSetId</a></code> | <code>string</code> | Identifier for the runner set this image belongs to. |
| <code><a href="#cdk-github-microvm-runners.ImagePipelineProps.property.size">size</a></code> | <code><a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a></code> | The size the built image runs at, which becomes its memory floor. |
| <code><a href="#cdk-github-microvm-runners.ImagePipelineProps.property.baseImageVersion">baseImageVersion</a></code> | <code>string</code> | Version of the managed `al2023-1` base image to build from. |
| <code><a href="#cdk-github-microvm-runners.ImagePipelineProps.property.imageLogs">imageLogs</a></code> | <code><a href="#cdk-github-microvm-runners.ImageLogs">ImageLogs</a></code> | Where the build's logs go. |
| <code><a href="#cdk-github-microvm-runners.ImagePipelineProps.property.readyTimeoutSeconds">readyTimeoutSeconds</a></code> | <code>number</code> | Seconds the service waits for the in-VM agent's `/ready` hook before failing the image build. |
| <code><a href="#cdk-github-microvm-runners.ImagePipelineProps.property.runTimeoutSeconds">runTimeoutSeconds</a></code> | <code>number</code> | Seconds the service waits for the in-VM agent's `/run` hook to accept a launch. |

---

##### `image`<sup>Required</sup> <a name="image" id="cdk-github-microvm-runners.ImagePipelineProps.property.image"></a>

```typescript
public readonly image: RunnerImage;
```

- *Type:* <a href="#cdk-github-microvm-runners.RunnerImage">RunnerImage</a>

The runner image to build: `RunnerImage.fromOptions()` for a synthesized Dockerfile, `RunnerImage.fromInline(text)` for Dockerfile text, or `RunnerImage.fromDockerfile(dir)` for a Dockerfile and build context on disk.

---

##### `network`<sup>Required</sup> <a name="network" id="cdk-github-microvm-runners.ImagePipelineProps.property.network"></a>

```typescript
public readonly network: RunnerNetwork;
```

- *Type:* <a href="#cdk-github-microvm-runners.RunnerNetwork">RunnerNetwork</a>

How the build and the VMs reach the network.

---

##### `runnerSetId`<sup>Required</sup> <a name="runnerSetId" id="cdk-github-microvm-runners.ImagePipelineProps.property.runnerSetId"></a>

```typescript
public readonly runnerSetId: string;
```

- *Type:* string

Identifier for the runner set this image belongs to.

It is combined with
the first 8 hex characters of the image's `contentHash` to form the
image's name, so a content change publishes a new image and an unchanged
one is a no-op. Must match `^[a-zA-Z0-9-_]+$`, and must be 55 characters
or fewer so that `<runnerSetId>-<8-hex-chars>` stays within the service's
64-character name limit.

---

##### `size`<sup>Required</sup> <a name="size" id="cdk-github-microvm-runners.ImagePipelineProps.property.size"></a>

```typescript
public readonly size: MicrovmSize;
```

- *Type:* <a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a>

The size the built image runs at, which becomes its memory floor.

---

##### `baseImageVersion`<sup>Optional</sup> <a name="baseImageVersion" id="cdk-github-microvm-runners.ImagePipelineProps.property.baseImageVersion"></a>

```typescript
public readonly baseImageVersion: string;
```

- *Type:* string
- *Default:* '0'

Version of the managed `al2023-1` base image to build from.

---

##### `imageLogs`<sup>Optional</sup> <a name="imageLogs" id="cdk-github-microvm-runners.ImagePipelineProps.property.imageLogs"></a>

```typescript
public readonly imageLogs: ImageLogs;
```

- *Type:* <a href="#cdk-github-microvm-runners.ImageLogs">ImageLogs</a>

Where the build's logs go.

Left unset, the build emits no logs; `ImageLogs.enabled()` sends them to the platform's group, and `ImageLogs.enabled(logGroup)` to a group you supply.

---

##### `readyTimeoutSeconds`<sup>Optional</sup> <a name="readyTimeoutSeconds" id="cdk-github-microvm-runners.ImagePipelineProps.property.readyTimeoutSeconds"></a>

```typescript
public readonly readyTimeoutSeconds: number;
```

- *Type:* number
- *Default:* 300

Seconds the service waits for the in-VM agent's `/ready` hook before failing the image build.

---

##### `runTimeoutSeconds`<sup>Optional</sup> <a name="runTimeoutSeconds" id="cdk-github-microvm-runners.ImagePipelineProps.property.runTimeoutSeconds"></a>

```typescript
public readonly runTimeoutSeconds: number;
```

- *Type:* number
- *Default:* 60

Seconds the service waits for the in-VM agent's `/run` hook to accept a launch.

Service maximum: 60.

---

### MicrovmIdlePolicy <a name="MicrovmIdlePolicy" id="cdk-github-microvm-runners.MicrovmIdlePolicy"></a>

When the platform suspends and resumes a runner class's cold-launched VMs.

This mirrors the MicroVM service's own `idlePolicy` shape, expressed as
`Duration`s rather than raw seconds. Set it on a runner class through
`RunnerClassProps.idlePolicy`.

#### Initializer <a name="Initializer" id="cdk-github-microvm-runners.MicrovmIdlePolicy.Initializer"></a>

```typescript
import { MicrovmIdlePolicy } from 'cdk-github-microvm-runners'

const microvmIdlePolicy: MicrovmIdlePolicy = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.MicrovmIdlePolicy.property.maxIdleDuration">maxIdleDuration</a></code> | <code>aws-cdk-lib.Duration</code> | Idle time before the platform auto-suspends the VM. |
| <code><a href="#cdk-github-microvm-runners.MicrovmIdlePolicy.property.suspendedDuration">suspendedDuration</a></code> | <code>aws-cdk-lib.Duration</code> | How long a suspended VM is kept before the platform terminates it. |
| <code><a href="#cdk-github-microvm-runners.MicrovmIdlePolicy.property.autoResume">autoResume</a></code> | <code>boolean</code> | Auto-resume the VM on activity. |

---

##### `maxIdleDuration`<sup>Required</sup> <a name="maxIdleDuration" id="cdk-github-microvm-runners.MicrovmIdlePolicy.property.maxIdleDuration"></a>

```typescript
public readonly maxIdleDuration: Duration;
```

- *Type:* aws-cdk-lib.Duration

Idle time before the platform auto-suspends the VM.

---

##### `suspendedDuration`<sup>Required</sup> <a name="suspendedDuration" id="cdk-github-microvm-runners.MicrovmIdlePolicy.property.suspendedDuration"></a>

```typescript
public readonly suspendedDuration: Duration;
```

- *Type:* aws-cdk-lib.Duration

How long a suspended VM is kept before the platform terminates it.

Required. The MicroVM service rejects a launch whose idle policy omits
this value, and it offers no value meaning "keep the suspended VM
indefinitely", so every idle policy names a duration.

---

##### `autoResume`<sup>Optional</sup> <a name="autoResume" id="cdk-github-microvm-runners.MicrovmIdlePolicy.property.autoResume"></a>

```typescript
public readonly autoResume: boolean;
```

- *Type:* boolean
- *Default:* false

Auto-resume the VM on activity.

---

### RunnerAlarmOptions <a name="RunnerAlarmOptions" id="cdk-github-microvm-runners.RunnerAlarmOptions"></a>

Tuning for the ready-made alarms on `GithubMicrovmRunnersMetrics`.

#### Initializer <a name="Initializer" id="cdk-github-microvm-runners.RunnerAlarmOptions.Initializer"></a>

```typescript
import { RunnerAlarmOptions } from 'cdk-github-microvm-runners'

const runnerAlarmOptions: RunnerAlarmOptions = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerAlarmOptions.property.evaluationPeriods">evaluationPeriods</a></code> | <code>number</code> | Consecutive breaching periods before the alarm fires. |
| <code><a href="#cdk-github-microvm-runners.RunnerAlarmOptions.property.period">period</a></code> | <code>aws-cdk-lib.Duration</code> | Aggregation period for the metric. |
| <code><a href="#cdk-github-microvm-runners.RunnerAlarmOptions.property.threshold">threshold</a></code> | <code>number</code> | Value at or above which the alarm fires. |

---

##### `evaluationPeriods`<sup>Optional</sup> <a name="evaluationPeriods" id="cdk-github-microvm-runners.RunnerAlarmOptions.property.evaluationPeriods"></a>

```typescript
public readonly evaluationPeriods: number;
```

- *Type:* number
- *Default:* 1 (3 for the stuck-launch alarm)

Consecutive breaching periods before the alarm fires.

---

##### `period`<sup>Optional</sup> <a name="period" id="cdk-github-microvm-runners.RunnerAlarmOptions.property.period"></a>

```typescript
public readonly period: Duration;
```

- *Type:* aws-cdk-lib.Duration
- *Default:* Duration.minutes(5)

Aggregation period for the metric.

---

##### `threshold`<sup>Optional</sup> <a name="threshold" id="cdk-github-microvm-runners.RunnerAlarmOptions.property.threshold"></a>

```typescript
public readonly threshold: number;
```

- *Type:* number
- *Default:* 1

Value at or above which the alarm fires.

---

### RunnerClass <a name="RunnerClass" id="cdk-github-microvm-runners.RunnerClass"></a>

Handle returned by `GithubMicrovmRunners.addRunnerClass`.

#### Initializer <a name="Initializer" id="cdk-github-microvm-runners.RunnerClass.Initializer"></a>

```typescript
import { RunnerClass } from 'cdk-github-microvm-runners'

const runnerClass: RunnerClass = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerClass.property.imageArn">imageArn</a></code> | <code>string</code> | ARN of this class's built MicroVM image (a CloudFormation token at synth). |
| <code><a href="#cdk-github-microvm-runners.RunnerClass.property.imagePipeline">imagePipeline</a></code> | <code><a href="#cdk-github-microvm-runners.ImagePipeline">ImagePipeline</a></code> | The image pipeline that builds and publishes this class's MicroVM image. |
| <code><a href="#cdk-github-microvm-runners.RunnerClass.property.label">label</a></code> | <code>string</code> | The `runs-on` label workflows target to run on this class. |
| <code><a href="#cdk-github-microvm-runners.RunnerClass.property.size">size</a></code> | <code><a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a></code> | The VM memory floor this class launches at. |

---

##### `imageArn`<sup>Required</sup> <a name="imageArn" id="cdk-github-microvm-runners.RunnerClass.property.imageArn"></a>

```typescript
public readonly imageArn: string;
```

- *Type:* string

ARN of this class's built MicroVM image (a CloudFormation token at synth).

---

##### `imagePipeline`<sup>Required</sup> <a name="imagePipeline" id="cdk-github-microvm-runners.RunnerClass.property.imagePipeline"></a>

```typescript
public readonly imagePipeline: ImagePipeline;
```

- *Type:* <a href="#cdk-github-microvm-runners.ImagePipeline">ImagePipeline</a>

The image pipeline that builds and publishes this class's MicroVM image.

---

##### `label`<sup>Required</sup> <a name="label" id="cdk-github-microvm-runners.RunnerClass.property.label"></a>

```typescript
public readonly label: string;
```

- *Type:* string

The `runs-on` label workflows target to run on this class.

---

##### `size`<sup>Required</sup> <a name="size" id="cdk-github-microvm-runners.RunnerClass.property.size"></a>

```typescript
public readonly size: MicrovmSize;
```

- *Type:* <a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a>

The VM memory floor this class launches at.

---

### RunnerClassProps <a name="RunnerClassProps" id="cdk-github-microvm-runners.RunnerClassProps"></a>

Props for `GithubMicrovmRunners.addRunnerClass`.

#### Initializer <a name="Initializer" id="cdk-github-microvm-runners.RunnerClassProps.Initializer"></a>

```typescript
import { RunnerClassProps } from 'cdk-github-microvm-runners'

const runnerClassProps: RunnerClassProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerClassProps.property.size">size</a></code> | <code><a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a></code> | VM memory floor for this class. |
| <code><a href="#cdk-github-microvm-runners.RunnerClassProps.property.idlePolicy">idlePolicy</a></code> | <code><a href="#cdk-github-microvm-runners.MicrovmIdlePolicy">MicrovmIdlePolicy</a></code> | Auto-suspend and auto-resume policy for this class's cold-launched VMs. |
| <code><a href="#cdk-github-microvm-runners.RunnerClassProps.property.image">image</a></code> | <code><a href="#cdk-github-microvm-runners.RunnerImage">RunnerImage</a></code> | Image this class builds from. |
| <code><a href="#cdk-github-microvm-runners.RunnerClassProps.property.warmPoolSize">warmPoolSize</a></code> | <code>number</code> | How many pre-booted, suspended VMs to keep ready for this class. |

---

##### `size`<sup>Required</sup> <a name="size" id="cdk-github-microvm-runners.RunnerClassProps.property.size"></a>

```typescript
public readonly size: MicrovmSize;
```

- *Type:* <a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a>

VM memory floor for this class.

---

##### `idlePolicy`<sup>Optional</sup> <a name="idlePolicy" id="cdk-github-microvm-runners.RunnerClassProps.property.idlePolicy"></a>

```typescript
public readonly idlePolicy: MicrovmIdlePolicy;
```

- *Type:* <a href="#cdk-github-microvm-runners.MicrovmIdlePolicy">MicrovmIdlePolicy</a>
- *Default:* undefined (no idle policy; the platform never auto-suspends)

Auto-suspend and auto-resume policy for this class's cold-launched VMs.

Mutually exclusive with `warmPoolSize` on the same class, since both drive
the VM's suspended state; setting both throws at `addRunnerClass` time.

---

##### `image`<sup>Optional</sup> <a name="image" id="cdk-github-microvm-runners.RunnerClassProps.property.image"></a>

```typescript
public readonly image: RunnerImage;
```

- *Type:* <a href="#cdk-github-microvm-runners.RunnerImage">RunnerImage</a>
- *Default:* RunnerImage.fromOptions()

Image this class builds from.

---

##### `warmPoolSize`<sup>Optional</sup> <a name="warmPoolSize" id="cdk-github-microvm-runners.RunnerClassProps.property.warmPoolSize"></a>

```typescript
public readonly warmPoolSize: number;
```

- *Type:* number
- *Default:* undefined (no warm pool; every job cold-launches)

How many pre-booted, suspended VMs to keep ready for this class.

A job
that matches this class resumes one of them instead of cold-launching a
new VM, and falls back to a cold launch when none is available. This is a
count, not a flag: `warmPoolSize: 3` keeps three VMs ready. The runner set
refills the pool on the `warmPoolInterval` schedule.

---

### RunnerImageOptions <a name="RunnerImageOptions" id="cdk-github-microvm-runners.RunnerImageOptions"></a>

Options for `RunnerImage.fromOptions`.

#### Initializer <a name="Initializer" id="cdk-github-microvm-runners.RunnerImageOptions.Initializer"></a>

```typescript
import { RunnerImageOptions } from 'cdk-github-microvm-runners'

const runnerImageOptions: RunnerImageOptions = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerImageOptions.property.additionalOsCapabilities">additionalOsCapabilities</a></code> | <code>string[]</code> | Extra Linux capabilities granted to the MicroVM's operating system. |
| <code><a href="#cdk-github-microvm-runners.RunnerImageOptions.property.assets">assets</a></code> | <code><a href="#cdk-github-microvm-runners.ImageAsset">ImageAsset</a>[]</code> | Extra files and directories to copy into the image. |
| <code><a href="#cdk-github-microvm-runners.RunnerImageOptions.property.environment">environment</a></code> | <code>{[ key: string ]: string}</code> | Extra environment variables baked into the image. |
| <code><a href="#cdk-github-microvm-runners.RunnerImageOptions.property.runnerVersion">runnerVersion</a></code> | <code><a href="#cdk-github-microvm-runners.RunnerVersion">RunnerVersion</a></code> | `actions/runner` release to install. |
| <code><a href="#cdk-github-microvm-runners.RunnerImageOptions.property.setupCommands">setupCommands</a></code> | <code>string[]</code> | Extra `RUN` commands, executed in order after packages, assets, and environment variables are laid down. |
| <code><a href="#cdk-github-microvm-runners.RunnerImageOptions.property.systemPackages">systemPackages</a></code> | <code>string[]</code> | Extra `dnf` packages to install alongside the fixed base set. |
| <code><a href="#cdk-github-microvm-runners.RunnerImageOptions.property.toolchains">toolchains</a></code> | <code><a href="#cdk-github-microvm-runners.RunnerToolchain">RunnerToolchain</a>[]</code> | Language runtimes to bake into the hosted tool cache, so `actions/setup-*` finds them without downloading anything. |
| <code><a href="#cdk-github-microvm-runners.RunnerImageOptions.property.warmPaths">warmPaths</a></code> | <code>string[]</code> | Paths the in-VM agent pages into memory during the boot handshake, before any job runs. Directories are walked. |

---

##### `additionalOsCapabilities`<sup>Optional</sup> <a name="additionalOsCapabilities" id="cdk-github-microvm-runners.RunnerImageOptions.property.additionalOsCapabilities"></a>

```typescript
public readonly additionalOsCapabilities: string[];
```

- *Type:* string[]
- *Default:* ['ALL']

Extra Linux capabilities granted to the MicroVM's operating system.

---

##### `assets`<sup>Optional</sup> <a name="assets" id="cdk-github-microvm-runners.RunnerImageOptions.property.assets"></a>

```typescript
public readonly assets: ImageAsset[];
```

- *Type:* <a href="#cdk-github-microvm-runners.ImageAsset">ImageAsset</a>[]

Extra files and directories to copy into the image.

---

##### `environment`<sup>Optional</sup> <a name="environment" id="cdk-github-microvm-runners.RunnerImageOptions.property.environment"></a>

```typescript
public readonly environment: {[ key: string ]: string};
```

- *Type:* {[ key: string ]: string}

Extra environment variables baked into the image.

---

##### `runnerVersion`<sup>Optional</sup> <a name="runnerVersion" id="cdk-github-microvm-runners.RunnerImageOptions.property.runnerVersion"></a>

```typescript
public readonly runnerVersion: RunnerVersion;
```

- *Type:* <a href="#cdk-github-microvm-runners.RunnerVersion">RunnerVersion</a>
- *Default:* RunnerVersion.latest()

`actions/runner` release to install.

---

##### `setupCommands`<sup>Optional</sup> <a name="setupCommands" id="cdk-github-microvm-runners.RunnerImageOptions.property.setupCommands"></a>

```typescript
public readonly setupCommands: string[];
```

- *Type:* string[]

Extra `RUN` commands, executed in order after packages, assets, and environment variables are laid down.

---

##### `systemPackages`<sup>Optional</sup> <a name="systemPackages" id="cdk-github-microvm-runners.RunnerImageOptions.property.systemPackages"></a>

```typescript
public readonly systemPackages: string[];
```

- *Type:* string[]

Extra `dnf` packages to install alongside the fixed base set.

---

##### `toolchains`<sup>Optional</sup> <a name="toolchains" id="cdk-github-microvm-runners.RunnerImageOptions.property.toolchains"></a>

```typescript
public readonly toolchains: RunnerToolchain[];
```

- *Type:* <a href="#cdk-github-microvm-runners.RunnerToolchain">RunnerToolchain</a>[]
- *Default:* []

Language runtimes to bake into the hosted tool cache, so `actions/setup-*` finds them without downloading anything.

An image with none of these is smaller; one toolchain entry is needed per version your workflows ask for.

---

##### `warmPaths`<sup>Optional</sup> <a name="warmPaths" id="cdk-github-microvm-runners.RunnerImageOptions.property.warmPaths"></a>

```typescript
public readonly warmPaths: string[];
```

- *Type:* string[]
- *Default:* ['/usr/bin/node', '/usr/bin/git', '/opt/runner']

Paths the in-VM agent pages into memory during the boot handshake, before any job runs. Directories are walked.

A MicroVM's pages fault in on first access, so the first run of a binary
costs far more than the second — enough that `actions/checkout` spends most
of its time waiting for `node` to page in. Warming moves that cost into the
idle window between boot and job assignment.

Point this at the interpreters and tools your jobs reach for first. Set it
to `[]` to turn warming off entirely.

---

### RunnerNetworkVpcOptions <a name="RunnerNetworkVpcOptions" id="cdk-github-microvm-runners.RunnerNetworkVpcOptions"></a>

Options for `RunnerNetwork.vpc`.

#### Initializer <a name="Initializer" id="cdk-github-microvm-runners.RunnerNetworkVpcOptions.Initializer"></a>

```typescript
import { RunnerNetworkVpcOptions } from 'cdk-github-microvm-runners'

const runnerNetworkVpcOptions: RunnerNetworkVpcOptions = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerNetworkVpcOptions.property.securityGroups">securityGroups</a></code> | <code>aws-cdk-lib.aws_ec2.ISecurityGroup[]</code> | Security groups attached to the connector's ENIs. |
| <code><a href="#cdk-github-microvm-runners.RunnerNetworkVpcOptions.property.subnets">subnets</a></code> | <code>aws-cdk-lib.aws_ec2.SubnetSelection</code> | Which of the VPC's subnets the connector's ENIs land in. |

---

##### `securityGroups`<sup>Optional</sup> <a name="securityGroups" id="cdk-github-microvm-runners.RunnerNetworkVpcOptions.property.securityGroups"></a>

```typescript
public readonly securityGroups: ISecurityGroup[];
```

- *Type:* aws-cdk-lib.aws_ec2.ISecurityGroup[]
- *Default:* a new security group is created on the VPC

Security groups attached to the connector's ENIs.

---

##### `subnets`<sup>Optional</sup> <a name="subnets" id="cdk-github-microvm-runners.RunnerNetworkVpcOptions.property.subnets"></a>

```typescript
public readonly subnets: SubnetSelection;
```

- *Type:* aws-cdk-lib.aws_ec2.SubnetSelection
- *Default:* the VPC's private-with-egress subnets (CDK's `selectSubnets()` default; falls back to isolated, then public, subnets if the VPC has none of the preceding kind)

Which of the VPC's subnets the connector's ENIs land in.

---

## Classes <a name="Classes" id="Classes"></a>

### ConsoleLogs <a name="ConsoleLogs" id="cdk-github-microvm-runners.ConsoleLogs"></a>

Runtime console capture for a runner set: everything a VM prints while it boots, runs the runner agent, and runs the job.

Off unless you add it.

Console capture needs a VM execution role. The platform writes these logs
with the VM's own role, and the construct never creates a VM identity on
your behalf, so a runner set that turns console capture on without
`vmExecutionRole` fails at synth. The two console-write actions on the group
are granted by you as well, since the construct does not add policy to a
role it did not create:

```ts
runners.vmConsoleLogGroup!.grant(
  role, 'logs:CreateLogStream', 'logs:PutLogEvents',
);
```

A MicroVM's instance metadata service serves the execution role's
credentials to arbitrary job code, so whatever that role can do, every job
running on this runner set can do. Console capture on its own needs nothing
beyond the two log-write actions above. Job code can also write whatever it
likes into the console group, so the contents are as trustworthy as the jobs
that produced them.

`ImageLogs` covers the build-time counterpart and needs no role. The two are
independent and can both be on.

*Example*

```typescript
new GithubMicrovmRunners(stack, 'Runners', {
  github,
  scope,
  vmExecutionRole: role,
  consoleLogs: ConsoleLogs.enabled(),
});
```



#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.ConsoleLogs.enabled">enabled</a></code> | Capture the runtime console. |

---

##### `enabled` <a name="enabled" id="cdk-github-microvm-runners.ConsoleLogs.enabled"></a>

```typescript
import { ConsoleLogs } from 'cdk-github-microvm-runners'

ConsoleLogs.enabled(logGroup?: ILogGroup)
```

Capture the runtime console.

With no argument the construct creates a log
group and exposes it as `runners.vmConsoleLogGroup`. Pass an `ILogGroup`
to use one whose retention and KMS key you control. Either way the runner
set needs `vmExecutionRole`, and that role needs the two console-write
actions on the group.

*Example*

```typescript
const consoleCapture = ConsoleLogs.enabled(myConsoleLogGroup);
```


###### `logGroup`<sup>Optional</sup> <a name="logGroup" id="cdk-github-microvm-runners.ConsoleLogs.enabled.parameter.logGroup"></a>

- *Type:* aws-cdk-lib.aws_logs.ILogGroup

destination group.

Omitted, the construct creates one with
the runner set's `logRetention` (two weeks by default).

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.ConsoleLogs.property.logGroup">logGroup</a></code> | <code>aws-cdk-lib.aws_logs.ILogGroup</code> | The group console output goes to, when one was passed to `ConsoleLogs.enabled()`. `undefined` means the construct creates one. |

---

##### `logGroup`<sup>Optional</sup> <a name="logGroup" id="cdk-github-microvm-runners.ConsoleLogs.property.logGroup"></a>

```typescript
public readonly logGroup: ILogGroup;
```

- *Type:* aws-cdk-lib.aws_logs.ILogGroup

The group console output goes to, when one was passed to `ConsoleLogs.enabled()`. `undefined` means the construct creates one.

---


### GithubAppId <a name="GithubAppId" id="cdk-github-microvm-runners.GithubAppId"></a>

Where a GitHub App's numeric ID comes from: a literal known at synth time, or a Secrets Manager secret read at runtime.

The secret form makes setup single-pass. A GitHub App can only be created
once the runner set's webhook URL exists, so an App ID that has to be known
at synth means deploying twice. Referencing the ID by secret, the way the
private key and webhook secret already are, lets you deploy, then create the
App and write its ID into the secret, with no redeploy.

Build one with the static factories below; the constructor is private.

*Example*

```typescript
const appId = GithubAppId.fromSecret(
  Secret.fromSecretNameV2(stack, 'AppId', 'microvm-runner/dev/app-id'),
);
```



#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubAppId.fromSecret">fromSecret</a></code> | The App ID is read at runtime from a Secrets Manager secret whose value is the numeric ID. |
| <code><a href="#cdk-github-microvm-runners.GithubAppId.fromValue">fromValue</a></code> | The App ID is a literal string known at synth time. |

---

##### `fromSecret` <a name="fromSecret" id="cdk-github-microvm-runners.GithubAppId.fromSecret"></a>

```typescript
import { GithubAppId } from 'cdk-github-microvm-runners'

GithubAppId.fromSecret(secret: ISecret)
```

The App ID is read at runtime from a Secrets Manager secret whose value is the numeric ID.

The secret need not exist at deploy time.

*Example*

```typescript
const appId = GithubAppId.fromSecret(
  Secret.fromSecretNameV2(stack, 'AppId', 'microvm-runner/dev/app-id'),
);
```


###### `secret`<sup>Required</sup> <a name="secret" id="cdk-github-microvm-runners.GithubAppId.fromSecret.parameter.secret"></a>

- *Type:* aws-cdk-lib.aws_secretsmanager.ISecret

---

##### `fromValue` <a name="fromValue" id="cdk-github-microvm-runners.GithubAppId.fromValue"></a>

```typescript
import { GithubAppId } from 'cdk-github-microvm-runners'

GithubAppId.fromValue(value: string)
```

The App ID is a literal string known at synth time.

*Example*

```typescript
const appId = GithubAppId.fromValue('123456');
```


###### `value`<sup>Required</sup> <a name="value" id="cdk-github-microvm-runners.GithubAppId.fromValue.parameter.value"></a>

- *Type:* string

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubAppId.property.secret">secret</a></code> | <code>aws-cdk-lib.aws_secretsmanager.ISecret</code> | The secret holding the ID, for an ID built with `fromSecret()`. |
| <code><a href="#cdk-github-microvm-runners.GithubAppId.property.value">value</a></code> | <code>string</code> | The literal ID, for an ID built with `fromValue()`. |

---

##### `secret`<sup>Optional</sup> <a name="secret" id="cdk-github-microvm-runners.GithubAppId.property.secret"></a>

```typescript
public readonly secret: ISecret;
```

- *Type:* aws-cdk-lib.aws_secretsmanager.ISecret

The secret holding the ID, for an ID built with `fromSecret()`.

---

##### `value`<sup>Optional</sup> <a name="value" id="cdk-github-microvm-runners.GithubAppId.property.value"></a>

```typescript
public readonly value: string;
```

- *Type:* string

The literal ID, for an ID built with `fromValue()`.

---


### GithubAppKey <a name="GithubAppKey" id="cdk-github-microvm-runners.GithubAppKey"></a>

Where a GitHub App's private key lives: a Secrets Manager secret holding the PEM, or a KMS key that signs the App's JWTs directly.

Build one with the static factories below; the constructor is private.

*Example*

```typescript
const privateKey = GithubAppKey.fromSecret(
  Secret.fromSecretNameV2(stack, 'AppKey', 'microvm-runner/dev/app-private-key'),
);
```



#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubAppKey.fromKmsKey">fromKmsKey</a></code> | The App's private key lives in KMS and is used via `kms:Sign`. |
| <code><a href="#cdk-github-microvm-runners.GithubAppKey.fromSecret">fromSecret</a></code> | The App's private key is stored as a PEM in Secrets Manager. |

---

##### `fromKmsKey` <a name="fromKmsKey" id="cdk-github-microvm-runners.GithubAppKey.fromKmsKey"></a>

```typescript
import { GithubAppKey } from 'cdk-github-microvm-runners'

GithubAppKey.fromKmsKey(key: IKey)
```

The App's private key lives in KMS and is used via `kms:Sign`.

*Example*

```typescript
import { Key } from 'aws-cdk-lib/aws-kms';

const privateKey = GithubAppKey.fromKmsKey(
  Key.fromKeyArn(
    stack,
    'AppKey',
    'arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab',
  ),
);
```


###### `key`<sup>Required</sup> <a name="key" id="cdk-github-microvm-runners.GithubAppKey.fromKmsKey.parameter.key"></a>

- *Type:* aws-cdk-lib.aws_kms.IKey

---

##### `fromSecret` <a name="fromSecret" id="cdk-github-microvm-runners.GithubAppKey.fromSecret"></a>

```typescript
import { GithubAppKey } from 'cdk-github-microvm-runners'

GithubAppKey.fromSecret(secret: ISecret)
```

The App's private key is stored as a PEM in Secrets Manager.

*Example*

```typescript
const privateKey = GithubAppKey.fromSecret(
  Secret.fromSecretNameV2(stack, 'AppKey', 'microvm-runner/dev/app-private-key'),
);
```


###### `secret`<sup>Required</sup> <a name="secret" id="cdk-github-microvm-runners.GithubAppKey.fromSecret.parameter.secret"></a>

- *Type:* aws-cdk-lib.aws_secretsmanager.ISecret

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubAppKey.property.kmsKey">kmsKey</a></code> | <code>aws-cdk-lib.aws_kms.IKey</code> | The signing key, for a key built with `fromKmsKey()`. |
| <code><a href="#cdk-github-microvm-runners.GithubAppKey.property.secret">secret</a></code> | <code>aws-cdk-lib.aws_secretsmanager.ISecret</code> | The secret holding the PEM, for a key built with `fromSecret()`. |

---

##### `kmsKey`<sup>Optional</sup> <a name="kmsKey" id="cdk-github-microvm-runners.GithubAppKey.property.kmsKey"></a>

```typescript
public readonly kmsKey: IKey;
```

- *Type:* aws-cdk-lib.aws_kms.IKey

The signing key, for a key built with `fromKmsKey()`.

---

##### `secret`<sup>Optional</sup> <a name="secret" id="cdk-github-microvm-runners.GithubAppKey.property.secret"></a>

```typescript
public readonly secret: ISecret;
```

- *Type:* aws-cdk-lib.aws_secretsmanager.ISecret

The secret holding the PEM, for a key built with `fromSecret()`.

---


### GithubAuth <a name="GithubAuth" id="cdk-github-microvm-runners.GithubAuth"></a>

How a runner set authenticates to GitHub: as a GitHub App, whose private key is backed by a secret or a KMS key, or with a personal access token.

Either
form also carries the webhook secret that inbound GitHub deliveries are
validated against.

Build one with the static factories below; the constructor is private.

*Example*

```typescript
const auth = GithubAuth.app({
  appId: GithubAppId.fromSecret(
    Secret.fromSecretNameV2(stack, 'AppId', 'microvm-runner/dev/app-id'),
  ),
  privateKey: GithubAppKey.fromSecret(
    Secret.fromSecretNameV2(stack, 'AppKey', 'microvm-runner/dev/app-private-key'),
  ),
  webhookSecret: Secret.fromSecretNameV2(
    stack, 'WebhookSecret', 'microvm-runner/dev/webhook-secret',
  ),
});
```


#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubAuth.bindEnv">bindEnv</a></code> | Serialize to the environment variables the runner set's handlers read: `GH_AUTH_KIND`, `GH_APP_ID` or `GH_APP_ID_SECRET_ARN`, `GH_KEY_SECRET_ARN` or `GH_KEY_KMS_ARN`, `GH_PAT_SECRET_ARN`, and `GH_WEBHOOK_SECRET_ARN`. |
| <code><a href="#cdk-github-microvm-runners.GithubAuth.grantRead">grantRead</a></code> | Grant `grantee` read access to whichever credentials this auth carries: the App's secret-backed key and/or `kms:Sign` on its KMS key, plus its secret-backed App ID when one is used, or the PAT secret — plus, in every case, read access to the webhook secret. |
| <code><a href="#cdk-github-microvm-runners.GithubAuth.grantReadWebhookSecret">grantReadWebhookSecret</a></code> | Grant `grantee` read access to the webhook secret, and nothing else. |

---

##### `bindEnv` <a name="bindEnv" id="cdk-github-microvm-runners.GithubAuth.bindEnv"></a>

```typescript
public bindEnv(): {[ key: string ]: string}
```

Serialize to the environment variables the runner set's handlers read: `GH_AUTH_KIND`, `GH_APP_ID` or `GH_APP_ID_SECRET_ARN`, `GH_KEY_SECRET_ARN` or `GH_KEY_KMS_ARN`, `GH_PAT_SECRET_ARN`, and `GH_WEBHOOK_SECRET_ARN`.

Entries that do not apply are left out.

##### `grantRead` <a name="grantRead" id="cdk-github-microvm-runners.GithubAuth.grantRead"></a>

```typescript
public grantRead(grantee: IGrantable): void
```

Grant `grantee` read access to whichever credentials this auth carries: the App's secret-backed key and/or `kms:Sign` on its KMS key, plus its secret-backed App ID when one is used, or the PAT secret — plus, in every case, read access to the webhook secret.

This is the full set, for a handler that has to act as the App. A handler
that only verifies signatures wants {@link grantReadWebhookSecret}.

###### `grantee`<sup>Required</sup> <a name="grantee" id="cdk-github-microvm-runners.GithubAuth.grantRead.parameter.grantee"></a>

- *Type:* aws-cdk-lib.aws_iam.IGrantable

---

##### `grantReadWebhookSecret` <a name="grantReadWebhookSecret" id="cdk-github-microvm-runners.GithubAuth.grantReadWebhookSecret"></a>

```typescript
public grantReadWebhookSecret(grantee: IGrantable): void
```

Grant `grantee` read access to the webhook secret, and nothing else.

This is all a handler needs to verify the HMAC signature GitHub sends with
every delivery. It is deliberately separate from {@link grantRead}, which
also hands over the credentials that can act AS the App — minting
installation tokens, registering runners. A component that only checks
signatures and enqueues has no use for those, and the webhook handler is
the one component reachable from the public internet.

*Example*

```typescript
github.grantReadWebhookSecret(role);
```


###### `grantee`<sup>Required</sup> <a name="grantee" id="cdk-github-microvm-runners.GithubAuth.grantReadWebhookSecret.parameter.grantee"></a>

- *Type:* aws-cdk-lib.aws_iam.IGrantable

---

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubAuth.app">app</a></code> | Authenticate as a GitHub App. |
| <code><a href="#cdk-github-microvm-runners.GithubAuth.pat">pat</a></code> | Authenticate with a personal access token. |

---

##### `app` <a name="app" id="cdk-github-microvm-runners.GithubAuth.app"></a>

```typescript
import { GithubAuth } from 'cdk-github-microvm-runners'

GithubAuth.app(props: GithubAppAuthProps)
```

Authenticate as a GitHub App.

*Example*

```typescript
const auth = GithubAuth.app({
  appId: GithubAppId.fromSecret(
    Secret.fromSecretNameV2(stack, 'AppId', 'microvm-runner/dev/app-id'),
  ),
  privateKey: GithubAppKey.fromSecret(
    Secret.fromSecretNameV2(stack, 'AppKey', 'microvm-runner/dev/app-private-key'),
  ),
  webhookSecret: Secret.fromSecretNameV2(
    stack, 'WebhookSecret', 'microvm-runner/dev/webhook-secret',
  ),
});
```


###### `props`<sup>Required</sup> <a name="props" id="cdk-github-microvm-runners.GithubAuth.app.parameter.props"></a>

- *Type:* <a href="#cdk-github-microvm-runners.GithubAppAuthProps">GithubAppAuthProps</a>

---

##### `pat` <a name="pat" id="cdk-github-microvm-runners.GithubAuth.pat"></a>

```typescript
import { GithubAuth } from 'cdk-github-microvm-runners'

GithubAuth.pat(props: GithubPatAuthProps)
```

Authenticate with a personal access token.

*Example*

```typescript
const auth = GithubAuth.pat({
  token: Secret.fromSecretNameV2(stack, 'Pat', 'microvm-runner/dev/token'),
  webhookSecret: Secret.fromSecretNameV2(
    stack, 'WebhookSecret', 'microvm-runner/dev/webhook-secret',
  ),
});
```


###### `props`<sup>Required</sup> <a name="props" id="cdk-github-microvm-runners.GithubAuth.pat.parameter.props"></a>

- *Type:* <a href="#cdk-github-microvm-runners.GithubPatAuthProps">GithubPatAuthProps</a>

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubAuth.property.kind">kind</a></code> | <code><a href="#cdk-github-microvm-runners.GithubAuthKind">GithubAuthKind</a></code> | Whether this is App or personal-access-token authentication. |
| <code><a href="#cdk-github-microvm-runners.GithubAuth.property.webhookSecret">webhookSecret</a></code> | <code>aws-cdk-lib.aws_secretsmanager.ISecret</code> | Secret holding the webhook secret inbound deliveries are validated against. |
| <code><a href="#cdk-github-microvm-runners.GithubAuth.property.appId">appId</a></code> | <code><a href="#cdk-github-microvm-runners.GithubAppId">GithubAppId</a></code> | The App's ID, for App authentication. |
| <code><a href="#cdk-github-microvm-runners.GithubAuth.property.privateKey">privateKey</a></code> | <code><a href="#cdk-github-microvm-runners.GithubAppKey">GithubAppKey</a></code> | The App's private key, for App authentication. |
| <code><a href="#cdk-github-microvm-runners.GithubAuth.property.token">token</a></code> | <code>aws-cdk-lib.aws_secretsmanager.ISecret</code> | The personal access token secret, for token authentication. |

---

##### `kind`<sup>Required</sup> <a name="kind" id="cdk-github-microvm-runners.GithubAuth.property.kind"></a>

```typescript
public readonly kind: GithubAuthKind;
```

- *Type:* <a href="#cdk-github-microvm-runners.GithubAuthKind">GithubAuthKind</a>

Whether this is App or personal-access-token authentication.

---

##### `webhookSecret`<sup>Required</sup> <a name="webhookSecret" id="cdk-github-microvm-runners.GithubAuth.property.webhookSecret"></a>

```typescript
public readonly webhookSecret: ISecret;
```

- *Type:* aws-cdk-lib.aws_secretsmanager.ISecret

Secret holding the webhook secret inbound deliveries are validated against.

---

##### `appId`<sup>Optional</sup> <a name="appId" id="cdk-github-microvm-runners.GithubAuth.property.appId"></a>

```typescript
public readonly appId: GithubAppId;
```

- *Type:* <a href="#cdk-github-microvm-runners.GithubAppId">GithubAppId</a>

The App's ID, for App authentication.

---

##### `privateKey`<sup>Optional</sup> <a name="privateKey" id="cdk-github-microvm-runners.GithubAuth.property.privateKey"></a>

```typescript
public readonly privateKey: GithubAppKey;
```

- *Type:* <a href="#cdk-github-microvm-runners.GithubAppKey">GithubAppKey</a>

The App's private key, for App authentication.

---

##### `token`<sup>Optional</sup> <a name="token" id="cdk-github-microvm-runners.GithubAuth.property.token"></a>

```typescript
public readonly token: ISecret;
```

- *Type:* aws-cdk-lib.aws_secretsmanager.ISecret

The personal access token secret, for token authentication.

---


### GithubMicrovmRunnersMetrics <a name="GithubMicrovmRunnersMetrics" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics"></a>

The CloudWatch metrics a runner set reports, and ready-made alarms over them. A `GithubMicrovmRunners` exposes its own as `runners.metrics`.

The metrics live in the `MicrovmRunners` namespace, tagged with the runner
set's id. The janitor reports one set of counters per sweep, the launcher
one per launch, and the warm pool one per refill sweep. Launcher and
warm-pool metrics are also tagged with the runner class the launch belongs
to, which is why those accessors take a runner-class label. Every method
here names one of those metrics, or the dead-letter queue's own SQS metric;
the class carries no data of its own.

Everything except `deadLetterQueueDepth` reports only when
`GithubMicrovmRunnersProps.emitMetrics` is on. The accessors return a
`Metric` either way, so a dashboard can be built ahead of turning metrics
on. The two alarms over those metrics throw at synth instead, rather than
synthesizing an alarm that could never fire.

*Example*

```typescript
new cw.Alarm(stack, 'SweepErrors', {
  metric: runners.metrics.errors(),
  threshold: 1,
  evaluationPeriods: 1,
});
```


#### Initializers <a name="Initializers" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.Initializer"></a>

```typescript
import { GithubMicrovmRunnersMetrics } from 'cdk-github-microvm-runners'

new GithubMicrovmRunnersMetrics(runnerSetId: string, deadLetterQueue: IQueue, emitMetrics?: boolean)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.Initializer.parameter.runnerSetId">runnerSetId</a></code> | <code>string</code> | *No description.* |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.Initializer.parameter.deadLetterQueue">deadLetterQueue</a></code> | <code>aws-cdk-lib.aws_sqs.IQueue</code> | *No description.* |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.Initializer.parameter.emitMetrics">emitMetrics</a></code> | <code>boolean</code> | Whether the runner set reports the metrics this class names, which is `GithubMicrovmRunnersProps.emitMetrics`. Every accessor except `deadLetterQueueDepth` depends on it, though they all return a `Metric` either way; only the two alarms over those metrics refuse to synthesize. |

---

##### `runnerSetId`<sup>Required</sup> <a name="runnerSetId" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.Initializer.parameter.runnerSetId"></a>

- *Type:* string

---

##### `deadLetterQueue`<sup>Required</sup> <a name="deadLetterQueue" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.Initializer.parameter.deadLetterQueue"></a>

- *Type:* aws-cdk-lib.aws_sqs.IQueue

---

##### `emitMetrics`<sup>Optional</sup> <a name="emitMetrics" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.Initializer.parameter.emitMetrics"></a>

- *Type:* boolean

Whether the runner set reports the metrics this class names, which is `GithubMicrovmRunnersProps.emitMetrics`. Every accessor except `deadLetterQueueDepth` depends on it, though they all return a `Metric` either way; only the two alarms over those metrics refuse to synthesize.

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.cancelledBeforeLaunch">cancelledBeforeLaunch</a></code> | Launches skipped because the job had already stopped waiting for a runner by the time the launch was processed — cancelled, or its run deleted. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.capacityRejected">capacityRejected</a></code> | Launches the MicroVM service rejected for capacity. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.coldBoot">coldBoot</a></code> | Launches served by booting a new VM, because no warm VM was available or the class keeps no warm pool. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.coldSpinUpMs">coldSpinUpMs</a></code> | Milliseconds to spin up a cold launch: starting the VM, waiting for it to boot, and pushing the runner's registration. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.deadLetterQueueDepth">deadLetterQueueDepth</a></code> | Messages sitting in the dead-letter queue: a launch or terminate intent SQS gave up redriving. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.deadLetterQueueNotEmptyAlarm">deadLetterQueueNotEmptyAlarm</a></code> | Alarm when the dead-letter queue is not empty, meaning SQS gave up redriving a launch or terminate intent. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.errors">errors</a></code> | Janitor sweep count: failures on individual VMs, rows, or image versions during a sweep. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.imageVersionsPruned">imageVersionsPruned</a></code> | Janitor sweep count: inactive MicroVM image versions pruned past `keepImageVersions`. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.lifetimeKills">lifetimeKills</a></code> | Janitor sweep count: VMs terminated for having run longer than `maxJobDuration` plus the platform's own grace. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.orphansReaped">orphansReaped</a></code> | Janitor sweep count: running VMs that belong to this runner set but have no row in the runner table, reaped once a second sweep has seen the same VM unaccounted for. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.poolCurrent">poolCurrent</a></code> | Warm VMs suspended and available for this class as of the last warm-pool sweep. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.poolLaunched">poolLaunched</a></code> | Warm VMs the last warm-pool sweep launched to reach `warmPoolSize`. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.poolLaunchFailed">poolLaunchFailed</a></code> | Warm-VM launches a warm-pool sweep attempted and failed. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.poolTarget">poolTarget</a></code> | This class's `warmPoolSize`, as the last warm-pool sweep read it. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.stuckClaimsRelaunched">stuckClaimsRelaunched</a></code> | Janitor sweep count: launches that were claimed but never served, re-launched from the orphaned claim. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.stuckLaunchesRecovered">stuckLaunchesRecovered</a></code> | Janitor sweep count: dead-lettered launches re-driven onto the job queue, which is 0 unless `recoverStuckLaunches` is on. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.stuckLaunchesRecoveredAlarm">stuckLaunchesRecoveredAlarm</a></code> | Alarm on stuck-launch recoveries, the dead-lettered launches the janitor re-drove, which only happens with `recoverStuckLaunches` on. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.stuckRunnersReaped">stuckRunnersReaped</a></code> | Janitor sweep count: runners that registered with GitHub and then sat idle past `idleRunnerGraceSeconds`, reaped once a second sweep has seen them the same way. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.suspectsCleared">suspectsCleared</a></code> | Janitor sweep count: VMs an earlier sweep had marked as suspect, cleared because this sweep found them accounted for or working again. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.sweepErrorsAlarm">sweepErrorsAlarm</a></code> | Alarm on janitor sweep errors, the per-item failures a sweep isolates and continues past. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.tableRowsCleaned">tableRowsCleaned</a></code> | Janitor sweep count: runner table rows deleted, either because the VM they name is confirmed gone or because a real row superseded an orphaned one. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.warmHit">warmHit</a></code> | Launches served from the warm pool: a pre-booted VM claimed and resumed rather than a new one launched. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.warmSpinUpMs">warmSpinUpMs</a></code> | Milliseconds to spin up a warm launch: claiming the VM, resuming it, and pushing the runner's registration. |
| <code><a href="#cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.warmThrottled">warmThrottled</a></code> | Warm-pool claims that were throttled and fell back to booting a new VM. |

---

##### `cancelledBeforeLaunch` <a name="cancelledBeforeLaunch" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.cancelledBeforeLaunch"></a>

```typescript
public cancelledBeforeLaunch(runnerClassLabel: string): Metric
```

Launches skipped because the job had already stopped waiting for a runner by the time the launch was processed — cancelled, or its run deleted.

No VM is booted for these, so a rising count is work avoided rather than
work lost. It tracks how often jobs are cancelled while still queued,
which is routine on a repository using concurrency groups: every re-push
cancels the run it superseded. A count that dwarfs `ColdBoot` suggests the
workflows feeding this runner set are cancelled more often than they
finish, which is usually a question about their triggers rather than
about the runner set.

*Example*

```typescript
new cw.Alarm(stack, 'MostlyCancelled', {
  metric: runners.metrics.cancelledBeforeLaunch('microvm'),
  threshold: 50,
  evaluationPeriods: 3,
});
```


###### `runnerClassLabel`<sup>Required</sup> <a name="runnerClassLabel" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.cancelledBeforeLaunch.parameter.runnerClassLabel"></a>

- *Type:* string

---

##### `capacityRejected` <a name="capacityRejected" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.capacityRejected"></a>

```typescript
public capacityRejected(runnerClassLabel: string): Metric
```

Launches the MicroVM service rejected for capacity.

This is the runner
set's quota signal: a value that stays above zero means jobs are queueing
behind a MicroVM quota, or behind `maxConcurrentVms`, rather than running,
and each rejected launch spends one of its `maxReceiveCount` redrives on
the way to the dead-letter queue. See docs/service-quotas.md.

###### `runnerClassLabel`<sup>Required</sup> <a name="runnerClassLabel" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.capacityRejected.parameter.runnerClassLabel"></a>

- *Type:* string

---

##### `coldBoot` <a name="coldBoot" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.coldBoot"></a>

```typescript
public coldBoot(runnerClassLabel: string): Metric
```

Launches served by booting a new VM, because no warm VM was available or the class keeps no warm pool.

###### `runnerClassLabel`<sup>Required</sup> <a name="runnerClassLabel" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.coldBoot.parameter.runnerClassLabel"></a>

- *Type:* string

---

##### `coldSpinUpMs` <a name="coldSpinUpMs" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.coldSpinUpMs"></a>

```typescript
public coldSpinUpMs(runnerClassLabel: string): Metric
```

Milliseconds to spin up a cold launch: starting the VM, waiting for it to boot, and pushing the runner's registration.

Reported as an average rather than a sum.

###### `runnerClassLabel`<sup>Required</sup> <a name="runnerClassLabel" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.coldSpinUpMs.parameter.runnerClassLabel"></a>

- *Type:* string

---

##### `deadLetterQueueDepth` <a name="deadLetterQueueDepth" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.deadLetterQueueDepth"></a>

```typescript
public deadLetterQueueDepth(): Metric
```

Messages sitting in the dead-letter queue: a launch or terminate intent SQS gave up redriving.

##### `deadLetterQueueNotEmptyAlarm` <a name="deadLetterQueueNotEmptyAlarm" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.deadLetterQueueNotEmptyAlarm"></a>

```typescript
public deadLetterQueueNotEmptyAlarm(scope: Construct, options?: RunnerAlarmOptions): Alarm
```

Alarm when the dead-letter queue is not empty, meaning SQS gave up redriving a launch or terminate intent.

A runner set that is keeping up
holds this at 0, so any sustained depth means jobs are being dropped,
unless `recoverStuckLaunches` is draining them. It fires on one message
over a single 5-minute period; pass `RunnerAlarmOptions` to change
that, and `alarm.addAlarmAction()` to route it.

This is the one alarm here that works without
`GithubMicrovmRunnersProps.emitMetrics`, because it watches the
dead-letter queue's own SQS metric rather than one the handlers report.

###### `scope`<sup>Required</sup> <a name="scope" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.deadLetterQueueNotEmptyAlarm.parameter.scope"></a>

- *Type:* constructs.Construct

---

###### `options`<sup>Optional</sup> <a name="options" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.deadLetterQueueNotEmptyAlarm.parameter.options"></a>

- *Type:* <a href="#cdk-github-microvm-runners.RunnerAlarmOptions">RunnerAlarmOptions</a>

---

##### `errors` <a name="errors" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.errors"></a>

```typescript
public errors(): Metric
```

Janitor sweep count: failures on individual VMs, rows, or image versions during a sweep.

The sweep isolates each one and still completes.

##### `imageVersionsPruned` <a name="imageVersionsPruned" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.imageVersionsPruned"></a>

```typescript
public imageVersionsPruned(): Metric
```

Janitor sweep count: inactive MicroVM image versions pruned past `keepImageVersions`.

##### `lifetimeKills` <a name="lifetimeKills" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.lifetimeKills"></a>

```typescript
public lifetimeKills(): Metric
```

Janitor sweep count: VMs terminated for having run longer than `maxJobDuration` plus the platform's own grace.

##### `orphansReaped` <a name="orphansReaped" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.orphansReaped"></a>

```typescript
public orphansReaped(): Metric
```

Janitor sweep count: running VMs that belong to this runner set but have no row in the runner table, reaped once a second sweep has seen the same VM unaccounted for.

##### `poolCurrent` <a name="poolCurrent" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.poolCurrent"></a>

```typescript
public poolCurrent(runnerClassLabel: string): Metric
```

Warm VMs suspended and available for this class as of the last warm-pool sweep.

###### `runnerClassLabel`<sup>Required</sup> <a name="runnerClassLabel" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.poolCurrent.parameter.runnerClassLabel"></a>

- *Type:* string

---

##### `poolLaunched` <a name="poolLaunched" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.poolLaunched"></a>

```typescript
public poolLaunched(runnerClassLabel: string): Metric
```

Warm VMs the last warm-pool sweep launched to reach `warmPoolSize`.

###### `runnerClassLabel`<sup>Required</sup> <a name="runnerClassLabel" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.poolLaunched.parameter.runnerClassLabel"></a>

- *Type:* string

---

##### `poolLaunchFailed` <a name="poolLaunchFailed" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.poolLaunchFailed"></a>

```typescript
public poolLaunchFailed(runnerClassLabel: string): Metric
```

Warm-VM launches a warm-pool sweep attempted and failed.

A value that stays above zero means the pool is not reaching `warmPoolSize`, so jobs keep booting new VMs instead of resuming warm ones.

###### `runnerClassLabel`<sup>Required</sup> <a name="runnerClassLabel" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.poolLaunchFailed.parameter.runnerClassLabel"></a>

- *Type:* string

---

##### `poolTarget` <a name="poolTarget" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.poolTarget"></a>

```typescript
public poolTarget(runnerClassLabel: string): Metric
```

This class's `warmPoolSize`, as the last warm-pool sweep read it.

###### `runnerClassLabel`<sup>Required</sup> <a name="runnerClassLabel" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.poolTarget.parameter.runnerClassLabel"></a>

- *Type:* string

---

##### `stuckClaimsRelaunched` <a name="stuckClaimsRelaunched" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.stuckClaimsRelaunched"></a>

```typescript
public stuckClaimsRelaunched(): Metric
```

Janitor sweep count: launches that were claimed but never served, re-launched from the orphaned claim.

This is 0 unless `recoverStuckLaunches` is on.

##### `stuckLaunchesRecovered` <a name="stuckLaunchesRecovered" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.stuckLaunchesRecovered"></a>

```typescript
public stuckLaunchesRecovered(): Metric
```

Janitor sweep count: dead-lettered launches re-driven onto the job queue, which is 0 unless `recoverStuckLaunches` is on.

A value that stays high means launches are failing for some reason other than a GitHub outage.

##### `stuckLaunchesRecoveredAlarm` <a name="stuckLaunchesRecoveredAlarm" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.stuckLaunchesRecoveredAlarm"></a>

```typescript
public stuckLaunchesRecoveredAlarm(scope: Construct, options?: RunnerAlarmOptions): Alarm
```

Alarm on stuck-launch recoveries, the dead-lettered launches the janitor re-drove, which only happens with `recoverStuckLaunches` on.

Recoveries
that keep coming mean launches are failing for some reason other than a
GitHub outage. It fires on one recovery in each of three consecutive
5-minute periods, which rides out a real outage; pass
`RunnerAlarmOptions` to change that.

Requires `GithubMicrovmRunnersProps.emitMetrics`, and throws at synth
without it.

###### `scope`<sup>Required</sup> <a name="scope" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.stuckLaunchesRecoveredAlarm.parameter.scope"></a>

- *Type:* constructs.Construct

---

###### `options`<sup>Optional</sup> <a name="options" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.stuckLaunchesRecoveredAlarm.parameter.options"></a>

- *Type:* <a href="#cdk-github-microvm-runners.RunnerAlarmOptions">RunnerAlarmOptions</a>

---

##### `stuckRunnersReaped` <a name="stuckRunnersReaped" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.stuckRunnersReaped"></a>

```typescript
public stuckRunnersReaped(): Metric
```

Janitor sweep count: runners that registered with GitHub and then sat idle past `idleRunnerGraceSeconds`, reaped once a second sweep has seen them the same way.

##### `suspectsCleared` <a name="suspectsCleared" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.suspectsCleared"></a>

```typescript
public suspectsCleared(): Metric
```

Janitor sweep count: VMs an earlier sweep had marked as suspect, cleared because this sweep found them accounted for or working again.

##### `sweepErrorsAlarm` <a name="sweepErrorsAlarm" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.sweepErrorsAlarm"></a>

```typescript
public sweepErrorsAlarm(scope: Construct, options?: RunnerAlarmOptions): Alarm
```

Alarm on janitor sweep errors, the per-item failures a sweep isolates and continues past.

A value that stays above zero means the runner set is
failing to reconcile — VMs left running, runners left unreaped — even
though each sweep completes. It fires on one error over a single 5-minute
period; pass `RunnerAlarmOptions` to change that.

Requires `GithubMicrovmRunnersProps.emitMetrics`, and throws at synth
without it.

###### `scope`<sup>Required</sup> <a name="scope" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.sweepErrorsAlarm.parameter.scope"></a>

- *Type:* constructs.Construct

---

###### `options`<sup>Optional</sup> <a name="options" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.sweepErrorsAlarm.parameter.options"></a>

- *Type:* <a href="#cdk-github-microvm-runners.RunnerAlarmOptions">RunnerAlarmOptions</a>

---

##### `tableRowsCleaned` <a name="tableRowsCleaned" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.tableRowsCleaned"></a>

```typescript
public tableRowsCleaned(): Metric
```

Janitor sweep count: runner table rows deleted, either because the VM they name is confirmed gone or because a real row superseded an orphaned one.

##### `warmHit` <a name="warmHit" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.warmHit"></a>

```typescript
public warmHit(runnerClassLabel: string): Metric
```

Launches served from the warm pool: a pre-booted VM claimed and resumed rather than a new one launched.

###### `runnerClassLabel`<sup>Required</sup> <a name="runnerClassLabel" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.warmHit.parameter.runnerClassLabel"></a>

- *Type:* string

---

##### `warmSpinUpMs` <a name="warmSpinUpMs" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.warmSpinUpMs"></a>

```typescript
public warmSpinUpMs(runnerClassLabel: string): Metric
```

Milliseconds to spin up a warm launch: claiming the VM, resuming it, and pushing the runner's registration.

Reported as an average rather than a sum.

###### `runnerClassLabel`<sup>Required</sup> <a name="runnerClassLabel" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.warmSpinUpMs.parameter.runnerClassLabel"></a>

- *Type:* string

---

##### `warmThrottled` <a name="warmThrottled" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.warmThrottled"></a>

```typescript
public warmThrottled(runnerClassLabel: string): Metric
```

Warm-pool claims that were throttled and fell back to booting a new VM.

The same launch can also count under `ColdBoot` or `CapacityRejected`.

###### `runnerClassLabel`<sup>Required</sup> <a name="runnerClassLabel" id="cdk-github-microvm-runners.GithubMicrovmRunnersMetrics.warmThrottled.parameter.runnerClassLabel"></a>

- *Type:* string

---




### ImageLogs <a name="ImageLogs" id="cdk-github-microvm-runners.ImageLogs"></a>

Build-time image logs for a runner set: the Docker build layers and the ready-probe banner an image emits while it is built.

Off unless you add it.

These logs are written while the image builds, by the image build role
rather than by a VM, so image logging needs no VM execution role and puts no
credentials on a runner. `ConsoleLogs` covers the runtime counterpart, which
does need a role. The two are independent and can both be on.

*Example*

```typescript
new GithubMicrovmRunners(stack, 'Runners', {
  github,
  scope,
  imageLogs: ImageLogs.enabled(),
});
```



#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.ImageLogs.enabled">enabled</a></code> | Send image-build logs to CloudWatch. |

---

##### `enabled` <a name="enabled" id="cdk-github-microvm-runners.ImageLogs.enabled"></a>

```typescript
import { ImageLogs } from 'cdk-github-microvm-runners'

ImageLogs.enabled(logGroup?: ILogGroup)
```

Send image-build logs to CloudWatch.

With no argument they go to the
platform's own group (`/aws/lambda-microvms/…`). Pass an `ILogGroup` to
send them to a group whose retention and KMS key you control.

*Example*

```typescript
const buildLogs = ImageLogs.enabled(myBuildLogGroup);
```


###### `logGroup`<sup>Optional</sup> <a name="logGroup" id="cdk-github-microvm-runners.ImageLogs.enabled.parameter.logGroup"></a>

- *Type:* aws-cdk-lib.aws_logs.ILogGroup

destination group.

Omitted, the platform's own group.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.ImageLogs.property.logGroup">logGroup</a></code> | <code>aws-cdk-lib.aws_logs.ILogGroup</code> | The group build logs go to, when one was passed to `ImageLogs.enabled()`. `undefined` means the platform's own group. |

---

##### `logGroup`<sup>Optional</sup> <a name="logGroup" id="cdk-github-microvm-runners.ImageLogs.property.logGroup"></a>

```typescript
public readonly logGroup: ILogGroup;
```

- *Type:* aws-cdk-lib.aws_logs.ILogGroup

The group build logs go to, when one was passed to `ImageLogs.enabled()`. `undefined` means the platform's own group.

---


### MicrovmSize <a name="MicrovmSize" id="cdk-github-microvm-runners.MicrovmSize"></a>

The memory a MicroVM runs with.

Each runner class picks one preset, and that preset becomes the memory floor
of the image the class builds. Pick from the static presets below; the
constructor is private.

A preset is a **floor, not an allocation**. It is the minimum the image is
built with, and the platform provisions above it — measured at roughly four
times the request, so a class on `GB1` has been observed booting with about
4 GB and 2 vCPU, and one on `GB4` with about 16 GB and 8 vCPU. Two things
follow: a workload usually fits a smaller preset than its memory figure
suggests, and the account's memory quota is charged the measured allocation
rather than the floor. The service quotas guide carries the arithmetic.

vCPU and disk follow from the preset and are not separately settable — the
image resource takes a memory floor and nothing else.

*Example*

```typescript
runners.addRunnerClass('microvm-8gb', { size: MicrovmSize.GB8 });
```




#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.MicrovmSize.property.memoryGb">memoryGb</a></code> | <code>number</code> | Memory floor in GB. |
| <code><a href="#cdk-github-microvm-runners.MicrovmSize.property.memoryMib">memoryMib</a></code> | <code>number</code> | Memory in MiB, the unit the MicroVM image's `minimumMemoryInMiB` takes. |

---

##### `memoryGb`<sup>Required</sup> <a name="memoryGb" id="cdk-github-microvm-runners.MicrovmSize.property.memoryGb"></a>

```typescript
public readonly memoryGb: number;
```

- *Type:* number

Memory floor in GB.

---

##### `memoryMib`<sup>Required</sup> <a name="memoryMib" id="cdk-github-microvm-runners.MicrovmSize.property.memoryMib"></a>

```typescript
public readonly memoryMib: number;
```

- *Type:* number

Memory in MiB, the unit the MicroVM image's `minimumMemoryInMiB` takes.

---

#### Constants <a name="Constants" id="Constants"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.MicrovmSize.property.GB0_5">GB0_5</a></code> | <code><a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a></code> | Memory floor of 0.5 GB. |
| <code><a href="#cdk-github-microvm-runners.MicrovmSize.property.GB1">GB1</a></code> | <code><a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a></code> | Memory floor of 1 GB. |
| <code><a href="#cdk-github-microvm-runners.MicrovmSize.property.GB2">GB2</a></code> | <code><a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a></code> | Memory floor of 2 GB. |
| <code><a href="#cdk-github-microvm-runners.MicrovmSize.property.GB4">GB4</a></code> | <code><a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a></code> | Memory floor of 4 GB. |
| <code><a href="#cdk-github-microvm-runners.MicrovmSize.property.GB8">GB8</a></code> | <code><a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a></code> | Memory floor of 8 GB. |

---

##### `GB0_5`<sup>Required</sup> <a name="GB0_5" id="cdk-github-microvm-runners.MicrovmSize.property.GB0_5"></a>

```typescript
public readonly GB0_5: MicrovmSize;
```

- *Type:* <a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a>

Memory floor of 0.5 GB.

---

##### `GB1`<sup>Required</sup> <a name="GB1" id="cdk-github-microvm-runners.MicrovmSize.property.GB1"></a>

```typescript
public readonly GB1: MicrovmSize;
```

- *Type:* <a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a>

Memory floor of 1 GB.

---

##### `GB2`<sup>Required</sup> <a name="GB2" id="cdk-github-microvm-runners.MicrovmSize.property.GB2"></a>

```typescript
public readonly GB2: MicrovmSize;
```

- *Type:* <a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a>

Memory floor of 2 GB.

---

##### `GB4`<sup>Required</sup> <a name="GB4" id="cdk-github-microvm-runners.MicrovmSize.property.GB4"></a>

```typescript
public readonly GB4: MicrovmSize;
```

- *Type:* <a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a>

Memory floor of 4 GB.

---

##### `GB8`<sup>Required</sup> <a name="GB8" id="cdk-github-microvm-runners.MicrovmSize.property.GB8"></a>

```typescript
public readonly GB8: MicrovmSize;
```

- *Type:* <a href="#cdk-github-microvm-runners.MicrovmSize">MicrovmSize</a>

Memory floor of 8 GB.

---

### RunnerImage <a name="RunnerImage" id="cdk-github-microvm-runners.RunnerImage"></a>

The image a runner class's VMs boot from: one this library synthesizes, or one you author yourself.

Build one with the static factories below; the constructor is private.

*Example*

```typescript
runners.addRunnerClass('build', {
  size: MicrovmSize.GB4,
  image: RunnerImage.fromOptions({
    systemPackages: ['jq', 'ripgrep'],
  }),
});
```



#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerImage.fromDockerfile">fromDockerfile</a></code> | Use your own Dockerfile, and the build context around it, from the directory `dir`. |
| <code><a href="#cdk-github-microvm-runners.RunnerImage.fromInline">fromInline</a></code> | Use your own Dockerfile, supplied as text. |
| <code><a href="#cdk-github-microvm-runners.RunnerImage.fromOptions">fromOptions</a></code> | Synthesize a Dockerfile from `opts` — extra packages, setup commands, assets, environment variables, toolchains, and the `actions/runner` release to install. |

---

##### `fromDockerfile` <a name="fromDockerfile" id="cdk-github-microvm-runners.RunnerImage.fromDockerfile"></a>

```typescript
import { RunnerImage } from 'cdk-github-microvm-runners'

RunnerImage.fromDockerfile(dir: string)
```

Use your own Dockerfile, and the build context around it, from the directory `dir`.

The whole directory is staged as the Docker build
context, so a Dockerfile that needs to `COPY` files of its own belongs
here rather than in `RunnerImage.fromInline`.

The `contentHash` recorded on the returned instance is derived from the
path string. The directory's actual contents are read and hashed later,
when the image pipeline stages them as a CDK asset.

A relative `dir` is resolved against the process working directory, which
is wherever `cdk` was invoked. Anchor it to the file that declares the
runner class instead by passing `path.join(__dirname, 'runner-image')`.

*Example*

```typescript
const customImage = RunnerImage.fromDockerfile('runner-image');
```


###### `dir`<sup>Required</sup> <a name="dir" id="cdk-github-microvm-runners.RunnerImage.fromDockerfile.parameter.dir"></a>

- *Type:* string

---

##### `fromInline` <a name="fromInline" id="cdk-github-microvm-runners.RunnerImage.fromInline"></a>

```typescript
import { RunnerImage } from 'cdk-github-microvm-runners'

RunnerImage.fromInline(dockerfile: string)
```

Use your own Dockerfile, supplied as text.

The text is staged verbatim as
the build context's `Dockerfile`, alongside the `microvm-runner/`
directory the image pipeline injects and nothing else. A Dockerfile that
needs to `COPY` files of its own belongs with
`RunnerImage.fromDockerfile`, which stages a whole directory.

The text must `COPY microvm-runner/agent.mjs` and start the staged
entrypoint, because that agent is what serves the MicroVM lifecycle hooks
the platform calls. This is checked here, and a Dockerfile that does not
copy the agent throws.

The `contentHash` recorded on the returned instance is a sha256 over the
supplied text.

*Example*

```typescript
const inlineImage = RunnerImage.fromInline(`
FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y git jq

COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs
COPY microvm-runner/entrypoint.sh /opt/microvm-runner/entrypoint.sh
ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]
`);
```


###### `dockerfile`<sup>Required</sup> <a name="dockerfile" id="cdk-github-microvm-runners.RunnerImage.fromInline.parameter.dockerfile"></a>

- *Type:* string

---

##### `fromOptions` <a name="fromOptions" id="cdk-github-microvm-runners.RunnerImage.fromOptions"></a>

```typescript
import { RunnerImage } from 'cdk-github-microvm-runners'

RunnerImage.fromOptions(opts?: RunnerImageOptions)
```

Synthesize a Dockerfile from `opts` — extra packages, setup commands, assets, environment variables, toolchains, and the `actions/runner` release to install.

The image's `contentHash` is computed here, over the
rendered Dockerfile text and the list of assets it copies.

*Example*

```typescript
const buildImage = RunnerImage.fromOptions({
  systemPackages: ['jq', 'ripgrep'],
  setupCommands: ['npm install -g pnpm@10'],
  environment: { LANG: 'C.UTF-8' },
  toolchains: [RunnerToolchain.python('3.12.7')],
});
```


###### `opts`<sup>Optional</sup> <a name="opts" id="cdk-github-microvm-runners.RunnerImage.fromOptions.parameter.opts"></a>

- *Type:* <a href="#cdk-github-microvm-runners.RunnerImageOptions">RunnerImageOptions</a>

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerImage.property.additionalOsCapabilities">additionalOsCapabilities</a></code> | <code>string[]</code> | Extra Linux capabilities granted to the MicroVM's operating system. |
| <code><a href="#cdk-github-microvm-runners.RunnerImage.property.contentHash">contentHash</a></code> | <code>string</code> | sha256 content hash, part of the built image's name. |
| <code><a href="#cdk-github-microvm-runners.RunnerImage.property.assets">assets</a></code> | <code><a href="#cdk-github-microvm-runners.ImageAsset">ImageAsset</a>[]</code> | The `{source, target}` pairs from `RunnerImageOptions.assets`. Set for `fromOptions()`, whose rendered Dockerfile copies each one into the image. `undefined` for `fromDockerfile()`, which stages your whole directory instead, and for `fromInline()`, whose build context holds the Dockerfile and the injected agent and nothing else. |
| <code><a href="#cdk-github-microvm-runners.RunnerImage.property.dockerfile">dockerfile</a></code> | <code>string</code> | Dockerfile text: rendered for `fromOptions()`, supplied by you for `fromInline()`. |
| <code><a href="#cdk-github-microvm-runners.RunnerImage.property.dockerfileDir">dockerfileDir</a></code> | <code>string</code> | The directory holding your own Dockerfile and build context. |

---

##### `additionalOsCapabilities`<sup>Required</sup> <a name="additionalOsCapabilities" id="cdk-github-microvm-runners.RunnerImage.property.additionalOsCapabilities"></a>

```typescript
public readonly additionalOsCapabilities: string[];
```

- *Type:* string[]

Extra Linux capabilities granted to the MicroVM's operating system.

`fromOptions()` takes this from `RunnerImageOptions`; `fromDockerfile()`
and `fromInline()` always carry `['ALL']`.

---

##### `contentHash`<sup>Required</sup> <a name="contentHash" id="cdk-github-microvm-runners.RunnerImage.property.contentHash"></a>

```typescript
public readonly contentHash: string;
```

- *Type:* string

sha256 content hash, part of the built image's name.

For
`fromOptions()` it covers the rendered Dockerfile and the options that
produced it; for `fromInline()`, the supplied Dockerfile text; for
`fromDockerfile()`, the directory path.

---

##### `assets`<sup>Optional</sup> <a name="assets" id="cdk-github-microvm-runners.RunnerImage.property.assets"></a>

```typescript
public readonly assets: ImageAsset[];
```

- *Type:* <a href="#cdk-github-microvm-runners.ImageAsset">ImageAsset</a>[]

The `{source, target}` pairs from `RunnerImageOptions.assets`. Set for `fromOptions()`, whose rendered Dockerfile copies each one into the image. `undefined` for `fromDockerfile()`, which stages your whole directory instead, and for `fromInline()`, whose build context holds the Dockerfile and the injected agent and nothing else.

---

##### `dockerfile`<sup>Optional</sup> <a name="dockerfile" id="cdk-github-microvm-runners.RunnerImage.property.dockerfile"></a>

```typescript
public readonly dockerfile: string;
```

- *Type:* string

Dockerfile text: rendered for `fromOptions()`, supplied by you for `fromInline()`.

`undefined` for `fromDockerfile()`, whose Dockerfile
lives on disk under `dockerfileDir`.

---

##### `dockerfileDir`<sup>Optional</sup> <a name="dockerfileDir" id="cdk-github-microvm-runners.RunnerImage.property.dockerfileDir"></a>

```typescript
public readonly dockerfileDir: string;
```

- *Type:* string

The directory holding your own Dockerfile and build context.

Set for
`fromDockerfile()`, `undefined` for `fromOptions()` and `fromInline()`,
which both carry their Dockerfile as `dockerfile` text.

---


### RunnerNetwork <a name="RunnerNetwork" id="cdk-github-microvm-runners.RunnerNetwork"></a>

How a runner set's MicroVMs reach the network: direct internet egress, Lambda VPC runtime connectors you already have, or a connector the construct builds from a CDK VPC.

Build one with the static factories below; the constructor is private.

*Example*

```typescript
new GithubMicrovmRunners(stack, 'Runners', {
  github,
  scope,
  network: RunnerNetwork.vpc(vpc),
});
```



#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerNetwork.internetEgress">internetEgress</a></code> | Runners egress directly to the internet (no VPC connector). |
| <code><a href="#cdk-github-microvm-runners.RunnerNetwork.vpc">vpc</a></code> | Runners egress through a network connector the construct builds from the given CDK VPC, along with the security group and the ENI-management operator role that connector needs. |
| <code><a href="#cdk-github-microvm-runners.RunnerNetwork.vpcConnector">vpcConnector</a></code> | Runners are attached to the given Lambda runtime connector ARNs. |

---

##### `internetEgress` <a name="internetEgress" id="cdk-github-microvm-runners.RunnerNetwork.internetEgress"></a>

```typescript
import { RunnerNetwork } from 'cdk-github-microvm-runners'

RunnerNetwork.internetEgress()
```

Runners egress directly to the internet (no VPC connector).

*Example*

```typescript
const network = RunnerNetwork.internetEgress();
```


##### `vpc` <a name="vpc" id="cdk-github-microvm-runners.RunnerNetwork.vpc"></a>

```typescript
import { RunnerNetwork } from 'cdk-github-microvm-runners'

RunnerNetwork.vpc(vpc: IVpc, opts?: RunnerNetworkVpcOptions)
```

Runners egress through a network connector the construct builds from the given CDK VPC, along with the security group and the ENI-management operator role that connector needs.

You supply the VPC; no connector ARN
is required. `connectorArns` is empty on the returned instance, and the
construct fills in the connector's real ARN at synth.

*Example*

```typescript
const network = RunnerNetwork.vpc(vpc, {
  subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  securityGroups: [mySecurityGroup],
});
```


###### `vpc`<sup>Required</sup> <a name="vpc" id="cdk-github-microvm-runners.RunnerNetwork.vpc.parameter.vpc"></a>

- *Type:* aws-cdk-lib.aws_ec2.IVpc

---

###### `opts`<sup>Optional</sup> <a name="opts" id="cdk-github-microvm-runners.RunnerNetwork.vpc.parameter.opts"></a>

- *Type:* <a href="#cdk-github-microvm-runners.RunnerNetworkVpcOptions">RunnerNetworkVpcOptions</a>

---

##### `vpcConnector` <a name="vpcConnector" id="cdk-github-microvm-runners.RunnerNetwork.vpcConnector"></a>

```typescript
import { RunnerNetwork } from 'cdk-github-microvm-runners'

RunnerNetwork.vpcConnector(connectorArns: string[])
```

Runners are attached to the given Lambda runtime connector ARNs.

*Example*

```typescript
const network = RunnerNetwork.vpcConnector([
  'arn:aws:lambda:us-east-1:111122223333:network-connector:my-connector',
]);
```


###### `connectorArns`<sup>Required</sup> <a name="connectorArns" id="cdk-github-microvm-runners.RunnerNetwork.vpcConnector.parameter.connectorArns"></a>

- *Type:* string[]

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerNetwork.property.connectorArns">connectorArns</a></code> | <code>string[]</code> | Runtime connector ARNs. |
| <code><a href="#cdk-github-microvm-runners.RunnerNetwork.property.kind">kind</a></code> | <code><a href="#cdk-github-microvm-runners.RunnerNetworkKind">RunnerNetworkKind</a></code> | Which networking mode this instance carries. |
| <code><a href="#cdk-github-microvm-runners.RunnerNetwork.property.securityGroups">securityGroups</a></code> | <code>aws-cdk-lib.aws_ec2.ISecurityGroup[]</code> | Security groups for the built connector, set only for a `vpc()` network. |
| <code><a href="#cdk-github-microvm-runners.RunnerNetwork.property.sourceVpc">sourceVpc</a></code> | <code>aws-cdk-lib.aws_ec2.IVpc</code> | The VPC to build a connector from, set only for a `vpc()` network. |
| <code><a href="#cdk-github-microvm-runners.RunnerNetwork.property.subnets">subnets</a></code> | <code>aws-cdk-lib.aws_ec2.SubnetSelection</code> | Subnet selection for the built connector, set only for a `vpc()` network. |

---

##### `connectorArns`<sup>Required</sup> <a name="connectorArns" id="cdk-github-microvm-runners.RunnerNetwork.property.connectorArns"></a>

```typescript
public readonly connectorArns: string[];
```

- *Type:* string[]

Runtime connector ARNs.

Empty for direct internet egress, and empty for
a `vpc()` network until the construct builds its connector at synth.

---

##### `kind`<sup>Required</sup> <a name="kind" id="cdk-github-microvm-runners.RunnerNetwork.property.kind"></a>

```typescript
public readonly kind: RunnerNetworkKind;
```

- *Type:* <a href="#cdk-github-microvm-runners.RunnerNetworkKind">RunnerNetworkKind</a>

Which networking mode this instance carries.

---

##### `securityGroups`<sup>Optional</sup> <a name="securityGroups" id="cdk-github-microvm-runners.RunnerNetwork.property.securityGroups"></a>

```typescript
public readonly securityGroups: ISecurityGroup[];
```

- *Type:* aws-cdk-lib.aws_ec2.ISecurityGroup[]

Security groups for the built connector, set only for a `vpc()` network.

---

##### `sourceVpc`<sup>Optional</sup> <a name="sourceVpc" id="cdk-github-microvm-runners.RunnerNetwork.property.sourceVpc"></a>

```typescript
public readonly sourceVpc: IVpc;
```

- *Type:* aws-cdk-lib.aws_ec2.IVpc

The VPC to build a connector from, set only for a `vpc()` network.

---

##### `subnets`<sup>Optional</sup> <a name="subnets" id="cdk-github-microvm-runners.RunnerNetwork.property.subnets"></a>

```typescript
public readonly subnets: SubnetSelection;
```

- *Type:* aws-cdk-lib.aws_ec2.SubnetSelection

Subnet selection for the built connector, set only for a `vpc()` network.

---


### RunnerScope <a name="RunnerScope" id="cdk-github-microvm-runners.RunnerScope"></a>

Which GitHub scope registered runners are visible to: an entire organization, or an explicit list of `owner/repo` repositories.

Build one with the static factories below; the constructor is private.

*Example*

```typescript
const orgScope = RunnerScope.org('my-org');
```


#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerScope.toJson">toJson</a></code> | Serialize this scope to the JSON form the runner set's handlers read at runtime. |

---

##### `toJson` <a name="toJson" id="cdk-github-microvm-runners.RunnerScope.toJson"></a>

```typescript
public toJson(): string
```

Serialize this scope to the JSON form the runner set's handlers read at runtime.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerScope.org">org</a></code> | Runners are registered at the organization level. |
| <code><a href="#cdk-github-microvm-runners.RunnerScope.repos">repos</a></code> | Runners are registered against an explicit list of `owner/repo` repos. |

---

##### `org` <a name="org" id="cdk-github-microvm-runners.RunnerScope.org"></a>

```typescript
import { RunnerScope } from 'cdk-github-microvm-runners'

RunnerScope.org(org: string)
```

Runners are registered at the organization level.

*Example*

```typescript
const orgScope = RunnerScope.org('my-org');
```


###### `org`<sup>Required</sup> <a name="org" id="cdk-github-microvm-runners.RunnerScope.org.parameter.org"></a>

- *Type:* string

---

##### `repos` <a name="repos" id="cdk-github-microvm-runners.RunnerScope.repos"></a>

```typescript
import { RunnerScope } from 'cdk-github-microvm-runners'

RunnerScope.repos(repos: string[])
```

Runners are registered against an explicit list of `owner/repo` repos.

*Example*

```typescript
const repoScope = RunnerScope.repos(['my-org/api', 'my-org/web']);
```


###### `repos`<sup>Required</sup> <a name="repos" id="cdk-github-microvm-runners.RunnerScope.repos.parameter.repos"></a>

- *Type:* string[]

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerScope.property.kind">kind</a></code> | <code><a href="#cdk-github-microvm-runners.RunnerScopeKind">RunnerScopeKind</a></code> | Whether this scope is an organization or a list of repositories. |
| <code><a href="#cdk-github-microvm-runners.RunnerScope.property.organization">organization</a></code> | <code>string</code> | The organization, for a scope built with `RunnerScope.org()`. |
| <code><a href="#cdk-github-microvm-runners.RunnerScope.property.repositories">repositories</a></code> | <code>string[]</code> | The `owner/repo` list, for a scope built with `RunnerScope.repos()`. |

---

##### `kind`<sup>Required</sup> <a name="kind" id="cdk-github-microvm-runners.RunnerScope.property.kind"></a>

```typescript
public readonly kind: RunnerScopeKind;
```

- *Type:* <a href="#cdk-github-microvm-runners.RunnerScopeKind">RunnerScopeKind</a>

Whether this scope is an organization or a list of repositories.

---

##### `organization`<sup>Optional</sup> <a name="organization" id="cdk-github-microvm-runners.RunnerScope.property.organization"></a>

```typescript
public readonly organization: string;
```

- *Type:* string

The organization, for a scope built with `RunnerScope.org()`.

---

##### `repositories`<sup>Optional</sup> <a name="repositories" id="cdk-github-microvm-runners.RunnerScope.property.repositories"></a>

```typescript
public readonly repositories: string[];
```

- *Type:* string[]

The `owner/repo` list, for a scope built with `RunnerScope.repos()`.

---


### RunnerToolchain <a name="RunnerToolchain" id="cdk-github-microvm-runners.RunnerToolchain"></a>

A language runtime baked into the runner image's hosted tool cache at `/opt/hostedtoolcache`, where `actions/setup-python` and `actions/setup-node` find it without downloading anything.

Those actions otherwise fetch
OS-specific prebuilt runtimes, which are not published for the AL2023 image
these runners use.

Several versions can be baked in at once, and a workflow asking for
`python-version: "3.12"` matches a baked `3.12.7`.

Build one with the static factories below; the constructor is private.

*Example*

```typescript
const testImage = RunnerImage.fromOptions({
  toolchains: [
    RunnerToolchain.python('3.12.7'),
    RunnerToolchain.node('22.11.0'),
  ],
});
```



#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerToolchain.node">node</a></code> | Node.js, from the official arm64 tarball. Full semver, e.g. `'22.11.0'`. |
| <code><a href="#cdk-github-microvm-runners.RunnerToolchain.python">python</a></code> | CPython, built from source. |

---

##### `node` <a name="node" id="cdk-github-microvm-runners.RunnerToolchain.node"></a>

```typescript
import { RunnerToolchain } from 'cdk-github-microvm-runners'

RunnerToolchain.node(version: string)
```

Node.js, from the official arm64 tarball. Full semver, e.g. `'22.11.0'`.

*Example*

```typescript
const node = RunnerToolchain.node('22.11.0');
```


###### `version`<sup>Required</sup> <a name="version" id="cdk-github-microvm-runners.RunnerToolchain.node.parameter.version"></a>

- *Type:* string

---

##### `python` <a name="python" id="cdk-github-microvm-runners.RunnerToolchain.python"></a>

```typescript
import { RunnerToolchain } from 'cdk-github-microvm-runners'

RunnerToolchain.python(version: string)
```

CPython, built from source.

`version` is a full semver, e.g. `'3.12.7'`.

*Example*

```typescript
const python = RunnerToolchain.python('3.12.7');
```


###### `version`<sup>Required</sup> <a name="version" id="cdk-github-microvm-runners.RunnerToolchain.python.parameter.version"></a>

- *Type:* string

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerToolchain.property.kind">kind</a></code> | <code><a href="#cdk-github-microvm-runners.ToolchainKind">ToolchainKind</a></code> | Which runtime this is. |
| <code><a href="#cdk-github-microvm-runners.RunnerToolchain.property.version">version</a></code> | <code>string</code> | The full semver release baked in, e.g. `'3.12.7'`. |

---

##### `kind`<sup>Required</sup> <a name="kind" id="cdk-github-microvm-runners.RunnerToolchain.property.kind"></a>

```typescript
public readonly kind: ToolchainKind;
```

- *Type:* <a href="#cdk-github-microvm-runners.ToolchainKind">ToolchainKind</a>

Which runtime this is.

---

##### `version`<sup>Required</sup> <a name="version" id="cdk-github-microvm-runners.RunnerToolchain.property.version"></a>

```typescript
public readonly version: string;
```

- *Type:* string

The full semver release baked in, e.g. `'3.12.7'`.

---


### RunnerVersion <a name="RunnerVersion" id="cdk-github-microvm-runners.RunnerVersion"></a>

Which `actions/runner` release to install on the MicroVM image.

Build one with the static factories below; the constructor is private.

*Example*

```typescript
const pinnedImage = RunnerImage.fromOptions({
  runnerVersion: RunnerVersion.of('2.328.0'),
});
```



#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerVersion.latest">latest</a></code> | Use the `actions/runner` release this library currently pins (`DEFAULT_RUNNER_VERSION`). |
| <code><a href="#cdk-github-microvm-runners.RunnerVersion.of">of</a></code> | Pin an explicit `actions/runner` release, e.g. `"2.319.1"`. |

---

##### `latest` <a name="latest" id="cdk-github-microvm-runners.RunnerVersion.latest"></a>

```typescript
import { RunnerVersion } from 'cdk-github-microvm-runners'

RunnerVersion.latest()
```

Use the `actions/runner` release this library currently pins (`DEFAULT_RUNNER_VERSION`).

No version is carried on the instance; the
image build fills the pinned value in at synth.

*Example*

```typescript
const runnerVersion = RunnerVersion.latest();
```


##### `of` <a name="of" id="cdk-github-microvm-runners.RunnerVersion.of"></a>

```typescript
import { RunnerVersion } from 'cdk-github-microvm-runners'

RunnerVersion.of(version: string)
```

Pin an explicit `actions/runner` release, e.g. `"2.319.1"`.

*Example*

```typescript
const pinnedRunner = RunnerVersion.of('2.328.0');
```


###### `version`<sup>Required</sup> <a name="version" id="cdk-github-microvm-runners.RunnerVersion.of.parameter.version"></a>

- *Type:* string

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerVersion.property.version">version</a></code> | <code>string</code> | The pinned release, for a version built with `RunnerVersion.of()`. `undefined` for `RunnerVersion.latest()`. |

---

##### `version`<sup>Optional</sup> <a name="version" id="cdk-github-microvm-runners.RunnerVersion.property.version"></a>

```typescript
public readonly version: string;
```

- *Type:* string

The pinned release, for a version built with `RunnerVersion.of()`. `undefined` for `RunnerVersion.latest()`.

---


### WebhookEndpoint <a name="WebhookEndpoint" id="cdk-github-microvm-runners.WebhookEndpoint"></a>

How the webhook handler is exposed to GitHub's `workflow_job` deliveries.

The one form today is a Lambda Function URL. It is created with
`authType: NONE`; the auth boundary is the HMAC-SHA256 signature GitHub
sends with every delivery, which the handler verifies against the webhook
secret before it does anything else.

*Example*

```typescript
new GithubMicrovmRunners(stack, 'Runners', {
  github,
  scope,
  webhook: WebhookEndpoint.functionUrl(),
});
```



#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.WebhookEndpoint.functionUrl">functionUrl</a></code> | Expose the webhook handler on a Lambda Function URL. |

---

##### `functionUrl` <a name="functionUrl" id="cdk-github-microvm-runners.WebhookEndpoint.functionUrl"></a>

```typescript
import { WebhookEndpoint } from 'cdk-github-microvm-runners'

WebhookEndpoint.functionUrl()
```

Expose the webhook handler on a Lambda Function URL.

*Example*

```typescript
const webhook = WebhookEndpoint.functionUrl();
```


#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#cdk-github-microvm-runners.WebhookEndpoint.property.kind">kind</a></code> | <code><a href="#cdk-github-microvm-runners.WebhookEndpointKind">WebhookEndpointKind</a></code> | Which form of endpoint this instance represents. |

---

##### `kind`<sup>Required</sup> <a name="kind" id="cdk-github-microvm-runners.WebhookEndpoint.property.kind"></a>

```typescript
public readonly kind: WebhookEndpointKind;
```

- *Type:* <a href="#cdk-github-microvm-runners.WebhookEndpointKind">WebhookEndpointKind</a>

Which form of endpoint this instance represents.

---



## Enums <a name="Enums" id="Enums"></a>

### GithubAuthKind <a name="GithubAuthKind" id="cdk-github-microvm-runners.GithubAuthKind"></a>

Which credential flow a `GithubAuth` represents.

#### Members <a name="Members" id="Members"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.GithubAuthKind.APP">APP</a></code> | A GitHub App. |
| <code><a href="#cdk-github-microvm-runners.GithubAuthKind.PAT">PAT</a></code> | A personal access token. |

---

##### `APP` <a name="APP" id="cdk-github-microvm-runners.GithubAuthKind.APP"></a>

A GitHub App.

---


##### `PAT` <a name="PAT" id="cdk-github-microvm-runners.GithubAuthKind.PAT"></a>

A personal access token.

---


### RunnerNetworkKind <a name="RunnerNetworkKind" id="cdk-github-microvm-runners.RunnerNetworkKind"></a>

Which networking mode a `RunnerNetwork` carries.

#### Members <a name="Members" id="Members"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerNetworkKind.INTERNET">INTERNET</a></code> | Direct internet egress, with no Lambda VPC runtime connector. |
| <code><a href="#cdk-github-microvm-runners.RunnerNetworkKind.CONNECTORS">CONNECTORS</a></code> | Runners attached to caller-supplied Lambda runtime connector ARNs. |
| <code><a href="#cdk-github-microvm-runners.RunnerNetworkKind.VPC">VPC</a></code> | Runners attached to a connector the construct builds from a CDK VPC. |

---

##### `INTERNET` <a name="INTERNET" id="cdk-github-microvm-runners.RunnerNetworkKind.INTERNET"></a>

Direct internet egress, with no Lambda VPC runtime connector.

---


##### `CONNECTORS` <a name="CONNECTORS" id="cdk-github-microvm-runners.RunnerNetworkKind.CONNECTORS"></a>

Runners attached to caller-supplied Lambda runtime connector ARNs.

---


##### `VPC` <a name="VPC" id="cdk-github-microvm-runners.RunnerNetworkKind.VPC"></a>

Runners attached to a connector the construct builds from a CDK VPC.

---


### RunnerScopeKind <a name="RunnerScopeKind" id="cdk-github-microvm-runners.RunnerScopeKind"></a>

Which GitHub scope a `RunnerScope` represents.

#### Members <a name="Members" id="Members"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.RunnerScopeKind.ORG">ORG</a></code> | Runners are registered at the organization level. |
| <code><a href="#cdk-github-microvm-runners.RunnerScopeKind.REPOS">REPOS</a></code> | Runners are registered against an explicit list of repositories. |

---

##### `ORG` <a name="ORG" id="cdk-github-microvm-runners.RunnerScopeKind.ORG"></a>

Runners are registered at the organization level.

---


##### `REPOS` <a name="REPOS" id="cdk-github-microvm-runners.RunnerScopeKind.REPOS"></a>

Runners are registered against an explicit list of repositories.

---


### ToolchainKind <a name="ToolchainKind" id="cdk-github-microvm-runners.ToolchainKind"></a>

How a toolchain is installed into the image's hosted tool cache.

#### Members <a name="Members" id="Members"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.ToolchainKind.PYTHON">PYTHON</a></code> | CPython, built from source (`configure --prefix … --enable-shared`) on AL2023. |
| <code><a href="#cdk-github-microvm-runners.ToolchainKind.NODE">NODE</a></code> | Node.js, unpacked from the official nodejs.org linux-arm64 tarball. |

---

##### `PYTHON` <a name="PYTHON" id="cdk-github-microvm-runners.ToolchainKind.PYTHON"></a>

CPython, built from source (`configure --prefix … --enable-shared`) on AL2023.

---


##### `NODE` <a name="NODE" id="cdk-github-microvm-runners.ToolchainKind.NODE"></a>

Node.js, unpacked from the official nodejs.org linux-arm64 tarball.

---


### WebhookEndpointKind <a name="WebhookEndpointKind" id="cdk-github-microvm-runners.WebhookEndpointKind"></a>

Which form of endpoint a `WebhookEndpoint` represents.

#### Members <a name="Members" id="Members"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#cdk-github-microvm-runners.WebhookEndpointKind.FUNCTION_URL">FUNCTION_URL</a></code> | A Lambda Function URL. |

---

##### `FUNCTION_URL` <a name="FUNCTION_URL" id="cdk-github-microvm-runners.WebhookEndpointKind.FUNCTION_URL"></a>

A Lambda Function URL.

---

