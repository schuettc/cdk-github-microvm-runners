const OWNER_REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** Which GitHub scope a `RunnerScope` represents. */
export enum RunnerScopeKind {
  /** Runners are registered at the organization level. */
  ORG = 'org',
  /** Runners are registered against an explicit list of repositories. */
  REPOS = 'repos',
  /** Runners are registered at the organization level, in each of several organizations. */
  ORGS = 'orgs',
}

/**
 * Which GitHub scope registered runners are visible to: an entire
 * organization, several organizations, or an explicit list of `owner/repo`
 * repositories.
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
    return new RunnerScope(RunnerScopeKind.ORG, org, undefined, undefined);
  }

  /**
   * Runners are registered at the organization level in each listed
   * organization: one runner set serving several organizations. A job's
   * runner registers in the organization that owns the job's repository.
   *
   * Install the runner set's GitHub App on every listed organization. A
   * runner class on this scope cannot set `warmPoolSize`; that throws at
   * synth.
   *
   * @example
   * const multiOrgScope = RunnerScope.orgs(['my-org', 'my-other-org']);
   */
  public static orgs(orgs: string[]): RunnerScope {
    if (orgs.length === 0) {
      throw new Error('RunnerScope.orgs() requires at least one organization.');
    }
    for (const org of orgs) {
      if (org.length === 0 || /[/\s]/.test(org)) {
        throw new Error(
          `Invalid organization "${org}": expected an organization login, with no "/" or whitespace.`,
        );
      }
    }
    return new RunnerScope(RunnerScopeKind.ORGS, undefined, undefined, [
      ...orgs,
    ]);
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
    return new RunnerScope(
      RunnerScopeKind.REPOS,
      undefined,
      [...repos],
      undefined,
    );
  }

  // The instance properties cannot share a name with the static factories
  // above: jsii rejects the assembly with JSII5013. The factories are the
  // documented API and keep their names; these carry the longer form. The
  // wire format below is unaffected.
  private constructor(
    /** Whether this scope is an organization, several organizations, or a list of repositories. */
    public readonly kind: RunnerScopeKind,
    /** The organization, for a scope built with `RunnerScope.org()`. */
    public readonly organization?: string,
    /** The `owner/repo` list, for a scope built with `RunnerScope.repos()`. */
    public readonly repositories?: string[],
    /** The organizations, for a scope built with `RunnerScope.orgs()`. */
    public readonly organizations?: string[],
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
      orgs: this.organizations,
    });
  }
}
