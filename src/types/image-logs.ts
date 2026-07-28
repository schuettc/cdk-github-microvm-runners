import type { ILogGroup } from 'aws-cdk-lib/aws-logs';

/**
 * Build-time image logs for a runner set: the Docker build layers and the
 * ready-probe banner an image emits while it is built. Off unless you add it.
 *
 * These logs are written while the image builds, by the image build role
 * rather than by a VM, so image logging needs no VM execution role and puts no
 * credentials on a runner. `ConsoleLogs` covers the runtime counterpart, which
 * does need a role. The two are independent and can both be on.
 *
 * @example
 * new GithubMicrovmRunners(stack, 'Runners', {
 *   github,
 *   scope,
 *   imageLogs: ImageLogs.enabled(),
 * });
 */
export class ImageLogs {
  /**
   * Send image-build logs to CloudWatch. With no argument they go to the
   * platform's own group (`/aws/lambda-microvms/…`). Pass an `ILogGroup` to
   * send them to a group whose retention and KMS key you control.
   *
   * @param logGroup destination group. Omitted, the platform's own group.
   *
   * @example
   * const buildLogs = ImageLogs.enabled(myBuildLogGroup);
   */
  public static enabled(logGroup?: ILogGroup): ImageLogs {
    return new ImageLogs(logGroup);
  }
  private constructor(
    /**
     * The group build logs go to, when one was passed to
     * `ImageLogs.enabled()`. `undefined` means the platform's own group.
     */
    public readonly logGroup?: ILogGroup,
  ) {}
}
