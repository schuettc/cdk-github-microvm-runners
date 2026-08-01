/**
 * GitHub REST client for handler runtime code (webhook / launcher / janitor).
 *
 * Handler-internal — NOT exported from `src/index.ts`. Reads the env-var
 * contract produced by `GithubAuth.bindEnv()` (`src/types/github-auth.ts`):
 * `GH_AUTH_KIND` ('app'|'pat'), `GH_APP_ID` | `GH_APP_ID_SECRET_ARN`,
 * `GH_KEY_SECRET_ARN` | `GH_KEY_KMS_ARN`, `GH_PAT_SECRET_ARN`.
 *
 * All HTTP goes through the global `fetch` (Node 22, undici-backed) so tests
 * can mock it with undici's `MockAgent` + `setGlobalDispatcher`.
 *
 * Module-level caches (app id, PEM, PAT, installation id, installation token) persist
 * for the lifetime of the Lambda execution environment. Call
 * `_resetCachesForTesting()` between tests to avoid cross-test leakage.
 */
import { sign as rsaSign } from 'node:crypto';
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const GITHUB_API_BASE = 'https://api.github.com';
const USER_AGENT = 'cdk-github-microvm-runners';
const API_VERSION = '2022-11-28';
const APP_JWT_CLOCK_DRIFT_SECONDS = 60;
const APP_JWT_TTL_SECONDS = 600; // GitHub's 10-minute maximum, measured from `iat`.
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Where a runner-scoped API call targets: an org, or an owner/repo pair. */
export type ScopeTarget = { org: string } | { owner: string; repo: string };

/** A registered GitHub Actions runner, as returned by the runners API. */
export interface GithubRunner {
  id: number;
  name: string;
  busy: boolean;
  status: string;
}

/**
 * Thrown when GitHub responds with a rate-limit signal (403/429 with
 * `retry-after` or `x-ratelimit-remaining: 0`). Callers (SQS-driven
 * handlers) should catch this and map it to a batch-item failure/retry
 * rather than a hard failure.
 */
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

const smClient = new SecretsManagerClient({});
const kmsClient = new KMSClient({});

let cachedAppId: string | undefined;
let cachedPem: string | undefined;
let cachedPat: string | undefined;
/**
 * Installation id and token caches, keyed PER OWNER LOGIN (the target org,
 * or repo owner — see {@link ownerLoginFor}) rather than process-global: a
 * single GitHub App can have multiple installations (one per org/user it's
 * installed into), and a deployment may drive calls against more than one
 * owner over its lifetime (e.g. a `repos`-scoped runner set spanning repos under
 * different owners). A process-global single cache would silently reuse the
 * wrong installation's token for a second owner.
 */
let cachedInstallationIds: Map<string, number> = new Map();
let cachedInstallationTokens: Map<
  string,
  { token: string; expiresAtMs: number }
> = new Map();

/** Test-only: clear all module-level caches between test cases. */
export function _resetCachesForTesting(): void {
  cachedAppId = undefined;
  cachedPem = undefined;
  cachedPat = undefined;
  cachedInstallationIds = new Map();
  cachedInstallationTokens = new Map();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `github-client: missing required environment variable ${name}`,
    );
  }
  return value;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

async function fetchSecretString(secretArn: string): Promise<string> {
  const res = await smClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!res.SecretString) {
    throw new Error(`github-client: secret ${secretArn} has no SecretString`);
  }
  return res.SecretString;
}

/**
 * Resolve the App's numeric ID from whichever env var the construct set:
 * `GH_APP_ID` (literal, baked in at synth) or `GH_APP_ID_SECRET_ARN` (a
 * Secrets Manager reference read here at runtime, so the App can be created
 * after the runner set is deployed). Cached for the lifetime of the execution
 * environment, exactly like the PEM.
 *
 * The stored value is trimmed: the setup helper writes it with `String(appId)`
 * and a stray trailing newline would corrupt the JWT's `iss` claim.
 */
async function getAppId(): Promise<string> {
  if (cachedAppId !== undefined) {
    return cachedAppId;
  }

  const literal = process.env.GH_APP_ID;
  if (literal) {
    cachedAppId = literal.trim();
    return cachedAppId;
  }

  const secretArn = process.env.GH_APP_ID_SECRET_ARN;
  if (!secretArn) {
    throw new Error(
      'github-client: neither GH_APP_ID nor GH_APP_ID_SECRET_ARN is set for app auth',
    );
  }
  cachedAppId = (await fetchSecretString(secretArn)).trim();
  return cachedAppId;
}

async function getPem(): Promise<string> {
  if (cachedPem === undefined) {
    cachedPem = await fetchSecretString(requireEnv('GH_KEY_SECRET_ARN'));
  }
  return cachedPem;
}

async function getPat(): Promise<string> {
  if (cachedPat === undefined) {
    cachedPat = await fetchSecretString(requireEnv('GH_PAT_SECRET_ARN'));
  }
  return cachedPat;
}

/**
 * Sign `signingInput` (the JWT's `header.payload`) and return a base64url
 * signature.
 *
 * KMS path uses `MessageType: 'RAW'` with `SigningAlgorithm:
 * 'RSASSA_PKCS1_V1_5_SHA_256'` — KMS hashes the message internally for RAW
 * inputs, and the App JWT signing input is a few hundred bytes, well under
 * the 4096-byte RAW limit, so there is no need to pre-hash it ourselves
 * (which `MessageType: 'DIGEST'` would require).
 */
async function signWithConfiguredKey(signingInput: string): Promise<string> {
  const kmsKeyArn = process.env.GH_KEY_KMS_ARN;
  if (kmsKeyArn) {
    const res = await kmsClient.send(
      new SignCommand({
        KeyId: kmsKeyArn,
        Message: Buffer.from(signingInput, 'utf8'),
        MessageType: 'RAW',
        SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
      }),
    );
    if (!res.Signature) {
      throw new Error('github-client: KMS Sign returned no Signature');
    }
    return base64url(Buffer.from(res.Signature));
  }

  if (process.env.GH_KEY_SECRET_ARN) {
    const pem = await getPem();
    return base64url(
      rsaSign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), pem),
    );
  }

  throw new Error(
    'github-client: neither GH_KEY_SECRET_ARN nor GH_KEY_KMS_ARN is set for app auth',
  );
}

/**
 * Build a GitHub App JWT: RS256, `iss` = app id, `iat` = now - 60s (clock
 * drift guard), `exp` = iat + 600s (GitHub's 10-minute maximum).
 */
async function buildAppJwt(): Promise<string> {
  const appId = await getAppId();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: nowSeconds - APP_JWT_CLOCK_DRIFT_SECONDS,
    exp: nowSeconds - APP_JWT_CLOCK_DRIFT_SECONDS + APP_JWT_TTL_SECONDS,
    iss: appId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = await signWithConfiguredKey(signingInput);
  return `${signingInput}.${signature}`;
}

interface RawFetchOpts {
  method?: string;
  bearerToken: string;
  body?: unknown;
}

/**
 * Reject anything that isn't a bare path rooted at `/`. Every `path` this
 * module builds is an internal string interpolation of validated org/
 * owner/repo/id values, never external input — but this guard is cheap
 * defense-in-depth against a future caller mistake smuggling a scheme/host
 * (`http://...`, `//evil.example`) that would otherwise redirect the
 * request off `GITHUB_API_BASE` entirely (SSRF via URL/base confusion).
 */
function assertRelativeGithubPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    throw new Error(
      `github-client: refusing to fetch a non-relative path: ${path}`,
    );
  }
  return path;
}

/** Low-level authenticated fetch against the GitHub REST API. */
async function githubFetch(
  path: string,
  opts: RawFetchOpts,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.bearerToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
  };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(
    `${GITHUB_API_BASE}${assertRelativeGithubPath(path)}`,
    {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
  );

  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const retryAfter = res.headers.get('retry-after');
    if (remaining === '0' || retryAfter !== null) {
      throw new RetryableError(
        `github-client: rate-limited by GitHub (status ${res.status})`,
        retryAfter !== null ? Number(retryAfter) : undefined,
      );
    }
  }

  return res;
}

async function assertOk(res: Response): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`github-client: GitHub API error ${res.status}: ${text}`);
  }
}

/** The login this call should authenticate as: the org (org scope) or the repo owner (repos scope). */
function ownerLoginFor(target: ScopeTarget): string {
  return 'org' in target ? target.org : target.owner;
}

/** Fetch every installation of this App, paginating `per_page=100` like `listRunners`. */
async function listAllInstallations(
  jwt: string,
): Promise<Array<{ id: number; account: { login: string } | null }>> {
  const pageSize = 100;
  const installations: Array<{
    id: number;
    account: { login: string } | null;
  }> = [];
  for (let page = 1; ; page += 1) {
    const res = await githubFetch(
      `/app/installations?per_page=${pageSize}&page=${page}`,
      { bearerToken: jwt },
    );
    await assertOk(res);
    const body = (await res.json()) as Array<{
      id: number;
      account: { login: string } | null;
    }>;
    installations.push(...body);
    if (body.length < pageSize) {
      break;
    }
  }
  return installations;
}

/**
 * Resolve (and cache, per `ownerLogin`) the installation id whose
 * `account.login` matches `ownerLogin` case-insensitively, reusing the
 * caller's already-signed JWT rather than minting a second one. A GitHub App
 * can have multiple installations (one per org/user); this driving
 * deployment may target more than one owner over its lifetime (e.g. a
 * `repos`-scoped runner set spanning repos under different owners), so "exactly
 * one installation total" is no longer assumed — the RIGHT installation for
 * THIS call is selected by login, and a miss throws a clear error naming the
 * owner and every login that IS available (so a misconfigured owner name is
 * obvious from the error alone).
 */
async function getInstallationId(
  jwt: string,
  ownerLogin: string,
): Promise<number> {
  const cached = cachedInstallationIds.get(ownerLogin);
  if (cached !== undefined) {
    return cached;
  }

  const installations = await listAllInstallations(jwt);
  const match = installations.find(
    (i) => i.account?.login.toLowerCase() === ownerLogin.toLowerCase(),
  );
  if (!match) {
    const available = installations
      .map((i) => i.account?.login ?? '(no account)')
      .join(', ');
    throw new Error(
      `github-client: no GitHub App installation found for "${ownerLogin}" (available installations: ${available || 'none'})`,
    );
  }
  cachedInstallationIds.set(ownerLogin, match.id);
  return match.id;
}

/**
 * Return a usable bearer token for `target`'s owner: the installation access
 * token (App kind, cached PER OWNER LOGIN until 5 minutes before its
 * `expires_at`) or the PAT itself (PAT kind, cached — never assume its
 * format, GitHub's stateless-JWT rollout means PATs/installation tokens are
 * opaque strings of unspecified shape; `target` is irrelevant for PAT auth,
 * a single PAT is used for every call).
 */
export async function getInstallationToken(
  target: ScopeTarget,
): Promise<string> {
  const kind = requireEnv('GH_AUTH_KIND');
  if (kind === 'pat') {
    return getPat();
  }
  if (kind !== 'app') {
    throw new Error(`github-client: unknown GH_AUTH_KIND "${kind}"`);
  }

  const ownerLogin = ownerLoginFor(target);
  const cached = cachedInstallationTokens.get(ownerLogin);
  if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
    return cached.token;
  }

  const jwt = await buildAppJwt();
  const installationId = await getInstallationId(jwt, ownerLogin);
  const res = await githubFetch(
    `/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      bearerToken: jwt,
    },
  );
  await assertOk(res);
  const body = (await res.json()) as { token: string; expires_at: string };
  cachedInstallationTokens.set(ownerLogin, {
    token: body.token,
    expiresAtMs: Date.parse(body.expires_at),
  });
  return body.token;
}

async function authedFetch(
  target: ScopeTarget,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const bearerToken = await getInstallationToken(target);
  return githubFetch(path, { ...opts, bearerToken });
}

function runnersBasePath(target: ScopeTarget): string {
  return 'org' in target
    ? `/orgs/${target.org}/actions/runners`
    : `/repos/${target.owner}/${target.repo}/actions/runners`;
}

/**
 * Request a JIT runner-registration config and return the opaque
 * `encoded_jit_config` blob.
 */
export async function generateJitConfig(p: {
  target: ScopeTarget;
  runnerName: string;
  labels: string[];
}): Promise<string> {
  const res = await authedFetch(
    p.target,
    `${runnersBasePath(p.target)}/generate-jitconfig`,
    {
      method: 'POST',
      body: { name: p.runnerName, runner_group_id: 1, labels: p.labels },
    },
  );
  await assertOk(res);
  const body = (await res.json()) as { encoded_jit_config: string };
  return body.encoded_jit_config;
}

/** List all registered runners for `target`, paginating per_page=100. */
export async function listRunners(
  target: ScopeTarget,
): Promise<GithubRunner[]> {
  const base = runnersBasePath(target);
  const runners: GithubRunner[] = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const res = await authedFetch(
      target,
      `${base}?per_page=${pageSize}&page=${page}`,
    );
    await assertOk(res);
    const body = (await res.json()) as { runners: GithubRunner[] };
    runners.push(...body.runners);
    if (body.runners.length < pageSize) {
      break;
    }
  }
  return runners;
}

/** Fetch a single runner by id, or `undefined` if it no longer exists. */
export async function getRunner(
  target: ScopeTarget,
  id: number,
): Promise<GithubRunner | undefined> {
  const res = await authedFetch(target, `${runnersBasePath(target)}/${id}`);
  if (res.status === 404) {
    return undefined;
  }
  await assertOk(res);
  return (await res.json()) as GithubRunner;
}

/** Delete a runner by id. A 404 (already gone) is treated as success. */
export async function deleteRunner(
  target: ScopeTarget,
  id: number,
): Promise<void> {
  const res = await authedFetch(target, `${runnersBasePath(target)}/${id}`, {
    method: 'DELETE',
  });
  if (res.status === 404) {
    return;
  }
  await assertOk(res);
}

/**
 * Fetch a workflow job's status (`queued` | `in_progress` | `completed` | …),
 * its `conclusion` and the `runnerName` that served it, its requested runner
 * `labels`, and its `runId`, or `undefined` if the job no longer exists (404).
 * The DLQ sweep reads only `.status`; the claim-row reconciler also reads
 * `labels`/`runId` to rebuild a launch message without storing them on the
 * claim row.
 *
 * `conclusion`/`runnerName` exist for the launcher's pre-launch guard
 * (`skipCancelledJob`), which has to tell two very different `completed` jobs
 * apart: one cancelled while still queued, which consumed no runner, and one
 * that actually RAN on a runner drawn from this runner set's pool. `status`
 * alone reports both as `completed`. See the guard for why the difference
 * decides whether another job starves.
 */
export async function getWorkflowJob(
  target: ScopeTarget,
  owner: string,
  repo: string,
  jobId: number,
): Promise<
  | {
      status: string;
      conclusion: string | undefined;
      runnerName: string | undefined;
      labels: string[];
      runId: number;
    }
  | undefined
> {
  const res = await authedFetch(
    target,
    `/repos/${owner}/${repo}/actions/jobs/${jobId}`,
  );
  if (res.status === 404) {
    return undefined;
  }
  await assertOk(res);
  const body = (await res.json()) as {
    status: string;
    conclusion?: string | null;
    runner_name?: string | null;
    labels?: string[];
    run_id?: number;
  };
  return {
    status: body.status,
    conclusion: body.conclusion ?? undefined,
    // GitHub sends an EMPTY STRING (not null) for a job no runner ever
    // claimed, so `|| undefined` — `??` would keep `''` and read as "a runner
    // served this".
    runnerName: body.runner_name || undefined,
    labels: body.labels ?? [],
    runId: body.run_id ?? 0,
  };
}
