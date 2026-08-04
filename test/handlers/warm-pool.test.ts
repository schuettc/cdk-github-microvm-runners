jest.mock('../../src/handlers/shared/microvm-client.js', () => ({
  listSuspendedVmsForImage: jest.fn(),
  runMicrovm: jest.fn(),
  waitForMicrovmRunning: jest.fn(),
  suspendMicrovm: jest.fn(),
  terminateMicrovm: jest.fn(),
}));

import {
  listSuspendedVmsForImage,
  runMicrovm,
  suspendMicrovm,
  terminateMicrovm,
  waitForMicrovmRunning,
} from '../../src/handlers/shared/microvm-client.js';
import { handler, planConvergence } from '../../src/handlers/warm-pool.js';

const listSuspendedVmsForImageMock = jest.mocked(listSuspendedVmsForImage);
const runMicrovmMock = jest.mocked(runMicrovm);
const waitForMicrovmRunningMock = jest.mocked(waitForMicrovmRunning);
const suspendMicrovmMock = jest.mocked(suspendMicrovm);
const terminateMicrovmMock = jest.mocked(terminateMicrovm);

/**
 * A pooled VM young enough to still serve a full job — the ordinary case.
 * Age matters now that the sweep retires VMs whose remaining platform
 * lifetime can no longer cover `MAX_JOB_DURATION_SECONDS` + grace, so every
 * fixture has to be explicit about it rather than implying "new".
 */
function freshWarmVm(microvmId: string): {
  microvmId: string;
  startedAtMs: number;
} {
  return { microvmId, startedAtMs: Date.now() };
}

const ORIGINAL_ENV = { ...process.env };

const IMAGE_ARN_DEFAULT =
  'arn:aws:lambda:us-east-1:1:microvm-image:default-image';
const IMAGE_ARN_8GB = 'arn:aws:lambda:us-east-1:1:microvm-image:8gb-image';

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (
      [
        'WARM_POOL_JSON',
        'SIZE_CLASSES_JSON',
        'IMAGE_ARN',
        'MAX_JOB_DURATION_SECONDS',
        'RUNNER_SET_VM_ROLE_ARN',
        'EGRESS_CONNECTOR_ARNS',
        'AWS_REGION',
        'LOGGING_JSON',
        'RUNNER_SET_ID',
      ].includes(key)
    ) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function setEnv(overrides: Record<string, string> = {}): void {
  process.env.WARM_POOL_JSON = JSON.stringify({ microvm: 3 });
  process.env.SIZE_CLASSES_JSON = JSON.stringify({
    microvm: { imageArn: IMAGE_ARN_DEFAULT },
    'microvm-8gb': { imageArn: IMAGE_ARN_8GB },
  });
  process.env.IMAGE_ARN = IMAGE_ARN_DEFAULT;
  process.env.MAX_JOB_DURATION_SECONDS = '3600';
  process.env.AWS_REGION = 'us-east-1';
  process.env.LOGGING_JSON = JSON.stringify({ kind: 'cloudWatch' });
  process.env.RUNNER_SET_ID = 'x';
  // Metric emission is opt-in (`GithubMicrovmRunnersProps.emitMetrics` ->
  // `EMIT_METRICS`, gated in `shared/emf.ts`'s `emitEmf`). The EMF assertions
  // below exercise the enabled path, so turn it on here; a dedicated test
  // covers the default-off no-op.
  process.env.EMIT_METRICS = 'true';
  Object.assign(process.env, overrides);
}

/** Finds and parses every EMF envelope (a `console.log` JSON line carrying `"_aws"`) among a log spy's calls. */
function findEmfEnvelopes(
  logSpy: ReturnType<typeof jest.spyOn>,
): Record<string, unknown>[] {
  return logSpy.mock.calls
    .map((c: unknown[]) => c[0] as string)
    .filter(
      (line: string) => typeof line === 'string' && line.includes('"_aws"'),
    )
    .map((line: string) => JSON.parse(line) as Record<string, unknown>);
}

let runMicrovmCounter: number;

beforeEach(() => {
  resetEnv();
  setEnv();
  runMicrovmCounter = 0;
  listSuspendedVmsForImageMock.mockReset();
  runMicrovmMock.mockReset();
  waitForMicrovmRunningMock.mockReset();
  suspendMicrovmMock.mockReset();
  terminateMicrovmMock.mockReset();
  listSuspendedVmsForImageMock.mockResolvedValue([freshWarmVm('mvm-warm-1')]);
  runMicrovmMock.mockImplementation(async () => {
    runMicrovmCounter += 1;
    return `mvm-new-${runMicrovmCounter}`;
  });
  waitForMicrovmRunningMock.mockResolvedValue({
    state: 'RUNNING',
    endpoint: 'https://mvm.example.invalid',
  });
  suspendMicrovmMock.mockResolvedValue(undefined);
  terminateMicrovmMock.mockResolvedValue(undefined);
});

describe('planConvergence (pure)', () => {
  it('current 2, target 5 -> launch 3', () => {
    expect(planConvergence(2, 5)).toEqual({ launch: 3 });
  });

  it('current 5, target 5 -> launch 0', () => {
    expect(planConvergence(5, 5)).toEqual({ launch: 0 });
  });

  it('current 6, target 5 (over target) -> launch 0, never negative', () => {
    expect(planConvergence(6, 5)).toEqual({ launch: 0 });
  });
});

describe('handler', () => {
  it('given 1 suspended VM and target 3, launches 2 cold VMs, waits each to RUNNING, and suspends each', async () => {
    await handler();

    expect(listSuspendedVmsForImageMock).toHaveBeenCalledWith(
      IMAGE_ARN_DEFAULT,
    );
    expect(runMicrovmMock).toHaveBeenCalledTimes(2);
    expect(runMicrovmMock.mock.calls[0][0]).toMatchObject({
      imageArn: IMAGE_ARN_DEFAULT,
      // The platform ceiling, NOT `maxJobDuration + grace` (which is what the
      // cold path uses and what this assertion used to require). The lifetime
      // clock starts here and runs while the VM waits in the pool, and it
      // cannot be re-armed on resume, so capping a pooled VM at the job budget
      // spends that budget on residency and kills the job mid-run.
      maximumDurationInSeconds: 28800,
    });
    expect(waitForMicrovmRunningMock).toHaveBeenCalledTimes(2);
    expect(suspendMicrovmMock).toHaveBeenCalledTimes(2);
    expect(suspendMicrovmMock).toHaveBeenCalledWith('mvm-new-1');
    expect(suspendMicrovmMock).toHaveBeenCalledWith('mvm-new-2');
    expect(terminateMicrovmMock).not.toHaveBeenCalled();
  });

  it('reuses the ingress/egress params RunMicrovm carries (same shape as the launcher cold path)', async () => {
    process.env.EGRESS_CONNECTOR_ARNS = JSON.stringify([
      'arn:aws:lambda:us-east-1:1:network-connector:egress-1',
    ]);

    await handler();

    const runInput = runMicrovmMock.mock.calls[0][0];
    expect(runInput.ingressNetworkConnectors).toEqual([
      'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS',
    ]);
    expect(runInput.egressNetworkConnectors).toEqual([
      'arn:aws:lambda:us-east-1:1:network-connector:egress-1',
    ]);
  });

  it("CRITICAL: powerless runner set (RUNNER_SET_VM_ROLE_ARN unset, this suite's default) with the default cloudWatch LOGGING_JSON -> RunMicrovm carries NO logging field at all (the platform rejects RunMicrovm with cloudWatch logging + no executionRoleArn)", async () => {
    await handler();

    const runInput = runMicrovmMock.mock.calls[0][0];
    expect(runInput.executionRoleArn).toBeUndefined();
    expect(runInput.logging).toBeUndefined();
  });

  it('with RUNNER_SET_VM_ROLE_ARN set, RunMicrovm includes cloudWatch logging', async () => {
    process.env.RUNNER_SET_VM_ROLE_ARN =
      'arn:aws:iam::1:role/runners-runner-set-x-vm-role';

    await handler();

    const runInput = runMicrovmMock.mock.calls[0][0];
    expect(runInput.executionRoleArn).toBe(
      'arn:aws:iam::1:role/runners-runner-set-x-vm-role',
    );
    expect(runInput.logging).toEqual({ cloudWatch: {} });
  });

  it('retires a pooled VM whose remaining lifetime can no longer cover a full job, and replaces it', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 1 }) });
    // Aged so that 28800 - age < 3600 + 300: it cannot outlive a full job.
    listSuspendedVmsForImageMock.mockResolvedValue([
      { microvmId: 'mvm-stale', startedAtMs: Date.now() - 28_000 * 1000 },
    ]);

    await handler();

    expect(terminateMicrovmMock).toHaveBeenCalledWith('mvm-stale');
    // The crux: an aged-out VM must NOT count toward target. Counting it
    // would leave the pool reporting itself full while every claim skipped
    // past it to a cold boot — the same bug, one level up and quieter.
    expect(runMicrovmMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a pooled VM that has aged but can still outlive a full job', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 1 }) });
    // Two hours old: 28800 - 7200 = 21600 remaining, comfortably over 3900.
    // Under the old job-budget cap this VM would already have been dead.
    listSuspendedVmsForImageMock.mockResolvedValue([
      { microvmId: 'mvm-aged-ok', startedAtMs: Date.now() - 7200 * 1000 },
    ]);

    await handler();

    expect(terminateMicrovmMock).not.toHaveBeenCalled();
    expect(runMicrovmMock).not.toHaveBeenCalled();
  });

  it('a terminate failure while retiring does not abort convergence', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 1 }) });
    listSuspendedVmsForImageMock.mockResolvedValue([
      { microvmId: 'mvm-stale', startedAtMs: Date.now() - 28_000 * 1000 },
    ]);
    terminateMicrovmMock.mockRejectedValueOnce(new Error('boom: terminate'));
    const errSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await handler();

    // Still refills the slot; the undeleted VM is the janitor's problem.
    expect(runMicrovmMock).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('does not launch anything when current already meets target', async () => {
    setEnv({ WARM_POOL_JSON: JSON.stringify({ microvm: 1 }) });

    await handler();

    expect(runMicrovmMock).not.toHaveBeenCalled();
    expect(suspendMicrovmMock).not.toHaveBeenCalled();
  });

  it("one VM's waitForMicrovmRunning failure does not abort the loop: the other VM still launches and suspends, and the failed VM is compensated with a terminate", async () => {
    waitForMicrovmRunningMock
      .mockRejectedValueOnce(new Error('boom: never reached RUNNING'))
      .mockResolvedValue({
        state: 'RUNNING',
        endpoint: 'https://mvm.example.invalid',
      });

    await handler();

    expect(runMicrovmMock).toHaveBeenCalledTimes(2);
    expect(suspendMicrovmMock).toHaveBeenCalledTimes(1);
    expect(terminateMicrovmMock).toHaveBeenCalledTimes(1);
    expect(terminateMicrovmMock).toHaveBeenCalledWith('mvm-new-1');
  });

  it('a RunMicrovm failure for one VM does not abort the loop for the rest', async () => {
    runMicrovmMock
      .mockRejectedValueOnce(new Error('boom: RunMicrovm throttled'))
      .mockImplementation(async () => {
        runMicrovmCounter += 1;
        return `mvm-new-${runMicrovmCounter}`;
      });

    await handler();

    expect(runMicrovmMock).toHaveBeenCalledTimes(2);
    // Only the second (successful) launch reaches wait/suspend.
    expect(waitForMicrovmRunningMock).toHaveBeenCalledTimes(1);
    expect(suspendMicrovmMock).toHaveBeenCalledTimes(1);
  });

  it('a suspendMicrovm failure for one VM does not abort the loop for the rest', async () => {
    suspendMicrovmMock
      .mockRejectedValueOnce(new Error('boom: SuspendMicrovm failed'))
      .mockResolvedValue(undefined);

    await handler();

    expect(runMicrovmMock).toHaveBeenCalledTimes(2);
    expect(suspendMicrovmMock).toHaveBeenCalledTimes(2);
    // Compensating terminate for the VM whose suspend failed.
    expect(terminateMicrovmMock).toHaveBeenCalledTimes(1);
    expect(terminateMicrovmMock).toHaveBeenCalledWith('mvm-new-1');
  });

  it('skips a WARM_POOL_JSON label with no matching SIZE_CLASSES_JSON entry, but still converges the other labels', async () => {
    setEnv({
      WARM_POOL_JSON: JSON.stringify({ 'unknown-label': 2, microvm: 1 }),
    });

    await handler();

    expect(listSuspendedVmsForImageMock).toHaveBeenCalledTimes(1);
    expect(listSuspendedVmsForImageMock).toHaveBeenCalledWith(
      IMAGE_ARN_DEFAULT,
    );
    // current (1 suspended) already meets target (1) for "microvm" -> no launch.
    expect(runMicrovmMock).not.toHaveBeenCalled();
  });

  it('converges multiple labels independently against their own image ARN', async () => {
    setEnv({
      WARM_POOL_JSON: JSON.stringify({ microvm: 1, 'microvm-8gb': 2 }),
    });
    listSuspendedVmsForImageMock.mockImplementation(async (imageArn) =>
      imageArn === IMAGE_ARN_8GB ? [] : [freshWarmVm('mvm-warm-1')],
    );

    await handler();

    expect(runMicrovmMock).toHaveBeenCalledTimes(2);
    expect(runMicrovmMock.mock.calls[0][0]).toMatchObject({
      imageArn: IMAGE_ARN_8GB,
    });
  });

  it('a listSuspendedVmsForImage failure for one label does not abort convergence of the other labels', async () => {
    setEnv({
      WARM_POOL_JSON: JSON.stringify({ microvm: 1, 'microvm-8gb': 1 }),
    });
    listSuspendedVmsForImageMock.mockImplementation(async (imageArn) => {
      if (imageArn === IMAGE_ARN_8GB) {
        throw new Error('boom: ListMicrovms failed');
      }
      return [freshWarmVm('mvm-warm-1')];
    });

    await handler();

    // "microvm" label still converges fine (current 1 == target 1, no launch).
    expect(runMicrovmMock).not.toHaveBeenCalled();
  });
});

describe('handler — per-tick pool fill metrics', () => {
  it('current 1 / target 3, launching 2 with one launch failure -> emits PoolCurrent:1, PoolTarget:3, PoolLaunched:1, PoolLaunchFailed:1 dimensioned by RunnerSetId + SizeClass=label', async () => {
    runMicrovmMock
      .mockRejectedValueOnce(new Error('boom: RunMicrovm throttled'))
      .mockImplementation(async () => {
        runMicrovmCounter += 1;
        return `mvm-new-${runMicrovmCounter}`;
      });
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await handler();

    const envelopes = findEmfEnvelopes(logSpy);
    expect(envelopes).toHaveLength(1);
    const parsed = envelopes[0];
    expect(parsed.RunnerSetId).toBe('x');
    expect(parsed.SizeClass).toBe('microvm');
    expect(parsed.PoolCurrent).toBe(1);
    expect(parsed.PoolTarget).toBe(3);
    expect(parsed.PoolLaunched).toBe(1);
    expect(parsed.PoolLaunchFailed).toBe(1);

    logSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('emits one envelope per label, each dimensioned by its own SizeClass', async () => {
    setEnv({
      WARM_POOL_JSON: JSON.stringify({ microvm: 1, 'microvm-8gb': 2 }),
    });
    listSuspendedVmsForImageMock.mockImplementation(async (imageArn) =>
      imageArn === IMAGE_ARN_8GB ? [] : [freshWarmVm('mvm-warm-1')],
    );
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    await handler();

    const envelopes = findEmfEnvelopes(logSpy);
    expect(envelopes).toHaveLength(2);
    const byLabel = Object.fromEntries(envelopes.map((e) => [e.SizeClass, e]));
    expect(byLabel.microvm).toMatchObject({
      PoolCurrent: 1,
      PoolTarget: 1,
      PoolLaunched: 0,
      PoolLaunchFailed: 0,
    });
    expect(byLabel['microvm-8gb']).toMatchObject({
      PoolCurrent: 0,
      PoolTarget: 2,
      PoolLaunched: 2,
      PoolLaunchFailed: 0,
    });

    logSpy.mockRestore();
  });

  it('metric emit is best-effort: a console.log throw for the metric envelope does not abort convergence', async () => {
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

    await handler();

    // Convergence itself still completed normally.
    expect(runMicrovmMock).toHaveBeenCalledTimes(2);
    expect(suspendMicrovmMock).toHaveBeenCalledTimes(2);

    logSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
