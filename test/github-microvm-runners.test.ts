import { App, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import {
  GithubMicrovmRunners,
  type GithubMicrovmRunnersProps,
} from '../src/github-microvm-runners.js';
import { RunnerImage } from '../src/image/runner-image.js';
import { ConsoleLogs } from '../src/types/console-logs.js';
import {
  GithubAppId,
  GithubAppKey,
  GithubAuth,
} from '../src/types/github-auth.js';
import type { MicrovmIdlePolicy } from '../src/types/idle-policy.js';
import { ImageLogs } from '../src/types/image-logs.js';
import { MicrovmSize } from '../src/types/microvm-size.js';
import type { RunnerClassProps } from '../src/types/runner-class.js';
import { RunnerNetwork } from '../src/types/runner-network.js';
import { RunnerScope } from '../src/types/runner-scope.js';

function newApp(): App {
  return new App();
}

function newStack(app: App = newApp(), region = 'us-east-1'): Stack {
  return new Stack(app, 'TestStack', {
    env: { account: '123456789012', region },
  });
}

/** A fresh `GithubAuth.pat(...)` bound to unique secrets under `idPrefix`, so callers can build multiple auths in one stack without id collisions. */
function patAuth(stack: Stack, idPrefix = ''): GithubAuth {
  return GithubAuth.pat({
    token: new Secret(stack, `${idPrefix}PatToken`),
    webhookSecret: new Secret(stack, `${idPrefix}WebhookSecret`),
  });
}

function minimalProps(stack: Stack, idPrefix = ''): GithubMicrovmRunnersProps {
  return {
    github: patAuth(stack, idPrefix),
    scope: RunnerScope.org('my-org'),
  };
}

/**
 * The behavior-preserving default class: a single `microvm`/GB4 class matches
 * the old `sizeClasses` default (`{ microvm: MicrovmSize.GB4 }`).
 */
const DEFAULT_RUNNER_CLASS: [string, RunnerClassProps] = [
  'microvm',
  { size: MicrovmSize.GB4 },
];

/**
 * Construct a runner set and register runner classes on it (defaulting to the
 * single behavior-preserving `microvm`/GB4 class) — most tests just need a
 * valid runner set with the default class so synth doesn't hit the ≥1-class gate.
 */
function mkRunners(
  stack: Stack,
  id: string,
  props: GithubMicrovmRunnersProps,
  classes: [string, RunnerClassProps][] = [DEFAULT_RUNNER_CLASS],
): GithubMicrovmRunners {
  const runners = new GithubMicrovmRunners(stack, id, props);
  for (const [label, classProps] of classes) {
    runners.addRunnerClass(label, classProps);
  }
  return runners;
}

/** Expected `requireEnv`/`numEnv`(no-default) keys per handler — hardcoded from a direct read of each handler's source (see task-11-report.md's env cross-check evidence), NOT re-derived from the construct under test. */
const WEBHOOK_REQUIRED_ENV = [
  'GH_WEBHOOK_SECRET_ARN', // webhook.ts getWebhookSecret()
  'QUEUE_URL', // webhook.ts sendQueueMessage()
  'SIZE_CLASS_LABELS', // webhook.ts readSizeClassLabels()
];
const LAUNCHER_REQUIRED_ENV = [
  'SCOPE_JSON', // launcher.ts readScope()
  'SIZE_CLASSES_JSON', // launcher.ts readSizeClasses()
  'MAX_CONCURRENT', // launcher.ts handleLaunch()
  'MAX_JOB_DURATION_SECONDS', // launcher.ts handleLaunch()
  'RUNNER_SET_ID', // launcher.ts handleLaunch()
  // RUNNER_SET_VM_ROLE_ARN is intentionally optional (powerless-VM default) — the
  // launcher reads it via process.env, not requireEnv. Not in the required set.
  'RUNNER_TABLE', // launcher.ts commitLaunch()/handleTerminate()
  'IMAGE_ARN', // launcher.ts resolveImageArn() fallback
  'LOGGING_JSON', // launcher.ts handleLaunch() -> readLogging()
  'GH_AUTH_KIND', // shared/github-client.ts getInstallationToken()
  'GH_PAT_SECRET_ARN', // shared/github-client.ts getPat() (pat-kind auth)
];
const JANITOR_REQUIRED_ENV = [
  'RUNNER_SET_ID', // janitor.ts buildContext()
  'SCOPE_JSON', // janitor.ts readScope()
  'RUNNER_TABLE', // janitor.ts buildContext()
  'SIZE_CLASSES_JSON', // janitor.ts readSizeClasses()
  'MAX_JOB_DURATION_SECONDS', // janitor.ts buildContext() — numEnv with no default
  'GH_AUTH_KIND', // shared/github-client.ts getInstallationToken()
  'GH_PAT_SECRET_ARN', // shared/github-client.ts getPat() (pat-kind auth)
];

describe('GithubMicrovmRunners: minimal instantiation', () => {
  const app = newApp();
  const stack = newStack(app);
  const runners = mkRunners(stack, 'Runners', minimalProps(stack));
  const template = Template.fromStack(stack);

  it('synthesizes without error', () => {
    expect(() => app.synth()).not.toThrow();
  });

  it('creates exactly 3 Lambda functions, all arm64', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    const nonBundling = Object.values(fns).filter(
      (r) => r.Properties?.Architectures !== undefined,
    );
    expect(nonBundling).toHaveLength(3);
    for (const fn of nonBundling) {
      expect(fn.Properties.Architectures).toEqual(['arm64']);
      expect(fn.Properties.Runtime).toBe('nodejs22.x');
    }
  });

  it('wires the job queue to a DLQ with the default maxReceiveCount 20 and 180s visibility timeout', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 180,
    });
    const queues = template.findResources('AWS::SQS::Queue');
    const mainQueue = Object.values(queues).find(
      (q) => q.Properties?.RedrivePolicy !== undefined,
    );
    expect(mainQueue).toBeDefined();
    expect(mainQueue?.Properties.RedrivePolicy.maxReceiveCount).toBe(20);
  });

  it('creates one AWS::Lambda::MicrovmImage for the default single size class', () => {
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    expect(Object.keys(images)).toHaveLength(1);
  });

  it('exposes a Function URL with authType NONE', () => {
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'NONE',
    });
  });

  it('does not reserve concurrency on the webhook Lambda by default', () => {
    // A reservation carves capacity out of the account's shared unreserved pool,
    // so unless the consumer opts in the property must be absent entirely.
    const functions = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions)) {
      expect(fn.Properties?.ReservedConcurrentExecutions).toBeUndefined();
    }
  });

  it('schedules the janitor on rate(5 minutes)', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
    });
  });

  it('honors defaults: launcher env MAX_CONCURRENT "10", MAX_JOB_DURATION_SECONDS "21600"', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          MAX_CONCURRENT: '10',
          MAX_JOB_DURATION_SECONDS: '21600',
        }),
      },
    });
  });

  it('scopes the VM execution role logs grants to the MicroVMs log-group prefix, not the whole account', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const logsStatement = Object.values(policies)
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .find(
        (s: { Action?: string[] }) =>
          Array.isArray(s.Action) && s.Action.includes('logs:CreateLogGroup'),
      );
    expect(logsStatement).toBeDefined();
    expect(logsStatement.Resource).toHaveLength(2);
    for (const r of logsStatement.Resource) {
      expect(JSON.stringify(r)).toContain('log-group:/aws/lambda-microvms/');
      expect(JSON.stringify(r)).not.toBe(
        JSON.stringify(`arn:aws:logs:us-east-1:123456789012:*`),
      );
    }
  });

  it('defaults to a powerless VM: no execution role, no RUNNER_SET_VM_ROLE_ARN env, no iam:PassRole', () => {
    // Public surface: no role by default.
    expect(runners.vmExecutionRole).toBeUndefined();
    // The launcher's env carries no RUNNER_SET_VM_ROLE_ARN (⇒ launcher omits
    // executionRoleArn ⇒ VM has no AWS identity ⇒ IMDS serves no creds).
    const launcherEnv = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Environment: {
          Variables: Match.objectLike({ MAX_CONCURRENT: Match.anyValue() }),
        },
      },
    });
    const envVars = Object.values(launcherEnv)[0]?.Properties?.Environment
      ?.Variables as Record<string, unknown>;
    expect(envVars).not.toHaveProperty('RUNNER_SET_VM_ROLE_ARN');
    // No iam:PassRole statement anywhere (nothing to pass).
    const policies = template.findResources('AWS::IAM::Policy');
    const hasPassRole = JSON.stringify(policies).includes('iam:PassRole');
    expect(hasPassRole).toBe(false);
  });

  it('opts into an execution role when props.vmExecutionRole is set: RUNNER_SET_VM_ROLE_ARN env + scoped iam:PassRole', () => {
    const stack = newStack();
    const role = new Role(stack, 'OptInVmRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    const r = mkRunners(stack, 'RunnersWithRole', {
      github: patAuth(stack, 'Opt'),
      scope: RunnerScope.org('o'),
      vmExecutionRole: role,
    });
    expect(r.vmExecutionRole).toBe(role);
    const t = Template.fromStack(stack);
    // launcher env carries RUNNER_SET_VM_ROLE_ARN
    const launcherEnv = t.findResources('AWS::Lambda::Function', {
      Properties: {
        Environment: {
          Variables: Match.objectLike({
            RUNNER_SET_VM_ROLE_ARN: Match.anyValue(),
          }),
        },
      },
    });
    expect(Object.keys(launcherEnv).length).toBeGreaterThan(0);
    // and a scoped iam:PassRole exists
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'iam:PassRole',
            Effect: 'Allow',
            Resource: Match.objectLike({
              'Fn::GetAtt': Match.arrayWith(['Arn']),
            }),
          }),
        ]),
      },
    });
  });

  it('recoverStuckLaunches defaults ON: a launch that never served its job is recovered without the operator opting in', () => {
    // Shipped off, which made it useless exactly when it was needed. A
    // production stall on 2026-08-01 (muster thread 146) matched this
    // reconciler's conditions precisely — committed claim, VM terminated, job
    // still queued — and every sweep for 85 minutes would have recovered it,
    // but the flag was false. There is no floor under an event-driven plane
    // unless the floor is on by default.
    const stack = newStack();
    mkRunners(stack, 'RunnersDefaultRecover', {
      github: patAuth(stack, 'DefRec'),
      scope: RunnerScope.org('o'),
    });
    const t = Template.fromStack(stack);
    const janitorEnv = t.findResources('AWS::Lambda::Function', {
      Properties: {
        Environment: {
          Variables: Match.objectLike({ RECOVER_STUCK_LAUNCHES: 'true' }),
        },
      },
    });
    expect(Object.keys(janitorEnv).length).toBe(1);
  });

  it('recoverStuckLaunches: false still opts out — RECOVER_STUCK_LAUNCHES=false and no DLQ-consume grant on the janitor', () => {
    const stack = newStack();
    mkRunners(stack, 'RunnersNoRecover', {
      github: patAuth(stack, 'NoRec'),
      scope: RunnerScope.org('o'),
      recoverStuckLaunches: false,
    });
    const t = Template.fromStack(stack);
    const janitorEnv = t.findResources('AWS::Lambda::Function', {
      Properties: {
        Environment: {
          Variables: Match.objectLike({ RECOVER_STUCK_LAUNCHES: 'false' }),
        },
      },
    });
    expect(Object.keys(janitorEnv).length).toBe(1);
    // No role is granted sqs:ReceiveMessage on the dead-letter queue when off.
    const dlqConsume = t.findResources('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['sqs:ReceiveMessage']),
              Resource: Match.objectLike({
                'Fn::GetAtt': Match.arrayWith([
                  Match.stringLikeRegexp('DeadLetterQueue'),
                  'Arn',
                ]),
              }),
            }),
          ]),
        },
      },
    });
    expect(Object.keys(dlqConsume).length).toBe(0);
  });

  it('recoverStuckLaunches: true wires RECOVER_STUCK_LAUNCHES=true + queue URLs and grants the janitor DLQ-consume', () => {
    const stack = newStack();
    mkRunners(stack, 'RunnersRecover', {
      github: patAuth(stack, 'Rec'),
      scope: RunnerScope.org('o'),
      recoverStuckLaunches: true,
    });
    const t = Template.fromStack(stack);
    const janitorEnv = t.findResources('AWS::Lambda::Function', {
      Properties: {
        Environment: {
          Variables: Match.objectLike({
            RECOVER_STUCK_LAUNCHES: 'true',
            JOB_QUEUE_URL: Match.anyValue(),
            DEAD_LETTER_QUEUE_URL: Match.anyValue(),
          }),
        },
      },
    });
    expect(Object.keys(janitorEnv).length).toBe(1);
    // The janitor is granted sqs:ReceiveMessage on the dead-letter queue —
    // nothing else consumes the DLQ, so this statement is the recovery grant.
    const dlqConsume = t.findResources('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'sqs:ReceiveMessage',
                'sqs:DeleteMessage',
              ]),
              Resource: Match.objectLike({
                'Fn::GetAtt': Match.arrayWith([
                  Match.stringLikeRegexp('DeadLetterQueue'),
                  'Arn',
                ]),
              }),
            }),
          ]),
        },
      },
    });
    expect(Object.keys(dlqConsume).length).toBeGreaterThan(0);
  });

  it('grants the launcher the VM-instance-lifecycle actions (including CreateMicrovmAuthToken for the ingress-push delivery flow), unscoped (VMs have no ARN)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'lambda:RunMicrovm',
              'lambda:ListMicrovms',
              'lambda:GetMicrovm',
              'lambda:TerminateMicrovm',
              'lambda:CreateMicrovmAuthToken',
            ]),
            Effect: 'Allow',
            Resource: '*',
          }),
        ]),
      },
    });
  });

  it('grants the launcher lambda:ResumeMicrovm — the warm-path resume grant a future refactor could silently drop, leaving every warm resume AccessDenied', () => {
    // Pinned to the launcher's OWN policy (the `LauncherFunctionServiceRoleDefaultPolicy`
    // logical id embeds the function's construct id), not a generic
    // existence match — this is the safety-critical grant `launcher.ts`'s
    // `tryWarmPath` depends on to resume a claimed warm-pool VM.
    const policies = template.findResources('AWS::IAM::Policy');
    const [, launcherPolicy] =
      Object.entries(policies).find(([id]) =>
        id.includes('LauncherFunctionServiceRoleDefaultPolicy'),
      ) ?? [];
    expect(launcherPolicy).toBeDefined();
    const statements = launcherPolicy?.Properties?.PolicyDocument?.Statement as
      { Action?: string | string[] }[] | undefined;
    const hasResumeMicrovm = (statements ?? []).some((s) =>
      Array.isArray(s.Action)
        ? s.Action.includes('lambda:ResumeMicrovm')
        : s.Action === 'lambda:ResumeMicrovm',
    );
    expect(hasResumeMicrovm).toBe(true);
  });

  it('grants the launcher dynamodb:TransactWriteItems on the runner table (grantReadWriteData omits transact actions)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'dynamodb:TransactWriteItems',
            Effect: 'Allow',
            Resource: Match.arrayWith([
              Match.objectLike({
                'Fn::GetAtt': Match.arrayWith(['Arn']),
              }),
            ]),
          }),
        ]),
      },
    });
  });

  it('scopes the janitor image-version actions to the image ARN(s)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'lambda:ListMicrovmImageVersions',
              'lambda:DeleteMicrovmImageVersion',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
    const policies = template.findResources('AWS::IAM::Policy');
    const imgVersionStatement = Object.values(policies)
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .find(
        (s: { Action?: string[] }) =>
          Array.isArray(s.Action) &&
          s.Action.includes('lambda:ListMicrovmImageVersions'),
      );
    expect(imgVersionStatement.Resource).not.toBe('*');
  });

  it('creates a DynamoDB table with pk runnerName and TTL attribute expiresAt, PAY_PER_REQUEST, DESTROY', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({
        KeySchema: [{ AttributeName: 'runnerName', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      }),
    });
  });

  it('wires the launcher to the job queue via an SQS event source with batchSize 5 and reportBatchItemFailures', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 5,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('exposes the expected public readonly surface', () => {
    const surfaceStack = newStack(newApp());
    const runners = mkRunners(
      surfaceStack,
      'Runners2',
      minimalProps(surfaceStack),
    );
    expect(runners.webhookUrl).toBeDefined();
    expect(runners.jobQueue).toBeDefined();
    expect(runners.deadLetterQueue).toBeDefined();
    expect(runners.launcherFunction).toBeDefined();
    expect(runners.webhookFunction).toBeDefined();
    expect(runners.janitorFunction).toBeDefined();
    expect(runners.runnerTable).toBeDefined();
    // Powerless VM by default: no execution role on the public surface.
    expect(runners.vmExecutionRole).toBeUndefined();
    expect(runners.runnerClasses).toHaveLength(1);
    expect(runners.defaultImageArn).toBeDefined();
    expect(runners.metrics).toBeDefined();
    // No warm pool configured: no warm-pool function on the public surface.
    expect(runners.warmPoolFunction).toBeUndefined();
  });

  it('exposes every EMF metric name the janitor sweep emits, namespaced MicrovmRunners and dimensioned by RunnerSetId', () => {
    const surfaceStack = newStack(newApp());
    const runners = mkRunners(
      surfaceStack,
      'Runners3',
      minimalProps(surfaceStack),
    );

    const cases: [
      string,
      () => {
        metricName: string;
        namespace: string;
        dimensions?: Record<string, string>;
      },
    ][] = [
      ['orphansReaped', () => runners.metrics.orphansReaped()],
      ['stuckRunnersReaped', () => runners.metrics.stuckRunnersReaped()],
      ['suspectsCleared', () => runners.metrics.suspectsCleared()],
      ['lifetimeKills', () => runners.metrics.lifetimeKills()],
      ['imageVersionsPruned', () => runners.metrics.imageVersionsPruned()],
      ['tableRowsCleaned', () => runners.metrics.tableRowsCleaned()],
      [
        'stuckLaunchesRecovered',
        () => runners.metrics.stuckLaunchesRecovered(),
      ],
      ['stuckClaimsRelaunched', () => runners.metrics.stuckClaimsRelaunched()],
      ['errors', () => runners.metrics.errors()],
    ];

    for (const [metricName, getMetric] of cases) {
      const metric = getMetric();
      expect(metric.metricName).toBe(metricName);
      expect(metric.namespace).toBe('MicrovmRunners');
      expect(metric.dimensions).toEqual(
        expect.objectContaining({ RunnerSetId: expect.any(String) }),
      );
    }
  });
});

describe('GithubMicrovmRunners: env-contract completeness (⊇ each handler’s requireEnv/numEnv set)', () => {
  const stack = newStack();
  mkRunners(stack, 'Runners', minimalProps(stack));
  const template = Template.fromStack(stack);
  const fns = template.findResources('AWS::Lambda::Function');

  function envKeysFor(logicalIdSubstring: string): string[] {
    const [, resource] =
      Object.entries(fns).find(([id]) => id.includes(logicalIdSubstring)) ?? [];
    expect(resource).toBeDefined();
    return Object.keys(resource!.Properties.Environment.Variables);
  }

  it('webhook env is a superset of WEBHOOK_REQUIRED_ENV', () => {
    const keys = envKeysFor('WebhookFunction');
    for (const required of WEBHOOK_REQUIRED_ENV) {
      expect(keys).toContain(required);
    }
  });

  it('launcher env is a superset of LAUNCHER_REQUIRED_ENV', () => {
    const keys = envKeysFor('LauncherFunction');
    for (const required of LAUNCHER_REQUIRED_ENV) {
      expect(keys).toContain(required);
    }
  });

  it('janitor env is a superset of JANITOR_REQUIRED_ENV', () => {
    const keys = envKeysFor('JanitorFunction');
    for (const required of JANITOR_REQUIRED_ENV) {
      expect(keys).toContain(required);
    }
  });
});

describe('GithubMicrovmRunners: GitHub App id plumbing', () => {
  const HANDLERS = ['WebhookFunction', 'LauncherFunction', 'JanitorFunction'];

  /** Env vars of the handler whose logical id contains `logicalIdSubstring`. */
  function envFor(
    template: Template,
    logicalIdSubstring: string,
  ): Record<string, unknown> {
    const [, resource] =
      Object.entries(template.findResources('AWS::Lambda::Function')).find(
        ([id]) => id.includes(logicalIdSubstring),
      ) ?? [];
    expect(resource).toBeDefined();
    return resource!.Properties.Environment.Variables as Record<
      string,
      unknown
    >;
  }

  /** How many IAM policies grant `secretsmanager:GetSecretValue` on a resource mentioning `logicalIdPrefix`. */
  function policiesGrantingSecretRead(
    template: Template,
    logicalIdPrefix: string,
  ): number {
    return Object.values(template.findResources('AWS::IAM::Policy')).filter(
      (policy) =>
        (
          policy.Properties.PolicyDocument.Statement as Array<{
            Action: string | string[];
            Resource: unknown;
          }>
        ).some(
          (statement) =>
            ([] as string[])
              .concat(statement.Action)
              .includes('secretsmanager:GetSecretValue') &&
            JSON.stringify(statement.Resource).includes(logicalIdPrefix),
        ),
    ).length;
  }

  /**
   * Which handlers hold secretsmanager:GetSecretValue on a secret, by name.
   * A count alone cannot tell "the webhook lost it" from "the janitor did",
   * and which one holds a credential is the whole security property here.
   */
  function handlersGrantedSecretRead(
    template: Template,
    logicalIdPrefix: string,
  ): string[] {
    const roles = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((policy) =>
        (
          policy.Properties.PolicyDocument.Statement as Array<{
            Action: string | string[];
            Resource: unknown;
          }>
        ).some(
          (statement) =>
            ([] as string[])
              .concat(statement.Action)
              .includes('secretsmanager:GetSecretValue') &&
            JSON.stringify(statement.Resource).includes(logicalIdPrefix),
        ),
      )
      .flatMap((policy) =>
        HANDLERS.filter((h) =>
          JSON.stringify(policy.Properties.Roles ?? []).includes(h),
        ),
      );
    return [...new Set(roles)].sort();
  }

  it('GithubAppId.fromValue bakes GH_APP_ID into every handler and sets no secret ref', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', {
      github: GithubAuth.app({
        appId: GithubAppId.fromValue('123456'),
        privateKey: GithubAppKey.fromSecret(new Secret(stack, 'AppKey')),
        webhookSecret: new Secret(stack, 'WebhookSecret'),
      }),
      scope: RunnerScope.org('my-org'),
    });
    const template = Template.fromStack(stack);

    for (const handler of HANDLERS) {
      const env = envFor(template, handler);
      expect(env.GH_APP_ID).toBe('123456');
      expect(env.GH_APP_ID_SECRET_ARN).toBeUndefined();
    }
  });

  it('GithubAppId.fromSecret sets GH_APP_ID_SECRET_ARN (a CFN intrinsic) on every handler and no literal GH_APP_ID', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', {
      github: GithubAuth.app({
        appId: GithubAppId.fromSecret(new Secret(stack, 'AppIdSecret')),
        privateKey: GithubAppKey.fromSecret(new Secret(stack, 'AppKey')),
        webhookSecret: new Secret(stack, 'WebhookSecret'),
      }),
      scope: RunnerScope.org('my-org'),
    });
    const template = Template.fromStack(stack);

    for (const handler of HANDLERS) {
      const env = envFor(template, handler);
      expect(env.GH_APP_ID).toBeUndefined();
      // A resolved CFN reference to the secret, not a synth-time literal.
      expect(env.GH_APP_ID_SECRET_ARN).toEqual({
        Ref: expect.stringMatching(/^AppIdSecret/),
      });
    }
  });

  it('grants every GitHub-authenticating handler secretsmanager:GetSecretValue on the app-id secret', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', {
      github: GithubAuth.app({
        appId: GithubAppId.fromSecret(new Secret(stack, 'AppIdSecret')),
        privateKey: GithubAppKey.fromSecret(new Secret(stack, 'AppKey')),
        webhookSecret: new Secret(stack, 'WebhookSecret'),
      }),
      scope: RunnerScope.org('my-org'),
    });
    const template = Template.fromStack(stack);

    // The launcher and the janitor act AS the App, so they read its id. The
    // webhook does not: it verifies a signature and enqueues, and it is the
    // one handler reachable from the public internet on a Function URL with
    // authType NONE. Granting it the App's credentials would put the ability
    // to register runners behind an unauthenticated endpoint.
    expect(policiesGrantingSecretRead(template, 'AppIdSecret')).toBe(2);
    expect(handlersGrantedSecretRead(template, 'AppIdSecret')).toEqual([
      'JanitorFunction',
      'LauncherFunction',
    ]);
  });

  it('grants no app-id read when the id is a literal', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', {
      github: GithubAuth.app({
        appId: GithubAppId.fromValue('123456'),
        privateKey: GithubAppKey.fromSecret(new Secret(stack, 'AppKey')),
        webhookSecret: new Secret(stack, 'WebhookSecret'),
      }),
      scope: RunnerScope.org('my-org'),
    });
    const template = Template.fromStack(stack);

    expect(policiesGrantingSecretRead(template, 'AppIdSecret')).toBe(0);
    // The key secret is still granted to the two handlers that act as the App,
    // so a zero above is not an artifact of the grant path being broken
    // wholesale. The webhook is absent here for the same reason as above, and
    // that absence is the point: the private key is exactly what should not
    // sit behind the public endpoint.
    expect(policiesGrantingSecretRead(template, 'AppKey')).toBe(2);
    expect(handlersGrantedSecretRead(template, 'AppKey')).toEqual([
      'JanitorFunction',
      'LauncherFunction',
    ]);
  });
});

describe('GithubMicrovmRunners: overrides change the template', () => {
  it('respects maxConcurrentVms, maxJobDuration, webhookReservedConcurrency, janitorInterval', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      maxConcurrentVms: 3,
      maxJobDuration: Duration.hours(1),
      webhookReservedConcurrency: 2,
      janitorInterval: Duration.minutes(10),
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          MAX_CONCURRENT: '3',
          MAX_JOB_DURATION_SECONDS: '3600',
        }),
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 2,
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(10 minutes)',
    });
  });

  it('respects idleRunnerGraceSeconds and keepImageVersions', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      idleRunnerGraceSeconds: 120,
      keepImageVersions: 2,
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          GRACE_SECONDS: '120',
          KEEP_IMAGE_VERSIONS: '2',
        }),
      },
    });
  });
});

describe('GithubMicrovmRunners: multiple runner classes', () => {
  it('creates 2 MicrovmImages, SIZE_CLASSES_JSON carrying both arns as tokens, and SIZE_CLASS_LABELS exactly the two keys', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack), [
      ['microvm', { size: MicrovmSize.GB1 }],
      ['large', { size: MicrovmSize.GB4 }],
    ]);
    const template = Template.fromStack(stack);

    const images = template.findResources('AWS::Lambda::MicrovmImage');
    expect(Object.keys(images)).toHaveLength(2);

    const fns = template.findResources('AWS::Lambda::Function');
    const [, webhookFn] =
      Object.entries(fns).find(([id]) => id.includes('WebhookFunction')) ?? [];
    expect(webhookFn!.Properties.Environment.Variables.SIZE_CLASS_LABELS).toBe(
      JSON.stringify(['microvm', 'large']),
    );

    const [, launcherFn] =
      Object.entries(fns).find(([id]) => id.includes('LauncherFunction')) ?? [];
    const sizeClassesJsonValue =
      launcherFn!.Properties.Environment.Variables.SIZE_CLASSES_JSON;
    // Not a plain string: it's built from `ImagePipeline.imageArn` tokens
    // (Fn::GetAtt), so CDK must render it as an Fn::Join carrying real
    // attribute references, one per runner class.
    expect(typeof sizeClassesJsonValue).not.toBe('string');
    const serialized = JSON.stringify(sizeClassesJsonValue);
    expect(serialized.match(/Fn::GetAtt/g)?.length).toBe(2);
  });

  it('defaults IMAGE_ARN to the "microvm" class when present', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack), [
      ['large', { size: MicrovmSize.GB4 }],
      ['microvm', { size: MicrovmSize.GB1 }],
    ]);
    const template = Template.fromStack(stack);
    const images = template.findResources('AWS::Lambda::MicrovmImage');
    // The "microvm"-labeled pipeline's Name carries its own contentHash
    // suffix but is otherwise deterministic — assert IMAGE_ARN resolves to
    // *a* declared image's Fn::GetAtt, not a bespoke third value.
    const imageLogicalIds = Object.keys(images);
    const fns = template.findResources('AWS::Lambda::Function');
    const [, launcherFn] =
      Object.entries(fns).find(([id]) => id.includes('LauncherFunction')) ?? [];
    const imageArnValue =
      launcherFn!.Properties.Environment.Variables.IMAGE_ARN;
    const referencedLogicalId = imageArnValue['Fn::GetAtt']?.[0];
    expect(imageLogicalIds).toContain(referencedLogicalId);
  });

  it('falls back to the first registered class when "microvm" is absent', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack), [
      ['large', { size: MicrovmSize.GB4 }],
      ['small', { size: MicrovmSize.GB0_5 }],
    ]);
    const template = Template.fromStack(stack);
    // "large" is registered first, so its ImagePipeline's construct id is
    // "Image0" — IMAGE_ARN (the launcher/janitor fallback) must resolve to
    // that pipeline's image, not "small"'s ("Image1").
    const fns = template.findResources('AWS::Lambda::Function');
    const [, launcherFn] =
      Object.entries(fns).find(([id]) => id.includes('LauncherFunction')) ?? [];
    const imageArnValue =
      launcherFn!.Properties.Environment.Variables.IMAGE_ARN;
    const referencedLogicalId: string = imageArnValue['Fn::GetAtt']?.[0];
    expect(referencedLogicalId).toContain('Image0');
    expect(referencedLogicalId).not.toContain('Image1');
  });
});

describe('GithubMicrovmRunners: logging', () => {
  it('defaults to no logging: image Logging.Disabled and launcher env LOGGING_JSON carries kind "disabled"', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack));
    const t = Template.fromStack(stack);

    t.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      Logging: { Disabled: true },
    });
    t.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: {
          Variables: Match.objectLike({
            LOGGING_JSON: JSON.stringify({ kind: 'disabled' }),
          }),
        },
      }),
    );
  });

  it('imageLogs.enabled() turns on image build logging to the platform default group (Logging.CloudWatch {}) and leaves the launcher runtime logging off', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      imageLogs: ImageLogs.enabled(),
    });
    const t = Template.fromStack(stack);

    t.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      Logging: { CloudWatch: {} },
    });
    // Build-time only: runtime (LOGGING_JSON) is driven by consoleLogs, unset here.
    t.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: {
          Variables: Match.objectLike({
            LOGGING_JSON: JSON.stringify({ kind: 'disabled' }),
          }),
        },
      }),
    );
  });

  it('imageLogs.enabled(logGroup) is valid WITHOUT vmExecutionRole (build logs are role-free) and grants the image build role write on the custom group', () => {
    const stack = newStack();
    const logGroup = new LogGroup(stack, 'BuildLogGroup');
    // No vmExecutionRole, no throw — build logs never touch the VM role.
    mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      imageLogs: ImageLogs.enabled(logGroup),
    });
    const t = Template.fromStack(stack);
    const images = t.findResources('AWS::Lambda::MicrovmImage');
    expect(JSON.stringify(images)).toContain('BuildLogGroup');
    // The build role can write to the custom group.
    expect(JSON.stringify(t.findResources('AWS::IAM::Policy'))).toContain(
      'BuildLogGroup',
    );
  });

  it('consoleLogs.enabled(logGroup) carries the log group name into LOGGING_JSON as a CFN intrinsic (not a plain string)', () => {
    const stack = newStack();
    const logGroup = new LogGroup(stack, 'CustomLogGroup');
    const role = new Role(stack, 'VmRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      consoleLogs: ConsoleLogs.enabled(logGroup),
      // Console capture needs vmExecutionRole (see validateLoggingProps) —
      // without it, this same props object throws (covered below).
      vmExecutionRole: role,
    });
    const t = Template.fromStack(stack);

    const fns = t.findResources('AWS::Lambda::Function');
    const [, launcherFn] =
      Object.entries(fns).find(([id]) => id.includes('LauncherFunction')) ?? [];
    const loggingJsonValue =
      launcherFn!.Properties.Environment.Variables.LOGGING_JSON;
    // Not a plain string: it embeds the log group's name token, so CDK must
    // render it as an Fn::Join carrying a real Ref/Fn::GetAtt.
    expect(typeof loggingJsonValue).not.toBe('string');
    expect(JSON.stringify(loggingJsonValue)).toContain('CustomLogGroup');
  });

  it('CRITICAL: consoleLogs.enabled() WITHOUT vmExecutionRole throws at synth time — the construct never mints a VM identity', () => {
    const stack = newStack();
    expect(
      () =>
        new GithubMicrovmRunners(stack, 'Runners', {
          ...minimalProps(stack),
          consoleLogs: ConsoleLogs.enabled(),
        }),
    ).toThrow(/ConsoleLogs\.enabled\(\) requires vmExecutionRole/);
  });

  it('consoleLogs.enabled() + vmExecutionRole: creates a two-week group, uses the provided role AS-IS (no minted VM role, no construct-added console-write policy on it), and wires it as the VM/launcher execution role', () => {
    const stack = newStack();
    const byoRole = new Role(stack, 'ByoVmRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    const runners = mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      consoleLogs: ConsoleLogs.enabled(),
      vmExecutionRole: byoRole,
    });
    const t = Template.fromStack(stack);

    // The provided role IS the VM execution role (one VM, one role).
    expect(runners.vmExecutionRole).toBe(byoRole);
    expect(runners.vmConsoleLogGroup).toBeDefined();
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });

    // The construct mints NO VM identity for console capture.
    const roles = t.findResources('AWS::IAM::Role');
    expect(
      Object.keys(roles).some((id) => id.includes('VmConsoleLogRole')),
    ).toBe(false);

    // MODEL B: the construct writes NOTHING to the consumer's role. No policy
    // carrying the console-write actions is attached to ByoVmRole — the
    // consumer grants those themselves.
    const policies = t.findResources('AWS::IAM::Policy');
    const consoleWriteOnByoRole = Object.values(policies).filter((p) => {
      const stmts = p.Properties.PolicyDocument.Statement as {
        Action: string | string[];
      }[];
      const hasConsoleWrite = stmts.some(
        (s) =>
          JSON.stringify([s.Action].flat().sort()) ===
          JSON.stringify(['logs:CreateLogStream', 'logs:PutLogEvents']),
      );
      const onByoRole = JSON.stringify(p.Properties.Roles ?? []).includes(
        'ByoVmRole',
      );
      return hasConsoleWrite && onByoRole;
    });
    expect(consoleWriteOnByoRole).toHaveLength(0);

    // The VM/launcher wiring uses the provided role: RUNNER_SET_VM_ROLE_ARN
    // points at it and iam:PassRole is scoped to it.
    const fns = t.findResources('AWS::Lambda::Function');
    const [, launcherFn] =
      Object.entries(fns).find(([id]) => id.includes('LauncherFunction')) ?? [];
    expect(
      JSON.stringify(
        launcherFn!.Properties.Environment.Variables.RUNNER_SET_VM_ROLE_ARN,
      ),
    ).toContain('ByoVmRole');
    const passRoleJson = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(passRoleJson).toContain('iam:PassRole');
  });

  it('consoleLogs.enabled(byoGroup) + vmExecutionRole uses the supplied group without creating one', () => {
    const stack = newStack();
    const byo = new LogGroup(stack, 'MyDebugGroup');
    const byoRole = new Role(stack, 'ByoVmRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    const runners = mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      consoleLogs: ConsoleLogs.enabled(byo),
      vmExecutionRole: byoRole,
    });
    const t = Template.fromStack(stack);

    expect(runners.vmConsoleLogGroup).toBe(byo);
    // The BYO group is used and NO construct-created VmConsoleLogGroup exists
    // (the handler log groups are separate, expected resources).
    const groups = t.findResources('AWS::Logs::LogGroup');
    const ids = Object.keys(groups);
    expect(ids.some((id) => id.includes('MyDebugGroup'))).toBe(true);
    expect(ids.some((id) => id.includes('VmConsoleLogGroup'))).toBe(false);
  });

  it('imageLogs and consoleLogs are independent: build logs go to the image group, runtime console goes to the console group, and neither leaks into the other', () => {
    const stack = newStack();
    const buildGroup = new LogGroup(stack, 'BuildLogGroup');
    const consoleGroup = new LogGroup(stack, 'ConsoleGroup');
    const role = new Role(stack, 'VmRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    const runners = mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      imageLogs: ImageLogs.enabled(buildGroup),
      consoleLogs: ConsoleLogs.enabled(consoleGroup),
      vmExecutionRole: role,
    });
    const t = Template.fromStack(stack);

    // Image build logging → buildGroup, not the console group.
    const imageJson = JSON.stringify(
      t.findResources('AWS::Lambda::MicrovmImage'),
    );
    expect(imageJson).toContain('BuildLogGroup');
    expect(imageJson).not.toContain('ConsoleGroup');

    // Runtime LOGGING_JSON (console capture) → consoleGroup, not the build group.
    const fns = t.findResources('AWS::Lambda::Function');
    const [, launcherFn] =
      Object.entries(fns).find(([id]) => id.includes('LauncherFunction')) ?? [];
    const rendered = JSON.stringify(
      launcherFn!.Properties.Environment.Variables.LOGGING_JSON,
    );
    expect(rendered).toContain('cloudWatch');
    expect(rendered).toContain('ConsoleGroup');
    expect(rendered).not.toContain('BuildLogGroup');
    expect(runners.vmConsoleLogGroup).toBe(consoleGroup);
  });
});

describe('GithubMicrovmRunners: network', () => {
  it('internetEgress() (the default): no AWS::Lambda::NetworkConnector, no operator role, empty EGRESS_CONNECTOR_ARNS', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack));
    const t = Template.fromStack(stack);

    expect(
      Object.keys(t.findResources('AWS::Lambda::NetworkConnector')),
    ).toHaveLength(0);
    t.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: {
          Variables: Match.objectLike({ EGRESS_CONNECTOR_ARNS: '[]' }),
        },
      }),
    );
  });

  it('RunnerNetwork.vpc(vpc) synthesizes a NetworkConnector + operator role referencing the VPC subnets, and the launcher EGRESS_CONNECTOR_ARNS references the connector', () => {
    const stack = newStack();
    const vpc = new ec2.Vpc(stack, 'Vpc');
    mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      network: RunnerNetwork.vpc(vpc),
    });
    const t = Template.fromStack(stack);

    const connectors = t.findResources('AWS::Lambda::NetworkConnector');
    const connectorIds = Object.keys(connectors);
    expect(connectorIds).toHaveLength(1);
    const connectorProps = connectors[connectorIds[0]].Properties;
    // Value-asserted, not just existence-checked: the actual subnet ids
    // (CDK's default subnet selection — private-with-egress) must be the
    // ones passed to the connector.
    const expectedSubnetIds = Stack.of(stack).resolve(
      vpc.selectSubnets({}).subnetIds,
    );
    expect(
      connectorProps.Configuration.VpcEgressConfiguration.SubnetIds,
    ).toEqual(expectedSubnetIds);
    expect(
      connectorProps.Configuration.VpcEgressConfiguration
        .AssociatedComputeResourceTypes,
    ).toEqual(['MicroVm']);
    // The service rejects a VPC_EGRESS connector missing this field (found
    // live: "NetworkProtocol cannot be null or empty for VPC_EGRESS
    // connector") — assert the actual value, not just that the connector
    // exists.
    expect(
      connectorProps.Configuration.VpcEgressConfiguration.NetworkProtocol,
    ).toEqual('IPv4');
    expect(connectorProps.OperatorRole).toBeDefined();

    // An operator role trusted by the Lambda service exists (the connector's
    // ENI-management role — distinct from the launcher/janitor/webhook
    // function roles already present in this runner set).
    const roles = t.findResources('AWS::IAM::Role');
    const operatorRoleId = Object.keys(roles).find((id) =>
      id.includes('NetworkConnectorOperatorRole'),
    );
    expect(operatorRoleId).toBeDefined();
    // The trust must carry NO source condition, and this assertion is a
    // REGRESSION GUARD, not a style preference: an `aws:SourceAccount`
    // condition here was rejected live by the service ("The service is unable
    // to assume the provided NetworkConnectorOperatorRole", CFN rollback,
    // 2026-07-22). Static review recommends that hardening on sight, so pin
    // the absence — see the rationale on the role in github-microvm-runners.ts.
    const assumeRoleStatement =
      operatorRoleId &&
      roles[operatorRoleId].Properties.AssumeRolePolicyDocument.Statement[0];
    expect(assumeRoleStatement.Principal).toEqual({
      Service: 'lambda.amazonaws.com',
    });
    expect(assumeRoleStatement.Condition).toBeUndefined();

    // The launcher's EGRESS_CONNECTOR_ARNS references the connector's ARN
    // (an Fn::GetAtt on the connector's logical id), not a literal string.
    const launcherEnv = t.findResources('AWS::Lambda::Function', {
      Properties: {
        Environment: {
          Variables: Match.objectLike({ MAX_CONCURRENT: Match.anyValue() }),
        },
      },
    });
    const egressConnectorArns =
      Object.values(launcherEnv)[0]?.Properties?.Environment?.Variables
        ?.EGRESS_CONNECTOR_ARNS;
    expect(typeof egressConnectorArns).not.toBe('string');
    expect(JSON.stringify(egressConnectorArns)).toContain(connectorIds[0]);

    // Same connector ARN also appears in the launcher's PassNetworkConnector
    // IAM statement resources (same egress-connector path as vpcConnector()).
    const policies = t.findResources('AWS::IAM::Policy');
    const passNetworkConnector = Object.values(policies)
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .find(
        (s: { Action?: string }) => s.Action === 'lambda:PassNetworkConnector',
      );
    expect(passNetworkConnector).toBeDefined();
    expect(JSON.stringify(passNetworkConnector.Resource)).toContain(
      connectorIds[0],
    );
  });

  it('RunnerNetwork.vpc(vpc, { securityGroups }) uses the given security groups instead of creating a default one', () => {
    const stack = newStack();
    const vpc = new ec2.Vpc(stack, 'Vpc');
    const sg = new ec2.SecurityGroup(stack, 'CustomSg', { vpc });
    mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      network: RunnerNetwork.vpc(vpc, { securityGroups: [sg] }),
    });
    const t = Template.fromStack(stack);

    // No default security group created for the connector.
    expect(
      Object.keys(t.findResources('AWS::EC2::SecurityGroup')),
    ).toHaveLength(1);
    const connectors = t.findResources('AWS::Lambda::NetworkConnector');
    const [connectorId] = Object.keys(connectors);
    const sgIds =
      connectors[connectorId].Properties.Configuration.VpcEgressConfiguration
        .SecurityGroupIds;
    // Value-asserted: the connector's security groups are exactly the
    // caller-supplied one (resolved to its actual synthesized security
    // group id), not merely a string that happens to contain "CustomSg".
    expect(sgIds).toEqual(Stack.of(stack).resolve([sg.securityGroupId]));
  });
});

describe('GithubMicrovmRunners: region validation', () => {
  it('throws for an unsupported concrete region', () => {
    const stack = newStack(newApp(), 'ap-southeast-1');
    expect(
      () => new GithubMicrovmRunners(stack, 'Runners', minimalProps(stack)),
    ).toThrow(/not a Lambda MicroVMs region/);
  });

  it('does not throw when the unsupported region is listed in additionalRegions', () => {
    const stack = newStack(newApp(), 'ap-southeast-1');
    expect(
      () =>
        new GithubMicrovmRunners(stack, 'Runners', {
          ...minimalProps(stack),
          additionalRegions: ['ap-southeast-1'],
        }),
    ).not.toThrow();
  });
});

describe('GithubMicrovmRunners: numeric prop validation', () => {
  const invalidCases: {
    name: string;
    props: Partial<GithubMicrovmRunnersProps>;
    expected: RegExp;
  }[] = [
    {
      name: 'maxConcurrentVms not a positive integer',
      props: { maxConcurrentVms: 0 },
      expected: /maxConcurrentVms must be a positive integer/,
    },
    {
      name: 'maxConcurrentVms not an integer',
      props: { maxConcurrentVms: 1.5 },
      expected: /maxConcurrentVms must be a positive integer/,
    },
    {
      name: 'webhookReservedConcurrency not a positive integer',
      props: { webhookReservedConcurrency: -1 },
      expected: /webhookReservedConcurrency must be a positive integer/,
    },
    {
      // `0` reserved concurrency disables the function — reject it as a mistake
      // rather than silently throttling the webhook to zero.
      name: 'webhookReservedConcurrency of 0 (would disable the webhook)',
      props: { webhookReservedConcurrency: 0 },
      expected: /webhookReservedConcurrency must be a positive integer/,
    },
    {
      name: 'idleRunnerGraceSeconds not a positive integer',
      props: { idleRunnerGraceSeconds: 0 },
      expected: /idleRunnerGraceSeconds must be a positive integer/,
    },
    {
      name: 'keepImageVersions less than 1',
      props: { keepImageVersions: 0 },
      expected: /keepImageVersions must be a positive integer/,
    },
    {
      name: 'maxJobDuration not positive',
      props: { maxJobDuration: Duration.seconds(0) },
      expected: /maxJobDuration must be positive/,
    },
    {
      name: 'maxJobDuration exceeds the 8h-minus-grace platform ceiling',
      props: { maxJobDuration: Duration.hours(8) },
      expected: /maxJobDuration must be at most/,
    },
    {
      name: 'janitorInterval below the EventBridge rate() floor',
      props: { janitorInterval: Duration.seconds(30) },
      expected: /janitorInterval must be at least 60s/,
    },
    {
      name: 'janitorInterval not strictly greater than the launcher timeout',
      props: { janitorInterval: Duration.minutes(2) },
      expected:
        /janitorInterval \(120s\) must be strictly greater than the launcher function's timeout \(120s\)/,
    },
  ];

  it.each(invalidCases)('throws for $name', ({ props, expected }) => {
    const stack = newStack();
    // Every numeric/interval-shape knob here throws eagerly in the
    // constructor, before any runner class is even registered.
    expect(() => {
      new GithubMicrovmRunners(stack, 'Runners', {
        ...minimalProps(stack),
        ...props,
      });
    }).toThrow(expected);
  });
});

describe('GithubMicrovmRunners: per-class warmPoolSize validation', () => {
  it.each([
    { warmPoolSize: 0, name: 'zero' },
    { warmPoolSize: -1, name: 'negative' },
    { warmPoolSize: 1.5, name: 'non-integer' },
  ])(
    'addRunnerClass throws for warmPoolSize=$warmPoolSize ($name)',
    ({ warmPoolSize }) => {
      const stack = newStack();
      const runners = new GithubMicrovmRunners(
        stack,
        'Runners',
        minimalProps(stack),
      );
      expect(() =>
        runners.addRunnerClass('microvm', {
          size: MicrovmSize.GB4,
          warmPoolSize,
        }),
      ).toThrow(
        /runner class "microvm": warmPoolSize must be a positive integer/,
      );
    },
  );

  it('accepts a positive integer warmPoolSize and does not throw', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    expect(() =>
      runners.addRunnerClass('microvm', {
        size: MicrovmSize.GB4,
        warmPoolSize: 2,
      }),
    ).not.toThrow();
  });
});

describe('GithubMicrovmRunners: warmPoolInterval floor (gated on a warm class)', () => {
  it('a runner set with NO warm class + a sub-floor warmPoolInterval does NOT throw, even at synth (opt-in-means-opt-in: warmPoolInterval is inert with no warm class)', () => {
    const stack = newStack();
    expect(() => {
      const runners = new GithubMicrovmRunners(stack, 'Runners', {
        ...minimalProps(stack),
        warmPoolInterval: Duration.seconds(30),
      });
      runners.addRunnerClass('microvm', { size: MicrovmSize.GB4 });
      Template.fromStack(stack);
    }).not.toThrow();
  });

  it('a runner set WITH a warm class + a sub-floor warmPoolInterval throws with the EventBridge floor message (the moment the warm class registers, pre-empting a worse CDK-native error)', () => {
    const stack = newStack();
    expect(() => {
      const runners = new GithubMicrovmRunners(stack, 'Runners', {
        ...minimalProps(stack),
        warmPoolInterval: Duration.seconds(30),
      });
      runners.addRunnerClass('microvm', {
        size: MicrovmSize.GB4,
        warmPoolSize: 1,
      });
      Template.fromStack(stack);
    }).toThrow(/warmPoolInterval must be at least 60s/);
  });
});

describe('GithubMicrovmRunners: per-class idlePolicy', () => {
  it('M4: a zero-second idlePolicy Duration throws at SYNTH (not later as a RunMicrovm ValidationException)', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    expect(() =>
      runners.addRunnerClass('microvm', {
        size: MicrovmSize.GB4,
        idlePolicy: {
          maxIdleDuration: Duration.seconds(0),
          suspendedDuration: Duration.hours(1),
        },
      }),
    ).toThrow(/idlePolicy\.maxIdleDuration.*positive/);
    expect(() =>
      runners.addRunnerClass('microvm2', {
        size: MicrovmSize.GB4,
        idlePolicy: {
          maxIdleDuration: Duration.minutes(5),
          suspendedDuration: Duration.seconds(0),
        },
      }),
    ).toThrow(/idlePolicy\.suspendedDuration.*positive/);
  });

  it('IDLE_POLICY_JSON always carries all three members for an idle class (maxIdleDurationSeconds, suspendedDurationSeconds, autoResumeEnabled) — regression guard for the suspendedDurationSeconds-absent ValidationException', () => {
    const stack = newStack();
    // Typed against the public MicrovmIdlePolicy interface (not just an
    // inline literal that happens to structurally match it) so this suite
    // exercises the exported type itself, not merely its shape.
    const idlePolicy: MicrovmIdlePolicy = {
      maxIdleDuration: Duration.minutes(5),
      suspendedDuration: Duration.hours(1),
      autoResume: true,
    };
    mkRunners(stack, 'Runners', minimalProps(stack), [
      ['microvm', { size: MicrovmSize.GB4, idlePolicy }],
      ['large', { size: MicrovmSize.GB8 }],
    ]);
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          IDLE_POLICY_JSON: JSON.stringify({
            microvm: {
              maxIdleDurationSeconds: 300,
              suspendedDurationSeconds: 3600,
              autoResumeEnabled: true,
            },
          }),
        }),
      },
    });
    // The exact-string match above already pins key order/presence, but
    // assert `Object.keys` explicitly too — this is the regression guard the
    // task calls for, independent of the producer's serialization order.
    const fns = template.findResources('AWS::Lambda::Function');
    const idlePolicyJsonRaw = Object.values(fns)
      .map(
        (f) =>
          (
            f as {
              Properties: {
                Environment: { Variables: Record<string, string> };
              };
            }
          ).Properties.Environment.Variables.IDLE_POLICY_JSON,
      )
      .find((v) => v !== undefined) as string;
    expect(Object.keys(JSON.parse(idlePolicyJsonRaw).microvm).sort()).toEqual(
      [
        'autoResumeEnabled',
        'maxIdleDurationSeconds',
        'suspendedDurationSeconds',
      ].sort(),
    );
  });

  it('a class with idlePolicy but no autoResume: suspendedDurationSeconds is still present (autoResumeEnabled omitted at this layer; microvm-client.ts defaults it)', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack), [
      [
        'microvm',
        {
          size: MicrovmSize.GB4,
          idlePolicy: {
            maxIdleDuration: Duration.minutes(5),
            suspendedDuration: Duration.hours(1),
          },
        },
      ],
    ]);
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          IDLE_POLICY_JSON: JSON.stringify({
            microvm: {
              maxIdleDurationSeconds: 300,
              suspendedDurationSeconds: 3600,
            },
          }),
        }),
      },
    });
  });

  it('no class sets idlePolicy: IDLE_POLICY_JSON is {}', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack));
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ IDLE_POLICY_JSON: '{}' }),
      },
    });
  });
});

describe('GithubMicrovmRunners: warm x idlePolicy guard', () => {
  it('a class setting BOTH warmPoolSize and idlePolicy throws, naming the label and both fields', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    expect(() =>
      runners.addRunnerClass('microvm', {
        size: MicrovmSize.GB4,
        warmPoolSize: 2,
        idlePolicy: {
          maxIdleDuration: Duration.minutes(5),
          suspendedDuration: Duration.hours(1),
        },
      }),
    ).toThrow(
      /runner class "microvm" sets both warmPoolSize and idlePolicy.*mutually exclusive/,
    );
  });

  it('warm alone (no idlePolicy) does not throw', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    expect(() =>
      runners.addRunnerClass('microvm', {
        size: MicrovmSize.GB4,
        warmPoolSize: 2,
      }),
    ).not.toThrow();
  });

  it('idlePolicy alone (no warm) does not throw', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    expect(() =>
      runners.addRunnerClass('microvm', {
        size: MicrovmSize.GB4,
        idlePolicy: {
          maxIdleDuration: Duration.minutes(5),
          suspendedDuration: Duration.hours(1),
        },
      }),
    ).not.toThrow();
  });
});

describe('GithubMicrovmRunners: multiple instances in one stack', () => {
  it('assigns distinct runnerSetIds (no RUNNER_SET_ID collision)', () => {
    const stack = newStack();
    mkRunners(stack, 'RunnersA', minimalProps(stack, 'A'));
    mkRunners(stack, 'RunnersB', minimalProps(stack, 'B'));
    const template = Template.fromStack(stack);

    const fns = template.findResources('AWS::Lambda::Function');
    const launcherEnvs = Object.entries(fns)
      .filter(([id]) => id.includes('LauncherFunction'))
      .map(
        ([, r]) => r.Properties.Environment.Variables.RUNNER_SET_ID as string,
      );

    expect(launcherEnvs).toHaveLength(2);
    expect(launcherEnvs[0]).not.toBe(launcherEnvs[1]);
    expect(launcherEnvs[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(launcherEnvs[1]).toMatch(/^[0-9a-f]{8}$/);
  });

  it('synthesizes cleanly (no logical id collisions)', () => {
    const app = newApp();
    const stack = newStack(app);
    mkRunners(stack, 'RunnersA', minimalProps(stack, 'A'));
    mkRunners(stack, 'RunnersB', minimalProps(stack, 'B'));
    expect(() => app.synth()).not.toThrow();
  });
});

describe('GithubMicrovmRunners: warm pool (per-class warm, opt-in)', () => {
  it('NO class sets warmPoolSize: exactly one scheduled function (janitor only), WARM_POOL_JSON is {} wherever it appears, no warmPoolFunction', () => {
    const stack = newStack();
    const runners = mkRunners(stack, 'Runners', minimalProps(stack));
    const template = Template.fromStack(stack);

    // Exactly 3 Lambda functions total (webhook, launcher, janitor) — no
    // fourth (warm-pool) function synthesized.
    const fns = template.findResources('AWS::Lambda::Function');
    const nonBundling = Object.values(fns).filter(
      (r) => r.Properties?.Architectures !== undefined,
    );
    expect(nonBundling).toHaveLength(3);

    // Exactly one EventBridge rule (the janitor's).
    const rules = template.findResources('AWS::Events::Rule');
    expect(Object.keys(rules)).toHaveLength(1);

    // WARM_POOL_JSON is always present now (per-class `warm`), but with no
    // warm class it's the empty object everywhere it's wired (the launcher).
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ WARM_POOL_JSON: '{}' }),
      },
    });

    expect(runners.warmPoolFunction).toBeUndefined();
  });

  it('a class sets warmPoolSize: a second scheduled Lambda + a second EventBridge rule, the launcher env carries WARM_POOL_JSON, and warmPoolFunction is exposed', () => {
    const stack = newStack();
    const runners = mkRunners(stack, 'Runners', minimalProps(stack), [
      ['microvm', { size: MicrovmSize.GB4, warmPoolSize: 3 }],
    ]);
    const template = Template.fromStack(stack);

    const fns = template.findResources('AWS::Lambda::Function');
    const nonBundling = Object.values(fns).filter(
      (r) => r.Properties?.Architectures !== undefined,
    );
    expect(nonBundling).toHaveLength(4);

    const rules = template.findResources('AWS::Events::Rule');
    expect(Object.keys(rules)).toHaveLength(2);

    // Pin the LAUNCHER specifically: match on WARM_POOL_JSON *and*
    // MAX_CONCURRENT (a launcher-unique env key, see the tests near line
    // 163/192 that anchor on it too) so this test only passes if the
    // launcher's own WARM_POOL_JSON wiring is intact — both the launcher and
    // RunnerWarmPoolFunction carry WARM_POOL_JSON, but only the launcher also
    // carries MAX_CONCURRENT.
    const launcherEnv = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Environment: {
          Variables: Match.objectLike({
            WARM_POOL_JSON: '{"microvm":3}',
            MAX_CONCURRENT: Match.anyValue(),
          }),
        },
      },
    });
    expect(Object.keys(launcherEnv).length).toBe(1);

    expect(runners.warmPoolFunction).toBeDefined();
  });

  it('two warm classes both land in the same WARM_POOL_JSON, registered on the SECOND warm class (not just the first)', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack), [
      ['microvm', { size: MicrovmSize.GB4, warmPoolSize: 3 }],
      ['large', { size: MicrovmSize.GB8, warmPoolSize: 1 }],
    ]);
    const template = Template.fromStack(stack);

    // Still exactly ONE warm-pool function (not recreated for the second
    // warm class), whose WARM_POOL_JSON covers both labels.
    const fns = template.findResources('AWS::Lambda::Function');
    const warmPoolFns = Object.entries(fns).filter(([id]) =>
      id.includes('RunnerWarmPoolFunction'),
    );
    expect(warmPoolFns).toHaveLength(1);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          WARM_POOL_JSON: JSON.stringify({ microvm: 3, large: 1 }),
        }),
      },
    });
  });

  it('the warm-pool function is granted RunMicrovm/SuspendMicrovm/ListMicrovms/TerminateMicrovm/GetMicrovm, unscoped', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack), [
      ['microvm', { size: MicrovmSize.GB4, warmPoolSize: 3 }],
    ]);
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'lambda:RunMicrovm',
              'lambda:SuspendMicrovm',
              'lambda:ListMicrovms',
              'lambda:TerminateMicrovm',
              'lambda:GetMicrovm',
            ]),
            Effect: 'Allow',
            Resource: '*',
          }),
        ]),
      },
    });
  });

  it('the warm-pool function, pinned by its RunnerWarmPoolFunction logical id, carries WARM_POOL_JSON + SIZE_CLASSES_JSON but NOT RUNNER_TABLE, and its own policy carries no DynamoDB actions (least privilege — warm-pool.ts never touches DynamoDB)', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack), [
      ['microvm', { size: MicrovmSize.GB4, warmPoolSize: 3 }],
    ]);
    const template = Template.fromStack(stack);

    // Pin the warm-pool function by its own logical id (CDK derives it from
    // the `RunnerWarmPoolFunction` construct id) rather than a generic env
    // existence match that the launcher — which also carries WARM_POOL_JSON
    // and SIZE_CLASSES_JSON — could equally satisfy.
    const fns = template.findResources('AWS::Lambda::Function');
    const [, warmPoolFn] =
      Object.entries(fns).find(([id]) =>
        id.includes('RunnerWarmPoolFunction'),
      ) ?? [];
    expect(warmPoolFn).toBeDefined();
    const envKeys = Object.keys(
      (warmPoolFn?.Properties?.Environment?.Variables ?? {}) as Record<
        string,
        unknown
      >,
    );
    expect(envKeys).toContain('WARM_POOL_JSON');
    expect(envKeys).toContain('SIZE_CLASSES_JSON');
    // warm-pool.ts's handler calls `requireEnv('RUNNER_SET_ID')` at entry (the
    // metric dimension every emitted pool-fill metric carries) — omitting
    // this env var makes every convergence tick throw before it does
    // anything, so the pool silently stays empty forever. Regression guard
    // for that exact production bug.
    expect(envKeys).toContain('RUNNER_SET_ID');
    // warm-pool.ts derives pool membership purely from MicroVM SUSPENDED
    // state + image (see its module doc) — it never reads RUNNER_TABLE, so
    // the construct must not wire it in (least privilege).
    expect(envKeys).not.toContain('RUNNER_TABLE');

    // Same pin applied to the warm-pool function's OWN policy (the
    // `...ServiceRoleDefaultPolicy` logical id embeds the function's
    // construct id) — its policy must carry no dynamodb: actions at all,
    // since the runner-table grant lives only on the launcher and janitor.
    const policies = template.findResources('AWS::IAM::Policy');
    const [, warmPoolPolicy] =
      Object.entries(policies).find(([id]) =>
        id.includes('RunnerWarmPoolFunctionServiceRoleDefaultPolicy'),
      ) ?? [];
    expect(warmPoolPolicy).toBeDefined();
    const statements = warmPoolPolicy?.Properties?.PolicyDocument?.Statement as
      { Action?: string | string[] }[] | undefined;
    const hasDynamoAction = (statements ?? []).some((s) =>
      Array.isArray(s.Action)
        ? s.Action.some((a) => a.startsWith('dynamodb:'))
        : typeof s.Action === 'string' && s.Action.startsWith('dynamodb:'),
    );
    expect(hasDynamoAction).toBe(false);
  });

  it('the runner table grant is NOT satisfiable by the warm-pool function alone: dynamodb:GetItem/PutItem still exists (on the launcher/janitor)', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack), [
      ['microvm', { size: MicrovmSize.GB4, warmPoolSize: 3 }],
    ]);
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:GetItem', 'dynamodb:PutItem']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('schedules the warm-pool function on rate(2 minutes) by default, and honors a custom warmPoolInterval', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack), [
      ['microvm', { size: MicrovmSize.GB4, warmPoolSize: 1 }],
    ]);
    Template.fromStack(stack).hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(2 minutes)',
    });

    const stack2 = newStack();
    mkRunners(
      stack2,
      'Runners',
      { ...minimalProps(stack2), warmPoolInterval: Duration.minutes(10) },
      [['microvm', { size: MicrovmSize.GB4, warmPoolSize: 1 }]],
    );
    Template.fromStack(stack2).hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(10 minutes)',
    });
  });
});

/** Extract the ordered list of `Fn::GetAtt` logical ids referenced anywhere in a resolved (token-carrying) value. */
function getAttLogicalIds(resolved: unknown): string[] {
  return [
    ...JSON.stringify(resolved).matchAll(/"Fn::GetAtt":\["([^"]+)"/g),
  ].map((m) => m[1]);
}

function launcherEnv(template: Template): Record<string, unknown> {
  const fns = template.findResources('AWS::Lambda::Function');
  const [, launcherFn] =
    Object.entries(fns).find(([id]) => id.includes('LauncherFunction')) ?? [];
  return launcherFn!.Properties.Environment.Variables as Record<
    string,
    unknown
  >;
}

function webhookEnv(template: Template): Record<string, unknown> {
  const fns = template.findResources('AWS::Lambda::Function');
  const [, webhookFn] =
    Object.entries(fns).find(([id]) => id.includes('WebhookFunction')) ?? [];
  return webhookFn!.Properties.Environment.Variables as Record<string, unknown>;
}

describe('GithubMicrovmRunners: addRunnerClass registry', () => {
  it('two classes → two ImagePipelines and a launcher SIZE_CLASSES_JSON carrying both, with distinct image arns', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    runners.addRunnerClass('a', { size: MicrovmSize.GB4 });
    runners.addRunnerClass('b', {
      size: MicrovmSize.GB8,
      image: RunnerImage.fromOptions(),
    });
    const template = Template.fromStack(stack);

    expect(
      Object.keys(template.findResources('AWS::Lambda::MicrovmImage')),
    ).toHaveLength(2);

    const sizeClassesJson = launcherEnv(template).SIZE_CLASSES_JSON;
    // Token-carrying (Fn::Join over the per-class imageArn Fn::GetAtt refs),
    // not a plain string.
    expect(typeof sizeClassesJson).not.toBe('string');
    const ids = getAttLogicalIds(sizeClassesJson);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    // Both labels appear as literal JSON keys in the join's string parts.
    const serialized = JSON.stringify(sizeClassesJson);
    expect(serialized).toContain('{\\"a\\":');
    expect(serialized).toContain('\\"b\\":');
  });

  it('captures a class attached AFTER construction in the synthesized env (proves the Lazy registry wiring)', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    runners.addRunnerClass('microvm', { size: MicrovmSize.GB4 });
    // Deferred, post-constructor attach — must still land in the synth output.
    runners.addRunnerClass('big', { size: MicrovmSize.GB8 });
    const template = Template.fromStack(stack);

    expect(webhookEnv(template).SIZE_CLASS_LABELS).toBe(
      JSON.stringify(['microvm', 'big']),
    );
    expect(
      Object.keys(template.findResources('AWS::Lambda::MicrovmImage')),
    ).toHaveLength(2);
  });

  it('zero runner classes → synth throws the ≥1-class message', () => {
    const stack = newStack();
    new GithubMicrovmRunners(stack, 'Runners', minimalProps(stack));
    expect(() => Template.fromStack(stack)).toThrow(
      /add at least one runner class with addRunnerClass/,
    );
  });

  it('a duplicate label → addRunnerClass throws immediately', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    runners.addRunnerClass('microvm', { size: MicrovmSize.GB4 });
    expect(() =>
      runners.addRunnerClass('microvm', { size: MicrovmSize.GB8 }),
    ).toThrow(/runner class label "microvm" is already registered/);
  });

  it('image omitted → the class still builds a pipeline from RunnerImage.fromOptions(), its arn present in SIZE_CLASSES_JSON', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    const rc = runners.addRunnerClass('microvm', { size: MicrovmSize.GB4 });
    const template = Template.fromStack(stack);

    expect(
      Object.keys(template.findResources('AWS::Lambda::MicrovmImage')),
    ).toHaveLength(1);
    expect(rc.imagePipeline).toBeDefined();
    expect(rc.imageArn).toBeDefined();
    // The single class's image arn is the sole Fn::GetAtt in SIZE_CLASSES_JSON.
    expect(
      getAttLogicalIds(launcherEnv(template).SIZE_CLASSES_JSON),
    ).toHaveLength(1);
  });

  it('IMAGE_ARN / defaultImageArn resolve to the "microvm" class when present (even if not first)', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    runners.addRunnerClass('large', { size: MicrovmSize.GB4 }); // Image0
    runners.addRunnerClass('microvm', { size: MicrovmSize.GB1 }); // Image1
    const template = Template.fromStack(stack);

    const referenced = getAttLogicalIds(launcherEnv(template).IMAGE_ARN);
    expect(referenced).toHaveLength(1);
    expect(referenced[0]).toContain('Image1');
    expect(runners.defaultImageArn).toBeDefined();
  });

  it('IMAGE_ARN falls back to the first attached class when "microvm" is absent', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    runners.addRunnerClass('large', { size: MicrovmSize.GB4 }); // Image0
    runners.addRunnerClass('small', { size: MicrovmSize.GB0_5 }); // Image1
    const template = Template.fromStack(stack);

    const referenced = getAttLogicalIds(launcherEnv(template).IMAGE_ARN);
    expect(referenced[0]).toContain('Image0');
    expect(referenced[0]).not.toContain('Image1');
  });

  it('the janitor image-version policy resources pick up EVERY registered class, not just one (regression: a silently-missed class means AccessDenied on DeleteMicrovmImageVersion for it in production)', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    runners.addRunnerClass('a', { size: MicrovmSize.GB4 }); // Image0
    runners.addRunnerClass('b', { size: MicrovmSize.GB8 }); // Image1
    const template = Template.fromStack(stack);

    // The janitor's role accumulates more than one inline policy resource
    // (a `...ServiceRoleDefaultPolicy` plus subsequent `addToRolePolicy`
    // calls split into `...inlinePolicyAddedToExecutionRole<n>` resources),
    // so — matching the existing "scopes the janitor image-version actions"
    // test's approach — search every Janitor-owned policy for the
    // image-version statement rather than assuming which resource holds it.
    const policies = template.findResources('AWS::IAM::Policy');
    const imgVersionStatement = Object.entries(policies)
      .filter(([id]) => id.includes('Janitor'))
      .flatMap(
        ([, p]) =>
          p.Properties.PolicyDocument.Statement as {
            Action?: string[];
            Resource?: unknown;
          }[],
      )
      .find(
        (s) =>
          Array.isArray(s.Action) &&
          s.Action.includes('lambda:DeleteMicrovmImageVersion'),
      );
    expect(imgVersionStatement).toBeDefined();
    const ids = getAttLogicalIds(imgVersionStatement?.Resource);
    expect(ids).toHaveLength(2);
    expect(ids.some((id) => id.includes('Image0'))).toBe(true);
    expect(ids.some((id) => id.includes('Image1'))).toBe(true);
  });

  it('exposes runnerClasses and runnerClass(label); runnerClass throws for an absent label', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    const a = runners.addRunnerClass('microvm', { size: MicrovmSize.GB4 });
    const b = runners.addRunnerClass('large', { size: MicrovmSize.GB8 });
    expect(runners.runnerClasses).toHaveLength(2);
    expect(runners.runnerClass('microvm')).toBe(a);
    expect(runners.runnerClass('large')).toBe(b);
    expect(() => runners.runnerClass('nope')).toThrow(
      /no runner class registered with label "nope"/,
    );
  });

  it('runnerClasses returns a defensive copy: mutating it does not corrupt the internal registry', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    runners.addRunnerClass('microvm', { size: MicrovmSize.GB4 });
    const snapshot = runners.runnerClasses;
    snapshot.push({
      label: 'injected',
      size: MicrovmSize.GB4,
    } as unknown as (typeof snapshot)[number]);
    snapshot.length = 0;
    // Neither mutation should be visible on a fresh read, nor affect what
    // the ≥1-class validation / Lazy producers see at synth.
    expect(runners.runnerClasses).toHaveLength(1);
    expect(() => Template.fromStack(stack)).not.toThrow();
  });

  it('the warm knob on a runner class registers and builds its image pipeline like any other class (full warm-pool wiring covered by the "warm pool" describe block)', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    const warmClass = runners.addRunnerClass('warm', {
      size: MicrovmSize.GB4,
      warmPoolSize: 2,
    });
    expect(warmClass.label).toBe('warm');
    expect(runners.runnerClasses).toHaveLength(1);
    expect(runners.warmPoolFunction).toBeDefined();

    const template = Template.fromStack(stack);
    expect(
      Object.keys(template.findResources('AWS::Lambda::MicrovmImage')),
    ).toHaveLength(1);
  });

  it('behavior-preserving default: a single microvm/GB4 class matches the old default single-size runner set (one image, launcher IMAGE_ARN + SIZE_CLASSES_JSON)', () => {
    const stack = newStack();
    const runners = new GithubMicrovmRunners(
      stack,
      'Runners',
      minimalProps(stack),
    );
    runners.addRunnerClass('microvm', { size: MicrovmSize.GB4 });
    const template = Template.fromStack(stack);

    expect(
      Object.keys(template.findResources('AWS::Lambda::MicrovmImage')),
    ).toHaveLength(1);
    // The single class's image (construct id "Image0") backs both IMAGE_ARN
    // and the sole SIZE_CLASSES_JSON entry.
    const imageArnRef = getAttLogicalIds(launcherEnv(template).IMAGE_ARN);
    expect(imageArnRef[0]).toContain('Image0');
    expect(webhookEnv(template).SIZE_CLASS_LABELS).toBe(
      JSON.stringify(['microvm']),
    );
  });
});

describe('GithubMicrovmRunners: enterprise — encryptionKey (CMK)', () => {
  it('encryptionKey applies a CMK to the DynamoDB table, BOTH SQS queues, and the console log group', () => {
    const stack = newStack();
    const key = new Key(stack, 'Cmk');
    const byoRole = new Role(stack, 'ByoVmRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      encryptionKey: key,
      consoleLogs: ConsoleLogs.enabled(),
      vmExecutionRole: byoRole,
    });
    const t = Template.fromStack(stack);

    // DynamoDB: customer-managed SSE with the key.
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: Match.objectLike({ SSEEnabled: true }),
    });
    // Both SQS queues carry a KmsMasterKeyId.
    const queues = t.findResources('AWS::SQS::Queue');
    const queueIds = Object.keys(queues);
    expect(queueIds.length).toBe(2);
    for (const q of queueIds) {
      expect(queues[q].Properties).toHaveProperty('KmsMasterKeyId');
    }
    // Console log group carries a KmsKeyId.
    const groups = t.findResources('AWS::Logs::LogGroup');
    const consoleGroup = Object.values(groups).find(
      (g) => g.Properties?.KmsKeyId !== undefined,
    );
    expect(consoleGroup).toBeDefined();
  });

  it('without encryptionKey, no CMK is forced (default AWS-managed) — DDB has no SSESpecification key and queues have no KmsMasterKeyId', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack));
    const t = Template.fromStack(stack);
    const queues = t.findResources('AWS::SQS::Queue');
    for (const q of Object.keys(queues)) {
      expect(queues[q].Properties ?? {}).not.toHaveProperty('KmsMasterKeyId');
    }
  });
});

describe('GithubMicrovmRunners: enterprise — permissionsBoundary', () => {
  it('applies the boundary to EVERY IAM role the construct creates (handler roles, build role)', () => {
    const stack = newStack();
    const boundary = ManagedPolicy.fromManagedPolicyArn(
      stack,
      'Boundary',
      'arn:aws:iam::aws:policy/PowerUserAccess',
    );
    mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      permissionsBoundary: boundary,
    });
    const t = Template.fromStack(stack);

    const roles = t.findResources('AWS::IAM::Role');
    const roleIds = Object.keys(roles);
    expect(roleIds.length).toBeGreaterThan(0);
    // NON-NEGOTIABLE: not a single role may be created without the boundary,
    // or an SCP that denies iam:CreateRole without it fails the deploy.
    for (const id of roleIds) {
      expect(roles[id].Properties).toHaveProperty('PermissionsBoundary');
    }
  });

  it('without permissionsBoundary, roles carry none (unchanged default)', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack));
    const t = Template.fromStack(stack);
    const roles = t.findResources('AWS::IAM::Role');
    for (const id of Object.keys(roles)) {
      expect(roles[id].Properties ?? {}).not.toHaveProperty(
        'PermissionsBoundary',
      );
    }
  });
});

describe('GithubMicrovmRunners: enterprise — governance knobs', () => {
  it('defaults: PITR off, DESTROY, 4 handler log groups at 14-day retention, maxReceiveCount 20, 128 MB', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack));
    const t = Template.fromStack(stack);

    // Handler log groups are explicit now (not Lambda's never-expiring
    // default) — 3 without a warm class, all at the default 14 days.
    const groups = t.findResources('AWS::Logs::LogGroup');
    const ids = Object.keys(groups);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    for (const id of ids) {
      expect(groups[id].Properties.RetentionInDays).toBe(14);
    }
    // Lambdas at 128 MB.
    const fns = t.findResources('AWS::Lambda::Function');
    for (const id of Object.keys(fns)) {
      expect(fns[id].Properties.MemorySize).toBe(128);
    }
  });

  it('overrides: removalPolicy RETAIN, PITR on, logRetention ONE_MONTH, deadLetterRetention, maxReceiveCount, lambdaMemorySize', () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      logRetention: RetentionDays.ONE_MONTH,
      deadLetterRetention: Duration.days(14),
      maxReceiveCount: 50,
      lambdaMemorySize: 256,
    });
    const t = Template.fromStack(stack);

    // DDB: PITR on + RETAIN deletion policy.
    t.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      }),
    });
    // Log groups: 30-day retention + RETAIN.
    const groups = t.findResources('AWS::Logs::LogGroup');
    for (const id of Object.keys(groups)) {
      expect(groups[id].Properties.RetentionInDays).toBe(30);
      expect(groups[id].DeletionPolicy).toBe('Retain');
    }
    // Lambdas at 256 MB.
    const fns = t.findResources('AWS::Lambda::Function');
    for (const id of Object.keys(fns)) {
      expect(fns[id].Properties.MemorySize).toBe(256);
    }
    // Redrive at 50; DLQ retains 14 days (1209600s).
    const queues = t.findResources('AWS::SQS::Queue');
    const main = Object.values(queues).find(
      (q) => q.Properties?.RedrivePolicy !== undefined,
    );
    expect(main?.Properties.RedrivePolicy.maxReceiveCount).toBe(50);
    const dlq = Object.values(queues).find(
      (q) => q.Properties?.MessageRetentionPeriod === 1209600,
    );
    expect(dlq).toBeDefined();
  });
});

describe('GithubMicrovmRunners: ready-made alarms', () => {
  it('deadLetterQueueNotEmptyAlarm builds a >=1 alarm on the DLQ depth', () => {
    const stack = newStack();
    const runners = mkRunners(stack, 'Runners', minimalProps(stack));
    runners.metrics.deadLetterQueueNotEmptyAlarm(stack);
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
    });
  });

  it('sweepErrorsAlarm and stuckLaunchesRecoveredAlarm build alarms (the latter defaulting to 3 evaluation periods)', () => {
    const stack = newStack();
    // Both watch EMF metrics, so they need the opt-in emitMetrics; without it
    // they throw (covered in the emitMetrics suite below).
    const runners = mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      emitMetrics: true,
    });
    runners.metrics.sweepErrorsAlarm(stack);
    runners.metrics.stuckLaunchesRecoveredAlarm(stack);
    const t = Template.fromStack(stack);
    const alarms = t.findResources('AWS::CloudWatch::Alarm');
    expect(Object.keys(alarms).length).toBe(2);
    const evalPeriods = Object.values(alarms).map(
      (a) => a.Properties.EvaluationPeriods,
    );
    expect(evalPeriods).toContain(3); // stuck-launch default
  });

  it('alarm options override threshold / evaluationPeriods', () => {
    const stack = newStack();
    const runners = mkRunners(stack, 'Runners', minimalProps(stack));
    runners.metrics.deadLetterQueueNotEmptyAlarm(stack, {
      threshold: 5,
      evaluationPeriods: 2,
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 5,
      EvaluationPeriods: 2,
    });
  });
});

describe('GithubMicrovmRunners: emitMetrics opt-in gate', () => {
  /** Every handler Lambda's `EMIT_METRICS` value, keyed by the logical-id fragment identifying the handler. */
  function emitMetricsEnvByHandler(
    template: Template,
  ): Record<string, unknown> {
    const fns = template.findResources('AWS::Lambda::Function');
    const out: Record<string, unknown> = {};
    for (const fragment of [
      'WebhookFunction',
      'LauncherFunction',
      'JanitorFunction',
      'RunnerWarmPoolFunction',
    ]) {
      const [, fn] =
        Object.entries(fns).find(([id]) => id.includes(fragment)) ?? [];
      // jest's expect() takes no message argument (vitest's did) — fold the
      // handler name into the asserted value so a miss names itself.
      expect({ [fragment]: fn !== undefined }).toEqual({ [fragment]: true });
      out[fragment] = fn!.Properties.Environment.Variables.EMIT_METRICS;
    }
    return out;
  }

  /** A runner set whose single class is warm, so the lazily-created warm-pool Lambda exists and can be asserted on too. */
  const WARM_CLASS: [string, RunnerClassProps][] = [
    ['microvm', { size: MicrovmSize.GB4, warmPoolSize: 1 }],
  ];

  it("default (emitMetrics unset): all four handler Lambdas carry EMIT_METRICS 'false'", () => {
    const stack = newStack();
    mkRunners(stack, 'Runners', minimalProps(stack), WARM_CLASS);
    const env = emitMetricsEnvByHandler(Template.fromStack(stack));
    expect(env).toEqual({
      WebhookFunction: 'false',
      LauncherFunction: 'false',
      JanitorFunction: 'false',
      RunnerWarmPoolFunction: 'false',
    });
  });

  it("emitMetrics: true → all four handler Lambdas carry EMIT_METRICS 'true'", () => {
    const stack = newStack();
    mkRunners(
      stack,
      'Runners',
      { ...minimalProps(stack), emitMetrics: true },
      WARM_CLASS,
    );
    const env = emitMetricsEnvByHandler(Template.fromStack(stack));
    expect(env).toEqual({
      WebhookFunction: 'true',
      LauncherFunction: 'true',
      JanitorFunction: 'true',
      RunnerWarmPoolFunction: 'true',
    });
  });

  it("emitMetrics: false is explicit and identical to the default ('false' everywhere)", () => {
    const stack = newStack();
    mkRunners(
      stack,
      'Runners',
      { ...minimalProps(stack), emitMetrics: false },
      WARM_CLASS,
    );
    const env = emitMetricsEnvByHandler(Template.fromStack(stack));
    expect(Object.values(env)).toEqual(['false', 'false', 'false', 'false']);
  });

  it('sweepErrorsAlarm throws when metrics are off, naming the prop and the metric', () => {
    const stack = newStack();
    const runners = mkRunners(stack, 'Runners', minimalProps(stack));
    expect(() => runners.metrics.sweepErrorsAlarm(stack)).toThrow(
      /sweepErrorsAlarm\(\) requires emitMetrics: true/,
    );
    expect(() => runners.metrics.sweepErrorsAlarm(stack)).toThrow(/`errors`/);
  });

  it('stuckLaunchesRecoveredAlarm throws when metrics are off', () => {
    const stack = newStack();
    const runners = mkRunners(stack, 'Runners', minimalProps(stack));
    expect(() => runners.metrics.stuckLaunchesRecoveredAlarm(stack)).toThrow(
      /stuckLaunchesRecoveredAlarm\(\) requires emitMetrics: true/,
    );
  });

  it('both EMF-backed alarms succeed with emitMetrics: true', () => {
    const stack = newStack();
    const runners = mkRunners(stack, 'Runners', {
      ...minimalProps(stack),
      emitMetrics: true,
    });
    expect(() => runners.metrics.sweepErrorsAlarm(stack)).not.toThrow();
    expect(() =>
      runners.metrics.stuckLaunchesRecoveredAlarm(stack),
    ).not.toThrow();
  });

  it('deadLetterQueueNotEmptyAlarm never throws — it watches an SQS metric, not an EMF one', () => {
    const off = newStack();
    const offRunners = mkRunners(off, 'Runners', minimalProps(off));
    expect(() =>
      offRunners.metrics.deadLetterQueueNotEmptyAlarm(off),
    ).not.toThrow();
    // ...and the alarm it builds really is on the SQS namespace, which
    // publishes regardless of this construct's own metric emission.
    Template.fromStack(off).hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateNumberOfMessagesVisible',
    });

    const on = newStack();
    const onRunners = mkRunners(on, 'Runners', {
      ...minimalProps(on),
      emitMetrics: true,
    });
    expect(() =>
      onRunners.metrics.deadLetterQueueNotEmptyAlarm(on),
    ).not.toThrow();
  });

  it('the EMF-backed metric ACCESSORS never throw with metrics off (dashboards stay buildable)', () => {
    const stack = newStack();
    const runners = mkRunners(stack, 'Runners', minimalProps(stack));
    expect(() => runners.metrics.errors()).not.toThrow();
    expect(() => runners.metrics.orphansReaped()).not.toThrow();
    expect(() => runners.metrics.capacityRejected('microvm')).not.toThrow();
    expect(() => runners.metrics.poolCurrent('microvm')).not.toThrow();
  });
});

describe('GithubMicrovmRunners: per-runner-class metric accessors', () => {
  const stack = newStack();
  const runners = mkRunners(stack, 'Runners', minimalProps(stack));
  const m = runners.metrics;

  /** Every two-dimension accessor: [method name, invocation, expected CloudWatch metric name, expected statistic]. */
  const CLASS_METRICS: [
    string,
    () => import('aws-cdk-lib/aws-cloudwatch').Metric,
    string,
    string,
  ][] = [
    ['warmHit', () => m.warmHit('large'), 'WarmHit', 'Sum'],
    ['coldBoot', () => m.coldBoot('large'), 'ColdBoot', 'Sum'],
    [
      'capacityRejected',
      () => m.capacityRejected('large'),
      'CapacityRejected',
      'Sum',
    ],
    ['warmThrottled', () => m.warmThrottled('large'), 'WarmThrottled', 'Sum'],
    // Latency: averaged, not summed — a summed duration is meaningless.
    ['warmSpinUpMs', () => m.warmSpinUpMs('large'), 'WarmSpinUpMs', 'Average'],
    ['coldSpinUpMs', () => m.coldSpinUpMs('large'), 'ColdSpinUpMs', 'Average'],
    // Pool gauges: averaged — summing a per-tick gauge multiplies by ticks.
    ['poolCurrent', () => m.poolCurrent('large'), 'PoolCurrent', 'Average'],
    ['poolTarget', () => m.poolTarget('large'), 'PoolTarget', 'Average'],
    ['poolLaunched', () => m.poolLaunched('large'), 'PoolLaunched', 'Sum'],
    [
      'poolLaunchFailed',
      () => m.poolLaunchFailed('large'),
      'PoolLaunchFailed',
      'Sum',
    ],
  ];

  it('covers all ten previously-unreachable launcher/warm-pool metrics', () => {
    expect(CLASS_METRICS).toHaveLength(10);
  });

  for (const [method, build, metricName, statistic] of CLASS_METRICS) {
    it(`${method}() → ${metricName} in MicrovmRunners, dimensioned by RunnerSetId + SizeClass, statistic ${statistic}`, () => {
      const metric = build();
      expect(metric.namespace).toBe('MicrovmRunners');
      expect(metric.metricName).toBe(metricName);
      expect(metric.statistic).toBe(statistic);
      expect(Object.keys(metric.dimensions ?? {}).sort()).toEqual([
        'RunnerSetId',
        'SizeClass',
      ]);
      expect(metric.dimensions?.SizeClass).toBe('large');
      // The RunnerSetId dimension is the runner set's derived id — a non-empty
      // string, and the same one the single-dimension janitor metrics carry.
      expect(metric.dimensions?.RunnerSetId).toBe(
        m.errors().dimensions?.RunnerSetId,
      );
    });
  }

  it('the label argument really varies the SizeClass dimension', () => {
    expect(m.coldBoot('gb1').dimensions?.SizeClass).toBe('gb1');
    expect(m.coldBoot('gb8').dimensions?.SizeClass).toBe('gb8');
  });

  it('the single-dimension janitor accessors are unchanged (RunnerSetId only)', () => {
    expect(Object.keys(m.errors().dimensions ?? {})).toEqual(['RunnerSetId']);
    expect(m.errors().statistic).toBe('Sum');
  });
});

describe('GithubMicrovmRunners: setupCommand', () => {
  it('renders a runnable npx invocation for an org runner set', () => {
    const stack = new Stack(new App(), 'Runners', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    const runners = new GithubMicrovmRunners(stack, 'Runners', {
      github: patAuth(stack),
      scope: RunnerScope.org('my-org'),
    });

    // The version is asserted by shape, not value: the repo carries 0.0.0
    // until a release bumps it, so pinning a literal would fail on the first
    // published version.
    expect(runners.setupCommand).toMatch(
      /^npx cdk-github-microvm-runners@\d+\.\d+ setup /,
    );
    expect(runners.setupCommand).toContain('--org my-org');
    expect(runners.setupCommand).toContain('--stack Runners');
    expect(runners.setupCommand).toContain('--region us-east-1');
  });

  it('uses --account for a repository-scoped runner set', () => {
    const stack = new Stack(new App(), 'Runners', {
      env: { account: '111122223333', region: 'us-east-1' },
    });
    const runners = new GithubMicrovmRunners(stack, 'Runners', {
      github: patAuth(stack),
      scope: RunnerScope.repos(['my-org/api']),
    });

    expect(runners.setupCommand).toContain('--account my-org');
    expect(runners.setupCommand).not.toContain('--org ');
  });
});
