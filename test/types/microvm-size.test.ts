import { MicrovmSize } from '../../src/types/microvm-size.js';

describe('MicrovmSize', () => {
  // memoryMib is the only value that leaves this class: the image pipeline
  // sends it as the resource's `minimumMemoryInMiB` and nothing else.
  it.each([
    ['GB0_5', MicrovmSize.GB0_5, 0.5, 512],
    ['GB1', MicrovmSize.GB1, 1, 1024],
    ['GB2', MicrovmSize.GB2, 2, 2048],
    ['GB4', MicrovmSize.GB4, 4, 4096],
    ['GB8', MicrovmSize.GB8, 8, 8192],
  ])('%s carries its memory floor in both units', (_n, size, gb, mib) => {
    expect(size.memoryGb).toBe(gb);
    expect(size.memoryMib).toBe(mib);
  });

  it('exposes nothing the image resource cannot take', () => {
    // vcpu and diskGb used to be here. The platform derives both from the
    // memory floor — `run-microvm` accepts neither — so publishing them
    // invited a consumer to set a number that reaches nothing.
    expect(Object.keys(MicrovmSize.GB1)).toEqual(['memoryGb', 'memoryMib']);
  });
});
