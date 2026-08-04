/**
 * Shared `RunMicrovm` launch-parameter resolution for the launcher's cold
 * path (`src/handlers/launcher.ts`) and the warm pool's convergence handler
 * (`src/handlers/warm-pool.ts`) — both boot a MicroVM from the same runner set
 * config (`SIZE_CLASSES_JSON`/`IMAGE_ARN`, `EGRESS_CONNECTOR_ARNS`,
 * `LOGGING_JSON`) and must resolve `ingressNetworkConnectors`,
 * `egressNetworkConnectors`, and `logging` identically, so a warm-pool VM is
 * fungible with a cold-launched one once the launcher's warm path resumes it
 * (Task 5).
 *
 * Extracted from `launcher.ts` (previously private helpers there) rather
 * than duplicated — see that module's history for the pre-extraction
 * versions. `allIngressConnectorArn`/`resolveRuntimeLogging` take their
 * caller's own `runnerSetConfigFor`-bound `requireEnv`/`readLogging` so each
 * module keeps its own error-message prefix (`"launcher: ..."` /
 * `"warm-pool: ..."`) byte-for-byte, exactly like `runner-set-config.ts`'s
 * `runnerSetConfigFor(moduleName)` does for its own readers.
 */
import type { RunMicrovmParams } from './microvm-client.js';
import type { LoggingConfig } from './runner-set-config.js';

/** Grace period added to the caller-supplied job duration for MicroVM `maximumDurationInSeconds`. */
export const MAX_DURATION_GRACE_SECONDS = 300;

/**
 * The platform's hard ceiling for `maximumDurationInSeconds` (8h) — the
 * largest value `RunMicrovm` accepts. Mirrors
 * `github-microvm-runners.ts`'s `PLATFORM_VM_LIFETIME_CEILING_SECONDS`, which
 * uses it at synth time to bound `maxJobDuration`; this copy is the runtime
 * one, used by the warm pool when it creates a pooled VM.
 */
export const PLATFORM_VM_LIFETIME_CEILING_SECONDS = 8 * 3600;

/**
 * Whether a pooled VM created at `startedAtMs` can still outlive a
 * full-length job started now.
 *
 * The platform's lifetime clock starts at `RunMicrovm` and keeps running
 * while the VM sits SUSPENDED in the pool, and the cap cannot be re-armed on
 * resume — `ResumeMicrovm` accepts only a `microvmIdentifier`, and the service
 * exposes no `UpdateMicrovm`. So a pooled VM's real budget for a job is
 * `capSeconds - age`, and handing a job a VM with less than a full
 * `maxJobDuration + grace` left is what killed jobs mid-run: the VM simply
 * vanished, with `stateReason` "MicroVM exceeded maximum lifetime" and nothing
 * logged by this library, because nothing in this library terminated it.
 *
 * Callers pass the cap the pool CREATED the VM with
 * (`PLATFORM_VM_LIFETIME_CEILING_SECONDS`), not the job cap — see
 * `warm-pool.ts`'s `launchAndSuspendOne`.
 */
export function warmVmCanServeJob(params: {
  startedAtMs: number;
  nowMs: number;
  capSeconds: number;
  maxJobDurationSeconds: number;
}): boolean {
  const ageSeconds = (params.nowMs - params.startedAtMs) / 1000;
  const remainingSeconds = params.capSeconds - ageSeconds;
  return (
    remainingSeconds >=
    params.maxJobDurationSeconds + MAX_DURATION_GRACE_SECONDS
  );
}

/** Parse the optional `EGRESS_CONNECTOR_ARNS` env var (JSON string array); absent/unset -> no egress connectors. */
export function readEgressConnectors(): string[] {
  const raw = process.env.EGRESS_CONNECTOR_ARNS;
  if (!raw) {
    return [];
  }
  return JSON.parse(raw) as string[];
}

/**
 * The AWS-managed ingress connector that opens a MicroVM's ingress proxy
 * endpoint (`GetMicrovm().endpoint`) to the platform's JIT-config push
 * (spike-verified — see `launcher.ts`'s module doc for the ingress-push
 * pivot). `requireEnv` is the caller's own module-prefixed reader (from
 * `runnerSetConfigFor`), so a missing `AWS_REGION` throws with that caller's
 * error-message prefix.
 */
export function allIngressConnectorArn(
  requireEnv: (name: string) => string,
): string {
  const region = requireEnv('AWS_REGION');
  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
}

/**
 * Map the construct-serialized `LOGGING_JSON` (`{kind, logGroupName?}`) onto
 * `RunMicrovmParams.logging` — the RunMicrovm *runtime API*'s shape, where
 * "disabled" is the empty object `{}`, NOT the boolean `CfnMicrovmImage`
 * (build-time) uses (see `shared/microvm-client.ts`'s doc comment on
 * `RunMicrovmParams.logging` for why the two schemas differ). `readLogging`
 * is the caller's own module-bound `runnerSetConfigFor` reader.
 *
 * The `cloudWatch` kind here means the runner set opted into `consoleLogs`,
 * which the construct only accepts alongside `vmExecutionRole` (validated at
 * synth), so a `cloudWatch` config always arrives with a role present. The
 * platform still REJECTS `RunMicrovm` with `"Logging cannot be enabled without
 * providing executionRoleArn"` (live deploy, 2026-07-21) whenever
 * `logging.cloudWatch` is set on a role-free VM, so `hasExecutionRole` (the
 * caller's own `Boolean(runnerSetVmRoleArn)`) stays as a defensive gate: were a
 * `cloudWatch` config ever to reach a powerless VM, this returns `undefined`
 * (no `logging` field) rather than a rejected launch. `disabled` — the default,
 * console capture off — is always safe regardless of role.
 */
export function resolveRuntimeLogging(
  readLogging: () => LoggingConfig,
  hasExecutionRole: boolean,
): RunMicrovmParams['logging'] {
  const cfg = readLogging();
  if (cfg.kind === 'disabled') {
    return { disabled: {} };
  }
  if (!hasExecutionRole) {
    return undefined;
  }
  // Omit-when-unset, never `logGroup: undefined` — the SDK types `logGroup`
  // as an optional key (`logGroup?:`), so its marshaller drops an undefined
  // value today, but the idlePolicy incident (required-keyed members
  // serialize undefined as JSON null -> ValidationException) is one codegen
  // detail away. Convention: never put an undefined value on the wire shape.
  return {
    cloudWatch: {
      ...(cfg.logGroupName !== undefined ? { logGroup: cfg.logGroupName } : {}),
    },
  };
}
