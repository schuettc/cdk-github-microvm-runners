/**
 * Unit tests for the pure pieces of the in-VM agent (`src/image/assets/agent.mjs`):
 * `buildRunnerArgs`, the injected-clock readiness poll `waitForDockerReady`, and
 * the bounded check `commandProbe`, `dockerdArgs`, and the start/wait/timeout
 * decision in `decideAndStartRunner`.
 *
 * The agent is dependency-free ESM shipped verbatim into the image. jest runs as
 * CommonJS and can't `import` the `.mjs` without --experimental-vm-modules, so the
 * scenarios are driven in a real Node ESM process (`agent-scenarios.mjs`) that
 * exercises the exported helpers with injected probes/clocks and prints its
 * results as JSON; these tests assert on that. Running the driver does not start
 * the HTTP server — the module guards `listen` behind a main-module check.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Scenarios {
  args: string[];
  mainViaSymlink: boolean;
  notMainWhenImported: boolean;
  notMainWhenNoArgv: boolean;
  readyOnProbeSuccess: { ready: boolean; calls: number };
  timeout: { ready: boolean; calls: number };
  noDockerd: {
    started: string[];
    probes: number;
    dockerdStarts: number;
    containerdStarts: number;
  };
  waitsThenStarts: { started: string[] };
  timesOut: { started: string[]; logs: string[] };
  timesOutUnreadableLog: { logs: string[] };
  startsTogether: { calls: string[] };
  neverAnswers: { calls: string[]; logs: string[]; endedAt: number };
  logsReadyTime: { events: string[] };
  dockerdArgs: string[];
  probeBudgets: { budgets: number[] };
  hungProbe: {
    result: boolean;
    elapsedMs: number;
    during: string;
    after: string;
  };
}

let s: Scenarios;

beforeAll(() => {
  const driver = join(__dirname, 'agent-scenarios.mjs');
  const stdout = execFileSync(process.execPath, [driver], { encoding: 'utf8' });
  s = JSON.parse(stdout) as Scenarios;
});

describe('entrypoint.sh', () => {
  it('raises the open-files limit to 65536 before starting the agent, and stops if it cannot', () => {
    const commands = readFileSync(
      join(__dirname, '../../src/image/assets/entrypoint.sh'),
      'utf8',
    )
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));

    expect(commands).toEqual([
      'ulimit -n 65536 || exit 1',
      'exec node /opt/microvm-runner/agent.mjs',
    ]);
  });
});

describe('buildRunnerArgs', () => {
  it('runs run.sh as the runner user with only the run options it accepts', () => {
    // run.sh accepts --jitconfig, --once and --startuptype; anything else
    // (such as the configure-only --disableupdate) is logged as unrecognized.
    expect(s.args).toEqual([
      '-u',
      'runner',
      './run.sh',
      '--jitconfig',
      'JITCFG',
    ]);
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

  it('gives each probe at most the probe timeout, and never more than the time left', () => {
    // 120 s left: the probe timeout (10 s). Then 4 s left: 4 s.
    expect(s.probeBudgets.budgets).toEqual([10000, 4000]);
  });
});

describe('commandProbe', () => {
  it('resolves false and kills the child when the check outlives its timeout', () => {
    expect(s.hungProbe.during).not.toBe(''); // the child was running
    expect(s.hungProbe.result).toBe(false);
    expect(s.hungProbe.elapsedMs).toBeLessThan(2000);
    expect(s.hungProbe.after).toBe(''); // and is gone
  });
});

describe('decideAndStartRunner', () => {
  it('starts containerd then dockerd before the first probe, then the runner once docker answers', () => {
    expect(s.startsTogether.calls).toEqual([
      'startContainerd',
      'startDockerd',
      'probe',
      'start(JITCFG)',
    ]);
  });

  it('refuses the job when docker never answers within 120 s', () => {
    expect(s.neverAnswers.calls).toContain('startContainerd');
    expect(s.neverAnswers.calls).toContain('startDockerd');
    expect(s.neverAnswers.calls).not.toContain('start(JITCFG)');
    expect(s.neverAnswers.logs.slice(0, 2)).toEqual([
      'dockerd not ready after 120s; not accepting a job',
      '--- last 1 lines of /var/log/microvm-runner-dockerd.log ---',
    ]);
    expect(s.neverAnswers.endedAt).toBeLessThanOrEqual(121000);
  });

  it('starts nothing and probes nothing on an image without dockerd', () => {
    expect(s.noDockerd.started).toEqual(['JITCFG']);
    expect(s.noDockerd.containerdStarts).toBe(0);
    expect(s.noDockerd.dockerdStarts).toBe(0);
    expect(s.noDockerd.probes).toBe(0);
  });

  it('logs how long dockerd took', () => {
    const events = s.logsReadyTime.events;
    expect(events).toContain('dockerd ready after 11.0s');
    expect(events.indexOf('dockerd ready after 11.0s')).toBeLessThan(
      events.indexOf('start(JITCFG)'),
    );
    expect(events.some((e) => e.startsWith('containerd ready after'))).toBe(
      false,
    );
  });

  it('waits then starts once dockerd answers', () => {
    expect(s.waitsThenStarts.started).toEqual(['JITCFG']);
  });

  it('when dockerd times out, does not start the runner and logs the refusal then the tail of the dockerd log', () => {
    expect(s.timesOut.started).toEqual([]); // no runner started
    // The refusal line, which operators grep for, unchanged.
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

describe('dockerdArgs', () => {
  it("points dockerd at the agent's containerd", () => {
    expect(s.dockerdArgs).toEqual([
      '--containerd=/run/containerd/containerd.sock',
      '--storage-driver=vfs',
      '--iptables=false',
    ]);
  });
});
