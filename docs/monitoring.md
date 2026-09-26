# Monitoring

Two kinds of CloudWatch metric are available.

**AWS emits metrics for the resources the construct creates** — the SQS queues
and the handler Lambdas — the way it does for any queue or function. Those are
there from the first deploy.

**The runner set emits metrics of its own** about what it did: VMs reaped,
launches served, warm-pool hits. `emitMetrics` turns those on:

```ts
new GithubMicrovmRunners(stack, 'Runners', {
  github,
  scope,
  emitMetrics: true,
});
```

## What AWS reports on its own

The queues and handler Lambdas are construct properties, so their standard
metrics are reachable from the first deploy:

```ts
runners.deadLetterQueue.metricApproximateNumberOfMessagesVisible();
runners.deadLetterQueue.metricApproximateAgeOfOldestMessage();
runners.jobQueue.metricApproximateNumberOfMessagesVisible();

runners.launcherFunction.metricErrors();
runners.launcherFunction.metricThrottles();
runners.webhookFunction.metricErrors();
runners.janitorFunction.metricErrors();
```

## What the runner set reports

With `emitMetrics` on, the handlers write to the `MicrovmRunners` namespace in
two shapes.

**Per runner set**, dimensioned by `RunnerSetId`, the janitor emits one envelope
per sweep. Two runner sets in the same account and region report separately.

| Accessor                   | Counts                                              |
| -------------------------- | --------------------------------------------------- |
| `orphansReaped()`          | running VMs with no mapping row, terminated         |
| `stuckRunnersReaped()`     | registered runners GitHub had lost track of         |
| `suspectsCleared()`        | suspicions withdrawn when a fresh read contradicted |
| `lifetimeKills()`          | VMs terminated for exceeding their lifetime         |
| `imageVersionsPruned()`    | superseded image versions removed                   |
| `tableRowsCleaned()`       | stale runner-table rows deleted                     |
| `stuckLaunchesRecovered()` | dead-lettered launches re-driven onto the queue     |
| `stuckClaimsRelaunched()`  | launch claims taken over after an attempt died      |
| `errors()`                 | failures the sweep isolated and continued past      |
| `queuedJobScanTruncated()` | 1 when a sweep hit its GitHub-listing cap mid-scan  |

**Per runner class**, dimensioned by `RunnerSetId` and `SizeClass`, the launcher
and warm pool emit one envelope per event. Each accessor takes the class label:

| Accessor                        | Reports                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `warmHit(label)`                | launches served by a pre-booted VM                           |
| `coldBoot(label)`               | launches that booted a new VM                                |
| `capacityRejected(label)`       | launches refused because the account hit its quota           |
| `cancelledBeforeLaunch(label)`  | launches skipped because the job had already stopped waiting |
| `warmThrottled(label)`          | warm-path attempts that fell back to a cold boot             |
| `warmSpinUpMs(label)`           | spin-up time on the warm path                                |
| `coldSpinUpMs(label)`           | spin-up time on the cold path                                |
| `poolCurrent(label)`            | VMs currently in the warm pool                               |
| `poolTarget(label)`             | VMs the pool is converging toward                            |
| `poolLaunched(label)`           | VMs a sweep added to the pool                                |
| `poolLaunchFailed(label)`       | pool launches that failed                                    |
| `oldestQueuedJobSeconds(label)` | seconds the class's oldest queued job has waited (0 if none) |
| `queuedJobs(label)`             | jobs this class owns that are still queued                   |

```ts
runners.metrics.capacityRejected('microvm');
runners.metrics.poolCurrent('microvm');
```

`capacityRejected` is what a runner set reports when it reaches its account's
MicroVM memory quota, or its own `maxConcurrentVms`;
[Service quotas](service-quotas.md) covers that ceiling and how to raise it.

`cancelledBeforeLaunch` counts jobs that stopped waiting for a runner before
their launch was processed — cancelled, or their run deleted. Nothing is booted
for these, so a rising count is work avoided rather than work lost. It is
routine on a repository using concurrency groups, where every re-push cancels
the run it superseded. A count that dwarfs `coldBoot` says the workflows
feeding this runner set are cancelled more often than they finish, which is
usually a question about their triggers.

The two spin-up metrics, `poolCurrent`/`poolTarget`, and
`oldestQueuedJobSeconds`/`queuedJobs` read as averages, since each reports an
absolute value; the rest are sums.

`oldestQueuedJobSeconds` and `queuedJobs` come from a read-only pass the janitor
makes over GitHub each sweep (only with `emitMetrics` on), asking how long jobs
have been waiting per class. A job counts toward a class when it requests that
class's label — the same match the launcher makes when it registers a runner
for the job, and the same routing GitHub then does (the runner carries the
job's full label set, so extra labels like `linux` or `ARM64` do not
disqualify it). A job that requests none of this set's class labels is not one
this set serves, so it does not count here. The pass is bounded per sweep and
paginates within that budget: GitHub lists runs newest-first, so it reads older
pages until the budget is spent. If the budget stops it with pages still
unread it reports `queuedJobScanTruncated` = 1 — a completed scan never
under-reports the oldest queued jobs without saying so.

## Ready-made alarms

Six methods build a `cloudwatch.Alarm` carrying a default threshold. An alarm
exists where you call one and give it a scope:

```ts
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';

const topic = new sns.Topic(stack, 'RunnerAlarms');

runners.metrics
  .deadLetterQueueNotEmptyAlarm(stack)
  .addAlarmAction(new cw_actions.SnsAction(topic));
```

`deadLetterQueueNotEmptyAlarm` watches the messages visible in the dead-letter
queue. Each one is a launch or terminate intent SQS gave up redriving, so the
job it carries waits on `recoverStuckLaunches` to re-drive it or on someone to
drain the queue. It reads an SQS metric, so it works with or without
`emitMetrics`.

`sweepErrorsAlarm` watches the janitor's `errors` counter. A non-zero value
means a sweep finished with part of the runner set's state unreconciled. It
fires only when three consecutive sweeps report an error, because one sweep
error on its own is usually transient — a GitHub API call that lost its
connection, a throttled describe — and the sweep is convergent, so the work is
retried five minutes later regardless. A real reconciliation failure (expired
credentials, a revoked App installation, a broken table) fails every sweep and
still announces itself within fifteen minutes.

`stuckLaunchesRecoveredAlarm` watches `stuckLaunchesRecovered`. The runner set
property `recoverStuckLaunches` drives that counter and is on by default, so a
non-zero value is real: recovery is working, and something upstream is losing
launches often enough to need it. Treat a persistently high count as a signal to
find that cause, not as a healthy steady state. Setting the property to false
silences the counter along with the recovery itself.

`stuckRunnersReapedAlarm` watches the janitor's `stuckRunnersReaped` counter —
runners that registered with GitHub and then went nowhere, reaped once a second
sweep saw them idle past `idleRunnerGraceSeconds`. It is the alarm for a refused
runner version (see below): it fires on a sum of 6 or more over a single
15-minute period, well above the handful a healthy set reaps and well below the
rate a refusal drives.

`capacityRejectedAlarm(scope, label)` watches one runner class's
`capacityRejected` counter — launches the MicroVM service turned away for
capacity, each a job queueing behind the account's memory quota or the set's
`maxConcurrentVms` rather than running. It fires on one rejection in each of
three consecutive 5-minute periods, so a lone burst the next launch clears does
not page. It is per class, so it takes the class label and builds its alarm
under an id unique to that label — call it once for each class you want
watched, in the same scope, and the alarms do not collide:

```ts
runners.metrics.capacityRejectedAlarm(stack, 'small');
runners.metrics.capacityRejectedAlarm(stack, 'large');
```

`queuedJobAgeAlarm(scope, label)` watches one runner class's
`oldestQueuedJobSeconds`. It is the alarm for a job that never gets a runner at
all — the failure the others structurally cannot see. The reap and
stuck-launch alarms all watch things that happen _after_ a launch: a VM that
registered and went idle, a launch that dead-lettered, an error a sweep counted.
When no launch happens in the first place — a webhook that was misrouted or
dropped, a GitHub App failure, a launch bug, or a MicroVM quota wall — there is
no VM to reap and no error to count, and the job just sits `queued` with nothing
anywhere saying so. This alarm reads the janitor's queued-job measurement and
fires when a class's oldest queued job crosses 20 minutes over a single
5-minute period (read as a maximum):

```ts
runners.metrics.queuedJobAgeAlarm(stack, 'microvm');
```

It is the one alarm here that **treats missing data as breaching**. Its metric
is emitted every sweep for every class — 0 when nothing is queued — so the
metric going absent does not mean "nothing queued", it means the janitor itself
has stopped reporting, which is its own failure worth paging on. It is per
class, so it takes the class label and builds its alarm under an id unique to
that label — call it once for each class you want watched, in the same scope,
and the alarms do not collide.

Those five read metrics the handlers emit, so they require `emitMetrics: true`
and throw at synth without it.

Each takes an optional `RunnerAlarmOptions { threshold?, evaluationPeriods?,
period? }`. The defaults are `threshold: 1`, `evaluationPeriods: 1` — 3 for the
sweep-errors, stuck-launch, and capacity-rejected alarms, all of which watch
signals that only mean something when they persist — and
`period: Duration.minutes(5)`, except `stuckRunnersReapedAlarm`, which defaults
to `threshold: 6` over `Duration.minutes(15)`, and `queuedJobAgeAlarm`, which
defaults to `threshold: 1200` (seconds). All compare with `>=` and treat missing
data as not breaching — except `queuedJobAgeAlarm`, which treats it as breaching.
Pass any of the three to change it:

```ts
runners.metrics.sweepErrorsAlarm(stack, {
  threshold: 5,
  evaluationPeriods: 2,
});
```

Each builds its alarm under a fixed construct id, so call a given one once per
scope — except `capacityRejectedAlarm` and `queuedJobAgeAlarm`, whose ids carry
the class label, so they are called once per class instead.

## What a refused runner looks like

GitHub can refuse a runner version — a runner that registers with a version
GitHub has stopped accepting is told to update and never picks up a job. The
launcher keeps launching, each VM registers, sits idle, and is reaped, and jobs
pile up behind runners that are present but useless.

It is a quiet failure. Nothing errors: launches succeed, registrations succeed,
the janitor sweeps cleanly. On 2026-09-24 a refused version drove
`stuckRunnersReaped` to 14–28 an hour for about six hours, peaking at 8–10 in a
single five-minute sweep, against a month-long baseline that never exceeded 3
in any hour — and the dead-letter, sweep-errors, and stuck-launch alarms all
stayed OK the whole time, because none of them watches this. `stuckRunnersReaped`
rising is the signal, which is what `stuckRunnersReapedAlarm` is for:

```ts
runners.metrics.stuckRunnersReapedAlarm(stack);
```

A sustained climb here means the runners this set launches are being turned
away. Check the runner version the set builds into its image against the
version GitHub currently requires, and roll the image forward if it has fallen
behind.

## Building your own

Every accessor above returns a standard `cloudwatch.Metric`, so any of them can
back an alarm:

```ts
runners.metrics
  .capacityRejected('microvm')
  .createAlarm(stack, 'QuotaRejections', {
    threshold: 1,
    evaluationPeriods: 1,
  });

runners.launcherFunction.metricErrors().createAlarm(stack, 'LauncherErrors', {
  threshold: 1,
  evaluationPeriods: 1,
});
```

They also chart, which is where the per-class metrics earn their second
dimension — one widget per runner class, or several classes on one:

```ts
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

const dashboard = new cloudwatch.Dashboard(stack, 'RunnerDashboard');

dashboard.addWidgets(
  new cloudwatch.GraphWidget({
    title: 'Warm hits vs cold boots — microvm',
    left: [
      runners.metrics.warmHit('microvm'),
      runners.metrics.coldBoot('microvm'),
    ],
  }),
  new cloudwatch.GraphWidget({
    title: 'Spin-up time',
    left: [
      runners.metrics.warmSpinUpMs('microvm'),
      runners.metrics.coldSpinUpMs('microvm'),
    ],
  }),
  new cloudwatch.GraphWidget({
    title: 'Warm pool',
    left: [
      runners.metrics.poolCurrent('microvm'),
      runners.metrics.poolTarget('microvm'),
    ],
  }),
);
```
