/** Which form of endpoint a `WebhookEndpoint` represents. */
export enum WebhookEndpointKind {
  /** A Lambda Function URL. */
  FUNCTION_URL = 'function_url',
}

/**
 * How the webhook handler is exposed to GitHub's `workflow_job` deliveries.
 *
 * The one form today is a Lambda Function URL. It is created with
 * `authType: NONE`; the auth boundary is the HMAC-SHA256 signature GitHub
 * sends with every delivery, which the handler verifies against the webhook
 * secret before it does anything else.
 *
 * @example
 * new GithubMicrovmRunners(stack, 'Runners', {
 *   github,
 *   scope,
 *   webhook: WebhookEndpoint.functionUrl(),
 * });
 */
export class WebhookEndpoint {
  /**
   * Expose the webhook handler on a Lambda Function URL.
   *
   * @example
   * const webhook = WebhookEndpoint.functionUrl();
   */
  public static functionUrl(): WebhookEndpoint {
    return new WebhookEndpoint(WebhookEndpointKind.FUNCTION_URL);
  }

  private constructor(
    /** Which form of endpoint this instance represents. */
    public readonly kind: WebhookEndpointKind,
  ) {}
}
