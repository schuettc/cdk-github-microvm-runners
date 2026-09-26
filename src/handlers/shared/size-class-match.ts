/**
 * Single source of truth for "which size class serves this job".
 *
 * Match a job's requested runner labels (`runs-on`) to a configured size
 * class: the LAST size-class label (in declared object order) that also
 * appears in the job's labels, or `undefined` when none matches.
 *
 * This is shared verbatim by the launcher — which registers a JIT runner
 * carrying the job's full label set for the matched class — and the janitor's
 * queued-job-age scan, which attributes a queued job to the class that would
 * serve it. Both MUST agree, or the janitor would measure a queue the launcher
 * never drains (or ignore one it does).
 *
 * It mirrors GitHub's own label routing for the runners this construct
 * registers. The webhook enqueues a job whenever ANY of its `runs-on` labels
 * is one of this set's size-class labels (`labels.some(l => sizeClassLabels.has(l))`)
 * and carries the job's full label set; the launcher then registers a JIT
 * runner with exactly those labels, and GitHub routes the job to it because
 * the runner satisfies every requested label. So a job is served by a class as
 * long as it requests that class's label — extra labels (`linux`, `ARM64`, or
 * even another set's label) do not disqualify it, they are part of what the
 * registered runner carries.
 *
 * Convention: operators declare size classes in ascending size order, so "last
 * matching wins" implements "largest match wins if multiple size-class labels
 * are requested" — exactly the launcher's dispatch.
 */
export function matchSizeClassLabel(
  jobLabels: string[],
  sizeClassLabels: string[],
): string | undefined {
  const labelSet = new Set(jobLabels);
  let matched: string | undefined;
  for (const label of sizeClassLabels) {
    if (labelSet.has(label)) {
      matched = label;
    }
  }
  return matched;
}
