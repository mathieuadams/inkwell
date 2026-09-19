import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { InkwellStack } from '../lib/inkwell-stack';

let t: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new InkwellStack(app, 'Test', {
    stage: 'test',
    extractModelId: 'test-extract-model',
    translateModelId: 'test-translate-model',
    env: { account: '123456789012', region: 'us-east-1' },
  });
  t = Template.fromStack(stack);
});

describe('InkwellStack', () => {
  it('keeps every bucket private and TLS-only', () => {
    t.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        ]),
      },
    });
  });

  it('protects every API route with the Cognito JWT authorizer', () => {
    const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes).toHaveLength(7);
    for (const r of routes) expect(r.Properties.AuthorizationType).toBe('JWT');
    t.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  });

  it('runs the app Lambdas on Node 22 / arm64 with the configured models', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Environment: {
        Variables: Match.objectLike({ EXTRACT_MODEL_ID: 'test-extract-model', TRANSLATE_MODEL_ID: 'test-translate-model' }),
      },
    });
  });

  it('serves the site over HTTPS only through CloudFront', () => {
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
  });

  it('uses the authorization code flow only', () => {
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AllowedOAuthFlows: ['code'],
      GenerateSecret: false,
    });
  });
});
