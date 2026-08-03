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

**Per runner class**, dimensioned by `RunnerSetId` and `SizeClass`, the launcher
and warm pool emit one envelope per event. Each accessor takes the class label:

| Accessor                       | Reports                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `warmHit(label)`               | launches served by a pre-booted VM                           |
| `coldBoot(label)`              | launches that booted a new VM                                |
| `capacityRejected(label)`      | launches refused because the account hit its quota           |
| `cancelledBeforeLaunch(label)` | launches skipped because the job had already stopped waiting |
| `warmThrottled(label)`         | warm-path attempts that fell back to a cold boot             |
| `warmSpinUpMs(label)`          | spin-up time on the warm path                                |
| `coldSpinUpMs(label)`          | spin-up time on the cold path                                |
| `poolCurrent(label)`           | VMs currently in the warm pool                               |
| `poolTarget(label)`            | VMs the pool is converging toward                            |
| `poolLaunched(label)`          | VMs a sweep added to the pool                                |
| `poolLaunchFailed(label)`      | pool launches that failed                                    |

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

The two spin-up metrics and `poolCurrent`/`poolTarget` read as averages, since
each reports an absolute value; the rest are sums.

## Ready-made alarms

Three methods build a `cloudwatch.Alarm` carrying a default threshold. An alarm
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

Those two read metrics the handlers emit, so they require `emitMetrics: true`
and throw at synth without it.

Each takes an optional `RunnerAlarmOptions { threshold?, evaluationPeriods?,
period? }`. The defaults are `threshold: 1`, `evaluationPeriods: 1` — 3 for the
sweep-errors and stuck-launch alarms, both of which watch signals that only
mean something when they persist — and `period: Duration.minutes(5)`, compared
with `>=`, with missing data treated as not breaching. Pass any of the three to
change it:

```ts
runners.metrics.sweepErrorsAlarm(stack, {
  threshold: 5,
  evaluationPeriods: 2,
});
```

Each builds its alarm under a fixed construct id, so call a given one once per
scope.

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
