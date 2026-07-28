/**
 * Shared CloudWatch Embedded Metric Format (EMF) emitter.
 *
 * A single `console.log` JSON envelope encodes both the EMF metadata
 * (`_aws.CloudWatchMetrics`) CloudWatch Logs uses to extract metrics, and the
 * plain top-level fields (dimension values + metric values) that make the
 * same log line readable as structured JSON. Generalized from janitor.ts's
 * original inline `emitMetrics` so every handler that emits metrics (janitor,
 * launcher, ...) writes byte-for-byte the same envelope shape.
 *
 * Emission is OPT-IN, gated on the `EMIT_METRICS` env var
 * (`GithubMicrovmRunnersProps.emitMetrics`, default off — CloudWatch bills
 * custom metrics per metric per month). The gate lives HERE, at the single
 * choke point every handler's metric emission funnels through, rather than at
 * the three call sites (`janitor.ts`'s `emitMetrics`, `launcher.ts`'s
 * `emitLaunchMetrics`, `warm-pool.ts`'s `emitPoolMetrics`): with one gate on
 * the only function that writes the envelope, no path — existing or
 * future — can escape it, and a caller that forgets to check its own flag
 * cannot bypass it. The check reads `process.env` directly and is cheap and
 * side-effect free, so it costs nothing on the disabled default.
 */
export function emitEmf(p: {
  namespace: string;
  dimensions: string[];
  dimensionValues: Record<string, string>;
  metrics: Record<string, number>;
  timestamp: number;
  unit?: string;
  /**
   * Optional per-metric unit override (metric name -> CloudWatch unit).
   * EMF natively supports a distinct `Unit` per entry in `Metrics[]`; this
   * lets a single envelope mix, e.g., a `Milliseconds` latency metric
   * alongside `Count` counters. A metric not present in `units` falls back
   * to `unit` (or `'Count'`) exactly as before, so every existing caller
   * that never sets `units` (the janitor) is unaffected.
   */
  units?: Record<string, string>;
}): void {
  // The opt-in gate (see this module's doc). Off by default: write nothing at
  // all — not even the structured log line — so a runner set that never set
  // `emitMetrics` is billed for zero custom metrics.
  if (!metricsEnabled()) {
    return;
  }
  const defaultUnit = p.unit ?? 'Count';
  const metricNames = Object.keys(p.metrics);
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: p.timestamp,
        CloudWatchMetrics: [
          {
            Namespace: p.namespace,
            Dimensions: [p.dimensions],
            Metrics: metricNames.map((name) => ({
              Name: name,
              Unit: p.units?.[name] ?? defaultUnit,
            })),
          },
        ],
      },
      ...p.dimensionValues,
      ...p.metrics,
    }),
  );
}

/**
 * The opt-in metric gate itself (see this module's doc): `true` only when the
 * construct wired `EMIT_METRICS=true`, i.e. the runner set set
 * `GithubMicrovmRunnersProps.emitMetrics`. Exported as a named predicate so
 * the gate has one spelling; {@link emitEmf} is the only production caller —
 * handlers must never re-implement the check, they simply call `emitEmf` and
 * let it decide.
 */
export function metricsEnabled(): boolean {
  return process.env.EMIT_METRICS === 'true';
}
