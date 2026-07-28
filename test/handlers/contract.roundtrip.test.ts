/**
 * SQS contract round-trip test — the webhook and launcher handlers are
 * tested in isolation everywhere else, each against a hand-written literal
 * `MessageBody`. This is the one test that exercises the actual seam
 * between them: invoke the webhook handler for real, CAPTURE the exact
 * `MessageBody` string it sends to SQS, then feed that exact string as an
 * SQS record body into the launcher handler. No shared literal — the real
 * output of one handler feeds the real input of the other, so a drift
 * between what webhook.ts sends and what launcher.ts expects fails here
 * even if both handlers' own unit tests still pass against their own
 * (possibly independently-drifted) fixtures.
 */
import { createHmac } from 'node:crypto';
import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';

jest.mock('../../src/handlers/shared/github-client.js', () => {
  const actual = jest.requireActual<
    typeof import('../../src/handlers/shared/github-client.js')
  >('../../src/handlers/shared/github-client.js');
  return {
    ...actual,
    generateJitConfig: jest.fn(),
  };
});

import {
  _resetCachesForTesting as resetLauncherCaches,
  handler as launcherHandler,
} from '../../src/handlers/launcher.js';
import { generateJitConfig } from '../../src/handlers/shared/github-client.js';
import {
  _resetCachesForTesting as resetWebhookCaches,
  handler as webhookHandler,
} from '../../src/handlers/webhook.js';

const smMock = mockClient(SecretsManagerClient);
const sqsMock = mockClient(SQSClient);
const ddbMock = mockClient(DynamoDBClient);
const mvmMock = mockClient(LambdaMicrovmsClient);
const generateJitConfigMock = jest.mocked(generateJitConfig);

const WEBHOOK_SECRET = 'whsec_test_secret';
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:1:secret:webhook';
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/1/queue';
const IMAGE_ARN_DEFAULT =
  'arn:aws:lambda:us-east-1:1:microvm-image:default-image';
const RUNNER_SET_VM_ROLE_ARN =
  'arn:aws:iam::1:role/microvm-runner-runner-set-x-vm-role';
const RUNNER_TABLE = 'microvm-runner-x-runners';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('GH_') ||
      [
        'QUEUE_URL',
        'SIZE_CLASS_LABELS',
        'SCOPE_JSON',
        'SIZE_CLASSES_JSON',
        'IMAGE_ARN',
        'RUNNER_SET_ID',
        'RUNNER_SET_VM_ROLE_ARN',
        'MAX_CONCURRENT',
        'MAX_JOB_DURATION_SECONDS',
        'RUNNER_TABLE',
        'EGRESS_CONNECTOR_ARNS',
        'AWS_REGION',
        'LOGGING_JSON',
      ].includes(key)
    ) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function setEnv(): void {
  // webhook.ts env
  process.env.GH_WEBHOOK_SECRET_ARN = SECRET_ARN;
  process.env.QUEUE_URL = QUEUE_URL;
  process.env.SIZE_CLASS_LABELS = JSON.stringify(['microvm']);

  // launcher.ts env
  process.env.RUNNER_SET_ID = 'x';
  process.env.RUNNER_SET_VM_ROLE_ARN = RUNNER_SET_VM_ROLE_ARN;
  process.env.MAX_CONCURRENT = '5';
  process.env.MAX_JOB_DURATION_SECONDS = '3600';
  process.env.SIZE_CLASSES_JSON = JSON.stringify({
    microvm: { imageArn: IMAGE_ARN_DEFAULT },
  });
  process.env.IMAGE_ARN = IMAGE_ARN_DEFAULT;
  process.env.SCOPE_JSON = JSON.stringify({ kind: 'org', org: 'acme' });
  process.env.RUNNER_TABLE = RUNNER_TABLE;
  process.env.AWS_REGION = 'us-east-1';
  process.env.LOGGING_JSON = JSON.stringify({ kind: 'cloudWatch' });
}

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function makeWebhookEvent(
  body: string,
  eventType: string,
): { headers: Record<string, string>; body: string; isBase64Encoded: boolean } {
  return {
    headers: {
      'x-github-event': eventType,
      'x-hub-signature-256': sign(body),
    },
    body,
    isBase64Encoded: false,
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
    workflow_job: { id, run_id, labels, runner_name },
    repository: { full_name: repo },
  });
}

/** Capture the exact `MessageBody` string webhook.ts sent to SQS, as an SQS record ready to feed to launcher.ts. */
function capturedMessageBodyAsSqsRecord(messageId: string): SQSRecord {
  const calls = sqsMock.commandCalls(SendMessageCommand);
  const body = calls[calls.length - 1].args[0].input.MessageBody as string;
  return {
    messageId,
    body,
    receiptHandle: `receipt-${messageId}`,
    attributes: {} as never,
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:1:queue',
    awsRegion: 'us-east-1',
  };
}

beforeEach(() => {
  resetEnv();
  setEnv();
  resetWebhookCaches();
  resetLauncherCaches();

  smMock.reset();
  sqsMock.reset();
  ddbMock.reset();
  mvmMock.reset();
  generateJitConfigMock.mockReset();

  smMock.on(GetSecretValueCommand).resolves({ SecretString: WEBHOOK_SECRET });
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'msg-1' });
  generateJitConfigMock.mockResolvedValue('encoded-jit-config-blob');
  mvmMock.on(ListMicrovmsCommand).resolves({ items: [] });
  mvmMock.on(RunMicrovmCommand).resolves({
    microvmId: 'mvm-123',
    state: 'PENDING',
    endpoint: 'mvm-123.lambda-microvm.us-east-1.on.aws',
    imageArn: IMAGE_ARN_DEFAULT,
    imageVersion: '1',
    maximumDurationInSeconds: 3900,
    startedAt: new Date(),
  });
  mvmMock.on(GetMicrovmCommand).resolves({
    microvmId: 'mvm-123',
    state: 'RUNNING',
    endpoint: 'mvm-123.lambda-microvm.us-east-1.on.aws',
    imageArn: IMAGE_ARN_DEFAULT,
    imageVersion: '1',
    maximumDurationInSeconds: 3900,
    startedAt: new Date(),
  });
  mvmMock.on(CreateMicrovmAuthTokenCommand).resolves({
    authToken: { 'X-aws-proxy-auth': 'test-auth-token' },
  });
  mvmMock.on(TerminateMicrovmCommand).resolves({});
  globalThis.fetch = jest
    .fn()
    .mockResolvedValue(
      new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
  ddbMock.on(PutItemCommand).resolves({});
  ddbMock.on(DeleteItemCommand).resolves({});
  ddbMock.on(TransactWriteItemsCommand).resolves({});
});

describe('webhook -> launcher SQS contract round-trip', () => {
  it('queued workflow_job: the exact MessageBody webhook.ts sends launches successfully when fed to launcher.ts', async () => {
    const body = workflowJobPayload({
      action: 'queued',
      labels: ['self-hosted', 'microvm', 'my-tool'],
      id: 42,
      run_id: 99,
      repo: 'acme/widgets',
    });
    const webhookRes = await webhookHandler(
      makeWebhookEvent(body, 'workflow_job') as never,
    );
    expect(webhookRes.statusCode).toBe(200);
    expect(JSON.parse(webhookRes.body)).toEqual({ queued: true });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);

    const record = capturedMessageBodyAsSqsRecord('m1');
    // Sanity: the captured body really does carry the full label set, not a
    // hand-written stand-in.
    const parsedBody = JSON.parse(record.body) as { labels: string[] };
    expect(parsedBody.labels).toEqual(['self-hosted', 'microvm', 'my-tool']);

    const launcherRes = await launcherHandler(
      { Records: [record] } as SQSEvent,
      {} as never,
      undefined as never,
    );

    expect(launcherRes).toEqual({ batchItemFailures: [] });
    const runCalls = mvmMock.commandCalls(RunMicrovmCommand);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].args[0].input.imageIdentifier).toBe(IMAGE_ARN_DEFAULT);
    expect(generateJitConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { org: 'acme' },
        labels: ['self-hosted', 'microvm', 'my-tool'],
      }),
    );
    // One PutItem: the job-claim row (written before any side effect, see
    // launcher.ts's job-claim idempotency mechanism). The runner mapping row
    // and the claim's microvmId stamp land together in a single atomic
    // TransactWriteItems (see launcher.ts's `commitLaunch`).
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
  });

  it('completed workflow_job: the exact MessageBody webhook.ts sends terminates successfully when fed to launcher.ts', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({
        runnerName: 'microvm-runner-x-abc12345',
        microvmId: 'mvm-999',
        repo: 'acme/widgets',
        jobId: 1001,
        launchedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 999_999,
      }),
    });

    const body = workflowJobPayload({
      action: 'completed',
      runner_name: 'microvm-runner-x-abc12345',
    });
    const webhookRes = await webhookHandler(
      makeWebhookEvent(body, 'workflow_job') as never,
    );
    expect(webhookRes.statusCode).toBe(200);
    expect(JSON.parse(webhookRes.body)).toEqual({ terminated: true });

    const record = capturedMessageBodyAsSqsRecord('m2');
    const parsedBody = JSON.parse(record.body) as {
      kind: string;
      runnerName: string;
    };
    expect(parsedBody).toEqual({
      kind: 'terminate',
      runnerName: 'microvm-runner-x-abc12345',
    });

    const launcherRes = await launcherHandler(
      { Records: [record] } as SQSEvent,
      {} as never,
      undefined as never,
    );

    expect(launcherRes).toEqual({ batchItemFailures: [] });
    const termCalls = mvmMock.commandCalls(TerminateMicrovmCommand);
    expect(termCalls).toHaveLength(1);
    expect(termCalls[0].args[0].input.microvmIdentifier).toBe('mvm-999');
    const delCalls = ddbMock.commandCalls(DeleteItemCommand);
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0].args[0].input.Key?.runnerName?.S).toBe(
      'microvm-runner-x-abc12345',
    );
  });
});
