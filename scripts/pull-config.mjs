// Writes web/config.json from the deployed stack's outputs, for local development.
// Usage: npm run web:config [-- dev|prod]    (uses your default AWS credentials/profile)
import { writeFileSync } from 'node:fs';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const stage = process.argv[2] || process.env.STAGE || 'dev';
const region = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';
const stackName = `Inkwell-${stage}`;

const cf = new CloudFormationClient({ region });
const { Stacks } = await cf.send(new DescribeStacksCommand({ StackName: stackName }));
const out = Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));

const config = {
  stage,
  region: out.Region,
  apiUrl: out.ApiUrl,
  userPoolId: out.UserPoolId,
  clientId: out.ClientId,
  authDomain: out.AuthDomain,
};
for (const [k, v] of Object.entries(config)) if (!v) throw new Error(`Output for "${k}" missing on ${stackName}`);

writeFileSync(new URL('../web/config.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
console.log(`web/config.json written from ${stackName} (${region}). Run "npm run web:dev" and open http://localhost:5173`);
