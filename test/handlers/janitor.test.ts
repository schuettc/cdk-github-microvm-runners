import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteMicrovmImageVersionCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmImageVersionsCommand,
  ListMicrovmsCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { marshall } from '@aws-sdk/util-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

jest.mock('../../src/handlers/shared/github-client.js', () => ({
  listRunners: jest.fn(),
  getRunner: jest.fn(),
  deleteRunner: jest.fn(),
  getWorkflowJob: jest.fn(),
}));

import { _resetCachesForTesting, handler } from '../../src/handlers/janitor.js';
import {
  deleteRunner,
  getRunner,
  getWorkflowJob,
  listRunners,
} from '../../src/handlers/shared/github-client.js';

const mvmMock = mockClient(LambdaMicrovmsClient);
const ddbMock = mockClient(DynamoDBClient);
const sqsMock = mockClient(SQSClient);
const listRunnersMock = jest.mocked(listRunners);
const getRunnerMock = jest.mocked(getRunner);
const deleteRunnerMock = jest.mocked(deleteRunner);
const getWorkflowJobMock = jest.mocked(getWorkflowJob);

const JOB_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/1/runners-jobq';
const DLQ_URL = 'https://sqs.us-east-1.amazonaws.com/1/runners-dlq';

const ORIGINAL_ENV = { ...process.env };
const NOW_MS = Date.parse('2026-07-18T12:00:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();

const IMAGE_ARN_DEFAULT =
  'arn:aws:lambda:us-east-1:1:microvm-image:default-image';
const RUNNER_TABLE = 'microvm-runner-x-runners';
const RUNNER_SET_ID = 'x';

// GRACE_SECONDS=600, JANITOR_INTERVAL_SECONDS=300, MAX_JOB_DURATION_SECONDS=3600
// -> lifetimeCapSeconds = 3600 + 300 + 300 = 4200s.
const GRACE_SECONDS = 600;
const INTERVAL_SECONDS = 300;
const MAX_JOB_DURATION_SECONDS = 3600;
const LIFETIME_CAP_SECONDS = MAX_JOB_DURATION_SECONDS + 300 + INTERVAL_SECONDS;

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (
      [
        'RUNNER_SET_ID',
        'SCOPE_JSON',
        'SIZE_CLASSES_JSON',
        'IMAGE_ARN',
        'RUNNER_TABLE',
        'GRACE_SECONDS',
        'JANITOR_INTERVAL_SECONDS',
        'MAX_JOB_DURATION_SECONDS',
        'KEEP_IMAGE_VERSIONS',
        'RECOVER_STUCK_LAUNCHES',
        'JOB_QUEUE_URL',
        'DEAD_LETTER_QUEUE_URL',
      ].includes(key)
    ) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function setEnv(overrides: Record<string, string> = {}): void {
  process.env.RUNNER_SET_ID = RUNNER_SET_ID;
  process.env.SCOPE_JSON = JSON.stringify({ kind: 'org', org: 'acme' });
  process.env.SIZE_CLASSES_JSON = JSON.stringify({
    microvm: { imageArn: IMAGE_ARN_DEFAULT },
  });
  process.env.IMAGE_ARN = IMAGE_ARN_DEFAULT;
  process.env.RUNNER_TABLE = RUNNER_TABLE;
  process.env.GRACE_SECONDS = String(GRACE_SECONDS);
  process.env.JANITOR_INTERVAL_SECONDS = String(INTERVAL_SECONDS);
  process.env.MAX_JOB_DURATION_SECONDS = String(MAX_JOB_DURATION_SECONDS);
  // Metric emission is opt-in (`GithubMicrovmRunnersProps.emitMetrics` ->
  // `EMIT_METRICS`, gated in `shared/emf.ts`'s `emitEmf`). The EMF assertions
  // below exercise the enabled path, so turn it on here; a dedicated test
  // covers the default-off no-op.
  process.env.EMIT_METRICS = 'true';
  Object.assign(process.env, overrides);
}

function isoMinusSeconds(seconds: number): string {
  return new Date(NOW_MS - seconds * 1000).toISOString();
}

interface RowFixture {
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

function normalRow(overrides: Partial<RowFixture> = {}): RowFixture {
  return {
    runnerName: 'microvm-runner-x-abc12345',
    microvmId: 'mvm-1',
    repo: 'acme/widgets',
    jobId: 1001,
    launchedAt: isoMinusSeconds(3600),
    expiresAt: Math.floor(NOW_MS / 1000) + 999_999,
    ...overrides,
  };
}

function orphanRow(microvmId: string, orphanSince?: string): RowFixture {
  return {
    runnerName: `orphan-vm-${microvmId}`,
    microvmId,
    ...(orphanSince ? { orphanSince } : {}),
  };
}

function setTableRows(rows: RowFixture[]): void {
  ddbMock.on(ScanCommand).resolves({
    Items: rows.map((r) => marshall(r, { removeUndefinedValues: true })),
  });
}

interface VmFixture {
  microvmId: string;
  state?: string;
  imageArn?: string;
  ageSeconds?: number;
}

function setRunnerSetVms(vms: VmFixture[]): void {
  mvmMock.on(ListMicrovmsCommand).resolves({
    items: vms.map((v) => ({
      microvmId: v.microvmId,
      state: (v.state ?? 'RUNNING') as never,
      imageArn: v.imageArn ?? IMAGE_ARN_DEFAULT,
      imageVersion: '1',
      startedAt: new Date(NOW_MS - (v.ageSeconds ?? 60) * 1000),
    })),
  });
}

function githubRunner(overrides: {
  id: number;
  name: string;
  busy?: boolean;
  status?: string;
}) {
  return {
    id: overrides.id,
    name: overrides.name,
    busy: overrides.busy ?? false,
    status: overrides.status ?? 'online',
  };
}

beforeEach(() => {
  resetEnv();
  setEnv();
  _resetCachesForTesting();
  mvmMock.reset();
  ddbMock.reset();
  sqsMock.reset();
  listRunnersMock.mockReset();
  getRunnerMock.mockReset();
  deleteRunnerMock.mockReset();
  getWorkflowJobMock.mockReset();
  listRunnersMock.mockResolvedValue([]);
  getRunnerMock.mockResolvedValue(undefined);
  deleteRunnerMock.mockResolvedValue(undefined);
  // Default: DLQ is empty (ReceiveMessage returns no messages).
  sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });
  sqsMock.on(SendMessageCommand).resolves({});
  sqsMock.on(DeleteMessageCommand).resolves({});

  mvmMock.on(ListMicrovmsCommand).resolves({ items: [] });
  mvmMock.on(GetMicrovmCommand).rejects(
    Object.assign(new Error('no such microvm'), {
      name: 'ResourceNotFoundException',
    }),
  );
  mvmMock.on(TerminateMicrovmCommand).resolves({});
  mvmMock.on(ListMicrovmImageVersionsCommand).resolves({ items: [] });
  mvmMock.on(DeleteMicrovmImageVersionCommand).resolves({
    imageIdentifier: IMAGE_ARN_DEFAULT,
    imageVersion: '1',
    state: 'DELETING',
  });

  ddbMock.on(ScanCommand).resolves({ Items: [] });
  ddbMock.on(PutItemCommand).resolves({});
  ddbMock.on(DeleteItemCommand).resolves({});
  ddbMock.on(UpdateItemCommand).resolves({});

  jest.useFakeTimers();
  jest.setSystemTime(NOW_MS);
});

describe('zombie rows (TTL-resurrection) and update conditioning', () => {
  it('LIVE-HIT REGRESSION (bench 2026-07-22): a {runnerName, suspectSince}-only row — no microvmId, no expiresAt — must NOT abort the sweep; it is deleted (self-heal) and GetMicrovm is never called with undefined', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([
      // The zombie: what an unconditional SET suspectSince racing DynamoDB's
      // TTL delete leaves behind. Exactly the row observed live.
      {
        runnerName: 'microvm-runner-23b84a55-0112f361',
        suspectSince: isoMinusSeconds(3600),
      } as RowFixture,
      normalRow(),
    ]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 42, name: 'microvm-runner-x-abc12345', busy: true }),
    ]);

    await handler(); // must complete — before the fix this threw

    // Never dereferenced the missing id.
    for (const c of mvmMock.commandCalls(GetMicrovmCommand)) {
      expect(c.args[0].input.microvmIdentifier).toBeDefined();
    }
    // Self-heal: the zombie is deleted; the healthy row is not.
    const deleted = ddbMock
      .commandCalls(DeleteItemCommand)
      .map((c) => c.args[0].input.Key?.runnerName?.S);
    expect(deleted).toContain('microvm-runner-23b84a55-0112f361');
    expect(deleted).not.toContain(normalRow().runnerName);
  });

  it('every janitor UpdateItem is conditioned on attribute_exists(runnerName) — the TTL-race resurrection path is closed', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([normalRow()]);
    // Absent from GitHub -> first observation triggers setSuspect (an update).
    listRunnersMock.mockResolvedValue([]);

    await handler();

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls.length).toBeGreaterThan(0);
    for (const c of updateCalls) {
      expect(c.args[0].input.ConditionExpression).toBe(
        'attribute_exists(runnerName)',
      );
    }
  });

  it('a ConditionalCheckFailedException on setSuspect (row TTLd mid-sweep) is a silent no-op — the sweep completes', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([normalRow()]);
    listRunnersMock.mockResolvedValue([]);
    const err = Object.assign(new Error('conditional check failed'), {
      name: 'ConditionalCheckFailedException',
    });
    ddbMock.on(UpdateItemCommand).rejects(err);

    await expect(handler()).resolves.not.toThrow();
  });
});

describe('sweep robustness: phase isolation + guaranteed metric emission (H1)', () => {
  // Parse the EMF metrics line emitted by emitMetrics from a console.log spy.
  function emittedMetrics(
    logSpy: ReturnType<typeof jest.spyOn>,
  ): Record<string, number> {
    const line = logSpy.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .reverse()
      .find((l: string) => typeof l === 'string' && l.includes('"_aws"'));
    expect(line).toBeDefined();
    return JSON.parse(line as string) as Record<string, number>;
  }

  it('a transient throw in the reconcile PHASE (listRunnerSetVms 5xx) does NOT abort the sweep AND still emits metrics with errors>=1', async () => {
    // Non-throttle error → listRunnerSetVms rethrows immediately (no retry
    // sleep) → reconcileTable throws → phase guard catches.
    mvmMock
      .on(ListMicrovmsCommand)
      .rejects(Object.assign(new Error('internal error'), { name: 'Error' }));
    setTableRows([normalRow()]);
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(handler()).resolves.not.toThrow();

    // The whole point: emitMetrics ran despite the phase fault, and the
    // errors signal reached CloudWatch instead of going dark.
    const m = emittedMetrics(logSpy);
    expect(m.errors).toBeGreaterThanOrEqual(1);
    jest.restoreAllMocks();
  });

  it('a per-VM getMicrovm transient throw in buildVmMap leaves that row ALONE (no terminate) and counts an error, sweep completes', async () => {
    setRunnerSetVms([]); // image-scoped list empty → buildVmMap resolves rows via getMicrovm
    setTableRows([normalRow()]); // microvmId 'mvm-1'
    // Non-RNF, non-throttle error for the row's VM → buildVmMap catches →
    // id ABSENT from map (distinct from present-undefined "gone") → the
    // consumer skips the row entirely rather than treating it as gone.
    mvmMock
      .on(GetMicrovmCommand)
      .rejects(Object.assign(new Error('5xx'), { name: 'Error' }));
    listRunnersMock.mockResolvedValue([]);
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(handler()).resolves.not.toThrow();

    // Unknown state ⇒ no destructive action against the row.
    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(mvmMock.commandCalls(GetMicrovmCommand).length).toBeGreaterThan(0);
    const m = emittedMetrics(logSpy);
    expect(m.errors).toBeGreaterThanOrEqual(1);
    jest.restoreAllMocks();
  });
});

describe('rule 1: absent from GitHub listRunners', () => {
  it('the sweep scan sends NO ConsistentRead and NO ExclusiveStartKey key at all (omit-when-unset — keys must be genuinely absent, not present-with-undefined)', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([normalRow()]);
    listRunnersMock.mockResolvedValue([]);

    await handler();

    // The regular sweep scan is eventually-consistent (no ConsistentRead)
    // and single-page here (no ExclusiveStartKey). Assert key ABSENCE:
    // `input.ConsistentRead === undefined` would also pass for an explicit
    // `ConsistentRead: undefined`, which is a different wire shape — the
    // idlePolicy incident (required-keyed member serialized undefined as
    // JSON null → ValidationException) is why the convention is pinned.
    const sweepScan = ddbMock.commandCalls(ScanCommand)[0].args[0].input;
    expect(sweepScan).not.toHaveProperty('ConsistentRead');
    expect(sweepScan).not.toHaveProperty('ExclusiveStartKey');
  });

  it('first observation sets suspectSince without deregistering or terminating', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([normalRow()]);
    // Both the per-invocation cached list and the fresh re-list come back
    // without this runner.
    listRunnersMock.mockResolvedValue([]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(deleteRunnerMock).not.toHaveBeenCalled();
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.UpdateExpression).toBe(
      'SET suspectSince = :s',
    );
    expect(
      updateCalls[0].args[0].input.ExpressionAttributeValues?.[':s'].S,
    ).toBe(NOW_ISO);
  });

  it('second strike lands on the next sweep even when the scheduler fires it fractionally early', async () => {
    // EventBridge does not fire a 5-minute rule at exactly 300000 ms. Measured
    // over 26 consecutive sweeps on the bench account, 17 gaps came in SHORT
    // by 60-110 ms. Comparing elapsed time against the exact interval
    // therefore failed on the very next sweep about two times in three, and
    // the strike waited another whole interval — silently adding 300s to
    // every idle reap. The question being asked is "was this written on an
    // earlier sweep?", so a sweep that arrives 100 ms early still counts.
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([
      normalRow({
        suspectSince: isoMinusSeconds(INTERVAL_SECONDS - 0.1),
        runnerId: 555,
      }),
    ]);
    listRunnersMock.mockResolvedValue([]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(1);
    expect(deleteRunnerMock).toHaveBeenCalled();
  });

  it('a strike written during THIS sweep is not acted on', async () => {
    // The tolerance must not be so wide that a suspect set moments ago is
    // treated as a previous sweep's — that would collapse the two-strike
    // rule into one and reap on a single bad reading.
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([
      normalRow({ suspectSince: isoMinusSeconds(1), runnerId: 555 }),
    ]);
    listRunnersMock.mockResolvedValue([]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(deleteRunnerMock).not.toHaveBeenCalled();
  });

  it('second strike (suspectSince older than one interval, still absent) deregisters, terminates, and deletes the row', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([
      normalRow({
        suspectSince: isoMinusSeconds(INTERVAL_SECONDS + 1),
        runnerId: 555,
      }),
    ]);
    listRunnersMock.mockResolvedValue([]);
    getRunnerMock.mockResolvedValue(undefined);

    await handler();

    expect(deleteRunnerMock).toHaveBeenCalledWith({ org: 'acme' }, 555);
    const termCalls = mvmMock.commandCalls(TerminateMicrovmCommand);
    expect(termCalls).toHaveLength(1);
    expect(termCalls[0].args[0].input.microvmIdentifier).toBe('mvm-1');
    const delCalls = ddbMock.commandCalls(DeleteItemCommand);
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0].args[0].input.Key?.runnerName?.S).toBe(
      'microvm-runner-x-abc12345',
    );
  });

  it('second strike with no cached runnerId still terminates (nothing to deregister by id)', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([
      normalRow({ suspectSince: isoMinusSeconds(INTERVAL_SECONDS + 1) }),
    ]);
    listRunnersMock.mockResolvedValue([]);

    await handler();

    expect(deleteRunnerMock).not.toHaveBeenCalled();
    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(1);
  });

  it('suspectSince younger than one interval takes no action (waiting for next sweep)', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([
      normalRow({ suspectSince: isoMinusSeconds(INTERVAL_SECONDS - 30) }),
    ]);
    listRunnersMock.mockResolvedValue([]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
  });
});

describe('rule 3: the stale-list race (the #4391 case)', () => {
  it('busy runner absent from the cached list but present (busy) on a fresh getRunner-by-name re-list is cleared, never touched', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([normalRow({ suspectSince: isoMinusSeconds(10) })]);
    // Cached per-invocation list: absent. Fresh re-list: present + busy.
    listRunnersMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        githubRunner({ id: 42, name: 'microvm-runner-x-abc12345', busy: true }),
      ]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(deleteRunnerMock).not.toHaveBeenCalled();
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    const removeCall = updateCalls.find(
      (c) => c.args[0].input.UpdateExpression === 'REMOVE suspectSince',
    );
    expect(removeCall).toBeDefined();
  });

  it('runner present and busy=true on the cached list is always cleared and never touched, regardless of suspectSince', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([normalRow({ suspectSince: isoMinusSeconds(10) })]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 42, name: 'microvm-runner-x-abc12345', busy: true }),
    ]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    const removeCall = updateCalls.find(
      (c) => c.args[0].input.UpdateExpression === 'REMOVE suspectSince',
    );
    expect(removeCall).toBeDefined();
  });

  it('busy runner with no suspectSince takes no suspect-clearing action (nothing to clear)', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([normalRow()]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 42, name: 'microvm-runner-x-abc12345', busy: true }),
    ]);

    await handler();

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    const removeCall = updateCalls.find(
      (c) => c.args[0].input.UpdateExpression === 'REMOVE suspectSince',
    );
    expect(removeCall).toBeUndefined();
    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
  });

  it('rule 2 second-strike kill aborts and clears when the immediate fresh read shows busy=true', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1', ageSeconds: GRACE_SECONDS + 100 }]);
    setTableRows([
      normalRow({
        suspectSince: isoMinusSeconds(INTERVAL_SECONDS + 1),
        runnerId: 42,
      }),
    ]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 42, name: 'microvm-runner-x-abc12345', busy: false }),
    ]);
    // Fresh getRunner-by-id right before the kill decision: now busy.
    getRunnerMock.mockResolvedValue(
      githubRunner({ id: 42, name: 'microvm-runner-x-abc12345', busy: true }),
    );

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(deleteRunnerMock).not.toHaveBeenCalled();
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    const removeCall = updateCalls.find(
      (c) => c.args[0].input.UpdateExpression === 'REMOVE suspectSince',
    );
    expect(removeCall).toBeDefined();
  });

  it('cached runnerId 404s on getRunner, but a fresh name-based re-list shows the runner busy: cleared, not killed', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1', ageSeconds: GRACE_SECONDS + 1000 }]);
    setTableRows([
      normalRow({
        suspectSince: isoMinusSeconds(INTERVAL_SECONDS + 1),
        runnerId: 42,
      }),
    ]);
    listRunnersMock
      .mockResolvedValueOnce([
        githubRunner({
          id: 42,
          name: 'microvm-runner-x-abc12345',
          busy: false,
        }),
      ]) // per-invocation cached list
      .mockResolvedValueOnce([
        githubRunner({ id: 99, name: 'microvm-runner-x-abc12345', busy: true }),
      ]); // fresh name-based re-list fallback after the cached id 404s
    getRunnerMock.mockResolvedValue(undefined); // cached id 404s

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(deleteRunnerMock).not.toHaveBeenCalled();
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    const removeCall = updateCalls.find(
      (c) => c.args[0].input.UpdateExpression === 'REMOVE suspectSince',
    );
    expect(removeCall).toBeDefined();
    expect(listRunnersMock).toHaveBeenCalledTimes(2);
  });
});

describe('rule 2: registered, online, idle past grace — two-strike stuck-runner reap', () => {
  it('first observation (VM age > GRACE_SECONDS, online, idle) sets suspectSince', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1', ageSeconds: GRACE_SECONDS + 1 }]);
    setTableRows([normalRow()]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 42, name: 'microvm-runner-x-abc12345', busy: false }),
    ]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    const setCall = updateCalls.find(
      (c) => c.args[0].input.UpdateExpression === 'SET suspectSince = :s',
    );
    expect(setCall).toBeDefined();
  });

  it('VM age within grace takes no rule-2 action even when online and idle', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1', ageSeconds: GRACE_SECONDS - 100 }]);
    setTableRows([normalRow()]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 42, name: 'microvm-runner-x-abc12345', busy: false }),
    ]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    // Opportunistic runnerId caching may still fire an UpdateItem, but never
    // a suspectSince strike.
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    const setSuspectCall = updateCalls.find(
      (c) => c.args[0].input.UpdateExpression === 'SET suspectSince = :s',
    );
    expect(setSuspectCall).toBeUndefined();
  });

  it('second strike (suspectSince older than one interval, still online+idle on fresh read) deletes the runner, terminates, and deletes the row', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1', ageSeconds: GRACE_SECONDS + 1000 }]);
    setTableRows([
      normalRow({
        suspectSince: isoMinusSeconds(INTERVAL_SECONDS + 1),
        runnerId: 42,
      }),
    ]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 42, name: 'microvm-runner-x-abc12345', busy: false }),
    ]);
    getRunnerMock.mockResolvedValue(
      githubRunner({ id: 42, name: 'microvm-runner-x-abc12345', busy: false }),
    );

    await handler();

    expect(deleteRunnerMock).toHaveBeenCalledWith({ org: 'acme' }, 42);
    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(1);
  });

  it('OFFLINE zombie (crash-after-register: runner offline, VM still RUNNING) is reaped on the second strike', async () => {
    // A runner that registered then had its process die shows status
    // 'offline' while the VM keeps running (agent alive). Before the fix this
    // matched no reap rule and held a quota slot indefinitely.
    setRunnerSetVms([{ microvmId: 'mvm-1', ageSeconds: GRACE_SECONDS + 1000 }]);
    setTableRows([
      normalRow({
        suspectSince: isoMinusSeconds(INTERVAL_SECONDS + 1),
        runnerId: 42,
      }),
    ]);
    listRunnersMock.mockResolvedValue([
      githubRunner({
        id: 42,
        name: 'microvm-runner-x-abc12345',
        busy: false,
        status: 'offline',
      }),
    ]);
    getRunnerMock.mockResolvedValue(
      githubRunner({
        id: 42,
        name: 'microvm-runner-x-abc12345',
        busy: false,
        status: 'offline',
      }),
    );

    await handler();

    expect(deleteRunnerMock).toHaveBeenCalledWith({ org: 'acme' }, 42);
    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(1);
  });

  it('OFFLINE runner on FIRST observation only sets suspectSince (two-strike protects a transient reconnect)', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1', ageSeconds: GRACE_SECONDS + 1000 }]);
    setTableRows([normalRow({ runnerId: 42 })]); // no suspectSince yet
    listRunnersMock.mockResolvedValue([
      githubRunner({
        id: 42,
        name: 'microvm-runner-x-abc12345',
        busy: false,
        status: 'offline',
      }),
    ]);

    await handler();

    // First strike: suspect set, nothing killed.
    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(deleteRunnerMock).not.toHaveBeenCalled();
    const updates = ddbMock.commandCalls(UpdateItemCommand);
    const setSuspect = updates.find((c) =>
      c.args[0].input.UpdateExpression?.includes('SET suspectSince'),
    );
    expect(setSuspect).toBeDefined();
  });
});

describe('rule 4: VM lifetime backstop', () => {
  it('terminates a VM past the lifetime cap without any GitHub call, and logs a structured lifetimeKill', async () => {
    setRunnerSetVms([
      { microvmId: 'mvm-1', ageSeconds: LIFETIME_CAP_SECONDS + 1 },
    ]);
    setTableRows([normalRow()]);
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(1);
    expect(listRunnersMock).not.toHaveBeenCalled();
    expect(getRunnerMock).not.toHaveBeenCalled();
    expect(deleteRunnerMock).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(1);

    const lifetimeLog = logSpy.mock.calls
      .map((c) => c[0] as string)
      .find((line) => line.includes('lifetimeKill'));
    expect(lifetimeLog).toBeDefined();
    const parsed = JSON.parse(lifetimeLog as string) as Record<string, unknown>;
    expect(parsed.msg).toBe('janitor: lifetimeKill');
    expect(parsed.microvmId).toBe('mvm-1');
    logSpy.mockRestore();
  });

  it('does not fire below the lifetime cap', async () => {
    setRunnerSetVms([
      { microvmId: 'mvm-1', ageSeconds: LIFETIME_CAP_SECONDS - 1 },
    ]);
    setTableRows([normalRow()]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 1, name: 'microvm-runner-x-abc12345', busy: true }),
    ]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
  });
});

describe('rule 5: stale table row hygiene', () => {
  it('deletes a row whose VM is confirmed gone (GetMicrovm NotFound) once its own expiresAt has passed', async () => {
    setRunnerSetVms([]); // not discoverable via image ARNs
    setTableRows([
      normalRow({
        microvmId: 'mvm-gone',
        expiresAt: Math.floor(NOW_MS / 1000) - 10,
      }),
    ]);
    // default GetMicrovmCommand mock rejects NotFound

    await handler();

    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(1);
    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
  });

  it('leaves a row whose VM is confirmed gone alone until its own expiresAt passes', async () => {
    setRunnerSetVms([]);
    setTableRows([
      normalRow({
        microvmId: 'mvm-gone',
        expiresAt: Math.floor(NOW_MS / 1000) + 999_999,
      }),
    ]);

    await handler();

    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
  });

  it('closes the image-rotation gap: a row-referenced VM not in the current image-ARN sweep is still discovered via GetMicrovm and reconciled normally', async () => {
    setRunnerSetVms([]); // rotated-out image ARN, invisible to listRunnerSetVms(currentArns)
    setTableRows([normalRow({ microvmId: 'mvm-old-image' })]);
    mvmMock.on(GetMicrovmCommand).resolves({
      microvmId: 'mvm-old-image',
      state: 'RUNNING',
      endpoint: 'https://example.invalid',
      imageArn: 'arn:aws:lambda:us-east-1:1:microvm-image:old-rotated-out',
      imageVersion: '1',
      maximumDurationInSeconds: 3900,
      startedAt: new Date(NOW_MS - 60_000),
    });
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 9, name: 'microvm-runner-x-abc12345', busy: true }),
    ]);

    await handler();

    // Reconciled as a normal busy runner: never touched.
    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
  });
});

describe('rule 6: orphan VM (no table row) lifecycle', () => {
  it('first observation synthesizes an orphan row and takes no kill action', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-orphan' }]);
    setTableRows([]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Item?.runnerName?.S).toBe(
      'orphan-vm-mvm-orphan',
    );
    expect(putCalls[0].args[0].input.Item?.orphanSince?.S).toBe(NOW_ISO);
  });

  it('second observation within one interval takes no action', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-orphan' }]);
    setTableRows([
      orphanRow('mvm-orphan', isoMinusSeconds(INTERVAL_SECONDS - 30)),
    ]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
  });

  it('second observation past one interval terminates the VM and deletes the orphan row, without any GitHub call', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-orphan' }]);
    setTableRows([
      orphanRow('mvm-orphan', isoMinusSeconds(INTERVAL_SECONDS + 1)),
    ]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(1);
    expect(listRunnersMock).not.toHaveBeenCalled();
    expect(getRunnerMock).not.toHaveBeenCalled();
    const delCalls = ddbMock.commandCalls(DeleteItemCommand);
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0].args[0].input.Key?.runnerName?.S).toBe(
      'orphan-vm-mvm-orphan',
    );
  });

  it('pre-kill freshness: an interval-old orphan row whose sweep-start scan snapshot showed no competing row, but a FRESH pre-kill consistent scan now reveals a legit row for the same microvmId — no terminate, orphan row deleted', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-shared' }]);
    // Sweep-start scan snapshot: only the interval-old orphan row (no legit
    // row yet) — hasCompetingLegitRow is false from THIS scan's point of
    // view. A second, later ScanCommand call (the pre-kill fresh read) sees
    // a legit row that "landed" in between.
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          marshall(
            orphanRow('mvm-shared', isoMinusSeconds(INTERVAL_SECONDS + 1)),
          ),
        ],
      })
      .resolves({
        Items: [
          marshall(
            orphanRow('mvm-shared', isoMinusSeconds(INTERVAL_SECONDS + 1)),
          ),
          marshall(
            normalRow({
              runnerName: 'microvm-runner-x-legit002',
              microvmId: 'mvm-shared',
            }),
          ),
        ],
      });
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    const delCalls = ddbMock.commandCalls(DeleteItemCommand);
    const deletedNames = delCalls.map(
      (c) => c.args[0].input.Key?.runnerName?.S,
    );
    expect(deletedNames).toContain('orphan-vm-mvm-shared');

    // The pre-kill scan used ConsistentRead: true.
    const scanCalls = ddbMock.commandCalls(ScanCommand);
    expect(scanCalls.some((c) => c.args[0].input.ConsistentRead === true)).toBe(
      true,
    );

    const abortLog = logSpy.mock.calls
      .map((c) => c[0] as string)
      .find((line) => line.includes('orphan kill aborted'));
    expect(abortLog).toBeDefined();
    logSpy.mockRestore();
  });

  it('orphan race: an interval-old orphan row and a later-landed legit row for the SAME microvmId — no terminate, orphan row deleted as hygiene, legit row reconciled normally', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-shared' }]);
    setTableRows([
      orphanRow('mvm-shared', isoMinusSeconds(INTERVAL_SECONDS + 1)),
      normalRow({
        runnerName: 'microvm-runner-x-legit001',
        microvmId: 'mvm-shared',
      }),
    ]);
    // Legit row's runner is busy — normal reconciliation must never touch it.
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 7, name: 'microvm-runner-x-legit001', busy: true }),
    ]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);

    const delCalls = ddbMock.commandCalls(DeleteItemCommand);
    const deletedNames = delCalls.map(
      (c) => c.args[0].input.Key?.runnerName?.S,
    );
    expect(deletedNames).toContain('orphan-vm-mvm-shared');
    expect(deletedNames).not.toContain('microvm-runner-x-legit001');

    // Legit row's own reconciliation ran (busy -> opportunistic runnerId
    // caching), proving rule 6's race guard deferred to it rather than
    // short-circuiting on stale orphan strike memory.
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    const cacheIdCall = updateCalls.find(
      (c) =>
        c.args[0].input.UpdateExpression === 'SET runnerId = :id' &&
        c.args[0].input.Key?.runnerName?.S === 'microvm-runner-x-legit001',
    );
    expect(cacheIdCall).toBeDefined();
    expect(listRunnersMock).toHaveBeenCalled();
  });
});

describe('warm pool: SUSPENDED VM with no table row is never reaped (invariant)', () => {
  it('a SUSPENDED pool VM with no runner-table row is left completely alone', async () => {
    // A pre-warmed pool VM: SUSPENDED, no launcher-created row, no orphan
    // row — it is not a registered runner yet and must never be reaped by
    // the janitor (that would destroy the pool). Rule 6's "first
    // observation" path only fires for `state === 'RUNNING'`, so a
    // SUSPENDED VM with no row should receive no action whatsoever: no
    // terminate, no orphan-row synthesis, no table writes, no GitHub call.
    setRunnerSetVms([{ microvmId: 'mvm-pool', state: 'SUSPENDED' }]);
    setTableRows([]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(listRunnersMock).not.toHaveBeenCalled();
    expect(getRunnerMock).not.toHaveBeenCalled();
  });
});

describe('job-claim rows (job#<repo>#<jobId>) are excluded from reconciliation', () => {
  function claimRow(
    overrides: {
      microvmId?: string;
      expiresAt?: number;
    } = {},
  ): RowFixture {
    return {
      runnerName: 'job#acme/widgets#1001',
      microvmId: overrides.microvmId ?? 'pending',
      repo: 'acme/widgets',
      jobId: 1001,
      launchedAt: isoMinusSeconds(60),
      expiresAt: overrides.expiresAt ?? Math.floor(NOW_MS / 1000) + 999_999,
    };
  }

  it('a live (non-expired) claim row is left completely untouched by a sweep', async () => {
    setRunnerSetVms([]);
    setTableRows([claimRow()]);

    await handler();

    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(listRunnersMock).not.toHaveBeenCalled();
    expect(getRunnerMock).not.toHaveBeenCalled();
  });

  it('an expired claim row (microvmId still "pending") is deleted as hygiene, never reconciled as an orphan or runner', async () => {
    setRunnerSetVms([]);
    setTableRows([claimRow({ expiresAt: Math.floor(NOW_MS / 1000) - 10 })]);

    await handler();

    const delCalls = ddbMock.commandCalls(DeleteItemCommand);
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0].args[0].input.Key?.runnerName?.S).toBe(
      'job#acme/widgets#1001',
    );
    // Never treated as an orphan VM (no GitHub call, no PutItem synthesizing
    // an orphan row for 'pending') or a normal runner mapping row.
    expect(listRunnersMock).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it("a claim row sharing a sweep with a normal running-VM row does not interfere with that row's own reconciliation", async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([claimRow(), normalRow()]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 1, name: 'microvm-runner-x-abc12345', busy: true }),
    ]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(listRunnersMock).toHaveBeenCalled();
  });
});

describe('warm-pool claim rows (warmvm#<microvmId>) are excluded from reconciliation', () => {
  // A warm-VM claim row (see `warm-claim.ts`'s `claimWarmVm`) has NO
  // `microvmId` attribute at all — the id lives only inside the
  // `runnerName` string (`warmvm#<microvmId>`). Built without going through
  // `RowFixture`'s (required) `microvmId` field, matching the real shape
  // `marshall` would produce for this row in production.
  function warmClaimRow(
    microvmId: string,
    overrides: { expiresAt?: number } = {},
  ): RowFixture {
    return {
      runnerName: `warmvm#${microvmId}`,
      expiresAt: overrides.expiresAt ?? Math.floor(NOW_MS / 1000) + 999_999,
    } as unknown as RowFixture;
  }

  it('a warmvm# row sharing a sweep with a normal running-VM row does not abort the sweep, and getMicrovm is never called with an undefined id', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([warmClaimRow('mvm-warm-1'), normalRow()]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 1, name: 'microvm-runner-x-abc12345', busy: true }),
    ]);
    // Mirror the real AWS SDK: a `GetMicrovm` call missing its required
    // `microvmIdentifier` throws a client-side validation error (NOT
    // `ResourceNotFoundException`) — `getMicrovm` only swallows the latter,
    // so `getMicrovm(undefined)` propagates and (pre-fix) aborts the whole
    // sweep via `buildVmMap`'s unguarded `await`.
    mvmMock.on(GetMicrovmCommand).callsFake((input) => {
      if (input.microvmIdentifier === undefined) {
        throw new Error("Missing required key 'microvmIdentifier' in params");
      }
      throw Object.assign(new Error('no such microvm'), {
        name: 'ResourceNotFoundException',
      });
    });

    // Must complete without throwing — pre-fix this rejects because the
    // warmvm# row flows into buildVmMap as getMicrovm(undefined).
    await handler();

    const getCalls = mvmMock.commandCalls(GetMicrovmCommand);
    expect(
      getCalls.some((c) => c.args[0].input.microvmIdentifier === undefined),
    ).toBe(false);

    // The warmvm# row itself is left completely untouched: not terminated,
    // not treated as a runner or orphan, no table writes referencing it.
    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    const deleteCalls = ddbMock.commandCalls(DeleteItemCommand);
    expect(
      deleteCalls.some(
        (c) => c.args[0].input.Key?.runnerName?.S === 'warmvm#mvm-warm-1',
      ),
    ).toBe(false);

    // The normal row's own reconciliation still ran undisturbed.
    expect(listRunnersMock).toHaveBeenCalled();
  });

  it('an expired warmvm# row is left for its own TTL — no active hygiene delete', async () => {
    setRunnerSetVms([]);
    setTableRows([
      warmClaimRow('mvm-warm-2', {
        expiresAt: Math.floor(NOW_MS / 1000) - 10,
      }),
    ]);

    await handler();

    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
    expect(mvmMock.commandCalls(GetMicrovmCommand)).toHaveLength(0);
  });
});

describe('kill-ordering: no TerminateMicrovm without a preceding same-invocation fresh getRunner (except rules 4 and 6)', () => {
  it('rule 1 second-strike kill: the fresh re-list happens before TerminateMicrovm', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([
      normalRow({ suspectSince: isoMinusSeconds(INTERVAL_SECONDS + 1) }),
    ]);
    const callLog: string[] = [];
    listRunnersMock.mockImplementation(async () => {
      callLog.push('listRunners');
      return [];
    });
    mvmMock.on(TerminateMicrovmCommand).callsFake(() => {
      callLog.push('terminateMicrovm');
      return {};
    });

    await handler();

    expect(callLog.indexOf('terminateMicrovm')).toBeGreaterThan(-1);
    expect(callLog.indexOf('listRunners')).toBeGreaterThan(-1);
    expect(callLog.indexOf('listRunners')).toBeLessThan(
      callLog.indexOf('terminateMicrovm'),
    );
  });

  it('rule 2 second-strike kill: the fresh getRunner-by-id happens before TerminateMicrovm', async () => {
    setRunnerSetVms([{ microvmId: 'mvm-1', ageSeconds: GRACE_SECONDS + 1000 }]);
    setTableRows([
      normalRow({
        suspectSince: isoMinusSeconds(INTERVAL_SECONDS + 1),
        runnerId: 42,
      }),
    ]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 42, name: 'microvm-runner-x-abc12345', busy: false }),
    ]);
    const callLog: string[] = [];
    getRunnerMock.mockImplementation(async () => {
      callLog.push('getRunner');
      return githubRunner({
        id: 42,
        name: 'microvm-runner-x-abc12345',
        busy: false,
      });
    });
    mvmMock.on(TerminateMicrovmCommand).callsFake(() => {
      callLog.push('terminateMicrovm');
      return {};
    });

    await handler();

    expect(callLog).toEqual(['getRunner', 'terminateMicrovm']);
  });

  it('rule 4 (lifetime) and rule 6 (orphan) terminate without any getRunner/listRunners call, gated purely by their age thresholds', async () => {
    setRunnerSetVms([
      { microvmId: 'mvm-lifetime', ageSeconds: LIFETIME_CAP_SECONDS + 1 },
      { microvmId: 'mvm-orphan' },
    ]);
    setTableRows([
      normalRow({ microvmId: 'mvm-lifetime' }),
      orphanRow('mvm-orphan', isoMinusSeconds(INTERVAL_SECONDS + 1)),
    ]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(2);
    expect(listRunnersMock).not.toHaveBeenCalled();
    expect(getRunnerMock).not.toHaveBeenCalled();

    // Below their thresholds, neither fires.
    ddbMock.reset();
    mvmMock.reset();
    mvmMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: 'mvm-lifetime',
          state: 'RUNNING',
          imageArn: IMAGE_ARN_DEFAULT,
          imageVersion: '1',
          startedAt: new Date(NOW_MS - (LIFETIME_CAP_SECONDS - 1) * 1000),
        },
        {
          microvmId: 'mvm-orphan',
          state: 'RUNNING',
          imageArn: IMAGE_ARN_DEFAULT,
          imageVersion: '1',
          startedAt: new Date(NOW_MS - 60_000),
        },
      ],
    });
    mvmMock.on(TerminateMicrovmCommand).resolves({});
    mvmMock
      .on(GetMicrovmCommand)
      .rejects(
        Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' }),
      );
    mvmMock.on(ListMicrovmImageVersionsCommand).resolves({ items: [] });
    ddbMock.on(ScanCommand).resolves({
      Items: [
        marshall(normalRow({ microvmId: 'mvm-lifetime' })),
        marshall(
          orphanRow('mvm-orphan', isoMinusSeconds(INTERVAL_SECONDS - 30)),
        ),
      ],
    });
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(DeleteItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 1, name: 'microvm-runner-x-abc12345', busy: true }),
    ]);

    await handler();

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
  });
});

describe('repos scope fan-out', () => {
  it('resolves the GitHub target from the row.repo, not a fixed scope-level target', async () => {
    setEnv({
      SCOPE_JSON: JSON.stringify({
        kind: 'repos',
        repos: ['acme/widgets', 'acme/other'],
      }),
    });
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([normalRow({ repo: 'acme/other' })]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 1, name: 'microvm-runner-x-abc12345', busy: true }),
    ]);

    await handler();

    expect(listRunnersMock).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'other',
    });
  });
});

describe('image version pruning', () => {
  function versionSummary(overrides: {
    imageVersion: string;
    status: 'ACTIVE' | 'INACTIVE';
    createdAtOffsetSeconds: number;
  }) {
    return {
      baseImageArn: 'arn:aws:lambda:us-east-1:1:microvm-image:base',
      buildRoleArn: 'arn:aws:iam::1:role/build',
      codeArtifact: { uri: 's3://bucket/key' },
      imageArn: IMAGE_ARN_DEFAULT,
      imageVersion: overrides.imageVersion,
      state: 'SUCCESSFUL' as const,
      status: overrides.status,
      createdAt: new Date(NOW_MS - overrides.createdAtOffsetSeconds * 1000),
    };
  }

  it('keeps the newest KEEP_IMAGE_VERSIONS versions regardless of status, deletes only INACTIVE versions beyond that', async () => {
    setEnv({ KEEP_IMAGE_VERSIONS: '3' });
    mvmMock.on(ListMicrovmImageVersionsCommand).resolves({
      items: [
        versionSummary({
          imageVersion: 'v5',
          status: 'ACTIVE',
          createdAtOffsetSeconds: 10,
        }),
        versionSummary({
          imageVersion: 'v4',
          status: 'INACTIVE',
          createdAtOffsetSeconds: 20,
        }),
        versionSummary({
          imageVersion: 'v3',
          status: 'INACTIVE',
          createdAtOffsetSeconds: 30,
        }),
        // beyond newest 3:
        versionSummary({
          imageVersion: 'v2',
          status: 'INACTIVE',
          createdAtOffsetSeconds: 40,
        }),
        versionSummary({
          imageVersion: 'v1',
          status: 'ACTIVE',
          createdAtOffsetSeconds: 50,
        }),
      ],
    });

    await handler();

    const delCalls = mvmMock.commandCalls(DeleteMicrovmImageVersionCommand);
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0].args[0].input.imageVersion).toBe('v2');
  });
});

describe('config validation: numeric env vars must be finite, not silently coerced to NaN', () => {
  it('MAX_JOB_DURATION_SECONDS="not-a-number" throws a clear config error before any reconciliation — no TerminateMicrovm calls are ever made', async () => {
    setEnv({ MAX_JOB_DURATION_SECONDS: 'not-a-number' });
    // If this weren't caught, `Number("not-a-number")` is NaN, and
    // `age <= lifetimeCapSeconds` (NaN comparisons are always false) would
    // make tryLifetimeKill terminate every RUNNING VM unconditionally.
    setRunnerSetVms([{ microvmId: 'mvm-1', ageSeconds: 60 }]);
    setTableRows([normalRow()]);

    await expect(handler()).rejects.toThrow(
      /invalid numeric env var MAX_JOB_DURATION_SECONDS/,
    );

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
    // buildContext throws before reconcileTable ever runs, so no table
    // scan or VM list is ever issued either.
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    expect(mvmMock.commandCalls(ListMicrovmsCommand)).toHaveLength(0);
  });

  it('MAX_JOB_DURATION_SECONDS unset throws a missing-required-env error (no default; it is required)', async () => {
    setEnv();
    delete process.env.MAX_JOB_DURATION_SECONDS;
    setRunnerSetVms([{ microvmId: 'mvm-1' }]);
    setTableRows([normalRow()]);

    await expect(handler()).rejects.toThrow(
      /missing required environment variable MAX_JOB_DURATION_SECONDS/,
    );

    expect(mvmMock.commandCalls(TerminateMicrovmCommand)).toHaveLength(0);
  });
});

describe('per-item error isolation', () => {
  it('one row throwing during reconciliation does not stop the sweep: the other row is still reconciled, and metrics are still emitted with errors>=1', async () => {
    setRunnerSetVms([
      { microvmId: 'mvm-a', ageSeconds: GRACE_SECONDS + 1000 },
      { microvmId: 'mvm-b', ageSeconds: GRACE_SECONDS + 1000 },
    ]);
    setTableRows([
      normalRow({
        runnerName: 'microvm-runner-x-aaaaaaaa',
        microvmId: 'mvm-a',
        suspectSince: isoMinusSeconds(INTERVAL_SECONDS + 1),
        runnerId: 1,
      }),
      normalRow({
        runnerName: 'microvm-runner-x-bbbbbbbb',
        microvmId: 'mvm-b',
        suspectSince: isoMinusSeconds(INTERVAL_SECONDS + 1),
        runnerId: 2,
      }),
    ]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 1, name: 'microvm-runner-x-aaaaaaaa', busy: false }),
      githubRunner({ id: 2, name: 'microvm-runner-x-bbbbbbbb', busy: false }),
    ]);
    getRunnerMock.mockImplementation(async (_target, id) =>
      githubRunner({
        id: id as number,
        name:
          id === 1 ? 'microvm-runner-x-aaaaaaaa' : 'microvm-runner-x-bbbbbbbb',
        busy: false,
      }),
    );
    // First row's terminate throws; second row's terminate must still run.
    mvmMock.on(TerminateMicrovmCommand).callsFake((input) => {
      if (input.microvmIdentifier === 'mvm-a') {
        throw new Error('boom: transient MicroVM API failure');
      }
      return {};
    });
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await handler();

    const termCalls = mvmMock.commandCalls(TerminateMicrovmCommand);
    expect(termCalls.map((c) => c.args[0].input.microvmIdentifier)).toEqual(
      expect.arrayContaining(['mvm-a', 'mvm-b']),
    );

    const delCalls = ddbMock.commandCalls(DeleteItemCommand);
    const deletedNames = delCalls.map(
      (c) => c.args[0].input.Key?.runnerName?.S,
    );
    // second row completed its full reconciliation (row deleted)...
    expect(deletedNames).toContain('microvm-runner-x-bbbbbbbb');
    // ...but the first row's terminate threw before its deleteRow ran.
    expect(deletedNames).not.toContain('microvm-runner-x-aaaaaaaa');

    const logLines = logSpy.mock.calls.map((c) => c[0] as string);
    const emfLine = logLines.find((line) => line.includes('"_aws"'));
    expect(emfLine).toBeDefined();
    const parsed = JSON.parse(emfLine as string) as { errors: number };
    expect(parsed.errors).toBeGreaterThanOrEqual(1);

    const structuredErrorLine = logLines.find((line) => {
      try {
        const p = JSON.parse(line) as Record<string, unknown>;
        return p.scope === 'reconcile' && p.err !== undefined;
      } catch {
        return false;
      }
    });
    expect(structuredErrorLine).toBeDefined();

    logSpy.mockRestore();
  });

  it('an image-version delete throwing does not stop pruning the rest, and is counted in the errors metric', async () => {
    mvmMock.on(ListMicrovmImageVersionsCommand).resolves({
      items: [
        {
          baseImageArn: 'arn:aws:lambda:us-east-1:1:microvm-image:base',
          buildRoleArn: 'arn:aws:iam::1:role/build',
          codeArtifact: { uri: 's3://bucket/key' },
          imageArn: IMAGE_ARN_DEFAULT,
          imageVersion: 'v2',
          state: 'SUCCESSFUL' as const,
          status: 'INACTIVE' as const,
          createdAt: new Date(NOW_MS - 20_000),
        },
        {
          baseImageArn: 'arn:aws:lambda:us-east-1:1:microvm-image:base',
          buildRoleArn: 'arn:aws:iam::1:role/build',
          codeArtifact: { uri: 's3://bucket/key' },
          imageArn: IMAGE_ARN_DEFAULT,
          imageVersion: 'v1',
          state: 'SUCCESSFUL' as const,
          status: 'INACTIVE' as const,
          createdAt: new Date(NOW_MS - 30_000),
        },
      ],
    });
    setEnv({ KEEP_IMAGE_VERSIONS: '0' });
    mvmMock.on(DeleteMicrovmImageVersionCommand).callsFake((input) => {
      if (input.imageVersion === 'v2') {
        throw new Error('boom: delete failed');
      }
      return {
        imageIdentifier: IMAGE_ARN_DEFAULT,
        imageVersion: input.imageVersion,
        state: 'DELETING',
      };
    });
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await handler();

    const delCalls = mvmMock.commandCalls(DeleteMicrovmImageVersionCommand);
    expect(delCalls.map((c) => c.args[0].input.imageVersion)).toEqual(
      expect.arrayContaining(['v1', 'v2']),
    );

    const emfLine = logSpy.mock.calls
      .map((c) => c[0] as string)
      .find((line) => line.includes('"_aws"'));
    const parsed = JSON.parse(emfLine as string) as {
      errors: number;
      imageVersionsPruned: number;
    };
    expect(parsed.errors).toBeGreaterThanOrEqual(1);
    expect(parsed.imageVersionsPruned).toBe(1);

    logSpy.mockRestore();
  });
});

describe('EMF metrics output', () => {
  it('emits a CloudWatch EMF envelope with the expected shape and counters', async () => {
    setRunnerSetVms([
      { microvmId: 'mvm-busy' },
      { microvmId: 'mvm-lifetime', ageSeconds: LIFETIME_CAP_SECONDS + 1 },
    ]);
    setTableRows([
      normalRow({
        runnerName: 'microvm-runner-x-busy0001',
        microvmId: 'mvm-busy',
        suspectSince: isoMinusSeconds(10),
      }),
      normalRow({
        runnerName: 'microvm-runner-x-life0001',
        microvmId: 'mvm-lifetime',
      }),
    ]);
    listRunnersMock.mockResolvedValue([
      githubRunner({ id: 1, name: 'microvm-runner-x-busy0001', busy: true }),
    ]);
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await handler();

    const emfLine = logSpy.mock.calls
      .map((c) => c[0] as string)
      .find((line) => line.includes('"_aws"'));
    expect(emfLine).toBeDefined();
    const parsed = JSON.parse(emfLine as string) as {
      _aws: {
        CloudWatchMetrics: {
          Namespace: string;
          Dimensions: string[][];
          Metrics: { Name: string; Unit: string }[];
        }[];
      };
      RunnerSetId: string;
      suspectsCleared: number;
      lifetimeKills: number;
      orphansReaped: number;
      stuckRunnersReaped: number;
      imageVersionsPruned: number;
      tableRowsCleaned: number;
    };

    expect(parsed._aws.CloudWatchMetrics[0].Namespace).toBe('MicrovmRunners');
    expect(parsed._aws.CloudWatchMetrics[0].Dimensions).toEqual([
      ['RunnerSetId'],
    ]);
    const metricNames = parsed._aws.CloudWatchMetrics[0].Metrics.map(
      (m) => m.Name,
    );
    expect(metricNames).toEqual(
      expect.arrayContaining([
        'orphansReaped',
        'stuckRunnersReaped',
        'suspectsCleared',
        'lifetimeKills',
        'imageVersionsPruned',
        'tableRowsCleaned',
      ]),
    );
    expect(parsed.RunnerSetId).toBe('x');
    expect(parsed.suspectsCleared).toBe(1);
    expect(parsed.lifetimeKills).toBe(1);
    logSpy.mockRestore();
  });
});

describe('recoverStuckLaunches: DLQ recovery on control-plane outage recovery', () => {
  function enableRecovery(): void {
    process.env.RECOVER_STUCK_LAUNCHES = 'true';
    process.env.JOB_QUEUE_URL = JOB_QUEUE_URL;
    process.env.DEAD_LETTER_QUEUE_URL = DLQ_URL;
  }

  function dlqMessage(
    overrides: {
      kind?: string;
      repo?: string;
      jobId?: number;
      receiptHandle?: string;
      messageId?: string;
    } = {},
  ) {
    return {
      MessageId: overrides.messageId ?? 'm1',
      ReceiptHandle: overrides.receiptHandle ?? 'rh1',
      Body: JSON.stringify({
        kind: overrides.kind ?? 'launch',
        repo: overrides.repo ?? 'acme/widgets',
        jobId: overrides.jobId ?? 1001,
        runId: 55,
        labels: ['self-hosted', 'microvm'],
      }),
    };
  }

  function setDlq(messages: ReturnType<typeof dlqMessage>[]): void {
    sqsMock
      .on(ReceiveMessageCommand)
      .resolvesOnce({ Messages: messages })
      .resolves({ Messages: [] });
  }

  it('does nothing when the feature is disabled (default) — never touches the DLQ', async () => {
    // Feature off: even with messages waiting, no ReceiveMessage is issued.
    setDlq([dlqMessage()]);
    getWorkflowJobMock.mockResolvedValue({ status: 'queued' } as {
      status: string;
      labels: string[];
      runId: number;
    });

    await handler();

    expect(sqsMock.commandCalls(ReceiveMessageCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    expect(getWorkflowJobMock).not.toHaveBeenCalled();
  });

  it('re-drives a still-queued launch onto the job queue and deletes it from the DLQ', async () => {
    enableRecovery();
    const body = JSON.stringify({
      kind: 'launch',
      repo: 'acme/widgets',
      jobId: 1001,
      runId: 55,
      labels: ['self-hosted', 'microvm'],
    });
    setDlq([dlqMessage()]);
    getWorkflowJobMock.mockResolvedValue({ status: 'queued' } as {
      status: string;
      labels: string[];
      runId: number;
    });
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await handler();

    // Send-then-delete, both against the right queues.
    const sends = sqsMock.commandCalls(SendMessageCommand);
    expect(sends).toHaveLength(1);
    expect(sends[0].args[0].input.QueueUrl).toBe(JOB_QUEUE_URL);
    expect(sends[0].args[0].input.MessageBody).toBe(body);
    const deletes = sqsMock.commandCalls(DeleteMessageCommand);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].args[0].input.QueueUrl).toBe(DLQ_URL);
    expect(deletes[0].args[0].input.ReceiptHandle).toBe('rh1');

    // Freshness read addressed the job's repo, not the runner set org.
    expect(getWorkflowJobMock).toHaveBeenCalledWith(
      { org: 'acme' },
      'acme',
      'widgets',
      1001,
    );

    const emfLine = logSpy.mock.calls
      .map((c) => c[0] as string)
      .find((line) => line.includes('"_aws"'));
    const parsed = JSON.parse(emfLine as string) as {
      stuckLaunchesRecovered: number;
      errors: number;
    };
    expect(parsed.stuckLaunchesRecovered).toBe(1);
    expect(parsed.errors).toBe(0);
    logSpy.mockRestore();
  });

  it('discards (deletes, does not re-drive) a launch whose job is no longer queued', async () => {
    enableRecovery();
    setDlq([dlqMessage()]);
    getWorkflowJobMock.mockResolvedValue({ status: 'in_progress' } as {
      status: string;
      labels: string[];
      runId: number;
    });

    await handler();

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    const deletes = sqsMock.commandCalls(DeleteMessageCommand);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].args[0].input.QueueUrl).toBe(DLQ_URL);
  });

  it('discards a launch whose job no longer exists (GitHub 404 -> undefined)', async () => {
    enableRecovery();
    setDlq([dlqMessage()]);
    getWorkflowJobMock.mockResolvedValue(undefined);

    await handler();

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(1);
  });

  it('isolates a GitHub read error — leaves the message in the DLQ and still completes the sweep', async () => {
    enableRecovery();
    setDlq([dlqMessage()]);
    getWorkflowJobMock.mockRejectedValue(new Error('503 outage'));
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await expect(handler()).resolves.toBeUndefined();

    // Neither re-driven nor discarded — left for a later sweep.
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    const emfLine = logSpy.mock.calls
      .map((c) => c[0] as string)
      .find((line) => line.includes('"_aws"'));
    const parsed = JSON.parse(emfLine as string) as {
      stuckLaunchesRecovered: number;
      errors: number;
    };
    expect(parsed.stuckLaunchesRecovered).toBe(0);
    expect(parsed.errors).toBe(1);
    logSpy.mockRestore();
  });

  it('leaves a non-launch (terminate) DLQ message untouched', async () => {
    enableRecovery();
    setDlq([dlqMessage({ kind: 'terminate' })]);

    await handler();

    expect(getWorkflowJobMock).not.toHaveBeenCalled();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(0);
  });

  it('keeps pulling past a partial batch — drains across multiple receives until empty', async () => {
    enableRecovery();
    // A partial batch (<10) is NOT "drained": the sweep must keep receiving.
    sqsMock
      .on(ReceiveMessageCommand)
      .resolvesOnce({
        Messages: [dlqMessage({ jobId: 1, receiptHandle: 'rh-a' })],
      })
      .resolvesOnce({
        Messages: [dlqMessage({ jobId: 2, receiptHandle: 'rh-b' })],
      })
      .resolves({ Messages: [] });
    getWorkflowJobMock.mockResolvedValue({ status: 'queued' } as {
      status: string;
      labels: string[];
      runId: number;
    });

    await handler();

    // Both partial batches were processed, not just the first.
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(2);
    const deleted = sqsMock
      .commandCalls(DeleteMessageCommand)
      .map((c) => c.args[0].input.ReceiptHandle);
    expect(deleted).toEqual(expect.arrayContaining(['rh-a', 'rh-b']));
    // At least three receives: batch, batch, empty-terminator.
    expect(
      sqsMock.commandCalls(ReceiveMessageCommand).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('leaves a malformed (non-JSON) body without erroring — not counted as a sweep error', async () => {
    enableRecovery();
    sqsMock
      .on(ReceiveMessageCommand)
      .resolvesOnce({
        Messages: [{ MessageId: 'm1', ReceiptHandle: 'rh1', Body: 'not json' }],
      })
      .resolves({ Messages: [] });
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await handler();

    expect(getWorkflowJobMock).not.toHaveBeenCalled();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    const emfLine = logSpy.mock.calls
      .map((c) => c[0] as string)
      .find((line) => line.includes('"_aws"'));
    const parsed = JSON.parse(emfLine as string) as { errors: number };
    expect(parsed.errors).toBe(0);
    logSpy.mockRestore();
  });

  it('leaves a message with no ReceiptHandle untouched (cannot delete or re-drive it)', async () => {
    enableRecovery();
    sqsMock
      .on(ReceiveMessageCommand)
      .resolvesOnce({
        Messages: [{ MessageId: 'm1', Body: dlqMessage().Body }],
      })
      .resolves({ Messages: [] });

    await handler();

    expect(getWorkflowJobMock).not.toHaveBeenCalled();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(0);
  });
});

describe('recoverStuckLaunches: committed-but-unserved claim reconciliation', () => {
  function enableRecovery(): void {
    process.env.RECOVER_STUCK_LAUNCHES = 'true';
    process.env.JOB_QUEUE_URL = JOB_QUEUE_URL;
    process.env.DEAD_LETTER_QUEUE_URL = DLQ_URL;
  }

  // A committed claim row: microvmId is a real (non-'pending') id.
  function committedClaim(): RowFixture {
    return {
      runnerName: 'job#acme/widgets#1001',
      microvmId: 'mvm-committed',
      repo: 'acme/widgets',
      jobId: 1001,
      expiresAt: Math.floor(NOW_MS / 1000) + 999_999, // not expired
    };
  }

  it('re-launches a committed claim whose VM is gone and job is still queued', async () => {
    enableRecovery();
    setTableRows([committedClaim()]);
    // getMicrovm('mvm-committed') -> NotFound (default mock) -> VM dead.
    getWorkflowJobMock.mockResolvedValue({
      status: 'queued',
      labels: ['self-hosted', 'microvm'],
      runId: 42,
    });
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await handler();

    // Claim deleted, launch re-sent, metric bumped.
    const deletes = ddbMock.commandCalls(DeleteItemCommand);
    expect(
      deletes.some(
        (c) => c.args[0].input.Key?.runnerName?.S === 'job#acme/widgets#1001',
      ),
    ).toBe(true);
    const sends = sqsMock.commandCalls(SendMessageCommand);
    expect(sends).toHaveLength(1);
    expect(sends[0].args[0].input.QueueUrl).toBe(JOB_QUEUE_URL);
    expect(JSON.parse(sends[0].args[0].input.MessageBody as string)).toEqual({
      kind: 'launch',
      repo: 'acme/widgets',
      jobId: 1001,
      runId: 42,
      labels: ['self-hosted', 'microvm'],
    });
    const emfLine = logSpy.mock.calls
      .map((c) => c[0] as string)
      .find((line) => line.includes('"_aws"'));
    const parsed = JSON.parse(emfLine as string) as {
      stuckClaimsRelaunched: number;
    };
    expect(parsed.stuckClaimsRelaunched).toBe(1);
    logSpy.mockRestore();
  });

  it('M1: if SendMessage fails AFTER the claim is deleted, the claim is RESTORED (no permanent strand) and the sweep survives', async () => {
    enableRecovery();
    setTableRows([committedClaim()]);
    getWorkflowJobMock.mockResolvedValue({
      status: 'queued',
      labels: ['self-hosted', 'microvm'],
      runId: 42,
    });
    // The failure the fix targets: delete ok, send fails.
    sqsMock
      .on(SendMessageCommand)
      .rejects(Object.assign(new Error('sqs down'), { name: 'Error' }));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    // Caller isolates the error → the whole sweep still completes.
    await expect(handler()).resolves.not.toThrow();

    // The claim was deleted (delete-before-send) …
    const deleted = ddbMock
      .commandCalls(DeleteItemCommand)
      .some(
        (c) => c.args[0].input.Key?.runnerName?.S === 'job#acme/widgets#1001',
      );
    expect(deleted).toBe(true);
    // … and then RESTORED via PutItem so the next sweep retries — without
    // this, the claim would be gone with no launch enqueued = permanent strand.
    const restored = ddbMock
      .commandCalls(PutItemCommand)
      .some(
        (c) => c.args[0].input.Item?.runnerName?.S === 'job#acme/widgets#1001',
      );
    expect(restored).toBe(true);
    jest.restoreAllMocks();
  });

  it('does not re-launch when the job is no longer queued', async () => {
    enableRecovery();
    setTableRows([committedClaim()]);
    getWorkflowJobMock.mockResolvedValue({
      status: 'in_progress',
      labels: ['self-hosted', 'microvm'],
      runId: 42,
    });

    await handler();

    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    const deletes = ddbMock.commandCalls(DeleteItemCommand);
    expect(
      deletes.some(
        (c) => c.args[0].input.Key?.runnerName?.S === 'job#acme/widgets#1001',
      ),
    ).toBe(false);
  });

  it('does not re-launch when the committed VM is still RUNNING', async () => {
    enableRecovery();
    setTableRows([committedClaim()]);
    mvmMock
      .on(GetMicrovmCommand, { microvmIdentifier: 'mvm-committed' })
      .resolves({
        microvmId: 'mvm-committed',
        state: 'RUNNING' as never,
        imageArn: IMAGE_ARN_DEFAULT,
        imageVersion: '1',
        startedAt: new Date(NOW_MS - 60_000),
      });

    await handler();

    expect(getWorkflowJobMock).not.toHaveBeenCalled();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('ignores a pending (uncommitted) claim', async () => {
    enableRecovery();
    setTableRows([{ ...committedClaim(), microvmId: 'pending' }]);

    await handler();

    expect(getWorkflowJobMock).not.toHaveBeenCalled();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('does nothing when the feature is disabled', async () => {
    // No enableRecovery() -> RECOVER_STUCK_LAUNCHES unset.
    setTableRows([committedClaim()]);
    getWorkflowJobMock.mockResolvedValue({
      status: 'queued',
      labels: ['self-hosted', 'microvm'],
      runId: 42,
    });

    await handler();

    expect(getWorkflowJobMock).not.toHaveBeenCalled();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('isolates a send failure: logs an error, bumps errors, sweep completes', async () => {
    enableRecovery();
    setTableRows([committedClaim()]);
    getWorkflowJobMock.mockResolvedValue({
      status: 'queued',
      labels: ['self-hosted', 'microvm'],
      runId: 42,
    });
    sqsMock.on(SendMessageCommand).rejects(new Error('sqs down'));
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await expect(handler()).resolves.toBeUndefined();

    const emfLine = logSpy.mock.calls
      .map((c) => c[0] as string)
      .find((line) => line.includes('"_aws"'));
    const parsed = JSON.parse(emfLine as string) as {
      errors: number;
      stuckClaimsRelaunched: number;
    };
    expect(parsed.errors).toBeGreaterThanOrEqual(1);
    expect(parsed.stuckClaimsRelaunched).toBe(0);
    logSpy.mockRestore();
  });

  it('caps committed-claim reconciliation (getWorkflowJob probes) at COMMITTED_CLAIM_RECONCILE_CAP per sweep', async () => {
    enableRecovery();
    // COMMITTED_CLAIM_RECONCILE_CAP in src/handlers/janitor.ts is 25; use
    // more than that many committed dead-VM claims, all with queued jobs, so
    // an uncapped sweep would probe GitHub for every one of them.
    const CAP = 25;
    const rows: RowFixture[] = Array.from({ length: CAP + 3 }, (_, i) => ({
      runnerName: `job#acme/widgets#${2000 + i}`,
      microvmId: `mvm-committed-${i}`,
      repo: 'acme/widgets',
      jobId: 2000 + i,
      expiresAt: Math.floor(NOW_MS / 1000) + 999_999, // not expired
    }));
    setTableRows(rows);
    // getMicrovm(...) -> NotFound (default mock) -> every VM reads dead.
    getWorkflowJobMock.mockResolvedValue({
      status: 'queued',
      labels: ['self-hosted', 'microvm'],
      runId: 42,
    });

    await handler();

    expect(getWorkflowJobMock.mock.calls.length).toBeLessThanOrEqual(CAP);
  });
});
