import { Annotations, Token } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * AWS regions where Lambda MicroVMs is available.
 */
export const SUPPORTED_REGIONS: string[] = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'eu-west-1',
  'ap-northeast-1',
];

/**
 * Validate that `region` supports Lambda MicroVMs.
 *
 * - If `region` is an unresolved CDK token (env-agnostic stack), synth-time
 *   validation is impossible: emit an `Annotations` warning instead of
 *   throwing.
 * - If `region` is a concrete string not in `SUPPORTED_REGIONS` and not in
 *   `additionalRegions`, throw.
 */
export function validateRegion(
  scope: Construct,
  region: string,
  additionalRegions: string[],
): void {
  if (Token.isUnresolved(region)) {
    Annotations.of(scope).addWarning(
      'Region is unresolved at synth; Lambda MicroVMs is only available in: ' +
        SUPPORTED_REGIONS.join(', '),
    );
    return;
  }
  if (
    !SUPPORTED_REGIONS.includes(region) &&
    !additionalRegions.includes(region)
  ) {
    throw new Error(
      `Region ${region} is not a Lambda MicroVMs region (${SUPPORTED_REGIONS.join(', ')}). ` +
        `If MicroVMs launched there recently, pass additionalRegions: ['${region}'].`,
    );
  }
}
