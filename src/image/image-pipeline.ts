import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { FileSystem, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { dockerfileCopiesAgent } from './agent-contract.js';
import type { RunnerImage } from './runner-image.js';
import type { ImageLogs } from '../types/image-logs.js';
import type { MicrovmSize } from '../types/microvm-size.js';
import type { RunnerNetwork } from '../types/runner-network.js';

/**
 * Directory holding the verbatim in-VM agent runtime files (`agent.mjs`,
 * `entrypoint.sh`) shipped alongside this module — see
 * `src/image/assets/README` (Task 5). Resolved relative to this compiled
 * module's own location (`__dirname`) rather than `process.cwd()` so it works
 * both when tests run against `src/` and against a built `lib/` package,
 * whose post-compile step copies these two files next to the compiled
 * `image-pipeline.js`.
 *
 * `__dirname` rather than `import.meta.url`: jsii compiles and ships this
 * package as CommonJS, where `import.meta` is unavailable.
 */
const AGENT_RUNTIME_DIR = join(__dirname, 'assets');

/** `AWS::Lambda::MicrovmImage` Name pattern; the pipeline appends `-<8-hex-char contentHash prefix>`. */
const RUNNER_SET_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_IMAGE_NAME_LENGTH = 64;
const HASH_PREFIX_LENGTH = 8;

/** The version of the managed `al2023-1` base MicroVM image built from by default — tunable via {@link ImagePipelineProps.baseImageVersion} should AWS publish a newer one. */
const DEFAULT_BASE_IMAGE_VERSION = '0';
/** Default seconds the service waits for the in-VM agent's `/ready` hook before failing the build — tunable via {@link ImagePipelineProps.readyTimeoutSeconds}. */
const DEFAULT_READY_TIMEOUT_SECONDS = 300;
/** Default seconds the service waits for the in-VM agent's `/run` hook to accept a job — tunable via {@link ImagePipelineProps.runTimeoutSeconds}, up to the service maximum of 60. */
const DEFAULT_RUN_TIMEOUT_SECONDS = 60;

/** Props for `ImagePipeline`. */
export interface ImagePipelineProps {
  /** The runner image to build: `RunnerImage.fromOptions()` for a synthesized Dockerfile, `RunnerImage.fromInline(text)` for Dockerfile text, or `RunnerImage.fromDockerfile(dir)` for a Dockerfile and build context on disk. */
  readonly image: RunnerImage;
  /** The size the built image runs at, which becomes its memory floor. */
  readonly size: MicrovmSize;
  /** How the build and the VMs reach the network. */
  readonly network: RunnerNetwork;
  /** Where the build's logs go. Left unset, the build emits no logs; `ImageLogs.enabled()` sends them to the platform's group, and `ImageLogs.enabled(logGroup)` to a group you supply. */
  readonly imageLogs?: ImageLogs;
  /**
   * Identifier for the runner set this image belongs to. It is combined with
   * the first 8 hex characters of the image's `contentHash` to form the
   * image's name, so a content change publishes a new image and an unchanged
   * one is a no-op. Must match `^[a-zA-Z0-9-_]+$`, and must be 55 characters
   * or fewer so that `<runnerSetId>-<8-hex-chars>` stays within the service's
   * 64-character name limit.
   */
  readonly runnerSetId: string;
  /** Version of the managed `al2023-1` base image to build from. @default '0' */
  readonly baseImageVersion?: string;
  /** Seconds the service waits for the in-VM agent's `/ready` hook before failing the image build. @default 300 */
  readonly readyTimeoutSeconds?: number;
  /** Seconds the service waits for the in-VM agent's `/run` hook to accept a launch. Service maximum: 60. @default 60 */
  readonly runTimeoutSeconds?: number;
}

/**
 * The build behind one runner class's MicroVM image. `addRunnerClass` creates
 * one for each class it registers and returns it as
 * `RunnerClass.imagePipeline`, so this is a handle you read rather than a
 * construct you instantiate.
 *
 * It stages the class's Dockerfile and build context as a CDK asset, declares
 * the `AWS::Lambda::MicrovmImage` resource that CloudFormation builds from it,
 * and creates the IAM role that build runs as. Reading it is how you reach the
 * built image's name and ARN, and the role the build runs as.
 *
 * @example
 * const buildClass = runners.addRunnerClass('build', {
 *   size: MicrovmSize.GB4,
 *   image: RunnerImage.fromOptions({ systemPackages: ['jq'] }),
 * });
 *
 * new cdk.CfnOutput(stack, 'BuildImageName', {
 *   value: buildClass.imagePipeline.imageName,
 * });
 */
export class ImagePipeline extends Construct {
  /** ARN of the built MicroVM image. */
  public readonly imageArn: string;
  /** Name of the built MicroVM image, `<runnerSetId>-<8 hex characters of the content hash>`. */
  public readonly imageName: string;
  /** The underlying `AWS::Lambda::MicrovmImage` resource. */
  public readonly imageResource: lambda.CfnMicrovmImage;
  /** IAM role the image build runs as, able to read the staged build context and pull any private container base image. */
  public readonly buildRole: iam.IRole;

  constructor(scope: Construct, id: string, props: ImagePipelineProps) {
    super(scope, id);

    validateRunnerSetId(props.runnerSetId);
    // The image Name hash must ALSO cover the packaged microvm-runner runtime
    // assets (agent.mjs, entrypoint.sh): RunnerImage.contentHash only hashes
    // the rendered Dockerfile + consumer options, so an agent change would
    // otherwise keep the same Name and never trigger a CFN rebuild —
    // found live 2026-07-19 when an agent fix silently didn't ship.
    const agentAssetsHash = createHash('sha256')
      .update(readFileSync(join(AGENT_RUNTIME_DIR, 'agent.mjs')))
      .update(readFileSync(join(AGENT_RUNTIME_DIR, 'entrypoint.sh')))
      .digest('hex');
    const hashPrefix = createHash('sha256')
      .update(props.image.contentHash)
      .update(agentAssetsHash)
      .digest('hex')
      .slice(0, HASH_PREFIX_LENGTH);
    const imageName = `${props.runnerSetId}-${hashPrefix}`;
    if (imageName.length > MAX_IMAGE_NAME_LENGTH) {
      throw new Error(
        `ImagePipeline: runnerSetId "${props.runnerSetId}" is too long — the resulting image Name "${imageName}" is ${imageName.length} characters, exceeding AWS::Lambda::MicrovmImage's 64-character limit once the ${HASH_PREFIX_LENGTH}-char content-hash suffix (plus separator) is appended. Use a runnerSetId of ${MAX_IMAGE_NAME_LENGTH - HASH_PREFIX_LENGTH - 1} characters or fewer.`,
      );
    }
    this.imageName = imageName;

    const stagingDir = stageBuildContext(props.image);
    const codeAsset = new s3_assets.Asset(this, 'Code', { path: stagingDir });

    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    // CORRECTION (Spike 2): the build role's trust policy needs BOTH
    // sts:AssumeRole (added by the ServicePrincipal above) AND
    // sts:TagSession, per the getting-started doc / real successful deploy.
    buildRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:TagSession'],
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
      }),
    );
    codeAsset.grantRead(buildRole);
    // Scoped to the MicroVMs service's own log-group naming convention
    // (/aws/lambda-microvms/<image-name> — VERIFIED LIVE 2026-07-19; the docs/design guess had a slash not a dash. Confirmed at
    // dogfood), not a blanket account-wide `:*` — the build role has no
    // business writing outside its own service's log groups. The `:*`
    // suffix variant additionally covers the log-STREAM-level resource
    // PutLogEvents requires.
    const buildLogGroupArnPrefix = `arn:aws:logs:${Stack.of(this).region}:${Stack.of(this).account}:log-group:/aws/lambda-microvms/*`;
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [buildLogGroupArnPrefix, `${buildLogGroupArnPrefix}:*`],
      }),
    );
    // ecr:GetAuthorizationToken has no resource-level permissions (the ECR
    // API requires resource "*"); the pull actions are also left
    // unscoped because the build role doesn't know ahead of time which
    // private ECR repository (if any) a consumer's Dockerfile FROM line
    // references — this construct has no props surface yet for a specific
    // repo grant.
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchCheckLayerAvailability',
        ],
        resources: ['*'],
      }),
    );
    this.buildRole = buildRole;

    // CORRECTION: the CFN resource's LoggingProperty.disabled is a plain
    // boolean (verified against the installed aws-cdk-lib@2.261.0's
    // lambda.generated.js: `CfnMicrovmImageLoggingPropertyValidator` runs
    // `cdk.validateBoolean` on it and `convertCfnMicrovmImageLoggingPropertyToCloudFormation`
    // renders `Disabled: booleanToCloudFormation(...)`) — NOT the
    // empty-object `{disabled:{}}` shape the RunMicrovm *runtime API*'s
    // `Logging` union uses (see `shared/microvm-client.ts`). Same concept,
    // two different schemas between the CFN resource and the SDK call.
    const logging: lambda.CfnMicrovmImage.LoggingProperty = props.imageLogs
      ? { cloudWatch: { logGroup: props.imageLogs.logGroup?.logGroupName } }
      : { disabled: true };
    // A caller-supplied custom log group needs an explicit write grant — the
    // build role's own hardcoded `/aws/lambda-microvms/*` policy statement
    // above only covers the platform's own log-group naming convention, not
    // an arbitrary consumer log group.
    if (props.imageLogs?.logGroup) {
      props.imageLogs.logGroup.grantWrite(buildRole);
    }

    // Service maximum discovered at first live deploy (CFN early validation,
    // 2026-07-18): the /run hook timeout must be <= 60s. Not documented in
    // the MicroVMs guide or CLI help at the time.
    const runTimeoutSeconds =
      props.runTimeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS;
    if (runTimeoutSeconds > 60 || runTimeoutSeconds < 1) {
      throw new Error(
        `runTimeoutSeconds must be 1-60 (service maximum is 60; got ${runTimeoutSeconds})`,
      );
    }
    this.imageResource = new lambda.CfnMicrovmImage(this, 'Image', {
      name: imageName,
      description: `microvm-runner image for runner set "${props.runnerSetId}"`,
      codeArtifact: { uri: codeAsset.s3ObjectUrl },
      // CORRECTION (Spike 2): baseImageArn's region must come from the
      // stack, never hardcoded — this is a CFN intrinsic when the stack's
      // region is unresolved (environment-agnostic stack).
      baseImageArn: `arn:aws:lambda:${Stack.of(this).region}:aws:microvm-image:al2023-1`,
      baseImageVersion: props.baseImageVersion ?? DEFAULT_BASE_IMAGE_VERSION,
      buildRoleArn: buildRole.roleArn,
      // CORRECTION (Spike 2): cpuConfigurations carries architecture ONLY
      // (ARM_64 is the only supported value); memory is a separate
      // resources[].minimumMemoryInMiB entry, in MiB not GB.
      additionalOsCapabilities: props.image.additionalOsCapabilities,
      cpuConfigurations: [{ architecture: 'ARM_64' }],
      resources: [{ minimumMemoryInMiB: props.size.memoryMib }],
      // CORRECTION (Spike 2): environmentVariables is an array of
      // {key, value} structs, not a map. No props surface for build-time
      // container env vars yet (distinct from the image's baked-in `ENV`
      // lines, which the Dockerfile already carries).
      environmentVariables: [],
      egressNetworkConnectors: props.network.connectorArns,
      hooks: {
        port: 8080,
        // Hook paths are a FIXED service convention (not configurable) —
        // only ENABLED/DISABLED + a timeout per hook, plus the shared port.
        microvmImageHooks: {
          ready: 'ENABLED',
          readyTimeoutInSeconds:
            props.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS,
          validate: 'DISABLED',
        },
        // The launcher delivers runHookPayload to the /run hook — must be
        // enabled for the runner to ever start. Real generated-type shape
        // (aws-cdk-lib@2.261.0/aws-lambda/lib/lambda.generated.d.ts,
        // CfnMicrovmImage.MicrovmHooksProperty): run?, runTimeoutInSeconds?,
        // plus resume/suspend/terminate (+ timeouts) which we don't set —
        // this matches what the task brief asked for exactly, once found in
        // the generated types (the spike itself only exercised
        // microvmImageHooks, not microvmHooks).
        microvmHooks: {
          run: 'ENABLED',
          runTimeoutInSeconds: runTimeoutSeconds,
        },
      },
      // CORRECTION (Spike 2): logging.cloudWatch has no "enabled" field —
      // presence of the (possibly empty) cloudWatch block turns logging on.
      logging,
    });

    this.imageArn = this.imageResource.attrImageArn;
  }
}

function validateRunnerSetId(runnerSetId: string): void {
  if (!RUNNER_SET_ID_PATTERN.test(runnerSetId)) {
    throw new Error(
      `ImagePipeline: runnerSetId "${runnerSetId}" is invalid — it must match ${RUNNER_SET_ID_PATTERN} (AWS::Lambda::MicrovmImage's Name pattern is ^[a-zA-Z0-9-_]+$, and the pipeline appends "-<8-hex-char hash>" to it).`,
    );
  }
}

/**
 * Assemble the Docker build context for `image` in a fresh temp directory
 * and return its path, ready to hand to `aws_s3_assets.Asset`.
 *
 * - `RunnerImage.fromOptions()`: write the already-rendered Dockerfile text,
 *   then copy each `ImageAsset.source` into `assets/<index>/`, matching the
 *   `COPY assets/<index>/ <target>` lines `renderDockerfile` emitted.
 * - `RunnerImage.fromInline(text)`: the same text path — `text` becomes the
 *   context's `Dockerfile` and there are no assets, so the context holds
 *   that file plus the `microvm-runner/` directory below and nothing else.
 *   Its agent-COPY check already ran in the factory, where the text arrived.
 * - `RunnerImage.fromDockerfile(dir)`: copy the consumer's whole `dir` as
 *   the build context verbatim. The consumer's Dockerfile MUST already
 *   contain a line referencing `microvm-runner/agent.mjs` (e.g. `COPY
 *   microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs`) — BYO images
 *   still need the in-VM agent to serve the MicroVM lifecycle hooks;
 *   missing that line is a synth-time error.
 *
 * In both cases, the canonical `microvm-runner/agent.mjs` +
 * `microvm-runner/entrypoint.sh` are (re-)written last so they're always
 * the pipeline's own copies, never a stale one a BYO consumer happened to
 * have lying around in their dir.
 */
function stageBuildContext(image: RunnerImage): string {
  const stagingDir = FileSystem.mkdtemp('microvm-runner-image-');

  if (image.dockerfile !== undefined) {
    writeFileSync(join(stagingDir, 'Dockerfile'), image.dockerfile);
    (image.assets ?? []).forEach((asset, index) => {
      const destDir = join(stagingDir, 'assets', String(index));
      copyIntoDir(asset.source, destDir);
    });
  } else {
    const dir = image.dockerfileDir;
    if (dir === undefined) {
      // Unreachable given RunnerImage's public factories always set exactly
      // one of `dockerfile`/`dockerfileDir` — guarded defensively anyway.
      throw new Error(
        'ImagePipeline: RunnerImage has neither `dockerfile` nor `dockerfileDir` set.',
      );
    }
    const dockerfilePath = join(dir, 'Dockerfile');
    if (!existsSync(dockerfilePath)) {
      throw new Error(
        `ImagePipeline: no Dockerfile found at "${dockerfilePath}" — RunnerImage.fromDockerfile(dir) requires dir/Dockerfile to exist.`,
      );
    }
    const dockerfileText = readFileSync(dockerfilePath, 'utf8');
    // Same rule `RunnerImage.fromInline()` applies to the text it is handed,
    // defined once in `agent-contract.ts` — here it runs against the file
    // read off disk, which is the first moment this path has the text.
    if (!dockerfileCopiesAgent(dockerfileText)) {
      throw new Error(
        `ImagePipeline: the Dockerfile at "${dockerfilePath}" must COPY the in-VM agent — expected a line referencing "microvm-runner/agent.mjs" (e.g. "COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs"). BYO images still need the agent to serve the MicroVM lifecycle hooks.`,
      );
    }
    cpSync(dir, stagingDir, { recursive: true });
  }

  const agentStagingDir = join(stagingDir, 'microvm-runner');
  mkdirSync(agentStagingDir, { recursive: true });
  cpSync(
    join(AGENT_RUNTIME_DIR, 'agent.mjs'),
    join(agentStagingDir, 'agent.mjs'),
  );
  cpSync(
    join(AGENT_RUNTIME_DIR, 'entrypoint.sh'),
    join(agentStagingDir, 'entrypoint.sh'),
  );

  return stagingDir;
}

/** Copy `source` (file or directory) into `destDir`, creating `destDir` if needed. Mirrors `COPY <src>/ <target>` semantics for directories. */
function copyIntoDir(source: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  if (statSync(source).isDirectory()) {
    cpSync(source, destDir, { recursive: true });
  } else {
    cpSync(source, join(destDir, basename(source)));
  }
}
