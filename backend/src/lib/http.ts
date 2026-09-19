import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type ApiResult = APIGatewayProxyResultV2;

/** An error whose message is safe to show to the user. */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const json = (statusCode: number, body: unknown): ApiResult => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cognito `sub` of the caller, taken from the JWT the API Gateway authorizer already verified. */
export function userId(event: ApiEvent): string {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || !UUID.test(sub)) throw new HttpError(401, 'Sign in to continue.');
  return sub;
}

export function parseBody<T>(event: ApiEvent): Partial<T> {
  if (!event.body) throw new HttpError(400, 'The request body is empty.');
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Partial<T>;
  } catch {
    throw new HttpError(400, 'The request body must be a JSON object.');
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function handle(fn: (event: ApiEvent) => Promise<ApiResult>) {
  return async (event: ApiEvent): Promise<ApiResult> => {
    try {
      return await fn(event);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error('Unhandled error', err);
      return json(500, { error: 'Something went wrong on our side. Try again.' });
    }
  };
}
