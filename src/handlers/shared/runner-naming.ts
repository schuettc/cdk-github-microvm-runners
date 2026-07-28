/**
 * Shared runner-name prefix for the launcher, janitor, and webhook handlers.
 *
 * `launcher.ts` GENERATES runner names (`${RUNNER_NAME_PREFIX}-${runnerSetId}-<uuid>`);
 * `janitor.ts` and `webhook.ts` MATCH against that same prefix when filtering
 * `listRunners` results / deciding whether a `completed` webhook's
 * `runner_name` belongs to this runner set. Previously each file re-hardcoded the
 * literal `'microvm-runner'` independently, which let generation and
 * matching silently diverge. This module is the single source of truth —
 * zero runtime imports, so pulling it into `webhook.ts` (deliberately thin,
 * no AWS SDK calls beyond its webhook-secret fetch and SQS send) never drags
 * in `launcher.ts`'s or `janitor.ts`'s heavier AWS-SDK dependency graph.
 */

/** Prefix for generated runner names. */
export const RUNNER_NAME_PREFIX = 'microvm-runner';
