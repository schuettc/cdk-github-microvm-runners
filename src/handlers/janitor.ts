/**
 * Janitor handler — scheduled sweep that reconciles running MicroVMs
 * against GitHub Actions runner registrations and reaps the ones GitHub
 * lost track of (or that never got picked up), using a conservative
 * two-strike rule.
 *
 * THIS IS THE WRONG-KILL-RISK CODE. Every rule below traces back to a
 * corroborated production failure mode: runners killed mid-job by a
 * stale-list race (GitHub's `listRunners` lagging a runner picking up a
 * job — see the "#4391 case" tests). Conservatism here is load-bearing,
 * not style: when in doubt, this code does nothing and waits for the next
 * sweep, never guesses toward termination.
 *
 * DESIGN AMENDMENT (supersedes the Task 10 brief's VM-tag-based strike
 * memory — running MicroVMs cannot be tagged, the same spike finding that
 * drove Task 9's amendment): strike memory (`suspectSince`) lives as an
 * attribute on the launcher's `RUNNER_TABLE` row (`src/handlers/launcher.ts`),
 * keyed by the same `runnerName` partition key. A MicroVM that exists with
 * no table row at all (the launcher crashed between `RunMicrovm` and
 * `PutItem`) gets its own synthetic row keyed `orphan-vm-${microvmId}`
 * (attributes: `microvmId`, `orphanSince`), so two-strike memory still
 * applies to VMs the launcher never got to record.
 *
 * Runner set VM discovery is a UNION of (a) `listRunnerSetVms` scoped to the
 * *current* `SIZE_CLASSES_JSON`/`IMAGE_ARN` image ARNs, and (b) every
 * `microvmId` referenced by a `RUNNER_TABLE` row not already covered by
 * (a), resolved individually via `getMicrovm`. (b) closes the
 * "image-rotation" gap flagged in Task 9's review: a VM launched from a
 * since-rotated-out image ARN is invisible to `listRunnerSetVms(currentArns)`
 * forever, but its table row (and strike memory) must still be reconciled.
 *
 * NEVER terminate or deregister without a FRESH per-runner GitHub read
 * (`getRunner` by cached id, or a fresh `listRunners` re-list when no id is
 * cached yet) taken in THIS invocation, immediately before acting — cached
 * list output is documented stale. The only exceptions are rule 4 (the
 * VM-lifetime backstop) and rule 6 (orphan-VM termination), where there is
 * no runner to check in the first place — see `reconcileRunningVm` below.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { emitEmf } from './shared/emf.js';
import {
  deleteRunner,
  getRunner,
  getWorkflowJob,
  listRunners,
  type GithubRunner,
  type ScopeTarget,
} from './shared/github-client.js';
import {
  deleteImageVersion,
  getMicrovm,
  listImageVersions,
  listRunnerSetVms,
  terminateMicrovm,
  type RunnerSetVm,
} from './shared/microvm-client.js';
import { RUNNER_NAME_PREFIX } from './shared/runner-naming.js';
import {
  runnerSetConfigFor,
  type ScopeConfig,
} from './shared/runner-set-config.js';

const EMF_NAMESPACE = 'MicrovmRunners';
/** Prefix for the janitor's own synthetic strike-memory row for a table-less VM (see module doc). */
const ORPHAN_ROW_PREFIX = 'orphan-vm-';
/**
 * Prefix for the launcher's job-claim idempotency rows (`job#<repo>#<jobId>`,
 * see `launcher.ts`'s `CLAIM_ROW_PREFIX`). These are NOT runner mappings or
 * orphan-VM strike memory — a claim's `microvmId` is `'pending'` until the
 * launcher's post-launch best-effort update, so it never corresponds to a
 * real running VM the janitor should reconcile. Claim rows are touched by:
 * (a) rule-5-style hygiene (deleted once their own `expiresAt` has passed),
 * and (b) the opt-in `recoverStuckLaunches` committed-claim reconciliation
 * (if a committed claim's VM is gone/TERMINATED but its GitHub job is still
 * `queued`, the claim is deleted and a fresh launch is re-driven).
 */
const CLAIM_ROW_PREFIX = 'job#';
/**
 * Prefix for the warm-pool claim rows written by `warm-claim.ts`'s
 * `claimWarmVm` (`warmvm#<microvmId>`, see its `WARM_CLAIM_PREFIX`). Like a
 * launch-claim row, this is a claim MARKER, not a runner mapping — and
 * critically it has NO `microvmId` attribute at all (the id lives only
 * inside the `runnerName` string), so it must never reach `buildVmMap`:
 * `getMicrovm(row.microvmId)` would be `getMicrovm(undefined)`, which
 * surfaces as a non-`ResourceNotFoundException` error `getMicrovm` doesn't
 * swallow, aborting the whole sweep. Reclaimed by its own `expiresAt` TTL —
 * no active hygiene delete needed here (unlike claim rows, which get one).
 */
const WARM_CLAIM_PREFIX = 'warmvm#';
/** Grace added to a job's max duration before the platform's own `maximumDurationInSeconds` cap "should" have fired (mirrors `launcher.ts`'s `MAX_DURATION_GRACE_SECONDS`). */
const LIFETIME_CAP_GRACE_SECONDS = 300;

/**
 * A `RUNNER_TABLE` row: either a launcher-created runner mapping
 * (`runnerName` = `microvm-runner-<runnerSetId>-<uuid>`, always has `repo`/`jobId`/
 * `launchedAt`/`expiresAt`) or a janitor-synthesized orphan-VM row
 * (`runnerName` = `orphan-vm-<microvmId>`, only `microvmId`/`orphanSince`).
 */
interface RunnerRow {
  runnerName: string;
  microvmId: string;
  repo?: string;
  jobId?: number;
  launchedAt?: string;
  expiresAt?: number;
  suspectSince?: string;
  orphanSince?: string;
  runnerId?: number;
}

interface Metrics {
  orphansReaped: number;
  stuckRunnersReaped: number;
  suspectsCleared: number;
  lifetimeKills: number;
  imageVersionsPruned: number;
  tableRowsCleaned: number;
  /** Count of dead-lettered launches re-driven onto the job queue by `recoverStuckLaunches` (feature off -> always 0). A persistently high value means launches are failing for a non-outage reason — alarm on it. */
  stuckLaunchesRecovered: number;
  /** Count of committed-but-unserved launches re-launched from an orphaned claim (feature off -> always 0): the launch's VM is gone/TERMINATED but its GitHub job is still `queued`. A persistently high value means a non-outage bug — alarm on it. */
  stuckClaimsRelaunched: number;
  /** Count of per-item failures caught and isolated (see `reconcileTable`/`pruneImageVersions`); a sweep with `errors > 0` still emits metrics and completes. */
  errors: number;
}

function freshMetrics(): Metrics {
  return {
    orphansReaped: 0,
    stuckRunnersReaped: 0,
    suspectsCleared: 0,
    lifetimeKills: 0,
    imageVersionsPruned: 0,
    tableRowsCleaned: 0,
    stuckLaunchesRecovered: 0,
    stuckClaimsRelaunched: 0,
    errors: 0,
  };
}

/** Render an unknown thrown value into a JSON-loggable string. */
function serializeError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

interface JanitorContext {
  tableName: string;
  scope: ScopeConfig;
  runnerSetId: string;
  graceSeconds: number;
  intervalSeconds: number;
  lifetimeCapSeconds: number;
  nowMs: number;
  nowIso: string;
  metrics: Metrics;
  /** target key ("org:<org>" | "repo:<owner>/<repo>") -> runnerName -> GithubRunner, filtered to this runner set's runner-name prefix. Populated lazily and refreshed by `freshGetRunner`'s re-list fallback. */
  runnersByTarget: Map<string, Map<string, GithubRunner>>;
}

const { requireEnv, numEnv, readScope, runnerSetImageArns, resolveTarget } =
  runnerSetConfigFor('janitor');

let cachedDdbClient: DynamoDBClient | undefined;
let cachedSqsClient: SQSClient | undefined;

/** Test-only: clear all module-level caches between test cases. */
export function _resetCachesForTesting(): void {
  cachedDdbClient = undefined;
  cachedSqsClient = undefined;
}

function ddbClient(): DynamoDBClient {
  if (!cachedDdbClient) {
    cachedDdbClient = new DynamoDBClient({});
  }
  return cachedDdbClient;
}

function sqsClient(): SQSClient {
  if (!cachedSqsClient) {
    cachedSqsClient = new SQSClient({});
  }
  return cachedSqsClient;
}

function isOrphanRow(row: RunnerRow): boolean {
  return row.runnerName.startsWith(ORPHAN_ROW_PREFIX);
}

function isClaimRow(row: RunnerRow): boolean {
  return row.runnerName.startsWith(CLAIM_ROW_PREFIX);
}

/** See {@link WARM_CLAIM_PREFIX}: a warm-pool claim marker, not a runner mapping. */
function isWarmClaimRow(row: RunnerRow): boolean {
  return row.runnerName.startsWith(WARM_CLAIM_PREFIX);
}

/**
 * Slack allowed when deciding whether a timestamp was written on an EARLIER
 * sweep.
 *
 * These comparisons are really asking "is this from a previous sweep?", and
 * the answer was derived from wall-clock elapsed time against the exact
 * interval. That is knife-edge: EventBridge does not fire a 5-minute rule at
 * exactly 300000 ms. Measured on the bench account over two windows — 17 of 26
 * gaps short by 60 to 110 ms, then 18 of 35 short by up to 480 ms — so a
 * strike written on one sweep failed the check on the next about half the
 * time and waited another whole interval, silently adding 300 s to every idle
 * reap.
 *
 * One second clears the worst drift seen so far by roughly 2x, and sits
 * orders of magnitude below any sane sweep interval, so it absorbs the jitter
 * without making a timestamp from the CURRENT sweep look like a previous one
 * — which would collapse the two-strike rule into one and reap on a single
 * bad reading. If a future measurement finds drift approaching a second,
 * raise this rather than widening it to a fraction of the interval: the
 * headroom that matters is against the drift, not against the interval.
 */
const SWEEP_JITTER_SLACK_MS = 1000;

function isOlderThanInterval(
  iso: string,
  nowMs: number,
  intervalSeconds: number,
): boolean {
  return (
    nowMs - Date.parse(iso) >= intervalSeconds * 1000 - SWEEP_JITTER_SLACK_MS
  );
}

function vmAgeSeconds(vm: RunnerSetVm, nowMs: number): number {
  return (nowMs - vm.startedAt.getTime()) / 1000;
}

async function scanRunnerTable(
  tableName: string,
  consistentRead = false,
): Promise<RunnerRow[]> {
  const rows: RunnerRow[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await ddbClient().send(
      new ScanCommand({
        TableName: tableName,
        // Omit-when-unset, never explicit `undefined` — the idlePolicy lesson
        // (see microvm-client.ts): an optional-keyed member's undefined IS
        // dropped by this SDK's marshaller today, but the convention is to
        // never rely on that per-member codegen detail.
        ...(exclusiveStartKey !== undefined
          ? { ExclusiveStartKey: exclusiveStartKey }
          : {}),
        ...(consistentRead ? { ConsistentRead: true } : {}),
      }),
    );
    for (const item of res.Items ?? []) {
      rows.push(unmarshall(item) as RunnerRow);
    }
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

async function deleteRow(tableName: string, runnerName: string): Promise<void> {
  await ddbClient().send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: marshall({ runnerName }),
    }),
  );
}

/**
 * Update an EXISTING row, never create one. DynamoDB's `UpdateItem` is an
 * upsert regardless of the update expression — an unconditional
 * `SET suspectSince` racing DynamoDB's own TTL delete RESURRECTS the row as
 * a `{runnerName, suspectSince}`-only zombie: no `microvmId` (poisoning
 * `buildVmMap`'s `getMicrovm(row.microvmId)`), no `expiresAt` (so it never
 * ages out). Live-hit on the bench runner set 2026-07-22: one such zombie
 * aborted EVERY sweep for ~12h. `attribute_exists` makes TTL-raced updates
 * a silent no-op — if the row is gone, there is nothing left to mark.
 */
async function updateExistingRow(
  tableName: string,
  runnerName: string,
  update: {
    UpdateExpression: string;
    ExpressionAttributeValues?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await ddbClient().send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ runnerName }),
        UpdateExpression: update.UpdateExpression,
        ...(update.ExpressionAttributeValues
          ? {
              ExpressionAttributeValues: marshall(
                update.ExpressionAttributeValues,
              ),
            }
          : {}),
        ConditionExpression: 'attribute_exists(runnerName)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return; // row TTL'd/deleted mid-sweep — nothing to update, by design
    }
    throw err;
  }
}

async function setSuspect(
  tableName: string,
  runnerName: string,
  nowIso: string,
): Promise<void> {
  await updateExistingRow(tableName, runnerName, {
    UpdateExpression: 'SET suspectSince = :s',
    ExpressionAttributeValues: { ':s': nowIso },
  });
}

async function clearSuspect(
  tableName: string,
  runnerName: string,
): Promise<void> {
  await updateExistingRow(tableName, runnerName, {
    UpdateExpression: 'REMOVE suspectSince',
  });
}

async function cacheRunnerId(
  tableName: string,
  runnerName: string,
  runnerId: number,
): Promise<void> {
  await updateExistingRow(tableName, runnerName, {
    UpdateExpression: 'SET runnerId = :id',
    ExpressionAttributeValues: { ':id': runnerId },
  });
}

async function putOrphanRow(
  tableName: string,
  microvmId: string,
  nowIso: string,
): Promise<void> {
  await ddbClient().send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall({
        runnerName: `${ORPHAN_ROW_PREFIX}${microvmId}`,
        microvmId,
        orphanSince: nowIso,
      }),
    }),
  );
}

function targetKey(target: ScopeTarget): string {
  return 'org' in target
    ? `org:${target.org}`
    : `repo:${target.owner}/${target.repo}`;
}

/** Filter a raw `listRunners` result down to this runner set's runners, indexed by name. */
function indexRunnerSetRunners(
  runnerSetId: string,
  runners: GithubRunner[],
): Map<string, GithubRunner> {
  const prefix = `${RUNNER_NAME_PREFIX}-${runnerSetId}-`;
  const byName = new Map<string, GithubRunner>();
  for (const r of runners) {
    if (r.name.startsWith(prefix)) {
      byName.set(r.name, r);
    }
  }
  return byName;
}

/** Per-invocation cached `listRunners` for `target` (one call per target per sweep, not per row). */
async function loadRunnersForTarget(
  ctx: JanitorContext,
  target: ScopeTarget,
): Promise<Map<string, GithubRunner>> {
  const key = targetKey(target);
  const cached = ctx.runnersByTarget.get(key);
  if (cached) {
    return cached;
  }
  const byName = indexRunnerSetRunners(
    ctx.runnerSetId,
    await listRunners(target),
  );
  ctx.runnersByTarget.set(key, byName);
  return byName;
}

/**
 * A same-invocation FRESH read for `row`: `getRunner` by cached id when
 * known (single-runner GET, cannot itself be a stale list), else a fresh
 * `listRunners` re-list (NOT the per-invocation cache above — a stale list
 * is exactly the failure mode this function exists to avoid) with a name
 * match. Refreshes the per-invocation cache for `target` as a side effect.
 *
 * A cached id that 404s (`getRunner` returns `undefined`) does NOT by
 * itself mean the runner is gone — GitHub can rotate/reassign runner ids
 * (e.g. a re-registration under the same name), so a stale cached id would
 * otherwise falsely report "absent" and walk the caller straight into a
 * kill decision. Fall back to the same fresh name-based re-list used when
 * no id is cached, and only declare the runner truly absent if that also
 * comes up empty.
 */
async function freshGetRunner(
  ctx: JanitorContext,
  target: ScopeTarget,
  row: RunnerRow,
): Promise<GithubRunner | undefined> {
  if (row.runnerId !== undefined) {
    const byId = await getRunner(target, row.runnerId);
    if (byId) {
      return byId;
    }
  }
  const byName = indexRunnerSetRunners(
    ctx.runnerSetId,
    await listRunners(target),
  );
  ctx.runnersByTarget.set(targetKey(target), byName);
  return byName.get(row.runnerName);
}

/**
 * Rule 4 — lifetime backstop: applies to every RUNNING VM regardless of
 * runner/row state. The platform's own `maximumDurationInSeconds` cap (job
 * duration + 300s grace, set at launch) "should" have already fired by this
 * threshold; this is backstop-of-backstop. No runner to check — exception
 * to the fresh-getRunner-before-kill rule. Returns `true` if it killed the
 * VM (caller stops there).
 */
async function tryLifetimeKill(
  ctx: JanitorContext,
  vm: RunnerSetVm,
  row: RunnerRow | undefined,
  age: number,
): Promise<boolean> {
  if (age <= ctx.lifetimeCapSeconds) {
    return false;
  }
  await terminateMicrovm(vm.microvmId);
  console.log(
    JSON.stringify({
      msg: 'janitor: lifetimeKill',
      microvmId: vm.microvmId,
      runnerName: row?.runnerName,
      vmAgeSeconds: age,
      lifetimeCapSeconds: ctx.lifetimeCapSeconds,
    }),
  );
  ctx.metrics.lifetimeKills += 1;
  if (row) {
    await deleteRow(ctx.tableName, row.runnerName);
  }
  return true;
}

/**
 * Rule 6 — a RUNNING runner set VM with no launcher-created row: first
 * observation synthesizes orphan strike memory (`row === undefined`);
 * second+ observation (`row` is the janitor's own orphan row) kills once
 * `orphanSince` is older than one interval. No runner exists to check for
 * either case — exception to the fresh-getRunner-before-kill rule, same as
 * rule 4.
 *
 * Race guard: `hasCompetingLegitRow` is `true` when THIS sweep's table scan
 * also turned up a launcher-created row for the same `microvmId` — the
 * launcher's `PutItem` landed late, after the orphan row was already
 * synthesized by an earlier sweep. Once a real row exists, the orphan row's
 * strike memory is stale and MUST NOT be used to kill: the orphan row is
 * deleted as hygiene and the VM's fate is left entirely to that legit row's
 * own `reconcileNormalRow` pass (which runs its own fresh-getRunner check
 * before ever acting).
 *
 * Pre-kill freshness: `hasCompetingLegitRow` only reflects THIS sweep's
 * table-scan snapshot, taken at the *start* of the sweep — a launcher
 * `PutItem` that lands after that scan but before the actual kill decision
 * below would otherwise be invisible to it. To close that window, the
 * instant before terminating (i.e. only once the two-strike interval has
 * actually elapsed) this function takes a SECOND, strongly-consistent
 * (`ConsistentRead: true` — the table is tiny, a full scan is cheap) read of
 * the whole table, right here, and re-checks for a non-orphan/non-claim row
 * referencing this `microvmId`. If one has appeared, the kill is aborted:
 * the orphan row is deleted as hygiene and the VM's fate is left to that
 * legit row's own `reconcileNormalRow` pass, exactly like the
 * scan-snapshot-race case above.
 */
async function reconcileOrphanVm(
  ctx: JanitorContext,
  vm: RunnerSetVm,
  row: RunnerRow | undefined,
  hasCompetingLegitRow: boolean,
): Promise<void> {
  if (!row) {
    await putOrphanRow(ctx.tableName, vm.microvmId, ctx.nowIso);
    return;
  }
  if (hasCompetingLegitRow) {
    await deleteRow(ctx.tableName, row.runnerName);
    ctx.metrics.tableRowsCleaned += 1;
    return;
  }
  if (
    row.orphanSince &&
    isOlderThanInterval(row.orphanSince, ctx.nowMs, ctx.intervalSeconds)
  ) {
    // FRESH pre-kill read, taken in THIS invocation immediately before
    // acting (see doc comment above) — never rely on the sweep-start scan
    // snapshot for a kill decision.
    const freshRows = await scanRunnerTable(ctx.tableName, true);
    const legitRowAppeared = freshRows.some(
      (r) => !isOrphanRow(r) && !isClaimRow(r) && r.microvmId === vm.microvmId,
    );
    if (legitRowAppeared) {
      await deleteRow(ctx.tableName, row.runnerName);
      ctx.metrics.tableRowsCleaned += 1;
      console.log(
        JSON.stringify({
          msg: 'janitor: orphan kill aborted: legit mapping appeared',
          microvmId: vm.microvmId,
          runnerName: row.runnerName,
        }),
      );
      return;
    }
    await terminateMicrovm(vm.microvmId);
    await deleteRow(ctx.tableName, row.runnerName);
    ctx.metrics.orphansReaped += 1;
  }
}

/** Rule 3: busy on the (cached) list -> clear strike memory, never touch. */
async function handleBusyListed(
  ctx: JanitorContext,
  row: RunnerRow,
  listed: GithubRunner,
): Promise<void> {
  if (row.suspectSince) {
    await clearSuspect(ctx.tableName, row.runnerName);
    ctx.metrics.suspectsCleared += 1;
  }
  if (row.runnerId !== listed.id) {
    await cacheRunnerId(ctx.tableName, row.runnerName, listed.id);
  }
}

/**
 * Rule 1 (+ the rule-3 "#4391 case"): absent from the cached list -> a
 * fresh per-runner check before acting (NEVER act on list output alone).
 * Present on the fresh read -> stale-list race, clear and never touch.
 * Still absent -> two-strike: first observation sets `suspectSince`,
 * second (older than one interval) deregisters + terminates + deletes the
 * row.
 */
async function handleAbsentFromList(
  ctx: JanitorContext,
  vm: RunnerSetVm,
  target: ScopeTarget,
  row: RunnerRow,
): Promise<void> {
  const fresh = await freshGetRunner(ctx, target, row);
  if (fresh) {
    if (row.suspectSince) {
      await clearSuspect(ctx.tableName, row.runnerName);
      ctx.metrics.suspectsCleared += 1;
    }
    if (row.runnerId !== fresh.id) {
      await cacheRunnerId(ctx.tableName, row.runnerName, fresh.id);
    }
    return;
  }
  if (!row.suspectSince) {
    await setSuspect(ctx.tableName, row.runnerName, ctx.nowIso);
    return;
  }
  if (!isOlderThanInterval(row.suspectSince, ctx.nowMs, ctx.intervalSeconds)) {
    return;
  }
  if (row.runnerId !== undefined) {
    await deleteRunner(target, row.runnerId);
  }
  await terminateMicrovm(vm.microvmId);
  await deleteRow(ctx.tableName, row.runnerName);
  ctx.metrics.orphansReaped += 1;
}

/**
 * Rule 2: a registered, non-busy runner whose VM is past `GRACE_SECONDS` ->
 * two-strike reap. Covers BOTH failure shapes of a stuck runner:
 *   - `online` + idle: registered, never picked up a job (cancelled-queued,
 *     or the launcher armed a runner GitHub never assigned).
 *   - `offline`: the runner PROCESS died but the VM is still RUNNING (crash
 *     after register — found live 2026-07-19; a JIT runner that completed
 *     cleanly deregisters itself and is handled by rule 1's absent path,
 *     so a lingering `offline`+running VM is a zombie holding a quota slot).
 * First observation sets `suspectSince`; the second (older than one
 * interval) takes a fresh per-runner read immediately before killing — busy
 * or vanished on that fresh read IS the rule-3 stale-list race (a runner
 * that reconnected and grabbed a job), clear and never touch. Anything else
 * (still online-idle, still offline) -> deregister + terminate. The shared
 * grace + two-strike + fresh-read guards keep a briefly-offline runner
 * (transient long-poll reconnect) from being reaped.
 */
async function handleListedIdle(
  ctx: JanitorContext,
  vm: RunnerSetVm,
  target: ScopeTarget,
  row: RunnerRow,
  listed: GithubRunner,
  age: number,
): Promise<void> {
  const reapable =
    (listed.status === 'online' || listed.status === 'offline') &&
    age > ctx.graceSeconds;
  if (!reapable) {
    if (row.suspectSince) {
      await clearSuspect(ctx.tableName, row.runnerName);
      ctx.metrics.suspectsCleared += 1;
    }
    if (row.runnerId !== listed.id) {
      await cacheRunnerId(ctx.tableName, row.runnerName, listed.id);
    }
    return;
  }

  if (!row.suspectSince) {
    if (row.runnerId !== listed.id) {
      await cacheRunnerId(ctx.tableName, row.runnerName, listed.id);
    }
    await setSuspect(ctx.tableName, row.runnerName, ctx.nowIso);
    return;
  }
  if (!isOlderThanInterval(row.suspectSince, ctx.nowMs, ctx.intervalSeconds)) {
    return;
  }

  const fresh = await freshGetRunner(ctx, target, row);
  if (!fresh || fresh.busy) {
    await clearSuspect(ctx.tableName, row.runnerName);
    ctx.metrics.suspectsCleared += 1;
    return;
  }
  await deleteRunner(target, fresh.id);
  await terminateMicrovm(vm.microvmId);
  await deleteRow(ctx.tableName, row.runnerName);
  ctx.metrics.stuckRunnersReaped += 1;
}

/** Normal (launcher-created) row: dispatches rules 1-3, GitHub reconciliation. */
async function reconcileNormalRow(
  ctx: JanitorContext,
  vm: RunnerSetVm,
  row: RunnerRow,
  age: number,
): Promise<void> {
  const target = resolveTarget(ctx.scope, row.repo);
  const listedRunners = await loadRunnersForTarget(ctx, target);
  const listed = listedRunners.get(row.runnerName);

  if (listed?.busy) {
    await handleBusyListed(ctx, row, listed);
    return;
  }
  if (!listed) {
    await handleAbsentFromList(ctx, vm, target, row);
    return;
  }
  await handleListedIdle(ctx, vm, target, row, listed, age);
}

/**
 * Decide and act on one RUNNING runner set VM. `row` is the matching
 * `RUNNER_TABLE` row (launcher-created, janitor-orphan-created, or
 * `undefined` for a VM with no row at all yet).
 */
async function reconcileRunningVm(
  ctx: JanitorContext,
  vm: RunnerSetVm,
  row: RunnerRow | undefined,
  hasCompetingLegitRow = false,
): Promise<void> {
  const age = vmAgeSeconds(vm, ctx.nowMs);

  if (await tryLifetimeKill(ctx, vm, row, age)) {
    return;
  }
  if (!row || isOrphanRow(row)) {
    await reconcileOrphanVm(ctx, vm, row, hasCompetingLegitRow);
    return;
  }
  await reconcileNormalRow(ctx, vm, row, age);
}

/**
 * Union the image-ARN-scoped VM list with every table row's `microvmId`
 * not already covered by it (fetched individually via `getMicrovm`) — see
 * module doc's "image-rotation gap" note. A `Map` value of `undefined`
 * means the VM is confirmed gone (`ResourceNotFoundException`).
 */
async function buildVmMap(
  imageVms: RunnerSetVm[],
  rows: RunnerRow[],
  metrics: Metrics,
): Promise<Map<string, RunnerSetVm | undefined>> {
  const vmsById = new Map<string, RunnerSetVm | undefined>();
  for (const vm of imageVms) {
    vmsById.set(vm.microvmId, vm);
  }
  for (const row of rows) {
    if (vmsById.has(row.microvmId)) {
      continue;
    }
    // Per-VM isolation: `getMicrovm` swallows NotFound (→ undefined) but
    // rethrows a throttle/5xx that outlasted its bounded retry. One such
    // throw must NOT blank the whole map and abort the sweep — treat an
    // unresolved id as "leave alone this sweep" (omit from the map, so no
    // rule fires against it) and count it as a sweep error. Next sweep
    // retries it. This is the transient-throw analogue of the zombie guard.
    try {
      vmsById.set(row.microvmId, await getMicrovm(row.microvmId));
    } catch (err) {
      metrics.errors += 1;
      console.error(
        JSON.stringify({
          scope: 'reconcile',
          action: 'getMicrovm-failed',
          runnerName: row.runnerName,
          microvmId: row.microvmId,
          err: serializeError(err),
        }),
      );
    }
  }
  return vmsById;
}

/**
 * Rule 5: a table row whose VM is confirmed gone (`GetMicrovm` NotFound, or
 * found but `TERMINATED`) is eligible for row-hygiene deletion once its own
 * TTL (`expiresAt`) has passed. Orphan rows (no `expiresAt` of their own)
 * are eligible as soon as the VM is confirmed gone — there's no TTL to wait
 * out and no risk: the row's only purpose was tracking that specific VM
 * instance.
 */
function eligibleForHygieneDelete(row: RunnerRow, nowSeconds: number): boolean {
  if (row.expiresAt !== undefined) {
    return row.expiresAt <= nowSeconds;
  }
  return true;
}

/** A committed claim's launch attempt succeeded (real `microvmId`); a pending one has not. */
function isCommittedClaim(row: RunnerRow): boolean {
  return row.microvmId !== undefined && row.microvmId !== 'pending';
}

/**
 * Reconcile one COMMITTED claim row (`recoverStuckLaunches`): if its VM is gone
 * or TERMINATED but the GitHub job is still `queued`, the launch committed yet
 * never served the job (the runner was reaped before assignment) — delete the
 * stale claim and re-drive a fresh launch. A RUNNING/SUSPENDED VM, or a job no
 * longer `queued`, is left alone.
 *
 * Ordering: delete-BEFORE-send is required here (unlike `recoverOneStuckLaunch`,
 * which does the reverse for DLQ'd launches): the committed claim is present,
 * so `acquireLaunchClaim` would self-suppress the re-launch as a duplicate if
 * the claim still existed when the new launcher runs. That inverts the risk to
 * "delete ok, send fails → claim gone AND no launch enqueued → permanent
 * strand". So we COMPENSATE: on a send failure, restore the claim row (it was
 * scanned whole) so the next sweep re-attempts. Only a send-AND-restore double
 * failure strands, and that is logged.
 */
async function reconcileCommittedClaim(
  ctx: JanitorContext,
  claimRow: RunnerRow,
  jobQueueUrl: string,
): Promise<void> {
  const vm = await getMicrovm(claimRow.microvmId);
  if (vm && vm.state !== 'TERMINATED') {
    return; // RUNNING/SUSPENDED/other — not dead, leave it
  }
  if (!claimRow.repo || typeof claimRow.jobId !== 'number') {
    return; // malformed claim — leave for hygiene
  }
  const [owner, name] = claimRow.repo.split('/');
  if (!owner || !name) {
    return;
  }
  const job = await getWorkflowJob(
    resolveTarget(ctx.scope, claimRow.repo),
    owner,
    name,
    claimRow.jobId,
  );
  if (job?.status !== 'queued') {
    return; // job done/cancelled/gone — leave for hygiene delete on expiry
  }
  await deleteRow(ctx.tableName, claimRow.runnerName);
  try {
    await sqsClient().send(
      new SendMessageCommand({
        QueueUrl: jobQueueUrl,
        MessageBody: JSON.stringify({
          kind: 'launch',
          repo: claimRow.repo,
          jobId: claimRow.jobId,
          runId: job.runId,
          labels: job.labels,
        }),
      }),
    );
  } catch (sendErr) {
    // Send failed AFTER the claim was deleted — restore the claim (scanned
    // whole, so `marshall` round-trips every attribute incl. attemptToken)
    // so the next sweep re-attempts instead of the job being permanently
    // stranded. Best-effort; rethrow either way so the caller counts it.
    try {
      await ddbClient().send(
        new PutItemCommand({
          TableName: ctx.tableName,
          Item: marshall(claimRow, { removeUndefinedValues: true }),
        }),
      );
    } catch (restoreErr) {
      console.error(
        JSON.stringify({
          scope: 'reconcile',
          action: 'committed-claim-restore-failed',
          runnerName: claimRow.runnerName,
          err: serializeError(restoreErr),
        }),
      );
    }
    throw sendErr;
  }
  ctx.metrics.stuckClaimsRelaunched += 1;
  console.log(
    JSON.stringify({
      scope: 'reconcile',
      action: 'relaunched-committed',
      repo: claimRow.repo,
      jobId: claimRow.jobId,
    }),
  );
}

async function reconcileTable(ctx: JanitorContext): Promise<void> {
  const imageVms = await listRunnerSetVms(runnerSetImageArns());
  const scannedRows = await scanRunnerTable(ctx.tableName);
  // Claim rows (`job#<repo>#<jobId>`) are launcher-side launch-idempotency
  // markers, not runner mappings or orphan-VM strike memory — excluded from
  // every OTHER reconciliation path below (rules 1-6 operate on `rows` only).
  // Claim rows are touched by two lifecycle events here: (a) rule-5-style
  // hygiene, deleting a claim once its own `expiresAt` (same TTL horizon as a
  // mapping row) has passed, and (b) the opt-in `recoverStuckLaunches`
  // committed-claim reconciliation below, capped per sweep at
  // {@link COMMITTED_CLAIM_RECONCILE_CAP}.
  const claimRows = scannedRows.filter(isClaimRow);
  // Warm-pool claim rows (`warmvm#<microvmId>`, see `WARM_CLAIM_PREFIX`) are
  // ALSO claim markers, not runner mappings — and unlike `job#` rows they
  // have no `microvmId` attribute at all, so they must never reach `rows`
  // (which `buildVmMap` dereferences via `getMicrovm(row.microvmId)`). They
  // are not added to `claimRows` either: they need none of the job-claim
  // lifecycle handling above (no hygiene delete, no stuck-launch recovery —
  // there is no GitHub job or launch behind a warm claim), just exclusion.
  // They age out via their own `expiresAt` TTL.
  const candidateRows = scannedRows.filter(
    (r) => !isClaimRow(r) && !isWarmClaimRow(r),
  );
  // Zombie guard (live-hit, bench 2026-07-22): a row with no `microvmId`
  // can exist when an unconditional UpdateItem raced DynamoDB's TTL delete
  // and resurrected the key with a single attribute (see
  // `updateExistingRow`, which closes the creation path). Such a row is
  // unrecognizable debris — every janitor duty needs the id — and with no
  // `expiresAt` it would poison `buildVmMap` (`getMicrovm(undefined)`
  // aborts the sweep) FOREVER. Skip it from reconciliation and delete it
  // (self-heal), per-item isolated like every other row action.
  const rows: RunnerRow[] = [];
  for (const row of candidateRows) {
    if (row.microvmId) {
      rows.push(row);
      continue;
    }
    console.log(
      JSON.stringify({
        scope: 'reconcile',
        msg: 'malformed row without microvmId — deleting (TTL-resurrection zombie)',
        runnerName: row.runnerName,
      }),
    );
    try {
      await deleteRow(ctx.tableName, row.runnerName);
      ctx.metrics.tableRowsCleaned += 1;
    } catch (err) {
      ctx.metrics.errors += 1;
      console.log(
        JSON.stringify({
          scope: 'reconcile',
          runnerName: row.runnerName,
          err: serializeError(err),
        }),
      );
    }
  }

  const recoverStuckLaunchesEnabled =
    process.env.RECOVER_STUCK_LAUNCHES === 'true';
  const jobQueueUrl = recoverStuckLaunchesEnabled
    ? requireEnv('JOB_QUEUE_URL')
    : undefined;
  const nowSeconds = Math.floor(ctx.nowMs / 1000);
  let committedClaimsReconciled = 0;
  for (const claimRow of claimRows) {
    if (claimRow.expiresAt !== undefined && claimRow.expiresAt <= nowSeconds) {
      try {
        await deleteRow(ctx.tableName, claimRow.runnerName);
        ctx.metrics.tableRowsCleaned += 1;
      } catch (err) {
        ctx.metrics.errors += 1;
        console.log(
          JSON.stringify({
            scope: 'reconcile',
            runnerName: claimRow.runnerName,
            err: serializeError(err),
          }),
        );
      }
      continue;
    }
    // Committed-but-unserved recovery (opt-in). Only committed claims are
    // candidates; per-item isolated so one failure can't abort the sweep.
    // Capped at COMMITTED_CLAIM_RECONCILE_CAP per sweep (see its doc comment)
    // — hygiene deletes above are never capped, only this GitHub-probing path.
    if (
      recoverStuckLaunchesEnabled &&
      jobQueueUrl &&
      isCommittedClaim(claimRow) &&
      committedClaimsReconciled < COMMITTED_CLAIM_RECONCILE_CAP
    ) {
      committedClaimsReconciled += 1;
      try {
        await reconcileCommittedClaim(ctx, claimRow, jobQueueUrl);
      } catch (err) {
        ctx.metrics.errors += 1;
        console.error(
          JSON.stringify({
            scope: 'reconcile',
            action: 'error',
            runnerName: claimRow.runnerName,
            err: serializeError(err),
          }),
        );
      }
    }
  }

  const vmsById = await buildVmMap(imageVms, rows, ctx.metrics);
  // Every microvmId referenced by a non-orphan (launcher-created) row in
  // THIS sweep's scan — used to detect the rule-6 orphan/legit-row race
  // (see `reconcileOrphanVm`'s doc comment).
  const legitMicrovmIds = new Set(
    rows.filter((r) => !isOrphanRow(r)).map((r) => r.microvmId),
  );

  const rowsWithRunningVm: { row: RunnerRow; vm: RunnerSetVm }[] = [];
  for (const row of rows) {
    // Unresolved this sweep (getMicrovm threw a transient error in
    // buildVmMap): the id is ABSENT from the map, distinct from a
    // present-`undefined` "confirmed gone". Leave the row entirely alone —
    // acting on unknown state is exactly the wrong-kill / wrong-delete risk
    // this janitor exists to avoid. Next sweep re-resolves it.
    if (!vmsById.has(row.microvmId)) {
      continue;
    }
    const vm = vmsById.get(row.microvmId);
    if (vm && vm.state === 'RUNNING') {
      rowsWithRunningVm.push({ row, vm });
      continue;
    }
    // VM missing or in a non-RUNNING terminal-ish state: rule 5 hygiene.
    // (Non-RUNNING-but-not-gone states, e.g. SUSPENDED, get no action —
    // out of scope for this sweep, left for the next one.)
    if (
      (!vm || vm.state === 'TERMINATED') &&
      eligibleForHygieneDelete(row, Math.floor(ctx.nowMs / 1000))
    ) {
      try {
        await deleteRow(ctx.tableName, row.runnerName);
        ctx.metrics.tableRowsCleaned += 1;
      } catch (err) {
        ctx.metrics.errors += 1;
        console.log(
          JSON.stringify({
            scope: 'reconcile',
            runnerName: row.runnerName,
            err: serializeError(err),
          }),
        );
      }
    }
  }

  // Per-item isolation: one row/VM's reconciliation throwing (a transient
  // GitHub/DynamoDB/MicroVM API error, a malformed row) must never abort
  // the sweep for every other row — each row gets its own try/catch, and
  // `emitMetrics` (in `handler`) always runs after this function returns,
  // whether or not any item failed.
  for (const { row, vm } of rowsWithRunningVm) {
    const hasCompetingLegitRow =
      isOrphanRow(row) && legitMicrovmIds.has(row.microvmId);
    try {
      await reconcileRunningVm(ctx, vm, row, hasCompetingLegitRow);
    } catch (err) {
      ctx.metrics.errors += 1;
      console.log(
        JSON.stringify({
          scope: 'reconcile',
          runnerName: row.runnerName,
          err: serializeError(err),
        }),
      );
    }
  }

  // Rule 6, first observation: RUNNING runner set VMs with no row at all.
  const rowMicrovmIds = new Set(rows.map((r) => r.microvmId));
  for (const vm of imageVms) {
    if (vm.state === 'RUNNING' && !rowMicrovmIds.has(vm.microvmId)) {
      try {
        await reconcileRunningVm(ctx, vm, undefined);
      } catch (err) {
        ctx.metrics.errors += 1;
        console.log(
          JSON.stringify({
            scope: 'reconcile',
            microvmId: vm.microvmId,
            err: serializeError(err),
          }),
        );
      }
    }
  }
}

/**
 * Prune MicroVM image versions beyond `KEEP_IMAGE_VERSIONS` (default 5):
 * the newest N versions (by `createdAt`) are always kept regardless of
 * status; only `INACTIVE` versions older than that are deleted. `ACTIVE`
 * versions are never deleted even beyond the newest N (an operator may
 * have manually re-activated an older version; deleting a version
 * `RunMicrovm` can still launch from is not this sweep's call to make).
 */
async function pruneImageVersions(
  ctx: JanitorContext,
  keepVersions: number,
): Promise<void> {
  for (const imageArn of runnerSetImageArns()) {
    const versions = await listImageVersions(imageArn);
    const sorted = [...versions].sort((a, b) => {
      const at = a.createdAt ? a.createdAt.getTime() : 0;
      const bt = b.createdAt ? b.createdAt.getTime() : 0;
      return bt - at;
    });
    for (const v of sorted.slice(keepVersions)) {
      if (v.status === 'INACTIVE' && v.imageVersion) {
        try {
          await deleteImageVersion(imageArn, v.imageVersion);
          ctx.metrics.imageVersionsPruned += 1;
        } catch (err) {
          ctx.metrics.errors += 1;
          console.log(
            JSON.stringify({
              scope: 'prune',
              version: v.imageVersion,
              err: serializeError(err),
            }),
          );
        }
      }
    }
  }
}

/** Max dead-letter messages a single sweep pulls for stuck-launch recovery — bounds per-sweep work; a larger DLQ drains across sweeps. */
const DLQ_RECOVERY_BATCH_CAP = 50;

/** Max committed claims the reconciler probes GitHub for per sweep. Each probe is a `getWorkflowJob` REST call on the shared per-installation rate-limit bucket that the janitor's own safety-critical reap reads (`listRunners`/`getRunner`) also draw from — an uncapped scan would, on a busy runner set, exhaust the bucket and stall reaping. A larger backlog drains across sweeps, like the DLQ sweep's cap. */
const COMMITTED_CLAIM_RECONCILE_CAP = 25;

/** Shape we parse a dead-lettered message down to — only launches are recovered. */
interface DlqLaunch {
  kind?: string;
  repo?: string;
  jobId?: number;
}

/**
 * Recover one dead-lettered message. Only LAUNCH messages are acted on: if
 * GitHub still reports the job as `queued`, re-drive it onto the job queue;
 * if the job has completed, been cancelled, or is gone (404), discard it.
 * Non-launch or malformed messages are left in place (reconciliation covers
 * terminate intent; the DLQ's own retention ages the rest out).
 *
 * Re-drive is send-then-delete on purpose: a duplicate launch is deduped by the
 * launcher's job-claim idempotency, whereas deleting before a successful send
 * could strand the job. At-least-once beats at-most-once here.
 */
async function recoverOneStuckLaunch(
  ctx: JanitorContext,
  msg: { Body?: string; ReceiptHandle?: string; MessageId?: string },
  dlqUrl: string,
  jobQueueUrl: string,
): Promise<void> {
  const receiptHandle = msg.ReceiptHandle;
  const body = msg.Body ?? '';
  if (!receiptHandle) {
    return; // can't delete or re-drive without a handle; leave it
  }
  let parsed: DlqLaunch;
  try {
    parsed = JSON.parse(body) as DlqLaunch;
  } catch {
    // A body we can't parse is not an operational failure worth alarming on —
    // leave it for the DLQ's own retention to age out, rather than throwing to
    // the per-message error path and polluting the `errors` metric every sweep.
    return;
  }
  const [owner, name] = (parsed.repo ?? '').split('/');
  if (
    parsed.kind !== 'launch' ||
    typeof parsed.jobId !== 'number' ||
    !owner ||
    !name
  ) {
    return; // not a launch, or malformed — leave it for retention to age out
  }

  const job = await getWorkflowJob(
    resolveTarget(ctx.scope, parsed.repo!),
    owner,
    name,
    parsed.jobId,
  );

  if (job?.status === 'queued') {
    await sqsClient().send(
      new SendMessageCommand({ QueueUrl: jobQueueUrl, MessageBody: body }),
    );
    // Count the re-drive as soon as the launch is back on the queue (the
    // meaningful action). If the subsequent delete fails, the message re-drives
    // again next sweep — a duplicate the launcher's claim dedupes — so counting
    // here (not after the delete) attributes the recovery to the sweep that did it.
    ctx.metrics.stuckLaunchesRecovered += 1;
    await sqsClient().send(
      new DeleteMessageCommand({
        QueueUrl: dlqUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
    console.log(
      JSON.stringify({
        scope: 'recover',
        action: 're-drove',
        repo: parsed.repo,
        jobId: parsed.jobId,
      }),
    );
    return;
  }

  // Any status other than `queued` (in_progress / completed / cancelled /
  // waiting / …) or a 404 (`job` undefined) means no runnerless job is waiting,
  // so booting a runner would be wasteful — discard the launch.
  await sqsClient().send(
    new DeleteMessageCommand({
      QueueUrl: dlqUrl,
      ReceiptHandle: receiptHandle,
    }),
  );
  console.log(
    JSON.stringify({
      scope: 'recover',
      action: 'discarded',
      repo: parsed.repo,
      jobId: parsed.jobId,
      status: job?.status ?? 'gone',
    }),
  );
}

/**
 * Sweep the dead-letter queue for launches stranded by a control-plane
 * (GitHub Actions) outage and recover the still-`queued` ones — see
 * `recoverOneStuckLaunch`. Opt-in (`RECOVER_STUCK_LAUNCHES`); bounded to
 * {@link DLQ_RECOVERY_BATCH_CAP} messages per sweep. A per-message failure
 * (bad body, transient GitHub read error) is isolated: the message is left in
 * the DLQ for a later sweep and the sweep continues.
 *
 * Note: a launch that fails for a NON-outage reason (e.g. a persistent
 * RunMicrovm error) while its GitHub job stays `queued` will be re-driven every
 * sweep until the job leaves `queued` — bounded per sweep, but a standing
 * `stuckLaunchesRecovered > 0` across many sweeps is the signal to alarm and
 * investigate, not a healthy steady state.
 */
async function recoverStuckLaunches(ctx: JanitorContext): Promise<void> {
  const dlqUrl = requireEnv('DEAD_LETTER_QUEUE_URL');
  const jobQueueUrl = requireEnv('JOB_QUEUE_URL');
  let pulled = 0;
  while (pulled < DLQ_RECOVERY_BATCH_CAP) {
    const received = await sqsClient().send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 10,
        // Long-poll: short polling (WaitTimeSeconds=0) samples a subset of SQS
        // hosts and can return zero — or fewer than requested — even when the
        // DLQ is backlogged, which would end the sweep early and slow recovery.
        // Long polling returns as soon as any message is available and only
        // waits the full window when the queue is genuinely empty.
        WaitTimeSeconds: 20,
        VisibilityTimeout: Math.max(ctx.intervalSeconds, 60),
      }),
    );
    const messages = received.Messages ?? [];
    // Only an empty return means "drained" — a partial batch does NOT (SQS never
    // guarantees a full batch). Keep pulling until empty or the per-sweep cap.
    if (messages.length === 0) {
      break;
    }
    pulled += messages.length;
    for (const msg of messages) {
      try {
        await recoverOneStuckLaunch(ctx, msg, dlqUrl, jobQueueUrl);
      } catch (err) {
        ctx.metrics.errors += 1;
        console.error(
          JSON.stringify({
            scope: 'recover',
            action: 'error',
            messageId: msg.MessageId,
            err: serializeError(err),
          }),
        );
      }
    }
  }
}

/** EMF structured-log metric emission: one `console.log` JSON envelope per sweep, namespace `MicrovmRunners`, dimensioned by `RunnerSetId`. Opt-in — `emitEmf` writes nothing unless the runner set set `GithubMicrovmRunnersProps.emitMetrics` (see `shared/emf.ts`'s gate). */
function emitMetrics(ctx: JanitorContext): void {
  emitEmf({
    namespace: EMF_NAMESPACE,
    dimensions: ['RunnerSetId'],
    dimensionValues: { RunnerSetId: ctx.runnerSetId },
    // `Metrics` is a fixed-field interface (no index signature); every field
    // is a number, so this is a safe structural cast to the generic emitter's
    // `Record<string, number>` shape.
    metrics: ctx.metrics as unknown as Record<string, number>,
    timestamp: ctx.nowMs,
  });
}

async function buildContext(): Promise<JanitorContext> {
  const runnerSetId = requireEnv('RUNNER_SET_ID');
  const scope = readScope();
  const graceSeconds = numEnv('GRACE_SECONDS', 600);
  const intervalSeconds = numEnv('JANITOR_INTERVAL_SECONDS', 300);
  const maxJobDurationSeconds = numEnv('MAX_JOB_DURATION_SECONDS');
  const nowMs = Date.now();
  return {
    tableName: requireEnv('RUNNER_TABLE'),
    scope,
    runnerSetId,
    graceSeconds,
    intervalSeconds,
    lifetimeCapSeconds:
      maxJobDurationSeconds + LIFETIME_CAP_GRACE_SECONDS + intervalSeconds,
    nowMs,
    nowIso: new Date(nowMs).toISOString(),
    metrics: freshMetrics(),
    runnersByTarget: new Map(),
  };
}

/** EventBridge Scheduler entry point — a scheduled sweep, no meaningful event payload. */
export async function handler(): Promise<void> {
  const ctx = await buildContext();
  // Each PHASE is isolated so one transient un-isolated throw (a throttle that
  // outlasts the SDK retries in `listRunnerSetVms`/`buildVmMap`, a 5xx from
  // `scanRunnerTable`/`listImageVersions`) cannot abort the whole sweep. Two
  // harms this prevents: (1) reaping halts and the VM/quota leak accumulates
  // across every aborted sweep; (2) `emitMetrics` is skipped, so the `errors`
  // metric — the operator's alarm signal — goes dark during the exact failure
  // it should announce. Per-item isolation inside the loops covers row-level
  // faults; this covers the phase-level calls around them.
  try {
    await reconcileTable(ctx);
  } catch (err) {
    ctx.metrics.errors += 1;
    console.error(
      JSON.stringify({
        scope: 'reconcile',
        action: 'phase-failed',
        err: serializeError(err),
      }),
    );
  }
  try {
    await pruneImageVersions(ctx, numEnv('KEEP_IMAGE_VERSIONS', 5));
  } catch (err) {
    ctx.metrics.errors += 1;
    console.error(
      JSON.stringify({
        scope: 'prune',
        action: 'phase-failed',
        err: serializeError(err),
      }),
    );
  }
  // Opt-in stuck-launch recovery. Isolated at the sweep level: this add-on must
  // never break the core reconciliation or metric emission.
  if (process.env.RECOVER_STUCK_LAUNCHES === 'true') {
    try {
      await recoverStuckLaunches(ctx);
    } catch (err) {
      ctx.metrics.errors += 1;
      console.error(
        JSON.stringify({
          scope: 'recover',
          action: 'sweep-failed',
          err: serializeError(err),
        }),
      );
    }
  }
  // Called on every path: emitMetrics only does
  // console.log(JSON.stringify(numbers)), so it still runs after a phase fault
  // above — the point is that `errors > 0` is not swallowed when a sweep
  // partially failed. Whether it reaches CloudWatch is a separate, opt-in
  // question: `emitEmf` writes nothing unless the runner set set `emitMetrics`
  // (see `shared/emf.ts`'s gate), so on the default runner set this is a no-op
  // and `errors` is visible only via the sweep's own structured error logs.
  emitMetrics(ctx);
}
