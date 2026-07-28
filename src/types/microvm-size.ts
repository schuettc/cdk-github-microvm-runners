/**
 * The memory a MicroVM runs with.
 *
 * Each runner class picks one preset, and that preset becomes the memory floor
 * of the image the class builds. Pick from the static presets below; the
 * constructor is private.
 *
 * A preset is a **floor, not an allocation**. It is the minimum the image is
 * built with, and the platform provisions above it — measured at roughly four
 * times the request, so a class on `GB1` has been observed booting with about
 * 4 GB and 2 vCPU, and one on `GB4` with about 16 GB and 8 vCPU. Two things
 * follow: a workload usually fits a smaller preset than its memory figure
 * suggests, and the account's memory quota is charged the measured allocation
 * rather than the floor. The service quotas guide carries the arithmetic.
 *
 * vCPU and disk follow from the preset and are not separately settable — the
 * image resource takes a memory floor and nothing else.
 *
 * @example
 * runners.addRunnerClass('microvm-8gb', { size: MicrovmSize.GB8 });
 */
export class MicrovmSize {
  /** Memory floor of 0.5 GB. */
  public static readonly GB0_5 = new MicrovmSize(0.5);
  /** Memory floor of 1 GB. */
  public static readonly GB1 = new MicrovmSize(1);
  /** Memory floor of 2 GB. */
  public static readonly GB2 = new MicrovmSize(2);
  /** Memory floor of 4 GB. */
  public static readonly GB4 = new MicrovmSize(4);
  /** Memory floor of 8 GB. */
  public static readonly GB8 = new MicrovmSize(8);

  /** Memory in MiB, the unit the MicroVM image's `minimumMemoryInMiB` takes. */
  public readonly memoryMib: number;

  private constructor(
    /** Memory floor in GB. */
    public readonly memoryGb: number,
  ) {
    this.memoryMib = memoryGb * 1024;
  }
}
