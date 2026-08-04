import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { mockClient } from 'aws-sdk-client-mock';

import {
  createMicrovmAuthToken,
  getMicrovm,
  listRunnerSetVms,
  listSuspendedVmsForImage,
  MicrovmWaitTimeoutError,
  resumeMicrovm,
  runMicrovm,
  suspendMicrovm,
  waitForMicrovmRunning,
} from '../../src/handlers/shared/microvm-client.js';

const mvmMock = mockClient(LambdaMicrovmsClient);

const IMAGE_ARN = 'arn:aws:lambda:us-east-1:1:microvm-image:default-image';
const ROLE_ARN = 'arn:aws:iam::1:role/vm-role';
const VM_ENDPOINT = 'mvm-123.lambda-microvm.us-east-1.on.aws';

beforeEach(() => {
  mvmMock.reset();
  jest.useFakeTimers();
});

describe('runMicrovm', () => {
  it('sends RunMicrovm with ingressNetworkConnectors passthrough and NO runHookPayload field', async () => {
    mvmMock.on(RunMicrovmCommand).resolves({
      microvmId: 'mvm-123',
      state: 'PENDING',
      endpoint: VM_ENDPOINT,
      imageArn: IMAGE_ARN,
      imageVersion: '1',
      maximumDurationInSeconds: 3900,
      startedAt: new Date(),
    });

    const id = await runMicrovm({
      imageArn: IMAGE_ARN,
      executionRoleArn: ROLE_ARN,
      maximumDurationInSeconds: 3900,
      ingressNetworkConnectors: [
        'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS',
      ],
    });

    expect(id).toBe('mvm-123');
    const call = mvmMock.commandCalls(RunMicrovmCommand)[0];
    expect(call.args[0].input.ingressNetworkConnectors).toEqual([
      'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS',
    ]);
    expect(call.args[0].input).not.toHaveProperty('runHookPayload');
  });

  it('tolerates logging: undefined — the field is omitted from the RunMicrovm request rather than sent as an explicit null/undefined value', async () => {
    mvmMock.on(RunMicrovmCommand).resolves({
      microvmId: 'mvm-123',
      state: 'PENDING',
      endpoint: VM_ENDPOINT,
      imageArn: IMAGE_ARN,
      imageVersion: '1',
      maximumDurationInSeconds: 3900,
      startedAt: new Date(),
    });

    await runMicrovm({
      imageArn: IMAGE_ARN,
      maximumDurationInSeconds: 3900,
      ingressNetworkConnectors: [],
      logging: undefined,
    });

    const call = mvmMock.commandCalls(RunMicrovmCommand)[0];
    expect(call.args[0].input).not.toHaveProperty('logging');
  });

  it('M3: powerless VM (no executionRoleArn) omits the key entirely — never sends executionRoleArn: undefined (the security-critical default must not depend on the marshaller dropping undefined)', async () => {
    mvmMock.on(RunMicrovmCommand).resolves({
      microvmId: 'mvm-123',
      state: 'PENDING',
      endpoint: VM_ENDPOINT,
      imageArn: IMAGE_ARN,
      imageVersion: '1',
      maximumDurationInSeconds: 3900,
      startedAt: new Date(),
    });

    await runMicrovm({
      imageArn: IMAGE_ARN,
      maximumDurationInSeconds: 3900,
      ingressNetworkConnectors: [],
      // executionRoleArn omitted ⇒ powerless VM
    });

    const call = mvmMock.commandCalls(RunMicrovmCommand)[0];
    expect(call.args[0].input).not.toHaveProperty('executionRoleArn');
  });

  it('a supplied executionRoleArn IS carried through', async () => {
    mvmMock.on(RunMicrovmCommand).resolves({
      microvmId: 'mvm-123',
      state: 'PENDING',
      endpoint: VM_ENDPOINT,
      imageArn: IMAGE_ARN,
      imageVersion: '1',
      maximumDurationInSeconds: 3900,
      startedAt: new Date(),
    });

    await runMicrovm({
      imageArn: IMAGE_ARN,
      maximumDurationInSeconds: 3900,
      ingressNetworkConnectors: [],
      executionRoleArn: ROLE_ARN,
    });

    const call = mvmMock.commandCalls(RunMicrovmCommand)[0];
    expect(call.args[0].input.executionRoleArn).toBe(ROLE_ARN);
  });

  it('idlePolicy: undefined — the field is omitted from the RunMicrovm request', async () => {
    mvmMock.on(RunMicrovmCommand).resolves({
      microvmId: 'mvm-123',
      state: 'PENDING',
      endpoint: VM_ENDPOINT,
      imageArn: IMAGE_ARN,
      imageVersion: '1',
      maximumDurationInSeconds: 3900,
      startedAt: new Date(),
    });

    await runMicrovm({
      imageArn: IMAGE_ARN,
      maximumDurationInSeconds: 3900,
      ingressNetworkConnectors: [],
    });

    const call = mvmMock.commandCalls(RunMicrovmCommand)[0];
    expect(call.args[0].input).not.toHaveProperty('idlePolicy');
  });

  it('idlePolicy set — the command carries the mapped seconds/flags', async () => {
    mvmMock.on(RunMicrovmCommand).resolves({
      microvmId: 'mvm-123',
      state: 'PENDING',
      endpoint: VM_ENDPOINT,
      imageArn: IMAGE_ARN,
      imageVersion: '1',
      maximumDurationInSeconds: 3900,
      startedAt: new Date(),
    });

    await runMicrovm({
      imageArn: IMAGE_ARN,
      maximumDurationInSeconds: 3900,
      ingressNetworkConnectors: [],
      idlePolicy: {
        maxIdleDurationSeconds: 300,
        suspendedDurationSeconds: 3600,
        autoResumeEnabled: true,
      },
    });

    const call = mvmMock.commandCalls(RunMicrovmCommand)[0];
    expect(call.args[0].input.idlePolicy).toEqual({
      maxIdleDurationSeconds: 300,
      suspendedDurationSeconds: 3600,
      autoResumeEnabled: true,
    });
  });

  it('idlePolicy with NO autoResume — the exact live-failing case — the emitted idlePolicy always has exactly maxIdleDurationSeconds, suspendedDurationSeconds, autoResumeEnabled, and autoResumeEnabled defaults to false', async () => {
    mvmMock.on(RunMicrovmCommand).resolves({
      microvmId: 'mvm-123',
      state: 'PENDING',
      endpoint: VM_ENDPOINT,
      imageArn: IMAGE_ARN,
      imageVersion: '1',
      maximumDurationInSeconds: 3900,
      startedAt: new Date(),
    });

    await runMicrovm({
      imageArn: IMAGE_ARN,
      maximumDurationInSeconds: 3900,
      ingressNetworkConnectors: [],
      idlePolicy: {
        maxIdleDurationSeconds: 300,
        suspendedDurationSeconds: 600,
      },
    });

    const call = mvmMock.commandCalls(RunMicrovmCommand)[0];
    const idlePolicy = call.args[0].input.idlePolicy as unknown as Record<
      string,
      unknown
    >;
    // ALL THREE members are service-required (see microvm-client.ts's
    // comment block on `runMicrovm` for both verbatim ValidationExceptions).
    // This exact no-autoResume shape is what failed every live launch until
    // autoResumeEnabled was always-sent — REGRESSION GUARD. Previously this
    // suite also asserted `suspendedDurationSeconds` was ABSENT when the
    // caller omitted it; that contract is now inverted (the service demands
    // it), so that assertion has been deleted rather than inverted-in-place.
    expect(Object.keys(idlePolicy).sort()).toEqual([
      'autoResumeEnabled',
      'maxIdleDurationSeconds',
      'suspendedDurationSeconds',
    ]);
    expect(idlePolicy.autoResumeEnabled).toBe(false);
    expect(idlePolicy.suspendedDurationSeconds).toBe(600);
  });

  it('throws when RunMicrovm returns no microvmId', async () => {
    mvmMock.on(RunMicrovmCommand).resolves({});

    await expect(
      runMicrovm({
        imageArn: IMAGE_ARN,
        executionRoleArn: ROLE_ARN,
        maximumDurationInSeconds: 3900,
        ingressNetworkConnectors: [],
      }),
    ).rejects.toThrow('RunMicrovm returned no microvmId');
  });
});

describe('getMicrovm', () => {
  it('includes endpoint in the returned RunnerSetVm when present', async () => {
    mvmMock.on(GetMicrovmCommand).resolves({
      microvmId: 'mvm-123',
      state: 'RUNNING',
      endpoint: VM_ENDPOINT,
      imageArn: IMAGE_ARN,
      imageVersion: '1',
      maximumDurationInSeconds: 3900,
      startedAt: new Date(),
    });

    const vm = await getMicrovm('mvm-123');

    expect(vm?.endpoint).toBe(VM_ENDPOINT);
    expect(vm?.state).toBe('RUNNING');
  });
});

describe('createMicrovmAuthToken', () => {
  it('extracts the X-aws-proxy-auth value from the authToken map', async () => {
    mvmMock.on(CreateMicrovmAuthTokenCommand).resolves({
      authToken: { 'X-aws-proxy-auth': 'the-token' },
    });

    const token = await createMicrovmAuthToken('mvm-123', 5, 8080);

    expect(token).toBe('the-token');
    const call = mvmMock.commandCalls(CreateMicrovmAuthTokenCommand)[0];
    expect(call.args[0].input).toEqual({
      microvmIdentifier: 'mvm-123',
      expirationInMinutes: 5,
      allowedPorts: [{ port: 8080 }],
    });
  });

  it('throws when the response has no authToken map or no X-aws-proxy-auth key', async () => {
    mvmMock.on(CreateMicrovmAuthTokenCommand).resolves({ authToken: {} });

    await expect(createMicrovmAuthToken('mvm-123', 5, 8080)).rejects.toThrow(
      'CreateMicrovmAuthToken returned no X-aws-proxy-auth token',
    );
  });
});

describe('suspendMicrovm', () => {
  it('sends SuspendMicrovmCommand with the correct microvmIdentifier', async () => {
    mvmMock.on(SuspendMicrovmCommand).resolves({});

    await suspendMicrovm('mvm-123');

    const call = mvmMock.commandCalls(SuspendMicrovmCommand)[0];
    expect(call.args[0].input).toEqual({
      microvmIdentifier: 'mvm-123',
    });
  });
});

describe('resumeMicrovm', () => {
  it('sends ResumeMicrovmCommand with the correct microvmIdentifier', async () => {
    mvmMock.on(ResumeMicrovmCommand).resolves({});

    await resumeMicrovm('mvm-123');

    const call = mvmMock.commandCalls(ResumeMicrovmCommand)[0];
    expect(call.args[0].input).toEqual({
      microvmIdentifier: 'mvm-123',
    });
  });
});

describe('listSuspendedVmsForImage', () => {
  it('returns only SUSPENDED microvmIds whose imageArn matches the argument', async () => {
    const OTHER_IMAGE_ARN =
      'arn:aws:lambda:us-east-1:1:microvm-image:other-image';
    mvmMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: 'mvm-suspended-match',
          state: 'SUSPENDED',
          imageArn: IMAGE_ARN,
          imageVersion: '1',
          startedAt: new Date(),
        },
        {
          microvmId: 'mvm-running-match',
          state: 'RUNNING',
          imageArn: IMAGE_ARN,
          imageVersion: '1',
          startedAt: new Date(),
        },
        {
          microvmId: 'mvm-suspended-other-image',
          state: 'SUSPENDED',
          imageArn: OTHER_IMAGE_ARN,
          imageVersion: '1',
          startedAt: new Date(),
        },
      ],
    });

    const ids = await listSuspendedVmsForImage(IMAGE_ARN);

    expect(ids.map((v) => v.microvmId)).toEqual(['mvm-suspended-match']);
  });

  it('paginates via nextToken across multiple ListMicrovms pages', async () => {
    mvmMock
      .on(ListMicrovmsCommand)
      .resolvesOnce({
        items: [
          {
            microvmId: 'mvm-page1',
            state: 'SUSPENDED',
            imageArn: IMAGE_ARN,
            imageVersion: '1',
            startedAt: new Date(),
          },
        ],
        nextToken: 'token-2',
      })
      .resolves({
        items: [
          {
            microvmId: 'mvm-page2',
            state: 'SUSPENDED',
            imageArn: IMAGE_ARN,
            imageVersion: '1',
            startedAt: new Date(),
          },
        ],
      });

    const ids = await listSuspendedVmsForImage(IMAGE_ARN);

    expect(ids.map((v) => v.microvmId)).toEqual(['mvm-page1', 'mvm-page2']);
    const calls = mvmMock.commandCalls(ListMicrovmsCommand);
    expect(calls).toHaveLength(2);
    // maxResults: the service maximum, so a busy account pages fewer times.
    // imageIdentifier: a server-side filter, so the walk no longer fetches
    // every other image's VMs only to discard them here.
    expect(calls[1].args[0].input).toEqual({
      imageIdentifier: IMAGE_ARN,
      maxResults: 50,
      nextToken: 'token-2',
    });
  });

  it('returns an empty array when nothing matches', async () => {
    mvmMock.on(ListMicrovmsCommand).resolves({
      items: [
        {
          microvmId: 'mvm-running',
          state: 'RUNNING',
          imageArn: IMAGE_ARN,
          imageVersion: '1',
          startedAt: new Date(),
        },
      ],
    });

    const ids = await listSuspendedVmsForImage(IMAGE_ARN);

    expect(ids).toEqual([]);
  });

  it('retries a ListMicrovms ThrottlingException and returns once a retry clears', async () => {
    const throttleErr = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
    });
    mvmMock
      .on(ListMicrovmsCommand)
      .rejectsOnce(throttleErr)
      .rejectsOnce(throttleErr)
      .resolves({
        items: [
          {
            microvmId: 'mvm-after-retry',
            state: 'SUSPENDED',
            imageArn: IMAGE_ARN,
            imageVersion: '1',
            startedAt: new Date(),
          },
        ],
      });

    const resultPromise = listSuspendedVmsForImage(IMAGE_ARN);
    await jest.advanceTimersByTimeAsync(5_000);
    const ids = await resultPromise;

    expect(ids.map((v) => v.microvmId)).toEqual(['mvm-after-retry']);
    expect(mvmMock.commandCalls(ListMicrovmsCommand)).toHaveLength(3);
  });

  it('throws after the bounded retry cap when every ListMicrovms attempt throttles (does not loop forever)', async () => {
    const throttleErr = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
    });
    mvmMock.on(ListMicrovmsCommand).rejects(throttleErr);

    const resultPromise = listSuspendedVmsForImage(IMAGE_ARN);
    resultPromise.catch(() => {
      // Prevent an unhandled-rejection warning before the assertion below
      // has a chance to attach its own handler via `.rejects`.
    });
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(resultPromise).rejects.toThrow('Rate exceeded');
    expect(mvmMock.commandCalls(ListMicrovmsCommand)).toHaveLength(4);
  });

  it('rethrows a non-throttle error immediately with no retry', async () => {
    const validationErr = Object.assign(new Error('bad input'), {
      name: 'ValidationException',
    });
    mvmMock.on(ListMicrovmsCommand).rejects(validationErr);

    await expect(listSuspendedVmsForImage(IMAGE_ARN)).rejects.toThrow(
      'bad input',
    );
    expect(mvmMock.commandCalls(ListMicrovmsCommand)).toHaveLength(1);
  });
});

describe('waitForMicrovmRunning', () => {
  it('resolves with state and endpoint once GetMicrovm reports RUNNING', async () => {
    mvmMock
      .on(GetMicrovmCommand)
      .resolvesOnce({
        microvmId: 'mvm-123',
        state: 'PENDING',
        endpoint: VM_ENDPOINT,
        imageArn: IMAGE_ARN,
        imageVersion: '1',
        maximumDurationInSeconds: 3900,
        startedAt: new Date(),
      })
      .resolves({
        microvmId: 'mvm-123',
        state: 'RUNNING',
        endpoint: VM_ENDPOINT,
        imageArn: IMAGE_ARN,
        imageVersion: '1',
        maximumDurationInSeconds: 3900,
        startedAt: new Date(),
      });

    const resultPromise = waitForMicrovmRunning('mvm-123', {
      timeoutMs: 10_000,
      intervalMs: 1_000,
    });
    await jest.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result).toEqual({ state: 'RUNNING', endpoint: VM_ENDPOINT });
  });

  it('tolerates a transient undefined getMicrovm result (treated like "not yet running")', async () => {
    mvmMock
      .on(GetMicrovmCommand)
      .rejectsOnce(
        Object.assign(new Error('gone (transient)'), {
          name: 'ResourceNotFoundException',
        }),
      )
      .resolves({
        microvmId: 'mvm-123',
        state: 'RUNNING',
        endpoint: VM_ENDPOINT,
        imageArn: IMAGE_ARN,
        imageVersion: '1',
        maximumDurationInSeconds: 3900,
        startedAt: new Date(),
      });

    const resultPromise = waitForMicrovmRunning('mvm-123', {
      timeoutMs: 10_000,
      intervalMs: 1_000,
    });
    await jest.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result).toEqual({ state: 'RUNNING', endpoint: VM_ENDPOINT });
  });

  it('throws MicrovmWaitTimeoutError once the timeout budget is exhausted', async () => {
    mvmMock.on(GetMicrovmCommand).resolves({
      microvmId: 'mvm-123',
      state: 'PENDING',
      endpoint: VM_ENDPOINT,
      imageArn: IMAGE_ARN,
      imageVersion: '1',
      maximumDurationInSeconds: 3900,
      startedAt: new Date(),
    });

    const resultPromise = waitForMicrovmRunning('mvm-123', {
      timeoutMs: 5_000,
      intervalMs: 1_000,
    });
    resultPromise.catch(() => {
      // Prevent an unhandled-rejection warning before the assertion below
      // has a chance to attach its own handler via `.rejects`.
    });
    await jest.advanceTimersByTimeAsync(6_000);

    await expect(resultPromise).rejects.toThrow(MicrovmWaitTimeoutError);
  });
});

describe('ListMicrovms paging', () => {
  // The account's VM list keeps TERMINATED entries for about a day and cannot
  // be filtered by state server-side, so every listing walks the whole recent
  // history of the account — and the launcher's capacity check does that
  // before every launch. At the SDK default of 10 per page an 18-way burst
  // issued 230+ calls in seconds, exhausted the throttle retry, and pushed
  // launches into a 180s SQS redrive: a burst that peaked at 18 concurrent
  // VMs collapsed to 7. 50 is the service maximum (100 is rejected with a
  // ValidationException) and ListMicrovms has no Service Quotas entry, so the
  // page size is the only lever. A regression here is a silent 5x increase in
  // calls under load.
  it('requests the largest page the service allows', async () => {
    mvmMock.on(ListMicrovmsCommand).resolves({ items: [] });

    await listRunnerSetVms([IMAGE_ARN], ['RUNNING']);

    const calls = mvmMock.commandCalls(ListMicrovmsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.maxResults).toBe(50);
  });

  it('pages with the same size, carrying the token forward', async () => {
    mvmMock
      .on(ListMicrovmsCommand)
      .resolvesOnce({ items: [], nextToken: 'page-2' })
      .resolves({ items: [] });

    await listRunnerSetVms([IMAGE_ARN], ['RUNNING']);

    const calls = mvmMock.commandCalls(ListMicrovmsCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input).toMatchObject({
      maxResults: 50,
      nextToken: 'page-2',
    });
  });
});
