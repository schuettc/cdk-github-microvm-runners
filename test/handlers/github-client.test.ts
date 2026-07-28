import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { fetch as undiciFetch, MockAgent } from 'undici';
import {
  _resetCachesForTesting,
  deleteRunner,
  generateJitConfig,
  getInstallationToken,
  getRunner,
  listRunners,
  RetryableError,
  type ScopeTarget,
} from '../../src/handlers/shared/github-client.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const smMock = mockClient(SecretsManagerClient);
const kmsMock = mockClient(KMSClient);

let mockAgent: MockAgent;
let pool: ReturnType<MockAgent['get']>;

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GH_')) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

/** PAT-kind env, used by every test that doesn't care about App-JWT auth. */
function setPatEnv(): void {
  process.env.GH_AUTH_KIND = 'pat';
  process.env.GH_PAT_SECRET_ARN =
    'arn:aws:secretsmanager:us-east-1:1:secret:pat';
  smMock.on(GetSecretValueCommand).resolves({ SecretString: 'ghp_thepat' });
}

/** App-kind env with a secret-backed key, used by the JWT/install-flow tests. */
function setAppSecretEnv(appId = '12345'): void {
  process.env.GH_AUTH_KIND = 'app';
  process.env.GH_APP_ID = appId;
  process.env.GH_KEY_SECRET_ARN =
    'arn:aws:secretsmanager:us-east-1:1:secret:key';
  smMock.on(GetSecretValueCommand).resolves({ SecretString: privateKey });
}

/** Mocks GET /app/installations (per_page=100&page=1) to return exactly one installation. */
function interceptSingleInstallation(
  installationId: number,
  login = 'acme',
): void {
  pool
    .intercept({
      path: '/app/installations?per_page=100&page=1',
      method: 'GET',
    })
    .reply(200, [{ id: installationId, account: { login } }]);
}

/** Mocks the access-token exchange, optionally capturing the Authorization header. */
function interceptAccessTokenExchange(
  installationId: number,
  reply: { token: string; expiresAt: Date },
  onAuth?: (bearer: string | undefined) => void,
): void {
  pool
    .intercept({
      path: `/app/installations/${installationId}/access_tokens`,
      method: 'POST',
      headers: onAuth
        ? (headers) => {
            onAuth((headers as Record<string, string>).authorization);
            return true;
          }
        : undefined,
    })
    .reply(201, {
      token: reply.token,
      expires_at: reply.expiresAt.toISOString(),
    });
}

function decodeJwt(bearer: string | undefined): {
  headerB64: string;
  payloadB64: string;
  signatureB64: string;
  header: { alg: string; typ: string };
  payload: { iss: string; iat: number; exp: number };
} {
  expect(bearer).toBeDefined();
  const jwt = bearer!.replace(/^Bearer\s+/, '');
  const [headerB64, payloadB64, signatureB64] = jwt.split('.');
  return {
    headerB64,
    payloadB64,
    signatureB64,
    header: JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')),
  };
}

beforeEach(() => {
  resetEnv();
  _resetCachesForTesting();
  smMock.reset();
  kmsMock.reset();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  // Under jest's sandboxed globals, undici's setGlobalDispatcher never
  // reaches node's built-in fetch (separate globalThis realms) — route
  // fetch through npm-undici with the MockAgent as an explicit dispatcher.
  globalThis.fetch = ((input: any, init?: any) =>
    undiciFetch(input, {
      ...init,
      dispatcher: mockAgent,
    })) as unknown as typeof fetch;
  pool = mockAgent.get('https://api.github.com');
});

afterEach(async () => {
  await mockAgent.close();
  resetEnv();
});

describe('getInstallationToken — app kind, secret-backed key', () => {
  it('signs a valid RS256 JWT (iss = app id, exp - iat <= 600) to fetch the installation token', async () => {
    setAppSecretEnv();
    let capturedAuth: string | undefined;
    interceptSingleInstallation(555);
    interceptAccessTokenExchange(
      555,
      { token: 'ghs_abc123', expiresAt: new Date(Date.now() + 3600_000) },
      (bearer) => {
        capturedAuth = bearer;
      },
    );

    const token = await getInstallationToken({ org: 'acme' });
    expect(token).toBe('ghs_abc123');

    const { headerB64, payloadB64, signatureB64, header, payload } =
      decodeJwt(capturedAuth);
    expect(header.alg).toBe('RS256');
    const nowSec = Math.floor(Date.now() / 1000);
    expect(payload.iss).toBe('12345');
    expect(payload.iat).toBeLessThanOrEqual(nowSec - 55);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(payload.exp).toBeGreaterThan(nowSec);

    const valid = cryptoVerify(
      'RSA-SHA256',
      Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
      publicKey,
      Buffer.from(signatureB64, 'base64url'),
    );
    expect(valid).toBe(true);
  });

  it('caches the installation token until 5 minutes before expiry (no re-fetch)', async () => {
    setAppSecretEnv();
    interceptSingleInstallation(555);
    interceptAccessTokenExchange(555, {
      token: 'ghs_cached',
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const first = await getInstallationToken({ org: 'acme' });
    const second = await getInstallationToken({ org: 'acme' });
    expect(first).toBe('ghs_cached');
    expect(second).toBe('ghs_cached');
    // No further interceptors were registered above; a third HTTP call would
    // throw (net connect disabled), so reaching here proves caching held.
  });

  it('re-fetches a new token once within 5 minutes of expiry, reusing the cached installation id', async () => {
    setAppSecretEnv();
    // Only ONE /app/installations interceptor is registered: the
    // installation id must be cached and reused across the two token
    // fetches below, not re-discovered.
    interceptSingleInstallation(555);
    interceptAccessTokenExchange(555, {
      token: 'ghs_almost_expired',
      expiresAt: new Date(Date.now() + 4 * 60_000), // within the 5-min skew
    });
    interceptAccessTokenExchange(555, {
      token: 'ghs_fresh',
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const first = await getInstallationToken({ org: 'acme' });
    const second = await getInstallationToken({ org: 'acme' });
    expect(first).toBe('ghs_almost_expired');
    expect(second).toBe('ghs_fresh');
  });
});

describe('getInstallationToken — app id from Secrets Manager', () => {
  const APP_ID_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:1:secret:app-id';
  const KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:1:secret:key';

  /** App-kind env whose numeric id is a secret reference, not a literal. */
  function setAppIdSecretEnv(storedAppId: string): void {
    process.env.GH_AUTH_KIND = 'app';
    process.env.GH_APP_ID_SECRET_ARN = APP_ID_SECRET_ARN;
    process.env.GH_KEY_SECRET_ARN = KEY_SECRET_ARN;
    smMock
      .on(GetSecretValueCommand, { SecretId: APP_ID_SECRET_ARN })
      .resolves({ SecretString: storedAppId });
    smMock
      .on(GetSecretValueCommand, { SecretId: KEY_SECRET_ARN })
      .resolves({ SecretString: privateKey });
  }

  it('resolves the app id from GH_APP_ID_SECRET_ARN into the JWT iss claim', async () => {
    setAppIdSecretEnv('778899');
    let capturedAuth: string | undefined;
    interceptSingleInstallation(555);
    interceptAccessTokenExchange(
      555,
      { token: 'ghs_secret_id', expiresAt: new Date(Date.now() + 3600_000) },
      (bearer) => {
        capturedAuth = bearer;
      },
    );

    const token = await getInstallationToken({ org: 'acme' });
    expect(token).toBe('ghs_secret_id');
    expect(decodeJwt(capturedAuth).payload.iss).toBe('778899');
  });

  it('trims surrounding whitespace/newlines from the stored app id', async () => {
    setAppIdSecretEnv('778899\n');
    let capturedAuth: string | undefined;
    interceptSingleInstallation(555);
    interceptAccessTokenExchange(
      555,
      { token: 'ghs_trimmed', expiresAt: new Date(Date.now() + 3600_000) },
      (bearer) => {
        capturedAuth = bearer;
      },
    );

    await getInstallationToken({ org: 'acme' });
    expect(decodeJwt(capturedAuth).payload.iss).toBe('778899');
  });

  it('caches the app id across JWT builds (single GetSecretValue for it)', async () => {
    setAppIdSecretEnv('778899');
    interceptSingleInstallation(555);
    // Two token fetches: the second is forced by an almost-expired first token,
    // so a second JWT — and therefore a second app-id resolution — is built.
    interceptAccessTokenExchange(555, {
      token: 'ghs_almost_expired',
      expiresAt: new Date(Date.now() + 4 * 60_000),
    });
    interceptAccessTokenExchange(555, {
      token: 'ghs_fresh',
      expiresAt: new Date(Date.now() + 3600_000),
    });

    await getInstallationToken({ org: 'acme' });
    await getInstallationToken({ org: 'acme' });

    const appIdCalls = smMock
      .commandCalls(GetSecretValueCommand)
      .filter((call) => call.args[0].input.SecretId === APP_ID_SECRET_ARN);
    expect(appIdCalls).toHaveLength(1);
  });

  it('prefers a literal GH_APP_ID and never calls Secrets Manager for the id', async () => {
    setAppIdSecretEnv('778899');
    process.env.GH_APP_ID = '12345';
    let capturedAuth: string | undefined;
    interceptSingleInstallation(555);
    interceptAccessTokenExchange(
      555,
      { token: 'ghs_literal', expiresAt: new Date(Date.now() + 3600_000) },
      (bearer) => {
        capturedAuth = bearer;
      },
    );

    await getInstallationToken({ org: 'acme' });
    expect(decodeJwt(capturedAuth).payload.iss).toBe('12345');
    const appIdCalls = smMock
      .commandCalls(GetSecretValueCommand)
      .filter((call) => call.args[0].input.SecretId === APP_ID_SECRET_ARN);
    expect(appIdCalls).toHaveLength(0);
  });

  it('throws when app kind sets neither GH_APP_ID nor GH_APP_ID_SECRET_ARN', async () => {
    process.env.GH_AUTH_KIND = 'app';
    process.env.GH_KEY_SECRET_ARN = KEY_SECRET_ARN;
    smMock.on(GetSecretValueCommand).resolves({ SecretString: privateKey });

    await expect(getInstallationToken({ org: 'acme' })).rejects.toThrow(
      /neither GH_APP_ID nor GH_APP_ID_SECRET_ARN/,
    );
  });
});

describe('getInstallationToken — app kind, KMS-backed key', () => {
  it('signs via KMS Sign with RSASSA_PKCS1_V1_5_SHA_256 / RAW on the exact header.payload message', async () => {
    process.env.GH_AUTH_KIND = 'app';
    process.env.GH_APP_ID = '999';
    process.env.GH_KEY_KMS_ARN = 'arn:aws:kms:us-east-1:1:key/abc';

    let capturedAuth: string | undefined;
    interceptSingleInstallation(7);
    interceptAccessTokenExchange(
      7,
      { token: 'ghs_kms', expiresAt: new Date(Date.now() + 3600_000) },
      (bearer) => {
        capturedAuth = bearer;
      },
    );

    // Sign the eventual header.payload for real so the returned Signature is
    // usable, but the point of this test is asserting the exact SignCommand
    // params GitHub's App-JWT contract requires.
    kmsMock.on(SignCommand).callsFake((input) => {
      const signature = cryptoSign(
        'RSA-SHA256',
        Buffer.from(input.Message as Uint8Array),
        privateKey,
      );
      return { Signature: new Uint8Array(signature) };
    });

    const token = await getInstallationToken({ org: 'acme' });
    expect(token).toBe('ghs_kms');

    expect(kmsMock.commandCalls(SignCommand)).toHaveLength(1);
    const signInput = kmsMock.commandCalls(SignCommand)[0].args[0].input;
    expect(signInput.KeyId).toBe('arn:aws:kms:us-east-1:1:key/abc');
    expect(signInput.SigningAlgorithm).toBe('RSASSA_PKCS1_V1_5_SHA_256');
    expect(signInput.MessageType).toBe('RAW');

    const { headerB64, payloadB64 } = decodeJwt(capturedAuth);
    const expectedMessage = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    expect(
      Buffer.from(signInput.Message as Uint8Array).equals(expectedMessage),
    ).toBe(true);
  });
});

describe('getInstallationToken — pat kind', () => {
  it('returns the PAT from Secrets Manager and caches it (single GetSecretValue call)', async () => {
    setPatEnv();

    const first = await getInstallationToken({ org: 'acme' });
    const second = await getInstallationToken({ org: 'acme' });

    expect(first).toBe('ghp_thepat');
    expect(second).toBe('ghp_thepat');
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });
});

describe('getInstallationToken — misconfiguration guards', () => {
  it('throws when GH_AUTH_KIND is unset', async () => {
    await expect(getInstallationToken({ org: 'acme' })).rejects.toThrow(
      /GH_AUTH_KIND/,
    );
  });

  it('throws on an unrecognized GH_AUTH_KIND value', async () => {
    process.env.GH_AUTH_KIND = 'bogus';
    await expect(getInstallationToken({ org: 'acme' })).rejects.toThrow(
      /unknown GH_AUTH_KIND/,
    );
  });

  it('throws when app kind has neither GH_KEY_SECRET_ARN nor GH_KEY_KMS_ARN', async () => {
    process.env.GH_AUTH_KIND = 'app';
    process.env.GH_APP_ID = '1';
    interceptSingleInstallation(1);

    await expect(getInstallationToken({ org: 'acme' })).rejects.toThrow(
      /neither GH_KEY_SECRET_ARN nor GH_KEY_KMS_ARN/,
    );
  });

  it('throws a clear error naming the owner and listing available logins when no installation matches', async () => {
    setAppSecretEnv('1');
    pool
      .intercept({
        path: '/app/installations?per_page=100&page=1',
        method: 'GET',
      })
      .reply(200, [{ id: 1, account: { login: 'other-org' } }]);

    await expect(getInstallationToken({ org: 'acme' })).rejects.toThrow(
      /no GitHub App installation found for "acme".*other-org/,
    );
  });

  it('throws the same clear error when the App has zero installations at all', async () => {
    setAppSecretEnv('1');
    pool
      .intercept({
        path: '/app/installations?per_page=100&page=1',
        method: 'GET',
      })
      .reply(200, []);

    await expect(getInstallationToken({ org: 'acme' })).rejects.toThrow(
      /no GitHub App installation found for "acme"/,
    );
  });

  it('selects the installation whose account.login matches the target org case-insensitively, among multiple installations', async () => {
    setAppSecretEnv('1');
    pool
      .intercept({
        path: '/app/installations?per_page=100&page=1',
        method: 'GET',
      })
      .reply(200, [
        { id: 1, account: { login: 'other-org' } },
        { id: 2, account: { login: 'ACME' } },
      ]);
    interceptAccessTokenExchange(2, {
      token: 'ghs_acme',
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const token = await getInstallationToken({ org: 'acme' });
    expect(token).toBe('ghs_acme');
  });

  it('caches installation id and token PER OWNER LOGIN, not process-global (two owners -> two token fetches, second call per owner cached)', async () => {
    setAppSecretEnv('1');
    pool
      .intercept({
        path: '/app/installations?per_page=100&page=1',
        method: 'GET',
      })
      .reply(200, [
        { id: 10, account: { login: 'acme' } },
        { id: 20, account: { login: 'other-org' } },
      ])
      .persist();
    interceptAccessTokenExchange(10, {
      token: 'ghs_acme',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    interceptAccessTokenExchange(20, {
      token: 'ghs_other',
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const acme1 = await getInstallationToken({ org: 'acme' });
    const acme2 = await getInstallationToken({ org: 'acme' });
    const other = await getInstallationToken({ org: 'other-org' });

    expect(acme1).toBe('ghs_acme');
    expect(acme2).toBe('ghs_acme');
    expect(other).toBe('ghs_other');
    // Only ONE access-token exchange was registered per owner above; a
    // second exchange call for the same owner would throw (net connect
    // disabled), so reaching here proves per-owner caching held while still
    // fetching a fresh token for the second, distinct owner.
  });

  it('throws when the secret has no SecretString', async () => {
    process.env.GH_AUTH_KIND = 'pat';
    process.env.GH_PAT_SECRET_ARN =
      'arn:aws:secretsmanager:us-east-1:1:secret:pat';
    smMock.on(GetSecretValueCommand).resolves({});

    await expect(getInstallationToken({ org: 'acme' })).rejects.toThrow(
      /no SecretString/,
    );
  });

  it('throws when KMS Sign returns no Signature', async () => {
    process.env.GH_AUTH_KIND = 'app';
    process.env.GH_APP_ID = '1';
    process.env.GH_KEY_KMS_ARN = 'arn:aws:kms:us-east-1:1:key/abc';
    kmsMock.on(SignCommand).resolves({});

    await expect(getInstallationToken({ org: 'acme' })).rejects.toThrow(
      /no Signature/,
    );
  });
});

describe('generateJitConfig', () => {
  it('POSTs to the org generate-jitconfig endpoint with name/labels/runner_group_id and returns the blob', async () => {
    setPatEnv();
    let capturedBody: unknown;
    pool
      .intercept({
        path: '/orgs/acme/actions/runners/generate-jitconfig',
        method: 'POST',
        body: (body) => {
          capturedBody = JSON.parse(body);
          return true;
        },
      })
      .reply(201, { encoded_jit_config: 'BLOB' });

    const target: ScopeTarget = { org: 'acme' };
    const result = await generateJitConfig({
      target,
      runnerName: 'runner-1',
      labels: ['self-hosted', 'microvm'],
    });

    expect(result).toBe('BLOB');
    expect(capturedBody).toEqual({
      name: 'runner-1',
      runner_group_id: 1,
      labels: ['self-hosted', 'microvm'],
    });
  });

  it('POSTs to the repo generate-jitconfig endpoint for an owner/repo target', async () => {
    setPatEnv();
    pool
      .intercept({
        path: '/repos/acme/widgets/actions/runners/generate-jitconfig',
        method: 'POST',
      })
      .reply(201, { encoded_jit_config: 'REPO_BLOB' });

    const target: ScopeTarget = { owner: 'acme', repo: 'widgets' };
    const result = await generateJitConfig({
      target,
      runnerName: 'runner-2',
      labels: ['self-hosted'],
    });

    expect(result).toBe('REPO_BLOB');
  });
});

describe('listRunners', () => {
  it('paginates through 2 pages (per_page=100) and concatenates results', async () => {
    setPatEnv();

    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `runner-${i}`,
      busy: false,
      status: 'online',
    }));
    const page2 = [
      { id: 100, name: 'runner-100', busy: true, status: 'online' },
    ];

    pool
      .intercept({
        path: '/orgs/acme/actions/runners?per_page=100&page=1',
        method: 'GET',
      })
      .reply(200, { total_count: 101, runners: page1 });
    pool
      .intercept({
        path: '/orgs/acme/actions/runners?per_page=100&page=2',
        method: 'GET',
      })
      .reply(200, { total_count: 101, runners: page2 });

    const result = await listRunners({ org: 'acme' });
    expect(result).toHaveLength(101);
    expect(result[0]).toEqual({
      id: 0,
      name: 'runner-0',
      busy: false,
      status: 'online',
    });
    expect(result[100]).toEqual({
      id: 100,
      name: 'runner-100',
      busy: true,
      status: 'online',
    });
  });
});

describe('getRunner', () => {
  it('returns the runner when found', async () => {
    setPatEnv();
    pool
      .intercept({
        path: '/repos/acme/widgets/actions/runners/42',
        method: 'GET',
      })
      .reply(200, { id: 42, name: 'runner-42', busy: false, status: 'online' });

    const runner = await getRunner({ owner: 'acme', repo: 'widgets' }, 42);
    expect(runner).toEqual({
      id: 42,
      name: 'runner-42',
      busy: false,
      status: 'online',
    });
  });

  it('returns undefined on 404', async () => {
    setPatEnv();
    pool
      .intercept({ path: '/orgs/acme/actions/runners/999', method: 'GET' })
      .reply(404, { message: 'Not Found' });

    const runner = await getRunner({ org: 'acme' }, 999);
    expect(runner).toBeUndefined();
  });

  it('throws on a non-404 error status', async () => {
    setPatEnv();
    pool
      .intercept({ path: '/orgs/acme/actions/runners/500', method: 'GET' })
      .reply(500, { message: 'boom' });

    await expect(getRunner({ org: 'acme' }, 500)).rejects.toThrow();
  });
});

describe('deleteRunner', () => {
  it('resolves on 204 success', async () => {
    setPatEnv();
    pool
      .intercept({ path: '/orgs/acme/actions/runners/1', method: 'DELETE' })
      .reply(204, '');

    await expect(deleteRunner({ org: 'acme' }, 1)).resolves.toBeUndefined();
  });

  it('treats 404 (already gone) as success, does not throw', async () => {
    setPatEnv();
    pool
      .intercept({ path: '/orgs/acme/actions/runners/2', method: 'DELETE' })
      .reply(404, { message: 'Not Found' });

    await expect(deleteRunner({ org: 'acme' }, 2)).resolves.toBeUndefined();
  });

  it('throws on a non-404 error status', async () => {
    setPatEnv();
    pool
      .intercept({ path: '/orgs/acme/actions/runners/3', method: 'DELETE' })
      .reply(500, { message: 'boom' });

    await expect(deleteRunner({ org: 'acme' }, 3)).rejects.toThrow();
  });
});

describe('rate-limit hygiene', () => {
  function interceptRunnersPage1(): ReturnType<typeof pool.intercept> {
    return pool.intercept({
      path: '/orgs/acme/actions/runners?per_page=100&page=1',
      method: 'GET',
    });
  }

  it('throws RetryableError on 403 with x-ratelimit-remaining: 0', async () => {
    setPatEnv();
    interceptRunnersPage1().reply(
      403,
      { message: 'rate limited' },
      { headers: { 'x-ratelimit-remaining': '0' } },
    );

    await expect(listRunners({ org: 'acme' })).rejects.toBeInstanceOf(
      RetryableError,
    );
  });

  it('throws RetryableError on 429 with a retry-after header', async () => {
    setPatEnv();
    interceptRunnersPage1().reply(
      429,
      { message: 'secondary rate limit' },
      { headers: { 'retry-after': '30' } },
    );

    await expect(listRunners({ org: 'acme' })).rejects.toBeInstanceOf(
      RetryableError,
    );
  });
});
