import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
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
    getWorkflowJob: jest.fn(),
  };
});

import {
  _resetCachesForTesting,
  handler,
} from '../../src/handlers/launcher.js';
import {
  generateJitConfig,
  getWorkflowJob,
  RetryableError,
} from '../../src/handlers/shared/github-client.js';
import { RUNNER_NAME_PREFIX } from '../../src/handlers/shared/runner-naming.js';

const mvmMock = mockClient(LambdaMicrovmsClient);
const ddbMock = mockClient(DynamoDBClient);
const generateJitConfigMock = jest.mocked(generateJitConfig);
const getWorkflowJobMock = jest.mocked(getWorkflowJob);

const ORIGINAL_ENV = { ...process.env };
const NOW_MS = Date.parse('2026-07-18T12:00:00.000Z');

const IMAGE_ARN_DEFAULT =
  'arn:aws:lambda:us-east-1:1:microvm-image:default-image';
const IMAGE_ARN_8GB = 'arn:aws:lambda:us-east-1:1:microvm-image:8gb-image';
const RUNNER_SET_VM_ROLE_ARN =
  'arn:aws:iam::1:role/runners-runner-set-x-vm-role';
const RUNNER_TABLE = 'runners-runner-set-x-runners';
const VM_ENDPOINT = 'mvm-123.lambda-microvm.us-east-1.on.aws';
const AUTH_TOKEN = 'test-auth-token';

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('GH_') ||
      [
        'RUNNER_SET_ID',
        'RUNNER_SET_VM_ROLE_ARN',
        'MAX_CONCURRENT',
        'MAX_JOB_DURATION_SECONDS',
        'SIZE_CLASSES_JSON',
        'IMAGE_ARN',
        'SCOPE_JSON',
        'RUNNER_TABLE',
        'EGRESS_CONNECTOR_ARNS',
        'AWS_REGION',
        'LOGGING_JSON',
        'WARM_POOL_JSON',
        'IDLE_POLICY_JSON',
      ].includes(key)
    ) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function setEnv(overrides: Record<string, string> = {}): void {
  process.env.RUNNER_SET_ID = 'x';
  process.env.RUNNER_SET_VM_ROLE_ARN = RUNNER_SET_VM_ROLE_ARN;
  process.env.MAX_CONCURRENT = '5';
  process.env.MAX_JOB_DURATION_SECONDS = '3600';
  process.env.SIZE_CLASSES_JSON = JSON.stringify({
    microvm: { imageArn: IMAGE_ARN_DEFAULT },
    'microvm-8gb': { imageArn: IMAGE_ARN_8GB },
  });
  process.env.IMAGE_ARN = IMAGE_ARN_DEFAULT;
  process.env.SCOPE_JSON = JSON.stringify({ kind: 'org', org: 'acme' });
  process.env.RUNNER_TABLE = RUNNER_TABLE;
  process.env.AWS_REGION = 'us-east-1';
  process.env.LOGGING_JSON = JSON.stringify({ kind: 'cloudWatch' });
  // Metric emission is opt-in (`GithubMicrovmRunnersProps.emitMetrics` ->
  // `EMIT_METRICS`, gated in `shared/emf.ts`'s `emitEmf`). The EMF assertions
  // below exercise the enabled path, so turn it on here; a dedicated test
  // covers the default-off no-op.
  process.env.EMIT_METRICS = 'true';
  Object.assign(process.env, overrides);
}

function sqsRecord(messageId: string, body: unknown): SQSRecord {
  return {
    messageId,
    body: JSON.stringify(body),
    receiptHandle: `receipt-${messageId}`,
    attributes: {} as never,
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:1:queue',
    awsRegion: 'us-east-1',
  };
}

function batchEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

function launchMessage(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'launch',
    repo: 'acme/widgets',
    jobId: 1001,
    runId: 5001,
    labels: ['microvm'],
    ...overrides,
  };
}

function terminateMessage(runnerName: string) {
  return { kind: 'terminate', runnerName };
}

let fetchMock: jest.Mock<Promise<Response>, unknown[]>;

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  resetEnv();
  setEnv();
  _resetCachesForTesting();
  mvmMock.reset();
  ddbMock.reset();
  generateJitConfigMock.mockReset();
  generateJitConfigMock.mockResolvedValue('encoded-jit-config-blob');
  // Default: the job is still waiting for a runner, so every pre-existing test
  // launches exactly as it did before the pre-launch check was added.
  getWorkflowJobMock.mockReset();
  getWorkflowJobMock.mockResolvedValue({
    status: 'queued',
    labels: ['self-hosted', 'microvm'],
    runId: 1,
  });
  mvmMock.on(ListMicrovmsCommand).resolves({ items: [] });
  mvmMock.on(RunMicrovmCommand).resolves({
    microvmId: 'mvm-123',
    state: 'PENDING',
    endpoint: VM_ENDPOINT,
    imageArn: IMAGE_ARN_DEFAULT,
    imageVersion: '1',
    maximumDurationInSeconds: 3900,
    startedAt: new Date(NOW_MS),
  });
  // Default GetMicrovm sequence: RUNNING on the very first poll, so
  // `waitForMicrovmRunning` resolves without needing a fake-timer advance in
  // tests that don't care about the polling loop itself.
  mvmMock.on(GetMicrovmCommand).resolves({
    microvmId: 'mvm-123',
    state: 'RUNNING',
    endpoint: VM_ENDPOINT,
    imageArn: IMAGE_ARN_DEFAULT,
    imageVersion: '1',
    maximumDurationInSeconds: 3900,
    startedAt: new Date(NOW_MS),
  });
  mvmMock.on(CreateMicrovmAuthTokenCommand).resolves({
    authToken: { 'X-aws-proxy-auth': AUTH_TOKEN },
  });
  fetchMock = jest
    .fn<Promise<Response>, unknown[]>()
    .mockResolvedValue(jsonResponse(200));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  ddbMock.on(PutItemCommand).resolves({});
  ddbMock.on(DeleteItemCommand).resolves({});
  ddbMock.on(TransactWriteItemsCommand).resolves({});
  jest.useFakeTimers();
  jest.setSystemTime(NOW_MS);
});

describe('launch: happy path', () => {
  it('calls RunMicrovm with the ALL_INGRESS connector (no runHookPayload), waits for RUNNING, mints an auth token, and pushes the JIT config to the ingress endpoint before PutItems the mapping with TTL', async () => {
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });

    const runCalls = mvmMock.commandCalls(RunMicrovmCommand);
    expect(runCalls).toHaveLength(1);
    const runInput = runCalls[0].args[0].input;
    expect(runInput.imageIdentifier).toBe(IMAGE_ARN_DEFAULT);
    // Opt-in path: this suite's beforeEach sets RUNNER_SET_VM_ROLE_ARN, so the
    // launcher passes it through. The powerless default (env unset ⇒
    // executionRoleArn undefined) is covered by its own test below.
    expect(runInput.executionRoleArn).toBe(RUNNER_SET_VM_ROLE_ARN);
    expect(runInput.maximumDurationInSeconds).toBe(3600 + 300);
    expect(runInput.ingressNetworkConnectors).toEqual([
      'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS',
    ]);
    expect(runInput.egressNetworkConnectors).toBeUndefined();
    expect(runInput).not.toHaveProperty('runHookPayload');
    // A cloudWatch LOGGING_JSON (console capture on, no custom group) maps to
    // the platform-default CloudWatch logging block — and the logGroup KEY must
    // be genuinely absent, not present-with-undefined (`.toEqual` alone
    // cannot tell those apart; the idlePolicy incident showed the
    // difference can be a live ValidationException).
    expect(runInput.logging).toEqual({ cloudWatch: {} });
    expect(runInput.logging?.cloudWatch).not.toHaveProperty('logGroup');
    expect(Object.keys(runInput.logging?.cloudWatch ?? {})).toEqual([]);

    // waitForMicrovmRunning: at least one GetMicrovm poll.
    expect(
      mvmMock.commandCalls(GetMicrovmCommand).length,
    ).toBeGreaterThanOrEqual(1);
    expect(mvmMock.commandCalls(GetMicrovmCommand)[0].args[0].input).toEqual({
      microvmIdentifier: 'mvm-123',
    });

    // createMicrovmAuthToken(id, 5, 8080).
    const authCalls = mvmMock.commandCalls(CreateMicrovmAuthTokenCommand);
    expect(authCalls).toHaveLength(1);
    expect(authCalls[0].args[0].input).toEqual({
      microvmIdentifier: 'mvm-123',
      expirationInMinutes: 5,
      allowedPorts: [{ port: 8080 }],
    });

    // The JIT config push: exact-path POST to the VM's ingress endpoint,
    // the auth token in X-aws-proxy-auth, jitConfig in the JSON body.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(fetchUrl).toBe(
      `https://${VM_ENDPOINT}/aws/lambda-microvms/runtime/v1/run`,
    );
    expect(fetchInit.method).toBe('POST');
    expect(
      (fetchInit.headers as Record<string, string>)['X-aws-proxy-auth'],
    ).toBe(AUTH_TOKEN);
    expect(JSON.parse(fetchInit.body as string)).toEqual({
      jitConfig: 'encoded-jit-config-blob',
    });

    expect(generateJitConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { org: 'acme' },
        labels: ['microvm'],
        runnerName: expect.stringMatching(/^microvm-runner-x-[0-9a-f]{8}$/),
      }),
    );

    // One PutItem call: the job-claim row, written before any side effect
    // (the RunMicrovm/mapping side effects happen after the claim is held).
    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);

    const claimCall = putCalls.find(
      (c) => c.args[0].input.Item?.runnerName?.S === 'job#acme/widgets#1001',
    );
    expect(claimCall).toBeDefined();
    expect(claimCall?.args[0].input.Item?.microvmId?.S).toBe('pending');
    expect(claimCall?.args[0].input.ConditionExpression).toBe(
      'attribute_not_exists(runnerName)',
    );

    // The runner mapping row and the claim's microvmId stamp are committed
    // together in a SINGLE atomic TransactWriteItems — never as two
    // independent writes (see `commitLaunch` in launcher.ts for why: a
    // split write left a window where a valid mapping+VM existed but the
    // claim stayed 'pending' forever).
    const txnCalls = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(txnCalls).toHaveLength(1);
    const txnItems = txnCalls[0].args[0].input.TransactItems ?? [];
    expect(txnItems).toHaveLength(2);

    const mappingPut = txnItems.find((t) => t.Put)?.Put;
    expect(mappingPut).toBeDefined();
    expect(mappingPut?.TableName).toBe(RUNNER_TABLE);
    expect(mappingPut?.Item?.microvmId?.S).toBe('mvm-123');
    expect(mappingPut?.Item?.repo?.S).toBe('acme/widgets');
    expect(mappingPut?.Item?.jobId?.N).toBe('1001');
    expect(mappingPut?.Item?.launchedAt?.S).toBe('2026-07-18T12:00:00.000Z');
    // TTL = launch epoch secs + MAX_JOB_DURATION_SECONDS + 3600 grace.
    const expectedExpiresAt = Math.floor(NOW_MS / 1000) + 3600 + 3600;
    expect(mappingPut?.Item?.expiresAt?.N).toBe(String(expectedExpiresAt));

    const claimUpdate = txnItems.find((t) => t.Update)?.Update;
    expect(claimUpdate).toBeDefined();
    expect(claimUpdate?.TableName).toBe(RUNNER_TABLE);
    expect(claimUpdate?.Key?.runnerName?.S).toBe('job#acme/widgets#1001');
    expect(claimUpdate?.ConditionExpression).toBe('attemptToken = :mine');
    expect(claimUpdate?.ExpressionAttributeValues?.[':m'].S).toBe('mvm-123');
  });

  it('powerless VM: with RUNNER_SET_VM_ROLE_ARN unset, RunMicrovm carries NO executionRoleArn', async () => {
    delete process.env.RUNNER_SET_VM_ROLE_ARN;
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    const runCalls = mvmMock.commandCalls(RunMicrovmCommand);
    expect(runCalls).toHaveLength(1);
    // No AWS identity ⇒ IMDS serves no role credentials to job code.
    expect(runCalls[0].args[0].input.executionRoleArn).toBeUndefined();
  });

  it('CRITICAL: a cloudWatch LOGGING_JSON reaching a role-free VM (RUNNER_SET_VM_ROLE_ARN unset) -> RunMicrovm carries NO logging field at all — the defensive gate (the platform rejects RunMicrovm with cloudWatch logging + no executionRoleArn)', async () => {
    delete process.env.RUNNER_SET_VM_ROLE_ARN;
    // The construct only emits a cloudWatch LOGGING_JSON alongside a role
    // (consoleLogs requires vmExecutionRole), so this pairing should not arise
    // in practice; resolveRuntimeLogging still guards it defensively. This must
    // NOT crash and must NOT emit a cloudWatch logging block.
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    const runInput = mvmMock.commandCalls(RunMicrovmCommand)[0].args[0].input;
    // Key-absence, not value-undefined: the logging KEY itself must be off
    // the request object (toBeUndefined() passes for `logging: undefined`,
    // which is a different wire shape for a required-keyed member).
    expect(runInput).not.toHaveProperty('logging');
  });

  it('LOGGING_JSON kind "disabled" -> RunMicrovm carries logging: { disabled: {} }', async () => {
    setEnv({ LOGGING_JSON: JSON.stringify({ kind: 'disabled' }) });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    await handler(event, {} as never, undefined as never);

    const runInput = mvmMock.commandCalls(RunMicrovmCommand)[0].args[0].input;
    expect(runInput.logging).toEqual({ disabled: {} });
  });

  it('LOGGING_JSON carrying a logGroupName -> RunMicrovm carries logging: { cloudWatch: { logGroup } }', async () => {
    setEnv({
      LOGGING_JSON: JSON.stringify({
        kind: 'cloudWatch',
        logGroupName: '/my/custom/group',
      }),
    });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    await handler(event, {} as never, undefined as never);

    const runInput = mvmMock.commandCalls(RunMicrovmCommand)[0].args[0].input;
    expect(runInput.logging).toEqual({
      cloudWatch: { logGroup: '/my/custom/group' },
    });
  });

  it('resolves egress connectors from EGRESS_CONNECTOR_ARNS when set', async () => {
    setEnv({
      EGRESS_CONNECTOR_ARNS: JSON.stringify([
        'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:egress-1',
      ]),
    });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    await handler(event, {} as never, undefined as never);

    const runInput = mvmMock.commandCalls(RunMicrovmCommand)[0].args[0].input;
    expect(runInput.egressNetworkConnectors).toEqual([
      'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:egress-1',
    ]);
  });

  it('uses repos scope target parsed from message.repo when SCOPE_JSON kind=repos', async () => {
    setEnv({
      SCOPE_JSON: JSON.stringify({ kind: 'repos', repos: ['acme/widgets'] }),
    });
    const event = batchEvent([
      sqsRecord('m1', launchMessage({ repo: 'acme/widgets' })),
    ]);

    await handler(event, {} as never, undefined as never);

    expect(generateJitConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: { owner: 'acme', repo: 'widgets' } }),
    );
  });

  it('selects the last matching SIZE_CLASSES_JSON key when multiple labels match (largest wins)', async () => {
    const event = batchEvent([
      sqsRecord('m1', launchMessage({ labels: ['microvm', 'microvm-8gb'] })),
    ]);

    await handler(event, {} as never, undefined as never);

    const runInput = mvmMock.commandCalls(RunMicrovmCommand)[0].args[0].input;
    expect(runInput.imageIdentifier).toBe(IMAGE_ARN_8GB);
  });

  it('falls back to IMAGE_ARN when no job label matches a configured size class', async () => {
    const event = batchEvent([
      sqsRecord('m1', launchMessage({ labels: ['self-hosted'] })),
    ]);

    await handler(event, {} as never, undefined as never);

    const runInput = mvmMock.commandCalls(RunMicrovmCommand)[0].args[0].input;
    expect(runInput.imageIdentifier).toBe(IMAGE_ARN_DEFAULT);
  });

  it('cold launch for a matched size class WITH an idlePolicy carries the mapped idlePolicy on RunMicrovm', async () => {
    setEnv({
      IDLE_POLICY_JSON: JSON.stringify({
        microvm: {
          maxIdleDurationSeconds: 300,
          suspendedDurationSeconds: 3600,
          autoResumeEnabled: true,
        },
      }),
    });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    await handler(event, {} as never, undefined as never);

    const runInput = mvmMock.commandCalls(RunMicrovmCommand)[0].args[0].input;
    expect(runInput.idlePolicy).toEqual({
      maxIdleDurationSeconds: 300,
      suspendedDurationSeconds: 3600,
      autoResumeEnabled: true,
    });
  });

  it('cold launch for a matched size class with NO idlePolicy carries no idlePolicy field on RunMicrovm', async () => {
    setEnv({
      IDLE_POLICY_JSON: JSON.stringify({
        'microvm-8gb': { maxIdleDurationSeconds: 300 },
      }),
    });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    await handler(event, {} as never, undefined as never);

    const runInput = mvmMock.commandCalls(RunMicrovmCommand)[0].args[0].input;
    expect(runInput).not.toHaveProperty('idlePolicy');
  });

  it('cold launch when IDLE_POLICY_JSON is entirely unset carries no idlePolicy field (byte-identical default)', async () => {
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    await handler(event, {} as never, undefined as never);

    const runInput = mvmMock.commandCalls(RunMicrovmCommand)[0].args[0].input;
    expect(runInput).not.toHaveProperty('idlePolicy');
  });
});

describe('launch: warm pool', () => {
  const WARM_VM_ID = 'warm-vm-1';

  /** Mocks `ListMicrovmsCommand` (used by both the capacity check and `listSuspendedVmsForImage`) to return exactly one SUSPENDED candidate on the default image. */
  function warmSuspendedListing(): void {
    mvmMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: WARM_VM_ID,
          state: 'SUSPENDED',
          imageArn: IMAGE_ARN_DEFAULT,
          imageVersion: '1',
          startedAt: new Date(NOW_MS),
        },
      ],
    });
  }

  it('(a) resumes and injects an available warm VM when WARM_POOL_JSON targets the matched label — does not call RunMicrovm, writes the runner row', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 3 }) });
    warmSuspendedListing();
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(0);

    // The warm-VM claim: a conditional PutItem keyed on `warmvm#<id>`.
    const claimCalls = ddbMock
      .commandCalls(PutItemCommand)
      .filter(
        (c) => c.args[0].input.Item?.runnerName?.S === `warmvm#${WARM_VM_ID}`,
      );
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0].args[0].input.ConditionExpression).toBe(
      'attribute_not_exists(runnerName)',
    );

    const resumeCalls = mvmMock.commandCalls(ResumeMicrovmCommand);
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0].args[0].input.microvmIdentifier).toBe(WARM_VM_ID);

    // JIT gen + push happen exactly once, for the warm VM.
    expect(generateJitConfigMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The runner row maps to the WARM VM's id, not a cold-launched one.
    const txnCalls = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(txnCalls).toHaveLength(1);
    const mappingPut = txnCalls[0].args[0].input.TransactItems?.find(
      (t) => t.Put,
    )?.Put;
    expect(mappingPut?.Item?.microvmId?.S).toBe(WARM_VM_ID);
  });

  it('(b) falls back to cold RunMicrovm when no warm VM is available (empty SUSPENDED listing)', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 3 }) });
    // beforeEach already defaults ListMicrovmsCommand to `{ items: [] }`.
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(ResumeMicrovmCommand)).toHaveLength(0);
    const runCalls = mvmMock.commandCalls(RunMicrovmCommand);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].args[0].input.imageIdentifier).toBe(IMAGE_ARN_DEFAULT);
  });

  it('(c) falls back to cold RunMicrovm when the only candidate loses its warm-VM claim', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 3 }) });
    warmSuspendedListing();
    ddbMock.on(PutItemCommand).callsFake((input) => {
      const runnerName = input.Item?.runnerName?.S ?? '';
      if (runnerName.startsWith('warmvm#')) {
        throw Object.assign(new Error('claim exists'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      return {};
    });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(ResumeMicrovmCommand)).toHaveLength(0);
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);
  });

  it('(d) skips the warm path entirely when WARM_POOL_JSON lacks the matched label — cold path only', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ 'microvm-8gb': 5 }) });
    warmSuspendedListing();
    const event = batchEvent([sqsRecord('m1', launchMessage())]); // labels: ['microvm']

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(ResumeMicrovmCommand)).toHaveLength(0);
    // Only the capacity check's ListMicrovms call — listSuspendedVmsForImage
    // is never reached because the warm-path guard short-circuits first.
    expect(mvmMock.commandCalls(ListMicrovmsCommand)).toHaveLength(1);
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);
  });

  it('(e) a warm-path failure mid-attempt (resumeMicrovm throws) compensates with a best-effort terminate of the claimed VM, then falls back to cold — no crash', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 3 }) });
    warmSuspendedListing();
    mvmMock
      .on(ResumeMicrovmCommand)
      .rejects(new Error('resume failed: VM not resumable'));
    mvmMock.on(TerminateMicrovmCommand).resolves({});
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });

    // Compensating terminate for the claimed-but-never-resumed warm VM.
    const termCalls = mvmMock.commandCalls(TerminateMicrovmCommand);
    expect(
      termCalls.some((c) => c.args[0].input.microvmIdentifier === WARM_VM_ID),
    ).toBe(true);

    // The job still completes, via a fresh cold-launched VM.
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);
    // generateJitConfig was never reached in the doomed warm attempt (it
    // comes after resumeMicrovm in sequence) — only the cold path's own call.
    expect(generateJitConfigMock).toHaveBeenCalledTimes(1);
    const txnCalls = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(txnCalls).toHaveLength(1);
    const mappingPut = txnCalls[0].args[0].input.TransactItems?.find(
      (t) => t.Put,
    )?.Put;
    expect(mappingPut?.Item?.microvmId?.S).toBe('mvm-123');
  });

  it('(f) when the warm-path compensating terminate ALSO fails, the launcher still falls back to cold and completes the job (both failures logged, no crash)', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 3 }) });
    warmSuspendedListing();
    mvmMock
      .on(ResumeMicrovmCommand)
      .rejects(new Error('resume failed: VM not resumable'));
    mvmMock
      .on(TerminateMicrovmCommand)
      .rejects(new Error('terminate also failed'));
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);
    const txnCalls = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(txnCalls).toHaveLength(1);
    const mappingPut = txnCalls[0].args[0].input.TransactItems?.find(
      (t) => t.Put,
    )?.Put;
    expect(mappingPut?.Item?.microvmId?.S).toBe('mvm-123');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('warm-path compensating terminate failed'),
    );
    consoleErrorSpy.mockRestore();
  });

  it('(g) when pushJitConfig already succeeded (VM confirmed RUNNING + armed) but commitLaunch then throws AND the compensating terminate ALSO fails, the launcher does NOT cold-boot a second VM — it retains the claim and surfaces the error', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 3 }) });
    warmSuspendedListing();
    // pushJitConfig succeeds (default fetchMock resolves 200), but the
    // commitLaunch transaction throws.
    ddbMock.on(TransactWriteItemsCommand).rejects(new Error('txn failed'));
    mvmMock
      .on(TerminateMicrovmCommand)
      .rejects(new Error('terminate also failed'));
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    // The invocation surfaces the failure as a batch-item failure — it does
    // NOT swallow it and cold-boot a duplicate VM.
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });

    // The JIT config WAS pushed to the warm VM (confirmed armed) before the
    // failure — this is exactly the case that must not cold-boot a second
    // runner for the same job.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // No second VM was launched, and no cold JIT generation was attempted.
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(0);
    expect(generateJitConfigMock).toHaveBeenCalledTimes(1);

    // Compensating terminate WAS attempted (and failed) for the claimed VM.
    const termCalls = mvmMock.commandCalls(TerminateMicrovmCommand);
    expect(
      termCalls.some((c) => c.args[0].input.microvmIdentifier === WARM_VM_ID),
    ).toBe(true);

    // The job-launch claim is retained: no DeleteItem (release) was ever
    // issued for it.
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('claim retained after ambiguous compensation'),
    );
    consoleErrorSpy.mockRestore();
  });
});

describe('launch: per-launch metrics', () => {
  const WARM_VM_ID = 'warm-vm-metrics-1';

  /** Same shape as `warmSuspendedListing` in the warm-pool describe above — one SUSPENDED candidate on the default image. */
  function warmSuspendedListing(): void {
    mvmMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: WARM_VM_ID,
          state: 'SUSPENDED',
          imageArn: IMAGE_ARN_DEFAULT,
          imageVersion: '1',
          startedAt: new Date(NOW_MS),
        },
      ],
    });
  }

  /** Finds and parses the single EMF envelope (a `console.log` JSON line carrying `"_aws"`) among a log spy's calls. */
  function findEmfEnvelope(
    logSpy: ReturnType<typeof jest.spyOn>,
  ): Record<string, unknown> {
    const lines = logSpy.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .filter(
        (line: string) => typeof line === 'string' && line.includes('"_aws"'),
      );
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]) as Record<string, unknown>;
  }

  it('(a) warm-hit launch emits WarmHit:1 with the matched SizeClass and a numeric WarmSpinUpMs (no ColdSpinUpMs)', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 3 }) });
    warmSuspendedListing();
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    const parsed = findEmfEnvelope(logSpy);
    expect(parsed.RunnerSetId).toBe('x');
    expect(parsed.SizeClass).toBe('microvm');
    expect(parsed.WarmHit).toBe(1);
    expect(typeof parsed.WarmSpinUpMs).toBe('number');
    expect(parsed.ColdSpinUpMs).toBeUndefined();
    expect(parsed.ColdBoot).toBeUndefined();
    expect(parsed.WarmThrottled).toBeUndefined();
    logSpy.mockRestore();
  });

  it('(b) a cold launch (no warm pool configured) emits ColdBoot:1 with a numeric ColdSpinUpMs (no WarmSpinUpMs)', async () => {
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    const parsed = findEmfEnvelope(logSpy);
    expect(parsed.SizeClass).toBe('microvm');
    expect(parsed.ColdBoot).toBe(1);
    expect(typeof parsed.ColdSpinUpMs).toBe('number');
    expect(parsed.WarmSpinUpMs).toBeUndefined();
    expect(parsed.WarmHit).toBeUndefined();
    expect(parsed.WarmThrottled).toBeUndefined();
    logSpy.mockRestore();
  });

  it('(c) a warm attempt that fails on a throttle-classified error then cold-succeeds emits WarmThrottled:1 AND ColdBoot:1 with a numeric ColdSpinUpMs (no WarmSpinUpMs) in the same envelope', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 3 }) });
    warmSuspendedListing();
    const throttleErr = Object.assign(new Error('slow down'), {
      name: 'ThrottlingException',
    });
    mvmMock.on(ResumeMicrovmCommand).rejects(throttleErr);
    mvmMock.on(TerminateMicrovmCommand).resolves({});
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    // Cold fallback actually ran (one RunMicrovm call) and completed.
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);
    const parsed = findEmfEnvelope(logSpy);
    expect(parsed.SizeClass).toBe('microvm');
    expect(parsed.WarmThrottled).toBe(1);
    expect(parsed.ColdBoot).toBe(1);
    expect(typeof parsed.ColdSpinUpMs).toBe('number');
    expect(parsed.WarmSpinUpMs).toBeUndefined();
    expect(parsed.WarmHit).toBeUndefined();
    consoleErrorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('(d) a cold RunMicrovm ServiceQuotaExceededException emits CapacityRejected:1 with no WarmSpinUpMs/ColdSpinUpMs', async () => {
    const quotaErr = Object.assign(new Error('no capacity available'), {
      name: 'ServiceQuotaExceededException',
    });
    mvmMock.on(RunMicrovmCommand).rejects(quotaErr);
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    const parsed = findEmfEnvelope(logSpy);
    expect(parsed.SizeClass).toBe('microvm');
    expect(parsed.CapacityRejected).toBe(1);
    expect(parsed.WarmSpinUpMs).toBeUndefined();
    expect(parsed.ColdSpinUpMs).toBeUndefined();
    expect(parsed.ColdBoot).toBeUndefined();
    consoleErrorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('a job cancelled while queued is not launched at all', async () => {
    // GitHub reports a cancelled-while-queued job as `completed`. Nothing
    // should be booted for it: the webhook cannot send a terminate (the
    // completed event carries an EMPTY runner_name, since no runner ever
    // claimed the job), so a VM launched here would sit idle holding a
    // maxConcurrentVms slot until the janitor's idle rule reaps it 15-20
    // minutes later.
    getWorkflowJobMock.mockResolvedValue({
      status: 'completed',
      labels: ['self-hosted', 'microvm'],
      runId: 1,
    });
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    // Consumed, not re-driven: the job is gone, so retrying achieves nothing.
    expect(res).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(0);
    expect(generateJitConfigMock).not.toHaveBeenCalled();
    // No claim was written either — the slot is never taken.
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    const parsed = findEmfEnvelope(logSpy);
    expect(parsed.CancelledBeforeLaunch).toBe(1);
    expect(parsed.SizeClass).toBe('microvm');
    logSpy.mockRestore();
  });

  it('a job GitHub no longer knows about (404) is not launched', async () => {
    // getWorkflowJob returns undefined on a 404 — the job or its run was
    // deleted. There is nothing left to run.
    getWorkflowJobMock.mockResolvedValue(undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(0);
  });

  it('FAILS OPEN: a failed job check still launches', async () => {
    // The most important case in this file. If a rate limit or a transient
    // 5xx were read as "the job is gone", legitimate jobs would be silently
    // dropped and the symptom — a job that queues forever having never been
    // picked up — looks nothing like its cause. A launch that should have
    // been skipped costs one VM for a sweep or two; a job that should have
    // launched and did not costs a developer their afternoon.
    getWorkflowJobMock.mockRejectedValue(new Error('secondary rate limit'));
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);
    consoleErrorSpy.mockRestore();
  });

  it('a job still in_progress elsewhere is left to the launch claim', async () => {
    // in_progress means another runner already took it. That is a duplicate
    // delivery, which the launch claim already handles — this guard is only
    // for jobs nothing will ever run, so it stays out of the way.
    getWorkflowJobMock.mockResolvedValue({
      status: 'in_progress',
      labels: ['self-hosted', 'microvm'],
      runId: 1,
    });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    await handler(event, {} as never, undefined as never);

    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);
  });

  it('(d2) hitting maxConcurrentVms emits CapacityRejected:1 labelled with the size class', async () => {
    // The runner set's OWN ceiling, as distinct from the service-side quota
    // rejection in (d). This used to be silent: the launcher threw
    // RetryLaterError without emitting, so the most common cause of jobs
    // queueing — the cap the operator set — never reached the metric whose
    // documentation claimed to cover it.
    process.env.MAX_CONCURRENT = '1';
    // The capacity check counts RUNNING VMs on this runner set's image ARNs,
    // so the listed VM has to carry one to be counted at all.
    mvmMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: 'mvm-already-running',
          state: 'RUNNING',
          imageArn: IMAGE_ARN_DEFAULT,
          // listRunnerSetVms drops any item missing startedAt, so a fixture
          // without it is silently not counted.
          startedAt: new Date(NOW_MS),
        },
      ],
    } as never);
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    // Re-driven rather than dropped, so the job still runs once capacity frees.
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    const parsed = findEmfEnvelope(logSpy);
    expect(parsed.CapacityRejected).toBe(1);
    expect(parsed.SizeClass).toBe('microvm');
    // No VM was attempted, so neither terminal outcome is claimed.
    expect(parsed.ColdBoot).toBeUndefined();
    expect(parsed.WarmHit).toBeUndefined();
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(0);
    consoleErrorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('(f) WarmSpinUpMs/ColdSpinUpMs are tagged Unit: Milliseconds while counters stay Unit: Count', async () => {
    // Cold-boot envelope (default: no warm pool configured) carries
    // ColdSpinUpMs.
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    const parsed = findEmfEnvelope(logSpy) as {
      _aws: {
        CloudWatchMetrics: { Metrics: { Name: string; Unit: string }[] }[];
      };
    };
    const metrics = parsed._aws.CloudWatchMetrics[0]?.Metrics ?? [];
    const byName = Object.fromEntries(metrics.map((m) => [m.Name, m.Unit]));
    expect(byName.ColdSpinUpMs).toBe('Milliseconds');
    expect(byName.ColdBoot).toBe('Count');
    logSpy.mockRestore();
  });

  it('(g) a warm-hit envelope tags WarmSpinUpMs as Unit: Milliseconds', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 3 }) });
    warmSuspendedListing();
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    const parsed = findEmfEnvelope(logSpy) as {
      _aws: {
        CloudWatchMetrics: { Metrics: { Name: string; Unit: string }[] }[];
      };
    };
    const metrics = parsed._aws.CloudWatchMetrics[0]?.Metrics ?? [];
    const byName = Object.fromEntries(metrics.map((m) => [m.Name, m.Unit]));
    expect(byName.WarmSpinUpMs).toBe('Milliseconds');
    expect(byName.WarmHit).toBe('Count');
    logSpy.mockRestore();
  });

  it('(e) best-effort: a metric-emit failure (console.log throws) never throws out of handleLaunch — the launch still succeeds', async () => {
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation((msg?: unknown) => {
        if (typeof msg === 'string' && msg.includes('"_aws"')) {
          throw new Error('log sink unavailable');
        }
      });
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    // The launch itself still succeeds — no batch-item failure — despite
    // the metric emit throwing.
    expect(res).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
    logSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

describe('launch: at capacity', () => {
  it('reports a batch-item failure and never calls RunMicrovm when RUNNING runner set VMs >= MAX_CONCURRENT', async () => {
    mvmMock.on(ListMicrovmsCommand).resolves({
      items: Array.from({ length: 5 }, (_, i) => ({
        microvmId: `mvm-${i}`,
        state: 'RUNNING' as const,
        imageArn: IMAGE_ARN_DEFAULT,
        imageVersion: '1',
        startedAt: new Date(NOW_MS),
      })),
    });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('only counts VMs in this runner set (matching image ARNs), ignoring other runner sets and non-RUNNING states', async () => {
    mvmMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: 'other-runner-set',
          state: 'RUNNING',
          imageArn: 'arn:aws:lambda:us-east-1:1:microvm-image:other-runner-set',
          imageVersion: '1',
          startedAt: new Date(NOW_MS),
        },
        {
          microvmId: 'suspended-vm',
          state: 'SUSPENDED',
          imageArn: IMAGE_ARN_DEFAULT,
          imageVersion: '1',
          startedAt: new Date(NOW_MS),
        },
      ],
    });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);
  });
});

describe('launch: retryable failures', () => {
  it('maps a ThrottlingException from RunMicrovm to a batch-item failure, and releases the launch claim (no mapping row written)', async () => {
    const err = Object.assign(new Error('slow down'), {
      name: 'ThrottlingException',
    });
    mvmMock.on(RunMicrovmCommand).rejects(err);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    // The claim itself IS written (before any side effect); only a real
    // mapping row (a real microvmId, not 'pending') must never appear.
    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(
      putCalls.every((c) => c.args[0].input.Item?.microvmId?.S === 'pending'),
    ).toBe(true);
    // The claim is released (conditional DeleteItem) so a retry can
    // re-acquire cleanly instead of being permanently suppressed.
    const delCalls = ddbMock.commandCalls(DeleteItemCommand);
    const claimRelease = delCalls.find(
      (c) => c.args[0].input.Key?.runnerName?.S === 'job#acme/widgets#1001',
    );
    expect(claimRelease).toBeDefined();
    expect(claimRelease?.args[0].input.ConditionExpression).toBe(
      'attemptToken = :mine',
    );
  });

  it('maps a RetryableError from generateJitConfig to a batch-item failure without calling RunMicrovm, and releases the launch claim', async () => {
    generateJitConfigMock.mockRejectedValue(
      new RetryableError('rate limited', 30),
    );
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(0);
    const delCalls = ddbMock.commandCalls(DeleteItemCommand);
    expect(
      delCalls.some(
        (c) => c.args[0].input.Key?.runnerName?.S === 'job#acme/widgets#1001',
      ),
    ).toBe(true);
  });

  it('maps an unexpected error to a batch-item failure and logs it via console.error', async () => {
    generateJitConfigMock.mockRejectedValue(new Error('boom'));
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'launcher: unexpected error processing message',
      expect.objectContaining({ messageId: 'm1' }),
    );
    consoleErrorSpy.mockRestore();
  });
});

describe('launch: job-claim idempotency', () => {
  const CLAIM_KEY = 'job#acme/widgets#1001';

  function claimItemFixture(overrides: {
    microvmId?: string;
    launchedAt?: string;
    attemptToken?: string;
  }): Record<string, AttributeValue> {
    return marshall({
      runnerName: CLAIM_KEY,
      microvmId: overrides.microvmId ?? 'pending',
      repo: 'acme/widgets',
      jobId: 1001,
      launchedAt:
        overrides.launchedAt ?? new Date(NOW_MS - 10_000).toISOString(),
      expiresAt: 1234567890,
      attemptToken: overrides.attemptToken ?? 'existing-attempt-token',
    });
  }

  /** Simulates a table that already holds a claim for this job: the initial `attribute_not_exists` conditional PutItem always fails. */
  function rejectInitialClaimAcquire(): void {
    ddbMock.on(PutItemCommand).callsFake((input) => {
      if (input.ConditionExpression === 'attribute_not_exists(runnerName)') {
        throw Object.assign(new Error('claim exists'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      return {};
    });
  }

  it('(a) duplicate delivery AFTER a successful mapping (claim has a real microvmId) is suppressed — no second launch', async () => {
    rejectInitialClaimAcquire();
    ddbMock
      .on(GetItemCommand)
      .resolves({ Item: claimItemFixture({ microvmId: 'mvm-existing' }) });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(generateJitConfigMock).not.toHaveBeenCalled();
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(0);
  });

  it('(b) a generateJitConfig failure releases the claim (conditional DeleteItem keyed on our own launchedAt); a subsequent retry re-acquires and launches', async () => {
    generateJitConfigMock.mockRejectedValueOnce(new Error('jit boom'));
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res1 = await handler(event, {} as never, undefined as never);
    expect(res1).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });

    const release = ddbMock
      .commandCalls(DeleteItemCommand)
      .find((c) => c.args[0].input.Key?.runnerName?.S === CLAIM_KEY);
    expect(release).toBeDefined();
    expect(release?.args[0].input.ConditionExpression).toBe(
      'attemptToken = :mine',
    );

    generateJitConfigMock.mockResolvedValue('encoded-jit-config-blob');
    const res2 = await handler(event, {} as never, undefined as never);

    expect(res2).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);
  });

  it('(c) a RunMicrovm failure releases the claim; a subsequent retry re-acquires and launches', async () => {
    mvmMock.on(RunMicrovmCommand).rejects(new Error('run boom'));
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res1 = await handler(event, {} as never, undefined as never);
    expect(res1).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });

    const release = ddbMock
      .commandCalls(DeleteItemCommand)
      .find((c) => c.args[0].input.Key?.runnerName?.S === CLAIM_KEY);
    expect(release).toBeDefined();

    // Retry: RunMicrovm now succeeds — the claim was released, so this
    // attempt re-acquires cleanly and completes the launch.
    mvmMock.on(RunMicrovmCommand).resolves({
      microvmId: 'mvm-123',
      state: 'PENDING',
      endpoint: 'https://example.invalid',
      imageArn: IMAGE_ARN_DEFAULT,
      imageVersion: '1',
      maximumDurationInSeconds: 3900,
      startedAt: new Date(NOW_MS),
    });
    const res2 = await handler(event, {} as never, undefined as never);
    expect(res2).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(2);
  });

  it('(d) a launch-transaction failure with a successful compensating terminate releases the claim; a subsequent retry re-acquires and launches exactly once (no split-brain, no suppressed job)', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejectsOnce(
      Object.assign(new Error('transaction cancelled'), {
        name: 'TransactionCanceledException',
      }),
    );
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res1 = await handler(event, {} as never, undefined as never);

    expect(res1).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    // The transaction failing means NEITHER the mapping Put nor the claim
    // Update landed — only the compensating terminate ran.
    const termCalls = mvmMock.commandCalls(TerminateMicrovmCommand);
    expect(termCalls).toHaveLength(1);
    expect(termCalls[0].args[0].input.microvmIdentifier).toBe('mvm-123');

    const release = ddbMock
      .commandCalls(DeleteItemCommand)
      .find((c) => c.args[0].input.Key?.runnerName?.S === CLAIM_KEY);
    expect(release).toBeDefined();
    expect(release?.args[0].input.ConditionExpression).toBe(
      'attemptToken = :mine',
    );

    // Retry: the claim was released, so this attempt re-acquires cleanly
    // and RunMicrovm is called exactly once more (once total for this
    // retry) — end state is one launch per attempt, no suppressed job and
    // no second VM for the same job.
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);
    const res2 = await handler(event, {} as never, undefined as never);
    expect(res2).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(2);
  });

  it('(e) a launch-transaction failure where the compensating terminate ALSO fails retains the claim (ambiguous VM state), no re-acquire possible', async () => {
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejects(new Error('transaction failed'));
    mvmMock
      .on(TerminateMicrovmCommand)
      .rejects(new Error('terminate also failed'));
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    const release = ddbMock
      .commandCalls(DeleteItemCommand)
      .find((c) => c.args[0].input.Key?.runnerName?.S === CLAIM_KEY);
    expect(release).toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'launcher: launch claim retained after ambiguous compensation (terminate failed)',
      expect.objectContaining({ claimKey: CLAIM_KEY }),
    );
    consoleErrorSpy.mockRestore();
  });

  it('(h) waitForMicrovmRunning timing out (VM stuck PENDING) compensates via terminate + claim release and reports a batch failure', async () => {
    mvmMock.on(GetMicrovmCommand).resolves({
      microvmId: 'mvm-123',
      state: 'PENDING',
      endpoint: VM_ENDPOINT,
      imageArn: IMAGE_ARN_DEFAULT,
      imageVersion: '1',
      maximumDurationInSeconds: 3900,
      startedAt: new Date(NOW_MS),
    });
    mvmMock.on(TerminateMicrovmCommand).resolves({});
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const resultPromise = handler(event, {} as never, undefined as never);
    // The wait budget is 90_000ms; advance well past it so the polling loop
    // exhausts its budget and throws MicrovmWaitTimeoutError.
    await jest.advanceTimersByTimeAsync(95_000);
    const res = await resultPromise;

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    // Never reached token mint or push — the VM never left PENDING.
    expect(mvmMock.commandCalls(CreateMicrovmAuthTokenCommand)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const termCalls = mvmMock.commandCalls(TerminateMicrovmCommand);
    expect(termCalls).toHaveLength(1);
    expect(termCalls[0].args[0].input.microvmIdentifier).toBe('mvm-123');
    const release = ddbMock
      .commandCalls(DeleteItemCommand)
      .find((c) => c.args[0].input.Key?.runnerName?.S === CLAIM_KEY);
    expect(release).toBeDefined();
    // The mapping transaction never ran — no mapping for an unarmed VM.
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('(i) createMicrovmAuthToken failure compensates via terminate + claim release and reports a batch failure', async () => {
    mvmMock
      .on(CreateMicrovmAuthTokenCommand)
      .rejects(new Error('token mint failed'));
    mvmMock.on(TerminateMicrovmCommand).resolves({});
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(fetchMock).not.toHaveBeenCalled();
    const termCalls = mvmMock.commandCalls(TerminateMicrovmCommand);
    expect(termCalls).toHaveLength(1);
    expect(termCalls[0].args[0].input.microvmIdentifier).toBe('mvm-123');
    const release = ddbMock
      .commandCalls(DeleteItemCommand)
      .find((c) => c.args[0].input.Key?.runnerName?.S === CLAIM_KEY);
    expect(release).toBeDefined();
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('(j) a non-200 push response compensates via terminate + claim release and reports a batch failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500));
    mvmMock.on(TerminateMicrovmCommand).resolves({});
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    const termCalls = mvmMock.commandCalls(TerminateMicrovmCommand);
    expect(termCalls).toHaveLength(1);
    expect(termCalls[0].args[0].input.microvmIdentifier).toBe('mvm-123');
    const release = ddbMock
      .commandCalls(DeleteItemCommand)
      .find((c) => c.args[0].input.Key?.runnerName?.S === CLAIM_KEY);
    expect(release).toBeDefined();
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('(k) a network throw from the push fetch compensates via terminate + claim release and reports a batch failure', async () => {
    fetchMock.mockRejectedValue(new Error('network unreachable'));
    mvmMock.on(TerminateMicrovmCommand).resolves({});
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    const termCalls = mvmMock.commandCalls(TerminateMicrovmCommand);
    expect(termCalls).toHaveLength(1);
    expect(termCalls[0].args[0].input.microvmIdentifier).toBe('mvm-123');
    const release = ddbMock
      .commandCalls(DeleteItemCommand)
      .find((c) => c.args[0].input.Key?.runnerName?.S === CLAIM_KEY);
    expect(release).toBeDefined();
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('(f) a fresh pending claim (concurrent in-flight attempt) yields a batch failure — no launch, claim NOT deleted', async () => {
    rejectInitialClaimAcquire();
    ddbMock.on(GetItemCommand).resolves({
      Item: claimItemFixture({
        microvmId: 'pending',
        launchedAt: new Date(NOW_MS - 10_000).toISOString(), // 10s old, well under the 180s takeover window
      }),
    });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(generateJitConfigMock).not.toHaveBeenCalled();
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
  });

  it('(g) a stale pending claim (older than the 180s takeover window) is taken over and the launch proceeds', async () => {
    rejectInitialClaimAcquire();
    ddbMock.on(GetItemCommand).resolves({
      Item: claimItemFixture({
        microvmId: 'pending',
        launchedAt: new Date(NOW_MS - 181_000).toISOString(), // 181s old, past the window
      }),
    });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(generateJitConfigMock).toHaveBeenCalled();
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);

    const takeoverCall = ddbMock
      .commandCalls(PutItemCommand)
      .find(
        (c) => c.args[0].input.ConditionExpression === 'attemptToken = :old',
      );
    expect(takeoverCall).toBeDefined();
    expect(
      takeoverCall?.args[0].input.ExpressionAttributeValues?.[':old'].S,
    ).toBe('existing-attempt-token');
  });

  it('a generic (non-conditional-check) claim-write error is a batch failure with no launch attempted', async () => {
    ddbMock.on(PutItemCommand).callsFake((input) => {
      if (input.ConditionExpression === 'attribute_not_exists(runnerName)') {
        throw new Error('ddb unavailable');
      }
      return {};
    });
    const event = batchEvent([sqsRecord('m1', launchMessage())]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(generateJitConfigMock).not.toHaveBeenCalled();
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(0);
  });
});

describe('terminate', () => {
  it('terminates the mapped MicroVM and deletes the mapping for a known runnerName', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({
        runnerName: 'runners-x-abc12345',
        microvmId: 'mvm-999',
        repo: 'acme/widgets',
        jobId: 1001,
        launchedAt: '2026-07-18T11:00:00.000Z',
        expiresAt: 1234567890,
      }),
    });
    mvmMock.on(TerminateMicrovmCommand).resolves({});
    const event = batchEvent([
      sqsRecord('m1', terminateMessage('runners-x-abc12345')),
    ]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    const termCalls = mvmMock.commandCalls(TerminateMicrovmCommand);
    expect(termCalls).toHaveLength(1);
    expect(termCalls[0].args[0].input.microvmIdentifier).toBe('mvm-999');
    const delCalls = ddbMock.commandCalls(DeleteItemCommand);
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0].args[0].input.Key?.runnerName?.S).toBe(
      'runners-x-abc12345',
    );
  });

  it('resolves successfully for an unknown runnerName without calling TerminateMicrovm', async () => {
    ddbMock.on(GetItemCommand).resolves({});
    const event = batchEvent([
      sqsRecord('m1', terminateMessage('runners-x-unknown')),
    ]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
  });

  it('treats an already-terminated VM (ResourceNotFoundException) as success and still deletes the mapping', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({
        runnerName: 'runners-x-gone1234',
        microvmId: 'mvm-gone',
        repo: 'acme/widgets',
        jobId: 1002,
        launchedAt: '2026-07-18T11:00:00.000Z',
        expiresAt: 1234567890,
      }),
    });
    const notFound = Object.assign(new Error('no such microvm'), {
      name: 'ResourceNotFoundException',
    });
    mvmMock.on(TerminateMicrovmCommand).rejects(notFound);
    const event = batchEvent([
      sqsRecord('m1', terminateMessage('runners-x-gone1234')),
    ]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(1);
  });

  it('duplicate/late terminate delivery for an already-deleted mapping is idempotent success', async () => {
    ddbMock.on(GetItemCommand).resolves({});
    const event = batchEvent([
      sqsRecord('m1', terminateMessage('runners-x-abc12345')),
      sqsRecord('m2', terminateMessage('runners-x-abc12345')),
    ]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
  });

  it('still reports success when the best-effort DeleteItem fails after a successful terminate', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({
        runnerName: 'runners-x-abc12345',
        microvmId: 'mvm-999',
        repo: 'acme/widgets',
        jobId: 1001,
        launchedAt: '2026-07-18T11:00:00.000Z',
        expiresAt: 1234567890,
      }),
    });
    mvmMock.on(TerminateMicrovmCommand).resolves({});
    ddbMock.on(DeleteItemCommand).rejects(new Error('ddb unavailable'));
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = batchEvent([
      sqsRecord('m1', terminateMessage('runners-x-abc12345')),
    ]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'launcher: DeleteItem failed after terminate',
      expect.objectContaining({ runnerName: 'runners-x-abc12345' }),
    );
    consoleErrorSpy.mockRestore();
  });

  it('maps a non-NotFound TerminateMicrovm error to a batch-item failure', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({
        runnerName: 'runners-x-abc12345',
        microvmId: 'mvm-999',
        repo: 'acme/widgets',
        jobId: 1001,
        launchedAt: '2026-07-18T11:00:00.000Z',
        expiresAt: 1234567890,
      }),
    });
    mvmMock
      .on(TerminateMicrovmCommand)
      .rejects(new Error('internal service error'));
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = batchEvent([
      sqsRecord('m1', terminateMessage('runners-x-abc12345')),
    ]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
    consoleErrorSpy.mockRestore();
  });
});

describe('partial batch', () => {
  it('reports only the failed message id when one launch fails and one terminate succeeds', async () => {
    const err = Object.assign(new Error('slow down'), {
      name: 'ThrottlingException',
    });
    mvmMock.on(RunMicrovmCommand).rejects(err);
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({
        runnerName: 'runners-x-ok123456',
        microvmId: 'mvm-ok',
        repo: 'acme/widgets',
        jobId: 2001,
        launchedAt: '2026-07-18T11:00:00.000Z',
        expiresAt: 1234567890,
      }),
    });
    mvmMock.on(TerminateMicrovmCommand).resolves({});

    const event = batchEvent([
      sqsRecord('launch-fail', launchMessage()),
      sqsRecord('terminate-ok', terminateMessage('runners-x-ok123456')),
    ]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({
      batchItemFailures: [{ itemIdentifier: 'launch-fail' }],
    });
    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(1);
  });
});

describe('unknown message kind', () => {
  it('reports a batch-item failure for a message with an unrecognized kind', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const event = batchEvent([sqsRecord('m1', { kind: 'bogus' })]);

    const res = await handler(event, {} as never, undefined as never);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    consoleErrorSpy.mockRestore();
  });
});

it('runner names use the microvm-runner prefix', () => {
  expect(RUNNER_NAME_PREFIX).toBe('microvm-runner');
});

describe('scope enforcement (defence in depth behind the webhook)', () => {
  // The webhook checks scope before enqueueing. This is the second check, for
  // a message that reached the queue by any other route — it is the last
  // point before the launch starts spending GitHub calls, quota and money.
  it('drops an out-of-scope launch WITHOUT any GitHub, DynamoDB or MicroVM side effect', async () => {
    setEnv({
      SCOPE_JSON: JSON.stringify({ kind: 'repos', repos: ['acme/widgets'] }),
    });
    const event = batchEvent([
      sqsRecord('m1', launchMessage({ repo: 'evil/repo' })),
    ]);

    const res = await handler(event, {} as never, undefined as never);

    // A check that rejects AFTER a side effect is not a check. Every client
    // the launch path can reach must be untouched.
    expect(generateJitConfigMock).not.toHaveBeenCalled();
    expect(getWorkflowJobMock).not.toHaveBeenCalled();
    expect(mvmMock.calls()).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);

    // Dropped, not retried: an out-of-scope message will never become
    // in-scope, so re-driving it until it dead-letters would only burn the
    // queue's redrive budget. An empty failure list deletes it.
    expect(res?.batchItemFailures ?? []).toHaveLength(0);
  });

  it('an in-scope launch is unaffected', async () => {
    setEnv({
      SCOPE_JSON: JSON.stringify({ kind: 'repos', repos: ['acme/widgets'] }),
    });
    const event = batchEvent([
      sqsRecord('m1', launchMessage({ repo: 'acme/widgets' })),
    ]);

    await handler(event, {} as never, undefined as never);

    expect(generateJitConfigMock).toHaveBeenCalled();
    expect(mvmMock.commandCalls(RunMicrovmCommand)).toHaveLength(1);
  });

  it('org scope: a foreign owner is dropped even though the App installation is valid', async () => {
    setEnv({ SCOPE_JSON: JSON.stringify({ kind: 'org', org: 'acme' }) });
    const event = batchEvent([
      sqsRecord('m1', launchMessage({ repo: 'other-org/widgets' })),
    ]);

    await handler(event, {} as never, undefined as never);

    expect(mvmMock.calls()).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });
});
