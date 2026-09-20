# Inkwell

Photograph a handwritten note, get editable text, translate it. Mobile-first web app, fully serverless on AWS.

```
Browser ──► CloudFront ──► S3 (static site, OAC)
   │
   ├─► Cognito hosted sign-in (auth code + PKCE)
   │
   ├─► API Gateway (HTTP API, Cognito JWT authorizer)
   │       POST /uploads      ─► Lambda ─► presigned S3 PUT
   │       POST /extract      ─► Lambda ─► S3 ─► Bedrock (vision) ─► note saved to S3
   │       POST /translate    ─► Lambda ─► Bedrock ─► translation saved on note
   │       GET/PATCH/DELETE /notes[/{id}] ─► Lambda ─► S3
   │
   └─► S3 data bucket (direct upload via presigned URL)
         users/{sub}/uploads/{uuid}.jpg
         users/{sub}/notes/{id}.json
```

Everything is defined in AWS CDK (TypeScript) in one stack per stage: `Inkwell-dev`, `Inkwell-prod`.

## Repo layout

| Path | What |
|---|---|
| `web/` | Front end. Plain HTML/CSS/ES modules, no build step. `config.json` is generated at deploy. |
| `backend/src/handlers/` | One Lambda per file: `upload`, `extract`, `translate`, `notes`. |
| `backend/src/lib/` | HTTP helpers, validation, S3 storage, Bedrock calls, response parsing. |
| `lib/inkwell-stack.ts` | All infrastructure. |
| `bin/app.ts` | CDK app, stage + model selection. |
| `bootstrap/github-oidc.yaml` | One-time IAM role so GitHub Actions deploys without AWS keys. |
| `.github/workflows/` | `ci.yml` on PRs, `deploy.yml` on `main` (dev) and releases (prod). |

## First-time setup

Requirements: Node 22, AWS CLI v2 with admin credentials for the target account, a GitHub repo.

**1. Install and commit the lockfile**

```bash
npm install
npm test
git init -b main && git add . && git commit -m "Inkwell: initial commit"
git remote add origin git@github.com:<you>/inkwell.git
git push -u origin main   # the first deploy run will fail until steps 2–4 are done
```

**2. Bootstrap CDK in the account/region** (once per account + region)

```bash
export AWS_REGION=us-east-1
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/$AWS_REGION
```

**3. Enable Bedrock models**

In the Bedrock console for your region, open *Model catalog* and make sure the Anthropic Claude models are available to the account (first-time Anthropic use requires submitting the use-case form). Defaults:

- Extraction: `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
- Translation: `us.anthropic.claude-haiku-4-5-20251001-v1:0`

To use other models, set the GitHub variables `EXTRACT_MODEL_ID` / `TRANSLATE_MODEL_ID` (or `-c extractModelId=…` locally). Any Converse-compatible vision model works for extraction.

**4. Create the GitHub deploy role**

```bash
aws cloudformation deploy \
  --stack-name inkwell-github-oidc \
  --template-file bootstrap/github-oidc.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides GitHubOwner=<you> GitHubRepo=inkwell \
    GitHubOwnerId=$(gh api users/<you> --jq .id) GitHubRepoId=$(gh api repos/<you>/inkwell --jq .id)
# If the account already has the GitHub OIDC provider, add CreateOidcProvider=false

aws cloudformation describe-stacks --stack-name inkwell-github-oidc \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text
```

**5. Configure GitHub** (repo → Settings)

- *Environments*: create `dev` and `prod`. On `prod`, add required reviewers.
- *Secrets and variables → Actions → Variables*:
  - `AWS_DEPLOY_ROLE_ARN` = the role ARN from step 4
  - `AWS_REGION` = `us-east-1` (or your region)
  - optional: `EXTRACT_MODEL_ID`, `TRANSLATE_MODEL_ID`

**6. Deploy**

Re-run the *Deploy* workflow (Actions → Deploy → Run workflow → dev), or push to `main`. The run summary lists the site URL. Open it, choose *Create account*, verify your email, add a note.

Prod: publish a GitHub release (e.g. `v1.0.0`). It waits for approval, then deploys `Inkwell-prod`.

## Plans and billing (Stripe)

| Plan | Price | Pages / month | Notes kept |
|---|---|---|---|
| Free | $0 | `FREE_PAGES` total (default 3) | Not saved |
| Starter | $5 | 20 | Not saved (photo deleted after reading) |
| Plus | $10 | 150 | 30 days |
| Pro | $25 | 500 | While subscribed |

Translations are capped at 5× the page quota. After a downgrade or cancellation, stored notes are kept 30 days before the new plan's retention applies (daily cleanup Lambda).

Setup per stage (dev uses Stripe **test mode**, prod uses **live mode**):

1. Stripe products, each with its monthly price as the default price, then GitHub variables `STRIPE_PRODUCT_STARTER`, `STRIPE_PRODUCT_PLUS`, `STRIPE_PRODUCT_PRO` (`prod_...`). Optional `FREE_PAGES`.
2. Restricted key (Checkout Sessions W, Customers W, Customer portal W, Subscriptions R, Prices R, Products R) in SSM:
   `aws ssm put-parameter --name /inkwell/dev/stripe/secret-key --type SecureString --value rk_test_...`
3. Deploy, then add a Stripe webhook to the `StripeWebhookUrl` output with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and store its signing secret:
   `aws ssm put-parameter --name /inkwell/dev/stripe/webhook-secret --type SecureString --value whsec_...`
4. Stripe customer portal: enable plan switching (all three products) and cancellation.

Prod uses the same parameter names under `/inkwell/prod/stripe/`. Set the live product IDs as variables on the `prod` GitHub environment; they override the repo-level test ones.

## CI/CD

| Trigger | Workflow | Does |
|---|---|---|
| Pull request / non-main push | `ci.yml` | typecheck, unit + CDK assertion tests, web syntax check, `cdk synth` |
| Push to `main` | `deploy.yml` | tests, then `cdk deploy Inkwell-dev` |
| Release published | `deploy.yml` | tests, approval, then `cdk deploy Inkwell-prod` |
| Manual | `deploy.yml` | deploy the chosen stage |

AWS access uses GitHub OIDC; there are no stored AWS keys. The deploy role can only assume the CDK bootstrap roles.

## Local development

Front end against a deployed dev backend (localhost:5173 is already an allowed Cognito callback and CORS origin):

```bash
npm run web:config        # writes web/config.json from Inkwell-dev outputs
npm run web:dev           # http://localhost:5173
```

Backend changes: `npm test`, then `npm run deploy:dev` (or `npx cdk watch -c stage=dev` for fast hot-swaps).

## Behaviour notes

- Photos are converted in the browser to JPEG (max 2048 px, under 3.75 MB), which also handles iPhone HEIC in Safari. PDFs go up as-is, up to 4.5 MB (Bedrock limits).
- Uploads go straight from the browser to S3 with a 5-minute presigned URL whose content type and size are signed.
- Each user can only touch keys under `users/{their Cognito sub}/`; the sub comes from the verified JWT.
- Editing the text autosaves and clears stale translations. Translations are cached per language on the note.
- API throttling: 10 req/s, burst 20 per stage. Lambda timeout is 29 s to match API Gateway.
- `dev` is fully deleted with `cdk destroy`. `prod` keeps the user pool and data bucket (versioned, deletion protection on).

## Costs

Idle cost is close to zero (no servers). You pay per request for Lambda, API Gateway, S3 and CloudFront, per active user for Cognito beyond the free tier, and per token for Bedrock; extraction on Sonnet is the main variable cost.

## Next steps

- Custom domain (ACM cert in the same us-east-1 region + Route 53 alias) and add it to Cognito callback URLs and CORS.
- Managed login branding for the Cognito sign-in page.
- AWS WAF on CloudFront and API Gateway for public launch.
