# Warm pools

A job normally waits for a MicroVM to boot. A warm pool removes that wait by
keeping VMs booted and suspended ahead of time, so a job resumes one instead of
starting one.

A pool belongs to a runner class, and is one property:

```ts
runners.addRunnerClass('microvm', {
  size: MicrovmSize.GB4,
  warmPoolSize: 3,
});
```

That keeps three VMs of that class ready. It is a count, not a flag — classes
without `warmPoolSize` cold-launch every job, which is the default.

## What it changes

A cold launch boots a VM from the class's image, then registers a runner
against it. The warm path resumes a VM that is already booted, so the boot is
gone from the job's critical path. Resuming is the faster of the two by roughly
a factor of four, so the saving is seconds per job — worth having on a class
that runs short jobs often, and close to irrelevant on one that runs long
builds occasionally.

Nothing about the job changes. A job cannot tell which path served it, and the
image, size, and labels are the same either way. Only the wait before it starts
is different.

## How the pool stays full

Registering a class with a `warmPoolSize` adds a scheduled Lambda to the runner
set. It runs every `warmPoolInterval` (default two minutes), compares the
class's pool against its target, and boots and suspends whatever is missing.
A runner set with no warm class never creates this function at all.

When a job arrives, the launcher claims a suspended VM with a conditional write
keyed on that VM's id, so two launches arriving together cannot claim the same
one — the loser cold-launches instead. It also falls back to a cold launch when
the pool is empty, which is what happens for the first jobs after a burst
drains it and before the next sweep refills it.

That fallback means a warm pool is an optimization, never a dependency. A pool
that fails to refill costs latency, not correctness.

## What it costs

Pooled VMs are suspended, not running, and **do not count against
`maxConcurrentVms`** — the runner set's cap counts VMs in the `RUNNING` state,
which a pooled VM only enters once a job resumes it. A pool of three alongside
`maxConcurrentVms: 10` does not leave room for seven.

They are still VMs in your account, so they draw on the account's MicroVM
memory quota according to how the platform accounts for suspended VMs.
[Service quotas](service-quotas.md) covers that ceiling. Size a pool against
it: a large pool on a large size class can consume capacity that running jobs
then have to wait for.

## Whether it is working

With `emitMetrics` on, the split between the two paths is directly visible.
`warmHit` counts launches served by a pooled VM and `coldBoot` counts those
that booted one, both per runner class, so the ratio between them is how well
the pool is keeping up with arrivals. `warmSpinUpMs` and `coldSpinUpMs` are the
corresponding times.

`poolCurrent` against `poolTarget` says whether the pool is converging.
`poolCurrent` is sampled at the start of a sweep, before that sweep tops the
pool up, so it reads low for one interval after a drain and recovers on the
next — a single low sample is not a fault.

`warmThrottled` counts warm-path attempts that fell back to a cold boot. A
steady stream of those against a healthy `poolCurrent` means jobs are arriving
faster than the interval refills the pool, which is an argument for a larger
pool rather than a shorter interval.

[Monitoring](monitoring.md) has the full list and how to alarm on them.
