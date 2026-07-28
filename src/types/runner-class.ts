import type { MicrovmIdlePolicy } from './idle-policy.js';
import type { MicrovmSize } from './microvm-size.js';
import type { ImagePipeline } from '../image/image-pipeline.js';
import type { RunnerImage } from '../image/runner-image.js';

/** Props for `GithubMicrovmRunners.addRunnerClass`. */
export interface RunnerClassProps {
  /** VM memory floor for this class. */
  readonly size: MicrovmSize;
  /** Image this class builds from. @default RunnerImage.fromOptions() */
  readonly image?: RunnerImage;
  /**
   * How many pre-booted, suspended VMs to keep ready for this class. A job
   * that matches this class resumes one of them instead of cold-launching a
   * new VM, and falls back to a cold launch when none is available. This is a
   * count, not a flag: `warmPoolSize: 3` keeps three VMs ready. The runner set
   * refills the pool on the `warmPoolInterval` schedule.
   * @default undefined (no warm pool; every job cold-launches)
   */
  readonly warmPoolSize?: number;
  /**
   * Auto-suspend and auto-resume policy for this class's cold-launched VMs.
   * Mutually exclusive with `warmPoolSize` on the same class, since both drive
   * the VM's suspended state; setting both throws at `addRunnerClass` time.
   * @default undefined (no idle policy; the platform never auto-suspends)
   */
  readonly idlePolicy?: MicrovmIdlePolicy;
}

/** Handle returned by `GithubMicrovmRunners.addRunnerClass`. */
export interface RunnerClass {
  /** The `runs-on` label workflows target to run on this class. */
  readonly label: string;
  /** The VM memory floor this class launches at. */
  readonly size: MicrovmSize;
  /** The image pipeline that builds and publishes this class's MicroVM image. */
  readonly imagePipeline: ImagePipeline;
  /** ARN of this class's built MicroVM image (a CloudFormation token at synth). */
  readonly imageArn: string;
}
