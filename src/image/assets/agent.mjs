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
import { spawn, spawnSync } from 'node:child_process';
import {
  openSync,
  mkdirSync,
  statSync,
  readdirSync,
  readSync,
  closeSync,
} from 'node:fs';

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
// running (0.10-0.17 s hosted) — that gap is node being paged in — and why
// forking `git --version` costs ~1.2 s on a VM that has not run git yet.
//
// The cost is paid once per VM either way. Paying it HERE puts it in the
// boot→job-assignment window, otherwise spent waiting for the JIT config push,
// instead of inside the job where it is billed and observed. Same reasoning as
// starting dockerd from this hook rather than from /run.
//
// Warmth was measured to persist: a binary warmed 300 s earlier still started
// in 3-12 ms rather than 299-421 ms, so it comfortably outlives this window.
//
// Reading a file pages in the file. EXECUTING it also resolves its interpreter
// and shared libraries, which is most of what a cold `node` actually pays for,
// so the two fixed binaries we own are exercised rather than merely read.
// Everything else is read, because executing an arbitrary configured path
// would be a side effect nobody asked for.
const WARM_PATHS = (process.env.MICROVM_RUNNER_WARM_PATHS ?? '')
  .split(':')
  .filter(Boolean);
// Bounded so a large or deep directory cannot turn the boot window into a
// full-disk read. Files are taken largest-first, since page-in cost tracks
// size and the big ones are what hurt.
const WARM_MAX_FILES = Number(process.env.MICROVM_RUNNER_WARM_MAX_FILES || 400);
const WARM_MAX_BYTES = Number(
  process.env.MICROVM_RUNNER_WARM_MAX_BYTES || 768 * 1024 * 1024,
);

let warmed = false;
function warmUp() {
  if (warmed || WARM_PATHS.length === 0) return;
  warmed = true;
  const t0 = Date.now();
  let files = 0;
  let bytes = 0;
  try {
    const candidates = [];
    const walk = (p, depth) => {
      let st;
      try {
        st = statSync(p);
      } catch {
        return; // A configured path that is absent is not worth failing boot over.
      }
      if (st.isDirectory()) {
        if (depth > 6) return;
        let entries = [];
        try {
          entries = readdirSync(p);
        } catch {
          return;
        }
        for (const e of entries) walk(`${p}/${e}`, depth + 1);
      } else if (st.isFile() && st.size > 0) {
        candidates.push({ p, size: st.size });
      }
    };
    for (const p of WARM_PATHS) walk(p, 0);
    candidates.sort((a, b) => b.size - a.size);
    const buf = Buffer.allocUnsafe(1 << 20);
    for (const c of candidates) {
      if (files >= WARM_MAX_FILES || bytes >= WARM_MAX_BYTES) break;
      let fd;
      try {
        // Streamed rather than readFileSync: this pages the file in without
        // holding a copy of it in the agent's own heap.
        fd = openSync(c.p, 'r');
        let n;
        while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) bytes += n;
        files++;
      } catch {
        // Unreadable file (permissions, races). Warming is advisory; skip it.
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {}
        }
      }
    }
  } catch (e) {
    console.log(`warm-up walk error: ${e}`);
  }
  // Exercise the two binaries we ship and know a job reaches for. This resolves
  // the dynamic linker and shared libraries as well as the binary itself.
  for (const bin of ['node', 'git']) {
    try {
      spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 30_000 });
    } catch {
      // Absent on a custom image. The contract requires node; git is a
      // convenience. Neither is worth failing the ready handshake for.
    }
  }
  console.log(
    `microvm-runner warm-up: ${files} files, ${Math.round(bytes / 1048576)} MiB, ${Date.now() - t0} ms`,
  );
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
      startDockerd();
      // Answer the handshake BEFORE warming. The service times the ready hook
      // out (readyTimeoutSeconds, 300 by default) and warming reads hundreds of
      // megabytes, so doing it inline would spend that budget and could fail the
      // image build outright. Deferring by a tick lets the 200 go out first and
      // the warm-up run against the idle window that follows.
      res.writeHead(200);
      res.end();
      setImmediate(warmUp);
      return;
    }
    if (req.url === RUN_PATH) {
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

server.listen(PORT, () => console.log(`microvm-runner agent on ${PORT}`));
