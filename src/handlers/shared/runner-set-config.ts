/**
 * Shared runner-set-config env-var readers for the launcher and janitor handlers
 * (`src/handlers/launcher.ts`, `src/handlers/janitor.ts`).
 *
 * Both handlers previously carried their own byte-identical copies of these
 * functions (`requireEnv`, `readScope`, `readSizeClasses`, `runnerSetImageArns`,
 * and a near-identical `scopeTarget`/`resolveTarget`), plus janitor's own
 * `numEnv`. This module is the single source for all of them.
 *
 * `runnerSetConfigFor(moduleName)` binds every reader to a caller-supplied
 * module name so thrown error messages keep their existing per-handler
 * prefix (`"launcher: ..."` / `"janitor: ..."`) byte-for-byte — unifying the
 * implementation changes nothing observable about either handler's error
 * text.
 *
 * `resolveTarget` uses janitor's optional-`repo` signature (a `RUNNER_TABLE`
 * row may be missing its `repo` field, which is itself an error worth a
 * distinct message) — this subsumes launcher's always-defined-`repo` case,
 * since `LaunchMessage.repo` is always a string and the `undefined` branch
 * is simply never reached from that call site.
 */
import type { ScopeTarget } from './github-client.js';

/** Parsed `SCOPE_JSON` env var: which GitHub scope (org or explicit repos) is visible to this runner set. */
export interface ScopeConfig {
  kind: 'org' | 'repos';
  org?: string;
  repos?: string[];
}

/** One entry of the parsed `SIZE_CLASSES_JSON` env var. */
export interface SizeClassEntry {
  imageArn: string;
  /**
   * The image's current version. Present so the warm path can tell a pooled
   * VM booted from an older build apart from a current one: the image Name —
   * and therefore the ARN — is stable across rebuilds now, so ARN equality no
   * longer implies same content. Optional so a runner set synthesized by an
   * older library version, whose SIZE_CLASSES_JSON carries no version, keeps
   * parsing; the warm path skips the version check when it is absent.
   */
  imageVersion?: string;
}

/**
 * Parsed `WARM_POOL_JSON` env var: size-class label -> target SUSPENDED count
 * (`src/handlers/warm-pool.ts`'s convergence handler, and the launcher's
 * warm-path). Always present on a synthesized runner set now (per-class `warm`,
 * see `github-microvm-runners.ts`'s `addRunnerClass`) — `{}` means no
 * registered class is warm, not "unconfigured".
 */
export type WarmPoolConfig = Record<string, number>;

/**
 * One entry of the parsed `IDLE_POLICY_JSON` env var: a registered class's
 * auto-suspend/auto-resume policy (`RunnerClassProps.idlePolicy`, serialized
 * by `github-microvm-runners.ts`'s `IDLE_POLICY_JSON` producer). Mirrors the
 * `RunMicrovmRequest.idlePolicy` shape (`@aws-sdk/client-lambda-microvms`'s
 * `IdlePolicy`). `suspendedDurationSeconds` is required — it mirrors the
 * public `MicrovmIdlePolicy.suspendedDuration`, which is itself required
 * because the service rejects `RunMicrovm` when this member is absent (see
 * `types/idle-policy.ts`) — so the producer always serializes it for every
 * idle-policy class. `autoResumeEnabled` is only present when the caller set
 * the corresponding `MicrovmIdlePolicy.autoResume` field.
 */
export interface IdlePolicyEntry {
  maxIdleDurationSeconds: number;
  suspendedDurationSeconds: number;
  autoResumeEnabled?: boolean;
}

/**
 * Parsed `IDLE_POLICY_JSON` env var: size-class label -> its idle policy.
 * Always present on a synthesized runner set (per-class `idlePolicy`, see
 * `github-microvm-runners.ts`'s `addRunnerClass`) — `{}` means no registered
 * class set `idlePolicy`, not "unconfigured".
 */
export type IdlePolicyConfig = Record<string, IdlePolicyEntry>;

/** Parsed `LOGGING_JSON` env var: the runner set's *runtime* logging decision, which is entirely `GithubMicrovmRunnersProps.consoleLogs` (serialized by `github-microvm-runners.ts`). `cloudWatch` ⇒ console capture on, to `logGroupName` (always present in that case — the resolved console group); `disabled` ⇒ console capture off. Build-time image logs (`imageLogs`) are wired on the image resource and never appear here. */
export interface LoggingConfig {
  kind: 'cloudWatch' | 'disabled';
  logGroupName?: string;
}

export interface RunnerSetConfig {
  /** Read a required env var; throws `"<moduleName>: missing required environment variable <name>"` if unset/empty. */
  requireEnv(name: string): string;
  /**
   * Read a numeric env var. With `defaultValue` given, an unset/empty var
   * falls back to it. With `defaultValue` omitted, the var is required —
   * unset/empty throws, exactly like `requireEnv`. Either way, a present but
   * non-finite value (e.g. `"not-a-number"`) always throws: this is the only
   * gate standing between a malformed numeric env var and NaN silently
   * poisoning downstream comparisons, so every numeric env var — required or
   * defaulted — MUST be read through this function, never a bare
   * `Number(requireEnv(...))`.
   */
  numEnv(name: string, defaultValue?: number): number;
  /** Parse `SCOPE_JSON`. */
  readScope(): ScopeConfig;
  /** Parse `SIZE_CLASSES_JSON`. */
  readSizeClasses(): Record<string, SizeClassEntry>;
  /** Parse `LOGGING_JSON`. */
  readLogging(): LoggingConfig;
  /** Parse `WARM_POOL_JSON`; `{}` when unset/empty (no registered class is warm). */
  readWarmPool(): WarmPoolConfig;
  /** Parse `IDLE_POLICY_JSON`; `{}` when unset/empty (no registered class set idlePolicy). */
  readIdlePolicies(): IdlePolicyConfig;
  /** The set of image ARNs this runner set's VMs may run from: every `SIZE_CLASSES_JSON` value plus the `IMAGE_ARN` fallback, deduplicated. */
  runnerSetImageArns(): string[];
  /** `ScopeConfig` + an optional `owner/name` repo -> a github-client `ScopeTarget`, honoring org vs. repos scope. */
  resolveTarget(scope: ScopeConfig, repo?: string): ScopeTarget;
  /**
   * Does this runner set serve `repo` ("owner/name")? Case-insensitive, as
   * GitHub is. The webhook decides with it before enqueueing and the launcher
   * before acting, from this one definition.
   */
  isRepoInScope(scope: ScopeConfig, repo: string | undefined): boolean;
}

/**
 * Is `repo` ("owner/name") one this runner set is configured to serve?
 *
 * THE ONE DEFINITION. Both the webhook and the launcher decide with this
 * function, so there is no second copy to drift — the launcher's check is
 * defence in depth against a message that did not come from our webhook,
 * not a differently-worded opinion about the same question.
 *
 * `RunnerScope` used to narrow only where a runner is REGISTERED. It did
 * not decide who may trigger a launch, so any repository under the same App
 * installation could consume this runner set's quota and cost by using a
 * matching label. The prop read as a boundary and was not one.
 *
 * Comparison is case-insensitive because GitHub treats owner and repository
 * names that way — it preserves the case you typed and resolves
 * `Owner/Repo` and `owner/repo` to the same thing, so an allowlist that
 * compared exactly would reject deliveries for repositories it does list.
 *
 * Not a security boundary on its own: the HMAC signature check in the
 * webhook is what establishes that a delivery came from GitHub at all. This
 * decides which of those authentic deliveries this runner set serves.
 */
/**
 * Case-insensitive equality, GitHub's rule for owner and repository names: it
 * preserves the case you typed and resolves `Owner/Repo` and `owner/repo` to
 * the same thing. An `undefined` on either side is never equal, which is what
 * folds "the config did not set this" into a plain `false` at the call site.
 */
function eqFold(a: string | undefined, b: string | undefined): boolean {
  return (
    a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()
  );
}

/** `"owner/name"` -> its owner, or `undefined` if it is not that shape. */
function repoOwner(repo: string | undefined): string | undefined {
  const [owner, name] = (repo ?? '').split('/');
  return owner && name ? owner : undefined;
}

/**
 * Is `repo` ("owner/name") one this runner set is configured to serve?
 *
 * THE ONE DEFINITION. Both the webhook and the launcher decide with this
 * function, so there is no second copy to drift — the launcher's check is
 * defence in depth against a message that did not come from our webhook, not
 * a differently-worded opinion about the same question.
 *
 * `RunnerScope` used to narrow only where a runner is REGISTERED. It did not
 * decide who may trigger a launch, so any repository under the same App
 * installation could consume this runner set's quota and cost by using a
 * matching label. The prop read as a boundary and was not one.
 *
 * Not a security boundary on its own: the HMAC signature check in the webhook
 * is what establishes that a delivery came from GitHub at all. This decides
 * which of those authentic deliveries this runner set serves.
 */
export function isRepoInScope(
  scope: ScopeConfig,
  repo: string | undefined,
): boolean {
  const owner = repoOwner(repo);
  if (owner === undefined) {
    return false;
  }
  // An org-scoped set serves every repository under that org. The App can be
  // installed on more than one org, and a delivery from another installation
  // carries a valid signature, so the owner is checked rather than assumed.
  if (scope.kind === 'org') {
    return eqFold(owner, scope.org);
  }
  return (scope.repos ?? []).some((allowed) => eqFold(allowed, repo));
}

export function runnerSetConfigFor(moduleName: string): RunnerSetConfig {
  function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
      throw new Error(
        `${moduleName}: missing required environment variable ${name}`,
      );
    }
    return value;
  }

  function numEnv(name: string, defaultValue?: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
      if (defaultValue === undefined) {
        throw new Error(
          `${moduleName}: missing required environment variable ${name}`,
        );
      }
      return defaultValue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(
        `${moduleName}: invalid numeric env var ${name}: "${raw}"`,
      );
    }
    return n;
  }

  function readScope(): ScopeConfig {
    return JSON.parse(requireEnv('SCOPE_JSON')) as ScopeConfig;
  }

  function readSizeClasses(): Record<string, SizeClassEntry> {
    return JSON.parse(requireEnv('SIZE_CLASSES_JSON')) as Record<
      string,
      SizeClassEntry
    >;
  }

  function readLogging(): LoggingConfig {
    return JSON.parse(requireEnv('LOGGING_JSON')) as LoggingConfig;
  }

  function readWarmPool(): WarmPoolConfig {
    const raw = process.env.WARM_POOL_JSON;
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as WarmPoolConfig;
  }

  function readIdlePolicies(): IdlePolicyConfig {
    const raw = process.env.IDLE_POLICY_JSON;
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as IdlePolicyConfig;
  }

  function runnerSetImageArns(): string[] {
    const sizeClasses = readSizeClasses();
    const arns = new Set(Object.values(sizeClasses).map((e) => e.imageArn));
    const fallback = process.env.IMAGE_ARN;
    if (fallback) {
      arns.add(fallback);
    }
    return [...arns];
  }

  function resolveTarget(scope: ScopeConfig, repo?: string): ScopeTarget {
    if (scope.kind === 'org') {
      if (!scope.org) {
        throw new Error(
          `${moduleName}: SCOPE_JSON kind=org but org is missing`,
        );
      }
      return { org: scope.org };
    }
    if (!repo) {
      throw new Error(
        `${moduleName}: repos-scoped row is missing its repo field`,
      );
    }
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
      throw new Error(
        `${moduleName}: malformed repo "${repo}", expected owner/name`,
      );
    }
    return { owner, repo: name };
  }

  return {
    requireEnv,
    numEnv,
    readScope,
    readSizeClasses,
    readLogging,
    readWarmPool,
    readIdlePolicies,
    runnerSetImageArns,
    resolveTarget,
    isRepoInScope,
  };
}
