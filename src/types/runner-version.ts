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
   * This is the library's pinned default, not GitHub's latest release. The
   * library bumps the pin as releases ship, because GitHub stops queuing jobs
   * to a runner more than 30 days behind the newest release; see "Keeping the
   * runner current" in `docs/images.md`.
   *
   * @example
   * const runnerVersion = RunnerVersion.libraryDefault();
   */
  public static libraryDefault(): RunnerVersion {
    return new RunnerVersion(undefined);
  }

  /**
   * Use the `actions/runner` release this library currently pins
   * (`DEFAULT_RUNNER_VERSION`).
   *
   * @deprecated returns the library's pinned default, not GitHub's latest
   * release; use `libraryDefault()` or `of()`.
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
     * `undefined` for `RunnerVersion.libraryDefault()`.
     */
    public readonly version?: string,
  ) {}
}
