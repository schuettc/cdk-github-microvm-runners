// In-VM agent for microvm-runner runner images. NOT TypeScript — copied verbatim into
// the Dockerfile build context at `microvm-runner/agent.mjs` by the image
// pipeline (Task 6) and COPYed to /opt/microvm-runner/agent.mjs, then
// exec'd by entrypoint.sh.
// Runs entirely inside the MicroVM; no AWS credentials, no Docker Hub.
//
// Dependency-free: node builtins only, so it ships as this one file with
// nothing to install. The pure pieces (argv construction, the readiness
// poll with an injected probe/clock) are exported so they can be unit-tested
// without a VM; importing this module does NOT start the HTTP server — the
// listen is guarded behind a main-module check at the very bottom.
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
import { openSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PORT = 8080;
const READY_PATH = '/aws/lambda-microvms/runtime/v1/ready';
const RUN_PATH = '/aws/lambda-microvms/runtime/v1/run';

// How long the agent waits for dockerd to actually answer before it gives up
// on a job. A constant, not a knob: a consumer can't tune it in this change
// (YAGNI). 120 s comfortably covers vfs dockerd cold-start in a MicroVM while
// staying well inside the janitor's stuck-job recovery window, so a VM that
// never gets a working daemon is reaped rather than sitting forever.
export const DOCKER_READY_TIMEOUT_MS = 120_000;
// Poll interval for the readiness probe — short so the runner starts promptly
// once the daemon is up, without busy-spinning `docker info`.
export const DOCKER_POLL_INTERVAL_MS = 1_000;

let runnerStarted = false;
let dockerStarted = false;

/**
 * The `run.sh` argv the runner is started with (as arguments to `sudo -u
 * runner`). Two flags matter here:
 *   --disableupdate  the runner must NOT self-update. GitHub advises disabling
 *                    automatic updates for ephemeral runners, and GitHub's own
 *                    actions-runner-controller runs with DisableUpdate by
 *                    default; a stale runner that starts an update then stops
 *                    without taking a job was seen live (a consumer's 2.335.1
 *                    runners registered, went offline, and were reaped
 *                    2026-09-24). Currency comes from the pinned runner version
 *                    instead (see docs/images.md, "Keeping the runner current").
 *   --jitconfig      the just-in-time config the platform pushed to the VM.
 * Exported pure so a test can assert the flags are present without a VM.
 */
export function buildRunnerArgs(jitConfig) {
  return [
    '-u',
    'runner',
    './run.sh',
    '--disableupdate',
    '--jitconfig',
    jitConfig,
  ];
}

/**
 * Poll `probe` until it resolves truthy (ready), or the `timeoutMs` bound
 * elapses on the injected `now` clock (timed out). Returns `true` as soon as a
 * probe succeeds, `false` on timeout — and makes NO further probe call once the
 * clock has reached the deadline, so the bound is a hard ceiling on the number
 * of probes as well as on wall-clock time.
 *
 * `probe`, `now`, and `sleep` are injected so this is a pure control-flow
 * function testable with a fake clock — the real caller passes a `docker info`
 * probe, `Date.now`, and a `setTimeout`-based sleep.
 */
export async function waitForDockerReady({
  probe,
  sleep,
  now = () => Date.now(),
  timeoutMs = DOCKER_READY_TIMEOUT_MS,
  intervalMs = DOCKER_POLL_INTERVAL_MS,
}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await probe()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/**
 * True when the image ships a Docker daemon, decided once by resolving
 * `dockerd` on PATH. `command -v` exits 0 when found, non-0 when not — and we
 * key off that status, NOT off a spawn error, so a transient failure to run
 * the check is never mistaken for "no dockerd" (which would silently skip the
 * wait an image with dockerd needs). A consumer's own Dockerfile without
 * docker resolves to false and keeps today's no-wait behaviour.
 */
function imageHasDockerd() {
  const r = spawnSync('sh', ['-c', 'command -v dockerd'], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * The readiness check jobs actually depend on: a real `docker info` returning
 * success. The socket file merely existing is not enough — dockerd creates it
 * before it can serve requests. Resolves `true` on exit 0, `false` on any
 * other exit or spawn error.
 */
function dockerInfoProbe() {
  return new Promise((resolve) => {
    const p = spawn('docker', ['info'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
// is diagnosable from inside the job. Idempotent: only the first call starts it.
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

/** Spawn the GitHub Actions runner for `jitConfig`. */
function startRunner(jitConfig) {
  const p = spawn('sudo', buildRunnerArgs(jitConfig), {
    cwd: '/opt/runner',
    stdio: 'inherit',
  });
  // Termination is external (the launcher/lifecycle manager decides when the
  // MicroVM itself goes away) — the agent just idles once the runner exits.
  p.on('exit', (code) => console.log(`runner exited ${code}`));
}

/**
 * Start the runner, but on a Docker-capable image only AFTER dockerd answers.
 * Called out of band, AFTER /run has already returned 200 (see the handler),
 * so the bounded wait here can't trip the platform's short /run hook timeout.
 *
 * No silent fallback: if the image has dockerd and it does not answer within
 * the bound, the runner is NOT started and exactly one line is logged. The job
 * stays queued, so the launcher's stuck-launch recovery and `queuedJobAgeAlarm`
 * surface it — far better than taking the job onto a VM whose `docker` commands
 * would fail. An image without dockerd starts immediately, unchanged.
 *
 * The daemon detection, readiness probe, runner start, log sink, and clock are
 * injectable (defaulting to the real ones) so the whole decision — start now /
 * wait then start / time out and don't start — is unit-testable without a VM.
 */
export async function decideAndStartRunner(
  jitConfig,
  {
    hasDockerd = imageHasDockerd,
    probe = dockerInfoProbe,
    start = startRunner,
    log = (m) => console.log(m),
    sleep: sleepFn = sleep,
    now,
    timeoutMs,
    intervalMs,
  } = {},
) {
  if (!hasDockerd()) {
    start(jitConfig);
    return;
  }
  const ready = await waitForDockerReady({
    probe,
    sleep: sleepFn,
    now,
    timeoutMs,
    intervalMs,
  });
  if (!ready) {
    log(
      `dockerd not ready after ${DOCKER_READY_TIMEOUT_MS / 1000}s; not accepting a job`,
    );
    return;
  }
  start(jitConfig);
}

function handleRequest(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === READY_PATH) {
      // Start dockerd at BOOT, not at /run, to CLOSE the daemon-not-ready race
      // rather than merely narrow it. dockerd + the vfs storage driver are slow
      // and variable to initialize in a MicroVM: starting it here, at the ready
      // handshake, gives it the whole boot→job-assignment window to warm up.
      // But warm-up time is not guaranteed to beat job assignment — a job that
      // landed 1 s after the runner connected found no daemon (consumer canary
      // run recreational-spreadsheeting/ci-runners 36222878239; an earlier
      // narrowing on 2026-07-19 left the window open). So booting the daemon
      // early is only half the fix: /run below still waits for `docker info` to
      // actually answer before starting the runner. Idempotent — safe if
      // /ready is called more than once.
      startDockerd();
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.url === RUN_PATH) {
      if (runnerStarted) {
        // Idempotent: the platform may call /run more than once for a VM; once
        // the runner is started, later calls just re-acknowledge.
        res.writeHead(200);
        res.end();
        return;
      }
      let jitConfig;
      try {
        ({ jitConfig } = JSON.parse(body || '{}'));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
        return;
      }
      if (!jitConfig) {
        // The platform invokes /run at EVERY VM start (with an empty payload
        // when RunMicrovm carried none) and terminates the VM on any non-200
        // (stateReason: "Run lifecycle hook returned HTTP status 400" — found
        // live 2026-07-19). Acknowledge the boot handshake; the JIT config
        // arrives via the authenticated ingress push moments later.
        res.writeHead(200);
        res.end('awaiting jitConfig');
        return;
      }
      runnerStarted = true;
      startDockerd(); // MicroVM-safe dockerd for job containers
      // Answer the /run hook FIRST. Its timeout (runTimeoutSeconds, ≤ 60 s —
      // see image-pipeline.ts) is far shorter than the dockerd-readiness bound,
      // so we ack now and do the bounded wait out of band; the platform's hook
      // timeout can never kill the VM while we wait for the daemon.
      res.writeHead(200);
      res.end();
      decideAndStartRunner(jitConfig);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

// Start the HTTP server only when run as the entrypoint, never on import —
// so a unit test can import the exported pure helpers above without binding a
// port or serving hooks.
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const server = createServer(handleRequest);
  server.listen(PORT, () => console.log(`microvm-runner agent on ${PORT}`));
}
