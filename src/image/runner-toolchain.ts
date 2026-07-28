/** How a toolchain is installed into the image's hosted tool cache. */
export enum ToolchainKind {
  /** CPython, built from source (`configure --prefix … --enable-shared`) on AL2023. */
  PYTHON = 'python',
  /** Node.js, unpacked from the official nodejs.org linux-arm64 tarball. */
  NODE = 'node',
}

/**
 * A language runtime baked into the runner image's hosted tool cache at
 * `/opt/hostedtoolcache`, where `actions/setup-python` and `actions/setup-node`
 * find it without downloading anything. Those actions otherwise fetch
 * OS-specific prebuilt runtimes, which are not published for the AL2023 image
 * these runners use.
 *
 * Several versions can be baked in at once, and a workflow asking for
 * `python-version: "3.12"` matches a baked `3.12.7`.
 *
 * Build one with the static factories below; the constructor is private.
 *
 * @example
 * const testImage = RunnerImage.fromOptions({
 *   toolchains: [
 *     RunnerToolchain.python('3.12.7'),
 *     RunnerToolchain.node('22.11.0'),
 *   ],
 * });
 */
export class RunnerToolchain {
  /**
   * CPython, built from source. `version` is a full semver, e.g. `'3.12.7'`.
   *
   * @example
   * const python = RunnerToolchain.python('3.12.7');
   */
  public static python(version: string): RunnerToolchain {
    return new RunnerToolchain(ToolchainKind.PYTHON, version);
  }

  /**
   * Node.js, from the official arm64 tarball. Full semver, e.g. `'22.11.0'`.
   *
   * @example
   * const node = RunnerToolchain.node('22.11.0');
   */
  public static node(version: string): RunnerToolchain {
    return new RunnerToolchain(ToolchainKind.NODE, version);
  }

  private constructor(
    /** Which runtime this is. */
    public readonly kind: ToolchainKind,
    /** The full semver release baked in, e.g. `'3.12.7'`. */
    public readonly version: string,
  ) {
    // Pinned full semver only — the cache directory name IS the version, and a
    // partial/floating spec can't name a directory. See the design doc.
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(
        `RunnerToolchain: version must be a full semver like '3.12.7', got '${version}'.`,
      );
    }
  }
}
