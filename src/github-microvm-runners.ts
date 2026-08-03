import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArnFormat, Duration, Lazy, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { ImagePipeline } from './image/image-pipeline.js';
import { RunnerImage } from './image/runner-image.js';
import { validateRegion } from './regions.js';
import type { ConsoleLogs } from './types/console-logs.js';
import type { GithubAuth } from './types/github-auth.js';
import type { MicrovmIdlePolicy } from './types/idle-policy.js';
import type { ImageLogs } from './types/image-logs.js';
import type { RunnerClass, RunnerClassProps } from './types/runner-class.js';
import { RunnerNetwork, RunnerNetworkKind } from './types/runner-network.js';
import { RunnerScopeKind, type RunnerScope } from './types/runner-scope.js';
import {
  WebhookEndpoint,
  WebhookEndpointKind,
} from './types/webhook-endpoint.js';

/**
 * Directory holding the handler source (`src/handlers/*.ts`) this construct
 * wires up as Lambda entries, resolved relative to this compiled module's
 * own location (`__dirname`) — same trick as `ImagePipeline`'s
 * `AGENT_RUNTIME_DIR` (`src/image/image-pipeline.ts`), so it works both when
 * tests run against `src/` and against a built `lib/` package, whose
 * post-compile step copies the bundled handlers next to the compiled
 * `github-microvm-runners.js`.
 *
 * `__dirname` rather than `import.meta.url`: jsii compiles and ships this
 * package as CommonJS, where `import.meta` is unavailable.
 */
const HANDLERS_DIR = join(__dirname, 'handlers');

const DEFAULT_SIZE_CLASS_LABEL = 'microvm';
const RUNNER_SET_ID_HASH_LENGTH = 8;
/**
 * Launcher Lambda timeout, in seconds — comfortably under the job queue's
 * 120s visibility timeout (see the `JobQueue` below), leaving headroom
 * before an in-flight message would become visible again. Also the floor
 * `janitorInterval` must exceed (see `validateNumericProps`): the janitor
 * must never be able to run faster than a single launcher invocation can
 * still be in flight, or it could reconcile a runner whose mapping row
 * hasn't been written yet.
 */
const LAUNCHER_TIMEOUT_SECONDS = 120;
/** Grace the platform's own MicroVM `maximumDurationInSeconds` adds beyond a job's declared duration (mirrors `launcher.ts`'s `MAX_DURATION_GRACE_SECONDS`) — used below to cap `maxJobDuration` at the platform's fixed per-VM lifetime ceiling. */
const MAX_DURATION_GRACE_SECONDS = 300;
/** Lambda MicroVMs' own hard per-VM lifetime ceiling (fixed by the platform, not configurable). `maxJobDuration` + the grace above must never exceed this. */
const PLATFORM_VM_LIFETIME_CEILING_SECONDS = 8 * 3600;
/** `events.Schedule.rate()`'s minimum supported period. */
const EVENTBRIDGE_RATE_FLOOR_SECONDS = 60;

function assertPositiveInteger(propName: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `GithubMicrovmRunners: ${propName} must be a positive integer (got ${value}).`,
    );
  }
}

/**
 * Constructor-time validation for every numeric/Duration knob on
 * {@link GithubMicrovmRunnersProps}. Each failure throws a clear, per-prop
 * message rather than letting a bad value silently reach a handler's env var
 * (where it would only surface as a `numEnv` runtime throw on the first
 * invocation, or worse, a permissive default like `NaN` comparisons always
 * being `false`).
 */
function validateNumericProps(p: {
  maxConcurrentVms: number;
  webhookReservedConcurrency?: number;
  idleRunnerGraceSeconds: number;
  keepImageVersions: number;
  maxJobDuration: Duration;
  janitorInterval: Duration;
  launcherTimeoutSeconds: number;
}): void {
  assertPositiveInteger('maxConcurrentVms', p.maxConcurrentVms);
  // Optional: reserving concurrency is an opt-in cap. When unset the construct
  // leaves the webhook Lambda with no reservation, so there's nothing to check.
  // When a value IS provided, a positive integer is the only sensible input:
  // `0` (or negative) would throttle the webhook to disabled — far likelier a
  // mistake than an intent — so it's rejected here rather than silently applied.
  if (p.webhookReservedConcurrency !== undefined) {
    assertPositiveInteger(
      'webhookReservedConcurrency',
      p.webhookReservedConcurrency,
    );
  }
  assertPositiveInteger('idleRunnerGraceSeconds', p.idleRunnerGraceSeconds);
  assertPositiveInteger('keepImageVersions', p.keepImageVersions);

  // Duration.toSeconds() (default options) itself throws if the value isn't
  // an exact whole number of seconds, so no separate integrality check is
  // needed for either Duration prop below.
  const maxJobDurationSeconds = p.maxJobDuration.toSeconds();
  const maxJobDurationCeilingSeconds =
    PLATFORM_VM_LIFETIME_CEILING_SECONDS - MAX_DURATION_GRACE_SECONDS;
  if (maxJobDurationSeconds <= 0) {
    throw new Error(
      `GithubMicrovmRunners: maxJobDuration must be positive (got ${maxJobDurationSeconds}s).`,
    );
  }
  if (maxJobDurationSeconds > maxJobDurationCeilingSeconds) {
    throw new Error(
      `GithubMicrovmRunners: maxJobDuration must be at most ${maxJobDurationCeilingSeconds}s (8h minus the ${MAX_DURATION_GRACE_SECONDS}s platform grace added at launch), got ${maxJobDurationSeconds}s.`,
    );
  }

  const janitorIntervalSeconds = p.janitorInterval.toSeconds();
  if (janitorIntervalSeconds < EVENTBRIDGE_RATE_FLOOR_SECONDS) {
    throw new Error(
      `GithubMicrovmRunners: janitorInterval must be at least ${EVENTBRIDGE_RATE_FLOOR_SECONDS}s (the EventBridge Schedule rate() floor), got ${janitorIntervalSeconds}s.`,
    );
  }
  if (janitorIntervalSeconds <= p.launcherTimeoutSeconds) {
    throw new Error(
      `GithubMicrovmRunners: janitorInterval (${janitorIntervalSeconds}s) must be strictly greater than the launcher function's timeout (${p.launcherTimeoutSeconds}s).`,
    );
  }
}

/**
 * Checks {@link GithubMicrovmRunnersProps.warmPoolInterval} against the
 * EventBridge `rate()` floor. Deliberately NOT eager/unconditional at
 * construction: whether *any* runner class ends up warm is only known once
 * (and if) the first warm `addRunnerClass` call arrives, and a runner set with no
 * warm class never synthesizes anything that reads `warmPoolInterval` at all
 * — throwing on it anyway would be a new failure mode for runner sets that never
 * touch the warm feature, breaking the opt-in-means-opt-in posture the rest
 * of this feature holds to (mirrors why the old `warmPool`-prop version only
 * ever validated this alongside a set `warmPool`).
 *
 * Called from {@link GithubMicrovmRunners.createWarmPoolInfra} — which only
 * ever runs once a warm class exists — rather than from a synth-time
 * `node.addValidation`, because `createWarmPoolInfra` runs eagerly (the
 * moment the first warm class registers, not deferred to synth) and itself
 * calls `events.Schedule.rate(warmPoolInterval)`, which throws its own
 * generic error for a sub-floor Duration; this must run first to pre-empt
 * that with a clearer message. Returns an error string rather than throwing
 * so the caller decides how to surface it.
 */
function warmPoolIntervalFloorError(
  warmPoolInterval: Duration,
): string | undefined {
  const warmPoolIntervalSeconds = warmPoolInterval.toSeconds();
  if (warmPoolIntervalSeconds < EVENTBRIDGE_RATE_FLOOR_SECONDS) {
    return `GithubMicrovmRunners: warmPoolInterval must be at least ${EVENTBRIDGE_RATE_FLOOR_SECONDS}s (the EventBridge Schedule rate() floor), got ${warmPoolIntervalSeconds}s.`;
  }
  return undefined;
}

/**
 * Constructor-time validation for {@link GithubMicrovmRunnersProps.consoleLogs}
 * against `GithubMicrovmRunnersProps.vmExecutionRole`.
 *
 * Runtime console capture is impossible without an execution role: the platform
 * rejects `RunMicrovm` logging with `"Logging cannot be enabled without
 * providing executionRoleArn"` (live deploy, 2026-07-21), and the construct
 * never mints a VM identity on the caller's behalf. So enabling `consoleLogs`
 * requires `vmExecutionRole`, and the caller grants that role the two
 * console-write actions themselves — the construct never writes to a role it
 * did not create. {@link GithubMicrovmRunnersProps.imageLogs} needs no such
 * check: build logs are written by the image build role, not the VM.
 */
function validateLoggingProps(p: {
  consoleLogs?: ConsoleLogs;
  vmExecutionRole?: iam.IRole;
}): void {
  if (p.consoleLogs && !p.vmExecutionRole) {
    throw new Error(
      'GithubMicrovmRunners: consoleLogs: ConsoleLogs.enabled() requires vmExecutionRole. ' +
        "Console capture writes the VM's runtime output using the VM execution role, and the construct never " +
        'creates a VM identity for you. Pass vmExecutionRole and grant it logs:CreateLogStream and ' +
        'logs:PutLogEvents on the console log group (runners.vmConsoleLogGroup, or the group you pass to ConsoleLogs.enabled()).',
    );
  }
}

/**
 * The service's only ARN-addressable resource type is a MicroVM *image*
 * (`AWS::Lambda::MicrovmImage` -> `arn:aws:lambda:<region>:<account>:microvm-image:<name>`,
 * see `ImagePipeline.imageArn`). Individual running MicroVMs have no ARN at
 * all — confirmed against AWS's "Fine-tuning the Resources and Conditions
 * sections of policies" reference (`lambda-api-permissions-ref.html`), whose
 * resource-type list for the `lambda:` prefix covers Function/version/alias/
 * durable-execution/event-source-mapping/layer/code-signing-config only, no
 * `microvm` entry — so every VM-instance-lifecycle action below is scoped to
 * `Resource: '*'` (account+region wildcard); this is a known, documented
 * broadness, not an oversight. Also confirmed: the same reference states
 * that for actions not called out as exceptions (only `Invoke` ->
 * `InvokeFunction` and `GetLayerVersion*` -> `GetLayerVersion` are listed),
 * the IAM action name equals the API operation name prefixed with `lambda:`
 * — so `RunMicrovm`, `ListMicrovms`, `GetMicrovm`, `TerminateMicrovm`,
 * `CreateMicrovmAuthToken`, `ListMicrovmImageVersions`, and
 * `DeleteMicrovmImageVersion` are `lambda:RunMicrovm` etc., not a separate
 * `lambda-microvms:` namespace (despite that being the CLI/SDK's own
 * package name). `CreateMicrovmAuthToken` was added to the launcher's
 * VM-instance action set for the ingress-push JIT delivery pivot (see
 * `launcher.ts`'s module doc) — it mints the token used to push the JIT
 * config to a launched VM's ingress endpoint.
 */
const VM_INSTANCE_ACTIONS = [
  'lambda:RunMicrovm',
  'lambda:ListMicrovms',
  'lambda:GetMicrovm',
  'lambda:TerminateMicrovm',
  'lambda:CreateMicrovmAuthToken',
  // ResumeMicrovm: the launcher's warm-path (see launcher.ts's `tryWarmPath`,
  // warm-pool plan Task 5) resumes a claimed `SUSPENDED` warm-pool VM before
  // injecting its JIT config. Present unconditionally (like every other
  // action here) because the warm path is dead code, never invoked, when no
  // runner class sets `warm` (`readWarmPool()` returns `{}` when
  // `WARM_POOL_JSON` is `{}`/unset, and `tryWarmPath` treats an empty pool as
  // "no target for this label") — this grant costs nothing on a runner set with no
  // warm class and avoids a second, warm-conditional IAM statement on the
  // launcher's own policy.
  'lambda:ResumeMicrovm',
] as const;
const VM_LIFECYCLE_ACTIONS_NO_RUN = [
  'lambda:ListMicrovms',
  'lambda:GetMicrovm',
  'lambda:TerminateMicrovm',
] as const;
/** Image-version actions CAN be scoped to the owning image's ARN (unlike the VM-instance actions above). */
const IMAGE_VERSION_ACTIONS = [
  'lambda:ListMicrovmImageVersions',
  'lambda:DeleteMicrovmImageVersion',
] as const;

/** Props for `GithubMicrovmRunners`. */
export interface GithubMicrovmRunnersProps {
  /** How the runner set authenticates to GitHub, as an App or with a personal access token. This also carries the webhook secret. */
  readonly github: GithubAuth;
  /** Which GitHub scope, an organization or a list of repositories, registered runners are visible to. */
  readonly scope: RunnerScope;
  /**
   * Customer-managed KMS key for this runner set's data at rest: the DynamoDB
   * runner table, the SQS job queue and dead-letter queue, and any log group
   * this construct creates. Log groups you bring yourself, and the GitHub
   * secrets you pass in, keep their own keys.
   * @default undefined (AWS-managed keys)
   */
  readonly encryptionKey?: kms.IKey;
  /**
   * Permissions boundary applied to every IAM role this construct creates: the
   * handler execution roles, the per-class image build roles, and the
   * network-connector operator role. It is applied once at construct scope, so
   * roles created later also carry it — the warm-pool handler's role, and the
   * build role of any runner class registered after construction.
   * @default undefined (no boundary)
   */
  readonly permissionsBoundary?: iam.IManagedPolicy;
  /**
   * Removal policy for this runner set's stateful resources: the runner table
   * and any log group the construct creates. The table holds correlation data
   * for VMs that are currently running, all of which the janitor can rebuild
   * from the MicroVM and GitHub APIs.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;
  /**
   * Turn on DynamoDB point-in-time recovery for the runner table.
   * @default false
   */
  readonly pointInTimeRecovery?: boolean;
  /**
   * Retention for the CloudWatch log groups this construct creates: the
   * handler Lambda log groups and, when console capture is on, the VM console
   * group.
   * @default logs.RetentionDays.TWO_WEEKS
   */
  readonly logRetention?: logs.RetentionDays;
  /**
   * How long the dead-letter queue retains a failed launch or terminate
   * intent. SQS allows up to 14 days, which is also how long
   * `recoverStuckLaunches` has to re-drive a message before SQS drops it.
   * @default Duration.days(4) (SQS default)
   */
  readonly deadLetterRetention?: Duration;
  /**
   * How many times a launch intent is redriven before it dead-letters. A
   * runner set already at `maxConcurrentVms` redrives capacity-rejected
   * launches through this same budget, so on a runner set that regularly runs
   * at capacity this count is how long a queued job waits before its launch is
   * dropped. See docs/service-quotas.md.
   * @default 20
   */
  readonly maxReceiveCount?: number;
  /**
   * Memory, in MiB, for the handler Lambdas: the webhook, the launcher, the
   * janitor, and the warm pool. The janitor's sweep scans the runner table and
   * reconciles every running VM, so it is the handler most sensitive to this
   * on a busy runner set.
   * @default 128
   */
  readonly lambdaMemorySize?: number;
  /** Maximum number of MicroVMs this runner set runs at once. @default 10 */
  readonly maxConcurrentVms?: number;
  /**
   * How long a job may run before its MicroVM is terminated.
   *
   * The VM is killed five minutes after this value, not at it. The runner set
   * asks the platform for `maxJobDuration + 5 minutes`, so that a job which
   * reaches its own limit is stopped by the runner — which reports the timeout
   * to GitHub and lets the VM come down cleanly — rather than by the platform
   * removing the machine underneath it. Treat the five minutes as headroom for
   * that shutdown rather than as extra running time.
   *
   * @default Duration.hours(6)
   */
  readonly maxJobDuration?: Duration;
  /** How launched MicroVMs and image builds reach the network. @default RunnerNetwork.internetEgress() */
  readonly network?: RunnerNetwork;
  /** How the webhook handler is exposed to GitHub. @default WebhookEndpoint.functionUrl() */
  readonly webhook?: WebhookEndpoint;
  /** How often the janitor sweep runs. @default Duration.minutes(5) */
  readonly janitorInterval?: Duration;
  /**
   * Reserved concurrency for the webhook Lambda, which caps how many webhook
   * deliveries the runner set processes at once. Reserved concurrency is
   * carved out of the account's shared pool of unreserved concurrency, so a
   * runner set that sets it takes that capacity away from every other function
   * in the account. Must be a positive integer when set, since `0` would
   * disable the webhook entirely.
   * @default undefined (no reservation; the webhook draws from the shared pool)
   */
  readonly webhookReservedConcurrency?: number;
  /**
   * Additional regions to accept as Lambda MicroVMs regions, beyond the ones
   * this library already knows about. Deploying into a region on neither list
   * fails at synth.
   * @default [] (only the regions this library knows about)
   */
  readonly additionalRegions?: string[];
  /** How many seconds a registered runner may sit idle before the janitor's two-strike sweep treats it as stuck. @default 600 */
  readonly idleRunnerGraceSeconds?: number;
  /** How many MicroVM image versions to keep per runner class. The janitor prunes inactive versions past this count. @default 5 */
  readonly keepImageVersions?: number;
  /**
   * Re-launch jobs that are still waiting for a runner they never got. This is
   * the floor under an event-driven plane, and it is on by default.
   *
   * GitHub announces a job once. If the launch that announcement triggered
   * doesn't end with the job being served, nothing else ever asks again, and
   * the job waits for as long as the workflow allows with no error anywhere —
   * the plane looks healthy because by its own bookkeeping it did its work.
   * Each janitor sweep closes that hole from two directions: it re-drives
   * dead-lettered launch messages back onto the job queue, and it re-launches
   * claims whose VM is gone while the job is still queued. Both check with
   * GitHub first, so a job that has since completed or been cancelled is
   * discarded rather than booting a VM for work nobody is waiting on.
   *
   * Turn it off only if you want a job that slips through to stay stuck. The
   * cost of leaving it on is one extra GitHub read per sweep per candidate,
   * bounded per sweep so it cannot exhaust the installation's rate limit.
   *
   * The janitor counts recoveries under the `stuckLaunchesRecovered` and
   * `stuckClaimsRelaunched` metrics, which report when `emitMetrics` is on. A
   * count that stays high means launches are failing for some ongoing reason
   * and the recovery is masking it — alarm on it rather than ignoring it.
   * @default true
   */
  readonly recoverStuckLaunches?: boolean;
  /**
   * An AWS identity for this runner set's runner VMs. By default the VMs carry
   * no AWS identity at all: the runner agent talks outbound to GitHub, the
   * just-in-time registration is pushed to the VM over a platform-authenticated
   * channel, and a job that needs AWS assumes its own role through GitHub OIDC.
   *
   * With a role attached, the MicroVM's instance metadata service serves that
   * role's credentials to arbitrary job code, so every job running on this
   * runner set can do whatever the role can do. `consoleLogs` requires a role,
   * because the platform writes a VM's console output using it.
   * @default undefined (the VMs carry no AWS identity)
   */
  readonly vmExecutionRole?: iam.IRole;
  /**
   * Where build-time image logs go: the Docker build layers and the
   * ready-probe banner from each image build. `ImageLogs.enabled()` sends them
   * to the platform's own CloudWatch group, and `ImageLogs.enabled(logGroup)`
   * to a group whose retention and KMS key you control. These are written by
   * the image build role rather than by a VM, so they need no VM execution
   * role. Independent of `consoleLogs`.
   * @default undefined (no image logs)
   */
  readonly imageLogs?: ImageLogs;
  /**
   * Where a VM's runtime console goes: everything it prints while it boots,
   * runs the runner agent, and runs the job. `ConsoleLogs.enabled()` has the
   * construct create the group and expose it as `vmConsoleLogGroup`, and
   * `ConsoleLogs.enabled(logGroup)` uses one you control. The platform writes
   * these logs with the VM's own role, so this requires `vmExecutionRole`; see
   * `ConsoleLogs` for what that role means for job code. Independent of
   * `imageLogs`.
   * @default undefined (no runtime console capture)
   */
  readonly consoleLogs?: ConsoleLogs;
  /**
   * How often the warm-pool sweep refills pre-booted VMs. It applies only to
   * runner classes that set `RunnerClassProps.warmPoolSize`, and the warm-pool
   * handler and its schedule are only created once such a class is registered.
   * A runner set with no warm class never runs this sweep, and never reads
   * this value.
   * @default Duration.minutes(2)
   */
  readonly warmPoolInterval?: Duration;
  /**
   * Report this runner set's CloudWatch custom metrics. Those are the
   * janitor's per-sweep counters, the launcher's per-launch outcomes and
   * spin-up timings, and the warm pool's fill numbers — everything
   * `GithubMicrovmRunnersMetrics` names. With this off the handlers report
   * none of them.
   *
   * CloudWatch bills custom metrics per metric per month, and this runner set's
   * bill is not a fixed number: the launcher and warm-pool metrics carry a
   * runner-class dimension, so each one becomes a separate billable metric per
   * registered runner class.
   *
   * The two alarms backed by these metrics, `sweepErrorsAlarm` and
   * `stuckLaunchesRecoveredAlarm`, throw at synth unless this is on, since the
   * metric they watch would never report. `deadLetterQueueNotEmptyAlarm`
   * watches an SQS metric and works either way. The metric accessors on
   * `GithubMicrovmRunnersMetrics` return a `Metric` regardless, so a
   * dashboard can be built ahead of turning metrics on.
   *
   * @default false (no metrics emitted)
   */
  readonly emitMetrics?: boolean;
}

/** Tuning for the ready-made alarms on `GithubMicrovmRunnersMetrics`. */
export interface RunnerAlarmOptions {
  /** Value at or above which the alarm fires. @default 1 */
  readonly threshold?: number;
  /** Consecutive breaching periods before the alarm fires. @default 1 (3 for the stuck-launch alarm) */
  readonly evaluationPeriods?: number;
  /** Aggregation period for the metric. @default Duration.minutes(5) */
  readonly period?: Duration;
}

/**
 * The CloudWatch metrics a runner set reports, and ready-made alarms over
 * them. A `GithubMicrovmRunners` exposes its own as `runners.metrics`.
 *
 * The metrics live in the `MicrovmRunners` namespace, tagged with the runner
 * set's id. The janitor reports one set of counters per sweep, the launcher
 * one per launch, and the warm pool one per refill sweep. Launcher and
 * warm-pool metrics are also tagged with the runner class the launch belongs
 * to, which is why those accessors take a runner-class label. Every method
 * here names one of those metrics, or the dead-letter queue's own SQS metric;
 * the class carries no data of its own.
 *
 * Everything except `deadLetterQueueDepth` reports only when
 * `GithubMicrovmRunnersProps.emitMetrics` is on. The accessors return a
 * `Metric` either way, so a dashboard can be built ahead of turning metrics
 * on. The two alarms over those metrics throw at synth instead, rather than
 * synthesizing an alarm that could never fire.
 *
 * @example
 * new cw.Alarm(stack, 'SweepErrors', {
 *   metric: runners.metrics.errors(),
 *   threshold: 1,
 *   evaluationPeriods: 1,
 * });
 */
export class GithubMicrovmRunnersMetrics {
  private static readonly NAMESPACE = 'MicrovmRunners';

  constructor(
    private readonly runnerSetId: string,
    private readonly deadLetterQueue: sqs.IQueue,
    /**
     * Whether the runner set reports the metrics this class names, which is
     * `GithubMicrovmRunnersProps.emitMetrics`. Every accessor except
     * `deadLetterQueueDepth` depends on it, though they all return a `Metric`
     * either way; only the two alarms over those metrics refuse to synthesize.
     */
    private readonly emitMetrics: boolean = false,
  ) {}

  /** Messages sitting in the dead-letter queue: a launch or terminate intent SQS gave up redriving. */
  public deadLetterQueueDepth(): cloudwatch.Metric {
    return this.deadLetterQueue.metricApproximateNumberOfMessagesVisible();
  }

  /** Janitor sweep count: running VMs that belong to this runner set but have no row in the runner table, reaped once a second sweep has seen the same VM unaccounted for. */
  public orphansReaped(): cloudwatch.Metric {
    return this.emfMetric('orphansReaped');
  }

  /** Janitor sweep count: runners that registered with GitHub and then sat idle past `idleRunnerGraceSeconds`, reaped once a second sweep has seen them the same way. */
  public stuckRunnersReaped(): cloudwatch.Metric {
    return this.emfMetric('stuckRunnersReaped');
  }

  /** Janitor sweep count: VMs terminated for having run longer than `maxJobDuration` plus the platform's own grace. */
  public lifetimeKills(): cloudwatch.Metric {
    return this.emfMetric('lifetimeKills');
  }

  /** Janitor sweep count: VMs an earlier sweep had marked as suspect, cleared because this sweep found them accounted for or working again. */
  public suspectsCleared(): cloudwatch.Metric {
    return this.emfMetric('suspectsCleared');
  }

  /** Janitor sweep count: inactive MicroVM image versions pruned past `keepImageVersions`. */
  public imageVersionsPruned(): cloudwatch.Metric {
    return this.emfMetric('imageVersionsPruned');
  }

  /** Janitor sweep count: runner table rows deleted, either because the VM they name is confirmed gone or because a real row superseded an orphaned one. */
  public tableRowsCleaned(): cloudwatch.Metric {
    return this.emfMetric('tableRowsCleaned');
  }

  /** Janitor sweep count: dead-lettered launches re-driven onto the job queue, which is 0 unless `recoverStuckLaunches` is on. A value that stays high means launches are failing for some reason other than a GitHub outage. */
  public stuckLaunchesRecovered(): cloudwatch.Metric {
    return this.emfMetric('stuckLaunchesRecovered');
  }

  /** Janitor sweep count: launches that were claimed but never served, re-launched from the orphaned claim. This is 0 unless `recoverStuckLaunches` is on. */
  public stuckClaimsRelaunched(): cloudwatch.Metric {
    return this.emfMetric('stuckClaimsRelaunched');
  }

  /** Janitor sweep count: failures on individual VMs, rows, or image versions during a sweep. The sweep isolates each one and still completes. */
  public errors(): cloudwatch.Metric {
    return this.emfMetric('errors');
  }

  // --- Launcher metrics (per runner class) --------------------------------
  // `src/handlers/launcher.ts`'s `emitLaunchMetrics` emits these dimensioned
  // by `RunnerSetId` + `SizeClass`, so each accessor takes the runner-class
  // label (`addRunnerClass`'s `label`, which is the `SizeClass` dimension
  // value). A launch whose labels matched no registered class is emitted under
  // the literal label `unknown`.

  /** Launches served from the warm pool: a pre-booted VM claimed and resumed rather than a new one launched. */
  public warmHit(runnerClassLabel: string): cloudwatch.Metric {
    return this.classMetric('WarmHit', runnerClassLabel);
  }

  /** Launches served by booting a new VM, because no warm VM was available or the class keeps no warm pool. */
  public coldBoot(runnerClassLabel: string): cloudwatch.Metric {
    return this.classMetric('ColdBoot', runnerClassLabel);
  }

  /**
   * Launches the MicroVM service rejected for capacity. This is the runner
   * set's quota signal: a value that stays above zero means jobs are queueing
   * behind a MicroVM quota, or behind `maxConcurrentVms`, rather than running,
   * and each rejected launch spends one of its `maxReceiveCount` redrives on
   * the way to the dead-letter queue. See docs/service-quotas.md.
   */
  public capacityRejected(runnerClassLabel: string): cloudwatch.Metric {
    return this.classMetric('CapacityRejected', runnerClassLabel);
  }

  /**
   * Launches skipped because the job had already stopped waiting for a runner
   * by the time the launch was processed — cancelled, or its run deleted.
   *
   * No VM is booted for these, so a rising count is work avoided rather than
   * work lost. It tracks how often jobs are cancelled while still queued,
   * which is routine on a repository using concurrency groups: every re-push
   * cancels the run it superseded. A count that dwarfs `ColdBoot` suggests the
   * workflows feeding this runner set are cancelled more often than they
   * finish, which is usually a question about their triggers rather than
   * about the runner set.
   *
   * @example
   * new cw.Alarm(stack, 'MostlyCancelled', {
   *   metric: runners.metrics.cancelledBeforeLaunch('microvm'),
   *   threshold: 50,
   *   evaluationPeriods: 3,
   * });
   */
  public cancelledBeforeLaunch(runnerClassLabel: string): cloudwatch.Metric {
    return this.classMetric('CancelledBeforeLaunch', runnerClassLabel);
  }

  /** Warm-pool claims that were throttled and fell back to booting a new VM. The same launch can also count under `ColdBoot` or `CapacityRejected`. */
  public warmThrottled(runnerClassLabel: string): cloudwatch.Metric {
    return this.classMetric('WarmThrottled', runnerClassLabel);
  }

  /** Milliseconds to spin up a warm launch: claiming the VM, resuming it, and pushing the runner's registration. Reported as an average rather than a sum. */
  public warmSpinUpMs(runnerClassLabel: string): cloudwatch.Metric {
    return this.classGaugeMetric('WarmSpinUpMs', runnerClassLabel);
  }

  /** Milliseconds to spin up a cold launch: starting the VM, waiting for it to boot, and pushing the runner's registration. Reported as an average rather than a sum. */
  public coldSpinUpMs(runnerClassLabel: string): cloudwatch.Metric {
    return this.classGaugeMetric('ColdSpinUpMs', runnerClassLabel);
  }

  // --- Warm-pool metrics (per runner class) -------------------------------
  // `src/handlers/warm-pool.ts`'s `emitPoolMetrics` emits these once per
  // convergence tick per warm class, dimensioned the same way. Only classes
  // that set `RunnerClassProps.warmPoolSize` ever report.

  /** Warm VMs suspended and available for this class as of the last warm-pool sweep. */
  public poolCurrent(runnerClassLabel: string): cloudwatch.Metric {
    return this.classGaugeMetric('PoolCurrent', runnerClassLabel);
  }

  /** This class's `warmPoolSize`, as the last warm-pool sweep read it. */
  public poolTarget(runnerClassLabel: string): cloudwatch.Metric {
    return this.classGaugeMetric('PoolTarget', runnerClassLabel);
  }

  /** Warm VMs the last warm-pool sweep launched to reach `warmPoolSize`. */
  public poolLaunched(runnerClassLabel: string): cloudwatch.Metric {
    return this.classMetric('PoolLaunched', runnerClassLabel);
  }

  /** Warm-VM launches a warm-pool sweep attempted and failed. A value that stays above zero means the pool is not reaching `warmPoolSize`, so jobs keep booting new VMs instead of resuming warm ones. */
  public poolLaunchFailed(runnerClassLabel: string): cloudwatch.Metric {
    return this.classMetric('PoolLaunchFailed', runnerClassLabel);
  }

  private emfMetric(metricName: string): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: GithubMicrovmRunnersMetrics.NAMESPACE,
      metricName,
      dimensionsMap: { RunnerSetId: this.runnerSetId },
      statistic: 'Sum',
    });
  }

  /**
   * Two-dimension counterpart of {@link emfMetric}: the launcher and warm-pool
   * envelopes carry a second `SizeClass` dimension, which {@link emfMetric}'s
   * hardcoded single-dimension map structurally cannot express. Kept as a
   * separate helper rather than an optional-arg overload on {@link emfMetric},
   * since optional-arg overloads are not jsii-clean.
   *
   * `'Sum'` — these are all counters (occurrences per period), matching
   * {@link emfMetric}.
   */
  private classMetric(
    metricName: string,
    runnerClassLabel: string,
  ): cloudwatch.Metric {
    return this.classMetricWith(metricName, runnerClassLabel, 'Sum');
  }

  /**
   * {@link classMetric} for the metrics a `'Sum'` would misreport — the two
   * `*SpinUpMs` latencies and the two pool gauges.
   *
   * `'Average'`, not `'Sum'`, for two distinct reasons:
   * - `WarmSpinUpMs`/`ColdSpinUpMs` are per-launch durations. A summed
   *   duration ("47 seconds spent spinning up this period") answers no
   *   question an operator has — it just tracks launch volume. Mean spin-up
   *   per launch is the meaningful statistic, and the raw metric stays
   *   reachable via `.with({ statistic: 'p99' })` for a percentile view.
   * - `PoolCurrent`/`PoolTarget` are gauges the warm-pool sweep re-reports
   *   every tick, so summing them over an aggregation period multiplies by the
   *   number of ticks in it — a 3-VM pool reads as 7.5 on a 5-minute period at
   *   the default 2-minute `warmPoolInterval`. The average is the pool size.
   *
   * `PoolLaunched`/`PoolLaunchFailed` are genuine per-tick counters and stay
   * on `'Sum'`.
   */
  private classGaugeMetric(
    metricName: string,
    runnerClassLabel: string,
  ): cloudwatch.Metric {
    return this.classMetricWith(metricName, runnerClassLabel, 'Average');
  }

  private classMetricWith(
    metricName: string,
    runnerClassLabel: string,
    statistic: string,
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: GithubMicrovmRunnersMetrics.NAMESPACE,
      metricName,
      dimensionsMap: {
        RunnerSetId: this.runnerSetId,
        SizeClass: runnerClassLabel,
      },
      statistic,
    });
  }

  // --- Ready-made alarms -------------------------------------------------
  // Turnkey alarms for the signals every production runner set should watch, each
  // with a sensible default threshold, so operators don't have to know which
  // metric is alarm-worthy or invent thresholds. Attach your own SNS action
  // to the returned Alarm (standard CDK: `alarm.addAlarmAction(...)`). Tune
  // via RunnerAlarmOptions; the metric is still reachable directly for a
  // fully custom alarm.

  /**
   * Alarm when the dead-letter queue is not empty, meaning SQS gave up
   * redriving a launch or terminate intent. A runner set that is keeping up
   * holds this at 0, so any sustained depth means jobs are being dropped,
   * unless `recoverStuckLaunches` is draining them. It fires on one message
   * over a single 5-minute period; pass `RunnerAlarmOptions` to change
   * that, and `alarm.addAlarmAction()` to route it.
   *
   * This is the one alarm here that works without
   * `GithubMicrovmRunnersProps.emitMetrics`, because it watches the
   * dead-letter queue's own SQS metric rather than one the handlers report.
   * @default threshold 1, 1 evaluation period, 5-minute period
   */
  public deadLetterQueueNotEmptyAlarm(
    scope: Construct,
    options: RunnerAlarmOptions = {},
  ): cloudwatch.Alarm {
    return this.buildAlarm(
      scope,
      'DeadLetterQueueNotEmptyAlarm',
      this.deadLetterQueueDepth(),
      'MicroVM runner set: dead-letter queue is not empty (dropped launch/terminate intents).',
      options,
      1,
    );
  }

  /**
   * Alarm on janitor sweep errors, the per-item failures a sweep isolates and
   * continues past. A value that stays above zero means the runner set is
   * failing to reconcile — VMs left running, runners left unreaped — even
   * though each sweep completes. It fires on one error in each of three
   * consecutive 5-minute periods; pass `RunnerAlarmOptions` to change that.
   *
   * The three periods are the point. A single sweep error is usually a
   * transient fault the next sweep sails past — a GitHub API call that lost
   * its connection, a throttled describe — and the sweep is convergent, so
   * the work is retried five minutes later either way. Alarming on one such
   * blip pages an operator for something already fixed by the time they
   * read it. A genuine reconciliation failure (expired credentials, a broken
   * table, a revoked App installation) fails every sweep, so it still
   * announces itself within fifteen minutes.
   *
   * Requires `GithubMicrovmRunnersProps.emitMetrics`, and throws at synth
   * without it.
   * @default threshold 1, 3 evaluation periods, 5-minute period
   */
  public sweepErrorsAlarm(
    scope: Construct,
    options: RunnerAlarmOptions = {},
  ): cloudwatch.Alarm {
    this.requireEmittedMetrics('sweepErrorsAlarm', 'errors');
    return this.buildAlarm(
      scope,
      'SweepErrorsAlarm',
      this.errors(),
      'MicroVM runner set: janitor sweep is reporting reconciliation/prune errors across three consecutive sweeps.',
      { evaluationPeriods: 3, ...options },
      1,
    );
  }

  /**
   * Alarm on stuck-launch recoveries, the dead-lettered launches the janitor
   * re-drove, which only happens with `recoverStuckLaunches` on. Recoveries
   * that keep coming mean launches are failing for some reason other than a
   * GitHub outage. It fires on one recovery in each of three consecutive
   * 5-minute periods, which rides out a real outage; pass
   * `RunnerAlarmOptions` to change that.
   *
   * Requires `GithubMicrovmRunnersProps.emitMetrics`, and throws at synth
   * without it.
   * @default threshold 1, 3 evaluation periods, 5-minute period
   */
  public stuckLaunchesRecoveredAlarm(
    scope: Construct,
    options: RunnerAlarmOptions = {},
  ): cloudwatch.Alarm {
    this.requireEmittedMetrics(
      'stuckLaunchesRecoveredAlarm',
      'stuckLaunchesRecovered',
    );
    return this.buildAlarm(
      scope,
      'StuckLaunchesRecoveredAlarm',
      this.stuckLaunchesRecovered(),
      'MicroVM runner set: janitor is re-driving dead-lettered launches (launches failing for a non-outage reason?).',
      { evaluationPeriods: 3, ...options },
      1,
    );
  }

  /**
   * Guard for the alarms whose metric is EMF-emitted by a handler. With
   * `GithubMicrovmRunnersProps.emitMetrics` off the handlers write no
   * metric at all, and these alarms use
   * `TreatMissingData.NOT_BREACHING` — so they would synthesize fine, sit
   * green forever, and never fire, which is strictly worse than no alarm.
   * Fail at synth instead. Only the EMF-backed alarms call this;
   * {@link deadLetterQueueNotEmptyAlarm} watches SQS's own metric and works
   * either way, and the metric accessors themselves never throw (a consumer
   * may legitimately build a dashboard ahead of turning metrics on).
   */
  private requireEmittedMetrics(alarmMethod: string, metricName: string): void {
    if (!this.emitMetrics) {
      throw new Error(
        `GithubMicrovmRunners: ${alarmMethod}() requires emitMetrics: true. ` +
          `The alarm watches the \`${metricName}\` CloudWatch metric, which the handlers only emit when emitMetrics is enabled; ` +
          'with it off the metric never reports and the alarm — which treats missing data as not-breaching — would stay green forever and never fire. ' +
          'Set emitMetrics: true on GithubMicrovmRunnersProps (note CloudWatch bills custom metrics per metric per month), or drop this alarm and use deadLetterQueueNotEmptyAlarm, which watches an SQS metric and works either way.',
      );
    }
  }

  private buildAlarm(
    scope: Construct,
    id: string,
    metric: cloudwatch.Metric,
    description: string,
    options: RunnerAlarmOptions,
    defaultThreshold: number,
  ): cloudwatch.Alarm {
    const period = options.period ?? Duration.minutes(5);
    return new cloudwatch.Alarm(scope, id, {
      metric: metric.with({ period }),
      threshold: options.threshold ?? defaultThreshold,
      evaluationPeriods: options.evaluationPeriods ?? 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: description,
    });
  }
}

/**
 * Internal registry-record shape: every field the public `RunnerClass`
 * handle exposes, plus `warmPoolSize` (the target `SUSPENDED`-pool size for this
 * class, if any) — read by the `WARM_POOL_JSON` `Lazy` producer and by
 * `addRunnerClass`'s lazy warm-pool-infra trigger. `warm` is optional, so any
 * `RunnerClass` value structurally satisfies this type too — the public
 * `runnerClasses: RunnerClass[]` getter returns a defensive copy of the
 * `classRegistry` array backing this richer internal one, so a consumer
 * mutating the returned array (`.push()`, `.length = 0`, …) can't corrupt
 * the registry the `Lazy` producers and validations read from.
 */
interface InternalRunnerClass extends RunnerClass {
  readonly warmPoolSize?: number;
  readonly idlePolicy?: MicrovmIdlePolicy;
}

/**
 * A runner set: one deployment of GitHub Actions runners that run on AWS
 * Lambda MicroVMs, with a fresh VM per job that is thrown away when the job
 * ends.
 *
 * The construct deploys a webhook handler for GitHub's `workflow_job`
 * deliveries, a queue those deliveries become launch and terminate intents on,
 * a launcher that starts a VM and registers it with GitHub for each queued
 * job, and a janitor that sweeps on a schedule for VMs and runners that
 * outlived their job. Every runner class registered through
 * `addRunnerClass` adds an image build of its own, and a runner set needs
 * at least one class to synthesize.
 *
 * Deploying it takes two props: how to authenticate to GitHub, and which
 * GitHub scope the runners register into. The VMs themselves carry no AWS
 * identity unless `GithubMicrovmRunnersProps.vmExecutionRole` gives them
 * one.
 *
 * @example
 * const runnerSet = new GithubMicrovmRunners(stack, 'Runners', {
 *   github: GithubAuth.app({
 *     appId: GithubAppId.fromSecret(
 *       Secret.fromSecretNameV2(stack, 'AppId', 'microvm-runner/dev/app-id'),
 *     ),
 *     privateKey: GithubAppKey.fromSecret(
 *       Secret.fromSecretNameV2(stack, 'AppKey', 'microvm-runner/dev/app-private-key'),
 *     ),
 *     webhookSecret: Secret.fromSecretNameV2(
 *       stack, 'WebhookSecret', 'microvm-runner/dev/webhook-secret',
 *     ),
 *   }),
 *   scope: RunnerScope.org('my-org'),
 * });
 *
 * runnerSet.addRunnerClass('microvm', { size: MicrovmSize.GB4 });
 */
export class GithubMicrovmRunners extends Construct {
  /** The webhook handler's public Function URL, which is the payload URL to configure on the GitHub App or webhook. */
  public readonly webhookUrl: string;
  /**
   * The command that creates this runner set's GitHub App and writes its three
   * secrets. It carries the scope, the stack name, and the region this runner
   * set was built with, and is pinned to the version of this library that
   * produced it, so the helper and the construct agree about secret names and
   * stack outputs.
   *
   * Surface it as a stack output and the deploy ends by printing the line to
   * paste. On a stack built without an explicit `env`, the region is a token
   * that reads as `${Token[AWS.Region.N]}` here and resolves to the real region
   * in the deployed output.
   *
   * @example
   * new cdk.CfnOutput(stack, 'SetupCommand', { value: runners.setupCommand });
   */
  public readonly setupCommand: string;
  /** Queue carrying launch and terminate intents from the webhook handler to the launcher. */
  public readonly jobQueue: sqs.IQueue;
  /** Dead-letter queue holding job-queue messages that ran out of redrives. */
  public readonly deadLetterQueue: sqs.IQueue;
  /** The launcher Lambda, which reads the job queue and starts and terminates MicroVMs. */
  public readonly launcherFunction: lambda.IFunction;
  /** The webhook Lambda, which GitHub's deliveries reach through `webhookUrl`. */
  public readonly webhookFunction: lambda.IFunction;
  /** The janitor Lambda, which runs the scheduled sweep. */
  public readonly janitorFunction: lambda.IFunction;
  /** DynamoDB table mapping each runner's name to its MicroVM, and holding the janitor's record of which VMs it already suspects. */
  public readonly runnerTable: dynamodb.ITable;
  /** The AWS identity launched MicroVMs run with, passed in as `GithubMicrovmRunnersProps.vmExecutionRole`, or `undefined` when the VMs carry no AWS identity. Console capture runs on this role and requires it. A runner set identifies its own VMs by the image they booted from, not by this role. */
  public readonly vmExecutionRole?: iam.IRole;
  /** Where a VM's runtime console goes when console capture is on: the group the construct created, or the one you supplied. `undefined` when console capture is off. */
  public readonly vmConsoleLogGroup?: logs.ILogGroup;
  /**
   * Every runner class registered through `addRunnerClass`, in the order
   * they were registered. It is empty until the first class is added, and a
   * runner set that reaches synth with none fails. Each call returns a copy, so
   * changing the returned array does not change the runner set.
   */
  public get runnerClasses(): RunnerClass[] {
    return [...this.classRegistry];
  }
  /**
   * The image a job whose labels match no registered runner class launches on:
   * the class labelled `microvm` if one is registered, otherwise the first
   * class registered. Runner classes can be added right up until synth, so this
   * is a token that resolves once the set of them is final.
   */
  public readonly defaultImageArn: string;
  /** This runner set's CloudWatch metrics and the ready-made alarms over them. */
  public readonly metrics: GithubMicrovmRunnersMetrics;
  /**
   * The Lambda that refills the warm pool, or `undefined` when no registered
   * runner class sets `RunnerClassProps.warmPoolSize`. It is created by the
   * first class that does, so a runner set with no warm class deploys neither
   * this function nor its schedule.
   */
  public get warmPoolFunction(): lambda.IFunction | undefined {
    return this.warmPoolFn;
  }

  /**
   * The single source of truth backing the public {@link runnerClasses}
   * getter (which returns a defensive copy); the `Lazy` env producers and
   * `node.addValidation` read this array directly at synth, after all
   * `addRunnerClass` calls have run — never the public getter, so their view
   * always reflects live registrations.
   */
  private readonly classRegistry: InternalRunnerClass[] = [];
  /** Captured from props/defaults for `addRunnerClass` to build each class's `ImagePipeline` after construction. */
  private readonly runnerSetId: string;
  private readonly network: RunnerNetwork;
  private readonly imageLogs?: ImageLogs;
  /** Backing field for the {@link warmPoolFunction} getter — also doubles as the "warm-pool infra already created" guard in {@link createWarmPoolInfra}. */
  private warmPoolFn?: lambda.IFunction;
  /**
   * Constructor-captured fragments {@link createWarmPoolInfra} needs to build
   * the warm-pool Lambda + schedule when the first warm class registers
   * (post-construction, via `addRunnerClass`) — mirrors {@link runnerSetId} /
   * {@link network} / {@link logging} above.
   */
  private readonly egressConnectorArnsJson: string;
  private readonly loggingJson: string;
  private readonly maxJobDurationSeconds: number;
  private readonly warmPoolInterval: Duration;
  /** `'true'`/`'false'` for the handlers' `EMIT_METRICS` env var — captured so the lazily-created warm-pool Lambda gets the same value as the eager three. */
  private readonly emitMetricsEnv: string;
  /** Governance knobs captured so {@link createWarmPoolInfra}'s lazily-created Lambda + log group match the eagerly-created handlers. */
  private readonly lambdaMemorySize: number;
  private readonly logRetention: logs.RetentionDays;
  private readonly resourceRemovalPolicy: RemovalPolicy;
  private readonly encryptionKey?: kms.IKey;
  /**
   * `Lazy`-produced `WARM_POOL_JSON`: `{label: warmPoolSize}` for every registered
   * class with `warm > 0`, `{}` when none — always present (see
   * {@link GithubMicrovmRunnersProps.warmPoolInterval}'s doc). Set on both the
   * launcher and the warm-pool Lambda's env.
   */
  private readonly warmPoolJson: string;
  /**
   * `Lazy`-produced `SIZE_CLASSES_JSON` (see the constructor's `sizeClassesJson`
   * local) — captured so {@link createWarmPoolInfra} can wire the same token
   * onto the warm-pool Lambda without recomputing it.
   */
  private readonly sizeClassesJson: string;

  constructor(scope: Construct, id: string, props: GithubMicrovmRunnersProps) {
    super(scope, id);

    // Apply the permissions boundary FIRST, at construct scope, so every role
    // created below — including the lazily-created warm-pool role and each
    // per-class ImagePipeline build role — inherits it via CDK's aspect
    // traversal. One apply covers the whole subtree (CLAUDE.md's
    // one-canonical-decision ethos).
    if (props.permissionsBoundary) {
      iam.PermissionsBoundary.of(this).apply(props.permissionsBoundary);
    }

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;
    const logRetention = props.logRetention ?? logs.RetentionDays.TWO_WEEKS;
    const lambdaMemorySize = props.lambdaMemorySize ?? 128;
    const maxReceiveCount = props.maxReceiveCount ?? 20;
    // Captured for the lazily-created warm-pool infra (a separate method) so
    // it matches the eagerly-created handlers.
    this.resourceRemovalPolicy = removalPolicy;
    this.logRetention = logRetention;
    this.lambdaMemorySize = lambdaMemorySize;
    this.encryptionKey = props.encryptionKey;
    const makeLogGroup = (lgId: string): logs.LogGroup =>
      this.makeLogGroup(lgId);

    validateRegion(this, Stack.of(this).region, props.additionalRegions ?? []);

    const runnerSetId = computeRunnerSetId(this);
    this.runnerSetId = runnerSetId;

    const network = this.resolveNetwork(
      props.network ?? RunnerNetwork.internetEgress(),
    );
    this.network = network;
    const maxConcurrentVms = props.maxConcurrentVms ?? 10;
    const maxJobDuration = props.maxJobDuration ?? Duration.hours(6);
    const janitorInterval = props.janitorInterval ?? Duration.minutes(5);
    // Left optional on purpose: `undefined` means "no reservation" so CDK omits
    // `reservedConcurrentExecutions` entirely rather than defaulting to a value
    // that would carve capacity out of the account's shared concurrency pool.
    const webhookReservedConcurrency = props.webhookReservedConcurrency;
    const idleRunnerGraceSeconds = props.idleRunnerGraceSeconds ?? 600;
    const keepImageVersions = props.keepImageVersions ?? 5;
    const recoverStuckLaunches = props.recoverStuckLaunches ?? true;
    // Opt-in, default off: CloudWatch bills custom metrics per metric per
    // month and the launcher/warm-pool metrics multiply by runner class (see
    // the prop's doc). Wired to every handler as `EMIT_METRICS` and consumed
    // at the single choke point, `handlers/shared/emf.ts`'s `emitEmf`.
    const emitMetrics = props.emitMetrics ?? false;
    this.emitMetricsEnv = String(emitMetrics);
    this.imageLogs = props.imageLogs;
    const warmPoolInterval = props.warmPoolInterval ?? Duration.minutes(2);
    this.warmPoolInterval = warmPoolInterval;
    this.maxJobDurationSeconds = maxJobDuration.toSeconds();

    validateNumericProps({
      maxConcurrentVms,
      webhookReservedConcurrency,
      idleRunnerGraceSeconds,
      keepImageVersions,
      maxJobDuration,
      janitorInterval,
      launcherTimeoutSeconds: LAUNCHER_TIMEOUT_SECONDS,
    });
    // Runner classes are registered post-construction via `addRunnerClass`, so
    // the label/image set is only complete at synth. Defer the "≥1 class"
    // gate to a synth-time validation reading `this.classRegistry`. (The old
    // warmPool-key ∈ class-labels check is now structurally impossible: `warm`
    // is a per-class prop, so there's no separate key to drift from a label.
    // The `warmPoolInterval` floor is likewise gated on a warm class existing
    // — but validated inside `createWarmPoolInfra`, not here: see that
    // method's doc for why a synth-time `node.addValidation` check would fire
    // too late, after CDK's own `events.Schedule.rate()` already threw a
    // worse error.)
    this.node.addValidation({
      validate: () => {
        const errors: string[] = [];
        if (this.classRegistry.length === 0) {
          errors.push(
            'GithubMicrovmRunners: add at least one runner class with addRunnerClass(label, { size }).',
          );
        }
        return errors;
      },
    });

    // Accepted for its Phase-2 seam (see WebhookEndpoint's doc comment); the
    // only Phase-1 variant is functionUrl(), which is exactly how the
    // webhook handler is wired below regardless. The kind check is
    // defensive future-proofing: if a later Phase-2 variant (e.g.
    // customDomain()) reaches this construct before it's taught to wire it,
    // fail loudly instead of silently falling back to a Function URL.
    const webhookEndpoint = props.webhook ?? WebhookEndpoint.functionUrl();
    if (webhookEndpoint.kind !== WebhookEndpointKind.FUNCTION_URL) {
      throw new Error(
        `GithubMicrovmRunners: unsupported WebhookEndpoint kind "${webhookEndpoint.kind}".`,
      );
    }

    // --- Runner classes / image pipelines ----------------------------------
    // Classes (and their `ImagePipeline`s) are registered post-construction
    // via `addRunnerClass` — see that method. The launcher/janitor fall back
    // to this image ARN when a job matches no class; it resolves at synth from
    // the completed registry.
    const defaultImageArn = Lazy.string({
      produce: () => this.resolveDefaultImageArn(),
    });
    this.defaultImageArn = defaultImageArn;

    // --- Runner mapping / janitor strike-memory table -----------------------
    const runnerTable = new dynamodb.Table(this, 'RunnerTable', {
      partitionKey: { name: 'runnerName', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      // CMK when supplied, else DynamoDB's default (AWS-owned) key.
      ...(props.encryptionKey
        ? {
            encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
            encryptionKey: props.encryptionKey,
          }
        : {}),
      // Ephemeral runner<->VM correlation data, fully reconstructable from
      // the live MicroVM/GitHub APIs (see janitor.ts's rule 6) — DESTROY is
      // the safe default; overridable for blanket-RETAIN org policies.
      removalPolicy,
      // `pointInTimeRecovery` is deprecated and is removed in the next CDK
      // major. This is the shape CDK wants now; the public prop stays a plain
      // boolean, so nothing about our API changes.
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: props.pointInTimeRecovery ?? false,
      },
    });
    this.runnerTable = runnerTable;

    // --- VM execution role (opt-in; default: powerless VM, no AWS identity)
    // Runner VMs default to NO execution role. A MicroVM's IMDS serves its
    // execution-role credentials to arbitrary job code (live-measured
    // 2026-07-19), so attaching a role makes it an ambient privilege every
    // workflow can assume — the opposite of "zero AWS creds in VMs". Jobs
    // that need AWS use their own per-job GitHub OIDC role. `--execution-role
    // -arn` is optional on RunMicrovm (spike-verified: VMs boot + run + log
    // without it — the platform writes /aws/lambda-microvms logs via its own
    // identity). A consumer may still opt a runner set in via props.vmExecutionRole.
    const vmExecutionRole = props.vmExecutionRole;
    validateLoggingProps({ consoleLogs: props.consoleLogs, vmExecutionRole });
    this.vmExecutionRole = vmExecutionRole;

    // --- consoleLogs: runtime console capture -------------------------------
    // Runtime console capture (boot + agent + job process output) is the only
    // way to see a VM's runtime console: the platform hard-rejects RunMicrovm
    // `logging` without an executionRoleArn, and image-level logging is
    // provably build-time-only (live-verified 2026-07-22 — real job launches on
    // a powerless runner set produce zero runtime streams anywhere). The
    // construct never mints a VM identity: consoleLogs requires the consumer's
    // vmExecutionRole (enforced by validateLoggingProps above), and the
    // consumer grants that role the two console-write actions themselves. We do
    // not write to a role we did not create. See ConsoleLogs.enabled()'s doc.
    if (props.consoleLogs) {
      this.vmConsoleLogGroup =
        props.consoleLogs.logGroup ??
        new logs.LogGroup(this, 'VmConsoleLogGroup', {
          // Debug destination, not an archive: bounded retention caps the
          // cost of a log-flooding job. Bring your own group to tune.
          retention: logRetention,
          removalPolicy,
          ...(props.encryptionKey
            ? { encryptionKey: props.encryptionKey }
            : {}),
        });
    }

    // --- Job queue + DLQ -----------------------------------------------------
    // CMK when supplied, else SQS-managed SSE (the service default).
    const queueEncryption = props.encryptionKey
      ? {
          encryption: sqs.QueueEncryption.KMS,
          encryptionMasterKey: props.encryptionKey,
        }
      : {};
    const deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      ...queueEncryption,
      ...(props.deadLetterRetention
        ? { retentionPeriod: props.deadLetterRetention }
        : {}),
    });
    const jobQueue = new sqs.Queue(this, 'JobQueue', {
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount },
      ...queueEncryption,
    });
    this.jobQueue = jobQueue;
    this.deadLetterQueue = deadLetterQueue;

    // --- Shared env fragments --------------------------------------------
    const scopeJson = props.scope.toJson();
    // package.json sits one directory above the compiled `lib/`, and one above
    // `src/` when the tests run from source — the same relative position either
    // way, and the same `__dirname` trick as HANDLERS_DIR above. Minor-pinned
    // rather than patch-pinned: a patch of the helper is always safe to pick
    // up, a minor may change what it asks for.
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { name: string; version: string };
    const [major, minor] = pkg.version.split('.');
    const setupTarget =
      props.scope.kind === RunnerScopeKind.ORG
        ? `--org ${props.scope.organization}`
        : `--account ${props.scope.repositories![0].split('/')[0]}`;
    this.setupCommand = [
      `npx ${pkg.name}@${major}.${minor} setup`,
      setupTarget,
      `--stack ${Stack.of(this).stackName}`,
      `--region ${Stack.of(this).region}`,
    ].join(' ');
    // `Lazy`: the class set (and each class's imageArn token) is only complete
    // after all `addRunnerClass` calls, which run post-construction. The
    // produced JSON string embeds per-class imageArn tokens, which CDK
    // resolves further into an `Fn::Join` of `Fn::GetAtt` refs at synth —
    // byte-identical to the pre-registry eager `JSON.stringify` for a runner set
    // with the same class set.
    const sizeClassesJson = Lazy.string({
      produce: () =>
        JSON.stringify(
          Object.fromEntries(
            this.classRegistry.map((c) => [c.label, { imageArn: c.imageArn }]),
          ),
        ),
    });
    this.sizeClassesJson = sizeClassesJson;
    const egressConnectorArnsJson = JSON.stringify(network.connectorArns);
    this.egressConnectorArnsJson = egressConnectorArnsJson;
    // Serialized for the launcher's LOGGING_JSON env var (see
    // `handlers/shared/runner-set-config.ts`'s `readLogging`/`LoggingConfig`).
    // This carries the *runtime* logging decision only, which is entirely
    // `consoleLogs`: console capture on ⇒ CloudWatch to the resolved group
    // (`vmConsoleLogGroup`, always present, always with a role — see
    // validateLoggingProps), console capture off ⇒ disabled. Build-time image
    // logs (`imageLogs`) never reach the launcher — they are wired on the
    // image resource, not on RunMicrovm.
    const loggingJson = JSON.stringify(
      this.vmConsoleLogGroup
        ? {
            kind: 'cloudWatch',
            logGroupName: this.vmConsoleLogGroup.logGroupName,
          }
        : { kind: 'disabled' },
    );
    this.loggingJson = loggingJson;
    // `Lazy`, always present: `{label: warm}` for every registered class with
    // `warm > 0`, `{}` when none. Both the launcher (its warm-path guard,
    // `launcher.ts`'s `tryWarmPath`) and the `RunnerWarmPool` function read
    // this via `readWarmPool()`, which now returns `{}` on an unset/empty var
    // rather than throwing — an empty object naturally makes every warm-path
    // lookup miss, so a runner set with no warm class behaves exactly like one
    // predating the feature even though the env var itself is always set.
    const warmPoolJson = Lazy.string({
      produce: () =>
        JSON.stringify(
          Object.fromEntries(
            this.classRegistry
              .filter((c) => c.warmPoolSize)
              .map((c) => [c.label, c.warmPoolSize as number]),
          ),
        ),
    });
    this.warmPoolJson = warmPoolJson;
    // `Lazy`, always present: `{label: {maxIdleDurationSeconds,
    // suspendedDurationSeconds, autoResumeEnabled?}}` for every registered
    // class that set `idlePolicy`, `{}` when none. Only the launcher reads
    // this (via `readIdlePolicies()`, `shared/runner-set-config.ts`) for its cold
    // path — a class can never have both `warmPoolSize` and `idlePolicy` (see
    // `addRunnerClass`'s eager guard below), so the warm-pool Lambda never
    // needs it. Durations serialize via `Duration.toSeconds()`.
    // `suspendedDurationSeconds` is now unconditional: `MicrovmIdlePolicy.
    // suspendedDuration` is a required public prop (the service rejects
    // `RunMicrovm` when `idlePolicy.suspendedDurationSeconds` is absent —
    // see `types/idle-policy.ts`), so every idle-policy class always has one
    // to serialize. `autoResumeEnabled` stays conditional here — the
    // always-send-with-default-false behavior for it lives one layer down,
    // in `microvm-client.ts`'s `runMicrovm` (the last line of defence before
    // the wire), not in this producer.
    const idlePolicyJson = Lazy.string({
      produce: () =>
        JSON.stringify(
          Object.fromEntries(
            this.classRegistry
              .filter((c) => c.idlePolicy)
              .map((c) => {
                const policy = c.idlePolicy as MicrovmIdlePolicy;
                return [
                  c.label,
                  {
                    maxIdleDurationSeconds: policy.maxIdleDuration.toSeconds(),
                    suspendedDurationSeconds:
                      policy.suspendedDuration.toSeconds(),
                    ...(policy.autoResume !== undefined
                      ? { autoResumeEnabled: policy.autoResume }
                      : {}),
                  },
                ];
              }),
          ),
        ),
    });

    // --- Webhook function ---------------------------------------------------
    // Handlers ship PRE-BUNDLED (scripts/bundle-handlers.mjs at package
    // build), not synth-bundled: a jsii consumer (Python) has no esbuild
    // or Docker at synth. All SDK clients are bundled IN (external: []) —
    // the Lambda runtime's ambient SDK predates brand-new services
    // (@aws-sdk/client-lambda-microvms missing at runtime:
    // Runtime.ImportModuleError, first live launch 2026-07-19), and
    // bundling pins the lockfile's SDK version the handlers' service
    // contract (required members, marshaller behavior) was validated on.
    const webhookFunction = new lambda.Function(this, 'WebhookFunction', {
      memorySize: lambdaMemorySize,
      logGroup: makeLogGroup('WebhookLogGroup'),
      code: lambda.Code.fromAsset(join(HANDLERS_DIR, 'bundled', 'webhook')),
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // Well under GitHub's webhook delivery timeout and the Function URL's
      // synchronous-invoke ceiling; the handler is deliberately thin (one
      // secret fetch + one SQS send, see webhook.ts's module doc).
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: webhookReservedConcurrency,
      environment: {
        ...props.github.bindEnv(),
        // `Lazy`: labels are only known after all `addRunnerClass` calls. No
        // token content (labels are plain strings), so this resolves to a
        // plain JSON-array string at synth.
        SIZE_CLASS_LABELS: Lazy.string({
          produce: () => JSON.stringify(this.classRegistry.map((c) => c.label)),
        }),
        // The webhook decides whether a delivery's repository is one this
        // runner set serves, before anything reaches the queue. A valid
        // signature proves the delivery came from GitHub through this App; it
        // does not prove the repository is in scope, because the App can be
        // installed more widely than the runner set is configured for.
        SCOPE_JSON: scopeJson,
        QUEUE_URL: jobQueue.queueUrl,
        // Always present, `'false'` unless the runner set opted in. The webhook
        // handler emits no metrics today; wiring it here anyway keeps one
        // uniform contract across all four handlers, so a metric added to the
        // webhook later is gated without a construct change.
        EMIT_METRICS: this.emitMetricsEnv,
      },
    });
    // The webhook secret ONLY — not the credentials that can act as the App.
    // This handler verifies GitHub's HMAC signature and enqueues; it never
    // mints an installation token, and `GH_WEBHOOK_SECRET_ARN` is the one
    // secret it reads. It is also the single component reachable from the
    // public internet, on a Function URL with `authType: NONE`, so the App's
    // private key and `kms:Sign` are exactly what should not sit behind it.
    props.github.grantReadWebhookSecret(webhookFunction);
    jobQueue.grantSendMessages(webhookFunction);
    const webhookFunctionUrl = webhookFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });
    this.webhookFunction = webhookFunction;
    this.webhookUrl = webhookFunctionUrl.url;

    // --- Launcher function ---------------------------------------------------
    const launcherFunction = new lambda.Function(this, 'LauncherFunction', {
      memorySize: lambdaMemorySize,
      logGroup: makeLogGroup('LauncherLogGroup'),
      code: lambda.Code.fromAsset(join(HANDLERS_DIR, 'bundled', 'launcher')),
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // Comfortably under the job queue's 180s visibility timeout, leaving
      // headroom before an in-flight message would become visible again.
      timeout: Duration.seconds(LAUNCHER_TIMEOUT_SECONDS),
      environment: {
        ...props.github.bindEnv(),
        SCOPE_JSON: scopeJson,
        SIZE_CLASSES_JSON: sizeClassesJson,
        IMAGE_ARN: defaultImageArn,
        EGRESS_CONNECTOR_ARNS: egressConnectorArnsJson,
        LOGGING_JSON: loggingJson,
        MAX_CONCURRENT: String(maxConcurrentVms),
        MAX_JOB_DURATION_SECONDS: String(maxJobDuration.toSeconds()),
        RUNNER_SET_ID: runnerSetId,
        // Only set when a consumer opts into an execution role; unset ⇒ the
        // launcher omits executionRoleArn ⇒ powerless VM.
        ...(vmExecutionRole
          ? { RUNNER_SET_VM_ROLE_ARN: vmExecutionRole.roleArn }
          : {}),
        RUNNER_TABLE: runnerTable.tableName,
        // Always present now (see `warmPoolJson` above) — `{}` when no
        // registered class is warm, which the launcher's warm-path guard
        // treats as "no target for this label" (every lookup misses).
        WARM_POOL_JSON: warmPoolJson,
        // Always present (see `idlePolicyJson` above) — `{}` when no
        // registered class set `idlePolicy`, which the launcher's cold path
        // treats as "no idle policy for this label" (every lookup misses,
        // `idlePolicy` stays `undefined`, RunMicrovm carries no field).
        IDLE_POLICY_JSON: idlePolicyJson,
        // Opt-in metric gate, read by `handlers/shared/emf.ts`'s `emitEmf`.
        // `'false'` (the default) makes every per-launch metric emission a
        // no-op — see `GithubMicrovmRunnersProps.emitMetrics`.
        EMIT_METRICS: this.emitMetricsEnv,
      },
    });
    props.github.grantRead(launcherFunction);
    runnerTable.grantReadWriteData(launcherFunction);
    // grantReadWriteData() does not include dynamodb:TransactWriteItems in
    // aws-cdk-lib 2.261.0, but the launcher issues TransactWriteItemsCommand
    // — grant it explicitly or the first live launch gets AccessDenied.
    runnerTable.grant(launcherFunction, 'dynamodb:TransactWriteItems');
    launcherFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [...VM_INSTANCE_ACTIONS],
        resources: ['*'],
      }),
    );
    // RunMicrovm also "passes" its network connectors — every connector on
    // the call (incl. AWS-managed INTERNET_EGRESS / ALL_INGRESS) requires
    // lambda:PassNetworkConnector on the connector ARN, PassRole-style.
    // Undocumented; found via live AccessDenied at first ingress-push launch
    // (2026-07-19). Connectors ARE ARN-addressable, so scope to the
    // AWS-managed connector namespace plus any consumer-supplied egress
    // connectors.
    launcherFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:PassNetworkConnector'],
        resources: [
          Stack.of(this).formatArn({
            service: 'lambda',
            account: 'aws',
            resource: 'network-connector',
            resourceName: 'aws-network-connector:*',
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
          ...network.connectorArns,
        ],
      }),
    );
    // Only when a consumer opts into an execution role: RunMicrovm passes it
    // to the VM's runtime, needing iam:PassRole scoped to that one role's ARN
    // (a role IS ARN-addressable, unlike the VM-instance actions above). The
    // default powerless VM has no role, so no PassRole grant.
    if (vmExecutionRole) {
      launcherFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [vmExecutionRole.roleArn],
        }),
      );
    }
    launcherFunction.addEventSource(
      new SqsEventSource(jobQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );
    this.launcherFunction = launcherFunction;

    // --- Janitor function -----------------------------------------------------
    const janitorFunction = new lambda.Function(this, 'JanitorFunction', {
      memorySize: lambdaMemorySize,
      logGroup: makeLogGroup('JanitorLogGroup'),
      code: lambda.Code.fromAsset(join(HANDLERS_DIR, 'bundled', 'janitor')),
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // A full sweep (DynamoDB Scan + per-row GitHub/MicroVM reconciliation
      // + image-version pruning) can run long on a busy runner set; well under
      // Lambda's 15-minute ceiling.
      timeout: Duration.minutes(5),
      environment: {
        ...props.github.bindEnv(),
        SCOPE_JSON: scopeJson,
        SIZE_CLASSES_JSON: sizeClassesJson,
        IMAGE_ARN: defaultImageArn,
        RUNNER_SET_ID: runnerSetId,
        RUNNER_TABLE: runnerTable.tableName,
        GRACE_SECONDS: String(idleRunnerGraceSeconds),
        JANITOR_INTERVAL_SECONDS: String(janitorInterval.toSeconds()),
        MAX_JOB_DURATION_SECONDS: String(maxJobDuration.toSeconds()),
        KEEP_IMAGE_VERSIONS: String(keepImageVersions),
        // Opt-in stuck-launch recovery (see janitor.ts). The queue URLs are
        // always wired so the handler can read them, but the sweep only runs
        // when the flag is 'true'.
        RECOVER_STUCK_LAUNCHES: String(recoverStuckLaunches),
        JOB_QUEUE_URL: jobQueue.queueUrl,
        DEAD_LETTER_QUEUE_URL: deadLetterQueue.queueUrl,
        // Opt-in metric gate, read by `handlers/shared/emf.ts`'s `emitEmf`.
        // `'false'` (the default) makes the per-sweep envelope a no-op — the
        // sweep's own structured error logs are unaffected.
        EMIT_METRICS: this.emitMetricsEnv,
      },
    });
    props.github.grantRead(janitorFunction);
    runnerTable.grantReadWriteData(janitorFunction);
    // Stuck-launch recovery: read+delete from the DLQ, re-drive onto the job
    // queue. Granted only when the feature is enabled — least privilege.
    if (recoverStuckLaunches) {
      deadLetterQueue.grantConsumeMessages(janitorFunction);
      jobQueue.grantSendMessages(janitorFunction);
    }
    janitorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [...VM_LIFECYCLE_ACTIONS_NO_RUN],
        resources: ['*'],
      }),
    );
    janitorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [...IMAGE_VERSION_ACTIONS],
        // `Lazy`: one image ARN per registered class, known only at synth
        // (classes register post-construction). Each element is itself an
        // imageArn token, resolved to an `Fn::GetAtt` at synth.
        resources: Lazy.list({
          produce: () => this.classRegistry.map((c) => c.imageArn),
        }),
      }),
    );
    this.janitorFunction = janitorFunction;

    new events.Rule(this, 'JanitorSchedule', {
      schedule: events.Schedule.rate(janitorInterval),
      targets: [new eventsTargets.LambdaFunction(janitorFunction)],
    });

    // Warm-pool function + schedule are NOT created here. Whether *any* class
    // is warm is only known after every `addRunnerClass` call, so that infra
    // is created lazily, inside `addRunnerClass`, on the first class that
    // sets `warm` — see `createWarmPoolInfra` below. A runner set with no warm
    // class ends up with neither, byte-identical to a runner set predating the
    // feature (aside from the always-present `WARM_POOL_JSON` env var, which
    // is `{}` in that case and a no-op everywhere it's read).

    this.metrics = new GithubMicrovmRunnersMetrics(
      runnerSetId,
      deadLetterQueue,
      emitMetrics,
    );
  }

  /**
   * Register a runner class: the `runs-on` label a workflow targets, paired
   * with the VM size, and optionally the image, that jobs carrying that label
   * run on. Each class builds its own image. A runner set needs at least one
   * class, and one that reaches synth with none fails.
   *
   * Classes can be registered at any point before synth. Everything that
   * depends on the full set of them — which labels the webhook accepts, which
   * image each label launches, and the janitor's access to each class's image
   * — is resolved once, after the last call.
   *
   * Setting `warmPoolSize` on a class keeps that many pre-booted VMs ready for
   * it. The first class to do so creates the warm-pool handler and its
   * schedule, which every later warm class then shares.
   *
   * @param label the `runs-on` label workflows use to target this class.
   * @param props the VM size, and optionally the image, warm pool size, and
   *   idle policy for this class.
   * @returns the registered `RunnerClass`, carrying its label, size,
   *   image pipeline, and image ARN.
   */
  public addRunnerClass(label: string, props: RunnerClassProps): RunnerClass {
    if (this.classRegistry.some((c) => c.label === label)) {
      throw new Error(
        `GithubMicrovmRunners: runner class label "${label}" is already registered.`,
      );
    }
    if (props.warmPoolSize !== undefined) {
      assertPositiveInteger(
        `runner class "${label}": warmPoolSize`,
        props.warmPoolSize,
      );
    }
    if (props.idlePolicy !== undefined) {
      // Catch a zero/negative idle Duration at synth. Otherwise it flows
      // through Duration.toSeconds() into IDLE_POLICY_JSON and only surfaces
      // as a RunMicrovm ValidationException on the first cold launch of this
      // class — the "fails only at deploy/runtime" trap the numeric
      // validators exist to prevent.
      assertPositiveInteger(
        `runner class "${label}": idlePolicy.maxIdleDuration (seconds)`,
        props.idlePolicy.maxIdleDuration.toSeconds(),
      );
      assertPositiveInteger(
        `runner class "${label}": idlePolicy.suspendedDuration (seconds)`,
        props.idlePolicy.suspendedDuration.toSeconds(),
      );
    }
    if (props.warmPoolSize !== undefined && props.idlePolicy !== undefined) {
      throw new Error(
        `GithubMicrovmRunners: runner class "${label}" sets both warmPoolSize and idlePolicy; they both drive the VM's SUSPENDED state and are mutually exclusive. Use one or the other.`,
      );
    }

    // Index by the current registry length — preserves the old per-size-class
    // `Image<index>` construct id and the `<runnerSetId><index>` image-Name
    // disambiguation (two classes may build the same `RunnerImage`, hence the
    // same contentHash, so a bare shared runnerSetId would collide their Names).
    const index = this.classRegistry.length;
    const pipeline = new ImagePipeline(this, `Image${index}`, {
      image: props.image ?? RunnerImage.fromOptions(),
      size: props.size,
      network: this.network,
      imageLogs: this.imageLogs,
      runnerSetId: `${this.runnerSetId}${index}`,
    });

    const runnerClass: InternalRunnerClass = {
      label,
      size: props.size,
      imagePipeline: pipeline,
      imageArn: pipeline.imageArn,
      warmPoolSize: props.warmPoolSize,
      idlePolicy: props.idlePolicy,
    };
    this.classRegistry.push(runnerClass);

    // Lazily create the warm-pool Lambda + schedule on the FIRST class that
    // sets `warm` — `this.warmPoolFn` (the guard) is set inside
    // `createWarmPoolInfra`, so a second/third warm class here is a no-op.
    // Its `WARM_POOL_JSON` env is the same `Lazy` producer covering every
    // warm class, not just this one, so registering it once is sufficient
    // regardless of how many more warm classes follow.
    if (props.warmPoolSize && !this.warmPoolFn) {
      this.createWarmPoolInfra();
    }

    return runnerClass;
  }

  /**
   * A construct-created handler log group with the runner set's governance knobs:
   * bounded retention (cost governance), the runner set's removal policy, and the
   * CMK when supplied. Replaces Lambda's implicit never-expiring, service-keyed
   * default log group. Used for all four handlers (the eager three in the
   * constructor and the lazily-created warm-pool one here).
   */
  private makeLogGroup(lgId: string): logs.LogGroup {
    return new logs.LogGroup(this, lgId, {
      retention: this.logRetention,
      removalPolicy: this.resourceRemovalPolicy,
      ...(this.encryptionKey ? { encryptionKey: this.encryptionKey } : {}),
    });
  }

  /**
   * Builds the `RunnerWarmPool` Lambda + its `WarmPoolSchedule` EventBridge
   * rule and assigns {@link warmPoolFn} (the {@link warmPoolFunction} getter's
   * backing field, also this method's own re-entry guard — see the call site
   * in `addRunnerClass`). Called at most once per runner set, lazily, the
   * moment the first warm runner class registers; never called at all for a
   * runner set where no class ever sets `warmPoolSize`.
   *
   * Validates {@link warmPoolInterval}'s EventBridge `rate()` floor FIRST,
   * before creating anything: `events.Schedule.rate()` below throws its own
   * generic, unhelpful message for a sub-floor Duration
   * ("'30 seconds' cannot be converted into a whole number of minutes"), and
   * this method — not `node.addValidation` — is the earliest point at which
   * "a warm class exists" is known (this runs eagerly, the moment the first
   * warm class registers, not deferred to synth), so it's also the right
   * place to fail fast with our own clearer error instead. This keeps the
   * opt-in contract intact: a runner set where no class ever sets
   * `warmPoolSize` never calls this method at all, so a bad `warmPoolInterval`
   * is simply never evaluated and never throws.
   */
  private createWarmPoolInfra(): void {
    const warmPoolIntervalError = warmPoolIntervalFloorError(
      this.warmPoolInterval,
    );
    if (warmPoolIntervalError) {
      throw new Error(warmPoolIntervalError);
    }

    const warmPoolFunction = new lambda.Function(
      this,
      'RunnerWarmPoolFunction',
      {
        memorySize: this.lambdaMemorySize,
        logGroup: this.makeLogGroup('WarmPoolLogGroup'),
        code: lambda.Code.fromAsset(join(HANDLERS_DIR, 'bundled', 'warm-pool')),
        handler: 'index.handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        // A sweep may launch+wait+suspend several cold VMs serially per label
        // (see warm-pool.ts's module doc); comfortably under Lambda's
        // 15-minute ceiling, mirroring the janitor's own budget rationale.
        timeout: Duration.minutes(5),
        environment: {
          WARM_POOL_JSON: this.warmPoolJson,
          SIZE_CLASSES_JSON: this.sizeClassesJson,
          EGRESS_CONNECTOR_ARNS: this.egressConnectorArnsJson,
          LOGGING_JSON: this.loggingJson,
          MAX_JOB_DURATION_SECONDS: String(this.maxJobDurationSeconds),
          RUNNER_SET_ID: this.runnerSetId,
          // Opt-in metric gate, read by `handlers/shared/emf.ts`'s `emitEmf`.
          // `'false'` (the default) makes every per-tick pool-fill metric
          // emission a no-op.
          EMIT_METRICS: this.emitMetricsEnv,
          // Only set when a consumer opts into an execution role; unset ⇒ the
          // warm-pool handler's cold launch omits executionRoleArn ⇒ powerless
          // VM — same posture as the launcher's cold path.
          ...(this.vmExecutionRole
            ? { RUNNER_SET_VM_ROLE_ARN: this.vmExecutionRole.roleArn }
            : {}),
        },
      },
    );
    // No RUNNER_TABLE env / DynamoDB grant here: warm-pool.ts never reads
    // RUNNER_TABLE or touches DynamoDB (pool membership is derived purely
    // from MicroVM SUSPENDED state + image, per its module doc) — granting
    // it anyway would violate least privilege. A future reaping task can add
    // both back when it actually needs the runner table.
    warmPoolFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'lambda:RunMicrovm',
          'lambda:SuspendMicrovm',
          'lambda:ListMicrovms',
          'lambda:TerminateMicrovm',
          'lambda:GetMicrovm',
        ],
        resources: ['*'],
      }),
    );
    // Same PassNetworkConnector requirement as the launcher's cold path
    // (RunMicrovm "passes" every connector on the call) — see the launcher's
    // own PassNetworkConnector statement for the live-AccessDenied
    // provenance.
    warmPoolFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:PassNetworkConnector'],
        resources: [
          Stack.of(this).formatArn({
            service: 'lambda',
            account: 'aws',
            resource: 'network-connector',
            resourceName: 'aws-network-connector:*',
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
          ...this.network.connectorArns,
        ],
      }),
    );
    if (this.vmExecutionRole) {
      warmPoolFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [this.vmExecutionRole.roleArn],
        }),
      );
    }
    this.warmPoolFn = warmPoolFunction;

    new events.Rule(this, 'WarmPoolSchedule', {
      schedule: events.Schedule.rate(this.warmPoolInterval),
      targets: [new eventsTargets.LambdaFunction(warmPoolFunction)],
    });
  }

  /**
   * The registered `RunnerClass` carrying `label`. Throws when no class
   * with that label has been registered.
   *
   * @param label the `runs-on` label the class was registered under.
   */
  public runnerClass(label: string): RunnerClass {
    const found = this.classRegistry.find((c) => c.label === label);
    if (!found) {
      throw new Error(
        `GithubMicrovmRunners: no runner class registered with label "${label}".`,
      );
    }
    return found;
  }

  /**
   * Resolves a `RunnerNetwork` to the shape every downstream read site
   * (`network.connectorArns`, consumed for `EGRESS_CONNECTOR_ARNS`, the
   * `lambda:PassNetworkConnector` IAM resources, and each `ImagePipeline`'s
   * `egressNetworkConnectors`) already understands.
   *
   * `internetEgress()` and `vpcConnector()` pass through untouched — this is
   * the behavior-preserving guarantee: a runner set using either synthesizes
   * byte-identically to before this method existed.
   *
   * `RunnerNetwork.vpc(vpc, opts)` carries only the vpc + subnet/SG
   * selection (no connector exists yet — a consumer builds it before the
   * `GithubMicrovmRunners` construct itself does). Here, once `this` is a
   * real scope, materialize the `AWS::Lambda::NetworkConnector` + its
   * operator role and fold the resulting ARN into a `vpcConnector()`-shaped
   * instance — so every downstream read site needs no special-casing for the
   * vpc kind at all; it just sees another `connectorArns` entry.
   */
  private resolveNetwork(network: RunnerNetwork): RunnerNetwork {
    if (network.kind !== RunnerNetworkKind.VPC) {
      return network;
    }
    const vpc = network.sourceVpc;
    if (!vpc) {
      // Unreachable via the public API (RunnerNetwork.vpc() always sets
      // `sourceVpc`), but keeps this method total rather than trusting the
      // invariant silently.
      throw new Error(
        'GithubMicrovmRunners: RunnerNetwork of kind "vpc" has no vpc set.',
      );
    }

    const subnetIds = vpc.selectSubnets(network.subnets).subnetIds;
    const securityGroups = network.securityGroups ?? [
      new ec2.SecurityGroup(this, 'EgressConnectorSecurityGroup', { vpc }),
    ];

    // The connector's operator role: assumed by the Lambda service to manage
    // the ENIs it provisions in the consumer's VPC on the connector's
    // behalf. `CfnNetworkConnectorProps.operatorRole`'s doc: "This role must
    // have permissions for ec2:CreateNetworkInterface and related describe
    // operations" — the minimal ENI-lifecycle set below (create/delete +
    // describe subnets/security-groups/VPCs/network-interfaces), unscoped
    // (ENIs aren't known until the connector provisions them).
    //
    // The trust carries NO source condition, deliberately. An
    // `aws:SourceAccount` StringEquals condition was added here as standard
    // confused-deputy hardening and the SERVICE REJECTED IT (live deploy
    // 2026-07-22): `AWS::Lambda::NetworkConnector` failed with
    //   "The service is unable to assume the provided
    //    NetworkConnectorOperatorRole. Please verify the trust policy on the
    //    role. (Service: Lambda, Status Code: 400)"
    // and rolled the stack back — i.e. Lambda MicroVMs does not present
    // `aws:SourceAccount` when assuming a connector's operator role, so the
    // condition makes the feature unusable rather than safer. `aws:SourceArn`
    // is not an alternative: it would need the connector's own ARN, which does
    // not exist at role-creation time (this role is the connector's
    // `operatorRole` INPUT), so pinning to it is circular.
    //
    // Do NOT re-add a source condition without re-running the live VPC smoke
    // test (`examples/vpc-smoke/app.ts`). Static review will keep recommending
    // this hardening; only a real deploy shows that it breaks.
    const operatorRole = new iam.Role(this, 'NetworkConnectorOperatorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        EniManagement: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'ec2:CreateNetworkInterface',
                'ec2:DeleteNetworkInterface',
                'ec2:DescribeNetworkInterfaces',
                'ec2:DescribeSubnets',
                'ec2:DescribeSecurityGroups',
                'ec2:DescribeVpcs',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    const connector = new lambda.CfnNetworkConnector(this, 'NetworkConnector', {
      configuration: {
        vpcEgressConfiguration: {
          // "Currently, only MicroVm is supported" per
          // CfnNetworkConnector.VpcEgressConfigurationProperty's doc.
          associatedComputeResourceTypes: ['MicroVm'],
          subnetIds,
          securityGroupIds: securityGroups.map((sg) => sg.securityGroupId),
          // The CDK L1 type declares `networkProtocol` as optional, but the
          // service rejects a VPC_EGRESS connector that omits it — a live
          // deploy failed CREATE_FAILED with: "NetworkProtocol cannot be
          // null or empty for VPC_EGRESS connector" (same
          // optional-in-type/required-in-service trap as `idlePolicy`
          // members, fixed earlier on this branch). Default to IPv4-only;
          // a DualStack knob is a future public-API decision, not this fix.
          networkProtocol: 'IPv4',
        },
      },
      operatorRole: operatorRole.roleArn,
    });

    return RunnerNetwork.vpcConnector([connector.attrArn]);
  }

  /**
   * The image ARN the launcher/janitor fall back to for a job matching no
   * class: the `microvm` class if registered, else the first registered class.
   * Resolved at synth (via the `defaultImageArn` `Lazy`) from the completed
   * {@link classRegistry}; throws if no class was ever registered (which the
   * ≥1 validation reports as the primary, clearer synth error).
   */
  private resolveDefaultImageArn(): string {
    const microvmClass = this.classRegistry.find(
      (c) => c.label === DEFAULT_SIZE_CLASS_LABEL,
    );
    const defaultClass = microvmClass ?? this.classRegistry[0];
    if (!defaultClass) {
      throw new Error(
        'GithubMicrovmRunners: add at least one runner class with addRunnerClass(label, { size }).',
      );
    }
    return defaultClass.imageArn;
  }
}

/**
 * Deterministic 8-hex-char `RUNNER_SET_ID`, derived from the construct's own
 * `node.path` (stack name + every ancestor construct id) so that: the same
 * app synthesized twice yields the same id (no cross-synth drift in image
 * `Name`s or runner-name prefixes), and two `GithubMicrovmRunners` instances
 * in one stack — necessarily at different paths — never collide.
 */
function computeRunnerSetId(scope: Construct): string {
  return createHash('sha256')
    .update(scope.node.path)
    .digest('hex')
    .slice(0, RUNNER_SET_ID_HASH_LENGTH);
}
