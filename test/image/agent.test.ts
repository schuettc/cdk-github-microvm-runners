/**
 * Unit tests for the pure pieces of the in-VM agent (`src/image/assets/agent.mjs`):
 * `buildRunnerArgs`, the injected-clock readiness poll `waitForDockerReady`, and
 * the start/wait/timeout decision in `decideAndStartRunner`.
 *
 * The agent is dependency-free ESM shipped verbatim into the image. jest runs as
 * CommonJS and can't `import` the `.mjs` without --experimental-vm-modules, so the
 * scenarios are driven in a real Node ESM process (`agent-scenarios.mjs`) that
 * exercises the exported helpers with injected probes/clocks and prints its
 * results as JSON; these tests assert on that. Running the driver does not start
 * the HTTP server — the module guards `listen` behind a main-module check.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

interface Scenarios {
  args: string[];
  mainViaSymlink: boolean;
  notMainWhenImported: boolean;
  notMainWhenNoArgv: boolean;
  readyOnProbeSuccess: { ready: boolean; calls: number };
  timeout: { ready: boolean; calls: number };
  noDockerd: { started: string[]; probes: number };
  waitsThenStarts: { started: string[] };
  timesOut: { started: string[]; logs: string[] };
  timesOutUnreadableLog: { logs: string[] };
}

let s: Scenarios;

beforeAll(() => {
  const driver = join(__dirname, 'agent-scenarios.mjs');
  const stdout = execFileSync(process.execPath, [driver], { encoding: 'utf8' });
  s = JSON.parse(stdout) as Scenarios;
});

describe('buildRunnerArgs', () => {
  it('passes --disableupdate and --jitconfig <cfg> to run.sh as the runner user', () => {
    // Started as the non-root runner user, from run.sh.
    expect(s.args.slice(0, 3)).toEqual(['-u', 'runner', './run.sh']);
    // The runner must not self-update.
    expect(s.args).toContain('--disableupdate');
    // The just-in-time config the platform pushed, as a flag+value pair.
    const i = s.args.indexOf('--jitconfig');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(s.args[i + 1]).toBe('JITCFG');
  });
});

describe('isMainModule (entrypoint guard)', () => {
  it('is true when argv[1] is a symlink to the agent (realpath-safe)', () => {
    // Node realpaths import.meta.url but not argv[1]; comparing realpaths
    // keeps the guard true through the symlink, so the server still starts.
    expect(s.mainViaSymlink).toBe(true);
  });

  it('is false when the agent is imported from another script', () => {
    expect(s.notMainWhenImported).toBe(false);
  });

  it('is false when argv[1] is missing', () => {
    expect(s.notMainWhenNoArgv).toBe(false);
  });
});

describe('waitForDockerReady', () => {
  it('returns ready as soon as the probe succeeds, and stops probing', () => {
    expect(s.readyOnProbeSuccess.ready).toBe(true);
    expect(s.readyOnProbeSuccess.calls).toBe(3); // failed twice, then succeeded
  });

  it('times out at the bound and makes no further probe call after the deadline', () => {
    expect(s.timeout.ready).toBe(false);
    // The loop probes only while now() < deadline; with the clock advanced one
    // interval per sleep, 120_000 / 1_000 = 120 probes, and not one more.
    expect(s.timeout.calls).toBe(120);
  });
});

describe('decideAndStartRunner', () => {
  it('starts the runner immediately, without probing, when the image has no dockerd', () => {
    expect(s.noDockerd.started).toEqual(['JITCFG']);
    expect(s.noDockerd.probes).toBe(0);
  });

  it('waits then starts once dockerd answers', () => {
    expect(s.waitsThenStarts.started).toEqual(['JITCFG']);
  });

  it('when dockerd times out, does not start the runner and logs the refusal then the tail of the dockerd log', () => {
    expect(s.timesOut.started).toEqual([]); // no runner started
    // The refusal line is grepped for by operators: it stays first and unchanged.
    expect(s.timesOut.logs[0]).toBe(
      'dockerd not ready after 120s; not accepting a job',
    );
    // Then the last 50 of the log's 60 lines, under a header naming the file.
    const tail = Array.from({ length: 50 }, (_, i) => `line ${i + 11}`);
    expect(s.timesOut.logs.slice(1)).toEqual([
      '--- last 50 lines of /var/log/microvm-runner-dockerd.log ---',
      ...tail,
    ]);
  });

  it('when dockerd times out and its log cannot be read, logs one line saying so with the error', () => {
    expect(s.timesOutUnreadableLog.logs).toEqual([
      'dockerd not ready after 120s; not accepting a job',
      '/var/log/microvm-runner-dockerd.log could not be read: Error: ENOENT: no such file or directory',
    ]);
  });
});
