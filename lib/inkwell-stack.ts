import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export interface InkwellStackProps extends cdk.StackProps {
  /** dev | prod | any short name. prod retains data on stack deletion. */
  stage: string;
  /** Bedrock model or inference-profile id used to read handwriting. */
  extractModelId: string;
  /** Bedrock model or inference-profile id used to translate. */
  translateModelId: string;
  /** Stripe price ids (price_...) for the monthly plans. Empty = billing disabled. */
  stripePrices: { starter: string; plus: string; pro: string };
  /** Pages a new account can convert before subscribing. */
  freePages: string;
}

const LOCAL_ORIGIN = 'http://localhost:5173';
const ROOT = path.join(__dirname, '..');

export class InkwellStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InkwellStackProps) {
    super(scope, id, props);

    const isProd = props.stage === 'prod';
    const dataRemoval = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    /* ------------------------------------------------------------------ */
    /* Web front end: private S3 bucket behind CloudFront (OAC)            */
    /* ------------------------------------------------------------------ */
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: `Inkwell ${props.stage} security headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            'font-src https://fonts.gstatic.com',
            "img-src 'self' data: blob: https://*.amazonaws.com",
            "connect-src 'self' https://*.amazonaws.com https://*.amazoncognito.com",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
          ].join('; '),
        },
        strictTransportSecurity: {
          override: true,
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        referrerPolicy: {
          override: true,
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        },
      },
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: `Inkwell ${props.stage}`,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        compress: true,
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: cdk.Duration.seconds(0),
      })),
    });

    const siteUrl = `https://${distribution.distributionDomainName}`;

    /* ------------------------------------------------------------------ */
    /* Uploads + note storage                                              */
    /*   users/{sub}/uploads/{uuid}.{ext}  original photo / PDF            */
    /*   users/{sub}/notes/{id}.json       note text + translations        */
    /* ------------------------------------------------------------------ */
    const dataBucket = new s3.Bucket(this, 'DataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: isProd,
      removalPolicy: dataRemoval,
      autoDeleteObjects: !isProd,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: [siteUrl, LOCAL_ORIGIN],
          allowedHeaders: ['content-type'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
        ...(isProd ? [{ noncurrentVersionExpiration: cdk.Duration.days(30) }] : []),
      ],
    });

    /* ------------------------------------------------------------------ */
    /* Auth: Cognito user pool + hosted sign-in (authorization code+PKCE)  */
    /* ------------------------------------------------------------------ */
    const userPool = new cognito.UserPool(this, 'Users', {
      userPoolName: `inkwell-${props.stage}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 10, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: isProd,
      removalPolicy: dataRemoval,
    });

    const authDomain = userPool.addDomain('HostedUi', {
      cognitoDomain: { domainPrefix: `inkwell-${props.stage}-${cdk.Aws.ACCOUNT_ID}` },
    });

    const redirectUrls = [`${siteUrl}/`, `${LOCAL_ORIGIN}/`];
    const webClient = userPool.addClient('WebClient', {
      userPoolClientName: 'inkwell-web',
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: redirectUrls,
        logoutUrls: redirectUrls,
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    /* ------------------------------------------------------------------ */
    /* Lambdas                                                             */
    /* ------------------------------------------------------------------ */
    // Stripe keys live in SSM Parameter Store (SecureString), never in the repo:
    //   /inkwell/{stage}/stripe/secret-key      restricted API key
    //   /inkwell/{stage}/stripe/webhook-secret  webhook signing secret
    const stripeParamPrefix = `/inkwell/${props.stage}/stripe`;

    const fn = (name: string, file: string, overrides: Partial<NodejsFunctionProps> = {}) =>
      new NodejsFunction(this, name, {
        entry: path.join(ROOT, 'backend', 'src', 'handlers', file),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: cdk.Duration.seconds(29),
        environment: {
          BUCKET: dataBucket.bucketName,
          EXTRACT_MODEL_ID: props.extractModelId,
          TRANSLATE_MODEL_ID: props.translateModelId,
          SITE_URL: siteUrl,
          FREE_PAGES: props.freePages,
          STRIPE_PRICE_STARTER: props.stripePrices.starter,
          STRIPE_PRICE_PLUS: props.stripePrices.plus,
          STRIPE_PRICE_PRO: props.stripePrices.pro,
          STRIPE_SECRET_PARAM: `${stripeParamPrefix}/secret-key`,
          STRIPE_WEBHOOK_PARAM: `${stripeParamPrefix}/webhook-secret`,
          NODE_OPTIONS: '--enable-source-maps',
        },
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'node22',
          externalModules: [], // bundle AWS SDK so versions are pinned by package-lock
        },
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        ...overrides,
      });

    const uploadFn = fn('UploadFn', 'upload.ts', { memorySize: 256 });
    const extractFn = fn('ExtractFn', 'extract.ts', { memorySize: 1024 });
    const translateFn = fn('TranslateFn', 'translate.ts');
    const notesFn = fn('NotesFn', 'notes.ts', { memorySize: 256 });
    const billingFn = fn('BillingFn', 'billing.ts', { memorySize: 256 });
    const webhookFn = fn('StripeWebhookFn', 'webhook.ts', { memorySize: 256 });
    const cleanupFn = fn('CleanupFn', 'cleanup.ts', { timeout: cdk.Duration.minutes(15) });

    dataBucket.grantPut(uploadFn);
    dataBucket.grantReadWrite(extractFn);
    dataBucket.grantReadWrite(translateFn);
    dataBucket.grantReadWrite(notesFn);
    dataBucket.grantDelete(notesFn);
    dataBucket.grantRead(uploadFn);
    dataBucket.grantReadWrite(billingFn);
    dataBucket.grantReadWrite(webhookFn);
    dataBucket.grantReadWrite(cleanupFn);
    dataBucket.grantDelete(cleanupFn);

    const readStripeSecrets = new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${stripeParamPrefix}/*`],
    });
    billingFn.addToRolePolicy(readStripeSecrets);
    webhookFn.addToRolePolicy(readStripeSecrets);

    new events.Rule(this, 'DailyCleanup', {
      description: `Inkwell ${props.stage}: apply note retention per plan`,
      schedule: events.Schedule.cron({ minute: '17', hour: '9' }),
      targets: [new targets.LambdaFunction(cleanupFn)],
    });

    const bedrockInvoke = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
      ],
    });
    // Lets the first invocation auto-enable serverless models sold through AWS Marketplace.
    const marketplace = new iam.PolicyStatement({
      actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
      resources: ['*'],
    });
    for (const f of [extractFn, translateFn]) {
      f.addToRolePolicy(bedrockInvoke);
      f.addToRolePolicy(marketplace);
    }

    /* ------------------------------------------------------------------ */
    /* HTTP API with Cognito JWT authorizer                                */
    /* ------------------------------------------------------------------ */
    const authorizer = new HttpJwtAuthorizer(
      'CognitoJwt',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [webClient.userPoolClientId] },
    );

    const api = new apigw.HttpApi(this, 'Api', {
      apiName: `inkwell-${props.stage}`,
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: [siteUrl, LOCAL_ORIGIN],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PATCH,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    const stage = api.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };

    const M = apigw.HttpMethod;
    const notesIntegration = new HttpLambdaIntegration('NotesIntegration', notesFn);
    api.addRoutes({ path: '/uploads', methods: [M.POST], integration: new HttpLambdaIntegration('UploadIntegration', uploadFn) });
    api.addRoutes({ path: '/extract', methods: [M.POST], integration: new HttpLambdaIntegration('ExtractIntegration', extractFn) });
    api.addRoutes({ path: '/translate', methods: [M.POST], integration: new HttpLambdaIntegration('TranslateIntegration', translateFn) });
    api.addRoutes({ path: '/notes', methods: [M.GET], integration: notesIntegration });
    api.addRoutes({ path: '/notes/{id}', methods: [M.GET, M.PATCH, M.DELETE], integration: notesIntegration });

    const billingIntegration = new HttpLambdaIntegration('BillingIntegration', billingFn);
    api.addRoutes({ path: '/account', methods: [M.GET], integration: billingIntegration });
    api.addRoutes({ path: '/billing/checkout', methods: [M.POST], integration: billingIntegration });
    api.addRoutes({ path: '/billing/portal', methods: [M.POST], integration: billingIntegration });
    // Stripe can't send a Cognito JWT; the handler verifies the Stripe-Signature header instead.
    api.addRoutes({
      path: '/stripe/webhook',
      methods: [M.POST],
      integration: new HttpLambdaIntegration('StripeWebhookIntegration', webhookFn),
      authorizer: new apigw.HttpNoneAuthorizer(),
    });

    /* ------------------------------------------------------------------ */
    /* Publish the front end + runtime config                              */
    /* ------------------------------------------------------------------ */
    const webConfig = {
      stage: props.stage,
      region: this.region,
      apiUrl: api.apiEndpoint,
      userPoolId: userPool.userPoolId,
      clientId: webClient.userPoolClientId,
      authDomain: authDomain.baseUrl(),
    };

    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      destinationBucket: siteBucket,
      sources: [
        s3deploy.Source.asset(path.join(ROOT, 'web'), { exclude: ['config.json'] }),
        s3deploy.Source.jsonData('config.json', webConfig),
      ],
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=0, must-revalidate')],
      distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
    });

    /* ------------------------------------------------------------------ */
    /* Outputs (read by scripts/pull-config.mjs and the deploy workflow)   */
    /* ------------------------------------------------------------------ */
    new cdk.CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'Region', { value: this.region });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'ClientId', { value: webClient.userPoolClientId });
    new cdk.CfnOutput(this, 'AuthDomain', { value: authDomain.baseUrl() });
    new cdk.CfnOutput(this, 'DataBucketName', { value: dataBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'StripeWebhookUrl', { value: `${api.apiEndpoint}/stripe/webhook` });
    new cdk.CfnOutput(this, 'StripeParamPrefix', { value: stripeParamPrefix });
  }
}
