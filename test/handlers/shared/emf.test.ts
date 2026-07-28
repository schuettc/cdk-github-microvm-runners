import { emitEmf, metricsEnabled } from '../../../src/handlers/shared/emf.js';

const ORIGINAL_EMIT_METRICS = process.env.EMIT_METRICS;

// `emitEmf` reads `EMIT_METRICS` directly (the opt-in gate). Save/restore it
// around every test in this file so neither the enabled nor the disabled
// setting leaks into other suites in the same worker.
afterEach(() => {
  if (ORIGINAL_EMIT_METRICS === undefined) {
    delete process.env.EMIT_METRICS;
  } else {
    process.env.EMIT_METRICS = ORIGINAL_EMIT_METRICS;
  }
});

describe('emitEmf: the EMIT_METRICS opt-in gate', () => {
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function emitOne(): void {
    emitEmf({
      namespace: 'MicrovmRunners',
      dimensions: ['RunnerSetId'],
      dimensionValues: { RunnerSetId: 'runner-set-gate' },
      metrics: { errors: 1 },
      timestamp: 1_700_000_000_004,
    });
  }

  it('writes nothing when EMIT_METRICS is unset (the default runner set)', () => {
    delete process.env.EMIT_METRICS;
    expect(metricsEnabled()).toBe(false);
    emitOne();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("writes nothing when EMIT_METRICS is 'false'", () => {
    process.env.EMIT_METRICS = 'false';
    expect(metricsEnabled()).toBe(false);
    emitOne();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('writes nothing for any value other than the exact string "true"', () => {
    for (const value of ['True', 'TRUE', '1', 'yes', '']) {
      process.env.EMIT_METRICS = value;
      emitOne();
    }
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("writes the envelope when EMIT_METRICS is 'true'", () => {
    process.env.EMIT_METRICS = 'true';
    expect(metricsEnabled()).toBe(true);
    emitOne();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      _aws: { CloudWatchMetrics: { Namespace: string }[] };
      errors: number;
    };
    expect(parsed._aws.CloudWatchMetrics[0]?.Namespace).toBe('MicrovmRunners');
    expect(parsed.errors).toBe(1);
  });
});

describe('emitEmf', () => {
  // Every assertion below is about envelope SHAPE, which only exists on the
  // enabled path — the gate itself is covered by the suite above.
  beforeEach(() => {
    process.env.EMIT_METRICS = 'true';
  });

  it('writes one console.log EMF envelope with the given namespace, dimensions, and metrics', () => {
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    emitEmf({
      namespace: 'MicrovmRunners',
      dimensions: ['RunnerSetId', 'SizeClass'],
      dimensionValues: { RunnerSetId: 'runner-set-x', SizeClass: 'large' },
      metrics: { launches: 3, failures: 1 },
      timestamp: 1_700_000_000_000,
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      _aws: {
        Timestamp: number;
        CloudWatchMetrics: {
          Namespace: string;
          Dimensions: string[][];
          Metrics: { Name: string; Unit: string }[];
        }[];
      };
      RunnerSetId: string;
      SizeClass: string;
      launches: number;
      failures: number;
    };

    expect(parsed._aws.Timestamp).toBe(1_700_000_000_000);
    expect(parsed._aws.CloudWatchMetrics[0]?.Namespace).toBe('MicrovmRunners');
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([
      ['RunnerSetId', 'SizeClass'],
    ]);
    expect(parsed._aws.CloudWatchMetrics[0]?.Metrics).toEqual([
      { Name: 'launches', Unit: 'Count' },
      { Name: 'failures', Unit: 'Count' },
    ]);
    expect(parsed.RunnerSetId).toBe('runner-set-x');
    expect(parsed.SizeClass).toBe('large');
    expect(parsed.launches).toBe(3);
    expect(parsed.failures).toBe(1);

    logSpy.mockRestore();
  });

  it('defaults to Count unit and supports a custom unit', () => {
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    emitEmf({
      namespace: 'MicrovmRunners',
      dimensions: ['RunnerSetId'],
      dimensionValues: { RunnerSetId: 'runner-set-y' },
      metrics: { launchLatencyMs: 42 },
      timestamp: 1_700_000_000_001,
      unit: 'Milliseconds',
    });

    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      _aws: {
        CloudWatchMetrics: { Metrics: { Name: string; Unit: string }[] }[];
      };
    };
    expect(parsed._aws.CloudWatchMetrics[0]?.Metrics).toEqual([
      { Name: 'launchLatencyMs', Unit: 'Milliseconds' },
    ]);

    logSpy.mockRestore();
  });

  it('applies a per-metric unit override from `units` while other metrics keep the default', () => {
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    emitEmf({
      namespace: 'MicrovmRunners',
      dimensions: ['RunnerSetId', 'SizeClass'],
      dimensionValues: { RunnerSetId: 'runner-set-z', SizeClass: 'large' },
      metrics: { SpinUpMs: 1234, ColdBoot: 1 },
      timestamp: 1_700_000_000_002,
      units: { SpinUpMs: 'Milliseconds' },
    });

    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      _aws: {
        CloudWatchMetrics: { Metrics: { Name: string; Unit: string }[] }[];
      };
    };
    expect(parsed._aws.CloudWatchMetrics[0]?.Metrics).toEqual([
      { Name: 'SpinUpMs', Unit: 'Milliseconds' },
      { Name: 'ColdBoot', Unit: 'Count' },
    ]);

    logSpy.mockRestore();
  });

  it('omitting `units` keeps the old single-unit behavior (janitor path unchanged)', () => {
    const logSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    emitEmf({
      namespace: 'MicrovmRunners',
      dimensions: ['RunnerSetId'],
      dimensionValues: { RunnerSetId: 'runner-set-w' },
      metrics: { launches: 3, failures: 1 },
      timestamp: 1_700_000_000_003,
    });

    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      _aws: {
        CloudWatchMetrics: { Metrics: { Name: string; Unit: string }[] }[];
      };
    };
    expect(parsed._aws.CloudWatchMetrics[0]?.Metrics).toEqual([
      { Name: 'launches', Unit: 'Count' },
      { Name: 'failures', Unit: 'Count' },
    ]);

    logSpy.mockRestore();
  });
});
