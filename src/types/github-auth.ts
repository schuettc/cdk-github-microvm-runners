import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { IStringParameter } from 'aws-cdk-lib/aws-ssm';

/** Which credential flow a `GithubAuth` represents. */
export enum GithubAuthKind {
  /** A GitHub App. */
  APP = 'app',
  /** A personal access token. */
  PAT = 'pat',
}

/**
 * Where a GitHub App's private key lives: an SSM SecureString parameter
 * holding the PEM, or a KMS key that signs the App's JWTs directly.
 *
 * Build one with the static factories below; the constructor is private.
 *
 * @example
 * const privateKey = GithubAppKey.fromParameter(
 *   StringParameter.fromSecureStringParameterAttributes(stack, 'AppKey', {
 *     parameterName: '/microvm-runner/dev/app-private-key',
 *   }),
 * );
 */
export class GithubAppKey {
  /**
   * The App's private key is stored as a PEM in an SSM SecureString
   * parameter, read at runtime with decryption.
   *
   * @example
   * const privateKey = GithubAppKey.fromParameter(
   *   StringParameter.fromSecureStringParameterAttributes(stack, 'AppKey', {
   *     parameterName: '/microvm-runner/dev/app-private-key',
   *   }),
   * );
   */
  public static fromParameter(parameter: IStringParameter): GithubAppKey {
    return new GithubAppKey(parameter, undefined);
  }

  /**
   * The App's private key lives in KMS and is used via `kms:Sign`.
   *
   * @example
   * import { Key } from 'aws-cdk-lib/aws-kms';
   *
   * const privateKey = GithubAppKey.fromKmsKey(
   *   Key.fromKeyArn(
   *     stack,
   *     'AppKey',
   *     'arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab',
   *   ),
   * );
   */
  public static fromKmsKey(key: IKey): GithubAppKey {
    return new GithubAppKey(undefined, key);
  }

  private constructor(
    /** The parameter holding the PEM, for a key built with `fromParameter()`. */
    public readonly parameter?: IStringParameter,
    /** The signing key, for a key built with `fromKmsKey()`. */
    public readonly kmsKey?: IKey,
  ) {}
}

/**
 * Where a GitHub App's numeric ID comes from: a literal known at synth time,
 * or an SSM SecureString parameter read at runtime.
 *
 * The parameter form makes setup single-pass. A GitHub App can only be created
 * once the runner set's webhook URL exists, so an App ID that has to be known
 * at synth means deploying twice. Referencing the ID by parameter, the way the
 * private key and webhook secret already are, lets you deploy, then create the
 * App and write its ID into the parameter, with no redeploy.
 *
 * Build one with the static factories below; the constructor is private.
 *
 * @example
 * const appId = GithubAppId.fromParameter(
 *   StringParameter.fromSecureStringParameterAttributes(stack, 'AppId', {
 *     parameterName: '/microvm-runner/dev/app-id',
 *   }),
 * );
 */
export class GithubAppId {
  /**
   * The App ID is a literal string known at synth time.
   *
   * @example
   * const appId = GithubAppId.fromValue('123456');
   */
  public static fromValue(value: string): GithubAppId {
    return new GithubAppId(value, undefined);
  }

  /**
   * The App ID is read at runtime from an SSM SecureString parameter whose
   * value is the numeric ID. The parameter need not exist at deploy time.
   *
   * @example
   * const appId = GithubAppId.fromParameter(
   *   StringParameter.fromSecureStringParameterAttributes(stack, 'AppId', {
   *     parameterName: '/microvm-runner/dev/app-id',
   *   }),
   * );
   */
  public static fromParameter(parameter: IStringParameter): GithubAppId {
    return new GithubAppId(undefined, parameter);
  }

  private constructor(
    /** The literal ID, for an ID built with `fromValue()`. */
    public readonly value?: string,
    /** The parameter holding the ID, for an ID built with `fromParameter()`. */
    public readonly parameter?: IStringParameter,
  ) {}
}

/** Props for `GithubAuth.app`. */
export interface GithubAppAuthProps {
  /** The GitHub App's numeric ID, as a literal or a parameter reference. */
  readonly appId: GithubAppId;
  /** The App's private key, backed by a parameter or a KMS key. */
  readonly privateKey: GithubAppKey;
  /** SecureString parameter holding the webhook secret used to validate inbound deliveries. */
  readonly webhookSecret: IStringParameter;
}

/** Props for `GithubAuth.pat`. */
export interface GithubPatAuthProps {
  /** SecureString parameter holding a GitHub personal access token. */
  readonly token: IStringParameter;
  /** SecureString parameter holding the webhook secret used to validate inbound deliveries. */
  readonly webhookSecret: IStringParameter;
}

/**
 * How a runner set authenticates to GitHub: as a GitHub App, whose private key
 * is backed by a SecureString parameter or a KMS key, or with a personal access token. Either
 * form also carries the webhook secret that inbound GitHub deliveries are
 * validated against.
 *
 * Build one with the static factories below; the constructor is private.
 *
 * @example
 * const auth = GithubAuth.app({
 *   appId: GithubAppId.fromParameter(
 *     StringParameter.fromSecureStringParameterAttributes(stack, 'AppId', {
 *       parameterName: '/microvm-runner/dev/app-id',
 *     }),
 *   ),
 *   privateKey: GithubAppKey.fromParameter(
 *     StringParameter.fromSecureStringParameterAttributes(stack, 'AppKey', {
 *       parameterName: '/microvm-runner/dev/app-private-key',
 *     }),
 *   ),
 *   webhookSecret: StringParameter.fromSecureStringParameterAttributes(
 *     stack, 'WebhookSecret', { parameterName: '/microvm-runner/dev/webhook-secret' },
 *   ),
 * });
 */
export class GithubAuth {
  /**
   * Authenticate as a GitHub App.
   *
   * @example
   * const auth = GithubAuth.app({
   *   appId: GithubAppId.fromParameter(
   *     StringParameter.fromSecureStringParameterAttributes(stack, 'AppId', {
   *       parameterName: '/microvm-runner/dev/app-id',
   *     }),
   *   ),
   *   privateKey: GithubAppKey.fromParameter(
   *     StringParameter.fromSecureStringParameterAttributes(stack, 'AppKey', {
   *       parameterName: '/microvm-runner/dev/app-private-key',
   *     }),
   *   ),
   *   webhookSecret: StringParameter.fromSecureStringParameterAttributes(
   *     stack, 'WebhookSecret', { parameterName: '/microvm-runner/dev/webhook-secret' },
   *   ),
   * });
   */
  public static app(props: GithubAppAuthProps): GithubAuth {
    return new GithubAuth(
      GithubAuthKind.APP,
      props.webhookSecret,
      props.appId,
      props.privateKey,
      undefined,
    );
  }

  /**
   * Authenticate with a personal access token.
   *
   * @example
   * const auth = GithubAuth.pat({
   *   token: StringParameter.fromSecureStringParameterAttributes(
   *     stack, 'Pat', { parameterName: '/microvm-runner/dev/token' },
   *   ),
   *   webhookSecret: StringParameter.fromSecureStringParameterAttributes(
   *     stack, 'WebhookSecret', { parameterName: '/microvm-runner/dev/webhook-secret' },
   *   ),
   * });
   */
  public static pat(props: GithubPatAuthProps): GithubAuth {
    return new GithubAuth(
      GithubAuthKind.PAT,
      props.webhookSecret,
      undefined,
      undefined,
      props.token,
    );
  }

  private constructor(
    /** Whether this is App or personal-access-token authentication. */
    public readonly kind: GithubAuthKind,
    /** Parameter holding the webhook secret inbound deliveries are validated against. */
    public readonly webhookSecret: IStringParameter,
    /** The App's ID, for App authentication. */
    public readonly appId?: GithubAppId,
    /** The App's private key, for App authentication. */
    public readonly privateKey?: GithubAppKey,
    /** The personal access token parameter, for token authentication. */
    public readonly token?: IStringParameter,
  ) {}

  /**
   * Serialize to the environment variables the runner set's handlers read:
   * `GH_AUTH_KIND`, `GH_APP_ID` or `GH_APP_ID_PARAMETER`,
   * `GH_KEY_PARAMETER` or `GH_KEY_KMS_ARN`, `GH_PAT_PARAMETER`, and
   * `GH_WEBHOOK_SECRET_PARAMETER`. Each `*_PARAMETER` holds a parameter NAME,
   * which `ssm:GetParameter` takes as-is. Entries that do not apply are left
   * out.
   */
  public bindEnv(): Record<string, string> {
    const env: Record<string, string> = {
      GH_AUTH_KIND: this.kind,
      GH_WEBHOOK_SECRET_PARAMETER: this.webhookSecret.parameterName,
    };

    if (this.kind === GithubAuthKind.APP) {
      // Exactly one of the two: a literal ID baked in at synth, or a parameter
      // reference the handlers resolve at runtime.
      if (this.appId?.parameter) {
        env.GH_APP_ID_PARAMETER = this.appId.parameter.parameterName;
      } else {
        env.GH_APP_ID = this.appId!.value!;
      }
      if (this.privateKey?.parameter) {
        env.GH_KEY_PARAMETER = this.privateKey.parameter.parameterName;
      }
      if (this.privateKey?.kmsKey) {
        env.GH_KEY_KMS_ARN = this.privateKey.kmsKey.keyArn;
      }
    } else {
      env.GH_PAT_PARAMETER = this.token!.parameterName;
    }

    return env;
  }

  /**
   * Grant `grantee` read access to the webhook secret, and nothing else.
   *
   * This is all a handler needs to verify the HMAC signature GitHub sends with
   * every delivery. It is deliberately separate from {@link grantRead}, which
   * also hands over the credentials that can act AS the App — minting
   * installation tokens, registering runners. A component that only checks
   * signatures and enqueues has no use for those, and the webhook handler is
   * the one component reachable from the public internet.
   *
   * @example
   * github.grantReadWebhookSecret(role);
   */
  public grantReadWebhookSecret(grantee: IGrantable): void {
    this.webhookSecret.grantRead(grantee);
  }

  /**
   * Grant `grantee` read access to whichever credentials this auth carries:
   * the App's parameter-backed key and/or `kms:Sign` on its KMS key, plus its
   * parameter-backed App ID when one is used, or the PAT parameter — plus, in
   * every case, read access to the webhook secret.
   *
   * A parameter imported with an `encryptionKey` (a customer-managed KMS key)
   * also gets `kms:Decrypt` on that key; one under the account's `aws/ssm`
   * key needs no KMS grant.
   *
   * This is the full set, for a handler that has to act as the App. A handler
   * that only verifies signatures wants {@link grantReadWebhookSecret}.
   */
  public grantRead(grantee: IGrantable): void {
    if (this.kind === GithubAuthKind.APP) {
      this.appId?.parameter?.grantRead(grantee);
      this.privateKey?.parameter?.grantRead(grantee);
      this.privateKey?.kmsKey?.grant(grantee, 'kms:Sign');
    } else {
      this.token?.grantRead(grantee);
    }

    this.webhookSecret.grantRead(grantee);
  }
}
