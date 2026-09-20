#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { InkwellStack } from '../lib/inkwell-stack';

const DEFAULT_EXTRACT_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const DEFAULT_TRANSLATE_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const app = new cdk.App();
const stage: string = app.node.tryGetContext('stage') || 'dev';
if (!/^[a-z0-9-]{2,12}$/.test(stage)) throw new Error(`Invalid stage "${stage}"`);

new InkwellStack(app, `Inkwell-${stage}`, {
  stage,
  extractModelId: app.node.tryGetContext('extractModelId') || DEFAULT_EXTRACT_MODEL,
  translateModelId: app.node.tryGetContext('translateModelId') || DEFAULT_TRANSLATE_MODEL,
  stripeProducts: {
    starter: app.node.tryGetContext('stripeProductStarter') || '',
    plus: app.node.tryGetContext('stripeProductPlus') || '',
    pro: app.node.tryGetContext('stripeProductPro') || '',
    topup20: app.node.tryGetContext('stripeProductTopup20') || '',
    topup50: app.node.tryGetContext('stripeProductTopup50') || '',
    topup100: app.node.tryGetContext('stripeProductTopup100') || '',
  },
  freePages: String(app.node.tryGetContext('freePages') || '3'),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: `Inkwell handwriting-to-text app (${stage})`,
});

cdk.Tags.of(app).add('app', 'inkwell');
cdk.Tags.of(app).add('stage', stage);
