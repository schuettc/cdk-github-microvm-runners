// In-VM agent for microvm-runner runner images. NOT TypeScript — copied verbatim into
// the Dockerfile build context at `microvm-runner/agent.mjs` by the image
// pipeline (Task 6) and COPYed to /opt/microvm-runner/agent.mjs, then
// exec'd by entrypoint.sh.
// Runs entirely inside the MicroVM; no AWS credentials, no Docker Hub.
//
// Lifecycle hook contract (spike-verified, corrects the original task
// brief): hook paths are a FIXED service convention, not configurable —
// AWS Lambda MicroVMs always calls the full fixed paths below on port 8080
// (the `hooks: { port: 8080, ... }` value the image pipeline sets). We
// match the full path with `===` rather than `req.url?.endsWith(...)`:
// exact match is strictly more precise (an endsWith check would also match
// an unintended longer path that happens to end in "/ready"/"/run") and it
// mirrors the fixed-path convention exactly, so there's no reason to prefer
// the looser suffix match here.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  openSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  statSync,
  readdirSync,
} from 'node:fs';

// Boot timings are written to a FILE, not to stdout. The VM console log group
// does not capture the agent's early output at all — the startup banner appears
// zero times in a day of console logs, while a line logged 854 s after boot
// appeared seven times. A job can read this file; it cannot read what was never
// captured.
const TRACE = '/var/log/microvm-runner-boot.log';
// TRUNCATED at agent start. The image build boots a VM and runs the ready
// probe, and the snapshot captures the filesystem afterwards -- so without this
// every VM launches carrying the BUILD's entries, and runtime events read as
// ~535 s offsets from a boot that happened during the build.
try {
  mkdirSync('/var/log', { recursive: true });
  writeFileSync(TRACE, '');
} catch {
  // Tracing must never be able to fail a boot.
}
function note(msg) {
  try {
    appendFileSync(TRACE, `${Date.now()} ${msg}\n`);
  } catch {
    // Tracing must never be able to fail a boot.
  }
}

const PORT = 8080;
const READY_PATH = '/aws/lambda-microvms/runtime/v1/ready';
const RUN_PATH = '/aws/lambda-microvms/runtime/v1/run';

let runnerStarted = false;
let dockerStarted = false;

// Start the Docker daemon with MicroVM-safe settings. MicroVMs
// (no nested KVM, snapshot rootfs, limited netfilter) break dockerd's
// defaults two ways found live 2026-07-19 (dockerd never became ready):
//   --storage-driver=vfs   overlay2 needs a backing fs the snapshot rootfs
//                          may not provide; vfs works everywhere (slower, but
//                          correct — fine for CI build/run).
//   --iptables=false       dockerd's iptables NAT setup fails without the
//                          host netfilter modules; disabling it lets builds
//                          and host-network runs work.
// Output is logged to /var/log/microvm-runner-dockerd.log (NOT swallowed) so a failure
// is diagnosable from inside the job. Idempotent: only the first /run starts it.
function startDockerd() {
  if (dockerStarted) return;
  dockerStarted = true;
  try {
    mkdirSync('/var/log', { recursive: true });
    const log = openSync('/var/log/microvm-runner-dockerd.log', 'a');
    const d = spawn('dockerd', ['--storage-driver=vfs', '--iptables=false'], {
      stdio: ['ignore', log, log],
      detached: true,
    });
    d.on('error', (e) => console.log(`dockerd failed to spawn: ${e}`));
    d.unref();
  } catch (e) {
    console.log(`dockerd start error: ${e}`);
  }
}

// Page the binaries a job reaches for first into memory, during the boot
// handshake rather than during the job.
//
// A MicroVM is snapshot-restored, so its pages fault in on FIRST access. That
// makes the first execution of a binary cost 100-1000x the second: measured on
// a bench runner, `python3 --version` took 2,006 ms cold and 2 ms warm, while
// the same pair on a GitHub-hosted runner was 2 ms and 2 ms. It is why
// `actions/checkout` spends 8.5-17.6 s between the step starting and the action
// running (0.10-0.17 s hosted) — that gap is node being paged in.
//
// Warming works: checkout dropped from 12-17 s to 2-3 s on every job. But HOW
// it is done matters more than that number.
//
// IT RUNS IN A DETACHED CHILD, NEVER IN THIS PROCESS. The first version read
// files with readSync on the event loop. Node is single-threaded, so the agent's
// HTTP server could not answer anything for the 854 s that took — including the
// platform's /run call carrying the JIT config, without which the runner cannot
// register. checkout got faster and queue latency went from 19-45 s to 29-217 s,
// with one job still unassigned after 20 minutes. Deferring the start with
// setImmediate does not help: it delays the block, it does not prevent it.
//
// It is also BUDGETED IN TIME, not only in file count. That run read 305 MiB
// across 400 files because `/opt/runner` is hundreds of megabytes of .NET
// assemblies a job never touches. A file cap cannot bound wall time when
// per-file cost is unknown; a timeout can, whatever the disk does.
//
// And it runs at `nice -n 19`, so it yields to the registration it must not
// delay.
const WARM_PATHS = (process.env.MICROVM_RUNNER_WARM_PATHS ?? '')
  .split(':')
  .filter(Boolean);
const WARM_MAX_FILES = Number(
  process.env.MICROVM_RUNNER_WARM_MAX_FILES || 4000,
);
/** Hard wall-clock ceiling. The one bound that holds regardless of disk speed. */
const WARM_TIMEOUT_S = Number(process.env.MICROVM_RUNNER_WARM_TIMEOUT_S || 60);

let warmed = false;
function warmUp() {
  if (warmed || WARM_PATHS.length === 0) return;
  warmed = true;

  // The WALK happens here; the READ happens in a detached child.
  //
  // Walking is directory metadata and costs milliseconds. Reading is hundreds
  // of megabytes and must never touch this event loop — an earlier version read
  // with readSync inline and stalled the agent for 854 s, so it could not answer
  // the /run call carrying the JIT config.
  //
  // NEITHER STEP MAY USE `find` OR `xargs`. The al2023-minimal base does not
  // ship findutils, and nothing in the package set adds it. The shell version of
  // this reported `bytes=0` while claiming success, because `find` was not found,
  // stderr went to /dev/null, and `wc -c` of nothing is zero. Node is the one
  // interpreter the image contract guarantees, so both halves use it.
  const files = [];
  const walk = (p, depth) => {
    if (files.length >= WARM_MAX_FILES) return;
    let st;
    try {
      st = statSync(p);
    } catch {
      return; // A configured path that is absent must not fail boot.
    }
    if (st.isDirectory()) {
      if (depth > 8) return;
      let entries = [];
      try {
        entries = readdirSync(p);
      } catch {
        return;
      }
      for (const e of entries) walk(`${p}/${e}`, depth + 1);
    } else if (st.isFile() && st.size > 0) {
      files.push(p);
    }
  };
  for (const p of WARM_PATHS) walk(p, 0);
  if (files.length === 0) {
    note('warm-skipped no-files');
    return;
  }

  // The list goes via a file rather than argv, which has a length limit that a
  // few thousand paths would exceed.
  const listPath = '/tmp/microvm-runner-warm.list';
  try {
    writeFileSync(listPath, files.join('\n'));
  } catch (e) {
    note(`warm-list-failed ${e}`);
    return;
  }

  // The child enforces its own deadline, so the budget holds without depending
  // on `timeout` being present either.
  const child = `
    const fs = require('fs');
    const files = fs.readFileSync(process.argv[1], 'utf8').split('\n').filter(Boolean);
    const deadline = Date.now() + ${WARM_TIMEOUT_S} * 1000;
    const buf = Buffer.allocUnsafe(1 << 20);
    let bytes = 0, read = 0;
    for (const f of files) {
      if (Date.now() > deadline) break;
      let fd;
      try {
        fd = fs.openSync(f, 'r');
        let n;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) bytes += n;
        read++;
      } catch {} finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
    }
    try { fs.appendFileSync(${JSON.stringify(TRACE)},
      Date.now() + ' warm-end bytes=' + bytes + ' files=' + read + ' of=' + files.length + '\n'); } catch {}
  `;
  try {
    const c = spawn(process.execPath, ['-e', child, listPath], {
      detached: true,
      stdio: 'ignore',
    });
    c.on('error', (e) => note(`warm-spawn-failed ${e}`));
    c.unref();
    note(`warm-start files=${files.length} budget=${WARM_TIMEOUT_S}s`);
  } catch (e) {
    note(`warm-start-error ${e}`);
  }
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === READY_PATH) {
      // Start dockerd at BOOT, not at /run. dockerd + the vfs storage driver
      // are slow and variable to initialize in a MicroVM (canary caught
      // "dockerd never became ready" races 2026-07-19). Starting it here, at
      // the ready handshake, gives it the whole boot→job-assignment window to
      // warm up, so it's reliably ready by the time a job's first docker
      // command runs. Idempotent — safe if /ready is called more than once.
      note('ready-hook');
      startDockerd();
      // Both of these only spawn a detached child and return, so the ready
      // hook's timeout (readyTimeoutSeconds, 300 by default) is never at risk
      // and neither is the /run call that follows.
      warmUp();
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.url === RUN_PATH) {
      note('run-hook');
      if (!runnerStarted) {
        try {
          const { jitConfig } = JSON.parse(body || '{}');
          if (!jitConfig) {
            // The platform invokes /run at EVERY VM start (with an empty
            // payload when RunMicrovm carried none) and terminates the VM
            // on any non-200 (stateReason: "Run lifecycle hook returned
            // HTTP status 400" — found live 2026-07-19). Acknowledge the
            // boot handshake; the JIT config arrives via the authenticated
            // ingress push moments later.
            res.writeHead(200);
            res.end('awaiting jitConfig');
            return;
          }
          runnerStarted = true;
          note('runner-spawn');
          startDockerd(); // MicroVM-safe dockerd for job containers
          const p = spawn(
            'sudo',
            ['-u', 'runner', './run.sh', '--jitconfig', jitConfig],
            { cwd: '/opt/runner', stdio: 'inherit' },
          );
          // Termination is external (the launcher/lifecycle manager decides
          // when the MicroVM itself goes away) — the agent just idles once
          // the runner process exits.
          p.on('exit', (code) => console.log(`runner exited ${code}`));
        } catch (e) {
          res.writeHead(500);
          res.end(String(e));
          return;
        }
      }
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

server.listen(PORT, () => {
  note('agent-listening');
  console.log(`microvm-runner agent on ${PORT}`);
});
