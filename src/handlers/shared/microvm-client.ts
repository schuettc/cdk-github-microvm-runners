/**
 * Thin wrapper around `@aws-sdk/client-lambda-microvms` for the
 * launcher/janitor handlers.
 *
 * DESIGN NOTE (runner set membership): running MicroVMs cannot be tagged (spike
 * finding, no VM ARN exists for `TagResource` to target — see
 * `.superpowers/sdd/progress.md`), and `ListMicrovms`' summary items
 * (`MicrovmItem`, `@aws-sdk/client-lambda-microvms` v3.1090.0
 * `models_0.d.ts`) carry only `microvmId`, `state`, `imageArn`,
 * `imageVersion`, `startedAt` — no `executionRoleArn`. Getting
 * `executionRoleArn` per VM requires a separate `GetMicrovm` call, which
 * would mean an N+1 fan-out on every concurrency-gate check (every launch
 * message). Instead, runner set membership is derived from `imageArn`: each
 * runner set's `ImagePipeline` (Task 6, `src/image/image-pipeline.ts`) names its
 * image `<runnerSetId>-<contentHash prefix>`, so image ARNs are already
 * runner-set-scoped by construction — one (or more, one per size class) image
 * per runner set, never shared across runner sets. `listRunnerSetVms` therefore takes the
 * caller's own set of image ARNs (its `SIZE_CLASSES_JSON` values plus
 * `IMAGE_ARN`) and filters the full account VM list to just those,
 * client-side, in a single paginated `ListMicrovms` sweep — no per-VM
 * `GetMicrovm` calls. This is a deviation from the literal
 * "filter on executionRoleArn" text of the amendment note in the Task 9
 * dispatch; flagged for operator ratification in task-9-report.md.
 */
import {
  CreateMicrovmAuthTokenCommand,
  DeleteMicrovmImageVersionCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmImageVersionsCommand,
  ListMicrovmsCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
  type IdlePolicy,
  type ListMicrovmsCommandInput,
  type ListMicrovmsCommandOutput,
  type MicrovmImageVersionSummary,
  type MicrovmState,
} from '@aws-sdk/client-lambda-microvms';

const client = new LambdaMicrovmsClient({});

/**
 * DELIVERY CHANNEL PIVOT: `RunMicrovmRequest.runHookPayload` is capped at
 * 4096 chars server-side (`ValidationException` — the 16KB ceiling in AWS's
 * docs does not match observed behavior, spike-verified live), and JIT
 * config blobs routinely exceed that. `RunMicrovmParams` therefore no longer
 * accepts a payload at all — delivery moves to an ingress-endpoint push
 * (`createMicrovmAuthToken` + `waitForMicrovmRunning` below), driven from
 * `launcher.ts`'s `handleLaunch`. See `.superpowers/sdd/progress.md` for the
 * spike findings.
 */
export interface RunMicrovmParams {
  imageArn: string;
  /**
   * Optional. When omitted, the MicroVM launches with NO AWS identity — its
   * IMDS serves no role credentials to job code. This is the default and the
   * security-correct posture: runner VMs need no AWS permissions (the runner
   * talks outbound to GitHub; the JIT push is platform-authenticated; jobs
   * that need AWS use their own per-job GitHub OIDC role, never the VM's
   * identity). Live-measured 2026-07-19: with a role attached, IMDSv2 serves
   * its credentials to arbitrary job code.
   */
  executionRoleArn?: string;
  maximumDurationInSeconds: number;
  ingressNetworkConnectors: string[];
  egressNetworkConnectors?: string[];
  /**
   * Runtime logging configuration for this MicroVM instance, mirroring the
   * `RunMicrovmRequest.logging` union (`cloudWatch`/`disabled`). `undefined`
   * leaves logging at the service's own default. Note this is the *runtime
   * API's* shape — `{disabled: {}}` for the disabled case — distinct from
   * `CfnMicrovmImage`'s CFN-resource `LoggingProperty`, whose `disabled`
   * field is a plain boolean (see `image/image-pipeline.ts`'s CORRECTION
   * comment for why the two schemas differ for the same concept).
   *
   * MUST be omitted (i.e. left `undefined`, never an explicit
   * `{cloudWatch: ...}`) when the VM has no `executionRoleArn`: the platform
   * REJECTS `RunMicrovm` with `"Logging cannot be enabled without providing
   * executionRoleArn"` whenever `cloudWatch` logging is requested on a
   * powerless VM (live-deploy finding, 2026-07-21). `resolveRuntimeLogging`
   * (`shared/launch-params.ts`) is the single place that enforces this —
   * both callers here just pass its result through untouched.
   */
  logging?:
    { cloudWatch: { logGroup?: string } } | { disabled: Record<string, never> };
  /**
   * Auto-suspend/auto-resume policy for this MicroVM, mirroring the
   * `RunMicrovmRequest.idlePolicy` shape (`@aws-sdk/client-lambda-microvms`'s
   * `IdlePolicy`). `undefined` (the default) omits the field entirely from
   * the request rather than sending an explicit empty/null value — matches
   * this module's existing `logging`/`egressNetworkConnectors` omit-when-unset
   * convention. Populated by the launcher's cold path from
   * `readIdlePolicies()` (`shared/runner-set-config.ts`) for the matched size
   * class, when that class set `RunnerClassProps.idlePolicy`.
   */
  idlePolicy?: {
    maxIdleDurationSeconds: number;
    suspendedDurationSeconds: number;
    autoResumeEnabled?: boolean;
  };
}

export interface RunnerSetVm {
  microvmId: string;
  state: MicrovmState;
  imageArn: string;
  startedAt: Date;
  /**
   * The HTTPS endpoint for the ingress-push JIT delivery channel
   * (`<uuid>.lambda-microvm.<region>.on.aws`). Populated whenever
   * `GetMicrovm` returns one; not required for `getMicrovm`'s own
   * completeness check below (existing callers — the janitor's
   * reconciliation sweep — don't need it), but required by
   * `waitForMicrovmRunning` once the VM reaches `RUNNING`.
   */
  endpoint?: string;
}

/** Run a new MicroVM; returns its `microvmId`. */
export async function runMicrovm(p: RunMicrovmParams): Promise<string> {
  const res = await client.send(
    new RunMicrovmCommand({
      imageIdentifier: p.imageArn,
      // `imageVersion` is deliberately NOT sent. Live-probed (bench account,
      // 2026-07-22, image with 4 ACTIVE versions): omitting it serves the
      // LATEST version; pinning (e.g. "2.0") serves exactly that version.
      // Omitting gives rolling-update semantics for asset-only image updates
      // (in-place image update → new version → next launch picks it up;
      // in-flight VMs keep the version they booted). Spec-level changes
      // instead change the image Name (content hash) and REPLACE the
      // resource, so a pin would add nothing there either.
      // Omit-when-unset, never an explicit `executionRoleArn: undefined` —
      // this is the security-critical powerless-VM default (no role ⇒ IMDS
      // serves no creds to job code), and it must not depend on the SDK
      // marshaller happening to drop an undefined-valued key. Same
      // conditional-spread convention as `logging`/`idlePolicy`/
      // `egressNetworkConnectors` below (see the idlePolicy incident).
      ...(p.executionRoleArn ? { executionRoleArn: p.executionRoleArn } : {}),
      maximumDurationInSeconds: p.maximumDurationInSeconds,
      ingressNetworkConnectors: p.ingressNetworkConnectors,
      egressNetworkConnectors:
        p.egressNetworkConnectors && p.egressNetworkConnectors.length > 0
          ? p.egressNetworkConnectors
          : undefined,
      ...(p.logging ? { logging: p.logging } : {}),
      // ALL THREE `idlePolicy` members are service-required, despite being
      // typed optional everywhere upstream (the SDK, CDK, and — until this
      // fix — our own public API). Both of these were live-observed on the
      // bench runner set, one after the other (2026-07-22):
      //   `ValidationException: Value null at 'idlePolicy.autoResumeEnabled'
      //    failed to satisfy constraint: Member must not be null`
      //   `ValidationException: Value null at
      //    'idlePolicy.suspendedDurationSeconds' failed to satisfy
      //    constraint: Member must not be null`
      // — and in both cases the error is IDENTICAL whether the key is sent
      // as an explicit `undefined` or omitted from the object entirely (both
      // were deployed and tested against the live service). So "Value null"
      // here means "required member absent", NOT "you literally sent null".
      //
      // `maxIdleDurationSeconds` is already required on `RunMicrovmParams.
      // idlePolicy`, so it's always present by construction.
      // `suspendedDurationSeconds` is now required on the public
      // `MicrovmIdlePolicy` (see `types/idle-policy.ts`) and on this
      // module's own `RunMicrovmParams.idlePolicy`, so it's always supplied
      // by every caller — but this module is the last line of defence
      // before the wire, so it's still emitted unconditionally here rather
      // than trusted to have arrived. `autoResumeEnabled` is the one member
      // that stays genuinely optional upstream, so it alone gets an explicit
      // default (`false`) at this boundary.
      //
      // Do NOT "optimise" any of these three back to a conditional spread —
      // that's exactly the bug both ValidationExceptions above were caused
      // by.
      ...(p.idlePolicy
        ? {
            idlePolicy: {
              maxIdleDurationSeconds: p.idlePolicy.maxIdleDurationSeconds,
              suspendedDurationSeconds: p.idlePolicy.suspendedDurationSeconds,
              autoResumeEnabled: p.idlePolicy.autoResumeEnabled ?? false,
            } satisfies IdlePolicy,
          }
        : {}),
    }),
  );
  if (!res.microvmId) {
    throw new Error('microvm-client: RunMicrovm returned no microvmId');
  }
  return res.microvmId;
}

/**
 * Terminate a MicroVM by id. `TerminateMicrovm` is documented idempotent
 * for an already-terminated VM (succeeds without error); a VM that no
 * longer exists at all surfaces as `ResourceNotFoundException`, which this
 * also treats as success — the caller (launcher's terminate path) only
 * cares that the VM is gone, not how it got that way.
 */
export async function terminateMicrovm(microvmId: string): Promise<void> {
  try {
    await client.send(
      new TerminateMicrovmCommand({ microvmIdentifier: microvmId }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      return;
    }
    throw err;
  }
}

/** Suspend a MicroVM by id. */
export async function suspendMicrovm(microvmId: string): Promise<void> {
  await client.send(
    new SuspendMicrovmCommand({ microvmIdentifier: microvmId }),
  );
}

/** Resume a MicroVM by id. */
export async function resumeMicrovm(microvmId: string): Promise<void> {
  await client.send(new ResumeMicrovmCommand({ microvmIdentifier: microvmId }));
}

/**
 * List this runner set's MicroVMs — those running one of `runnerSetImageArns` —
 * optionally filtered to a set of lifecycle `states`. Paginates the full
 * account VM list client-side (see module doc for why `ListMicrovms` can't
 * filter server-side on runner set membership).
 */
export async function listRunnerSetVms(
  runnerSetImageArns: string[],
  states?: MicrovmState[],
): Promise<RunnerSetVm[]> {
  const imageArnSet = new Set(runnerSetImageArns);
  const stateSet = states ? new Set(states) : undefined;
  const result: RunnerSetVm[] = [];
  let nextToken: string | undefined;
  do {
    // Throttle-retry each page (same bounded backoff as
    // `listSuspendedVmsForImage`). The janitor's sweep calls this un-isolated
    // at the top of `reconcileTable`, so a transient `ListMicrovms` throttle
    // that outlasts the SDK's own retries would otherwise abort the whole
    // sweep before any reaping or metric emission (see the janitor handler's
    // phase guards).
    const res = await sendListMicrovmsWithRetry({ nextToken });
    for (const item of res.items ?? []) {
      if (
        item.microvmId &&
        item.state &&
        item.imageArn &&
        item.startedAt &&
        imageArnSet.has(item.imageArn) &&
        (!stateSet || stateSet.has(item.state))
      ) {
        result.push({
          microvmId: item.microvmId,
          state: item.state,
          imageArn: item.imageArn,
          startedAt: item.startedAt,
        });
      }
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return result;
}

/**
 * Bounded retry cap for a single `ListMicrovms` page fetch inside
 * `listSuspendedVmsForImage` — see `LIST_MICROVMS_RETRY_BASE_MS` doc below for
 * why this stays small.
 */
const LIST_MICROVMS_MAX_ATTEMPTS = 4;

/**
 * Base backoff delay (ms) for the `ListMicrovms` throttle retry below.
 * Real-world value (not test-injected): the warm path sits in the launcher's
 * synchronous hot path, so backoff must stay short even in prod — a few
 * hundred ms of total retry budget beats falling back to the slow cold path.
 * Tests exercise this for real via `vi.useFakeTimers()` +
 * `vi.advanceTimersByTimeAsync`, so the real value can be used unmodified in
 * both prod and tests without any injected/parameterized delay.
 */
const LIST_MICROVMS_RETRY_BASE_MS = 100;

/**
 * True if `err` represents a throttling response — either the SDK's named
 * `ThrottlingException` or a generic error the SDK middleware has flagged
 * retryable-for-throttling via `$retryable.throttling` (belt-and-suspenders:
 * different service/SDK versions surface throttling one way or the other).
 */
function isThrottlingError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'ThrottlingException') {
    return true;
  }
  const retryable = (err as { $retryable?: { throttling?: boolean } } | null)
    ?.$retryable;
  return retryable?.throttling === true;
}

/**
 * Send one `ListMicrovmsCommand` page, retrying on `ThrottlingException`
 * (bounded, exponential backoff + jitter) so a transient throttle burst
 * during concurrent launches doesn't defeat `listSuspendedVmsForImage`'s warm
 * path and force callers onto the slow cold-launch fallback. Retries re-send
 * the SAME `nextToken` (the caller passes the identical input each attempt),
 * so pagination position is never lost. Non-throttle errors and the final
 * attempt's throttle error both rethrow immediately.
 */
async function sendWithThrottleRetry<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (!isThrottlingError(err) || attempt >= LIST_MICROVMS_MAX_ATTEMPTS) {
        throw err;
      }
      const backoffMs = LIST_MICROVMS_RETRY_BASE_MS * 2 ** (attempt - 1);
      const jitterMs = Math.random() * LIST_MICROVMS_RETRY_BASE_MS;
      await sleep(backoffMs + jitterMs);
    }
  }
}

/**
 * Largest page `ListMicrovms` accepts. Probed against the live service
 * 2026-07-26: `maxResults: 100` is rejected with
 * `ValidationException: Member must have value less than or equal to 50`.
 * Undocumented, so it is pinned here rather than inferred.
 *
 * This matters more than a page size usually does. The account's MicroVM list
 * retains TERMINATED VMs for about a day and cannot be filtered by state
 * server-side, so every listing walks the whole recent history of the account.
 * The launcher's capacity check runs that walk before EVERY launch, which
 * makes the call count per burst `concurrent launches x pages`. At the SDK
 * default of 10 per page a busy account reached 13 pages, and an 18-way burst
 * issued 230+ calls in a couple of seconds — enough to exhaust
 * `LIST_MICROVMS_MAX_ATTEMPTS` and push launches into a 180s SQS redrive.
 * Measured effect: a burst that peaked at 18 concurrent VMs on a short list
 * collapsed to 7, trickling in over 14 minutes. `ListMicrovms` has no Service
 * Quotas entry, so the throttle ceiling cannot be raised — using the full page
 * is the lever available.
 */
const LIST_MICROVMS_MAX_PAGE = 50;

function sendListMicrovmsWithRetry(
  input: ListMicrovmsCommandInput,
): Promise<ListMicrovmsCommandOutput> {
  return sendWithThrottleRetry(() =>
    client.send(
      new ListMicrovmsCommand({ maxResults: LIST_MICROVMS_MAX_PAGE, ...input }),
    ),
  );
}

/**
 * List the `microvmId`s of every MicroVM whose `imageArn` equals `imageArn`
 * AND whose `state` is `SUSPENDED` — the warm pool for that image. Paginates
 * the full account VM list client-side via `nextToken`, same shape as
 * `listRunnerSetVms` above (there is no server-side filter on `imageArn` or
 * `state` in `ListMicrovms`). Each page send is wrapped in a bounded
 * throttle retry (`sendListMicrovmsWithRetry` above) — this is the launcher's
 * warm-path lookup, which under a burst of concurrent job launches can hit
 * `ListMicrovms` `ThrottlingException`; without the retry a single throttled
 * call here used to fail the whole warm path and push the launch onto the
 * slow cold-VM fallback.
 */
export async function listSuspendedVmsForImage(
  imageArn: string,
): Promise<string[]> {
  const result: string[] = [];
  let nextToken: string | undefined;
  do {
    // `imageIdentifier` is a SERVER-side filter, verified against the live
    // service 2026-07-26: every item it returns carries the requested ARN.
    // This walk used to fetch the whole account and discard the rest here,
    // which on a busy account meant paging through a day of TERMINATED VMs
    // belonging to other images — on the launcher's warm path, before every
    // claim. The `imageArn` equality below is kept as a belt-and-braces check
    // rather than a filter; state is NOT filterable server-side, so SUSPENDED
    // still has to be selected client-side.
    const res = await sendListMicrovmsWithRetry({
      imageIdentifier: imageArn,
      nextToken,
    });
    for (const item of res.items ?? []) {
      if (
        item.microvmId &&
        item.state === 'SUSPENDED' &&
        item.imageArn === imageArn
      ) {
        result.push(item.microvmId);
      }
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return result;
}

/**
 * Fetch a single MicroVM by id, or `undefined` if it no longer exists
 * (`ResourceNotFoundException`) OR the response is missing a field this
 * module treats as required (`microvmId`/`state`/`imageArn`/`startedAt`).
 * The incomplete-response case is logged, not thrown: `listRunnerSetVms` below
 * already treats the same condition as "not usable" by silently filtering
 * the item out of its result rather than failing the whole paginated scan,
 * and callers (the janitor's `buildVmMap`) already have a well-exercised
 * "VM not found" path (rule 5 hygiene) that this reuses — a thrown error
 * here would instead abort the caller's per-row reconciliation for no
 * benefit over folding it into the existing NotFound handling. Used by the
 * janitor (Task 10) to resolve VM state for table rows not covered by the
 * image-ARN-scoped `listRunnerSetVms` sweep (e.g. a row whose VM launched from
 * an already-rotated-out image version — the image-rotation gap).
 */
export async function getMicrovm(
  microvmId: string,
): Promise<RunnerSetVm | undefined> {
  try {
    const res = await sendWithThrottleRetry(() =>
      client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId })),
    );
    if (!res.microvmId || !res.state || !res.imageArn || !res.startedAt) {
      console.log(
        JSON.stringify({
          msg: 'microvm-client: GetMicrovm returned an incomplete response',
          microvmId,
        }),
      );
      return undefined;
    }
    return {
      microvmId: res.microvmId,
      state: res.state,
      imageArn: res.imageArn,
      startedAt: res.startedAt,
      endpoint: res.endpoint,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      return undefined;
    }
    throw err;
  }
}

/**
 * Mint a short-lived MicroVM auth token scoping access to a single port,
 * for use as the `X-aws-proxy-auth` header value when pushing the JIT
 * config to the VM's ingress endpoint (see `launcher.ts`'s `handleLaunch`).
 * `CreateMicrovmAuthTokenResponse.authToken` is a MAP whose single key is
 * `X-aws-proxy-auth` (SDK v3.1090.0 `models_0.d.ts`) — this extracts and
 * returns just that value, throwing if the SDK response is malformed.
 */
export async function createMicrovmAuthToken(
  microvmId: string,
  expirationMinutes: number,
  port: number,
): Promise<string> {
  const res = await client.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes: expirationMinutes,
      allowedPorts: [{ port }],
    }),
  );
  const token = res.authToken?.['X-aws-proxy-auth'];
  if (!token) {
    throw new Error(
      'microvm-client: CreateMicrovmAuthToken returned no X-aws-proxy-auth token',
    );
  }
  return token;
}

/** Thrown by `waitForMicrovmRunning` when the VM hasn't reached `RUNNING` within its polling budget. */
export class MicrovmWaitTimeoutError extends Error {
  constructor(microvmId: string, timeoutMs: number) {
    super(
      `microvm-client: MicroVM ${microvmId} did not reach RUNNING within ${timeoutMs}ms`,
    );
    this.name = 'MicrovmWaitTimeoutError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll `getMicrovm` until the VM reaches `RUNNING` (and has an `endpoint`),
 * or the timeout budget is exhausted. A transient `undefined` from
 * `getMicrovm` (e.g. a momentarily incomplete `GetMicrovm` response — see
 * that function's doc) is tolerated and simply retried on the next tick,
 * not treated as fatal, since the VM legitimately may not be immediately
 * describable right after `RunMicrovm` returns.
 */
export async function waitForMicrovmRunning(
  microvmId: string,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<{ state: MicrovmState; endpoint: string }> {
  const deadlineMs = Date.now() + opts.timeoutMs;
  for (;;) {
    const vm = await getMicrovm(microvmId);
    if (vm && vm.state === 'RUNNING') {
      if (!vm.endpoint) {
        throw new Error(
          `microvm-client: MicroVM ${microvmId} reached RUNNING but GetMicrovm returned no endpoint`,
        );
      }
      return { state: vm.state, endpoint: vm.endpoint };
    }
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new MicrovmWaitTimeoutError(microvmId, opts.timeoutMs);
    }
    await sleep(Math.min(opts.intervalMs, remainingMs));
  }
}

/**
 * List every version of a MicroVM image, paginating the full result set.
 * Used by the janitor's image-version-pruning sweep.
 */
export async function listImageVersions(
  imageArn: string,
): Promise<MicrovmImageVersionSummary[]> {
  const result: MicrovmImageVersionSummary[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListMicrovmImageVersionsCommand({
        imageIdentifier: imageArn,
        nextToken,
      }),
    );
    result.push(...(res.items ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return result;
}

/**
 * Delete one version of a MicroVM image. Documented idempotent by the SDK
 * (deleting an already-deleted version succeeds without error), so no
 * NotFound handling is needed here (unlike `terminateMicrovm`).
 */
export async function deleteImageVersion(
  imageArn: string,
  imageVersion: string,
): Promise<void> {
  await client.send(
    new DeleteMicrovmImageVersionCommand({
      imageIdentifier: imageArn,
      imageVersion,
    }),
  );
}
