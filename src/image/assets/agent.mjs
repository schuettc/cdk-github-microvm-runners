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
import { openSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
// The most one `docker info` check may take. A `docker info` against a daemon
// that holds the socket but never answers blocks instead of failing (seen on a
// GB2 VM in August: "socket present, docker info blocked"), so without a bound
// a single check could outlast DOCKER_READY_TIMEOUT_MS.
export const DOCKER_PROBE_TIMEOUT_MS = 10_000;
// The socket containerd listens on by default, and the one dockerd is pointed
// at with --containerd.
export const CONTAINERD_SOCKET = '/run/containerd/containerd.sock';
// Where containerd's and dockerd's stdout/stderr go, and how much of it is
// echoed to the console when the agent refuses a job because Docker never
// answered.
const DOCKERD_LOG = '/var/log/microvm-runner-dockerd.log';
const DOCKERD_LOG_TAIL_LINES = 50;

let runnerStarted = false;
let containerdStarted = false;
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
 * of probes as well as on wall-clock time. Each probe is passed how long it may
 * take: DOCKER_PROBE_TIMEOUT_MS, or the time left before the deadline if that
 * is less, so a check that hangs cannot carry the wait past the bound.
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
    if (await probe(Math.min(DOCKER_PROBE_TIMEOUT_MS, deadline - now())))
      return true;
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
 * A bounded readiness check: run `command args` (by default `docker info`, the
 * check jobs actually depend on; the socket file merely existing is not enough,
 * since dockerd creates it before it can serve requests). Resolves `true` on
 * exit 0, `false` on any other exit or spawn error, and `false` once
 * `timeoutMs` passes, killing the check with SIGKILL so a hung check is not
 * left behind. Resolves once. The containerd wait uses it with
 * `ctr --address <socket> version`; a test stands in a check that hangs.
 */
export function commandProbe({
  timeoutMs,
  command = 'docker',
  args = ['info'],
}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const p = spawn(command, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      settle(false);
    }, timeoutMs);
    p.on('error', () => settle(false));
    p.on('exit', (code) => settle(code === 0));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Open the shared daemon log and spawn `command args` detached, writing to it.
 * A spawn error is logged, not thrown.
 */
function spawnDaemon(command, args) {
  try {
    mkdirSync('/var/log', { recursive: true });
    const log = openSync(DOCKERD_LOG, 'a');
    const d = spawn(command, args, {
      stdio: ['ignore', log, log],
      detached: true,
    });
    d.on('error', (e) => console.log(`${command} failed to spawn: ${e}`));
    d.unref();
  } catch (e) {
    console.log(`${command} start error: ${e}`);
  }
}

// Start containerd ourselves, with its defaults (socket CONTAINERD_SOCKET), as
// AL2023's containerd.service does. Left to dockerd, containerd is started by
// dockerd's own supervisor, which gives it a fixed 15 s to answer and then
// exits with "failed to start containerd: timeout waiting for containerd to
// start"; loading the containerd binary on a fresh VM has taken up to about
// 11 s, so that limit was being missed (#55). Its output goes to the same log
// as dockerd's, so a refusal's tail shows both. Called once per VM, when the
// job's configuration reaches /run; later calls do nothing.
function startContainerd() {
  if (containerdStarted) return;
  containerdStarted = true;
  spawnDaemon('containerd', []);
}

/**
 * dockerd's flags. MicroVMs (no nested KVM, snapshot rootfs, limited
 * netfilter) break dockerd's defaults two ways found live 2026-07-19 (dockerd
 * never became ready):
 *   --storage-driver=vfs   overlay2 needs a backing fs the snapshot rootfs
 *                          may not provide; vfs works everywhere (slower, but
 *                          correct — fine for CI build/run).
 *   --iptables=false       dockerd's iptables NAT setup fails without the
 *                          host netfilter modules; disabling it lets builds
 *                          and host-network runs work.
 * And --containerd points it at the containerd the agent already started and
 * waited for, so dockerd skips starting its own (and that 15 s limit) and only
 * dials the socket — the arrangement AL2023's docker.service uses (#55).
 */
export function dockerdArgs() {
  return [
    `--containerd=${CONTAINERD_SOCKET}`,
    '--storage-driver=vfs',
    '--iptables=false',
  ];
}

// Start the Docker daemon with dockerdArgs(), after containerd answers.
// Output is logged to /var/log/microvm-runner-dockerd.log (NOT swallowed) so a failure
// is diagnosable from inside a job, and when dockerd never answers and no job
// runs, decideAndStartRunner prints the log's tail to the console instead.
// Called once per VM, when the job's configuration reaches /run; later calls
// do nothing.
function startDockerd() {
  if (dockerStarted) return;
  dockerStarted = true;
  spawnDaemon('dockerd', dockerdArgs());
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
 * the bound, the runner is NOT started: one line says so, followed by the tail
 * of dockerd's own log (or one line saying it could not be read), since no job
 * will run to show it. The job stays queued, so the launcher's stuck-launch
 * recovery and `queuedJobAgeAlarm` surface it — far better than taking the job
 * onto a VM whose `docker` commands would fail. An image without dockerd
 * starts immediately, unchanged.
 *
 * On a Docker-capable image containerd and then dockerd are started here,
 * when the job's configuration has arrived, and not earlier: /ready runs once
 * at image build and every VM resumes from the snapshot taken after it, so a
 * daemon started before then is carried across that snapshot (and across a
 * warm VM's suspend) half-started. containerd comes first, and dockerd only
 * once `ctr version` answers: dockerd's own containerd start gives up after a
 * fixed 15 s, which a slow first program load exceeds ("failed to start
 * containerd: timeout waiting for containerd to start", issue #55); this is
 * the order AL2023's own containerd.service and docker.service use. Both waits
 * share one DOCKER_READY_TIMEOUT_MS budget from the job's arrival, and either
 * running out ends in the same refusal. How long each took is logged. One
 * start of each per job: no restart or retry.
 *
 * The daemon detection, daemon starts, readiness probes, runner start, log
 * sink, daemon log reader, and clock are injectable (defaulting to the real
 * ones) so the whole decision — start now / start the daemons, wait then start
 * / time out and don't start — is unit-testable without a VM.
 */
export async function decideAndStartRunner(
  jitConfig,
  {
    hasDockerd = imageHasDockerd,
    startContainerd: startContainerdFn = startContainerd,
    containerdProbe = (timeoutMs) =>
      commandProbe({
        timeoutMs,
        command: 'ctr',
        args: ['--address', CONTAINERD_SOCKET, 'version'],
      }),
    startDockerd: startDockerdFn = startDockerd,
    probe = (timeoutMs) => commandProbe({ timeoutMs }),
    start = startRunner,
    log = (m) => console.log(m),
    readDockerdLog = () => readFileSync(DOCKERD_LOG, 'utf8'),
    sleep: sleepFn = sleep,
    now = () => Date.now(),
    timeoutMs = DOCKER_READY_TIMEOUT_MS,
    intervalMs,
  } = {},
) {
  if (!hasDockerd()) {
    start(jitConfig);
    return;
  }
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const waitFor = (readyProbe) =>
    waitForDockerReady({
      probe: readyProbe,
      sleep: sleepFn,
      now,
      timeoutMs: deadline - now(),
      intervalMs,
    });
  const refuse = () => {
    log(
      `dockerd not ready after ${DOCKER_READY_TIMEOUT_MS / 1000}s; not accepting a job`,
    );
    logDockerdTail(readDockerdLog, log);
  };
  const took = () => ((now() - startedAt) / 1000).toFixed(1);

  startContainerdFn();
  if (!(await waitFor(containerdProbe))) return refuse();
  log(`containerd ready after ${took()}s`);

  startDockerdFn();
  if (!(await waitFor(probe))) return refuse();
  log(`dockerd ready after ${took()}s`);
  start(jitConfig);
}

/**
 * Log the last DOCKERD_LOG_TAIL_LINES lines of dockerd's log under a header,
 * or one line saying why there is nothing to show.
 */
function logDockerdTail(readDockerdLog, log) {
  let text;
  try {
    text = readDockerdLog();
  } catch (e) {
    log(`${DOCKERD_LOG} could not be read: ${e}`);
    return;
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) {
    log(`${DOCKERD_LOG} is empty`);
    return;
  }
  const tail = lines.slice(-DOCKERD_LOG_TAIL_LINES);
  log(`--- last ${tail.length} lines of ${DOCKERD_LOG} ---`);
  for (const line of tail) log(line);
}

function handleRequest(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === READY_PATH) {
      // Answer and start nothing. /ready runs once, at image build, and every
      // VM resumes from the snapshot taken right after it, so a dockerd
      // started here would be carried across that snapshot (and across a warm
      // VM's suspend) half-started, and fail on resume (#55). containerd and
      // dockerd start when the job's configuration reaches /run
      // (decideAndStartRunner).
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
      // Answer the /run hook FIRST. Its timeout (runTimeoutSeconds, ≤ 60 s —
      // see image-pipeline.ts) is far shorter than the dockerd-readiness bound,
      // so we ack now and start dockerd and do the bounded wait out of band;
      // the platform's hook timeout can never kill the VM while we wait for
      // the daemon.
      res.writeHead(200);
      res.end();
      // Fire-and-forget by design (the /run hook is already acked), but a
      // rejection must never go unhandled — log it so a failed start is
      // diagnosable rather than a silent UnhandledPromiseRejection.
      decideAndStartRunner(jitConfig).catch((e) =>
        console.log(`runner start failed: ${e}`),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

/**
 * True when this module is the process entrypoint (run directly), false when
 * it is imported. Compares REALPATHS, not the raw URLs: Node resolves symlinks
 * in `import.meta.url` but leaves `process.argv[1]` as given, so when the agent
 * is launched through a symlink (its normal case — `/opt/microvm-runner/agent.mjs`
 * may itself be a link) a raw `import.meta.url === pathToFileURL(argv1)`
 * compare is false and the server silently never starts. Guards a missing
 * `argv1` and any resolve error (a path that can't be realpath'd is not the
 * entrypoint). Exported so the guard is unit-testable without binding a port.
 */
export function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

// Start the HTTP server only when run as the entrypoint, never on import —
// so a unit test can import the exported pure helpers above without binding a
// port or serving hooks.
if (isMainModule(import.meta.url, process.argv[1])) {
  const server = createServer(handleRequest);
  server.listen(PORT, () => console.log(`microvm-runner agent on ${PORT}`));
}
