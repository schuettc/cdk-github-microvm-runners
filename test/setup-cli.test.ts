import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLI_PATH = join(__dirname, '..', 'scripts', 'setup-github-app.mjs');
const CLI = pathToFileURL(CLI_PATH).href;

/**
 * Load the CLI's pure helpers through node's own ESM loader.
 *
 * The helper is ESM (`.mjs`) and this suite runs as CommonJS, and ts-jest
 * preserves ESM syntax for a `.mjs` file whatever `module` it is given — so a
 * plain `import` of the script fails to parse under jest. A short-lived child
 * process loads the real module instead, which also proves the module guard:
 * `node -e` leaves `process.argv[1]` unset, so importing the script does not
 * run `main()`.
 */
function evaluate(imports: string, expression: string): any {
  const src =
    `import { ${imports} } from ${JSON.stringify(CLI)};\n` +
    `process.stdout.write(JSON.stringify(${expression}));`;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', src], {
      encoding: 'utf8',
    }),
  );
}

function accountModeFor(argv: string[]): Record<string, unknown> {
  return evaluate(
    'accountMode, parseArgs',
    `accountMode(parseArgs(${JSON.stringify(argv)}))`,
  );
}

function planFor(state: Record<string, unknown>): {
  action: string;
  reason: string;
} {
  return evaluate('planFromState', `planFromState(${JSON.stringify(state)})`);
}

describe('setup CLI account mode', () => {
  it('treats --org as an organization App', () => {
    const mode = accountModeFor(['--org', 'my-org']);
    expect(mode.newAppUrl).toBe(
      'https://github.com/organizations/my-org/settings/apps/new',
    );
    expect(mode.permissions).toEqual({
      actions: 'read',
      organization_self_hosted_runners: 'write',
    });
    expect(mode.installPermissionKey).toBe('organization_self_hosted_runners');
  });

  it('treats a bare --account as a personal App', () => {
    const mode = accountModeFor(['--account', 'schuettc']);
    expect(mode.newAppUrl).toBe('https://github.com/settings/apps/new');
    expect(mode.permissions).toEqual({
      actions: 'read',
      administration: 'write',
    });
    expect(mode.installPermissionKey).toBe('administration');
  });

  it('url-encodes an organization name', () => {
    const mode = accountModeFor(['--org', 'my org']);
    expect(mode.newAppUrl).toContain('my%20org');
  });
});

describe('setup CLI planning', () => {
  it('creates when no secrets exist', () => {
    const plan = planFor({ appId: null, pem: null, webhookSecret: null });
    expect(plan.action).toBe('create');
  });

  it('reports ok when all three secrets are present and verified', () => {
    const plan = planFor({
      appId: '123456',
      // The planner reads presence, not content. A stand-in rather than a real
      // PEM header, which the repo's secret scanner reads as a leaked key.
      pem: 'a-stored-private-key',
      webhookSecret: 'abc',
      installationVerified: true,
    });
    expect(plan.action).toBe('ok');
  });

  it('repairs when secrets are partial', () => {
    const plan = planFor({
      appId: '123456',
      pem: null,
      webhookSecret: 'abc',
    });
    expect(plan.action).toBe('repair');
    expect(plan.reason).toMatch(/private key/i);
  });

  it('repairs when the installation is missing a permission', () => {
    const plan = planFor({
      appId: '123456',
      // The planner reads presence, not content. A stand-in rather than a real
      // PEM header, which the repo's secret scanner reads as a leaked key.
      pem: 'a-stored-private-key',
      webhookSecret: 'abc',
      installationVerified: false,
    });
    expect(plan.action).toBe('repair');
  });
});

describe('setup CLI help', () => {
  // Run as a program rather than imported: --help has to answer before the
  // argument validation that a bare invocation trips, and Task 9's smoke test
  // asserts the same output from the installed package.
  it('documents every flag and exits 0', () => {
    const help = execFileSync(process.execPath, [CLI_PATH, '--help'], {
      encoding: 'utf8',
    });
    for (const flag of [
      '--org',
      '--account',
      '--stack',
      '--region',
      '--secret-prefix',
      '--app-name',
      '--port',
      '--doctor',
    ]) {
      expect(help).toContain(flag);
    }
  });

  it('exits non-zero with a usage message when no account is given', () => {
    expect(() =>
      execFileSync(process.execPath, [CLI_PATH], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow(/--org <organization> or --account <login>/);
  });
});
