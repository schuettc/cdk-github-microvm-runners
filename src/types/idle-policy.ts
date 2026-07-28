import type { Duration } from 'aws-cdk-lib';

/**
 * When the platform suspends and resumes a runner class's cold-launched VMs.
 *
 * This mirrors the MicroVM service's own `idlePolicy` shape, expressed as
 * `Duration`s rather than raw seconds. Set it on a runner class through
 * `RunnerClassProps.idlePolicy`.
 */
export interface MicrovmIdlePolicy {
  /** Idle time before the platform auto-suspends the VM. */
  readonly maxIdleDuration: Duration;
  /**
   * How long a suspended VM is kept before the platform terminates it.
   *
   * Required. The MicroVM service rejects a launch whose idle policy omits
   * this value, and it offers no value meaning "keep the suspended VM
   * indefinitely", so every idle policy names a duration.
   */
  readonly suspendedDuration: Duration;
  /** Auto-resume the VM on activity. @default false */
  readonly autoResume?: boolean;
}
