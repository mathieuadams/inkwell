import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { HttpError, requireEnv } from './http';
import { encodeForm } from './stripe-utils';

const ssm = new SSMClient({});
const cache = new Map<string, { value: string; at: number }>();

/** Reads a SecureString from SSM Parameter Store, cached for 5 minutes per container. */
export async function getSecret(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 300_000) return hit.value;
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = res.Parameter?.Value;
    if (!value) throw new Error(`Empty parameter ${name}`);
    cache.set(name, { value, at: Date.now() });
    return value;
  } catch (err) {
    console.error('Secret unavailable', name, (err as Error).name);
    throw new HttpError(503, "Billing isn't set up yet. Try again later.");
  }
}

export async function stripe<T = any>(method: 'GET' | 'POST', path: string, params?: Record<string, unknown>): Promise<T> {
  const key = await getSecret(requireEnv('STRIPE_SECRET_PARAM'));
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? encodeForm(params) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    console.error('Stripe error', res.status, method, path, data?.error?.type, data?.error?.message);
    throw new HttpError(502, 'Billing is unavailable right now. Try again in a moment.');
  }
  return data as T;
}
