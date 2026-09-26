// Driver for the agent unit tests. `agent.mjs` is dependency-free ESM shipped
// verbatim into the image; jest runs its tests as CommonJS and cannot `import`
// the `.mjs` without --experimental-vm-modules, so the exported pure helpers are
// exercised here in a plain Node ESM process (the real runtime) and the results
// are printed as JSON for the jest test to assert on. Importing the module does
// NOT start the HTTP server — the listen is guarded behind a main-module check —
// which is what lets this run without a VM or an open port.
import {
  buildRunnerArgs,
  waitForDockerReady,
  decideAndStartRunner,
} from '../../src/image/assets/agent.mjs';

async function run() {
  const out = {};

  out.args = buildRunnerArgs('JITCFG');

  // Ready as soon as the probe succeeds; stops probing (clock never advances).
  {
    let calls = 0;
    const ready = await waitForDockerReady({
      probe: async () => (calls += 1) === 3,
      sleep: async () => {},
      now: () => 0,
      timeoutMs: 120_000,
      intervalMs: 1_000,
    });
    out.readyOnProbeSuccess = { ready, calls };
  }

  // Times out at the bound; no probe once the clock reaches the deadline.
  {
    let clock = 0;
    let calls = 0;
    const ready = await waitForDockerReady({
      probe: async () => {
        calls += 1;
        return false;
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      timeoutMs: 120_000,
      intervalMs: 1_000,
    });
    out.timeout = { ready, calls };
  }

  // No dockerd: start immediately, never probe.
  {
    const started = [];
    let probes = 0;
    await decideAndStartRunner('JITCFG', {
      hasDockerd: () => false,
      probe: async () => {
        probes += 1;
        return true;
      },
      start: (cfg) => started.push(cfg),
      sleep: async () => {},
    });
    out.noDockerd = { started, probes };
  }

  // dockerd answers after a wait: start.
  {
    const started = [];
    let clock = 0;
    let calls = 0;
    await decideAndStartRunner('JITCFG', {
      hasDockerd: () => true,
      probe: async () => (calls += 1) >= 2,
      start: (cfg) => started.push(cfg),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      timeoutMs: 120_000,
      intervalMs: 1_000,
    });
    out.waitsThenStarts = { started };
  }

  // dockerd times out: do not start, log exactly one line.
  {
    const started = [];
    const logs = [];
    let clock = 0;
    await decideAndStartRunner('JITCFG', {
      hasDockerd: () => true,
      probe: async () => false,
      start: (cfg) => started.push(cfg),
      log: (m) => logs.push(m),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      timeoutMs: 120_000,
      intervalMs: 1_000,
    });
    out.timesOut = { started, logs };
  }

  process.stdout.write(JSON.stringify(out));
}

run().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
