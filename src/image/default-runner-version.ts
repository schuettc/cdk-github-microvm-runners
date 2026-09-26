/**
 * The `actions/runner` release this library pins. An image built with
 * `RunnerVersion.libraryDefault()`, or with no runner version at all, installs
 * this release. `RunnerVersion.of()` pins a different one.
 *
 * GitHub requires each new `actions/runner` release to be installed within 30
 * days of publication or it stops queuing jobs to that runner
 * (https://github.blog/changelog/2026-06-12-github-actions-minimum-version-enforcement-timeline-for-self-hosted-runners/),
 * so this pin is bumped as releases ship. See "Keeping the runner current" in
 * `docs/images.md`.
 */
export const DEFAULT_RUNNER_VERSION = '2.337.0';
