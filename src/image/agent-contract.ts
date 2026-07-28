/**
 * The one rule a consumer-authored Dockerfile has to satisfy: it must COPY
 * the in-VM agent that the image pipeline stages into the build context
 * under `microvm-runner/`, because that agent is what serves the MicroVM
 * lifecycle hooks. Tolerates COPY flags (e.g. `--chown=runner:runner`,
 * `--from=stage`) between `COPY` and the source path — any number of
 * `--flag value` tokens, each still requiring at least one following space
 * so a bare `--foo` isn't swallowed into the source path itself. Anchored
 * per line (`m`, no `g` — `test` is therefore stateless) so a commented-out
 * `# COPY ...` line never satisfies it.
 */
const AGENT_COPY_PATTERN =
  /^\s*COPY\s+(--\S+\s+)*\S*microvm-runner\/agent\.mjs/m;

/**
 * True when `dockerfileText` copies the in-VM agent in.
 *
 * Both consumer-authored entry points check the same rule through this one
 * predicate: `RunnerImage.fromInline()` checks the text it is handed, and
 * `ImagePipeline`'s build-context staging checks the file it reads off disk
 * for `RunnerImage.fromDockerfile()`. Each phrases its own error — the
 * paths differ — but the rule itself is defined once, here.
 */
export function dockerfileCopiesAgent(dockerfileText: string): boolean {
  return AGENT_COPY_PATTERN.test(dockerfileText);
}
