import {
  RunnerToolchain,
  ToolchainKind,
} from '../../src/image/runner-toolchain.js';

describe('RunnerToolchain', () => {
  it('python() sets kind + version', () => {
    const t = RunnerToolchain.python('3.12.7');
    expect(t.kind).toBe(ToolchainKind.PYTHON);
    expect(t.version).toBe('3.12.7');
  });

  it('node() sets kind + version', () => {
    const t = RunnerToolchain.node('22.11.0');
    expect(t.kind).toBe(ToolchainKind.NODE);
    expect(t.version).toBe('22.11.0');
  });

  it.each(['3.12', '20', 'latest', '3.12.x', '', 'v3.12.7'])(
    'rejects non-full-semver %j',
    (bad) => {
      expect(() => RunnerToolchain.python(bad)).toThrow(/full semver/);
      expect(() => RunnerToolchain.node(bad)).toThrow(/full semver/);
    },
  );
});
