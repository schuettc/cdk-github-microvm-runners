import { matchSizeClassLabel } from '../../../src/handlers/shared/size-class-match.js';

describe('matchSizeClassLabel', () => {
  it('matches a job that requests only self-hosted + the class label', () => {
    expect(matchSizeClassLabel(['self-hosted', 'bh-small'], ['bh-small'])).toBe(
      'bh-small',
    );
  });

  it('matches when the job also requests OS/arch labels the set does not register', () => {
    // The launcher registers a runner carrying the full label set, so GitHub
    // routes the job as long as the class label is present.
    expect(
      matchSizeClassLabel(
        ['self-hosted', 'linux', 'ARM64', 'bh-small'],
        ['bh-small'],
      ),
    ).toBe('bh-small');
  });

  it('matches on the presence of a class label even alongside a foreign label (e.g. gpu)', () => {
    expect(
      matchSizeClassLabel(['self-hosted', 'small', 'gpu'], ['small', 'large']),
    ).toBe('small');
  });

  it('resolves two size-class labels to the LAST declared match (largest wins)', () => {
    expect(
      matchSizeClassLabel(
        ['self-hosted', 'small', 'large'],
        ['small', 'large'],
      ),
    ).toBe('large');
    // Declaration order is what decides, not the order in the job labels.
    expect(
      matchSizeClassLabel(
        ['self-hosted', 'large', 'small'],
        ['small', 'large'],
      ),
    ).toBe('large');
  });

  it('returns undefined when the job requests no size-class label', () => {
    expect(matchSizeClassLabel(['self-hosted'], ['small', 'large'])).toBe(
      undefined,
    );
    expect(
      matchSizeClassLabel(['self-hosted', 'gpu'], ['small', 'large']),
    ).toBe(undefined);
  });
});
