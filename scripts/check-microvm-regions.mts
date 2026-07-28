#!/usr/bin/env -S npx tsx
// check-microvm-regions — keeps SUPPORTED_REGIONS in src/regions.ts current.
//
// AWS Lambda MicroVMs launched 2026-06-22, and the global-infrastructure SSM
// tree (`/aws/service/global-infrastructure/services/<slug>/regions`) still has
// no microvms service slug — verified during the design spikes and re-checked
// here — so there is no SSM signal for "where is MicroVMs available." The
// canonical fallback (also spike-verified) is a read-only API probe:
// ListManagedMicrovmImages returns 200 in a region that supports MicroVMs, and
// a 403 whose body is a routing-level <AccessDenied> (endpoint doesn't resolve)
// in a region that doesn't.
//
// This script enumerates every AWS region (from the public SSM regions
// parameter), probes each, and diffs the supported set against the hard-coded
// SUPPORTED_REGIONS. It is the single source of truth's freshness gate: run it
// weekly in CI, and let a non-zero exit be the staleness alarm.
//
// Exit codes:
//   0  SUPPORTED_REGIONS matches reality — nothing to do.
//   1  a delta was found (a region gained or lost MicroVMs support) — update
//      src/regions.ts. The report names exactly what to change.
//   2  the probe itself was unreliable (missing IAM permission, auth failure,
//      or transient errors) — this is NOT a staleness verdict; fix the probe.
//
// Requires AWS credentials with `ssm:GetParametersByPath` (public parameters)
// and `lambda-microvms:ListManagedMicrovmImages`. Region-agnostic; the SSM
// enumeration call uses us-east-1.
//
// Run locally:  npx tsx scripts/check-microvm-regions.mts
// In CI:        see .github/workflows/region-watch.yml

import { SSMClient, paginateGetParametersByPath } from '@aws-sdk/client-ssm';
import {
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
} from '@aws-sdk/client-lambda-microvms';
import { SUPPORTED_REGIONS } from '../src/regions';

type Probe =
  | { region: string; verdict: 'supported' }
  | { region: string; verdict: 'unsupported' }
  | { region: string; verdict: 'inconclusive'; detail: string };

/**
 * All AWS *commercial*-partition regions, from the public global-infrastructure
 * param. China (`cn-*`), GovCloud/ISO (`us-gov-*`, `us-iso*`), and EU Sovereign
 * Cloud (`eusc-*`, on `amazonaws.eu`) live in separate partitions with their
 * own endpoints and credentials — unreachable from a commercial caller (DNS
 * won't even resolve) and out of scope for the commercial SUPPORTED_REGIONS
 * list — so they're filtered out here.
 */
async function allRegions(): Promise<string[]> {
  const ssm = new SSMClient({ region: 'us-east-1' });
  const regions: string[] = [];
  for await (const page of paginateGetParametersByPath(
    { client: ssm },
    { Path: '/aws/service/global-infrastructure/regions' },
  )) {
    for (const p of page.Parameters ?? []) {
      if (p.Value && /^(?!cn-|us-gov-|us-iso|eusc-)/.test(p.Value)) {
        regions.push(p.Value);
      }
    }
  }
  return [...new Set(regions)].sort();
}

/**
 * Probe one region. Three outcomes:
 *   - `supported`   — 200: MicroVMs is available.
 *   - `unsupported` — a 403 whose body is a routing-level <AccessDenied> the
 *     SDK can't parse as JSON (verified: this is exactly what both true
 *     non-MicroVMs regions AND disabled opt-in regions return — the API gives
 *     no way to tell them apart; see the opt-in caveat in main()).
 *   - `inconclusive` — anything else: a proper AccessDeniedException (endpoint
 *     exists but our IAM lacks the action), an auth failure, or a timeout. We
 *     must NOT collapse these into `unsupported`, or a missing permission or a
 *     transient network hang would masquerade as regions dropping support.
 *     Note in particular that the 12s abort routes here, not to `unsupported`:
 *     a slow/hung endpoint is "couldn't tell," never "not available."
 */
async function probe(region: string): Promise<Probe> {
  // maxAttempts: 1 is essential — the SDK treats the <AccessDenied> JSON
  // deserialization failure as retryable and would otherwise back off and
  // retry it three times per unsupported region, hanging the whole sweep.
  // Cross-region transient flakiness is handled instead by main()'s single
  // retry pass over inconclusive regions. A hard 12s abort backstops any
  // endpoint that neither answers nor rejects promptly.
  const client = new LambdaMicrovmsClient({ region, maxAttempts: 1 });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    await client.send(new ListManagedMicrovmImagesCommand({}), {
      abortSignal: ac.signal,
    });
    return { region, verdict: 'supported' };
  } catch (e: unknown) {
    const err = e as {
      name?: string;
      message?: string;
      $metadata?: { httpStatusCode?: number };
    };
    const status = err.$metadata?.httpStatusCode;
    const msg = err.message ?? '';
    const endpointAbsent =
      status === 403 &&
      (err.name === 'SyntaxError' ||
        /not valid JSON/i.test(msg) ||
        /Unable to determine service\/operation/i.test(msg));
    if (endpointAbsent) return { region, verdict: 'unsupported' };
    return {
      region,
      verdict: 'inconclusive',
      detail:
        err.name === 'AbortError'
          ? 'timeout after 12s'
          : `${err.name ?? 'Error'}${status ? ` (${status})` : ''}: ${msg.slice(0, 100)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe a list of regions with bounded concurrency. */
async function probeAll(regions: string[]): Promise<Probe[]> {
  const results: Probe[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < regions.length; i += CONCURRENCY) {
    const batch = regions.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map(probe))));
  }
  return results;
}

async function main(): Promise<number> {
  const regions = await allRegions();
  console.log(`Probing ${regions.length} AWS regions for Lambda MicroVMs…\n`);

  // First pass, then a single retry over just the inconclusive regions —
  // enough to shed a one-off timeout/network blip without reintroducing the
  // SDK's SyntaxError-retry hang (retries here are one extra attempt total,
  // not per-region backoff).
  const verdict = new Map<string, Probe>();
  for (const r of await probeAll(regions)) verdict.set(r.region, r);
  const retryRegions = [...verdict.values()]
    .filter((r) => r.verdict === 'inconclusive')
    .map((r) => r.region);
  if (retryRegions.length) {
    console.log(
      `Re-probing ${retryRegions.length} inconclusive region(s) once: ${retryRegions.join(', ')}\n`,
    );
    for (const r of await probeAll(retryRegions)) verdict.set(r.region, r);
  }

  const results = [...verdict.values()];
  const declared = new Set(SUPPORTED_REGIONS);
  const supported = new Set(
    results.filter((r) => r.verdict === 'supported').map((r) => r.region),
  );
  const inconclusive = results.filter(
    (r) => r.verdict === 'inconclusive',
  ) as Extract<Probe, { detail: string }>[];

  console.log(
    `Supported per probe (${supported.size}): ${[...supported].sort().join(', ')}`,
  );
  console.log(
    `Declared in src/regions.ts (${declared.size}): ${[...declared].sort().join(', ')}\n`,
  );

  // A region we DECLARE that we couldn't probe conclusively is a real failure:
  // we ship it but can't verify it still has MicroVMs. This is also how the
  // missing-IAM-permission case surfaces — every supported region (declared
  // ones included) returns AccessDeniedException → inconclusive → here. A
  // region we DON'T declare that came back inconclusive is only a coverage
  // gap: we can't confirm support so we won't (falsely) alarm on it — log it
  // and move on, so one persistently-slow opt-in region can't hold the gate red.
  const declaredInconclusive = inconclusive.filter((r) =>
    declared.has(r.region),
  );
  const otherInconclusive = inconclusive.filter((r) => !declared.has(r.region));
  if (otherInconclusive.length) {
    console.log(
      `Note — ${otherInconclusive.length} non-declared region(s) could not be ` +
        `probed conclusively (treated as no-signal, not an alarm):`,
    );
    for (const r of otherInconclusive)
      console.log(`  ${r.region}: ${r.detail}`);
    console.log('');
  }
  if (declaredInconclusive.length) {
    console.error(
      `✗ Probe unreliable for ${declaredInconclusive.length} DECLARED region(s) — ` +
        `cannot verify a region we ship. NOT a staleness verdict; check the ` +
        `credentials have lambda-microvms:ListManagedMicrovmImages.\n`,
    );
    for (const r of declaredInconclusive)
      console.error(`  ${r.region}: ${r.detail}`);
    return 2;
  }

  const newlyAvailable = [...supported].filter((r) => !declared.has(r)).sort();
  // A declared region only counts as dropped if we CONCLUSIVELY saw it
  // unsupported — declaredInconclusive is already handled (exit 2) above.
  const dropped = results
    .filter((r) => r.verdict === 'unsupported' && declared.has(r.region))
    .map((r) => r.region)
    .sort();

  if (!newlyAvailable.length && !dropped.length) {
    console.log('✓ SUPPORTED_REGIONS is current. Nothing to change.');
    console.log(
      '\nNote: a disabled opt-in region is indistinguishable from an ' +
        'unsupported one at the API level. To detect a MicroVMs launch in an ' +
        'opt-in region, that region must be enabled in the probe account.',
    );
    return 0;
  }

  console.error('✗ SUPPORTED_REGIONS is stale — update src/regions.ts:\n');
  if (newlyAvailable.length) {
    console.error(
      `  ADD (MicroVMs now available, not yet declared):\n    ${newlyAvailable.join(', ')}`,
    );
  }
  if (dropped.length) {
    console.error(
      `  REVIEW (declared but the probe no longer sees support):\n    ${dropped.join(', ')}`,
    );
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`\n✗ region check failed to run: ${e?.message ?? e}`);
    process.exit(2);
  });
