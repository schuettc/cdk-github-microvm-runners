import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import {
  GithubAppId,
  GithubAppKey,
  GithubAuth,
  GithubAuthKind,
} from '../../src/types/github-auth.js';

function newStack(): Stack {
  return new Stack(new App(), 'TestStack');
}

function newRole(stack: Stack): Role {
  return new Role(stack, 'TestRole', {
    assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
  });
}

describe('GithubAuth', () => {
  describe('bindEnv', () => {
    it('app + secret-backed key sets GH_KEY_SECRET_ARN, not GH_KEY_KMS_ARN', () => {
      const stack = newStack();
      const keySecret = new Secret(stack, 'KeySecret');
      const webhookSecret = new Secret(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromValue('12345'),
        privateKey: GithubAppKey.fromSecret(keySecret),
        webhookSecret,
      });

      expect(auth.kind).toBe(GithubAuthKind.APP);
      const env = auth.bindEnv();
      expect(env).toEqual({
        GH_AUTH_KIND: 'app',
        GH_APP_ID: '12345',
        GH_KEY_SECRET_ARN: keySecret.secretArn,
        GH_WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
      });
      expect(env.GH_KEY_KMS_ARN).toBeUndefined();
      expect(env.GH_PAT_SECRET_ARN).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual(
        [
          'GH_AUTH_KIND',
          'GH_APP_ID',
          'GH_KEY_SECRET_ARN',
          'GH_WEBHOOK_SECRET_ARN',
        ].sort(),
      );
    });

    it('app + KMS-backed key sets GH_KEY_KMS_ARN, not GH_KEY_SECRET_ARN', () => {
      const stack = newStack();
      const key = new Key(stack, 'AppKey');
      const webhookSecret = new Secret(stack, 'WebhookSecret');

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
        GH_WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
      });
      expect(env.GH_KEY_SECRET_ARN).toBeUndefined();
      expect(env.GH_PAT_SECRET_ARN).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual(
        [
          'GH_AUTH_KIND',
          'GH_APP_ID',
          'GH_KEY_KMS_ARN',
          'GH_WEBHOOK_SECRET_ARN',
        ].sort(),
      );
    });

    it('app + secret-backed app id sets GH_APP_ID_SECRET_ARN, not GH_APP_ID', () => {
      const stack = newStack();
      const appIdSecret = new Secret(stack, 'AppIdSecret');
      const keySecret = new Secret(stack, 'KeySecret');
      const webhookSecret = new Secret(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromSecret(appIdSecret),
        privateKey: GithubAppKey.fromSecret(keySecret),
        webhookSecret,
      });

      const env = auth.bindEnv();
      expect(env).toEqual({
        GH_AUTH_KIND: 'app',
        GH_APP_ID_SECRET_ARN: appIdSecret.secretArn,
        GH_KEY_SECRET_ARN: keySecret.secretArn,
        GH_WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
      });
      expect(env.GH_APP_ID).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual(
        [
          'GH_AUTH_KIND',
          'GH_APP_ID_SECRET_ARN',
          'GH_KEY_SECRET_ARN',
          'GH_WEBHOOK_SECRET_ARN',
        ].sort(),
      );
    });

    it('pat sets GH_AUTH_KIND=pat and GH_PAT_SECRET_ARN, omits app keys', () => {
      const stack = newStack();
      const token = new Secret(stack, 'PatToken');
      const webhookSecret = new Secret(stack, 'WebhookSecret');

      const auth = GithubAuth.pat({ token, webhookSecret });

      expect(auth.kind).toBe(GithubAuthKind.PAT);
      const env = auth.bindEnv();
      expect(env).toEqual({
        GH_AUTH_KIND: 'pat',
        GH_PAT_SECRET_ARN: token.secretArn,
        GH_WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
      });
      expect(env.GH_APP_ID).toBeUndefined();
      expect(env.GH_KEY_SECRET_ARN).toBeUndefined();
      expect(env.GH_KEY_KMS_ARN).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual(
        ['GH_AUTH_KIND', 'GH_PAT_SECRET_ARN', 'GH_WEBHOOK_SECRET_ARN'].sort(),
      );
    });
  });

  describe('grantReadWebhookSecret', () => {
    it('grants the webhook secret and NOT the App key or its KMS key', () => {
      // The narrow grant exists for the webhook handler, which verifies the
      // HMAC on a delivery and enqueues. It sits on a Function URL with
      // authType NONE, so the credentials that can act AS the App are exactly
      // what must not be reachable through it.
      const stack = newStack();
      const role = newRole(stack);
      const keySecret = new Secret(stack, 'KeySecret');
      const webhookSecret = new Secret(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromValue('1'),
        privateKey: GithubAppKey.fromSecret(keySecret),
        webhookSecret,
      });
      auth.grantReadWebhookSecret(role);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
              Resource: { Ref: Match.stringLikeRegexp('^WebhookSecret') },
            }),
          ]),
        },
      });

      // The whole point: the key secret must appear NOWHERE in any policy this
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
    it('app + secret-backed key grants secretsmanager:GetSecretValue on both the key secret and webhook secret', () => {
      const stack = newStack();
      const role = newRole(stack);
      const keySecret = new Secret(stack, 'KeySecret');
      const webhookSecret = new Secret(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromValue('1'),
        privateKey: GithubAppKey.fromSecret(keySecret),
        webhookSecret,
      });
      auth.grantRead(role);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
              Resource: { Ref: Match.stringLikeRegexp('^KeySecret') },
            }),
          ]),
        },
      });
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
              Resource: { Ref: Match.stringLikeRegexp('^WebhookSecret') },
            }),
          ]),
        },
      });
    });

    it('app + secret-backed app id grants secretsmanager:GetSecretValue on the app-id secret too', () => {
      const stack = newStack();
      const role = newRole(stack);
      const appIdSecret = new Secret(stack, 'AppIdSecret');
      const keySecret = new Secret(stack, 'KeySecret');
      const webhookSecret = new Secret(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromSecret(appIdSecret),
        privateKey: GithubAppKey.fromSecret(keySecret),
        webhookSecret,
      });
      auth.grantRead(role);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
              Resource: { Ref: Match.stringLikeRegexp('^AppIdSecret') },
            }),
          ]),
        },
      });
    });

    it('app + literal app id grants nothing extra beyond the key and webhook secrets', () => {
      const stack = newStack();
      const role = newRole(stack);
      const keySecret = new Secret(stack, 'KeySecret');
      const webhookSecret = new Secret(stack, 'WebhookSecret');

      const auth = GithubAuth.app({
        appId: GithubAppId.fromValue('1'),
        privateKey: GithubAppKey.fromSecret(keySecret),
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
            ([] as string[])
              .concat(s.Action)
              .includes('secretsmanager:GetSecretValue'),
          )
          .map((s) => JSON.stringify(s.Resource)),
      );
      expect(secretResources).toHaveLength(2);
      expect(secretResources.join(' ')).not.toMatch(/AppIdSecret/);
    });

    it('app + KMS-backed key grants kms:Sign on the key and secretsmanager:GetSecretValue on the webhook secret', () => {
      const stack = newStack();
      const role = newRole(stack);
      const key = new Key(stack, 'AppKey');
      const webhookSecret = new Secret(stack, 'WebhookSecret');

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
              Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
              Resource: { Ref: Match.stringLikeRegexp('^WebhookSecret') },
            }),
          ]),
        },
      });
    });

    it('pat grants secretsmanager:GetSecretValue on both the token secret and webhook secret', () => {
      const stack = newStack();
      const role = newRole(stack);
      const token = new Secret(stack, 'PatToken');
      const webhookSecret = new Secret(stack, 'WebhookSecret');

      const auth = GithubAuth.pat({ token, webhookSecret });
      auth.grantRead(role);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
              Resource: { Ref: Match.stringLikeRegexp('^PatToken') },
            }),
          ]),
        },
      });
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
              Resource: { Ref: Match.stringLikeRegexp('^WebhookSecret') },
            }),
          ]),
        },
      });
    });
  });

  describe('GithubAppId', () => {
    it('fromValue carries the literal and leaves secret undefined', () => {
      const appId = GithubAppId.fromValue('123456');
      expect(appId.value).toBe('123456');
      expect(appId.secret).toBeUndefined();
    });

    it('fromSecret carries the secret and leaves value undefined', () => {
      const stack = newStack();
      const secret = new Secret(stack, 'AppIdSecret');
      const appId = GithubAppId.fromSecret(secret);
      expect(appId.secret).toBe(secret);
      expect(appId.value).toBeUndefined();
    });
  });

  describe('GithubAppKey', () => {
    it('fromSecret sets secret and leaves kmsKey undefined', () => {
      const stack = newStack();
      const secret = new Secret(stack, 'KeySecret');
      const key = GithubAppKey.fromSecret(secret);
      expect(key.secret).toBe(secret);
      expect(key.kmsKey).toBeUndefined();
    });

    it('fromKmsKey sets kmsKey and leaves secret undefined', () => {
      const stack = newStack();
      const kmsKey = new Key(stack, 'AppKey');
      const key = GithubAppKey.fromKmsKey(kmsKey);
      expect(key.kmsKey).toBe(kmsKey);
      expect(key.secret).toBeUndefined();
    });
  });
});
