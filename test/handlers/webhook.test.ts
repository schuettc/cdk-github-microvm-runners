import { createHmac } from 'node:crypto';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { _resetCachesForTesting, handler } from '../../src/handlers/webhook.js';

const WEBHOOK_SECRET = 'whsec_test_secret';
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:1:secret:webhook';
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/1/queue';

const smMock = mockClient(SecretsManagerClient);
const sqsMock = mockClient(SQSClient);

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('GH_') ||
      key === 'QUEUE_URL' ||
      key === 'SIZE_CLASS_LABELS' ||
      key === 'SCOPE_JSON'
    ) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function setEnv(overrides: Record<string, string> = {}): void {
  process.env.GH_WEBHOOK_SECRET_ARN = SECRET_ARN;
  process.env.QUEUE_URL = QUEUE_URL;
  process.env.SIZE_CLASS_LABELS = JSON.stringify(['microvm', 'microvm-8gb']);
  // Every fixture below is under `acme`. Individual scope tests override this.
  process.env.SCOPE_JSON = JSON.stringify({ kind: 'org', org: 'acme' });
  Object.assign(process.env, overrides);
}

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function makeEvent(
  body: string,
  opts: {
    event?: string;
    signature?: string;
    base64?: boolean;
  } = {},
): {
  headers: Record<string, string | undefined>;
  body: string;
  isBase64Encoded: boolean;
} {
  const rawBody = opts.base64
    ? Buffer.from(body, 'utf8').toString('base64')
    : body;
  return {
    headers: {
      'x-github-event': opts.event ?? 'workflow_job',
      'x-hub-signature-256': opts.signature ?? sign(body),
    },
    body: rawBody,
    isBase64Encoded: opts.base64 ?? false,
  };
}

function workflowJobPayload(overrides: {
  action: string;
  labels?: string[];
  runner_name?: string | null;
  id?: number;
  run_id?: number;
  repo?: string;
}): string {
  const {
    action,
    labels = ['self-hosted', 'microvm'],
    runner_name = null,
    id = 1001,
    run_id = 5001,
    repo = 'acme/widgets',
  } = overrides;
  return JSON.stringify({
    action,
    workflow_job: {
      id,
      run_id,
      labels,
      runner_name,
    },
    repository: {
      full_name: repo,
    },
  });
}

beforeEach(() => {
  resetEnv();
  setEnv();
  _resetCachesForTesting();
  smMock.reset();
  sqsMock.reset();
  smMock.on(GetSecretValueCommand).resolves({ SecretString: WEBHOOK_SECRET });
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'msg-1' });
});

describe('signature verification', () => {
  it('rejects a bad signature with 401 and sends nothing', async () => {
    const body = workflowJobPayload({ action: 'queued' });
    const event = makeEvent(body, { signature: 'sha256=' + '0'.repeat(64) });

    const res = await handler(event as never);

    expect(res.statusCode).toBe(401);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('rejects a same-length wrong signature with 401 (timing-safe compare)', async () => {
    const body = workflowJobPayload({ action: 'queued' });
    const correct = sign(body);
    // Flip one hex character, keeping length identical.
    const flipped = correct.slice(0, -1) + (correct.endsWith('0') ? '1' : '0');
    const event = makeEvent(body, { signature: flipped });

    const res = await handler(event as never);

    expect(res.statusCode).toBe(401);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('accepts a base64-encoded body that verifies correctly', async () => {
    const body = workflowJobPayload({
      action: 'queued',
      labels: ['self-hosted', 'microvm'],
    });
    const event = makeEvent(body, { base64: true });

    const res = await handler(event as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ queued: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it('fetches the webhook secret from Secrets Manager once and caches it', async () => {
    const body1 = workflowJobPayload({ action: 'queued' });
    const body2 = workflowJobPayload({ action: 'queued', id: 2002 });

    await handler(makeEvent(body1) as never);
    await handler(makeEvent(body2) as never);

    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });
});

describe('non-workflow_job events', () => {
  it('ignores a non-workflow_job event', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const event = makeEvent(body, { event: 'pull_request' });

    const res = await handler(event as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});

describe('action=queued', () => {
  it('sends a launch message when a label matches SIZE_CLASS_LABELS', async () => {
    const body = workflowJobPayload({
      action: 'queued',
      labels: ['self-hosted', 'microvm'],
      id: 1001,
      run_id: 5001,
      repo: 'acme/widgets',
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ queued: true });
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.QueueUrl).toBe(QUEUE_URL);
    const sentBody = JSON.parse(calls[0].args[0].input.MessageBody as string);
    expect(sentBody).toEqual({
      kind: 'launch',
      repo: 'acme/widgets',
      jobId: 1001,
      runId: 5001,
      labels: ['self-hosted', 'microvm'],
    });
  });

  it('matches a multi-label intersection with SIZE_CLASS_LABELS', async () => {
    setEnv({ SIZE_CLASS_LABELS: JSON.stringify(['microvm', 'microvm-8gb']) });
    const body = workflowJobPayload({
      action: 'queued',
      labels: ['self-hosted', 'microvm-8gb'],
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ queued: true });
    const calls = sqsMock.commandCalls(SendMessageCommand);
    const sentBody = JSON.parse(calls[0].args[0].input.MessageBody as string);
    expect(sentBody.labels).toEqual(['self-hosted', 'microvm-8gb']);
  });

  it('carries the FULL label set through, not just the matched size-class subset, so a runner registered with extra custom labels can still receive jobs declaring them', async () => {
    const body = workflowJobPayload({
      action: 'queued',
      labels: ['self-hosted', 'microvm', 'my-tool'],
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(200);
    const calls = sqsMock.commandCalls(SendMessageCommand);
    const sentBody = JSON.parse(calls[0].args[0].input.MessageBody as string);
    expect(sentBody.labels).toEqual(['self-hosted', 'microvm', 'my-tool']);
  });

  it('ignores when no label matches SIZE_CLASS_LABELS', async () => {
    const body = workflowJobPayload({
      action: 'queued',
      labels: ['self-hosted', 'linux', 'x64'],
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});

describe('action=completed', () => {
  it('sends a terminate message when runner_name starts with microvm-runner-', async () => {
    const body = workflowJobPayload({
      action: 'completed',
      runner_name: 'microvm-runner-x-123',
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(200);
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    const sentBody = JSON.parse(calls[0].args[0].input.MessageBody as string);
    expect(sentBody).toEqual({
      kind: 'terminate',
      runnerName: 'microvm-runner-x-123',
    });
  });

  it('ignores when runner_name is null (cancelled-while-queued)', async () => {
    const body = workflowJobPayload({
      action: 'completed',
      runner_name: null,
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('ignores when runner_name does not start with microvm-runner- (non-fleet runner)', async () => {
    const body = workflowJobPayload({
      action: 'completed',
      runner_name: 'some-other-runner-1',
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});

describe('other actions', () => {
  it('ignores in_progress', async () => {
    const body = workflowJobPayload({
      action: 'in_progress',
      runner_name: 'microvm-runner-x-123',
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('ignores waiting', async () => {
    const body = workflowJobPayload({ action: 'waiting' });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});

describe('SQS send failure', () => {
  it('rejects and logs structured context when SQS send fails', async () => {
    sqsMock.on(SendMessageCommand).rejects(new Error('boom'));
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const body = workflowJobPayload({
      action: 'queued',
      labels: ['self-hosted', 'microvm'],
      id: 1001,
      run_id: 5001,
      repo: 'acme/widgets',
    });
    const event = makeEvent(body);

    await expect(handler(event as never)).rejects.toThrow('boom');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'webhook: SQS send failed',
      expect.objectContaining({
        kind: 'launch',
        jobId: 1001,
        runnerName: undefined,
      }),
    );

    consoleErrorSpy.mockRestore();
  });
});

describe('malformed body', () => {
  it('returns 400 on malformed JSON after a valid signature', async () => {
    const body = '{not valid json';
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(400);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});

describe('malformed payload shape (valid JSON, wrong shape)', () => {
  it('returns 400 { error: "malformed payload" } when labels is not an array', async () => {
    const body = JSON.stringify({
      action: 'queued',
      workflow_job: {
        id: 1001,
        run_id: 5001,
        labels: 'oops',
        runner_name: null,
      },
      repository: { full_name: 'acme/widgets' },
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'malformed payload' });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('returns 400 { error: "malformed payload" } when workflow_job is missing entirely', async () => {
    const body = JSON.stringify({
      action: 'queued',
      repository: { full_name: 'acme/widgets' },
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'malformed payload' });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('returns 400 when action is not a string', async () => {
    const body = JSON.stringify({
      action: 123,
      workflow_job: {
        id: 1001,
        run_id: 5001,
        labels: ['microvm'],
        runner_name: null,
      },
      repository: { full_name: 'acme/widgets' },
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'malformed payload' });
  });

  it('returns 400 when workflow_job.id/run_id are not numeric', async () => {
    const body = JSON.stringify({
      action: 'queued',
      workflow_job: {
        id: '1001',
        run_id: 5001,
        labels: ['microvm'],
        runner_name: null,
      },
      repository: { full_name: 'acme/widgets' },
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'malformed payload' });
  });

  it('returns 400 when runner_name is neither a string nor null', async () => {
    const body = JSON.stringify({
      action: 'completed',
      workflow_job: {
        id: 1001,
        run_id: 5001,
        labels: ['microvm'],
        runner_name: 123,
      },
      repository: { full_name: 'acme/widgets' },
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'malformed payload' });
  });

  it('returns 400 when repository.full_name is missing on the queued path', async () => {
    const body = JSON.stringify({
      action: 'queued',
      workflow_job: {
        id: 1001,
        run_id: 5001,
        labels: ['microvm'],
        runner_name: null,
      },
      repository: {},
    });
    const event = makeEvent(body);

    const res = await handler(event as never);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'malformed payload' });
  });
});

describe('scope enforcement (the repository a delivery names must be one this runner set serves)', () => {
  // A correctly signed delivery proves only that GitHub sent it through this
  // App. The App can be installed on repositories beyond the configured list,
  // and on more than one organization, and every one of those deliveries
  // verifies. Before this check, any of them could consume the runner set.
  const signedQueuedEvent = (repo: string) => {
    const body = workflowJobPayload({
      action: 'queued',
      labels: ['self-hosted', 'microvm'],
      repo,
    });
    return makeEvent(body);
  };

  it('repos scope: a listed repository is queued', async () => {
    setEnv({
      SCOPE_JSON: JSON.stringify({
        kind: 'repos',
        repos: ['acme/widgets', 'acme/other'],
      }),
    });

    const res = await handler(signedQueuedEvent('acme/widgets') as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ queued: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it('repos scope: an UNLISTED repository under the same App installation is ignored, and nothing is enqueued', async () => {
    setEnv({
      SCOPE_JSON: JSON.stringify({ kind: 'repos', repos: ['acme/widgets'] }),
    });

    const res = await handler(signedQueuedEvent('acme/not-listed') as never);

    // 200 + ignored, not 4xx: a rejection would make GitHub retry a delivery
    // that can never be accepted, and would confirm to an unlisted repository
    // that it had found a live runner set.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
    // The assertion that matters: zero side effects.
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('repos scope: matching is case-insensitive, as GitHub is', async () => {
    setEnv({
      SCOPE_JSON: JSON.stringify({ kind: 'repos', repos: ['ACME/Widgets'] }),
    });

    const res = await handler(signedQueuedEvent('acme/widgets') as never);

    expect(JSON.parse(res.body)).toEqual({ queued: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it('org scope: a repository under a DIFFERENT owner is ignored — the App installed on a second org cannot borrow this runner set', async () => {
    setEnv({ SCOPE_JSON: JSON.stringify({ kind: 'org', org: 'acme' }) });

    const res = await handler(signedQueuedEvent('other-org/widgets') as never);

    expect(JSON.parse(res.body)).toEqual({ ignored: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('org scope: any repository under the configured org is queued', async () => {
    setEnv({ SCOPE_JSON: JSON.stringify({ kind: 'org', org: 'acme' }) });

    const res = await handler(signedQueuedEvent('acme/anything') as never);

    expect(JSON.parse(res.body)).toEqual({ queued: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  it('scope is checked BEFORE labels, so an out-of-scope repo is ignored even when its labels match', async () => {
    // Ordering matters for what an attacker learns: checking labels first
    // would let an out-of-scope repository probe which labels this runner set
    // serves by watching which deliveries behave differently.
    setEnv({
      SCOPE_JSON: JSON.stringify({ kind: 'repos', repos: ['acme/widgets'] }),
    });

    const matching = await handler(signedQueuedEvent('evil/repo') as never);
    const nonMatching = await handler(
      makeEvent(
        workflowJobPayload({
          action: 'queued',
          labels: ['self-hosted', 'not-a-class'],
          repo: 'evil/repo',
        }),
      ) as never,
    );

    expect(JSON.parse(matching.body)).toEqual({ ignored: true });
    expect(JSON.parse(nonMatching.body)).toEqual({ ignored: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});
