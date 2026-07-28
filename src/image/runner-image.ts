import { createHash } from 'node:crypto';
import { dockerfileCopiesAgent } from './agent-contract.js';
import {
  computeContentHash,
  normalizeImageOptions,
  renderDockerfile,
  type ImageAsset,
  type RunnerImageOptions,
} from './dockerfile-template.js';

export type { ImageAsset, RunnerImageOptions };

/**
 * The image a runner class's VMs boot from: one this library synthesizes, or
 * one you author yourself.
 *
 * Build one with the static factories below; the constructor is private.
 *
 * @example
 * runners.addRunnerClass('build', {
 *   size: MicrovmSize.GB4,
 *   image: RunnerImage.fromOptions({
 *     systemPackages: ['jq', 'ripgrep'],
 *   }),
 * });
 */
export class RunnerImage {
  /**
   * Synthesize a Dockerfile from `opts` — extra packages, setup commands,
   * assets, environment variables, toolchains, and the `actions/runner`
   * release to install. The image's `contentHash` is computed here, over the
   * rendered Dockerfile text and the list of assets it copies.
   *
   * @example
   * const buildImage = RunnerImage.fromOptions({
   *   systemPackages: ['jq', 'ripgrep'],
   *   setupCommands: ['npm install -g pnpm@10'],
   *   environment: { LANG: 'C.UTF-8' },
   *   toolchains: [RunnerToolchain.python('3.12.7')],
   * });
   */
  public static fromOptions(opts: RunnerImageOptions = {}): RunnerImage {
    const normalized = normalizeImageOptions(opts);
    const dockerfile = renderDockerfile(normalized);
    return new RunnerImage(
      computeContentHash(dockerfile, normalized),
      dockerfile,
      undefined,
      normalized.assets,
      normalized.additionalOsCapabilities,
    );
  }

  /**
   * Use your own Dockerfile, and the build context around it, from the
   * directory `dir`. The whole directory is staged as the Docker build
   * context, so a Dockerfile that needs to `COPY` files of its own belongs
   * here rather than in `RunnerImage.fromInline`.
   *
   * The `contentHash` recorded on the returned instance is derived from the
   * path string. The directory's actual contents are read and hashed later,
   * when the image pipeline stages them as a CDK asset.
   *
   * A relative `dir` is resolved against the process working directory, which
   * is wherever `cdk` was invoked. Anchor it to the file that declares the
   * runner class instead by passing `path.join(__dirname, 'runner-image')`.
   *
   * @example
   * const customImage = RunnerImage.fromDockerfile('runner-image');
   */
  public static fromDockerfile(dir: string): RunnerImage {
    return new RunnerImage(
      createHash('sha256').update(dir).digest('hex'),
      undefined,
      dir,
      undefined,
      ['ALL'],
    );
  }

  /**
   * Use your own Dockerfile, supplied as text. The text is staged verbatim as
   * the build context's `Dockerfile`, alongside the `microvm-runner/`
   * directory the image pipeline injects and nothing else. A Dockerfile that
   * needs to `COPY` files of its own belongs with
   * `RunnerImage.fromDockerfile`, which stages a whole directory.
   *
   * The text must `COPY microvm-runner/agent.mjs` and start the staged
   * entrypoint, because that agent is what serves the MicroVM lifecycle hooks
   * the platform calls. This is checked here, and a Dockerfile that does not
   * copy the agent throws.
   *
   * The `contentHash` recorded on the returned instance is a sha256 over the
   * supplied text.
   *
   * @example
   * const inlineImage = RunnerImage.fromInline(`
   * FROM public.ecr.aws/lambda/microvms:al2023-minimal
   *
   * RUN dnf install -y git jq
   *
   * COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs
   * COPY microvm-runner/entrypoint.sh /opt/microvm-runner/entrypoint.sh
   * ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]
   * `);
   */
  public static fromInline(dockerfile: string): RunnerImage {
    if (!dockerfileCopiesAgent(dockerfile)) {
      throw new Error(
        'RunnerImage.fromInline: the Dockerfile text must COPY the in-VM agent — expected a line referencing "microvm-runner/agent.mjs" (e.g. "COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs"). Consumer-authored images still need the agent to serve the MicroVM lifecycle hooks.',
      );
    }
    return new RunnerImage(
      createHash('sha256').update(dockerfile).digest('hex'),
      dockerfile,
      undefined,
      undefined,
      ['ALL'],
    );
  }

  private constructor(
    /**
     * sha256 content hash, part of the built image's name. For
     * `fromOptions()` it covers the rendered Dockerfile and the options that
     * produced it; for `fromInline()`, the supplied Dockerfile text; for
     * `fromDockerfile()`, the directory path.
     */
    public readonly contentHash: string,
    /**
     * Dockerfile text: rendered for `fromOptions()`, supplied by you for
     * `fromInline()`. `undefined` for `fromDockerfile()`, whose Dockerfile
     * lives on disk under `dockerfileDir`.
     */
    public readonly dockerfile?: string,
    /**
     * The directory holding your own Dockerfile and build context. Set for
     * `fromDockerfile()`, `undefined` for `fromOptions()` and `fromInline()`,
     * which both carry their Dockerfile as `dockerfile` text.
     */
    public readonly dockerfileDir?: string,
    /**
     * The `{source, target}` pairs from `RunnerImageOptions.assets`. Set for
     * `fromOptions()`, whose rendered Dockerfile copies each one into the
     * image. `undefined` for `fromDockerfile()`, which stages your whole
     * directory instead, and for `fromInline()`, whose build context holds
     * the Dockerfile and the injected agent and nothing else.
     */
    public readonly assets?: ImageAsset[],
    /**
     * Extra Linux capabilities granted to the MicroVM's operating system.
     * `fromOptions()` takes this from `RunnerImageOptions`; `fromDockerfile()`
     * and `fromInline()` always carry `['ALL']`.
     */
    public readonly additionalOsCapabilities: string[] = ['ALL'],
  ) {}
}
