# Service quotas: sizing a runner set for concurrency and launch rate

AWS Lambda MicroVMs is a quota-gated service. Account-level quotas set how many
runners a runner set can run at once and how quickly it can start them, and new
accounts are provisioned below the AWS published defaults, so those ceilings
come into play as soon as more than one job runs at a time.

## The quotas that gate a runner set

All three live under the **Lambda** service in Service Quotas. Each is held per
account and per region, so raise it in every region a runner set runs in.

| Quota                                     | Code         | AWS default | What it caps                                                                                                         |
| ----------------------------------------- | ------------ | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| **Max allocated memory**                  | `L-CD1C0CC4` | 1024 GB     | Total memory summed across **all running MicroVMs** in the account and region. This is the real concurrency ceiling. |
| **Rate of RunMicrovm API requests**       | `L-535CA9B6` | 5 /sec      | Sustained launch rate — how many runners you can start per second.                                                   |
| **Burst rate of RunMicrovm API requests** | `L-91B95582` | 5 /sec      | Burst launch rate — at a burst of `1`, launches admit one at a time, so simultaneous arrivals queue.                 |

In the Service Quotas console, find the memory quota by its name, `Max
allocated memory`, or by its code, `L-CD1C0CC4`.

## How allocated memory is counted

The memory quota counts each VM at its **actual** allocated memory, and the
platform over-provisions every VM to **~4× its requested size class** — a `GB1`
VM comes up with ~4 GB kernel-visible, a `GB4` with ~16 GB.

Admission is strict-exceeds: a new launch is blocked only while the account's
actual allocated memory **already exceeds** the quota (`>`, not `≥`), so a
launch that lands the total exactly _at_ the quota still admits.

The ceiling that follows is **`quota ÷ (4 × requested size)`**, so **4×
over-provisioning quarters a frozen quota**. The boundary observations behind
this rule come from a single run, the `>`-versus-`≥` edge is inferred rather
than directly observed, and the 4× factor may be capacity-dependent.

## Reaching the memory quota

When a launch would push total running memory past **Max allocated memory**,
the platform rejects it:

```
ServiceQuotaExceededException: The base maximum allocated memory limit
has been reached for this account.
```

The launcher's message stays on the queue and is retried, and the janitor
re-drives anything that dead-letters. The job serializes, waiting until a
running VM frees enough
memory. What clears it is more concurrent capacity: a higher quota, or smaller
VMs, so more fit in the same memory budget.

## Mapping the memory quota to `maxConcurrentVms`

`maxConcurrentVms` (default `10`) caps how many MicroVMs the runner set will run
at once, across all runner classes. The memory quota sets the effective ceiling,
measured against each VM's **actual** (~4× requested) allocation, so the quota
has to cover the **worst-case mix at 4×**:

```
Max allocated memory (GB)  ≥  Σ over concurrent VMs of (4 × that VM's class size, GB)  +  headroom
```

For a single-class runner set that's `maxConcurrentVms × 4 × class size`. The
same over-provisioning decides which preset a workload needs in the first
place, which [Runner images](images.md) covers. Size classes, requested vs.
what actually lands:

| `MicrovmSize` | Requested (GB) | Actual ~4× (GB) |
| ------------- | -------------- | --------------- |
| `GB0_5`       | 0.5            | ~2              |
| `GB1`         | 1              | ~4              |
| `GB2`         | 2              | ~8              |
| `GB4`         | 4              | ~16             |
| `GB8`         | 8              | ~32             |

As a worked example, `maxConcurrentVms: 10` on `GB4` needs
`10 × 16 = 160 GB` of _Max allocated memory_, plus headroom, because a VM being
torn down still counts until it's fully gone. The AWS default of 1024 GB covers
that; on a throttled **8 GB** account a single `GB4` (≈16 GB actual) already
exceeds the quota and monopolizes the runner set until it exits.

With `maxConcurrentVms` set above what the memory quota covers, the quota is
what binds: launches past it fail with the error above and serialize.

## When the quota is frozen: split by memory profile

A quota increase is not always granted. On an account held at a low memory
quota, the lever left is the size class — smaller VMs, so more of them fit
under the same ceiling. But do not size a whole gate down on the assumption
that it is uniformly small: measure each step's peak memory first, because a
gate is often bimodal rather than big.

One production gate, measured: strict mypy over 306 files peaked at 443 MB,
while the pytest battery in the same gate peaked near 4 GiB. Sizing the whole
gate down to `GB1` would have run the tests out of memory; keeping it whole on
`GB4` made every lint-only run pay the big VM's footprint — and on that
account's frozen 8 GB quota, a single `GB4` at ~16 GB actual monopolizes the
runner set. The fix was two runner classes: lint and type-checking on `GB1`,
tests on `GB4`, each job routed by its label. The small jobs then run two or
three wide among themselves instead of competing for the big slots, and the
repository gains a fast required check — about three minutes — alongside the
long one.

## Running near capacity

When the runner set is at `maxConcurrentVms`, or against the memory quota, a new
launch is re-queued and retried until a slot frees. Those capacity retries share
the dead-letter queue's redrive budget (`maxReceiveCount`, default **20**,
tunable), so a launch that keeps hitting a full runner set across ~20 redrives,
each after the 180s visibility timeout, will eventually dead-letter — roughly a
**1-hour** saturation window at the default.

Three things matter for a runner set expected to run sustained at capacity.
Raising `maxReceiveCount` gives genuine saturation a longer queue wait before a
launch dead-letters. `recoverStuckLaunches`, on by default, re-drives any launch
that does dead-letter during a long saturation or a GitHub outage, once its job
is launchable again; turn it off and a dead-lettered launch waits in the
dead-letter queue until you drain it yourself. The third is capacity itself,
which under a fixed memory quota means moving to a smaller size class.

## Checking your quotas

Per account/region, with your CLI profile:

```bash
for code in L-CD1C0CC4 L-535CA9B6 L-91B95582; do
  aws service-quotas get-service-quota \
    --service-code lambda --quota-code "$code" \
    --profile "$PROFILE" --region "$REGION" \
    --query 'Quota.{Name:QuotaName,Applied:Value}' --output json
done
```

Compare `Applied` against the defaults in the table above. Anything below
default is a candidate to raise.
