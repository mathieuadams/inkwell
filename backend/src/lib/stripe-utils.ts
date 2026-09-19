import { createHmac, timingSafeEqual } from 'crypto';

/** Stripe's form encoding: { a: { b: [ { c: 1 } ] } } -> a[b][0][c]=1 */
export function encodeForm(params: Record<string, unknown>): string {
  const out: [string, string][] = [];
  const walk = (value: unknown, key: string) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, key ? `${key}[${k}]` : k);
    } else out.push([key, String(value)]);
  };
  walk(params, '');
  return new URLSearchParams(out).toString();
}

/** Verifies the Stripe-Signature header (v1 scheme) for a raw request body. */
export function verifyStripeSignature(
  payload: string,
  header: string | undefined,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string]);
  const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex'), 'utf8');
  return signatures.some((sig) => {
    const given = Buffer.from(sig ?? '', 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
