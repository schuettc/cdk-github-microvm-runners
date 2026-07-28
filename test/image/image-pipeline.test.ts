import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { ImagePipeline } from '../../src/image/image-pipeline.js';
import { RunnerImage } from '../../src/image/runner-image.js';
import { ImageLogs } from '../../src/types/image-logs.js';
import { MicrovmSize } from '../../src/types/microvm-size.js';
import { RunnerNetwork } from '../../src/types/runner-network.js';

/** A fresh `App` synthesizing into its own throwaway temp `outdir`, so tests can inspect staged asset contents in `cdk.out` without colliding with each other. */
function newApp(): { app: App; outdir: string } {
  const outdir = mkdtempSync(join(tmpdir(), 'synth-'));
  return { app: new App({ outdir }), outdir };
}

function newStack(app: App): Stack {
  return new Stack(app, 'TestStack');
}

/** Recursively find a staged `asset.*` directory under `outdir` that contains a `Dockerfile` — i.e. our `Code` asset's staging dir. */
function findStagedImageAssetDir(outdir: string): string {
  for (const entry of readdirSync(outdir)) {
    const full = join(outdir, entry);
    if (
      entry.startsWith('asset.') &&
      statSync(full).isDirectory() &&
      existsSync(join(full, 'Dockerfile'))
    ) {
      return full;
    }
  }
  throw new Error(
    `no staged asset dir with a Dockerfile found under ${outdir}`,
  );
}

describe('ImagePipeline (RunnerImage.fromOptions())', () => {
  it('creates a AWS::Lambda::MicrovmImage with the spike-verified property shapes', () => {
    const { app } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB4,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    app.synth();
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      AdditionalOsCapabilities: ['ALL'],
      CpuConfigurations: [{ Architecture: 'ARM_64' }],
      Resources: [{ MinimumMemoryInMiB: 4096 }],
      EgressNetworkConnectors: [],
      Hooks: {
        Port: 8080,
        MicrovmImageHooks: Match.objectLike({
          Ready: 'ENABLED',
          ReadyTimeoutInSeconds: 300,
          Validate: 'DISABLED',
        }),
        MicrovmHooks: Match.objectLike({
          Run: 'ENABLED',
          RunTimeoutInSeconds: 60,
        }),
      },
      Logging: { CloudWatch: {} },
      Name: Match.stringLikeRegexp('^runners-dev-[0-9a-f]{8}$'),
    });
  });

  it('derives BaseImageArn from the stack region token, never a hardcoded literal', () => {
    const { app } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    const template = Template.fromStack(stack);
    const resources = template.findResources('AWS::Lambda::MicrovmImage');
    const [logicalId] = Object.keys(resources);
    const baseImageArn = resources[logicalId].Properties.BaseImageArn;

    // Must resolve via a CFN intrinsic referencing AWS::Region, not a plain string.
    expect(typeof baseImageArn).not.toBe('string');
    expect(JSON.stringify(baseImageArn)).toContain('AWS::Region');
    const joinParts = baseImageArn['Fn::Join'][1];
    expect(joinParts[0]).toBe('arn:aws:lambda:');
    expect(joinParts[joinParts.length - 1]).toBe(':aws:microvm-image:al2023-1');
  });

  it('respects an explicit baseImageVersion, readyTimeoutSeconds, and runTimeoutSeconds', () => {
    const { app } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB2,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
      baseImageVersion: '1',
      readyTimeoutSeconds: 120,
      runTimeoutSeconds: 45,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      BaseImageVersion: '1',
      Hooks: Match.objectLike({
        MicrovmImageHooks: Match.objectLike({ ReadyTimeoutInSeconds: 120 }),
        MicrovmHooks: Match.objectLike({ RunTimeoutInSeconds: 45 }),
      }),
    });
  });

  it('defaults baseImageVersion to "0" when unset', () => {
    const { app } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    Template.fromStack(stack).hasResourceProperties(
      'AWS::Lambda::MicrovmImage',
      {
        BaseImageVersion: '0',
      },
    );
  });

  it('wires egressNetworkConnectors from RunnerNetwork.vpcConnector', () => {
    const { app } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.vpcConnector([
        'arn:aws:lambda:us-east-1:111111111111:runtime-connector/abc',
      ]),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    Template.fromStack(stack).hasResourceProperties(
      'AWS::Lambda::MicrovmImage',
      {
        EgressNetworkConnectors: [
          'arn:aws:lambda:us-east-1:111111111111:runtime-connector/abc',
        ],
      },
    );
  });

  it('creates a build role trusted by lambda.amazonaws.com with both sts:AssumeRole and sts:TagSession', () => {
    const { app } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
          }),
          Match.objectLike({
            Action: 'sts:TagSession',
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  it('scopes the build role logs grants to the MicroVMs log-group prefix, not the whole account', () => {
    const { app } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    const template = Template.fromStack(stack);
    const policies = template.findResources('AWS::IAM::Policy');
    const logsStatement = Object.values(policies)
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .find(
        (s: { Action?: string[] }) =>
          Array.isArray(s.Action) && s.Action.includes('logs:CreateLogGroup'),
      );
    expect(logsStatement).toBeDefined();
    expect(logsStatement.Resource).toHaveLength(2);
    for (const r of logsStatement.Resource) {
      expect(JSON.stringify(r)).toContain('log-group:/aws/lambda-microvms/');
    }
  });

  it('grants the build role s3:GetObject* read access to the staged code asset', () => {
    const { app } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:GetObject*']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('stages Dockerfile + microvm-runner/agent.mjs + microvm-runner/entrypoint.sh in the code asset staging dir', () => {
    const { app, outdir } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    app.synth();

    const assetDir = findStagedImageAssetDir(outdir);
    expect(existsSync(join(assetDir, 'Dockerfile'))).toBe(true);
    expect(existsSync(join(assetDir, 'microvm-runner', 'agent.mjs'))).toBe(
      true,
    );
    expect(existsSync(join(assetDir, 'microvm-runner', 'entrypoint.sh'))).toBe(
      true,
    );
  });

  it('stages consumer assets under assets/<index>/, matching the Dockerfile COPY lines', () => {
    const { app, outdir } = newApp();
    const stack = newStack(app);

    const assetSrcDir = mkdtempSync(join(tmpdir(), 'runners-consumer-asset-'));
    writeFileSync(join(assetSrcDir, 'hello.txt'), 'hi');

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions({
        assets: [{ source: assetSrcDir, target: '/opt/extra' }],
      }),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    app.synth();

    const assetDir = findStagedImageAssetDir(outdir);
    expect(existsSync(join(assetDir, 'assets', '0', 'hello.txt'))).toBe(true);
  });

  it('stages a single-file asset source (not just directories) under assets/<index>/', () => {
    const { app, outdir } = newApp();
    const stack = newStack(app);

    const assetSrcDir = mkdtempSync(join(tmpdir(), 'runners-consumer-file-'));
    const assetSrcFile = join(assetSrcDir, 'single.txt');
    writeFileSync(assetSrcFile, 'solo');

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions({
        assets: [{ source: assetSrcFile, target: '/opt/single.txt' }],
      }),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    app.synth();

    const assetDir = findStagedImageAssetDir(outdir);
    expect(existsSync(join(assetDir, 'assets', '0', 'single.txt'))).toBe(true);
  });

  it('exposes imageArn as the CfnMicrovmImage ImageArn attribute, imageName, imageResource, and buildRole', () => {
    const { app } = newApp();
    const stack = newStack(app);

    const pipeline = new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    expect(pipeline.imageResource).toBeInstanceOf(lambda.CfnMicrovmImage);
    expect(pipeline.imageArn).toBe(pipeline.imageResource.attrImageArn);
    expect(pipeline.imageName).toMatch(/^runners-dev-[0-9a-f]{8}$/);
    expect(pipeline.buildRole.roleArn).toBeDefined();
  });

  it('wires custom additionalOsCapabilities to the CfnMicrovmImage resource', () => {
    const { app } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions({
        additionalOsCapabilities: ['NET_ADMIN'],
      }),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    Template.fromStack(stack).hasResourceProperties(
      'AWS::Lambda::MicrovmImage',
      {
        AdditionalOsCapabilities: ['NET_ADMIN'],
      },
    );
  });
});

describe('ImagePipeline: logging', () => {
  it('omitting imageLogs sets Logging: { Disabled: true } on the CfnMicrovmImage', () => {
    const { app } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      runnerSetId: 'runners-dev',
    });

    Template.fromStack(stack).hasResourceProperties(
      'AWS::Lambda::MicrovmImage',
      {
        Logging: { Disabled: true },
      },
    );
  });

  it('ImageLogs.enabled(logGroup) sets Logging.CloudWatch.LogGroup and grants the build role write access', () => {
    const { app } = newApp();
    const stack = newStack(app);
    const logGroup = new logs.LogGroup(stack, 'CustomLogGroup');

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(logGroup),
      runnerSetId: 'runners-dev',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      Logging: {
        CloudWatch: Match.objectLike({
          LogGroup: { Ref: Match.stringLikeRegexp('CustomLogGroup') },
        }),
      },
    });

    // The image build role is granted write access to the custom log group:
    // a logs:PutLogEvents-carrying statement (plus friends) whose Resource
    // references the custom log group's own construct (via an Fn::Join
    // wrapping its Fn::GetAtt Arn, `grantWrite`'s standard shape) — distinct
    // from the build role's own hardcoded /aws/lambda-microvms/* policy
    // statement, which targets a literal ARN prefix string.
    const policies = template.findResources('AWS::IAM::Policy');
    const customGroupGrant = Object.values(policies).find((p) =>
      p.Properties.PolicyDocument.Statement.some(
        (s: { Action?: string | string[]; Resource?: unknown }) =>
          Array.isArray(s.Action) &&
          s.Action.includes('logs:PutLogEvents') &&
          JSON.stringify(s.Resource).includes('CustomLogGroup'),
      ),
    );
    expect(customGroupGrant).toBeDefined();
  });

  it('ImageLogs.enabled() with no explicit logGroup does not grant the build role any extra log-group access (nothing to grant)', () => {
    const { app } = newApp();
    const stack = newStack(app);

    const pipeline = new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromOptions(),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-dev',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      Logging: { CloudWatch: {} },
    });
    // No Fn::GetAtt-based logs:PutLogEvents grant — the only logs statement
    // is the build role's own hardcoded /aws/lambda-microvms/* prefix grant.
    const policies = template.findResources('AWS::IAM::Policy');
    const putLogEventsStatements = Object.values(policies)
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter(
        (s: { Action?: string | string[] }) =>
          Array.isArray(s.Action) && s.Action.includes('logs:PutLogEvents'),
      );
    expect(putLogEventsStatements).toHaveLength(1);
    expect(pipeline.buildRole).toBeDefined();
  });
});

describe('ImagePipeline (RunnerImage.fromInline())', () => {
  const INLINE_DOCKERFILE = [
    'FROM public.ecr.aws/lambda/microvms:al2023-minimal',
    'RUN dnf install -y git',
    'COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs',
    'COPY microvm-runner/entrypoint.sh /opt/microvm-runner/entrypoint.sh',
    'ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]',
  ].join('\n');

  it('stages the inline text verbatim as the Dockerfile, plus the injected microvm-runner/ agent files', () => {
    const { app, outdir } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromInline(INLINE_DOCKERFILE),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-inline',
    });

    app.synth();

    const assetDir = findStagedImageAssetDir(outdir);
    expect(readFileSync(join(assetDir, 'Dockerfile'), 'utf8')).toBe(
      INLINE_DOCKERFILE,
    );
    expect(existsSync(join(assetDir, 'microvm-runner', 'agent.mjs'))).toBe(
      true,
    );
    expect(existsSync(join(assetDir, 'microvm-runner', 'entrypoint.sh'))).toBe(
      true,
    );
  });

  it('stages nothing else: the build context is the Dockerfile and the agent directory', () => {
    const { app, outdir } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromInline(INLINE_DOCKERFILE),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-inline',
    });

    app.synth();

    const assetDir = findStagedImageAssetDir(outdir);
    expect(readdirSync(assetDir).sort()).toEqual([
      'Dockerfile',
      'microvm-runner',
    ]);
    expect(readdirSync(join(assetDir, 'microvm-runner')).sort()).toEqual([
      'agent.mjs',
      'entrypoint.sh',
    ]);
  });

  it('creates the MicrovmImage resource, named for the runner set and the content hash', () => {
    const { app } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromInline(INLINE_DOCKERFILE),
      size: MicrovmSize.GB2,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-inline',
    });

    app.synth();
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      AdditionalOsCapabilities: ['ALL'],
      CpuConfigurations: [{ Architecture: 'ARM_64' }],
      Resources: [{ MinimumMemoryInMiB: 2048 }],
      Name: Match.stringLikeRegexp('^runners-inline-[0-9a-f]{8}$'),
    });
  });

  it('a different inline Dockerfile produces a different image Name', () => {
    function imageNameFor(dockerfile: string): string {
      const { app } = newApp();
      const stack = newStack(app);
      const pipeline = new ImagePipeline(stack, 'Pipeline', {
        image: RunnerImage.fromInline(dockerfile),
        size: MicrovmSize.GB1,
        network: RunnerNetwork.internetEgress(),
        imageLogs: ImageLogs.enabled(),
        runnerSetId: 'runners-inline',
      });
      return pipeline.imageName;
    }

    expect(imageNameFor(INLINE_DOCKERFILE)).toBe(
      imageNameFor(INLINE_DOCKERFILE),
    );
    expect(imageNameFor(INLINE_DOCKERFILE)).not.toBe(
      imageNameFor(INLINE_DOCKERFILE.replace('git', 'jq')),
    );
  });
});

describe('ImagePipeline (RunnerImage.fromDockerfile())', () => {
  function writeDockerfile(dir: string, contents: string): void {
    writeFileSync(join(dir, 'Dockerfile'), contents);
  }

  it('stages the consumer dir as-is plus the injected microvm-runner/ agent files', () => {
    const consumerDir = mkdtempSync(join(tmpdir(), 'byo-'));
    writeDockerfile(
      consumerDir,
      [
        'FROM public.ecr.aws/lambda/microvms:al2023-minimal',
        'COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs',
        'COPY microvm-runner/entrypoint.sh /opt/microvm-runner/entrypoint.sh',
        'ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]',
      ].join('\n'),
    );
    mkdirSync(join(consumerDir, 'extra'));
    writeFileSync(join(consumerDir, 'extra', 'file.txt'), 'x');

    const { app, outdir } = newApp();
    const stack = newStack(app);

    new ImagePipeline(stack, 'Pipeline', {
      image: RunnerImage.fromDockerfile(consumerDir),
      size: MicrovmSize.GB1,
      network: RunnerNetwork.internetEgress(),
      imageLogs: ImageLogs.enabled(),
      runnerSetId: 'runners-byo',
    });

    app.synth();

    const assetDir = findStagedImageAssetDir(outdir);
    expect(existsSync(join(assetDir, 'Dockerfile'))).toBe(true);
    expect(existsSync(join(assetDir, 'microvm-runner', 'agent.mjs'))).toBe(
      true,
    );
    expect(existsSync(join(assetDir, 'microvm-runner', 'entrypoint.sh'))).toBe(
      true,
    );
    expect(existsSync(join(assetDir, 'extra', 'file.txt'))).toBe(true);
  });

  it('throws a clear synth error when the consumer Dockerfile is missing the microvm-runner/agent.mjs COPY line', () => {
    const consumerDir = mkdtempSync(join(tmpdir(), 'byo-missing-'));
    writeDockerfile(
      consumerDir,
      'FROM public.ecr.aws/lambda/microvms:al2023-minimal\n',
    );

    const { app } = newApp();
    const stack = newStack(app);

    expect(
      () =>
        new ImagePipeline(stack, 'Pipeline', {
          image: RunnerImage.fromDockerfile(consumerDir),
          size: MicrovmSize.GB1,
          network: RunnerNetwork.internetEgress(),
          imageLogs: ImageLogs.enabled(),
          runnerSetId: 'runners-byo',
        }),
    ).toThrow(/microvm-runner\/agent\.mjs/);
  });

  it('throws when the only microvm-runner/agent.mjs reference is a commented-out COPY line', () => {
    const consumerDir = mkdtempSync(join(tmpdir(), 'byo-commented-'));
    writeDockerfile(
      consumerDir,
      [
        'FROM public.ecr.aws/lambda/microvms:al2023-minimal',
        '# COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs',
        'ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]',
      ].join('\n'),
    );

    const { app } = newApp();
    const stack = newStack(app);

    expect(
      () =>
        new ImagePipeline(stack, 'Pipeline', {
          image: RunnerImage.fromDockerfile(consumerDir),
          size: MicrovmSize.GB1,
          network: RunnerNetwork.internetEgress(),
          imageLogs: ImageLogs.enabled(),
          runnerSetId: 'runners-byo',
        }),
    ).toThrow(/microvm-runner\/agent\.mjs/);
  });

  it('throws when the Dockerfile copies the agent to some other path (only microvm-runner/agent.mjs satisfies the check)', () => {
    const consumerDir = mkdtempSync(join(tmpdir(), 'byo-wrong-path-'));
    writeDockerfile(
      consumerDir,
      [
        'FROM public.ecr.aws/lambda/microvms:al2023-minimal',
        'COPY other/agent.mjs /opt/other/agent.mjs',
        'ENTRYPOINT ["/opt/other/entrypoint.sh"]',
      ].join('\n'),
    );

    const { app } = newApp();
    const stack = newStack(app);

    expect(
      () =>
        new ImagePipeline(stack, 'Pipeline', {
          image: RunnerImage.fromDockerfile(consumerDir),
          size: MicrovmSize.GB1,
          network: RunnerNetwork.internetEgress(),
          imageLogs: ImageLogs.enabled(),
          runnerSetId: 'runners-byo',
        }),
    ).toThrow(/microvm-runner\/agent\.mjs/);
  });

  it('passes when the Dockerfile has a real, uncommented microvm-runner/agent.mjs COPY line', () => {
    const consumerDir = mkdtempSync(join(tmpdir(), 'byo-real-'));
    writeDockerfile(
      consumerDir,
      [
        'FROM public.ecr.aws/lambda/microvms:al2023-minimal',
        'COPY microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs',
        'ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]',
      ].join('\n'),
    );

    const { app } = newApp();
    const stack = newStack(app);

    expect(
      () =>
        new ImagePipeline(stack, 'Pipeline', {
          image: RunnerImage.fromDockerfile(consumerDir),
          size: MicrovmSize.GB1,
          network: RunnerNetwork.internetEgress(),
          imageLogs: ImageLogs.enabled(),
          runnerSetId: 'runners-byo',
        }),
    ).not.toThrow();
  });

  it('passes when the microvm-runner/agent.mjs COPY line carries flags (e.g. --chown)', () => {
    const consumerDir = mkdtempSync(join(tmpdir(), 'byo-chown-'));
    writeDockerfile(
      consumerDir,
      [
        'FROM public.ecr.aws/lambda/microvms:al2023-minimal',
        'COPY --chown=runner:runner microvm-runner/agent.mjs /opt/microvm-runner/agent.mjs',
        'ENTRYPOINT ["/opt/microvm-runner/entrypoint.sh"]',
      ].join('\n'),
    );

    const { app } = newApp();
    const stack = newStack(app);

    expect(
      () =>
        new ImagePipeline(stack, 'Pipeline', {
          image: RunnerImage.fromDockerfile(consumerDir),
          size: MicrovmSize.GB1,
          network: RunnerNetwork.internetEgress(),
          imageLogs: ImageLogs.enabled(),
          runnerSetId: 'runners-byo',
        }),
    ).not.toThrow();
  });

  it('throws a clear synth error when dir/Dockerfile does not exist', () => {
    const consumerDir = mkdtempSync(join(tmpdir(), 'byo-nofile-'));

    const { app } = newApp();
    const stack = newStack(app);

    expect(
      () =>
        new ImagePipeline(stack, 'Pipeline', {
          image: RunnerImage.fromDockerfile(consumerDir),
          size: MicrovmSize.GB1,
          network: RunnerNetwork.internetEgress(),
          imageLogs: ImageLogs.enabled(),
          runnerSetId: 'runners-byo',
        }),
    ).toThrow(/Dockerfile/);
  });
});

describe('ImagePipeline runnerSetId validation', () => {
  it('throws for a runnerSetId containing invalid characters (e.g. "/")', () => {
    const { app } = newApp();
    const stack = newStack(app);

    expect(
      () =>
        new ImagePipeline(stack, 'Pipeline', {
          image: RunnerImage.fromOptions(),
          size: MicrovmSize.GB1,
          network: RunnerNetwork.internetEgress(),
          imageLogs: ImageLogs.enabled(),
          runnerSetId: 'runners/dev',
        }),
    ).toThrow(/runnerSetId/);
  });

  it('throws when runnerSetId + hash suffix would exceed the 64-char Name limit', () => {
    const { app } = newApp();
    const stack = newStack(app);

    expect(
      () =>
        new ImagePipeline(stack, 'Pipeline', {
          image: RunnerImage.fromOptions(),
          size: MicrovmSize.GB1,
          network: RunnerNetwork.internetEgress(),
          imageLogs: ImageLogs.enabled(),
          runnerSetId: 'a'.repeat(60),
        }),
    ).toThrow(/64/);
  });

  it('accepts a runnerSetId at the exact 55-char boundary', () => {
    const { app } = newApp();
    const stack = newStack(app);

    expect(
      () =>
        new ImagePipeline(stack, 'Pipeline', {
          image: RunnerImage.fromOptions(),
          size: MicrovmSize.GB1,
          network: RunnerNetwork.internetEgress(),
          imageLogs: ImageLogs.enabled(),
          runnerSetId: 'a'.repeat(55),
        }),
    ).not.toThrow();
  });

  it('throws for a runnerSetId one character past the 55-char boundary', () => {
    const { app } = newApp();
    const stack = newStack(app);

    expect(
      () =>
        new ImagePipeline(stack, 'Pipeline', {
          image: RunnerImage.fromOptions(),
          size: MicrovmSize.GB1,
          network: RunnerNetwork.internetEgress(),
          imageLogs: ImageLogs.enabled(),
          runnerSetId: 'a'.repeat(56),
        }),
    ).toThrow(/64/);
  });

  it('accepts a runnerSetId with the full allowed charset (letters, digits, hyphen, underscore)', () => {
    const { app } = newApp();
    const stack = newStack(app);

    expect(
      () =>
        new ImagePipeline(stack, 'Pipeline', {
          image: RunnerImage.fromOptions(),
          size: MicrovmSize.GB1,
          network: RunnerNetwork.internetEgress(),
          imageLogs: ImageLogs.enabled(),
          runnerSetId: 'Ghmr-Dev_1',
        }),
    ).not.toThrow();
  });
});
