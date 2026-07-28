const OWNER_REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** Which GitHub scope a `RunnerScope` represents. */
export enum RunnerScopeKind {
  /** Runners are registered at the organization level. */
  ORG = 'org',
  /** Runners are registered against an explicit list of repositories. */
  REPOS = 'repos',
}

/**
 * Which GitHub scope registered runners are visible to: an entire
 * organization, or an explicit list of `owner/repo` repositories.
 *
 * Build one with the static factories below; the constructor is private.
 *
 * @example
 * const orgScope = RunnerScope.org('my-org');
 */
export class RunnerScope {
  /**
   * Runners are registered at the organization level.
   *
   * @example
   * const orgScope = RunnerScope.org('my-org');
   */
  public static org(org: string): RunnerScope {
    return new RunnerScope(RunnerScopeKind.ORG, org, undefined);
  }

  /**
   * Runners are registered against an explicit list of `owner/repo` repos.
   *
   * @example
   * const repoScope = RunnerScope.repos(['my-org/api', 'my-org/web']);
   */
  public static repos(repos: string[]): RunnerScope {
    if (repos.length === 0) {
      throw new Error('RunnerScope.repos() requires at least one repository.');
    }
    for (const repo of repos) {
      if (!OWNER_REPO_PATTERN.test(repo)) {
        throw new Error(
          `Invalid repository "${repo}": expected the "owner/repo" format.`,
        );
      }
    }
    return new RunnerScope(RunnerScopeKind.REPOS, undefined, [...repos]);
  }

  // The instance properties cannot share a name with the static factories
  // above: jsii rejects the assembly with JSII5013. The factories are the
  // documented API and keep their names; these carry the longer form. The
  // wire format below is unaffected.
  private constructor(
    /** Whether this scope is an organization or a list of repositories. */
    public readonly kind: RunnerScopeKind,
    /** The organization, for a scope built with `RunnerScope.org()`. */
    public readonly organization?: string,
    /** The `owner/repo` list, for a scope built with `RunnerScope.repos()`. */
    public readonly repositories?: string[],
  ) {}

  /**
   * Serialize this scope to the JSON form the runner set's handlers read at
   * runtime.
   */
  public toJson(): string {
    return JSON.stringify({
      kind: this.kind,
      org: this.organization,
      repos: this.repositories,
    });
  }
}
