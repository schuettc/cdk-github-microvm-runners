import type { ILogGroup } from 'aws-cdk-lib/aws-logs';

/**
 * Runtime console capture for a runner set: everything a VM prints while it
 * boots, runs the runner agent, and runs the job. Off unless you add it.
 *
 * Console capture needs a VM execution role. The platform writes these logs
 * with the VM's own role, and the construct never creates a VM identity on
 * your behalf, so a runner set that turns console capture on without
 * `vmExecutionRole` fails at synth. The two console-write actions on the group
 * are granted by you as well, since the construct does not add policy to a
 * role it did not create:
 *
 * ```ts
 * runners.vmConsoleLogGroup!.grant(
 *   role, 'logs:CreateLogStream', 'logs:PutLogEvents',
 * );
 * ```
 *
 * A MicroVM's instance metadata service serves the execution role's
 * credentials to arbitrary job code, so whatever that role can do, every job
 * running on this runner set can do. Console capture on its own needs nothing
 * beyond the two log-write actions above. Job code can also write whatever it
 * likes into the console group, so the contents are as trustworthy as the jobs
 * that produced them.
 *
 * `ImageLogs` covers the build-time counterpart and needs no role. The two are
 * independent and can both be on.
 *
 * @example
 * new GithubMicrovmRunners(stack, 'Runners', {
 *   github,
 *   scope,
 *   vmExecutionRole: role,
 *   consoleLogs: ConsoleLogs.enabled(),
 * });
 */
export class ConsoleLogs {
  /**
   * Capture the runtime console. With no argument the construct creates a log
   * group and exposes it as `runners.vmConsoleLogGroup`. Pass an `ILogGroup`
   * to use one whose retention and KMS key you control. Either way the runner
   * set needs `vmExecutionRole`, and that role needs the two console-write
   * actions on the group.
   *
   * @param logGroup destination group. Omitted, the construct creates one with
   *   the runner set's `logRetention` (two weeks by default).
   *
   * @example
   * const consoleCapture = ConsoleLogs.enabled(myConsoleLogGroup);
   */
  public static enabled(logGroup?: ILogGroup): ConsoleLogs {
    return new ConsoleLogs(logGroup);
  }
  private constructor(
    /**
     * The group console output goes to, when one was passed to
     * `ConsoleLogs.enabled()`. `undefined` means the construct creates one.
     */
    public readonly logGroup?: ILogGroup,
  ) {}
}
