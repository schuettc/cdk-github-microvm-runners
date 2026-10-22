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
gone from the job's critical path.

The saving is the boot, and only the boot. Measured on a bench runner, the
launcher's own slice — enqueue through to the VM running — came out at 6.3–9.0 s
warm against 3.8–7.2 s cold. Those ranges overlap on small samples, so treat the
warm path as removing boot from the critical path rather than as a fixed
multiple faster. Everything after the VM is running is unchanged: the runner
still starts and registers per job, which is most of the wait either way. See
[Start latency](architecture.md#start-latency) for where the time actually
goes.

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

## How long a pooled VM lasts

Every MicroVM carries a platform lifetime cap, fixed when the VM is created and
never changeable afterwards — `ResumeMicrovm` takes only a VM id, and the
service has no update call. The clock runs from creation, and it keeps running
while the VM sits suspended in the pool.

So a pooled VM is created with the platform's **maximum** lifetime of eight
hours rather than the job budget a cold launch uses. That is deliberate: were a
pooled VM capped at `maxJobDuration` plus its grace, the time it spent waiting
in the pool would come out of the job's budget, and a VM claimed near the end of
that window would be terminated part-way through the job it had just accepted.

Two things follow, both automatic:

- The sweep **retires a pooled VM once its remaining lifetime can no longer
  cover a full `maxJobDuration`**, and refills the slot. Retired VMs do not
  count toward the pool's target, so `poolCurrent` reflects VMs that can
  actually take a job.
- The launcher **skips any pooled VM without the budget to outlive the job**
  and cold-launches instead, logging the skip. This is a backstop for the
  window between sweeps.

The same two places also retire and skip a pooled VM built from a **superseded
image version**. An image keeps its name when its contents change (see
[Images](images.md)), so its ARN stays the same across rebuilds, and a VM
suspended before a deploy would otherwise still look like a match afterwards
and run a job on the previous image. Version equality is what actually
establishes that a pooled VM carries the image the deploy published.

With the default two-minute interval you will not normally see either. Both
matter when a pool has been sitting idle for hours — after a quiet weekend, say
— which is exactly when a stale VM would otherwise be claimed.

Because the cap is the platform maximum, the platform's own runaway-job guard
is looser on a warm VM than a cold one. The janitor's lifetime sweep, which
works from the runner record rather than the VM, is what still bounds a job
that hangs.

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
