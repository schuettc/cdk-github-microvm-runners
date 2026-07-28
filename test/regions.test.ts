import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { SUPPORTED_REGIONS, validateRegion } from '../src/regions.js';

describe('validateRegion', () => {
  it('throws on a known-unsupported concrete region', () => {
    const stack = new Stack(new App(), 'S', {
      env: { region: 'eu-central-1' },
    });
    expect(() => validateRegion(stack, stack.region, [])).toThrow(
      /eu-central-1.*not.*Lambda MicroVMs.*additionalRegions/s,
    );
  });

  it('accepts an additionalRegions escape hatch', () => {
    const stack = new Stack(new App(), 'S', {
      env: { region: 'eu-central-1' },
    });
    expect(() =>
      validateRegion(stack, stack.region, ['eu-central-1']),
    ).not.toThrow();
  });

  it('accepts a concrete supported region without warning or throwing', () => {
    const stack = new Stack(new App(), 'S', { env: { region: 'us-east-1' } });
    expect(() => validateRegion(stack, stack.region, [])).not.toThrow();
    Annotations.fromStack(stack).hasNoWarning('*', Match.anyValue());
  });

  it('warns, not throws, when region is unresolved', () => {
    const app = new App();
    const stack = new Stack(app, 'S'); // env-agnostic -> token
    expect(() => validateRegion(stack, stack.region, [])).not.toThrow();
    Annotations.fromStack(stack).hasWarning(
      '*',
      Match.stringLikeRegexp('Lambda MicroVMs is only available in'),
    );
  });

  it('exposes all launch regions', () => {
    expect(SUPPORTED_REGIONS).toHaveLength(5);
    expect(SUPPORTED_REGIONS).toEqual([
      'us-east-1',
      'us-east-2',
      'us-west-2',
      'eu-west-1',
      'ap-northeast-1',
    ]);
  });
});
