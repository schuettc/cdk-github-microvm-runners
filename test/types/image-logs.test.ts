import { Stack } from 'aws-cdk-lib';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { ImageLogs } from '../../src/types/image-logs.js';

describe('ImageLogs', () => {
  it('enabled() with no group', () => {
    expect(ImageLogs.enabled().logGroup).toBeUndefined();
  });
  it('enabled(group) carries the group', () => {
    const g = new LogGroup(new Stack(), 'G');
    expect(ImageLogs.enabled(g).logGroup).toBe(g);
  });
});
