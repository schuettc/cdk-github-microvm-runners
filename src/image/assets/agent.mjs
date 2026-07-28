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
import { openSync, mkdirSync } from 'node:fs';

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
      res.writeHead(200);
      res.end();
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
