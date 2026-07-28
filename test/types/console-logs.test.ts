import { Stack } from 'aws-cdk-lib';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { ConsoleLogs } from '../../src/types/console-logs.js';

describe('ConsoleLogs', () => {
  it('enabled() with no group', () => {
    expect(ConsoleLogs.enabled().logGroup).toBeUndefined();
  });
  it('enabled(group) carries the group', () => {
    const g = new LogGroup(new Stack(), 'G');
    expect(ConsoleLogs.enabled(g).logGroup).toBe(g);
  });
});
