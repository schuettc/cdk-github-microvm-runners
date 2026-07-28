import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import { claimWarmVm } from '../../../src/handlers/shared/warm-claim.js';

const ddbMock = mockClient(DynamoDBClient);

const RUNNER_TABLE = 'runners-runner-set-x-runners';
const MICROVM_ID = 'mvm-abc123';
const NOW_MS = Date.parse('2026-07-21T12:00:00.000Z');

describe('claimWarmVm', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.RUNNER_TABLE = RUNNER_TABLE;
  });

  it('wins the claim on the first attempt and returns true', async () => {
    ddbMock.on(PutItemCommand).resolves({});

    const result = await claimWarmVm({
      microvmId: MICROVM_ID,
      nowMs: NOW_MS,
      ttlSeconds: 300,
    });

    expect(result).toBe(true);
    const calls = ddbMock.commandCalls(PutItemCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0].input;
    expect(input?.TableName).toBe(RUNNER_TABLE);
    expect(input?.ConditionExpression).toBe('attribute_not_exists(runnerName)');
    expect(input?.Item).toEqual(
      marshall({
        runnerName: `warmvm#${MICROVM_ID}`,
        expiresAt: Math.floor(NOW_MS / 1000) + 300,
      }),
    );
  });

  it('returns false when a claim for the same microvmId already exists (ConditionalCheckFailedException)', async () => {
    ddbMock.on(PutItemCommand).callsFake((input) => {
      if (input.ConditionExpression === 'attribute_not_exists(runnerName)') {
        throw Object.assign(new Error('claim exists'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      return {};
    });

    const result = await claimWarmVm({
      microvmId: MICROVM_ID,
      nowMs: NOW_MS,
      ttlSeconds: 300,
    });

    expect(result).toBe(false);
  });
});
