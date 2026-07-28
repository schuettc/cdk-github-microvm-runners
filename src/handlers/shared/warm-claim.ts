/**
 * Warm-VM claim primitive — a single conditional write on the runner table
 * (`RUNNER_TABLE`) that lets exactly one caller "win" a specific, already
 * running warm-pool MicroVM before handing it a job.
 *
 * Row shape: `{ runnerName: "warmvm#<microvmId>", expiresAt }`, keyed on the
 * SAME `runnerName` partition key the launcher's runner-mapping and
 * launch-claim rows use (see `launcher.ts`'s `acquireLaunchClaim` /
 * `claimItem` / `commitLaunch`), so this reuses the existing table and TTL
 * attribute (`expiresAt`) rather than adding a new one.
 *
 * The `warmvm#` prefix is deliberately disjoint from every other key shape
 * already living in that partition space, so a claim row can never collide
 * with:
 *  - a real runner-mapping row (`microvm-runner-...`, `RUNNER_NAME_PREFIX`
 *    in `runner-naming.ts`),
 *  - a janitor orphan row (`orphan-vm-<microvmId>`, `ORPHAN_ROW_PREFIX` in
 *    `janitor.ts`), or
 *  - a launcher launch-claim row (`job#<repo>#<jobId>`, `CLAIM_ROW_PREFIX`
 *    in `launcher.ts`).
 *
 * The conditional `PutItem` (`attribute_not_exists(runnerName)`) is a
 * one-shot claim, unlike `acquireLaunchClaim`'s stale-lease takeover dance —
 * a warm-VM claim only needs "first writer wins"; there is no owner
 * identity to hand off, so losing simply means someone else already claimed
 * this VM and the caller should fall back to a cold launch.
 */
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

/** Partition-key prefix for warm-VM claim rows. See module doc for why this can never collide with runner-mapping, orphan, or launch-claim rows. */
const WARM_CLAIM_PREFIX = 'warmvm#';

let cachedDdbClient: DynamoDBClient | undefined;

/** Test-only: clear the module-level cached client between test cases. */
export function _resetCachesForTesting(): void {
  cachedDdbClient = undefined;
}

function ddbClient(): DynamoDBClient {
  if (!cachedDdbClient) {
    cachedDdbClient = new DynamoDBClient({});
  }
  return cachedDdbClient;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `warm-claim: missing required environment variable ${name}`,
    );
  }
  return value;
}

/**
 * Attempt to claim a specific warm-pool MicroVM by `microvmId`. Returns
 * `true` when this call won the claim (first writer), `false` when a claim
 * for the same `microvmId` already exists (`ConditionalCheckFailedException`
 * — someone else got there first). Any other DynamoDB error propagates to
 * the caller.
 */
export async function claimWarmVm(p: {
  microvmId: string;
  nowMs: number;
  ttlSeconds: number;
}): Promise<boolean> {
  const tableName = requireEnv('RUNNER_TABLE');
  const expiresAt = Math.floor(p.nowMs / 1000) + p.ttlSeconds;
  try {
    await ddbClient().send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          runnerName: `${WARM_CLAIM_PREFIX}${p.microvmId}`,
          expiresAt,
        }),
        ConditionExpression: 'attribute_not_exists(runnerName)',
      }),
    );
    return true;
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === 'ConditionalCheckFailedException'
    ) {
      return false;
    }
    throw err;
  }
}
