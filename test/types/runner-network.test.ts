import { App, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {
  RunnerNetwork,
  RunnerNetworkKind,
} from '../../src/types/runner-network.js';

function newVpc(): { stack: Stack; vpc: ec2.Vpc } {
  const stack = new Stack(new App(), 'TestStack');
  const vpc = new ec2.Vpc(stack, 'Vpc');
  return { stack, vpc };
}

describe('RunnerNetwork', () => {
  it('internetEgress() has an empty connectorArns list and kind INTERNET', () => {
    const network = RunnerNetwork.internetEgress();
    expect(network.connectorArns).toEqual([]);
    expect(network.kind).toBe(RunnerNetworkKind.INTERNET);
  });

  it('vpcConnector() carries the given connector ARNs and kind CONNECTORS', () => {
    const arns = [
      'arn:aws:lambda:us-east-1:111111111111:runtime-connector:conn-1',
    ];
    const network = RunnerNetwork.vpcConnector(arns);
    expect(network.connectorArns).toEqual(arns);
    expect(network.kind).toBe(RunnerNetworkKind.CONNECTORS);
  });

  it('vpcConnector() rejects an empty ARN list', () => {
    expect(() => RunnerNetwork.vpcConnector([])).toThrow(/at least one/);
  });

  it('vpc() carries the vpc + selection (subnets, security groups) and kind VPC', () => {
    const { stack, vpc } = newVpc();
    const sg = new ec2.SecurityGroup(stack, 'Sg', { vpc });
    const subnets: ec2.SubnetSelection = {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    };

    const network = RunnerNetwork.vpc(vpc, {
      subnets,
      securityGroups: [sg],
    });

    expect(network.kind).toBe(RunnerNetworkKind.VPC);
    expect(network.sourceVpc).toBe(vpc);
    expect(network.subnets).toBe(subnets);
    expect(network.securityGroups).toEqual([sg]);
    // Not yet resolved to a real connector ARN — that only happens once the
    // construct materializes the CfnNetworkConnector at synth.
    expect(network.connectorArns).toEqual([]);
  });

  it('vpc() with no opts carries the vpc alone', () => {
    const { vpc } = newVpc();
    const network = RunnerNetwork.vpc(vpc);
    expect(network.kind).toBe(RunnerNetworkKind.VPC);
    expect(network.sourceVpc).toBe(vpc);
    expect(network.subnets).toBeUndefined();
    expect(network.securityGroups).toBeUndefined();
  });
});
