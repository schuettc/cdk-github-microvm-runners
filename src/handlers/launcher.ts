/**
 * Launcher handler — SQS-driven, consumes `launch`/`terminate` intents
 * produced by the webhook handler (Task 8, `src/handlers/webhook.ts`) and
 * drives MicroVM lifecycle via `@aws-sdk/client-lambda-microvms`.
 *
 * Uses `reportBatchItemFailures` (SQS partial-batch failure reporting): a
 * failed message's id is returned in `batchItemFailures` so SQS redrives
 * only that message (with its queue's configured backoff), while
 * successful messages in the same batch are not redelivered.
 *
 * DESIGN AMENDMENT (supersedes the Task 9 brief's tag-based design — see
 * `.superpowers/sdd/progress.md` and the Task 9 dispatch): running
 * MicroVMs cannot be tagged, so:
 *  - Runner set membership is derived from image ARN, not a tag or
 *    `executionRoleArn` (see `shared/microvm-client.ts` module doc for why).
 *  - runnerName -> microvmId mapping lives in DynamoDB (`RUNNER_TABLE`),
 *    not a VM tag, because there is nothing to tag.
 *  - Concurrency is *always* counted live from `listRunnerSetVms`, never from
 *    the table — the service's VM list is the only ground truth.
 *
 * RunMicrovm sizing verdict (spike-verified via `aws lambda-microvms
 * run-microvm help` against SDK v3.1090.0, Task 9): sizing is IMAGE-LEVEL
 * ONLY — `RunMicrovmRequest` has no per-launch memory/resources field, only
 * `imageIdentifier`. `SIZE_CLASSES_JSON` is therefore a `{label:
 * {imageArn}}` map; `IMAGE_ARN` is the fallback/default image when no
 * job label matches a configured size class.
 *
 * Module-level env cache persists for the Lambda execution environment's
 * lifetime; call `_resetCachesForTesting()` between tests.
 */
import { randomUUID } from 'node:crypto';
import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type {
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
  SQSHandler,
  SQSRecord,
} from 'aws-lambda';
import { emitEmf } from './shared/emf.js';
import {
  generateJitConfig,
  getWorkflowJob,
  RetryableError,
  type ScopeTarget,
} from './shared/github-client.js';
import {
  allIngressConnectorArn,
  MAX_DURATION_GRACE_SECONDS,
  readEgressConnectors,
  resolveRuntimeLogging,
} from './shared/launch-params.js';
import {
  createMicrovmAuthToken,
  listRunnerSetVms,
  listSuspendedVmsForImage,
  resumeMicrovm,
  runMicrovm,
  terminateMicrovm,
  waitForMicrovmRunning,
} from './shared/microvm-client.js';
import { RUNNER_NAME_PREFIX } from './shared/runner-naming.js';
import {
  isRepoInScope,
  runnerSetConfigFor,
} from './shared/runner-set-config.js';
import { claimWarmVm } from './shared/warm-claim.js';

/**
 * EMF namespace for per-launch outcome + spin-up metrics (see
 * `emitLaunchMetrics` below). Same namespace janitor.ts's own metrics use —
 * one CloudWatch namespace for the whole runner set, dimensions distinguish
 * handler/shape.
 */
const EMF_NAMESPACE = 'MicrovmRunners';

/** Grace period added to a runner's TTL beyond its own max lifetime, absorbing a late/lost `completed` webhook. */
const TTL_GRACE_SECONDS = 3600;
/**
 * Budget for `waitForMicrovmRunning` after `RunMicrovm` returns, in the
 * ingress-push delivery flow below. The launcher's own Lambda timeout is 120s
 * (`LAUNCHER_TIMEOUT_SECONDS`, `src/github-microvm-runners.ts`) — this
 * leaves room after the wait for `createMicrovmAuthToken`, the push itself
 * (its own 10s `AbortSignal.timeout`, see `pushJitConfig`), and the final
 * `commitLaunch` transaction.
 */
const RUNNING_WAIT_TIMEOUT_MS = 90_000;
/** Poll interval for `waitForMicrovmRunning`. */
const RUNNING_WAIT_INTERVAL_MS = 2_000;
/** `CreateMicrovmAuthToken` expiration — short-lived, just long enough to push the JIT config once. */
const AUTH_TOKEN_EXPIRATION_MINUTES = 5;
/** Port the in-VM agent's ingress push endpoint listens on (`/aws/lambda-microvms/runtime/v1/run`). */
const INGRESS_PUSH_PORT = 8080;
/** Timeout for the JIT-config push HTTP request itself. */
const PUSH_TIMEOUT_MS = 10_000;
/**
 * Job-claim idempotency key prefix: `job#<repo>#<jobId>`. Reuses
 * `RUNNER_TABLE`'s existing `runnerName` partition key so no new table/GSI is
 * needed — a claim row can never collide with a real `microvm-runner-<runnerSetId>-<uuid>`
 * mapping row or a janitor `orphan-vm-<microvmId>` row (disjoint prefixes).
 * `janitor.ts` excludes `job#`-prefixed rows from runner/orphan
 * reconciliation entirely; they age out via the table's TTL like any other
 * row (rule-5-style hygiene for the pending case).
 *
 * DESIGN NOTE (claim-then-fail must never permanently swallow a job): a
 * claim that's merely conditionally created and never released would turn
 * ANY post-claim failure (a JIT error, a RunMicrovm throttle, a launch
 * transaction failure whose compensation succeeds) into a permanently-suppressed
 * job — the retried `launch` message would hit `ConditionalCheckFailed`
 * against the leftover claim and be swallowed as "duplicate" forever (or
 * until the claim's multi-hour TTL). So a claim carries real state
 * (`microvmId`, `launchedAt`, `attemptToken`) and this module actively
 * releases it whenever a failure is safely compensated, and additionally
 * supports a time-boxed takeover (`STALE_LEASE_SECONDS`) for the case where
 * a prior attempt died mid-flight without releasing at all (e.g. the Lambda
 * was killed mid-invocation). `acquireLaunchClaim` below is the single entry
 * point implementing this.
 *
 * `attemptToken` (a fresh `randomUUID()` minted by whichever attempt writes
 * or takes over the claim) is what every conditional release/update below is
 * actually keyed on — NOT `launchedAt`. Two independent attempts (an
 * original and a retry that raced a takeover) can share the same
 * millisecond-resolution clock value, so `launchedAt` alone can't
 * distinguish "my own claim" from "a claim someone else just took over" for
 * a safe conditional write; a random token can. `launchedAt` remains the
 * clock a takeover decision is based on (`STALE_LEASE_SECONDS`), just not
 * the identity a conditional write is keyed on.
 */
const CLAIM_ROW_PREFIX = 'job#';
/**
 * How long a `microvmId: 'pending'` claim is honored as "another attempt is
 * still in flight" before a fresh attempt is allowed to take it over. Well
 * above the launcher's own Lambda timeout (120s, see
 * `src/github-microvm-runners.ts`'s `LAUNCHER_TIMEOUT_SECONDS`) plus margin
 * for the SQS visibility-timeout (180s) redrive cadence, so a takeover only
 * ever
 * fires once the original attempt is provably dead, never while it's simply
 * still running.
 */
const STALE_LEASE_SECONDS = 180;

/**
 * TTL for a warm-VM claim row (`claimWarmVm`, Task 3) — only needs to cover
 * one launcher invocation's own resume + `waitForMicrovmRunning` + JIT push,
 * with margin (mirrors `RUNNING_WAIT_TIMEOUT_MS` + `PUSH_TIMEOUT_MS`). Unlike
 * `STALE_LEASE_SECONDS` (a stale-lease *takeover* window for the launch
 * claim), a warm-VM claim is never taken over — `claimWarmVm` is a one-shot
 * "first writer wins" primitive (see `warm-claim.ts`'s module doc), so a
 * lost/abandoned claim simply blocks that `microvmId` from being claimed
 * again until this TTL expires.
 */
const WARM_CLAIM_TTL_SECONDS = 300;

function launchClaimKey(repo: string, jobId: number): string {
  return `${CLAIM_ROW_PREFIX}${repo}#${jobId}`;
}

interface LaunchMessage {
  kind: 'launch';
  repo: string;
  jobId: number;
  runId: number;
  labels: string[];
}

interface TerminateMessage {
  kind: 'terminate';
  runnerName: string;
}

type QueueMessage = LaunchMessage | TerminateMessage;

const {
  requireEnv,
  numEnv,
  readScope,
  readSizeClasses,
  readLogging,
  readWarmPool,
  readIdlePolicies,
  runnerSetImageArns,
  resolveTarget,
} = runnerSetConfigFor('launcher');

let cachedDdbClient: DynamoDBClient | undefined;

/** Test-only: clear all module-level caches between test cases. */
export function _resetCachesForTesting(): void {
  cachedDdbClient = undefined;
}

function ddbClient(): DynamoDBClient {
  if (!cachedDdbClient) {
    cachedDdbClient = new DynamoDBClient({});
  }
  return cachedDdbClient;
}

/**
 * Push the JIT runner config to a RUNNING MicroVM's ingress endpoint. The
 * in-VM agent's `/run` handler (exact-path match, no agent changes needed
 * for this pivot) accepts `{"jitConfig": "<blob>"}` and returns 200. Any
 * non-200 status or network failure (including the request's own
 * `PUSH_TIMEOUT_MS` abort) throws, which the caller (`handleLaunch`) treats
 * exactly like any other post-`RunMicrovm` failure — compensating terminate,
 * then a conditional claim release.
 */
async function pushJitConfig(
  endpoint: string,
  authToken: string,
  jitConfig: string,
): Promise<void> {
  const res = await fetch(
    `https://${endpoint}/aws/lambda-microvms/runtime/v1/run`,
    {
      method: 'POST',
      headers: {
        'X-aws-proxy-auth': authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jitConfig }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    },
  );
  if (res.status !== 200) {
    throw new Error(
      `launcher: JIT config push returned HTTP ${res.status} (expected 200)`,
    );
  }
}

/**
 * Resolve the `SIZE_CLASSES_JSON` entry a launch's `labels` match: the LAST
 * key (in declared object order) that also appears in `labels`, or
 * `undefined` when no configured size-class label matches. Convention:
 * operators declare `SIZE_CLASSES_JSON` in ascending size order (Task 11's
 * construct wiring), so "last matching key" implements "largest match wins
 * if multiple" from the Task 9 dispatch without a numeric ordering field
 * (image-level sizing carries no `memoryGb`).
 *
 * Split out from `resolveImageArn` (below) so the warm-path guard (Task 5)
 * can check whether the matched LABEL has a `WARM_POOL_JSON` target without
 * re-implementing this matching loop.
 */
function resolveMatchedSizeClass(
  labels: string[],
): { label: string; imageArn: string } | undefined {
  const sizeClasses = readSizeClasses();
  const labelSet = new Set(labels);
  let matched: string | undefined;
  for (const label of Object.keys(sizeClasses)) {
    if (labelSet.has(label)) {
      matched = label;
    }
  }
  return matched
    ? { label: matched, imageArn: sizeClasses[matched].imageArn }
    : undefined;
}

/**
 * Resolve the image ARN for a launch: the matched size-class's image (see
 * `resolveMatchedSizeClass`), falling back to `IMAGE_ARN` when no configured
 * size-class label matches.
 */
function resolveImageArn(labels: string[]): string {
  return resolveMatchedSizeClass(labels)?.imageArn ?? requireEnv('IMAGE_ARN');
}

async function runningRunnerSetVmCount(): Promise<number> {
  const vms = await listRunnerSetVms(runnerSetImageArns(), ['RUNNING']);
  return vms.length;
}

/**
 * Commit a successful launch: the runner-mapping row and the claim's
 * `microvmId` stamp MUST land together or not at all. These used to be two
 * independent writes (a `PutItem` for the mapping, then a best-effort
 * `UpdateItem` on the claim whose failure was only logged) — that split
 * created a window where the mapping (and the real, running MicroVM behind
 * it) existed but the claim stayed `'pending'` forever, so a duplicate
 * delivery would eventually take over the "stale" claim via
 * `STALE_LEASE_SECONDS` and launch a SECOND MicroVM for the same job. A
 * single `TransactWriteItems` makes both writes atomic: either the mapping
 * is created AND the claim is stamped, or NEITHER happens (the claim is left
 * exactly as `acquireLaunchClaim` set it — still `'pending'`, still owned by
 * `ourAttemptToken`), so the caller's existing compensation path
 * (`terminate` the just-launched VM, then conditionally release the claim)
 * is the only recovery path — there is no partial state to reconcile.
 */
async function commitLaunch(params: {
  runnerName: string;
  microvmId: string;
  repo: string;
  jobId: number;
  maxJobDurationSeconds: number;
  claimKey: string;
  attemptToken: string;
}): Promise<void> {
  const tableName = requireEnv('RUNNER_TABLE');
  const launchedAtMs = Date.now();
  const expiresAt =
    Math.floor(launchedAtMs / 1000) +
    params.maxJobDurationSeconds +
    TTL_GRACE_SECONDS;
  await ddbClient().send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: marshall({
              runnerName: params.runnerName,
              microvmId: params.microvmId,
              repo: params.repo,
              jobId: params.jobId,
              launchedAt: new Date(launchedAtMs).toISOString(),
              expiresAt,
            }),
          },
        },
        {
          Update: {
            TableName: tableName,
            Key: marshall({ runnerName: params.claimKey }),
            UpdateExpression: 'SET microvmId = :m',
            ConditionExpression: 'attemptToken = :mine',
            ExpressionAttributeValues: marshall({
              ':m': params.microvmId,
              ':mine': params.attemptToken,
            }),
          },
        },
      ],
    }),
  );
}

/** A fresh claim's fields, marshalled once and reused by both the initial acquire attempt and a stale-lease takeover. `attemptToken` is a fresh `randomUUID()` identifying THIS attempt's hold on the claim (see module doc). */
function claimItem(params: {
  claimKey: string;
  repo: string;
  jobId: number;
  nowIso: string;
  expiresAt: number;
  attemptToken: string;
}): Record<string, unknown> {
  return {
    runnerName: params.claimKey,
    microvmId: 'pending',
    repo: params.repo,
    jobId: params.jobId,
    launchedAt: params.nowIso,
    expiresAt: params.expiresAt,
    attemptToken: params.attemptToken,
  };
}

/**
 * Acquire the job's launch claim. See the module-doc "DESIGN NOTE" above for
 * why this can't be a simple one-shot `attribute_not_exists` conditional put.
 *
 * - `{ status: 'acquired', attemptToken }`: safe to proceed with the launch
 *   side effects; `attemptToken` identifies THIS attempt's hold on the claim
 *   and must be threaded through to `releaseLaunchClaim`/`commitLaunch`
 *   below.
 * - `{ status: 'duplicate' }`: the claim's `microvmId` is a real
 *   (non-`'pending'`) id — a prior attempt already launched and mapped a
 *   MicroVM for this job. Logged, treated as success, never a batch failure.
 * - `{ status: 'retry-later' }`: the claim is `'pending'` and fresh (another
 *   attempt is plausibly still in flight), or a stale-lease takeover raced a
 *   concurrent acquirer and lost. Maps to a batch-item failure so SQS
 *   redrives the message — never suppressed.
 *
 * Any DynamoDB error other than a conditional-check failure propagates to
 * the caller as a normal batch-item failure.
 */
async function acquireLaunchClaim(params: {
  claimKey: string;
  repo: string;
  jobId: number;
  nowMs: number;
  nowIso: string;
  expiresAt: number;
}): Promise<
  | { status: 'acquired'; attemptToken: string }
  | { status: 'duplicate' }
  | { status: 'retry-later' }
> {
  const tableName = requireEnv('RUNNER_TABLE');
  const attemptToken = randomUUID();
  try {
    await ddbClient().send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(claimItem({ ...params, attemptToken })),
        ConditionExpression: 'attribute_not_exists(runnerName)',
      }),
    );
    return { status: 'acquired', attemptToken };
  } catch (err) {
    if (!(
      err instanceof Error && err.name === 'ConditionalCheckFailedException'
    )) {
      throw err;
    }
  }

  // Someone already holds (or held) this claim — inspect it before deciding.
  const existing = await ddbClient().send(
    new GetItemCommand({
      TableName: tableName,
      Key: marshall({ runnerName: params.claimKey }),
    }),
  );
  if (!existing.Item) {
    // Raced with a release (the holder's claim was deleted between our
    // failed conditional put and this read) — don't loop within this
    // invocation; a batch-item failure redrives and the retry will see a
    // clean slate.
    return { status: 'retry-later' };
  }

  const held = unmarshall(existing.Item) as {
    microvmId: string;
    launchedAt: string;
    attemptToken: string;
  };
  if (held.microvmId !== 'pending') {
    console.log(
      JSON.stringify({
        msg: 'launcher: duplicate launch suppressed',
        repo: params.repo,
        jobId: params.jobId,
      }),
    );
    return { status: 'duplicate' };
  }

  const heldAgeMs = params.nowMs - Date.parse(held.launchedAt);
  if (heldAgeMs < STALE_LEASE_SECONDS * 1000) {
    console.log(
      JSON.stringify({
        msg: 'launcher: launch claim held by an in-flight attempt',
        repo: params.repo,
        jobId: params.jobId,
        heldAgeMs,
      }),
    );
    return { status: 'retry-later' };
  }

  // Stale pending lease — a prior attempt died mid-flight without
  // releasing. Take over via a conditional put keyed on the OLD row's
  // `attemptToken` (NOT `launchedAt` — two attempts could share a clock
  // value), so a concurrent takeover attempt can never both win. The row we
  // write carries a BRAND NEW `attemptToken`, identifying this takeover as
  // its own attempt from here on.
  try {
    await ddbClient().send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(claimItem({ ...params, attemptToken })),
        ConditionExpression: 'attemptToken = :old',
        ExpressionAttributeValues: marshall({ ':old': held.attemptToken }),
      }),
    );
    return { status: 'acquired', attemptToken };
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === 'ConditionalCheckFailedException'
    ) {
      console.log(
        JSON.stringify({
          msg: 'launcher: stale claim takeover lost the race',
          repo: params.repo,
          jobId: params.jobId,
        }),
      );
      return { status: 'retry-later' };
    }
    throw err;
  }
}

/**
 * Release a held claim: a conditional `DeleteItem` keyed on OUR OWN
 * `attemptToken`, so this can never delete a claim a concurrent takeover has
 * since replaced (a `ConditionalCheckFailedException` there just means
 * someone else already took over — not an error, nothing to release).
 * Called from every post-acquire failure path that safely compensated its
 * own side effects, so a retried message can re-acquire cleanly instead of
 * being permanently suppressed as a false "duplicate".
 */
async function releaseLaunchClaim(
  claimKey: string,
  ourAttemptToken: string,
  reason: string,
): Promise<void> {
  try {
    await ddbClient().send(
      new DeleteItemCommand({
        TableName: requireEnv('RUNNER_TABLE'),
        Key: marshall({ runnerName: claimKey }),
        ConditionExpression: 'attemptToken = :mine',
        ExpressionAttributeValues: marshall({ ':mine': ourAttemptToken }),
      }),
    );
    console.log(
      JSON.stringify({
        msg: 'launcher: launch claim released',
        claimKey,
        reason,
      }),
    );
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === 'ConditionalCheckFailedException'
    ) {
      return;
    }
    console.error('launcher: launch claim release failed', {
      claimKey,
      reason,
      err,
    });
  }
}

/**
 * Compensation for ANY failure that occurs after `RunMicrovm` has already
 * returned a `microvmId` — a real VM exists, so (unlike the
 * `generateJitConfig`/`RunMicrovm` failure paths above, which have nothing
 * to terminate) the claim can only be safely released once that VM is
 * confirmed gone. Shared by the wait/token/push failure path and the
 * `commitLaunch` transaction failure path below — both leave the claim
 * exactly as `acquireLaunchClaim` set it (still `'pending'`) on entry, so
 * "terminate, then release only if terminate succeeded" is the same
 * recovery either way.
 */
async function compensateAfterRunMicrovm(params: {
  runnerName: string;
  microvmId: string;
  claimKey: string;
  attemptToken: string;
  reason: string;
  err: unknown;
}): Promise<void> {
  console.error('launcher: compensating terminate after post-launch failure', {
    runnerName: params.runnerName,
    microvmId: params.microvmId,
    reason: params.reason,
    err: params.err,
  });
  let compensated = true;
  try {
    await terminateMicrovm(params.microvmId);
  } catch (termErr) {
    compensated = false;
    console.error('launcher: compensating terminate failed', {
      runnerName: params.runnerName,
      microvmId: params.microvmId,
      err: termErr,
    });
  }
  if (compensated) {
    // The VM is confirmed gone: safe to release the claim so a retry can
    // re-acquire and launch cleanly.
    await releaseLaunchClaim(
      params.claimKey,
      params.attemptToken,
      `${params.reason} (compensated)`,
    );
  } else {
    // The VM's fate is ambiguous (terminate itself failed) — do NOT
    // release; retain the claim so nothing else launches a second VM for
    // this job while it might still be alive. It is still recoverable:
    // the stale-lease takeover above reclaims it once
    // `STALE_LEASE_SECONDS` has passed, and the janitor's orphan-VM logic
    // independently reaps the VM itself if it's still running unmapped.
    console.error(
      'launcher: launch claim retained after ambiguous compensation (terminate failed)',
      {
        runnerName: params.runnerName,
        microvmId: params.microvmId,
        claimKey: params.claimKey,
      },
    );
  }
}

/**
 * True if `err` is the SDK's named `ThrottlingException` — the same check
 * `isRetryable` (below) uses to decide whether a message should redrive.
 * Reused by `tryWarmPath`'s catch (purely for the `WarmThrottled` metric,
 * Task 3 of the metrics plan) so the two call sites can never classify the
 * same error differently.
 */
function isThrottlingError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ThrottlingException';
}

/**
 * True if `err` is the SDK's named `ServiceQuotaExceededException` — the
 * cold `RunMicrovm` call's capacity-rejection signal. Used only to classify
 * the `CapacityRejected` per-launch metric (Task 3 of the metrics plan);
 * does not change how the error is handled (still released + rethrown
 * exactly as before).
 */
function isCapacityError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ServiceQuotaExceededException';
}

/**
 * Best-effort per-launch outcome + spin-up metric emission (Task 3 of the
 * metrics plan) — PURELY OBSERVATIONAL: never allowed to affect
 * `handleLaunch`'s control flow. Wraps `emitEmf` in try/catch so a logging
 * failure (e.g. `console.log` throwing) never throws out of `handleLaunch`.
 * Dimensioned by `RunnerSetId` + `SizeClass` (the matched size-class label, or
 * `'unknown'` when no configured label matched); `metrics` carries exactly
 * one terminal-outcome counter (`WarmHit` | `ColdBoot` | `CapacityRejected`)
 * set to 1, optionally alongside `WarmThrottled: 1` (a warm attempt that hit
 * a throttle-classified error before falling back to cold — both can be
 * true for the same launch, see `handleLaunch`), and — only when the launch
 * succeeded — an outcome-specific spin-up latency: `WarmSpinUpMs` on a
 * `WarmHit`, `ColdSpinUpMs` on a `ColdBoot`. Kept as two distinct metric
 * names (rather than one blended `SpinUpMs`) so native CloudWatch
 * percentiles (p50/p99) never mix warm-resume latency with cold-boot
 * latency — a dashboard needs those separable per `SizeClass`.
 */
function emitLaunchMetrics(params: {
  runnerSetId: string;
  sizeClass: string;
  metrics: Record<string, number>;
}): void {
  try {
    emitEmf({
      namespace: EMF_NAMESPACE,
      dimensions: ['RunnerSetId', 'SizeClass'],
      dimensionValues: {
        RunnerSetId: params.runnerSetId,
        SizeClass: params.sizeClass,
      },
      metrics: params.metrics,
      timestamp: Date.now(),
      units: { WarmSpinUpMs: 'Milliseconds', ColdSpinUpMs: 'Milliseconds' },
    });
  } catch (err) {
    console.error(
      'launcher: per-launch metric emit failed (best-effort, ignored)',
      {
        err,
      },
    );
  }
}

/**
 * Warm-path attempt: claim + resume + inject a `SUSPENDED` warm-pool VM for
 * this job, falling back to the cold `RunMicrovm` path on ANY failure — the
 * pool is a pure optimization, never a hard dependency (see the warm-pool
 * plan's Global Constraints). Returns `{ handled: true, throttled: false }`
 * when a warm VM was successfully claimed, resumed, and committed as the
 * job's runner (the caller must return without touching the cold path);
 * `{ handled: false, throttled }` whenever the warm path should be skipped
 * entirely OR fell back (no candidate, `WARM_POOL_JSON` unset/lacks this
 * label, every claim lost, or any step after a won claim threw) —
 * `throttled` is `true` only when the fallback was triggered by a
 * throttle-classified error (`isThrottlingError`), purely for
 * `handleLaunch`'s `WarmThrottled` metric; it never changes the fallback
 * decision itself.
 *
 * DELIBERATELY calls `generateJitConfig` itself (a SEPARATE call from the
 * cold path's own, unchanged call further down in `handleLaunch`) rather
 * than sharing one jitConfig blob across both attempts: a JIT config's
 * registration token is effectively single-use once pushed to a VM, so
 * generating it fresh per attempt (and simply discarding it if that
 * attempt's VM is later terminated) is what keeps a warm-path failure from
 * ever risking two VMs racing to consume the same token. The cold path
 * below is therefore truly UNCHANGED — same call, same position, same
 * behavior regardless of whether a warm attempt was made first.
 *
 * The launch claim (`claimKey`/`attemptToken`) is NEVER released from here:
 * every ordinary failure path in this function is a same-invocation
 * fallback to cold (still using the SAME held claim), not a
 * batch-item-failure/redrive recovery like `compensateAfterRunMicrovm`'s
 * callers.
 *
 * ONE exception mirrors `compensateAfterRunMicrovm`'s own ambiguous case:
 * once `pushJitConfig` has already succeeded, the claimed VM is confirmed
 * RUNNING and armed with a valid, runnerName-scoped JIT config — a real,
 * credentialed runner. If something after that point (only `commitLaunch`,
 * in the current sequence) then fails AND the compensating `terminateMicrovm`
 * ALSO fails, the VM's fate is ambiguous: it may still be alive and able to
 * pick up the job. Falling through to cold in that case would launch a
 * SECOND VM for the same job while the first might still answer it — so
 * instead of returning `false`, this function RE-THROWS (retaining the
 * claim, never releasing it) exactly like `compensateAfterRunMicrovm`'s
 * ambiguous branch, so `handleLaunch` stops this invocation rather than
 * cold-booting a duplicate. The stale-lease takeover
 * (`STALE_LEASE_SECONDS`) and the janitor's orphan-VM reaping are the same
 * recovery paths that apply to the cold path's ambiguous case.
 *
 * A failure BEFORE `pushJitConfig` succeeds (claim lost, resume failure,
 * wait timeout, JIT generation/push failure) leaves the VM's armed-ness
 * unconfirmed either way, so an ambiguous compensating terminate there is
 * no worse than never having attempted the warm path at all — cold
 * fallback remains safe and unchanged.
 */
async function tryWarmPath(params: {
  label: string;
  imageArn: string;
  runnerName: string;
  repo: string;
  jobId: number;
  labels: string[];
  target: ScopeTarget;
  maxJobDurationSeconds: number;
  claimKey: string;
  attemptToken: string;
  nowMs: number;
}): Promise<{ handled: boolean; throttled: boolean }> {
  let warmPool: Record<string, number>;
  try {
    warmPool = readWarmPool();
  } catch (err) {
    // Distinguishable-in-logs only: still falls through to "no target for
    // this label" behavior below (a malformed WARM_POOL_JSON is never a hard
    // dependency — see the pool's Global Constraints in the module doc
    // above), just at debug level so an operator can tell a parse failure
    // apart from an intentionally-unset pool.
    console.debug(
      JSON.stringify({
        msg: 'launcher: readWarmPool failed, treating as no warm-pool target for this label',
        label: params.label,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return { handled: false, throttled: false };
  }
  const poolTarget = warmPool[params.label];
  if (!poolTarget || poolTarget <= 0) {
    return { handled: false, throttled: false };
  }

  // Set the moment a claim is won: from here on a real (possibly resumed)
  // VM may exist, so the catch below must attempt a compensating terminate
  // before falling back to cold — never leak it back to the pool.
  let claimedMicrovmId: string | undefined;
  // Set the moment `pushJitConfig` resolves: from here on the claimed VM is
  // confirmed RUNNING and armed with a valid JIT config for this
  // `runnerName` — a real, credentialed runner, not just a claimed-but-not-
  // -yet-confirmed one. See the module doc above for why this flips the
  // catch block's ambiguous-compensation handling.
  let jitConfigPushed = false;
  try {
    const candidates = await listSuspendedVmsForImage(params.imageArn);
    for (const microvmId of candidates) {
      const won = await claimWarmVm({
        microvmId,
        nowMs: params.nowMs,
        ttlSeconds: WARM_CLAIM_TTL_SECONDS,
      });
      if (!won) {
        continue;
      }
      claimedMicrovmId = microvmId;

      await resumeMicrovm(microvmId);
      const { endpoint } = await waitForMicrovmRunning(microvmId, {
        timeoutMs: RUNNING_WAIT_TIMEOUT_MS,
        intervalMs: RUNNING_WAIT_INTERVAL_MS,
      });
      const jitConfig = await generateJitConfig({
        target: params.target,
        runnerName: params.runnerName,
        labels: params.labels,
      });
      const authToken = await createMicrovmAuthToken(
        microvmId,
        AUTH_TOKEN_EXPIRATION_MINUTES,
        INGRESS_PUSH_PORT,
      );
      await pushJitConfig(endpoint, authToken, jitConfig);
      jitConfigPushed = true;
      await commitLaunch({
        runnerName: params.runnerName,
        microvmId,
        repo: params.repo,
        jobId: params.jobId,
        maxJobDurationSeconds: params.maxJobDurationSeconds,
        claimKey: params.claimKey,
        attemptToken: params.attemptToken,
      });
      logLaunchOutcome({
        path: 'warm',
        repo: params.repo,
        jobId: params.jobId,
        sizeClass: params.label,
        microvmId,
        runnerName: params.runnerName,
      });
      return { handled: true, throttled: false };
    }
    return { handled: false, throttled: false };
  } catch (err) {
    // Purely observational (Task 3 of the metrics plan): does not affect
    // which branch below is taken, only what `handleLaunch` records once
    // this function returns.
    const throttled = isThrottlingError(err);
    console.error(
      JSON.stringify({
        msg: 'launcher: warm-path attempt failed, falling back to cold boot',
        label: params.label,
        imageArn: params.imageArn,
        microvmId: claimedMicrovmId,
        err: err instanceof Error ? err.message : String(err),
        errName: err instanceof Error ? err.name : undefined,
      }),
    );
    if (claimedMicrovmId) {
      let compensated = true;
      try {
        await terminateMicrovm(claimedMicrovmId);
      } catch (termErr) {
        compensated = false;
        console.error(
          JSON.stringify({
            msg: 'launcher: warm-path compensating terminate failed',
            microvmId: claimedMicrovmId,
            err: termErr instanceof Error ? termErr.message : String(termErr),
          }),
        );
      }
      if (!compensated && jitConfigPushed) {
        // Ambiguous AND the VM was confirmed armed: mirror
        // `compensateAfterRunMicrovm`'s own ambiguous branch — retain the
        // claim (never released here) and re-throw so `handleLaunch` stops
        // this invocation instead of cold-booting a second VM for the same
        // job while the first may still be alive and able to pick it up.
        console.error(
          JSON.stringify({
            msg: 'launcher: warm-path claim retained after ambiguous compensation (terminate failed post-JIT-push)',
            microvmId: claimedMicrovmId,
            claimKey: params.claimKey,
          }),
        );
        throw err;
      }
    }
    return { handled: false, throttled };
  }
}

/**
 * One INFO line per launch that actually produced a runner, keyed by `jobId`.
 *
 * The launcher used to log only the paths that DIDN'T launch — skips and
 * errors — so a job that stalled left no trace and an operator could not
 * answer "did this plane even try for my job?" from the logs (found live
 * 2026-08-01, muster thread 146: an 85-minute production stall whose job id
 * appeared nowhere). `path` distinguishes a warm resume from a cold boot; the
 * `microvmId`/`runnerName` pair is what makes a job traceable onward into the
 * VM's own console stream and into GitHub's record of which runner served it.
 *
 * Deliberately NOT gated on `emitMetrics`: the EMF envelope carries no job
 * identity and is off by default, so gating this the same way would reproduce
 * exactly the blind spot it exists to close.
 */
function logLaunchOutcome(params: {
  path: 'cold' | 'warm';
  repo: string;
  jobId: number;
  sizeClass: string;
  microvmId: string;
  runnerName: string;
}): void {
  console.log(
    JSON.stringify({
      msg: 'launcher: launched',
      path: params.path,
      repo: params.repo,
      jobId: params.jobId,
      sizeClass: params.sizeClass,
      microvmId: params.microvmId,
      runnerName: params.runnerName,
    }),
  );
}

/**
 * True when this job is no longer waiting for a runner, so the launch should
 * be dropped rather than performed.
 *
 * FAILS OPEN, ON PURPOSE. Every path other than a definite answer from GitHub
 * returns `false` and lets the launch proceed. Getting this backwards would be
 * far worse than the leak it prevents: a rate limit, a transient 5xx or a
 * malformed repo string would silently cancel legitimate jobs, and the symptom
 * — jobs that queue forever having never been picked up — looks nothing like
 * its cause. A launch that should have been skipped costs one VM for a sweep
 * or two; a job that should have launched and did not costs a developer their
 * afternoon.
 *
 * `getWorkflowJob` returns `undefined` on a 404. That is treated as gone: the
 * job was deleted, or its run was, and there is nothing left to run it on.
 *
 * A `completed` job is NOT automatically gone, and that is the subtle part.
 * Runners are a POOL: a JIT runner is not bound to the job whose launch
 * created it, so GitHub hands a registering runner whichever queued job it
 * likes among those carrying matching labels (verified live 2026-08-01 — two
 * jobs in one burst landed on each other's VMs, exactly swapped). So
 * `completed` covers two opposite situations:
 *
 *   - Cancelled while still queued: no runner ever claimed it, nothing was
 *     spent, and nothing else is waiting on what this launch would supply.
 *     Skipping is free, and this is the case the guard exists for.
 *   - Already SERVED by one of this runner set's own runners: a runner WAS
 *     spent, drawn from the pool, and whichever job lent it is very likely
 *     still queued. Skipping here drops supply below demand, and the starved
 *     job then waits forever because nothing reconciles it (found live
 *     2026-08-01: four jobs in one burst, three VMs, one launch skipped, one
 *     job queued 85 minutes on a completely healthy plane).
 *
 * `conclusion` and `runner_name` tell the two apart, and GitHub's own
 * signature for the cancelled case — quoted in `handleLaunch` below — is an
 * EMPTY `runner_name`. A job that actually ran names the runner that ran it,
 * so a named runner means the pool is now one short and this launch is how it
 * is repaid.
 */
async function skipCancelledJob(
  message: LaunchMessage,
  sizeClass: string,
  runnerSetId: string,
): Promise<boolean> {
  const [owner, name] = message.repo.split('/');
  if (!owner || !name) {
    return false;
  }
  let job;
  try {
    job = await getWorkflowJob(
      resolveTarget(readScope(), message.repo),
      owner,
      name,
      message.jobId,
    );
  } catch (err) {
    // Read failed, so nothing is known. Launch.
    console.error('launcher: pre-launch job check failed; launching anyway', {
      repo: message.repo,
      jobId: message.jobId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  // `queued` is the only state that still wants a runner. `in_progress` means
  // some other runner already took it, which is equally a reason not to launch
  // — but it is not what this guard is for, and a duplicate delivery is
  // already handled by the launch claim, so it is left alone here.
  if (job && job.status !== 'completed') {
    return false;
  }
  // Completed, but a runner served it: that runner came out of this runner
  // set's pool, so supply is down one while demand may not be. Launch, and let
  // the fresh runner be claimed by whichever job is still queued. See the
  // module doc above for the burst this comes from.
  if (job?.runnerName) {
    console.log(
      JSON.stringify({
        msg: 'launcher: job already served by a pool runner, launching to restore supply',
        repo: message.repo,
        jobId: message.jobId,
        conclusion: job.conclusion,
        servedBy: job.runnerName,
        sizeClass,
      }),
    );
    return false;
  }
  console.log('launcher: job is no longer queued, skipping the launch', {
    repo: message.repo,
    jobId: message.jobId,
    status: job?.status ?? 'gone',
    conclusion: job?.conclusion ?? 'gone',
    sizeClass,
  });
  emitLaunchMetrics({
    runnerSetId,
    sizeClass,
    metrics: { CancelledBeforeLaunch: 1 },
  });
  return true;
}

async function handleLaunch(message: LaunchMessage): Promise<void> {
  // Scope, before ANY side effect: no GitHub call, no capacity read, no
  // DynamoDB claim, no MicroVM. Defence in depth behind the webhook's own
  // check — a message reaching this queue by any route other than that
  // webhook has not been scope-checked at all, and this is the last place to
  // decide before the launch starts spending.
  //
  // `return`, not `throw`: an out-of-scope message is not a transient
  // failure and will never become in-scope, so re-driving it until it
  // dead-letters would only burn the queue's redrive budget. Returning
  // deletes it.
  if (!isRepoInScope(readScope(), message.repo)) {
    console.log(
      JSON.stringify({
        msg: 'launcher: repo is outside this runner set scope, dropping the launch',
        repo: message.repo,
        jobId: message.jobId,
      }),
    );
    return;
  }

  // Spin-up clock t0: captured at the very top of this invocation, BEFORE
  // the capacity check below (`runningRunnerSetVmCount`'s `ListMicrovms`
  // round-trip is real spin-up latency a launch incurs, so `WarmSpinUpMs`/
  // `ColdSpinUpMs` must include it). Deliberately a SEPARATE timestamp from
  // `nowMs` below — that one is the post-capacity-check launch clock used
  // for claim/TTL
  // timestamps and must stay exactly where it is (unrelated call sites key
  // off it), so it is never repointed at this earlier moment.
  const spinUpStartMs = Date.now();
  const maxConcurrent = numEnv('MAX_CONCURRENT');
  const maxJobDurationSeconds = numEnv('MAX_JOB_DURATION_SECONDS');
  const runnerSetId = requireEnv('RUNNER_SET_ID');
  // Optional: unset ⇒ powerless VM (no AWS identity, IMDS serves no creds).
  // This is the default; the construct only sets it when a consumer opts a
  // runner set's VMs into an execution role. See microvm-client's RunMicrovmParams.
  const runnerSetVmRoleArn = process.env.RUNNER_SET_VM_ROLE_ARN || undefined;

  // Resolved before the capacity check so a rejection can be attributed to a
  // size class. `resolveMatchedSizeClass` reads the message's labels and
  // nothing else, so moving it earlier costs no work and reaches no service.
  const matchedSizeClass = resolveMatchedSizeClass(message.labels);
  const sizeClass = matchedSizeClass?.label ?? 'unknown';

  // Is this job still waiting for a runner?
  //
  // A job cancelled while it is still QUEUED never reaches the terminate path:
  // GitHub's `workflow_job.completed` for it carries an EMPTY `runner_name`
  // (an empty string, not null), because no runner ever claimed it — and the
  // webhook has nothing to name in a terminate message, so it ignores the
  // event. Without this check the launch goes ahead regardless, boots a VM,
  // and registers a runner for a job that no longer exists. That VM then sits
  // idle until the janitor's idle rule reaps it, which takes the grace period
  // plus two sweeps: 15 to 20 minutes on the defaults.
  //
  // The cost of that is not the VM, it is the SLOT. A running VM counts toward
  // `maxConcurrentVms` whether or not it has a job, so on a repository using
  // concurrency groups — where every re-push cancels the superseded run while
  // it is still queued — a burst of pushes can hold a large share of the
  // runner set's capacity while real jobs queue behind it, with nothing in the
  // metrics that says so.
  //
  // This is deliberately placed BEFORE the capacity check and the claim: the
  // whole point is to not take a slot in the first place. It also gets more
  // valuable exactly when it matters most — under capacity pressure launches
  // are re-driven with the queue's visibility timeout, so a launch message can
  // sit for minutes, and this reads GitHub's view at the moment the launch is
  // finally processed rather than when it was enqueued.
  //
  // Anything other than a definite "this job is gone" proceeds with the
  // launch. A failed read must never cancel a legitimate job, so the error
  // path below deliberately falls through — see `skipCancelledJob`.
  if (await skipCancelledJob(message, sizeClass, runnerSetId)) {
    return;
  }

  const runningCount = await runningRunnerSetVmCount();
  if (runningCount >= maxConcurrent) {
    // `maxConcurrentVms` is the runner set's own ceiling, and hitting it was
    // silent: the throw below re-drives the message, so jobs queue and
    // eventually run, and the only trace was a log line. That left the most
    // common cause of queueing — the cap the operator set — invisible on the
    // metric whose whole job is to say "jobs are waiting rather than
    // running", while `capacityRejected()`'s own documentation claimed it
    // covered exactly this case. The service-side quota rejection further
    // down emits the same counter; the two are told apart by the log rather
    // than by separate metrics, because the operator's next question — why
    // are jobs waiting — is the same either way.
    emitLaunchMetrics({
      runnerSetId,
      sizeClass,
      metrics: { CapacityRejected: 1 },
    });
    throw new RetryLaterError(
      `launcher: runner set at capacity (${runningCount}/${maxConcurrent})`,
    );
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const claimKey = launchClaimKey(message.repo, message.jobId);
  // Same TTL horizon as a runner mapping row (see `commitLaunch`): job
  // duration + the platform grace + the runner-TTL grace.
  const claimExpiresAt =
    Math.floor(nowMs / 1000) + maxJobDurationSeconds + TTL_GRACE_SECONDS;
  const claimResult = await acquireLaunchClaim({
    claimKey,
    repo: message.repo,
    jobId: message.jobId,
    nowMs,
    nowIso,
    expiresAt: claimExpiresAt,
  });
  if (claimResult.status === 'duplicate') {
    return;
  }
  if (claimResult.status === 'retry-later') {
    throw new RetryLaterError(
      `launcher: launch claim contended for ${claimKey}`,
    );
  }
  const { attemptToken } = claimResult;

  const runnerName = `${RUNNER_NAME_PREFIX}-${runnerSetId}-${randomUUID().slice(0, 8)}`;
  const target = resolveTarget(readScope(), message.repo);

  // Warm-path attempt: only when the job's matched size class has a
  // WARM_POOL_JSON target. Any failure (including WARM_POOL_JSON being
  // entirely unset) falls through to the cold path below, unchanged.
  //
  // Metrics (Task 3 of the metrics plan, purely observational — see
  // `emitLaunchMetrics`): `sizeClass` labels every envelope this launch
  // emits (`'unknown'` when no configured size class matched);
  // `warmThrottled` carries forward a throttle-classified warm-attempt
  // failure so it can ride alongside whichever terminal outcome the cold
  // path lands on below (`WarmSpinUpMs`/`ColdSpinUpMs` below are measured
  // from `spinUpStartMs`, captured at this function's entry — BEFORE the
  // capacity check — not
  // from `nowMs`, which is the separate post-capacity-check clock used for
  // claim/TTL timestamps; see the module doc at `spinUpStartMs`'s
  // declaration for why the two must stay distinct). `matchedSizeClass` and
  // `sizeClass` are resolved above the capacity check, so a capacity
  // rejection can carry the same label this path uses.
  let warmThrottled = false;
  if (matchedSizeClass) {
    const warmResult = await tryWarmPath({
      label: matchedSizeClass.label,
      imageArn: matchedSizeClass.imageArn,
      runnerName,
      repo: message.repo,
      jobId: message.jobId,
      labels: message.labels,
      target,
      maxJobDurationSeconds,
      claimKey,
      attemptToken,
      nowMs,
    });
    warmThrottled = warmResult.throttled;
    if (warmResult.handled) {
      emitLaunchMetrics({
        runnerSetId,
        sizeClass,
        metrics: { WarmHit: 1, WarmSpinUpMs: Date.now() - spinUpStartMs },
      });
      return;
    }
  }

  let jitConfig: string;
  try {
    jitConfig = await generateJitConfig({
      target,
      runnerName,
      labels: message.labels,
    });
  } catch (err) {
    await releaseLaunchClaim(
      claimKey,
      attemptToken,
      'generateJitConfig failure',
    );
    throw err;
  }

  const imageArn = resolveImageArn(message.labels);
  // Cold-path-only: the matched size class's idlePolicy (undefined when that
  // class never set one, or when no class matched at all — a class can never
  // have both `warm` and `idlePolicy`, see `addRunnerClass`'s eager guard, so
  // this lookup and the warm-path attempt above never both apply to the same
  // class). The warm-pool handler's own cold launches (`warm-pool.ts`) never
  // read this — a warm class can't have an idlePolicy.
  const idlePolicy = matchedSizeClass
    ? readIdlePolicies()[matchedSizeClass.label]
    : undefined;
  let microvmId: string;
  try {
    microvmId = await runMicrovm({
      imageArn,
      executionRoleArn: runnerSetVmRoleArn,
      maximumDurationInSeconds:
        maxJobDurationSeconds + MAX_DURATION_GRACE_SECONDS,
      ingressNetworkConnectors: [allIngressConnectorArn(requireEnv)],
      egressNetworkConnectors: readEgressConnectors(),
      logging: resolveRuntimeLogging(readLogging, Boolean(runnerSetVmRoleArn)),
      idlePolicy,
    });
  } catch (err) {
    // Nothing to terminate yet — no VM was created — so a plain claim
    // release (not the terminate-then-release compensation below) is the
    // correct recovery here.
    await releaseLaunchClaim(claimKey, attemptToken, 'RunMicrovm failure');
    if (isCapacityError(err)) {
      const metrics: Record<string, number> = { CapacityRejected: 1 };
      if (warmThrottled) {
        metrics.WarmThrottled = 1;
      }
      emitLaunchMetrics({ runnerSetId, sizeClass, metrics });
    }
    throw err;
  }

  // From here on a real VM exists. Delivery is an ingress-endpoint push
  // (RunMicrovm's runHookPayload is capped at 4096 chars server-side and
  // JIT config blobs routinely exceed it — see microvm-client.ts's module
  // doc): wait for the VM to reach RUNNING, mint a short-lived auth token,
  // then POST the JIT config to its ingress endpoint. ANY failure in this
  // sequence is compensated exactly like a `commitLaunch` failure — the VM
  // is real and must be torn down before the claim can be released.
  try {
    const { endpoint } = await waitForMicrovmRunning(microvmId, {
      timeoutMs: RUNNING_WAIT_TIMEOUT_MS,
      intervalMs: RUNNING_WAIT_INTERVAL_MS,
    });
    const authToken = await createMicrovmAuthToken(
      microvmId,
      AUTH_TOKEN_EXPIRATION_MINUTES,
      INGRESS_PUSH_PORT,
    );
    await pushJitConfig(endpoint, authToken, jitConfig);
  } catch (err) {
    await compensateAfterRunMicrovm({
      runnerName,
      microvmId,
      claimKey,
      attemptToken,
      reason: 'JIT config delivery failure',
      err,
    });
    throw err;
  }

  // The mapping row and the claim's microvmId stamp land LAST, in a single
  // atomic transaction, only once the VM is confirmed RUNNING and armed
  // with its JIT config — so a mapping only ever exists for a VM that can
  // actually pick up a job.
  try {
    await commitLaunch({
      runnerName,
      microvmId,
      repo: message.repo,
      jobId: message.jobId,
      maxJobDurationSeconds,
      claimKey,
      attemptToken,
    });
  } catch (err) {
    // The transaction failed as a whole (any reason, including
    // `TransactionCanceledException` from the claim's `attemptToken`
    // condition losing a race) — NEITHER the mapping row nor the claim
    // stamp was written, so the claim is still exactly as
    // `acquireLaunchClaim` left it.
    await compensateAfterRunMicrovm({
      runnerName,
      microvmId,
      claimKey,
      attemptToken,
      reason: 'launch transaction failure',
      err,
    });
    throw err;
  }

  logLaunchOutcome({
    path: 'cold',
    repo: message.repo,
    jobId: message.jobId,
    sizeClass,
    microvmId,
    runnerName,
  });
  const coldMetrics: Record<string, number> = {
    ColdBoot: 1,
    ColdSpinUpMs: Date.now() - spinUpStartMs,
  };
  if (warmThrottled) {
    coldMetrics.WarmThrottled = 1;
  }
  emitLaunchMetrics({ runnerSetId, sizeClass, metrics: coldMetrics });
}

async function handleTerminate(message: TerminateMessage): Promise<void> {
  const tableName = requireEnv('RUNNER_TABLE');
  const getRes = await ddbClient().send(
    new GetItemCommand({
      TableName: tableName,
      Key: marshall({ runnerName: message.runnerName }),
    }),
  );

  if (!getRes.Item) {
    console.log('launcher: terminate for unknown runnerName (idempotent)', {
      runnerName: message.runnerName,
    });
    return;
  }

  const item = unmarshall(getRes.Item) as { microvmId: string; jobId?: number };
  await terminateMicrovm(item.microvmId);
  // `launchedForJobId` is deliberately named for what it is, and is very often
  // NOT the job whose `completed` event triggered this terminate: runners are
  // a pool, so the runner that finished a job usually lives on a VM launched
  // for some other job. Without this line a VM simply disappears from the
  // plane with nothing tying it to anything (2026-08-01, muster thread 146).
  console.log(
    JSON.stringify({
      msg: 'launcher: terminated',
      runnerName: message.runnerName,
      microvmId: item.microvmId,
      launchedForJobId: item.jobId,
    }),
  );

  try {
    await ddbClient().send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: marshall({ runnerName: message.runnerName }),
      }),
    );
  } catch (err) {
    // Best-effort: a leftover row is the janitor's problem, not a reason to
    // fail (and redrive) an already-successful termination.
    console.error('launcher: DeleteItem failed after terminate', {
      runnerName: message.runnerName,
      err,
    });
  }
}

/**
 * Thrown when the runner set is at its concurrency cap; maps to an SQS
 * batch-item failure so the message redrives with the queue's backoff.
 * Module-private: nothing outside this file needs to catch it by type
 * (only `isRetryable` below does), so it stays unexported rather than
 * tripping fallow's unused-export check.
 */
class RetryLaterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryLaterError';
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof RetryLaterError || err instanceof RetryableError) {
    return true;
  }
  return isThrottlingError(err);
}

async function processRecord(record: SQSRecord): Promise<void> {
  const message = JSON.parse(record.body) as QueueMessage;
  if (message.kind === 'launch') {
    await handleLaunch(message);
    return;
  }
  if (message.kind === 'terminate') {
    await handleTerminate(message);
    return;
  }
  throw new Error(
    `launcher: unknown message kind "${(message as { kind: string }).kind}"`,
  );
}

/** SQS batch handler entry point. */
export const handler: SQSHandler = async (
  event: SQSEvent,
): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      if (!isRetryable(err)) {
        console.error('launcher: unexpected error processing message', {
          messageId: record.messageId,
          body: record.body,
          err,
        });
      }
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
