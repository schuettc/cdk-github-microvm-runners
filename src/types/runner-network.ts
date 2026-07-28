import type * as ec2 from 'aws-cdk-lib/aws-ec2';

/** Which networking mode a `RunnerNetwork` carries. */
export enum RunnerNetworkKind {
  /** Direct internet egress, with no Lambda VPC runtime connector. */
  INTERNET = 'internet',
  /** Runners attached to caller-supplied Lambda runtime connector ARNs. */
  CONNECTORS = 'connectors',
  /** Runners attached to a connector the construct builds from a CDK VPC. */
  VPC = 'vpc',
}

/** Options for `RunnerNetwork.vpc`. */
export interface RunnerNetworkVpcOptions {
  /**
   * Which of the VPC's subnets the connector's ENIs land in.
   * @default - the VPC's private-with-egress subnets (CDK's
   * `selectSubnets()` default; falls back to isolated, then public, subnets
   * if the VPC has none of the preceding kind)
   */
  readonly subnets?: ec2.SubnetSelection;
  /**
   * Security groups attached to the connector's ENIs.
   * @default - a new security group is created on the VPC
   */
  readonly securityGroups?: ec2.ISecurityGroup[];
}

/**
 * How a runner set's MicroVMs reach the network: direct internet egress,
 * Lambda VPC runtime connectors you already have, or a connector the construct
 * builds from a CDK VPC.
 *
 * Build one with the static factories below; the constructor is private.
 *
 * @example
 * new GithubMicrovmRunners(stack, 'Runners', {
 *   github,
 *   scope,
 *   network: RunnerNetwork.vpc(vpc),
 * });
 */
export class RunnerNetwork {
  /**
   * Runners egress directly to the internet (no VPC connector).
   *
   * @example
   * const network = RunnerNetwork.internetEgress();
   */
  public static internetEgress(): RunnerNetwork {
    return new RunnerNetwork(RunnerNetworkKind.INTERNET, []);
  }

  /**
   * Runners are attached to the given Lambda runtime connector ARNs.
   *
   * @example
   * const network = RunnerNetwork.vpcConnector([
   *   'arn:aws:lambda:us-east-1:111122223333:network-connector:my-connector',
   * ]);
   */
  public static vpcConnector(connectorArns: string[]): RunnerNetwork {
    if (connectorArns.length === 0) {
      throw new Error(
        'RunnerNetwork.vpcConnector() requires at least one connector ARN; use RunnerNetwork.internetEgress() for direct internet egress.',
      );
    }
    return new RunnerNetwork(RunnerNetworkKind.CONNECTORS, [...connectorArns]);
  }

  /**
   * Runners egress through a network connector the construct builds from the
   * given CDK VPC, along with the security group and the ENI-management
   * operator role that connector needs. You supply the VPC; no connector ARN
   * is required. `connectorArns` is empty on the returned instance, and the
   * construct fills in the connector's real ARN at synth.
   *
   * @example
   * const network = RunnerNetwork.vpc(vpc, {
   *   subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
   *   securityGroups: [mySecurityGroup],
   * });
   */
  public static vpc(
    vpc: ec2.IVpc,
    opts?: RunnerNetworkVpcOptions,
  ): RunnerNetwork {
    return new RunnerNetwork(
      RunnerNetworkKind.VPC,
      [],
      vpc,
      opts?.subnets,
      opts?.securityGroups ? [...opts.securityGroups] : undefined,
    );
  }

  private constructor(
    /** Which networking mode this instance carries. */
    public readonly kind: RunnerNetworkKind,
    /**
     * Runtime connector ARNs. Empty for direct internet egress, and empty for
     * a `vpc()` network until the construct builds its connector at synth.
     */
    public readonly connectorArns: string[],
    /** The VPC to build a connector from, set only for a `vpc()` network. */
    public readonly sourceVpc?: ec2.IVpc,
    /** Subnet selection for the built connector, set only for a `vpc()` network. */
    public readonly subnets?: ec2.SubnetSelection,
    /** Security groups for the built connector, set only for a `vpc()` network. */
    public readonly securityGroups?: ec2.ISecurityGroup[],
  ) {}
}
