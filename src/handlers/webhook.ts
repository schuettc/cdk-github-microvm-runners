/**
 * Webhook intake handler — Lambda Function URL target for GitHub's
 * `workflow_job` webhook.
 *
 * Verifies the HMAC-SHA256 signature (`X-Hub-Signature-256`) over the RAW
 * request body before parsing anything, then fans `queued`/`completed`
 * events out to SQS as `launch`/`terminate` intents for the launcher
 * handler (Task 9) to act on.
 *
 * Deliberately thin: no GitHub API calls, no AWS calls beyond the one-time
 * webhook-secret fetch and the SQS send, so it stays fast under GitHub's
 * webhook delivery timeout.
 *
 * Module-level webhook-secret cache persists for the lifetime of the Lambda
 * execution environment. Call `_resetCachesForTesting()` between tests to
 * avoid cross-test leakage.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { RUNNER_NAME_PREFIX } from './shared/runner-naming.js';
import { isRepoInScope, type ScopeConfig } from './shared/runner-set-config.js';

const SIGNATURE_PREFIX = 'sha256=';

/** Minimal shape of the Lambda Function URL request this handler needs. */
export interface WebhookEvent {
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

/** Minimal shape of the Lambda Function URL response this handler returns. */
export interface WebhookResult {
  statusCode: number;
  body: string;
}

interface WorkflowJobPayload {
  action: string;
  workflow_job: {
    id: number;
    run_id: number;
    labels: string[];
    runner_name: string | null;
  };
  repository: {
    full_name: string;
  };
}

const smClient = new SecretsManagerClient({});
const sqsClient = new SQSClient({});

let cachedWebhookSecret: string | undefined;

/** Test-only: clear all module-level caches between test cases. */
export function _resetCachesForTesting(): void {
  cachedWebhookSecret = undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`webhook: missing required environment variable ${name}`);
  }
  return value;
}

async function getWebhookSecret(): Promise<string> {
  if (cachedWebhookSecret === undefined) {
    const res = await smClient.send(
      new GetSecretValueCommand({
        SecretId: requireEnv('GH_WEBHOOK_SECRET_ARN'),
      }),
    );
    if (!res.SecretString) {
      throw new Error('webhook: webhook secret has no SecretString');
    }
    cachedWebhookSecret = res.SecretString;
  }
  return cachedWebhookSecret;
}

function ok(body: Record<string, unknown>): WebhookResult {
  return { statusCode: 200, body: JSON.stringify(body) };
}

function decodeRawBody(event: WebhookEvent): Buffer {
  const body = event.body ?? '';
  return event.isBase64Encoded
    ? Buffer.from(body, 'base64')
    : Buffer.from(body, 'utf8');
}

/**
 * Constant-time comparison of the `X-Hub-Signature-256` header against an
 * HMAC-SHA256 of the raw body, computed with the given secret. Length is
 * checked first — `timingSafeEqual` throws on mismatched-length buffers,
 * and a length mismatch is itself not a signal worth timing-protecting.
 */
function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header || !header.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const providedHex = header.slice(SIGNATURE_PREFIX.length);
  const expectedHex = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const provided = Buffer.from(providedHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (
    provided.length === 0 ||
    expected.length === 0 ||
    provided.length !== expected.length
  ) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

function getHeader(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

function readSizeClassLabels(): string[] {
  return JSON.parse(requireEnv('SIZE_CLASS_LABELS')) as string[];
}

function readScope(): ScopeConfig {
  return JSON.parse(requireEnv('SCOPE_JSON')) as ScopeConfig;
}

/**
 * Structural validation of a parsed `workflow_job` webhook body, run BEFORE
 * any field is read. GitHub's webhook payload shape is not itself something
 * this handler controls, and a malformed/unexpected shape must never throw
 * past this point (which would surface as an unhandled-rejection 5xx and
 * make GitHub treat a bad payload as a delivery failure worth retrying) —
 * it's a client error, so it gets the same 400 treatment as malformed JSON.
 */
function isValidWorkflowJobPayload(
  payload: unknown,
): payload is WorkflowJobPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.action !== 'string') {
    return false;
  }

  const wj = p.workflow_job;
  if (typeof wj !== 'object' || wj === null) {
    return false;
  }
  const w = wj as Record<string, unknown>;
  if (typeof w.id !== 'number' || typeof w.run_id !== 'number') {
    return false;
  }
  if (
    !Array.isArray(w.labels) ||
    !w.labels.every((label) => typeof label === 'string')
  ) {
    return false;
  }
  if (!(w.runner_name === null || typeof w.runner_name === 'string')) {
    return false;
  }

  // repository.full_name is only ever read on the `queued` path.
  if (p.action === 'queued') {
    const repo = p.repository;
    if (typeof repo !== 'object' || repo === null) {
      return false;
    }
    if (typeof (repo as Record<string, unknown>).full_name !== 'string') {
      return false;
    }
  }

  return true;
}

async function sendQueueMessage(
  message: Record<string, unknown>,
): Promise<void> {
  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: requireEnv('QUEUE_URL'),
        MessageBody: JSON.stringify(message),
      }),
    );
  } catch (err) {
    console.error('webhook: SQS send failed', {
      kind: message.kind,
      jobId: 'jobId' in message ? message.jobId : undefined,
      runnerName: 'runnerName' in message ? message.runnerName : undefined,
    });
    // Rethrow deliberately: the resulting unhandled rejection surfaces as a
    // 5xx, so GitHub records this as a failed delivery — the intended
    // outcome, since we have no queued intent for the launcher to act on.
    throw err;
  }
}

/** Lambda Function URL entry point. */
export async function handler(event: WebhookEvent): Promise<WebhookResult> {
  const rawBody = decodeRawBody(event);
  const signatureHeader = getHeader(event.headers, 'X-Hub-Signature-256');

  let secret: string;
  try {
    secret = await getWebhookSecret();
  } catch (err) {
    console.error('webhook: failed to fetch webhook secret', err);
    throw err;
  }

  if (!verifySignature(rawBody, signatureHeader, secret)) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'bad signature' }),
    };
  }

  const eventType = getHeader(event.headers, 'X-GitHub-Event');
  if (eventType !== 'workflow_job') {
    return ok({ ignored: true });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('webhook: malformed JSON body', err);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'malformed body' }),
    };
  }

  if (!isValidWorkflowJobPayload(parsed)) {
    console.error('webhook: malformed workflow_job payload shape');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'malformed payload' }),
    };
  }
  const payload = parsed;

  if (payload.action === 'queued') {
    // Scope FIRST, before labels and before anything is enqueued.
    //
    // A valid signature proves the delivery came from GitHub through this
    // App. It does NOT prove the repository is one this runner set serves:
    // the App can be installed on repositories beyond the configured list,
    // and on more than one organization, and every one of those deliveries is
    // correctly signed. Without this check any of them could consume this
    // runner set's VMs, quota and cost by using a matching label.
    //
    // Ignored rather than rejected, and answered 200, exactly like the
    // no-matching-label case below: a 4xx would make GitHub retry a delivery
    // that can never be accepted, and would tell an unlisted repository that
    // it had found a runner set worth probing.
    if (!isRepoInScope(readScope(), payload.repository.full_name)) {
      return ok({ ignored: true });
    }

    const sizeClassLabels = new Set(readSizeClassLabels());
    const hasSizeClassMatch = payload.workflow_job.labels.some((label) =>
      sizeClassLabels.has(label),
    );
    if (!hasSizeClassMatch) {
      return ok({ ignored: true });
    }
    // Carry the FULL label set (not just the size-class intersection): a
    // runner registered with only the matched subset would never receive
    // jobs that also declare extra custom labels (GitHub's runner-label
    // matching requires the runner to carry every label a job declares).
    // Routing is still decided by the size-class intersection above, which
    // is unaffected by this.
    await sendQueueMessage({
      kind: 'launch',
      repo: payload.repository.full_name,
      jobId: payload.workflow_job.id,
      runId: payload.workflow_job.run_id,
      labels: payload.workflow_job.labels,
    });
    return ok({ queued: true });
  }

  if (payload.action === 'completed') {
    const runnerName = payload.workflow_job.runner_name;
    if (!runnerName || !runnerName.startsWith(`${RUNNER_NAME_PREFIX}-`)) {
      return ok({ ignored: true });
    }
    await sendQueueMessage({ kind: 'terminate', runnerName });
    return ok({ terminated: true });
  }

  return ok({ ignored: true });
}
