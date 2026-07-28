/**
 * Which `actions/runner` release to install on the MicroVM image.
 *
 * Build one with the static factories below; the constructor is private.
 *
 * @example
 * const pinnedImage = RunnerImage.fromOptions({
 *   runnerVersion: RunnerVersion.of('2.328.0'),
 * });
 */
export class RunnerVersion {
  /**
   * Use the `actions/runner` release this library currently pins
   * (`DEFAULT_RUNNER_VERSION`). No version is carried on the instance; the
   * image build fills the pinned value in at synth.
   *
   * @example
   * const runnerVersion = RunnerVersion.latest();
   */
  public static latest(): RunnerVersion {
    return new RunnerVersion(undefined);
  }

  /**
   * Pin an explicit `actions/runner` release, e.g. `"2.319.1"`.
   *
   * @example
   * const pinnedRunner = RunnerVersion.of('2.328.0');
   */
  public static of(version: string): RunnerVersion {
    return new RunnerVersion(version);
  }

  private constructor(
    /**
     * The pinned release, for a version built with `RunnerVersion.of()`.
     * `undefined` for `RunnerVersion.latest()`.
     */
    public readonly version?: string,
  ) {}
}
