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
import { openSync, mkdirSync, appendFileSync } from 'node:fs';

// Boot timings are written to a FILE, not to stdout. The VM console log group
// does not capture the agent's early output at all — the startup banner appears
// zero times in a day of console logs, while a line logged 854 s after boot
// appeared seven times. A job can read this file; it cannot read what was never
// captured.
const TRACE = '/var/log/microvm-runner-boot.log';
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
  // Single-quoted for the shell, with embedded quotes escaped, so a path
  // containing a space or a metacharacter cannot turn into extra words.
  const quoted = WARM_PATHS.map((p) => `'${p.split("'").join(`'\\''`)}'`).join(
    ' ',
  );
  // `xargs -0 cat` batches many files per process; `cat` per file via -I{}
  // would spend the budget on process startup instead of on reading. `wc -c`
  // costs nothing next to the read and makes the volume observable.
  const script =
    `echo "$(date +%s%3N) warm-start" >> ${TRACE}; ` +
    `B=$(find ${quoted} -xdev -type f 2>/dev/null | head -n ${WARM_MAX_FILES} ` +
    `| tr '\\n' '\\0' | xargs -0 -r cat 2>/dev/null | wc -c); ` +
    // Executing resolves the interpreter and shared libraries as well as the
    // binary. Only the two we ship are executed; configured paths are read.
    `node --version > /dev/null 2>&1; git --version > /dev/null 2>&1; ` +
    `echo "$(date +%s%3N) warm-end bytes=$B" >> ${TRACE}`;
  try {
    // NOT nice'd. An earlier version ran at `nice -n 19` on the theory that
    // warming should yield to runner registration. Decomposing queue latency
    // showed the opposite: 29 of 41 s is `Runner.Listener` starting inside an
    // already-RUNNING VM, paging in the very assemblies this reads. Warming is
    // not competing with that work, it is prefetching for it — sequentially and
    // in bulk, rather than 4 KB at a time on demand — so it has to run at
    // normal priority to get ahead.
    const c = spawn('timeout', [String(WARM_TIMEOUT_S), 'sh', '-c', script], {
      detached: true,
      stdio: 'ignore',
    });
    c.on('error', (e) => note(`warm-spawn-failed ${e}`));
    c.unref();
    note(`warm-spawned paths=${WARM_PATHS.length} budget=${WARM_TIMEOUT_S}s`);
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
