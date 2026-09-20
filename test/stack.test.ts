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
    stripeProducts: { starter: 'prod_s', plus: 'prod_p', pro: 'prod_x', topup20: 'prod_t20', topup50: 'prod_t50', topup100: 'prod_t100' },
    freePages: '3',
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

  it('protects every API route with the Cognito JWT authorizer except the Stripe webhook', () => {
    const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes).toHaveLength(12);
    for (const r of routes) {
      const expected = r.Properties.RouteKey === 'POST /stripe/webhook' ? 'NONE' : 'JWT';
      expect(r.Properties.AuthorizationType ?? 'NONE').toBe(expected);
    }
    t.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  });

  it('only lets billing Lambdas read the Stripe parameters', () => {
    const policies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p.Properties.PolicyDocument).includes('ssm:GetParameter'),
    );
    expect(policies).toHaveLength(2);
    expect(JSON.stringify(policies)).toContain('/inkwell/test/stripe/*');
  });

  it('schedules the daily retention cleanup', () => {
    t.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(17 9 * * ? *)' });
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
