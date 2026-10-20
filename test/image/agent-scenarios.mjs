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
  dockerInfoProbe,
  isMainModule,
} from '../../src/image/assets/agent.mjs';
import { spawnSync } from 'node:child_process';
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

  // No dockerd: start immediately; never start dockerd or probe.
  {
    const started = [];
    let probes = 0;
    let dockerdStarts = 0;
    await decideAndStartRunner('JITCFG', {
      hasDockerd: () => false,
      startDockerd: () => {
        dockerdStarts += 1;
      },
      probe: async () => {
        probes += 1;
        return true;
      },
      start: (cfg) => started.push(cfg),
      sleep: async () => {},
    });
    out.noDockerd = { started, probes, dockerdStarts };
  }

  // dockerd answers after a wait: start.
  {
    const started = [];
    let clock = 0;
    let calls = 0;
    await decideAndStartRunner('JITCFG', {
      hasDockerd: () => true,
      startDockerd: () => {},
      probe: async () => (calls += 1) >= 2,
      start: (cfg) => started.push(cfg),
      log: () => {},
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
      startDockerd: () => {},
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
      startDockerd: () => {},
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

  // dockerd is started when the job arrives, before the first probe, and the
  // runner once it answers.
  {
    const calls = [];
    await decideAndStartRunner('JITCFG', {
      hasDockerd: () => true,
      startDockerd: () => calls.push('startDockerd'),
      probe: async () => {
        calls.push('probe');
        return true;
      },
      start: (cfg) => calls.push(`start(${cfg})`),
      log: () => {},
      sleep: async () => {},
      now: () => 0,
    });
    out.startsDockerdAtJob = { calls };
  }

  // How long dockerd took is logged before the runner starts.
  {
    const events = [];
    let clock = 0;
    await decideAndStartRunner('JITCFG', {
      hasDockerd: () => true,
      startDockerd: () => {},
      probe: async () => {
        clock += 37_000;
        return true;
      },
      start: (cfg) => events.push(`start(${cfg})`),
      log: (m) => events.push(m),
      sleep: async () => {},
      now: () => clock,
    });
    out.logsReadyTime = { events };
  }

  // Each probe gets the probe timeout, or the time left if that is less: the
  // first probe has the whole 120 s budget, the second 4 s.
  {
    let clock = 0;
    const budgets = [];
    await waitForDockerReady({
      probe: async (ms) => {
        budgets.push(ms);
        return false;
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      timeoutMs: 120_000,
      intervalMs: 116_000,
    });
    out.probeBudgets = { budgets };
  }

  // A `docker info` that hangs is cut off at its timeout and its child killed.
  {
    const children = () =>
      spawnSync('pgrep', ['-P', String(process.pid), 'sleep'], {
        encoding: 'utf8',
      }).stdout.trim();
    let during = '';
    const peek = setTimeout(() => {
      during = children();
    }, 100);
    const t0 = Date.now();
    const result = await dockerInfoProbe({
      timeoutMs: 200,
      command: 'sleep',
      args: ['5'],
    });
    const elapsedMs = Date.now() - t0;
    clearTimeout(peek);
    await new Promise((r) => setTimeout(r, 200));
    out.hungProbe = { result, elapsedMs, during, after: children() };
  }

  process.stdout.write(JSON.stringify(out));
}

run().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
