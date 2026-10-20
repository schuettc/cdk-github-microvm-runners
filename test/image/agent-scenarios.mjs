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
  isMainModule,
} from '../../src/image/assets/agent.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync, symlinkSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function run() {
  const out = {};

  out.args = buildRunnerArgs('JITCFG');

  // Entrypoint guard is realpath-safe. Node realpaths import.meta.url but not
  // argv[1], so running the agent through a symlink (argv[1] = the link, the
  // meta URL = the real file) must still be recognised as the main module.
  {
    const agentPath = fileURLToPath(
      new URL('../../src/image/assets/agent.mjs', import.meta.url),
    );
    // What Node actually presents as import.meta.url: the realpath'd file.
    const metaUrl = pathToFileURL(realpathSync(agentPath)).href;
    const dir = mkdtempSync(join(tmpdir(), 'agent-guard-'));
    const link = join(dir, 'agent-link.mjs');
    symlinkSync(agentPath, link);
    const other = join(dir, 'other-script.mjs');
    writeFileSync(other, '');
    // argv[1] is a symlink to the agent -> main module (server should start).
    out.mainViaSymlink = isMainModule(metaUrl, link);
    // Imported from another script -> not the main module.
    out.notMainWhenImported = isMainModule(metaUrl, other);
    // Missing argv[1] -> not the main module.
    out.notMainWhenNoArgv = isMainModule(metaUrl, undefined);
  }

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
      dockerdStopped: () => null,
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

  // dockerd times out: do not start; log the refusal, then the log's last 50
  // of its 60 lines under a header.
  {
    const started = [];
    const logs = [];
    let clock = 0;
    const dockerdLog = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    await decideAndStartRunner('JITCFG', {
      hasDockerd: () => true,
      dockerdStopped: () => null,
      probe: async () => false,
      start: (cfg) => started.push(cfg),
      log: (m) => logs.push(m),
      readDockerdLog: () => dockerdLog.join('\n') + '\n',
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      timeoutMs: 120_000,
      intervalMs: 1_000,
    });
    out.timesOut = { started, logs };
  }

  // dockerd times out and its log can't be read: one fallback line.
  {
    const logs = [];
    let clock = 0;
    await decideAndStartRunner('JITCFG', {
      hasDockerd: () => true,
      dockerdStopped: () => null,
      probe: async () => false,
      start: () => {},
      log: (m) => logs.push(m),
      readDockerdLog: () => {
        throw new Error('ENOENT: no such file or directory');
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      timeoutMs: 120_000,
      intervalMs: 1_000,
    });
    out.timesOutUnreadableLog = { logs };
  }

  // A fake dockerd for the restart scenarios. Each entry of `lives` is one run
  // of the daemon (the first is the one started at /ready, each later one a
  // restart): `docker info` answers from its `upAt`-th probe, and on its
  // `diesAt`-th probe it has exited (code 1) instead, as a warm VM's dockerd
  // does a moment after resume.
  async function withFakeDockerd(lives) {
    const logs = [];
    const started = [];
    let life = 0;
    let alive = true;
    let age = 0;
    let checks = 0;
    let restarts = 0;
    let clock = 0;
    await decideAndStartRunner('JITCFG', {
      hasDockerd: () => true,
      dockerdStopped: () => {
        checks += 1;
        return alive ? null : 'code 1';
      },
      restartDockerd: () => {
        restarts += 1;
        life += 1;
        alive = true;
        age = 0;
      },
      probe: async () => {
        if (!alive) return false;
        age += 1;
        const { diesAt = Infinity, upAt = Infinity } = lives[life] ?? {};
        if (age >= diesAt) {
          alive = false;
          return false;
        }
        return age >= upAt;
      },
      start: (cfg) => started.push(cfg),
      log: (m) => logs.push(m),
      readDockerdLog: () => 'failed to start containerd\n',
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      timeoutMs: 120_000,
      intervalMs: 1_000,
    });
    return { started, logs, checks, restarts };
  }

  // Running at /run, exits during the wait; the restart answers.
  out.diesDuringWait = await withFakeDockerd([{ diesAt: 2 }, { upAt: 3 }]);
  // Running throughout, answers on its 3rd probe.
  out.staysRunning = await withFakeDockerd([{ upAt: 3 }]);
  // Exits during the wait, and the restarted one exits too.
  out.diesAgain = await withFakeDockerd([{ diesAt: 2 }, { diesAt: 2 }]);

  process.stdout.write(JSON.stringify(out));
}

run().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
