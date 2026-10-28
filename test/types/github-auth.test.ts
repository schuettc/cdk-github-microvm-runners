import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { GithubMicrovmRunners } from '../../src/github-microvm-runners.js';
import {
  GithubAppId,
  GithubAppKey,
  GithubAuth,
  GithubAuthKind,
} from '../../src/types/github-auth.js';
import { MicrovmSize } from '../../src/types/microvm-size.js';
import { RunnerScope } from '../../src/types/runner-scope.js';

function newStack(): Stack {
  return new Stack(new App(), 'TestStack');
}

/**
 * The ARN an imported parameter's grant names. One slash after `parameter`:
 * the name already starts with one, and `parameter//...` would match nothing.
 */
function parameterArn(name: string): unknown {
  return {
    'Fn::Join': [
      '',
      [
        'arn:',
        { Ref: 'AWS::Partition' },
        ':ssm:',
        { Ref: 'AWS::Region' },
        ':',
        { Ref: 'AWS::AccountId' },
        `:parameter${name}`,
      ],
    ],
  };
}

/** A SecureString parameter imported by name, the way a consumer references one. */
function param(stack: Stack, id: string, name = `/microvm-runner/dev/${id}`) {
  return StringParameter.fromSecureStringParameterAttributes(stack, id, {
    parameterName: name,
  });
}

function newRole(stack: Stack): Role {
  return new Role(stack, 'TestRole', {
    assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
  });
}

describe('GithubAuth', () => {
  describe('bindEnv', () => {
    it('app + parameter-backed key sets GH_KEY_PARAMETER, not GH_KEY_KMS_ARN', () => {
      const stack = newStack();
      const keySecret = param(stack, 'KeySecret');
      const webhookSecret = param(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromValue('12345'),
        privateKey: GithubAppKey.fromParameter(keySecret),
        webhookSecret,
      });

      expect(auth.kind).toBe(GithubAuthKind.APP);
      const env = auth.bindEnv();
      expect(env).toEqual({
        GH_AUTH_KIND: 'app',
        GH_APP_ID: '12345',
        GH_KEY_PARAMETER: keySecret.parameterName,
        GH_WEBHOOK_SECRET_PARAMETER: webhookSecret.parameterName,
      });
      expect(env.GH_KEY_KMS_ARN).toBeUndefined();
      expect(env.GH_PAT_PARAMETER).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual(
        [
          'GH_AUTH_KIND',
          'GH_APP_ID',
          'GH_KEY_PARAMETER',
          'GH_WEBHOOK_SECRET_PARAMETER',
        ].sort(),
      );
    });

    it('app + KMS-backed key sets GH_KEY_KMS_ARN, not GH_KEY_PARAMETER', () => {
      const stack = newStack();
      const key = new Key(stack, 'AppKey');
      const webhookSecret = param(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromValue('67890'),
        privateKey: GithubAppKey.fromKmsKey(key),
        webhookSecret,
      });

      const env = auth.bindEnv();
      expect(env).toEqual({
        GH_AUTH_KIND: 'app',
        GH_APP_ID: '67890',
        GH_KEY_KMS_ARN: key.keyArn,
        GH_WEBHOOK_SECRET_PARAMETER: webhookSecret.parameterName,
      });
      expect(env.GH_KEY_PARAMETER).toBeUndefined();
      expect(env.GH_PAT_PARAMETER).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual(
        [
          'GH_AUTH_KIND',
          'GH_APP_ID',
          'GH_KEY_KMS_ARN',
          'GH_WEBHOOK_SECRET_PARAMETER',
        ].sort(),
      );
    });

    it('app + parameter-backed app id sets GH_APP_ID_PARAMETER, not GH_APP_ID', () => {
      const stack = newStack();
      const appIdSecret = param(stack, 'AppIdSecret');
      const keySecret = param(stack, 'KeySecret');
      const webhookSecret = param(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromParameter(appIdSecret),
        privateKey: GithubAppKey.fromParameter(keySecret),
        webhookSecret,
      });

      const env = auth.bindEnv();
      expect(env).toEqual({
        GH_AUTH_KIND: 'app',
        GH_APP_ID_PARAMETER: appIdSecret.parameterName,
        GH_KEY_PARAMETER: keySecret.parameterName,
        GH_WEBHOOK_SECRET_PARAMETER: webhookSecret.parameterName,
      });
      expect(env.GH_APP_ID).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual(
        [
          'GH_AUTH_KIND',
          'GH_APP_ID_PARAMETER',
          'GH_KEY_PARAMETER',
          'GH_WEBHOOK_SECRET_PARAMETER',
        ].sort(),
      );
    });

    it('pat sets GH_AUTH_KIND=pat and GH_PAT_PARAMETER, omits app keys', () => {
      const stack = newStack();
      const token = param(stack, 'PatToken');
      const webhookSecret = param(stack, 'WebhookSecret');

      const auth = GithubAuth.pat({ token, webhookSecret });

      expect(auth.kind).toBe(GithubAuthKind.PAT);
      const env = auth.bindEnv();
      expect(env).toEqual({
        GH_AUTH_KIND: 'pat',
        GH_PAT_PARAMETER: token.parameterName,
        GH_WEBHOOK_SECRET_PARAMETER: webhookSecret.parameterName,
      });
      expect(env.GH_APP_ID).toBeUndefined();
      expect(env.GH_KEY_PARAMETER).toBeUndefined();
      expect(env.GH_KEY_KMS_ARN).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual(
        [
          'GH_AUTH_KIND',
          'GH_PAT_PARAMETER',
          'GH_WEBHOOK_SECRET_PARAMETER',
        ].sort(),
      );
    });
  });

  describe('grantReadWebhookSecret', () => {
    it('grants the webhook-secret parameter and NOT the App key or its KMS key', () => {
      // The narrow grant exists for the webhook handler, which verifies the
      // HMAC on a delivery and enqueues. It sits on a Function URL with
      // authType NONE, so the credentials that can act AS the App are exactly
      // what must not be reachable through it.
      const stack = newStack();
      const role = newRole(stack);
      const keySecret = param(stack, 'KeySecret');
      const webhookSecret = param(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromValue('1'),
        privateKey: GithubAppKey.fromParameter(keySecret),
        webhookSecret,
      });
      auth.grantReadWebhookSecret(role);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetParameter']),
              Resource: parameterArn('/microvm-runner/dev/WebhookSecret'),
            }),
          ]),
        },
      });

      // The whole point: the key parameter must appear NOWHERE in any policy this
      // grant produced. Asserted over the rendered template rather than by
      // matcher absence, because a matcher that fails to match reads the same
      // as one that matched nothing.
      const policies = JSON.stringify(
        template.findResources('AWS::IAM::Policy'),
      );
      expect(policies).toContain('WebhookSecret');
      expect(policies).not.toContain('KeySecret');
    });
  });

  describe('grantRead', () => {
    it('app + parameter-backed key grants ssm:GetParameter on both the key parameter and webhook-secret parameter', () => {
      const stack = newStack();
      const role = newRole(stack);
      const keySecret = param(stack, 'KeySecret');
      const webhookSecret = param(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromValue('1'),
        privateKey: GithubAppKey.fromParameter(keySecret),
        webhookSecret,
      });
      auth.grantRead(role);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetParameter']),
              Resource: parameterArn('/microvm-runner/dev/KeySecret'),
            }),
          ]),
        },
      });
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetParameter']),
              Resource: parameterArn('/microvm-runner/dev/WebhookSecret'),
            }),
          ]),
        },
      });
    });

    it('app + parameter-backed app id grants ssm:GetParameter on the app-id parameter too', () => {
      const stack = newStack();
      const role = newRole(stack);
      const appIdSecret = param(stack, 'AppIdSecret');
      const keySecret = param(stack, 'KeySecret');
      const webhookSecret = param(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromParameter(appIdSecret),
        privateKey: GithubAppKey.fromParameter(keySecret),
        webhookSecret,
      });
      auth.grantRead(role);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetParameter']),
              Resource: parameterArn('/microvm-runner/dev/AppIdSecret'),
            }),
          ]),
        },
      });
    });

    it('app + literal app id grants nothing extra beyond the key and webhook-secret parameters', () => {
      const stack = newStack();
      const role = newRole(stack);
      const keySecret = param(stack, 'KeySecret');
      const webhookSecret = param(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromValue('1'),
        privateKey: GithubAppKey.fromParameter(keySecret),
        webhookSecret,
      });
      auth.grantRead(role);

      const template = Template.fromStack(stack);
      const policies = Object.values(
        template.findResources('AWS::IAM::Policy'),
      );
      const secretResources = policies.flatMap((p) =>
        (
          p.Properties.PolicyDocument.Statement as Array<{
            Action: string | string[];
            Resource: unknown;
          }>
        )
          .filter((s) =>
            ([] as string[]).concat(s.Action).includes('ssm:GetParameter'),
          )
          .map((s) => JSON.stringify(s.Resource)),
      );
      expect(secretResources).toHaveLength(2);
      expect(secretResources.join(' ')).not.toMatch(/AppIdSecret/);
    });

    it('app + KMS-backed key grants kms:Sign on the key and ssm:GetParameter on the webhook-secret parameter', () => {
      const stack = newStack();
      const role = newRole(stack);
      const key = new Key(stack, 'AppKey');
      const webhookSecret = param(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromValue('1'),
        privateKey: GithubAppKey.fromKmsKey(key),
        webhookSecret,
      });
      auth.grantRead(role);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'kms:Sign',
              Resource: Match.objectLike({
                'Fn::GetAtt': [Match.stringLikeRegexp('^AppKey'), 'Arn'],
              }),
            }),
          ]),
        },
      });
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetParameter']),
              Resource: parameterArn('/microvm-runner/dev/WebhookSecret'),
            }),
          ]),
        },
      });
    });

    it('pat grants ssm:GetParameter on both the token parameter and webhook-secret parameter', () => {
      const stack = newStack();
      const role = newRole(stack);
      const token = param(stack, 'PatToken');
      const webhookSecret = param(stack, 'WebhookSecret');

      const auth = GithubAuth.pat({ token, webhookSecret });
      auth.grantRead(role);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetParameter']),
              Resource: parameterArn('/microvm-runner/dev/PatToken'),
            }),
          ]),
        },
      });
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetParameter']),
              Resource: parameterArn('/microvm-runner/dev/WebhookSecret'),
            }),
          ]),
        },
      });
    });
  });

  describe('GithubAppId', () => {
    it('fromValue carries the literal and leaves parameter undefined', () => {
      const appId = GithubAppId.fromValue('123456');
      expect(appId.value).toBe('123456');
      expect(appId.parameter).toBeUndefined();
    });

    it('fromParameter carries the parameter and leaves value undefined', () => {
      const stack = newStack();
      const parameter = param(stack, 'AppIdSecret');
      const appId = GithubAppId.fromParameter(parameter);
      expect(appId.parameter).toBe(parameter);
      expect(appId.value).toBeUndefined();
    });
  });

  describe('GithubAppKey', () => {
    it('fromParameter sets parameter and leaves kmsKey undefined', () => {
      const stack = newStack();
      const parameter = param(stack, 'KeySecret');
      const key = GithubAppKey.fromParameter(parameter);
      expect(key.parameter).toBe(parameter);
      expect(key.kmsKey).toBeUndefined();
    });

    it('fromKmsKey sets kmsKey and leaves parameter undefined', () => {
      const stack = newStack();
      const kmsKey = new Key(stack, 'AppKey');
      const key = GithubAppKey.fromKmsKey(kmsKey);
      expect(key.kmsKey).toBe(kmsKey);
      expect(key.parameter).toBeUndefined();
    });
  });

  describe('on a runner set', () => {
    /**
     * A runner set authenticated as an App whose three credentials are
     * SecureString parameters under the setup script's default prefix.
     */
    function synthApp(): Template {
      const stack = new Stack(new App(), 'TestStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const runners = new GithubMicrovmRunners(stack, 'Runners', {
        github: GithubAuth.app({
          appId: GithubAppId.fromParameter(
            param(stack, 'AppId', '/microvm-runner/dev/app-id'),
          ),
          privateKey: GithubAppKey.fromParameter(
            param(stack, 'AppKey', '/microvm-runner/dev/app-private-key'),
          ),
          webhookSecret: param(
            stack,
            'WebhookSecret',
            '/microvm-runner/dev/webhook-secret',
          ),
        }),
        scope: RunnerScope.org('my-org'),
      });
      runners.addRunnerClass('microvm', { size: MicrovmSize.GB4 });
      return Template.fromStack(stack);
    }

    /** The rendered statements of every IAM policy attached to `handler`'s role. */
    function statementsOf(template: Template, handler: string): string {
      return JSON.stringify(
        Object.values(template.findResources('AWS::IAM::Policy'))
          .filter((p) =>
            JSON.stringify(p.Properties.Roles ?? []).includes(handler),
          )
          .map((p) => p.Properties.PolicyDocument.Statement),
      );
    }

    it('fromParameter binds the parameter name and grants ssm:GetParameter on it', () => {
      const stack = newStack();
      const auth = GithubAuth.app({
        appId: GithubAppId.fromParameter(
          param(stack, 'AppId', '/microvm-runner/dev/app-id'),
        ),
        privateKey: GithubAppKey.fromParameter(
          param(stack, 'AppKey', '/microvm-runner/dev/app-private-key'),
        ),
        webhookSecret: param(
          stack,
          'WebhookSecret',
          '/microvm-runner/dev/webhook-secret',
        ),
      });
      expect(auth.bindEnv()).toEqual({
        GH_AUTH_KIND: 'app',
        GH_APP_ID_PARAMETER: '/microvm-runner/dev/app-id',
        GH_KEY_PARAMETER: '/microvm-runner/dev/app-private-key',
        GH_WEBHOOK_SECRET_PARAMETER: '/microvm-runner/dev/webhook-secret',
      });

      const template = synthApp();
      const launcher = Object.values(
        template.findResources('AWS::IAM::Policy'),
      ).filter((p) =>
        JSON.stringify(p.Properties.Roles ?? []).includes('LauncherFunction'),
      );
      expect(launcher.length).toBeGreaterThan(0);
      const statements = launcher.flatMap(
        (p) =>
          p.Properties.PolicyDocument.Statement as Array<{
            Action: string | string[];
            Resource: unknown;
          }>,
      );
      const keyGrant = statements.find(
        (st) =>
          ([] as string[]).concat(st.Action).includes('ssm:GetParameter') &&
          JSON.stringify(st.Resource).includes('app-private-key'),
      );
      // A name that starts with `/` must not render as `parameter//...`, which
      // IAM would match against nothing and the handler would be denied.
      expect(keyGrant?.Resource).toEqual({
        'Fn::Join': [
          '',
          [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':ssm:us-east-1:123456789012:parameter/microvm-runner/dev/app-private-key',
          ],
        ],
      });
    });

    it('the webhook function can read only the webhook secret', () => {
      const webhook = statementsOf(synthApp(), 'WebhookFunction');
      expect(webhook).toContain('ssm:GetParameter');
      expect(webhook).toContain('parameter/microvm-runner/dev/webhook-secret');
      expect(webhook).not.toContain('microvm-runner/dev/app-id');
      expect(webhook).not.toContain('microvm-runner/dev/app-private-key');
    });
  });
});
