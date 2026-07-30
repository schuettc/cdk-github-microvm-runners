#!/usr/bin/env node
// setup-github-app — one-command GitHub App creation for a MicroVM runner set.
//
// GitHub does not allow App *creation* via any API (a human must click Create
// once), but the App Manifest flow lets us pre-fill EVERYTHING and reduce the
// whole thing to two clicks with zero copy-paste.
//
// Every run starts by reading the three secrets and the installation, and then
// does only what is missing (see planFromState below), so the same command is
// first-time setup, a health check, and a diagnosis. When nothing is stored yet
// it:
//   1. reads the deployed runner set's webhook URL (from the CloudFormation stack),
//   2. builds a manifest with the exact permissions + events the runners need,
//   3. opens a pre-filled "Create GitHub App" page in your browser,
//   4. catches GitHub's redirect on localhost and exchanges the one-time code
//      for the App id, private key, and (GitHub-generated) webhook secret,
//   5. writes all three to Secrets Manager,
//   6. opens the install page, and
//   7. verifies the INSTALLATION (not just the App) has the right permissions
//      and event subscription — the two-truths trap that silently breaks setup.
//
// Every requirement encoded here was learned the hard way during the first
// live dogfood (see the project's setup notes): the workflow_job event is
// gated on the Actions:read permission (without it the event won't even be
// offered), and an installation keeps OLD permissions until an org owner
// accepts — so verification MUST read the installation, not the App.
//
// Run it with --help for the flags. That text lives in printHelp() below so
// there is one copy of it.
//
// Node 18+ (uses global fetch). Depends only on @aws-sdk/client-secretsmanager
// and @aws-sdk/client-cloudformation (both already in the package).

import { spawn } from 'node:child_process';
import { createSign, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- args
export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      a[key] = ''; // valueless boolean flag (e.g. --doctor)
    } else {
      a[key] = next;
      i++;
    }
  }
  return a;
}

// ---------------------------------------------------------------- help
// The usage text lives here rather than in a comment, so `--help` and the file
// stay one thing.
function printHelp() {
  console.log(`
  setup-github-app — create, check, and repair the GitHub App behind a MicroVM
  runner set.

  Usage
    npx cdk-github-microvm-runners setup --org <organization> --stack <name>
    npx cdk-github-microvm-runners setup --account <login> --stack <name>

  The package ships this as a command, so it runs the same way from a
  TypeScript or Python project. From a clone of this repository it is
  node scripts/setup-github-app.mjs with the same flags.

  Every run reads the stored secrets and the App installation first, then does
  what is missing: it creates the App when nothing is stored, says what is
  missing when some of it is, and prints a summary when the setup is complete.
  Re-running it is safe.

  Account — pass one
    --org <organization>  Create the App on an organization. It asks for
                          actions:read and organization self-hosted
                          runners:write, which is what org-wide runner
                          registration needs.
    --account <login>     Create the App on a personal account. It asks for
                          actions:read and repository administration:write,
                          which is what repository-scoped registration needs.

  Runner set
    --stack <name>        CloudFormation stack of the deployed runner set. Its
                          WebhookUrl output becomes the App's webhook URL.
    --webhook-url <url>   Use this webhook URL and skip the stack lookup.

  AWS
    --region <region>     Region holding the stack and the secrets.
                          Default: $AWS_REGION, else us-east-1
    --profile <name>      Named AWS profile to use for both.
    --secret-prefix <p>   Secrets Manager name prefix for the app-id,
                          app-private-key, and webhook-secret values.
                          Default: microvm-runner/dev

  GitHub App
    --app-name <name>     Name GitHub gives the App. GitHub requires it to be
                          unique across all of GitHub.
                          Default: microvm-runner
    --port <port>         Local port that catches GitHub's redirect while the
                          App is being created. Default: 8722

  Reporting
    --doctor              Report on the stored secrets, the installation
                          permissions, and the webhook endpoint, and create
                          nothing. A plain run prints the same report once the
                          setup is complete.
    --help                Print this text.
`);
}

// ---------------------------------------------------------------- account mode
// The organization and personal-account flows differ in exactly three places,
// and all three are data. Everything else — the manifest POST, the local
// redirect catcher, the code exchange, the secret writes, the verification
// read — is identical.
export function accountMode(args) {
  const org = args.org;
  if (org) {
    return {
      label: `organization ${org}`,
      owner: org,
      newAppUrl: `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`,
      // Org-level runner registration; actions:read gates the workflow_job event.
      permissions: {
        actions: 'read',
        organization_self_hosted_runners: 'write',
      },
      installPermissionKey: 'organization_self_hosted_runners',
      installationsUrl: `https://github.com/organizations/${encodeURIComponent(org)}/settings/installations`,
      appsUrl: `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps`,
    };
  }
  const account = args.account;
  if (!account) {
    throw new Error('pass --org <organization> or --account <login>');
  }
  return {
    label: `account ${account}`,
    owner: account,
    newAppUrl: 'https://github.com/settings/apps/new',
    // Repo-scoped registration (/repos/{owner}/{repo}/actions/runners/
    // generate-jitconfig) needs repository Administration:write; there is no
    // repo equivalent of the org runner permission.
    permissions: { actions: 'read', administration: 'write' },
    installPermissionKey: 'administration',
    installationsUrl: 'https://github.com/settings/installations',
    appsUrl: 'https://github.com/settings/apps',
  };
}

// ---------------------------------------------------------------- plan
// One command for setup, verification, and debugging later: read the current
// state first, then do only what is missing. Safe to re-run.
export function planFromState(state) {
  const missing = [];
  if (!state.appId) missing.push('app ID');
  if (!state.pem) missing.push('private key');
  if (!state.webhookSecret) missing.push('webhook secret');

  if (missing.length === 3) {
    return { action: 'create', reason: 'no App secrets are present' };
  }
  if (missing.length > 0) {
    return { action: 'repair', reason: `missing ${missing.join(', ')}` };
  }
  if (state.installationVerified === false) {
    return {
      action: 'repair',
      reason: 'the installation is missing a required permission',
    };
  }
  return {
    action: 'ok',
    reason: 'App, secrets, and installation are in place',
  };
}

const args = parseArgs(process.argv.slice(2));
const STACK = args.stack;
const REGION = args.region || process.env.AWS_REGION || 'us-east-1';
const SECRET_PREFIX = (args['secret-prefix'] || 'microvm-runner/dev').replace(
  /\/+$/,
  '',
);
const APP_NAME = args['app-name'] || 'microvm-runner';
const PORT = Number(args.port || 8722);

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- webhook url
async function resolveWebhookUrl() {
  if (args['webhook-url']) return args['webhook-url'];
  const { CloudFormationClient, DescribeStacksCommand } =
    await import('@aws-sdk/client-cloudformation');
  const cfn = new CloudFormationClient({ region: REGION });
  const res = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const outputs = res.Stacks?.[0]?.Outputs ?? [];
  const hit = outputs.find(
    (o) =>
      o.OutputKey === 'WebhookUrl' || /webhookurl/i.test(o.OutputKey ?? ''),
  );
  if (!hit?.OutputValue)
    die(
      `stack "${STACK}" has no WebhookUrl output. Add one next to the construct:\n` +
        `  new CfnOutput(stack, 'WebhookUrl', { value: runners.webhookUrl });\n` +
        `then redeploy and run this again (or pass --webhook-url directly).`,
    );
  return hit.OutputValue;
}

// ---------------------------------------------------------------- manifest
function buildManifest(mode, webhookUrl, redirectUrl) {
  // default_permissions / default_events use GitHub's API permission names,
  // and which registration permission the App asks for is the account mode's
  // business (see accountMode above).
  return {
    name: APP_NAME,
    url: 'https://github.com/schuettc/cdk-github-microvm-runners',
    hook_attributes: { url: webhookUrl, active: true },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: mode.permissions,
    default_events: ['workflow_job'],
  };
}

// ---------------------------------------------------------------- browser
function openBrowser(url) {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* fall through — we print the URL regardless */
  }
}

// ---------------------------------------------------------------- App JWT (verify step)
function appJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }),
  ).toString('base64url');
  const sig = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(pem)
    .toString('base64url');
  return `${header}.${payload}.${sig}`;
}

// `attempts` is how many times to re-ask before giving up, 2s apart.
//
// Just after creating an App there is something to wait for: the installation
// takes a moment to appear, and an org owner may still need to accept added
// permissions — the two-truths trap. Polling is right there.
//
// Inspecting an existing setup is not waiting for anything. The installation
// either is or is not in the state GitHub reports, so a single ask answers it,
// and polling would make `setup` sit for a minute before saying "not
// installed" — on the command this library tells people to re-run whenever
// they want to know where they stand.
async function verifyInstallation(mode, appId, pem, attempts = 30) {
  const jwt = appJwt(appId, pem);
  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'microvm-runner-setup',
  };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await fetch('https://api.github.com/app/installations', {
      headers,
    });
    if (res.ok) {
      const insts = await res.json();
      const inst = insts.find(
        (i) => i.account?.login?.toLowerCase() === mode.owner.toLowerCase(),
      );
      if (inst) {
        const perms = inst.permissions ?? {};
        const events = inst.events ?? [];
        const okActions = perms.actions === 'read';
        const okRegister = perms[mode.installPermissionKey] === 'write';
        const okEvent = events.includes('workflow_job');
        if (okActions && okRegister && okEvent) return { ok: true, inst };
        return {
          ok: false,
          reason:
            `installation on ${mode.owner} is missing: ` +
            [
              !okRegister && `${mode.installPermissionKey}:write`,
              !okActions && 'actions:read',
              !okEvent && 'the workflow_job event',
            ]
              .filter(Boolean)
              .join(', ') +
            `. If you just accepted new permissions it may take a moment; ` +
            `otherwise accept them at ${mode.installationsUrl}/${inst.id}`,
          inst,
        };
      }
    }
    await sleep(2000);
  }
  return {
    ok: false,
    reason: `no installation found on ${mode.owner} yet — did you click Install?`,
  };
}

// ---------------------------------------------------------------- secrets
async function storeSecrets({ appId, pem, webhookSecret }) {
  const { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: REGION });
  const put = async (name, value) => {
    try {
      await sm.send(
        new CreateSecretCommand({ Name: name, SecretString: value }),
      );
      return 'created';
    } catch (e) {
      if (e?.name === 'ResourceExistsException') {
        await sm.send(
          new PutSecretValueCommand({ SecretId: name, SecretString: value }),
        );
        return 'updated';
      }
      throw e;
    }
  };
  const r1 = await put(`${SECRET_PREFIX}/app-id`, String(appId));
  const r2 = await put(`${SECRET_PREFIX}/app-private-key`, pem);
  const r3 = await put(`${SECRET_PREFIX}/webhook-secret`, webhookSecret);
  return { r1, r2, r3 };
}

// ---------------------------------------------------------------- secrets read
async function readSecret(name) {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: REGION });
  const res = await sm.send(new GetSecretValueCommand({ SecretId: name }));
  return res.SecretString;
}

// An absent secret is a state the planner reads, so a missing one comes back
// as null; every other failure (denied, throttled, wrong region) still throws.
async function readSecretOrNull(name) {
  try {
    return (await readSecret(name)) ?? null;
  } catch (e) {
    if (e?.name === 'ResourceNotFoundException') return null;
    throw e;
  }
}

// ---------------------------------------------------------------- current state
// The three secrets the runner set reads, and how to put each one back by hand
// when only that one is gone.
const SECRETS = [
  {
    field: 'appId',
    label: 'app ID',
    suffix: 'app-id',
    repair: 'copy the App ID from the App settings page and store it',
  },
  {
    field: 'pem',
    label: 'private key',
    suffix: 'app-private-key',
    // GitHub shows a private key once, at generation, so a lost one is
    // replaced rather than re-read.
    repair:
      'generate a new private key on the App settings page and store the .pem it downloads',
  },
  {
    field: 'webhookSecret',
    label: 'webhook secret',
    suffix: 'webhook-secret',
    repair:
      'set a new webhook secret on the App settings page and store the same value',
  },
];

// Read everything the plan depends on before deciding anything.
async function readState(mode) {
  const state = {};
  for (const s of SECRETS) {
    state[s.field] = await readSecretOrNull(`${SECRET_PREFIX}/${s.suffix}`);
  }
  if (state.appId) state.appId = state.appId.trim();
  // The installation is only worth reading once the App can be authenticated
  // as, which takes both the ID and the key.
  if (state.appId && state.pem) {
    // One ask, not the create path's poll — see verifyInstallation.
    const v = await verifyInstallation(mode, state.appId, state.pem, 1);
    state.installationVerified = v.ok;
    state.installationReason = v.reason;
  }
  return state;
}

// ---------------------------------------------------------------- report
// What the setup looks like right now: which secrets are stored, whether the
// installation carries the permissions and the event (the two-truths trap), and
// whether the webhook endpoint answers an unsigned request with a 401.
async function report(mode, state) {
  console.log(
    `\n  Checking ${mode.label} setup (secrets ${SECRET_PREFIX}, region ${REGION})\n`,
  );
  for (const s of SECRETS) {
    console.log(
      state[s.field]
        ? `  ✓ ${SECRET_PREFIX}/${s.suffix} stored`
        : `  ✗ ${SECRET_PREFIX}/${s.suffix} absent`,
    );
  }
  if (state.installationVerified === true) {
    console.log('  ✓ installation permissions + workflow_job event: OK');
  } else if (state.installationVerified === false) {
    console.log(`  ✗ installation: ${state.installationReason}`);
  }

  if (args['webhook-url'] || STACK) {
    const webhookUrl = await resolveWebhookUrl();
    try {
      // #skylos:ignore SSRF — this is a local operator CLI, not a server; the
      // URL is the operator's own runner set webhook (from their CFN stack output or
      // --webhook-url), and the request is an unauthenticated liveness probe.
      const r = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      console.log(
        r.status === 401
          ? '  ✓ webhook endpoint live and rejecting unsigned requests (401)'
          : `  ⚠ webhook endpoint returned ${r.status} to an unsigned request (expected 401)`,
      );
    } catch (e) {
      console.log(`  ⚠ webhook endpoint unreachable: ${e.message}`);
    }
  }
  console.log('');
}

// ---------------------------------------------------------------- repair
// Partial state is not something this command can fix on its own: the App
// already exists, and the values it holds are not readable back out of GitHub.
// Print the one missing piece and the way to put it back.
function printRepair(mode, state, plan) {
  console.error(`\n  ✗ ${plan.reason}\n`);
  const gone = SECRETS.filter((s) => !state[s.field]);
  if (gone.length > 0) {
    console.error(
      `  An App is already recorded under ${SECRET_PREFIX}, so creating a` +
        ` second one would leave two Apps pointed at the same runner set.\n`,
    );
    for (const s of gone) {
      console.error(`  ${s.label} — ${s.repair}:`);
      console.error(
        `    aws secretsmanager put-secret-value --region ${REGION} \\\n` +
          `      --secret-id ${SECRET_PREFIX}/${s.suffix} --secret-string <value>`,
      );
    }
    console.error(`\n  The App settings live at ${mode.appsUrl}.`);
    console.error(
      `  To start over instead, delete ${SECRET_PREFIX}/{${SECRETS.map(
        (s) => s.suffix,
      ).join(',')}} and run this command again.\n`,
    );
    return;
  }
  console.error(`  ${state.installationReason}\n`);
}

// ---------------------------------------------------------------- create flow
async function createApp(mode) {
  if (!STACK && !args['webhook-url'])
    die(
      'pass --stack <name> (to read the webhook URL from CloudFormation) or --webhook-url <url>.',
    );
  const webhookUrl = await resolveWebhookUrl();
  const oauthState = randomBytes(16).toString('hex');
  // localhost is intentional and load-bearing: GitHub's App Manifest flow
  // redirects the OAuth code back to a listener on this machine. These are not
  // misconfigured "internal" hosts — they are the ephemeral local callback.
  const redirectUrl = `http://localhost:${PORT}/callback`;
  const manifest = buildManifest(mode, webhookUrl, redirectUrl);
  const createPageUrl = `http://localhost:${PORT}/`;

  console.log(`\n  Runner set webhook URL:  ${webhookUrl}`);
  console.log(`  GitHub target:      ${mode.label}`);
  console.log(`  Secrets prefix:     ${SECRET_PREFIX} (region ${REGION})\n`);

  const conversion = await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      // Step A: serve a page that auto-POSTs the manifest to GitHub.
      if (u.pathname === '/') {
        const action = `${mode.newAppUrl}?state=${oauthState}`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Create App…</title>
<body style="font:16px system-ui;margin:3rem;max-width:34rem">
<h2>Redirecting you to GitHub…</h2>
<p>A pre-filled “Create GitHub App” page is opening. Click <b>Create GitHub App</b>, then come back here.</p>
<form id="f" method="post" action="${action}">
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, '&#39;')}'>
</form>
<script>document.getElementById('f').submit()</script>
<noscript><button onclick="document.getElementById('f').submit()">Continue to GitHub</button></noscript>
</body>`);
        return;
      }
      // Step B: GitHub redirects back with ?code=… — exchange it.
      if (u.pathname === '/callback') {
        const code = u.searchParams.get('code');
        const gotState = u.searchParams.get('state');
        if (gotState !== oauthState) {
          res.writeHead(400).end('state mismatch');
          return reject(new Error('OAuth state mismatch — aborting.'));
        }
        try {
          const r = await fetch(
            `https://api.github.com/app-manifests/${code}/conversions`,
            {
              method: 'POST',
              headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'microvm-runner-setup',
              },
            },
          );
          if (!r.ok)
            throw new Error(`conversion failed: ${r.status} ${await r.text()}`);
          const data = await r.json();
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;margin:3rem">
<h2>✓ App created</h2><p>Return to your terminal — one Install click left.</p></body>`);
          server.close();
          resolve(data);
        } catch (e) {
          res.writeHead(500).end(String(e));
          server.close();
          reject(e);
        }
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(PORT, () => {
      console.log(
        `  → Opening ${createPageUrl} — click “Create GitHub App” in your browser.\n`,
      );
      openBrowser(createPageUrl);
    });
    server.on('error', reject);
  });

  // Exchange result: id, slug, pem, webhook_secret, client_id, html_url…
  const appId = conversion.id;
  const slug = conversion.slug;
  const pem = conversion.pem;
  const webhookSecret = conversion.webhook_secret;
  if (!appId || !pem || !webhookSecret)
    die('conversion response missing id/pem/webhook_secret — cannot continue.');

  console.log(`  App created: ${conversion.name} (id ${appId})`);
  const stored = await storeSecrets({ appId, pem, webhookSecret });
  console.log(
    `  Secrets ${SECRET_PREFIX}/{app-id,app-private-key,webhook-secret}: ${stored.r1}/${stored.r2}/${stored.r3}\n`,
  );

  // Install click.
  const installUrl = `https://github.com/apps/${slug}/installations/new`;
  console.log(`  → Now INSTALL the App on ${mode.owner}:`);
  console.log(
    `    ${installUrl}\n    (opening it for you — click Install, grant it the repositories the runner set serves, then wait here)\n`,
  );
  openBrowser(installUrl);

  // Verify at the installation level.
  console.log('  Verifying the installation…');
  const v = await verifyInstallation(mode, appId, pem);
  if (!v.ok) {
    console.error(`\n  ⚠ ${v.reason}\n`);
    process.exit(2);
  }
  console.log(
    `\n  ✓ Installation on ${mode.owner} verified: actions:read · ${mode.installPermissionKey}:write · workflow_job.`,
  );
  console.log(`  ✓ The runner set can now register runners. You're done.\n`);
}

// ---------------------------------------------------------------- main flow
async function main() {
  // --help answers before the arguments are validated, so it works on the run
  // where the reader does not yet know which arguments there are.
  if (args.help !== undefined) return printHelp();
  if (args.profile) process.env.AWS_PROFILE = args.profile;
  const mode = accountMode(args);

  const state = await readState(mode);
  const plan = planFromState(state);

  // --doctor reports and stops, whatever the plan says. It predates the
  // inspect-first run and stays as the way to ask for the report on its own.
  if (args.doctor !== undefined) {
    await report(mode, state);
    process.exit(plan.action === 'ok' ? 0 : 2);
  }

  if (plan.action === 'ok') {
    await report(mode, state);
    console.log(`  ✓ ${plan.reason}. Nothing to do.\n`);
    return;
  }

  if (plan.action === 'repair') {
    await report(mode, state);
    printRepair(mode, state, plan);
    process.exit(2);
  }

  return createApp(mode);
}

// Only run when invoked as a program, so the pure helpers above are importable
// by the tests. Compare resolved real paths rather than file names: installed
// as this package's `bin`, the file is reached through npm's
// node_modules/.bin/cdk-github-microvm-runners symlink, which node leaves
// un-resolved in argv[1] — a name comparison sees "cdk-github-microvm-runners"
// against "setup.js", decides it was imported, and the CLI exits silently.
function invokedAsProgram() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    // An argv[1] that no longer exists on disk is not this file.
    return false;
  }
}

if (invokedAsProgram()) {
  main().catch((e) => die(e.message || String(e)));
}
