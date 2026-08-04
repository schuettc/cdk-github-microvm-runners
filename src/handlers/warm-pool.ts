/**
 * RunnerWarmPool handler — scheduled convergence sweep that keeps each
 * configured size class's `SUSPENDED`-VM count at its operator-configured
 * target (`WARM_POOL_JSON`, `{"<label>": <target>}`), opt-in per the warm
 * pool plan (`docs/designs/2026-07-21-warm-pool-plan.md`).
 *
 * Pool membership = `SUSPENDED` state + the size class's image (MicroVMs
 * can't be tagged — see `microvm-client.ts`'s module doc). Per label: count
 * the class's current `SUSPENDED` VMs (`listSuspendedVmsForImage`, Task 2),
 * cold-launch the shortfall with the SAME `RunMicrovm` params the launcher's
 * cold path uses (`shared/launch-params.ts`, extracted from `launcher.ts` so
 * a warm-pool VM is fungible with a cold-launched one once the launcher's
 * warm path resumes it — Task 5), wait each to `RUNNING`, then suspend it.
 *
 * Each launched VM's launch+wait+suspend runs in its OWN try/catch: one
 * VM's failure (a transient `RunMicrovm` throttle, a wait timeout, a
 * `SuspendMicrovm` on a VM that changed state underneath it — suspend/resume
 * THROW on a missing VM, unlike `terminateMicrovm`'s idempotent NotFound
 * handling) must never abort the tick for the rest of that label's shortfall
 * or for other labels; the next scheduled tick simply retries the shortfall.
 * A VM that reached `RUNNING` but then failed to reach `SUSPENDED` is
 * compensated with a best-effort `terminateMicrovm` — leaving it RUNNING
 * would otherwise silently consume the runner set's concurrency budget outside
 * the warm pool's own accounting.
 *
 * OUT OF SCOPE for this task (see the plan's YAGNI note): reaping
 * `FAILED`/over-age warm VMs. This sweep only logs the per-label suspended
 * count; a follow-up task adds reaping.
 */
import { emitEmf } from './shared/emf.js';
import {
  allIngressConnectorArn,
  PLATFORM_VM_LIFETIME_CEILING_SECONDS,
  readEgressConnectors,
  resolveRuntimeLogging,
  warmVmCanServeJob,
} from './shared/launch-params.js';
import {
  listSuspendedVmsForImage,
  runMicrovm,
  suspendMicrovm,
  terminateMicrovm,
  waitForMicrovmRunning,
} from './shared/microvm-client.js';
import { runnerSetConfigFor } from './shared/runner-set-config.js';

/** Namespace shared by every handler's EMF metric emission — same value as `janitor.ts`/`launcher.ts`'s `EMF_NAMESPACE`. */
const EMF_NAMESPACE = 'MicrovmRunners';

/**
 * Budget for `waitForMicrovmRunning` after `RunMicrovm` returns — mirrors
 * `launcher.ts`'s `RUNNING_WAIT_TIMEOUT_MS`/`RUNNING_WAIT_INTERVAL_MS` (no
 * ingress-push deadline pressure here since a warm VM isn't handed a JIT
 * config yet, but the same budget is a reasonable, already-battle-tested
 * default).
 */
const RUNNING_WAIT_TIMEOUT_MS = 90_000;
/** Poll interval for `waitForMicrovmRunning`. */
const RUNNING_WAIT_INTERVAL_MS = 2_000;

const { requireEnv, numEnv, readSizeClasses, readLogging, readWarmPool } =
  runnerSetConfigFor('warm-pool');

/**
 * Pure convergence planner: how many cold VMs to launch to bring `current`
 * `SUSPENDED` VMs up to `target`. Never negative — a class already at or
 * above target launches nothing (reaping any surplus is out of scope here,
 * see module doc).
 */
export function planConvergence(
  current: number,
  target: number,
): { launch: number } {
  return { launch: Math.max(0, target - current) };
}

/**
 * Launch one cold VM for `imageArn`, wait for it to reach `RUNNING`, then
 * suspend it into the warm pool. Any failure after `RunMicrovm` has already
 * returned a real `microvmId` is compensated with a best-effort
 * `terminateMicrovm` (logged if that also fails — the VM is left for the
 * janitor's own lifetime/orphan backstops). A `RunMicrovm` failure itself has
 * nothing to compensate (no VM was created).
 *
 * Returns `true` iff the VM reached `SUSPENDED` (a real addition to the warm
 * pool), `false` for any failure — used by `convergeLabel` to count
 * `PoolLaunched` vs `PoolLaunchFailed` for the tick's metric emission.
 */
async function launchAndSuspendOne(imageArn: string): Promise<boolean> {
  const maxJobDurationSeconds = numEnv('MAX_JOB_DURATION_SECONDS');
  // Optional: unset ⇒ powerless VM, same default posture as the launcher's
  // cold path (see `launcher.ts`'s `RunMicrovmParams.executionRoleArn` doc).
  const runnerSetVmRoleArn = process.env.RUNNER_SET_VM_ROLE_ARN || undefined;

  let microvmId: string;
  try {
    microvmId = await runMicrovm({
      imageArn,
      executionRoleArn: runnerSetVmRoleArn,
      // The PLATFORM CEILING, deliberately — not `maxJobDuration + grace`
      // like the cold path uses.
      //
      // The lifetime clock starts here, at creation, and keeps running while
      // the VM sits SUSPENDED in the pool; it cannot be re-armed on resume
      // (`ResumeMicrovm` takes only a `microvmIdentifier`, and the service has
      // no `UpdateMicrovm`). Capping a POOLED VM at the job budget therefore
      // spends that budget on pool residency: a VM that waited 29 minutes was
      // killed 62 seconds into its job, mid-run, with the job's step never
      // completing. Under the job cap a pooled VM is only safe to claim while
      // younger than `grace` — five minutes — which is not a pool.
      //
      // Creating at the ceiling makes the budget large enough that residency
      // is affordable, and `warmVmCanServeJob` is what enforces "this VM can
      // still outlive a full job" at claim time. The cost is that the
      // PLATFORM's runaway-job guard is looser for a warm VM (8h from
      // creation rather than the job budget from job start); the janitor's
      // own lifetime sweep, keyed off the runner row rather than the VM, is
      // the backstop that still bounds a hung job.
      maximumDurationInSeconds: PLATFORM_VM_LIFETIME_CEILING_SECONDS,
      ingressNetworkConnectors: [allIngressConnectorArn(requireEnv)],
      egressNetworkConnectors: readEgressConnectors(),
      logging: resolveRuntimeLogging(readLogging, Boolean(runnerSetVmRoleArn)),
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: 'warm-pool: RunMicrovm failed',
        imageArn,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }

  try {
    await waitForMicrovmRunning(microvmId, {
      timeoutMs: RUNNING_WAIT_TIMEOUT_MS,
      intervalMs: RUNNING_WAIT_INTERVAL_MS,
    });
    await suspendMicrovm(microvmId);
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: 'warm-pool: failed to bring warm VM to SUSPENDED, compensating',
        imageArn,
        microvmId,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    try {
      await terminateMicrovm(microvmId);
    } catch (termErr) {
      console.error(
        JSON.stringify({
          msg: 'warm-pool: compensating terminate also failed',
          imageArn,
          microvmId,
          err: termErr instanceof Error ? termErr.message : String(termErr),
        }),
      );
    }
    return false;
  }
}

/**
 * Best-effort per-tick pool-fill metric emission — PURELY OBSERVATIONAL:
 * never allowed to affect convergence. Wraps `emitEmf` in try/catch so a
 * logging failure (e.g. `console.log` throwing) never throws out of
 * `convergeLabel`. Dimensioned by `RunnerSetId` + `SizeClass` (the label), same
 * envelope shape as `launcher.ts`'s `emitLaunchMetrics`.
 */
function emitPoolMetrics(params: {
  runnerSetId: string;
  label: string;
  current: number;
  target: number;
  launched: number;
  launchFailed: number;
}): void {
  try {
    emitEmf({
      namespace: EMF_NAMESPACE,
      dimensions: ['RunnerSetId', 'SizeClass'],
      dimensionValues: {
        RunnerSetId: params.runnerSetId,
        SizeClass: params.label,
      },
      metrics: {
        PoolCurrent: params.current,
        PoolTarget: params.target,
        PoolLaunched: params.launched,
        PoolLaunchFailed: params.launchFailed,
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error(
      'warm-pool: per-tick metric emit failed (best-effort, ignored)',
      { err },
    );
  }
}

/** Converge a single label to its `WARM_POOL_JSON` target. Isolated at the caller (per-label try/catch is unnecessary here since every fallible step inside is already isolated at the VM level; a `listSuspendedVmsForImage` failure is caught by the caller loop). */
async function convergeLabel(
  label: string,
  imageArn: string,
  target: number,
  runnerSetId: string,
): Promise<void> {
  const suspended = await listSuspendedVmsForImage(imageArn);
  const maxJobDurationSeconds = numEnv('MAX_JOB_DURATION_SECONDS');
  const nowMs = Date.now();

  // Split the pool into VMs that can still serve a full-length job and VMs
  // that have aged past that. Counting the aged-out ones toward `current`
  // would be the same bug one level up: the pool would report itself at
  // target while every claim skipped its way to a cold boot, so the pool
  // looks healthy and does nothing. They are retired here instead, which
  // frees the launcher from ever seeing them and lets convergence refill the
  // slot with a VM that has a full budget.
  const usable = suspended.filter((vm) =>
    warmVmCanServeJob({
      startedAtMs: vm.startedAtMs,
      nowMs,
      capSeconds: PLATFORM_VM_LIFETIME_CEILING_SECONDS,
      maxJobDurationSeconds,
    }),
  );
  const expired = suspended.filter((vm) => !usable.includes(vm));

  let retired = 0;
  for (const vm of expired) {
    try {
      await terminateMicrovm(vm.microvmId);
      retired += 1;
    } catch (err) {
      // Best-effort, exactly like the compensating terminate in
      // `launchAndSuspendOne`: a VM left behind is picked up by the janitor's
      // orphan pass, and failing the whole tick over it would stop
      // convergence for every other VM in this label.
      console.error(
        JSON.stringify({
          msg: 'warm-pool: failed to retire aged-out warm VM',
          imageArn,
          microvmId: vm.microvmId,
          ageSeconds: Math.round((nowMs - vm.startedAtMs) / 1000),
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  const current = usable.length;
  const { launch } = planConvergence(current, target);

  let launched = 0;
  let launchFailed = 0;
  for (let i = 0; i < launch; i++) {
    const ok = await launchAndSuspendOne(imageArn);
    if (ok) {
      launched += 1;
    } else {
      launchFailed += 1;
    }
  }

  console.log(
    JSON.stringify({
      msg: 'warm-pool: convergence tick',
      label,
      imageArn,
      target,
      current,
      retired,
      launched,
      launchFailed,
    }),
  );

  emitPoolMetrics({
    runnerSetId,
    label,
    current,
    target,
    launched,
    launchFailed,
  });
}

/** EventBridge Scheduler entry point — a scheduled convergence sweep, no meaningful event payload. */
export async function handler(): Promise<void> {
  const runnerSetId = requireEnv('RUNNER_SET_ID');
  const warmPool = readWarmPool();
  const sizeClasses = readSizeClasses();

  for (const [label, target] of Object.entries(warmPool)) {
    const entry = sizeClasses[label];
    if (!entry) {
      console.error(
        JSON.stringify({
          msg: 'warm-pool: WARM_POOL_JSON label has no matching SIZE_CLASSES_JSON entry, skipping',
          label,
        }),
      );
      continue;
    }
    try {
      await convergeLabel(label, entry.imageArn, target, runnerSetId);
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: 'warm-pool: convergence failed for label',
          label,
          imageArn: entry.imageArn,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
